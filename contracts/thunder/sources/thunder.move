// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Thunder — encrypt signals between SuiNS identities.
///
/// Storm is the shared object. Anyone can send a signal.
/// Only the SuiNS name owner can quest (NFT-gated).
/// Ragtag holds signals per name. Questing emits decrypted keys.
/// Empty ragtags are removed for storage rebate.
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

/// Emitted when a signal is sent.
public struct Signaled has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted on quest — contains everything the client needs to decrypt.
public struct Questfi has copy, drop {
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

/// A single encrypt signal.
public struct Signal has store, copy, drop {
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

/// Per-name ragtag. Dynamic field on Storm, keyed by name_hash.
public struct Ragtag has store {
    signals: vector<Signal>,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Storm { id: object::new(ctx) });
}

// ─── Send ──────────────────────────────────────────────────────────

/// Send a signal to someone's ragtag. Permissionless — anyone can send.
entry fun signal(
    storm: &mut Storm,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let sig = Signal { payload, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&storm.id, name_hash)) {
        let ragtag: &mut Ragtag = dynamic_field::borrow_mut(&mut storm.id, name_hash);
        ragtag.signals.push_back(sig);
    } else {
        dynamic_field::add(&mut storm.id, name_hash, Ragtag { signals: vector[sig] });
    };

    event::emit(Signaled { name_hash, timestamp_ms });
}

// ─── Claim (NFT-gated) ─────────────────────────────────────────────

/// Quest — claim the first signal from your ragtag. Requires SuinsRegistration NFT.
/// Un-XORs the AES key and emits Questfi with payload + key + nonce.
/// Batch multiple quests in one PTB.
entry fun quest(
    storm: &mut Storm,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let ragtag: &mut Ragtag = dynamic_field::borrow_mut(&mut storm.id, name_hash);
    assert!(!ragtag.signals.is_empty(), EEmpty);

    let sig = ragtag.signals.remove(0);
    let empty = ragtag.signals.is_empty();

    // Remove empty ragtag → full storage rebate
    if (empty) {
        let Ragtag { signals: _ } = dynamic_field::remove<vector<u8>, Ragtag>(&mut storm.id, name_hash);
    };

    // Un-XOR the key
    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(sig.aes_key, mask);

    event::emit(Questfi {
        name_hash,
        payload: sig.payload,
        aes_key: real_key,
        aes_nonce: sig.aes_nonce,
    });
}

// ─── Queries ────────────────────────────────────────────────────────

/// Count pending signals. Permissionless.
public fun count(storm: &Storm, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&storm.id, name_hash)) return 0;
    let ragtag: &Ragtag = dynamic_field::borrow(&storm.id, name_hash);
    ragtag.signals.length()
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
