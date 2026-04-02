// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Ignite — burn iUSD, get native gas on any chain.
///
/// Permissionless. Economics self-protect: user overpays in iUSD,
/// t2000 agents reach supermajority consensus off-chain (quilted to Walrus),
/// ultron fulfills by signing native gas tx via IKA dWallet 2PC-MPC.
///
/// The spread (iUSD burned minus gas value) permanently shrinks iUSD supply,
/// improving backing ratio for all holders.
///
/// Privacy: recipient addresses are IKA dWallet-derived (chain@name records
/// in SuiNS dynamic fields). The on-chain event stores the encrypted recipient
/// — only the sender and ultron know the target address. t2000 agents vote on
/// the encrypted payload without seeing the plaintext destination.
///
/// Compliance: iUSD operates under GENIUS Stablecoin Act guidelines (HR 4766).
/// All ignite operations are permanently auditable via Walrus quilts. The burn
/// event on Sui + fulfillment proof on target chain creates a complete trail.
/// No algorithmic peg — 1:1 USDC reserve with overcollateralization.
module ignite::ignite;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use sui::clock::Clock;
use iusd::iusd::IUSD;

// ─── Errors ────────────────────────────────────────────────────────

const EUnderpaid: u64 = 0;
const ENotUltron: u64 = 1;
const EAlreadyFulfilled: u64 = 2;

// ─── Constants ─────────────────────────────────────────────────────

/// Minimum iUSD payment (0.10 iUSD = 100_000_000 at 9 decimals)
const MIN_PAYMENT: u64 = 100_000_000;

// ─── Events ────────────────────────────────────────────────────────

public struct IgniteRequested has copy, drop {
    request_id: address,
    sender: address,
    chain: vector<u8>,
    /// Encrypted recipient — only ultron can decrypt via Seal/AES.
    /// On-chain observers see ciphertext, not the target address.
    encrypted_recipient: vector<u8>,
    iusd_burned: u64,
    timestamp_ms: u64,
}

public struct IgniteFulfilled has copy, drop {
    request_id: address,
    executor: address,
    chain: vector<u8>,
    target_tx_hash: vector<u8>,
    quilt_blob_id: vector<u8>,
}

// ─── Types ─────────────────────────────────────────────────────────

/// Config object — holds the ultron address for auth.
/// Created once on publish, shared.
public struct Config has key {
    id: UID,
    ultron: address,
}

/// Pending ignite request. Burned iUSD, waiting for gas on target chain.
/// The recipient field is encrypted — privacy by default.
public struct IgniteRequest has key {
    id: UID,
    sender: address,
    chain: vector<u8>,
    /// Encrypted with ultron's public key — only ultron can read the target address.
    /// Derived from the sender's chain@name IKA dWallet address.
    encrypted_recipient: vector<u8>,
    iusd_burned: u64,
    created_ms: u64,
    fulfilled: bool,
}

// ─── Init ──────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    let config = Config {
        id: object::new(ctx),
        ultron: ctx.sender(),
    };
    transfer::share_object(config);
}

// ─── Request ───────────────────────────────────────────────────────

/// Burn iUSD and request native gas on a foreign chain.
///
/// `chain`: target chain identifier (b"sol", b"eth", b"base", b"btc", b"arb")
/// `encrypted_recipient`: target address encrypted with ultron's public key.
///   The client encrypts the chain@name derived address (from IKA dWallet)
///   so on-chain observers cannot link the Sui sender to the target chain address.
///
/// The iUSD is burned immediately — supply shrinks, backing ratio rises.
/// ultron decrypts the recipient, t2000s vote on the encrypted payload,
/// then ultron fulfills via IKA 2PC-MPC signing.
entry fun ignite_req(
    config: &Config,
    treasury_cap: &mut TreasuryCap<IUSD>,
    payment: Coin<IUSD>,
    chain: vector<u8>,
    encrypted_recipient: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = payment.value();
    assert!(amount >= MIN_PAYMENT, EUnderpaid);

    // Burn the iUSD — permanent supply reduction
    coin::burn(treasury_cap, payment);

    let request = IgniteRequest {
        id: object::new(ctx),
        sender: ctx.sender(),
        chain,
        encrypted_recipient,
        iusd_burned: amount,
        created_ms: clock.timestamp_ms(),
        fulfilled: false,
    };

    let request_id = object::id_to_address(&object::id(&request));

    event::emit(IgniteRequested {
        request_id,
        sender: ctx.sender(),
        chain: request.chain,
        encrypted_recipient: request.encrypted_recipient,
        iusd_burned: amount,
        timestamp_ms: request.created_ms,
    });

    // Send request to ultron — ultron watches for these
    transfer::transfer(request, config.ultron);
}

// ─── Response ──────────────────────────────────────────────────────

/// Record ignite fulfillment. Called by ultron after t2000 consensus
/// and IKA dWallet execution on the target chain.
///
/// `target_tx_hash`: tx hash on the target chain (proof of gas delivery)
/// `quilt_blob_id`: Walrus blob ID containing all t2000 votes (audit trail)
entry fun ignite_resp(
    config: &Config,
    request: IgniteRequest,
    target_tx_hash: vector<u8>,
    quilt_blob_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == config.ultron, ENotUltron);
    assert!(!request.fulfilled, EAlreadyFulfilled);

    let request_id = object::id_to_address(&object::id(&request));

    event::emit(IgniteFulfilled {
        request_id,
        executor: ctx.sender(),
        chain: request.chain,
        target_tx_hash,
        quilt_blob_id,
    });

    // Destroy the fulfilled request
    let IgniteRequest { id, sender: _, chain: _, encrypted_recipient: _, iusd_burned: _, created_ms: _, fulfilled: _ } = request;
    object::delete(id);
}

// ─── Admin ─────────────────────────────────────────────────────────

/// Transfer ultron role to a new address.
entry fun set_ultron(config: &mut Config, new_ultron: address, ctx: &TxContext) {
    assert!(ctx.sender() == config.ultron, ENotUltron);
    config.ultron = new_ultron;
}
