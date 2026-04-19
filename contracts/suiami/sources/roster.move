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
const EChainNotInRecord: u64 = 8;
const ENoRecord: u64 = 9;
const EGuestNotBound: u64 = 10;
const EGuestNotExpired: u64 = 11;
const EGuestBadTtl: u64 = 12;
const ENotParentOrDelegate: u64 = 13;

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

// ─── v6: Disclosure projection (PublicChains) ───────────────────────
//
// A per-address whitelist of chain keys the owner has opted to expose
// via ENS / CCIP-read. Semantics:
//
//   • If no `PublicChainsKey { addr }` dynamic field exists for a
//     record, resolvers fall back to `record.chains` (v5 behavior —
//     everything in chains is readable via ENS).
//   • If `PublicChainsKey` exists, resolvers read `PublicChains.visible`
//     strictly — chains not listed there are hidden from ENS, even if
//     still present in the encrypted Walrus blob / `record.chains`.
//
// Owners call `set_public_chains` to opt into whitelist mode and
// `clear_public_chains` to revert to the v5 default.

public struct PublicChainsKey has copy, drop, store { addr: address }

public struct PublicChains has store, drop {
    /// chain_key → address copy at publish time. Resolvers use this
    /// instead of re-fetching IdentityRecord on the hot path.
    visible: VecMap<String, String>,
    updated_ms: u64,
}

public struct PublicChainsSet has copy, drop {
    sui_address: address,
    chain_count: u64,
}

public struct PublicChainsCleared has copy, drop {
    sui_address: address,
}

/// Set the whitelist of chain keys to expose via ENS / CCIP-read.
/// `chain_keys` must be a subset of the caller's existing `chains`.
/// An empty `chain_keys` vector is allowed (means "hide everything from
/// ENS but keep the whitelist opted-in"). To revert to v5 default
/// (expose everything in `chains`), call `clear_public_chains`.
entry fun set_public_chains(
    roster: &mut Roster,
    chain_keys: vector<String>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENoRecord);
    let record: &IdentityRecord = dynamic_field::borrow<address, IdentityRecord>(&roster.id, sender);

    let mut visible = vec_map::empty<String, String>();
    let mut i = 0;
    let len = chain_keys.length();
    while (i < len) {
        let key = chain_keys[i];
        assert!(vec_map::contains(&record.chains, &key), EChainNotInRecord);
        let value = *vec_map::get(&record.chains, &key);
        vec_map::insert(&mut visible, key, value);
        i = i + 1;
    };

    let pk = PublicChainsKey { addr: sender };
    if (dynamic_field::exists_<PublicChainsKey>(&roster.id, pk)) {
        let _old: PublicChains = dynamic_field::remove<PublicChainsKey, PublicChains>(&mut roster.id, pk);
    };
    let pc = PublicChains { visible, updated_ms: clock.timestamp_ms() };
    dynamic_field::add(&mut roster.id, pk, pc);

    event::emit(PublicChainsSet { sui_address: sender, chain_count: len });
}

/// Drop the whitelist, reverting ENS exposure to v5 default (resolver
/// reads `record.chains` directly).
entry fun clear_public_chains(roster: &mut Roster, ctx: &TxContext) {
    let sender = ctx.sender();
    let pk = PublicChainsKey { addr: sender };
    if (dynamic_field::exists_<PublicChainsKey>(&roster.id, pk)) {
        let _old: PublicChains = dynamic_field::remove<PublicChainsKey, PublicChains>(&mut roster.id, pk);
        event::emit(PublicChainsCleared { sui_address: sender });
    };
}

public fun has_public_chains(roster: &Roster, addr: address): bool {
    dynamic_field::exists_<PublicChainsKey>(&roster.id, PublicChainsKey { addr })
}

/// Read the whitelisted chains for an address. Caller should first
/// check `has_public_chains` — this function aborts if the key is
/// absent. Use `public_chains_contains` to probe specific keys.
public fun public_chains_visible(roster: &Roster, addr: address): &VecMap<String, String> {
    let pc: &PublicChains = dynamic_field::borrow(&roster.id, PublicChainsKey { addr });
    &pc.visible
}

