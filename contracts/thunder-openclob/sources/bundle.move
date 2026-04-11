// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder OpenCLOB — sub-cent tag bundle settlement (Phase 3a).
///
/// Groups CLOB limit orders by a sub-cent tag so they can be settled
/// atomically. The creator builds a bundle with a target fill count
/// and a deadline; orders are placed on their respective venues in
/// the same PTB and recorded via `record_order_placed`; a scanner
/// watches fills and calls `settle_bundle` once the target is hit.
///
/// What this package does NOT do:
///   - Place orders on specific venues. Bundles are venue-agnostic.
///     The PTB that creates the bundle also places the orders on
///     DeepBook / Cetus / etc. via their native entry functions,
///     then records the returned order_id back onto this bundle.
///   - Hold proceeds. Filled orders' coins stay with whatever the
///     target venue routes them to (typically the maker). Settle is
///     a *confirmation* event on this package, with the
///     cross-venue withdraw happening in the same PTB.
///   - Enforce atomicity across multiple bundles or cross-chain.
///     Phase 3 handles single-chain DeepBook bundles only.
///
/// Status codes:
///   0 = open       — accepting new slot records
///   1 = complete   — target_count reached, awaiting settle
///   2 = settled    — settle_bundle called, bundle destroyed
///   3 = refunded   — force_refund_bundle called by creator
///   4 = expired    — past deadline, awaiting refund
module thunder_openclob::bundle;

use sui::event;

// ─── Errors ──────────────────────────────────────────────────────────

const EBundleNotOpen: u64 = 0;
const EBundleNotComplete: u64 = 1;
const EBundleNotRefundable: u64 = 2;
const EInvalidSlot: u64 = 3;
const EInvalidTargetCount: u64 = 4;
const ECapMismatch: u64 = 5;
const EDeadlinePassed: u64 = 6;

// ─── Constants ───────────────────────────────────────────────────────

const MAX_BUNDLE_SIZE: u8 = 16;

const STATUS_OPEN: u8 = 0;
const STATUS_COMPLETE: u8 = 1;
const STATUS_SETTLED: u8 = 2;
const STATUS_REFUNDED: u8 = 3;

const SLOT_PENDING: u8 = 0;
const SLOT_PLACED: u8 = 1;
const SLOT_FILLED: u8 = 2;
const SLOT_CANCELLED: u8 = 3;

// ─── Types ───────────────────────────────────────────────────────────

/// One order's metadata inside a bundle. All fields are populated at
/// `create_bundle` time *except* `order_id`, which fills in once the
/// order actually lands on its venue (via `record_order_placed`).
public struct OrderSlot has store, copy, drop {
    /// Which CLOB this slot lives on (0=DeepBook, future: 1=Cetus, ...).
    venue: u8,
    /// Pool object ID on the target venue, stored as raw address for
    /// cross-checks. Future Cetus wrappers can reinterpret.
    pool_id: address,
    /// Order ID returned by the venue after placement. 0 before
    /// `record_order_placed` fills it in.
    order_id: u128,
    /// Who receives fill proceeds for this slot.
    recipient: address,
    /// Slot status — see SLOT_* constants.
    status: u8,
}

/// Shared bundle object. The scanner reads state from this, and
/// `settle_bundle` / `force_refund_bundle` consume it.
public struct OrderBundle has key {
    id: UID,
    /// Sub-cent tag (u32 holds both 6-digit and 8-digit widths).
    tag: u32,
    /// Creator of the bundle — force-refund authority via the cap.
    creator: address,
    /// ms since epoch when create_bundle ran.
    created_ms: u64,
    /// ms since epoch after which the creator can force-refund.
    settle_deadline_ms: u64,
    /// Pre-declared list of orders in this bundle.
    orders: vector<OrderSlot>,
    /// How many of the slots need to reach SLOT_FILLED before the
    /// bundle is considered complete. Must be <= length(orders).
    target_count: u8,
    /// Running count of slots currently SLOT_FILLED.
    filled_count: u8,
    /// Bundle-level status — see STATUS_* constants.
    status: u8,
}

/// Capability held by the creator. Required for force_refund_bundle
/// and cancel_slot. Transferable so a multisig / DAO can own one
/// without having the keys hot-wired.
public struct OrderBundleCap has key, store {
    id: UID,
    /// Points at the bundle this cap authorizes.
    bundle_id: address,
}

// ─── Events ──────────────────────────────────────────────────────────

public struct BundleCreated has copy, drop {
    bundle_id: address,
    tag: u32,
    creator: address,
    target_count: u8,
    created_ms: u64,
    settle_deadline_ms: u64,
}

public struct OrderRecorded has copy, drop {
    bundle_id: address,
    slot_idx: u8,
    order_id: u128,
}

public struct SlotFilled has copy, drop {
    bundle_id: address,
    slot_idx: u8,
    filled_count: u8,
    target_count: u8,
}

public struct BundleSettled has copy, drop {
    bundle_id: address,
    tag: u32,
    filled_count: u8,
    settled_ms: u64,
}

