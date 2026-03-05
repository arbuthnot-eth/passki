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
const FULLNODE_URL = 'https://fullnode.mainnet.sui.io:443';
const SHADE_PACKAGE = '0xfcd0b2b4f69758cd3ed0d35a55335417cac6304017c3c5d9a5aaff75c367aaff';

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

export interface ShadeExecutorOrder {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string; // hex-encoded
  ownerAddress: string;
  depositMist: string; // serialized bigint
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

  // ─── Query orders ───────────────────────────────────────────────────

  @callable()
  async getOrders(): Promise<{ orders: ShadeExecutorOrder[] }> {
    return { orders: this.state.orders };
  }

  @callable()
  async getStatus(params: { objectId: string }): Promise<ShadeExecutorOrder | null> {
    return this.state.orders.find(o => o.objectId === params.objectId) ?? null;
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

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddress = keypair.toSuiAddress();

      const domainBytes = Array.from(new TextEncoder().encode(order.domain));
      const saltBytes = Array.from(hexToBytes(order.salt));
      const targetAddr = normalizeSuiAddress(order.targetAddress);
      const fullDomain = `${order.domain}.sui`;

      // Build all routes in parallel — submit the fastest, skip dry-runs for speed.
      // Every millisecond matters: a competing bot could register first.
      const buildArgs = [transport, suinsClient, keeperAddress, order, domainBytes, saltBytes, targetAddr, fullDomain] as const;

      const [routeA, routeB] = await Promise.allSettled([
        this.buildRouteA(...buildArgs),
        this.buildRouteB(...buildArgs),
      ]);

      // Try routes in priority order: A (direct SUI→NS) → B (SUI→USDC→NS) → fallback (SUI, no discount)
      // No dry-run — submit directly, fall back on actual tx failure.
      const routes: Array<{ name: string; bytes: Uint8Array | null }> = [
        { name: 'A (SUI→NS)', bytes: routeA.status === 'fulfilled' ? routeA.value : null },
        { name: 'B (SUI→USDC→NS)', bytes: routeB.status === 'fulfilled' ? routeB.value : null },
      ];

      let digest: string | null = null;
      for (const route of routes) {
        if (!route.bytes) continue;
        try {
          const { signature } = await keypair.signTransaction(route.bytes);
          digest = await this.submitTransaction(route.bytes, signature);
          console.log(`[ShadeExecutor] Route ${route.name} submitted: ${digest}`);
          break;
        } catch (err) {
          console.warn(`[ShadeExecutor] Route ${route.name} submit failed:`, err);
        }
      }

      // Last resort — direct SUI payment (no discount)
      if (!digest) {
        const fallbackBytes = await this.buildRouteFallback(...buildArgs);
        const { signature } = await keypair.signTransaction(fallbackBytes);
        digest = await this.submitTransaction(fallbackBytes, signature);
        console.log(`[ShadeExecutor] Fallback (SUI direct) submitted: ${digest}`);
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
    suinsTx.setDefault(fullDomain);
    tx.transferObjects([nft], tx.pure.address(targetAddr));
    return nsCoin; // still alive — has remainder after register splits what it needs
  }

  // ─── Route A: SUI → NS (direct DeepBook) → register with 25% discount

  private async buildRouteA(
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

    // 1. shade::execute → Coin<SUI>
    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    // 2. Swap SUI → NS via DeepBook NS/SUI pool (NS=base, SUI=quote)
    const nsSuiPool = tx.sharedObjectRef({
      objectId: DB_NS_SUI_POOL,
      initialSharedVersion: DB_NS_SUI_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, suiChange, deepChange] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, SUI_TYPE],
      arguments: [nsSuiPool, releasedCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock()],
    });

    // 3. Register with NS at 25% discount
    this.registerWithNs(tx, suinsClient, fullDomain, nsCoin, this.nsPriceInfoRef(tx), targetAddr);

    // 4. Return change — NS dust to 0x0, SUI change to user
    tx.transferObjects([nsCoin], tx.pure.address('0x0'));
    tx.transferObjects([suiChange], tx.pure.address(targetAddr));
    tx.transferObjects([deepChange], tx.pure.address('0x0'));

    return tx.build({ client: transport as never });
  }

  // ─── Route B: SUI → USDC → NS (two-hop DeepBook) → register with 25% discount

  private async buildRouteB(
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

    // 1. shade::execute → Coin<SUI>
    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    // 2. Swap SUI → USDC via DeepBook (SUI=base, USDC=quote)
    const suiUsdcPool = tx.sharedObjectRef({
      objectId: DB_SUI_USDC_POOL,
      initialSharedVersion: DB_SUI_USDC_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP1] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [usdcOut, suiChange, deepChange1] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
      typeArguments: [SUI_TYPE, mainPackage.mainnet.coins.USDC.type],
      arguments: [suiUsdcPool, releasedCoin, zeroDEEP1, tx.pure.u64(0), tx.object.clock()],
    });

    // 3. Swap USDC → NS via DeepBook (NS=base, USDC=quote)
    const nsUsdcPool = tx.sharedObjectRef({
      objectId: DB_NS_USDC_POOL,
      initialSharedVersion: DB_NS_USDC_POOL_ISV,
      mutable: true,
    });
    const [zeroDEEP2] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
    const [nsCoin, usdcChange, deepChange2] = tx.moveCall({
      target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
      typeArguments: [mainPackage.mainnet.coins.NS.type, mainPackage.mainnet.coins.USDC.type],
      arguments: [nsUsdcPool, usdcOut, zeroDEEP2, tx.pure.u64(0), tx.object.clock()],
    });

    // 4. Register with NS at 25% discount
    this.registerWithNs(tx, suinsClient, fullDomain, nsCoin, this.nsPriceInfoRef(tx), targetAddr);

    // 5. Return change — NS dust to 0x0, SUI+USDC change to user
    tx.transferObjects([nsCoin], tx.pure.address('0x0'));
    tx.transferObjects([suiChange, usdcChange], tx.pure.address(targetAddr));
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

    const [releasedCoin] = this.shadeExecute(tx, order, domainBytes, saltBytes, targetAddr);

    const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
      tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
    );

    const suinsTx = new SuinsTransaction(suinsClient, tx);
    const nft = suinsTx.register({
      domain: fullDomain,
      years: 1,
      coinConfig: mainPackage.mainnet.coins.SUI,
      coin: releasedCoin,
      priceInfoObjectId,
    });
    suinsTx.setTargetAddress({ nft, address: targetAddr });
    suinsTx.setDefault(fullDomain);
    tx.transferObjects([nft], tx.pure.address(targetAddr));
    tx.transferObjects([releasedCoin], tx.pure.address(targetAddr));

    return tx.build({ client: transport as never });
  }

  // ─── Submit transaction via fullnode JSON-RPC ───────────────────────

  private async submitTransaction(txBytes: Uint8Array, signature: string): Promise<string> {
    const res = await fetch(FULLNODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_executeTransactionBlock',
        params: [
          uint8ToBase64(txBytes),
          [signature],
          { showEffects: true },
          'WaitForLocalExecution',
        ],
      }),
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