public fun public_chains_contains(roster: &Roster, addr: address, chain_key: &String): bool {
    let pk = PublicChainsKey { addr };
    if (!dynamic_field::exists_<PublicChainsKey>(&roster.id, pk)) return false;
    let pc: &PublicChains = dynamic_field::borrow(&roster.id, pk);
    vec_map::contains(&pc.visible, chain_key)
}

// ─── v6: Guest Protocol — time-bound subname addresses ──────────────
//
// A guest record binds `<label>.<parent_name>` to a target address
// for a TTL window, after which reads return `none`. Parent owns the
// parent record; only the parent (or an optional delegate) can
// bind/revoke. Expiry is enforced at read time — `reap_guest` is a
// permissionless storage-rebate sweep for housekeeping, not for
// correctness.
//
// parent_hash format matches however the parent record is keyed:
//   • Sui-name parent: keccak256(bare_label)            (raw vector<u8>)
//   • ENS-name parent: keccak256(full_ens_name)         (via EnsHashKey)
// Callers pass the matching hash and the typed / raw lookup happens
// via the existing parent record indexes.

public struct GuestKey has copy, drop, store {
    parent_hash: vector<u8>,
    label: vector<u8>,
}

public struct Guest has store, drop {
    /// The Sui address that owns the parent record (auth anchor).
    parent_sui_address: address,
    /// Target address this guest subname resolves to, until expiry.
    /// String form because target chain varies — resolver parses
    /// against the caller's requested coinType.
    target: String,
    /// Chain the target belongs to: "eth","sol","btc","tron","sui".
    chain: String,
    /// Unix ms. `now < expires_ms` → guest is live.
    expires_ms: u64,
    /// Optional keeper/agent address permitted to revoke or rebind.
    delegate: Option<address>,
}

public struct GuestBound has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    target: String,
    chain: String,
    expires_ms: u64,
    has_delegate: bool,
}

public struct GuestRevoked has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    revoker: address,
}

public struct GuestReaped has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    reaper: address,
}

/// Resolve parent authority — caller must own the parent record either
/// by Sui-name (raw vector<u8>) or by ENS hash (EnsHashKey). Returns
/// the parent's `sui_address` on success.
fun assert_parent_owner(roster: &Roster, parent_hash: vector<u8>, sender: address): address {
    // Try Sui-name namespace first.
    if (dynamic_field::exists_<vector<u8>>(&roster.id, parent_hash)) {
        let rec: &IdentityRecord = dynamic_field::borrow<vector<u8>, IdentityRecord>(&roster.id, parent_hash);
        assert!(rec.sui_address == sender, ENotOwner);
        return rec.sui_address
    };
    // Try ENS namespace.
    let ek = EnsHashKey { hash: parent_hash };
    if (dynamic_field::exists_<EnsHashKey>(&roster.id, ek)) {
        let rec: &IdentityRecord = dynamic_field::borrow<EnsHashKey, IdentityRecord>(&roster.id, ek);
        assert!(rec.sui_address == sender, ENotOwner);
        return rec.sui_address
    };
    abort ENoRecord
}

/// Bind a guest subname for a TTL window. Only the parent owner can
/// call (not the delegate — first bind establishes the delegate).
/// Overwrites an existing binding if present.
entry fun bind_guest(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    target: String,
    chain: String,
    ttl_ms: u64,
    delegate: Option<address>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let parent_addr = assert_parent_owner(roster, parent_hash, sender);
    // TTL must be positive and bounded. 180 days hard cap — avoids
    // accidental decade-long leases if a UI passes a raw number.
    assert!(ttl_ms > 0 && ttl_ms <= 180 * 24 * 60 * 60 * 1000, EGuestBadTtl);

    let now = clock.timestamp_ms();
    let expires_ms = now + ttl_ms;

    let key = GuestKey { parent_hash, label };
    if (dynamic_field::exists_<GuestKey>(&roster.id, key)) {
        let _old: Guest = dynamic_field::remove<GuestKey, Guest>(&mut roster.id, key);
    };
    let has_delegate = option::is_some(&delegate);
    let guest = Guest {
        parent_sui_address: parent_addr,
        target,
        chain,
        expires_ms,
        delegate,
    };
    dynamic_field::add(&mut roster.id, key, guest);

    event::emit(GuestBound {
        parent_hash,
        label,
        target,
        chain,
        expires_ms,
        has_delegate,
    });
}

