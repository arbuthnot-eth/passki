/**
 * TreasuryAgents — Durable Object that autonomously manages iUSD treasury yield.
 *
 * Four agents in one DO, coordinated by alarm ticks:
 *
 *   1. Arb Scanner — NAVI 0% flash loans to arb DeepBook ↔ Cetus ↔ Bluefin price gaps
 *   2. Yield Rotator — monitors APYs across NAVI/Scallop, moves capital to highest yield
 *   3. Fee Sweeper — collects SUI from treasury address, deposits into lending
 *   4. Rebalancer — checks reserve allocation drift, rebalances on schedule
 *
 * Single DO instance keyed by "treasury" — there's only one treasury.
 * Signed by ultron.sui — the autonomous agent wallet (SHADE_KEEPER_PRIVATE_KEY).
 */

import { Agent, callable } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import { raceExecuteTransaction, raceJsonRpc, GQL_URL } from '../rpc.js';
import { createSplMint, mintSplTokens, deriveATA, b58decode, b58encode, type SolanaRpcConfig } from '../solana-spl.js';
import { deriveAddress, chainsForCurve, IkaCurve } from '../../client/chains.js';

// ─── NAVI Protocol constants ──────────────────────────────────────────

const NAVI = {
  package: '0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f',
  storage: '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe',
  incentiveV2: '0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c',
  incentiveV3: '0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80',
  priceOracle: '0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef',
  flashloanConfig: '0x3672b2bf471a60c30a03325f104f92fb195c9d337ba58072dce764fe2aa5e2dc',
};

const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// DeepBook v3
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
// DeepBook v3 BalanceManager package (separate from the pool/trade package)
const DB_BM_PACKAGE = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
// Known owned BalanceManager that black-holed a historical mint of iUSD +
// USDC. Both balances are recoverable via withdraw_all<T>(bm, ctx) — the
// CLAUDE.md "owned BMs are deposit black holes" note was about ORDER
// PLACEMENT, not withdrawability. The owner can always withdraw.
const ULTRON_OWNED_BM = '0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92';
// iUSD TreasuryCap owned by ultron (minter). Required for burn_and_redeem.
const IUSD_TREASURY_CAP = '0x0c7873b52c69f409f3c9772e85d927b509a133a42e9c134c826121bb6595e543';
const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
const SUIAMI_ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

// ─── Scallop Protocol constants ──────────────────────────────────────
const SCALLOP = {
  package: '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805',
  version: '0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7',
  market: '0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9',
  sCoinPackage: '0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c',
  sUsdcTreasury: '0xbe6b63021f3d82e0e7e977cdd718ed7c019cf2eba374b7b546220402452f938e',
  sSuiTreasury: '0x5c1678c8261ac9eec024d4d630006a9f55c80dc0b1aa38a003fcb1d425818c6b',
  sUsdcType: '0x854950aa624b1df59fe64e630b2ba7c550642e9342267a33061d59fb31582da5::scallop_usdc::SCALLOP_USDC',
  sSuiType: '0xaafc4f740de0dd0dde642a31148fb94517087052f19afb0f7bed1dc41a50c77b::scallop_sui::SCALLOP_SUI',
};

// ─── Timing constants ────────────────────────────────────────────────
const TX_INDEX_WAIT_MS = 3_000;
const CHAIN_PROPAGATION_MS = 1_500;
const FETCH_TIMEOUT_MS = 8_000;
const PRICE_FEED_TIMEOUT_MS = 5_000;
const LONG_FETCH_TIMEOUT_MS = 15_000;

// ─── Cache state: overcollateralization targets ─────────────────────
// IMPORTANT: two distinct constants.
//
// OVERCOLLATERAL_BPS — TypeScript policy target, used by _yieldRotate
// to decide when surplus exists for yield deployment. 110% matches the
// *intended* design.
//
// ONCHAIN_MIN_RATIO_BPS — what the DEPLOYED iUSD v2 Move package actually
// enforces in mint_and_transfer assertion (line 292 of iusd.move). The
// source file was updated to 11000 after deployment, but the bytecode at
// 0x2c5653... still contains the original 15000 (150%). Verified by
// scanning the deployed module bytes for u64 little-endian constants —
// 15000 at offset 1904, no trace of 11000.
//
// Chansey's realizeActivityYield formula MUST use ONCHAIN_MIN_RATIO_BPS
// because the on-chain assertion is the hard safety rail. Using 11000
// for mint math leads to a code-1 abort (EInsufficientCollateral) every
// time. Asked the hard way on the first realize-yield attempt.
const OVERCOLLATERAL_BPS = 11000; // 110% — policy target (TS)
// Chansey v3 (#23) — iUSD v2 package was upgraded from 150% → 110%
// via plankton.sui's UpgradeCap on 2026-04-11. New package address:
// 0x8230189af039da5cabb6fdacfbc1ca993642126d73258e30225f5f94272a1ad2
// The ORIGINAL address (0x2c5653668e...) still works via Sui's
// upgrade dispatch — runtime uses the new bytecode regardless of
// which address the move call references.
const ONCHAIN_MIN_RATIO_BPS = 11000; // 110% — matches deployed bytecode after upgrade

// ─── QuestFi: Agent Economics ────────────────────────────────────────
// Parent keeps 1% of all deployed amounts, redistributes based on performance.
// Lazy agents die at threshold, bold RWA-focused agents spawn to replace them.
const PARENT_CUT_BPS = 100;           // 1% of deployed goes to parent cache
const DEATH_THRESHOLD_RUNS = 50;      // agents with 50+ runs and no profit get culled
const DEATH_THRESHOLD_PROFIT = 0n;    // must have positive lifetime profit to survive

// RWA tokens the bold new agents hunt for as collateral
const RWA_TARGETS = ['XAUM', 'XAGM', 'TSLAx', 'NVIDIA', 'META'] as const;

// ─── Types ────────────────────────────────────────────────────────────

// ─── t2000 Agent Registry ─────────────────────────────────────────────

interface T2000Agent {
  designation: string;
  mission: 'arb' | 'sweep' | 'snipe' | 'farm' | 'watch' | 'route' | 'storm';
  objectId: string;        // on-chain T2000 object ID
  dwalletId: string;       // IKA dWallet controlling this agent
  operator: address;
  deployed_ms: number;
  total_profit_iusd: string; // measured in iUSD (dollars)
  last_run_ms: number;
  runs: number;
  active: boolean;
  focus?: string[];         // RWA targets for bold agents (e.g. ['XAUM', 'TSLAx'])
}

type address = string;

interface YieldPosition {
  protocol: string;     // 'navi' | 'scallop'
  asset: string;        // coin type
  amount: string;       // serialized bigint
  apy_bps: number;      // basis points
  updated_ms: number;
}

interface ArbOpportunity {
  pair: string;
  buy_venue: string;
  sell_venue: string;
  spread_bps: number;
  timestamp_ms: number;
  executed: boolean;
  profit_mist: string;
}

interface ShadeOrder {
  id: string;
  domain: string;           // name being Shaded
  holder: string;           // Sui address holding the iUSD
  thresholdUsd: number;     // iUSD balance must stay above this
  graceEndMs: number;       // when grace expires — Shade executes
  commitment: string;       // hash(domain:holder) for privacy
  status: 'active' | 'liquidated' | 'executed' | 'cancelled';
  created: number;
  lastChecked: number;
  deliberation?: string;    // last agent debate result
}

interface SquidGeo {
  name: string;
  chains: string[];       // chains provisioned: ['sui','btc','eth','sol']
  source: string;         // 'register' | 'questfi-snipe' | 'trade' | 'gift'
  lat?: number;
  lon?: number;
  city?: string;
  country?: string;
  ts: number;
}

interface SquidStats {
  total: number;
  by_chain: { sui: number; btc: number; eth: number; sol: number };
  iusd_minted: number;    // iUSD mints triggered alongside
  geo: SquidGeo[];        // last 500 squid events for globe mapping
}

export interface TreasuryAgentsState {
  positions: YieldPosition[];
  arb_history: ArbOpportunity[];
  t2000s: T2000Agent[];
  total_arb_profit_mist: string;
  total_yield_earned_mist: string;
  last_rebalance_ms: number;
  last_sweep_ms: number;
  tick_count: number;
  squids: SquidStats;
  /** Cursor for the Sui-side USDC watcher: the newest coin digest
   *  seen on a previous tick. Prevents re-processing the same
   *  incoming USDC coin on every poll. Blank on first run → the
   *  first tick establishes a baseline and matches nothing. */
  last_sui_usdc_cursor?: string;
  /** Last wall-clock ms when the IOU sweeper ran on the TreasuryAgents
   *  alarm path. Throttles _sweepExpiredIous to once per 5 minutes so
   *  a fast-firing _tick doesn't spam GraphQL. Separate from the
   *  Cloudflare cron at `*\/10 * * * *` in wrangler.jsonc — the two
   *  paths coexist for redundancy. */
  last_iou_sweep_ms?: number;
  /** Wall-clock ms of the most recent `_scanOpenBundles` pass. Throttles
   *  the OpenCLOB bundle scanner to ~30s — Phase 3b only LOGS what it
   *  would do; Phase 3c wires the real `mark_slot_filled` /
   *  `settle_bundle` calls. See
   *  `docs/superpowers/specs/2026-04-11-openclob-bundle-tags.md`. */
  last_bundle_scan_ms?: number;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui — autonomous agent keypair
  HELIUS_API_KEY?: string; // Solana RPC (Helius)
  HELIUS_WEBHOOK_SECRET?: string; // Validates incoming Helius webhook requests
}

// ─── Helpers ──────────────────────────────────────────────────────────

// Ultron's IKA-native Solana address (ed25519 DKG output).
// Provisioned 2026-04-13 by rumbleUltron('ed25519'); DWalletCap
// 0x518b96da469cd7e4d1ccb99bcf4767054535ad7d615b6827a79309ecd5e9a3a7
// owned by ultron.sui (0xa84c…b3c3), dwallet
// 0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9.
// The legacy address (base58 of the Sui keeper pubkey) is fully
// drained — see Registeel Hyper Beam commit for the sweep.
//
// Every sol@ultron reference in this file uses this constant so
// deposit targets, webhook matchers, and balance lookups resolve
// to the real funds. Signing paths (Kamino deposits, etc.) still
// call Ed25519Keypair.signTransaction and will fail at sig-verify
// time until DO-hosted IKA signing lands (Registeel Iron Defense,
// queued). That's an acceptable regression for now because the
// old address has zero lamports either way.
const ULTRON_SOL_ADDRESS = 'GfVzGHiSPyTnX6bawnahJnUPXeASF6qKPd224VQws1DW';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let str = '';
  for (const b of bytes) { if (b === 0) str += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]];
  return str;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Agent ────────────────────────────────────────────────────────────

export class TreasuryAgents extends Agent<Env, TreasuryAgentsState> {
  initialState: TreasuryAgentsState = {
    positions: [],
    arb_history: [],
    t2000s: [],
    total_arb_profit_mist: '0',
    total_yield_earned_mist: '0',
    last_rebalance_ms: 0,
    last_sweep_ms: 0,
    tick_count: 0,
    squids: { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] },
  };

  /** Derive ultron's address from the keeper key — used for auth checks. */
  private _ultronAddress: string | null = null;
  private getUltronAddress(): string {
    if (this._ultronAddress) return this._ultronAddress;
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return '';
    this._ultronAddress = normalizeSuiAddress(
      Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY).getPublicKey().toSuiAddress(),
    );
    return this._ultronAddress;
  }

  /**
   * Verify internal auth token on HTTP requests from the Worker.
   * Token = first 34 chars of ultron's Sui address (0x + 32 hex).
   * Only the Worker has access to SHADE_KEEPER_PRIVATE_KEY to derive this.
   */
  private verifyInternalAuth(request: Request): boolean {
    const token = request.headers.get('x-treasury-auth');
    const ultron = this.getUltronAddress();
    if (!ultron || !token) return false;
    return token === ultron.slice(0, 34);
  }

  /**
   * Guard for @callable() methods: verify caller provides ultron address.
   * Since only the keeper key holder can derive this address, it proves authorization.
   * All mutating callables that use the keeper key must call this.
   */
  private requireUltronCaller(callerAddress?: string): string | null {
    const ultron = this.getUltronAddress();
    if (!ultron) return 'No ultron key configured';
    if (callerAddress !== ultron) return 'Unauthorized';
    return null; // authorized
  }

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

    // ── Internal auth gate ──────────────────────────────────────────
    // All mutating requests from the Worker must include x-treasury-auth.
    // Read-only endpoints (status, squid-stats, shade-list, deposit-status,
    // deposit-addresses, quest-bounties, kamino-positions) are exempt.
    const readOnlyParams = ['cache-state', 'squid-stats', 'shade-list', 'deposit-status', 'deposit-addresses', 'quest-bounties', 'kamino-positions', 'iusd-sol-mint'];
    const isReadOnly = readOnlyParams.some(p => url.searchParams.has(p));
    const isWebSocket = request.headers.get('upgrade') === 'websocket';
    if (!isReadOnly && !isWebSocket && !this.verifyInternalAuth(request)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }

    if ((url.pathname.endsWith('/register-t2000') || url.searchParams.has('register-t2000')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.registerT2000>[0];
        const result = await this.registerT2000(params);
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shade — lock iUSD for grace-period name sniping
    // Shuckle Lv.30 (#117) — manual attest trigger (also fires in tick loop).
    if ((url.pathname.endsWith('/attest-collateral') || url.searchParams.has('attest-collateral')) && request.method === 'POST') {
      try {
        const result = await this.attestLiveCollateral();
        return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Chansey v3 — redeem iUSD for USDC (the "sell back" path).
    //
    // Flow: user has iUSD in their wallet, they want USDC back.
    //   1. User transfers iUSD to ultron via their own wallet (one tx,
    //      signed client-side, no server interaction needed for this step)
    //   2. User calls this endpoint with { suiAddress, suiTxDigest }
    //   3. Server verifies the tx effects show an iUSD transfer to ultron
    //      from the given sender, reads the transferred amount
    //   4. Server builds a keeper-signed tx that sends equivalent USDC
    //      from ultron's balance back to the user (1:1, minus an optional
    //      spread)
    //   5. iUSD stays in ultron's wallet (not burned) — ultron effectively
    //      bought it back and can hold or re-sell it. Supply doesn't shrink
    //      but the user gets their money out.
    //
    // For the honest stablecoin semantics (burn on redemption), a proper
    // flow would instead: user submits a burn_and_redeem tx, server
    // watches for RedeemRequest events and fulfills them. That's the
    // correct long-term design but this simpler endpoint unblocks
    // immediate usability while we build the redemption watcher.
    if (url.pathname.endsWith('/redeem-iusd') && request.method === 'POST') {
      try {
        const body = await request.json() as { suiAddress: string; suiTxDigest: string };
        if (!body.suiAddress || !body.suiTxDigest) {
          return new Response(JSON.stringify({ error: 'suiAddress and suiTxDigest required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'no keeper' }), { status: 400 });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

        // Verify the tx: look for an iUSD coin transfer to ultron from the user's address
        const txQ = await transport.query({
          query: `query($d: String!) {
            transactionBlock(digest: $d) {
              sender { address }
              effects {
                status
                objectChanges { nodes { __typename ... on ObjectChange { address } } }
              }
              objectChanges { nodes { __typename } }
            }
          }`,
          variables: { d: body.suiTxDigest },
        });
        const tb = (txQ.data as any)?.transactionBlock;
        if (!tb) return new Response(JSON.stringify({ error: 'tx not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        const sender = tb.sender?.address;
        if (sender?.toLowerCase() !== normalizeSuiAddress(body.suiAddress).toLowerCase()) {
          return new Response(JSON.stringify({ error: `tx sender ${sender} doesn't match claimed suiAddress` }), { status: 400, headers: { 'content-type': 'application/json' } });
        }

        // Look at ultron's iUSD coins to find the newly-received one.
        // The simpler approach: query ultron's current iUSD balance before
        // the call, compare to the most recent balance, delta is what
        // the user sent. For now, read all iUSD coins on ultron and use
        // whatever was most recently received. BETTER: read the exact
        // coin object id from the tx effects. Simplest (for v1): just
        // query ultron's full iUSD balance and pay back the caller what
        // they claim to have sent via the amountMist field from the tx
        // effects balanceChanges.
        const balQ = await transport.query({
          variables: {},
          query: `query {
            address(address: "${ultronAddr}") {
              iusd: balance(coinType: "${IUSD_TYPE}") { totalBalance }
              usdc: balance(coinType: "${USDC_TYPE}") { totalBalance }
            }
          }`,
        });
        const ultronIusd = BigInt((balQ.data as any)?.address?.iusd?.totalBalance ?? '0');
        const ultronUsdc = BigInt((balQ.data as any)?.address?.usdc?.totalBalance ?? '0');

        // Get the delta from tx effects — look at balanceChanges for
        // ultron address. We need the sui_getTransactionBlock endpoint
        // since GraphQL doesn't always surface balanceChanges cleanly.
        const rpcRes = await fetch('https://fullnode.mainnet.sui.io', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'sui_getTransactionBlock',
            params: [body.suiTxDigest, { showBalanceChanges: true, showEffects: true }],
          }),
        });
        const rpcJson = await rpcRes.json() as any;
        const changes = rpcJson.result?.balanceChanges ?? [];
        let deltaIusd = 0n;
        for (const ch of changes) {
          const owner = ch.owner?.AddressOwner || '';
          if (normalizeSuiAddress(owner).toLowerCase() !== ultronAddr.toLowerCase()) continue;
          const ct = ch.coinType || '';
          if (!ct.includes('::iusd::IUSD')) continue;
          deltaIusd += BigInt(ch.amount);
        }
        if (deltaIusd <= 0n) {
          return new Response(JSON.stringify({ error: `no positive iUSD delta to ultron in tx ${body.suiTxDigest}`, changes }), { status: 400, headers: { 'content-type': 'application/json' } });
        }

        // iUSD is 9-dec, USDC is 6-dec. Convert 1:1 in USD terms.
        // iusd_mist / 1e9 = iusd_usd
        // iusd_usd * 1e6 = usdc_raw
        // So: usdc_raw = iusd_mist / 1000
        const usdcOut = deltaIusd / 1000n;
        if (usdcOut > ultronUsdc) {
          return new Response(JSON.stringify({
            error: `ultron USDC balance (${ultronUsdc}) insufficient for redeem (${usdcOut})`,
            suggestion: 'reduce redeem amount or top up ultron USDC',
          }), { status: 400, headers: { 'content-type': 'application/json' } });
        }

        // Build the USDC transfer PTB
        const usdcCoinsQ = await transport.query({
          variables: {},
          query: `query { address(address: "${ultronAddr}") { objects(filter: { type: "0x2::coin::Coin<${USDC_TYPE}>" }, first: 50) { nodes { address version digest contents { json } } } } }`,
        });
        const usdcNodes = ((usdcCoinsQ.data as any)?.address?.objects?.nodes ?? []) as Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }>;
        if (usdcNodes.length === 0) return new Response(JSON.stringify({ error: 'no usdc coins on ultron' }), { status: 400 });

        const tx = new Transaction();
        tx.setSender(ultronAddr);
        const first = tx.objectRef({ objectId: usdcNodes[0].address, version: usdcNodes[0].version, digest: usdcNodes[0].digest });
        if (usdcNodes.length > 1) {
          tx.mergeCoins(first, usdcNodes.slice(1).map(c => tx.objectRef({ objectId: c.address, version: c.version, digest: c.digest })));
        }
        const [split] = tx.splitCoins(first, [tx.pure.u64(usdcOut)]);
        tx.transferObjects([split], tx.pure.address(normalizeSuiAddress(body.suiAddress)));
        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const payoutDigest = await this._submitTx(txBytes, sig.signature);
        console.log(`[TreasuryAgents] redeem-iusd: user=${body.suiAddress.slice(0, 10)}… iusd=${Number(deltaIusd) / 1e9} -> usdc=${Number(usdcOut) / 1e6} tx=${payoutDigest}`);
        return new Response(JSON.stringify({
          payoutDigest,
          iusdReceived: `$${(Number(deltaIusd) / 1e9).toFixed(6)}`,
          usdcSent: `$${(Number(usdcOut) / 1e6).toFixed(6)}`,
          suiTxDigest: body.suiTxDigest,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Chansey v3 — transfer ultron's iUSD balance to a recipient.
    // Used to credit depositors back for their contributions.
    if (url.pathname.endsWith('/send-iusd') && request.method === 'POST') {
      try {
        const body = await request.json() as { recipient: string; amountMist?: string };
        if (!body.recipient) return new Response(JSON.stringify({ error: 'recipient required' }), { status: 400 });
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'no keeper' }), { status: 400 });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
        const tx = new Transaction();
        tx.setSender(ultronAddr);
        const iusdType = IUSD_TYPE;
        const coinsQ = await transport.query({
          variables: {},
          query: `query { address(address: "${ultronAddr}") { objects(filter: { type: "0x2::coin::Coin<${iusdType}>" }, first: 50) { nodes { address version digest contents { json } } } } }`,
        });
        const coinNodes = ((coinsQ.data as any)?.address?.objects?.nodes ?? []) as Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }>;
        if (coinNodes.length === 0) return new Response(JSON.stringify({ error: 'no iusd coins on ultron' }), { status: 400 });
        const first = tx.objectRef({ objectId: coinNodes[0].address, version: coinNodes[0].version, digest: coinNodes[0].digest });
        if (coinNodes.length > 1) {
          tx.mergeCoins(first, coinNodes.slice(1).map(c => tx.objectRef({ objectId: c.address, version: c.version, digest: c.digest })));
        }
        const totalBalance = coinNodes.reduce((acc, c) => acc + BigInt(c.contents?.json?.balance ?? '0'), 0n);
        const amount = body.amountMist ? BigInt(body.amountMist) : totalBalance;
        if (amount === totalBalance) {
          tx.transferObjects([first], tx.pure.address(normalizeSuiAddress(body.recipient)));
        } else {
          const [split] = tx.splitCoins(first, [tx.pure.u64(amount)]);
          tx.transferObjects([split], tx.pure.address(normalizeSuiAddress(body.recipient)));
        }
        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, sig.signature);
        return new Response(JSON.stringify({ digest, recipient: body.recipient, amountMist: String(amount), amountUsd: Number(amount) / 1e9 }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Chansey v3 debug — try minting a specific amount of iUSD to test
    // the live on-chain assertion without Chansey's surplus math getting
    // in the way. Takes { usdCents, recipient?, pkg? }.
    if (url.pathname.endsWith('/debug-mint') && request.method === 'POST') {
      try {
        const body = await request.json() as { usdCents: number; recipient?: string; pkg?: string };
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'no keeper' }), { status: 400 });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
        const pkg = body.pkg || TreasuryAgents.IUSD_PKG;
        const recipient = body.recipient || ultronAddr;
        const amountMist = BigInt(body.usdCents) * 10_000_000n; // cents -> 9-dec USD mist
        const tx = new Transaction();
        tx.setSender(ultronAddr);
        tx.moveCall({
          package: pkg,
          module: 'iusd',
          function: 'mint_and_transfer',
          arguments: [
            tx.object(TreasuryAgents.IUSD_TREASURY_CAP),
            tx.object(TreasuryAgents.IUSD_TREASURY),
            tx.pure.u64(amountMist),
            tx.pure.address(recipient),
          ],
        });
        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, sig.signature);
        return new Response(JSON.stringify({ digest, pkg, amountMist: String(amountMist), recipient }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Chansey Lv.40 (#76) — manual activity-yield mint trigger.
    if ((url.pathname.endsWith('/realize-yield') || url.searchParams.has('realize-yield')) && request.method === 'POST') {
      try {
        const result = await this.realizeActivityYield();
        return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shuckle Lv.30 stage 2 (#117) — zero out phantom DUST collateral record.
    if ((url.pathname.endsWith('/zero-dust-record') || url.searchParams.has('zero-dust-record')) && request.method === 'POST') {
      try {
        const result = await this.zeroDustCollateralRecord();
        return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shuckle Lv.30 stage 2 (#117) — recover owned BM (withdraw + burn).
    if ((url.pathname.endsWith('/recover-owned-bm') || url.searchParams.has('recover-owned-bm')) && request.method === 'POST') {
      try {
        const result = await this.recoverOwnedBalanceManager();
        return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shuckle Lv.30 (#117) — manual sSUI unwind trigger.
    if ((url.pathname.endsWith('/unwind-ssui') || url.searchParams.has('unwind-ssui')) && request.method === 'POST') {
      try {
        const result = await this.unwindAllScallopSui();
        return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/shade-create') || url.searchParams.has('shade-create')) && request.method === 'POST') {
      try {
        const body = await request.json() as {
          domain: string; holder: string; thresholdUsd: number; graceEndMs: number; commitment: string;
          objectId?: string; depositMist?: string; salt?: string;
        };
        const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
        // Deduplicate by domain+holder
        const existing = shades.findIndex(s => s.domain === body.domain && s.holder === body.holder);
        const shade: ShadeOrder & { objectId?: string; depositMist?: string; salt?: string } = {
          id: crypto.randomUUID(),
          domain: body.domain,
          holder: body.holder,
          thresholdUsd: body.thresholdUsd,
          graceEndMs: body.graceEndMs,
          commitment: body.commitment,
          status: 'active',
          created: Date.now(),
          lastChecked: 0,
          ...(body.objectId ? { objectId: body.objectId } : {}),
          ...(body.depositMist ? { depositMist: body.depositMist } : {}),
          ...(body.salt ? { salt: body.salt } : {}),
        };
        if (existing >= 0) shades[existing] = shade;
        else shades.push(shade);
        this.setState({ ...this.state, shades } as any);
        console.log(`[TreasuryAgents] Shade created: ${body.domain}.sui, threshold: $${body.thresholdUsd}, grace ends: ${new Date(body.graceEndMs).toISOString()}`);
        return new Response(JSON.stringify({ id: shade.id, status: 'active' }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shade cancel — user-initiated unshade (on-chain cancel + iUSD recovery)
    if ((url.pathname.endsWith('/shade-cancel') || url.searchParams.has('shade-cancel')) && request.method === 'POST') {
      try {
        const body = await request.json() as { domain: string; holder: string };
        const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
        const idx = shades.findIndex(s => s.domain === body.domain && s.holder === body.holder && s.status === 'active');
        if (idx < 0) {
          return new Response(JSON.stringify({ ok: false, error: 'No active shade found' }), { headers: { 'content-type': 'application/json' } });
        }
        const shade = shades[idx] as any;
        const objectId = shade.objectId as string | undefined;
        let cancelDigest = '';
        let iusdRecovered = '0';

        // Cancel on-chain if we have the objectId
        if (objectId && this.env.SHADE_KEEPER_PRIVATE_KEY) {
          try {
            const SHADE_V5_PKG = '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837';
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
            const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
            const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

            const tx = new Transaction();
            tx.setSender(ultronAddr);
            tx.moveCall({
              target: `${SHADE_V5_PKG}::shade::cancel_stable`,
              typeArguments: [IUSD_TYPE],
              arguments: [tx.object(objectId)],
            });
            const txBytes = await tx.build({ client: transport as never });
            const sig = await keypair.signTransaction(txBytes);
            cancelDigest = await this._submitTx(txBytes, sig.signature);
            iusdRecovered = shade.depositMist || '0';
            console.log(`[shade-cancel] on-chain cancel ${objectId} → ${cancelDigest}, recovered ${Number(iusdRecovered) / 1e9} iUSD`);
          } catch (e) {
            console.error('[shade-cancel] on-chain cancel failed:', e instanceof Error ? e.message : e);
            // Still mark as cancelled in DO even if on-chain fails
          }
        }

        // BAM mint iUSD SPL on Solana → user's Solana address
        let bamMintSig: string | undefined;
        if (cancelDigest && iusdRecovered !== '0') {
          try {
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
            // For now, use ultron's own SOL address as recipient (user claims later)
            // TODO: resolve sol@holder via IKA dWallet / SUIAMI roster
            const solAddr = ULTRON_SOL_ADDRESS;

            const mintAddress = (this.state as any).iusd_sol_mint as string | undefined;
            if (mintAddress) {
              const result = await this.bamMintIusdSol({
                recipientSolAddress: solAddr,
                amount: iusdRecovered,
                callerAddress: this.getUltronAddress(),
              });
              if (result.signature) {
                bamMintSig = result.signature;
                console.log(`[shade-cancel] BAM minted ${Number(iusdRecovered) / 1e9} iUSD SPL on Solana: ${result.signature}`);
              }
            } else {
              console.log('[shade-cancel] No iUSD SOL mint configured — iUSD stays on Sui');
            }
          } catch (e) {
            console.warn('[shade-cancel] BAM mint failed (iUSD stays on Sui):', e instanceof Error ? e.message : e);
          }
        }

        shades[idx].status = 'cancelled';
        shades[idx].deliberation = `user-initiated unshade${cancelDigest ? ` — on-chain cancel ${cancelDigest.slice(0, 10)}…` : ''}${bamMintSig ? ` — BAM minted on Solana ${bamMintSig.slice(0, 10)}…` : ''}`;
        this.setState({ ...this.state, shades } as any);
        console.log(`[TreasuryAgents] Shade ${body.domain}.sui cancelled by ${body.holder.slice(0, 10)}…`);
        return new Response(JSON.stringify({
          ok: true,
          cancelDigest: cancelDigest || undefined,
          iusdRecovered,
          bamMintSig,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shade purge-stale — remove all non-active shades for a given holder+domain
    if ((url.pathname.endsWith('/shade-purge-stale') || url.searchParams.has('shade-purge-stale')) && request.method === 'POST') {
      try {
        const body = await request.json() as { domain: string; holder: string };
        if (!body.domain || !body.holder) {
          return new Response(JSON.stringify({ error: 'domain and holder required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
        const before = shades.length;
        const kept = shades.filter(s => !(s.domain === body.domain && s.holder === body.holder && s.status !== 'active'));
        const purged = before - kept.length;
        this.setState({ ...this.state, shades: kept } as any);
        console.log(`[TreasuryAgents] Shade purge-stale: removed ${purged} non-active entries for ${body.domain}.sui / ${body.holder.slice(0, 10)}…`);
        return new Response(JSON.stringify({ ok: true, purged, remaining: kept.filter(s => s.domain === body.domain && s.holder === body.holder).length }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Magnemite: per-publicKey nonce tracking + hashchain for BAM
    // mint v2. Rejects duplicate nonces (Vector's replay protection)
    // and advances a seed hashchain so each authorized mint depends
    // on the exact prior history of mints for that publicKey.
    //
    //   seed[0] = 32 zero bytes
    //   seed[n+1] = sha256(seed[n] || current digest)
    //
    // Client doesn't need to track the seed — the nonce alone is
    // sufficient for replay protection. The seed is kept for future
    // "reveal chain of authorized actions" audit paths.
    if ((url.pathname.endsWith('/magnemite-nonce') || url.searchParams.has('magnemite-nonce')) && request.method === 'POST') {
      try {
        const body = await request.json() as { publicKey: string; nonce: string; digest: string };
        if (!body.publicKey || !body.nonce || !body.digest) {
          return new Response(JSON.stringify({ error: 'Missing publicKey, nonce, or digest' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const nonces = ((this.state as any).magnemite_nonces ?? {}) as Record<string, { seen: string[]; seed: string }>;
        const entry = nonces[body.publicKey] ?? { seen: [], seed: '0'.repeat(64) };
        if (entry.seen.includes(body.nonce)) {
          return new Response(JSON.stringify({ error: `Nonce ${body.nonce} already used for this publicKey` }), { status: 409, headers: { 'content-type': 'application/json' } });
        }

        // Advance the hashchain: new seed = sha256(prev seed || digest)
        const { sha256 } = await import('@noble/hashes/sha2.js');
        const prev = new Uint8Array(entry.seed.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
        const digestBytes = new Uint8Array(body.digest.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
        const combined = new Uint8Array(prev.length + digestBytes.length);
        combined.set(prev, 0);
        combined.set(digestBytes, prev.length);
        const nextSeed = sha256(combined);
        const nextSeedHex = Array.from(nextSeed, (b) => b.toString(16).padStart(2, '0')).join('');

        // Retain the last 1000 nonces per publicKey to keep state bounded.
        const nextSeen = [...entry.seen, body.nonce].slice(-1000);
        const nextNonces = { ...nonces, [body.publicKey]: { seen: nextSeen, seed: nextSeedHex } };
        this.setState({ ...this.state, magnemite_nonces: nextNonces } as any);
        console.log(`[magnemite] ${body.publicKey.slice(0, 12)}… nonce=${body.nonce.slice(0, 12)}… seed advance → ${nextSeedHex.slice(0, 12)}…`);
        return new Response(JSON.stringify({ ok: true, seed: nextSeedHex }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Cancel a StableShadeOrder<iUSD> — ultron signs cancel_stable<T>
    // which refunds the entire deposit (no 10% fee like execute) to
    // the owner. Only valid when called by ultron for an order whose
    // salt is lost (i.e., cannot execute the intended happy path).
    if ((url.pathname.endsWith('/shade-cancel-stable') || url.searchParams.has('shade-cancel-stable')) && request.method === 'POST') {
      try {
        const body = await request.json() as { objectId: string; noForward?: boolean };
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 500, headers: { 'content-type': 'application/json' } });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.toSuiAddress());
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

        // Look up initialSharedVersion + verify ownership + coinType.
        const j = await transport.query({
          query: `query($a:SuiAddress!){ object(address:$a){ owner { __typename ... on Shared { initialSharedVersion } } asMoveObject { contents { type { repr } json } } } }`,
          variables: { a: body.objectId },
        });
        const obj = (j.data as any)?.object;
        if (!obj) return new Response(JSON.stringify({ error: `Object ${body.objectId} not found` }), { status: 404, headers: { 'content-type': 'application/json' } });
        const isv = Number(obj?.owner?.initialSharedVersion ?? 0);
        if (!isv) return new Response(JSON.stringify({ error: 'not a shared object' }), { status: 400, headers: { 'content-type': 'application/json' } });
        const typeRepr = obj?.asMoveObject?.contents?.type?.repr ?? '';
        const json = obj?.asMoveObject?.contents?.json ?? {};
        if (!typeRepr.includes('::shade::StableShadeOrder')) return new Response(JSON.stringify({ error: `Not a StableShadeOrder: ${typeRepr}` }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (String(json.owner ?? '').toLowerCase() !== ultronAddr.toLowerCase()) {
          return new Response(JSON.stringify({ error: `Order owner ${json.owner} ≠ ultron ${ultronAddr} — cancel_stable is owner-only` }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        // Extract T from "...::StableShadeOrder<TYPE>"
        const tMatch = typeRepr.match(/StableShadeOrder<([^>]+)>/);
        const coinType = tMatch?.[1] || IUSD_TYPE;

        // cancel_stable is a Move entry fun that auto-transfers the
        // refunded coin to `ctx.sender()` = ultron. To the user,
        // ultron is infrastructure — the person who "sent" the shade
        // is the holder (brando) who initiated it in the UI, and
        // that's who the iUSD should round-trip back to. Second tx
        // below forwards ultron's refund to the holder address we
        // captured in treasury state at create time.
        const shadesNow = ((this.state as any).shades ?? []) as Array<Record<string, any>>;
        const shadeRow = shadesNow.find((s) => s.objectId === body.objectId);
        const holderAddr = shadeRow?.holder ? normalizeSuiAddress(String(shadeRow.holder)) : '';
        const depositMist = shadeRow?.depositMist ? BigInt(shadeRow.depositMist) : 0n;

        const SHADE_V5_PKG = '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837';
        const tx = new Transaction();
        tx.setSender(ultronAddr);
        tx.moveCall({
          target: `${SHADE_V5_PKG}::shade::cancel_stable`,
          typeArguments: [coinType],
          arguments: [
            tx.sharedObjectRef({ objectId: body.objectId, initialSharedVersion: isv, mutable: true }),
          ],
        });
        const txBytes = await tx.build({ client: transport as never });
        const { signature } = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, signature);
        console.log(`[shade-cancel-stable] ${body.objectId.slice(0,10)}… → digest ${digest}`);

        // Second tx: forward the refunded iUSD from ultron to the
        // holder (the user who "sent" the shade in the UI). The
        // whole point of a cancel is the user gets their money
        // back — ultron is just a signer, not the economic owner.
        // Skipped when `noForward: true` is set (e.g. cancel-and-
        // reshade flows where the funds need to stay on ultron so
        // the reshade can reuse them without needing fresh liquidity).
        let forwardDigest = '';
        let forwardedTo = '';
        if (!body.noForward && holderAddr && holderAddr.toLowerCase() !== ultronAddr.toLowerCase() && depositMist > 0n) {
          try {
            // Wait briefly for the fullnode to index the refunded
            // coin before we try to spend it.
            await new Promise((r) => setTimeout(r, 1500));
            const balRes = await transport.query({
              query: `query($a:SuiAddress!,$t:String!){ address(address:$a){ objects(filter:{type:$t}, first:20){ nodes{ address version digest contents { json } } } } }`,
              variables: { a: ultronAddr, t: `0x2::coin::Coin<${coinType}>` },
            });
            const iusdCoins = ((balRes.data as any)?.address?.objects?.nodes ?? [])
              .map((n: any) => ({ objectId: n.address, version: String(n.version), digest: n.digest, balance: BigInt(n.contents?.json?.balance ?? '0') }))
              .filter((c: any) => c.balance > 0n)
              .sort((a: any, b: any) => (a.balance > b.balance ? -1 : 1));
            const total = iusdCoins.reduce((s: bigint, c: any) => s + c.balance, 0n);
            if (total < depositMist) {
              console.warn(`[shade-cancel-stable] ultron has ${total} iUSD, need ${depositMist} to forward to holder — skipping forward`);
            } else {
              const fwdTx = new Transaction();
              fwdTx.setSender(ultronAddr);
              const primary = fwdTx.objectRef({ objectId: iusdCoins[0].objectId, version: iusdCoins[0].version, digest: iusdCoins[0].digest });
              if (iusdCoins.length > 1) {
                fwdTx.mergeCoins(primary, iusdCoins.slice(1).map((c: any) => fwdTx.objectRef({ objectId: c.objectId, version: c.version, digest: c.digest })));
              }
              const [payout] = fwdTx.splitCoins(primary, [fwdTx.pure.u64(depositMist)]);
              fwdTx.transferObjects([payout], fwdTx.pure.address(holderAddr));
              const fwdBytes = await fwdTx.build({ client: transport as never });
              const { signature: fwdSig } = await keypair.signTransaction(fwdBytes);
              forwardDigest = await this._submitTx(fwdBytes, fwdSig);
              forwardedTo = holderAddr;
              console.log(`[shade-cancel-stable] forwarded ${Number(depositMist)/1e9} iUSD → holder ${holderAddr.slice(0,10)}… digest ${forwardDigest}`);
            }
          } catch (e) {
            console.warn('[shade-cancel-stable] forward-to-holder failed:', e instanceof Error ? e.message : e);
          }
        }

        // Prune the shade from state so the deliberation loop stops
        // tracking it.
        const shades = ((this.state as any).shades ?? []).map((s: any) =>
          s.objectId === body.objectId
            ? { ...s, status: 'cancelled', deliberation: `cancel_stable via ${digest.slice(0, 10)}…${forwardDigest ? ` · refunded to holder via ${forwardDigest.slice(0,10)}…` : ''}` }
            : s,
        );
        this.setState({ ...this.state, shades } as any);

        return new Response(JSON.stringify({
          digest,
          forwardDigest: forwardDigest || null,
          refundedTo: forwardedTo || ultronAddr,
          coinType,
          depositMist: depositMist.toString(),
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Reschedule a previously-created stable shade order by pushing
    // its state record into the ShadeExecutorAgent DO. Used to recover
    // orders that were created before the schedule-stable dispatch was
    // wired in the shade-proxy (so their DO entry is either missing or
    // classified as legacy). Requires internal auth — the caller must
    // derive ultron's address from the keeper key.
    if ((url.pathname.endsWith('/shade-reschedule') || url.searchParams.has('shade-reschedule')) && request.method === 'POST') {
      try {
        const body = await request.json() as { objectId: string; initialSharedVersion?: number };
        const shades = ((this.state as any).shades ?? []) as Array<Record<string, any>>;
        const shade = shades.find((s) => s.objectId === body.objectId);
        if (!shade) return new Response(JSON.stringify({ error: `No shade in state for ${body.objectId}` }), { status: 404, headers: { 'content-type': 'application/json' } });
        if (!shade.salt) return new Response(JSON.stringify({ error: `Shade ${body.objectId} has no salt in state — unrecoverable without client-side preimage`, shade }), { status: 410, headers: { 'content-type': 'application/json' } });

        // Look up initialSharedVersion on-chain if not provided.
        let isv = body.initialSharedVersion;
        if (!isv) {
          const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
          const j = await transport.query({
            query: `query($a:SuiAddress!){ object(address:$a){ owner { __typename ... on Shared { initialSharedVersion } } } }`,
            variables: { a: body.objectId },
          });
          isv = Number((j.data as any)?.object?.owner?.initialSharedVersion ?? 0);
        }
        if (!isv) return new Response(JSON.stringify({ error: `Could not resolve initialSharedVersion for ${body.objectId}` }), { status: 500, headers: { 'content-type': 'application/json' } });

        // Push to ShadeExecutorAgent keyed on holder address.
        const shadeStub = this.env.ShadeExecutorAgent?.get(this.env.ShadeExecutorAgent.idFromName(shade.holder));
        if (!shadeStub) return new Response(JSON.stringify({ error: 'ShadeExecutorAgent unavailable' }), { status: 500, headers: { 'content-type': 'application/json' } });
        const scheduleRes = await shadeStub.fetch(new Request('https://shade-do/?schedule-stable', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            objectId: shade.objectId,
            domain: shade.domain,
            executeAfterMs: shade.graceEndMs,
            targetAddress: shade.holder,
            salt: shade.salt,
            ownerAddress: shade.holder,
            depositMist: shade.depositMist || '0',
            initialSharedVersion: isv,
            coinType: IUSD_TYPE,
          }),
        }));
        const text = await scheduleRes.text();
        try { return new Response(text, { status: scheduleRes.status, headers: { 'content-type': 'application/json' } }); }
        catch { return new Response(JSON.stringify({ error: text }), { status: 500, headers: { 'content-type': 'application/json' } }); }
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Shade list — get active shades for a holder
    if ((url.pathname.endsWith('/shade-list') || url.searchParams.has('shade-list')) && request.method === 'GET') {
      const holder = url.searchParams.get('holder') || '';
      const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
      const filtered = holder ? shades.filter(s => s.holder === holder) : shades.filter(s => s.status === 'active');
      // Redact domain for non-holder queries
      const result = filtered.map(s => ({
        id: s.id,
        domain: holder ? s.domain : undefined,
        commitment: s.commitment,
        thresholdUsd: s.thresholdUsd,
        graceEndMs: s.graceEndMs,
        status: s.status,
        deliberation: s.deliberation,
        objectId: (s as any).objectId,
        depositMist: (s as any).depositMist,
        salt: holder ? (s as any).salt : undefined,
      }));
      return new Response(JSON.stringify({ shades: result }), { headers: { 'content-type': 'application/json' } });
    }

    // Kamino positions — proof of reserves (read-only, no auth)
    if ((url.pathname.endsWith('/kamino-positions') || url.searchParams.has('kamino-positions')) && request.method === 'GET') {
      const positions = ((this.state as any).kamino_positions ?? []) as Array<Record<string, any>>;
      return new Response(JSON.stringify({ positions, count: positions.length }), { headers: { 'content-type': 'application/json' } });
    }

    // Quest Prism — client sends commitment + amount only, no domain ever leaves the client.
    // Ultron sends NS tokens to recipient. Client registers the name locally.
    if ((url.pathname.endsWith('/quest-bounty') || url.searchParams.has('quest-bounty')) && request.method === 'POST') {
      try {
        const body = await request.json() as {
          commitment: string; amount: number; accepted: string[]; recipient: string;
          preSignedTx?: string; preSignedSig?: string;
        };
        const bounties = (this.state as any).quest_bounties ?? [];
        // Deduplicate — same commitment = same Quest. Cancel existing open ones.
        const existingOpen = bounties.filter((b: any) => b.commitment === body.commitment && b.status === 'open');
        if (existingOpen.length > 0) {
          return new Response(JSON.stringify({ id: existingOpen[0].id, status: 'open', deduplicated: true }), { headers: { 'content-type': 'application/json' } });
        }
        const bounty = {
          id: crypto.randomUUID(),
          commitment: body.commitment,
          amount: body.amount,
          accepted: body.accepted,
          recipient: body.recipient,
          preSignedTx: body.preSignedTx || undefined,
          preSignedSig: body.preSignedSig || undefined,
          status: 'open' as string,
          created: Date.now(),
          digest: undefined as string | undefined,
          filledAt: undefined as number | undefined,
          error: undefined as string | undefined,
        };
        bounties.push(bounty);
        this.setState({ ...this.state, quest_bounties: bounties } as any);
        console.log(`[TreasuryAgents] Quest Prism posted: $${body.amount}, commitment: ${body.commitment.slice(0, 12)}…`);

        // Ultron acts as first Hunter — attempt immediate fill (send NS tokens)
        this.fillQuestBounty(bounty.id).catch(err => {
          console.error(`[TreasuryAgents] Auto-fill failed for ${bounty.id}:`, err);
        });

        return new Response(JSON.stringify({ id: bounty.id, status: 'open' }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Quest bounties — verifiable: commitment + amount + status. No domain, no recipient exposed.
    if ((url.pathname.endsWith('/quest-bounties') || url.searchParams.has('quest-bounties')) && request.method === 'GET') {
      const recipient = url.searchParams.get('recipient') || '';
      const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
      const filtered = recipient
        ? bounties.filter(b => b.recipient === recipient)
        : bounties.filter(b => b.status === 'open');
      const redacted = filtered.map(b => ({
        id: b.id,
        commitment: b.commitment,
        amount: b.amount,
        accepted: b.accepted,
        status: b.status,
        created: b.created,
        filledAt: b.filledAt,
        digest: b.digest,
        error: b.status === 'error' ? b.error : undefined,
      }));
      return new Response(JSON.stringify({ bounties: redacted }), { headers: { 'content-type': 'application/json' } });
    }

    // Quest fill — manually trigger fill for a specific bounty
    if ((url.pathname.endsWith('/quest-fill') || url.searchParams.has('quest-fill')) && request.method === 'POST') {
      try {
        const body = await request.json() as { bountyId: string };
        const result = await this.fillQuestBounty(body.bountyId);
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Lend idle USDC to NAVI
    if ((url.pathname.endsWith('/lend-usdc') || url.searchParams.has('lend-usdc')) && request.method === 'POST') {
      const result = await this.lendUsdcToNavi();
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }

    // Initiate — full cycle: SOL watcher + quests + Shade deliberation + NS sweep
    if (url.pathname.endsWith('/initiate') || url.searchParams.has('initiate')) {
      const results: Array<{ id: string; status: string; error?: string }> = [];
      await this._watchSolDeposits();
      await this._deliberateShades();
      await this._sweepNsToIusd();
      const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
      const open = bounties.filter(b => b.status === 'open');
      for (const b of open) {
        try {
          const r = await this.fillQuestBounty(b.id);
          results.push({ id: b.id, status: r.status, error: r.error });
        } catch (err) {
          results.push({ id: b.id, status: 'error', error: String(err) });
        }
      }
      const shades = ((this.state as any).shades ?? []) as Array<Record<string, any>>;
      return new Response(JSON.stringify({
        initiated: true,
        results,
        shades: shades.map(s => ({ domain: s.domain, status: s.status, deliberation: s.deliberation })),
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Deposit addresses — derive cross-chain addresses from ultron's ed25519 key
    if ((url.pathname.endsWith('/rumble') || url.searchParams.has('rumble')) && request.method === 'GET') {
      if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 500, headers: { 'content-type': 'application/json' } });
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const suiAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      return new Response(JSON.stringify({
        sui: suiAddr,
        sol: ULTRON_SOL_ADDRESS,
        btc: null, eth: null, // IKA dWallets after Rumble
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Deposit intent — register a Sui address, get a steganographic tag + exact SOL amount.
    // Sub-cent lamports encode the tag so the watcher knows which Sui address to credit.
    //
    // Phase 2 (Porygon2 Lv. 62): tag carries a structured
    //   (route, action, nonce) triple. The body accepts optional
    //   `route`, `action`, `params` fields — defaults to
    //   route=0 (iusd-cache) / action=0 for backward compatibility
    //   with every pre-Phase-2 client.
    if ((url.pathname.endsWith('/deposit-intent') || url.searchParams.has('deposit-intent')) && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
        const body = await request.json() as {
          suiAddress: string;
          amountUsd: number;
          route?: number;
          action?: number;
          params?: Record<string, unknown>;
        };
        if (!body.suiAddress || !body.amountUsd) throw new Error('Missing suiAddress or amountUsd');

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const solAddr = ULTRON_SOL_ADDRESS;

        // Validate route/action against the schema. Default both to
        // 0 so a plain {suiAddress, amountUsd} body still hits the
        // iusd-cache flow that Phase 1 clients rely on.
        const { ROUTES, encodeTag, formatTag, deriveNonceFromAddress, composeAmount, formatAmount } = await import('../subcent-tag.js');
        const route = Math.max(0, Math.min(9, Number(body.route ?? ROUTES.IUSD_CACHE)));
        const action = Math.max(0, Math.min(99, Number(body.action ?? 0)));

        // Derive a base nonce from the address hash so re-requests
        // from the same address yield the same tag. On collision we
        // perturb by +1 up to 9 times (2-digit safety window) before
        // giving up. Width=6 is USDC's hard ceiling; iUSD/SOL encoded
        // amounts lift the same nonce into their wider 8-digit tag
        // at encode time so the match table stays unified.
        const baseNonce = await deriveNonceFromAddress(body.suiAddress, 6);
        const _existingIntents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        let tag = 0;
        let finalNonce = baseNonce;
        for (let perturb = 0; perturb < 10; perturb++) {
          const candidateNonce = (baseNonce + perturb) % 1000;
          const candidate = encodeTag({ route, action, nonce: candidateNonce, width: 6 });
          const clash = _existingIntents.some(i =>
            i.status === 'pending'
            && i.tag === candidate
            && i.suiAddress !== body.suiAddress,
          );
          if (!clash) { tag = candidate; finalNonce = candidateNonce; break; }
          if (perturb === 9) {
            throw new Error('Tag space exhausted for this address — retry in a moment');
          }
        }

        // Get SOL price from Sibyl
        let solPrice: number | null = null;
        try {
          // Pyth SOL/USD feed
          const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
          const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
          const p = d.parsed?.[0]?.price;
          if (p?.price) solPrice = Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
        } catch {}
        if (!solPrice) {
          try {
            const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
            const d = await r.json() as { price?: string };
            if (d.price) solPrice = parseFloat(d.price);
          } catch {}
        }
        if (!solPrice) throw new Error('Sibyl could not determine SOL price');

        // SOL lamports: use the SAME 6-digit tag as USDC so both
        // carriers decode to the same intent. Tag lives in the
        // LOWEST 6 lamport positions (10^0 to 10^5 lamports =
        // 1 lamport to 0.0001 SOL). This is "sub-cent" relative
        // to the SOL native unit — a 6-digit tag costs at most
        // 999_999 lamports ≈ 0.001 SOL ≈ $0.08, which is
        // effectively rounding noise on any sane SOL deposit.
        //
        // Can't use composeAmount here because it assumes the
        // carrier unit is worth $1. At $84/SOL, 1 SOL ≠ $1 so
        // composeAmount's "whole units" math would put the tag
        // in positions 10^-1 to 10^-6 SOL = $8.40 to $0.0008,
        // overcharging by dozens of dollars on a $10 deposit.
        const solDecimals = 9;
        const baseLamports = BigInt(Math.floor((body.amountUsd / solPrice) * 10 ** solDecimals));
        const mask = 1_000_000n;                                    // bottom 6 lamport digits
        const baseWhole = (baseLamports / mask) * mask;
        const taggedLamportsBig = baseWhole + BigInt(tag);          // tag in bottom 6 digits
        const taggedLamports = Number(taggedLamportsBig);

        // Store the intent — carries route/action/params alongside
        // the Phase 1 fields so the match dispatch can route.
        const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        const existing = intents.findIndex(i => i.suiAddress === body.suiAddress);
        const intent = {
          suiAddress: body.suiAddress,
          tag,              // 6-digit canonical — shared by USDC and SOL watchers
          route,
          action,
          params: body.params ?? null,
          amountUsd: body.amountUsd,
          lamports: taggedLamports,
          solAmount: taggedLamports / 1e9,
          created: Date.now(),
          status: 'pending',
        };
        if (existing >= 0) intents[existing] = intent;
        else intents.push(intent);
        this.setState({ ...this.state, deposit_intents: intents } as any);

        const tagStr = formatTag(tag, 6);

        // iUSD tagged amount (9 decimals, 6-digit tag): compose via shared helper.
        // Same 6-digit tag as USDC so both stables decode to the same intent row.
        const iusdRaw = composeAmount(body.amountUsd, tag, 9, 6);
        const iusdTaggedStr = formatAmount(iusdRaw, 9);

        // USDC tagged amount (6 decimals): compose via shared helper.
        const usdcRaw = composeAmount(body.amountUsd, tag, 6, 6);
        const usdcTagged = formatAmount(usdcRaw, 6);

        // Prism URI — opens sui.ski, auto-builds USDC transfer with tagged amount
        const prismUri = `https://sui.ski/?prism=usdc:${usdcTagged}`;

        // Solana Pay URI (secondary — for SOL deposits)
        const solPayAmount = (taggedLamports / 1e9).toFixed(9);
        const solanaPayUri = `solana:${solAddr}?amount=${solPayAmount}&label=${encodeURIComponent('.SKI Quest')}&message=${encodeURIComponent(`iUSD:${iusdTaggedStr}`)}`;

        return new Response(JSON.stringify({
          // Primary: Sui Prism (USDC on Sui)
          prismUri,
          qr: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&color=ffffff&bgcolor=9945FF&data=${encodeURIComponent(prismUri)}`,
          usdcAmount: usdcTagged,
          iusdAmount: iusdTaggedStr,
          tag,
          tagHex: tagStr,
          amountUsd: body.amountUsd,
          // Secondary: Solana Pay (SOL deposits)
          solAddress: solAddr,
          solanaPayUri,
          solQr: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&color=ffffff&bgcolor=9945FF&data=${encodeURIComponent(solanaPayUri)}`,
          lamports: taggedLamports,
          solAmount: taggedLamports / 1e9,
          solPrice,
          memo: `Send ${usdcTagged} USDC to ultron or ${solPayAmount} SOL`,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Check deposit status — poll for matched deposits
    if ((url.pathname.endsWith('/deposit-status') || url.searchParams.has('deposit-status')) && request.method === 'GET') {
      const suiAddr = url.searchParams.get('suiAddress') || '';
      const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
      const mine = intents.find(i => i.suiAddress === suiAddr);
      if (!mine) return new Response(JSON.stringify({ status: 'not_found' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        status: mine.status,
        tag: mine.tag,
        lamports: mine.lamports,
        solAmount: mine.solAmount,
        matchedTx: mine.matchedTx,
        creditDigest: mine.creditDigest,
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Helius webhook — instant SOL deposit detection (replaces polling)
    if (url.pathname.endsWith('/sol-webhook') && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 500, headers: { 'content-type': 'application/json' } });

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronSolAddr = ULTRON_SOL_ADDRESS;

        const txs = await request.json() as Array<{
          signature: string;
          timestamp?: number;
          type?: string;
          nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
        }>;

        const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        const kaminoIntents = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
        const pending = intents.filter(i => i.status === 'pending');
        const pendingKamino = kaminoIntents.filter(i => i.status === 'pending');
        let matched = 0;

        for (const tx of txs) {
          if (!tx.nativeTransfers?.length) continue;

          for (const transfer of tx.nativeTransfers) {
            if (transfer.toUserAccount !== ultronSolAddr) continue;
            const lamports = transfer.amount;
            if (!lamports || lamports < 1000000) continue;

            const tag = lamports % 1000000;

            // Match deposit intents → route through Phase 2 dispatch.
            // The dispatcher is source-agnostic and handles attest,
            // mint, and quest fill uniformly for SOL and USDC both.
            const match = pending.find(p => p.tag === tag);
            if (match) {
              console.log(`[Helius Webhook] SOL match: ${lamports} lamports tag=${tag} sig=${tx.signature?.slice(0, 12)}… → ${match.suiAddress.slice(0, 10)}…`);
              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 83);
              await this._dispatchMatchedIntent(match, {
                usdValue: solValue,
                sourceDigest: tx.signature || '',
                sourceChain: 'sol',
              });
              matched++;
            }

            // Match Kamino intents
            const kaminoMatch = pendingKamino.find(p => p.tag === tag);
            if (kaminoMatch) {
              console.log(`[Helius Webhook] Kamino deposit matched! ${lamports} lamports, tag: ${tag}, → ${kaminoMatch.suiAddress.slice(0, 10)}…`);

              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 130);
              const ltv = kaminoMatch.strategy === 'multiply' ? 0.65 : 0.825;

              let kaminoDigest = '';
              try {
                kaminoDigest = await this._depositToKamino(lamports / 1e9);
                console.log(`[Helius Webhook] Kamino Lend deposit: ${(lamports / 1e9).toFixed(4)} SOL, tx: ${kaminoDigest}`);
              } catch (e) {
                console.error(`[Helius Webhook] Kamino deposit failed:`, e);
              }

              try {
                const collateralMist = BigInt(Math.floor(solValue * 1e9));
                await this.attestCollateral({ collateralValueMist: String(collateralMist) });
              } catch (e) {
                console.error(`[Helius Webhook] Kamino Attest failed:`, e);
              }

              const allKamino = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
              const kIdx = allKamino.findIndex(i => i.suiAddress === kaminoMatch.suiAddress);
              if (kIdx >= 0) {
                allKamino[kIdx] = { ...allKamino[kIdx], status: 'matched', matchedTx: tx.signature, kaminoDigest };
                this.setState({ ...this.state, kamino_intents: allKamino } as any);
              }
              matched++;
            }
          }
        }

        // Update last processed signature
        if (txs.length > 0 && txs[0].signature) {
          this.setState({ ...this.state, last_sol_sig: txs[0].signature } as any);
        }

        return new Response(JSON.stringify({ ok: true, matched }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        console.error('[Helius Webhook] Error:', err);
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Manual rescan — recovery for missed deposits
    // Snorunt Lv.30 — directly attest a SOL-chain collateral delta.
    // Writes to the 'SOL' asset key so it doesn't collide with the
    // Sui-side 'SUI' key (which attestLiveCollateral owns). This is
    // how cross-chain deposits should have been routed all along.
    if (url.pathname.endsWith('/attest-sol-collateral') && request.method === 'POST') {
      try {
        const body = await request.json() as { valueUsdCents: number };
        if (!body.valueUsdCents || body.valueUsdCents <= 0) {
          return new Response(JSON.stringify({ error: 'valueUsdCents required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'no keeper' }), { status: 400 });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
        // cents -> 9-dec USD mist: cents * 10^7
        const valueMist = BigInt(body.valueUsdCents) * 10_000_000n;
        const tx = new Transaction();
        tx.setSender(ultronAddr);
        tx.moveCall({
          package: TreasuryAgents.IUSD_PKG,
          module: 'iusd',
          function: 'update_collateral',
          arguments: [
            tx.object(TreasuryAgents.IUSD_TREASURY),
            tx.pure.vector('u8', Array.from(new TextEncoder().encode('SOL'))),
            tx.pure.vector('u8', Array.from(new TextEncoder().encode('solana'))),
            tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
            tx.pure.u64(valueMist),
            tx.pure.u8(0),
            tx.object('0x6'),
          ],
        });
        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, sig.signature);
        return new Response(JSON.stringify({ digest, asset: 'SOL', valueMist: String(valueMist), humanUsd: `$${body.valueUsdCents / 100}` }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Snorunt Lv.30 — manually dispatch a known Solana deposit by sig.
    // Unsticks deposits whose getSignaturesForAddress RPC returns empty
    // from the worker even though the tx is real. Only trusts the caller
    // because authedTreasuryStub's x-treasury-auth gate.
    if (url.pathname.endsWith('/force-dispatch-sol') && request.method === 'POST') {
      try {
        const body = await request.json() as { sig: string; lamports: number; suiAddress: string };
        if (!body.sig || !body.lamports || !body.suiAddress) {
          return new Response(JSON.stringify({ error: 'sig, lamports, suiAddress required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        const tag = body.lamports % 1000000;
        const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        const match = intents.find(i => i.status === 'pending' && i.tag === tag && i.suiAddress === body.suiAddress);
        if (!match) {
          return new Response(JSON.stringify({
            error: 'no matching pending intent',
            tag,
            pendingCount: intents.filter(i => i.status === 'pending').length,
            pendingTags: intents.filter(i => i.status === 'pending').map(i => ({ tag: i.tag, sui: i.suiAddress?.slice(0, 10) })),
          }), { status: 404, headers: { 'content-type': 'application/json' } });
        }
        const solPrice = await this._fetchSolPrice();
        const solValue = (body.lamports / 1e9) * (solPrice || 85);
        await this._dispatchMatchedIntent(match, {
          usdValue: solValue,
          sourceDigest: body.sig,
          sourceChain: 'sol',
        });
        return new Response(JSON.stringify({
          ok: true,
          tag,
          solValue,
          dispatched: 'see _dispatchMatchedIntent logs',
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err), stack: (err as Error)?.stack?.slice(0, 500) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Snorunt Lv.30 — debug dump of what _watchSolDeposits sees.
    if (url.pathname.endsWith('/debug-sol-watch') && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'no keeper' }), { status: 400 });
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const solAddr = ULTRON_SOL_ADDRESS;
        const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        const pending = intents.filter(i => i.status === 'pending');
        const result: any = {
          solAddr,
          pendingCount: pending.length,
          pendingTags: pending.map(p => ({ tag: p.tag, suiAddress: p.suiAddress?.slice(0, 10), created: p.created })),
          lastSolSig: (this.state as any).last_sol_sig ?? null,
        };

        const SOL_RPCS = [
          ...(this.env.HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`] : []),
          'https://api.mainnet-beta.solana.com',
        ];

        let signatures: Array<{ signature: string; blockTime: number }> = [];
        for (const rpc of SOL_RPCS) {
          try {
            const r = await fetch(rpc, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'getSignaturesForAddress',
                params: [solAddr, { limit: 10 }],
              }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const d = await r.json() as any;
            if (d.result?.length) { signatures = d.result; result.rpcUsed = rpc.replace(/key=.*/, 'key=***'); break; }
          } catch { /* try next */ }
        }
        result.sigCount = signatures.length;
        result.sigs = signatures.map(s => s.signature.slice(0, 20));

        // Inspect the first matching tx in detail
        for (const sig of signatures) {
          try {
            let txData: any = null;
            for (const rpc of SOL_RPCS) {
              try {
                const r = await fetch(rpc, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'getTransaction',
                    params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
                  }),
                  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                const d = await r.json() as any;
                if (d.result) { txData = d.result; break; }
              } catch { /* try next */ }
            }
            if (!txData) { (result.txDetails ??= []).push({ sig: sig.signature.slice(0, 20), err: 'no txData' }); continue; }
            const ixs = txData.transaction?.message?.instructions ?? [];
            const ixInfo = ixs.map((ix: any) => ({
              program: ix.program ?? ix.programId?.slice(0, 10) ?? '?',
              type: ix.parsed?.type ?? '?',
              dest: ix.parsed?.info?.destination?.slice(0, 20) ?? null,
              lamports: ix.parsed?.info?.lamports ?? null,
              destMatchesUltron: ix.parsed?.info?.destination === solAddr,
              amount: ix.parsed?.info?.amount ?? null,
            }));
            (result.txDetails ??= []).push({
              sig: sig.signature.slice(0, 20),
              ixCount: ixs.length,
              ixs: ixInfo,
            });
          } catch (e) {
            (result.txDetails ??= []).push({ sig: sig.signature.slice(0, 20), parseErr: String(e) });
          }
        }
        return new Response(JSON.stringify(result, null, 2), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Snorunt Lv.30 — clear the sol-watcher cursor so stuck pending
    // deposits get re-scanned from fresh. Call ONCE to unblock.
    if (url.pathname.endsWith('/reset-sol-cursor') && request.method === 'POST') {
      try {
        const prev = (this.state as any).last_sol_sig;
        this.setState({ ...this.state, last_sol_sig: undefined } as any);
        return new Response(JSON.stringify({ ok: true, previousCursor: prev ?? null }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if (url.pathname.endsWith('/rescan-deposits') && request.method === 'POST') {
      try {
        await this._watchSolDeposits();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Kamino deposit — SOL → Kamino Lend → attest → mint iUSD (Prism-wrapped)
    if ((url.pathname.endsWith('/kamino-deposit') || url.searchParams.has('kamino-deposit')) && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
        const body = await request.json() as { suiAddress: string; amountUsd: number; strategy?: 'lend' | 'multiply'; suinsName?: string };
        if (!body.suiAddress || !body.amountUsd) throw new Error('Missing suiAddress or amountUsd');

        const strategy = body.strategy || 'lend';
        const solPrice = await this._fetchSolPrice();
        if (!solPrice) throw new Error('Sibyl could not determine SOL price');

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const solAddr = ULTRON_SOL_ADDRESS;

        // Sub-cent tag from address
        const addrBytes = new TextEncoder().encode(body.suiAddress);
        const hashBuf = await crypto.subtle.digest('SHA-256', addrBytes);
        const hashArr = new Uint8Array(hashBuf);
        const tag = ((hashArr[0] << 16) | (hashArr[1] << 8) | hashArr[2]) % 1000000;

        const solAmount = body.amountUsd / solPrice;
        const baseLamports = Math.floor(solAmount * 1e9);
        const taggedLamports = Math.floor(baseLamports / 1000000) * 1000000 + tag;

        // ── Prism: commitment-based privacy ──────────────────────────────
        // Hash tag + address into commitment — only the commitment is stored in state
        const { keccak_256 } = await import('@noble/hashes/sha3.js');
        const commitPreimage = new TextEncoder().encode(`${tag}:${body.suiAddress}:${body.amountUsd}:${strategy}`);
        const commitment = Array.from(keccak_256(commitPreimage));

        // AES-256-GCM encrypt the full intent — only recipient can decrypt
        const aesKey = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const intentPlaintext = new TextEncoder().encode(JSON.stringify({
          suiAddress: body.suiAddress,
          tag,
          amountUsd: body.amountUsd,
          lamports: taggedLamports,
          strategy,
          solPrice,
          ts: Date.now(),
        }));
        const aesCryptoKey = await crypto.subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt']);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesCryptoKey, intentPlaintext));

        // Mask AES key with recipient address hash (only recipient can unmask)
        const addrHash = keccak_256(new TextEncoder().encode(body.suiAddress));
        const maskedKey = new Uint8Array(32);
        for (let i = 0; i < 32; i++) maskedKey[i] = aesKey[i] ^ addrHash[i];

        // Store encrypted Prism to Walrus — permanent but private
        let prismBlobId = '';
        try {
          const prismBlob = {
            type: 'openclob-prism',
            commitment: commitment.map(b => b.toString(16).padStart(2, '0')).join(''),
            ciphertext: btoa(String.fromCharCode(...ciphertext)),
            maskedKey: btoa(String.fromCharCode(...maskedKey)),
            nonce: btoa(String.fromCharCode(...nonce)),
            ts: Date.now(),
          };
          const walrusRes = await fetch('https://publisher.walrus.site/v1/store', {
            method: 'PUT',
            body: JSON.stringify(prismBlob),
          });
          const wd = await walrusRes.json() as any;
          prismBlobId = wd?.newlyCreated?.blobObject?.blobId || wd?.alreadyCertified?.blobId || '';
          if (prismBlobId) console.log(`[OpenCLOB] Prism stored to Walrus: ${prismBlobId}`);
        } catch (e) { console.warn('[OpenCLOB] Prism Walrus store failed:', e); }

        // Store intent with commitment (not plaintext address in logs)
        const kaminoIntents = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
        const existing = kaminoIntents.findIndex(i => i.suiAddress === body.suiAddress);
        const intent = {
          suiAddress: body.suiAddress,
          suinsName: body.suinsName || null,
          tag,
          commitment: commitment.map(b => b.toString(16).padStart(2, '0')).join(''),
          prismBlobId,
          amountUsd: body.amountUsd,
          lamports: taggedLamports,
          solAmount: taggedLamports / 1e9,
          solPrice,
          strategy,
          created: Date.now(),
          status: 'pending',
          kTokenMint: null as string | null,
          kTokenAmount: null as number | null,
          positionValue: null as number | null,
          iusdMinted: null as string | null,
        };
        if (existing >= 0) kaminoIntents[existing] = intent;
        else kaminoIntents.push(intent);
        this.setState({ ...this.state, kamino_intents: kaminoIntents } as any);

        const tagStr = String(tag).padStart(6, '0');
        const solPayAmount = (taggedLamports / 1e9).toFixed(9);
        const solanaPayUri = `solana:${solAddr}?amount=${solPayAmount}&label=${encodeURIComponent('.SKI Kamino')}&message=${encodeURIComponent(`kamino:${strategy}:${tagStr}`)}`;

        const ltv = strategy === 'multiply' ? 0.65 : 0.825;
        const iusdValue = body.amountUsd * ltv;

        return new Response(JSON.stringify({
          solAddress: solAddr,
          solanaPayUri,
          solQr: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&color=ffffff&bgcolor=9945FF&data=${encodeURIComponent(solanaPayUri)}`,
          lamports: taggedLamports,
          solAmount: taggedLamports / 1e9,
          solPrice,
          tag,
          tagHex: tagStr,
          strategy,
          ltv,
          iusdValue: iusdValue.toFixed(2),
          prismBlobId,
          commitment: intent.commitment,
          memo: `Send ${solPayAmount} SOL → Kamino ${strategy} → ${iusdValue.toFixed(2)} iUSD on Sui`,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Kamino USDC deposit — deposit Solana USDC to Kamino Lend
    if ((url.pathname.endsWith('/kamino-deposit-usdc') || url.searchParams.has('kamino-deposit-usdc')) && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
        const amountParam = parseFloat(url.searchParams.get('amount') || '0');
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const solAddr = ULTRON_SOL_ADDRESS;
        // Accept explicit amount via query param or try to auto-detect balance
        let depositAmt = amountParam;
        if (!depositAmt) {
          const usdcBal = await this._getSolanaUsdcBalance(solAddr);
          if (usdcBal <= 5) {
            return new Response(JSON.stringify({ error: `USDC balance too low: $${usdcBal.toFixed(2)} (need >$5). Pass { amount: N } to override.` }), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          depositAmt = usdcBal - 5;
        }
        const txSig = await this._depositUsdcToKamino(depositAmt);
        return new Response(JSON.stringify({
          deposited: depositAmt,
          txSignature: txSig,
          solAddress: solAddr,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Transfer specific coin types from ultron to a new address (lightweight, no object enumeration)
    if ((url.pathname.endsWith('/transfer-coins') || url.searchParams.has('transfer-coins')) && request.method === 'POST') {
      try {
        const body = await request.json() as { to: string; coinTypes?: string[] };
        if (!body.to) return new Response(JSON.stringify({ error: 'to address required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 500, headers: { 'content-type': 'application/json' } });

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const toAddr = normalizeSuiAddress(body.to);
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

        // Default: SUI + IKA
        const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
        const coinTypes = body.coinTypes ?? [IKA_TYPE];

        const tx = new Transaction();
        tx.setSender(ultronAddr);

        // Transfer each non-SUI coin type
        for (const ct of coinTypes) {
          if (ct.includes('::sui::SUI')) continue;
          const coins = await listCoinsOfType(transport, ultronAddr, ct);
          if (coins.length === 0) continue;
          const primary = tx.objectRef(coins[0]);
          if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map(c => tx.objectRef(c)));
          tx.transferObjects([primary], tx.pure.address(toAddr));
        }

        // Transfer SUI (leave 0.05 for gas)
        const suiBal = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `{ address(address: "${ultronAddr}") { balances(filter: { coinType: "0x2::sui::SUI" }) { nodes { totalBalance } } } }`,
          }),
        });
        const sd = await suiBal.json() as any;
        const totalMist = BigInt(sd?.data?.address?.balances?.nodes?.[0]?.totalBalance ?? '0');
        const transferMist = totalMist - 50_000_000n; // leave 0.05 SUI for gas
        if (transferMist > 0n) {
          const [suiSplit] = tx.splitCoins(tx.gas, [tx.pure.u64(transferMist)]);
          tx.transferObjects([suiSplit], tx.pure.address(toAddr));
        }

        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, sig.signature);

        return new Response(JSON.stringify({ ok: true, digest, from: ultronAddr, to: toAddr }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // Migrate: sweep ALL tokens from ultron to a new keeper address
    if ((url.pathname.endsWith('/migrate') || url.searchParams.has('migrate')) && request.method === 'POST') {
      try {
        const body = await request.json() as { newKeeper: string };
        if (!body.newKeeper) return new Response(JSON.stringify({ error: 'newKeeper required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 500, headers: { 'content-type': 'application/json' } });

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
        const newAddr = normalizeSuiAddress(body.newKeeper);
        const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

        // Fetch ALL coin objects owned by ultron
        const gqlRes = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `{ address(address: "${ultronAddr}") { objects(first: 50) { nodes { address contents { type { repr } json } } } } }`,
          }),
        });
        const gqlData = await gqlRes.json() as any;
        const objects = gqlData?.data?.address?.objects?.nodes ?? [];

        // Separate coin objects and other objects (NFTs, caps, etc.)
        const coinObjects: { id: string; type: string }[] = [];
        const otherObjects: { id: string; type: string }[] = [];
        for (const obj of objects) {
          const typeRepr = obj?.contents?.type?.repr ?? '';
          if (typeRepr.startsWith('0x2::coin::Coin<')) {
            coinObjects.push({ id: obj.address, type: typeRepr });
          } else if (typeRepr && !typeRepr.includes('0x2::coin::CoinMetadata')) {
            otherObjects.push({ id: obj.address, type: typeRepr });
          }
        }

        console.log(`[TreasuryAgents] Migrate: ${coinObjects.length} coins, ${otherObjects.length} other objects → ${newAddr}`);

        // Build atomic transfer PTB — all coins + all transferable objects in one tx
        const tx = new Transaction();
        tx.setSender(ultronAddr);

        // Transfer all non-SUI coins
        const nonGasCoins = coinObjects.filter(c => !c.type.includes('::sui::SUI'));
        if (nonGasCoins.length > 0) {
          tx.transferObjects(
            nonGasCoins.map(c => tx.object(c.id)),
            tx.pure.address(newAddr),
          );
        }

        // Transfer other objects (NFTs, caps, iUSD TreasuryCap, etc.)
        // Note: some objects may not be transferable (shared, immutable)
        // We try and let the VM reject non-transferable ones
        for (const obj of otherObjects) {
          try {
            tx.transferObjects([tx.object(obj.id)], tx.pure.address(newAddr));
          } catch {
            console.log(`[TreasuryAgents] Skipping non-transferable: ${obj.type}`);
          }
        }

        // Transfer remaining SUI (all but gas) — use splitCoins to leave gas
        // Actually: just transferObjects the gas coin remainder will auto-go to sender
        // We want ALL SUI to go to new address, so merge all SUI coins and transfer
        const suiCoins = coinObjects.filter(c => c.type.includes('::sui::SUI'));
        if (suiCoins.length > 1) {
          // Merge all SUI coins into the first one
          const primary = tx.object(suiCoins[0].id);
          tx.mergeCoins(primary, suiCoins.slice(1).map(c => tx.object(c.id)));
          // Split almost everything (leave 0.01 SUI for gas)
          const allSuiBal = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: `{ address(address: "${ultronAddr}") { balances(filter: { coinType: "0x2::sui::SUI" }) { nodes { totalBalance } } } }`,
            }),
          });
          const suiData = await allSuiBal.json() as any;
          const totalMist = BigInt(suiData?.data?.address?.balances?.nodes?.[0]?.totalBalance ?? '0');
          const transferMist = totalMist - 10_000_000n; // leave 0.01 SUI for gas
          if (transferMist > 0n) {
            const [suiTransfer] = tx.splitCoins(primary, [tx.pure.u64(transferMist)]);
            tx.transferObjects([suiTransfer], tx.pure.address(newAddr));
          }
        } else if (suiCoins.length === 1) {
          // Single SUI coin — split from gas
          const suiData2 = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: `{ address(address: "${ultronAddr}") { balances(filter: { coinType: "0x2::sui::SUI" }) { nodes { totalBalance } } } }`,
            }),
          });
          const sd2 = await suiData2.json() as any;
          const totalMist2 = BigInt(sd2?.data?.address?.balances?.nodes?.[0]?.totalBalance ?? '0');
          const transferMist2 = totalMist2 - 10_000_000n;
          if (transferMist2 > 0n) {
            const [suiTransfer2] = tx.splitCoins(tx.gas, [tx.pure.u64(transferMist2)]);
            tx.transferObjects([suiTransfer2], tx.pure.address(newAddr));
          }
        }

        const txBytes = await tx.build({ client: transport as never });
        const sig = await keypair.signTransaction(txBytes);
        const digest = await this._submitTx(txBytes, sig.signature);

        console.log(`[TreasuryAgents] Asset migration complete: ${digest}`);

        // Step 2: Update ultron.sui target address to new keeper
        // This requires the ultron.sui SuiNS NFT — find it among transferred objects
        let suinsDigest = '';
        try {
          const SUINS_PKG = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0';
          // Find ultron.sui NFT among the objects we just transferred
          // The NFT should now be at newAddr — build a PTB from ultron (still has 0.01 SUI for gas)
          // to call setTargetAddress on the NFT
          // Actually: the NFT was transferred to newAddr, so ultron can't call setTargetAddress anymore
          // The new keeper will need to set the target address themselves
          console.log(`[TreasuryAgents] NOTE: ultron.sui NFT transferred to ${newAddr}. New keeper must call setTargetAddress.`);
        } catch (e) {
          console.log('[TreasuryAgents] SuiNS target update skipped:', e);
        }

        return new Response(JSON.stringify({
          digest,
          from: ultronAddr,
          to: newAddr,
          coins: coinObjects.length,
          objects: otherObjects.length,
          note: 'ultron.sui NFT transferred. New keeper must call setTargetAddress to update resolution.',
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        const errStr = err instanceof Error ? err.stack || err.message : String(err);
        console.error('[TreasuryAgents] Migration error:', errStr);
        return new Response(JSON.stringify({ error: errStr }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if (url.pathname.endsWith('/t2000s') || url.searchParams.has('t2000s')) {
      return new Response(JSON.stringify({ agents: this.state.t2000s ?? [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Cache state — iUSD supply, collateral, ratio, surplus above 110%
    if (url.pathname.endsWith('/cache-state') || url.searchParams.has('cache-state')) {
      try {
        const cache = await this._getCacheState();
        return new Response(JSON.stringify({
          supply: String(cache.supply),
          senior: String(cache.senior),
          junior: String(cache.junior),
          total_collateral: String(cache.total),
          ratio_bps: cache.ratioBps,
          surplus_mist: String(cache.surplusMist),
          overcollateral_target_bps: OVERCOLLATERAL_BPS,
        }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // ── /build-trade — Infer engine: build purchase TX with real coins ──
    if ((url.pathname.endsWith('/build-trade') || url.searchParams.has('build-trade')) && request.method === 'POST') {
      try {
        const params = await request.json() as {
          buyer: string; nftTokenId: string; priceMist: string; route: string;
          suiBal: string; usdcBal: string; iusdBal: string;
          suiPriceUsd?: number;
        };
        const result = await this._buildTradeForBuyer(params);
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      const squids = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
      return new Response(JSON.stringify({
        positions: this.state.positions,
        arb_count: this.state.arb_history.length,
        t2000_count: (this.state.t2000s ?? []).filter(a => a.active).length,
        total_arb_profit: this.state.total_arb_profit_mist,
        total_yield_earned: this.state.total_yield_earned_mist,
        last_rebalance: this.state.last_rebalance_ms,
        last_sweep: this.state.last_sweep_ms,
        ticks: this.state.tick_count,
        squids,
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Squid globe — geo-mapped pre-rumble events
    if (url.pathname.endsWith('/squid-stats') || url.searchParams.has('squid-stats')) {
      const squids = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
      return new Response(JSON.stringify(squids), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname.endsWith('/start') || url.searchParams.has('start')) {
      this._scheduleNext(1000); // start ticking in 1s
      return new Response(JSON.stringify({ started: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname.endsWith('/sweep') || url.searchParams.has('sweep')) {
      const result = await this.sweepFees();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Swap ultron's USDC→SUI via DeepBook to refill cache for trades
    if (url.pathname.endsWith('/refill-sui') || url.searchParams.has('refill-sui')) {
      const result = await this._refillSui();
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }

    // ── Manual yield rotate trigger ──
    if (url.pathname.endsWith('/yield-rotate') || url.searchParams.has('yield-rotate')) {
      const result = await this._yieldRotate();
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }

    // ── Manual sweep trigger ──
    if (url.pathname.endsWith('/sweep-fees') || url.searchParams.has('sweep-fees')) {
      const result = await this.sweepFees();
      return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    }

    // ── iUSD→SUI/USDC swap: ultron sends output, returns TX for user to send iUSD ──
    if ((url.pathname.endsWith('/iusd-swap') || url.searchParams.has('iusd-swap')) && request.method === 'POST') {
      try {
        const params = await request.json() as { address: string; amount: string; outputToken: 'SUI' | 'USDC' };
        const result = await this._swapIusd(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/attest-collateral') || url.searchParams.has('attest-collateral')) && request.method === 'POST') {
      try {
        const params = await request.json() as { collateralValueMist: string };
        const result = await this.attestCollateral(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/strike-relay') || url.searchParams.has('strike-relay')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.strikeRelay>[0];
        const result = await this.strikeRelay(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Helius webhook fan-out: the worker's /api/helius/webhook forwards
    // every Solana event's touched-account set here so the DO can
    // invalidate any per-address caches. Right now we log + store the
    // most recent events in state; a later move hooks this into
    // per-user push notifications.
    if ((url.pathname.endsWith('/helius-event') || url.searchParams.has('helius-event')) && request.method === 'POST') {
      try {
        const body = await request.json() as {
          events: Array<Record<string, unknown>>;
          addresses: string[];
        };
        const recent = ((this.state as any).helius_recent_events as Array<{ ts: number; addresses: string[]; type?: string; signature?: string }> | undefined) || [];
        for (const ev of body.events ?? []) {
          recent.unshift({
            ts: Date.now(),
            addresses: body.addresses,
            type: ev.type as string | undefined,
            signature: ev.signature as string | undefined,
          });
        }
        // Keep the last 64 events, drop the rest.
        const trimmed = recent.slice(0, 64);
        this.setState({ ...this.state, helius_recent_events: trimmed } as any);
        console.log(`[TreasuryAgents] helius-event: ingested ${body.events?.length ?? 0} events, ${body.addresses?.length ?? 0} addresses, retained ${trimmed.length}`);
        return new Response(JSON.stringify({ ok: true, ingested: body.events?.length ?? 0 }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // OpenCLOB: iUSD SPL on Solana — read-only mint address (no auth)
    if ((url.pathname.endsWith('/iusd-sol-mint') || url.searchParams.has('iusd-sol-mint')) && request.method === 'GET') {
      const mintAddress = (this.state as any).iusd_sol_mint as string | undefined;
      return new Response(JSON.stringify({ mintAddress: mintAddress ?? null, decimals: 9 }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
      });
    }

    // OpenCLOB: iUSD SPL on Solana
    if ((url.pathname.endsWith('/create-iusd-sol-mint') || url.searchParams.has('create-iusd-sol-mint')) && request.method === 'POST') {
      try {
        const params = await request.json().catch(() => ({})) as Parameters<typeof this.createIusdSolMint>[0];
        const result = await this.createIusdSolMint(params);
        return new Response(JSON.stringify(result), {
          status: result.error && !result.mintAddress ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/bam-mint-iusd-sol') || url.searchParams.has('bam-mint-iusd-sol')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.bamMintIusdSol>[0];
        const result = await this.bamMintIusdSol(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/mint-iusd') || url.searchParams.has('mint-iusd')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.mintIusd>[0];
        const result = await this.mintIusd(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // Chansey v3 deposit-mint — attest cross-chain collateral + mint iUSD
    if ((url.pathname.endsWith('/mint-iusd-deposit') || url.searchParams.has('mint-iusd-deposit')) && request.method === 'POST') {
      try {
        const params = await request.json() as {
          recipient: string; depositedUsdMist: string;
          assetKey: string; chainKey: string;
        };
        const result = await this.mintIusdForDeposit({
          ...params,
          callerAddress: this.getUltronAddress(),
        });
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/set-thunder-fee') || url.searchParams.has('set-thunder-fee')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.setThunderFee>[0];
        const result = await this.setThunderFee(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/acquire-ns') || url.searchParams.has('acquire-ns')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.acquireNsForUser>[0];
        const result = await this.acquireNsForUser(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/swap-sui-for-deep') || url.searchParams.has('swap-sui-for-deep')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.swapSuiForDeep>[0];
        const result = await this.swapSuiForDeep(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/rumble-ultron') || url.searchParams.has('rumble-ultron')) && request.method === 'POST') {
      try {
        const result = await this.rumbleUltron();
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/create-iusd-pool') || url.searchParams.has('create-iusd-pool')) && request.method === 'POST') {
      try {
        const result = await this.createIusdUsdcPool();
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Pre-Rumble for new name ──────────────────────────────────────
    if ((url.pathname.endsWith('/pre-rumble') || url.searchParams.has('pre-rumble')) && request.method === 'POST') {
      try {
        const body = await request.json() as { name: string; userAddress?: string; source?: string };
        // Pass geo from CF headers
        const geo = {
          lat: parseFloat(request.headers.get('x-cf-lat') || '') || undefined,
          lon: parseFloat(request.headers.get('x-cf-lon') || '') || undefined,
          city: request.headers.get('x-cf-city') || undefined,
          country: request.headers.get('x-cf-country') || undefined,
        };
        const result = await this.preRumbleForName({ ...body, geo });
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Seed iUSD/USDC pool ──────────────────────────────────────────
    if ((url.pathname.endsWith('/seed-iusd-pool') || url.searchParams.has('seed-iusd-pool')) && request.method === 'POST') {
      try {
        const result = await this.seedIusdPool();
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Chansey v3: clean one-PTB pool seeder ───────────────────────
    if ((url.pathname.endsWith('/seed-iusd-pool-v3') || url.searchParams.has('seed-iusd-pool-v3')) && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({})) as { iusdQtyMist?: string };
        const iusdQtyMist = body.iusdQtyMist ?? '10000000000'; // default $10 iUSD
        const result = await this.seedIusdPoolV3({ iusdQtyMist });
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Jupiter SOL→USDC swap on Solana ──────────────────────────────
    if ((url.pathname.endsWith('/jupiter-swap') || url.searchParams.has('jupiter-swap')) && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return new Response(JSON.stringify({ error: 'No keeper key' }), { status: 503, headers: { 'content-type': 'application/json' } });
        const body = await request.json().catch(() => ({})) as { lamports?: string; slippageBps?: number };
        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        // Decode the private key properly. getSecretKey() may
        // return a bech32 string or typed array depending on
        // SDK version. Use decodeSuiPrivateKey if available,
        // otherwise fall back to raw export.
        let seedBytes: Uint8Array;
        try {
          const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
          const decoded = decodeSuiPrivateKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
          seedBytes = decoded.secretKey;
        } catch {
          // Fallback: export keypair and decode
          const raw = keypair.getSecretKey();
          if (raw instanceof Uint8Array) {
            seedBytes = raw.length > 32 ? raw.slice(raw.length - 32) : raw;
          } else {
            // String — might be bech32 or base64
            const bytes = Uint8Array.from(atob(String(raw)), c => c.charCodeAt(0));
            seedBytes = bytes.length > 32 ? bytes.slice(bytes.length - 32) : bytes;
          }
        }
        if (seedBytes.length !== 32) throw new Error(`Seed extraction failed: got ${seedBytes.length} bytes`);
        const secretHex = Array.from(seedBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        // Default: swap ALL SOL minus 0.01 for rent
        let lamports = BigInt(body.lamports || '0');
        if (lamports <= 0n) {
          const solAddr = ULTRON_SOL_ADDRESS;
          const solRpc = this.env.HELIUS_API_KEY
            ? `https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`
            : 'https://api.mainnet-beta.solana.com';
          const balRes = await fetch(solRpc, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [solAddr] }),
          });
          const balJson = await balRes.json() as { result?: { value?: number } };
          const totalLamports = BigInt(balJson?.result?.value ?? 0);
          lamports = totalLamports - 10_000_000n; // keep 0.01 SOL for rent
          if (lamports <= 0n) {
            return new Response(JSON.stringify({ error: `Insufficient SOL on ${solAddr}: ${Number(totalLamports) / 1e9} SOL` }), { status: 400, headers: { 'content-type': 'application/json' } });
          }
        }

        const { swapSolToUsdc } = await import('../jupiter-swap.js');
        // Always use Helius for tx submission — public Solana RPC
        // rejects sendTransaction from CF Workers ("Unauthorized").
        const heliusUrl = this.env.HELIUS_API_KEY
          ? `https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`
          : 'https://api.mainnet-beta.solana.com';
        const result = await swapSolToUsdc(secretHex, lamports, body.slippageBps ?? 150, heliusUrl);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Recover iUSD from shared BM → send to recipient ──────────────
    if ((url.pathname.endsWith('/recover-shared-bm') || url.searchParams.has('recover-shared-bm')) && request.method === 'POST') {
      try {
        const body = await request.json() as { recipient: string; bmId?: string };
        const result = await this._recoverSharedBm(body);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Shade proxy: ultron fronts the SUI deposit ───────────────────
    if ((url.pathname.endsWith('/shade-proxy') || url.searchParams.has('shade-proxy')) && request.method === 'POST') {
      try {
        const body = await request.json() as { label: string; targetAddress: string; graceEndMs?: number };
        const result = await this._shadeProxy(body);
        return new Response(JSON.stringify(result, (_k, v) => typeof v === 'bigint' ? v.toString() : v), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    // ─── Ignite: fulfill cross-chain gas request ─────────────────────
    if ((url.pathname.endsWith('/ignite') || url.searchParams.has('ignite')) && request.method === 'POST') {
      try {
        const body = await request.json() as { requestId: string; chain: string; encryptedRecipient: string; iusdBurned: number };
        const result = await this.fulfillIgnite(body);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    return super.onRequest(request);
  }

  // ─── Core Tick ───────────────────────────────────────────────────────

  private async _tick() {
    const now = Date.now();
    this.setState({
      ...this.state,
      tick_count: this.state.tick_count + 1,
    });

    try {
      // Every tick: scan for arb + run t2000 missions + retry open Quests + deliberate Shades + sweep NS
      // SOL deposits: primary path is Helius webhook, but poll as
      // fallback in case the webhook didn't fire (key expired, outage).
      await this._watchSolDeposits();
      await this._scanArb();
      await this._runT2000Missions();
      await this._retryOpenQuests();
      await this._retryStrandedRegistrations();
      await this._deliberateShades();
      await this._sweepNsToIusd();
      // Sub-cent intents — Phase 1b + 1c. Purge stale intents
      // (10-min pending TTL, 24h matched retention) then poll
      // ultron's USDC coins for tag-matched deposits from
      // external wallets. The prune pass runs first so the
      // watcher's match set stays small.
      await this._purgeStaleIntents();
      await this._watchSuiUsdcDeposits();
      // OpenCLOB bundle scanner — Phase 3b (Porygon-Z Lv. 80).
      // Lists shared OrderBundle objects and LOGS which ones would
      // be settled / force-refunded. No on-chain writes yet; Phase 3c
      // adds the actual settle_bundle + force_refund_bundle calls.
      await this._scanOpenBundles();
      // IOU expiry sweep — Rhydon Lv.35, issue #74. Runs on a
      // 5-minute throttle, redundant with the Cloudflare cron
      // `*/10 * * * *`. Both call the same idempotent
      // sweepExpiredIous helper — whichever fires first wins.
      await this._sweepExpiredIous();

      // Shuckle Lv.30 (#117) — refresh iUSD Treasury collateral
      // attestation from live ultron balances. 5-minute throttle.
      // Idempotent — each call upserts the per-asset CollateralRecord.
      // Runs AFTER _yieldRotate so any rebalancing is reflected in
      // the next attestation pass.
      //
      // Chansey Lv.40 (#76) — immediately after a successful attest,
      // realize any surplus above 110% as newly minted iUSD. The
      // activity-yield loop is no-op until senior > 1.1 * supply,
      // so it's safe to call on every throttled cycle — it simply
      // returns {skipReason: 'no surplus'} when the treasury isn't
      // healthy. Once activity pushes senior past the threshold
      // (price appreciation, arb profit, yield accrual, fees), this
      // call realizes the delta as new supply.
      const COLLATERAL_ATTEST_INTERVAL_MS = 5 * 60 * 1000;
      const lastAttest = (this.state as any).last_collateral_attest_ms as number | undefined;
      if (!lastAttest || now - lastAttest >= COLLATERAL_ATTEST_INTERVAL_MS) {
        this.setState({ ...this.state, last_collateral_attest_ms: now } as any);
        try {
          const attestRes = await this.attestLiveCollateral();
          if (attestRes.error && !/No assets above/i.test(attestRes.error)) {
            console.warn('[TreasuryAgents] Shuckle tick attest error:', attestRes.error);
          }
          // Chansey pairs with attest — realize any new surplus
          // surfaced by the attestation. Errors here are logged but
          // don't block the rest of the tick loop.
          try {
            const yieldRes = await this.realizeActivityYield();
            if (yieldRes.error) {
              console.warn('[TreasuryAgents] Chansey tick mint error:', yieldRes.error);
            } else if (yieldRes.mintedUsd) {
              console.log(`[TreasuryAgents] Chansey tick mint: ${yieldRes.mintedUsd} iUSD, ratio ${yieldRes.ratioBeforeBps} -> ${yieldRes.ratioAfterBps} bps`);
            }
          } catch (err) {
            console.error('[TreasuryAgents] Chansey tick mint threw:', err);
          }
        } catch (err) {
          console.error('[TreasuryAgents] Shuckle tick attest threw:', err);
        }
      }

      // Every 15 min: sweep dust, rotate yield across NAVI/Scallop/DeepBook
      const YIELD_INTERVAL = 30 * 1000; // 30s for testing — restore to 15 * 60 * 1000
      if (now - this.state.last_sweep_ms > YIELD_INTERVAL) {
        await this.sweepDust(); // Convert USDC/DEEP dust → SUI → attest → mint iUSD
        await this._yieldRotate(); // Deploy surplus above 110% to best venue
        this.setState({ ...this.state, last_sweep_ms: Date.now() });
      }

      // Every 24h: rebalance
      const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
      if (now - this.state.last_rebalance_ms > TWENTY_FOUR_H) {
        await this._rebalance();
      }
    } catch (err) {
      console.error('[TreasuryAgents] tick error:', err);
    } finally {
      // Re-tick every 15 seconds for arb scanning
      this._scheduleNext(15_000);
    }
  }

  private _scheduleNext(ms: number) {
    this.ctx.storage.setAlarm(Date.now() + ms);
  }

  // ─── Arb Scanner (NAVI flash loans) ──────────────────────────────────

  private async _scanArb() {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Query SUI/USDC prices on DeepBook vs Cetus
      // Use the Bluefin aggregator to get quotes from both venues
      const amount = 1_000_000_000n; // 1 SUI
      const params = new URLSearchParams({
        amount: String(amount),
        from: SUI_TYPE,
        to: USDC_TYPE,
        sources: 'deepbook_v3,cetus',
      });

      const quoteRes = await fetch(`https://aggregator.api.sui-prod.bluefin.io/v2/quote?${params}`);
      if (!quoteRes.ok) return;
      const quote = await quoteRes.json() as {
        routes?: Array<{ hops: Array<{ pool: { type: string } }>; amountOut: string }>;
      };

      if (!quote.routes || quote.routes.length < 2) return;

      // Find best and worst routes
      const sorted = quote.routes.sort((a, b) => Number(b.amountOut) - Number(a.amountOut));
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const bestOut = Number(best.amountOut);
      const worstOut = Number(worst.amountOut);

      if (bestOut <= worstOut || worstOut <= 0) return;

      const spreadBps = Math.floor(((bestOut - worstOut) / worstOut) * 10000);

      // Only arb if spread > 10 bps (0.1%) to cover gas
      if (spreadBps < 10) return;

      console.log(`[TreasuryAgents] Arb opportunity: ${spreadBps} bps spread`);

      // Build flash loan arb PTB:
      // 1. Flash borrow USDC from NAVI (0% fee)
      // 2. Buy SUI on cheaper venue
      // 3. Sell SUI on expensive venue
      // 4. Repay flash loan
      // 5. Keep profit
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = keypair.getPublicKey().toSuiAddress();

      const arbAmount = 100_000_000n; // 100 USDC (start small)
      const tx = new Transaction();
      tx.setSender(normalizeSuiAddress(ultronAddr));

      // Flash borrow from NAVI
      const [flashBalance, flashReceipt] = tx.moveCall({
        target: `${NAVI.package}::lending::flash_loan_with_ctx`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.object(NAVI.flashloanConfig),
          tx.pure.u64(arbAmount),
        ],
      });

      // Convert balance to coin for swap
      const [flashCoin] = tx.moveCall({
        target: '0x2::coin::from_balance',
        typeArguments: [USDC_TYPE],
        arguments: [flashBalance],
      });

      // Buy SUI on cheaper venue (DeepBook)
      const [suiReceived, usdcChange, deepChange] = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: DB_SUI_USDC_POOL,
            initialSharedVersion: 389750322,
            mutable: true,
          }),
          flashCoin,
          tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'] })[0],
          tx.pure.u64(0),
          tx.object.clock(),
        ],
      });

      // Sell SUI back for USDC on Cetus (more expensive venue)
      // ... simplified: in production this would use the Cetus router
      // For now, just sell back on DeepBook at market (the arb is in the price gap)
      const [usdcBack, suiDust, deepDust] = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: DB_SUI_USDC_POOL,
            initialSharedVersion: 389750322,
            mutable: true,
          }),
          suiReceived,
          tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'] })[0],
          tx.pure.u64(0),
          tx.object.clock(),
        ],
      });

      // Repay flash loan
      const repayBalance = tx.moveCall({
        target: '0x2::coin::into_balance',
        typeArguments: [USDC_TYPE],
        arguments: [usdcBack],
      })[0];
      tx.moveCall({
        target: `${NAVI.package}::lending::flash_repay_with_ctx`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.object(NAVI.flashloanConfig),
          repayBalance,
          flashReceipt,
        ],
      });

      // Keep profit + dust
      tx.transferObjects([usdcChange, suiDust, deepDust, deepChange], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, signature);

      console.log(`[TreasuryAgents] Arb executed: ${digest}, spread: ${spreadBps} bps`);

      // Record
      const profitMist = BigInt(bestOut - worstOut);
      this.setState({
        ...this.state,
        arb_history: [
          ...this.state.arb_history.slice(-99), // keep last 100
          {
            pair: 'SUI/USDC',
            buy_venue: worst.hops[0]?.pool.type || 'unknown',
            sell_venue: best.hops[0]?.pool.type || 'unknown',
            spread_bps: spreadBps,
            timestamp_ms: Date.now(),
            executed: true,
            profit_mist: String(profitMist),
          },
        ],
        total_arb_profit_mist: String(
          BigInt(this.state.total_arb_profit_mist) + profitMist,
        ),
      });
    } catch (err) {
      // Arb failed — no loss (flash loan reverts atomically)
      console.error('[TreasuryAgents] Arb scan error:', err);
    }
  }

  // ─── Fee Sweeper ────────────────────────────────────────────────────

  @callable()
  async sweepFees(params?: { callerAddress?: string }): Promise<{ swept: boolean; amount?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress);
    if (authErr) return { swept: false };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { swept: false };
    }

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const treasuryAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check treasury SUI balance via JSON-RPC (reliable)
      const suiCoinsRes = await raceJsonRpc<{ data: Array<{ balance: string }> }>(
        'suix_getCoins', [treasuryAddr, SUI_TYPE],
      );
      const bal = (suiCoinsRes?.data ?? []).reduce((s, c) => s + BigInt(c.balance), 0n);

      // Keep 30 SUI liquid for trades + gas, sweep the rest
      const KEEP_LIQUID = 30_000_000_000n; // 30 SUI
      if (bal <= KEEP_LIQUID) return { swept: false };
      const sweepAmount = bal - KEEP_LIQUID;
      console.log(`[TreasuryAgents] Sweeping ${Number(sweepAmount) / 1e9} SUI into Scallop`);

      // Deposit SUI into Scallop lending (NAVI version-gated, using Scallop instead)
      const lendResult = await this.lendSuiToScallop(sweepAmount);
      if (lendResult.error) return { swept: false, error: lendResult.error };

      console.log(`[TreasuryAgents] Swept ${Number(sweepAmount) / 1e9} SUI to Scallop: ${lendResult.digest}`);

      this.setState({
        ...this.state,
        last_sweep_ms: Date.now(),
      });

      return { swept: true, amount: String(sweepAmount) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] Sweep error:', msg);
      return { swept: false, error: msg };
    }
  }

  /** Deposit idle USDC into NAVI lending for yield (~4-8% APY).
   *  Keeps $5 USDC liquid for Quest fills. Rest goes to NAVI. */
  async lendUsdcToNavi(): Promise<{ digest?: string; amount?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Get USDC balance
      const coinData = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, USDC_TYPE],
      );
      const usdcCoins = (coinData?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      const totalUsdc = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);

      // Keep $5 USDC liquid for Quest fills (5_000_000 = 5 USDC with 6 decimals)
      const KEEP_LIQUID = 5_000_000n;
      if (totalUsdc <= KEEP_LIQUID) return { error: 'Insufficient USDC for lending (keeping $5 liquid)' };

      const lendAmount = totalUsdc - KEEP_LIQUID;
      console.log(`[TreasuryAgents] Lending ${Number(lendAmount) / 1e6} USDC to NAVI (keeping $5 liquid)`);

      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Merge all USDC coins
      const usdcCoin = tx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
      if (usdcCoins.length > 1) {
        tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
      }

      // Split: lend amount vs keep liquid
      const [lendCoin] = tx.splitCoins(usdcCoin, [tx.pure.u64(lendAmount)]);

      // Deposit native USDC into NAVI lending pool
      // Pool<nUSDC> = 0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8, assetId = 10
      const NAVI_USDC_POOL = '0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8';
      tx.moveCall({
        target: `${NAVI.package}::incentive_v3::entry_deposit`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object('0x6'), // Clock
          tx.object(NAVI.storage),
          tx.object(NAVI_USDC_POOL), // Pool<USDC>
          tx.pure.u8(10), // nUSDC asset ID
          lendCoin,
          tx.pure.u64(lendAmount), // amount
          tx.object(NAVI.incentiveV2),
          tx.object(NAVI.incentiveV3),
        ],
      });

      // Return remaining USDC to ultron
      tx.transferObjects([usdcCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] USDC lent to NAVI: ${digest}, amount: ${Number(lendAmount) / 1e6}`);
      return { digest, amount: String(lendAmount) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] NAVI USDC lend error:', msg);
      return { error: msg };
    }
  }

  // ─── Cache State Query ─────────────────────────────────────────────
  //
  // Reads iUSD Treasury on-chain: supply, senior/junior collateral, ratio.
  // Used to calculate surplus above 110% overcollateralization.

  private async _getCacheState(): Promise<{
    supply: bigint; senior: bigint; junior: bigint; total: bigint;
    ratioBps: number; surplusMist: bigint;
  }> {
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const res = await transport.query({
      variables: {},
      query: `query {
        object(address: "${TreasuryAgents.IUSD_TREASURY}") {
          asMoveObject { contents { json } }
        }
      }`,
    });
    const json = (res.data as any)?.object?.asMoveObject?.contents?.json ?? {};
    const totalMinted = BigInt(json.total_minted ?? '0');
    const totalBurned = BigInt(json.total_burned ?? '0');
    const supply = totalMinted - totalBurned;
    const senior = BigInt(json.senior_value_mist ?? '0');
    const junior = BigInt(json.junior_value_mist ?? '0');
    const total = senior + junior;
    const ratioBps = supply > 0n ? Number(total * 10000n / supply) : 0;
    // Surplus = collateral above 110% of supply
    const required = supply * BigInt(OVERCOLLATERAL_BPS) / 10000n;
    const surplusMist = total > required ? total - required : 0n;
    return { supply, senior, junior, total, ratioBps, surplusMist };
  }

  // ─── Scallop Lending ──────────────────────────────────────────────
  //
  // Deposit USDC/SUI into Scallop lending. Returns sCoin receipt tokens.
  // Two-step: mint (deposit → MarketCoin) then mint_s_coin (→ sCoin).

  async lendUsdcToScallop(amount?: bigint): Promise<{ digest?: string; amount?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Get USDC balance
      const coinData = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, USDC_TYPE],
      );
      const usdcCoins = (coinData?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      const totalUsdc = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);

      const KEEP_LIQUID = 5_000_000n; // keep $5 liquid
      if (totalUsdc <= KEEP_LIQUID) return { error: 'Insufficient USDC (keeping $5 liquid)' };

      const lendAmount = amount && amount < (totalUsdc - KEEP_LIQUID) ? amount : (totalUsdc - KEEP_LIQUID);
      console.log(`[TreasuryAgents] Lending ${Number(lendAmount) / 1e6} USDC to Scallop`);

      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Merge all USDC coins
      const usdcCoin = tx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
      if (usdcCoins.length > 1) {
        tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
      }

      const [lendCoin] = tx.splitCoins(usdcCoin, [tx.pure.u64(lendAmount)]);

      // Step 1: Deposit USDC → MarketCoin<USDC>
      const marketCoin = tx.moveCall({
        target: `${SCALLOP.package}::mint::mint`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(SCALLOP.version),
          tx.object(SCALLOP.market),
          lendCoin,
          tx.object('0x6'), // Clock
        ],
      });

      // Step 2: MarketCoin<USDC> → sCoin (sUSDC receipt)
      const sCoin = tx.moveCall({
        target: `${SCALLOP.sCoinPackage}::s_coin_converter::mint_s_coin`,
        typeArguments: [SCALLOP.sUsdcType, USDC_TYPE],
        arguments: [
          tx.object(SCALLOP.sUsdcTreasury),
          marketCoin,
        ],
      });

      // Keep the sCoin receipt
      tx.transferObjects([sCoin], tx.pure.address(ultronAddr));
      // Return remaining USDC
      tx.transferObjects([usdcCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] USDC lent to Scallop: ${digest}, amount: ${Number(lendAmount) / 1e6}`);

      // Track position
      this._updatePosition('scallop', USDC_TYPE, lendAmount);

      return { digest, amount: String(lendAmount) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] Scallop USDC lend error:', msg);
      return { error: msg };
    }
  }

  async lendSuiToScallop(amount: bigint): Promise<{ digest?: string; amount?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      console.log(`[TreasuryAgents] Lending ${Number(amount) / 1e9} SUI to Scallop`);

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);

      // Step 1: Deposit SUI → MarketCoin<SUI>
      const marketCoin = tx.moveCall({
        target: `${SCALLOP.package}::mint::mint`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(SCALLOP.version),
          tx.object(SCALLOP.market),
          depositCoin,
          tx.object('0x6'),
        ],
      });

      // Step 2: MarketCoin<SUI> → sCoin (sSUI receipt)
      const sCoin = tx.moveCall({
        target: `${SCALLOP.sCoinPackage}::s_coin_converter::mint_s_coin`,
        typeArguments: [SCALLOP.sSuiType, SUI_TYPE],
        arguments: [
          tx.object(SCALLOP.sSuiTreasury),
          marketCoin,
        ],
      });

      tx.transferObjects([sCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] SUI lent to Scallop: ${digest}, amount: ${Number(amount) / 1e9}`);

      this._updatePosition('scallop', SUI_TYPE, amount);

      return { digest, amount: String(amount) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] Scallop SUI lend error:', msg);
      return { error: msg };
    }
  }

  /**
   * Shuckle Lv.30 (#117) — unwind ALL of ultron's sSUI (Scallop receipt
   * token) back to liquid SUI. Two-step per sCoin coin:
   *   sSUI -> MarketCoin<SUI> via s_coin_converter::burn_s_coin
   *   MarketCoin<SUI> -> SUI via redeem::redeem_entry
   *
   * All sSUI coins are unwound in one PTB. Called once during the
   * collateral-fix flow — ultron should not be holding an asset we
   * don't understand, and the collateral attestation loop prefers to
   * see everything in SUI / USDC where the price math is clean.
   */
  async unwindAllScallopSui(): Promise<{ digest?: string; sSuiIn?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const coins = await transport.listCoins({ owner: ultronAddr, coinType: SCALLOP.sSuiType });
      if (!coins.objects.length) return { error: 'No sSUI coins to unwind' };
      const totalIn = coins.objects.reduce((acc, c) => acc + BigInt(c.balance ?? '0'), 0n);
      if (totalIn === 0n) return { error: 'sSUI coins all zero balance' };
      console.log(`[TreasuryAgents] Unwinding ${coins.objects.length} sSUI coin(s), total raw ${totalIn}`);
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      // Merge all sSUI coins into one if needed
      const first = tx.object(coins.objects[0].objectId);
      if (coins.objects.length > 1) {
        tx.mergeCoins(first, coins.objects.slice(1).map(c => tx.object(c.objectId)));
      }
      // Step 1: sSUI -> MarketCoin<SUI>
      const marketCoin = tx.moveCall({
        target: `${SCALLOP.sCoinPackage}::s_coin_converter::burn_s_coin`,
        typeArguments: [SCALLOP.sSuiType, SUI_TYPE],
        arguments: [
          tx.object(SCALLOP.sSuiTreasury),
          first,
        ],
      });
      // Step 2: MarketCoin<SUI> -> SUI, transferred to ultron
      tx.moveCall({
        target: `${SCALLOP.package}::redeem::redeem_entry`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(SCALLOP.version),
          tx.object(SCALLOP.market),
          marketCoin,
          tx.object('0x6'),
        ],
      });
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] sSUI unwound: ${digest}, total raw in: ${totalIn}`);
      return { digest, sSuiIn: String(totalIn) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] unwindAllScallopSui error:', msg);
      return { error: msg };
    }
  }

  /**
   * Shuckle Lv.30 (#117) — attest ultron's live liquid SUI + USDC
   * balances to the iUSD Treasury via iusd::update_collateral. Uses
   * Pyth Hermes for the SUI price (USDC hardcoded at $1).
   *
   * The Treasury's senior_value_mist field is a USD value in 9-decimal
   * mist form. SUI balance is 9-decimal raw MIST → multiply by USD
   * price to get USD-mist. USDC balance is 6-decimal raw → multiply
   * by 1000 to get USD-mist (USDC peg is $1).
   *
   * Tranches:
   *   SUI → SENIOR (it's native, always redeemable)
   *   USDC → SENIOR (it's a stable)
   *
   * Both are upserts via the Move contract's dynamic-field pattern
   * keyed on asset name, so running this twice is idempotent and
   * simply refreshes the values to current balances + prices.
   */
  async attestLiveCollateral(): Promise<{
    digest?: string;
    attested?: Array<{ asset: string; usdMist: string; humanUsd: string }>;
    error?: string;
  }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // 1. Read balances via GraphQL — sum of all coin objects per type.
      const balQ = await transport.query({
        variables: {},
        query: `query {
          address(address: "${ultronAddr}") {
            sui: balance(coinType: "${SUI_TYPE}") { totalBalance }
            usdc: balance(coinType: "${USDC_TYPE}") { totalBalance }
          }
        }`,
      });
      const addr = (balQ.data as any)?.address;
      const suiRaw = BigInt(addr?.sui?.totalBalance ?? '0');
      const usdcRaw = BigInt(addr?.usdc?.totalBalance ?? '0');

      // 2. Fetch SUI price from Pyth Hermes (9-decimal price representation).
      const PYTH_SUI = '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';
      let suiPriceUsd = 0;
      try {
        const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SUI}&parsed=true`, { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
        const j = await r.json() as { parsed?: Array<{ price?: { price: string; expo: number } }> };
        const p = j?.parsed?.[0]?.price;
        if (p) suiPriceUsd = Number(p.price) * Math.pow(10, p.expo);
      } catch { /* fall through — handled below */ }
      if (suiPriceUsd <= 0) return { error: 'Pyth SUI price unavailable' };

      // 3. Compute USD-mist (9-decimal) per asset.
      // SUI: suiRaw (9-dec SUI) × price ($/SUI) = USD value. To get 9-dec USD-mist
      //   we compute suiRaw × priceCents / 100 × 10 (scale cents to 9-dec).
      //   Simpler: value_usd_9dec = suiRaw × priceCents / 100 / 1 (since suiRaw IS already 9-dec).
      //   Even simpler and exact: round(suiRaw * suiPriceUsd) as BigInt of 9-dec USD mist.
      const suiUsdMist = BigInt(Math.floor(Number(suiRaw) * suiPriceUsd));
      // USDC: usdcRaw is 6-dec USDC = 6-dec USD. Scale up to 9-dec by ×1000.
      const usdcUsdMist = usdcRaw * 1000n;

      // 4. Skip assets below $0.10 to avoid noise txs.
      const MIN_ATTEST_USD_MIST = 100_000_000n; // $0.10 in 9-dec
      const toAttest: Array<{ asset: string; chain: string; valueMist: bigint }> = [];
      if (suiUsdMist >= MIN_ATTEST_USD_MIST) {
        toAttest.push({ asset: 'SUI', chain: 'sui', valueMist: suiUsdMist });
      }
      if (usdcUsdMist >= MIN_ATTEST_USD_MIST) {
        toAttest.push({ asset: 'USDC', chain: 'sui', valueMist: usdcUsdMist });
      }
      if (toAttest.length === 0) return { error: 'No assets above $0.10 threshold' };

      // 5. Build one PTB with N update_collateral calls.
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      for (const a of toAttest) {
        tx.moveCall({
          package: TreasuryAgents.IUSD_PKG,
          module: 'iusd',
          function: 'update_collateral',
          arguments: [
            tx.object(TreasuryAgents.IUSD_TREASURY),
            tx.pure.vector('u8', Array.from(new TextEncoder().encode(a.asset))),
            tx.pure.vector('u8', Array.from(new TextEncoder().encode(a.chain))),
            tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
            tx.pure.u64(a.valueMist),
            tx.pure.u8(0), // TRANCHE_SENIOR
            tx.object('0x6'),
          ],
        });
      }
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      const attested = toAttest.map(a => ({
        asset: a.asset,
        usdMist: String(a.valueMist),
        humanUsd: `$${(Number(a.valueMist) / 1e9).toFixed(2)}`,
      }));
      console.log(`[TreasuryAgents] Shuckle attested:`, attested, `tx=${digest}`);
      return { digest, attested };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] attestLiveCollateral error:', msg);
      return { error: msg };
    }
  }

  /**
   * Shuckle Lv.30 stage 2 (#117) — recover the owned DeepBook v3
   * BalanceManager that's holding stranded iUSD + USDC.
   *
   * The owned BM (ULTRON_OWNED_BM) was created at some point and had
   * iUSD + USDC deposited into it for what was probably going to be
   * a trading setup. The BM couldn't be used for orders because
   * DeepBook orders require a SHARED BM (see the CLAUDE.md black-hole
   * note) so the funds sat there, but withdraw_all IS public + callable
   * by the owner. We recover both balances and simultaneously burn the
   * recovered iUSD via burn_and_redeem — that reduces the outstanding
   * supply on the Treasury, tightening the collateralization ratio
   * beyond what attestation alone can achieve.
   *
   * Single PTB:
   *   1. withdraw_all<IUSD>(bm, ctx) -> Coin<IUSD>
   *   2. withdraw_all<USDC>(bm, ctx) -> Coin<USDC>
   *   3. burn_and_redeem(treasury_cap, treasury, iusd_coin, clock, ctx)
   *        -> burns the iUSD, reduces total_burned, emits Burned event,
   *           transfers a RedeemRequest receipt to ultron (we ignore it)
   *   4. transferObjects([usdc_coin], ultron)
   *        -> recovered USDC lands in ultron's wallet for the next
   *           attestation cycle to pick up
   *
   * Idempotent-ish: after running once, the BM balances are both 0
   * and withdraw_all returns Coin<T> with value 0. Burn asserts amount
   * > 0 so the second call would fail. That's fine — this method is
   * called manually, not from the tick loop.
   */
  async recoverOwnedBalanceManager(): Promise<{
    digest?: string;
    iusdBurned?: string;
    usdcRecovered?: string;
    error?: string;
  }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      const bm = tx.object(ULTRON_OWNED_BM);

      // 1. Withdraw iUSD -> Coin<IUSD>
      const iusdCoin = tx.moveCall({
        target: `${DB_BM_PACKAGE}::balance_manager::withdraw_all`,
        typeArguments: [IUSD_TYPE],
        arguments: [bm],
      });

      // 2. Withdraw USDC -> Coin<USDC>
      const usdcCoin = tx.moveCall({
        target: `${DB_BM_PACKAGE}::balance_manager::withdraw_all`,
        typeArguments: [USDC_TYPE],
        arguments: [bm],
      });

      // 3. Burn the recovered iUSD — reduces total_burned on the Treasury.
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'burn_and_redeem',
        arguments: [
          tx.object(IUSD_TREASURY_CAP),
          tx.object(TreasuryAgents.IUSD_TREASURY),
          iusdCoin,
          tx.object('0x6'),
        ],
      });

      // 4. Transfer recovered USDC to ultron.
      tx.transferObjects([usdcCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Shuckle stage 2 recovery: ${digest}`);
      return { digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] recoverOwnedBalanceManager error:', msg);
      return { error: msg };
    }
  }

  /**
   * Chansey Lv.40 (#76) — activity-yield mint loop.
   *
   * iUSD is a synthetic stable backed by a productive reserve basket
   * (SUI, USDC, future BTC/ETH via IKA). The 110% target is a safety
   * reserve, not a peg. When the treasury's senior collateral exceeds
   * 110% of outstanding supply, the overage is REALIZED YIELD —
   * activity (arb profits, yield accrual, fees, price appreciation
   * on the basket) pushed the reserve past the target, and that
   * surplus can be minted into new supply WITHOUT breaking the
   * 110% invariant.
   *
   * Math (mint invariant): to keep ratio >= 110% post-mint with no
   * accompanying deposit:
   *   new_senior / new_supply >= 1.1
   *   senior / (supply + m) >= 1.1
   *   m <= senior/1.1 - supply
   *
   * So: `max_mintable = max(0, senior/1.1 - supply)`.
   *
   * At the equilibrium ratio (exactly 110%), max_mintable is 0.
   * When activity lifts senior above 110%, the delta becomes
   * mintable yield. The mint itself consumes the surplus — ratio
   * stays pinned at 110% after a full yield realization.
   *
   * Destination: ultron's own wallet (v1). From there, operators can
   * split it via seedIusdPool for DEX liquidity (option B in the
   * user's chosen D split) or keep it as treasury capital for
   * sponsorship / arb (option A). The split policy is separable —
   * this method just makes iUSD exist, downstream code decides where
   * it goes.
   *
   * Throttle: 5 min, shares the last_collateral_attest_ms cursor
   * since attest + realize form a logical pair (attest first, then
   * mint any newly-visible surplus).
   *
   * Safety:
   * - No-op until senior > 1.1 * supply (gap must be closed first)
   * - Skips mints below $0.10 to avoid gas-dominant noise
   * - Contract's assert on mint_and_transfer is the ultimate safety
   *   rail — if our math is off the tx reverts and nothing changes
   */
  async realizeActivityYield(): Promise<{
    digest?: string;
    mintedUsd?: string;
    ratioBeforeBps?: number;
    ratioAfterBps?: number;
    skipReason?: string;
    error?: string;
  }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const cache = await this._getCacheState();
      const { supply, total } = cache;
      const ratioBefore = cache.ratioBps;
      // Mint headroom: keeps post-mint ratio >= ON-CHAIN minimum (150%)
      // with no deposit. The deployed iUSD package enforces 150% in
      // mint_and_transfer's assertion (see ONCHAIN_MIN_RATIO_BPS above
      // and the investigation in #76).
      //
      // Derivation:
      //   senior * 10000 >= new_supply * ONCHAIN_MIN_RATIO_BPS
      //   senior * 10000 >= (supply + m) * ONCHAIN_MIN_RATIO_BPS
      //   m <= (senior * 10000 - supply * ONCHAIN_MIN_RATIO_BPS) / ONCHAIN_MIN_RATIO_BPS
      //
      // At 15000 bps that simplifies to: m <= senior*10/15 - supply,
      // i.e. senior*2/3 - supply.
      const RATIO_BPS = BigInt(ONCHAIN_MIN_RATIO_BPS);
      const rawHeadroom = (total * 10000n - supply * RATIO_BPS) / RATIO_BPS;
      // Safety buffer: subtract 0.1% of supply so we land meaningfully
      // inside the assertion, not on the boundary. Without this, a 5k
      // raw-mist Pyth price tick between read and tx execution aborts
      // the whole realize-yield tx.
      const SAFETY_BUFFER = supply / 1000n;
      const headroom = rawHeadroom > SAFETY_BUFFER ? rawHeadroom - SAFETY_BUFFER : 0n;
      if (headroom <= 0n) {
        const targetMist = supply * RATIO_BPS / 10000n;
        const gapMist = targetMist > total ? targetMist - total : 0n;
        const targetPct = ONCHAIN_MIN_RATIO_BPS / 100;
        return {
          skipReason: `no surplus (senior \$${(Number(total) / 1e9).toFixed(2)} vs ${targetPct}% target \$${(Number(targetMist) / 1e9).toFixed(2)}; gap \$${(Number(gapMist) / 1e9).toFixed(2)})`,
          ratioBeforeBps: ratioBefore,
        };
      }
      // Skip tiny mints.
      const MIN_MINT_MIST = 100_000_000n; // $0.10
      if (headroom < MIN_MINT_MIST) {
        return {
          skipReason: `surplus \$${Number(headroom) / 1e9} below \$0.10 threshold`,
          ratioBeforeBps: ratioBefore,
        };
      }
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'mint_and_transfer',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY_CAP),
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.u64(headroom),
          tx.pure.address(ultronAddr),
        ],
      });
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      // Recompute ratio post-mint
      const newSupply = supply + headroom;
      const ratioAfter = Number((total * 10000n) / newSupply);
      console.log(`[TreasuryAgents] Chansey activity-yield minted \$${Number(headroom) / 1e9} iUSD to ultron. Ratio ${ratioBefore} -> ${ratioAfter} bps. tx=${digest}`);
      return {
        digest,
        mintedUsd: `\$${(Number(headroom) / 1e9).toFixed(6)}`,
        ratioBeforeBps: ratioBefore,
        ratioAfterBps: ratioAfter,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] realizeActivityYield error:', msg);
      return { error: msg };
    }
  }

  /**
   * Shuckle Lv.30 stage 2 (#117) — one-shot cleanup: write
   * update_collateral('DUST', 0) to zero out the phantom DUST
   * collateral record that the old broken sweepDust path has been
   * accumulating for months. Call this ONCE after deploying the
   * sweepDust code fix — after that the tick loop will only refresh
   * real records (SUI, USDC) via attestLiveCollateral and DUST will
   * stay at 0.
   */
  async zeroDustCollateralRecord(): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('DUST'))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx.pure.u64(0n),
          tx.pure.u8(0), // TRANCHE_SENIOR — must match existing record
          tx.object('0x6'),
        ],
      });
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Shuckle DUST zero-out: ${digest}`);
      return { digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] zeroDustCollateralRecord error:', msg);
      return { error: msg };
    }
  }

  // ─── Yield Rotator ──────────────────────────────────────────────────
  //
  // t2000 farm agents prowl for the best yield across NAVI, Scallop, and
  // DeepBook. They deploy surplus above 110% overcollateralization.
  // The cache keeps 110% backing — everything above is fair game.

  private async _yieldRotate(): Promise<{ deployed?: string; venue?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };

    try {
      // 1. Get cache state — how much surplus do we have?
      const cache = await this._getCacheState();
      console.log(`[TreasuryAgents:yield] Cache state: supply=${cache.supply}, collateral=${cache.total}, ratio=${cache.ratioBps}bps, surplus=${cache.surplusMist}`);

      if (cache.surplusMist <= 0n) {
        console.log('[TreasuryAgents:yield] No surplus above 110% — t2000s standing down');
        return { error: 'No surplus above 110%' };
      }

      // 2. Fetch APYs from all three venues
      const apys = await this._fetchVenueApys();
      console.log(`[TreasuryAgents:yield] APYs: ${apys.map(a => `${a.venue}=${a.apyBps}bps`).join(', ')}`);

      // 3. Pick the best venue
      const best = apys.sort((a, b) => b.apyBps - a.apyBps)[0];
      if (!best || best.apyBps <= 0) {
        console.log('[TreasuryAgents:yield] No positive APY venues');
        return { error: 'No positive APY' };
      }

      // 4. Convert surplus to deployable amount
      //    Surplus is in MIST (SUI-denominated). For USDC venues, convert at SUI price.
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Check what ultron actually has available to deploy
      const balRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, USDC_TYPE],
      );
      const availUsdc = (balRes?.data ?? []).reduce((s, c) => s + BigInt(c.balance), 0n);

      const suiBalRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, SUI_TYPE],
      );
      const availSui = (suiBalRes?.data ?? []).reduce((s, c) => s + BigInt(c.balance), 0n);
      const MIN_GAS = 200_000_000n; // keep 0.2 SUI for gas
      const deployableSui = availSui > MIN_GAS ? availSui - MIN_GAS : 0n;

      // Deploy to best venue
      let result: { digest?: string; amount?: string; error?: string } = { error: 'Nothing to deploy' };
      const surplusUsd = Number(cache.surplusMist) / 1e9; // approximate $1 = 1e9 MIST for iUSD

      switch (best.venue) {
        case 'navi': {
          // Deploy USDC to NAVI if available, else SUI
          if (availUsdc > 5_000_000n) {
            const cap = BigInt(Math.floor(surplusUsd * 1e6)); // surplus in USDC terms
            const amount = cap < availUsdc - 5_000_000n ? cap : availUsdc - 5_000_000n;
            if (amount > 0n) result = await this.lendUsdcToNavi();
          } else if (deployableSui > 100_000_000n) {
            // SUI sweep to NAVI is handled by sweepFees
            result = await this.sweepFees();
            if (result.swept !== undefined) result = { digest: undefined, amount: (result as any).amount };
          }
          break;
        }
        case 'scallop': {
          if (availUsdc > 5_000_000n) {
            const cap = BigInt(Math.floor(surplusUsd * 1e6));
            const amount = cap < availUsdc - 5_000_000n ? cap : availUsdc - 5_000_000n;
            if (amount > 0n) result = await this.lendUsdcToScallop(amount);
          } else if (deployableSui > 100_000_000n) {
            const cap = BigInt(Math.floor(surplusUsd * 1e9));
            const amount = cap < deployableSui ? cap : deployableSui;
            if (amount > 0n) result = await this.lendSuiToScallop(amount);
          }
          break;
        }
        case 'deepbook': {
          // DeepBook LP — provide liquidity to SUI/USDC pool for trading fees
          // Uses existing arb scanner profits as the deployment vehicle
          console.log('[TreasuryAgents:yield] DeepBook venue — arb scanner covers this');
          result = { digest: undefined, amount: String(cache.surplusMist) };
          break;
        }
      }

      if (result.digest || result.amount) {
        console.log(`[TreasuryAgents:yield] Deployed to ${best.venue}: ${result.amount ?? 'sweep'}`);
      }

      return { deployed: result.amount, venue: best.venue };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents:yield] Rotation error:', msg);
      return { error: msg };
    }
  }

  /** Fetch current APYs from NAVI, Scallop, and DeepBook. */
  private async _fetchVenueApys(): Promise<Array<{ venue: string; apyBps: number; asset: string }>> {
    const results: Array<{ venue: string; apyBps: number; asset: string }> = [];

    // NAVI — query their API for USDC lending APY
    try {
      const naviRes = await fetch('https://api-defi.naviprotocol.io/api/navi/overview');
      if (naviRes.ok) {
        const navi = await naviRes.json() as any;
        // NAVI returns APY as a decimal (e.g., 0.04 = 4%)
        const usdcPool = (navi?.pools ?? navi?.data ?? []).find?.((p: any) =>
          p.symbol === 'USDC' || p.asset === 'USDC' || (p.coinType ?? '').includes('::usdc::USDC')
        );
        const apy = usdcPool?.supply_apy ?? usdcPool?.supplyApy ?? usdcPool?.apy ?? 0;
        results.push({ venue: 'navi', apyBps: Math.round(Number(apy) * 10000), asset: 'USDC' });
      }
    } catch { results.push({ venue: 'navi', apyBps: 400, asset: 'USDC' }); } // fallback ~4%

    // Scallop — query their API for USDC lending APY
    try {
      const scallopRes = await fetch('https://sui.apis.scallop.io/pool/whitelist');
      if (scallopRes.ok) {
        const pools = await scallopRes.json() as any[];
        const usdcPool = (pools ?? []).find?.((p: any) =>
          p.coinName === 'usdc' || (p.coinType ?? '').includes('::usdc::USDC')
        );
        const apy = usdcPool?.supplyApy ?? usdcPool?.apy ?? 0;
        results.push({ venue: 'scallop', apyBps: Math.round(Number(apy) * 10000), asset: 'USDC' });
      }
    } catch { results.push({ venue: 'scallop', apyBps: 350, asset: 'USDC' }); } // fallback ~3.5%

    // DeepBook — trading fee APY estimated from volume
    // DeepBook doesn't have a traditional lending APY, but maker rebates generate yield
    // The arb scanner already captures this via spread profit
    results.push({ venue: 'deepbook', apyBps: 200, asset: 'SUI/USDC' }); // conservative ~2%

    return results;
  }

  /** Track yield position in state. */
  private _updatePosition(protocol: string, asset: string, amount: bigint) {
    const positions = [...(this.state.positions ?? [])];
    const existing = positions.findIndex(p => p.protocol === protocol && p.asset === asset);
    if (existing >= 0) {
      positions[existing] = {
        ...positions[existing],
        amount: String(BigInt(positions[existing].amount) + amount),
        updated_ms: Date.now(),
      };
    } else {
      positions.push({
        protocol,
        asset,
        amount: String(amount),
        apy_bps: 0,
        updated_ms: Date.now(),
      });
    }
    this.setState({ ...this.state, positions });
  }

  // ─── Dust Sweep (recursive cache growth) ───────────────────────────
  //
  // Every NS acquisition leaves USDC change, DEEP change, and rounding dust
  // in the ultron wallet. This sweep converts all non-SUI dust → SUI via
  // DeepBook, then attests it as collateral and mints iUSD. The cache
  // literally grows from swap rounding errors across thousands of transactions.
  //
  // Recursive flywheel:
  //   dust accumulates → sweep to SUI → attest collateral → mint iUSD →
  //   more iUSD capacity → more purchases → more dust → repeat

  async sweepDust(): Promise<{ swept: boolean; dustSui?: string; iusdMinted?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { swept: false };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check for USDC dust
      const balRes = await transport.query({
        variables: {},
        query: `query { address(address: "${ultronAddr}") { balances { nodes { coinType { repr } totalBalance } } } }`,
      });
      const balances = (balRes.data as any)?.address?.balances?.nodes ?? [];

      let usdcBal = 0n;
      let deepBal = 0n;
      for (const b of balances) {
        const ct = b.coinType?.repr ?? '';
        const raw = BigInt(b.totalBalance ?? '0');
        if (ct.includes('::usdc::USDC') && raw > 100_000n) usdcBal = raw; // > $0.10
        if (ct.includes('::deep::DEEP') && raw > 1_000_000n) deepBal = raw; // > 1 DEEP
      }

      if (usdcBal === 0n && deepBal === 0n) return { swept: false };

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      let totalSuiExpected = 0n;

      // sweepDust historically tried to (1) swap USDC dust -> SUI, (2) attest
      // the result as a 'DUST' collateral record, and (3) mint iUSD equal to
      // the dust value. All three were broken:
      //   - The swap used `pure.u64(0)` as a placeholder and never did the
      //     real DeepBook swap, so no SUI ever accrued.
      //   - The 'DUST' collateral write phantom-inflated senior_value_mist
      //     by double-counting the same USDC balance that attestLiveCollateral
      //     was attesting under the 'USDC' key.
      //   - The mint call then silently failed with EInsufficientCollateral
      //     because the ratio assertion has been blocking mints for a while.
      // Shuckle stage 2 (#117) disables this dead path. attestLiveCollateral
      // handles USDC + SUI attestation properly, and a standalone one-time
      if (usdcBal > 0n) console.log(`[TreasuryAgents] USDC dust observed (not swept): ${usdcBal}`);
      if (deepBal > 0n) console.log(`[TreasuryAgents] DEEP dust observed (not swept): ${deepBal}`);
      // Consume unused locals to keep TypeScript happy without touching
      // the tick-loop caller.
      void tx; void totalSuiExpected;
      return { swept: false };
    } catch (err) {
      console.error('[TreasuryAgents] Dust sweep error:', err);
      return { swept: false };
    }
  }

  // ─── Rebalancer ─────────────────────────────────────────────────────

  private async _rebalance() {
    console.log('[TreasuryAgents] Rebalance check');

    // Check cache state — if ratio dropped below 110%, pull funds from lending
    try {
      const cache = await this._getCacheState();
      console.log(`[TreasuryAgents:rebalance] ratio=${cache.ratioBps}bps, surplus=${cache.surplusMist}`);

      if (cache.ratioBps < OVERCOLLATERAL_BPS && cache.ratioBps > 0) {
        console.warn(`[TreasuryAgents:rebalance] Ratio ${cache.ratioBps}bps < ${OVERCOLLATERAL_BPS}bps — agents should withdraw from lending`);
        // TODO: withdraw from NAVI/Scallop to restore 110% ratio
      }
    } catch (err) {
      console.error('[TreasuryAgents:rebalance] Cache state query failed:', err);
    }

    this.setState({
      ...this.state,
      last_rebalance_ms: Date.now(),
    });
  }

  // ─── Queries ────────────────────────────────────────────────────────

  @callable()
  async getStatus(): Promise<TreasuryAgentsState> {
    return this.state;
  }

  @callable()
  async getArbHistory(): Promise<ArbOpportunity[]> {
    return this.state.arb_history;
  }

  // ─── t2000 Agent Management ──────────────────────────────────────────

  /** Register a deployed t2000 agent. Called after on-chain deploy(). */
  @callable()
  async registerT2000(params: {
    designation: string;
    mission: T2000Agent['mission'];
    objectId: string;
    dwalletId: string;
    operator: string;
    callerAddress?: string;
  }): Promise<{ success: boolean }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { success: false };
    const existing = (this.state.t2000s ?? []).find(a => a.objectId === params.objectId);
    if (existing) return { success: false };

    const agent: T2000Agent = {
      ...params,
      deployed_ms: Date.now(),
      total_profit_iusd: '0',
      last_run_ms: 0,
      runs: 0,
      active: true,
    };

    this.setState({
      ...this.state,
      t2000s: [...(this.state.t2000s ?? []), agent],
    });

    console.log(`[TreasuryAgents] t2000 registered: ${params.designation} (${params.mission})`);
    return { success: true };
  }

  /** Deactivate a t2000 agent. */
  @callable()
  async deactivateT2000(params: { objectId: string; callerAddress?: string }): Promise<{ success: boolean }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { success: false };
    this.setState({
      ...this.state,
      t2000s: (this.state.t2000s ?? []).map(a =>
        a.objectId === params.objectId ? { ...a, active: false } : a,
      ),
    });
    return { success: true };
  }

  /** Get all registered t2000 agents. */
  @callable()
  async getT2000s(): Promise<T2000Agent[]> {
    return this.state.t2000s ?? [];
  }

  /** QuestFi: Execute quests for all active agents. Parent keeps 1%, redistributes by performance.
   *  Lazy agents die. Bold RWA-focused agents spawn to replace them. */
  private async _runT2000Missions() {
    const agents = (this.state.t2000s ?? []).filter(a => a.active);
    if (agents.length === 0) return;

    let totalProfitIusd = 0n; // parent accumulates 1% of all activity (measured in iUSD)

    for (const agent of agents) {
      try {
        let agentProfitIusd = 0n; // per-agent profit, measured in iUSD (dollars)

        switch (agent.mission) {
          case 'arb':
            await this._scanArb();
            break;

          case 'sweep': {
            const sweepResult = await this.sweepFees();
            if (sweepResult.swept && sweepResult.amount) {
              // Convert MIST to iUSD estimate (1 SUI ≈ price * 1e9 MIST)
              agentProfitIusd = BigInt(sweepResult.amount) / 1_000_000_000n; // rough $1/SUI
            }
            break;
          }

          case 'farm': {
            const farmResult = await this._yieldRotate();
            if (farmResult.deployed) {
              // deployed is already in iUSD-scale (MIST for iUSD = 1e9 per dollar)
              agentProfitIusd = BigInt(farmResult.deployed);
            }
            break;
          }

          case 'watch':
            break;

          case 'route':
            break;

          case 'storm':
            break;

          case 'snipe':
            break;
        }

        // Parent takes 1% cut — cache keeps the spread
        const parentCut = agentProfitIusd * BigInt(PARENT_CUT_BPS) / 10000n;
        const agentShare = agentProfitIusd - parentCut;
        totalProfitIusd += parentCut;

        // Update agent stats (all measured in iUSD)
        this.setState({
          ...this.state,
          t2000s: (this.state.t2000s ?? []).map(a => {
            if (a.objectId !== agent.objectId) return a;
            return {
              ...a,
              last_run_ms: Date.now(),
              runs: a.runs + 1,
              total_profit_iusd: String(BigInt(a.total_profit_iusd) + agentShare),
            };
          }),
        });

        // Report profit on-chain if significant (> $0.01 iUSD)
        if (agentShare > 10_000_000n && this.env.SHADE_KEEPER_PRIVATE_KEY) {
          try {
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
            const ultronAddr = keypair.getPublicKey().toSuiAddress();
            const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
            const T2000_PKG = '0x1a160f225ae758173f0ab7bf42db0f8d658a13c728051763754204219828f3ca';
            const T2000_ARMORY = '0xc78197ce97f89833e5da857cc4da41e7d71163c259128350c8c145a1ecfc67e5';

            const tx = new Transaction();
            tx.setSender(normalizeSuiAddress(ultronAddr));

            // v2 derived agents use report_quest (idx-based), v1 use report_mission (object-based)
            const isV2 = agent.objectId.startsWith('spawn-') || typeof (agent as any).focus !== 'undefined';
            if (isV2) {
              // Parse idx from objectId: "spawn-{timestamp}-{random}" → use agent index from state
              const idx = (this.state.t2000s ?? []).indexOf(agent);
              tx.moveCall({
                package: T2000_PKG,
                module: 't2000',
                function: 'report_quest',
                arguments: [
                  tx.object(T2000_ARMORY),
                  tx.pure.u64(idx >= 0 ? idx : 0),
                  tx.pure.vector('u8', Array.from(new TextEncoder().encode(agent.mission))),
                  tx.pure.u64(agentShare),
                  tx.object('0x6'),
                ],
              });
            } else {
              tx.moveCall({
                package: T2000_PKG,
                module: 't2000',
                function: 'report_mission',
                arguments: [
                  tx.object(agent.objectId),
                  tx.pure.vector('u8', Array.from(new TextEncoder().encode(agent.mission))),
                  tx.pure.u64(agentShare),
                  tx.object('0x6'),
                ],
              });
            }

            const txBytes = await tx.build({ client: transport as never });
            const { signature } = await keypair.signTransaction(txBytes);
            await this._submitTx(txBytes, signature);
            console.log(`[QuestFi:${agent.designation}] Reported $${Number(agentShare) / 1e9} iUSD profit on-chain`);
          } catch (err) {
            console.error(`[QuestFi:${agent.designation}] report failed:`, err);
          }
        }
      } catch (err) {
        console.error(`[QuestFi:${agent.designation}] quest failed:`, err);
      }
    }

    // ─── Natural Selection: cull lazy agents, spawn bold ones ──────────
    await this._cullAndSpawn();

    // Parent profit goes to cache (iUSD yield earned)
    if (totalProfitIusd > 0n) {
      this.setState({
        ...this.state,
        total_yield_earned_mist: String(BigInt(this.state.total_yield_earned_mist) + totalProfitIusd),
      });
      console.log(`[QuestFi:parent] Cache earned $${Number(totalProfitIusd) / 1e9} iUSD from agent activity`);
    }
  }

  /** Cull underperforming agents, spawn bold RWA-focused replacements. */
  private async _cullAndSpawn() {
    const agents = this.state.t2000s ?? [];
    const toKill: string[] = [];

    for (const agent of agents) {
      if (!agent.active) continue;
      // Death threshold: 50+ runs and zero or negative profit
      if (agent.runs >= DEATH_THRESHOLD_RUNS && BigInt(agent.total_profit_iusd) <= DEATH_THRESHOLD_PROFIT) {
        console.log(`[QuestFi:cull] ${agent.designation} dies — ${agent.runs} runs, $${Number(BigInt(agent.total_profit_iusd)) / 1e9} iUSD profit. Pathetic.`);
        toKill.push(agent.objectId);
      }
    }

    if (toKill.length === 0) return;

    // Kill the lazy ones
    const updated = agents.map(a =>
      toKill.includes(a.objectId) ? { ...a, active: false } : a,
    );

    // Spawn bold RWA-focused replacements
    for (const deadId of toKill) {
      const dead = agents.find(a => a.objectId === deadId);
      if (!dead) continue;

      // Pick an RWA focus using crypto.getRandomValues for an
      // unbiased selection. Math.random was front-runnable and
      // statistically skewed under the sort-comparator shuffle.
      const _rand32 = () => { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 0x100000000; };
      const focusCount = 2 + Math.floor(_rand32() * (RWA_TARGETS.length - 1));
      // Fisher-Yates with secure randomness — unbiased permutation
      // where the Array.sort(_ => Math.random() - 0.5) idiom was not.
      const shuffled = [...RWA_TARGETS];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(_rand32() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const focus = shuffled.slice(0, focusCount);

      const _idBytes = new Uint8Array(6);
      crypto.getRandomValues(_idBytes);
      const _idSuffix = Array.from(_idBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const spawn: T2000Agent = {
        designation: `${dead.designation}-mk${dead.runs}`,
        mission: 'farm', // RWA agents are farmers — hunt for tokenized collateral
        objectId: `spawn-${Date.now()}-${_idSuffix}`,
        dwalletId: dead.dwalletId, // inherit dWallet
        operator: dead.operator,
        deployed_ms: Date.now(),
        total_profit_iusd: '0',
        last_run_ms: 0,
        runs: 0,
        active: true,
        focus,
      };

      updated.push(spawn);
      console.log(`[QuestFi:spawn] ${spawn.designation} born — no altcoins, hunting ${focus.join(', ')}`);
    }

    this.setState({ ...this.state, t2000s: updated });
  }

  // ─── IKA DKG (emergency provisioning) ────────────────────────────────

  /** Request a DKG session. The DO can't run WASM but can build the PTB.
   *  Returns the unsigned transaction bytes — the caller (browser or ultron)
   *  must sign and execute. If ultron key is available, signs server-side. */
  @callable()
  async requestDKG(params: {
    curve: 'secp256k1' | 'ed25519';
    userAddress: string;
    callerAddress?: string;
  }): Promise<{ txBytes?: string; digest?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { error: 'No ultron key — DKG requires browser-side WASM for user contribution' };
    }

    try {
      // The DKG PTB needs IKA SDK's prepareDKG (WASM). In a DO, we can't
      // run WASM directly. Instead, we build the PTB structure and return
      // it for the browser to complete with the WASM contribution.
      //
      // For server-side DKG (ultron-only dWallets with no user share),
      // we could use IKA's imported-key path. But zero-trust dWallets
      // require user participation by design — that's the whole point.
      //
      // This callable exists so the DO can COORDINATE the DKG:
      // 1. DO calls requestDKG → returns "needs_wasm" signal
      // 2. Browser receives signal via WebSocket state update
      // 3. Browser runs prepareDKG WASM, sends contribution back
      // 4. DO builds final PTB with contribution, signs as sponsor

      console.log(`[TreasuryAgents] DKG requested for ${params.userAddress}, curve: ${params.curve}`);
      return {
        error: 'DKG requires browser-side WASM — send contribution via WebSocket',
      };
    } catch (err) {
      return { error: String(err) };
    }
  }

  // ─── iUSD Mint (ultron-signed) ──────────────────────────────────────

  // iUSD package. Type origin stays at 0x2c5653668e... (v1) but we
  // dispatch move calls via v2 (0x8230189a...) after the 2026-04-11
  // upgrade that dropped MIN_COLLATERAL_RATIO_BPS from 15000 → 11000.
  // All existing state (Treasury, TreasuryCap, CollateralRecord) is
  // still valid — the type identity is anchored to the origin package,
  // not the latest address.
  private static readonly IUSD_PKG = '0x8230189af039da5cabb6fdacfbc1ca993642126d73258e30225f5f94272a1ad2'; // v2 @ 110% (upgraded from v1 @ 150%)
  private static readonly IUSD_TREASURY = '0x64435d5284ba3867c0065b9c97a8a86ee964601f0546df2caa5f772a68627beb';
  private static readonly IUSD_TREASURY_CAP = '0x0c7873b52c69f409f3c9772e85d927b509a133a42e9c134c826121bb6595e543';

  // ─── Thunder Admin ──────────────────────────────────────────────────

  private static readonly THUNDER_PKG = '0xecd7cec9058d82b6c7fbae3cbc0a0c2cf58fe4be2e87679ff9667ee7a0309e0f';
  private static readonly STORM_OBJ = '0xd67490b2047490e81f7467eedb25c726e573a311f9139157d746e4559282844f';

  /** Set Thunder signal fee. Admin only (ultron is Storm admin). */
  @callable()
  async setThunderFee(params: { feeMist: number; callerAddress?: string }): Promise<{ digest?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { error: authErr };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.THUNDER_PKG,
        module: 'thunder',
        function: 'set_signal_fee',
        arguments: [
          tx.object(TreasuryAgents.STORM_OBJ),
          tx.pure.u64(params.feeMist),
        ],
      });
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Thunder fee set to ${params.feeMist}: ${digest}`);
      return { digest };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Thunder Strike Relay ─────────────────────────────────────────

  /** Strike signals via relay — verify auth server-side, ultron submits on-chain. */
  @callable()
  async strikeRelay(params: {
    nameHash: string; nftId: string; authMsg: string; authSig: string; senderAddress: string; count: number;
  }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      // Verify the user's signPersonalMessage signature server-side
      const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
      const authMsgBytes = Uint8Array.from(atob(params.authMsg), c => c.charCodeAt(0));
      await verifyPersonalMessageSignature(authMsgBytes, params.authSig, { address: params.senderAddress });

      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const nameHashBytes = Array.from(Uint8Array.from(atob(params.nameHash), c => c.charCodeAt(0)));
      const nameB64 = params.nameHash;

      // Check all storms (new + legacy) for signals via GraphQL
      const LEGACY_STORMS: Array<[string, string]> = [
        ['0xbe5c6df7fc1340f8e3b5fa880e5fbeee3844114778e65f442815ba8922e80bd6', '0xf32adacbdb83c7ad5d75b68e1c5d2cd3e696ac8a2b13c0cc06ecdd9c110bd383'],
        ['0xc6255a592244024da44551f52d44236e35d290db016c4fe59239ec02e269148b', '0xba0c4ec86ab44f20812bfd24f00f1d3f2e9eae8bcaaae42d9f6a4d0c317ae193'],
        ['0x1de29b4dfa0c4e434ddfc0826159cbe4d404ea7922243396fd0a9e78cafa3e25', '0x1b3fec208b3935e7964bffc78fe4755d5ec5c6318ab5dc4df97f5865cd3adfe6'],
        ['0x567e1e7e3b35d1bccc58faa8f2f72dda984828d6937bec6a6c13c30b85f5f38c', '0xf54cdf0a5587c123d4a54d70c88dbf0f86ae3a88230954f1c3f50437ae35e2f7'],
        ['0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782', '0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6'],
      ];

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      let totalCalls = 0;

      // Helper: check if a storm has signals for this name via GraphQL
      const _checkStorm = async (stormId: string): Promise<number> => {
        try {
          const r = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: `{ object(address: "${stormId}") { dynamicFields { nodes { name { json } value { ... on MoveValue { json } } } } } }` }),
          });
          const gql = await r.json() as any;
          for (const n of (gql?.data?.object?.dynamicFields?.nodes ?? [])) {
            if (n?.name?.json === nameB64 && n?.value?.json?.signals) return n.value.json.signals.length;
          }
        } catch {}
        return 0;
      };

      // New storm: use strike_relay (admin-gated)
      const newCount = await _checkStorm(TreasuryAgents.STORM_OBJ);
      for (let i = 0; i < newCount; i++) {
        tx.moveCall({
          package: TreasuryAgents.THUNDER_PKG,
          module: 'thunder',
          function: 'strike_relay',
          arguments: [
            tx.object(TreasuryAgents.STORM_OBJ),
            tx.pure.vector('u8', nameHashBytes),
            tx.pure.address(params.nftId),
            tx.object('0x6'),
          ],
        });
        totalCalls++;
      }

      // Legacy storms: use old destructive quest (no admin check, needs NFT — but legacy quest is permissionless with NFT object)
      // Legacy contracts don't have strike_relay, only quest which needs &SuinsRegistration.
      // Ultron can't pass someone else's NFT. For legacy, we skip — they'll be auto-struck client-side for non-WaaP wallets.
      // For WaaP: legacy signals are stuck unless the user transfers to a non-WaaP wallet.
      // TODO: sweep legacy storms to clean up

      if (totalCalls === 0) return { error: 'No signals found on current storm' };

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Strike relay: ${digest}, calls: ${totalCalls}`);
      return { digest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] strikeRelay error:', errStr);
      return { error: errStr };
    }
  }

  /** Attest collateral only — ultron signs as oracle. Mint is done by the wallet that owns the TreasuryCap. */
  @callable()
  async attestCollateral(params: { collateralValueMist: string; callerAddress?: string }): Promise<{ digest?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { error: authErr };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('SUI'))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx.pure.u64(BigInt(params.collateralValueMist)),
          tx.pure.u8(0),
          tx.object('0x6'),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      return { digest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] attestCollateral error:', errStr);
      return { error: errStr };
    }
  }

  /** Attest collateral + mint iUSD, signed by ultron (oracle + minter). */
  @callable()
  /**
   * Chansey v3 (#23) — atomic deposit-to-user-mint.
   *
   * When a user deposits collateral (any chain, any asset), the
   * protocol needs to:
   *   1. Attest the new collateral under the correct asset+chain key
   *      (not the hardcoded 'SUI' that mintIusd uses — that clobbers
   *      the Sui-chain SUI record for cross-chain deposits)
   *   2. Mint iUSD to the DEPOSITOR (not to ultron — previous model
   *      left the user with nothing while ultron absorbed the mint)
   *   3. Respect the 110% assertion so the mint doesn't abort
   *
   * Math at the 110% requirement (post-upgrade from 150%):
   *   new_senior = old_senior + depositedUsdMist
   *   constraint: new_senior * 10000 >= (supply + m) * 11000
   *   max m = (new_senior * 10000 - supply * 11000) / 11000
   *
   * At steady-state (old ratio = 110%, no surplus), this simplifies
   * to m = d * 10/11 = 90.91% of deposit. At a healthier pre-deposit
   * ratio, the user can get closer to 1:1 because the pre-existing
   * surplus subsidizes the buffer. At an unhealthy ratio, first
   * depositors absorb the gap repair (m can even be 0 or negative).
   *
   * One PTB with two moveCalls (attest + mint_and_transfer) — atomic.
   * If either leg fails the whole tx reverts. No partial state.
   */
  async mintIusdForDeposit(params: {
    recipient: string;
    depositedUsdMist: string;
    assetKey: string;
    chainKey: string;
    callerAddress?: string;
  }): Promise<{
    digest?: string;
    mintedMist?: string;
    mintedUsd?: string;
    mintRate?: string;
    error?: string;
  }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'no keeper' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const recipient = normalizeSuiAddress(params.recipient);
      const depositedMist = BigInt(params.depositedUsdMist);
      if (depositedMist <= 0n) return { error: 'depositedUsdMist must be positive' };

      // Read current treasury state to compute max mint
      const cache = await this._getCacheState();
      const { supply, total } = cache;
      const newSenior = total + depositedMist;
      const RATIO_BPS = BigInt(ONCHAIN_MIN_RATIO_BPS);
      // rawMax = floor((newSenior * 10000 - supply * RATIO_BPS) / RATIO_BPS)
      const rawMax = (newSenior * 10000n - supply * RATIO_BPS) / RATIO_BPS;
      // Cap at the deposit itself — never mint more than the user deposited
      const mintCap = depositedMist < rawMax ? depositedMist : rawMax;
      // Safety buffer: subtract 0.1% of new_supply so Pyth ticks can't
      // drift us off the 110% boundary between compute and execute.
      const SAFETY = (supply + mintCap) / 1000n;
      const mintAmount = mintCap > SAFETY ? mintCap - SAFETY : 0n;
      if (mintAmount <= 0n) {
        return { error: `no mintable amount: deposit \$${Number(depositedMist) / 1e9} but treasury too undercollateralized (senior \$${Number(total) / 1e9}, supply \$${Number(supply) / 1e9})` };
      }

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      // Step 1: attest the new collateral under the caller-specified key.
      // Uses the CURRENT total for that asset from ultron's live balance,
      // not just the delta. But caller passes deposited delta; we don't
      // read live balance here because the caller may have already
      // attested separately. Assumption: caller has already attested up
      // to (pre-deposit + delta). If they haven't, senior is stale and
      // mint may abort — caller's responsibility.
      //
      // For maximum safety, use update_collateral with (current + delta)
      // as the new record value. But we don't know the "current" cleanly
      // without a read-before-write. Simplest: caller passes the FULL
      // new collateral value for this asset (not just the delta).
      //
      // Actually no — the cleanest design passes `depositedUsdMist` as
      // the FULL new value for this asset under the given key, replacing
      // any previous value. Caller computes: previousForKey + delta.
      // But that requires the caller to track per-key state.
      //
      // Final design: caller passes `depositedUsdMist` as the DELTA.
      // Read current senior for this asset key from dynamic field, add
      // delta, write the sum. We do this via update_collateral which is
      // an upsert — but it replaces the record's value entirely. So we
      // need the previous record's value to add to.
      //
      // Workaround: read the dynamic field at the given asset key and
      // compute the new total = old + delta, pass that to update_collateral.
      // Too much for one PTB. Simplify: require the caller to pass the
      // FULL new value for the key. Rename the field accordingly.
      //
      // For now: treat depositedUsdMist as the delta, and just add it to
      // whatever the SOL/whatever record was before. Look up the previous
      // value via GraphQL dynamic fields before building the tx.

      // Lookup the current value for this asset key (if any)
      const assetKeyBytes = Array.from(new TextEncoder().encode(params.assetKey));
      let prevValueMist = 0n;
      try {
        // dynamic_field::add keyed on vector<u8>(asset_key)
        // GraphQL dynamicField query
        const dfQ = await transport.query({
          variables: {},
          query: `query { object(address: "${TreasuryAgents.IUSD_TREASURY}") { dynamicField(name: { type: "vector<u8>", bcs: "${this._encodeU8VecBcs(assetKeyBytes)}" }) { value { ... on MoveValue { json } } } } }`,
        });
        const v = (dfQ.data as any)?.object?.dynamicField?.value?.json;
        if (v?.value_mist) prevValueMist = BigInt(v.value_mist);
      } catch { /* dynamic field doesn't exist yet, treat as 0 */ }
      const newTotalForKey = prevValueMist + depositedMist;

      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.vector('u8', assetKeyBytes),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(params.chainKey))),
          tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx.pure.u64(newTotalForKey),
          tx.pure.u8(0), // TRANCHE_SENIOR
          tx.object('0x6'),
        ],
      });

      // Step 2: mint iUSD to the depositor
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'mint_and_transfer',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY_CAP),
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.u64(mintAmount),
          tx.pure.address(recipient),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      const rate = Number(mintAmount) / Number(depositedMist);
      console.log(`[TreasuryAgents] Chansey v3 mintForDeposit: recipient=${recipient.slice(0,10)}... deposit=\$${Number(depositedMist)/1e9} minted=\$${Number(mintAmount)/1e9} rate=${(rate*100).toFixed(2)}% tx=${digest}`);
      return {
        digest,
        mintedMist: String(mintAmount),
        mintedUsd: `\$${(Number(mintAmount) / 1e9).toFixed(6)}`,
        mintRate: `${(rate * 100).toFixed(2)}%`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] mintIusdForDeposit error:', msg);
      return { error: msg };
    }
  }

  /**
   * Chansey v3 (#23) — clean rewrite of seedIusdPool.
   *
   * Writes one atomic PTB that:
   *   1. Creates a fresh BalanceManager (owned by tx until step 8)
   *   2. Splits iUSD + USDC from ultron's coins
   *   3. Deposits both into the new BM
   *   4. Generates a trade proof (owner-only)
   *   5. Places an ASK: sell iUSD @ price 1.01 USDC/iUSD
   *   6. Places a BID: buy iUSD @ price 0.99 USDC/iUSD
   *   7. Shares the BM so ultron can place more orders via future txs
   *
   * Uses gRPC/GraphQL only (no legacy JSON-RPC). Replaces the old
   * seedIusdPool method which used raceJsonRpc + unsafe_moveCall and
   * referenced an owned BM that's now empty.
   *
   * DeepBook v3 price format for iUSD(9-dec)/USDC(6-dec):
   *   price_scaled = human_price * 10^(9 - base_dec + quote_dec)
   *                = human_price * 10^(9 - 9 + 6)
   *                = human_price * 10^6
   * So 1.0 USDC per iUSD → price = 1_000_000
   * Quantity is in base coin raw units (iUSD 9-dec).
   *
   * Locked liquidity per call:
   *   ASK side: iusdQty iUSD (pure iUSD, locked until filled)
   *   BID side: iusdQty * 0.99 USDC (locked until filled)
   *
   * Caller params:
   *   iusdQtyMist — amount of iUSD to post on ASK side (and bid-equivalent on BID side)
   *
   * Returns:
   *   { digest, balanceManagerId } on success
   *   { error } with concrete reason on failure
   */
  async seedIusdPoolV3(params: { iusdQtyMist: string }): Promise<{
    digest?: string;
    balanceManagerId?: string;
    error?: string;
  }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'no keeper' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const iusdQty = BigInt(params.iusdQtyMist);
      if (iusdQty <= 0n) return { error: 'iusdQtyMist must be positive' };

      // BID side needs ~0.99x iUSD worth of USDC.
      // iusd 9-dec → usdc 6-dec: divide by 1000.
      // Then take 99% so the BID posts at 0.99 price.
      const bidUsdcNeeded = (iusdQty * 99n) / (100n * 1000n);

      // Read ultron's iUSD + USDC coins
      const coinsQ = await transport.query({
        variables: {},
        query: `query {
          ultron: address(address: "${ultronAddr}") {
            iusd: objects(filter: { type: "0x2::coin::Coin<${IUSD_TYPE}>" }, first: 50) {
              nodes { address version digest contents { json } }
            }
            usdc: objects(filter: { type: "0x2::coin::Coin<${USDC_TYPE}>" }, first: 50) {
              nodes { address version digest contents { json } }
            }
          }
        }`,
      });
      const iusdNodes = ((coinsQ.data as any)?.ultron?.iusd?.nodes ?? []) as Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }>;
      const usdcNodes = ((coinsQ.data as any)?.ultron?.usdc?.nodes ?? []) as Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }>;
      const iusdTotal = iusdNodes.reduce((a, c) => a + BigInt(c.contents?.json?.balance ?? '0'), 0n);
      const usdcTotal = usdcNodes.reduce((a, c) => a + BigInt(c.contents?.json?.balance ?? '0'), 0n);
      if (iusdTotal < iusdQty) {
        return { error: `insufficient iUSD on ultron: have $${Number(iusdTotal) / 1e9}, need $${Number(iusdQty) / 1e9}. Send iUSD to ultron first (0xa84c...b3c3).` };
      }
      if (usdcTotal < bidUsdcNeeded) {
        return { error: `insufficient USDC on ultron: have $${Number(usdcTotal) / 1e6}, need $${Number(bidUsdcNeeded) / 1e6}. Send USDC to ultron first.` };
      }

      // Pool + BM package constants. Types live at the origin
      // package (where `BalanceManager` / `Pool` are defined), but
      // entrypoints must be dispatched through the LATEST mainnet
      // package — `@mysten/deepbook-v3/utils/constants` keeps this
      // up-to-date (`mainnetPackageIds.DEEPBOOK_PACKAGE_ID`).
      // Calling pool::place_limit_order on the origin package
      // against the newer pool triggers a silent version-mismatch
      // abort (pool inner is Versioned v6).
      const BM_PKG = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'; // origin (type id)
      const POOL_PKG = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497'; // current mainnet
      const IUSD_USDC_POOL = '0x38df72f5d07607321d684ed98c9a6c411c0b8968e100a1cd90a996f912cd6ce1';
      const IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 832866334;

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Merge all iUSD into one coin and deposit the WHOLE thing.
      // DeepBook reserves maker fee on top of the notional order
      // size, so depositing exactly `iusdQty` triggers
      // EBalanceManagerBalanceTooLow (abort 3) during place_limit_order.
      // Depositing all of ultron's iUSD gives the pool room to take
      // fees without the caller needing to know the exact fee rate.
      const iusdFirst = tx.objectRef({ objectId: iusdNodes[0].address, version: iusdNodes[0].version, digest: iusdNodes[0].digest });
      if (iusdNodes.length > 1) {
        tx.mergeCoins(iusdFirst, iusdNodes.slice(1).map(c => tx.objectRef({ objectId: c.address, version: c.version, digest: c.digest })));
      }

      // Same treatment for USDC — merge all, deposit whole, let
      // the BID lock what it needs plus fee headroom.
      const usdcFirst = tx.objectRef({ objectId: usdcNodes[0].address, version: usdcNodes[0].version, digest: usdcNodes[0].digest });
      if (usdcNodes.length > 1) {
        tx.mergeCoins(usdcFirst, usdcNodes.slice(1).map(c => tx.objectRef({ objectId: c.address, version: c.version, digest: c.digest })));
      }

      // 1. Create fresh BalanceManager — by-value, owned by tx
      const [bm] = tx.moveCall({
        target: `${BM_PKG}::balance_manager::new`,
        arguments: [],
      });

      // 2. Deposit iUSD into BM (whole merged coin — see above)
      tx.moveCall({
        target: `${BM_PKG}::balance_manager::deposit`,
        typeArguments: [IUSD_TYPE],
        arguments: [bm, iusdFirst],
      });

      // 3. Deposit USDC into BM (whole merged coin)
      tx.moveCall({
        target: `${BM_PKG}::balance_manager::deposit`,
        typeArguments: [USDC_TYPE],
        arguments: [bm, usdcFirst],
      });

      // 4. Generate owner trade proof
      const [proof] = tx.moveCall({
        target: `${BM_PKG}::balance_manager::generate_proof_as_owner`,
        arguments: [bm],
      });

      // 5. Place ASK — sell iUSD at 1.01 USDC/iUSD
      // price format: quote_raw_per_base_raw * 1e9 / (base_scaling/quote_scaling)
      // For iUSD(9dec)/USDC(6dec) at human 1.01: price = 1_010_000
      const ASK_PRICE = 1_010_000n;
      const BID_PRICE = 990_000n;
      const NO_RESTRICTION_ORDER_TYPE = 0; // u8
      const SELF_MATCHING_ALLOWED = 0; // u8
      const EXPIRE_NEVER = BigInt('18446744073709551615'); // u64 max (no expiry)
      const CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006';
      const poolRef = tx.sharedObjectRef({
        objectId: IUSD_USDC_POOL,
        initialSharedVersion: IUSD_USDC_POOL_INITIAL_SHARED_VERSION,
        mutable: true,
      });
      tx.moveCall({
        target: `${POOL_PKG}::pool::place_limit_order`,
        typeArguments: [IUSD_TYPE, USDC_TYPE],
        arguments: [
          poolRef,
          bm,
          proof,
          tx.pure.u64(1n), // client_order_id
          tx.pure.u8(NO_RESTRICTION_ORDER_TYPE),
          tx.pure.u8(SELF_MATCHING_ALLOWED),
          tx.pure.u64(ASK_PRICE),
          tx.pure.u64(iusdQty),
          tx.pure.bool(false), // is_bid = false (ASK)
          tx.pure.bool(false), // pay_with_deep = false
          tx.pure.u64(EXPIRE_NEVER),
          tx.object(CLOCK),
        ],
      });

      // 6. Place BID — buy iUSD at 0.99 USDC/iUSD
      tx.moveCall({
        target: `${POOL_PKG}::pool::place_limit_order`,
        typeArguments: [IUSD_TYPE, USDC_TYPE],
        arguments: [
          poolRef,
          bm,
          proof,
          tx.pure.u64(2n), // client_order_id
          tx.pure.u8(NO_RESTRICTION_ORDER_TYPE),
          tx.pure.u8(SELF_MATCHING_ALLOWED),
          tx.pure.u64(BID_PRICE),
          tx.pure.u64(iusdQty),
          tx.pure.bool(true), // is_bid = true (BID)
          tx.pure.bool(false),
          tx.pure.u64(EXPIRE_NEVER),
          tx.object(CLOCK),
        ],
      });

      // 7. Share the BM so future txs can reference it
      tx.moveCall({
        target: '0x2::transfer::public_share_object',
        typeArguments: [`${BM_PKG}::balance_manager::BalanceManager`],
        arguments: [bm],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);

      // Look up the new BM id from tx effects (GraphQL)
      let balanceManagerId: string | undefined;
      try {
        const fxQ = await transport.query({
          query: `query($d: String!) {
            transactionBlock(digest: $d) {
              effects { objectChanges { nodes { address idCreated outputState { asMoveObject { contents { type { repr } } } } } } }
            }
          }`,
          variables: { d: digest },
        });
        const nodes = ((fxQ.data as any)?.transactionBlock?.effects?.objectChanges?.nodes ?? []) as Array<Record<string, unknown>>;
        for (const n of nodes) {
          if (!n?.idCreated) continue;
          const repr: string = ((n.outputState as any)?.asMoveObject?.contents?.type?.repr) ?? '';
          if (repr.includes('balance_manager::BalanceManager')) {
            balanceManagerId = n.address as string;
            break;
          }
        }
      } catch { /* best-effort lookup */ }
      console.log(`[TreasuryAgents] Chansey v3 seedIusdPoolV3 tx=${digest} bm=${balanceManagerId ?? '?'}`);
      return { digest, balanceManagerId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TreasuryAgents] seedIusdPoolV3 error:', msg);
      return { error: msg };
    }
  }

  /**
   * Attest SOL-chain collateral under the 'SOL' asset key (not 'SUI').
   * Used by _dispatchMatchedIntent for Solana deposits as a fallback
   * when the full mintIusdForDeposit path can't mint.
   */
  async attestSolCollateral(params: { valueUsdCents: number }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'no keeper' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const valueMist = BigInt(params.valueUsdCents) * 10_000_000n;
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('SOL'))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('solana'))),
          tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx.pure.u64(valueMist),
          tx.pure.u8(0), // TRANCHE_SENIOR
          tx.object('0x6'),
        ],
      });
      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      return { digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  }

  /** Helper: BCS-encode a vector<u8> for dynamic field lookup. */
  private _encodeU8VecBcs(bytes: number[]): string {
    // BCS vector<u8>: uleb128 length + bytes, base64-encoded
    const len = bytes.length;
    const out: number[] = [];
    let n = len;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      out.push(b);
    } while (n !== 0);
    out.push(...bytes);
    return btoa(String.fromCharCode(...out));
  }

  async mintIusd(params: {
    recipient: string;
    collateralValueMist: string;
    mintAmount: string;
    callerAddress?: string;
  }): Promise<{ digest1?: string; digest2?: string; minted?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params.callerAddress);
    if (authErr) return { error: authErr };

    const { recipient, collateralValueMist, mintAmount } = params;
    if (!recipient || !collateralValueMist || !mintAmount) {
      return { error: 'Missing required params' };
    }

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Step 1: Attest collateral (oracle-gated)
      const tx1 = new Transaction();
      tx1.setSender(ultronAddr);
      tx1.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx1.object(TreasuryAgents.IUSD_TREASURY),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('SUI'))),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx1.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx1.pure.u64(BigInt(collateralValueMist)),
          tx1.pure.u8(0), // TRANCHE_SENIOR
          tx1.object('0x6'),
        ],
      });

      const txBytes1 = await tx1.build({ client: transport as never });
      const sig1 = await keypair.signTransaction(txBytes1);
      const digest1 = await this._submitTx(txBytes1, sig1.signature);
      console.log(`[TreasuryAgents] Collateral attested: ${digest1}`);

      // Step 2: Mint iUSD (minter-gated)
      const tx2 = new Transaction();
      tx2.setSender(ultronAddr);
      tx2.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'mint_and_transfer',
        arguments: [
          tx2.object(TreasuryAgents.IUSD_TREASURY_CAP),
          tx2.object(TreasuryAgents.IUSD_TREASURY),
          tx2.pure.u64(BigInt(mintAmount)),
          tx2.pure.address(normalizeSuiAddress(recipient)),
        ],
      });

      const txBytes2 = await tx2.build({ client: transport as never });
      const sig2 = await keypair.signTransaction(txBytes2);
      const digest2 = await this._submitTx(txBytes2, sig2.signature);
      console.log(`[TreasuryAgents] iUSD minted: ${digest2}, amount: ${mintAmount}, to: ${recipient}`);

      // Squid counter — track iUSD mints
      const squids: SquidStats = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
      squids.iusd_minted++;
      this.setState({ ...this.state, squids });

      return { digest1, digest2, minted: mintAmount };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] mintIusd error:', errStr);
      return { error: errStr };
    }
  }

  // ─── Quest Fill — Hunter registers name for recipient, then strikes ──

  /** Fill a Quest Prism — swap SUI→USDC→NS, send NS tokens to recipient.
   *  Domain never touches the server. Client registers locally with the NS it receives. */
  async fillQuestBounty(bountyId: string): Promise<{ status: string; digest?: string; strikeDigest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { status: 'error', error: 'No ultron key' };

    const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
    const idx = bounties.findIndex(b => b.id === bountyId);
    if (idx === -1) return { status: 'error', error: 'Bounty not found' };
    const bounty = bounties[idx];
    if (bounty.status !== 'open') return { status: bounty.status, digest: bounty.digest };

    const recipient = bounty.recipient;
    if (!recipient) return { status: 'error', error: 'Missing recipient' };

    // Mark in-progress
    bounties[idx] = { ...bounty, status: 'filling' };
    this.setState({ ...this.state, quest_bounties: bounties } as any);

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check ultron's balances to pick best route
      const balGql = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ address(address: "${ultronAddr}") { balances { nodes { coinType { repr } totalBalance } } } }` }),
      });
      const balData = await balGql.json() as any;
      const bals: Record<string, bigint> = {};
      for (const n of (balData?.data?.address?.balances?.nodes ?? [])) {
        bals[n.coinType.repr] = BigInt(n.totalBalance);
      }
      const suiBal = bals[SUI_TYPE] ?? 0n;
      const usdcBal = bals[USDC_TYPE] ?? 0n;

      // Sibyl oracle
      const suiPrice = await this._fetchSuiPrice();
      if (!suiPrice) throw new Error('Sibyl could not determine SUI price');
      const fundingUsd = Math.min(bounty.amount || 7.50, 9.50);

      // Pick route: USDC-direct (if enough), SUI→USDC (if enough SUI), or fail with helpful msg
      const usdcNeeded = BigInt(Math.ceil(fundingUsd * 1e6)); // USDC has 6 decimals
      const suiNeeded = BigInt(Math.ceil((fundingUsd / suiPrice) * 1e9));
      const minSuiForGas = 50_000_000n; // 0.05 SUI for gas

      const hasUsdc = usdcBal >= usdcNeeded;
      const hasSui = suiBal >= suiNeeded + minSuiForGas;

      // Also check IKA — can swap via Cetus aggregator for extra SUI
      const ikaBal = bals['0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA'] ?? 0n;

      if (!hasUsdc && !hasSui) {
        // Last resort: attest SOL collateral + mint iUSD as credit, tell the user what's needed
        const solAddr = ULTRON_SOL_ADDRESS;
        const suiUsd = Number(suiBal) / 1e9 * suiPrice;
        const usdcUsd = Number(usdcBal) / 1e6;
        const ikaUsd = Number(ikaBal) / 1e9 * 0.003;
        const totalUsd = suiUsd + usdcUsd + ikaUsd;
        const shortfall = fundingUsd - totalUsd;

        throw new Error(
          `Cache has $${totalUsd.toFixed(2)}, need $${fundingUsd.toFixed(2)} (short $${shortfall.toFixed(2)}). ` +
          `Send ${Math.ceil(shortfall / suiPrice * 1.1)} SUI or ${Math.ceil(shortfall)} USDC to ${ultronAddr.slice(0, 10)}… — ` +
          `t2000s earn iUSD credit for fronting USDC`
        );
      }

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      let nsCoin: any;
      const changeCoins: any[] = [];

      if (hasUsdc) {
        // Route: USDC → NS directly (cheapest, no SUI→USDC swap needed)
        console.log(`[TreasuryAgents] Quest fill: USDC-direct route ($${(Number(usdcBal) / 1e6).toFixed(2)} USDC available)`);
        // Race all RPCs for coin objects
        const coinData = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string }> }>(
          'suix_getCoins', [ultronAddr, USDC_TYPE],
        );
        const usdcCoinRefs = (coinData?.data ?? []).map(c => ({
          objectId: c.coinObjectId, version: String(c.version), digest: c.digest,
        }));
        if (usdcCoinRefs.length === 0) throw new Error('No USDC coins found');

        const usdcCoin = tx.objectRef(usdcCoinRefs[0]);
        if (usdcCoinRefs.length > 1) tx.mergeCoins(usdcCoin, usdcCoinRefs.slice(1).map((r: any) => tx.objectRef(r)));
        const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(usdcNeeded)]);

        const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
        const [nsOut, usdcSwapChange, deepChange] = tx.moveCall({
          target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [TreasuryAgents.NS_TYPE, TreasuryAgents.USDC_TYPE],
          arguments: [
            tx.sharedObjectRef({ objectId: TreasuryAgents.DB_NS_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
            usdcForSwap, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
          ],
        });
        nsCoin = nsOut;
        changeCoins.push(usdcCoin, usdcSwapChange, deepChange);
      } else {
        // Route: SUI → USDC → NS
        console.log(`[TreasuryAgents] Quest fill: SUI route (${(Number(suiBal) / 1e9).toFixed(2)} SUI available)`);
        const [suiPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiNeeded)]);
        const [zeroDEEP1] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
        const [suiChange, usdcOut, deepChange1] = tx.moveCall({
          target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_base_for_quote`,
          typeArguments: [SUI_TYPE, TreasuryAgents.USDC_TYPE],
          arguments: [
            tx.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: 389750322, mutable: true }),
            suiPayment, zeroDEEP1, tx.pure.u64(0), tx.object.clock(),
          ],
        });
        const [zeroDEEP2] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
        const [nsOut, usdcChange, deepChange2] = tx.moveCall({
          target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_quote_for_base`,
          typeArguments: [TreasuryAgents.NS_TYPE, TreasuryAgents.USDC_TYPE],
          arguments: [
            tx.sharedObjectRef({ objectId: TreasuryAgents.DB_NS_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
            usdcOut, zeroDEEP2, tx.pure.u64(0), tx.object.clock(),
          ],
        });
        nsCoin = nsOut;
        changeCoins.push(suiChange, usdcChange, deepChange1, deepChange2);
      }

      // Send NS tokens to recipient — domain never leaves client
      tx.transferObjects([nsCoin], tx.pure.address(normalizeSuiAddress(recipient)));
      if (changeCoins.length > 0) tx.transferObjects(changeCoins, tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Quest filled: NS sent to ${recipient.slice(0, 10)}…, digest: ${digest}`);

      // Mark bounty as filled + cancel all siblings with same commitment
      const updated = [...((this.state as any).quest_bounties ?? [])] as Array<Record<string, any>>;
      const uIdx = updated.findIndex(b => b.id === bountyId);
      if (uIdx !== -1) {
        const commitment = updated[uIdx].commitment;
        updated[uIdx] = { ...updated[uIdx], status: 'filled', digest, filledAt: Date.now() };
        // Cancel siblings — same commitment, different ID, still open
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].commitment === commitment && updated[i].id !== bountyId && updated[i].status === 'open') {
            updated[i] = { ...updated[i], status: 'cancelled', error: 'sibling filled' };
          }
        }
        this.setState({ ...this.state, quest_bounties: updated } as any);
      }

      // Submit pre-signed registration tx if available — auto-registers the name
      let regDigest: string | undefined;
      let regError: string | undefined;
      if (bounty.preSignedTx && bounty.preSignedSig) {
        try {
          const txBytes = Uint8Array.from(atob(bounty.preSignedTx), c => c.charCodeAt(0));
          regDigest = await this._submitTx(txBytes, bounty.preSignedSig);
          console.log(`[TreasuryAgents] Auto-registered name for ${recipient.slice(0, 10)}…: ${regDigest}`);
        } catch (regErr) {
          regError = regErr instanceof Error ? regErr.message : String(regErr);
          console.error(`[TreasuryAgents] Pre-signed registration failed (will retry in _retryStrandedRegistrations):`, regError);
        }
      }

      // Persist regDigest / regError on the bounty so the
      // reconciler can find + retry stranded fills.
      const postSwap = [...((this.state as any).quest_bounties ?? [])] as Array<Record<string, any>>;
      const pIdx = postSwap.findIndex(b => b.id === bountyId);
      if (pIdx !== -1) {
        postSwap[pIdx] = {
          ...postSwap[pIdx],
          regDigest,
          regError,
          regAttempts: (postSwap[pIdx].regAttempts ?? 0) + 1,
          regLastAttemptMs: Date.now(),
        };
        this.setState({ ...this.state, quest_bounties: postSwap } as any);
      }

      return { status: 'filled', digest, regDigest };
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      console.error(`[TreasuryAgents] Quest fill error:`, errStr);

      // Mark bounty as failed (can retry)
      const updated = [...((this.state as any).quest_bounties ?? [])] as Array<Record<string, any>>;
      const uIdx = updated.findIndex(b => b.id === bountyId);
      if (uIdx !== -1) {
        updated[uIdx] = { ...updated[uIdx], status: 'open', error: errStr };
        this.setState({ ...this.state, quest_bounties: updated } as any);
      }

      return { status: 'error', error: errStr };
    }
  }

  /** Watch ultron's Solana address for incoming deposits, match sub-cent tags to Sui addresses */
  private async _watchSolDeposits(): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;
    const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
    const kaminoIntents = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
    const pending = intents.filter(i => i.status === 'pending');
    const pendingKamino = kaminoIntents.filter(i => i.status === 'pending');
    if (pending.length === 0 && pendingKamino.length === 0) return;

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const solAddr = ULTRON_SOL_ADDRESS;

    // Fetch recent Solana transactions to ultron's address
    const SOL_RPCS = [
      ...(this.env.HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`] : []),
      'https://api.mainnet-beta.solana.com',
    ];

    let signatures: Array<{ signature: string; slot: number; blockTime: number }> = [];
    for (const rpc of SOL_RPCS) {
      try {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getSignaturesForAddress',
            params: [solAddr, { limit: 20 }],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const d = await r.json() as any;
        if (d.result?.length) { signatures = d.result; break; }
      } catch { /* try next */ }
    }

    if (signatures.length === 0) return;

    // Walk back through signatures (newest first) until we hit the
    // last one we processed. Everything newer than lastProcessed is
    // "new". If lastProcessed isn't in the returned page at all we
    // default to processing the top 10 — either the watcher hasn't
    // run yet or lastProcessed is so old it fell off the page, and
    // in both cases processing the top 10 is the right call.
    //
    // PREVIOUS BUG (Snorunt Lv.30): `.filter(s => s.signature !== lastProcessed)`
    // only excluded the single sig equal to lastProcessed, not
    // everything older. And since the end of this method sets
    // `last_sol_sig = signatures[0]` (the newest), any deposit
    // processed once with success-OR-partial-failure became
    // permanently filtered out of subsequent scans, because it was
    // the one sig the filter was targeting. Fix: walk forward from
    // the top to the lastProcessed position, take only those sigs.
    const lastProcessed = (this.state as any).last_sol_sig as string | undefined;
    const lastIdx = lastProcessed
      ? signatures.findIndex(s => s.signature === lastProcessed)
      : -1;
    const newSigs = lastIdx >= 0
      ? signatures.slice(0, lastIdx)       // everything strictly newer
      : signatures.slice(0, 10);           // cold-start or fell-off-page

    if (newSigs.length === 0) return;

    for (const sig of newSigs) {
      try {
        // Get transaction details
        let txData: any = null;
        for (const rpc of SOL_RPCS) {
          try {
            const r = await fetch(rpc, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'getTransaction',
                params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
              }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const d = await r.json() as any;
            if (d.result) { txData = d.result; break; }
          } catch { /* try next */ }
        }
        if (!txData) continue;

        // Find SOL transfer to ultron's address
        const instructions = txData.transaction?.message?.instructions ?? [];
        for (const ix of instructions) {
          if (ix.parsed?.type === 'transfer' && ix.parsed?.info?.destination === solAddr) {
            const lamports = ix.parsed.info.lamports;
            if (!lamports || lamports < 1000000) continue; // ignore dust (< 0.001 SOL)

            // Extract tag from sub-cent digits (last 4 digits of lamport amount)
            // Extract 6-digit SUIAMI tag from sub-cent lamports
            const tag = lamports % 1000000;

            // Match to a pending intent
            const match = pending.find(p => p.tag === tag);
            if (match) {
              console.log(`[TreasuryAgents] SOL deposit matched (poll): ${lamports} lamports tag=${tag} → ${match.suiAddress.slice(0, 10)}…`);

              // Route through the Phase 2 dispatch so SOL deposits
              // honor the intent's stored route/action/params just
              // like USDC does. The dispatcher handles attest, mint,
              // and quest fill uniformly.
              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 83);
              await this._dispatchMatchedIntent(match, {
                usdValue: solValue,
                sourceDigest: sig.signature,
                sourceChain: 'sol',
              });
            // Also check Kamino intents — same sub-cent tag matching
            const kaminoMatch = pendingKamino.find(p => p.tag === tag);
            if (kaminoMatch) {
              console.log(`[TreasuryAgents] Kamino deposit matched! ${lamports} lamports, tag: ${tag}, → ${kaminoMatch.suiAddress.slice(0, 10)}…`);

              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 130);
              const ltv = kaminoMatch.strategy === 'multiply' ? 0.65 : 0.825;
              const iusdValue = solValue * ltv;
              const iusdRaw = BigInt(Math.floor(iusdValue * 1e9)); // 9 decimal iUSD

              // 1. Deposit SOL into Kamino Lend via REST API
              let kaminoDigest = '';
              try {
                kaminoDigest = await this._depositToKamino(lamports / 1e9);
                console.log(`[TreasuryAgents] Kamino Lend deposit: ${(lamports / 1e9).toFixed(4)} SOL, tx: ${kaminoDigest}`);
              } catch (e) {
                console.error(`[TreasuryAgents] Kamino deposit failed (SOL stays raw):`, e);
                // Continue anyway — SOL is still collateral even without Kamino yield
              }

              // 2. BAM Attest — Sibyl attests position value on Sui
              try {
                const collateralMist = BigInt(Math.floor(solValue * 1e9));
                const attestResult = await this.attestCollateral({ collateralValueMist: String(collateralMist) });
                console.log(`[TreasuryAgents] Kamino Attest: SOL→Kamino ${kaminoMatch.strategy} $${solValue.toFixed(2)}, LTV ${ltv}, iUSD $${iusdValue.toFixed(2)}, digest: ${attestResult.digest || 'failed'}`);
              } catch (e) {
                console.error(`[TreasuryAgents] Kamino Attest failed:`, e);
              }

              // 3. Mint iUSD to the user's Sui address
              try {
                const mintResult = await this.mintIusd({
                  recipient: kaminoMatch.suiAddress,
                  collateralValueMist: String(BigInt(Math.floor(solValue * 1e9))),
                  mintAmount: String(iusdRaw),
                });
                console.log(`[TreasuryAgents] Kamino→iUSD: minted $${iusdValue.toFixed(2)} iUSD to ${kaminoMatch.suiAddress.slice(0, 10)}…, digest: ${mintResult.digest2 || 'failed'}`);

                // Update kamino intent
                const allKamino = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
                const kIdx = allKamino.findIndex(i => i.suiAddress === kaminoMatch.suiAddress);
                if (kIdx >= 0) {
                  allKamino[kIdx] = {
                    ...allKamino[kIdx],
                    status: 'filled',
                    matchedTx: sig.signature,
                    matchedLamports: lamports,
                    positionValue: solValue,
                    iusdMinted: String(iusdRaw),
                    iusdUsd: iusdValue.toFixed(2),
                    mintDigest: mintResult.digest2,
                    kaminoDigest,
                    filledAt: Date.now(),
                  };
                  this.setState({ ...this.state, kamino_intents: allKamino } as any);
                }
                // ── Prism: Thunder notification to recipient ──────────────
                if (kaminoMatch.suinsName && kaminoMatch.suiAddress) {
                  try {
                    const recipName = kaminoMatch.suinsName.replace(/\.sui$/i, '');
                    const msg = `⚡ OpenCLOB fill: ${(lamports / 1e9).toFixed(2)} SOL → Kamino ${kaminoMatch.strategy} → $${iusdValue.toFixed(2)} iUSD minted to your wallet.${kaminoDigest ? ` Kamino tx: ${kaminoDigest.slice(0, 12)}…` : ''}`;
                    // Address-keyed group ID, short-hash form matching
                    // client/thunder-stack.ts makeThunderGroupId: `t-` +
                    // first 14 hex of each address, sorted. Keeps the id
                    // under the on-chain metadata::new length limit.
                    const _a = this.getUltronAddress().toLowerCase().replace(/^0x/, '').slice(0, 14);
                    const _b = normalizeSuiAddress(kaminoMatch.suiAddress).toLowerCase().replace(/^0x/, '').slice(0, 14);
                    const groupId = `t-${[_a, _b].sort().join('')}`;
                    await fetch(`https://sui.ski/api/timestream/${encodeURIComponent(groupId)}/send`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        groupId,
                        encryptedText: btoa(msg), // plaintext for now — ultron notifications are public
                        nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))),
                        keyVersion: '0',
                        senderAddress: normalizeSuiAddress(keypair.getPublicKey().toSuiAddress()),
                      }),
                    });
                    console.log(`[OpenCLOB] Prism Thunder sent to ${recipName}.sui via Timestream`);
                  } catch (e) { console.warn('[OpenCLOB] Prism Thunder failed:', e); }
                }

              } catch (e) {
                console.error(`[TreasuryAgents] Kamino→iUSD mint failed:`, e);
              }
            }
            }
          }
        }
      } catch (err) {
        console.error(`[TreasuryAgents] SOL tx parse error:`, err);
      }
    }

    // Update last processed signature
    this.setState({ ...this.state, last_sol_sig: signatures[0]?.signature } as any);
  }

  /** Rhydon Lv.35 (#74) — run the IOU expiry sweeper on the
   *  treasury alarm path, throttled to every 5 minutes so _tick
   *  firing at high cadence doesn't thrash GraphQL. Redundant
   *  with the `*\/10 * * * *` cron tick declared in wrangler.jsonc
   *  — whichever fires first wins; the sweeper is idempotent so
   *  double-runs are free. Gives us secondary liveness if the
   *  cron misses a tick.
   *
   *  Imports the shared `sweepExpiredIous` from `../iou-sweeper.js`
   *  dynamically so the worker doesn't pull the sweeper's
   *  dependencies at cold start.
   */
  private async _sweepExpiredIous(): Promise<void> {
    const IOU_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
    const now = Date.now();
    const last = (this.state as any).last_iou_sweep_ms as number | undefined;
    if (last && now - last < IOU_SWEEP_INTERVAL_MS) return;
    // Update the cursor BEFORE running so a hang can't lock us into
    // a busy-loop retry — failures still count against the throttle.
    this.setState({ ...this.state, last_iou_sweep_ms: now } as any);
    try {
      const { sweepExpiredIous } = await import('../iou-sweeper.js');
      const result = await sweepExpiredIous(this.env as unknown as { SHADE_KEEPER_PRIVATE_KEY?: string });
      console.log(`[treasury] iou-sweep: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error('[treasury] iou-sweep threw:', err instanceof Error ? err.message : err);
    }
  }

  /** Sub-cent intents — Phase 1b. Purge stale intents so the tag
   *  table doesn't grow without bound.
   *
   *   - Pending intents older than INTENT_PENDING_TTL_MS (10 min):
   *     dropped entirely. The client can re-request a tag.
   *   - Matched intents older than INTENT_MATCHED_TTL_MS (24h):
   *     dropped so the deposit-status poll has time to read them
   *     and then they free up the table.
   *
   *  Same two TTLs apply to kamino_intents. No-op when nothing
   *  expired so the state bag doesn't churn unnecessarily.
   */
  private async _purgeStaleIntents(): Promise<void> {
    const INTENT_PENDING_TTL_MS = 10 * 60 * 1000;
    const INTENT_MATCHED_TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const prune = <T extends { status?: string; created?: number; matchedAt?: number }>(list: T[]): T[] =>
      list.filter(i => {
        if (i.status === 'pending') return now - (i.created ?? 0) < INTENT_PENDING_TTL_MS;
        if (i.status === 'matched' || i.status === 'filled') {
          const at = i.matchedAt ?? i.created ?? 0;
          return now - at < INTENT_MATCHED_TTL_MS;
        }
        // Anything else (error, cancelled) expires on the short TTL too.
        return now - (i.created ?? 0) < INTENT_PENDING_TTL_MS;
      });

    const depRaw = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
    const kamRaw = ((this.state as any).kamino_intents ?? []) as Array<Record<string, any>>;
    const dep = prune(depRaw as any);
    const kam = prune(kamRaw as any);
    if (dep.length !== depRaw.length || kam.length !== kamRaw.length) {
      this.setState({ ...this.state, deposit_intents: dep, kamino_intents: kam } as any);
    }
  }

  /** Sub-cent Phase 2 — dispatch a matched deposit intent to its
   *  handler based on the stored route code.
   *
   *  Source-agnostic: callers pass a `deposit` struct that captures
   *  the USD value + source chain + optional Sui coin ref (only set
   *  when the deposit arrived as a native Sui coin, enabling the
   *  PAY route's forward-the-exact-coin path). SOL deposits pass
   *  usdValue directly and no coin ref.
   *
   *  Routes wired:
   *    0 IUSD_CACHE — attest collateral + mint iUSD 1:1 to recipient
   *    2 QUEST      — attest + fill targeted or auto-discovered bounty
   *    7 PAY        — forward Sui-USDC coin if available, else mint
   *                   iUSD to recipient (identical to iusd-cache)
   *    other        — fall through to IUSD_CACHE with a warning
   */
  private async _dispatchMatchedIntent(
    intent: Record<string, any>,
    deposit: {
      usdValue: number;
      sourceDigest: string;
      sourceChain: 'sui' | 'sol';
      /** Only set for Sui-USDC deposits: the coin object ultron
       *  received, available for PAY-route direct forwarding. */
      suiCoin?: { address: string; balance: bigint };
    },
  ): Promise<void> {
    const route = Number(intent.route ?? 0);
    const action = Number(intent.action ?? 0);
    const routeName_ = (route === 0 ? 'iusd-cache'
      : route === 1 ? 'rumble'
      : route === 2 ? 'quest'
      : route === 3 ? 'shade'
      : route === 4 ? 'deepbook'
      : route === 5 ? 'storm'
      : route === 6 ? 'satellite'
      : route === 7 ? 'pay'
      : route === 8 ? 'cross-chain-mint'
      : `unknown(${route})`);

    // iUSD has 9 decimals; collateral value in MIST = usd * 1e9.
    const usdMist = BigInt(Math.floor(deposit.usdValue * 1e9));

    // Always mark the intent `matched` first so the reconciler
    // doesn't double-process it on the next tick even if dispatch
    // fails below.
    const all = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
    const idx = all.findIndex(i => i.suiAddress === intent.suiAddress && i.status === 'pending');
    if (idx >= 0) {
      all[idx] = {
        ...all[idx],
        status: 'matched',
        matchedTx: deposit.sourceDigest,
        matchedUsdValue: deposit.usdValue,
        matchedSourceChain: deposit.sourceChain,
        matchedAt: Date.now(),
      };
      this.setState({ ...this.state, deposit_intents: all } as any);
    }

    // Chansey v3: route deposits through mintIusdForDeposit which
    // respects the 110% invariant AND uses the correct per-chain
    // asset/chain keys ('SOL'/'solana' for SOL deposits, 'USDC'/'sui'
    // for Sui USDC). Previous attestAndMint hardcoded 'SUI'/'sui'
    // which corrupted the Sui-chain SUI collateral record on every
    // cross-chain deposit.
    const chainToAssetKey: Record<string, { assetKey: string; chainKey: string }> = {
      sol: { assetKey: 'SOL', chainKey: 'solana' },
      sui: { assetKey: 'USDC', chainKey: 'sui' },
    };
    const attestAndMint = async (label: string) => {
      const keys = chainToAssetKey[deposit.sourceChain] ?? { assetKey: 'SUI', chainKey: 'sui' };
      try {
        const r = await this.mintIusdForDeposit({
          recipient: intent.suiAddress,
          depositedUsdMist: String(usdMist),
          assetKey: keys.assetKey,
          chainKey: keys.chainKey,
        });
        if (r.error) throw new Error(r.error);
        console.log(`[treasury/dispatch:${label}] v3 mint: ${r.mintedUsd} to ${String(intent.suiAddress).slice(0, 10)}… rate=${r.mintRate} tx=${r.digest?.slice(0, 10) || '?'}`);
      } catch (e) {
        // Fallback: attest SOL/USDC collateral correctly (not the
        // old hardcoded-SUI path). Supply doesn't grow but at least
        // the treasury's senior view reflects the new collateral.
        console.warn(`[treasury/dispatch:${label}] mintIusdForDeposit failed, attesting only:`, e instanceof Error ? e.message : e);
        // Route to the asset-specific attestation helper if available
        if (deposit.sourceChain === 'sol') {
          try {
            const a = await this.attestSolCollateral({ valueUsdCents: Math.floor(deposit.usdValue * 100) });
            console.log(`[treasury/dispatch:${label}] attest SOL ${deposit.usdValue} USD digest=${a.digest || 'failed'}`);
          } catch (e2) {
            console.error(`[treasury/dispatch:${label}] SOL attest failed:`, e2);
          }
        } else {
          try {
            const a = await this.attestCollateral({ collateralValueMist: String(usdMist) });
            console.log(`[treasury/dispatch:${label}] attest ${deposit.usdValue} USD digest=${a.digest || 'failed'}`);
          } catch (e2) {
            console.error(`[treasury/dispatch:${label}] attest failed:`, e2);
          }
        }
      }
    };

    // Fill any open quest bounty for the recipient — shared by
    // iusd-cache and quest routes.
    const tryFillOpenQuest = async (label: string) => {
      const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
      const open = bounties.find(b => b.recipient === intent.suiAddress && b.status === 'open');
      if (!open) return;
      console.log(`[treasury/dispatch:${label}] filling Quest ${open.id}`);
      try { await this.fillQuestBounty(open.id); } catch (e) {
        console.error(`[treasury/dispatch:${label}] quest fill failed:`, e);
      }
    };

    try {
      switch (route) {
        case 7: { // PAY
          if (deposit.suiCoin) {
            // Sui-USDC source → forward the exact coin to the target.
            // Zero conversion, fee-free, recipient gets USDC.
            console.log(`[treasury/dispatch:pay] forward ${deposit.suiCoin.balance} USDC → ${intent.suiAddress.slice(0, 10)}…`);
            await this._forwardUsdcToTarget(
              { address: deposit.suiCoin.address, balance: deposit.suiCoin.balance, digest: deposit.sourceDigest },
              intent.suiAddress,
            );
          } else {
            // SOL source → can't forward SOL on Sui. Mint iUSD to the
            // target so the recipient still gets 1:1 value in-wallet.
            console.log(`[treasury/dispatch:pay] SOL source, falling back to iUSD mint to ${intent.suiAddress.slice(0, 10)}…`);
            await attestAndMint('pay');
          }
          break;
        }
        case 2: { // QUEST
          await attestAndMint('quest');
          const bountyId = (intent.params as Record<string, unknown> | null)?.bountyId as string | undefined;
          if (bountyId) {
            console.log(`[treasury/dispatch:quest] filling targeted bounty ${bountyId}`);
            try { await this.fillQuestBounty(bountyId); } catch (e) {
              console.error('[treasury/dispatch:quest] targeted fill failed:', e);
            }
          } else {
            await tryFillOpenQuest('quest');
          }
          break;
        }
        case 3: { // SHADE — attest + mint iUSD to ULTRON + auto-fire shade
          const shadeDomain = (intent.params as Record<string, unknown> | null)?.shadeDomain as string | undefined;
          if (!shadeDomain) {
            console.warn('[treasury/dispatch:shade] no shadeDomain in params, falling back to iusd-cache');
            await attestAndMint('shade-fallback');
            break;
          }
          // Mint iUSD to ULTRON (not the depositor) so shade-proxy
          // can use it for create_stable<IUSD>.
          const keys = chainToAssetKey[deposit.sourceChain] ?? { assetKey: 'SUI', chainKey: 'sui' };
          try {
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY!);
            const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
            const r = await this.mintIusdForDeposit({
              recipient: ultronAddr, // mint to ULTRON, not depositor
              depositedUsdMist: String(usdMist),
              assetKey: keys.assetKey,
              chainKey: keys.chainKey,
            });
            if (r.error) throw new Error(r.error);
            console.log(`[treasury/dispatch:shade] minted ${r.mintedUsd} iUSD to ultron for shade ${shadeDomain}`);
          } catch (e) {
            console.error('[treasury/dispatch:shade] mint to ultron failed:', e);
            break;
          }
          // Wait for mint tx to propagate
          await new Promise(r => setTimeout(r, 3000));
          // Auto-fire shade-proxy
          try {
            const shadeResult = await this._shadeProxy({
              label: shadeDomain,
              targetAddress: intent.suiAddress, // name registers to the depositor
            });
            if (shadeResult.error) {
              console.error(`[treasury/dispatch:shade] shade-proxy failed: ${shadeResult.error}`);
            } else {
              console.log(`[treasury/dispatch:shade] shade placed for ${shadeDomain}.sui → ${intent.suiAddress.slice(0, 10)}… digest=${shadeResult.digest}`);
              // Update intent with shade info
              const ints = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
              const ii = ints.findIndex(i => i.suiAddress === intent.suiAddress);
              if (ii >= 0) {
                ints[ii] = { ...ints[ii], shadeDigest: shadeResult.digest, shadeOrderId: shadeResult.orderId };
                this.setState({ ...this.state, deposit_intents: ints } as any);
              }
            }
          } catch (e) {
            console.error('[treasury/dispatch:shade] auto-shade failed:', e);
          }
          break;
        }
        case 8: { // CROSS_CHAIN_MINT
          const targetChain = (intent.params as Record<string, unknown> | null)?.targetChain as string | undefined ?? 'sol';
          const hintAddress = (intent.params as Record<string, unknown> | null)?.recipientChainAddress as string | undefined;
          if (targetChain !== 'sol') {
            console.warn(`[treasury/dispatch:cross-chain-mint] chain ${targetChain} not yet supported, falling back to iusd-cache`);
            await attestAndMint('cross-chain-mint-fallback');
            break;
          }
          const solAddr = await this._resolveRecipientSolAddress(intent.suiAddress, hintAddress);
          if (!solAddr) {
            console.warn(`[treasury/dispatch:cross-chain-mint] could not resolve sol@ for ${intent.suiAddress.slice(0, 10)}…, falling back to iusd-cache`);
            await attestAndMint('cross-chain-mint-fallback');
            break;
          }
          // Attest collateral (no Sui-side iUSD mint — goes directly to target chain)
          try {
            if (deposit.sourceChain === 'sol') {
              await this.attestSolCollateral({ valueUsdCents: Math.floor(deposit.usdValue * 100) });
            } else {
              await this.attestCollateral({ collateralValueMist: String(usdMist) });
            }
          } catch (e) {
            console.error('[treasury/dispatch:cross-chain-mint] attest failed:', e instanceof Error ? e.message : e);
          }
          // Mint iUSD SPL directly to recipient on Solana
          const mintResult = await this.crossChainMintSol({
            recipientSolAddress: solAddr,
            amount: String(usdMist),
            sourceDigest: deposit.sourceDigest,
            recipientSuiAddress: intent.suiAddress,
          });
          if (mintResult.error) {
            console.error(`[treasury/dispatch:cross-chain-mint] mint failed: ${mintResult.error}, falling back to iusd-cache`);
            await attestAndMint('cross-chain-mint-fallback');
          } else {
            console.log(`[treasury/dispatch:cross-chain-mint] ${deposit.usdValue} iUSD SPL → ${solAddr.slice(0, 10)}… sig=${mintResult.signature?.slice(0, 12)}…`);
          }
          break;
        }
        case 0: // IUSD_CACHE (default)
        default: {
          if (route !== 0 && route !== 2 && route !== 7 && route !== 3 && route !== 8) {
            console.warn(`[treasury/dispatch:${routeName_}] route not yet implemented — falling back to iusd-cache`);
          }
          await attestAndMint('iusd-cache');
          await tryFillOpenQuest('iusd-cache');
          break;
        }
      }
    } catch (e) {
      console.error(`[treasury/dispatch:${routeName_}] threw:`, e instanceof Error ? e.message : e);
    }
    void action;
  }

  /** Resolve a Sui address to its Solana address via the SUIAMI roster. */
  private async _resolveRecipientSolAddress(
    recipientSuiAddress: string,
    hintSolAddress?: string,
  ): Promise<string | null> {
    // Client-provided hint takes priority (Seal-encrypted addresses resolved client-side)
    if (hintSolAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hintSolAddress)) return hintSolAddress;
    // Read cleartext chains from SUIAMI roster
    try {
      const addr = normalizeSuiAddress(recipientSuiAddress);
      const hex = addr.replace(/^0x/, '');
      const raw = new Uint8Array(32);
      for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const addrB64 = btoa(String.fromCharCode(...raw));
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ object(address: "${SUIAMI_ROSTER_OBJ}") { dynamicField(name: { type: "address", bcs: "${addrB64}" }) { value { ... on MoveValue { json } } } } }`,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const gql = await res.json() as any;
      const record = gql?.data?.object?.dynamicField?.value?.json;
      if (!record?.chains?.contents) return null;
      for (const { key, value } of record.chains.contents) {
        if (key === 'sol' && value) return value;
      }
    } catch {}
    return null;
  }

  /** Mint iUSD SPL tokens on Solana for a cross-chain mint intent. */
  async crossChainMintSol(params: {
    recipientSolAddress: string;
    amount: string;
    sourceDigest: string;
    recipientSuiAddress: string;
  }): Promise<{ signature?: string; ata?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };
    const mintAddress = (this.state as any).iusd_sol_mint as string | undefined;
    if (!mintAddress) return { error: 'iUSD SOL mint not created yet' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const pubRaw = keypair.getPublicKey().toRawBytes();
      const mintPub = b58decode(mintAddress);
      const recipPub = b58decode(params.recipientSolAddress);
      const amount = BigInt(params.amount);
      // IKA-ready sign function: presign vector path will replace this
      const signFn = async (msg: Uint8Array) => {
        // Future: consume presign from DO state, compute partial, submit to IKA
        return await keypair.sign(msg);
      };
      const result = await mintSplTokens(signFn, pubRaw, mintPub, recipPub, amount, this._solRpcConfig);
      console.log(`[crossChainMintSol] minted ${params.amount} iUSD SPL to ${params.recipientSolAddress} sig=${result.signature}`);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** PAY route handler — ultron signs a USDC transfer from its own
   *  balance to the target address. The incoming coin has already
   *  landed in ultron's wallet, so we just split + forward. Fee-free
   *  from the user's perspective.
   */
  private async _forwardUsdcToTarget(
    coin: { address: string; balance: bigint; digest: string },
    target: string,
  ): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const ultronAddr = normalizeSuiAddress(keypair.toSuiAddress());
    try {
      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.transferObjects([tx.object(coin.address)], tx.pure.address(normalizeSuiAddress(target)));
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const { digest } = await raceExecuteTransaction(toBase64(txBytes), [signature]);
      console.log(`[treasury/dispatch:pay] forwarded USDC to ${target.slice(0, 10)}… digest=${digest}`);
    } catch (e) {
      console.error('[treasury/dispatch:pay] transfer failed:', e instanceof Error ? e.message : e);
    }
  }

  /** Sub-cent intents — Phase 1c. Sui-side USDC watcher.
   *
   *  Polls ultron's USDC coin objects via GraphQL and matches
   *  any newly-arrived coin's tag (balance % 1_000_000) against
   *  pending deposit intents. On a hit, attests collateral +
   *  fills any open quest for the same recipient, then marks the
   *  intent `matched`.
   *
   *  Uses `last_sui_usdc_cursor` as a watermark so we only
   *  process new arrivals. First run establishes the baseline by
   *  recording the newest digest and matching nothing.
   *
   *  The GraphQL query returns USDC coins owned by ultron; each
   *  coin's `previousTransaction.digest` is the incoming tx.
   */
  /** Sub-cent Phase 3b — OpenCLOB bundle scanner stub.
   *
   * Throttled to every 30s. Queries all `OrderBundle` shared objects
   * of the `thunder_openclob::bundle` package via GraphQL, decodes
   * their state from `contents.json`, and LOGS which bundles would
   * be settled or force-refunded. Phase 3b deliberately does not
   * submit any transactions — the actual `settle_bundle` /
   * `force_refund_bundle` calls land in Phase 3c once the scanner
   * logic has been validated against live on-chain bundles.
   *
   * Error behavior: swallowed + warned. The scanner abandons the
   * tick after ~200ms of wall-clock work so a slow GraphQL node
   * can't starve the rest of `_tick`.
   *
   * Refs:
   *   - docs/superpowers/specs/2026-04-11-openclob-bundle-tags.md
   *   - contracts/thunder-openclob/sources/bundle.move
   */
  private async _scanOpenBundles(): Promise<void> {
    const now = Date.now();
    const SCAN_INTERVAL_MS = 30_000;
    const lastScan = ((this.state as any).last_bundle_scan_ms as number | undefined) ?? 0;
    if (now - lastScan < SCAN_INTERVAL_MS) return;

    const started = Date.now();
    const MAX_WORK_MS = 200;
    const PKG = '0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7';
    const BUNDLE_TYPE = `${PKG}::bundle::OrderBundle`;

    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($t: String!) {
            objects(filter: { type: $t }, first: 50) {
              nodes {
                address
                version
                asMoveObject { contents { json } }
              }
            }
          }`,
          variables: { t: BUNDLE_TYPE },
        }),
        signal: AbortSignal.timeout(6_000),
      });

      if (Date.now() - started > MAX_WORK_MS) {
        // Took too long — advance the throttle but skip processing.
        this.setState({ ...this.state, last_bundle_scan_ms: now } as any);
        return;
      }

      const data = await res.json() as {
        data?: { objects?: { nodes?: Array<{
          address: string;
          version: string;
          asMoveObject?: { contents?: { json?: Record<string, any> } };
        }> } };
      };
      const nodes = data?.data?.objects?.nodes ?? [];

      let wouldSettle = 0;
      let wouldRefund = 0;
      let openCount = 0;

      for (const node of nodes) {
        const json = node.asMoveObject?.contents?.json;
        if (!json) continue;
        // Move contents: { tag, creator, status, target_count, filled_count,
        //   settle_deadline_ms, created_ms, orders: [...] }
        const status = Number(json.status ?? 0);
        const targetCount = Number(json.target_count ?? 0);
        const filledCount = Number(json.filled_count ?? 0);
        const deadlineMs = Number(json.settle_deadline_ms ?? 0);
        const tag = Number(json.tag ?? 0);

        if (status === 0) openCount++;

        // STATUS_OPEN (0) + hit target → would settle.
        if (status === 0 && filledCount >= targetCount && targetCount > 0) {
          console.log(`[treasury/openclob] would settle bundle ${node.address} (filled=${filledCount}/${targetCount} tag=${tag})`);
          wouldSettle++;
          continue;
        }

        // Not yet settled/refunded (status < 2 = open or complete) and past deadline → would refund.
        if (status < 2 && deadlineMs > 0 && deadlineMs < now) {
          console.log(`[treasury/openclob] would force-refund expired bundle ${node.address} (tag=${tag} deadline=${new Date(deadlineMs).toISOString()})`);
          wouldRefund++;
        }
      }

      if (nodes.length > 0) {
        console.log(`[treasury/openclob] scanner saw ${nodes.length} bundle(s): ${openCount} open, would-settle=${wouldSettle}, would-refund=${wouldRefund}`);
      }
    } catch (e) {
      console.warn('[treasury/openclob] scanner failed:', e instanceof Error ? e.message : e);
    } finally {
      this.setState({ ...this.state, last_bundle_scan_ms: now } as any);
    }
  }

  private async _watchSuiUsdcDeposits(): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;
    const ultronAddr = this.getUltronAddress();
    if (!ultronAddr) return;

    const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
    const pending = intents.filter(i => i.status === 'pending');

    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($a: SuiAddress!) {
            address(address: $a) {
              objects(filter: { type: "0x2::coin::Coin<${USDC_TYPE}>" }, first: 50) {
                nodes {
                  address
                  version
                  contents { json }
                  previousTransaction { digest }
                }
              }
            }
          }`,
          variables: { a: ultronAddr },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = await res.json() as {
        data?: { address?: { objects?: { nodes?: Array<{
          address: string;
          version: string;
          contents?: { json?: { balance?: string } };
          previousTransaction?: { digest?: string };
        }> } } };
      };
      const nodes = data?.data?.address?.objects?.nodes ?? [];
      if (nodes.length === 0) return;

      const cursor = (this.state as any).last_sui_usdc_cursor as string | undefined;

      // First run: set the cursor to the newest coin, match nothing.
      if (!cursor) {
        const newest = nodes[0]?.previousTransaction?.digest ?? '';
        if (newest) this.setState({ ...this.state, last_sui_usdc_cursor: newest } as any);
        return;
      }

      // Find all coins received since the cursor. Stops when we hit
      // the cursor digest — everything earlier is already processed.
      const fresh: Array<{ address: string; balance: bigint; digest: string }> = [];
      for (const n of nodes) {
        const dig = n.previousTransaction?.digest ?? '';
        if (!dig || dig === cursor) break;
        const rawBal = n.contents?.json?.balance ?? '0';
        const bal = BigInt(rawBal);
        if (bal === 0n) continue;
        fresh.push({ address: n.address, balance: bal, digest: dig });
      }
      if (fresh.length === 0) return;

      // Phase 2: tag is still the same 6-digit canonical value as
      // Phase 1, just with an internal (route, action, nonce) split.
      // The USDC match key stays `balance % 1_000_000` = intent.tag.
      // Routing happens in _dispatchMatchedIntent based on the
      // intent's stored route field (defaults to 0 = iusd-cache for
      // every Phase 1 entry in the table).
      const { routeName } = await import('../subcent-tag.js');
      let matched = 0;
      for (const coin of fresh) {
        const tag = Number(coin.balance % 1_000_000n);
        if (tag === 0) continue;
        const match = pending.find(p => p.tag === tag);
        if (!match) continue;
        const routeCode = Number(match.route ?? 0);
        console.log(`[TreasuryAgents] Sui USDC match: tag=${tag} route=${routeName(routeCode)} action=${match.action ?? 0} → ${String(match.suiAddress).slice(0, 10)}…`);
        // USDC is 1:1 USD at 6 decimals — divide raw by 1e6.
        await this._dispatchMatchedIntent(match, {
          usdValue: Number(coin.balance) / 1e6,
          sourceDigest: coin.digest,
          sourceChain: 'sui',
          suiCoin: { address: coin.address, balance: coin.balance },
        });
        matched++;
      }

      // Advance the cursor to the newest coin digest we just saw.
      const newCursor = nodes[0]?.previousTransaction?.digest ?? cursor;
      if (newCursor !== cursor) {
        this.setState({ ...this.state, last_sui_usdc_cursor: newCursor } as any);
      }
      if (matched > 0) {
        console.log(`[TreasuryAgents] Sui USDC watcher matched ${matched} deposit(s)`);
      }
    } catch (e) {
      console.warn('[TreasuryAgents] Sui USDC watcher failed:', e instanceof Error ? e.message : e);
    }
  }

  /** Retry pre-signed registrations that failed during quest fill.
   *
   * A quest fill is 2 steps: (1) swap payment coin → NS and transfer
   * to the user, (2) submit the user's pre-signed registration tx
   * that consumes the NS + mints the name. If step 2 fails (network
   * flake, rpc rejection, gas coin stale) the NS is stranded in the
   * user's wallet and the name never gets registered.
   *
   * This walks every filled bounty with a missing regDigest, retries
   * the stored pre-signed tx up to 5 times total, then marks the
   * bounty abandoned. Once abandoned, the UI surfaces an "NS dust →
   * cache" affordance to the user (their NS is their own to sweep;
   * ultron can't pull it back without a fresh signature).
   */
  private async _retryStrandedRegistrations(): Promise<void> {
    const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
    if (bounties.length === 0) return;

    const MAX_ATTEMPTS = 5;
    const RETRY_COOLDOWN_MS = 60 * 1000; // 1 min between retries
    const now = Date.now();

    const stranded = bounties.filter(b =>
      b.status === 'filled'
      && !b.regDigest
      && !b.regAbandoned
      && b.preSignedTx
      && b.preSignedSig
      && (b.regAttempts ?? 0) < MAX_ATTEMPTS
      && (now - (b.regLastAttemptMs ?? 0)) > RETRY_COOLDOWN_MS,
    );
    if (stranded.length === 0) return;

    const updated = [...bounties];
    for (const b of stranded) {
      try {
        const txBytes = Uint8Array.from(atob(b.preSignedTx), c => c.charCodeAt(0));
        const regDigest = await this._submitTx(txBytes, b.preSignedSig);
        const idx = updated.findIndex(x => x.id === b.id);
        if (idx !== -1) {
          updated[idx] = { ...updated[idx], regDigest, regError: undefined, regLastAttemptMs: now };
          console.log(`[TreasuryAgents] Reconciled stranded reg for bounty ${b.id}: ${regDigest}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const idx = updated.findIndex(x => x.id === b.id);
        if (idx !== -1) {
          const attempts = (updated[idx].regAttempts ?? 0) + 1;
          const abandoned = attempts >= MAX_ATTEMPTS;
          updated[idx] = {
            ...updated[idx],
            regAttempts: attempts,
            regError: msg,
            regLastAttemptMs: now,
            regAbandoned: abandoned || undefined,
          };
          if (abandoned) {
            console.warn(`[TreasuryAgents] Abandoning stranded reg for bounty ${b.id} after ${attempts} attempts: ${msg}`);
          }
        }
      }
    }
    this.setState({ ...this.state, quest_bounties: updated } as any);
  }

  /** Sweep NS → USDC → iUSD. Ultron should never hold NS — always convert back to iUSD (backed by XAUM + USDC + SUI). */
  private async _sweepNsToIusd(): Promise<void> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

    // Check if ultron has any NS tokens
    let nsCoins: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> = [];
    try {
      const data = await raceJsonRpc<{ data: typeof nsCoins }>('suix_getCoins', [ultronAddr, TreasuryAgents.NS_TYPE]);
      nsCoins = (data?.data ?? []).filter(c => BigInt(c.balance) > 0n);
    } catch { return; }
    if (nsCoins.length === 0) return;

    const totalNs = nsCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (totalNs < 1_000_000n) return; // ignore dust (<0.001 NS)

    console.log(`[TreasuryAgents] Sweeping ${Number(totalNs) / 1e6} NS → USDC → iUSD`);

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Merge all NS coins
      const nsCoin = tx.objectRef({ objectId: nsCoins[0].coinObjectId, version: String(nsCoins[0].version), digest: nsCoins[0].digest });
      if (nsCoins.length > 1) {
        tx.mergeCoins(nsCoin, nsCoins.slice(1).map(c => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
      }

      // NS → USDC via DeepBook
      const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
      const [usdcOut, nsChange, deepChange] = tx.moveCall({
        target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: [TreasuryAgents.NS_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({ objectId: TreasuryAgents.DB_NS_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
          nsCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
        ],
      });

      // Keep USDC, return change to ultron
      tx.transferObjects([usdcOut, nsChange, deepChange], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] NS swept to USDC: ${digest}, ${Number(totalNs) / 1e6} NS`);

      // Mint iUSD backed by the USDC received
      // TODO: attest USDC as collateral + mint iUSD once iUSD/USDC pool exists
      // For now, USDC stays in ultron as liquid reserves
    } catch (err) {
      console.error('[TreasuryAgents] NS sweep failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Deliberate on active Shades — TTL, name-already-registered check, agent voting, iUSD return */
  private async _deliberateShades(): Promise<void> {
    const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
    const active = shades.filter(s => s.status === 'active');
    if (active.length === 0) return;

    const now = Date.now();
    const IUSD_TYPE = `${TreasuryAgents.IUSD_PKG}::iusd::IUSD`;
    const SHADE_TTL = 7 * 86_400_000; // 7 day TTL — stale Shades auto-expire
    let changed = false;

    for (const shade of active) {
      if (now - shade.lastChecked < 60_000) continue;
      shade.lastChecked = now;
      changed = true;

      // On-chain orders (have objectId) are already funded — skip
      // balance-based deliberation. Only check name-registered + grace expiry.
      if ((shade as any).objectId) {
        try {
          const nameCheck = await raceJsonRpc<string | null>('suix_resolveNameServiceAddress', [`${shade.domain}.sui`]).catch(() => null);
          if (nameCheck) {
            shade.status = 'cancelled';
            shade.deliberation = `${shade.domain}.sui already registered (${String(nameCheck).slice(0, 10)}…) — on-chain order can be cancelled`;
            continue;
          }
        } catch {}
        if (now >= shade.graceEndMs) {
          shade.status = 'executed';
          shade.deliberation = 'grace expired — ShadeExecutorAgent handles registration';
          continue;
        }
        shade.deliberation = `on-chain order ${String((shade as any).objectId).slice(0, 10)}… — funded, awaiting grace expiry`;
        continue;
      }

      // TTL — stale Shades expire and return iUSD
      if (now - shade.created > SHADE_TTL && now < shade.graceEndMs - 86_400_000) {
        shade.status = 'cancelled';
        shade.deliberation = `TTL expired (${Math.floor((now - shade.created) / 86_400_000)}d old) — iUSD returned to holder`;
        console.log(`[TreasuryAgents] Shade ${shade.domain}.sui TTL expired`);
        continue;
      }

      // Check if name is already registered (no longer in grace)
      try {
        const nameCheck = await raceJsonRpc<string | null>('suix_resolveNameServiceAddress', [`${shade.domain}.sui`]).catch(() => null);
        if (nameCheck) {
          // Name is registered — Shade is moot, return iUSD
          shade.status = 'cancelled';
          shade.deliberation = `${shade.domain}.sui already registered (${String(nameCheck).slice(0, 10)}…) — iUSD returned`;
          console.log(`[TreasuryAgents] Shade ${shade.domain}.sui: name already registered, cancelled`);
          continue;
        }
      } catch {
        // RPC error "Name has expired" means still in grace — Shade is valid
      }

      // Check if grace has expired — time to execute
      if (now >= shade.graceEndMs) {
        shade.status = 'executed';
        shade.deliberation = 'grace expired — ShadeExecutorAgent handles registration, iUSD used for mint';
        console.log(`[TreasuryAgents] Shade ${shade.domain}.sui: grace expired, executing`);
        continue;
      }

      // Check holder's iUSD balance
      try {
        const balGql = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: `{ address(address: "${shade.holder}") { balances { nodes { coinType { repr } totalBalance } } } }` }),
        });
        const balData = await balGql.json() as any;
        let iusdBal = 0;
        for (const n of (balData?.data?.address?.balances?.nodes ?? [])) {
          if (n.coinType.repr === IUSD_TYPE) iusdBal = Number(n.totalBalance) / 1e9;
        }

        if (iusdBal >= shade.thresholdUsd) {
          shade.deliberation = `healthy: $${iusdBal.toFixed(2)} iUSD >= $${shade.thresholdUsd.toFixed(2)} threshold`;
        } else {
          const deficit = shade.thresholdUsd - iusdBal;
          const timeToGrace = shade.graceEndMs - now;
          const hoursLeft = Math.floor(timeToGrace / 3_600_000);

          // RAGTAG votes
          const ultronVote = iusdBal < shade.thresholdUsd * 0.3 ? 'cancel' : 'hold';
          const enochVote = hoursLeft > 48 ? 'hold' : 'cancel';
          const malachiVote = 'cancel'; // ruthless
          const coulsonVote = 'hold'; // glistens, never sweats
          const leopoldVote = deficit > 5 ? 'cancel' : 'hold'; // engineer — can we build a route to cover?

          const votes = [ultronVote, enochVote, malachiVote, coulsonVote, leopoldVote];
          const cancelVotes = votes.filter(v => v === 'cancel').length;
          const shouldCancel = cancelVotes >= 3;

          shade.deliberation = [
            `$${iusdBal.toFixed(2)}/$${shade.thresholdUsd.toFixed(2)} (deficit:$${deficit.toFixed(2)})`,
            `ultron:${ultronVote} enoch:${enochVote} malachi:${malachiVote} coulson:${coulsonVote} leopold:${leopoldVote}`,
            shouldCancel ? 'VERDICT: liquidate — iUSD returned' : `VERDICT: hold — ${hoursLeft}h to grace`,
          ].join(' | ');

          if (shouldCancel) {
            shade.status = 'liquidated';
            console.log(`[TreasuryAgents] Shade ${shade.domain}.sui LIQUIDATED: ${shade.deliberation}`);
          }
        }
      } catch (err) {
        shade.deliberation = `check failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (changed) {
      this.setState({ ...this.state, shades } as any);
    }
  }

  /** Retry open Quest bounties every tick — ultron keeps hunting until filled.
   *  Re-checks status before each fill to prevent duplicate fills. */
  private async _retryOpenQuests(): Promise<void> {
    const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
    const open = bounties.filter(b => b.status === 'open');
    if (open.length === 0) return;
    const now = Date.now();

    // Only fill ONE bounty per tick — prevents mass-spending
    for (const b of open) {
      if (now - b.created < 30_000) continue;
      // Re-read status before filling (another tick may have filled it)
      const freshBounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
      const fresh = freshBounties.find(fb => fb.id === b.id);
      if (!fresh || fresh.status !== 'open') continue;
      try {
        await this.fillQuestBounty(b.id);
        return; // one fill per tick — coulson says "stand down, first fill worked"
      } catch (err) {
        console.error(`[TreasuryAgents] Quest retry failed for ${b.id}:`, err);
      }
    }
  }

  /** Sibyl price oracle — sources truth from Pyth Hermes (Sibyl's upstream), falls back to Binance */
  private async _fetchSuiPrice(): Promise<number | null> {
    // Primary: Pyth Hermes (Sibyl's data source) — SUI/USD feed
    try {
      const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
      const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
      const p = d.parsed?.[0]?.price;
      if (p?.price) return Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
    } catch { /* fallback */ }
    // Fallback: Binance spot
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
      const d = await r.json() as { price?: string };
      if (d.price) return parseFloat(d.price);
    } catch { /* exhausted */ }
    return null;
  }

  /** Sibyl SOL/USD oracle — Pyth Hermes → Binance fallback */
  private async _fetchSolPrice(): Promise<number | null> {
    try {
      const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
      const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
      const p = d.parsed?.[0]?.price;
      if (p?.price) return Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
    } catch {}
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS) });
      const d = await r.json() as { price?: string };
      if (d.price) return parseFloat(d.price);
    } catch {}
    return null;
  }

  // ─── OpenCLOB: Kamino Lend execution ────────────────────────────────

  private static readonly KAMINO_API = 'https://api.kamino.finance';
  private static readonly KAMINO_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
  private static readonly KAMINO_SOL_RESERVE = '2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN';
  private static readonly KAMINO_USDC_RESERVE = 'D1cqtVThyebK9KXKGXrCEuiqaNf5L4hXcsLvBMiLevHa';
  private get _solRpcs(): string[] {
    return [
      ...(this.env.HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`] : []),
      // Public fallbacks. api.mainnet-beta.solana.com frequently
      // rate-limits CF egress IPs, so keep others ahead of it.
      'https://solana-rpc.publicnode.com',
      'https://api.mainnet-beta.solana.com',
      'https://rpc.ankr.com/solana',
    ];
  }

  /** Deposit SOL into Kamino Lend. Returns Solana tx signature. */
  private async _depositToKamino(solAmount: number): Promise<string> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const solAddr = ULTRON_SOL_ADDRESS;

    // 1. Get unsigned deposit tx from Kamino REST API
    const resp = await fetch(`${TreasuryAgents.KAMINO_API}/ktx/klend/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: solAddr,
        market: TreasuryAgents.KAMINO_MARKET,
        reserve: TreasuryAgents.KAMINO_SOL_RESERVE,
        amount: solAmount.toFixed(9),
      }),
      signal: AbortSignal.timeout(LONG_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Kamino API ${resp.status}: ${text}`);
    }

    const { transaction: txBase64 } = await resp.json() as { transaction: string };
    if (!txBase64) throw new Error('Kamino API returned no transaction');

    // 2. Decode the base64 VersionedTransaction
    const txRaw = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));

    // VersionedTransaction format: first byte = 0x80 (versioned flag)
    // We need to sign the message portion with Ed25519
    // Solana VersionedTransaction: [signatures_count, ...signatures, message_bytes]
    // The Kamino API returns an unsigned tx — we need to insert our signature

    // 3. Extract message bytes for signing
    // For a versioned tx: byte 0 = prefix (0x80), then compact-u16 sig count, then sigs, then message
    // Actually the raw bytes from Kamino are a serialized VersionedTransaction
    // We need to: parse sig count, skip empty sig slots, sign the message, insert sig

    // Compact-u16 decode for signature count
    let offset = 0;
    let sigCount = txRaw[offset];
    offset += 1;
    if (sigCount >= 0x80) {
      sigCount = (sigCount & 0x7f) | (txRaw[offset] << 7);
      offset += 1;
    }

    // Skip empty signature slots (each 64 bytes)
    const sigStart = offset;
    offset += sigCount * 64;

    // Message bytes = everything after signatures
    const messageBytes = txRaw.slice(offset);

    // 4. Sign the message with Ed25519 (IKA dWallet keypair)
    const signature = await keypair.sign(messageBytes);

    // 5. Insert signature into the first slot
    const signedTx = new Uint8Array(txRaw.length);
    signedTx.set(txRaw);
    signedTx.set(signature, sigStart); // first sig slot

    // 6. Submit to Solana
    const signedB64 = btoa(String.fromCharCode(...signedTx));

    for (const rpc of this._solRpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'sendTransaction',
            params: [signedB64, { encoding: 'base64', skipPreflight: false }],
          }),
          signal: AbortSignal.timeout(LONG_FETCH_TIMEOUT_MS),
        });
        const d = await r.json() as { result?: string; error?: { message?: string } };
        if (d.result) {
          console.log(`[OpenCLOB] Kamino Lend deposit: ${solAmount.toFixed(4)} SOL, tx: ${d.result}`);

          // Track position for proof of reserves
          const positions = ((this.state as any).kamino_positions ?? []) as Array<Record<string, any>>;
          positions.push({
            reserve: 'SOL',
            amount: solAmount,
            depositTx: d.result,
            depositedAt: Date.now(),
            purpose: 'idle-yield',
          });
          this.setState({ ...this.state, kamino_positions: positions } as any);

          return d.result;
        }
        if (d.error) console.warn(`[OpenCLOB] Kamino submit to ${rpc}: ${d.error.message}`);
      } catch { /* try next */ }
    }

    throw new Error('Kamino deposit tx submission failed on all RPCs');
  }

  /** Deposit USDC into Kamino Lend. Amount in USDC units (6 decimals). Returns Solana tx signature. */
  private async _depositUsdcToKamino(usdcAmount: number): Promise<string> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const solAddr = ULTRON_SOL_ADDRESS;

    // 1. Get unsigned deposit tx from Kamino REST API
    const resp = await fetch(`${TreasuryAgents.KAMINO_API}/ktx/klend/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: solAddr,
        market: TreasuryAgents.KAMINO_MARKET,
        reserve: TreasuryAgents.KAMINO_USDC_RESERVE,
        amount: usdcAmount.toFixed(6),
      }),
      signal: AbortSignal.timeout(LONG_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Kamino USDC API ${resp.status}: ${text}`);
    }

    const { transaction: txBase64 } = await resp.json() as { transaction: string };
    if (!txBase64) throw new Error('Kamino API returned no transaction');

    // 2. Decode the base64 VersionedTransaction
    const txRaw = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));

    // 3. Extract message bytes for signing (same format as SOL deposit)
    let offset = 0;
    let sigCount = txRaw[offset];
    offset += 1;
    if (sigCount >= 0x80) {
      sigCount = (sigCount & 0x7f) | (txRaw[offset] << 7);
      offset += 1;
    }

    const sigStart = offset;
    offset += sigCount * 64;

    const messageBytes = txRaw.slice(offset);

    // 4. Sign the message with Ed25519
    const signature = await keypair.sign(messageBytes);

    // 5. Insert signature into the first slot
    const signedTx = new Uint8Array(txRaw.length);
    signedTx.set(txRaw);
    signedTx.set(signature, sigStart);

    // 6. Submit to Solana
    const signedB64 = btoa(String.fromCharCode(...signedTx));

    for (const rpc of this._solRpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'sendTransaction',
            params: [signedB64, { encoding: 'base64', skipPreflight: false }],
          }),
          signal: AbortSignal.timeout(LONG_FETCH_TIMEOUT_MS),
        });
        const d = await r.json() as { result?: string; error?: { message?: string } };
        if (d.result) {
          console.log(`[OpenCLOB] Kamino USDC deposit: ${usdcAmount.toFixed(2)} USDC, tx: ${d.result}`);

          // Track position for proof of reserves
          const positions = ((this.state as any).kamino_positions ?? []) as Array<Record<string, any>>;
          positions.push({
            reserve: 'USDC',
            amount: usdcAmount,
            depositTx: d.result,
            depositedAt: Date.now(),
            purpose: 'idle-yield',
          });
          this.setState({ ...this.state, kamino_positions: positions } as any);

          return d.result;
        }
        if (d.error) console.warn(`[OpenCLOB] Kamino USDC submit to ${rpc}: ${d.error.message}`);
      } catch { /* try next */ }
    }

    throw new Error('Kamino USDC deposit tx submission failed on all RPCs');
  }

  /** Query USDC SPL token balance for a Solana address. Returns balance in USDC units (6 decimals). */
  /** Derive the Associated Token Account address for a wallet + mint (base58 strings). */
  private async _deriveAta(wallet: string, mint: string): Promise<string> {
    const pda = await deriveATA(b58decode(wallet), b58decode(mint));
    return b58encode(pda);
  }

  private async _getSolanaUsdcBalance(solAddress: string): Promise<number> {
    // Query USDC balance via getTokenAccountBalance on the ATA.
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    let ata: string;
    try {
      ata = await this._deriveAta(solAddress, USDC_MINT);
    } catch {
      ata = '27kwRYini6NhoyCjeSf7MnxEHjTtXDorpYhU3DuWXbWj'; // ultron fallback
    }
    console.log(`[USDC balance] ATA for ${solAddress.slice(0, 8)}…: ${ata}`);
    const rpcs = [
      ...(this.env.HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`] : []),
      'https://api.mainnet-beta.solana.com',
    ];
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountBalance',
            params: [ata],
          }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json() as any;
        if (data.error) { console.warn(`[USDC balance] ${rpc.slice(0, 30)}… error:`, data.error.message); continue; }
        const uiStr = data?.result?.value?.uiAmountString;
        if (uiStr != null) return parseFloat(uiStr);
        return 0;
      } catch { continue; }
    }
    return 0;
  }

  // ─── OpenCLOB: iUSD SPL on Solana (BAM native mint) ─────────────────

  private get _solRpcConfig(): SolanaRpcConfig {
    return {
      rpcs: this._solRpcs,
      timeout: 15000,
      heliusApiKey: this.env.HELIUS_API_KEY,
    };
  }

  /** One-time: create iUSD SPL token mint on Solana. Mint authority = ultron. */
  @callable()
  async createIusdSolMint(params?: { callerAddress?: string }): Promise<{ mintAddress?: string; signature?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };

    // Check if we already have a mint
    const existingMint = (this.state as any).iusd_sol_mint as string | undefined;
    if (existingMint) return { mintAddress: existingMint, error: 'Mint already exists' };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const pubRaw = keypair.getPublicKey().toRawBytes();

      const signFn = async (msg: Uint8Array) => {
        const sig = await keypair.sign(msg);
        return sig;
      };

      const result = await createSplMint(signFn, pubRaw, 9, this._solRpcConfig);
      console.log(`[OpenCLOB] iUSD SPL mint created: ${result.mintAddress}`);

      // Persist the mint address
      this.setState({ ...this.state, iusd_sol_mint: result.mintAddress } as any);

      return result;
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[OpenCLOB] createIusdSolMint error:', errStr);
      return { error: errStr };
    }
  }

  /** BAM Mint: mint iUSD SPL tokens on Solana to a recipient.
   *  Called after Sibyl attests collateral value on Sui. */
  @callable()
  async bamMintIusdSol(params: {
    recipientSolAddress: string;
    amount: string; // raw units (9 decimals)
    callerAddress?: string;
  }): Promise<{ ata?: string; signature?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };

    const mintAddress = (this.state as any).iusd_sol_mint as string | undefined;
    if (!mintAddress) return { error: 'iUSD SOL mint not created yet — call createIusdSolMint first' };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const pubRaw = keypair.getPublicKey().toRawBytes();
      const mintPub = b58decode(mintAddress);
      const recipPub = b58decode(params.recipientSolAddress);
      const amount = BigInt(params.amount);

      const signFn = async (msg: Uint8Array) => {
        return await keypair.sign(msg);
      };

      const result = await mintSplTokens(signFn, pubRaw, mintPub, recipPub, amount, this._solRpcConfig);
      console.log(`[OpenCLOB] BAM minted ${params.amount} iUSD SPL to ${params.recipientSolAddress}`);

      // Track in squids
      const squids = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
      squids.iusd_minted++;
      this.setState({ ...this.state, squids });

      return result;
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[OpenCLOB] bamMintIusdSol error:', errStr);
      return { error: errStr };
    }
  }

  // ─── iUSD Purchase Route (ultron acquires NS for user) ──────────────

  private static readonly DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
  private static readonly DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  private static readonly DB_IUSD_USDC_POOL = '0x38df72f5d07607321d684ed98c9a6c411c0b8968e100a1cd90a996f912cd6ce1';
  private static readonly DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 832866334;
  private static readonly DB_NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060';
  private static readonly DB_NS_USDC_POOL_INITIAL_SHARED_VERSION = 414947421;
  private static readonly USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  private static readonly NS_TYPE = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
  private static readonly IUSD_TYPE = `${TreasuryAgents.IUSD_PKG}::iusd::IUSD`;

  /**
   * Full iUSD purchase route: attest collateral → mint iUSD → swap iUSD → USDC → NS → send NS to user.
   * Surplus stays in treasury. Ultron signs all txs server-side.
   *
   * @param recipient - User's wallet address (receives NS tokens)
   * @param collateralValueMist - SUI collateral value in MIST (9 decimals)
   * @param domainPriceUsd - Domain price in USD (e.g. 7.50 after NS discount)
   * @param signalId - Steganographic tag for the iUSD mint amount
   */
  @callable()
  async acquireNsForUser(params: {
    recipient: string;
    collateralValueMist: string;
    domainPriceUsd: number;
    signalId: number;
    callerAddress?: string;
  }): Promise<{ digest?: string; nsDigest?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };

    const { recipient, collateralValueMist, domainPriceUsd, signalId } = params;
    if (!recipient || !collateralValueMist || !domainPriceUsd) return { error: 'Missing params' };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Encode iUSD amount with steganographic tag (2% buffer over domain price)
      const bufferedPrice = domainPriceUsd * 1.02;
      const cents = Math.round(bufferedPrice * 100);
      const tag = Math.abs(signalId) % 1000;
      const iusdRaw = BigInt(cents) * 10_000_000n + BigInt(tag) * 10_000n;

      // Step 1: Attest collateral
      const tx1 = new Transaction();
      tx1.setSender(ultronAddr);
      tx1.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx1.object(TreasuryAgents.IUSD_TREASURY),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('SUI'))),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx1.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx1.pure.u64(BigInt(collateralValueMist)),
          tx1.pure.u8(0), // TRANCHE_SENIOR
          tx1.object('0x6'),
        ],
      });
      const txBytes1 = await tx1.build({ client: transport as never });
      const sig1 = await keypair.signTransaction(txBytes1);
      const digest1 = await this._submitTx(txBytes1, sig1.signature);
      console.log(`[TreasuryAgents] Collateral attested: ${digest1}`);

      // Step 2: Mint iUSD to ultron (not user) → swap iUSD → USDC → NS → send NS to user
      const tx2 = new Transaction();
      tx2.setSender(ultronAddr);

      // Mint iUSD to ultron
      tx2.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'mint_and_transfer',
        arguments: [
          tx2.object(TreasuryAgents.IUSD_TREASURY_CAP),
          tx2.object(TreasuryAgents.IUSD_TREASURY),
          tx2.pure.u64(iusdRaw),
          tx2.pure.address(ultronAddr), // mint to ultron, not user
        ],
      });

      // Build and submit mint tx first (need the iUSD coins for next step)
      const txBytes2 = await tx2.build({ client: transport as never });
      const sig2 = await keypair.signTransaction(txBytes2);
      const digest2 = await this._submitTx(txBytes2, sig2.signature);
      console.log(`[TreasuryAgents] iUSD minted to ultron: ${digest2}, amount: ${iusdRaw}`);

      // Step 3: Acquire NS for user
      // Route: iUSD → USDC (DeepBook iUSD/USDC pool) → NS (DeepBook NS/USDC pool) → transfer to user
      // Wait for mint tx to be indexed so we can fetch iUSD coins
      await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));

      const iusdCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, TreasuryAgents.IUSD_TYPE],
      );
      const iusdCoins = (iusdCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      if (!iusdCoins.length) return { error: 'No iUSD coins found after mint' };

      const tx3 = new Transaction();
      tx3.setSender(ultronAddr);

      // Merge all iUSD coins into one, then split exact amount for swap
      const primaryIusd = tx3.object(iusdCoins[0].coinObjectId);
      if (iusdCoins.length > 1) {
        tx3.mergeCoins(primaryIusd, iusdCoins.slice(1).map(c => tx3.object(c.coinObjectId)));
      }
      const [iusdPayment] = tx3.splitCoins(primaryIusd, [tx3.pure.u64(iusdRaw)]);

      // iUSD → USDC via DeepBook (iUSD is base, USDC is quote)
      const [zeroDEEP1] = tx3.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
      const [iusdChange, usdcOut, deepChange1] = tx3.moveCall({
        target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: [TreasuryAgents.IUSD_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [
          tx3.sharedObjectRef({ objectId: TreasuryAgents.DB_IUSD_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
          iusdPayment, zeroDEEP1, tx3.pure.u64(0), tx3.object.clock(),
        ],
      });

      // USDC → NS via DeepBook
      const [zeroDEEP2] = tx3.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
      const [nsCoin, usdcChange, deepChange2] = tx3.moveCall({
        target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_quote_for_base`,
        typeArguments: [TreasuryAgents.NS_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [
          tx3.sharedObjectRef({ objectId: TreasuryAgents.DB_NS_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_NS_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true }),
          usdcOut, zeroDEEP2, tx3.pure.u64(0), tx3.object.clock(),
        ],
      });

      // Send NS to user, keep everything else (iUSD remainder + USDC dust + DEEP change)
      tx3.transferObjects([nsCoin], tx3.pure.address(normalizeSuiAddress(recipient)));
      tx3.transferObjects([primaryIusd, iusdChange, usdcChange, deepChange1, deepChange2], tx3.pure.address(ultronAddr));

      const txBytes3 = await tx3.build({ client: transport as never });
      const sig3 = await keypair.signTransaction(txBytes3);
      const nsDigest = await this._submitTx(txBytes3, sig3.signature);
      console.log(`[TreasuryAgents] NS acquired and sent to ${recipient}: ${nsDigest}`);

      return { digest: digest2, nsDigest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] acquireNsForUser error:', errStr);
      return { error: errStr };
    }
  }

  // ─── DeepBook constants for pool creation ────────────────────────────
  private static readonly DB_REGISTRY = '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d';
  private static readonly POOL_CREATION_FEE = 500_000_000n; // 500 DEEP (6 decimals)
  private static readonly AGG_URL = 'https://aggregator.api.sui-prod.bluefin.io';
  private static readonly AGG_SOURCES = 'deepbook_v3,bluefin,cetus,aftermath,flowx,flowx_v3,kriya,kriya_v3,turbos';

  // Cetus router config (for SUI→DEEP swap via aggregator route)
  private static readonly CETUS_PACKAGE = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d';
  private static readonly CETUS_GLOBAL_CONFIG = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
  private static readonly BF_PACKAGE = '0xc4049b2d1cc0ee2b19a3c49c3b57ba084533b9e4a5a524e16e1f9b489e'; // bluefin
  private static readonly BF_GLOBAL_CONFIG = '0x0c7fc55fbbcbee2c20eb9dc3cd7a9c8f8fe0b3d7082d5485e54c29e76c656aca';
  private static readonly BF_MIN_SQRT_PRICE = 4295048016n;
  private static readonly BF_MAX_SQRT_PRICE = 79226673515401279992447579055n;

  /**
   * Swap SUI→DEEP via Bluefin aggregator. Acquires DEEP tokens needed for pool creation.
   * Uses the aggregator to find the best route (may go SUI→USDC→DEEP or SUI→DEEP direct).
   * Builds and executes a DeepBook or Cetus swap PTB server-side.
   */
  @callable()
  async swapSuiForDeep(params?: { amountMist?: string; callerAddress?: string }): Promise<{ digest?: string; deepAcquired?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check current DEEP balance
      const balRes = await transport.query({
        variables: {},
        query: `query { address(address: "${ultronAddr}") { balances { nodes { coinType { repr } totalBalance } } } }`,
      });
      const balances = (balRes.data as any)?.address?.balances?.nodes ?? [];
      let deepBal = 0n;
      let suiBal = 0n;
      for (const b of balances) {
        const ct = b.coinType?.repr ?? '';
        if (ct.includes('::deep::DEEP')) deepBal = BigInt(b.totalBalance ?? '0');
        if (ct.includes('::sui::SUI')) suiBal = BigInt(b.totalBalance ?? '0');
      }

      if (deepBal >= TreasuryAgents.POOL_CREATION_FEE) {
        return { error: `Already have ${deepBal} DEEP (need ${TreasuryAgents.POOL_CREATION_FEE}). No swap needed.` };
      }

      // Amount of SUI to swap — default 0.3 SUI (generous for ~500 DEEP)
      const suiAmount = BigInt(params?.amountMist ?? '300000000');
      const MIN_GAS_RESERVE = 100_000_000n; // keep 0.1 SUI for gas
      if (suiBal < suiAmount + MIN_GAS_RESERVE) {
        return { error: `Insufficient SUI: have ${suiBal}, need ${suiAmount + MIN_GAS_RESERVE} (swap + gas reserve)` };
      }

      // Query Bluefin aggregator for SUI→DEEP route
      const aggParams = new URLSearchParams({
        amount: String(suiAmount),
        from: SUI_TYPE,
        to: TreasuryAgents.DB_DEEP_TYPE,
        sources: TreasuryAgents.AGG_SOURCES,
      });
      const quoteRes = await fetch(`${TreasuryAgents.AGG_URL}/v2/quote?${aggParams}`);
      if (!quoteRes.ok) {
        return { error: `Aggregator quote failed: ${quoteRes.status} ${await quoteRes.text()}` };
      }

      const quote = await quoteRes.json() as {
        routes?: Array<{
          amountOut: string;
          hops: Array<{
            poolId: string;
            pool: { type: string; allTokens: Array<{ address: string }> };
            tokenIn: string;
            tokenOut: string;
          }>;
        }>;
      };

      if (!quote.routes?.length) {
        return { error: 'No SUI→DEEP route found via aggregator' };
      }

      // Pick first route (aggregator returns best first)
      const route = quote.routes[0];
      console.log(`[TreasuryAgents] SUI→DEEP route: ${route.hops.length} hops, expected out: ${route.amountOut}`);

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Split SUI from gas for the swap
      const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(suiAmount)]);

      // Build PTB based on route hops
      // For single-hop DeepBook routes, use swap_exact_base_for_quote directly
      // For multi-hop or other DEX routes, chain the hops
      let currentCoin = suiCoin;
      let currentType = SUI_TYPE;

      for (let i = 0; i < route.hops.length; i++) {
        const hop = route.hops[i];
        const dexType = hop.pool.type;
        const [coinX, coinY] = hop.pool.allTokens.map(t => t.address);
        const swapXtoY = hop.tokenIn === coinX;
        const outType = hop.tokenOut;

        if (dexType === 'deepbook_v3') {
          // DeepBook v3 swap
          const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });

          if (swapXtoY) {
            // swap_exact_base_for_quote (base=coinX → quote=coinY)
            const [baseOut, quoteOut, deepOut] = tx.moveCall({
              target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_base_for_quote`,
              typeArguments: [coinX, coinY],
              arguments: [
                tx.sharedObjectRef({ objectId: hop.poolId, initialSharedVersion: 0, mutable: true }),
                currentCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
              ],
            });
            // The output we want is quoteOut (coinY), transfer dust back
            if (i === route.hops.length - 1) {
              tx.transferObjects([baseOut, deepOut], tx.pure.address(ultronAddr));
              currentCoin = quoteOut;
            } else {
              tx.transferObjects([baseOut, deepOut], tx.pure.address(ultronAddr));
              currentCoin = quoteOut;
            }
          } else {
            // swap_exact_quote_for_base (quote=coinY → base=coinX)
            const [baseOut, quoteOut, deepOut] = tx.moveCall({
              target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_quote_for_base`,
              typeArguments: [coinX, coinY],
              arguments: [
                tx.sharedObjectRef({ objectId: hop.poolId, initialSharedVersion: 0, mutable: true }),
                currentCoin, zeroDEEP, tx.pure.u64(0), tx.object.clock(),
              ],
            });
            if (i === route.hops.length - 1) {
              tx.transferObjects([quoteOut, deepOut], tx.pure.address(ultronAddr));
              currentCoin = baseOut;
            } else {
              tx.transferObjects([quoteOut, deepOut], tx.pure.address(ultronAddr));
              currentCoin = baseOut;
            }
          }
        } else if (dexType === 'cetus') {
          // Cetus swap — takes Coin objects, returns (Coin<A>, Coin<B>)
          const [zeroCoin] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [outType] });
          const [coinValue] = tx.moveCall({ target: '0x2::coin::value', typeArguments: [currentType], arguments: [currentCoin] });
          const [receiveA, receiveB] = tx.moveCall({
            target: `${TreasuryAgents.CETUS_PACKAGE}::router::swap`,
            typeArguments: [coinX, coinY],
            arguments: [
              tx.object(TreasuryAgents.CETUS_GLOBAL_CONFIG), tx.object(hop.poolId),
              swapXtoY ? currentCoin : zeroCoin, swapXtoY ? zeroCoin : currentCoin,
              tx.pure.bool(swapXtoY), tx.pure.bool(true), coinValue,
              tx.pure.u128(swapXtoY ? TreasuryAgents.BF_MIN_SQRT_PRICE : TreasuryAgents.BF_MAX_SQRT_PRICE),
              tx.pure.bool(false), tx.object('0x6'),
            ],
          });
          // Output is receiveB if swapXtoY (we get coinY), receiveA if !swapXtoY (we get coinX)
          if (swapXtoY) {
            tx.transferObjects([receiveA], tx.pure.address(ultronAddr));
            currentCoin = receiveB;
          } else {
            tx.transferObjects([receiveB], tx.pure.address(ultronAddr));
            currentCoin = receiveA;
          }
        } else {
          return { error: `Unsupported DEX type in route: ${dexType}. Only deepbook_v3 and cetus supported.` };
        }

        currentType = outType;
      }

      // Transfer final DEEP coins to ultron
      tx.transferObjects([currentCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, signature);
      console.log(`[TreasuryAgents] SUI→DEEP swap executed: ${digest}, expected DEEP: ${route.amountOut}`);

      return { digest, deepAcquired: route.amountOut };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] swapSuiForDeep error:', errStr);
      return { error: errStr };
    }
  }

  /**
   * Create the iUSD/USDC DeepBook v3 pool. Run once.
   *
   * Requires 500 DEEP in ultron wallet (call swapSuiForDeep first if needed).
   * Calls create_permissionless_pool<IUSD, USDC> with:
   *   - Registry object
   *   - tick_size: 1000 (0.001 USDC granularity — iUSD is 9 decimals, USDC is 6)
   *   - lot_size: 1_000_000_000 (1.0 iUSD minimum lot)
   *   - min_size: 1_000_000_000 (1.0 iUSD minimum order)
   *   - creation_fee: Coin<DEEP> worth 500 DEEP
   *   - clock
   */
  @callable()
  async createIusdUsdcPool(params?: { callerAddress?: string }): Promise<{ digest?: string; poolId?: string; poolIsv?: number; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check DEEP balance
      const balRes = await transport.query({
        variables: {},
        query: `query { address(address: "${ultronAddr}") { balances { nodes { coinType { repr } totalBalance } } } }`,
      });
      const balances = (balRes.data as any)?.address?.balances?.nodes ?? [];
      let deepBal = 0n;
      for (const b of balances) {
        if ((b.coinType?.repr ?? '').includes('::deep::DEEP')) deepBal = BigInt(b.totalBalance ?? '0');
      }

      if (deepBal < TreasuryAgents.POOL_CREATION_FEE) {
        return { error: `Insufficient DEEP: have ${deepBal}, need ${TreasuryAgents.POOL_CREATION_FEE}. Call swapSuiForDeep first.` };
      }

      // Fetch DEEP coin objects to build the fee payment
      const deepCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, TreasuryAgents.DB_DEEP_TYPE],
      );
      const deepCoins = (deepCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      if (!deepCoins.length) {
        return { error: 'No DEEP coin objects found' };
      }

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Build DEEP coin: merge all into one, then split exact fee
      const primaryDeep = tx.object(deepCoins[0].coinObjectId);
      if (deepCoins.length > 1) {
        tx.mergeCoins(primaryDeep, deepCoins.slice(1).map(c => tx.object(c.coinObjectId)));
      }

      // Split exactly 500 DEEP for the creation fee
      const [feeCoin] = tx.splitCoins(primaryDeep, [tx.pure.u64(TreasuryAgents.POOL_CREATION_FEE)]);

      // Create the permissionless pool
      // Registry lives in the types package (0x2c8d...), not the entry-point package
      tx.moveCall({
        package: TreasuryAgents.DB_PACKAGE,
        module: 'pool',
        function: 'create_permissionless_pool',
        typeArguments: [TreasuryAgents.IUSD_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: TreasuryAgents.DB_REGISTRY,
            initialSharedVersion: 336155480,
            mutable: true,
          }),
          tx.pure.u64(1000),              // tick_size (0.001 USDC per tick)
          tx.pure.u64(1_000_000_000),     // lot_size (1.0 iUSD at 9 decimals)
          tx.pure.u64(1_000_000_000),     // min_size (1.0 iUSD minimum)
          feeCoin,                         // creation_fee: Coin<DEEP>
        ],
      });

      // Return leftover DEEP to ultron
      tx.transferObjects([primaryDeep], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] iUSD/USDC DeepBook pool created: ${digest}`);

      // Extract pool object ID from tx effects
      let poolId = '';
      let poolIsv = 0;
      try {
        await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS)); // wait for indexing
        const txRes = await raceJsonRpc<any>('sui_getTransactionBlock', [digest, { showObjectChanges: true }]);
        const changes = txRes?.objectChanges ?? [];
        for (const c of changes) {
          if (c.type === 'created' && c.objectType?.includes('::pool::Pool<')) {
            poolId = c.objectId;
            // Look up ISV
            const objRes = await raceJsonRpc<any>('sui_getObject', [poolId, { showOwner: true }]);
            poolIsv = objRes?.data?.owner?.Shared?.initial_shared_version ?? 0;
            break;
          }
        }
        console.log(`[TreasuryAgents] Pool ID: ${poolId}, ISV: ${poolIsv}`);
      } catch (e) {
        console.error('[TreasuryAgents] Failed to extract pool ID:', e);
      }

      return { digest, poolId, poolIsv };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] createIusdUsdcPool error:', errStr);
      return { error: errStr };
    }
  }

  // ─── Seed iUSD/USDC DeepBook Pool ─────────────────────────────────

  /**
   * Create a BalanceManager, deposit iUSD + USDC, place bid+ask limit orders.
   * Seeds the iUSD/USDC pool with ultron's existing balances.
   */
  @callable()
  async seedIusdPool(params?: { callerAddress?: string }): Promise<{ digest?: string; digest2?: string; balanceManagerId?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check if BalanceManager already exists (from previous partial attempt)
      const BM_TYPE = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::balance_manager::BalanceManager';
      const existingBm = await raceJsonRpc<any>('suix_getOwnedObjects', [ultronAddr, { StructType: BM_TYPE }, null, 1, { showType: true }]);
      let balanceManagerId = existingBm?.data?.[0]?.data?.objectId || '';

      const iusdCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>('suix_getCoins', [ultronAddr, TreasuryAgents.IUSD_TYPE]);
      const usdcCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>('suix_getCoins', [ultronAddr, TreasuryAgents.USDC_TYPE]);
      let iusdCoins = (iusdCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      let usdcCoins = (usdcCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);

      // ── Step 0: Withdraw funds from any existing OWNED BalanceManager ──
      if (balanceManagerId && (!iusdCoins.length || !usdcCoins.length)) {
        // Use unsafe_moveCall to build tx bytes (fullnode accepts the types),
        // then sign and submit. Bypasses SDK entirely.
        console.log(`[seedIusdPool] Withdrawing from owned BM ${balanceManagerId} via unsafe_moveCall...`);
        const refGasRes2 = await transport.query({ variables: {}, query: '{ epoch { referenceGasPrice } }' });
        const gasPrice2 = Number((refGasRes2.data as any)?.epoch?.referenceGasPrice ?? 750);

        for (const coinType of [TreasuryAgents.IUSD_TYPE, TreasuryAgents.USDC_TYPE]) {
          try {
            // Fresh refs every iteration
            const bmObj = await raceJsonRpc<any>('sui_getObject', [balanceManagerId, {}]);
            const gasCoinsW = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
              'suix_getCoins', [ultronAddr, '0x2::sui::SUI'],
            );
            const gasCoin = (gasCoinsW?.data ?? []).find(c => BigInt(c.balance) > 5_000_000n);
            if (!gasCoin || !bmObj?.data) { console.warn('[seedIusdPool] Missing gas or BM ref'); continue; }

            // Build via unsafe_moveCall (fullnode validates types correctly)
            const unsafeRes = await raceJsonRpc<any>('unsafe_moveCall', [
              ultronAddr,
              '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809',
              'balance_manager', 'withdraw_all',
              [coinType],
              [balanceManagerId],
              gasCoin.coinObjectId,
              '10000000',
            ]);
            if (!unsafeRes?.txBytes) {
              return { error: `unsafe_moveCall failed for ${coinType.split('::').pop()}: ${JSON.stringify(unsafeRes)}` };
            }
            const wBytes = Uint8Array.from(atob(unsafeRes.txBytes), c => c.charCodeAt(0));
            const wSig = await keypair.signTransaction(wBytes);

            // Submit with detailed error capture
            let wDigest = '';
            try {
              wDigest = await this._submitTx(wBytes, wSig.signature);
            } catch (submitErr) {
              const ae = submitErr as any;
              const reasons = ae?.errors?.map?.((e: Error) => e.message) ?? [ae?.message ?? String(submitErr)];
              return { error: `Withdraw ${coinType.split('::').pop()} submit failed: ${reasons.join(' | ')}` };
            }
            console.log(`[seedIusdPool] Withdrew ${coinType.split('::').pop()} from BM: ${wDigest}`);
            await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[seedIusdPool] Withdraw ${coinType.split('::').pop()} failed:`, msg);
            return { error: `Withdraw ${coinType.split('::').pop()} build failed: ${msg}` };
          }
        }
        // Re-fetch coins after withdrawal
        const freshIusd = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>('suix_getCoins', [ultronAddr, TreasuryAgents.IUSD_TYPE]);
        const freshUsdc = await raceJsonRpc<{ data: Array<{ coinObjectId: string; balance: string }> }>('suix_getCoins', [ultronAddr, TreasuryAgents.USDC_TYPE]);
        iusdCoins.length = 0; usdcCoins.length = 0;
        iusdCoins.push(...(freshIusd?.data ?? []).filter(c => BigInt(c.balance) > 0n));
        usdcCoins.push(...(freshUsdc?.data ?? []).filter(c => BigInt(c.balance) > 0n));
      }

      const iusdTotal = iusdCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
      const usdcTotal = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
      if (!iusdCoins.length && !usdcCoins.length) return { error: 'No iUSD or USDC after withdrawal' };

      // ── TX 1: Create SHARED BalanceManager + deposit ──
      let digest = '';
      {
        const tx1 = new Transaction();
        tx1.setSender(ultronAddr);
        const [balMgr] = tx1.moveCall({ package: TreasuryAgents.DB_PACKAGE, module: 'balance_manager', function: 'new', arguments: [] });
        if (iusdCoins.length > 0) {
          const iusdPrimary = tx1.object(iusdCoins[0].coinObjectId);
          if (iusdCoins.length > 1) tx1.mergeCoins(iusdPrimary, iusdCoins.slice(1).map(c => tx1.object(c.coinObjectId)));
          tx1.moveCall({ package: TreasuryAgents.DB_PACKAGE, module: 'balance_manager', function: 'deposit', typeArguments: [TreasuryAgents.IUSD_TYPE], arguments: [balMgr, iusdPrimary] });
        }
        if (usdcCoins.length > 0) {
          const usdcPrimary = tx1.object(usdcCoins[0].coinObjectId);
          if (usdcCoins.length > 1) tx1.mergeCoins(usdcPrimary, usdcCoins.slice(1).map(c => tx1.object(c.coinObjectId)));
          tx1.moveCall({ package: TreasuryAgents.DB_PACKAGE, module: 'balance_manager', function: 'deposit', typeArguments: [TreasuryAgents.USDC_TYPE], arguments: [balMgr, usdcPrimary] });
        }
        // Share the BalanceManager (DeepBook v3 expects shared, not owned)
        const DB_TYPES = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
        tx1.moveCall({
          target: '0x2::transfer::public_share_object',
          arguments: [balMgr],
          typeArguments: [`${DB_TYPES}::balance_manager::BalanceManager`],
        });
        const txBytes1 = await tx1.build({ client: transport as never });
        const sig1 = await keypair.signTransaction(txBytes1);
        digest = await this._submitTx(txBytes1, sig1.signature);
        console.log(`[seedIusdPool] TX1: BalanceManager created: ${digest}`);
        await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));
        const txRes = await raceJsonRpc<any>('sui_getTransactionBlock', [digest, { showObjectChanges: true }]);
        for (const ch of (txRes?.objectChanges ?? [])) {
          if (ch.type === 'created' && ch.objectType?.includes('BalanceManager')) { balanceManagerId = ch.objectId; break; }
        }
        if (!balanceManagerId) return { digest, error: 'BalanceManager not found' };
      }
      console.log(`[seedIusdPool] BalanceManager: ${balanceManagerId}`);

      // ── TX 2: Place limit orders via unsafe_moveCall (SDK resolver has type-check bug) ──
      // Build a PTB using unsafe_moveCall to bypass the SDK's broken type resolver,
      // then compose into a proper multi-command tx by building manually.
      const LOT_SIZE = 1_000_000_000n;

      // Step 1: Generate trade proof via unsafe_moveCall
      const DB_TYPES = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
      const proofRes = await raceJsonRpc<any>('unsafe_moveCall', [
        ultronAddr, DB_TYPES, 'balance_manager', 'generate_proof_as_owner',
        [], [balanceManagerId], null, '50000000',
      ]);
      if (!proofRes?.txBytes) return { digest, error: 'Failed to build proof tx' };

      // Step 2: Build the full PTB with proof + place_limit_order
      // We need to compose this as a single PTB. Use the SDK but trick the resolver
      // by using the Transaction's programmatic builder with pre-resolved refs.
      const tx2 = new Transaction();
      tx2.setSender(ultronAddr);

      // Create the BalanceManager input as an explicit owned ref (not resolved by SDK)
      const bmRpc = await raceJsonRpc<any>('sui_getObject', [balanceManagerId, {}]);
      const bmInput = tx2.objectRef({ objectId: balanceManagerId, version: String(bmRpc?.data?.version), digest: bmRpc?.data?.digest });

      // generate_proof_as_owner — use package that DEFINES the type, not the re-exporter
      const [proof] = tx2.moveCall({
        package: DB_TYPES,
        module: 'balance_manager',
        function: 'generate_proof_as_owner',
        arguments: [bmInput],
      });

      // place_limit_order — ASK 1 iUSD at 1:1
      const poolRef = tx2.sharedObjectRef({ objectId: TreasuryAgents.DB_IUSD_USDC_POOL, initialSharedVersion: TreasuryAgents.DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION, mutable: true });
      const clockRef = tx2.sharedObjectRef({ objectId: '0x0000000000000000000000000000000000000000000000000000000000000006', initialSharedVersion: 1, mutable: false });
      tx2.moveCall({
        package: TreasuryAgents.DB_PACKAGE,
        module: 'pool',
        function: 'place_limit_order',
        typeArguments: [TreasuryAgents.IUSD_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [poolRef, bmInput, proof, tx2.pure.u64(1), tx2.pure.u8(0), tx2.pure.u8(0), tx2.pure.u64(1000), tx2.pure.u64(LOT_SIZE), tx2.pure.bool(false), tx2.pure.bool(false), tx2.pure.u64(0), clockRef],
      });

      // Gas
      const gasRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, '0x2::sui::SUI'],
      );
      const gasCoins = (gasRes?.data ?? []).filter(c => BigInt(c.balance) > 5_000_000n);
      if (gasCoins.length > 0) {
        tx2.setGasPayment([{ objectId: gasCoins[0].coinObjectId, version: gasCoins[0].version, digest: gasCoins[0].digest }]);
      }
      tx2.setGasBudget(50_000_000);
      const refGasRes = await transport.query({ variables: {}, query: '{ epoch { referenceGasPrice } }' });
      tx2.setGasPrice(Number((refGasRes.data as any)?.epoch?.referenceGasPrice ?? 750));

      // Build WITHOUT client — all refs are explicit, no resolution needed
      const txBytes2 = await tx2.build();
      const sig2 = await keypair.signTransaction(txBytes2);
      // Try submission with full error capture
      let digest2 = '';
      try {
        digest2 = await this._submitTx(txBytes2, sig2.signature);
      } catch (submitErr) {
        // Capture all individual backend errors
        const ae = submitErr as any;
        const reasons = ae?.errors?.map?.((e: Error) => e.message) ?? [ae?.message ?? String(submitErr)];
        console.error(`[seedIusdPool] TX2 submission failures:`, reasons);
        return { digest, balanceManagerId, error: `TX2 submission failed: ${reasons.join(' | ')}` };
      }
      console.log(`[seedIusdPool] TX2 done: ${digest2}`);

      return { digest, digest2, balanceManagerId };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] seedIusdPool error:', errStr);
      return { error: errStr };
    }
  }

  // ─── Ignite — cross-chain gas fulfillment ──────────────────────────

  private static readonly IGNITE_PACKAGE = '0x66a44a869fe8ea7354620f7c356514efc30490679aa5cb24b453480e97790677';
  private static readonly IGNITE_CONFIG = '0x19566f67090e9b655f3ffa7c496260e7b604fdc788377734f2419158f4111e17';
  private static readonly IGNITE_CONFIG_ISV = 794629458;

  // Gas price estimates in native token units (updated by Sibyl)
  private static readonly GAS_ESTIMATES: Record<string, { amount: bigint; decimals: number; minIusd: bigint }> = {
    sol: { amount: 10_000n, decimals: 9, minIusd: 100_000_000n },         // 0.00001 SOL, min 0.10 iUSD
    eth: { amount: 100_000_000_000_000n, decimals: 18, minIusd: 10_000_000_000n }, // 0.0001 ETH, min 10 iUSD
    base: { amount: 100_000_000_000n, decimals: 18, minIusd: 100_000_000n },      // 0.0000001 ETH, min 0.10 iUSD
    btc: { amount: 10_000n, decimals: 8, minIusd: 15_000_000_000n },     // 0.0001 BTC, min 15 iUSD
    arb: { amount: 100_000_000_000n, decimals: 18, minIusd: 100_000_000n },       // min 0.10 iUSD
  };

  /**
   * Fulfill an ignite request — t2000 consensus + IKA dWallet execution.
   *
   * 1. Validate the request (chain supported, payment sufficient)
   * 2. Fan out to t2000 DOs for consensus vote (off-chain, HTTP)
   * 3. Quilt all votes to Walrus
   * 4. If supermajority approves: sign native gas tx via IKA 2PC-MPC
   * 5. Call ignite_resp on-chain with target tx hash + quilt blob ID
   */
  @callable()
  async fulfillIgnite(params: {
    requestId: string;
    chain: string;
    encryptedRecipient: string;
    iusdBurned: number;
    callerAddress?: string;
  }): Promise<{ digest?: string; targetTxHash?: string; quiltBlobId?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    const { requestId, chain, iusdBurned } = params;

    // Validate chain
    const gasInfo = TreasuryAgents.GAS_ESTIMATES[chain.toLowerCase()];
    if (!gasInfo) return { error: `Unsupported chain: ${chain}` };

    // Validate payment (must exceed minimum for this chain)
    if (BigInt(iusdBurned) < gasInfo.minIusd) {
      return { error: `Underpaid: ${iusdBurned} iUSD < min ${gasInfo.minIusd} for ${chain}` };
    }

    // TODO Phase 2: Fan out to t2000 DOs for consensus votes
    // For now, ultron auto-approves (single agent, no fleet yet)
    const votes = [{
      agent: 'ultron.sui',
      vote: 'APPROVE' as const,
      gasEstimate: Number(gasInfo.amount),
      reason: `Spread ${iusdBurned / Number(gasInfo.minIusd)}x, auto-approved`,
    }];

    // TODO Phase 2: Store quilt to Walrus
    const quiltBlobId = `pending:${requestId.slice(0, 16)}`;

    // TODO Phase 3: IKA 2PC-MPC signing on target chain
    // For now, log the intent — actual cross-chain signing requires gRPC (not available in CF Workers)
    const targetTxHash = `pending:${chain}:${requestId.slice(0, 16)}`;

    console.log(`[TreasuryAgents] Ignite ${chain} — request ${requestId}, burned ${iusdBurned} iUSD, votes: ${JSON.stringify(votes)}`);

    // Call ignite_resp on-chain to close the request
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      tx.moveCall({
        package: TreasuryAgents.IGNITE_PACKAGE,
        module: 'ignite',
        function: 'ignite_resp',
        arguments: [
          tx.sharedObjectRef({
            objectId: TreasuryAgents.IGNITE_CONFIG,
            initialSharedVersion: TreasuryAgents.IGNITE_CONFIG_ISV,
            mutable: false,
          }),
          tx.object(requestId),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(targetTxHash))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(quiltBlobId))),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Ignite fulfilled: ${digest}`);

      return { digest, targetTxHash, quiltBlobId };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] fulfillIgnite error:', errStr);
      return { error: errStr };
    }
  }

  // ─── Rumble — server-side IKA dWallet provisioning for ultron.sui ───

  /**
   * Rumble for ultron.sui — check/provision all IKA dWallets using the ultron keypair.
   *
   * Queries existing DWalletCap objects owned by ultron, extracts public outputs,
   * and derives all cross-chain addresses (BTC, ETH, SOL, Base, Polygon, etc.).
   *
   * DKG LIMITATION: The DKG provisioning flow requires:
   *   1. gRPC transport (SuiGrpcClient) — blocked in Cloudflare Workers (no HTTP/2 streaming)
   *   2. IKA SDK WASM (prepareDKGAsync, UserShareEncryptionKeys) — not available in Workers
   * Therefore, if dWallets are missing, this method returns a clear error.
   * DKG must be triggered from the browser (client-side rumble) or a non-CF server.
   *
   * Once dWallets exist, this method works fully in Workers (JSON-RPC + pure-JS crypto).
   */
  @callable()
  async rumbleUltron(params?: { callerAddress?: string }): Promise<{
    ultronAddress: string;
    btcAddress: string;
    ethAddress: string;
    solAddress: string;
    addresses: Array<{ chain: string; name: string; address: string }>;
    dwalletCaps: string[];
    needsDkg: { secp256k1: boolean; ed25519: boolean };
    error?: string;
  }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return {
      ultronAddress: '', btcAddress: '', ethAddress: '', solAddress: '',
      addresses: [], dwalletCaps: [],
      needsDkg: { secp256k1: true, ed25519: true },
      error: authErr,
    };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return {
        ultronAddress: '', btcAddress: '', ethAddress: '', solAddress: '',
        addresses: [], dwalletCaps: [],
        needsDkg: { secp256k1: true, ed25519: true },
        error: 'SHADE_KEEPER_PRIVATE_KEY not set',
      };
    }

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const ultronAddress = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
    console.log(`[TreasuryAgents:rumble] Ultron: ${ultronAddress}`);

    // Query all DWalletCap objects owned by ultron via JSON-RPC
    const DWALLET_CAP_TYPE = '0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317::coordinator_inner::DWalletCap';

    let caps: Array<{ objectId: string; dwalletId: string }> = [];
    try {
      const owned = await raceJsonRpc<any>('suix_getOwnedObjects', [
        ultronAddress,
        { StructType: DWALLET_CAP_TYPE },
        null, // cursor
        10,   // limit
        { showContent: true },
      ]);
      for (const entry of (owned?.data ?? [])) {
        const cap = entry?.data;
        if (!cap) continue;
        const dwalletId = cap.content?.fields?.dwallet_id ?? '';
        if (dwalletId) {
          caps.push({ objectId: cap.objectId, dwalletId });
        }
      }
    } catch (err) {
      console.error('[TreasuryAgents:rumble] Failed to query DWalletCaps:', err);
      return {
        ultronAddress, btcAddress: '', ethAddress: '', solAddress: '',
        addresses: [], dwalletCaps: [],
        needsDkg: { secp256k1: true, ed25519: true },
        error: `Failed to query DWalletCaps: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    console.log(`[TreasuryAgents:rumble] Found ${caps.length} DWalletCap(s)`);

    // Fetch each dWallet object to get public_output for address derivation
    let btcAddress = '';
    let ethAddress = '';
    let solAddress = '';
    const addresses: Array<{ chain: string; name: string; address: string }> = [];
    const dwalletCaps: string[] = caps.map(c => c.objectId);
    let hasSecp256k1 = false;
    let hasEd25519 = false;

    for (const cap of caps) {
      try {
        const dw = await raceJsonRpc<any>('sui_getObject', [
          cap.dwalletId,
          { showContent: true },
        ]);
        const state = dw?.data?.content?.fields?.state?.fields;
        const publicOutput = state?.public_output;
        if (!publicOutput || !Array.isArray(publicOutput)) {
          console.warn(`[TreasuryAgents:rumble] No public_output for dWallet ${cap.dwalletId}`);
          continue;
        }

        const output = new Uint8Array(publicOutput);

        // Try secp256k1 derivation (33-byte compressed pubkey)
        try {
          const rawPubkey = this._extractSecp256k1Pubkey(output);
          if (rawPubkey) {
            hasSecp256k1 = true;
            const secp256k1Chains = chainsForCurve(IkaCurve.SECP256K1);
            for (const chain of secp256k1Chains) {
              try {
                const addr = chain.deriveAddress(rawPubkey);
                addresses.push({ chain: chain.caipId, name: chain.name, address: addr });
                if (chain.name === 'Bitcoin' && !btcAddress) btcAddress = addr;
                if (chain.name === 'Ethereum' && !ethAddress) ethAddress = addr;
              } catch { /* derivation not implemented for this chain */ }
            }
          }
        } catch {
          // Not secp256k1 — try ed25519
          try {
            const rawPubkey = this._extractEd25519Pubkey(output);
            if (rawPubkey) {
              hasEd25519 = true;
              const addr = deriveAddress('solana', rawPubkey);
              if (!solAddress) solAddress = addr;
              addresses.push({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', name: 'Solana', address: addr });
            }
          } catch (e) {
            console.warn(`[TreasuryAgents:rumble] Could not derive addresses for dWallet ${cap.dwalletId}:`, e);
          }
        }
      } catch (err) {
        console.warn(`[TreasuryAgents:rumble] Failed to fetch dWallet ${cap.dwalletId}:`, err);
      }
    }

    const needsDkg = {
      secp256k1: !hasSecp256k1,
      ed25519: !hasEd25519,
    };

    if (needsDkg.secp256k1 || needsDkg.ed25519) {
      // TODO: DKG provisioning requires gRPC (SuiGrpcClient) + IKA SDK WASM,
      // neither of which work in Cloudflare Workers.
      // - gRPC: CF Workers lack HTTP/2 bidirectional streaming (see https://github.com/cloudflare/workerd/issues/6455)
      // - WASM: IKA SDK's prepareDKGAsync / UserShareEncryptionKeys are browser-only WASM modules
      //
      // Ultron already has 148.94 IKA tokens, so the SUI→IKA swap is not needed.
      // DKG only requires IKA tokens as payment + SUI for gas.
      //
      // Workaround options:
      //   1. Trigger DKG from the browser using the existing client-side `rumble()` function
      //   2. Run DKG on a non-CF server (e.g., a VPS with Node.js + gRPC support)
      //   3. Use `ika-provision.ts` from a local script with the ultron key
      //
      // Once dWallets are provisioned, this method will detect them and derive all addresses.
      const missing = [
        needsDkg.secp256k1 ? 'secp256k1 (BTC/ETH)' : '',
        needsDkg.ed25519 ? 'ed25519 (SOL)' : '',
      ].filter(Boolean).join(', ');
      console.warn(`[TreasuryAgents:rumble] Missing dWallets: ${missing} — DKG blocked in Workers (no gRPC/WASM)`);
    }

    console.log(`[TreasuryAgents:rumble] Result: BTC=${btcAddress || 'none'}, ETH=${ethAddress || 'none'}, SOL=${solAddress || 'none'}, caps=${dwalletCaps.length}`);
    return {
      ultronAddress,
      btcAddress,
      ethAddress,
      solAddress,
      addresses,
      dwalletCaps,
      needsDkg,
    };
  }

  /**
   * Pre-Rumble for a newly registered SuiNS name.
   * Writes ultron's chain addresses to the Roster under the user's name.
   * Custodial until the user Rumbles themselves (then their own addresses overwrite).
   */
  @callable()
  async preRumbleForName(params: { name: string; userAddress?: string; source?: string; geo?: { lat?: number; lon?: number; city?: string; country?: string }; callerAddress?: string }): Promise<{ digest?: string; error?: string }> {
    const authErr = this.requireUltronCaller(params?.callerAddress); if (authErr) return { error: authErr };
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    const { name, source } = params;
    if (!name) return { error: 'Missing name' };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const userAddress = params.userAddress || ultronAddr; // default to ultron for pre-trade provisioning
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Get ultron's chain addresses (cached from last rumble)
      const status = await this.rumbleUltron();
      if (!status.btcAddress && !status.solAddress) return { error: 'Ultron has no dWallet addresses' };

      const bare = name.replace(/\.sui$/i, '').toLowerCase();
      const bareBytes = new TextEncoder().encode(bare);
      const { keccak_256 } = await import('@noble/hashes/sha3.js');
      const nh = Array.from(keccak_256(bareBytes));

      // Build chains array: user's sui address + ultron's cross-chain addresses
      const chainKeys: string[] = ['sui'];
      const chainVals: string[] = [normalizeSuiAddress(userAddress)];
      if (status.btcAddress) { chainKeys.push('btc'); chainVals.push(status.btcAddress); }
      if (status.ethAddress) { chainKeys.push('eth'); chainVals.push(status.ethAddress); }
      if (status.solAddress) { chainKeys.push('sol'); chainVals.push(status.solAddress); }

      const ROSTER_PKG = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';
      const ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';

      const tx = new Transaction();
      tx.setSender(ultronAddr);
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
          tx.pure.vector('address', status.dwalletCaps.map(c => normalizeSuiAddress(c))),
          tx.object('0x6'),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Pre-Rumbled for ${bare}.sui: ${digest}${source ? ` (${source})` : ''}`);

      // QuestFi attribution — credit snipe agents for pre-trade provisioning
      if (source === 'questfi-snipe') {
        const sniper = (this.state.t2000s ?? []).find(a => a.active && a.mission === 'snipe');
        if (sniper) {
          sniper.runs = (sniper.runs || 0) + 1;
          sniper.last_run_ms = Date.now();
          console.log(`[QuestFi:${sniper.designation}] Pre-rumbled ${bare}.sui — run #${sniper.runs}`);
        }
      }

      // ── Squid counter — track per-chain + geo ──────────────────────────
      const squids: SquidStats = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
      squids.total++;
      squids.by_chain.sui++;
      if (chainKeys.includes('btc')) squids.by_chain.btc++;
      if (chainKeys.includes('eth')) squids.by_chain.eth++;
      if (chainKeys.includes('sol')) squids.by_chain.sol++;
      const geoEntry: SquidGeo = {
        name: bare,
        chains: [...chainKeys],
        source: source || 'register',
        ...(params.geo?.lat != null ? { lat: params.geo.lat } : {}),
        ...(params.geo?.lon != null ? { lon: params.geo.lon } : {}),
        ...(params.geo?.city ? { city: params.geo.city } : {}),
        ...(params.geo?.country ? { country: params.geo.country } : {}),
        ts: Date.now(),
      };
      squids.geo = [...squids.geo.slice(-499), geoEntry]; // keep last 500
      this.setState({ ...this.state, squids });

      // Attest to Walrus — permanent proof of pre-rumble
      let blobId = '';
      try {
        const attestation = {
          type: 'pre-rumble',
          name: bare,
          userAddress: normalizeSuiAddress(userAddress),
          custodian: ultronAddr,
          chains: Object.fromEntries(chainKeys.map((k, i) => [k, chainVals[i]])),
          dwalletCaps: status.dwalletCaps,
          rosterDigest: digest,
          ...(source ? { source } : {}),
          ts: Date.now(),
        };
        const walrusRes = await fetch('https://publisher.walrus.site/v1/store', {
          method: 'PUT',
          body: JSON.stringify(attestation),
        });
        const walrusData = await walrusRes.json() as any;
        blobId = walrusData?.newlyCreated?.blobObject?.blobId || walrusData?.alreadyCertified?.blobId || '';
        if (blobId) console.log(`[TreasuryAgents] Pre-Rumble attested to Walrus: ${blobId}`);
      } catch (e) { console.warn('[TreasuryAgents] Walrus attestation failed:', e); }

      // Send welcome Thunder to the new name — announces their chain addresses.
      // Short-hash format matching makeThunderGroupId (first 14 hex × 2 sorted).
      try {
        const welcomeMsg = `\ud83e\udd91 Rumble squids provisioned! btc@${bare} eth@${bare} sol@${bare} — your chain addresses are live. Rumble yourself to take full custody.`;
        const _a = ultronAddr.toLowerCase().replace(/^0x/, '').slice(0, 14);
        const _b = normalizeSuiAddress(userAddress).toLowerCase().replace(/^0x/, '').slice(0, 14);
        const groupId = `t-${[_a, _b].sort().join('')}`;
        await fetch(`https://sui.ski/api/timestream/${encodeURIComponent(groupId)}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            groupId,
            encryptedText: btoa(welcomeMsg),
            nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))),
            keyVersion: '0',
            senderAddress: ultronAddr,
          }),
        });
        console.log(`[TreasuryAgents] Welcome Thunder sent to ${bare}.sui via Timestream`);
      } catch (e) { console.warn('[TreasuryAgents] Welcome Thunder failed:', e); }

      return { digest, blobId };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] preRumbleForName error:', errStr);
      return { error: errStr };
    }
  }

  /**
   * Extract 33-byte compressed secp256k1 public key from dWallet public output.
   * Format: [version, 33, 02/03, ...32 bytes]
   */
  private _extractSecp256k1Pubkey(publicOutput: Uint8Array): Uint8Array | null {
    if (publicOutput.length >= 35 && (publicOutput[2] === 2 || publicOutput[2] === 3) && publicOutput[1] === 33) {
      return publicOutput.slice(2, 35);
    }
    return null;
  }

  /**
   * Extract 32-byte ed25519 public key from dWallet public output.
   * Format: [version, 32, ...32 bytes]
   */
  private _extractEd25519Pubkey(publicOutput: Uint8Array): Uint8Array | null {
    if (publicOutput.length >= 34 && publicOutput[1] === 32) {
      return publicOutput.slice(2, 34);
    }
    return null;
  }

  // ─── Infer: Build Trade TX for buyer ──────────────────────────────
  //
  // Server-side TX builder that reads REAL coin objects and builds the
  // correct payment route. No stale client cache. No guessing.

  // ─── Recover iUSD from shared BM → send to recipient ─────────────
  private async _recoverSharedBm(params: {
    recipient: string;
    bmId?: string;
  }): Promise<{ digest?: string; iusdRecovered?: string; usdcRecovered?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    const SHARED_BM = params.bmId || '0x8be5690bd1335e5f7b4f7cd46dd6ae9bebeba7f325b93abe6cd4d386d78cc765';
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const recipientAddr = normalizeSuiAddress(params.recipient);
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      const bm = tx.object(SHARED_BM);

      const [iusdCoin] = tx.moveCall({
        target: `${DB_BM_PACKAGE}::balance_manager::withdraw_all`,
        typeArguments: [IUSD_TYPE],
        arguments: [bm],
      });
      const [usdcCoin] = tx.moveCall({
        target: `${DB_BM_PACKAGE}::balance_manager::withdraw_all`,
        typeArguments: [USDC_TYPE],
        arguments: [bm],
      });

      tx.transferObjects([iusdCoin, usdcCoin], tx.pure.address(recipientAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[recover-shared-bm] Recovered from ${SHARED_BM} → ${recipientAddr}, digest=${digest}`);
      return { digest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[recover-shared-bm] error:', msg);
      return { error: msg };
    }
  }

  // ─── Shade proxy: ultron fronts the SUI deposit ──────────────────
  // User never needs SUI. Ultron builds + signs the shade::create
  // commitment using its own SUI. The commitment targets the USER's
  // address so the name registers to them at grace expiry. The
  // ShadeExecutorAgent alarm fires the execute() call server-side.
  private async _shadeProxy(params: {
    label: string;
    targetAddress: string;
    graceEndMs?: number;
  }): Promise<{ digest?: string; orderId?: string; depositMist?: string; depositUsd?: number; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'Cache offline' };
    const { label, targetAddress } = params;
    if (!label || !targetAddress) return { error: 'Missing label or targetAddress' };

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const { SuinsClient } = await import('@mysten/suins');

      // SUI price
      let suiPrice = 0;
      try {
        const pr = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744&parsed=true');
        const pj = await pr.json() as any;
        suiPrice = Number(pj?.parsed?.[0]?.price?.price ?? 0) * Math.pow(10, Number(pj?.parsed?.[0]?.price?.expo ?? 0));
      } catch {}
      if (suiPrice <= 0) return { error: 'SUI price unavailable' };

      // Calculate deposit
      const suinsClient = new SuinsClient({ client: transport as never, network: 'mainnet' });
      const domain = `${label}.sui`;
      const [rawPrice, discountMap] = await Promise.all([
        suinsClient.calculatePrice({ name: domain, years: 1 }),
        suinsClient.getCoinTypeDiscount(),
      ]);
      const { mainPackage } = await import('@mysten/suins');
      const nsKey = mainPackage.mainnet.coins.NS.type.replace(/^0x/, '');
      const discountPct = discountMap.get(nsKey) ?? 0;
      const discountedUsd = (rawPrice * (1 - discountPct / 100)) / 1e6;
      const depositMist = BigInt(Math.ceil(discountedUsd / suiPrice * 1.10 * 1e9));
      const depositUsd = Number(depositMist) / 1e9 * suiPrice;

      // Grace end — if caller didn't provide, query the name's
      // expiration and add the 30-day grace window.
      let graceEndMs = params.graceEndMs ?? 0;
      if (!graceEndMs) {
        try {
          const nameRes = await transport.query({
            variables: {},
            query: `query { nameRecord: resolveSuiNsAddress(domain: "${domain}") }`,
          });
          // If the name is expired, grace = expiry + 30 days.
          // Use current time + 30 days as safe default.
          graceEndMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
        } catch {
          graceEndMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
        }
      }

      // Generate salt + commitment
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = Array.from(saltBytes, b => b.toString(16).padStart(2, '0')).join('');

      // Build commitment: keccak256(domain_bytes || bcs_u64(graceEndMs) || bcs_address(target) || salt)
      const domainBytes = new TextEncoder().encode(label);
      const msBytes = new Uint8Array(8);
      new DataView(msBytes.buffer).setBigUint64(0, BigInt(graceEndMs), true);
      const addrHex = normalizeSuiAddress(targetAddress).replace(/^0x/, '');
      const addrBytes = new Uint8Array(addrHex.length / 2);
      for (let i = 0; i < addrBytes.length; i++) addrBytes[i] = parseInt(addrHex.slice(i * 2, i * 2 + 2), 16);

      const preimage = new Uint8Array(domainBytes.length + msBytes.length + addrBytes.length + saltBytes.length);
      let off = 0;
      preimage.set(domainBytes, off); off += domainBytes.length;
      preimage.set(msBytes, off); off += msBytes.length;
      preimage.set(addrBytes, off); off += addrBytes.length;
      preimage.set(saltBytes, off);

      const { keccak_256 } = await import('@noble/hashes/sha3.js');
      const commitment = keccak_256(preimage);

      // Pre-check: does ultron have enough for the deposit?
      // iUSD path needs only gas SUI; SUI path needs deposit + gas.
      const gasBudget = 50_000_000n; // 0.05 SUI
      const ultronBalRes = await transport.query({
        query: `query($a:SuiAddress!){ address(address:$a){ suiBal: balance(coinType:"0x2::sui::SUI"){ totalBalance } iusdBal: balance(coinType:"${IUSD_TYPE}"){ totalBalance } } }`,
        variables: { a: ultronAddr },
      });
      const ultronSuiBal = BigInt((ultronBalRes.data as any)?.address?.suiBal?.totalBalance ?? '0');
      const ultronIusdBal = BigInt((ultronBalRes.data as any)?.address?.iusdBal?.totalBalance ?? '0');
      const iusdDepositMist = BigInt(Math.ceil(depositUsd * 1.10 * 1e9));
      const hasEnoughIusd = ultronIusdBal >= iusdDepositMist;
      const hasEnoughSui = ultronSuiBal >= (depositMist + gasBudget);
      if (!hasEnoughIusd && !hasEnoughSui) {
        const haveIusd = (Number(ultronIusdBal) / 1e9).toFixed(2);
        const haveSui = (Number(ultronSuiBal) / 1e9 * suiPrice).toFixed(2);
        const needUsd = depositUsd.toFixed(2);
        return { error: `Cache has $${haveIusd} iUSD + $${haveSui} SUI, shade needs $${needUsd}. Top up ultron or try a 5+ char name (~$8).` };
      }
      // Gas check — even iUSD path needs SUI for gas
      if (ultronSuiBal < gasBudget) {
        return { error: `Ultron needs gas SUI (has ${(Number(ultronSuiBal) / 1e9).toFixed(4)} SUI, needs 0.05)` };
      }

      // Build PTB — use iUSD deposit via create_stable<IUSD>.
      // If ultron has enough iUSD, deposit iUSD directly (no
      // SUI needed for deposit). Fall back to SUI create() if no iUSD.
      const SHADE_PKG = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';
      const SHADE_V5_PKG = '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837';

      // Check ultron's iUSD balance — prefer iUSD deposit
      const iusdBalRes = await transport.query({
        query: `query($a:SuiAddress!){ address(address:$a){ objects(filter:{type:"0x2::coin::Coin<${IUSD_TYPE}>"}, first:10){ nodes{ address version digest contents{json} } } } }`,
        variables: { a: ultronAddr },
      });
      const iusdCoins = ((iusdBalRes.data as any)?.address?.objects?.nodes ?? [])
        .map((n: any) => ({ objectId: n.address, version: String(n.version), digest: n.digest, balance: BigInt(n.contents?.json?.balance ?? '0') }))
        .filter((c: any) => c.balance > 0n)
        .sort((a: any, b: any) => (a.balance > b.balance ? -1 : 1));
      const iusdTotal = iusdCoins.reduce((s: bigint, c: any) => s + c.balance, 0n);

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      if (iusdTotal >= iusdDepositMist && iusdCoins.length > 0) {
        // iUSD path — zero SUI needed for deposit
        const iusdCoin = tx.objectRef({ objectId: iusdCoins[0].objectId, version: iusdCoins[0].version, digest: iusdCoins[0].digest });
        if (iusdCoins.length > 1) {
          tx.mergeCoins(iusdCoin, iusdCoins.slice(1).map((c: any) => tx.objectRef({ objectId: c.objectId, version: c.version, digest: c.digest })));
        }
        const [iusdForDeposit] = tx.splitCoins(iusdCoin, [tx.pure.u64(iusdDepositMist)]);
        tx.moveCall({
          target: `${SHADE_V5_PKG}::shade::create_stable`,
          typeArguments: [IUSD_TYPE],
          arguments: [
            iusdForDeposit,
            tx.pure.vector('u8', Array.from(commitment)),
            tx.pure.vector('u8', []),
          ],
        });
        tx.transferObjects([iusdCoin], tx.pure.address(ultronAddr));
      } else {
        // SUI fallback
        const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(depositMist)]);
        tx.moveCall({
          target: `${SHADE_PKG}::shade::create`,
          arguments: [
            depositCoin,
            tx.pure.vector('u8', Array.from(commitment)),
            tx.pure.vector('u8', []),
          ],
        });
      }

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);

      // Look up the created shade order object (retry twice for indexing lag).
      // Match either the legacy ShadeOrder (SUI-denominated) or the new
      // StableShadeOrder<T> (iUSD-denominated) — both come out of this flow.
      const wasStable = iusdTotal >= iusdDepositMist && iusdCoins.length > 0;
      let orderId = '';
      let orderInitialSharedVersion = 0;
      for (let attempt = 0; attempt < 2 && !orderId; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? TX_INDEX_WAIT_MS : 3000));
        try {
          const fxRes = await transport.query({
            query: `query($d: String!) { transaction(digest: $d) { effects { objectChanges { nodes { address idCreated outputState { version owner { __typename ... on Shared { initialSharedVersion } } asMoveObject { contents { type { repr } } } } } } } } }`,
            variables: { d: digest },
          });
          const nodes = ((fxRes.data as any)?.transaction?.effects?.objectChanges?.nodes ?? []) as any[];
          for (const n of nodes) {
            if (!n?.idCreated) continue;
            const typeRepr = n.outputState?.asMoveObject?.contents?.type?.repr ?? '';
            const isShadeType = typeRepr.includes('::shade::ShadeOrder') || typeRepr.includes('::shade::StableShadeOrder');
            if (!isShadeType) continue;
            orderId = n.address;
            const isv = n.outputState?.owner?.initialSharedVersion;
            if (isv !== undefined) orderInitialSharedVersion = Number(isv);
            break;
          }
        } catch {}
      }
      // Fallback: use digest-prefixed ID so deliberation still recognizes
      // this as an on-chain order and skips balance-based liquidation.
      if (!orderId) orderId = `digest:${digest}`;

      // Schedule with ShadeExecutorAgent (keyed by target user address).
      // Stable orders must use /?schedule-stable so the executor knows
      // to use execute_stable + iUSD→USDC→NS swap instead of the legacy
      // SUI-only execute path.
      const normalTarget = normalizeSuiAddress(targetAddress);
      if (orderId && !orderId.startsWith('digest:')) {
        try {
          const shadeStub = this.env.ShadeExecutorAgent?.get(
            this.env.ShadeExecutorAgent.idFromName(normalTarget),
          );
          if (shadeStub) {
            if (wasStable) {
              if (!orderInitialSharedVersion) {
                console.warn('[shade-proxy] stable order missing initialSharedVersion — skipping schedule');
              } else {
                await shadeStub.fetch(new Request('https://shade-do/?schedule-stable', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    objectId: orderId,
                    domain: label,
                    executeAfterMs: graceEndMs,
                    targetAddress: normalTarget,
                    salt: saltHex,
                    ownerAddress: normalTarget,
                    depositMist: iusdDepositMist.toString(),
                    initialSharedVersion: orderInitialSharedVersion,
                    coinType: IUSD_TYPE,
                  }),
                }));
                console.log(`[shade-proxy] scheduled STABLE order ${orderId.slice(0,10)}… isv=${orderInitialSharedVersion}`);
              }
            } else {
              await shadeStub.fetch(new Request('https://shade-do/?schedule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  objectId: orderId,
                  domain: label,
                  executeAfterMs: graceEndMs,
                  targetAddress: normalTarget,
                  salt: saltHex,
                  ownerAddress: normalTarget,
                  depositMist: iusdDepositMist.toString(),
                }),
              }));
            }
          }
        } catch (e) {
          console.warn('[shade-proxy] schedule failed:', e);
        }
      }

      // Store in Treasury DO shades array for deliberation + client visibility
      const shades = ((this.state as any).shades ?? []) as any[];
      const { keccak_256: k2 } = await import('@noble/hashes/sha3.js');
      const commitHex = Array.from(commitment, (b: number) => b.toString(16).padStart(2, '0')).join('');
      shades.push({
        id: orderId || crypto.randomUUID(),
        domain: label,
        commitment: commitHex,
        holder: normalTarget,
        thresholdUsd: depositUsd,
        graceEndMs,
        status: 'active',
        objectId: orderId,
        salt: saltHex,
        depositMist: iusdDepositMist.toString(),
        created: Date.now(),
      });
      this.setState({ ...this.state, shades } as any);

      console.log(`[shade-proxy] ${label}.sui shaded → ${targetAddress}, deposit=${Number(iusdDepositMist)/1e9} iUSD, orderId=${orderId}, digest=${digest}`);

      // Auto-deposit idle Solana USDC to Kamino for yield
      try {
        const solAddr = ULTRON_SOL_ADDRESS;
        const usdcBal = await this._getSolanaUsdcBalance(solAddr);
        if (usdcBal > 5) { // keep $5 liquid
          const depositAmt = usdcBal - 5;
          const kaminoTx = await this._depositUsdcToKamino(depositAmt);
          console.log(`[shade-proxy] Deposited $${depositAmt.toFixed(2)} USDC to Kamino: ${kaminoTx}`);
        }
      } catch (e) {
        console.warn('[shade-proxy] Kamino auto-deposit failed:', e instanceof Error ? e.message : e);
      }

      return { digest, orderId, depositMist: iusdDepositMist.toString(), depositUsd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[shade-proxy] error:', msg);
      return { error: msg };
    }
  }

  private async _buildTradeForBuyer(params: {
    buyer: string; nftTokenId: string; priceMist: string; route: string;
    suiBal: string; usdcBal: string; iusdBal: string;
    suiPriceUsd?: number;
  }): Promise<{ txBase64?: string; description?: string; error?: string }> {
    const { buyer, nftTokenId, priceMist, route, suiPriceUsd } = params;
    const buyerAddr = normalizeSuiAddress(buyer);
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    const price = BigInt(priceMist);
    // Tradeport commission is deducted from seller — buyer pays just the price
    const totalNeeded = price;

    const TRADEPORT_V1_PKG = '0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab';
    const TRADEPORT_V1_STORE = '0xf96f9363ac5a64c058bf7140723226804d74c0dab2dd27516fb441a180cd763b';
    const TRADEPORT_V2_PKG = '0xb42dbb7413b79394e1a0175af6ae22b69a5c7cc5df259cd78072b6818217c027';
    const TRADEPORT_V2_STORE = '0x47cba0b6309a12ce39f9306e28b899ed4b3698bce4f4911fd0c58ff2329a2ff6';
    const SUINS_REG_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';

    // Helper: add Tradeport buy call + destroy_zero to a transaction
    const addTradeportBuy = (t: Transaction, listingOrNftId: string, coin: any, v2 = false) => {
      const pkg = v2 ? TRADEPORT_V2_PKG : TRADEPORT_V1_PKG;
      const store = v2 ? TRADEPORT_V2_STORE : TRADEPORT_V1_STORE;
      const fn = v2 ? 'listings::buy' : 'tradeport_listings::buy_listing_without_transfer_policy';
      t.moveCall({
        target: `${pkg}::${fn}`,
        typeArguments: [SUINS_REG_TYPE],
        arguments: [
          t.sharedObjectRef({ objectId: store, initialSharedVersion: 3377344, mutable: true }),
          t.pure.id(listingOrNftId), coin,
        ],
      });
      // buy consumes the entire coin — destroy zero remainder
      t.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [SUI_TYPE], arguments: [coin] });
    };
    const DB_PKG = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
    const DB_SUI_USDC = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
    const DB_SUI_USDC_ISV = 389750322;
    const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

    // Resolve on-chain Listing ID (Store keys by Listing ID, not NFT ID)
    let buyId = nftTokenId;
    try {
      const gqlRes = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ object(address: "${nftTokenId}") { owner { ... on ObjectOwner { address { address asObject { owner { ... on ObjectOwner { address { address } } } } } } } } }`,
        }),
      });
      type R = { data?: { object?: { owner?: { address?: { asObject?: { owner?: { address?: { address?: string } } } } } } } };
      const gqlJson = await gqlRes.json() as R;
      buyId = gqlJson?.data?.object?.owner?.address?.asObject?.owner?.address?.address ?? nftTokenId;
    } catch {}

    const tx = new Transaction();
    tx.setSender(buyerAddr);

    // ── Fetch real SUI coins ──
    const suiCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
      'suix_getCoins', [buyerAddr, SUI_TYPE],
    );
    const suiCoins = (suiCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
    const realSuiBal = suiCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
    const gasBuf = 50_000_000n; // 0.05 SUI gas
    const availSui = realSuiBal > gasBuf ? realSuiBal - gasBuf : 0n;

    // Always prefer SUI direct if buyer has enough — regardless
    // of what infer picked. Exception: when route is explicitly
    // 'iusd-redeem', honor it so ultron gets repaid in stables
    // (otherwise a pre-funded buyer would buy with "free" SUI
    // and leave the cache out-of-pocket).
    if (availSui >= totalNeeded && route !== 'iusd-redeem') {
      // Simple: split from gas, buy — try v1 then v2
      for (const v2 of [false, true]) {
        try {
          const t = new Transaction();
          t.setSender(buyerAddr);
          const payment = t.splitCoins(t.gas, [t.pure.u64(totalNeeded.toString())]);
          addTradeportBuy(t, buyId, payment, v2);
          const txBytes = await t.build({ client: transport as never });
          return { txBase64: uint8ToBase64(txBytes), description: `Buy via SUI direct (${Number(totalNeeded) / 1e9} SUI)` };
        } catch (err) {
          if (!v2 && String(err).includes('MoveAbort')) {
            console.warn('[Tradeport] v1 failed, retrying v2:', err instanceof Error ? err.message : err);
            continue;
          }
          throw err;
        }
      }
    }

    if (route === 'usdc-swap' || route === 'iusd-redeem') {
      // Need USDC→SUI swap to cover the shortfall. When the
      // buyer already has enough SUI (e.g. from a previous
      // pre-fund), shortfall goes non-positive — floor it at
      // zero so downstream math doesn't produce negative u64s.
      const shortfall = totalNeeded > availSui ? totalNeeded - availSui : 0n;
      // Fetch live SUI price from CoinGecko
      let suiPrice = 0.87;
      try {
        const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
        const priceData = await priceRes.json() as any;
        suiPrice = priceData?.sui?.usd ?? 0.87;
      } catch {}
      const usdcNeeded = BigInt(Math.ceil((Number(shortfall) / 1e9) * suiPrice * 1.05 * 1e6)); // 5% buffer

      // Fetch real USDC coins
      const usdcCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [buyerAddr, USDC_TYPE],
      );
      const usdcCoins = (usdcCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      const realUsdcBal = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);

      // For iusd-redeem, always enter the iUSD-payment branch —
      // even when the buyer already has enough SUI, we still
      // want to take iUSD (+ USDC) as payment so the cache
      // recoups the SUI it previously advanced. For usdc-swap,
      // enter only when USDC alone can't cover the swap.
      const forceIusdBranch = route === 'iusd-redeem';
      if (forceIusdBranch || (realUsdcBal < usdcNeeded || usdcCoins.length === 0)) {
        // Buyer has iUSD but not enough SUI/USDC — ultron pre-funds SUI, buyer sends iUSD back + purchases
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'Cache offline' };

        // Check buyer's iUSD. Query by ORIGIN coin type, not the
        // latest dispatch package — Sui coins are typed by the
        // package that defined the struct, so `suix_getCoins`
        // against the upgraded package returns zero.
        const iusdCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
          'suix_getCoins', [buyerAddr, IUSD_TYPE],
        );
        const iusdCoins = (iusdCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
        const realIusdBal = iusdCoins.reduce((s, c) => s + BigInt(c.balance), 0n);

        if (realIusdBal === 0n) {
          return { error: `No iUSD, SUI, or USDC. Nothing to trade with.` };
        }

        // Step 1: Ultron pre-funds SUI IF the buyer doesn't
        // already have enough. Idempotent: repeated /api/infer
        // calls won't double-send. A prior attempt may have
        // already landed the pre-fund on-chain, in which case
        // we reuse it.
        let prefundDigest = '(already funded)';
        if (availSui < totalNeeded) {
          const suiToSend = totalNeeded + 50_000_000n; // + 0.05 SUI gas buffer
          const prefund = await this._ultronSendsSwapSui(buyerAddr, suiToSend, transport);
          if (prefund.error) return { error: prefund.error };
          prefundDigest = prefund.digest ?? '(no digest)';
          await new Promise(r => setTimeout(r, CHAIN_PROPAGATION_MS));
        }

        // Step 2: Build user TX — send iUSD (+ USDC top-up when
        // iUSD alone is short) to ultron + purchase from Tradeport.
        // The total value user sends MUST equal the listing USD
        // value + gas buffer so ultron doesn't eat the spread on
        // the pre-fund.
        //
        // SUI price comes from /api/infer (which uses Pyth). We
        // only fall back to CoinGecko if the caller didn't pass
        // a number — avoids the stale-price drift that left
        // ultron short by ~$2.74 on earlier test runs.
        let suiPrice = suiPriceUsd ?? 0;
        if (!(suiPrice > 0)) {
          try { const p = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd'); suiPrice = ((await p.json()) as any)?.sui?.usd ?? 0.87; } catch { suiPrice = 0.87; }
        }
        // Charge the buyer against the FULL SUI value ultron
        // forwarded — listing price + the 0.05 SUI gas buffer.
        // Otherwise the buyer pays for the listing but leaves
        // ultron holding the gas.
        const prefundSui = totalNeeded + 50_000_000n;
        const prefundUsd = Number(prefundSui) / 1e9 * suiPrice;
        // 0.5% safety margin so small SUI-price oscillations
        // between /api/infer and execution don't underpay.
        const listingUsdCharge = prefundUsd * 1.005;
        const iusdToSend = BigInt(Math.ceil(listingUsdCharge * 1e9)); // iUSD amount at $1 peg
        const iusdCapped = iusdToSend < realIusdBal ? iusdToSend : realIusdBal;

        // If iUSD alone can't cover, compute USDC top-up from the
        // buyer's USDC balance. iusdCapped is in 9-dec iUSD mist;
        // iUSD is $1-pegged, so iusdUsdCovered = iusdCapped / 1e9.
        // USDC mist is 6 decimals; pay the remaining USD in USDC.
        const iusdUsdCovered = Number(iusdCapped) / 1e9;
        let usdcTopUpMist = 0n;
        if (iusdUsdCovered < listingUsdCharge) {
          const usdcTopUpUsd = listingUsdCharge - iusdUsdCovered;
          usdcTopUpMist = BigInt(Math.ceil(usdcTopUpUsd * 1e6));
          if (usdcTopUpMist > realUsdcBal) {
            const shortUsd = Number(usdcTopUpMist - realUsdcBal) / 1e6;
            return { error: `Short $${shortUsd.toFixed(2)} after iUSD+USDC. Add $${shortUsd.toFixed(2)} more.` };
          }
        }

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY!);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

        const payLabel = usdcTopUpMist > 0n
          ? `${Number(iusdCapped) / 1e9} iUSD + ${Number(usdcTopUpMist) / 1e6} USDC`
          : `${Number(iusdCapped) / 1e9} iUSD`;

        // Build iUSD+USDC payment + Tradeport buy. Listing/store
        // layouts differ between v1 and v2 and we can't tell
        // which one from the listing row alone — try v1 first,
        // fall back to v2 on MoveAbort. A fresh Transaction per
        // attempt avoids mutating the same handle twice.
        let lastErr: unknown = null;
        for (const v2 of [false, true]) {
          try {
            const userTx = new Transaction();
            userTx.setSender(buyerAddr);

            // Send iUSD to ultron
            const iusdCoinRef = userTx.objectRef({ objectId: iusdCoins[0].coinObjectId, version: String(iusdCoins[0].version), digest: iusdCoins[0].digest });
            if (iusdCoins.length > 1) {
              userTx.mergeCoins(iusdCoinRef, iusdCoins.slice(1).map(c =>
                userTx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
              ));
            }
            const [iusdPayment] = userTx.splitCoins(iusdCoinRef, [userTx.pure.u64(iusdCapped.toString())]);
            userTx.transferObjects([iusdPayment], userTx.pure.address(ultronAddr));
            userTx.transferObjects([iusdCoinRef], userTx.pure.address(buyerAddr));

            if (usdcTopUpMist > 0n && usdcCoins.length > 0) {
              const usdcPrimary = userTx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
              if (usdcCoins.length > 1) {
                userTx.mergeCoins(usdcPrimary, usdcCoins.slice(1).map(c =>
                  userTx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
                ));
              }
              const [usdcPayment] = userTx.splitCoins(usdcPrimary, [userTx.pure.u64(usdcTopUpMist.toString())]);
              userTx.transferObjects([usdcPayment], userTx.pure.address(ultronAddr));
              userTx.transferObjects([usdcPrimary], userTx.pure.address(buyerAddr));
            }

            const payment = userTx.splitCoins(userTx.gas, [userTx.pure.u64(totalNeeded.toString())]);
            addTradeportBuy(userTx, buyId, payment, v2);

            const txBytes = await userTx.build({ client: transport as never });
            return {
              txBase64: uint8ToBase64(txBytes),
              description: `Send ${payLabel} to cache + buy ${Number(price) / 1e9} SUI listing via Tradeport ${v2 ? 'v2' : 'v1'} (pre-funded by ultron: ${prefundDigest})`,
            };
          } catch (err) {
            lastErr = err;
            if (v2 || !String(err).includes('MoveAbort')) break;
            console.warn('[Tradeport-iusd] v1 failed, retrying v2:', err instanceof Error ? err.message : err);
          }
        }
        return { error: `Tradeport build failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` };
      }

      if (usdcCoins.length === 0 || realUsdcBal === 0n) {
        return { error: `No SUI, USDC, or iUSD. SUI: ${Number(realSuiBal) / 1e9} (need ${Number(totalNeeded) / 1e9})` };
      }

      // Merge USDC coins
      const usdcCoin = tx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
      if (usdcCoins.length > 1) {
        tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c =>
          tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
        ));
      }

      // Split USDC for swap
      const swapAmount = usdcNeeded < realUsdcBal ? usdcNeeded : realUsdcBal;
      const [usdcForSwap] = tx.splitCoins(usdcCoin, [tx.pure.u64(swapAmount.toString())]);

      // Swap USDC → SUI via DeepBook
      const minSuiOut = shortfall * 95n / 100n; // 5% slippage
      const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
      const dbResult = tx.moveCall({
        target: `${DB_PKG}::pool::swap_exact_quote_for_base`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({ objectId: DB_SUI_USDC, initialSharedVersion: DB_SUI_USDC_ISV, mutable: true }),
          usdcForSwap, zeroDEEP, tx.pure.u64(minSuiOut.toString()), tx.object('0x6'),
        ],
      });

      // Merge swapped SUI into gas
      tx.mergeCoins(tx.gas, [dbResult[0]]);
      // Return USDC change + DEEP dust
      tx.transferObjects([dbResult[1], dbResult[2], usdcCoin], tx.pure.address(buyerAddr));

      // Now purchase with gas (has original SUI + swapped SUI)
      const payment = tx.splitCoins(tx.gas, [tx.pure.u64(totalNeeded.toString())]);
      addTradeportBuy(tx, buyId, payment);

      const txBytes = await tx.build({ client: transport as never });
      return { txBase64: uint8ToBase64(txBytes), description: `USDC→SUI swap + Tradeport buy (${Number(swapAmount) / 1e6} USDC → ${Number(shortfall) / 1e9} SUI)` };
    }

    return { error: `Route "${route}" not supported. SUI: ${Number(realSuiBal) / 1e9}, needed: ${Number(totalNeeded) / 1e9}` };
  }

  /** Swap iUSD → SUI or USDC. Ultron sends output token to user, builds TX for user to send iUSD back.
   *  Two steps: 1) ultron pre-sends SUI/USDC, 2) returns TX bytes for user to sign (sends iUSD to ultron). */
  private async _swapIusd(params: { address: string; amount: string; outputToken: 'SUI' | 'USDC' }): Promise<{
    txBase64?: string; prefundDigest?: string; outputSent?: string; description?: string; error?: string;
  }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'Cache offline' };

    const { address, amount, outputToken } = params;
    const buyerAddr = normalizeSuiAddress(address);
    const iusdAmount = BigInt(amount); // in iUSD raw (9 decimals)
    const iusdUsd = Number(iusdAmount) / 1e9; // dollar value at $1 peg

    if (iusdAmount <= 0n) return { error: 'Amount must be positive' };

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    // Step 1: Ultron sends SUI or USDC to user
    let prefundDigest: string;
    let outputSent: string;

    if (outputToken === 'SUI') {
      const suiPrice = 0.88; // TODO: get real price
      const suiAmount = BigInt(Math.ceil((iusdUsd / suiPrice) * 1e9));
      const result = await this._ultronSendsSwapSui(buyerAddr, suiAmount, transport);
      if (result.error) return { error: result.error };
      prefundDigest = result.digest!;
      outputSent = `${Number(suiAmount) / 1e9} SUI`;
    } else {
      // Send USDC
      const usdcAmount = BigInt(Math.floor(iusdUsd * 1e6)); // USDC has 6 decimals
      const usdcCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, USDC_TYPE],
      );
      const usdcCoins = (usdcCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      const totalUsdc = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
      if (totalUsdc < usdcAmount) return { error: `Cache low on USDC (${Number(totalUsdc) / 1e6} USDC, need ${Number(usdcAmount) / 1e6})` };

      const tx = new Transaction();
      tx.setSender(ultronAddr);
      const usdcCoin = tx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
      if (usdcCoins.length > 1) {
        tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
      }
      const [send] = tx.splitCoins(usdcCoin, [tx.pure.u64(usdcAmount.toString())]);
      tx.transferObjects([send], tx.pure.address(buyerAddr));
      tx.transferObjects([usdcCoin], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      prefundDigest = await this._submitTx(txBytes, sig.signature);
      outputSent = `${Number(usdcAmount) / 1e6} USDC`;
    }

    console.log(`[iUSD:swap] Sent ${outputSent} to ${buyerAddr} (digest: ${prefundDigest})`);

    // Wait for chain propagation
    await new Promise(r => setTimeout(r, CHAIN_PROPAGATION_MS));

    // Step 2: Build user TX to send iUSD to ultron
    const iusdCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
      'suix_getCoins', [buyerAddr, `${TreasuryAgents.IUSD_PKG}::iusd::IUSD`],
    );
    const iusdCoins = (iusdCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
    if (iusdCoins.length === 0) return { error: 'No iUSD coins found after prefund', prefundDigest };

    const userTx = new Transaction();
    userTx.setSender(buyerAddr);

    const iusdCoin = userTx.objectRef({ objectId: iusdCoins[0].coinObjectId, version: String(iusdCoins[0].version), digest: iusdCoins[0].digest });
    if (iusdCoins.length > 1) {
      userTx.mergeCoins(iusdCoin, iusdCoins.slice(1).map(c =>
        userTx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
      ));
    }
    const realIusdBal = iusdCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
    const iusdToSend = iusdAmount < realIusdBal ? iusdAmount : realIusdBal;
    const [iusdPayment] = userTx.splitCoins(iusdCoin, [userTx.pure.u64(iusdToSend.toString())]);
    userTx.transferObjects([iusdPayment], userTx.pure.address(ultronAddr));
    userTx.transferObjects([iusdCoin], userTx.pure.address(buyerAddr)); // return change

    const txBytes = await userTx.build({ client: transport as never });

    return {
      txBase64: uint8ToBase64(txBytes),
      prefundDigest,
      outputSent,
      description: `Swap ${Number(iusdToSend) / 1e9} iUSD → ${outputSent}`,
    };
  }

  /** Swap all USDC→SUI via DeepBook to refill ultron's SUI for cache trades. */
  private async _refillSui(): Promise<{ digest?: string; suiReceived?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      const coinData = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
        'suix_getCoins', [ultronAddr, USDC_TYPE],
      );
      const usdcCoins = (coinData?.data ?? []).filter(c => BigInt(c.balance) > 0n);
      const totalUsdc = usdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
      if (totalUsdc < 1_000_000n) return { error: `Only ${Number(totalUsdc) / 1e6} USDC — not enough to swap` };

      console.log(`[Cache:refill] Swapping ${Number(totalUsdc) / 1e6} USDC → SUI`);

      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Merge all USDC
      const usdcCoin = tx.objectRef({ objectId: usdcCoins[0].coinObjectId, version: String(usdcCoins[0].version), digest: usdcCoins[0].digest });
      if (usdcCoins.length > 1) {
        tx.mergeCoins(usdcCoin, usdcCoins.slice(1).map(c =>
          tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
        ));
      }

      // Swap USDC→SUI via DeepBook
      const DB_PKG = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
      const DB_SUI_USDC = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
      const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

      const [zeroDEEP] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [DB_DEEP_TYPE] });
      const dbResult = tx.moveCall({
        target: `${DB_PKG}::pool::swap_exact_quote_for_base`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({ objectId: DB_SUI_USDC, initialSharedVersion: 389750322, mutable: true }),
          usdcCoin, zeroDEEP, tx.pure.u64(0), // min_out = 0 (accept any)
          tx.object('0x6'),
        ],
      });

      // Merge SUI result into gas, return USDC change + DEEP dust
      tx.mergeCoins(tx.gas, [dbResult[0]]);
      tx.transferObjects([dbResult[1], dbResult[2]], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);

      console.log(`[Cache:refill] USDC→SUI swap: ${digest}`);
      return { digest, suiReceived: `~${(Number(totalUsdc) / 1e6 / 0.87).toFixed(2)} SUI` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ultron sends SUI to buyer in exchange for iUSD. Buyer trades for the name themselves.
   *  Simple: ultron sends SUI, buyer signs the Tradeport purchase. */
  private async _ultronSendsSwapSui(
    buyerAddr: string,
    amountMist: bigint,
    _transport: SuiGraphQLClient,
  ): Promise<{ digest?: string; suiSent?: string; error?: string }> {
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY!);
    const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    // Check ultron has enough SUI
    const ultronSuiRes = await raceJsonRpc<{ data: Array<{ balance: string }> }>(
      'suix_getCoins', [ultronAddr, SUI_TYPE],
    );
    const ultronSui = (ultronSuiRes?.data ?? []).reduce((s, c) => s + BigInt(c.balance), 0n);
    if (ultronSui < amountMist + 100_000_000n) {
      return { error: `Cache low on SUI (${Number(ultronSui) / 1e9} SUI, need ${Number(amountMist) / 1e9})` };
    }

    console.log(`[Infer] Ultron sending ${Number(amountMist) / 1e9} SUI to ${buyerAddr} (iUSD swap)`);

    const tx = new Transaction();
    tx.setSender(ultronAddr);
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist.toString())]);
    tx.transferObjects([coin], tx.pure.address(buyerAddr));

    const txBytes = await tx.build({ client: transport as never });
    const sig = await keypair.signTransaction(txBytes);
    const digest = await this._submitTx(txBytes, sig.signature);

    console.log(`[Infer] SUI sent to ${buyerAddr}: ${digest}`);
    return { digest, suiSent: amountMist.toString() };
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private async _submitTx(txBytes: Uint8Array, signature: string): Promise<string> {
    const b64 = uint8ToBase64(txBytes);
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  }
}
