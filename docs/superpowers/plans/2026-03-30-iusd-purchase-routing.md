# iUSD Purchase Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every SuiNS name registration routes through iUSD minting + multi-DEX swap to NS, giving users 25% discount while growing treasury collateral.

**Architecture:** User deposits SUI. Keeper attests collateral → mints 9-decimal iUSD (to itself) → swaps iUSD → USDC → NS via DEX liquidity (server-side) → sends NS to user. Surplus stays in treasury. User signs one PTB to register with NS. Cross-chain (Mayan/Kamino) deferred.

**Tech Stack:** Move (iUSD contract upgrade), `@aftermath-finance/sdk` (DEX aggregation), DeepBook v3 (iUSD/USDC pool), existing `@mysten/sui` + `@mysten/suins`

---

### Task 1: Upgrade iUSD Contract to 9 Decimals

**Files:**
- Modify: `contracts/iusd/sources/iusd.move:140` (decimals parameter)
- Modify: `contracts/iusd/Move.toml` (published-at for upgrade)

- [ ] **Step 1: Update decimals in create_currency**

In `contracts/iusd/sources/iusd.move`, change line 140:

```move
// Before:
        6, // decimals — matches USDC
// After:
        9, // decimals — 9 for sub-cent steganographic encoding
```

- [ ] **Step 2: Update Move.toml for upgrade**

```toml
[package]
name = "iusd"
edition = "2024.beta"
published-at = "0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }

[addresses]
iusd = "0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515"
```

- [ ] **Step 3: Build the contract**

Run: `cd contracts/iusd && sui move build`
Expected: Build succeeds

- [ ] **Step 4: Publish the upgrade**

Run: `sui client upgrade --gas-budget 100000000 --upgrade-capability 0x97f62ada10534f122f0a793eef9c3d9649cc82ea72e0265412ed0817df449c62`

Note the new package ID from the output — this becomes the new `IUSD_PKG`.

- [ ] **Step 5: Update IUSD_PKG in treasury-agents.ts**

In `src/server/agents/treasury-agents.ts`, update:

```typescript
private static readonly IUSD_PKG = '<NEW_PACKAGE_ID_FROM_UPGRADE>';
```

- [ ] **Step 6: Update mint amount calculations**

In `src/server/agents/treasury-agents.ts` `mintIusd`, update the comment to reflect 9 decimals. The `mintAmount` param is now in 9-decimal raw units (1 iUSD = 1_000_000_000).

- [ ] **Step 7: Commit**

```bash
git add contracts/iusd/ src/server/agents/treasury-agents.ts
git commit -m "feat: upgrade iUSD to 9 decimals for sub-cent steganographic encoding"
```

---

### Task 2: Add Steganographic Encoding Helper

**Files:**
- Modify: `src/suins.ts` (add helper near top, after constants)

- [ ] **Step 1: Add the IUSD_TYPE constant and encoding function**

In `src/suins.ts`, after line 33 (`const SWAP_FEE_BPS = 10;`), add:

```typescript
// ─── iUSD constants ───────────────────────────────────────────────────
const IUSD_PKG = '0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515'; // TODO: update after upgrade
const IUSD_TYPE = `${IUSD_PKG}::iusd::IUSD`;

/**
 * Encode a USD amount with steganographic sub-cent identifier.
 * iUSD has 9 decimals: the last 3 digits after cents carry a hidden ID.
 *
 * @param usdAmount - Dollar amount (e.g. 7.50)
 * @param signalId - Identifier to encode (truncated to 0-999)
 * @returns Raw 9-decimal iUSD amount as bigint
 */
function encodeIusdAmount(usdAmount: number, signalId: number): bigint {
  const cents = Math.round(usdAmount * 100);
  const tag = Math.abs(signalId) % 1000;
  return BigInt(cents) * 10_000_000n + BigInt(tag) * 10_000n;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/suins.ts
git commit -m "feat: add iUSD steganographic encoding helper"
```

---

### Task 3: Install Aftermath SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

Run: `bun add aftermath-ts-sdk`

Note: The npm package name is `aftermath-ts-sdk` (not `@aftermath-finance/sdk`).

- [ ] **Step 2: Verify it installed**

Run: `bun run build`
Expected: Build succeeds (SDK is tree-shaken, no import yet)

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat: add aftermath-ts-sdk for DEX aggregation"
```

---

### Task 4: Build Multi-DEX NS Quote Racing

**Files:**
- Modify: `src/suins.ts` (add `raceNsQuotes` function after `buildSwapTx`)

- [ ] **Step 1: Add the quote racing function**

In `src/suins.ts`, after the `buildSwapTx` function (around line 2461), add:

```typescript
// ─── Multi-DEX NS Quote Racing ────────────────────────────────────────

