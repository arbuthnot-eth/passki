/// Module: storm::nebula
///
/// Per-recipient batch-threshold-encrypted inbox.
///
/// All senders, regardless of which logical Storm (conversation) a message
/// belongs to, encrypt the per-message GT pad to the recipient's
/// `ek_compressed` (BLS12-381, 576 B). Storm membership is metadata
/// inside the AEAD payload, NOT a separate on-chain primitive.
///
/// Group conversations are handled by N-fold per-recipient encryption:
/// a 5-person group message produces 5 batch CTs, one to each recipient's
/// Nebula. Same content stored 5 times across 5 Nebulae. No shared group
/// keys, no group-key compromise vector. The privacy boundary is the
/// recipient.
///
/// One Seal-recover of `sk_user` + one batch-threshold pre_decrypt + one
/// batch decrypt unseals every unread message in the recipient's Nebula.
///
/// Move never decrypts (no native pairings). It stores CTs and AEAD
/// payloads, accepts the recipient's published `sbk` once per epoch, and
/// gates writes by sender / size / state.
///
/// Mitigations baked into the API:
///   - Per-CT NIZK fallback (`mark_bad_ct`): on batch-NIZK failure, owner
///     flags the bad slot; bad sender is on-chain evidence; recipient
///     re-runs pre_decrypt over surviving slots. Pistis mitigation.
///   - Optional epoch padding (`epoch_padding`): privacy-conscious recipient
///     pads each epoch to a fixed length with decoy CTs, hiding inbound
///     volume against on-chain observers. Dikaiosyne mitigation.
///
/// Construction: BE_short / BLS12-381 (Boneh / Nema / Roy / Tas, ePrint
/// 2026/674, Construction 5).
module storm::nebula;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::vec_set::{Self, VecSet};

// === Error Codes ===

const ENotOwner: u64 = 0;
const EBadCtSize: u64 = 1;
const EBadEkSize: u64 = 2;
const EBadSbkSize: u64 = 3;
const EEllNotPowerOfTwo: u64 = 4;
const EEpochFull: u64 = 5;
const EEpochAlreadySealed: u64 = 6;
const EBadCtIndex: u64 = 7;
const EPrevEpochNotSealed: u64 = 8;
const ECannotMarkAfterSeal: u64 = 9;

// === Constants (BE_short / BLS12-381) ===

const CT_BYTES: u64 = 704;
const EK_BYTES: u64 = 576;
const SBK_BYTES: u64 = 48;

// === Structs ===

public struct Nebula has key, store {
    id: UID,
    owner: address,
    suins_name: String,
    ek_compressed: vector<u8>,
    committee_ref: vector<u8>,
    ell_max: u64,
    epoch_padding: u64,
    current_epoch: u64,
    version: u64,
}

public struct NebulaEpoch has key, store {
    id: UID,
    nebula: ID,
    epoch_no: u64,
    cts: vector<vector<u8>>,
    aead_payloads: vector<vector<u8>>,
    senders: vector<address>,
    walrus_blob_ids: vector<vector<u8>>,
    bad_ct_indices: VecSet<u64>,
    sbk: vector<u8>,
    sealed_at_ms: u64,
}

// === Events ===

public struct NebulaOpened has copy, drop {
    nebula: ID,
    owner: address,
    ell_max: u64,
    epoch_padding: u64,
}

public struct ThunderPosted has copy, drop {
    epoch: ID,
    nebula: ID,
    epoch_no: u64,
    slot: u64,
    sender: address,
}

public struct EpochSealed has copy, drop {
    epoch: ID,
    nebula: ID,
    epoch_no: u64,
    sealed_at_ms: u64,
    n_messages: u64,
}

public struct EpochRotated has copy, drop {
    nebula: ID,
    prev_epoch: ID,
    new_epoch: ID,
    new_epoch_no: u64,
}

public struct CtMarkedBad has copy, drop {
    epoch: ID,
    slot: u64,
    flagged_sender: address,
}

// === Open / Configure ===

public fun open(
    suins_name: String,
    ek_compressed: vector<u8>,
    committee_ref: vector<u8>,
    ell_max: u64,
    epoch_padding: u64,
    ctx: &mut TxContext,
): Nebula {
    assert!(ek_compressed.length() == EK_BYTES, EBadEkSize);
    assert!(is_power_of_two(ell_max), EEllNotPowerOfTwo);
    let owner = ctx.sender();
    let nebula = Nebula {
        id: object::new(ctx),
        owner,
        suins_name,
        ek_compressed,
        committee_ref,
        ell_max,
        epoch_padding,
        current_epoch: 0,
        version: 1,
    };
    event::emit(NebulaOpened {
        nebula: object::id(&nebula),
        owner,
        ell_max,
        epoch_padding,
    });
    nebula
}

public fun set_epoch_padding(nebula: &mut Nebula, new_padding: u64, ctx: &TxContext) {
    assert!(ctx.sender() == nebula.owner, ENotOwner);
    nebula.epoch_padding = new_padding;
}

