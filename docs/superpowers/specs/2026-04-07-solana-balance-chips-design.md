# Solana Balance Chips + Batch Roster Rumble

**Date:** 2026-04-07
**Status:** Draft

## Part 1: Solana Balance Chips via Helius

### Problem

SOL balance is fetched via `getBalance` on public RPCs (native SOL only) and folded into the total USD with a CoinGecko price. It never appears as its own chip in the coin dropdown. SPL token holdings (USDC, xStocks) on the IKA dWallet Solana address are invisible.

### Solution

Show curated Solana token holdings as individual chips in the coin dropdown, using the Helius Wallet Balances API for both balances and USD pricing in a single call. No magic numbers — all prices come from Helius.

### Server: Proxy Route

Add `GET /api/sol-balances?address={base58}` to `src/server/index.ts`.

- Reads `HELIUS_API_KEY` from env
- Calls `GET https://api.helius.xyz/v1/wallet/{address}/balances?api-key={key}`
- Filters response through the curated allowlist (by mint address)
- Returns filtered balances + USD values to the browser
- If no `HELIUS_API_KEY`, returns 503

Response shape:
```ts
interface SolBalanceResponse {
  tokens: Array<{
    symbol: string;       // "SOL", "USDC", "TSLAx"
    balance: number;      // human-readable (already decimal-adjusted)
    usdValue: number;     // total USD value of holding
    pricePerToken: number; // per-unit USD price from Helius
    mint: string;         // mint address (empty string for native SOL)
    isStable: boolean;
  }>;
}
```

### Curated Allowlist

Only these Solana assets pass the filter. Keyed by mint address for SPL tokens, or `"native"` for SOL.

```ts
const SOL_ALLOWLIST: Record<string, { symbol: string; isStable: boolean }> = {
  'native':                                          { symbol: 'SOL',   isStable: false },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':  { symbol: 'USDC',  isStable: true },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':   { symbol: 'USDT',  isStable: true },
};
// xStock RWA mints added here as they're acquired (TSLAx, NVDAx, METAx)
```

New xStock mints get added to this map when acquired. No code change beyond adding the mint address.

### Browser: Fetch + Integrate

Replace `_fetchSolBalance()` in `src/ui.ts`:

1. Call `GET /api/sol-balances?address={app.solAddress}`
2. For each returned token:
   - Native SOL -> set `app.solBalance` (existing field)
   - Stables -> add USD value to `app.stableUsd`
   - All tokens -> push into `walletCoins` with `chain: 'sol'`
3. Chips render automatically via existing coin chip builder

### WalletCoin Extension

```ts
interface WalletCoin {
  symbol: string;
  balance: number;
  coinType: string;  // Sui coinType or Solana mint address
  isStable: boolean;
  chain?: 'sui' | 'sol';  // defaults to 'sui' if omitted
}
```

### Chip Icons

- SOL: existing `SOL_ICON_SVG` (already defined in ui.ts)
- USDC-SPL: same green `$` stable icon (grouped with Sui USDC)
- xStocks: letter-circle default icon

### Price Accuracy

- All prices from Helius `pricePerToken` — zero hardcoded defaults
- Helius prices have ~10min staleness (top 10k tokens by volume)
- If Helius returns `null` price for a token, exclude it from chips
- `app.solBalance` still set for native SOL so existing idle card / cache panel code works

### Stables Aggregation

Solana USDC/USDT add to the same `stableUsd` total and green `$` chip. Tooltip distinguishes chain origin: "310.96 USDC (Sui) + 50.00 USDC (Sol)".

### Error Handling

- `/api/sol-balances` fails -> fall back to current `getBalance` for native SOL only
- Non-blocking — failure doesn't affect Sui portfolio

---

## Part 2: Batch Roster Rumble

### Problem

`maybeAppendRoster` in `src/suins.ts` sets chain addresses for ONE name (the default SuiNS name) by piggybacking on existing PTBs. If a wallet owns 20 names, only the default has sol@/eth@/btc@ set. The other 19 are unreachable cross-chain.

### Solution

A "Rumble your squids" batch action that:
1. Builds a single PTB calling `set_identity` for every owned SuiNS name
2. Publishes a Walrus attestation blob as a permanent verifiable proof of the full mapping
3. All names get the same chain addresses (derived from the same IKA dWallet)

### Batch PTB Design

One transaction, N `set_identity` calls. Each call costs ~minimal gas since the Roster is a shared object and we're just writing dynamic fields.