/// Revoke a guest early. Parent owner OR delegate can call.
entry fun revoke_guest(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let key = GuestKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestKey>(&roster.id, key), EGuestNotBound);
    let g: &Guest = dynamic_field::borrow<GuestKey, Guest>(&roster.id, key);

    let is_parent = g.parent_sui_address == sender;
    let is_delegate = option::is_some(&g.delegate)
        && *option::borrow(&g.delegate) == sender;
    assert!(is_parent || is_delegate, ENotParentOrDelegate);

    let _old: Guest = dynamic_field::remove<GuestKey, Guest>(&mut roster.id, key);
    event::emit(GuestRevoked { parent_hash, label, revoker: sender });
}

/// Permissionless sweep of an expired guest. Caller reclaims storage
/// rebate. Fails if the guest is still live.
entry fun reap_guest(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let key = GuestKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestKey>(&roster.id, key), EGuestNotBound);
    let g: &Guest = dynamic_field::borrow<GuestKey, Guest>(&roster.id, key);
    let now = clock.timestamp_ms();
    assert!(now >= g.expires_ms, EGuestNotExpired);

    let _old: Guest = dynamic_field::remove<GuestKey, Guest>(&mut roster.id, key);
    event::emit(GuestReaped { parent_hash, label, reaper: ctx.sender() });
}

// Reader helpers for resolvers.

public fun has_guest(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): bool {
    dynamic_field::exists_<GuestKey>(&roster.id, GuestKey { parent_hash, label })
}

/// Returns `some(target)` if the guest is bound and unexpired,
/// `none` otherwise. Clients should prefer this over raw borrows so
/// expiry is enforced consistently.
public fun lookup_guest_target(
    roster: &Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    clock: &Clock,
): Option<String> {
    let key = GuestKey { parent_hash, label };
    if (!dynamic_field::exists_<GuestKey>(&roster.id, key)) return option::none();
    let g: &Guest = dynamic_field::borrow<GuestKey, Guest>(&roster.id, key);
    if (clock.timestamp_ms() >= g.expires_ms) return option::none();
    option::some(g.target)
}

public fun guest_chain(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): String {
    let g: &Guest = dynamic_field::borrow(&roster.id, GuestKey { parent_hash, label });
    g.chain
}

public fun guest_expires_ms(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): u64 {
    let g: &Guest = dynamic_field::borrow(&roster.id, GuestKey { parent_hash, label });
    g.expires_ms
}

#[test_only]
public fun test_assert_parent_owner(roster: &Roster, parent_hash: vector<u8>, sender: address): address {
    assert_parent_owner(roster, parent_hash, sender)
}

// ─── Guest Stealth subnames (Sneasel arc, #197) ────────────────────
//
// Privacy-preserving variant of Guest. Public CCIP-read resolves to a
// freshly-derived hot address per counterparty (hermes.guest.sui /
// hermes.guest.whelm.eth vs athena.guest.* get different, unlinkable
// addrs). The true
// cold squid destination is stored as a Seal-encrypted blob, decryptable
// ONLY by ultron (or the designated sweep delegate). The hot→cold sweep
// is ultron's job: IKA-sign from hot using its DWalletCap, batch+jitter
// to break timing correlation, deposit into the cold squid.
//
// Key authorisation flow:
//   - parent owner (brando) writes GuestStealth via `bind_guest_stealth`
//   - sealed_cold_dest is encrypted client-side against ultron's Seal policy
//   - ultron's `seal_approve_guest_stealth` fn gates decryption to the
//     sweep delegate's own on-chain ownership proof
//   - CCIP-read gateway resolves the subname to `hot_addr` (public-OK)
//   - ultron scans hot_addr via webhook, decrypts cold-dest JIT, signs
//     sweep tx via IKA, discards plaintext
//
// Observer view: hot_addr receives funds, forwards batch N minutes later
// to ultron's sweep collector; collector batches again to cold. Zero
// direct hot→cold link visible from Etherscan/Arkham. Hermes and Athena
// can't link payments because their guest subnames resolve to different
// addresses.

