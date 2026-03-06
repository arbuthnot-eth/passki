/**
 * ShadeExecutorAgent — Durable Object that auto-executes Shade orders.
 *
 * One DO instance per owner address (keyed by the user's Sui address).
 *
 * Flow:
 *   1. User creates a Shade order on-chain (client-side signing).
 *   2. Client calls schedule() to register the order with this DO.
 *   3. DO sets a Durable Object Alarm for the grace expiry timestamp.
 *   4. When alarm fires, DO builds the execute+register PTB, signs with
 *      a keeper keypair (Worker secret), and submits to Sui.
 *   5. Domain is registered and NFT transferred to the user's target address.
 *
 * The keeper keypair pays gas (~0.01 SUI per execution). The shade order's
 * escrowed deposit covers the SuiNS registration cost. Any excess deposit
 * is sent back to the user.
 */

import { Agent, callable } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SuinsClient, SuinsTransaction, mainPackage } from '@mysten/suins';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const FULLNODE_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];
const SHADE_PACKAGE = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';

// DeepBook v3 — swap pools for NS registration discount
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_NS_SUI_POOL = '0x27c4fdb3b846aa3ae4a65ef5127a309aa3c1f466671471a806d8912a18b253e8';
const DB_NS_SUI_POOL_ISV = 414947421;
const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
const DB_SUI_USDC_POOL_ISV = 389750322;
const DB_NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060';
const DB_NS_USDC_POOL_ISV = 414947421;
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const NS_PYTH_PRICE_INFO = '0xc6352e1ea55d7b5acc3ed690cc3cdf8007978071d7bfd6a189445018cfb366e0';
const NS_PYTH_PRICE_INFO_ISV = 417086474;

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000]; // aggressive first retry, then back off

// ─── Types ──────────────────────────────────────────────────────────────

export type ShadeRoute = 'sui-ns' | 'sui-usdc-ns';

export interface ShadeExecutorOrder {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string; // hex-encoded
  ownerAddress: string;
  depositMist: string; // serialized bigint
  preferredRoute?: ShadeRoute; // decided at creation time based on user balance
  status: 'pending' | 'executing' | 'completed' | 'failed';
  retries: number;
  createdAt: number;
  executedAt?: number;
  digest?: string;
  error?: string;
}

export interface ShadeExecutorState {
  orders: ShadeExecutorOrder[];
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class ShadeExecutorAgent extends Agent<Env, ShadeExecutorState> {
  initialState: ShadeExecutorState = {
    orders: [],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The Agent base class sets `this.alarm` as an instance property in its
    // constructor (for its cf_agents_schedules system), which shadows any
    // prototype alarm() method.  Chain our shade alarm after the agent's.
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._shadeAlarm();
    };
  }

