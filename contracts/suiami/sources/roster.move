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
    /// Walrus blob containing Seal-encrypted cross-chain addresses
    walrus_blob_id: String,
    /// Seal encryption nonce
    seal_nonce: vector<u8>,
    /// true if dwallet_caps is non-empty
    verified: bool,
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
    walrus_blob_id: String,
    seal_nonce: vector<u8>,
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

    let verified = !dwallet_caps.is_empty();
    let record = IdentityRecord {
        name,
        sui_address: sender,
        chains,
        dwallet_caps,
        updated_ms: clock.timestamp_ms(),
        walrus_blob_id,
        seal_nonce,
        verified,
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
public fun record_walrus_blob_id(record: &IdentityRecord): &String { &record.walrus_blob_id }
public fun record_seal_nonce(record: &IdentityRecord): &vector<u8> { &record.seal_nonce }
public fun record_verified(record: &IdentityRecord): bool { record.verified }

// ─── CF edge history (Porygon) ──────────────────────────────────────
//
// Append-only log of Seal-sealed Walrus blob IDs, one per CF fingerprint
// change. Stored as a separate dynamic field keyed by wallet address so
// the additive upgrade doesn't touch IdentityRecord's BCS shape. Client
// does change detection before appending (typical user: 1-3 lifetime
// entries).

/// Dynamic-field key for per-address CF history store.
public struct CfHistoryKey has copy, drop, store { addr: address }

/// CF-history container. `blobs` is oldest-first.
public struct CfHistory has store, drop {
    blobs: vector<String>,
    updated_ms: u64,
}

/// Append a Walrus blob ID to the caller's CF history. Creates the
/// history store on first write. Asserts the caller has a roster
/// record (prevents anonymous writes from consuming storage).
public fun append_cf_history(
    roster: &mut Roster,
    blob_id: String,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let key = CfHistoryKey { addr: sender };
    if (dynamic_field::exists_<CfHistoryKey>(&roster.id, key)) {
        let history: &mut CfHistory = dynamic_field::borrow_mut(&mut roster.id, key);
        history.blobs.push_back(blob_id);
        history.updated_ms = clock.timestamp_ms();
    } else {
        let mut blobs = vector::empty<String>();
        blobs.push_back(blob_id);
        dynamic_field::add(&mut roster.id, key, CfHistory {
            blobs,
            updated_ms: clock.timestamp_ms(),
        });
    };
}

/// Read the caller's or any address's CF history blob IDs.
public fun cf_history(roster: &Roster, addr: address): &vector<String> {
    let key = CfHistoryKey { addr };
    let h: &CfHistory = dynamic_field::borrow(&roster.id, key);
    &h.blobs
}

/// Last-updated timestamp of the CF history store.
public fun cf_history_updated_ms(roster: &Roster, addr: address): u64 {
    let key = CfHistoryKey { addr };
    let h: &CfHistory = dynamic_field::borrow(&roster.id, key);
    h.updated_ms
}

/// Does this address have any CF history? Checked by Seal policy.
public fun has_cf_history(roster: &Roster, addr: address): bool {
    let key = CfHistoryKey { addr };
    dynamic_field::exists_<CfHistoryKey>(&roster.id, key)
}

// ─── Granular mutators ──────────────────────────────────────────────
//
// Update a single field without rewriting the whole record via
// `set_identity`. Callers pass `name_hash` because it's not stored on
// the record but is needed to locate the by_name index copy. Every
// mutator propagates to all three dynamic-field indexes to prevent
// drift.

/// Rewrites name_hash / sui_address / chain:addr indexes with the same
/// record bytes. Internal — mutators call this after updating fields.
fun rewrite_indexes(roster_id: &mut UID, record: &IdentityRecord, name_hash: vector<u8>) {
    if (dynamic_field::exists_<vector<u8>>(roster_id, name_hash)) {
        dynamic_field::remove<vector<u8>, IdentityRecord>(roster_id, name_hash);
    };
    dynamic_field::add(roster_id, name_hash, *record);

    let addr = record.sui_address;
    if (dynamic_field::exists_<address>(roster_id, addr)) {
        dynamic_field::remove<address, IdentityRecord>(roster_id, addr);
    };
    dynamic_field::add(roster_id, addr, *record);

    let keys = record.chains.keys();
    let len = keys.length();
    let mut i = 0;
    while (i < len) {
        let chain_key = keys[i];
        let chain_value = *record.chains.get(&chain_key);
        let mut composite = chain_key;
        composite.append_utf8(b":");
        composite.append(chain_value);
        if (dynamic_field::exists_<String>(roster_id, composite)) {
            dynamic_field::remove<String, IdentityRecord>(roster_id, composite);
        };
        dynamic_field::add(roster_id, composite, *record);
        i = i + 1;
    };
}

/// Rotate Walrus blob id + Seal nonce. Caller must own the by_address
/// record. Propagates to all three indexes.
public fun set_walrus_blob(
    roster: &mut Roster,
    name_hash: vector<u8>,
    blob_id: String,
    seal_nonce: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let current: &IdentityRecord = dynamic_field::borrow<address, IdentityRecord>(&roster.id, sender);
    assert!(current.sui_address == sender, ENotOwner);
    let mut updated: IdentityRecord = *current;
    updated.walrus_blob_id = blob_id;
    updated.seal_nonce = seal_nonce;
    updated.updated_ms = clock.timestamp_ms();
    rewrite_indexes(&mut roster.id, &updated, name_hash);
}

/// Replace dWallet caps (flips `verified` based on non-emptiness).
/// Caller must own the by_address record.
public fun set_dwallet_caps(
    roster: &mut Roster,
    name_hash: vector<u8>,
    caps: vector<address>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let current: &IdentityRecord = dynamic_field::borrow<address, IdentityRecord>(&roster.id, sender);
    assert!(current.sui_address == sender, ENotOwner);
    let mut updated: IdentityRecord = *current;
    updated.dwallet_caps = caps;
    updated.verified = !updated.dwallet_caps.is_empty();
    updated.updated_ms = clock.timestamp_ms();
    rewrite_indexes(&mut roster.id, &updated, name_hash);
}

/// Feint the identity — removes all three index copies + any
/// cf_history store. Decrements the global count. Caller must own the
/// by_address record.
public fun revoke_identity(
    roster: &mut Roster,
    name_hash: vector<u8>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let record: IdentityRecord = dynamic_field::remove<address, IdentityRecord>(&mut roster.id, sender);
    assert!(record.sui_address == sender, ENotOwner);

    if (dynamic_field::exists_<vector<u8>>(&roster.id, name_hash)) {
        dynamic_field::remove<vector<u8>, IdentityRecord>(&mut roster.id, name_hash);
    };

    let keys = record.chains.keys();
    let len = keys.length();
    let mut i = 0;
    while (i < len) {
        let chain_key = keys[i];
        let chain_value = *record.chains.get(&chain_key);
        let mut composite = chain_key;
        composite.append_utf8(b":");
        composite.append(chain_value);
        if (dynamic_field::exists_<String>(&roster.id, composite)) {
            dynamic_field::remove<String, IdentityRecord>(&mut roster.id, composite);
        };
        i = i + 1;
    };

    let cf_key = CfHistoryKey { addr: sender };
    if (dynamic_field::exists_<CfHistoryKey>(&roster.id, cf_key)) {
        dynamic_field::remove<CfHistoryKey, CfHistory>(&mut roster.id, cf_key);
    };

    roster.count = roster.count - 1;
}