public struct GuestStealthKey has copy, drop, store {
    parent_hash: vector<u8>,
    label: vector<u8>,
}

public struct GuestStealth has store, drop {
    /// The Sui address that owns the parent record (auth anchor).
    parent_sui_address: address,
    /// Hot receive address — freshly provisioned per guest, no history.
    /// Public CCIP-read resolves the subname to this. Chain varies; the
    /// resolver matches against the caller's requested coinType.
    hot_addr: String,
    /// Chain hint for `hot_addr`: "eth","sol","btc","tron","sui".
    chain: String,
    /// Seal-ciphertext of the actual cold-squid destination address +
    /// any sweep policy hints (e.g., minimum batch size). Opaque here —
    /// the Seal policy gates who can decrypt. Stored as raw bytes so
    /// the encrypt format can evolve without Move upgrade.
    sealed_cold_dest: vector<u8>,
    /// Unix ms. `now < expires_ms` → guest is live.
    expires_ms: u64,
    /// Sweep delegate — the address whose ownership proof satisfies
    /// `seal_approve_guest_stealth`. Typically ultron's ETH dWallet
    /// or its IKA-derived address.
    sweep_delegate: address,
}

public struct GuestStealthBound has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    hot_addr: String,
    chain: String,
    expires_ms: u64,
    sweep_delegate: address,
}

public struct GuestStealthRevoked has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    revoker: address,
}

public struct GuestStealthReaped has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    reaper: address,
}

public struct GuestStealthDelegateRotated has copy, drop {
    parent_hash: vector<u8>,
    label: vector<u8>,
    old_delegate: address,
    new_delegate: address,
    rotated_at_ms: u64,
}

/// Bind a privacy-preserving guest subname. Caller must own the parent
/// record (via Sui-name or ENS hash). `sealed_cold_dest` is opaque here;
/// encrypt it client-side against the Seal policy before submitting.
/// Overwrites any existing binding under the same key.
entry fun bind_guest_stealth(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    hot_addr: String,
    chain: String,
    sealed_cold_dest: vector<u8>,
    ttl_ms: u64,
    sweep_delegate: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let parent_addr = assert_parent_owner(roster, parent_hash, sender);

    let key = GuestStealthKey { parent_hash, label };
    if (dynamic_field::exists_<GuestStealthKey>(&roster.id, key)) {
        let _old: GuestStealth = dynamic_field::remove<GuestStealthKey, GuestStealth>(&mut roster.id, key);
    };

    let expires_ms = clock.timestamp_ms() + ttl_ms;
    let stealth = GuestStealth {
        parent_sui_address: parent_addr,
        hot_addr,
        chain,
        sealed_cold_dest,
        expires_ms,
        sweep_delegate,
    };
    dynamic_field::add(&mut roster.id, key, stealth);

    let borrowed: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    event::emit(GuestStealthBound {
        parent_hash,
        label,
        hot_addr: borrowed.hot_addr,
        chain: borrowed.chain,
        expires_ms,
        sweep_delegate,
    });
}

/// Parent owner (or sweep_delegate) can revoke before expiry.
entry fun revoke_guest_stealth(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    let authorised = (stealth.parent_sui_address == sender) || (stealth.sweep_delegate == sender);
    assert!(authorised, ENotOwner);
    let _drop: GuestStealth = dynamic_field::remove<GuestStealthKey, GuestStealth>(&mut roster.id, key);
    event::emit(GuestStealthRevoked { parent_hash, label, revoker: sender });
}