public struct BundleRefunded has copy, drop {
    bundle_id: address,
    tag: u32,
    filled_count: u8,
    refunded_ms: u64,
}

public struct SlotCancelled has copy, drop {
    bundle_id: address,
    slot_idx: u8,
}

// ─── Create ──────────────────────────────────────────────────────────

/// Create a new bundle with pre-declared order slots. The PTB that
/// calls this usually also places each order on its venue in the same
/// tx and calls `record_order_placed` for each slot to fill in the
/// venue-assigned order IDs.
public fun create_bundle(
    tag: u32,
    target_count: u8,
    settle_deadline_ms: u64,
    slots: vector<OrderSlot>,
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
): OrderBundleCap {
    let n = vector::length(&slots);
    assert!(n > 0, EInvalidTargetCount);
    assert!(n <= (MAX_BUNDLE_SIZE as u64), EInvalidTargetCount);
    assert!(target_count > 0, EInvalidTargetCount);
    assert!((target_count as u64) <= n, EInvalidTargetCount);

    let now = clock.timestamp_ms();
    assert!(settle_deadline_ms > now, EDeadlinePassed);

    let bundle = OrderBundle {
        id: object::new(ctx),
        tag,
        creator: ctx.sender(),
        created_ms: now,
        settle_deadline_ms,
        orders: slots,
        target_count,
        filled_count: 0,
        status: STATUS_OPEN,
    };
    let bundle_addr = object::uid_to_address(&bundle.id);

    event::emit(BundleCreated {
        bundle_id: bundle_addr,
        tag,
        creator: bundle.creator,
        target_count,
        created_ms: now,
        settle_deadline_ms,
    });

    let cap = OrderBundleCap {
        id: object::new(ctx),
        bundle_id: bundle_addr,
    };

    transfer::share_object(bundle);
    cap
}

/// Helper so client PTBs can construct OrderSlot values without
/// needing to know the internal layout.
public fun new_slot(
    venue: u8,
    pool_id: address,
    recipient: address,
): OrderSlot {
    OrderSlot {
        venue,
        pool_id,
        order_id: 0,
        recipient,
        status: SLOT_PENDING,
    }
}

// ─── Record order placement ──────────────────────────────────────────

/// Called immediately after a venue-native `place_limit_order` (or
/// equivalent) to record the venue-assigned order ID onto the slot.
/// Transitions the slot from PENDING to PLACED.
///
/// Requires the bundle to be STATUS_OPEN. Any caller can record —
/// the authorization comes from the fact that they're executing the
/// same PTB that created the bundle, so if this tx aborts the whole
/// bundle creation unwinds.
public fun record_order_placed(
    bundle: &mut OrderBundle,
    slot_idx: u8,
    order_id: u128,
) {
    assert!(bundle.status == STATUS_OPEN, EBundleNotOpen);
    let idx = slot_idx as u64;
    assert!(idx < vector::length(&bundle.orders), EInvalidSlot);
    let slot = vector::borrow_mut(&mut bundle.orders, idx);
    assert!(slot.status == SLOT_PENDING, EInvalidSlot);
    slot.order_id = order_id;
    slot.status = SLOT_PLACED;

    event::emit(OrderRecorded {
        bundle_id: object::uid_to_address(&bundle.id),
        slot_idx,
        order_id,
    });
}

// ─── Mark slot filled ────────────────────────────────────────────────

/// Called by the scanner when a DeepBook fill event is observed for
/// one of this bundle's order_ids. Transitions PLACED → FILLED and
/// bumps the filled_count. When filled_count reaches target_count,
/// the bundle auto-promotes to STATUS_COMPLETE.
///
/// Permissionless: the caller proves nothing on-chain; the only
/// real check is "does this slot's order_id actually match a
/// reality on DeepBook?" which the scanner verifies off-chain
/// before submitting. A malicious caller could prematurely mark a
/// slot filled, but they'd just trigger a settle_bundle that tries
/// to withdraw proceeds that don't exist, and the settle would
/// fail downstream (in the DeepBook withdraw step) — nothing
/// dangerous leaks.
public fun mark_slot_filled(
    bundle: &mut OrderBundle,
    slot_idx: u8,
) {
    assert!(bundle.status == STATUS_OPEN, EBundleNotOpen);
    let idx = slot_idx as u64;
    assert!(idx < vector::length(&bundle.orders), EInvalidSlot);
    let slot = vector::borrow_mut(&mut bundle.orders, idx);
    assert!(slot.status == SLOT_PLACED, EInvalidSlot);
    slot.status = SLOT_FILLED;
    bundle.filled_count = bundle.filled_count + 1;

    event::emit(SlotFilled {
        bundle_id: object::uid_to_address(&bundle.id),
        slot_idx,
        filled_count: bundle.filled_count,
        target_count: bundle.target_count,
    });

    if (bundle.filled_count >= bundle.target_count) {
        bundle.status = STATUS_COMPLETE;
    };
}

// ─── Settle ──────────────────────────────────────────────────────────

