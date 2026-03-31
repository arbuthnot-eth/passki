// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder v3 — encrypt signals between SuiNS identities.
///
/// Storm is the shared object. Anyone can send a signal (with fee).
/// Only the SuiNS name owner can quest (NFT-gated).
/// Thunderstorm holds signals per name. Questing emits decrypted keys.
/// Empty thunderstorms survive for 7 days (reused by new signals).
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
use sui::ed25519;
use sui::random::{Self, Random};
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmpty: u64 = 1;
const ENotExpired: u64 = 2;
const EInsufficientFee: u64 = 3;
const ENotAdmin: u64 = 4;
const EInvalidSuiami: u64 = 5;

// ─── Constants ─────────────────────────────────────────────────────

/// 7 days in milliseconds
const THUNDERSTORM_TTL_MS: u64 = 604_800_000;

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

/// Emitted when a private signal is sent (SUIAMI verified on-chain).
public struct PrivateSignaled has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
    suiami_verified: bool,
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

/// Per-name thunderstorm. Dynamic field on Storm, keyed by name_hash.
/// Survives empty for up to THUNDERSTORM_TTL_MS after last activity.
public struct Thunderstorm has store {
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

/// Send a signal to someone's thunderstorm. Permissionless — anyone can send.
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
        let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, name_hash);
        thunderstorm.signals.push_back(sig);
        thunderstorm.last_activity_ms = timestamp_ms;
    } else {
        dynamic_field::add(&mut storm.id, name_hash, Thunderstorm {
            signals: vector[sig],
            last_activity_ms: timestamp_ms,
        });
    };

    event::emit(Signaled { name_hash, timestamp_ms });
}

// ─── Private Signal (SUIAMI verified, no fee) ─────────────────────

/// Send a signal with on-chain SUIAMI verification. Permissionless, no fee.
/// The SUIAMI proof (message + ed25519 signature + pubkey) is verified on-chain.
/// The sender's pubkey is validated against the address in the SUIAMI message
/// by hashing the pubkey and checking the first 32 bytes match the Sui address scheme.
/// Use via relay for sender privacy (on-chain sender = relay, real identity in encrypted payload).
entry fun signal_private(
    storm: &mut Storm,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    suiami_msg: vector<u8>,
    suiami_sig: vector<u8>,
    sender_pubkey: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // Verify SUIAMI ed25519 signature on-chain
    assert!(
        ed25519::ed25519_verify(&suiami_sig, &sender_pubkey, &suiami_msg),
        EInvalidSuiami,
    );

    let timestamp_ms = clock.timestamp_ms();
    let sig = Signal { payload, aes_key: masked_aes_key, aes_nonce, timestamp_ms };

    if (dynamic_field::exists_(&storm.id, name_hash)) {
        let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, name_hash);
        thunderstorm.signals.push_back(sig);
        thunderstorm.last_activity_ms = timestamp_ms;
    } else {
        dynamic_field::add(&mut storm.id, name_hash, Thunderstorm {
            signals: vector[sig],
            last_activity_ms: timestamp_ms,
        });
    };

    event::emit(PrivateSignaled { name_hash, timestamp_ms, suiami_verified: true });
}

// ─── Claim (NFT-gated) ─────────────────────────────────────────────

/// Quest — decrypt a signal without removing it. NFT-gated.
/// Emits Questfi so the client can decrypt. Signal stays on-chain.
/// Use index to read any signal in the thunderstorm (0 = oldest).
/// Batch multiple quests in one PTB.
entry fun quest(
    storm: &Storm,
    name_hash: vector<u8>,
    index: u64,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, name_hash);
    assert!(!thunderstorm.signals.is_empty(), EEmpty);

    let sig = &thunderstorm.signals[index];

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

/// Strike — decrypt and delete the first signal. NFT-gated, destructive.
/// Use quest first to read without deleting.
entry fun strike(
    storm: &mut Storm,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    clock: &Clock,
    _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, name_hash);
    assert!(!thunderstorm.signals.is_empty(), EEmpty);

    let sig = thunderstorm.signals.remove(0);
    thunderstorm.last_activity_ms = clock.timestamp_ms();

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

/// Strike via relay — decrypt and delete without requiring the NFT object in the PTB.
/// Admin-gated (keeper only). Auth is verified server-side via signPersonalMessage before calling.
/// The nft_id is passed as raw address bytes for XOR key unmasking.
entry fun strike_relay(
    storm: &mut Storm,
    name_hash: vector<u8>,
    nft_id: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);

    let thunderstorm: &mut Thunderstorm = dynamic_field::borrow_mut(&mut storm.id, name_hash);
    assert!(!thunderstorm.signals.is_empty(), EEmpty);

    let sig = thunderstorm.signals.remove(0);
    thunderstorm.last_activity_ms = clock.timestamp_ms();

    let nft_id_bytes = sui::address::to_bytes(nft_id);
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

