// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Shade — privacy-preserving time-locked escrow for SuiNS grace-period sniping.
///
/// On-chain, a ShadeOrder reveals only:
///   - owner address
///   - escrowed SUI balance
///   - opaque commitment hash
///   - Seal-encrypted payload (only owner can decrypt)
///
/// The domain name, target address, and execution timestamp are hidden until
/// the owner reveals them at execution time. Seal ensures only the owner can
/// recover the encrypted details (via `seal_approve`).
///
/// Commitment: SHA3-256(domain || execute_after_ms || target_address || salt)
///
/// Execute flow (reveal):
///   1. Owner decrypts Seal payload → gets domain, execute_after_ms, target, salt
///   2. Calls execute() with plaintext args → contract verifies commitment + clock
///   3. Returns Coin<SUI> for composing with suins::register in same PTB
module shade::shade;

use sui::balance::Balance;
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::hash::keccak256;
use sui::bcs;
use sui::sui::SUI;
use sui::event;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const ETooEarly: u64 = 1;
const EInvalidCommitment: u64 = 2;
const EZeroDeposit: u64 = 3;
const EAlreadyRefunded: u64 = 4;
const ENonZeroDeposit: u64 = 5;

// ─── Events ─────────────────────────────────────────────────────────

public struct OrderCreated has copy, drop {
    order_id: ID,
    owner: address,
    deposit: u64,
}

public struct OrderExecuted has copy, drop {
    order_id: ID,
    executor: address,
    domain: vector<u8>,
    target_address: address,
    deposit: u64,
}

public struct OrderCancelled has copy, drop {
    order_id: ID,
    owner: address,
    deposit: u64,
}

public struct OrderToppedUp has copy, drop {
    order_id: ID,
    owner: address,
    added: u64,
    new_total: u64,
}

// ─── Structs ─────────────────────────────────────────────────────────

/// A time-locked escrow order. Shared object, `key` only (no `store` —
/// prevents wrapping/transferring).
///
/// The commitment hides: domain, execution timestamp, target address, and salt.
/// The sealed_payload is a Seal-encrypted blob recoverable only by the owner
/// via the `seal_approve` access policy.
public struct ShadeOrder has key {
    id: UID,
    /// Creator — only they can cancel or decrypt via Seal.
    owner: address,
    /// Escrowed SUI for the registration payment.
    deposit: Balance<SUI>,
    /// SHA3-256(domain_bytes || execute_after_ms_bcs || target_address_bcs || salt)
    commitment: vector<u8>,
    /// Seal-encrypted payload containing (domain, execute_after_ms, target_address, salt).
    /// Encrypted with identity = [shade_pkg]::[commitment], decryptable only by owner.
    sealed_payload: vector<u8>,
}

// ─── Create ──────────────────────────────────────────────────────────

/// Deposit SUI and create a new shade order. The order is shared so it can
/// be consumed by `execute()` in a PTB composed with suins::register.
///
/// `commitment` = keccak256(domain_bytes || bcs(execute_after_ms) || bcs(target_address) || salt)
/// `sealed_payload` = Seal-encrypted blob (domain, execute_after_ms, target, salt)
entry fun create(
    coin: Coin<SUI>,
    commitment: vector<u8>,
    sealed_payload: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(coin.value() > 0, EZeroDeposit);
    let order = ShadeOrder {
        id: object::new(ctx),
        owner: ctx.sender(),
        deposit: coin.into_balance(),
        commitment,
        sealed_payload,
    };
    event::emit(OrderCreated {
        order_id: object::id(&order),
        owner: order.owner,
        deposit: order.deposit.value(),
    });
    transfer::share_object(order);
}

// ─── Execute (reveal) ────────────────────────────────────────────────

