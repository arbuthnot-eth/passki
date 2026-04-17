// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Seal policy module for roster reader approval.
///
/// Gates Seal decryption: only addresses registered in the Roster
/// can decrypt Seal-encrypted cross-chain address blobs.
module suiami::seal_roster;

use suiami::roster::{Self, Roster};

const ENotRegistered: u64 = 100;
const EInvalidIdentity: u64 = 101;
const ENoEncryptedData: u64 = 102;

entry fun seal_approve_roster_reader(
    roster: &Roster,
    id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(id.length() == 40, EInvalidIdentity);
    let sender = ctx.sender();
    assert!(roster::has_address(roster, sender), ENotRegistered);
    let record = roster::lookup_by_address(roster, sender);
    assert!(roster::record_walrus_blob_id(record).length() > 0, ENoEncryptedData);
    // Tightened: id prefix must match caller's address bytes so a
    // holder can't sign decrypt on a Seal id scoped to a different
    // member. Harmless today (mutual policy still lets them in) but
    // future-proofs if mutual semantics ever narrow.
    let addr_bytes = sui::address::to_bytes(sender);
    let mut i = 0u64;
    while (i < 32) {
        assert!(*id.borrow(i) == *addr_bytes.borrow(i), EInvalidIdentity);
        i = i + 1;
    };
}

/// v2 of the roster-reader Seal policy. Two fixes vs v1:
///
/// 1. **Argument order** — Seal key servers require `id: vector<u8>`
///    as the first user-visible parameter. v1 had `roster` first,
///    which trips `Invalid first parameter for seal_approve` on every
///    decrypt.
/// 2. **Identity check** — v1 compared id prefix to `sender_address`,
///    but the client encrypts with `keccak256(bare_name)` ids
///    (`deriveSuiamiSealId` in `src/client/suiami-seal.ts`). They
///    never matched, so no blob was ever decryptable. v2 looks up
///    the name directly: the id's first 32 bytes are the name hash,
///    and the sender must be the on-chain owner of that name.
///
/// Structured for ENS extensibility — adding a parallel
/// `roster::has_ens_name(ens_hash)` lookup is a compatible upgrade
/// (see `project_ens_waap_extension.md`).
entry fun seal_approve_roster_reader_v2(
    id: vector<u8>,
    roster: &Roster,
    ctx: &TxContext,
) {
    assert!(id.length() == 40, EInvalidIdentity);
    let sender = ctx.sender();

    // Extract the 32-byte name hash (id prefix).
    let mut name_hash = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) {
        name_hash.push_back(*id.borrow(i));
        i = i + 1;
    };

    // Name must be registered and owned by sender.
    assert!(roster::has_name(roster, name_hash), ENotRegistered);
    let record = roster::lookup_by_name(roster, name_hash);
    assert!(roster::record_sui_address(record) == sender, ENotRegistered);
    assert!(roster::record_walrus_blob_id(record).length() > 0, ENoEncryptedData);
}

/// Personal CF-history decrypt policy. Only the record owner can
/// decrypt their own CF chunks — not mutual-decrypt like the roster
/// reader policy. Seal id layout: 32-byte sender address ‖ 8-byte nonce.
entry fun seal_approve_cf_history(
    roster: &Roster,
    id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(id.length() == 40, EInvalidIdentity);
    let sender = ctx.sender();
    assert!(roster::has_cf_history(roster, sender), ENoEncryptedData);
    // Id prefix must be the sender's address bytes — prevents a caller
    // from passing someone else's Seal id even though policy is scoped
    // to their own address.
    let addr_bytes = sui::address::to_bytes(sender);
    let mut i = 0u64;
    while (i < 32) {
        assert!(*id.borrow(i) == *addr_bytes.borrow(i), ENotRegistered);
        i = i + 1;
    };
}
