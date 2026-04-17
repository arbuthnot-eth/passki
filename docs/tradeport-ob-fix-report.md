# Tradeport Buy Fix — Report

## Symptom

User clicks **TRADE** on `crowd.sui` at $4. Wallet held 43.98 SUI and ~$4 iUSD,
more than enough. Transaction aborted with:

```
MoveAbort in 3rd command, abort code: 1,
in '0x...002::dynamic_field::borrow_child_object' (instruction 0)
```

Three distinct bugs were masking each other. Each had to be fixed before the
next one surfaced.

---

## Bug 1 — Wrong buy key on Tradeport V1

### What the code did
`resolveTradeportListingId()` walked the NFT's owner chain
(`NFT → dynamic_field wrapper → SimpleListing`) and returned the
**SimpleListing object ID**. All three purchase builders then used that ID as
the `listing_id` argument to
`tradeport_listings::buy_listing_without_transfer_policy(store, listing_id, coin)`.

### What Tradeport actually wants
The `tradeport_listings::Store`'s dynamic_object_field is keyed by **NFT ID**,
not by SimpleListing ID. Passing the SimpleListing ID means Sui's
`dynamic_field::borrow_child_object` call inside the buy function finds no
entry and aborts with code `1` (`EFieldDoesNotExist`).

### Verification
A successful V1 buy (`FgMsKpeVcd…`) on 2026-04-04 passed the SuinsRegistration
NFT itself (type `…::suins_registration::SuinsRegistration`) as the
`listing_id` argument — not a SimpleListing. The `listing_id` parameter name
in the Move signature is misleading.

### Why the old v1↔v2 retry logic never helped
The builders had a `try { buildWithTx(…) } catch(MoveAbort) { retry v2 }`
block. But `buildWithTx` only calls `tx.build()`, which never simulates
on-chain — MoveAborts happen at execution time on the validator, long after
`build()` returns. The retry was dead code.

`buildTradeportPurchaseTx` also had a `Promise.any` race of v1 and v2 builds.
Both `build()` calls always succeed regardless of which version the listing
actually lives on, so the winner was arbitrary.

---

## Bug 2 — OB (order-book) listings need a different buy function

After fixing bug 1, `crowd.sui` produced a new abort:

```
MoveAbort in 3rd command, abort code: 4, in '…::tradeport_listings::
buy_ob_listing_without_transfer_policy' (instruction 52)
```

Tradeport has two V1 listing variants: **regular** (created via
`create_listing_without_transfer_policy`) and **OB** (order-book, created via
`create_ob_listing_without_transfer_policy`). They share the same
`SimpleListing` struct but OB listings are also registered in a separate
`tradeport_orderbook::Store` and must be bought via
`buy_ob_listing_without_transfer_policy(listings_store, orderbook_store, nft_id, coin)`.

Calling the non-OB buy on an OB listing aborts inside the buy function.

`crowd.sui` was listed via `create_ob_listing_without_transfer_policy` — tx
digest `9sP2vABdKkBs2jqTX13LkARWHJS4XY27ho1EXm9wbmv9`, on the upgraded
package `0xc99caf…` which the original V1 package `0xff22…` doesn't export.

### Detection
A new `resolveTradeportListing()` helper returns
`{ id: string, kind: 'v1' | 'v1ob' | 'v2' }`:

1. Walk the NFT owner chain to get the listing object ID.
2. Probe the listing's type:
   - starts with V2 pkg `0xb42d…` → `v2`
   - starts with V1 pkg `0xff22…` → check the orderbook Store for a dynamic
     field keyed by the SimpleListing ID
     - entry exists → `v1ob`
     - no entry → `v1` (regular)
3. Anything else → `null` (unsupported).

A new `addTradeportBuyCall(tx, kind, listingId, nftTokenId, payment)` helper
emits the correct Move call per kind, including the extra orderbook Store
argument for OB buys.

---

## Bug 3 — The 3% buyer fee