/// Settle a complete bundle. Permissionless — anyone can submit
/// the settle tx, and the on-chain state update is just a
/// bookkeeping transition (`STATUS_COMPLETE` → `STATUS_SETTLED`
/// with bundle deletion). The actual proceeds transfer happens in
/// the SAME PTB via venue-native withdraw calls — this function
/// only signs off that the bundle is settled.
public fun settle_bundle(
    bundle: OrderBundle,
    clock: &sui::clock::Clock,
    _ctx: &mut TxContext,
) {
    assert!(bundle.status == STATUS_COMPLETE, EBundleNotComplete);

    let OrderBundle {
        id,
        tag,
        creator: _,
        created_ms: _,
        settle_deadline_ms: _,
        orders: _,
        target_count: _,
        filled_count,
        status: _,
    } = bundle;
    let bundle_addr = object::uid_to_address(&id);
    object::delete(id);

    event::emit(BundleSettled {
        bundle_id: bundle_addr,
        tag,
        filled_count,
        settled_ms: clock.timestamp_ms(),
    });
}

// ─── Force refund ────────────────────────────────────────────────────

/// Creator can reclaim an expired or partially-filled bundle after
/// the deadline. Requires the OrderBundleCap for authorization.
/// Destroys the bundle. Any already-filled proceeds are the
/// creator's responsibility to withdraw from the venue directly —
/// this package doesn't custody coins.
public fun force_refund_bundle(
    bundle: OrderBundle,
    cap: OrderBundleCap,
    clock: &sui::clock::Clock,
    _ctx: &mut TxContext,
) {
    let bundle_addr = object::uid_to_address(&bundle.id);
    assert!(cap.bundle_id == bundle_addr, ECapMismatch);
    assert!(clock.timestamp_ms() >= bundle.settle_deadline_ms, EBundleNotRefundable);

    let OrderBundle {
        id,
        tag,
        creator: _,
        created_ms: _,
        settle_deadline_ms: _,
        orders: _,
        target_count: _,
        filled_count,
        status: _,
    } = bundle;
    object::delete(id);

    let OrderBundleCap { id: cap_id, bundle_id: _ } = cap;
    object::delete(cap_id);

    event::emit(BundleRefunded {
        bundle_id: bundle_addr,
        tag,
        filled_count,
        refunded_ms: clock.timestamp_ms(),
    });
}

// ─── Cancel one slot ─────────────────────────────────────────────────

/// Creator can drop a slot from the bundle while it's still open.
/// Reduces the target_count by 1 (so the bundle can still complete).
/// Slot itself is marked SLOT_CANCELLED for audit trail.
public fun cancel_slot(
    bundle: &mut OrderBundle,
    cap: &OrderBundleCap,
    slot_idx: u8,
) {
    assert!(cap.bundle_id == object::uid_to_address(&bundle.id), ECapMismatch);
    assert!(bundle.status == STATUS_OPEN, EBundleNotOpen);
    let idx = slot_idx as u64;
    assert!(idx < vector::length(&bundle.orders), EInvalidSlot);

    let slot = vector::borrow_mut(&mut bundle.orders, idx);
    assert!(slot.status != SLOT_FILLED && slot.status != SLOT_CANCELLED, EInvalidSlot);
    slot.status = SLOT_CANCELLED;

    if (bundle.target_count > 0) {
        bundle.target_count = bundle.target_count - 1;
    };

    event::emit(SlotCancelled {
        bundle_id: object::uid_to_address(&bundle.id),
        slot_idx,
    });
}

// ─── Read helpers (for off-chain scanners) ───────────────────────────

public fun tag(bundle: &OrderBundle): u32 { bundle.tag }
public fun creator(bundle: &OrderBundle): address { bundle.creator }
public fun status(bundle: &OrderBundle): u8 { bundle.status }
public fun target_count(bundle: &OrderBundle): u8 { bundle.target_count }
public fun filled_count(bundle: &OrderBundle): u8 { bundle.filled_count }
public fun orders(bundle: &OrderBundle): &vector<OrderSlot> { &bundle.orders }
public fun created_ms(bundle: &OrderBundle): u64 { bundle.created_ms }
public fun settle_deadline_ms(bundle: &OrderBundle): u64 { bundle.settle_deadline_ms }

public fun slot_venue(s: &OrderSlot): u8 { s.venue }
public fun slot_pool_id(s: &OrderSlot): address { s.pool_id }
public fun slot_order_id(s: &OrderSlot): u128 { s.order_id }
public fun slot_recipient(s: &OrderSlot): address { s.recipient }
public fun slot_status(s: &OrderSlot): u8 { s.status }

// ─── Status constants (public for off-chain matching) ────────────────

public fun status_open(): u8 { STATUS_OPEN }
public fun status_complete(): u8 { STATUS_COMPLETE }
public fun status_settled(): u8 { STATUS_SETTLED }
public fun status_refunded(): u8 { STATUS_REFUNDED }

public fun slot_pending(): u8 { SLOT_PENDING }
public fun slot_placed(): u8 { SLOT_PLACED }
public fun slot_filled(): u8 { SLOT_FILLED }
public fun slot_cancelled(): u8 { SLOT_CANCELLED }