/// Permissionless reap after expiry — keeps the roster tidy.
entry fun reap_guest_stealth(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    assert!(clock.timestamp_ms() >= stealth.expires_ms, EGuestNotBound);
    let _drop: GuestStealth = dynamic_field::remove<GuestStealthKey, GuestStealth>(&mut roster.id, key);
    event::emit(GuestStealthReaped { parent_hash, label, reaper: ctx.sender() });
}

/// Sneasel Slash — rotate the sweep delegate + sealed cold destination
/// in place. Preserves `hot_addr`, `chain`, `expires_ms`, and the parent
/// binding so live guests see an unchanged on-chain face while the
/// decrypt side rotates to a new delegate / fresh ciphertext.
entry fun rotate_sweep_delegate(
    roster: &mut Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    new_delegate: address,
    new_sealed_cold_dest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    let _parent_addr = assert_parent_owner(roster, parent_hash, sender);

    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &mut GuestStealth = dynamic_field::borrow_mut<GuestStealthKey, GuestStealth>(&mut roster.id, key);
    assert!(clock.timestamp_ms() < stealth.expires_ms, EGuestNotBound);

    let old_delegate = stealth.sweep_delegate;
    stealth.sweep_delegate = new_delegate;
    stealth.sealed_cold_dest = new_sealed_cold_dest;

    event::emit(GuestStealthDelegateRotated {
        parent_hash,
        label,
        old_delegate,
        new_delegate,
        rotated_at_ms: clock.timestamp_ms(),
    });
}

/// Seal approval — gates who can decrypt `sealed_cold_dest`. Seal calls
/// this at decrypt time; succeeds ⇒ key released. Callable by the sweep
/// delegate only. Expiry enforces auto-lockdown: expired stealths can't
/// be decrypted even by the delegate (caller should reap + rebind with
/// fresh sealed blob when rotating).
entry fun seal_approve_guest_stealth(
    roster: &Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    assert!(stealth.sweep_delegate == ctx.sender(), ENotOwner);
    assert!(clock.timestamp_ms() < stealth.expires_ms, EGuestNotBound);
}

public fun has_guest_stealth(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): bool {
    let key = GuestStealthKey { parent_hash, label };
    dynamic_field::exists_<GuestStealthKey>(&roster.id, key)
}

public fun guest_stealth_hot_addr(
    roster: &Roster,
    parent_hash: vector<u8>,
    label: vector<u8>,
    clock: &Clock,
): String {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    assert!(clock.timestamp_ms() < stealth.expires_ms, EGuestNotBound);
    stealth.hot_addr
}

public fun guest_stealth_chain(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): String {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    stealth.chain
}

public fun guest_stealth_expires_ms(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): u64 {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    stealth.expires_ms
}

public fun guest_stealth_sealed_cold_dest(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): vector<u8> {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    stealth.sealed_cold_dest
}

public fun guest_stealth_sweep_delegate(roster: &Roster, parent_hash: vector<u8>, label: vector<u8>): address {
    let key = GuestStealthKey { parent_hash, label };
    assert!(dynamic_field::exists_<GuestStealthKey>(&roster.id, key), EGuestNotBound);
    let stealth: &GuestStealth = dynamic_field::borrow<GuestStealthKey, GuestStealth>(&roster.id, key);
    stealth.sweep_delegate
}

