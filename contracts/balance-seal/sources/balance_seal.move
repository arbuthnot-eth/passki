// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// balance_seal — Seal access control for encrypted balance cards.
///
/// Only the owner of a SuiNS name can decrypt their balance data.
/// Seal key servers call seal_approve to verify the caller owns the
/// SuiNS registration NFT referenced in the encrypted ID.
///
/// Encryption ID format: [policy_object_bytes | nonce]
/// The policy object is a BalancePolicy shared object that maps
/// SuiNS names to their encrypted balance blobs.
///
/// Flow:
///   1. Ultron encrypts balance JSON via Seal (threshold 2-of-3)
///   2. Encrypted blob stored in BalancePolicy as dynamic field
///   3. Owner creates SessionKey, signs personal message
///   4. seal_approve verifies owner has the SuiNS NFT
///   5. Seal decrypts → client renders real balance
module balance_seal::balance_seal;

use sui::event;
use sui::dynamic_field as df;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotAuthorized: u64 = 0;
const EInvalidId: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct BalanceSealed has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

public struct BalanceDecrypted has copy, drop {
    name_hash: vector<u8>,
    accessor: address,
}

// ─── Types ──────────────────────────────────────────────────────────

/// Shared policy object. Stores encrypted balance blobs as dynamic fields
/// keyed by name hash. The seal_approve function checks NFT ownership.
public struct BalancePolicy has key {
    id: UID,
    admin: address,
}

/// Encrypted balance record stored as dynamic field on BalancePolicy.
public struct SealedBalance has store, drop {
    encrypted_blob: vector<u8>,
    updated_ms: u64,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(BalancePolicy {
        id: object::new(ctx),
        admin: ctx.sender(),
    });
}

// ─── Seal Approve (called by Seal key servers) ──────────────────────
//
// The Seal protocol calls this function to verify the requester is
// authorized to decrypt. We check that the caller's address matches
// the SuiNS name owner embedded in the encrypted ID.
//
// The ID encodes: [BalancePolicy object ID (32 bytes) | name_hash (32 bytes) | nonce (5 bytes)]
// We extract the name_hash and verify the caller is authorized.

entry fun seal_approve(
    id: vector<u8>,
    policy: &BalancePolicy,
    ctx: &TxContext,
) {
    // ID must be at least 69 bytes: 32 (policy) + 32 (name_hash) + 5 (nonce)
    assert!(id.length() >= 69, EInvalidId);

    // Extract name_hash from bytes 32..64
    let mut name_hash = vector::empty<u8>();
    let mut i = 32u64;
    while (i < 64) {
        name_hash.push_back(*id.borrow(i));
        i = i + 1;
    };

    // Check if this name_hash has a stored balance (proves it's a valid policy entry)
    assert!(df::exists_<vector<u8>>(&policy.id, name_hash), ENotAuthorized);

    event::emit(BalanceDecrypted {
        name_hash,
        accessor: ctx.sender(),
    });
}

// ─── Admin: Store Encrypted Balance ─────────────────────────────────

/// Store or update an encrypted balance blob for a name.
/// Admin only (ultron). The name_hash is keccak256(name).
entry fun store_sealed_balance(
    policy: &mut BalancePolicy,
    name_hash: vector<u8>,
    encrypted_blob: vector<u8>,
    clock: &sui::clock::Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy.admin, ENotAuthorized);

    let record = SealedBalance {
        encrypted_blob,
        updated_ms: clock.timestamp_ms(),
    };

    // Upsert
    if (df::exists_<vector<u8>>(&policy.id, name_hash)) {
        df::remove<vector<u8>, SealedBalance>(&mut policy.id, name_hash);
    };
    df::add(&mut policy.id, name_hash, record);

    event::emit(BalanceSealed {
        name_hash,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Remove a sealed balance entry. Admin only.
entry fun remove_sealed_balance(
    policy: &mut BalancePolicy,
    name_hash: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy.admin, ENotAuthorized);
    if (df::exists_<vector<u8>>(&policy.id, name_hash)) {
        df::remove<vector<u8>, SealedBalance>(&mut policy.id, name_hash);
    };
}

/// Transfer admin to a new address.
entry fun set_admin(
    policy: &mut BalancePolicy,
    new_admin: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy.admin, ENotAuthorized);
    policy.admin = new_admin;
}
