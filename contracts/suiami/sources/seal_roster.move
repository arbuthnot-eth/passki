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
    assert!(roster::has_address(roster, ctx.sender()), ENotRegistered);
    let record = roster::lookup_by_address(roster, ctx.sender());
    assert!(roster::record_walrus_blob_id(record).length() > 0, ENoEncryptedData);
}
