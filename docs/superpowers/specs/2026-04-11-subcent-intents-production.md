# Sub-cent Intents — Production Design

**Date:** 2026-04-11
**Status:** Draft — implementation plan
**Pokemon:** Porygon Lv. 50 → Porygon2 Lv. 62 → Porygon-Z Lv. 80 (3-phase)

## Problem

Sub-cent intents are already live: the client generates tagged Prism URIs (`prism=usdc:10.006296`) and the Helius webhook matches tagged SOL deposits back to Sui addresses and mints iUSD collateral. It works, but the design has production-blocking gaps:

1. **No Sui-side USDC watcher.** Prism works only when the user opens sui.ski and the client fires the transfer. External wallets paying to ultron with a tagged amount are silently ignored.
2. **Collisions are plausible.** 6-digit tag space (1M buckets) derived deterministically from address hash. 50k active users × 20 open intents puts us within one order of magnitude of collisions, and the create path doesn't check.
3. **Intent table grows unbounded.** `deposit_intents` and `kamino_intents` never get pruned. The webhook loop scans them on every Helius hit.
4. **Tags encode a destination, not an action.** There's no way to say "mint iUSD, register `atlas.sui`, leave change" — you get one route per tag.
5. **OpenCLOB integration is spec-only.** Cross-CLOB order matching via tag IDs (DeepBook + Kamino + Cetus + Bluefin) exists as lore, not code.
6. **Tag space isn't evenly allocated.** Derivation `sha256(addr)[:3] % 1_000_000` has uniform distribution but no per-user rate limit, no revocation, and no rotation. A misbehaving user could exhaust the matcher's attention budget.

## Goals

- **Any wallet, anywhere, can pay ultron with a tagged amount and land in the right Sui address's iUSD cache.** No bespoke client, no QR-only path.
- **Collisions detected at creation time.** No two live intents share a tag.
- **Intents self-prune.** 10-minute TTL, cleaned on every alarm tick.
- **Tags carry structured routing.** Route + action + nonce, not just a blob identifier.
- **Cross-chain coverage parity.** SOL, USDC-on-Sui, USDC-on-Ethereum, USDC-on-Base.
- **OpenCLOB order tags.** DeepBook limit orders can be grouped and matched by sub-cent tag, settled atomically.

## Non-goals

- Not designing a bridge. Sub-cent intents are a **matching layer** on top of existing chains.
- Not building a new stable. Settlement lives in iUSD.
- Not replacing Seal/Thunder. This is payment routing, not messaging.
- Not optimizing CEX-side deposits. The tag space is large enough for on-chain flows; CEX deposits can keep memo fields.

## Phase 1 — Porygon Lv. 50: production hardening (Day 1)

**Scope:** Close the three gaps that turn sub-cent intents from "demo" into "reliable production":

### 1a. Sui-side USDC watcher

New method `_watchSuiUsdcDeposits` on `TreasuryAgents`, called from `_tick` right after `_watchSolDeposits`.

- Query ultron's USDC coins via GraphQL:
  ```graphql
  query($a: SuiAddress!) {
    address(address: $a) {
      objects(filter: { type: "0x2::coin::Coin<...::usdc::USDC>" }, first: 50) {
        nodes { address contents { json } previousTransaction { digest sender { address } } }
      }
    }
  }
  ```
- Track a cursor (`last_sui_usdc_digest`) so we only process new coins. First run reads the newest digest as a baseline and matches nothing.
- For each coin received since the cursor: extract `tag = totalBalance % 1_000_000`.
- Match against `deposit_intents` (the same table the Helius watcher uses — shared tag namespace).
- On match: attest collateral via existing `attestCollateral` path (USDC 1:1 USD so `collateralValueMist = balance / 1e6 * 1e9`), mark intent `matched`, advance cursor.
- No TTL on the cursor; persisted in state.

**File:** `src/server/agents/treasury-agents.ts` (+80 lines next to `_watchSolDeposits`).

### 1b. Intent TTL + reconciler

Add `purgedAt` / `ttl_ms` fields to every intent. Default TTL = 10 minutes. Every alarm tick:

```ts
const now = Date.now();
const fresh = intents.filter(i => i.status !== 'pending' || (now - i.created) < INTENT_TTL_MS);
if (fresh.length !== intents.length) {
  this.setState({ ...this.state, deposit_intents: fresh } as any);
}
```

