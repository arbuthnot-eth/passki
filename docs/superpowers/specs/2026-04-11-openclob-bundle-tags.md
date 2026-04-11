# OpenCLOB Bundle Tags — Sub-cent Phase 3

**Date:** 2026-04-11
**Status:** Draft — implementation plan
**Pokemon:** Porygon-Z Lv. 80 (evolution of Porygon2 from Phase 2)
**Depends on:** Phase 1 (Porygon Lv. 50) + Phase 2 (Porygon2 Lv. 62), both shipped and live.

## Problem

Phase 1 + Phase 2 wire sub-cent intents into deposit routing — a tagged USDC payment to ultron gets routed by the `(route, action, nonce)` triple encoded in its trailing decimal digits. That works for *single-recipient* intents: one deposit, one outcome.

Phase 3 extends the same mechanism to **grouped CLOB orders**. A trader wants to place 4 coordinated DeepBook limit orders (e.g. an atomic basis trade across two pools) where either all 4 fill or none do. Without bundling, partial fills leave the trader exposed. Without a tag-driven settlement layer, trading venues can't detect the grouping.

**The move:** treat the sub-cent tag as a **bundle ID**. Every order in the bundle places with the same tag. The treasury-agent cron watches fills, groups by tag, and settles the bundle atomically via a new Move module.

## Architecture

### 1. `thunder_openclob` Move package

New package at `contracts/thunder-openclob/`. Core types:

```move
/// A bundle of orders that must settle atomically. Shared object
/// so the cron scanner can read state via object lookups.
public struct OrderBundle has key {
    id: UID,
    /// The sub-cent tag encoded as u32 (6 or 8 digit).
    tag: u32,
    /// Bundle creator — gets the refund if the bundle expires.
    creator: address,
    /// ms since epoch when the bundle was created.
    created_ms: u64,
    /// Absolute deadline — after this, creator can force-refund.
    settle_deadline_ms: u64,
    /// Expected orders in the bundle. Filled-in as orders arrive.
    orders: vector<OrderSlot>,
    /// Target count — bundle is "complete" when filled orders >= this.
    target_count: u8,
    /// Current status: open | complete | settled | refunded | expired.
    status: u8,
}

public struct OrderSlot has store, copy, drop {
    /// Which CLOB this order lives on (0=DeepBook, 1=Cetus future).
    venue: u8,
    /// Pool ID for cross-checks.
    pool_id: address,
    /// DeepBook order ID once placed — 0 before submission.
    order_id: u128,
    /// Recipient address for this slot's fill proceeds.
    recipient: address,
    /// Status: 0=pending, 1=placed, 2=filled, 3=cancelled.
    status: u8,
}

public struct BundleSettled has copy, drop {
    bundle_id: address,
    tag: u32,
    total_fills: u8,
    settled_ms: u64,
}
```

Entry functions:

- `create_bundle(tag, target_count, settle_deadline_ms, orders_metadata, ctx)` — creates the shared `OrderBundle`, transfers an `OrderBundleCap` to the creator for force-refund authority. Emits `BundleCreated { bundle_id, tag, target_count }`.
- `record_order_placed(bundle, slot_idx, order_id, ctx)` — the tx that places a DeepBook order calls this right after `place_limit_order`. Updates the slot's `order_id` field. Fails if the bundle is already `settled`/`refunded`.
- `settle_bundle(bundle, proceeds_vec, ctx)` — called by the cron scanner (permissionless). Takes a vector of `Coin<T>` proceeds, one per filled slot, in index order. Transfers each to its recipient, destroys the bundle, emits `BundleSettled`.
- `force_refund_bundle(bundle, cap, remaining_proceeds, ctx)` — creator reclaims any unfilled collateral after `settle_deadline_ms`. Requires the `OrderBundleCap`.
- `cancel_slot(bundle, slot_idx, cap, ctx)` — creator-only, works while the bundle is open. Removes one slot from the target count.

### 2. Client-side bundle builder

New module `src/client/openclob-bundle.ts`:

```ts
export interface BundleOrder {
  venue: 'deepbook';
  poolId: string;
  side: 'buy' | 'sell';
  price: bigint;       // quote-asset units per base unit
  quantity: bigint;    // base asset raw amount
  recipient: string;   // Sui address that receives fills
}

export interface BuiltBundle {
  bundleTx: Uint8Array;           // PTB that creates the bundle + places all orders
  tag: number;                    // the sub-cent tag
  bundleObjectId: string;         // predicted (pre-build) — reconciled after execution
}

export async function buildBundleTx(opts: {
  creator: string;
  orders: BundleOrder[];
  settleDeadlineMs: number;
  route?: number;                 // defaults to ROUTES.DEEPBOOK (4)
  action?: number;                // per-bundle action tag
}): Promise<BuiltBundle>;
```

