/// Module: darkrai::group_storm
///
/// Multi-recipient batch-threshold-encrypted Storm.
///
/// Direct messages between two SuiNS identities use `darkrai::inbox`
/// (per-recipient inbox key). Multi-participant Storms — group chats —
/// can't use that pattern because no single recipient holds the master
/// `sk`. Instead, each GroupStorm has its own `(ek, sk, dk)` derived
/// off-chain by the participants (e.g., via IKA 2PC-MPC). The shared
/// `sk` is Seal-protected to a per-group committee (or the union of the
/// participants' Seal commitments).
///
/// On-chain shape mirrors `Inbox` / `InboxEpoch` but with a participants
/// vec_set instead of a single owner, and seal authority delegated to
/// any participant (vs only the owner in `Inbox`).
module darkrai::group_storm;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::vec_set::{Self, VecSet};

const ENotParticipant: u64 = 0;
const EBadCtSize: u64 = 1;
const EBadEkSize: u64 = 2;
const EBadSbkSize: u64 = 3;
const EEllNotPowerOfTwo: u64 = 4;
const EEpochFull: u64 = 5;
const EEpochAlreadySealed: u64 = 6;
const EBadCtIndex: u64 = 7;
const EPrevEpochNotSealed: u64 = 8;
const ECannotMarkAfterSeal: u64 = 9;

const CT_BYTES: u64 = 704;
const EK_BYTES: u64 = 576;
const SBK_BYTES: u64 = 48;

public struct GroupStorm has key, store {
    id: UID,
    creator: address,
    /// Participants — addresses with permission to post + seal epochs.
    participants: VecSet<address>,
    /// Display name. Informational.
    name: String,
    /// 576 B compressed BLS12-381 GT element. Senders encrypt pads to this.
    ek_compressed: vector<u8>,
    /// Opaque pointer to where the Seal-protected sk is stored.
    committee_ref: vector<u8>,
    ell_max: u64,
    epoch_padding: u64,
    current_epoch: u64,
    version: u64,
}

public struct GroupStormEpoch has key, store {
    id: UID,
    storm: ID,
    epoch_no: u64,
    cts: vector<vector<u8>>,
    aead_payloads: vector<vector<u8>>,
    senders: vector<address>,
    walrus_blob_ids: vector<vector<u8>>,
    bad_ct_indices: VecSet<u64>,
    sbk: vector<u8>,
    sealed_at_ms: u64,
    /// Which participant published `sbk`. Empty until sealed.
    sealed_by: vector<u8>,
}

public struct GroupStormOpened has copy, drop {
    storm: ID,
    creator: address,
    n_participants: u64,
    ell_max: u64,
}

public struct GroupThunderPosted has copy, drop {
    epoch: ID,
    storm: ID,
    epoch_no: u64,
    slot: u64,
    sender: address,
}

public struct GroupEpochSealed has copy, drop {
    epoch: ID,
    storm: ID,
    epoch_no: u64,
    sealed_by: address,
    sealed_at_ms: u64,
    n_messages: u64,
}

public struct GroupEpochRotated has copy, drop {
    storm: ID,
    prev_epoch: ID,
    new_epoch: ID,
    new_epoch_no: u64,
}

// === Open ===

public fun open(
    name: String,
    participants: vector<address>,
    ek_compressed: vector<u8>,
    committee_ref: vector<u8>,
    ell_max: u64,
    epoch_padding: u64,
    ctx: &mut TxContext,
): GroupStorm {
    assert!(ek_compressed.length() == EK_BYTES, EBadEkSize);
    assert!(is_power_of_two(ell_max), EEllNotPowerOfTwo);
    let creator = ctx.sender();
    let mut set = vec_set::empty<address>();
    let mut i = 0;
    let n = participants.length();
    while (i < n) {
        let p = participants[i];
        if (!set.contains(&p)) { set.insert(p) };
        i = i + 1;
    };
    if (!set.contains(&creator)) { set.insert(creator) };

    let storm = GroupStorm {
        id: object::new(ctx),
        creator,
        participants: set,
        name,
        ek_compressed,
        committee_ref,
        ell_max,
        epoch_padding,
        current_epoch: 0,
        version: 1,
    };
    event::emit(GroupStormOpened {
        storm: object::id(&storm),
        creator,
        n_participants: storm.participants.length(),
        ell_max,
    });
    storm
}

fun new_epoch(storm: &GroupStorm, epoch_no: u64, ctx: &mut TxContext): GroupStormEpoch {
    GroupStormEpoch {
        id: object::new(ctx),
        storm: object::id(storm),
        epoch_no,
        cts: vector[],
        aead_payloads: vector[],
        senders: vector[],
        walrus_blob_ids: vector[],
        bad_ct_indices: vec_set::empty(),
        sbk: vector[],
        sealed_at_ms: 0,
        sealed_by: vector[],
    }
}

// === Post / Seal / Rotate ===

