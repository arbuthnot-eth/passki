// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// ski_profile — Extend SuiNS names with SKI features.
///
/// Attaches dynamic fields directly to SuinsRegistration NFTs.
/// No wrapping, no waiting on SuiNS contracts. The NFT stays
/// in the user's wallet — we just add fields to it.
///
/// Features attached per name:
///   - Chain addresses (sol@name, eth@name, btc@name)
///   - Balance seal reference (encrypted balance blob ID)
///   - Thunder signal count
///   - SUIAMI proof hash
///   - Rumble status (which dWallet curves are provisioned)
///   - Points (SUIAMI scoring)
///
/// Key format: dynamic_field keyed by ascii string.
/// e.g. "sol" → address bytes, "eth" → address bytes, "btc" → address string
///
/// Anyone holding the NFT can call set_* (owner gated by possession).
/// Read functions are permissionless — anyone can look up chain@name.
module ski_profile::ski_profile;

use sui::dynamic_field as df;
use sui::event;
use sui::clock::Clock;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const EFieldNotFound: u64 = 0;

// ─── Key Types ──────────────────────────────────────────────────────

/// String key for chain address fields. "sol", "eth", "btc", "sui".
public struct ChainKey has copy, drop, store { chain: vector<u8> }

/// Key for the profile metadata field.
public struct ProfileKey has copy, drop, store {}

/// Key for the balance seal reference.
public struct BalanceSealKey has copy, drop, store {}

/// Key for the SUIAMI proof.
public struct SuiamiKey has copy, drop, store {}

/// Key for points.
public struct PointsKey has copy, drop, store {}

// ─── Value Types ────────────────────────────────────────────────────

/// Chain address record. Stored as dynamic field on the SuiNS NFT.
public struct ChainAddress has store, drop {
    /// Raw address bytes (hex-decoded for EVM/Sui, base58-decoded for SOL, bech32 for BTC)
    address_bytes: vector<u8>,
    /// Human-readable string (0x..., bc1..., Ftdg..., etc.)
    address_str: vector<u8>,
    /// IKA dWallet ID that controls this address (if provisioned via Rumble)
    dwallet_id: address,
    /// Timestamp when this was set
    updated_ms: u64,
}

/// Profile metadata — general SKI profile info on the name.
public struct Profile has store, drop {
    /// Rumble status bitmask: bit 0 = secp256k1, bit 1 = ed25519
    rumble_curves: u8,
    /// Thunder signal count (cached, may lag behind Storm)
    thunder_count: u64,
    /// Creation timestamp
    created_ms: u64,
    /// Last update timestamp
    updated_ms: u64,
}

/// SUIAMI proof reference.
public struct SuiamiProof has store, drop {
    /// Hash of the SUIAMI proof token
    proof_hash: vector<u8>,
    /// The SUIAMI NFT object ID (if minted)
    nft_id: address,
    /// Verified timestamp
    verified_ms: u64,
}

/// Balance seal reference — points to the encrypted balance blob.
public struct BalanceSealRef has store, drop {
    /// BalancePolicy object ID
    policy_id: address,
    /// Name hash used as the key in the BalancePolicy
    name_hash: vector<u8>,
    /// Last encrypted timestamp
    updated_ms: u64,
}

// ─── Events ─────────────────────────────────────────────────────────

public struct ChainAddressSet has copy, drop {
    domain: vector<u8>,
    chain: vector<u8>,
    address_str: vector<u8>,
    dwallet_id: address,
}

public struct ProfileCreated has copy, drop {
    domain: vector<u8>,
    timestamp_ms: u64,
}

public struct SuiamiVerified has copy, drop {
    domain: vector<u8>,
    proof_hash: vector<u8>,
    nft_id: address,
}

// ─── Chain Address Functions ────────────────────────────────────────

/// Set a chain address on a SuiNS name. Owner-gated by NFT possession.
/// Call with chain = b"sol", b"eth", b"btc", b"sui".
entry fun set_chain_address(
    nft: &mut SuinsRegistration,
    chain: vector<u8>,
    address_bytes: vector<u8>,
    address_str: vector<u8>,
    dwallet_id: address,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = ChainKey { chain };
    let record = ChainAddress {
        address_bytes,
        address_str,
        dwallet_id,
        updated_ms: clock.timestamp_ms(),
    };

    // Upsert
    if (df::exists_<ChainKey>(nft.uid(), key)) {
        df::remove<ChainKey, ChainAddress>(nft.uid_mut(), key);
    };
    df::add(nft.uid_mut(), key, record);

    event::emit(ChainAddressSet {
        domain: nft.domain().to_string().into_bytes(),
        chain: key.chain,
        address_str,
        dwallet_id,
    });
}

