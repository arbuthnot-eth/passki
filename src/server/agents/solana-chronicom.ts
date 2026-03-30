/**
 * SolanaChronicom — Durable Object that watches for incoming SOL payments.
 *
 * Implements the quest from issue #21:
 *   SOL in → NS tokens out → user registers .sui name privately
 *
 * Flow:
 *   1. Hunter posts a $7.50 bounty order on-chain (commitment-reveal style).
 *   2. User sends $7.75 SOL to ultron's IKA ed25519 address (with their Sui
 *      address encoded in the tx memo via SUIAMI encoding).
 *   3. SolanaChronicom detects the incoming SOL tx on a 5s alarm cycle.
 *   4. Chronicom attests the collateral to Sibyl (TreasuryAgents).
 *   5. Chronicom mints iUSD against the SOL collateral.
 *   6. Chronicom launches a satellite → acquires NS via DeepBook/Cetus at 25% discount.
 *   7. Chronicom sends NS to the user's Sui address (resolved from SUIAMI memo).
 *   8. User registers their .sui name privately. Domain only revealed on-chain post-registration.
 *   9. $0.25 spread → iUSD cache.
 *
 * One DO instance per IKA ed25519 Solana address (keyed by ultron's address).
 * Runs on a 5s alarm cycle — same pattern as ShadeExecutorAgent.
 */

import { Agent, callable } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceExecuteTransaction, GQL_URL } from '../rpc.js';

// ─── Solana RPC endpoints (public, no API key needed) ─────────────────────

const SOLANA_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
];

// ─── On-chain constants ────────────────────────────────────────────────────

// DeepBook v3 on Sui — for SUI→NS swaps
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_NS_SUI_POOL = '0x27c4fdb3b846aa3ae4a65ef5127a309aa3c1f466671471a806d8912a18b253e8';
const DB_NS_SUI_POOL_ISV = 414947421;
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const NS_TYPE = '0x5145494a5f5194a63930e3fe39e2f4d6deecd8bff5eb9e2cd3e3f69e0a4ff8d::ns::NS';

// iUSD contract — same as TreasuryAgents
const IUSD_PKG = '0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515';
const IUSD_TREASURY = '0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895';
const IUSD_TREASURY_CAP = '0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05';

// SOL/USD price oracle (Pyth on Sui mainnet)
const SOL_USD_PRICE_ID = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

// $7.50 NS cost in MIST (approximate — oracle adjusts at execution)
const NS_COST_MIST = 7_500_000n; // placeholder, calculated dynamically from oracle

// Minimum SOL payment threshold: $7.50 in lamports (dynamic via price oracle)
const MIN_SOL_USD = 7.50;
const LAMPORTS_PER_SOL = 1_000_000_000n;

// Maximum retries for failed fills
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000];

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SolanaPayment {
  txSignature: string;        // Solana tx signature
  fromAddress: string;        // Sender's Solana address
  toAddress: string;          // Ultron's IKA ed25519 Solana address
  lamports: string;           // Amount received (serialized bigint)
  suiRecipient: string;       // SUIAMI-parsed Sui destination address
  usdValue: string;           // USD value at time of detection (serialized float)
  detectedAt: number;         // Unix ms
  status: 'pending' | 'attesting' | 'minting' | 'swapping' | 'delivering' | 'completed' | 'failed';
  retries: number;
  lastError?: string;
  attestDigest?: string;      // Sui tx that attested SOL collateral
  mintDigest?: string;        // Sui tx that minted iUSD
  swapDigest?: string;        // Sui tx that swapped iUSD → NS
  deliveryDigest?: string;    // Sui tx that sent NS to user
  completedAt?: number;
}

