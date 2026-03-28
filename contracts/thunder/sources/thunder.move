// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Thunder — encrypt messaging between SuiNS identities.
///
/// Thunder.in is a shared object. Anyone can deposit a thunder
/// (permissionless send). Only the SuiNS name owner can strike
/// (NFT-gated — key material emitted in events).
///
/// The AES key is XOR-masked with keccak256(nft_object_id) on-chain.
/// strike un-XORs and emits the real key in a ThunderStruck event.
/// Multiple strikes can be batched in a single PTB.
module thunder::thunder;

use sui::dynamic_field;
use sui::hash::keccak256;
use sui::event;
use sui::clock::Clock;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmptyInbox: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct ThunderDeposited has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted on strike — contains everything the client needs to decrypt.
public struct ThunderStruck has copy, drop {
    name_hash: vector<u8>,
    blob_id: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
}

// ─── Types ──────────────────────────────────────────────────────────

public struct Thunder has key {
    id: UID,
}

public struct ThunderBolt has store, copy, drop {
    blob_id: vector<u8>,
    /// AES-256-GCM key (32 bytes) — XOR-masked with keccak256(nft_object_id).
    aes_key: vector<u8>,
    /// AES-256-GCM nonce (12 bytes).
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

public struct ThunderInbox has store {
    bolts: vector<ThunderBolt>,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Thunder { id: object::new(ctx) });
}

// ─── Deposit (permissionless) ───────────────────────────────────────

/// Deposit a thunder. Anyone can send.
/// The masked_aes_key should be XOR'd with keccak256(recipient_nft_object_id)
/// by the sender before calling this.
entry fun deposit(
    thunder_in: &mut Thunder,
    name_hash: vector<u8>,
    blob_id: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let bolt = ThunderBolt { blob_id, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&thunder_in.id, name_hash)) {
        let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut thunder_in.id, name_hash);
        inbox.bolts.push_back(bolt);
    } else {
        dynamic_field::add(&mut thunder_in.id, name_hash, ThunderInbox { bolts: vector[bolt] });
    };

    event::emit(ThunderDeposited { name_hash, timestamp_ms });
}

// ─── Strike (NFT-gated) ────────────────────────────────────────────

/// Strike — claim the first thunder. Requires the SuinsRegistration NFT.
/// Un-XORs the AES key and emits it in a ThunderStruck event.
/// Batch multiple strikes in one PTB to decrypt all pending thunders.
entry fun strike(
    thunder_in: &mut Thunder,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    // Verify NFT ownership
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut thunder_in.id, name_hash);
    assert!(!inbox.bolts.is_empty(), EEmptyInbox);

    let bolt = inbox.bolts.remove(0);

    // Un-XOR the key with keccak256(nft_object_id)
    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(bolt.aes_key, mask);

    // Emit everything the client needs to decrypt
    event::emit(ThunderStruck {
        name_hash,
        blob_id: bolt.blob_id,
        aes_key: real_key,
        aes_nonce: bolt.aes_nonce,
    });
}

// ─── Read-only queries ──────────────────────────────────────────────

/// Count pending thunders. Permissionless.
public fun count(thunder_in: &Thunder, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&thunder_in.id, name_hash)) return 0;
    let inbox: &ThunderInbox = dynamic_field::borrow(&thunder_in.id, name_hash);
    inbox.bolts.length()
}

/// Peek at the first thunder's blob_id + timestamp (no key revealed).
public fun peek(thunder_in: &Thunder, name_hash: vector<u8>): (vector<u8>, u64) {
    let inbox: &ThunderInbox = dynamic_field::borrow(&thunder_in.id, name_hash);
    assert!(!inbox.bolts.is_empty(), EEmptyInbox);
    let b = &inbox.bolts[0];
    (b.blob_id, b.timestamp_ms)
}

// ─── Helpers ────────────────────────────────────────────────────────

fun xor_bytes(data: vector<u8>, mask: vector<u8>): vector<u8> {
    let mut result = vector[];
    let mask_len = mask.length();
    let mut i = 0;
    while (i < data.length()) {
        result.push_back(data[i] ^ mask[i % mask_len]);
        i = i + 1;
    };
    result
}