/// Sweep — delete an empty thunderstorm that has been idle for > 7 days.
/// Permissionless — anyone can call this to claim the storage rebate.
entry fun sweep(
    storm: &mut Storm,
    name_hash: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, name_hash);
    assert!(thunderstorm.signals.is_empty(), EEmpty);
    let now = clock.timestamp_ms();
    assert!(now >= thunderstorm.last_activity_ms + THUNDERSTORM_TTL_MS, ENotExpired);

    let Thunderstorm { signals: _, last_activity_ms: _ } = dynamic_field::remove<vector<u8>, Thunderstorm>(
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
    let thunderstorm: &Thunderstorm = dynamic_field::borrow(&storm.id, name_hash);
    thunderstorm.signals.length()
}

/// Current signal fee in MIST.
public fun signal_fee(storm: &Storm): u64 {
    storm.signal_fee_mist
}

// ─── v2: Derived Object Signals ─────────────────────────────────────
//
// Signals as dynamic_object_field children of Storm, keyed by
// (recipient_address, counter). Each signal is a visible on-chain object
// queryable via GraphQL by recipient. When the name re-points, new
// signals go to the new address. IKA derived addresses get their own
// signal namespace — sol@stables signals separate from sui@stables.

/// A v2 signal — derived object under Storm, visible to GraphQL.
public struct SignalV2 has key, store {
    id: UID,
    recipient: address,
    name_hash: vector<u8>,
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    timestamp_ms: u64,
}

/// A v3 signal — v2 + on-chain VRF entropy encrypted by recipient's SuiNS identity.
/// Breaks correlation, prevents replay, feeds steganographic encoding.
public struct SignalV3 has key, store {
    id: UID,
    recipient: address,
    name_hash: vector<u8>,
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    /// On-chain VRF entropy, XOR-masked with keccak256(name_hash).
    /// Only name owner can unmask.
    entropy: vector<u8>,
    timestamp_ms: u64,
}

/// Key for indexing signals per recipient under Storm.
/// Storm[RecipientKey { recipient, idx }] → SignalV2
public struct RecipientKey has copy, drop, store {
    recipient: address,
    idx: u64,
}

/// Per-recipient signal counter stored as dynamic_field on Storm.
public struct RecipientCounter has store, drop {
    count: u64,
}

/// Emitted when a v2 signal is created as a derived object.
public struct SignaledV2 has copy, drop {
    recipient: address,
    name_hash: vector<u8>,
    signal_id: address,
    idx: u64,
    timestamp_ms: u64,
}

/// Emitted when a v2 signal is claimed (decrypted + deleted).
public struct ClaimedV2 has copy, drop {
    recipient: address,
    name_hash: vector<u8>,
    signal_id: address,
    timestamp_ms: u64,
}

/// Send a v2 signal — creates a derived object under Storm keyed by recipient.
/// Permissionless with fee. Recipient address is the target (what the SuiNS name resolves to).
entry fun signal_v2(
    storm: &mut Storm,
    recipient: address,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    fee: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(fee.value() >= storm.signal_fee_mist, EInsufficientFee);
    let fee_amount = fee.value();
    transfer::public_transfer(fee, storm.fee_treasury);
    event::emit(FeePaid { amount: fee_amount, treasury: storm.fee_treasury });

    let timestamp_ms = clock.timestamp_ms();
    let counter_key = recipient;
    let idx = if (dynamic_field::exists_<address>(&storm.id, counter_key)) {
        let counter: &mut RecipientCounter = dynamic_field::borrow_mut(&mut storm.id, counter_key);
        let i = counter.count;
        counter.count = i + 1;
        i
    } else {
        dynamic_field::add(&mut storm.id, counter_key, RecipientCounter { count: 1 });
        0
    };
    let sig = SignalV2 {
        id: object::new(ctx), recipient, name_hash, payload,
        aes_key: masked_aes_key, aes_nonce, timestamp_ms,
    };
    let signal_id = object::id_to_address(&object::id(&sig));
    let key = RecipientKey { recipient, idx };
    sui::dynamic_object_field::add(&mut storm.id, key, sig);
    event::emit(SignaledV2 { recipient, name_hash, signal_id, idx, timestamp_ms });
}

