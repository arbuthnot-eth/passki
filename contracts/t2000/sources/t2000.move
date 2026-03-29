// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// t2000 — IKA army of inky terminators.
///
/// A space pirate army that fights to destroy bridges and wormholes.
/// Each t2000 is an autonomous agent with its own IKA dWallet —
/// threshold-signed, zero-trust, relentless. They don't bridge.
/// They don't wrap. They sign natively on every chain.
///
/// Anyone can deploy a t2000 for $4.50 iUSD equivalent.
/// The fee flows to the iUSD treasury. The agent gets a designation
/// (SuiNS subname under t2000.sui), a dWallet, and a mission.
///
/// They run 24/7. They farm yield. They arb spreads. They liquidate.
/// They sweep fees. They snipe names. They don't stop.
module t2000::t2000;

use sui::coin::{Self, Coin};
use sui::balance::{Self, Balance};
use sui::sui::SUI;
use sui::event;
use sui::clock::Clock;

// ─── Errors ──────────────────────────────────────────────────────────

const EInsufficientPayment: u64 = 0;
const ENotAdmin: u64 = 1;
const EAlreadyDeployed: u64 = 2;
const ENameTooShort: u64 = 3;

// ─── Constants ─────────────────────────────────────────────────────

/// Deployment cost in MIST (0.003 SUI × 1500 ≈ $4.50 at $3/SUI)
/// Adjustable by admin to track $4.50 iUSD equivalent.
const DEFAULT_DEPLOY_COST_MIST: u64 = 1_500_000_000; // 1.5 SUI ≈ $4.50

// ─── Events ─────────────────────────────────────────────────────────

/// A new terminator joins the army.
public struct Deployed has copy, drop {
    designation: vector<u8>,
    operator: address,
    dwallet_id: address,
    mission: vector<u8>,
    timestamp_ms: u64,
}

/// Terminator reports completed mission.
public struct MissionComplete has copy, drop {
    designation: vector<u8>,
    mission: vector<u8>,
    profit_mist: u64,
    timestamp_ms: u64,
}

// ─── Types ──────────────────────────────────────────────────────────

/// The armory — shared object tracking all deployed t2000 agents.
public struct Armory has key {
    id: UID,
    /// Total t2000s deployed
    count: u64,
    /// Total SUI collected from deployments
    total_collected_mist: u64,
    /// Current deployment cost in MIST
    deploy_cost_mist: u64,
    /// iUSD treasury address — all payments go here
    treasury: address,
    /// Admin (will be transferred to IKA dWallet)
    admin: address,
}

/// A deployed t2000 agent — owned object given to the operator.
/// The operator holds this as proof they deployed the terminator.
/// The actual agent runs as a Cloudflare DO keyed by designation.
public struct T2000 has key, store {
    id: UID,
    /// Agent designation (e.g. "arb", "sweep", "snipe")
    designation: vector<u8>,
    /// Operator who deployed this agent
    operator: address,
    /// IKA dWallet ID controlling this agent's cross-chain keys
    dwallet_id: address,
    /// Mission description
    mission: vector<u8>,
    /// Deployment timestamp
    deployed_ms: u64,
    /// Total profit generated (updated by the DO)
    total_profit_mist: u64,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    transfer::share_object(Armory {
        id: object::new(ctx),
        count: 0,
        total_collected_mist: 0,
        deploy_cost_mist: DEFAULT_DEPLOY_COST_MIST,
        treasury: ctx.sender(),
        admin: ctx.sender(),
    });
}

// ─── Deploy ─────────────────────────────────────────────────────────

/// Deploy a new t2000 terminator. Anyone can call this.
/// Payment goes directly to the iUSD treasury.
/// Returns the T2000 object to the deployer.
entry fun deploy(
    armory: &mut Armory,
    designation: vector<u8>,
    mission: vector<u8>,
    dwallet_id: address,
    payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(designation.length() >= 2, ENameTooShort);
    assert!(payment.value() >= armory.deploy_cost_mist, EInsufficientPayment);

    // Payment → treasury (direct, no accumulation)
    let paid = payment.value();
    transfer::public_transfer(payment, armory.treasury);
    armory.total_collected_mist = armory.total_collected_mist + paid;
    armory.count = armory.count + 1;

    let timestamp_ms = clock.timestamp_ms();
    let operator = ctx.sender();

    let agent = T2000 {
        id: object::new(ctx),
        designation,
        operator,
        dwallet_id,
        mission,
        deployed_ms: timestamp_ms,
        total_profit_mist: 0,
    };

    event::emit(Deployed {
        designation,
        operator,
        dwallet_id,
        mission,
        timestamp_ms,
    });

    transfer::transfer(agent, operator);
}

// ─── Mission Reporting ──────────────────────────────────────────────

/// Report a completed mission. The DO calls this via keeper to log
/// profit on-chain. The T2000 object tracks cumulative earnings.
entry fun report_mission(
    agent: &mut T2000,
    mission: vector<u8>,
    profit_mist: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    // Only the operator can report (or the admin/keeper acting on behalf)
    assert!(ctx.sender() == agent.operator, ENotAdmin);
    agent.total_profit_mist = agent.total_profit_mist + profit_mist;

    event::emit(MissionComplete {
        designation: agent.designation,
        mission,
        profit_mist,
        timestamp_ms: clock.timestamp_ms(),
    });
}

// ─── Admin ──────────────────────────────────────────────────────────

entry fun set_deploy_cost(armory: &mut Armory, new_cost_mist: u64, ctx: &TxContext) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    armory.deploy_cost_mist = new_cost_mist;
}

entry fun set_treasury(armory: &mut Armory, new_treasury: address, ctx: &TxContext) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    armory.treasury = new_treasury;
}

entry fun set_admin(armory: &mut Armory, new_admin: address, ctx: &TxContext) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    armory.admin = new_admin;
}

// ─── Queries ────────────────────────────────────────────────────────

public fun army_size(armory: &Armory): u64 { armory.count }
public fun total_collected(armory: &Armory): u64 { armory.total_collected_mist }
public fun deploy_cost(armory: &Armory): u64 { armory.deploy_cost_mist }