The PTB performs: `create_bundle` → for each order, `pool::place_limit_order` + `record_order_placed(bundle, i, order_id)` → share bundle → return.

### 3. Scanner in TreasuryAgents

New `_settleOpenBundles()` method called from `_tick` on a throttle (maybe 30s so it can catch fills quickly). The scanner:

1. Queries all `OrderBundle` shared objects with `status=open` via GraphQL filter.
2. For each bundle, checks how many slots are `status=filled` on-chain. DeepBook exposes order fill events; we parse `OrderFilled` events from the tx indexer.
3. If `filled_count >= target_count`, collects the proceed coins (they're owned by the creator or a settlement escrow — TBD) and builds a `settle_bundle` tx that routes proceeds to each slot's recipient.
4. Signs + submits via ultron. Ultron does NOT take custody; the bundle move calls are permissionless and the proceeds always end at the declared recipients.

### 4. CLI helper for manual testing

`window.ski.openBundleDryRun()` that creates a 2-order bundle against a DeepBook testnet pool, prints the tag, and pins the bundle object ID so we can walk the full create → fill → settle path by hand before going live.

## Phases

### Phase 3a — Minimal viable bundle (Week 1)

- `contracts/thunder-openclob/` package with just `OrderBundle` + `create_bundle` + `settle_bundle` + `force_refund_bundle`. No venue-specific wrapper yet.
- Move.toml + deploy script to mainnet. Package ID saved alongside existing `THUNDER_IOU_SHIELDED_PACKAGE` constants.
- Scanner stub that lists bundles but doesn't settle — just logs state.
- Unit tests: create a bundle, check status, force-refund, destroy.

### Phase 3b — DeepBook integration (Week 2)

- `record_order_placed` that takes a DeepBook order ref.
- PTB builder on the client that fuses `create_bundle` + `pool::place_limit_order` + `record_order_placed` for N orders in a single tx.
- Scanner logic: parse DeepBook `OrderFilled` events, match to bundles by order_id, transition slot status.
- End-to-end dry run with 2 orders on a live testnet pool.

### Phase 3c — Auto-settle + force-refund (Week 3)

- Scanner now calls `settle_bundle` when the bundle is complete.
- Cron job for force-refund of expired bundles.
- `ski.openBundleDryRun()` console helper for testing.

### Phase 3d — Cetus / Bluefin support (later)

- Venue wrappers for each additional CLOB. Each has its own event shape but the scanner surface stays unified (bundle → slot → status).

## Safety rails

- **No custody drift.** Ultron can create, settle, and force-refund bundles, but every path either routes proceeds back to declared recipients or back to the creator. No branch lets ultron keep funds.
- **Permissionless settlement.** `settle_bundle` can be called by any party once the bundle is complete. This means even if ultron goes offline, anyone can trigger the settlement for a small gas reward.
- **Creator-controlled refund.** Only the `OrderBundleCap` holder can force-refund. The cap is transferred at creation, so the creator is authoritative.
- **Deadline enforcement.** Bundles past `settle_deadline_ms` can be force-refunded even if some slots are filled — the creator recovers unfilled collateral and receives partial fills.
- **Partial-fill path.** If a bundle is force-refunded with some slots filled, those slots' proceeds still get transferred to their recipients. Nobody gets cheated out of a fill that actually happened.
- **Max bundle size 16.** Caps settle-tx gas budget. Bigger baskets split across multiple bundles.

## Open questions

- **Proceeds custody during the open window.** Where do filled orders' coins live between fill time and settle time? Options: (a) creator holds them in a dedicated escrow object, settled by the scanner via a cap; (b) DeepBook's OrderBook holds them until withdraw, and settle_bundle issues withdraw + transfer in the same tx. (b) is cleaner but couples us to DeepBook's withdraw API.
- **Scanner cadence vs gas cost.** Every tick of `_settleOpenBundles()` costs a GraphQL roundtrip. 30s is a guess — calibrate after first deployment.
- **Bundle-to-bundle atomicity.** Two bundles interacting on the same pool — do we need cross-bundle locks? Probably not for v1 (each bundle stands alone), but would matter for multi-leg strategies.
- **Fee split.** Bundle creators pay normal DeepBook fees per order. Does the bundler take a cut? For v1, no — the incentive is correctness, not skim.

## Not in scope (yet)

- Cross-chain bundles (SOL + Sui legs in the same bundle).
- Private / sealed bundles (bundle contents encrypted until fill).
- Shade-style commit-reveal order placement.
- MEV protection beyond standard DeepBook behavior.
