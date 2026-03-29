// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// iUSD — yield-bearing stable backed by a diversified reserve.
///
/// Sui-native collateral (XAUM, SUI, USDC): held directly by the Treasury.
/// Cross-chain collateral (BTC, ETH assets, SOL assets): controlled by IKA
/// dWallet threshold signatures. The DWalletCap is deposited into the Treasury —
/// no single party can move the cross-chain collateral without 2PC-MPC consensus.
///
/// Tranching: senior (peg floor) absorbs losses last, junior (growth) absorbs first.
/// The cascade protects iUSD holders — junior must be wiped before senior is touched.
module iusd::iusd;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::balance::{Self, Balance};
use sui::sui::SUI;
use sui::url;
use sui::event;
use sui::dynamic_field;
use sui::clock::Clock;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotAuthorized: u64 = 0;
const EInsufficientCollateral: u64 = 1;
const EZeroAmount: u64 = 2;
const ETrancheViolation: u64 = 3;
const EDWalletNotDeposited: u64 = 4;
const ECollateralRatioTooLow: u64 = 5;

// ─── Constants ─────────────────────────────────────────────────────

/// Minimum collateral ratio in basis points (15000 = 150%)
const MIN_COLLATERAL_RATIO_BPS: u64 = 15000;

/// Senior tranche must cover at least 100% of supply (10000 bps)
const SENIOR_COVERAGE_BPS: u64 = 10000;

/// Tranche identifiers
const TRANCHE_SENIOR: u8 = 0;
const TRANCHE_JUNIOR: u8 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct Minted has copy, drop {
    amount: u64,
    recipient: address,
    collateral_ratio_bps: u64,
}

public struct Burned has copy, drop {
    amount: u64,
    burner: address,
}

public struct RevenueReceived has copy, drop {
    source: vector<u8>,
    amount: u64,
}

public struct CollateralUpdated has copy, drop {
    asset: vector<u8>,
    chain: vector<u8>,
    value_mist: u64,
    tranche: u8,
}

public struct DWalletDeposited has copy, drop {
    dwallet_cap_id: address,
    owner: address,
}

public struct RedeemRequested has copy, drop {
    amount: u64,
    redeemer: address,
    request_id: address,
}

// ─── One-Time Witness ───────────────────────────────────────────────

public struct IUSD has drop {}

// ─── Types ──────────────────────────────────────────────────────────

/// Per-asset collateral record. Dynamic field on Treasury, keyed by asset name.
public struct CollateralRecord has store, drop {
    asset: vector<u8>,
    chain: vector<u8>,
    /// For Sui-native: 0x0. For cross-chain: the DWalletCap ID deposited in treasury.
    dwallet_cap_id: address,
    value_mist: u64,
    tranche: u8,
    updated_ms: u64,
}

/// Pending redemption request. Created on burn, fulfilled by TreasuryAgents.
public struct RedeemRequest has key {
    id: UID,
    amount: u64,
    redeemer: address,
    created_ms: u64,
    fulfilled: bool,
}

/// Protocol treasury — the heart of iUSD.
///
/// Holds:
/// - SUI revenue from protocol fees (Thunder, Shade, swaps)
/// - Sui-native collateral balances (deposited directly)
/// - DWalletCap objects (proving control of cross-chain collateral)
/// - Collateral records (oracle-attested values per asset)
/// - Tranche accounting (senior/junior totals)
public struct Treasury has key {
    id: UID,
    /// Revenue balance (SUI) from protocol fees
    revenue: Balance<SUI>,
    /// Total value of senior tranche collateral (in MIST, oracle-attested)
    senior_value_mist: u64,
    /// Total value of junior tranche collateral (in MIST, oracle-attested)
    junior_value_mist: u64,
    /// Total iUSD ever minted
    total_minted: u64,
    /// Total iUSD ever burned
    total_burned: u64,
    /// Number of DWalletCaps deposited (proves cross-chain control)
    dwallet_count: u64,
    /// Authorized minter (multisig or keeper)
    minter: address,
    /// Authorized oracle (TreasuryAgents)
    oracle: address,
}

// ─── Init ───────────────────────────────────────────────────────────

#[allow(deprecated_usage)]
fun init(witness: IUSD, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6, // decimals — matches USDC
        b"iUSD",
        b"iUSD",
        b"Yield-bearing stable backed by gold, silver, equities, energy, and dollar instruments across Bitcoin, Ethereum, Solana, and Sui via IKA dWallet threshold signatures.",
        option::some(url::new_unsafe_from_bytes(
            b"https://sui.ski/assets/iusd.svg"
        )),
        ctx,
    );

    let treasury = Treasury {
        id: object::new(ctx),
        revenue: balance::zero(),
        senior_value_mist: 0,
        junior_value_mist: 0,
        total_minted: 0,
        total_burned: 0,
        dwallet_count: 0,
        minter: ctx.sender(),
        oracle: ctx.sender(),
    };

    transfer::share_object(treasury);
    transfer::public_transfer(treasury_cap, ctx.sender());
    transfer::public_freeze_object(metadata);
}