```ts
export function buildBatchRosterTx(
  address: string,
  names: string[],                    // bare names, no .sui
  chains: { btc?: string; eth?: string; sol?: string },
): Transaction {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(address));

  const chainKeys = ['sui', ...Object.keys(chains).filter(k => chains[k as keyof typeof chains])];
  const chainVals = [address, ...chainKeys.slice(1).map(k => chains[k as keyof typeof chains]!)];

  for (const bare of names) {
    const nh = Array.from(keccak_256(new TextEncoder().encode(bare.toLowerCase())));
    tx.moveCall({
      package: ROSTER_PKG,
      module: 'roster',
      function: 'set_identity',
      arguments: [
        tx.object(ROSTER_OBJ),
        tx.pure.string(bare),
        tx.pure.vector('u8', nh),
        tx.pure.vector('string', chainKeys),
        tx.pure.vector('string', chainVals),
        tx.pure.vector('address', []), // dwallet_caps — TODO: populate from IKA state
        tx.object('0x6'),
      ],
    });
  }

  return tx;
}
```

PTB max commands is 1024 — each `set_identity` is one MoveCall, so we can batch up to ~1000 names per tx. Well above any realistic roster size.

### Walrus Attestation

After the batch tx succeeds, publish a signed SUIAMI attestation blob to Walrus. This serves as:
- Permanent off-chain proof of the full name-to-address mapping
- Verifiable by anyone with the blob ID
- Cheaper than N on-chain reads for third-party resolvers

```ts
interface SuiamiAttestation {
  type: 'batch-rumble';
  owner: string;            // Sui address
  names: string[];           // all names that were set
  chains: Record<string, string>; // { sui, btc, eth, sol }
  digest: string;            // on-chain tx digest (proof the roster was written)
  ts: number;                // timestamp
}
```

Published via `PUT https://publisher.walrus.site/v1/store` — same pattern as the existing pre-rumble attestation in treasury-agents.ts:4412.

The blob ID gets:
- Stored in localStorage per-address (`ski:roster-attestation:{address}`)
- Optionally displayed in the cache panel as a "SUIAMI proof" link

### Which Names Get Batch-Set

Filter `nsOwnedDomains` to only NFTs (not SubnameCaps):
```ts
const eligible = nsOwnedDomains
  .filter(d => d.kind === 'nft' && !d.inKiosk)
  .map(d => d.name.replace(/\.sui$/, ''));
```

Names in kiosks (listed for sale) are excluded — the wallet doesn't own them for roster purposes.

### UI: Where the Button Lives

The Rumble button already exists in the idle overlay footer. The batch roster action triggers when:
1. User has IKA dWallet addresses (btc/eth/sol populated)
2. User owns > 1 SuiNS name
3. Not all names are already roster-synced

The button text shifts from "Rumble" to "Rumble N squids" when batch is available. Clicking builds the batch PTB, signs via the connected wallet, submits, then publishes the Walrus attestation.

### Skip Logic

Track which names are already roster-synced to avoid redundant writes:
```ts
// localStorage: ski:roster-batch:{address} = JSON.stringify(["name1","name2",...])
```
Compare against current `nsOwnedDomains`. Only include names not in the synced set. If all names are synced, the batch button is hidden or shows a checkmark.

After successful tx, update the synced set and mark `ski:roster-attestation:{address}` with the new blob ID.

### Error Handling

- If batch tx fails: show toast with error, don't update synced set
- If Walrus attestation fails: non-blocking, log warning, on-chain roster is still the source of truth
- If user has no IKA dWallet: batch button hidden (nothing to set)

---

## Files to Modify

### Part 1 (Solana Balance Chips)
1. **`src/server/index.ts`** — Add `/api/sol-balances` route
2. **`src/ui.ts`** — Replace `_fetchSolBalance()`, extend `WalletCoin`, update chip builder for `chain: 'sol'`

### Part 2 (Batch Roster Rumble)
3. **`src/suins.ts`** — Add `buildBatchRosterTx()` function
4. **`src/ui.ts`** — Wire batch roster to Rumble button, add skip logic, Walrus attestation post-tx

## Not in Scope

- Solana NFTs or arbitrary SPL tokens
- Helius SDK npm dependency (raw fetch for one endpoint)
- ETH/BTC balance chips (future work)
- Per-name dWallet differentiation (all names share the same IKA dWallet for now)