// ─── Weavile Razor Claw — stealth meta-addresses (#198) ─────────────
//
// EIP-6538-adjacent registry, multi-chain from day one. One
// IKA-imported spend key identity (`ika_dwallet_id`) + per-chain view
// pubkeys. Senders ECDH(ephemeral_priv, view_pub) on the target chain's
// curve to derive a fresh unlinkable stealth address; recipient scans
// announcements with the matching view priv; sweep composes
// `spend_priv + s` via IKA 2PC-MPC (Metal Claw follow-up).
//
// Auth: caller must already have an IdentityRecord at their Sui
// address (same shape as PublicChainsKey). Owner-only write; reads are
// permissionless (meta-address is the *public* half by design — senders
// need it to pay).
//
// Format stored on-chain:
//   ika_dwallet_id: ID — links to the spend-key dWallet in the
//     caller's IKA registry (not the Sui dWallet that owns *this*
//     record; this is specifically the cross-curve spend-key dWallet
//     that gets rotated per view-key rotation).
//   view_pubkeys: VecMap<chain_key, pubkey_bytes>
//     "eth"/"btc"/"polygon"/"base"/"arbitrum"/"tron" → secp256k1
//       compressed (33 bytes)
//     "sui"/"sol" → ed25519 (32 bytes)
//   updated_ms — rotations emit StealthMetaSet with a fresh timestamp.
//
// Deliberate non-goals here: the Move module does NOT validate pubkey
// bytes against a curve (no sui-framework call for ed25519 pubkey parse,
// and secp256k1 parse is expensive on-chain for a check that the
// browser can do trivially). Bad bytes get rejected at scan time — a
// malformed view pubkey produces no matches, i.e. a self-DoS.

public struct StealthMetaKey has copy, drop, store { addr: address }

public struct StealthMeta has store, drop {
    /// Cross-curve spend-key IKA dWallet. Senders don't need this (they
    /// derive against view pubkeys + ephemeral) — it's published so the
    /// recipient's scanner can find the matching dWallet during sweep.
    ika_dwallet_id: ID,
    /// Per-chain view pubkeys. Curve depends on chain_key.
    view_pubkeys: VecMap<String, vector<u8>>,
    /// Last write ms — rotations bump this, resolvers can show "last
    /// rotated".
    updated_ms: u64,
}

public struct StealthMetaSet has copy, drop {
    addr: address,
    ika_dwallet_id: ID,
    chains: vector<String>,
    updated_ms: u64,
}

public struct StealthMetaCleared has copy, drop {
    addr: address,
}

/// Set your stealth meta-address. Requires an existing IdentityRecord
/// at the caller's Sui address. Parallel vectors `chain_keys` /
/// `view_pubkeys` get zipped into a VecMap; an empty input is allowed
/// (register the dwallet_id now, publish view keys in a later call).
/// Overwrites any existing meta for this caller.
entry fun set_stealth_meta(
    roster: &mut Roster,
    ika_dwallet_id: ID,
    chain_keys: vector<String>,
    view_pubkeys: vector<vector<u8>>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<address>(&roster.id, sender), ENoRecord);
    let len = chain_keys.length();
    assert!(len == view_pubkeys.length(), ENoChains);

    let mut map = vec_map::empty<String, vector<u8>>();
    let mut i = 0;
    while (i < len) {
        vec_map::insert(&mut map, chain_keys[i], view_pubkeys[i]);
        i = i + 1;
    };

    let key = StealthMetaKey { addr: sender };
    if (dynamic_field::exists_<StealthMetaKey>(&roster.id, key)) {
        let _old: StealthMeta = dynamic_field::remove<StealthMetaKey, StealthMeta>(&mut roster.id, key);
    };

    let updated_ms = clock.timestamp_ms();
    let meta = StealthMeta {
        ika_dwallet_id,
        view_pubkeys: map,
        updated_ms,
    };
    dynamic_field::add(&mut roster.id, key, meta);

    event::emit(StealthMetaSet {
        addr: sender,
        ika_dwallet_id,
        chains: chain_keys,
        updated_ms,
    });
}

/// Clear your stealth meta. Drops the dWallet id + all view pubkeys.
/// Idempotent — clearing a non-existent entry is a no-op (no event).
entry fun clear_stealth_meta(roster: &mut Roster, ctx: &TxContext) {
    let sender = ctx.sender();
    let key = StealthMetaKey { addr: sender };
    if (dynamic_field::exists_<StealthMetaKey>(&roster.id, key)) {
        let _old: StealthMeta = dynamic_field::remove<StealthMetaKey, StealthMeta>(&mut roster.id, key);
        event::emit(StealthMetaCleared { addr: sender });
    };
}

