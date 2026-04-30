/// Module: darkrai::nebula
///
/// Per-recipient batch-threshold-encrypted inbox.
///
/// All senders, regardless of which Storm a message belongs to, encrypt
/// the per-message GT pad to the recipient's `ek_compressed` (BLS12-381,
/// 576 B). Storm membership is metadata inside the AEAD payload, not at
/// the crypto layer.
///
/// One Seal-recover of `sk_user` + one Darkrai pre_decrypt + one batch
/// decrypt unseals every unread message across every direct Storm.
///
/// Move never decrypts (no native pairings). It stores CTs and AEAD
/// payloads, accepts the recipient's published `sbk` once per epoch, and
/// gates writes by sender / size / state.
///
/// Mitigations baked into the API:
///   - Per-CT NIZK fallback: if the recipient's batch-pre_decrypt fails
///     because a sender injected a malformed CT, the recipient marks the
///     bad slot via `mark_bad_ct` and re-runs pre_decrypt. The bad CT
///     stays on-chain as an evidence trail of the injecting sender.
///     (Pistis / Shield-of-Faith mitigation against batch-poisoning DoS.)
///   - Optional epoch padding: `epoch_padding` field on the Nebula lets
///     a privacy-conscious recipient pad each epoch to a fixed length
///     with decoy CTs, hiding inbound volume against on-chain observers.
///     (Dikaiosyne / Breastplate mitigation against volume correlation.)
///
/// See passki/thunder-sim/DESIGN.md in
/// arbuthnot-eth/batch-enc-partial-fractions@passki for the full
/// architecture write-up.
module darkrai::nebula;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::vec_set::{Self, VecSet};

// === Error Codes ===

/// Caller is not the inbox owner.
const ENotOwner: u64 = 0;
/// CT byte length doesn't match the construction (BE_short = 704 B).
const EBadCtSize: u64 = 1;
/// Encryption key byte length doesn't match (576 B for BLS12-381 GT).
const EBadEkSize: u64 = 2;
/// Pre-decryption key byte length doesn't match (48 B for BLS12-381 G1).
const EBadSbkSize: u64 = 3;
/// `ell_max` must be a power of two.
const EEllNotPowerOfTwo: u64 = 4;
/// Epoch is full — rotate before posting more.
const EEpochFull: u64 = 5;
/// Epoch already sealed; cannot post or re-seal.
const EEpochAlreadySealed: u64 = 6;
/// Bad CT index for `mark_bad_ct`.
const EBadCtIndex: u64 = 7;
/// Cannot rotate from an unsealed epoch.
const EPrevEpochNotSealed: u64 = 8;
/// Trying to mark a slot bad on a sealed epoch.
const ECannotMarkAfterSeal: u64 = 9;

// === Constants (BE_short with BLS12-381) ===

const CT_BYTES: u64 = 704;
const EK_BYTES: u64 = 576;
const SBK_BYTES: u64 = 48;

// === Structs ===

/// Per-recipient inbox. Long-lived. `ek_compressed` published once at
/// open; `sk_user` lives off-chain, Seal-protected by the existing 2-of-3
/// committee (Overclock + NodeInfra + Studio Mirai) and referenced by
/// `committee_ref`. Only the owner can rotate epochs or change padding.
public struct Nebula has key, store {
    id: UID,
    /// Sui address that owns this inbox. Authoritative for sk_user via Seal.
    owner: address,
    /// Display name, e.g. "brando.sui". Informational; resolution is via SuiNS.
    suins_name: String,
    /// 576 B compressed BLS12-381 GT element. Senders encrypt pads to this.
    ek_compressed: vector<u8>,
    /// Opaque pointer to where the Seal-protected sk_user is stored.
    /// (e.g., a thunder-stack EncryptionHistory entry id, serialized.)
    committee_ref: vector<u8>,
    /// Max batch size — set at open, fixes the dk shape. Power of two.
    ell_max: u64,
    /// 0 = no padding. Otherwise: epochs are filled with decoy CTs to this
    /// fixed length before sealing. Hides inbound volume against observers.
    epoch_padding: u64,
    /// Monotonic counter incremented on rotate_epoch.
    current_epoch: u64,
    /// Bumped by version.move on package upgrades.
    version: u64,
}

/// One epoch of CTs accumulating in an Nebula. Append-only until sealed.
/// Sealed epochs are immutable except for `bad_ct_indices` which the
/// owner can flag post-seal if they discover poisoned slots offline.
public struct NebulaEpoch has key, store {
    id: UID,
    inbox: ID,
    epoch_no: u64,
    /// 704 B each. Length grows with `post_thunder` until ell_max.
    cts: vector<vector<u8>>,
    /// AEAD payloads (variable length) — bincode'd Thunder { sender, ts, body }.
    aead_payloads: vector<vector<u8>>,
    /// Sender of each slot, parallel to `cts`. Useful for blame-on-bad-CT.
    senders: vector<address>,
    /// Walrus blob ids for attachments referenced by the AEAD payloads.
    /// Length matches `cts`; empty `vector<u8>` for slots with no attachment.
    walrus_blob_ids: vector<vector<u8>>,
    /// Indices of slots flagged as poisoned via `mark_bad_ct`. Excluded
    /// from the recipient's per-CT NIZK fallback retry of pre_decrypt.
    bad_ct_indices: VecSet<u64>,
    /// Empty until sealed. 48 B BLS12-381 G1 element.
    sbk: vector<u8>,
    /// 0 until sealed.
    sealed_at_ms: u64,
}

