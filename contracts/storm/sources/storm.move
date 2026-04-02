// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Storm v1 — private encrypt signals via ECDH-derived storm IDs.
///
/// Storm is the shared object. Anyone can signal, quest, strike, or sweep.
/// Knowledge of the storm_id IS the authorization — no NFT gate, no fee,
/// no admin. The storm_id is an opaque ECDH-derived key that only the
/// two conversation participants can compute.
///
/// Thunderstorm holds signals per storm_id. Questing emits decrypted keys.
/// Empty thunderstorms survive for 7 days (reused by new signals).
/// After 7 days idle, anyone can sweep for the storage rebate.
module storm::storm;

use sui::dynamic_field;
use sui::event;
use sui::clock::Clock;

// ─── Errors ──────────────────────────────────────────────────────────

const EEmpty: u64 = 0;
const ENotExpired: u64 = 1;
const ENotEmpty: u64 = 2;

// ─── Constants ─────────────────────────────────────────────────────

/// 7 days in milliseconds
const THUNDERSTORM_TTL_MS: u64 = 604_800_000;

// ─── Events ─────────────────────────────────────────────────────────

/// Emitted when a signal is sent.
public struct Signaled has copy, drop {
    storm_id: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted on quest/strike — contains everything the client needs to decrypt.
public struct Questfi has copy, drop {
    storm_id: vector<u8>,
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
}

// ─── Types ──────────────────────────────────────────────────────────

/// The shared object — always-on infrastructure.
public struct Storm has key {
    id: UID,
    version: u64,
}

/// A single encrypt signal.
public struct Signal has store, copy, drop {
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

/// Per-storm_id thunderstorm. Dynamic field on Storm, keyed by storm_id.
/// Survives empty for up to THUNDERSTORM_TTL_MS after last activity.
public struct Thunderstorm has store {
    signals: vector<Signal>,
    last_activity_ms: u64,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Storm {
        id: object::new(ctx),
        version: 1,
    });
}

// ─── Signal (permissionless, no fee) ────────────────────────────────

/// Send a signal into an opaque storm_id. Permissionless — anyone can write.
/// The storm_id is the ECDH-derived key, not a name hash.
entry fun signal(
    storm: &mut Storm,
    storm_id: vector<u8>,
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let sig = Signal { payload, aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&storm.id, storm_id)) {
        let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, storm_id);
        thunderstorm.signals.push_back(sig);
        thunderstorm.last_activity_ms = timestamp_ms;
    } else {
        dynamic_field::add(&mut storm.id, storm_id, Thunderstorm {
            signals: vector[sig],
            last_activity_ms: timestamp_ms,
        });
    };

    event::emit(Signaled { storm_id, timestamp_ms });
}

// ─── Quest (permissionless read) ────────────────────────────────────

/// Quest — read signals without deleting. Permissionless.
/// Only someone who knows the storm_id can find the signals.
/// Emits one Questfi event per signal in the thunderstorm.
entry fun quest(
    storm: &Storm,
    storm_id: vector<u8>,
    _clock: &Clock,
) {
    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, storm_id);
    assert!(!thunderstorm.signals.is_empty(), EEmpty);

    let mut i = 0;
    while (i < thunderstorm.signals.length()) {
        let sig = &thunderstorm.signals[i];
        event::emit(Questfi {
            storm_id,
            payload: sig.payload,
            aes_key: sig.aes_key,
            aes_nonce: sig.aes_nonce,
        });
        i = i + 1;
    };
}

// ─── Strike (permissionless delete) ─────────────────────────────────

/// Strike — read and delete all signals. Permissionless.
/// Emits Questfi for each signal, then clears the vector.
/// Storage rebate goes to tx sender.
entry fun strike(
    storm: &mut Storm,
    storm_id: vector<u8>,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, storm_id);
    assert!(!thunderstorm.signals.is_empty(), EEmpty);

    let mut i = 0;
    while (i < thunderstorm.signals.length()) {
        let sig = &thunderstorm.signals[i];
        event::emit(Questfi {
            storm_id,
            payload: sig.payload,
            aes_key: sig.aes_key,
            aes_nonce: sig.aes_nonce,
        });
        i = i + 1;
    };

    // Clear all signals
    thunderstorm.signals = vector[];
    thunderstorm.last_activity_ms = clock.timestamp_ms();
}

// ─── Sweep (permissionless cleanup) ─────────────────────────────────

/// Sweep — delete an empty thunderstorm that has been idle for > 7 days.
/// Permissionless — anyone can call this to claim the storage rebate.
entry fun sweep(
    storm: &mut Storm,
    storm_id: vector<u8>,
    clock: &Clock,
) {
    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, storm_id);
    assert!(thunderstorm.signals.is_empty(), ENotEmpty);
    let now = clock.timestamp_ms();
    assert!(now >= thunderstorm.last_activity_ms + THUNDERSTORM_TTL_MS, ENotExpired);

    let Thunderstorm { signals: _, last_activity_ms: _ } = dynamic_field::remove<vector<u8>, Thunderstorm>(
        &mut storm.id, storm_id,
    );
}

// ─── Queries ────────────────────────────────────────────────────────

/// Count pending signals. Permissionless.
public fun count(storm: &Storm, storm_id: vector<u8>): u64 {
    if (!dynamic_field::exists_(&storm.id, storm_id)) return 0;
    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, storm_id);
    thunderstorm.signals.length()
}