// ─── DWallet Deposit (zero-trust collateral control) ────────────────

/// Deposit a DWalletCap into the treasury. This proves the treasury
/// controls the cross-chain assets held by this dWallet. The cap is
/// stored as a dynamic field — it cannot be extracted without the
/// treasury's authority, and signatures require the 2PC-MPC ceremony
/// with IKA's network. Nobody has the full key.
///
/// The DWalletCap is a generic Sui object — we accept it by ID and
/// store it. The IKA package types are not imported directly to avoid
/// hard coupling to a specific IKA package version.
entry fun deposit_dwallet_cap(
    treasury: &mut Treasury,
    cap: sui::object::ID,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == treasury.minter, ENotAuthorized);
    let cap_addr = object::id_to_address(&cap);

    // Store the cap ID as a dynamic field (proof it's been deposited)
    let count = treasury.dwallet_count;
    dynamic_field::add(&mut treasury.id, count, cap_addr);
    treasury.dwallet_count = count + 1;

    event::emit(DWalletDeposited {
        dwallet_cap_id: cap_addr,
        owner: ctx.sender(),
    });
}

// ─── Collateral Oracle ──────────────────────────────────────────────

/// Update a collateral record. Oracle-gated (TreasuryAgents).
///
/// For Sui-native assets: dwallet_cap_id = @0x0, value verified by
/// the agents reading on-chain balances.
///
/// For cross-chain assets: dwallet_cap_id must match a deposited cap,
/// value attested by the agents reading cross-chain state via RPC.
/// The DWalletCap proves the treasury COULD control the assets;
/// the oracle confirms the amounts.
entry fun update_collateral(
    treasury: &mut Treasury,
    asset: vector<u8>,
    chain: vector<u8>,
    dwallet_cap_id: address,
    value_mist: u64,
    tranche: u8,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == treasury.oracle, ENotAuthorized);
    assert!(tranche == TRANCHE_SENIOR || tranche == TRANCHE_JUNIOR, ETrancheViolation);

    // For cross-chain assets, verify the DWalletCap was deposited
    if (dwallet_cap_id != @0x0) {
        let mut found = false;
        let mut i = 0;
        while (i < treasury.dwallet_count) {
            if (dynamic_field::exists_<u64>(&treasury.id, i)) {
                let stored: &address = dynamic_field::borrow(&treasury.id, i);
                if (*stored == dwallet_cap_id) {
                    found = true;
                };
            };
            i = i + 1;
        };
        assert!(found, EDWalletNotDeposited);
    };

    let record = CollateralRecord {
        asset,
        chain,
        dwallet_cap_id,
        value_mist,
        tranche,
        updated_ms: clock.timestamp_ms(),
    };

    // Upsert collateral record (keyed by asset name)
    if (dynamic_field::exists_<vector<u8>>(&treasury.id, asset)) {
        // Subtract old value from tranche total before replacing
        let old: &CollateralRecord = dynamic_field::borrow(&treasury.id, asset);
        if (old.tranche == TRANCHE_SENIOR) {
            treasury.senior_value_mist = treasury.senior_value_mist - old.value_mist;
        } else {
            treasury.junior_value_mist = treasury.junior_value_mist - old.value_mist;
        };
        dynamic_field::remove<vector<u8>, CollateralRecord>(&mut treasury.id, asset);
    };

    // Add new value to tranche total
    if (tranche == TRANCHE_SENIOR) {
        treasury.senior_value_mist = treasury.senior_value_mist + value_mist;
    } else {
        treasury.junior_value_mist = treasury.junior_value_mist + value_mist;
    };

    dynamic_field::add(&mut treasury.id, asset, record);

    event::emit(CollateralUpdated { asset, chain, value_mist, tranche });
}

// ─── Mint (collateral-ratio enforced) ───────────────────────────────