// === Events ===

public struct NebulaOpened has copy, drop {
    inbox: ID,
    owner: address,
    ell_max: u64,
    epoch_padding: u64,
}

public struct ThunderPosted has copy, drop {
    epoch: ID,
    inbox: ID,
    epoch_no: u64,
    slot: u64,
    sender: address,
}

public struct NebulaEpochSealed has copy, drop {
    epoch: ID,
    inbox: ID,
    epoch_no: u64,
    sealed_at_ms: u64,
    n_messages: u64,
}

public struct NebulaEpochRotated has copy, drop {
    inbox: ID,
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

/// Open a new inbox. The caller becomes the owner.
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
    let inbox = Nebula {
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
        inbox: object::id(&inbox),
        owner,
        ell_max,
        epoch_padding,
    });
    inbox
}

/// Owner-only: change epoch padding (privacy/throughput trade-off).
public fun set_epoch_padding(inbox: &mut Nebula, new_padding: u64, ctx: &TxContext) {
    assert!(ctx.sender() == inbox.owner, ENotOwner);
    inbox.epoch_padding = new_padding;
}

/// Spawn a fresh epoch object. Done as part of inbox open or rotation.
fun new_epoch(inbox: &Nebula, epoch_no: u64, ctx: &mut TxContext): NebulaEpoch {
    NebulaEpoch {
        id: object::new(ctx),
        inbox: object::id(inbox),
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

/// Append a thunder to the current epoch. Anyone can post — sender
/// authentication is at the AEAD/NIZK layer, not on-chain. The
/// construction's NIZK proves the sender knows `r` for `ct1 = [r]_1`,
/// which is what makes batch-poisoning detectable post-hoc via
/// `mark_bad_ct`.
public fun post_thunder(
    epoch: &mut NebulaEpoch,
    inbox: &Nebula,
    ct: vector<u8>,
    aead_payload: vector<u8>,
    walrus_blob_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(epoch.inbox == object::id(inbox), 0);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(ct.length() == CT_BYTES, EBadCtSize);
    let n = epoch.cts.length();
    assert!(n < inbox.ell_max, EEpochFull);

    let sender = ctx.sender();
    epoch.cts.push_back(ct);
    epoch.aead_payloads.push_back(aead_payload);
    epoch.senders.push_back(sender);
    epoch.walrus_blob_ids.push_back(walrus_blob_id);

    event::emit(ThunderPosted {
        epoch: object::id(epoch),
        inbox: object::id(inbox),
        epoch_no: epoch.epoch_no,
        slot: n,
        sender,
    });
}

/// Owner-only: publish the pre-decryption key for this epoch and freeze it.
/// Once sealed, the epoch is read-only (except `mark_bad_ct` for
/// post-hoc poisoning evidence).
public fun seal_epoch(
    epoch: &mut NebulaEpoch,
    inbox: &Nebula,
    sbk: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == inbox.owner, ENotOwner);
    assert!(epoch.inbox == object::id(inbox), 0);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(sbk.length() == SBK_BYTES, EBadSbkSize);

    epoch.sbk = sbk;
    epoch.sealed_at_ms = clock.timestamp_ms();

    event::emit(NebulaEpochSealed {
        epoch: object::id(epoch),
        inbox: object::id(inbox),
        epoch_no: epoch.epoch_no,
        sealed_at_ms: epoch.sealed_at_ms,
        n_messages: epoch.cts.length(),
    });
}

/// Owner-only: rotate to a new epoch after the previous one is sealed.
/// Returns the new NebulaEpoch which the caller should `transfer::share_object`.
public fun rotate_epoch(
    inbox: &mut Nebula,
    prev: &NebulaEpoch,
    ctx: &mut TxContext,
): NebulaEpoch {
    assert!(ctx.sender() == inbox.owner, ENotOwner);
    assert!(prev.inbox == object::id(inbox), 0);
    assert!(prev.sealed_at_ms != 0, EPrevEpochNotSealed);

    inbox.current_epoch = inbox.current_epoch + 1;
    let next = new_epoch(inbox, inbox.current_epoch, ctx);
    event::emit(NebulaEpochRotated {
        inbox: object::id(inbox),
        prev_epoch: object::id(prev),
        new_epoch: object::id(&next),
        new_epoch_no: inbox.current_epoch,
    });
    next
}

// === Per-CT NIZK fallback ===

/// Owner-only: flag a CT slot as poisoned. After this, the recipient's
/// client re-runs Darkrai pre_decrypt over the surviving slots only.
/// The flagged sender is on-chain evidence — useful for senderside
/// rate-limiting, allowlisting, or social-layer recourse.
public fun mark_bad_ct(
    epoch: &mut NebulaEpoch,
    inbox: &Nebula,
    slot: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == inbox.owner, ENotOwner);
    assert!(epoch.inbox == object::id(inbox), 0);
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

// === Public read accessors (for client + indexer use) ===

public fun owner(inbox: &Nebula): address { inbox.owner }
public fun ek(inbox: &Nebula): &vector<u8> { &inbox.ek_compressed }
public fun ell_max(inbox: &Nebula): u64 { inbox.ell_max }
public fun epoch_padding(inbox: &Nebula): u64 { inbox.epoch_padding }
public fun current_epoch_no(inbox: &Nebula): u64 { inbox.current_epoch }

public fun epoch_inbox(epoch: &NebulaEpoch): ID { epoch.inbox }
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
