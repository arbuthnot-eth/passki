/**
 * CrossChainBountyBoard — Durable Object that watches bounty boards on multiple chains.
 *
 * Implements the quest from issue #22:
 *   Hunter posts $7.75 on Solana/ETH/BTC/Base/Polygon →
 *   Chronicom detects + attests collateral → mints iUSD → acquires NS → delivers
 *
 * One DO instance per "board" (keyed by "bounty-board"). Runs a Chronicom watcher
 * per chain using a 5s alarm cycle. Multiple Hunters can post bounties; Hunters
 * compete on spread. The cache benefits regardless of which Hunter fills.
 *
 * Architecture:
 *   - SolanaChronicoms (ED25519 dWallet address) — handled by SolanaChronicom agent
 *   - EVM Chronicoms (secp256k1 dWallet address) — ETH, Base, Polygon, Arbitrum
 *   - Bitcoin Chronicom (P2WPKH dWallet address) — native BTC UTXO watcher
 *
 * Each chain Chronicom:
 *   1. Polls chain RPC for incoming payments to the Hunter's IKA dWallet address
 *   2. Parses SUIAMI memo from tx data/OP_RETURN/input data
 *   3. Attests collateral to Sibyl (TreasuryAgents)
 *   4. Mints iUSD → swaps to NS → delivers to user's Sui address
 */

import { Agent, callable } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceExecuteTransaction, GQL_URL } from '../rpc.js';

// ─── Chain configs ─────────────────────────────────────────────────────────

export type ChainId = 'solana' | 'ethereum' | 'bitcoin' | 'base' | 'polygon';

interface ChainConfig {
  id: ChainId;
  name: string;
  nativeCurrency: string;
  nativeDecimals: number;
  rpcUrls: string[];
  minUsd: number;   // Minimum payment (e.g. $7.50)
  bountyUsd: number; // Hunter's ask (e.g. $7.75)
}

const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  solana: {
    id: 'solana',
    name: 'Solana',
    nativeCurrency: 'SOL',
    nativeDecimals: 9,
    rpcUrls: [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
    ],
    minUsd: 7.50,
    bountyUsd: 7.75,
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    nativeCurrency: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://eth.llamarpc.com',
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.ankr.com/eth',
    ],
    minUsd: 7.50,
    bountyUsd: 7.75,
  },
  base: {
    id: 'base',
    name: 'Base',
    nativeCurrency: 'ETH',
    nativeDecimals: 18,
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://rpc.ankr.com/base',
    ],
    minUsd: 7.50,
    bountyUsd: 7.75,
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    nativeCurrency: 'MATIC',
    nativeDecimals: 18,
    rpcUrls: [
      'https://polygon-rpc.com',
      'https://polygon-rpc.publicnode.com',
      'https://rpc.ankr.com/polygon',
    ],
    minUsd: 7.50,
    bountyUsd: 7.75,
  },
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    nativeCurrency: 'BTC',
    nativeDecimals: 8,
    rpcUrls: [
      'https://blockstream.info/api',  // Esplora API
      'https://mempool.space/api',      // Mempool.space API
    ],
    minUsd: 7.50,
    bountyUsd: 7.75,
  },
};

// ─── Constants ─────────────────────────────────────────────────────────────

// DeepBook v3 on Sui — for iUSD → NS swaps
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_NS_SUI_POOL = '0x27c4fdb3b846aa3ae4a65ef5127a309aa3c1f466671471a806d8912a18b253e8';
const DB_NS_SUI_POOL_ISV = 414947421;
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const NS_TYPE = '0x5145494a5f5194a63930e3fe39e2f4d6deecd8bff5eb9e2cd3e3f69e0a4ff8d::ns::NS';

// iUSD
const IUSD_PKG = '0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515';
const IUSD_TREASURY = '0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895';
const IUSD_TREASURY_CAP = '0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05';

// Price oracle IDs (Pyth on Sui mainnet)
const PRICE_ORACLE_IDS: Record<string, string> = {
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  ETH: '0x9d4294bbcd1174d6f2003ec365831e64cc31d9f6f15a791579c7782c2c6e90c4',
  BTC: '0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33',
  MATIC: '0xd2c2c1f2bba8e0964f9589e060c2ee97f5e19057267ac3284caef3bd50bd2cb5',
};

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
const MIN_USD = 7.50;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BountyWatchAddress {
  chain: ChainId;
  address: string;          // Hunter's IKA dWallet native address for this chain
  curve: 'secp256k1' | 'ed25519' | 'p2wpkh';
  active: boolean;
  registeredAt: number;
}