Same for `kamino_intents`. Matched intents are retained for 24h (so the UI's `deposit-status` poll can report back), then purged.

**File:** `src/server/agents/treasury-agents.ts` — new `_purgeStaleIntents` called from `_tick`.

### 1c. Collision check on create

Before writing a new intent, scan `deposit_intents` for `status === 'pending' && tag === newTag`. On collision, perturb the tag:
```ts
let candidateTag = baseTag;
let nonce = 0;
while (intents.some(i => i.status === 'pending' && i.tag === candidateTag) && nonce < 10) {
  nonce++;
  candidateTag = (baseTag + nonce) % 1_000_000;
}
```

10 retries is enough to guarantee a hit when the table has fewer than ~1% of the space occupied. Above that, abort with a clear 503 and log.

**File:** `src/server/agents/treasury-agents.ts` — inline into the existing `/deposit-intent` handler (~10 lines).

### 1d. Persist cursors

Two new state fields:
```ts
last_sui_usdc_digest: string; // cursor for _watchSuiUsdcDeposits
last_sol_signature: string;   // already implicit — promote to persisted state
```

Both persisted via `setState`. On cold start we read these and skip older txs.

### Definition of done (Phase 1)

- [ ] A Phantom/Slush/Sui wallet pays `10.006296 USDC` to ultron → iUSD cache mint fires, `deposit-status` flips to `matched` within 2 minutes.
- [ ] Same flow with SOL continues to work (no regression).
- [ ] Creating 10 intents for 10 different addresses → all 10 tags unique.
- [ ] Creating an intent whose base tag collides with an existing pending intent → tag is perturbed, both match correctly.
- [ ] `deposit_intents.length` bounded by ~active users × ~3 (TTL prunes the rest).
- [ ] `npx wrangler deploy` is the final step. Both workers green. No `/api/cache/deposit-intent` 503s outside the intended collision-exhaustion case.

## Phase 2 — Porygon2 Lv. 62: action-encoding layer (Week 1)

### Tag schema

Widen the tag from `6 digits` to `8 digits` so routes + actions + nonce fit cleanly. USDC has 6 decimals; we encode the tag in the last 6 decimals of an amount whose integer part is ≥ 1 USDC. iUSD has 9 decimals, so it gets the full 8-digit tag in the last 8. Solana lamports are 9-decimal; last 8 digits.

8-digit tag split:
```
  RR  AA  NNNN
  │   │   │
  │   │   └─ 4-digit nonce (random per-intent; defeats collisions)
  │   └───── 2-digit action (00..99)
  └───────── 2-digit route (00..99)
```

100 routes × 100 actions × 10k nonces = 100M-tag space. Collisions are negligible below ~316 concurrent pending intents (birthday bound) and effectively impossible below ~1000.

### Routes (initial)

| Code | Name | Target                                      |
|------|------|---------------------------------------------|
| `00` | `iusd-cache` | Mint iUSD against the deposit, hold in ultron |
| `01` | `rumble`     | Run DKG for the target address's squids      |
| `02` | `quest`      | Post a Quest bounty for name registration    |
| `03` | `shade`      | Create a grace-period Shade order            |
| `04` | `deepbook`   | Place a limit order on DB (amount in stable) |
| `05` | `storm`      | Open storm / send thunder via memo blob      |
| `06` | `satellite`  | Flash-borrow NS, register, repay in deposit  |
| `07` | `pay`        | Straight transfer to `target` address        |
| `99` | `reserved`   | Future / experimental                        |

### Actions (per-route)

Each route defines its own action space. Example: route `02` (quest):
- `00` = register 5+ char name, 1 year, any coin
- `01` = register 4-char name
- `02` = register 3-char name
- `10` = renew existing name
- `20` = set default after register
- `30` = transfer NFT after register

Actions act as bitflags within their route: `tx bundle = {register, set_default, transfer}` would encode as `action = 0b00110011 = 51`.

### Intent body keyed by tag

Tag alone fits 8 digits. The **body** of the intent — recipient address, coin type, slippage tolerance, deadline, arbitrary params — is posted separately when the intent is created (existing `/api/cache/deposit-intent` POST). Sub-cent tag is the lookup key into the body.

### Prism URL migration

`prism=usdc:10.006296` → `prism=usdc:10.00002045` (route=00, action=20, nonce=0045).
Old format is deprecated but supported for one release (8-digit regex falls back to 6-digit match).

### Definition of done (Phase 2)

- [ ] `POST /api/cache/deposit-intent` accepts `{ route, action, params }` and returns a tagged amount.
- [ ] Existing clients (`prism=usdc:X.YZZZZZZ`) still work under the 6-digit fallback.
- [ ] Helius webhook + Sui USDC watcher both parse 8-digit tags and dispatch to the right route handler.
- [ ] At least 3 routes wired: `iusd-cache`, `quest`, `pay`.
- [ ] Collision bound raises from ~316 to ~31,623 concurrent pending intents.

## Phase 3 — Porygon-Z Lv. 80: OpenCLOB order tags (Week 2–3)

### Concept

A DeepBook limit order for `10.00042037 USDC` isn't just 10.00042037 USDC — it's bundle `04-20-37` (route=openclob, action=maker-limit, nonce=0037). When that order fills, the treasury-agent cron sees the fill event, reads the tag, and settles any other orders with the same tag atomically via a separate PTB (split the fill proceeds, transfer to bundle members, burn any fee remainder to the iUSD cache).

### Moving pieces

1. **Tag table on-chain.** A new shared object `OpenClobBundles { bundles: Table<u32, BundleMeta> }`. `BundleMeta` stores `{orders: vector<OrderRef>, creator, created_ms, settle_deadline_ms}`. Bundles are created via `create_bundle(meta, ctx)` and referenced by tag.
2. **Order-tag linker.** A thin Move module that wraps `deepbook::pool::place_limit_order` with a bundle tag. The wrapper emits a `BundleOrder { bundle, pool, order_id }` event.
3. **Cron scanner.** On every alarm tick, iterate recent `BundleOrder` events, group by bundle, and check if all orders in a bundle have filled. If yes, fire `settle_bundle(bundle, recipients, ctx)`.
4. **Atomic settlement.** `settle_bundle` takes the fill proceeds out of each filled order, sums by recipient, transfers, and destroys the bundle.

### Scope gates

- **Same chain first.** Phase 3 handles Sui-native DeepBook orders only. Cetus/Bluefin come later (each needs its own event shape + wrapper).
- **No cross-chain matching.** Ethereum/Solana-side CLOBs (Kamino, Jupiter) stay on the Helius / Sui-USDC deposit path with route=`04`; bundle semantics don't cross chains in this phase.
- **Max bundle size = 16 orders.** Protect settle tx gas budget.
- **Settlement deadline.** Any bundle older than 24h is eligible for forced refund by its creator.

### Definition of done (Phase 3)

- [ ] New Move package `thunder-openclob` published, UpgradeCap held by keeper.
- [ ] Create a 3-order bundle via a single PTB → all orders land on DeepBook with the same tag.
- [ ] Wait for fills, settle atomically, recipients credited, bundle deleted.
- [ ] Partial-fill path: 2 of 3 orders fill → bundle stays live, cron retries until deadline.
- [ ] Forced-refund path: a 4th order never fills → creator can reclaim unspent collateral after 24h.

## Open questions

- **Sui USDC watcher cursor choice:** GraphQL `objects(filter:{type:...}, orderBy:{field:VERSION}, first:50)` — is `version` monotonic for distinct coin objects? If not, use `previousTransaction.timestamp` and a timestamp-based cursor.
- **Action-encoding collisions across routes:** if two routes both define `action=20`, a truncated tag read still dispatches correctly because the route byte is checked first. But if a mutator bug ever swaps route/action order in a tag, the damage is visible — add a compile-time schema check.
- **OpenCLOB integration with existing sponsor:** if ultron sponsors gas on a bundle creation tx, who gets the refund if the bundle expires? Keep it on the creator — ultron's sponsorship covers fees, not principal.
- **Rate limiting on `/deposit-intent`:** one open POST per address seems right today but a mobile wallet hitting retry will blow past it. Implement per-address sliding window at 5 intents / 60s.

## Not in scope

- CEX-side deposit routing (memo fields are fine there).
- Fiat on-ramp integration.
- Tag rotation for privacy (can always generate with fresh nonce).
- Encrypted routes (route/action are public by design — this is a matching system, not a privacy system).