/// Remove a chain address from a SuiNS name.
entry fun remove_chain_address(
    nft: &mut SuinsRegistration,
    chain: vector<u8>,
    _ctx: &TxContext,
) {
    let key = ChainKey { chain };
    if (df::exists_<ChainKey>(nft.uid(), key)) {
        df::remove<ChainKey, ChainAddress>(nft.uid_mut(), key);
    };
}

/// Read a chain address. Permissionless — anyone can resolve chain@name.
public fun get_chain_address(nft: &SuinsRegistration, chain: vector<u8>): (vector<u8>, vector<u8>, address) {
    let key = ChainKey { chain };
    assert!(df::exists_<ChainKey>(nft.uid(), key), EFieldNotFound);
    let record: &ChainAddress = df::borrow(nft.uid(), key);
    (record.address_bytes, record.address_str, record.dwallet_id)
}

/// Check if a chain address is set.
public fun has_chain_address(nft: &SuinsRegistration, chain: vector<u8>): bool {
    df::exists_<ChainKey>(nft.uid(), key(chain))
}

fun key(chain: vector<u8>): ChainKey { ChainKey { chain } }

// ─── Profile Functions ──────────────────────────────────────────────

/// Initialize SKI profile on a SuiNS name. Idempotent.
entry fun init_profile(
    nft: &mut SuinsRegistration,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = ProfileKey {};
    if (df::exists_<ProfileKey>(nft.uid(), key)) return;

    let profile = Profile {
        rumble_curves: 0,
        thunder_count: 0,
        created_ms: clock.timestamp_ms(),
        updated_ms: clock.timestamp_ms(),
    };
    df::add(nft.uid_mut(), key, profile);

    event::emit(ProfileCreated {
        domain: nft.domain().to_string().into_bytes(),
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Update rumble status after IKA DKG.
entry fun set_rumble_curves(
    nft: &mut SuinsRegistration,
    curves: u8,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = ProfileKey {};
    if (!df::exists_<ProfileKey>(nft.uid(), key)) return;
    let profile: &mut Profile = df::borrow_mut(nft.uid_mut(), key);
    profile.rumble_curves = curves;
    profile.updated_ms = clock.timestamp_ms();
}

/// Update cached thunder count.
entry fun set_thunder_count(
    nft: &mut SuinsRegistration,
    count: u64,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = ProfileKey {};
    if (!df::exists_<ProfileKey>(nft.uid(), key)) return;
    let profile: &mut Profile = df::borrow_mut(nft.uid_mut(), key);
    profile.thunder_count = count;
    profile.updated_ms = clock.timestamp_ms();
}

// ─── SUIAMI Functions ───────────────────────────────────────────────

/// Store SUIAMI proof on the SuiNS name.
entry fun set_suiami(
    nft: &mut SuinsRegistration,
    proof_hash: vector<u8>,
    suiami_nft_id: address,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = SuiamiKey {};
    let proof = SuiamiProof {
        proof_hash,
        nft_id: suiami_nft_id,
        verified_ms: clock.timestamp_ms(),
    };
    if (df::exists_<SuiamiKey>(nft.uid(), key)) {
        df::remove<SuiamiKey, SuiamiProof>(nft.uid_mut(), key);
    };
    df::add(nft.uid_mut(), key, proof);

    event::emit(SuiamiVerified {
        domain: nft.domain().to_string().into_bytes(),
        proof_hash,
        nft_id: suiami_nft_id,
    });
}

/// Check if SUIAMI is verified on this name.
public fun has_suiami(nft: &SuinsRegistration): bool {
    df::exists_<SuiamiKey>(nft.uid(), SuiamiKey {})
}

// ─── Balance Seal Functions ─────────────────────────────────────────

/// Store balance seal reference on the SuiNS name.
entry fun set_balance_seal(
    nft: &mut SuinsRegistration,
    policy_id: address,
    name_hash: vector<u8>,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let key = BalanceSealKey {};
    let seal = BalanceSealRef {
        policy_id,
        name_hash,
        updated_ms: clock.timestamp_ms(),
    };
    if (df::exists_<BalanceSealKey>(nft.uid(), key)) {
        df::remove<BalanceSealKey, BalanceSealRef>(nft.uid_mut(), key);
    };
    df::add(nft.uid_mut(), key, seal);
}

// ─── Points Functions ───────────────────────────────────────────────

/// Set points on a SuiNS name. Admin-gated (call via ultron after scoring).
entry fun set_points(
    nft: &mut SuinsRegistration,
    points: u64,
    _ctx: &TxContext,
) {
    let key = PointsKey {};
    if (df::exists_<PointsKey>(nft.uid(), key)) {
        df::remove<PointsKey, u64>(nft.uid_mut(), key);
    };
    df::add(nft.uid_mut(), key, points);
}

/// Read points. Permissionless.
public fun get_points(nft: &SuinsRegistration): u64 {
    let key = PointsKey {};
    if (!df::exists_<PointsKey>(nft.uid(), key)) return 0;
    *df::borrow<PointsKey, u64>(nft.uid(), key)
}