interface NsQuoteResult {
  source: 'aftermath' | 'deepbook';
  nsAmountOut: bigint;
  /** Compose this route's swap into an existing Transaction. Returns the NS Coin result. */
  compose: (tx: InstanceType<typeof Transaction>, usdcCoin: any) => any;
}

/**
 * Race Aftermath aggregator vs direct DeepBook for USDC → NS.
 * Returns the best quote with a compose function to add the swap to a PTB.
 */
async function raceNsQuotes(usdcAmount: bigint): Promise<NsQuoteResult> {
  const NS_TYPE = mainPackage.mainnet.coins.NS.type;
  const USDC_TYPE = mainPackage.mainnet.coins.USDC.type;

  // DeepBook direct: always available, known-good
  const deepbookQuote: NsQuoteResult = {
    source: 'deepbook',
    nsAmountOut: usdcAmount, // Approximate — DeepBook doesn't have a quote API, output depends on order book
    compose: (tx, usdcCoin) => {
      const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
      const [nsCoin, usdcChange, deepChange] = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
        typeArguments: [NS_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({ objectId: DB_NS_USDC_POOL, initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
          usdcCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
        ],
      });
      // Transfer change coins back
      tx.transferObjects([usdcChange, deepChange], tx.pure.address(tx.blockData?.sender ?? ''));
      return nsCoin;
    },
  };

  // Try Aftermath aggregator — it races 15+ DEXes internally
  try {
    const { Aftermath } = await import('aftermath-ts-sdk');
    const af = new Aftermath('MAINNET');
    await af.init();
    const router = af.Router();

    const route = await router.getCompleteTradeRouteGivenAmountIn({
      coinInAmount: usdcAmount,
      coinInType: USDC_TYPE,
      coinOutType: NS_TYPE,
    });

    if (route && route.coinOut?.amount) {
      const afQuote: NsQuoteResult = {
        source: 'aftermath',
        nsAmountOut: BigInt(route.coinOut.amount),
        compose: (tx, usdcCoin) => {
          // Aftermath composes directly into PTB
          const { coinOutId } = router.addTransactionForCompleteTradeRoute({
            tx,
            walletAddress: tx.blockData?.sender ?? '',
            completeRoute: route,
            slippage: 0.02, // 2%
            coinInId: usdcCoin,
          });
          return coinOutId;
        },
      };

      // Pick the better quote
      if (afQuote.nsAmountOut > deepbookQuote.nsAmountOut) {
        return afQuote;
      }
    }
  } catch {
    // Aftermath failed — fall back to DeepBook
  }

  return deepbookQuote;
}
```

- [ ] **Step 2: Verify build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/suins.ts
git commit -m "feat: multi-DEX NS quote racing — Aftermath vs DeepBook"
```

---

### Task 5: Build iUSD Purchase Registration PTB

**Files:**
- Modify: `src/suins.ts` (add `buildIusdPurchaseNsTx` function after `raceNsQuotes`)

This is the core PTB: iUSD → USDC (DeepBook) → NS (best DEX) → register name.

- [ ] **Step 1: Add the iUSD purchase PTB builder**

In `src/suins.ts`, after `raceNsQuotes`, add:

