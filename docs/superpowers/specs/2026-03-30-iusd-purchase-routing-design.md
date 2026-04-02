# iUSD Purchase Routing — Design Spec

## Overview

Every SuiNS name purchase through SKI mints iUSD (growing treasury collateral) and routes through DEX liquidity to acquire NS tokens for registration at 25% discount. Multi-DEX aggregation races Bluefin, Aftermath, Cetus, and DeepBook for best execution. Cross-chain collateral flows via Mayan (Solana↔Sui) and yield via Kamino (Solana lending/LP).

## Architecture

```
User deposits collateral (SUI / SOL via Mayan / ETH via IKA)
        ↓
Keeper attests collateral → mints iUSD (9 decimals, sub-cent steganography)
        ↓
iUSD → USDC (DeepBook pool, 1:1 stable pair)
        ↓
USDC → NS (race: DeepBook vs Bluefin vs Aftermath vs Cetus)
        ↓
NS → register name (25% discount)
```

Single user signature. Keeper does collateral attestation + iUSD mint server-side. User PTB handles the swap chain + registration.

## Component 1: iUSD/USDC DeepBook Pool

**Why DeepBook:** Stable 1:1 pair, trivial market making, composable in PTBs, existing infra.

**Pool parameters:**
- Base: iUSD (9 decimals)
- Quote: USDC (6 decimals)
- tick_size: 1000 (0.001 price granularity — tight for a stable pair)
- lot_size: 1_000_000_000 (1.0 iUSD minimum)
- min_size: 1_000_000_000 (1.0 iUSD minimum)
- stable: true

**Creation:** Permissionless via `pool::create_permissionless_pool<IUSD, USDC>` (requires DEEP tokens for fee).

**Liquidity seeding:** Keeper creates a BalanceManager, deposits iUSD + USDC, places limit orders:
- Bid: $0.999 (buy iUSD)
- Ask: $1.001 (sell iUSD)
- Depth: Scale with treasury size, start with $1k each side

**Keeper maintenance:** DO Alarm refreshes orders every epoch. Rebalances when fills accumulate.

## Component 2: Multi-DEX Route Racing

For the USDC → NS leg, race multiple DEXes for best output:

| DEX | Method | Package |
|-----|--------|---------|
| DeepBook v3 | `swap_exact_quote_for_base` on NS/USDC pool | Existing `DB_PACKAGE` |
| Bluefin | Aggregator API `GET /v2/quote` | `@bluefin` |
| Aftermath | `router.getCompleteTradeRouteGivenAmountIn()` | `@aftermath-finance/sdk` |
| Cetus | Router swap (if NS/SUI or NS/USDC pool exists) | Existing `CETUS_ROUTER` |

**Racing strategy:**
1. Fire all quote requests in parallel (`Promise.allSettled`)
2. Compare output NS amounts
3. Pick the best, compose into PTB
4. Fallback chain: if winner fails at build time, try next best

**Aftermath is the strongest candidate** — it already aggregates across DeepBook, Bluefin, Cetus, FlowX, Kriya, Turbos, and 10+ others. Its `addTransactionForCompleteTradeRoute` composes directly into a PTB. Racing Aftermath against direct DeepBook gives us aggregator coverage plus a known-good direct path.

**Recommended approach:** Use Aftermath as primary router (it races internally), fall back to direct DeepBook NS/USDC pool if Aftermath SDK fails to load or returns worse.

## Component 3: iUSD 9-Decimal Steganography

Upgrade iUSD from 6 to 9 decimals. The last 3 digits after cents encode transaction metadata:

```
$10.000003141  ← 3141 = truncated signal/order ID
     ^^^^^^
     visible    ^^^^
     amount     hidden identifier
```

**Encoding:** `amount_mist = usd_cents * 1000 + (signal_id % 1000)`

**Purpose:** Links iUSD mints to specific purchases on-chain without metadata. Scanner with lookup table can trace provenance; everyone else sees a normal dollar amount.

**Contract change:** New iUSD package version with `decimals: 9` in `create_currency`. Requires contract upgrade via UpgradeCap. Existing 6-decimal iUSD balances scale by 1000x on migration.