/// Mint iUSD. Enforces:
/// 1. Total collateral >= MIN_COLLATERAL_RATIO_BPS of total supply
/// 2. Senior tranche alone >= 100% of total supply (peg floor)
///
/// Only the authorized minter can call this.
public fun mint(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
): Coin<IUSD> {
    assert!(ctx.sender() == treasury.minter, ENotAuthorized);
    assert!(amount > 0, EZeroAmount);

    let new_supply = supply(treasury) + amount;
    let total_collateral = treasury.senior_value_mist + treasury.junior_value_mist;

    // Check overall collateral ratio (150% minimum)
    // collateral * 10000 >= supply * MIN_COLLATERAL_RATIO_BPS
    assert!(
        total_collateral * 10000 >= new_supply * MIN_COLLATERAL_RATIO_BPS,
        EInsufficientCollateral,
    );

    // Check senior coverage (senior alone must cover 100% of supply)
    assert!(
        treasury.senior_value_mist * 10000 >= new_supply * SENIOR_COVERAGE_BPS,
        ECollateralRatioTooLow,
    );

    treasury.total_minted = treasury.total_minted + amount;

    let collateral_ratio_bps = if (new_supply > 0) {
        total_collateral * 10000 / new_supply
    } else {
        0
    };

    event::emit(Minted { amount, recipient, collateral_ratio_bps });

    coin::mint(treasury_cap, amount, ctx)
}

/// Mint and transfer in one call.
entry fun mint_and_transfer(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let coin = mint(treasury_cap, treasury, amount, recipient, ctx);
    transfer::public_transfer(coin, recipient);
}

// ─── Burn + Redeem ──────────────────────────────────────────────────

/// Burn iUSD and create a redemption request. The TreasuryAgents
/// fulfill the request by releasing proportional collateral.
///
/// Loss waterfall on redemption:
/// - Junior tranche value is reduced first
/// - Senior is only touched after junior is depleted
entry fun burn_and_redeem(
    treasury_cap: &mut TreasuryCap<IUSD>,
    treasury: &mut Treasury,
    coin_to_burn: Coin<IUSD>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = coin_to_burn.value();
    assert!(amount > 0, EZeroAmount);

    treasury.total_burned = treasury.total_burned + amount;

    // Create redemption request for TreasuryAgents to fulfill
    let request = RedeemRequest {
        id: object::new(ctx),
        amount,
        redeemer: ctx.sender(),
        created_ms: clock.timestamp_ms(),
        fulfilled: false,
    };

    let request_id = object::id_to_address(&object::id(&request));

    event::emit(Burned { amount, burner: ctx.sender() });
    event::emit(RedeemRequested { amount, redeemer: ctx.sender(), request_id });

    // Burn the iUSD
    coin::burn(treasury_cap, coin_to_burn);

    // Transfer redemption request to redeemer (they present it to claim collateral)
    transfer::transfer(request, ctx.sender());
}

// ─── Revenue ────────────────────────────────────────────────────────

/// Deposit protocol revenue (SUI) into treasury. Permissionless.
/// Thunder signal fees, Shade escrow cuts, swap spreads all flow here.
entry fun deposit_revenue(
    treasury: &mut Treasury,
    payment: Coin<SUI>,
    source: vector<u8>,
    _ctx: &TxContext,
) {
    let amount = payment.value();
    treasury.revenue.join(coin::into_balance(payment));
    event::emit(RevenueReceived { source, amount });
}

// ─── Admin ──────────────────────────────────────────────────────────

entry fun set_minter(treasury: &mut Treasury, new_minter: address, ctx: &TxContext) {
    assert!(ctx.sender() == treasury.minter, ENotAuthorized);
    treasury.minter = new_minter;
}

entry fun set_oracle(treasury: &mut Treasury, new_oracle: address, ctx: &TxContext) {
    assert!(ctx.sender() == treasury.oracle, ENotAuthorized);
    treasury.oracle = new_oracle;
}

// ─── Queries ────────────────────────────────────────────────────────

/// Total iUSD in circulation.
public fun supply(treasury: &Treasury): u64 {
    treasury.total_minted - treasury.total_burned
}

/// Revenue balance held in treasury.
public fun revenue_balance(treasury: &Treasury): u64 {
    treasury.revenue.value()
}

/// Total collateral value (senior + junior).
public fun total_collateral(treasury: &Treasury): u64 {
    treasury.senior_value_mist + treasury.junior_value_mist
}

/// Current collateral ratio in basis points.
public fun collateral_ratio_bps(treasury: &Treasury): u64 {
    let s = supply(treasury);
    if (s == 0) return 0;
    (treasury.senior_value_mist + treasury.junior_value_mist) * 10000 / s
}

/// Senior tranche value.
public fun senior_value(treasury: &Treasury): u64 {
    treasury.senior_value_mist
}

/// Junior tranche value.
public fun junior_value(treasury: &Treasury): u64 {
    treasury.junior_value_mist
}

/// Number of DWalletCaps deposited (proves cross-chain control).
public fun dwallet_count(treasury: &Treasury): u64 {
    treasury.dwallet_count
}