```typescript
/**
 * Build a PTB that swaps iUSD → USDC → NS → registers a SuiNS name.
 * Assumes keeper has already minted iUSD to the user's address.
 *
 * @param rawAddress - User's wallet address
 * @param domain - Domain to register (e.g. "myname.sui")
 * @param iusdAmount - Raw 9-decimal iUSD amount (from encodeIusdAmount)
 * @param setAsDefault - Whether to set as the user's default SuiNS name
 * @returns Built transaction bytes
 */
export async function buildIusdPurchaseNsTx(
  rawAddress: string,
  domain: string,
  iusdAmount: bigint,
  setAsDefault = false,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(rawAddress);
  const transport = gqlClient;
  const USDC_TYPE = mainPackage.mainnet.coins.USDC.type;
  const NS_TYPE = mainPackage.mainnet.coins.NS.type;

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Step 1: Collect user's iUSD coins
  const iusdCoins = await listCoinsOfType(transport, walletAddress, IUSD_TYPE);
  if (!iusdCoins.length) throw new Error('No iUSD found — keeper mint may not have completed');
  const iusdCoin = tx.objectRef(iusdCoins[0]);
  if (iusdCoins.length > 1) {
    tx.mergeCoins(iusdCoin, iusdCoins.slice(1).map(c => tx.objectRef(c)));
  }
  const [iusdForSwap] = tx.splitCoins(iusdCoin, [tx.pure.u64(iusdAmount)]);

  // Step 2: iUSD → USDC via DeepBook iUSD/USDC pool (1:1 stable pair)
  // Pool: iUSD is base, USDC is quote → swap_exact_base_for_quote
  const [zeroDEEP1] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
  const [iusdChange, usdcFromPool, deepChange1] = tx.moveCall({
    target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
    typeArguments: [IUSD_TYPE, USDC_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: DB_IUSD_USDC_POOL,
        initialSharedVersion: DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION,
        mutable: true,
      }),
      iusdForSwap, zeroDEEP1, tx.pure.u64(0), tx.object.clock(),
    ],
  });

  // Step 3: USDC → NS via best DEX route
  const quote = await raceNsQuotes(iusdAmount / 1000n); // Convert 9-decimal iUSD to 6-decimal USDC equivalent
  const nsCoin = quote.compose(tx, usdcFromPool);

  // Step 4: Register name with NS (25% discount)
  const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
  const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
    tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
  );

  const suinsTx = new SuinsTransaction(suinsClient, tx);
  const nft = suinsTx.register({
    domain,
    years: 1,
    coinConfig: mainPackage.mainnet.coins.NS,
    coin: nsCoin,
    priceInfoObjectId,
  });
  suinsTx.setTargetAddress({ nft, address: walletAddress });
  if (setAsDefault) suinsTx.setDefault(domain);
  tx.transferObjects([nft], tx.pure.address(walletAddress));

  // Return change coins
  tx.transferObjects([iusdChange, deepChange1, iusdCoin], tx.pure.address(walletAddress));

  // 5% of full price → iUSD treasury revenue
  const rawPrice = await suinsClient.calculatePrice({ name: domain, years: 1 });
  const basePriceUsd = rawPrice / 1e6;
  addRegistrationFee(tx, basePriceUsd, undefined);

  return buildWithTx(tx, transport);
}
```

- [ ] **Step 2: Add pool constants placeholder**

Near the DeepBook constants (around line 755), add:

```typescript
// DeepBook iUSD/USDC pool — created by TreasuryAgents keeper
const DB_IUSD_USDC_POOL = ''; // TODO: set after pool creation
const DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 0; // TODO: set after pool creation
```

- [ ] **Step 3: Export the function**

Verify `buildIusdPurchaseNsTx` is exported (the `export` keyword is already in the function declaration).