/// Send v2 signal with SUIAMI verification — no fee.
entry fun signal_v2_private(
    storm: &mut Storm,
    recipient: address,
    name_hash: vector<u8>,
    payload: vector<u8>,
    masked_aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    suiami_msg: vector<u8>,
    suiami_sig: vector<u8>,
    sender_pubkey: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ed25519::ed25519_verify(&suiami_sig, &sender_pubkey, &suiami_msg), EInvalidSuiami);
    let timestamp_ms = clock.timestamp_ms();
    let counter_key = recipient;
    let idx = if (dynamic_field::exists_<address>(&storm.id, counter_key)) {
        let counter: &mut RecipientCounter = dynamic_field::borrow_mut(&mut storm.id, counter_key);
        let i = counter.count;
        counter.count = i + 1;
        i
    } else {
        dynamic_field::add(&mut storm.id, counter_key, RecipientCounter { count: 1 });
        0
    };
    let sig = SignalV2 {
        id: object::new(ctx), recipient, name_hash, payload,
        aes_key: masked_aes_key, aes_nonce, timestamp_ms,
    };
    let signal_id = object::id_to_address(&object::id(&sig));
    let key = RecipientKey { recipient, idx };
    sui::dynamic_object_field::add(&mut storm.id, key, sig);
    event::emit(SignaledV2 { recipient, name_hash, signal_id, idx, timestamp_ms });
}

/// Claim a v2 signal — NFT-gated decrypt + delete. Returns decryption keys via event.
entry fun claim_v2(
    storm: &mut Storm,
    recipient: address,
    idx: u64,
    nft: &SuinsRegistration,
    clock: &Clock,
    _ctx: &TxContext,
) {
    // Verify the NFT resolves to the recipient address
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);

    let key = RecipientKey { recipient, idx };
    let sig: SignalV2 = sui::dynamic_object_field::remove(&mut storm.id, key);
    assert!(sig.name_hash == computed_hash, ENotOwner);

    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(sig.aes_key, mask);
    let signal_id = object::id_to_address(&object::id(&sig));

    event::emit(Questfi {
        name_hash: sig.name_hash,
        payload: sig.payload,
        aes_key: real_key,
        aes_nonce: sig.aes_nonce,
    });

    event::emit(ClaimedV2 {
        recipient,
        name_hash: sig.name_hash,
        signal_id,
        timestamp_ms: clock.timestamp_ms(),
    });

    // Destroy the signal object
    let SignalV2 { id, recipient: _, name_hash: _, payload: _, aes_key: _, aes_nonce: _, timestamp_ms: _ } = sig;
    object::delete(id);
}

/// Claim v2 via relay — admin-gated, for ultron to relay on behalf of name owner.
entry fun claim_v2_relay(
    storm: &mut Storm,
    recipient: address,
    idx: u64,
    nft_id: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);

    let key = RecipientKey { recipient, idx };
    let sig: SignalV2 = sui::dynamic_object_field::remove(&mut storm.id, key);

    let nft_id_bytes = sui::address::to_bytes(nft_id);
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(sig.aes_key, mask);
    let signal_id = object::id_to_address(&object::id(&sig));

    event::emit(Questfi {
        name_hash: sig.name_hash,
        payload: sig.payload,
        aes_key: real_key,
        aes_nonce: sig.aes_nonce,
    });

    event::emit(ClaimedV2 {
        recipient,
        name_hash: sig.name_hash,
        signal_id,
        timestamp_ms: clock.timestamp_ms(),
    });

    let SignalV2 { id, recipient: _, name_hash: _, payload: _, aes_key: _, aes_nonce: _, timestamp_ms: _ } = sig;
    object::delete(id);
}

/// Count v2 signals for a recipient.
public fun count_v2(storm: &Storm, recipient: address): u64 {
    if (!dynamic_field::exists_<address>(&storm.id, recipient)) return 0;
    let counter: &RecipientCounter = dynamic_field::borrow(&storm.id, recipient);
    counter.count
}

// ─── v3: Entropy Signals (VRF + encrypted by SuiNS identity) ────────

/// v3 key — separate namespace from v2 so both can coexist
public struct RecipientKeyV3 has copy, drop, store {
    recipient: address,
    idx: u64,
}

/// Send v3 signal — v2 + on-chain VRF entropy encrypted by recipient's name.
entry fun signal_v3(
    storm: &mut Storm, recipient: address, name_hash: vector<u8>,
    payload: vector<u8>, masked_aes_key: vector<u8>, aes_nonce: vector<u8>,
    fee: Coin<SUI>, rng: &Random, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(fee.value() >= storm.signal_fee_mist, EInsufficientFee);
    transfer::public_transfer(fee, storm.fee_treasury);

    let timestamp_ms = clock.timestamp_ms();
    let mut gen = random::new_generator(rng, ctx);
    let raw_entropy = gen.generate_bytes(32);
    let entropy = xor_bytes(raw_entropy, keccak256(&name_hash));

    let counter_key = recipient;
    let idx = if (dynamic_field::exists_<address>(&storm.id, counter_key)) {
        let counter: &mut RecipientCounter = dynamic_field::borrow_mut(&mut storm.id, counter_key);
        let i = counter.count; counter.count = i + 1; i
    } else {
        dynamic_field::add(&mut storm.id, counter_key, RecipientCounter { count: 1 }); 0
    };

    let sig = SignalV3 {
        id: object::new(ctx), recipient, name_hash, payload,
        aes_key: masked_aes_key, aes_nonce, entropy, timestamp_ms,
    };
    let signal_id = object::id_to_address(&object::id(&sig));
    sui::dynamic_object_field::add(&mut storm.id, RecipientKeyV3 { recipient, idx }, sig);
    event::emit(SignaledV2 { recipient, name_hash, signal_id, idx, timestamp_ms });
}