  // Handle HTTP requests (poke/status) — called by cron trigger or manual API
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/poke') || url.searchParams.has('poke')) {
      const result = await this.poke();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      return new Response(JSON.stringify({ orders: this.state.orders }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if ((url.pathname.endsWith('/schedule') || url.searchParams.has('schedule')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.schedule>[0];
        const result = await this.schedule(params);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if (url.pathname.endsWith('/reset-failed') || url.searchParams.has('reset-failed')) {
      try {
        const params = request.method === 'POST' ? await request.json() as { objectId?: string } : undefined;
        const result = await this.resetFailed(params);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if ((url.pathname.endsWith('/cancel') || url.searchParams.has('cancel')) && request.method === 'POST') {
      try {
        const params = await request.json() as { objectId: string };
        const result = await this.cancel(params);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if ((url.pathname.endsWith('/reap-cancelled') || url.searchParams.has('reap-cancelled')) && request.method === 'POST') {
      try {
        const params = await request.json() as { objectId: string };
        const result = await this.reapCancelled(params);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return super.onRequest(request);
  }

  // ─── Schedule an order for auto-execution ───────────────────────────

  @callable()
  async schedule(params: {
    objectId: string;
    domain: string;
    executeAfterMs: number;
    targetAddress: string;
    salt: string;
    ownerAddress: string;
    depositMist: string;
    preferredRoute?: ShadeRoute;
  }): Promise<{ success: boolean; error?: string }> {
    // Idempotent — skip if this exact objectId is already tracked
    if (this.state.orders.some(o => o.objectId === params.objectId)) {
      return { success: true };
    }

    // Prevent duplicates — only one active order per domain per address
    const existingActive = this.state.orders.find(
      o => o.domain === params.domain
        && (o.status === 'pending' || o.status === 'executing'),
    );
    if (existingActive) {
      return {
        success: false,
        error: `Active order already exists for ${params.domain} (${existingActive.objectId})`,
      };
    }

    // Prune completed/failed orders for this domain (allow retry with new order)
    const pruned = this.state.orders.filter(
      o => !(o.domain === params.domain && (o.status === 'completed' || o.status === 'failed')),
    );

    const order: ShadeExecutorOrder = {
      ...params,
      status: 'pending',
      retries: 0,
      createdAt: Date.now(),
    };

    this.setState({ orders: [...pruned, order] });
    this.scheduleNextAlarm();
    return { success: true };
  }

  // ─── Cancel a scheduled order ───────────────────────────────────────

  @callable()
  async cancel(params: { objectId: string }): Promise<{ success: boolean }> {
    // Special: "all" purges every order
    if (params.objectId === 'all') {
      this.setState({ orders: [] });
      return { success: true };
    }
    this.setState({
      orders: this.state.orders.filter(o => o.objectId !== params.objectId),
    });
    this.scheduleNextAlarm();
    return { success: true };
  }

  // ─── Cleanup cancelled on-chain orders (keeper-signed delete) ───────

  @callable()
  async reapCancelled(params: { objectId: string }): Promise<{ success: boolean; digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { success: false, error: 'No keeper private key configured (set SHADE_KEEPER_PRIVATE_KEY secret)' };
    }
    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddress = keypair.toSuiAddress();

      const tx = new Transaction();
      tx.setSender(keeperAddress);
      tx.moveCall({
        target: `${SHADE_PACKAGE}::shade::reap_cancelled`,
        arguments: [tx.object(params.objectId)],
      });

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this.submitTransaction(txBytes, signature);

      // Keep DO state consistent if this order was tracked here.
      this.setState({
        orders: this.state.orders.filter(o => o.objectId !== params.objectId),
      });
      this.scheduleNextAlarm();

      return { success: true, digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ─── Query orders ───────────────────────────────────────────────────

  @callable()
  async getOrders(): Promise<{ orders: ShadeExecutorOrder[] }> {
    return { orders: this.state.orders };
  }

  @callable()
  async getStatus(params: { objectId: string }): Promise<ShadeExecutorOrder | null> {
    return this.state.orders.find(o => o.objectId === params.objectId) ?? null;
  }

  // ─── Reset failed orders so they can retry ────────────────────────

  @callable()
  async resetFailed(params?: { objectId?: string; force?: boolean }): Promise<{ reset: number }> {
    let count = 0;
    this.setState({
      orders: this.state.orders.map(o => {
        // Reset failed orders, or force-reset executing/stuck orders
        if (o.status !== 'failed' && !(params?.force && o.status === 'executing')) return o;
        if (params?.objectId && o.objectId !== params.objectId) return o;
        count++;
        return { ...o, status: 'pending' as const, retries: 0, error: undefined };
      }),
    });
    if (count > 0) this.scheduleNextAlarm();
    console.log(`[ShadeExecutor] resetFailed: reset ${count} order(s) (force=${!!params?.force})`);
    return { reset: count };
  }

  // ─── Poke — external trigger to re-check and re-schedule ──────────

  @callable()
  async poke(): Promise<{ pending: number; nextAlarmMs: number | null; orders: Array<{ domain: string; status: string; executeAfterMs: number; retries: number; error?: string }> }> {
    const pending = this.state.orders.filter(o => o.status === 'pending');
    const nextAlarmMs = pending.length > 0
      ? Math.max(pending.sort((a, b) => a.executeAfterMs - b.executeAfterMs)[0].executeAfterMs, Date.now() + 1000)
      : null;
    this.scheduleNextAlarm();
    return {
      pending: pending.length,
      nextAlarmMs,
      orders: this.state.orders.map(o => ({
        domain: o.domain,
        status: o.status,
        executeAfterMs: o.executeAfterMs,
        retries: o.retries,
        ...(o.error ? { error: o.error } : {}),
      })),
    };
  }

  // ─── DO Alarm — fires at grace expiry ───────────────────────────────

  private async _shadeAlarm() {
    try {
      const now = Date.now();

      // Find orders ready to execute (grace period expired)
      const readyOrders = this.state.orders
        .filter(o => o.status === 'pending' && o.executeAfterMs <= now)
        .sort((a, b) => a.executeAfterMs - b.executeAfterMs);

      if (readyOrders.length === 0) {
        this.scheduleNextAlarm();
        return;
      }

      // Execute the earliest ready order
      await this.executeOrder(readyOrders[0]);
    } catch (err) {
      // Unexpected error — always reschedule so we don't lose track
      console.error('[ShadeExecutor] alarm() unexpected error:', err);
    } finally {
      // ALWAYS reschedule — never let a crash orphan pending orders
      this.scheduleNextAlarm();
    }
  }

  // ─── Core execution logic ──────────────────────────────────────────

  private async executeOrder(order: ShadeExecutorOrder) {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      this.updateOrder(order.objectId, {
        status: 'failed',
        error: 'No keeper private key configured (set SHADE_KEEPER_PRIVATE_KEY secret)',
      });
      return;
    }

    // Pre-flight: verify keeper has gas before building routes
    try {
      const gqlCheck = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const keypairCheck = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = keypairCheck.toSuiAddress();
      const balResult = await gqlCheck.query({
        query: `{ address(address: "${keeperAddr}") { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`,
      });
      const keeperBalance = BigInt((balResult.data as any)?.address?.balance?.totalBalance ?? '0');
      if (keeperBalance < 50_000_000n) { // need at least 0.05 SUI for gas
        const retries = (order.retries ?? 0) + 1;
        const msg = `Keeper has insufficient gas: ${keeperBalance} MIST (need ≥50M). Fund ${keeperAddr}`;
        console.warn(`[ShadeExecutor] ${msg}`);
        if (retries >= MAX_RETRIES) {
          this.updateOrder(order.objectId, { status: 'failed', error: msg, retries });
        } else {
          this.updateOrder(order.objectId, { status: 'pending', retries, error: `Retry ${retries}/${MAX_RETRIES}: ${msg}` });
          this.ctx.storage.setAlarm(Date.now() + RETRY_DELAYS_MS[retries - 1]);
        }
        return;
      }
      console.log(`[ShadeExecutor] Keeper gas OK: ${keeperBalance} MIST`);
    } catch (err) {
      console.warn('[ShadeExecutor] Gas check failed (proceeding anyway):', err);
    }

    // Resolve placeholder object ID by querying on-chain ShadeOrders for this owner
    if (order.objectId.startsWith('pending:')) {
      const realId = await this.resolveShadeOrderId(order);
      if (realId) {
        const oldId = order.objectId;
        order = { ...order, objectId: realId };
        // Update stored order with real ID
        this.setState({
          orders: this.state.orders.map(o =>
            o.objectId === oldId ? { ...o, objectId: realId } : o,
          ),
        });
      } else {
        this.updateOrder(order.objectId, {
          status: 'failed',
          error: 'Could not resolve on-chain ShadeOrder object ID',
        });
        return;
      }
    }

    this.updateOrder(order.objectId, { status: 'executing' });
    console.log(`[ShadeExecutor] Executing order ${order.objectId} for ${order.domain}.sui (deposit=${order.depositMist}, route=${order.preferredRoute ?? 'auto'})`);

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddress = keypair.toSuiAddress();

      const domainBytes = Array.from(new TextEncoder().encode(order.domain));
      const saltBytes = Array.from(hexToBytes(order.salt));
      const targetAddr = normalizeSuiAddress(order.targetAddress);
      const fullDomain = `${order.domain}.sui`;

      // Fetch NS-discounted price once — shared by all routes
      const [rawPrice, discountMap] = await Promise.all([
        suinsClient.calculatePrice({ name: fullDomain, years: 1 }),
        suinsClient.getCoinTypeDiscount(),
      ]);
      const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
      const discountPct = discountMap.get(nsKey) ?? 0;
      const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
      // 1.5% buffer + round up to nearest cent (covers DeepBook slippage)
      const usdcNeeded = BigInt(Math.ceil(discountedUsd * 1.015 * 100) * 10000);

      const buildArgs = [transport, suinsClient, keeperAddress, order, domainBytes, saltBytes, targetAddr, fullDomain, usdcNeeded] as const;

      // Build both routes in parallel — submit fastest, skip dry-runs for speed.
      // Route order decided at creation time based on user's balance:
      //   'sui-ns':      prefer SUI → NS (single-hop), then SUI → USDC → NS
      //   'sui-usdc-ns': prefer SUI → USDC → NS (two-hop), then SUI → NS
      console.log(`[ShadeExecutor] Building routes A+B (usdcNeeded=${usdcNeeded}, deposit=${order.depositMist})...`);
      const [routeA, routeB] = await Promise.allSettled([
        this.buildRouteA(...buildArgs),
        this.buildRouteB(...buildArgs),
      ]);

      const aErr = routeA.status === 'rejected' ? String(routeA.reason) : null;
      const bErr = routeB.status === 'rejected' ? String(routeB.reason) : null;
      if (aErr) console.warn('[ShadeExecutor] Route A build FAILED:', aErr);
      else console.log(`[ShadeExecutor] Route A build OK (${routeA.value.length} bytes)`);
      if (bErr) console.warn('[ShadeExecutor] Route B build FAILED:', bErr);
      else console.log(`[ShadeExecutor] Route B build OK (${routeB.value.length} bytes)`);
      const aResult = { name: `A (SUI→NS)`, bytes: routeA.status === 'fulfilled' ? routeA.value : null, err: aErr };
      const bResult = { name: `B (SUI→USDC→NS)`, bytes: routeB.status === 'fulfilled' ? routeB.value : null, err: bErr };

      const routes: Array<{ name: string; bytes: Uint8Array | null }> =
        order.preferredRoute === 'sui-usdc-ns'
          ? [bResult, aResult]
          : [aResult, bResult];

      let digest: string | null = null;
      const routeErrors: string[] = [];
      for (const route of routes) {
        if (!route.bytes) { routeErrors.push(`${route.name}: ${(route as any).err ?? 'build failed'}`); continue; }
        try {
          const { signature } = await keypair.signTransaction(route.bytes);
          digest = await this.submitTransaction(route.bytes, signature);
          console.log(`[ShadeExecutor] Route ${route.name} submitted OK: ${digest}`);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          routeErrors.push(`${route.name}: ${msg}`);
          console.warn(`[ShadeExecutor] Route ${route.name} submit FAILED:`, msg);
        }
      }

      // Last resort — direct SUI payment (no NS discount)
      if (!digest) {
        console.log(`[ShadeExecutor] All swap routes failed [${routeErrors.join(' | ')}], trying SUI direct fallback`);
        try {
          const fallbackBytes = await this.buildRouteFallback(transport, suinsClient, keeperAddress, order, domainBytes, saltBytes, targetAddr, fullDomain);
          console.log(`[ShadeExecutor] Fallback build OK (${fallbackBytes.length} bytes)`);
          const { signature } = await keypair.signTransaction(fallbackBytes);
          digest = await this.submitTransaction(fallbackBytes, signature);
          console.log(`[ShadeExecutor] Fallback (SUI direct) submitted OK: ${digest}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ShadeExecutor] Fallback FAILED: ${msg}`);
          throw new Error(`All routes failed — A+B: [${routeErrors.join(' | ')}] — Fallback: ${msg}`);
        }
      }

      this.updateOrder(order.objectId, {
        status: 'completed',
        digest,
        executedAt: Date.now(),
      });
    } catch (err) {
      const retries = (order.retries ?? 0) + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (retries >= MAX_RETRIES) {
        this.updateOrder(order.objectId, {
          status: 'failed',
          error: errorMsg,
          retries,
        });
      } else {
        const delay = RETRY_DELAYS_MS[retries - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        this.updateOrder(order.objectId, {
          status: 'pending',
          retries,
          error: `Retry ${retries}/${MAX_RETRIES}: ${errorMsg}`,
        });
        this.ctx.storage.setAlarm(Date.now() + delay);
      }
    }
  }

  // ─── Shared: shade::execute preamble ────────────────────────────────

  private shadeExecute(
    tx: Transaction,
    order: ShadeExecutorOrder,
    domainBytes: number[],
    saltBytes: number[],
    targetAddr: string,
  ) {
    return tx.moveCall({
      target: `${SHADE_PACKAGE}::shade::execute`,
      arguments: [
        tx.object(order.objectId),
        tx.pure.vector('u8', domainBytes),
        tx.pure.u64(order.executeAfterMs),
        tx.pure.address(targetAddr),
        tx.pure.vector('u8', saltBytes),
        tx.object.clock(),
      ],
    });
  }

  // ─── Shared: NS Pyth price info (hardcoded ref, no RPC) ───────────

  private nsPriceInfoRef(tx: Transaction) {
    return tx.sharedObjectRef({
      objectId: NS_PYTH_PRICE_INFO,
      initialSharedVersion: NS_PYTH_PRICE_INFO_ISV,
      mutable: false,
    });
  }

  // ─── Shared: register with NS + transfer NFT to user ─────────────

  private registerWithNs(
    tx: Transaction,
    suinsClient: InstanceType<typeof SuinsClient>,
    fullDomain: string,
    nsCoin: ReturnType<Transaction['moveCall']>[0],
    priceInfoObjectId: ReturnType<Transaction['sharedObjectRef']>,
    targetAddr: string,
  ) {
    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({
      domain: fullDomain,
      years: 1,
      coinConfig: mainPackage.mainnet.coins.NS,
      coin: nsCoin,
      priceInfoObjectId,
    });
    suinsTx.setTargetAddress({ nft, address: targetAddr });
    // setDefault skipped — keeper can't set reverse lookup for the target user
    tx.transferObjects([nft], tx.pure.address(targetAddr));
    return nsCoin; // still alive — has remainder after register splits what it needs
  }

  // ─── Route A: SUI → NS (direct DeepBook single-hop) → register with 25% discount
  //
  // Preferred route — single swap, least slippage. Swaps only what's needed,
  // returns excess SUI to user.

  private async buildRouteA(
    transport: SuiGraphQLClient,
    suinsClient: InstanceType<typeof SuinsClient>,
    keeperAddress: string,
    order: ShadeExecutorOrder,
    domainBytes: number[],
    saltBytes: number[],
    targetAddr: string,
    fullDomain: string,
    _usdcNeeded: bigint, // unused — Route A swaps SUI directly
  ): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(keeperAddress);

    // 1. shade::execute → Coin<SUI>
    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    // 2. Split ~50% of deposit for swap — keep remainder as safety margin.
    //    If the pool is thin, we only risk half. The rest goes back to user.
    const swapAmount = BigInt(order.depositMist) / 2n;
    const [swapCoin] = tx.splitCoins(releasedCoin, [tx.pure.u64(swapAmount)]);

    // 3. Swap SUI → NS via DeepBook NS/SUI pool (NS=base, SUI=quote)
    const nsSuiPool = tx.sharedObjectRef({
      objectId: DB_NS_SUI_POOL,
      initialSharedVersion: DB_NS_SUI_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, suiSwapChange, deepChange] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, SUI_TYPE],
      arguments: [nsSuiPool, swapCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock()],
    });

    // 4. Update NS Pyth price feed for register's calculatePrice
    const [nsPriceInfoId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
    );

    // 5. Register with NS at 25% discount
    this.registerWithNs(tx, suinsClient, fullDomain, nsCoin, nsPriceInfoId, targetAddr);

    // 6. Return excess to user — NS dust to 0x0
    tx.transferObjects([nsCoin], tx.pure.address('0x0'));
    // Merge swap SUI change back into released coin, send all excess to user
    tx.mergeCoins(releasedCoin, [suiSwapChange]);
    tx.transferObjects([releasedCoin], tx.pure.address(targetAddr));
    tx.transferObjects([deepChange], tx.pure.address('0x0'));

    return tx.build({ client: transport as never });
  }

  // ─── Route B: SUI → USDC → NS (DeepBook two-hop) → register with 25% discount
  //
  // Fallback when NS/SUI pool lacks liquidity. Mirrors the proven USDC→NS
  // path from buildRegisterSplashNsTx — swaps SUI→USDC first, then splits
  // exact usdcNeeded for the USDC→NS swap, returning all excess to user.

  private async buildRouteB(
    transport: SuiGraphQLClient,
    suinsClient: InstanceType<typeof SuinsClient>,
    keeperAddress: string,
    order: ShadeExecutorOrder,
    domainBytes: number[],
    saltBytes: number[],
    targetAddr: string,
    fullDomain: string,
    usdcNeeded: bigint,
  ): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(keeperAddress);

    // 1. shade::execute → Coin<SUI>
    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    // 2. Swap all released SUI → USDC via DeepBook SUI/USDC pool
    const suiUsdcPool = tx.sharedObjectRef({
      objectId: DB_SUI_USDC_POOL,
      initialSharedVersion: DB_SUI_USDC_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP1] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [suiChange, usdcOut, deepChange1] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, mainPackage.mainnet.coins.USDC.type],
      arguments: [suiUsdcPool, releasedCoin, zeroDEEP1, tx.pure.u64(0), tx.object.clock()],
    });

    // 3. Split exact USDC needed for NS swap — excess USDC goes to user
    const [usdcForSwap] = tx.splitCoins(usdcOut, [tx.pure.u64(usdcNeeded)]);

    // 4. Swap USDC → NS via DeepBook NS/USDC pool (identical to working registration)
    const nsUsdcPool = tx.sharedObjectRef({
      objectId: DB_NS_USDC_POOL,
      initialSharedVersion: DB_NS_USDC_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP2] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, usdcSwapChange, deepChange2] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, mainPackage.mainnet.coins.USDC.type],
      arguments: [nsUsdcPool, usdcForSwap, zeroDEEP2, tx.pure.u64(0), tx.object.clock()],
    });

    // 5. Update NS Pyth price feed (ensures freshness for register's calculatePrice)
    const [nsPriceInfoId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.NS.feed, tx.gas,
    );

    // 6. Register with NS at 25% discount
    this.registerWithNs(tx, suinsClient, fullDomain, nsCoin, nsPriceInfoId, targetAddr);

    // 7. Return all excess to user — NS dust + DEEP to 0x0
    tx.transferObjects([nsCoin], tx.pure.address('0x0'));
    tx.transferObjects([suiChange, usdcOut, usdcSwapChange], tx.pure.address(targetAddr));
    tx.transferObjects([deepChange1, deepChange2], tx.pure.address('0x0'));

    return tx.build({ client: transport as never });
  }