## Component 4: Cross-Chain Collateral via Mayan

SOL/ETH holders can purchase names using cross-chain collateral:

**SOL → Sui flow:**
1. `@mayanfinance/swap-sdk` `fetchQuote({ fromChain: 'solana', toChain: 'sui', fromToken: SOL, toToken: USDC })`
2. `swapFromSolana()` — user signs Solana tx, Mayan bridges to Sui
3. USDC arrives on Sui → keeper attests as collateral → mints iUSD
4. iUSD → USDC → NS → register (same PTB as native flow)

**ETH → Sui flow:** Same pattern with `swapFromEvm()`.

**Referrer fees:** Mayan supports 5-100 bps referrer. Set to iUSD treasury address.

## Component 5: Kamino Yield on Solana Collateral

Treasury SOL held in IKA ed25519 dWallet earns yield via Kamino:

- **Klend:** Deposit SOL as lending collateral (4-7% APY)
- **Kliquidity:** SOL/USDC LP vault with auto-rebalancing (higher yield, more risk)
- **TSLAx/NVDAx:** Hold in Kamino vaults if supported, else raw custody

Keeper manages Kamino positions server-side via `@kamino-finance/klend-sdk`. Yield compounds into collateral value, increasing iUSD mint capacity.

## Component 6: Purchase PTB Flow

### Native SUI purchase (single sign):

```
Keeper (server-side, before user PTB):
  1. update_collateral(treasury, "SUI", "sui", 0x0, value_mist, SENIOR, clock)
  2. mint_and_transfer(treasury_cap, treasury, iusd_amount, user_address)

User PTB (single signature):
  3. iUSD → USDC (DeepBook iUSD/USDC pool, swap_exact_base_for_quote)
  4. USDC → NS (Aftermath router or DeepBook NS/USDC pool)
  5. register(suins, domain, years=1, coinConfig=NS, coin=ns_coin, priceInfoObjectId)
  6. setTargetAddress(nft, user_address)
  7. setDefault(domain)
  8. transferObjects([nft], user_address)
```

### Cross-chain SOL purchase (two signs — one Solana, one Sui):

```
Solana sign:
  1. Mayan swapFromSolana(SOL → USDC on Sui)

(wait for bridge completion)

Keeper:
  2. Detect USDC arrival, attest collateral, mint iUSD to user

Sui sign:
  3. Same PTB as native flow (steps 3-8)
```

## Security

- **Keeper-only minting:** TreasuryCap + minter check. No permissionless mint.
- **150% collateral ratio:** Enforced on-chain in `mint()`. Cannot mint undercollateralized.
- **Senior coverage:** Senior tranche alone ≥ 100% of supply (peg floor).
- **Slippage protection:** 2% (200 bps) on all DEX swaps.
- **Race isolation:** Quote failures don't block — `Promise.allSettled` with fallback chain.
- **Steganography:** Encoding is one-way identification, not encryption. No security dependency on obscurity.
- **Cross-chain:** Mayan handles bridge security (Wormhole-based). IKA handles custody (2PC-MPC).

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@aftermath-finance/sdk` | latest | DEX aggregation + PTB composition |
| `@mayanfinance/swap-sdk` | latest | SOL/ETH → Sui cross-chain swaps |
| `@kamino-finance/klend-sdk` | latest | Solana yield management |
| `@mysten/sui` | ^2.5.0 | Existing |
| `@mysten/suins` | ^1.0.2 | Existing |

## File Changes

| File | Change |
|------|--------|
| `contracts/iusd/sources/iusd.move` | Upgrade decimals 6 → 9 |
| `src/suins.ts` | New `buildIusdPurchaseNsTx()` PTB builder |
| `src/suins.ts` | New `raceNsQuotes()` multi-DEX aggregation |
| `src/server/agents/treasury-agents.ts` | iUSD/USDC pool creation + order management |
| `src/server/agents/treasury-agents.ts` | Kamino position management |
| `src/client/mayan.ts` | New — cross-chain swap initiation |
| `src/ui.ts` | Wire purchase flow to use iUSD route |