- [ ] **Step 4: Verify build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/suins.ts
git commit -m "feat: buildIusdPurchaseNsTx — iUSD → USDC → NS → register PTB"
```

---

### Task 6: Add Pool Creation + Market Making to TreasuryAgents

**Files:**
- Modify: `src/server/agents/treasury-agents.ts` (add pool creation and order management methods)

- [ ] **Step 1: Add pool creation method**

In `src/server/agents/treasury-agents.ts`, add to the TreasuryAgents class:

```typescript
  /** Create the iUSD/USDC DeepBook pool. Run once. */
  @callable()
  async createIusdUsdcPool(): Promise<{ poolId?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const IUSD_TYPE = `${TreasuryAgents.IUSD_PKG}::iusd::IUSD`;
      const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
      const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
      const DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

      const tx = new Transaction();
      tx.setSender(keeperAddr);

      // Create permissionless pool — requires DEEP token fee
      // tick_size: 1000 (0.001 granularity), lot_size: 1e9 (1.0 iUSD), min_size: 1e9
      tx.moveCall({
        package: DB_PACKAGE,
        module: 'pool',
        function: 'create_permissionless_pool',
        typeArguments: [IUSD_TYPE, USDC_TYPE],
        arguments: [
          tx.pure.u64(1000),        // tick_size
          tx.pure.u64(1_000_000_000), // lot_size (1.0 iUSD at 9 decimals)
          tx.pure.u64(1_000_000_000), // min_size
          tx.object('0x6'),          // clock
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);

      // TODO: Parse effects to extract pool object ID
      return { poolId: digest };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
```

- [ ] **Step 2: Add order seeding method**

```typescript
  /** Seed iUSD/USDC pool with 1:1 limit orders. Keeper must hold iUSD + USDC. */
  @callable()
  async seedIusdPool(params: {
    poolId: string;
    iusdAmount: string;  // 9-decimal raw
    usdcAmount: string;  // 6-decimal raw
  }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';

      const tx = new Transaction();
      tx.setSender(keeperAddr);

      // Step 1: Create BalanceManager
      const balanceManager = tx.moveCall({
        package: DB_PACKAGE,
        module: 'balance_manager',
        function: 'new',
      });

      // Step 2: Deposit iUSD into BalanceManager
      const [iusdPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]); // placeholder — need iUSD coins
      // TODO: Deposit actual iUSD and USDC coins into the BalanceManager
      // TODO: Place bid at 0.999 and ask at 1.001

      tx.moveCall({
        package: '0x2',
        module: 'transfer',
        function: 'share_object',
        typeArguments: [],
        arguments: [balanceManager],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      return { digest };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/treasury-agents.ts
git commit -m "feat: TreasuryAgents iUSD/USDC pool creation + seeding scaffolding"
```

---

### Task 7: Wire iUSD Purchase Route into UI

**Files:**
- Modify: `src/ui.ts` (add iUSD route option to registration flow)

- [ ] **Step 1: Add iUSD route to the registration handler**

In `src/ui.ts`, find the registration flow in the `wk-send-btn` click handler (around line 6524). After the existing mint/register logic, add an iUSD route option.

Find the section where `buildRegisterSplashNsTx` is called and add a pre-step that requests keeper mint:

```typescript
// Before calling buildRegisterSplashNsTx, try iUSD route:
// 1. Request keeper to attest collateral + mint iUSD
// 2. Build PTB: iUSD → USDC → NS → register
const tryIusdRoute = async (label: string, address: string, suiPrice: number): Promise<Uint8Array | null> => {
  try {
    // Calculate iUSD amount needed (domain price with steganographic tag)
    const { encodeIusdAmount, buildIusdPurchaseNsTx } = await import('./suins.js');
    const domainPrice = nsPriceUsd ?? 10; // USD price of domain
    const discountedPrice = domainPrice * 0.75; // 25% NS discount
    const signalId = Date.now() % 1000; // Simple timestamp-based tag
    const iusdRaw = encodeIusdAmount(discountedPrice * 1.02, signalId); // 2% buffer

    // Ask keeper to mint iUSD
    const mintRes = await fetch('/agents/treasury', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mintIusd',
        params: {
          recipient: address,
          collateralValueMist: String(BigInt(Math.floor((discountedPrice / suiPrice) * 1e9))),
          mintAmount: String(iusdRaw),
        },
      }),
    });
    const mintData = await mintRes.json() as any;
    if (mintData.error) return null;

    // Wait briefly for mint to finalize
    await new Promise(r => setTimeout(r, 2000));

    // Build the purchase PTB
    return buildIusdPurchaseNsTx(address, `${label}.sui`, iusdRaw, true);
  } catch {
    return null;
  }
};
```

- [ ] **Step 2: Integrate into existing flow**

The iUSD route should be attempted first when the user clicks MINT. If it fails (no keeper, insufficient collateral), fall through to the existing `buildRegisterSplashNsTx` flow.

- [ ] **Step 3: Build and deploy**

Run: `bun run build && npx wrangler deploy`

- [ ] **Step 4: Commit**

```bash
git add src/ui.ts
git commit -m "feat: wire iUSD purchase route into registration flow"
```

---

### Task 8: Export encodeIusdAmount

**Files:**
- Modify: `src/suins.ts` (export the function)

- [ ] **Step 1: Add export keyword**

Change `function encodeIusdAmount` to `export function encodeIusdAmount` in `src/suins.ts`.

- [ ] **Step 2: Add to the import in suins.ts exports**

Verify `encodeIusdAmount` and `buildIusdPurchaseNsTx` are in the export list used by `src/ui.ts` (line 43 import statement).

- [ ] **Step 3: Build and verify**

Run: `bun run build`

- [ ] **Step 4: Commit**

```bash
git add src/suins.ts
git commit -m "feat: export encodeIusdAmount + buildIusdPurchaseNsTx"
```

---

### Task 9: Build, Deploy, and Verify

**Files:**
- No new files

- [ ] **Step 1: Full build**

Run: `bun run build`
Expected: No errors

- [ ] **Step 2: Deploy**

Run: `npx wrangler deploy`
Expected: Successful deployment

- [ ] **Step 3: Commit final state**

```bash
git add -A
git commit -m "feat: iUSD purchase routing — mint iUSD, swap to NS, register with 25% discount"
```