export interface ChainPayment {
  id: string;               // <chain>:<txHash>
  chain: ChainId;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  nativeAmount: string;     // serialized bigint (smallest denomination)
  usdValue: string;         // USD value at detection time
  suiRecipient: string;     // SUIAMI-resolved Sui destination
  detectedAt: number;
  status: 'pending' | 'attesting' | 'minting' | 'swapping' | 'completed' | 'failed';
  retries: number;
  lastError?: string;
  attestDigest?: string;
  mintDigest?: string;
  swapDigest?: string;
  completedAt?: number;
  spreadMist?: string;      // $0.25 spread captured to cache
}

export interface CrossChainBountyBoardState {
  watchAddresses: BountyWatchAddress[];
  payments: ChainPayment[];
  lastSeenByChain: Record<ChainId, string>;  // last tx hash processed per chain
  totalVolumeByChain: Record<ChainId, string>;
  totalSpreadMist: string;
  lastPollMs: number;
  tickCount: number;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

// ─── Chain-specific RPC helpers ────────────────────────────────────────────

async function evmRpc<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { result?: T; error?: unknown };
      if (data.error) continue;
      if (data.result === undefined) continue;
      return data.result;
    } catch {
      // try next
    }
  }
  throw new Error(`EVM RPC failed for method ${method}`);
}

async function solanaRpc<T>(urls: string[], method: string, params: unknown[]): Promise<T> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { result?: T; error?: unknown };
      if (data.error) continue;
      if (data.result === undefined) continue;
      return data.result;
    } catch {
      // try next
    }
  }
  throw new Error('Solana RPC failed');
}

/** Fetch native currency USD price from Pyth on Sui. */
async function fetchUsdPrice(transport: SuiGraphQLClient, symbol: string): Promise<number> {
  const oracleId = PRICE_ORACLE_IDS[symbol];
  if (!oracleId) return 1.0;

  try {
    const result = await transport.query({
      query: `query {
        object(address: "${oracleId}") {
          asMoveObject { contents { json } }
        }
      }`,
    });
    const json = (result.data as any)?.object?.asMoveObject?.contents?.json;
    if (json?.price?.price && json?.price?.expo !== undefined) {
      const price = Number(json.price.price) * Math.pow(10, Number(json.price.expo));
      if (price > 0) return price;
    }
  } catch {}

  // Fallback prices (conservative estimates)
  const fallbacks: Record<string, number> = {
    SOL: 150,
    ETH: 3000,
    BTC: 60000,
    MATIC: 0.8,
  };
  return fallbacks[symbol] ?? 1.0;
}

/** Parse Sui address from tx data (EVM input data or Bitcoin OP_RETURN). */
function parseSuiAddress(data: string | undefined): string | null {
  if (!data) return null;

  // EVM: input data is hex-encoded UTF-8 memo starting with 0x
  if (data.startsWith('0x')) {
    try {
      // Decode hex → utf8
      const bytes = data.slice(2);
      const str = bytes
        .match(/.{1,2}/g)
        ?.map(b => String.fromCharCode(parseInt(b, 16)))
        .join('') ?? '';
      return parseMemoString(str);
    } catch {}
  }

  // Try direct string parsing
  return parseMemoString(data);
}

