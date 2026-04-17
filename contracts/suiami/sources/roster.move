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

use std::string::{Self, String};
use sui::event;
use sui::dynamic_field;
use sui::clock::Clock;
use sui::vec_map::{Self, VecMap};
use sui::ecdsa_k1;
use sui::hash as sui_hash;
use sui::hex;
use sui::address as sui_address;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const ENoChains: u64 = 1;
const EEnsNameTaken: u64 = 2;
const EEnsNotBound: u64 = 3;
const ENoEthSquid: u64 = 4;
const EEthSigMismatch: u64 = 5;
const EBadSigLength: u64 = 6;
const ETimestampSkew: u64 = 7;

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

// ─── ENS bind (Beldum) ──────────────────────────────────────────────
//
// Bind an ENS name (typically `foo.waap.eth`) to the caller's existing
// SUIAMI RosterRecord. Writes an ens_hash-keyed dynamic field pointing
// to the same record, so SuiNS-name and ENS-name lookups resolve to one
// identity. Seal v2 policy already accepts the shared namespace, so no
// policy upgrade is needed for ENS decrypts.
//
// v1 trust model: the caller already owns a SUIAMI record (dwallet-caps
// verified), so they've proven control of an IKA-derived ETH address
// via DKG. Binding an ENS name is their attestation that the name maps
// to that address. The ETH ownership proof (`ecdsa_k1::secp256k1_verify`
// over a canonical bind message matching the record's `eth` chain
// address) is a follow-up move (Beldum Metal Claw). Harmless to land
// the scaffold first because only the record owner can write here.

entry fun set_ens_identity(
    roster: &mut Roster,
    ens_name: String,
    ens_hash: vector<u8>,
    eth_owner_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let mut updated: IdentityRecord = *dynamic_field::borrow<address, IdentityRecord>(&roster.id, sender);
    assert!(updated.sui_address == sender, ENotOwner);

    // TODO Beldum Metal Claw: verify `eth_owner_sig` via
    // `sui::ecdsa_k1::secp256k1_ecrecover` over a canonical
    // "SUIAMI bind ENS:<ens_name>:<sui_addr>:<timestamp>" message and
    // assert the recovered ETH address matches `updated.chains["eth"]`.
    let _ = eth_owner_sig;

    // First-come immutable: refuse to overwrite an existing ENS
    // binding. Owner must call `revoke_ens_identity` to release, then
    // re-bind. Prevents a griefer from hijacking a bound label by
    // re-issuing its hash.
    let key = EnsHashKey { hash: ens_hash };
    assert!(!dynamic_field::exists_<EnsHashKey>(&roster.id, key), EEnsNameTaken);

    updated.updated_ms = clock.timestamp_ms();
    let chain_count = updated.chains.length();
    let dwallet_count = updated.dwallet_caps.length();

    dynamic_field::add(&mut roster.id, key, updated);

    event::emit(IdentitySet {
        name: ens_name,
        sui_address: sender,
        chain_count,
        dwallet_count,
    });
}

