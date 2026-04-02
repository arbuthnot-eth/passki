// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// t2000 — QuestFi agent army.
///
/// v1: Agents as owned objects, simple deploy/report.
/// v2: Derived objects under Armory via dof. Parent keeps 1%.
///     Lazy agents get culled. Bold RWA-focused agents spawn.
///     Everything measured in iUSD (dollars).
module t2000::t2000;

use sui::coin::Coin;
use sui::sui::SUI;
use sui::event;
use sui::clock::Clock;
use sui::dynamic_object_field as dof;

// ─── Errors ──────────────────────────────────────────────────────────

const EInsufficientPayment: u64 = 0;
const ENotAdmin: u64 = 1;
#[allow(unused_const)]
const EAlreadyDeployed: u64 = 2;
const ENameTooShort: u64 = 3;
const EAgentNotFound: u64 = 4;
const EAgentStillProductive: u64 = 5;
const ENothingToDistribute: u64 = 7;

// ─── Constants ─────────────────────────────────────────────────────

const DEFAULT_DEPLOY_COST_MIST: u64 = 1_500_000_000;
const PARENT_CUT_BPS: u64 = 100; // 1%
const DEATH_THRESHOLD_RUNS: u64 = 50;

// ─── v1 Events (kept for compatibility) ─────────────────────────────

public struct Deployed has copy, drop {
    designation: vector<u8>,
    operator: address,
    dwallet_id: address,
    mission: vector<u8>,
    timestamp_ms: u64,
}

public struct MissionComplete has copy, drop {
    designation: vector<u8>,
    mission: vector<u8>,
    profit_mist: u64,
    timestamp_ms: u64,
}

// ─── v2 Events ──────────────────────────────────────────────────────

public struct QuestComplete has copy, drop {
    idx: u64,
    designation: vector<u8>,
    mission: vector<u8>,
    agent_profit_iusd: u64,
    parent_cut_iusd: u64,
    timestamp_ms: u64,
}

public struct AgentCulled has copy, drop {
    idx: u64,
    designation: vector<u8>,
    runs: u64,
    profit_iusd: u64,
    timestamp_ms: u64,
}

public struct AgentSpawned has copy, drop {
    idx: u64,
    designation: vector<u8>,
    focus: vector<vector<u8>>,
    timestamp_ms: u64,
}

public struct ProfitDistributed has copy, drop {
    total_iusd: u64,
    agent_count: u64,
    timestamp_ms: u64,
}

// ─── v1 Types (kept for compatibility) ──────────────────────────────

public struct Armory has key {
    id: UID,
    count: u64,
    total_collected_mist: u64,
    deploy_cost_mist: u64,
    treasury: address,
    admin: address,
}

public struct T2000 has key, store {
    id: UID,
    designation: vector<u8>,
    operator: address,
    dwallet_id: address,
    mission: vector<u8>,
    deployed_ms: u64,
    total_profit_mist: u64,
}

// ─── v2 Types (derived objects) ─────────────────────────────────────

/// A QuestFi agent — derived object under Armory via dynamic_object_field.
/// Stored keyed by u64 index. Visible to GraphQL, queryable by ID.
public struct Agent has key, store {
    id: UID,
    idx: u64,
    designation: vector<u8>,
    operator: address,
    dwallet_id: address,
    mission: vector<u8>,
    focus: vector<vector<u8>>,
    deployed_ms: u64,
    total_profit_iusd: u64,
    claimable_iusd: u64,
    runs: u64,
    active: bool,
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

// ─── v1 Deploy (owned objects — kept for compatibility) ─────────────

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

    event::emit(Deployed { designation, operator, dwallet_id, mission, timestamp_ms });
    transfer::transfer(agent, operator);
}

// ─── v1 Mission Reporting (kept for compatibility) ──────────────────

entry fun report_mission(
    agent: &mut T2000,
    mission: vector<u8>,
    profit_mist: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == agent.operator, ENotAdmin);
    agent.total_profit_mist = agent.total_profit_mist + profit_mist;
    event::emit(MissionComplete {
        designation: agent.designation,
        mission,
        profit_mist,
        timestamp_ms: clock.timestamp_ms(),
    });
}

// ─── v2 QuestFi: Deploy as Derived Object ──────────────────────────

/// Deploy a QuestFi agent as a derived object under the Armory.
/// Payment goes to cache. Agent stored as dof keyed by index.
entry fun deploy_quest(
    armory: &mut Armory,
    designation: vector<u8>,
    mission: vector<u8>,
    dwallet_id: address,
    focus: vector<vector<u8>>,
    payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(designation.length() >= 2, ENameTooShort);
    assert!(payment.value() >= armory.deploy_cost_mist, EInsufficientPayment);

    let paid = payment.value();
    transfer::public_transfer(payment, armory.treasury);
    armory.total_collected_mist = armory.total_collected_mist + paid;

    let idx = armory.count;
    let timestamp_ms = clock.timestamp_ms();
    let operator = ctx.sender();

    let agent = Agent {
        id: object::new(ctx),
        idx,
        designation,
        operator,
        dwallet_id,
        mission,
        focus,
        deployed_ms: timestamp_ms,
        total_profit_iusd: 0,
        claimable_iusd: 0,
        runs: 0,
        active: true,
    };

    event::emit(Deployed { designation, operator, dwallet_id, mission, timestamp_ms });

    dof::add(&mut armory.id, idx, agent);
    armory.count = idx + 1;
}