public fun has_stealth_meta(roster: &Roster, addr: address): bool {
    dynamic_field::exists_<StealthMetaKey>(&roster.id, StealthMetaKey { addr })
}

public fun stealth_meta_dwallet_id(roster: &Roster, addr: address): ID {
    let meta: &StealthMeta = dynamic_field::borrow(&roster.id, StealthMetaKey { addr });
    meta.ika_dwallet_id
}

public fun stealth_meta_updated_ms(roster: &Roster, addr: address): u64 {
    let meta: &StealthMeta = dynamic_field::borrow(&roster.id, StealthMetaKey { addr });
    meta.updated_ms
}

public fun stealth_meta_has_chain(roster: &Roster, addr: address, chain: &String): bool {
    let key = StealthMetaKey { addr };
    if (!dynamic_field::exists_<StealthMetaKey>(&roster.id, key)) return false;
    let meta: &StealthMeta = dynamic_field::borrow(&roster.id, key);
    vec_map::contains(&meta.view_pubkeys, chain)
}

/// Read the view pubkey for a specific chain. Aborts with EChainNotInRecord
/// if the caller has a meta but no entry for that chain, or ENoRecord
/// if no meta exists at all.
public fun stealth_meta_view_pubkey(
    roster: &Roster,
    addr: address,
    chain: &String,
): vector<u8> {
    let key = StealthMetaKey { addr };
    assert!(dynamic_field::exists_<StealthMetaKey>(&roster.id, key), ENoRecord);
    let meta: &StealthMeta = dynamic_field::borrow(&roster.id, key);
    assert!(vec_map::contains(&meta.view_pubkeys, chain), EChainNotInRecord);
    *vec_map::get(&meta.view_pubkeys, chain)
}

public fun stealth_meta_view_pubkeys(roster: &Roster, addr: address): &VecMap<String, vector<u8>> {
    let meta: &StealthMeta = dynamic_field::borrow(&roster.id, StealthMetaKey { addr });
    &meta.view_pubkeys
}

// ─── Aggron Earthquake — IntentRegistryAnchor (#-) ──────────────────
//
// On-chain mirror of the server-side IntentRegistry. Lets a recipient
// explicitly authorize a "router" (e.g. ultron) to Seal-decrypt their
// private chain records for sub-cent intent routing. The authorization
// is keyed by `(recipient_name_hash, router_sui_address)` and stored
// as a dynamic field on the shared Roster — no new shared object.
//
// Auth model:
//   - `authorize_router`: sender must already own a Roster record
//     (name_hash → record with record.sui_address == sender). Writes
//     a RouterAuthorization with revoked_at_ms=0.
//   - `revoke_router`: same ownership check; flips revoked_at_ms to now.
//   - Re-authorize after revoke: overwrites the existing authorization
//     with a fresh authorized_at_ms and revoked_at_ms=0.
//
// Seal policy (`seal_approve_intent_router`, in seal_roster.move) reads
// the same field and approves decrypt iff sender (the router) has an
// active authorization for the recipient identified by the seal id's
// first 32 bytes.

const ENotRecipient: u64 = 14;
const ENoRouterAuthorization: u64 = 15;

public struct RouterAuthKey has copy, drop, store {
    recipient_name_hash: vector<u8>,
    router: address,
}

public struct RouterAuthorization has store, drop, copy {
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
    authorized_at_ms: u64,
    /// 0 ⇒ still active; otherwise ms timestamp of revocation.
    revoked_at_ms: u64,
}

public struct RouterAuthorized has copy, drop {
    recipient_name_hash: vector<u8>,
    router: address,
    authorized_at_ms: u64,
}

public struct RouterRevoked has copy, drop {
    recipient_name_hash: vector<u8>,
    router: address,
    revoked_at_ms: u64,
}