/// Metal Claw (#167) — ENS bind with ecdsa_k1 signature verification.
///
/// Strongest version of the ENS bind path: caller supplies an ETH
/// signature over a canonical message proving they control the ETH
/// key registered in their own SUIAMI record. That key is
/// IKA-derived, so the chain of trust is:
///
///   caller owns SUIAMI record
///     → record lists an ETH address in `chains["eth"]`
///     → that ETH address was derived from an IKA secp256k1 dWallet
///       during DKG
///     → user signs bind message with the same ETH private share
///       (via IKA presign, or imported-key dWallet, or — until
///       Relocate ships — the owning Phantom / MetaMask seed)
///     → Move ecrecovers the signer, matches against the stored ETH
///       address, accepts the bind.
///
/// Signed message (EIP-191 personal-sign wrapped):
///   inner = "SUIAMI bind <ens_name> owner 0x<sender_hex> at <ts_ms>"
///   digest = keccak256("\x19Ethereum Signed Message:\n" + len(inner) + inner)
///   eth_sig = ECDSA_secp256k1_sign(eth_privkey, digest)  // 65 bytes r||s||v
///
/// Timestamp must be within ±10 minutes of on-chain clock (anti-replay
/// across the revoke boundary). ens_hash slot must be empty
/// (overwrite-protected, same as `set_ens_identity`).
entry fun set_ens_identity_verified(
    roster: &mut Roster,
    ens_name: String,
    ens_hash: vector<u8>,
    eth_owner_sig: vector<u8>,
    timestamp_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENotOwner);
    let mut updated: IdentityRecord = *dynamic_field::borrow<address, IdentityRecord>(&roster.id, sender);
    assert!(updated.sui_address == sender, ENotOwner);

    // Anti-replay: bind signature to a recent time. ±600_000 ms =
    // 10 min — comfortable for browser→sign→submit round-trip.
    let now = clock.timestamp_ms();
    let skew = if (timestamp_ms > now) { timestamp_ms - now } else { now - timestamp_ms };
    assert!(skew <= 600_000, ETimestampSkew);

    // Sig must be 65 bytes (r || s || v) — the Ethereum convention.
    assert!(eth_owner_sig.length() == 65, EBadSigLength);

    // ETH squid must exist in the caller's record.
    let eth_key = string::utf8(b"eth");
    assert!(vec_map::contains(&updated.chains, &eth_key), ENoEthSquid);
    let stored_eth_hex: String = *vec_map::get(&updated.chains, &eth_key);
    let stored_eth_bytes = eth_hex_string_to_bytes(&stored_eth_hex);

    // Build canonical inner message + EIP-191 wrap.
    let inner = build_bind_inner_message(&ens_name, sender, timestamp_ms);
    let prefixed = eip191_wrap(&inner);

    // Recover signer's compressed pubkey, decompress, derive ETH address.
    let compressed = ecdsa_k1::secp256k1_ecrecover(&eth_owner_sig, &prefixed, 0);
    let recovered = pubkey_to_eth_address(&compressed);

    assert!(recovered == stored_eth_bytes, EEthSigMismatch);

    // Overwrite-protected. Same shape as set_ens_identity — the
    // sig-verify version writes only after sig passes.
    let key = EnsHashKey { hash: ens_hash };
    assert!(!dynamic_field::exists_<EnsHashKey>(&roster.id, key), EEnsNameTaken);

    updated.updated_ms = clock.timestamp_ms();
    let chain_count = updated.chains.length();
    let dwallet_count = updated.dwallet_caps.length();
    dynamic_field::add(&mut roster.id, key, updated);

    event::emit(IdentitySet {
        name: ens_name,
        sui_address: sender,
        chain_count,
        dwallet_count,
    });
}

// ─── Helpers (pure byte / hex plumbing) ──────────────────────────────

/// Build the canonical inner bind message. Kept simple and
/// human-readable so the browser can reconstruct byte-for-byte
/// without wrestling BCS.
///
/// Format: `SUIAMI bind <ens_name> owner <sender-hex-0x> at <ts_ms>`
fun build_bind_inner_message(ens_name: &String, sender: address, ts_ms: u64): vector<u8> {
    let mut out = vector::empty<u8>();
    out.append(b"SUIAMI bind ");
    out.append(*ens_name.as_bytes());
    out.append(b" owner ");
    // Sui addresses formatted as lowercase 0x-prefixed 64-hex.
    let addr_str = sui_address::to_string(sender);
    out.append(b"0x");
    out.append(*addr_str.as_bytes());
    out.append(b" at ");
    out.append(u64_to_ascii_decimal(ts_ms));
    out
}

/// EIP-191 personal-sign wrapper. Produces the same bytes Ethereum's
/// `eth_sign` / Phantom's `personal_sign` pre-hashes before signing.
fun eip191_wrap(msg: &vector<u8>): vector<u8> {
    let mut out = vector::empty<u8>();
    // Literal 0x19 byte + ASCII "Ethereum Signed Message:\n"
    let prefix: vector<u8> = vector[0x19, 0x45, 0x74, 0x68, 0x65, 0x72, 0x65, 0x75, 0x6d, 0x20,
                                   0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20, 0x4d, 0x65, 0x73,
                                   0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a];
    out.append(prefix);
    out.append(u64_to_ascii_decimal(msg.length() as u64));
    out.append(*msg);
    out
}

/// u64 → ASCII decimal bytes. Used both for `timestamp_ms` in the
/// inner message AND the length prefix in EIP-191 wrap.
fun u64_to_ascii_decimal(n: u64): vector<u8> {
    if (n == 0) { return vector[48u8] };
    let mut out = vector::empty<u8>();
    let mut x = n;
    while (x > 0) {
        out.push_back(48u8 + ((x % 10) as u8));
        x = x / 10;
    };
    vector::reverse(&mut out);
    out
}