// ─── v2 QuestFi: Report with Parent Cut ────────────────────────────

/// Report quest profit. Parent (Armory) takes 1%, agent keeps 99%.
/// profit_iusd is in iUSD units (9 decimals). Admin only.
entry fun report_quest(
    armory: &mut Armory,
    idx: u64,
    mission: vector<u8>,
    profit_iusd: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    assert!(dof::exists_<u64>(&armory.id, idx), EAgentNotFound);

    let agent: &mut Agent = dof::borrow_mut(&mut armory.id, idx);

    let parent_cut = profit_iusd * PARENT_CUT_BPS / 10000;
    let agent_share = profit_iusd - parent_cut;

    agent.total_profit_iusd = agent.total_profit_iusd + agent_share;
    agent.runs = agent.runs + 1;
    // Parent cut accumulates in Armory's total_collected_mist (reuse field)
    armory.total_collected_mist = armory.total_collected_mist + parent_cut;

    event::emit(QuestComplete {
        idx,
        designation: agent.designation,
        mission,
        agent_profit_iusd: agent_share,
        parent_cut_iusd: parent_cut,
        timestamp_ms: clock.timestamp_ms(),
    });
}

// ─── v2 Natural Selection ──────────────────────────────────────────

/// Cull a lazy agent. Permissionless — natural selection is open.
entry fun cull(
    armory: &mut Armory,
    idx: u64,
    clock: &Clock,
    _ctx: &TxContext,
) {
    assert!(dof::exists_<u64>(&armory.id, idx), EAgentNotFound);

    let agent: &mut Agent = dof::borrow_mut(&mut armory.id, idx);
    assert!(agent.active, EAgentNotFound);
    assert!(
        agent.runs >= DEATH_THRESHOLD_RUNS && agent.total_profit_iusd == 0,
        EAgentStillProductive,
    );

    agent.active = false;

    event::emit(AgentCulled {
        idx,
        designation: agent.designation,
        runs: agent.runs,
        profit_iusd: agent.total_profit_iusd,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Spawn a bold RWA-focused agent. Admin only. No payment needed — these
/// are born from the ashes of culled agents.
entry fun spawn_rwa(
    armory: &mut Armory,
    designation: vector<u8>,
    dwallet_id: address,
    focus: vector<vector<u8>>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    assert!(designation.length() >= 2, ENameTooShort);

    let idx = armory.count;
    let timestamp_ms = clock.timestamp_ms();

    let agent = Agent {
        id: object::new(ctx),
        idx,
        designation,
        operator: armory.admin,
        dwallet_id,
        mission: b"farm",
        focus,
        deployed_ms: timestamp_ms,
        total_profit_iusd: 0,
        claimable_iusd: 0,
        runs: 0,
        active: true,
    };

    event::emit(AgentSpawned { idx, designation, focus, timestamp_ms });

    dof::add(&mut armory.id, idx, agent);
    armory.count = idx + 1;
}

// ─── v2 Parent Redistribution ──────────────────────────────────────

/// Distribute parent cache proportional to agent profit. Admin only.
entry fun distribute(
    armory: &mut Armory,
    pool_iusd: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == armory.admin, ENotAdmin);
    assert!(pool_iusd > 0, ENothingToDistribute);

    // First pass: sum active agent profits
    let mut total_profit = 0u64;
    let mut i = 0u64;
    while (i < armory.count) {
        if (dof::exists_<u64>(&armory.id, i)) {
            let agent: &Agent = dof::borrow(&armory.id, i);
            if (agent.active && agent.total_profit_iusd > 0) {
                total_profit = total_profit + agent.total_profit_iusd;
            };
        };
        i = i + 1;
    };

    if (total_profit == 0) return;

    // Second pass: distribute proportionally
    i = 0;
    let mut distributed = 0u64;
    while (i < armory.count) {
        if (dof::exists_<u64>(&armory.id, i)) {
            let agent: &mut Agent = dof::borrow_mut(&mut armory.id, i);
            if (agent.active && agent.total_profit_iusd > 0) {
                let share = pool_iusd * agent.total_profit_iusd / total_profit;
                agent.claimable_iusd = agent.claimable_iusd + share;
                distributed = distributed + share;
            };
        };
        i = i + 1;
    };

    event::emit(ProfitDistributed {
        total_iusd: distributed,
        agent_count: armory.count,
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