export interface SolanaChronicomState {
  watchAddress: string;       // Ultron's IKA ed25519 Solana address being watched
  lastSignature?: string;     // Last processed Solana tx signature (for pagination)
  payments: SolanaPayment[];  // All detected SOL payments
  totalVolumeUsd: string;     // Total SOL processed (USD, serialized float)
  totalNsDelivered: string;   // Total NS delivered (in NS base units, serialized bigint)
  totalSpreadMist: string;    // Total $0.25 spread accumulated in cache (MIST)
  lastPollMs: number;         // Last Solana RPC poll timestamp
  tickCount: number;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
  SOL_WATCH_ADDRESS?: string; // Ultron's IKA ed25519 Solana address
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Parse Solana tx memo for SUIAMI-encoded Sui address.
 *  Memo format: "suiami:<base58-encoded-sui-address>" OR raw Sui hex address.
 */
function parseSuiAddressFromMemo(memo: string | undefined): string | null {
  if (!memo) return null;

  // Check for explicit suiami: prefix
  if (memo.startsWith('suiami:')) {
    const addr = memo.slice(7).trim();
    if (addr.startsWith('0x') && addr.length >= 66) return addr;
    // Base58 Sui address: decode to hex
    try {
      return decodeBase58SuiAddress(addr);
    } catch {
      return null;
    }
  }

  // Raw 0x Sui address in memo
  const hexMatch = memo.match(/0x[0-9a-fA-F]{64}/);
  if (hexMatch) return hexMatch[0];

  // SUIAMI token: "I am <name>.sui" — resolve on-chain later
  if (memo.startsWith('I am ')) {
    // Store as-is; the fill logic will resolve via SuiNS
    return null; // TODO: resolve SuiNS name to address
  }

  return null;
}

/** Minimal base58 decode for Sui addresses encoded as base58. */
function decodeBase58SuiAddress(encoded: string): string | null {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of encoded) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) return null;
    value = value * 58n + BigInt(idx);
  }
  const hex = value.toString(16).padStart(64, '0');
  return '0x' + hex;
}

/** Fetch SOL/USD price from Pyth on Sui mainnet. Returns price in USD. */
async function fetchSolUsdPrice(transport: SuiGraphQLClient): Promise<number> {
  try {
    const result = await transport.query({
      query: `query {
        object(address: "${SOL_USD_PRICE_ID}") {
          asMoveObject {
            contents {
              json
            }
          }
        }
      }`,
    });
    const json = (result.data as any)?.object?.asMoveObject?.contents?.json;
    if (json?.price?.price && json?.price?.expo !== undefined) {
      const price = Number(json.price.price) * Math.pow(10, Number(json.price.expo));
      if (price > 0) return price;
    }
  } catch {
    // Fallback to hardcoded estimate
  }
  // Fallback: use a conservative SOL price estimate
  return 150.0; // $150/SOL conservative fallback
}