  // ─── Fallback: SUI → register directly (no discount) ─────────────

  private async buildRouteFallback(
    transport: SuiGraphQLClient,
    suinsClient: InstanceType<typeof SuinsClient>,
    keeperAddress: string,
    order: ShadeExecutorOrder,
    domainBytes: number[],
    saltBytes: number[],
    targetAddr: string,
    fullDomain: string,
  ): Promise<Uint8Array> {
    const tx = new Transaction();
    tx.setSender(keeperAddress);

    // 1. shade::execute → Coin<SUI> (full deposit)
    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    // 2. Get Pyth SUI/USD price info — pay oracle fee from gas (matches working buildRegisterSplashNsTx)
    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
    );

    // 3. Pre-split the SUI payment from released coin with buffer (matches working pattern).
    //    The deposit already has a 10% buffer baked in from creation. Use the full deposit
    //    as the payment coin — the SuiNS contract takes only what it needs.
    //    Key: split a known amount into a fresh coin so the SDK's tx.object() is clean.
    const rawPrice = await suinsClient.calculatePrice({ name: fullDomain, years: 1 });
    const basePriceUsd = rawPrice / 1e6;
    // Estimate SUI price from deposit: deposit was calculated as (usd_price / sui_price * 1.10)
    // We'll use the full deposit minus a tiny reserve as the payment coin.
    const suiPaymentMist = BigInt(order.depositMist) - 1_000_000n; // keep 0.001 SUI margin
    const [suiPayment] = tx.splitCoins(releasedCoin, [tx.pure.u64(suiPaymentMist)]);

