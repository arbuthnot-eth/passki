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

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 60_000; // 1 minute between retries

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

  // ─── DO Alarm — fires at grace expiry ───────────────────────────────

  async alarm() {
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

    // Schedule alarm for next pending order
    this.scheduleNextAlarm();
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

    this.updateOrder(order.objectId, { status: 'executing' });

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });

      // Derive keeper keypair from secret (bech32 suiprivkey1... string)
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddress = keypair.toSuiAddress();

      // ── Build the execute + register PTB ────────────────────────────

      const tx = new Transaction();
      tx.setSender(keeperAddress);

      // 1. shade::execute → Coin<SUI> (permissionless — anyone with preimage can call)
      const domainBytes = Array.from(new TextEncoder().encode(order.domain));
      const saltBytes = Array.from(hexToBytes(order.salt));
      const targetAddr = normalizeSuiAddress(order.targetAddress);

      const [releasedCoin] = tx.moveCall({
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

      // 2. Pyth SUI/USD price info for SuiNS registration fee
      const [priceInfoObjectId] = await suinsClient.getPriceInfoObject(
        tx, mainPackage.mainnet.coins.SUI.feed, tx.gas,
      );

      // 3. Register the domain with released SUI from the shade order
      const fullDomain = `${order.domain}.sui`;
      const suinsTx = new SuinsTransaction(suinsClient, tx);
      const nft = suinsTx.register({
        domain: fullDomain,
        years: 1,
        coinConfig: mainPackage.mainnet.coins.SUI,
        coin: releasedCoin,
        priceInfoObjectId,
      });

      // 4. Set forward resolution (target address) — uses NFT as auth
      suinsTx.setTargetAddress({ nft, address: targetAddr });

      // 5. Transfer NFT to user
      tx.transferObjects([nft], tx.pure.address(targetAddr));

      // 6. Send excess deposit back to user (not keeper)
      tx.transferObjects([releasedCoin], tx.pure.address(targetAddr));

      // ── Build, sign, submit ─────────────────────────────────────────

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this.submitTransaction(txBytes, signature);

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
        // Retry with backoff
        this.updateOrder(order.objectId, {
          status: 'pending',
          retries,
          error: `Retry ${retries}/${MAX_RETRIES}: ${errorMsg}`,
        });
        this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS * retries);
      }
    }
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
      // Schedule for the earliest pending order (at least 1s from now)
      const nextMs = Math.max(pendingOrders[0].executeAfterMs, Date.now() + 1000);
      this.ctx.storage.setAlarm(nextMs);
    }
  }
}
