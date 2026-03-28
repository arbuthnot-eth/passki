// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Thunder — encrypt messaging between SuiNS identities.
///
/// Storm is the shared object. Anyone can deposit a strike.
/// Only the SuiNS name owner can claim (NFT-gated).
/// Cloud holds strikes per name. Claiming emits Struck events
/// with the decrypt key. Empty clouds are removed for storage rebate.
module thunder::thunder;

use sui::dynamic_field;
use sui::hash::keccak256;
use sui::event;
use sui::clock::Clock;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmpty: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

/// Emitted on deposit — lightning bolt hits the cloud.
public struct Bolt has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted on claim — contains everything the client needs to decrypt.
public struct Struck has copy, drop {
    name_hash: vector<u8>,
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
}

// ─── Types ──────────────────────────────────────────────────────────

/// The shared object — always-on infrastructure.
public struct Storm has key {
    id: UID,
}

/// A single encrypt message.
public struct Strike has store, copy, drop {
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

/// Per-name inbox. Dynamic field on Storm, keyed by name_hash.
public struct Cloud has store {
    strikes: vector<Strike>,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Storm { id: object::new(ctx) });
}

// ─── Deposit ────────────────────────────────────────────────────────

/// Deposit a strike into someone's cloud. Permissionless — anyone can send.
entry fun deposit(
    storm: &mut Storm,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let strike = Strike { payload, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&storm.id, name_hash)) {
        let cloud: &mut Cloud = dynamic_field::borrow_mut(&mut storm.id, name_hash);
        cloud.strikes.push_back(strike);
    } else {
        dynamic_field::add(&mut storm.id, name_hash, Cloud { strikes: vector[strike] });
    };

    event::emit(Bolt { name_hash, timestamp_ms });
}

// ─── Claim (NFT-gated) ─────────────────────────────────────────────

/// Claim the first strike from your cloud. Requires SuinsRegistration NFT.
/// Un-XORs the AES key and emits Struck with payload + key + nonce.
/// Batch multiple claims in one PTB.
entry fun claim(
    storm: &mut Storm,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let cloud: &mut Cloud = dynamic_field::borrow_mut(&mut storm.id, name_hash);
    assert!(!cloud.strikes.is_empty(), EEmpty);

    let strike = cloud.strikes.remove(0);
    let empty = cloud.strikes.is_empty();

    // Remove empty cloud → full storage rebate
    if (empty) {
        let Cloud { strikes: _ } = dynamic_field::remove<vector<u8>, Cloud>(&mut storm.id, name_hash);
    };

    // Un-XOR the key
    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(strike.aes_key, mask);

    event::emit(Struck {
        name_hash,
        payload: strike.payload,
        aes_key: real_key,
        aes_nonce: strike.aes_nonce,
    });
}

// ─── Queries ────────────────────────────────────────────────────────

/// Count pending strikes. Permissionless.
public fun count(storm: &Storm, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&storm.id, name_hash)) return 0;
    let cloud: &Cloud = dynamic_field::borrow(&storm.id, name_hash);
    cloud.strikes.length()
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