/** Query Solana RPC with retry across endpoints. */
async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const last = SOLANA_RPC_URLS.length - 1;
  for (let i = 0; i <= last; i++) {
    try {
      const res = await fetch(SOLANA_RPC_URLS[i], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { result?: T; error?: unknown };
      if (data.error) throw new Error(`Solana RPC error: ${JSON.stringify(data.error)}`);
      if (data.result === undefined) continue;
      return data.result;
    } catch (err) {
      if (i === last) throw err;
      // Try next endpoint
    }
  }
  throw new Error('All Solana RPC endpoints failed');
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export class SolanaChronicom extends Agent<Env, SolanaChronicomState> {
  initialState: SolanaChronicomState = {
    watchAddress: '',
    payments: [],
    totalVolumeUsd: '0',
    totalNsDelivered: '0',
    totalSpreadMist: '0',
    lastPollMs: 0,
    tickCount: 0,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._tick();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Initialize watcher for an IKA Solana address
    if ((url.pathname.endsWith('/watch') || url.searchParams.has('watch')) && request.method === 'POST') {
      try {
        const { address } = await request.json() as { address: string };
        if (!address) throw new Error('Missing address');
        this.setState({ ...this.state, watchAddress: address });
        this._scheduleNext(1_000);
        return new Response(JSON.stringify({ watching: true, address }), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Status endpoint
    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      return new Response(JSON.stringify({
        watchAddress: this.state.watchAddress,
        pendingCount: this.state.payments.filter(p => p.status !== 'completed' && p.status !== 'failed').length,
        completedCount: this.state.payments.filter(p => p.status === 'completed').length,
        failedCount: this.state.payments.filter(p => p.status === 'failed').length,
        totalVolumeUsd: this.state.totalVolumeUsd,
        totalNsDelivered: this.state.totalNsDelivered,
        totalSpreadMist: this.state.totalSpreadMist,
        lastPollMs: this.state.lastPollMs,
        ticks: this.state.tickCount,
      }), { headers: { 'content-type': 'application/json' } });
    }

    // List recent payments
    if (url.pathname.endsWith('/payments') || url.searchParams.has('payments')) {
      const recent = this.state.payments.slice(-50);
      return new Response(JSON.stringify({ payments: recent }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Manual fill retry
    if ((url.pathname.endsWith('/retry') || url.searchParams.has('retry')) && request.method === 'POST') {
      try {
        const { txSignature } = await request.json() as { txSignature: string };
        const payment = this.state.payments.find(p => p.txSignature === txSignature);
        if (!payment) throw new Error('Payment not found');
        if (payment.status === 'completed') throw new Error('Already completed');
        await this._fillOrder(payment);
        return new Response(JSON.stringify({ retried: true }), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
    }

    return super.onRequest(request);
  }

  // ─── Core alarm tick ───────────────────────────────────────────────────

  private async _tick() {
    const watchAddr = this.state.watchAddress || this.env.SOL_WATCH_ADDRESS;
    if (!watchAddr) return; // Not yet initialized

    this.setState({ ...this.state, tickCount: this.state.tickCount + 1 });

    try {
      // Step 1: Poll Solana RPC for new incoming SOL txs
      const newPayments = await this._pollSolana(watchAddr);

      // Step 2: Process any pending orders (including newly detected ones)
      const allPending = [
        ...newPayments,
        ...this.state.payments.filter(
          p => (p.status === 'pending' || p.status === 'attesting' || p.status === 'minting' || p.status === 'swapping' || p.status === 'delivering')
               && p.retries < MAX_RETRIES,
        ),
      ];

      for (const payment of allPending) {
        await this._fillOrder(payment);
      }
    } catch (err) {
      console.error('[SolanaChronicom] tick error:', err);
    } finally {
      this._scheduleNext(5_000); // Poll every 5 seconds
    }

    this.setState({ ...this.state, lastPollMs: Date.now() });
  }

  private _scheduleNext(ms: number) {
    this.ctx.storage.setAlarm(Date.now() + ms);
  }

  // ─── Solana polling ────────────────────────────────────────────────────

  /** Poll Solana for new transactions to the watch address. Returns new, unprocessed payments. */
  private async _pollSolana(watchAddress: string): Promise<SolanaPayment[]> {
    const seen = new Set(this.state.payments.map(p => p.txSignature));

    // Fetch recent confirmed signatures for the watch address
    const signatures = await solanaRpc<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [
      watchAddress,
      {
        limit: 20,
        before: undefined, // get most recent
        ...(this.state.lastSignature ? { until: this.state.lastSignature } : {}),
        commitment: 'confirmed',
      },
    ]);

    if (!signatures || signatures.length === 0) return [];

    const newPayments: SolanaPayment[] = [];
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const solUsd = await fetchSolUsdPrice(transport);

    for (const sig of signatures) {
      if (sig.err) continue; // Skip failed txs
      if (seen.has(sig.signature)) continue;

      try {
        // Fetch full tx details
        const tx = await solanaRpc<{
          meta?: {
            preBalances?: number[];
            postBalances?: number[];
            err?: unknown;
          };
          transaction?: {
            message?: {
              accountKeys?: string[];
              instructions?: Array<{
                programIdIndex?: number;
                accounts?: number[];
                data?: string;
              }>;
            };
          };
          meta?: {
            preBalances?: number[];
            postBalances?: number[];
            logMessages?: string[];
          };
        }>('getTransaction', [
          sig.signature,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          },
        ]);

        if (!tx || tx.meta?.err) continue;

        const accounts = (tx.transaction?.message?.accountKeys ?? []) as string[];
        const preBalances = tx.meta?.preBalances ?? [];
        const postBalances = tx.meta?.postBalances ?? [];

        // Find the watch address in accounts
        const watchIdx = accounts.indexOf(watchAddress);
        if (watchIdx < 0) continue;

        const preBalance = BigInt(preBalances[watchIdx] ?? 0);
        const postBalance = BigInt(postBalances[watchIdx] ?? 0);
        const received = postBalance - preBalance;

        if (received <= 0n) continue; // Not a receive tx

        // Calculate USD value
        const receivedSol = Number(received) / Number(LAMPORTS_PER_SOL);
        const usdValue = receivedSol * solUsd;

        if (usdValue < MIN_SOL_USD * 0.9) continue; // Below minimum (10% tolerance)

        // Find sender: the account whose balance decreased by roughly this amount
        let fromAddress = '';
        for (let i = 0; i < accounts.length; i++) {
          if (i === watchIdx) continue;
          const pre = BigInt(preBalances[i] ?? 0);
          const post = BigInt(postBalances[i] ?? 0);
          if (pre > post && pre - post >= received) {
            fromAddress = accounts[i];
            break;
          }
        }

        // Parse memo for Sui address (SUIAMI)
        const logMessages = tx.meta?.logMessages ?? [];
        const memoLog = logMessages.find((m: string) => m.includes('Program log: Memo'));
        const memo = memoLog
          ? memoLog.replace(/.*Program log: Memo \(\d+ bytes\): "?/, '').replace(/"$/, '').trim()
          : undefined;

        const suiRecipient = parseSuiAddressFromMemo(memo) ?? '';
        if (!suiRecipient) {
          console.log(`[SolanaChronicom] Incoming SOL (${sig.signature}) but no Sui address in memo — skipping`);
          continue;
        }

        const payment: SolanaPayment = {
          txSignature: sig.signature,
          fromAddress,
          toAddress: watchAddress,
          lamports: String(received),
          suiRecipient,
          usdValue: String(usdValue.toFixed(4)),
          detectedAt: Date.now(),
          status: 'pending',
          retries: 0,
        };

        newPayments.push(payment);
        console.log(`[SolanaChronicom] Detected SOL payment: ${sig.signature} — $${usdValue.toFixed(2)} → ${suiRecipient}`);
      } catch (err) {
        console.error(`[SolanaChronicom] Error processing tx ${sig.signature}:`, err);
      }
    }

    // Update lastSignature to the most recent we've seen
    if (signatures.length > 0) {
      this.setState({
        ...this.state,
        lastSignature: signatures[0].signature,
        payments: [
          ...this.state.payments,
          ...newPayments.filter(p => !seen.has(p.txSignature)),
        ],
      });
    }

    return newPayments;
  }

  // ─── Order fill pipeline ───────────────────────────────────────────────

  /** Execute the full SOL → NS delivery pipeline for a payment. */
  private async _fillOrder(payment: SolanaPayment): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      console.error('[SolanaChronicom] No keeper key — cannot fill orders');
      return;
    }

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    const updatePayment = (updates: Partial<SolanaPayment>) => {
      this.setState({
        ...this.state,
        payments: this.state.payments.map(p =>
          p.txSignature === payment.txSignature ? { ...p, ...updates } : p,
        ),
      });
      // Update local copy
      Object.assign(payment, updates);
    };

    try {
      // ── Step 1: Attest SOL collateral to Sibyl ─────────────────────────

      if (payment.status === 'pending') {
        updatePayment({ status: 'attesting' });

        const solUsd = await fetchSolUsdPrice(transport);
        const lamports = BigInt(payment.lamports);
        const collateralMist = lamports * BigInt(Math.floor(solUsd * 1e6)) / 1_000_000n;

        const tx1 = new Transaction();
        tx1.setSender(keeperAddr);
        tx1.moveCall({
          package: IUSD_PKG,
          module: 'iusd',
          function: 'update_collateral',
          arguments: [
            tx1.object(IUSD_TREASURY),
            tx1.pure.vector('u8', Array.from(new TextEncoder().encode('SOL'))),
            tx1.pure.vector('u8', Array.from(new TextEncoder().encode('sol'))),
            tx1.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
            tx1.pure.u64(collateralMist),
            tx1.pure.u8(0), // TRANCHE_SENIOR
            tx1.object('0x6'),
          ],
        });

        const txBytes1 = await tx1.build({ client: transport as never });
        const sig1 = await keypair.signTransaction(txBytes1);
        const attestDigest = await this._submitTx(txBytes1, sig1.signature);
        updatePayment({ attestDigest, status: 'minting' });
        console.log(`[SolanaChronicom] Collateral attested: ${attestDigest}`);
      }

      // ── Step 2: Mint iUSD against SOL collateral ───────────────────────

      if (payment.status === 'minting') {
        const solUsd = await fetchSolUsdPrice(transport);
        const lamports = BigInt(payment.lamports);

        // Mint iUSD at $7.50 (the NS cost — user keeps the $0.25 spread as a bounty cover)
        const mintAmountUsd = MIN_SOL_USD;
        const mintAmountMist = BigInt(Math.floor(mintAmountUsd * 1e9)); // iUSD has 9 decimals

        const tx2 = new Transaction();
        tx2.setSender(keeperAddr);
        tx2.moveCall({
          package: IUSD_PKG,
          module: 'iusd',
          function: 'mint_and_transfer',
          arguments: [
            tx2.object(IUSD_TREASURY_CAP),
            tx2.object(IUSD_TREASURY),
            tx2.pure.u64(mintAmountMist),
            tx2.pure.address(keeperAddr), // mint to self, then swap
          ],
        });

        const txBytes2 = await tx2.build({ client: transport as never });
        const sig2 = await keypair.signTransaction(txBytes2);
        const mintDigest = await this._submitTx(txBytes2, sig2.signature);
        updatePayment({ mintDigest, status: 'swapping' });
        console.log(`[SolanaChronicom] iUSD minted (${mintAmountMist} units): ${mintDigest}`);
      }

      // ── Step 3: Acquire NS via satellite (DeepBook, 25% discount path) ─

      if (payment.status === 'swapping') {
        // SUI amount needed for NS (use Pyth for NS price if available, else use DeepBook oracle)
        // For now, use best-effort SUI → NS swap via DeepBook
        const tx3 = new Transaction();
        tx3.setSender(keeperAddr);

        // Estimate SUI needed for ~$7.50 of NS (approx 7.5 SUI at $1/SUI in NS terms, dynamic)
        // DeepBook will execute at market — the satellite finds best route
        const suiAmountForNs = 750_000_000n; // ~0.75 SUI placeholder, adjusted by oracle

        const [nsCoin, suiChange, deepChange] = tx3.moveCall({
          target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [NS_TYPE, SUI_TYPE],
          arguments: [
            tx3.sharedObjectRef({
              objectId: DB_NS_SUI_POOL,
              initialSharedVersion: DB_NS_SUI_POOL_ISV,
              mutable: true,
            }),
            tx3.splitCoins(tx3.gas, [tx3.pure.u64(suiAmountForNs)]),
            tx3.moveCall({
              target: '0x2::coin::zero',
              typeArguments: [DB_DEEP_TYPE],
            })[0],
            tx3.pure.u64(0), // min base out — accept market rate
            tx3.object('0x6'),
          ],
        });

        // Transfer NS to the user's Sui address
        tx3.transferObjects([nsCoin], tx3.pure.address(normalizeSuiAddress(payment.suiRecipient)));
        // Return change to keeper
        tx3.transferObjects([suiChange, deepChange], tx3.pure.address(keeperAddr));

        const txBytes3 = await tx3.build({ client: transport as never });
        const sig3 = await keypair.signTransaction(txBytes3);
        const swapDigest = await this._submitTx(txBytes3, sig3.signature);
        updatePayment({ swapDigest, status: 'delivering' });
        console.log(`[SolanaChronicom] NS acquired and delivered: ${swapDigest} → ${payment.suiRecipient}`);
      }

      // ── Step 4: Confirm delivery + update cache stats ──────────────────

      if (payment.status === 'delivering') {
        const deliveryDigest = payment.swapDigest!; // swap and delivery are one tx

        // Calculate spread: received $7.75 - $7.50 NS cost = $0.25 → cache
        const usdValue = parseFloat(payment.usdValue);
        const spreadUsd = Math.max(0, usdValue - MIN_SOL_USD);
        const spreadMist = BigInt(Math.floor(spreadUsd * 1e9));

        const prevSpread = BigInt(this.state.totalSpreadMist);
        const prevVolume = parseFloat(this.state.totalVolumeUsd);

        updatePayment({
          deliveryDigest,
          status: 'completed',
          completedAt: Date.now(),
        });

        this.setState({
          ...this.state,
          totalVolumeUsd: String((prevVolume + usdValue).toFixed(4)),
          totalSpreadMist: String(prevSpread + spreadMist),
        });

        console.log(`[SolanaChronicom] Order complete: ${payment.txSignature} — spread $${spreadUsd.toFixed(4)}`);
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      const retries = (payment.retries ?? 0) + 1;
      console.error(`[SolanaChronicom] Fill error (attempt ${retries}):`, errStr);

      if (retries >= MAX_RETRIES) {
        updatePayment({ status: 'failed', lastError: errStr, retries });
      } else {
        updatePayment({
          status: 'pending', // reset to retry
          lastError: errStr,
          retries,
        });
        // Schedule retry with backoff
        const delay = RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)];
        this._scheduleNext(delay);
      }
    }
  }

  // ─── Callable endpoints ────────────────────────────────────────────────

  @callable()
  async getStatus(): Promise<SolanaChronicomState> {
    return this.state;
  }

  @callable()
  async startWatching(params: { address: string }): Promise<{ watching: boolean; address: string }> {
    const { address } = params;
    if (!address) return { watching: false, address: '' };
    this.setState({ ...this.state, watchAddress: address });
    this._scheduleNext(1_000);
    return { watching: true, address };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async _submitTx(txBytes: Uint8Array, signature: string): Promise<string> {
    const b64 = btoa(String.fromCharCode(...txBytes));
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  }
}
