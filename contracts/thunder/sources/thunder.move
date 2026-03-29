// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder v3 — encrypt signals between SuiNS identities.
///
/// Storm is the shared object. Anyone can send a signal (with fee).
/// Only the SuiNS name owner can quest (NFT-gated).
/// Ragtag holds signals per name. Questing emits decrypted keys.
/// Empty ragtags survive for 7 days (reused by new signals).
/// After 7 days idle, anyone can sweep for the storage rebate.
///
/// Protocol fee: collected in SUI per signal, routed to treasury.
/// Denominated at $0.009 iUSD equivalent — the SUI amount floats
/// with price. Treasury converts to iUSD backing.
module thunder::thunder;

use sui::dynamic_field;
use sui::hash::keccak256;
use sui::event;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::sui::SUI;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmpty: u64 = 1;
const ENotExpired: u64 = 2;
const EInsufficientFee: u64 = 3;
const ENotAdmin: u64 = 4;

// ─── Constants ─────────────────────────────────────────────────────

/// 7 days in milliseconds
const RAGTAG_TTL_MS: u64 = 604_800_000;

/// Default signal fee in MIST (0.003 SUI ≈ $0.009 at $3/SUI)
/// Adjustable by admin via set_signal_fee()
const DEFAULT_SIGNAL_FEE_MIST: u64 = 3_000_000;

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

/// Emitted when fee is collected.
public struct FeePaid has copy, drop {
    amount: u64,
    treasury: address,
}

// ─── Types ──────────────────────────────────────────────────────────

/// The shared object — always-on infrastructure.
public struct Storm has key {
    id: UID,
    /// Fee amount per signal in MIST
    signal_fee_mist: u64,
    /// iUSD treasury address — fees go here directly on every signal
    fee_treasury: address,
    /// Admin who can update fee and treasury address
    admin: address,
}

/// A single encrypt signal.
public struct Signal has store, copy, drop {
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

/// Per-name ragtag. Dynamic field on Storm, keyed by name_hash.
/// Survives empty for up to RAGTAG_TTL_MS after last activity.
public struct Ragtag has store {
    signals: vector<Signal>,
    last_activity_ms: u64,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Storm {
        id: object::new(ctx),
        signal_fee_mist: DEFAULT_SIGNAL_FEE_MIST,
        fee_treasury: ctx.sender(),
        admin: ctx.sender(),
    });
}

// ─── Send (with fee) ───────────────────────────────────────────────

/// Send a signal to someone's ragtag. Permissionless — anyone can send.
/// Requires a fee payment in SUI. The fee accumulates in Storm and is
/// periodically withdrawn to the iUSD treasury by the TreasuryAgents.
entry fun signal(
    storm: &mut Storm,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    fee: Coin<SUI>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // Send fee directly to iUSD treasury
    assert!(fee.value() >= storm.signal_fee_mist, EInsufficientFee);
    let fee_amount = fee.value();
    transfer::public_transfer(fee, storm.fee_treasury);

    event::emit(FeePaid { amount: fee_amount, treasury: storm.fee_treasury });

    let timestamp_ms = clock.timestamp_ms();
    let sig = Signal { payload, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&storm.id, name_hash)) {
        let ragtag: &mut Ragtag = dynamic_field::borrow_mut(&mut storm.id, name_hash);
        ragtag.signals.push_back(sig);
        ragtag.last_activity_ms = timestamp_ms;
    } else {
        dynamic_field::add(&mut storm.id, name_hash, Ragtag {
            signals: vector[sig],
            last_activity_ms: timestamp_ms,
        });
    };

    event::emit(Signaled { name_hash, timestamp_ms });
}

// ─── Claim (NFT-gated) ─────────────────────────────────────────────

/// Quest — claim the first signal from your ragtag. Requires SuinsRegistration NFT.
/// Un-XORs the AES key and emits Questfi with payload + key + nonce.
/// Empty ragtags are kept alive (reused by future signals).
/// Batch multiple quests in one PTB.
entry fun quest(
    storm: &mut Storm,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let ragtag: &mut Ragtag = dynamic_field::borrow_mut(&mut storm.id, name_hash);
    assert!(!ragtag.signals.is_empty(), EEmpty);

    let sig = ragtag.signals.remove(0);
    ragtag.last_activity_ms = clock.timestamp_ms();

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

// ─── Sweep (permissionless cleanup) ────────────────────────────────

/// Sweep — delete an empty ragtag that has been idle for > 7 days.
/// Permissionless — anyone can call this to claim the storage rebate.
entry fun sweep(
    storm: &mut Storm,
    name_hash: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let ragtag: &Ragtag = dynamic_field::borrow(&storm.id, name_hash);
    assert!(ragtag.signals.is_empty(), EEmpty);
    let now = clock.timestamp_ms();
    assert!(now >= ragtag.last_activity_ms + RAGTAG_TTL_MS, ENotExpired);

    let Ragtag { signals: _, last_activity_ms: _ } = dynamic_field::remove<vector<u8>, Ragtag>(
        &mut storm.id, name_hash,
    );
}

// ─── Fee Management ────────────────────────────────────────────────

/// Update the signal fee. Admin only.
entry fun set_signal_fee(
    storm: &mut Storm,
    new_fee_mist: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);
    storm.signal_fee_mist = new_fee_mist;
}

/// Update the treasury address. Admin only.
entry fun set_fee_treasury(
    storm: &mut Storm,
    new_treasury: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);
    storm.fee_treasury = new_treasury;
}

/// Transfer admin. Current admin only.
entry fun set_admin(
    storm: &mut Storm,
    new_admin: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);
    storm.admin = new_admin;
}

// ─── Queries ────────────────────────────────────────────────────────

/// Count pending signals. Permissionless.
public fun count(storm: &Storm, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&storm.id, name_hash)) return 0;
    let ragtag: &Ragtag = dynamic_field::borrow(&storm.id, name_hash);
    ragtag.signals.length()
}

/// Current signal fee in MIST.
public fun signal_fee(storm: &Storm): u64 {
    storm.signal_fee_mist
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