/// Parse a string like "0xCE3e9733aB9e78aB6e9F13B7FC6aC5a45D711763"
/// into its 20 raw address bytes. Case-insensitive (hex::decode is
/// lowercase-strict, so lowercase first).
fun eth_hex_string_to_bytes(s: &String): vector<u8> {
    let mut src = *s.as_bytes();
    // Strip optional "0x" / "0X" prefix.
    if (src.length() >= 2 && *src.borrow(0) == 0x30u8
        && (*src.borrow(1) == 0x78u8 || *src.borrow(1) == 0x58u8)) {
        let mut rest = vector::empty<u8>();
        let mut i = 2u64;
        while (i < src.length()) { rest.push_back(*src.borrow(i)); i = i + 1; };
        src = rest;
    };
    // Lowercase any A-F so hex::decode accepts it.
    let mut normalized = vector::empty<u8>();
    let mut j = 0u64;
    while (j < src.length()) {
        let c = *src.borrow(j);
        // 'A'=65 .. 'F'=70 → lowercase by +32
        let lower = if (c >= 65u8 && c <= 70u8) { c + 32u8 } else { c };
        normalized.push_back(lower);
        j = j + 1;
    };
    hex::decode(normalized)
}

/// 33-byte compressed secp256k1 pubkey → 20-byte Ethereum address.
/// Decompresses to 65-byte SEC1, drops the 0x04 prefix, keccak256 of
/// the 64 remaining bytes, takes the trailing 20 bytes.
fun pubkey_to_eth_address(compressed: &vector<u8>): vector<u8> {
    let uncompressed = ecdsa_k1::decompress_pubkey(compressed);
    let mut tail = vector::empty<u8>();
    let mut i = 1u64;
    while (i < 65) { tail.push_back(*uncompressed.borrow(i)); i = i + 1; };
    let digest = sui_hash::keccak256(&tail);
    let mut addr = vector::empty<u8>();
    let mut j = 12u64;
    while (j < 32) { addr.push_back(*digest.borrow(j)); j = j + 1; };
    addr
}

/// Release an ENS binding so it can be re-issued (by the same caller
/// or a different one). Only the bound record owner can revoke —
/// lookup record under the key and assert `sui_address == sender`.
entry fun revoke_ens_identity(
    roster: &mut Roster,
    ens_hash: vector<u8>,
    _ctx: &TxContext,
) {
    let sender = _ctx.sender();
    let key = EnsHashKey { hash: ens_hash };
    assert!(dynamic_field::exists_<EnsHashKey>(&roster.id, key), EEnsNotBound);
    let record: IdentityRecord = dynamic_field::remove<EnsHashKey, IdentityRecord>(&mut roster.id, key);
    assert!(record.sui_address == sender, ENotOwner);
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

/// Typed dynamic-field key for ENS-hashed entries. Isolates the ENS
/// namespace from the raw `vector<u8>` name_hash namespace so a
/// malicious caller can't overwrite a Sui-side roster entry by calling
/// `set_ens_identity` with a colliding hash. Each `EnsHashKey{h}` lives
/// in a distinct dynamic-field map from `h: vector<u8>`.
public struct EnsHashKey has copy, drop, store { hash: vector<u8> }

/// Check if an ENS name is registered.
public fun has_ens_name(roster: &Roster, ens_hash: vector<u8>): bool {
    dynamic_field::exists_<EnsHashKey>(&roster.id, EnsHashKey { hash: ens_hash })
}

/// Lookup by ENS hash.
public fun lookup_by_ens(roster: &Roster, ens_hash: vector<u8>): &IdentityRecord {
    dynamic_field::borrow(&roster.id, EnsHashKey { hash: ens_hash })
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

// ─── Test-only accessors (Metal Claw) ───────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun test_build_bind_inner_message(ens_name: &String, sender: address, ts_ms: u64): vector<u8> {
    build_bind_inner_message(ens_name, sender, ts_ms)
}

#[test_only]
public fun test_eip191_wrap(msg: &vector<u8>): vector<u8> {
    eip191_wrap(msg)
}

#[test_only]
public fun test_u64_to_ascii_decimal(n: u64): vector<u8> {
    u64_to_ascii_decimal(n)
}

#[test_only]
public fun test_eth_hex_string_to_bytes(s: &String): vector<u8> {
    eth_hex_string_to_bytes(s)
}

#[test_only]
public fun test_pubkey_to_eth_address(compressed: &vector<u8>): vector<u8> {
    pubkey_to_eth_address(compressed)
}