After OB routing was fixed, the tx still aborted with code `4`
(`EInsufficientPayment`) inside the buy function.

The old code had a stale comment: *"Tradeport buy expects EXACTLY the listing
price — commission is deducted from seller's portion"*. That is **false**.

Verified from on-chain `BuySimpleListingEvent` payloads:

| Listing | Event price | Buyer split | Ratio |
|--------|-------------|-------------|-------|
| `FgMsKpeVcd…` (V1 regular) | 4.850 SUI | 4.9955 SUI | ×1.03 |
| `GC1jrhWy2U…` (V1 OB)      | 170.000 SUI | 175.100 SUI | ×1.03 |

The Store carries `fee_bps: 300` → **3% is added on top of the listing
price, paid by the buyer**. Splitting exactly the listing price is 3% short
and the buy function aborts.

All three builders now split
```ts
(listingPrice * 10300n) / 10000n
```
for Tradeport purchases. Kiosk purchases are untouched because kiosks handle
royalties through `TransferPolicy` inside the purchase call.

For `crowd.sui` at 4 SUI, the split is now 4.12 SUI — matches the UI toast.

---

## Other fixes in the same change

### V1 Store `initialSharedVersion`
The hardcoded `3377344` was actually the V2 Store's ISV. The V1 Store's
real ISV is `670935706` (verified via on-chain successful tx inputs). Sui's
validator was lenient enough that the wrong ISV alone didn't cause the
observed aborts, but the values are now correct on both V1 and V2 paths.

### UI RPC resilience
The pre-purchase balance fetch in `ui.ts` fired four `fetch()` calls in
parallel against `https://sui-rpc.publicnode.com`. When publicnode
rate-limited, the response parsed to `totalBalance: '0'`, the UI saw
`suiBal = 0`, computed a full-price shortfall, and routed the buy into the
iUSD PSM burn path — which then failed with *"PSM reserve too small: need
$3.99 more USDC"* even though the user had 44 SUI on hand.

Fix: the four RPC calls now race across publicnode + blockvision + ankr
(`Promise.any` across endpoints per call). If *all three* fail the user
sees an explicit *"RPC unavailable — try again in a moment"* toast instead
of being silently shunted into the iUSD branch.

### Treasury-agents parity
The same buy-key bug, OB-listing gap, and 3%-fee bug existed in
`src/server/agents/treasury-agents.ts`. The server-side infer flow was
updated in lockstep so keeper-pre-funded buys route correctly too.

### Post-purchase UI restoration
- `ski:ns-label` is persisted on successful trade so a hard refresh lands
  back on the card the user just bought (previously the input could go
  blank or snap to the wallet primary).
- The `finally` block in the trade handler was pinning the button label to
  `TRADE`. Now it calls `_updateSendBtnMode()` so the button reflects the
  post-trade state — `nsAvail === 'owned'` flips it to `SUIAMI`.

---

## Files changed

- `src/suins.ts` — `resolveTradeportListing`, `addTradeportBuyCall`,
  `buildTradeportPurchaseTx`, `buildSwapAndPurchaseTx`,
  `buildIusdBurnAndPurchaseTx`; removed dead v1↔v2 retry and race logic.
- `src/server/agents/treasury-agents.ts` — OB-aware listing resolver,
  kind-aware buy call, 3% fee on payment split, collapsed v1/v2 retry loops.
- `src/ui.ts` — multi-endpoint RPC race in the buy pre-compute,
  `ski:ns-label` persistence post-trade, button re-evaluation after trade.

## How to verify

1. `bun run build && npx wrangler deploy`
2. Sign in at sui.ski with a wallet holding ≥ `price × 1.03 + 0.1` SUI.
3. Search an OB-listed .sui name, click **TRADE** → signature prompt shows
   the `buy_ob_listing_without_transfer_policy` call, tx executes,
   follow-up `post_trade_configure` runs and points the name at the buyer.
4. Hard refresh — card and input still show the purchased name in the
   `Owned` state, button says `SUIAMI`.