/// Reveal the committed parameters, verify the commitment, check the clock,
/// consume the order, and return the escrowed coin.
///
/// Returns `Coin<SUI>` (not entry) so it composes in a PTB:
///   execute(order, ...) → Coin<SUI> → suins::register(coin=result) → transferObjects(nft)
///
/// Anyone who knows the preimage can call this (enables keeper bots the owner trusts).
/// The commitment is the knowledge-based access gate; the clock is the time gate.
public fun execute(
    order: ShadeOrder,
    domain: vector<u8>,
    execute_after_ms: u64,
    target_address: address,
    salt: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<SUI> {
    assert!(clock.timestamp_ms() >= execute_after_ms, ETooEarly);
    let mut preimage = domain;
    preimage.append(bcs::to_bytes(&execute_after_ms));
    preimage.append(bcs::to_bytes(&target_address));
    preimage.append(salt);
    let hash = keccak256(&preimage);
    assert!(hash == order.commitment, EInvalidCommitment);
    let deposit_amount = order.deposit.value();
    event::emit(OrderExecuted {
        order_id: object::id(&order),
        executor: ctx.sender(),
        domain,
        target_address,
        deposit: deposit_amount,
    });
    let ShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    coin::from_balance(deposit, ctx)
}

// ─── Cancel ──────────────────────────────────────────────────────────

/// Owner-only refund. Destroys the order and returns escrowed SUI.
entry fun cancel(order: ShadeOrder, ctx: &mut TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    event::emit(OrderCancelled {
        order_id: object::id(&order),
        owner: order.owner,
        deposit: order.deposit.value(),
    });
    let ShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    let coin = coin::from_balance(deposit, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

/// WaaP-safe two-step cancel:
/// 1) Owner calls this entry to refund escrow using &mut shared object access.
/// 2) Keeper calls reap_cancelled() to delete the now-empty cancelled object.
entry fun cancel_refund(order: &mut ShadeOrder, ctx: &mut TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    let refund = order.deposit.value();
    assert!(refund > 0, EAlreadyRefunded);
    if (refund > 0) {
        let coin = coin::take(&mut order.deposit, refund, ctx);
        transfer::public_transfer(coin, order.owner);
    };
    event::emit(OrderCancelled {
        order_id: object::id(order),
        owner: order.owner,
        deposit: refund,
    });
}

/// Deletes a cancelled order after refund. Anyone may call this cleanup.
entry fun reap_cancelled(order: ShadeOrder, ctx: &mut TxContext) {
    assert!(order.deposit.value() == 0, ENonZeroDeposit);
    let ShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    let zero = coin::from_balance(deposit, ctx);
    coin::destroy_zero(zero);
}

// ─── Top-up ──────────────────────────────────────────────────────────

/// Owner adds more SUI if the price moved since the order was created.
entry fun top_up(order: &mut ShadeOrder, coin: Coin<SUI>, ctx: &TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    let added = coin.value();
    order.deposit.join(coin.into_balance());
    event::emit(OrderToppedUp {
        order_id: object::id(order),
        owner: order.owner,
        added,
        new_total: order.deposit.value(),
    });
}

// ─── Generic stable shade (accepts any coin type) ───────────────────
// Enables SOL → iUSD → shade without needing SUI. The deposit is held
// in whatever coin the user provides (iUSD, USDC, etc.). Execute
// returns the same coin type for composing with registration swaps.

public struct StableShadeOrder<phantom T> has key {
    id: UID,
    owner: address,
    deposit: Balance<T>,
    commitment: vector<u8>,
    sealed_payload: vector<u8>,
}

public struct StableOrderCreated has copy, drop {
    order_id: ID,
    owner: address,
    deposit: u64,
}

public struct StableOrderExecuted has copy, drop {
    order_id: ID,
    executor: address,
    domain: vector<u8>,
    target_address: address,
    deposit: u64,
}

public struct StableOrderCancelled has copy, drop {
    order_id: ID,
    owner: address,
    deposit: u64,
}

entry fun create_stable<T>(
    coin: Coin<T>,
    commitment: vector<u8>,
    sealed_payload: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(coin.value() > 0, EZeroDeposit);
    let order = StableShadeOrder<T> {
        id: object::new(ctx),
        owner: ctx.sender(),
        deposit: coin.into_balance(),
        commitment,
        sealed_payload,
    };
    event::emit(StableOrderCreated {
        order_id: object::id(&order),
        owner: order.owner,
        deposit: order.deposit.value(),
    });
    transfer::share_object(order);
}

public fun execute_stable<T>(
    order: StableShadeOrder<T>,
    domain: vector<u8>,
    execute_after_ms: u64,
    target_address: address,
    salt: vector<u8>,
    treasury: address,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(clock.timestamp_ms() >= execute_after_ms, ETooEarly);
    let mut preimage = domain;
    preimage.append(bcs::to_bytes(&execute_after_ms));
    preimage.append(bcs::to_bytes(&target_address));
    preimage.append(salt);
    let hash = keccak256(&preimage);
    assert!(hash == order.commitment, EInvalidCommitment);
    let deposit_amount = order.deposit.value();
    event::emit(StableOrderExecuted {
        order_id: object::id(&order),
        executor: ctx.sender(),
        domain,
        target_address,
        deposit: deposit_amount,
    });
    let StableShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    let fee_amount = deposit_amount / 10;
    let mut deposit_balance = deposit;
    let fee_balance = deposit_balance.split(fee_amount);
    let fee_coin = coin::from_balance(fee_balance, ctx);
    transfer::public_transfer(fee_coin, treasury);
    coin::from_balance(deposit_balance, ctx)
}

entry fun cancel_stable<T>(order: StableShadeOrder<T>, ctx: &mut TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    event::emit(StableOrderCancelled {
        order_id: object::id(&order),
        owner: order.owner,
        deposit: order.deposit.value(),
    });
    let StableShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    let coin = coin::from_balance(deposit, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

entry fun cancel_refund_stable<T>(order: &mut StableShadeOrder<T>, ctx: &mut TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    let refund = order.deposit.value();
    assert!(refund > 0, EAlreadyRefunded);
    let coin = coin::take(&mut order.deposit, refund, ctx);
    transfer::public_transfer(coin, order.owner);
    event::emit(StableOrderCancelled {
        order_id: object::id(order),
        owner: order.owner,
        deposit: refund,
    });
}

entry fun reap_cancelled_stable<T>(order: StableShadeOrder<T>, ctx: &mut TxContext) {
    assert!(order.deposit.value() == 0, ENonZeroDeposit);
    let StableShadeOrder { id, owner: _, deposit, commitment: _, sealed_payload: _ } = order;
    id.delete();
    let zero = coin::from_balance(deposit, ctx);
    coin::destroy_zero(zero);
}

// ─── Seal access policy ──────────────────────────────────────────────
//
// Identity namespace: [shade_pkg]::[commitment]
// Only the order owner may decrypt the sealed_payload.
// Key servers call this function to verify decryption access.

/// Returns the Seal namespace bytes for this order (= commitment hash).
/// The commitment is used as the Seal encryption identity so that the owner
/// can recover the sealed_payload even without knowing the order's UID.
public fun namespace(order: &ShadeOrder): vector<u8> {
    order.commitment
}

/// Seal approval entry point. Key servers invoke this to check whether
/// the caller is authorized to decrypt data encrypted under this order's namespace.
entry fun seal_approve(id: vector<u8>, order: &ShadeOrder, ctx: &TxContext) {
    assert!(ctx.sender() == order.owner, ENotOwner);
    // Verify the requested id has the correct namespace prefix
    let ns = namespace(order);
    assert!(is_prefix(ns, id), ENotOwner);
}

// ─── Accessors ───────────────────────────────────────────────────────

public fun owner(order: &ShadeOrder): address { order.owner }
public fun deposit_value(order: &ShadeOrder): u64 { order.deposit.value() }
public fun commitment(order: &ShadeOrder): vector<u8> { order.commitment }
public fun sealed_payload(order: &ShadeOrder): vector<u8> { order.sealed_payload }

// ─── Helpers ─────────────────────────────────────────────────────────

/// Check if `prefix` is a prefix of `data`.
fun is_prefix(prefix: vector<u8>, data: vector<u8>): bool {
    if (prefix.length() > data.length()) return false;
    let mut i = 0;
    while (i < prefix.length()) {
        if (prefix[i] != data[i]) return false;
        i = i + 1;
    };
    true
}

// ─── Tests ───────────────────────────────────────────────────────────

#[test_only]
use sui::test_scenario as ts;
#[test_only]
use sui::clock;

#[test]
fun test_create_and_cancel() {
    let owner = @0xA;
    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(1_000_000_000, scenario.ctx());
        let commitment = keccak256(&b"test_commitment_preimage");
        create(coin, commitment, b"encrypted_blob", scenario.ctx());
    };
    scenario.next_tx(owner);
    {
        let order = scenario.take_shared<ShadeOrder>();
        assert!(order.deposit_value() == 1_000_000_000);
        assert!(order.owner() == owner);
        cancel(order, scenario.ctx());
    };
    scenario.end();
}

#[test]
fun test_create_and_execute() {
    let owner = @0xA;
    let target = @0xB;
    let domain = b"umbra";
    let execute_after_ms: u64 = 1000;
    let salt = b"random_salt";

    // Build commitment
    let mut preimage = domain;
    preimage.append(bcs::to_bytes(&execute_after_ms));
    preimage.append(bcs::to_bytes(&target));
    preimage.append(salt);
    let commitment = keccak256(&preimage);

    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(2_000_000_000, scenario.ctx());
        create(coin, commitment, b"sealed", scenario.ctx());
    };
    scenario.next_tx(owner);
    {
        let order = scenario.take_shared<ShadeOrder>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock.set_for_testing(1500); // past execute_after_ms
        let coin = execute(order, domain, execute_after_ms, target, salt, &clock, scenario.ctx());
        assert!(coin.value() == 2_000_000_000);
        transfer::public_transfer(coin, owner);
        clock.destroy_for_testing();
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = ETooEarly)]
fun test_execute_too_early() {
    let owner = @0xA;
    let target = @0xB;
    let domain = b"umbra";
    let execute_after_ms: u64 = 2000;
    let salt = b"salt";

    let mut preimage = domain;
    preimage.append(bcs::to_bytes(&execute_after_ms));
    preimage.append(bcs::to_bytes(&target));
    preimage.append(salt);
    let commitment = keccak256(&preimage);

    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(1_000_000_000, scenario.ctx());
        create(coin, commitment, b"sealed", scenario.ctx());
    };
    scenario.next_tx(owner);
    {
        let order = scenario.take_shared<ShadeOrder>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock.set_for_testing(500); // before execute_after_ms — should fail
        let coin = execute(order, domain, execute_after_ms, target, salt, &clock, scenario.ctx());
        transfer::public_transfer(coin, owner);
        clock.destroy_for_testing();
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = EInvalidCommitment)]
fun test_execute_wrong_domain() {
    let owner = @0xA;
    let target = @0xB;
    let domain = b"umbra";
    let execute_after_ms: u64 = 1000;
    let salt = b"salt";

    let mut preimage = domain;
    preimage.append(bcs::to_bytes(&execute_after_ms));
    preimage.append(bcs::to_bytes(&target));
    preimage.append(salt);
    let commitment = keccak256(&preimage);

    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(1_000_000_000, scenario.ctx());
        create(coin, commitment, b"sealed", scenario.ctx());
    };
    scenario.next_tx(owner);
    {
        let order = scenario.take_shared<ShadeOrder>();
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock.set_for_testing(1500);
        // Wrong domain — should fail
        let coin = execute(order, b"wrong", execute_after_ms, target, salt, &clock, scenario.ctx());
        transfer::public_transfer(coin, owner);
        clock.destroy_for_testing();
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = ENotOwner)]
fun test_cancel_not_owner() {
    let owner = @0xA;
    let attacker = @0xC;
    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(1_000_000_000, scenario.ctx());
        let commitment = keccak256(&b"test");
        create(coin, commitment, b"sealed", scenario.ctx());
    };
    scenario.next_tx(attacker);
    {
        let order = scenario.take_shared<ShadeOrder>();
        cancel(order, scenario.ctx()); // not owner — should fail
    };
    scenario.end();
}

#[test]
fun test_top_up() {
    let owner = @0xA;
    let mut scenario = ts::begin(owner);
    {
        let coin = coin::mint_for_testing<SUI>(1_000_000_000, scenario.ctx());
        let commitment = keccak256(&b"test");
        create(coin, commitment, b"sealed", scenario.ctx());
    };
    scenario.next_tx(owner);
    {
        let mut order = scenario.take_shared<ShadeOrder>();
        assert!(order.deposit_value() == 1_000_000_000);
        let extra = coin::mint_for_testing<SUI>(500_000_000, scenario.ctx());
        top_up(&mut order, extra, scenario.ctx());
        assert!(order.deposit_value() == 1_500_000_000);
        ts::return_shared(order);
    };
    scenario.end();
}
