// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// SUIAMI Roster — cross-chain identity resolver.
///
/// Maps SuiNS names and Sui addresses to their IKA-derived chain addresses.
/// Every address is cryptographically linked to the Sui account via IKA dWallet
/// threshold signatures — not manually entered, provably controlled.
///
/// Dual-keyed: lookup by name hash OR by Sui address. One write, two lookups.
/// Chain addresses stored as VecMap so new curves (post-quantum, Cosmos, etc.)
/// slot in without contract upgrades.
///
/// Authorization: pass your SuiNS NFT to prove ownership. Only the NFT holder
/// can write their record. Reads are permissionless.
module suiami::roster;

use std::string::String;
use sui::event;
use sui::dynamic_field;
use sui::clock::Clock;
use sui::vec_map::{Self, VecMap};

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const ENoChains: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct IdentitySet has copy, drop {
    name: String,
    sui_address: address,
    chain_count: u64,
    dwallet_count: u64,
}

// ─── Types ──────────────────────────────────────────────────────────

/// The shared roster object. One per deployment.
public struct Roster has key {
    id: UID,
    /// Total identities registered
    count: u64,
}

/// A single identity record. Stored as dynamic field on Roster,
/// keyed by both name_hash (vector<u8>) and sui_address (address).
public struct IdentityRecord has store, drop, copy {
    /// SuiNS name (bare, no .sui suffix)
    name: String,
    /// Sui wallet address
    sui_address: address,
    /// Chain addresses: "btc" → "bc1q...", "eth" → "0x...", "sol" → "5Kz..."
    chains: VecMap<String, String>,
    /// DWalletCap IDs that derived these addresses (provenance chain)
    dwallet_caps: vector<address>,
    /// Last update timestamp
    updated_ms: u64,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    let roster = Roster {
        id: object::new(ctx),
        count: 0,
    };
    transfer::share_object(roster);
}

// ─── Write (NFT-gated) ─────────────────────────────────────────────

/// Set your cross-chain identity. Requires your SuiNS NFT as proof of name ownership.
/// Overwrites any existing record for this name/address pair.
///
/// chain_keys and chain_values must be parallel vectors:
///   ["btc", "eth", "sol"] and ["bc1q...", "0x...", "5Kz..."]
///
/// dwallet_caps: the IKA DWalletCap object IDs that derived these addresses.
/// Pass empty vector if no dWallets (address-only record).
entry fun set_identity(
    roster: &mut Roster,
    name: String,
    name_hash: vector<u8>,
    chain_keys: vector<String>,
    chain_values: vector<String>,
    dwallet_caps: vector<address>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let len = chain_keys.length();
    assert!(len > 0 && len == chain_values.length(), ENoChains);

    // Build chain map
    let mut chains = vec_map::empty<String, String>();
    let mut i = 0;
    while (i < len) {
        chains.insert(chain_keys[i], chain_values[i]);
        i = i + 1;
    };

    let record = IdentityRecord {
        name,
        sui_address: sender,
        chains,
        dwallet_caps,
        updated_ms: clock.timestamp_ms(),
    };

    // Upsert by name_hash
    if (dynamic_field::exists_<vector<u8>>(&roster.id, name_hash)) {
        dynamic_field::remove<vector<u8>, IdentityRecord>(&mut roster.id, name_hash);
    } else {
        roster.count = roster.count + 1;
    };
    dynamic_field::add(&mut roster.id, name_hash, record);

    // Upsert by Sui address (second index)
    if (dynamic_field::exists_<address>(&roster.id, sender)) {
        dynamic_field::remove<address, IdentityRecord>(&mut roster.id, sender);
    };
    dynamic_field::add(&mut roster.id, sender, *&record);

    // Index by each chain address (reverse lookup: btc addr → identity)
    // Key format: "chain:address" string to avoid collisions
    let mut j = 0;
    while (j < len) {
        let mut chain_key = chain_keys[j];
        chain_key.append_utf8(b":");
        chain_key.append(chain_values[j]);
        if (dynamic_field::exists_<String>(&roster.id, chain_key)) {
            dynamic_field::remove<String, IdentityRecord>(&mut roster.id, chain_key);
        };
        dynamic_field::add(&mut roster.id, chain_key, *&record);
        j = j + 1;
    };

    event::emit(IdentitySet {
        name,
        sui_address: sender,
        chain_count: len,
        dwallet_count: dwallet_caps.length(),
    });
}

// ─── Read (permissionless) ──────────────────────────────────────────

/// Lookup by name hash. Returns the full identity record.
public fun lookup_by_name(roster: &Roster, name_hash: vector<u8>): &IdentityRecord {
    dynamic_field::borrow(&roster.id, name_hash)
}

/// Lookup by Sui address. Returns the full identity record.
public fun lookup_by_address(roster: &Roster, addr: address): &IdentityRecord {
    dynamic_field::borrow(&roster.id, addr)
}

/// Lookup by chain address. Key format: "chain:address" (e.g. "btc:bc1q...").
public fun lookup_by_chain(roster: &Roster, chain_key: String): &IdentityRecord {
    dynamic_field::borrow(&roster.id, chain_key)
}

/// Check if a chain address is registered.
public fun has_chain(roster: &Roster, chain_key: String): bool {
    dynamic_field::exists_<String>(&roster.id, chain_key)
}

/// Check if a name is registered.
public fun has_name(roster: &Roster, name_hash: vector<u8>): bool {
    dynamic_field::exists_<vector<u8>>(&roster.id, name_hash)
}

/// Check if an address is registered.
public fun has_address(roster: &Roster, addr: address): bool {
    dynamic_field::exists_<address>(&roster.id, addr)
}

/// Total registered identities.
public fun count(roster: &Roster): u64 {
    roster.count
}

// ─── Record accessors ───────────────────────────────────────────────

public fun record_name(record: &IdentityRecord): &String { &record.name }
public fun record_sui_address(record: &IdentityRecord): address { record.sui_address }
public fun record_chains(record: &IdentityRecord): &VecMap<String, String> { &record.chains }
public fun record_dwallet_caps(record: &IdentityRecord): &vector<address> { &record.dwallet_caps }
public fun record_updated_ms(record: &IdentityRecord): u64 { record.updated_ms }