function parseMemoString(memo: string): string | null {
  if (!memo) return null;

  // SUIAMI prefix
  if (memo.startsWith('suiami:')) {
    const addr = memo.slice(7).trim();
    if (addr.startsWith('0x') && addr.length >= 66) return addr;
  }

  // Raw Sui hex
  const hexMatch = memo.match(/0x[0-9a-fA-F]{64}/);
  if (hexMatch) return hexMatch[0];

  return null;
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export class CrossChainBountyBoard extends Agent<Env, CrossChainBountyBoardState> {
  initialState: CrossChainBountyBoardState = {
    watchAddresses: [],
    payments: [],
    lastSeenByChain: {
      solana: '',
      ethereum: '',
      bitcoin: '',
      base: '',
      polygon: '',
    },
    totalVolumeByChain: {
      solana: '0',
      ethereum: '0',
      bitcoin: '0',
      base: '0',
      polygon: '0',
    },
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

    // Register a Hunter's IKA address for a chain
    if ((url.pathname.endsWith('/register') || url.searchParams.has('register')) && request.method === 'POST') {
      try {
        const params = await request.json() as {
          chain: ChainId;
          address: string;
          curve: BountyWatchAddress['curve'];
        };
        const result = await this.registerBountyAddress(params);
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Status
    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      return new Response(JSON.stringify({
        watchAddresses: this.state.watchAddresses.filter(a => a.active),
        pendingCount: this.state.payments.filter(p => p.status !== 'completed' && p.status !== 'failed').length,
        completedCount: this.state.payments.filter(p => p.status === 'completed').length,
        totalVolumeByChain: this.state.totalVolumeByChain,
        totalSpreadMist: this.state.totalSpreadMist,
        lastPollMs: this.state.lastPollMs,
        ticks: this.state.tickCount,
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Recent payments
    if (url.pathname.endsWith('/payments') || url.searchParams.has('payments')) {
      return new Response(JSON.stringify({
        payments: this.state.payments.slice(-50),
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Start polling
    if (url.pathname.endsWith('/start') || url.searchParams.has('start')) {
      this._scheduleNext(1_000);
      return new Response(JSON.stringify({ started: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    return super.onRequest(request);
  }

  // ─── Core tick ─────────────────────────────────────────────────────────

  private async _tick() {
    this.setState({ ...this.state, tickCount: this.state.tickCount + 1 });

    const activeAddresses = this.state.watchAddresses.filter(a => a.active);
    if (activeAddresses.length === 0) {
      this._scheduleNext(5_000);
      return;
    }

    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    try {
      // Poll all active watch addresses concurrently
      const pollResults = await Promise.allSettled(
        activeAddresses.map(addr => this._pollChain(addr, transport)),
      );

      const newPayments: ChainPayment[] = [];
      for (const result of pollResults) {
        if (result.status === 'fulfilled') {
          newPayments.push(...result.value);
        }
      }

      // Process new + pending orders
      const allPending = [
        ...newPayments,
        ...this.state.payments.filter(
          p => ['pending', 'attesting', 'minting', 'swapping'].includes(p.status)
               && (p.retries ?? 0) < MAX_RETRIES,
        ),
      ];

      for (const payment of allPending) {
        await this._fillOrder(payment, transport);
      }
    } catch (err) {
      console.error('[CrossChainBountyBoard] tick error:', err);
    } finally {
      this._scheduleNext(5_000);
    }

    this.setState({ ...this.state, lastPollMs: Date.now() });
  }

  private _scheduleNext(ms: number) {
    this.ctx.storage.setAlarm(Date.now() + ms);
  }

  // ─── Per-chain polling ─────────────────────────────────────────────────

  private async _pollChain(watchAddr: BountyWatchAddress, transport: SuiGraphQLClient): Promise<ChainPayment[]> {
    switch (watchAddr.chain) {
      case 'solana':
        return this._pollSolana(watchAddr, transport);
      case 'ethereum':
      case 'base':
      case 'polygon':
        return this._pollEvm(watchAddr, transport);
      case 'bitcoin':
        return this._pollBitcoin(watchAddr, transport);
      default:
        return [];
    }
  }

  /** Poll Solana for incoming SOL payments to the watch address. */
  private async _pollSolana(watchAddr: BountyWatchAddress, transport: SuiGraphQLClient): Promise<ChainPayment[]> {
    const config = CHAIN_CONFIGS.solana;
    const seen = new Set(
      this.state.payments.filter(p => p.chain === 'solana').map(p => p.txHash),
    );
    const solUsd = await fetchUsdPrice(transport, 'SOL');
    const LAMPORTS = 1_000_000_000n;

    try {
      const sigs = await solanaRpc<Array<{ signature: string; err: unknown }>>(
        config.rpcUrls,
        'getSignaturesForAddress',
        [watchAddr.address, { limit: 20, commitment: 'confirmed' }],
      );

      if (!sigs || sigs.length === 0) return [];
      const payments: ChainPayment[] = [];

      for (const sig of sigs) {
        if (sig.err || seen.has(sig.signature)) continue;

        const tx = await solanaRpc<any>(config.rpcUrls, 'getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]);
        if (!tx || tx.meta?.err) continue;

        const accounts: string[] = tx.transaction?.message?.accountKeys ?? [];
        const pre: number[] = tx.meta?.preBalances ?? [];
        const post: number[] = tx.meta?.postBalances ?? [];
        const watchIdx = accounts.indexOf(watchAddr.address);
        if (watchIdx < 0) continue;

        const received = BigInt(post[watchIdx] ?? 0) - BigInt(pre[watchIdx] ?? 0);
        if (received <= 0n) continue;

        const usdValue = Number(received) / Number(LAMPORTS) * solUsd;
        if (usdValue < MIN_USD * 0.9) continue;

        // Find sender
        let fromAddress = '';
        for (let i = 0; i < accounts.length; i++) {
          if (i === watchIdx) continue;
          const diff = BigInt(pre[i] ?? 0) - BigInt(post[i] ?? 0);
          if (diff >= received) { fromAddress = accounts[i]; break; }
        }

        // Parse memo
        const memoLog = (tx.meta?.logMessages ?? []).find((m: string) => m.includes('Memo'));
        const memo = memoLog?.replace(/.*Memo \(\d+ bytes\): "?/, '').replace(/"$/, '').trim();
        const suiRecipient = parseMemoString(memo ?? '') ?? '';
        if (!suiRecipient) continue;

        payments.push({
          id: `solana:${sig.signature}`,
          chain: 'solana',
          txHash: sig.signature,
          fromAddress,
          toAddress: watchAddr.address,
          nativeAmount: String(received),
          usdValue: String(usdValue.toFixed(4)),
          suiRecipient,
          detectedAt: Date.now(),
          status: 'pending',
          retries: 0,
        });
      }

      // Persist new payments
      if (payments.length > 0) {
        this.setState({
          ...this.state,
          payments: [...this.state.payments, ...payments],
          lastSeenByChain: { ...this.state.lastSeenByChain, solana: sigs[0]?.signature ?? '' },
        });
      }

      return payments;
    } catch (err) {
      console.error('[CrossChainBountyBoard] Solana poll error:', err);
      return [];
    }
  }

  /** Poll an EVM chain (Ethereum, Base, Polygon) for incoming native payments. */
  private async _pollEvm(watchAddr: BountyWatchAddress, transport: SuiGraphQLClient): Promise<ChainPayment[]> {
    const config = CHAIN_CONFIGS[watchAddr.chain];
    const symbol = config.nativeCurrency;
    const usdPrice = await fetchUsdPrice(transport, symbol);
    const seen = new Set(
      this.state.payments.filter(p => p.chain === watchAddr.chain).map(p => p.txHash),
    );

    try {
      // Get latest block number
      const blockHex = await evmRpc<string>(config.rpcUrls, 'eth_blockNumber', []);
      const latestBlock = parseInt(blockHex, 16);
      const fromBlock = Math.max(0, latestBlock - 100); // scan last ~100 blocks (~25 min on Ethereum)

      // Get transaction logs for the watch address
      const logs = await evmRpc<Array<{
        transactionHash: string;
        blockNumber: string;
        from?: string;
        to?: string;
        value?: string;
        input?: string;
      }>>(config.rpcUrls, 'eth_getLogs', [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: 'latest',
        address: watchAddr.address,
      }]);

      // For native ETH transfers, getLogs won't work — use eth_getTransactionByHash on recent blocks
      // Alternative: use Alchemy/Infura trace API. For public RPCs, we poll recent blocks.
      // Pragmatic approach: fetch the last N block receipts and look for incoming txs.
      const payments: ChainPayment[] = [];

      // Scan last 10 blocks for incoming transactions
      for (let blockNum = latestBlock; blockNum >= Math.max(0, latestBlock - 10); blockNum--) {
        const blockData = await evmRpc<{
          transactions?: Array<{
            hash: string;
            from: string;
            to: string | null;
            value: string;
            input: string;
          }>;
        }>(config.rpcUrls, 'eth_getBlockByNumber', [
          '0x' + blockNum.toString(16),
          true, // include full tx objects
        ]);

        if (!blockData?.transactions) continue;

        for (const tx of blockData.transactions) {
          if (!tx.to || tx.to.toLowerCase() !== watchAddr.address.toLowerCase()) continue;
          if (seen.has(tx.hash)) continue;

          const valueWei = BigInt(tx.value || '0');
          if (valueWei === 0n) continue;

          // Calculate USD value
          const decimals = config.nativeDecimals;
          const nativeAmount = Number(valueWei) / Math.pow(10, decimals);
          const usdValue = nativeAmount * usdPrice;
          if (usdValue < MIN_USD * 0.9) continue;

          // Parse Sui address from input data (EVM memo field)
          const suiRecipient = parseSuiAddress(tx.input) ?? '';
          if (!suiRecipient) continue;

          payments.push({
            id: `${watchAddr.chain}:${tx.hash}`,
            chain: watchAddr.chain,
            txHash: tx.hash,
            fromAddress: tx.from,
            toAddress: watchAddr.address,
            nativeAmount: String(valueWei),
            usdValue: String(usdValue.toFixed(4)),
            suiRecipient,
            detectedAt: Date.now(),
            status: 'pending',
            retries: 0,
          });
        }
      }

      if (payments.length > 0) {
        this.setState({
          ...this.state,
          payments: [...this.state.payments, ...payments],
          lastSeenByChain: {
            ...this.state.lastSeenByChain,
            [watchAddr.chain]: payments[0].txHash,
          },
        });
      }

      return payments;
    } catch (err) {
      console.error(`[CrossChainBountyBoard] ${watchAddr.chain} poll error:`, err);
      return [];
    }
  }

  /** Poll Bitcoin for incoming P2WPKH UTXOs to the watch address. */
  private async _pollBitcoin(watchAddr: BountyWatchAddress, transport: SuiGraphQLClient): Promise<ChainPayment[]> {
    const btcUsd = await fetchUsdPrice(transport, 'BTC');
    const seen = new Set(
      this.state.payments.filter(p => p.chain === 'bitcoin').map(p => p.txHash),
    );

    try {
      // Esplora API: get UTXOs for the address
      const utxos = await fetch(
        `https://blockstream.info/api/address/${watchAddr.address}/txs`,
        { signal: AbortSignal.timeout(8_000) },
      ).then(r => r.json()) as Array<{
        txid: string;
        vout: Array<{
          scriptpubkey_address: string;
          value: number; // satoshis
        }>;
        vin: Array<{
          prevout?: { scriptpubkey_address: string };
        }>;
        status: { confirmed: boolean };
      }>;

      if (!Array.isArray(utxos)) return [];

      const payments: ChainPayment[] = [];

      for (const tx of utxos) {
        if (!tx.status?.confirmed) continue; // wait for confirmation
        if (seen.has(tx.txid)) continue;

        // Find outputs to our watch address
        for (const out of tx.vout) {
          if (out.scriptpubkey_address !== watchAddr.address) continue;

          const satoshis = out.value;
          const btcAmount = satoshis / 1e8;
          const usdValue = btcAmount * btcUsd;
          if (usdValue < MIN_USD * 0.9) continue;

          // Find sender (first input address)
          const fromAddress = tx.vin[0]?.prevout?.scriptpubkey_address ?? '';

          // Parse OP_RETURN for Sui address
          // Fetch raw tx for OP_RETURN data
          let suiRecipient = '';
          try {
            const rawTx = await fetch(
              `https://blockstream.info/api/tx/${tx.txid}`,
              { signal: AbortSignal.timeout(5_000) },
            ).then(r => r.json()) as {
              vout?: Array<{ scriptpubkey: string; scriptpubkey_type: string }>;
            };
            for (const vout of rawTx.vout ?? []) {
              if (vout.scriptpubkey_type === 'op_return') {
                // OP_RETURN data: 6a{len}{data}
                const data = vout.scriptpubkey.slice(4); // strip OP_RETURN opcode + length
                try {
                  const text = Buffer.from(data, 'hex').toString('utf8');
                  suiRecipient = parseMemoString(text) ?? '';
                } catch {}
              }
            }
          } catch {}

          if (!suiRecipient) continue;

          payments.push({
            id: `bitcoin:${tx.txid}`,
            chain: 'bitcoin',
            txHash: tx.txid,
            fromAddress,
            toAddress: watchAddr.address,
            nativeAmount: String(satoshis),
            usdValue: String(usdValue.toFixed(4)),
            suiRecipient,
            detectedAt: Date.now(),
            status: 'pending',
            retries: 0,
          });
          break; // one output per tx to our address is enough
        }
      }

      if (payments.length > 0) {
        this.setState({
          ...this.state,
          payments: [...this.state.payments, ...payments],
          lastSeenByChain: {
            ...this.state.lastSeenByChain,
            bitcoin: payments[0].txHash,
          },
        });
      }

      return payments;
    } catch (err) {
      console.error('[CrossChainBountyBoard] Bitcoin poll error:', err);
      return [];
    }
  }

  // ─── Order fill pipeline ───────────────────────────────────────────────

  private async _fillOrder(payment: ChainPayment, transport: SuiGraphQLClient): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

    const updatePayment = (updates: Partial<ChainPayment>) => {
      this.setState({
        ...this.state,
        payments: this.state.payments.map(p =>
          p.id === payment.id ? { ...p, ...updates } : p,
        ),
      });
      Object.assign(payment, updates);
    };

    try {
      const config = CHAIN_CONFIGS[payment.chain];
      const usdPrice = await fetchUsdPrice(transport, config.nativeCurrency);

      // ── Attest collateral ─────────────────────────────────────────────

      if (payment.status === 'pending') {
        updatePayment({ status: 'attesting' });

        const nativeAmount = BigInt(payment.nativeAmount);
        const decimals = BigInt(Math.pow(10, config.nativeDecimals));
        const collateralMist = nativeAmount * BigInt(Math.floor(usdPrice * 1e9)) / decimals;

        const tx1 = new Transaction();
        tx1.setSender(keeperAddr);
        tx1.moveCall({
          package: IUSD_PKG,
          module: 'iusd',
          function: 'update_collateral',
          arguments: [
            tx1.object(IUSD_TREASURY),
            tx1.pure.vector('u8', Array.from(new TextEncoder().encode(config.nativeCurrency))),
            tx1.pure.vector('u8', Array.from(new TextEncoder().encode(payment.chain))),
            tx1.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
            tx1.pure.u64(collateralMist),
            tx1.pure.u8(0),
            tx1.object('0x6'),
          ],
        });

        const bytes1 = await tx1.build({ client: transport as never });
        const sig1 = await keypair.signTransaction(bytes1);
        const attestDigest = await this._submitTx(bytes1, sig1.signature);
        updatePayment({ attestDigest, status: 'minting' });
        console.log(`[CrossChainBountyBoard] ${payment.chain} collateral attested: ${attestDigest}`);
      }

      // ── Mint iUSD ─────────────────────────────────────────────────────

      if (payment.status === 'minting') {
        // Mint $7.50 worth of iUSD (9 decimals)
        const mintAmountMist = BigInt(Math.floor(MIN_USD * 1e9));

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
            tx2.pure.address(keeperAddr),
          ],
        });

        const bytes2 = await tx2.build({ client: transport as never });
        const sig2 = await keypair.signTransaction(bytes2);
        const mintDigest = await this._submitTx(bytes2, sig2.signature);
        updatePayment({ mintDigest, status: 'swapping' });
        console.log(`[CrossChainBountyBoard] iUSD minted: ${mintDigest}`);
      }

      // ── Swap iUSD → NS via DeepBook + deliver ─────────────────────────

      if (payment.status === 'swapping') {
        const tx3 = new Transaction();
        tx3.setSender(keeperAddr);

        // SUI → NS via DeepBook (25% NS discount path)
        const suiForNs = 750_000_000n; // ~0.75 SUI — adjusted dynamically in production

        const [nsCoin, suiChange, deepChange] = tx3.moveCall({
          target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [NS_TYPE, SUI_TYPE],
          arguments: [
            tx3.sharedObjectRef({
              objectId: DB_NS_SUI_POOL,
              initialSharedVersion: DB_NS_SUI_POOL_ISV,
              mutable: true,
            }),
            tx3.splitCoins(tx3.gas, [tx3.pure.u64(suiForNs)]),
            tx3.moveCall({
              target: '0x2::coin::zero',
              typeArguments: [DB_DEEP_TYPE],
            })[0],
            tx3.pure.u64(0),
            tx3.object('0x6'),
          ],
        });

        // Deliver NS directly to user's Sui address
        tx3.transferObjects([nsCoin], tx3.pure.address(normalizeSuiAddress(payment.suiRecipient)));
        tx3.transferObjects([suiChange, deepChange], tx3.pure.address(keeperAddr));

        const bytes3 = await tx3.build({ client: transport as never });
        const sig3 = await keypair.signTransaction(bytes3);
        const swapDigest = await this._submitTx(bytes3, sig3.signature);

        // Calculate spread
        const usdValue = parseFloat(payment.usdValue);
        const spreadUsd = Math.max(0, usdValue - MIN_USD);
        const spreadMist = BigInt(Math.floor(spreadUsd * 1e9));

        const prevVolumeStr = this.state.totalVolumeByChain[payment.chain] ?? '0';
        const prevVolume = parseFloat(prevVolumeStr);
        const prevSpread = BigInt(this.state.totalSpreadMist);

        updatePayment({
          swapDigest,
          status: 'completed',
          completedAt: Date.now(),
          spreadMist: String(spreadMist),
        });

        this.setState({
          ...this.state,
          totalVolumeByChain: {
            ...this.state.totalVolumeByChain,
            [payment.chain]: String((prevVolume + usdValue).toFixed(4)),
          },
          totalSpreadMist: String(prevSpread + spreadMist),
        });

        console.log(`[CrossChainBountyBoard] ${payment.chain} order complete: ${swapDigest} → ${payment.suiRecipient}, spread $${spreadUsd.toFixed(4)}`);
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      const retries = (payment.retries ?? 0) + 1;
      console.error(`[CrossChainBountyBoard] Fill error (${payment.id}, attempt ${retries}):`, errStr);

      if (retries >= MAX_RETRIES) {
        updatePayment({ status: 'failed', lastError: errStr, retries });
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)];
        updatePayment({ status: 'pending', lastError: errStr, retries });
        this._scheduleNext(delay);
      }
    }
  }

  // ─── Callable endpoints ────────────────────────────────────────────────

  /** Register a Hunter's IKA dWallet address for a chain. */
  @callable()
  async registerBountyAddress(params: {
    chain: ChainId;
    address: string;
    curve: BountyWatchAddress['curve'];
  }): Promise<{ success: boolean; message: string }> {
    const { chain, address, curve } = params;
    if (!chain || !address || !curve) {
      return { success: false, message: 'Missing chain, address, or curve' };
    }
    if (!CHAIN_CONFIGS[chain]) {
      return { success: false, message: `Unknown chain: ${chain}` };
    }

    // Deactivate any existing address for this chain
    const updated = this.state.watchAddresses.map(a =>
      a.chain === chain ? { ...a, active: false } : a,
    );

    const entry: BountyWatchAddress = {
      chain,
      address,
      curve,
      active: true,
      registeredAt: Date.now(),
    };

    this.setState({
      ...this.state,
      watchAddresses: [...updated, entry],
    });

    // Start polling immediately
    this._scheduleNext(1_000);

    return {
      success: true,
      message: `Watching ${chain} address ${address} (${curve})`,
    };
  }

  @callable()
  async getStatus(): Promise<CrossChainBountyBoardState> {
    return this.state;
  }

  @callable()
  async getBountyBoard(): Promise<{
    chains: Array<{
      chain: ChainId;
      name: string;
      address: string;
      bountyUsd: number;
      currency: string;
      active: boolean;
    }>;
    totalSpreadMist: string;
    recentFills: ChainPayment[];
  }> {
    const activeChains = this.state.watchAddresses
      .filter(a => a.active)
      .map(a => ({
        chain: a.chain,
        name: CHAIN_CONFIGS[a.chain].name,
        address: a.address,
        bountyUsd: CHAIN_CONFIGS[a.chain].bountyUsd,
        currency: CHAIN_CONFIGS[a.chain].nativeCurrency,
        active: a.active,
      }));

    const recentFills = this.state.payments
      .filter(p => p.status === 'completed')
      .slice(-20);

    return {
      chains: activeChains,
      totalSpreadMist: this.state.totalSpreadMist,
      recentFills,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async _submitTx(txBytes: Uint8Array, signature: string): Promise<string> {
    const b64 = btoa(String.fromCharCode(...txBytes));
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  }
}