public fun post_thunder(
    epoch: &mut GroupStormEpoch,
    storm: &GroupStorm,
    ct: vector<u8>,
    aead_payload: vector<u8>,
    walrus_blob_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(epoch.storm == object::id(storm), 0);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(ct.length() == CT_BYTES, EBadCtSize);
    let sender = ctx.sender();
    assert!(storm.participants.contains(&sender), ENotParticipant);
    let n = epoch.cts.length();
    assert!(n < storm.ell_max, EEpochFull);

    epoch.cts.push_back(ct);
    epoch.aead_payloads.push_back(aead_payload);
    epoch.senders.push_back(sender);
    epoch.walrus_blob_ids.push_back(walrus_blob_id);

    event::emit(GroupThunderPosted {
        epoch: object::id(epoch),
        storm: object::id(storm),
        epoch_no: epoch.epoch_no,
        slot: n,
        sender,
    });
}

/// Any participant can seal — the group's `sk` is shared, so any of them
/// can produce `sbk` once the offline 2PC-MPC pre_decrypt flow is done.
public fun seal_epoch(
    epoch: &mut GroupStormEpoch,
    storm: &GroupStorm,
    sbk: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(epoch.storm == object::id(storm), 0);
    let actor = ctx.sender();
    assert!(storm.participants.contains(&actor), ENotParticipant);
    assert!(epoch.sealed_at_ms == 0, EEpochAlreadySealed);
    assert!(sbk.length() == SBK_BYTES, EBadSbkSize);

    epoch.sbk = sbk;
    epoch.sealed_at_ms = clock.timestamp_ms();
    epoch.sealed_by = sui::address::to_bytes(actor);

    event::emit(GroupEpochSealed {
        epoch: object::id(epoch),
        storm: object::id(storm),
        epoch_no: epoch.epoch_no,
        sealed_by: actor,
        sealed_at_ms: epoch.sealed_at_ms,
        n_messages: epoch.cts.length(),
    });
}

public fun rotate_epoch(
    storm: &mut GroupStorm,
    prev: &GroupStormEpoch,
    ctx: &mut TxContext,
): GroupStormEpoch {
    let actor = ctx.sender();
    assert!(storm.participants.contains(&actor), ENotParticipant);
    assert!(prev.storm == object::id(storm), 0);
    assert!(prev.sealed_at_ms != 0, EPrevEpochNotSealed);

    storm.current_epoch = storm.current_epoch + 1;
    let next = new_epoch(storm, storm.current_epoch, ctx);
    event::emit(GroupEpochRotated {
        storm: object::id(storm),
        prev_epoch: object::id(prev),
        new_epoch: object::id(&next),
        new_epoch_no: storm.current_epoch,
    });
    next
}

public fun mark_bad_ct(
    epoch: &mut GroupStormEpoch,
    storm: &GroupStorm,
    slot: u64,
    ctx: &TxContext,
) {
    assert!(epoch.storm == object::id(storm), 0);
    let actor = ctx.sender();
    assert!(storm.participants.contains(&actor), ENotParticipant);
    assert!(epoch.sealed_at_ms == 0, ECannotMarkAfterSeal);
    assert!(slot < epoch.cts.length(), EBadCtIndex);
    epoch.bad_ct_indices.insert(slot);
}

// === Membership ===

public fun add_participant(storm: &mut GroupStorm, who: address, ctx: &TxContext) {
    let actor = ctx.sender();
    assert!(actor == storm.creator, ENotParticipant);
    if (!storm.participants.contains(&who)) {
        storm.participants.insert(who);
    };
}

public fun leave(storm: &mut GroupStorm, ctx: &TxContext) {
    let actor = ctx.sender();
    assert!(storm.participants.contains(&actor), ENotParticipant);
    storm.participants.remove(&actor);
}

// === Read accessors ===

public fun creator(storm: &GroupStorm): address { storm.creator }
public fun participants(storm: &GroupStorm): &VecSet<address> { &storm.participants }
public fun is_participant(storm: &GroupStorm, who: address): bool { storm.participants.contains(&who) }
public fun ek(storm: &GroupStorm): &vector<u8> { &storm.ek_compressed }

public fun epoch_storm(epoch: &GroupStormEpoch): ID { epoch.storm }
public fun epoch_no(epoch: &GroupStormEpoch): u64 { epoch.epoch_no }
public fun epoch_cts(epoch: &GroupStormEpoch): &vector<vector<u8>> { &epoch.cts }
public fun epoch_payloads(epoch: &GroupStormEpoch): &vector<vector<u8>> { &epoch.aead_payloads }
public fun epoch_sbk(epoch: &GroupStormEpoch): &vector<u8> { &epoch.sbk }
public fun epoch_is_sealed(epoch: &GroupStormEpoch): bool { epoch.sealed_at_ms != 0 }

fun is_power_of_two(n: u64): bool {
    n > 0 && (n & (n - 1)) == 0
}