fun new_epoch(nebula: &Nebula, epoch_no: u64, ctx: &mut TxContext): NebulaEpoch {
    NebulaEpoch {
        id: object::new(ctx),
        nebula: object::id(nebula),
        epoch_no,
        cts: vector[],
        aead_payloads: vector[],
        senders: vector[],
        walrus_blob_ids: vector[],
        bad_ct_indices: vec_set::empty(),
        sbk: vector[],
        sealed_at_ms: 0,
    }
}

// === Post / Rotate / Seal ===

public fun post_thunder(
    epoch: &mut NebulaEpoch,
    nebula: &Nebula,
    ct: vector<u8>,
    aead_payload: vector<u8>,
    walrus_blob_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(epoch.nebula == object::id(nebula), 0);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(ct.length() == CT_BYTES, EBadCtSize);
    let n = epoch.cts.length();
    assert!(n < nebula.ell_max, EEpochFull);

    let sender = ctx.sender();
    epoch.cts.push_back(ct);
    epoch.aead_payloads.push_back(aead_payload);
    epoch.senders.push_back(sender);
    epoch.walrus_blob_ids.push_back(walrus_blob_id);

    event::emit(ThunderPosted {
        epoch: object::id(epoch),
        nebula: object::id(nebula),
        epoch_no: epoch.epoch_no,
        slot: n,
        sender,
    });
}

public fun seal_epoch(
    epoch: &mut NebulaEpoch,
    nebula: &Nebula,
    sbk: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == nebula.owner, ENotOwner);
    assert!(epoch.nebula == object::id(nebula), 0);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(sbk.length() == SBK_BYTES, EBadSbkSize);

    epoch.sbk = sbk;
    epoch.sealed_at_ms = clock.timestamp_ms();

    event::emit(EpochSealed {
        epoch: object::id(epoch),
        nebula: object::id(nebula),
        epoch_no: epoch.epoch_no,
        sealed_at_ms: epoch.sealed_at_ms,
        n_messages: epoch.cts.length(),
    });
}

public fun rotate_epoch(
    nebula: &mut Nebula,
    prev: &NebulaEpoch,
    ctx: &mut TxContext,
): NebulaEpoch {
    assert!(ctx.sender() == nebula.owner, ENotOwner);
    assert!(prev.nebula == object::id(nebula), 0);
    assert!(prev.sealed_at_ms != 0, EPrevEpochNotSealed);

    nebula.current_epoch = nebula.current_epoch + 1;
    let next = new_epoch(nebula, nebula.current_epoch, ctx);
    event::emit(EpochRotated {
        nebula: object::id(nebula),
        prev_epoch: object::id(prev),
        new_epoch: object::id(&next),
        new_epoch_no: nebula.current_epoch,
    });
    next
}

// === Per-CT NIZK fallback ===

public fun mark_bad_ct(
    epoch: &mut NebulaEpoch,
    nebula: &Nebula,
    slot: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == nebula.owner, ENotOwner);
    assert!(epoch.nebula == object::id(nebula), 0);
    assert!(epoch.sealed_at_ms == 0, ECannotMarkAfterSeal);
    assert!(slot < epoch.cts.length(), EBadCtIndex);

    let flagged_sender = epoch.senders[slot];
    epoch.bad_ct_indices.insert(slot);

    event::emit(CtMarkedBad {
        epoch: object::id(epoch),
        slot,
        flagged_sender,
    });
}

// === Read accessors ===

public fun owner(nebula: &Nebula): address { nebula.owner }
public fun ek(nebula: &Nebula): &vector<u8> { &nebula.ek_compressed }
public fun ell_max(nebula: &Nebula): u64 { nebula.ell_max }
public fun epoch_padding(nebula: &Nebula): u64 { nebula.epoch_padding }
public fun current_epoch_no(nebula: &Nebula): u64 { nebula.current_epoch }

public fun epoch_nebula(epoch: &NebulaEpoch): ID { epoch.nebula }
public fun epoch_no(epoch: &NebulaEpoch): u64 { epoch.epoch_no }
public fun epoch_cts(epoch: &NebulaEpoch): &vector<vector<u8>> { &epoch.cts }
public fun epoch_payloads(epoch: &NebulaEpoch): &vector<vector<u8>> { &epoch.aead_payloads }
public fun epoch_senders(epoch: &NebulaEpoch): &vector<address> { &epoch.senders }
public fun epoch_walrus_blobs(epoch: &NebulaEpoch): &vector<vector<u8>> { &epoch.walrus_blob_ids }
public fun epoch_bad_indices(epoch: &NebulaEpoch): &VecSet<u64> { &epoch.bad_ct_indices }
public fun epoch_sbk(epoch: &NebulaEpoch): &vector<u8> { &epoch.sbk }
public fun epoch_is_sealed(epoch: &NebulaEpoch): bool { epoch.sealed_at_ms != 0 }
public fun epoch_sealed_at_ms(epoch: &NebulaEpoch): u64 { epoch.sealed_at_ms }

// === Internals ===

fun is_power_of_two(n: u64): bool {
    n > 0 && (n & (n - 1)) == 0
}