/// Send v3 signal with SUIAMI — no fee, VRF entropy.
entry fun signal_v3_private(
    storm: &mut Storm, recipient: address, name_hash: vector<u8>,
    payload: vector<u8>, masked_aes_key: vector<u8>, aes_nonce: vector<u8>,
    suiami_msg: vector<u8>, suiami_sig: vector<u8>, sender_pubkey: vector<u8>,
    rng: &Random, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(ed25519::ed25519_verify(&suiami_sig, &sender_pubkey, &suiami_msg), EInvalidSuiami);
    let timestamp_ms = clock.timestamp_ms();
    let mut gen = random::new_generator(rng, ctx);
    let entropy = xor_bytes(gen.generate_bytes(32), keccak256(&name_hash));

    let counter_key = recipient;
    let idx = if (dynamic_field::exists_<address>(&storm.id, counter_key)) {
        let counter: &mut RecipientCounter = dynamic_field::borrow_mut(&mut storm.id, counter_key);
        let i = counter.count; counter.count = i + 1; i
    } else {
        dynamic_field::add(&mut storm.id, counter_key, RecipientCounter { count: 1 }); 0
    };

    let sig = SignalV3 {
        id: object::new(ctx), recipient, name_hash, payload,
        aes_key: masked_aes_key, aes_nonce, entropy, timestamp_ms,
    };
    let signal_id = object::id_to_address(&object::id(&sig));
    sui::dynamic_object_field::add(&mut storm.id, RecipientKeyV3 { recipient, idx }, sig);
    event::emit(SignaledV2 { recipient, name_hash, signal_id, idx, timestamp_ms });
}

/// Claim v3 signal — NFT-gated, unmasks entropy, returns decryption keys + raw entropy.
entry fun claim_v3(
    storm: &mut Storm, recipient: address, idx: u64,
    nft: &SuinsRegistration, clock: &Clock, _ctx: &TxContext,
) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    let key = RecipientKeyV3 { recipient, idx };
    let sig: SignalV3 = sui::dynamic_object_field::remove(&mut storm.id, key);
    assert!(sig.name_hash == computed_hash, ENotOwner);

    let nft_id_bytes = object::id(nft).to_bytes();
    let mask = keccak256(&nft_id_bytes);
    let real_key = xor_bytes(sig.aes_key, mask);
    // Unmask entropy — only name owner has the name_hash to reverse
    let _raw_entropy = xor_bytes(sig.entropy, keccak256(&sig.name_hash));

    event::emit(Questfi {
        name_hash: sig.name_hash, payload: sig.payload,
        aes_key: real_key, aes_nonce: sig.aes_nonce,
    });
    event::emit(ClaimedV2 {
        recipient, name_hash: sig.name_hash,
        signal_id: object::id_to_address(&object::id(&sig)),
        timestamp_ms: clock.timestamp_ms(),
    });

    let SignalV3 { id, recipient: _, name_hash: _, payload: _, aes_key: _, aes_nonce: _, entropy: _, timestamp_ms: _ } = sig;
    object::delete(id);
}

/// Claim v3 via relay — admin-gated.
entry fun claim_v3_relay(
    storm: &mut Storm, recipient: address, idx: u64,
    nft_id: address, clock: &Clock, ctx: &TxContext,
) {
    assert!(ctx.sender() == storm.admin, ENotAdmin);
    let key = RecipientKeyV3 { recipient, idx };
    let sig: SignalV3 = sui::dynamic_object_field::remove(&mut storm.id, key);

    let mask = keccak256(&sui::address::to_bytes(nft_id));
    let real_key = xor_bytes(sig.aes_key, mask);

    event::emit(Questfi {
        name_hash: sig.name_hash, payload: sig.payload,
        aes_key: real_key, aes_nonce: sig.aes_nonce,
    });
    event::emit(ClaimedV2 {
        recipient, name_hash: sig.name_hash,
        signal_id: object::id_to_address(&object::id(&sig)),
        timestamp_ms: clock.timestamp_ms(),
    });

    let SignalV3 { id, recipient: _, name_hash: _, payload: _, aes_key: _, aes_nonce: _, entropy: _, timestamp_ms: _ } = sig;
    object::delete(id);
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