    // 4. Register with SUI payment (same pattern as working buildRegisterSplashNsTx)
    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({
      domain: fullDomain,
      years: 1,
      coinConfig: mainPackage.mainnet.coins.SUI,
      coin: suiPayment,
      priceInfoObjectId,
    });
    suinsTx.setTargetAddress({ nft, address: targetAddr });
    // setDefault skipped — keeper can't set reverse lookup for the target user
    tx.transferObjects([nft], tx.pure.address(targetAddr));

    // 5. Return all excess SUI to user (suiPayment remainder + releasedCoin remainder)
    tx.mergeCoins(releasedCoin, [suiPayment]);
    tx.transferObjects([releasedCoin], tx.pure.address(targetAddr));

    return tx.build({ client: transport as never });
  }

  // ─── Submit transaction via fullnode JSON-RPC ───────────────────────

  private async submitTransaction(txBytes: Uint8Array, signature: string): Promise<string> {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_executeTransactionBlock',
      params: [
        uint8ToBase64(txBytes),
        [signature],
        { showEffects: true },
        'WaitForLocalExecution',
      ],
    });

    let lastError: Error | null = null;
    for (const url of FULLNODE_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });

        const json = await res.json() as {
          result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } };
          error?: { message?: string };
        };

        if (json.error) {
          throw new Error(`RPC error: ${json.error.message}`);
        }

        const status = json.result?.effects?.status;
        if (status?.status !== 'success') {
          throw new Error(`Tx failed: ${status?.error ?? JSON.stringify(status)}`);
        }

        return json.result?.digest ?? '';
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Tx-level failures (MoveAbort, insufficient balance) won't be fixed by another RPC
        if (lastError.message.includes('Tx failed:')) throw lastError;
        console.warn(`[ShadeExecutor] RPC ${url} failed:`, lastError.message);
      }
    }
    throw lastError ?? new Error('All RPC endpoints failed');
  }

  // ─── Resolve placeholder object ID ──────────────────────────────────

  private async resolveShadeOrderId(order: ShadeExecutorOrder): Promise<string | null> {
    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const result = await transport.query({
        query: `{
          objects(filter: { type: "${SHADE_PACKAGE}::shade::ShadeOrder" }) {
            nodes {
              address
              asMoveObject { contents { json } }
            }
          }
        }`,
      });
      const nodes = (result.data as Record<string, unknown> & { objects?: { nodes?: Array<{ address: string; asMoveObject?: { contents?: { json?: { owner?: string; deposit?: string } } } }> } })?.objects?.nodes;
      if (!nodes) return null;
      // Match by owner + deposit amount
      for (const node of nodes) {
        const json = node.asMoveObject?.contents?.json;
        if (json?.owner === order.ownerAddress && String(json?.deposit) === String(order.depositMist)) {
          return node.address;
        }
      }
      return null;
    } catch (err) {
      console.error('[ShadeExecutor] resolveShadeOrderId error:', err);
      return null;
    }
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  private updateOrder(objectId: string, update: Partial<ShadeExecutorOrder>) {
    this.setState({
      orders: this.state.orders.map(o =>
        o.objectId === objectId ? { ...o, ...update } : o,
      ),
    });
  }

  private scheduleNextAlarm() {
    const pendingOrders = this.state.orders
      .filter(o => o.status === 'pending')
      .sort((a, b) => a.executeAfterMs - b.executeAfterMs);

    if (pendingOrders.length > 0) {
      // Schedule exactly at expiry — every ms counts in a name race
      const nextMs = Math.max(pendingOrders[0].executeAfterMs, Date.now());
      this.ctx.storage.setAlarm(nextMs);
    }
  }
}