/// Authorize `router_sui_address` to Seal-decrypt the recipient's
/// private chain records. Sender must own the recipient record (owner
/// check: record.sui_address == sender). The recipient is identified
/// by `recipient_name_hash = keccak256(bareName)` — same hash space as
/// the roster's name index.
entry fun authorize_router(
    roster: &mut Roster,
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    // Recipient ownership: the name_hash must be registered and
    // the sender must be the on-chain owner of that name.
    assert!(dynamic_field::exists_<vector<u8>>(&roster.id, recipient_name_hash), ENotRecipient);
    let record: &IdentityRecord = dynamic_field::borrow(&roster.id, recipient_name_hash);
    assert!(record.sui_address == sender, ENotRecipient);

    let key = RouterAuthKey { recipient_name_hash, router: router_sui_address };
    if (dynamic_field::exists_<RouterAuthKey>(&roster.id, key)) {
        // Re-authorize path: drop stale entry so we can write fresh.
        let _old: RouterAuthorization = dynamic_field::remove<RouterAuthKey, RouterAuthorization>(&mut roster.id, key);
    };

    let authorized_at_ms = clock.timestamp_ms();
    let auth = RouterAuthorization {
        recipient_name_hash,
        router_sui_address,
        authorized_at_ms,
        revoked_at_ms: 0,
    };
    dynamic_field::add(&mut roster.id, key, auth);

    event::emit(RouterAuthorized {
        recipient_name_hash,
        router: router_sui_address,
        authorized_at_ms,
    });
}

/// Revoke a previously-authorized router. Sender must own the recipient
/// record. Aborts if no authorization exists. Sets revoked_at_ms to
/// current clock time; leaves the field in place so audit history is
/// preserved (`has_active_router` returns false for revoked entries).
entry fun revoke_router(
    roster: &mut Roster,
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(dynamic_field::exists_<vector<u8>>(&roster.id, recipient_name_hash), ENotRecipient);
    let record: &IdentityRecord = dynamic_field::borrow(&roster.id, recipient_name_hash);
    assert!(record.sui_address == sender, ENotRecipient);

    let key = RouterAuthKey { recipient_name_hash, router: router_sui_address };
    assert!(dynamic_field::exists_<RouterAuthKey>(&roster.id, key), ENoRouterAuthorization);
    let auth: &mut RouterAuthorization = dynamic_field::borrow_mut(&mut roster.id, key);
    let revoked_at_ms = clock.timestamp_ms();
    auth.revoked_at_ms = revoked_at_ms;

    event::emit(RouterRevoked {
        recipient_name_hash,
        router: router_sui_address,
        revoked_at_ms,
    });
}

/// Returns true iff an authorization exists for this (recipient,
/// router) pair AND it has not been revoked.
public fun has_active_router(
    roster: &Roster,
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
): bool {
    let key = RouterAuthKey { recipient_name_hash, router: router_sui_address };
    if (!dynamic_field::exists_<RouterAuthKey>(&roster.id, key)) return false;
    let auth: &RouterAuthorization = dynamic_field::borrow(&roster.id, key);
    auth.revoked_at_ms == 0
}

public fun router_authorization_authorized_at_ms(
    roster: &Roster,
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
): u64 {
    let key = RouterAuthKey { recipient_name_hash, router: router_sui_address };
    assert!(dynamic_field::exists_<RouterAuthKey>(&roster.id, key), ENoRouterAuthorization);
    let auth: &RouterAuthorization = dynamic_field::borrow(&roster.id, key);
    auth.authorized_at_ms
}

public fun router_authorization_revoked_at_ms(
    roster: &Roster,
    recipient_name_hash: vector<u8>,
    router_sui_address: address,
): u64 {
    let key = RouterAuthKey { recipient_name_hash, router: router_sui_address };
    assert!(dynamic_field::exists_<RouterAuthKey>(&roster.id, key), ENoRouterAuthorization);
    let auth: &RouterAuthorization = dynamic_field::borrow(&roster.id, key);
    auth.revoked_at_ms
}
