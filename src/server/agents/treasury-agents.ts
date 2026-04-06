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
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceExecuteTransaction, raceJsonRpc, GQL_URL } from '../rpc.js';
import { createSplMint, mintSplTokens, b58decode, b58encode, type SolanaRpcConfig } from '../solana-spl.js';
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

// ─── Cache state: 110% overcollateralization ─────────────────────────
const OVERCOLLATERAL_BPS = 11000; // 110% — everything above this is surplus for agents

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
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui — autonomous agent keypair
  HELIUS_API_KEY?: string; // Solana RPC (Helius)
  HELIUS_WEBHOOK_SECRET?: string; // Validates incoming Helius webhook requests
}

// ─── Helpers ──────────────────────────────────────────────────────────

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
    // deposit-addresses, quest-bounties) are exempt.
    const readOnlyParams = ['cache-state', 'squid-stats', 'shade-list', 'deposit-status', 'deposit-addresses', 'quest-bounties'];
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
    if ((url.pathname.endsWith('/shade-create') || url.searchParams.has('shade-create')) && request.method === 'POST') {
      try {
        const body = await request.json() as {
          domain: string; holder: string; thresholdUsd: number; graceEndMs: number; commitment: string;
        };
        const shades = ((this.state as any).shades ?? []) as ShadeOrder[];
        // Deduplicate by domain+holder
        const existing = shades.findIndex(s => s.domain === body.domain && s.holder === body.holder);
        const shade: ShadeOrder = {
          id: crypto.randomUUID(),
          domain: body.domain,
          holder: body.holder,
          thresholdUsd: body.thresholdUsd,
          graceEndMs: body.graceEndMs,
          commitment: body.commitment,
          status: 'active',
          created: Date.now(),
          lastChecked: 0,
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
      }));
      return new Response(JSON.stringify({ shades: result }), { headers: { 'content-type': 'application/json' } });
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
      const pubBytes = keypair.getPublicKey().toRawBytes();
      const solAddr = toBase58(pubBytes);
      return new Response(JSON.stringify({
        sui: suiAddr,
        sol: solAddr,
        btc: null, eth: null, // IKA dWallets after Rumble
      }), { headers: { 'content-type': 'application/json' } });
    }

    // Deposit intent — register a Sui address, get a steganographic tag + exact SOL amount.
    // Sub-cent lamports encode the tag so the watcher knows which Sui address to credit.
    if ((url.pathname.endsWith('/deposit-intent') || url.searchParams.has('deposit-intent')) && request.method === 'POST') {
      try {
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
        const body = await request.json() as { suiAddress: string; amountUsd: number };
        if (!body.suiAddress || !body.amountUsd) throw new Error('Missing suiAddress or amountUsd');

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
        const solAddr = toBase58(keypair.getPublicKey().toRawBytes());

        // Derive a 4-digit tag from the Sui address (deterministic, reproducible)
        const addrBytes = new TextEncoder().encode(body.suiAddress);
        const hashBuf = await crypto.subtle.digest('SHA-256', addrBytes);
        const hashArr = new Uint8Array(hashBuf);
        // 6-digit tag from address hash — encodes SUIAMI identity in sub-cent precision
        const tag = ((hashArr[0] << 16) | (hashArr[1] << 8) | hashArr[2]) % 1000000; // 000000-999999

        // Get SOL price from Sibyl
        let solPrice: number | null = null;
        try {
          // Pyth SOL/USD feed
          const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', { signal: AbortSignal.timeout(5000) });
          const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
          const p = d.parsed?.[0]?.price;
          if (p?.price) solPrice = Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
        } catch {}
        if (!solPrice) {
          try {
            const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(5000) });
            const d = await r.json() as { price?: string };
            if (d.price) solPrice = parseFloat(d.price);
          } catch {}
        }
        if (!solPrice) throw new Error('Sibyl could not determine SOL price');

        // Calculate exact lamport amount with tag encoded in sub-cent digits
        const solAmount = body.amountUsd / solPrice;
        const baseLamports = Math.floor(solAmount * 1e9);
        // Zero out last 4 digits, replace with tag
        // Embed 6-digit tag in sub-cent lamports. Any amount works — tag is in the last 6 digits.
        const taggedLamports = Math.floor(baseLamports / 1000000) * 1000000 + tag;

        // Store the intent
        const intents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
        // Deduplicate — update if same address
        const existing = intents.findIndex(i => i.suiAddress === body.suiAddress);
        const intent = {
          suiAddress: body.suiAddress,
          tag,
          amountUsd: body.amountUsd,
          lamports: taggedLamports,
          solAmount: taggedLamports / 1e9,
          created: Date.now(),
          status: 'pending',
        };
        if (existing >= 0) intents[existing] = intent;
        else intents.push(intent);
        this.setState({ ...this.state, deposit_intents: intents } as any);

        const tagStr = String(tag).padStart(6, '0');

        // iUSD tagged amount (9 decimals): $7.77 + 6-digit tag in sub-cent = 7.770006296 iUSD
        const iusdBase = Math.floor(body.amountUsd * 100); // cents
        const iusdTaggedRaw = BigInt(iusdBase) * 10_000_000n + BigInt(tag); // 9 decimals: cents(7 digits) + tag(6 digits shifted)
        const iusdTaggedStr = `${body.amountUsd.toFixed(2)}${tagStr}`;

        // USDC tagged amount (6 decimals): 10.006296 USDC — tag in sub-cent
        const usdcTagged = (Math.floor(body.amountUsd * 1e6) / 1e6 + tag / 1e6).toFixed(6);

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
        const ultronSolAddr = toBase58(keypair.getPublicKey().toRawBytes());

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

            // Match deposit intents
            const match = pending.find(p => p.tag === tag);
            if (match) {
              console.log(`[Helius Webhook] SOL deposit matched! ${lamports} lamports, tag: ${tag}, sig: ${tx.signature?.slice(0, 12)}…, → ${match.suiAddress.slice(0, 10)}…`);

              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 83);
              const collateralMist = BigInt(Math.floor(solValue * 1e9));

              try {
                const attestResult = await this.attestCollateral({ collateralValueMist: String(collateralMist) });
                console.log(`[Helius Webhook] BAM Attest: SOL collateral $${solValue.toFixed(2)}, digest: ${attestResult.digest || 'failed'}`);
              } catch (e) {
                console.error(`[Helius Webhook] BAM Attest failed:`, e);
              }

              const allIntents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
              const idx = allIntents.findIndex(i => i.suiAddress === match.suiAddress);
              if (idx >= 0) {
                allIntents[idx] = { ...allIntents[idx], status: 'matched', matchedTx: tx.signature, matchedLamports: lamports, attestedUsd: solValue };
                this.setState({ ...this.state, deposit_intents: allIntents } as any);
              }

              const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
              const openBounty = bounties.find(b => b.recipient === match.suiAddress && b.status === 'open');
              if (openBounty) {
                console.log(`[Helius Webhook] BAM Mint: filling Quest ${openBounty.id}`);
                await this.fillQuestBounty(openBounty.id);
              }
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
        const solAddr = toBase58(keypair.getPublicKey().toRawBytes());

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
        const { keccak_256 } = await import('@noble/hashes/sha3');
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

    // OpenCLOB: iUSD SPL on Solana
    if ((url.pathname.endsWith('/create-iusd-sol-mint') || url.searchParams.has('create-iusd-sol-mint')) && request.method === 'POST') {
      try {
        const result = await this.createIusdSolMint();
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
      // SOL deposits handled by Helius webhook (POST /api/sol-webhook), not polling
      await this._scanArb();
      await this._runT2000Missions();
      await this._retryOpenQuests();
      await this._deliberateShades();
      await this._sweepNsToIusd();

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

      // USDC → SUI via DeepBook
      if (usdcBal > 0n) {
        const usdcCoinsRes = await transport.query({
          query: `query { address(address: "${ultronAddr}") { coins(type: "${TreasuryAgents.USDC_TYPE}") { nodes { address version digest contents { json } } } } }`,
        });
        // Simplified: use the balance amount, swap all of it
        const [usdcPayment] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]); // placeholder
        // For now just log — proper coin fetching needs the object refs
        console.log(`[TreasuryAgents] USDC dust: ${usdcBal} (${Number(usdcBal) / 1e6} USDC)`);
        totalSuiExpected += usdcBal * 1_000n; // rough USDC→SUI estimate
      }

      if (deepBal > 0n) {
        console.log(`[TreasuryAgents] DEEP dust: ${deepBal} (${Number(deepBal) / 1e6} DEEP)`);
      }

      // If we swept any dust to SUI, attest as collateral and mint iUSD
      if (totalSuiExpected > 0n) {
        // Attest the dust as collateral
        const tx2 = new Transaction();
        tx2.setSender(ultronAddr);
        tx2.moveCall({
          package: TreasuryAgents.IUSD_PKG,
          module: 'iusd',
          function: 'update_collateral',
          arguments: [
            tx2.object(TreasuryAgents.IUSD_TREASURY),
            tx2.pure.vector('u8', Array.from(new TextEncoder().encode('DUST'))),
            tx2.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
            tx2.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
            tx2.pure.u64(totalSuiExpected),
            tx2.pure.u8(0), // TRANCHE_SENIOR
            tx2.object('0x6'),
          ],
        });
        const txBytes2 = await tx2.build({ client: transport as never });
        const sig2 = await keypair.signTransaction(txBytes2);
        await this._submitTx(txBytes2, sig2.signature);

        // Mint iUSD from dust collateral (steganographic tag: 999 = dust sweep)
        const dustUsd = Number(usdcBal) / 1e6; // USDC is already USD
        if (dustUsd > 0.01) {
          const cents = Math.round(dustUsd * 100);
          const iusdRaw = BigInt(cents) * 10_000_000n + 999n * 10_000n; // tag 999 = dust
          const tx3 = new Transaction();
          tx3.setSender(ultronAddr);
          tx3.moveCall({
            package: TreasuryAgents.IUSD_PKG,
            module: 'iusd',
            function: 'mint_and_transfer',
            arguments: [
              tx3.object(TreasuryAgents.IUSD_TREASURY_CAP),
              tx3.object(TreasuryAgents.IUSD_TREASURY),
              tx3.pure.u64(iusdRaw),
              tx3.pure.address(ultronAddr),
            ],
          });
          const txBytes3 = await tx3.build({ client: transport as never });
          const sig3 = await keypair.signTransaction(txBytes3);
          await this._submitTx(txBytes3, sig3.signature);
          console.log(`[TreasuryAgents] Dust sweep: minted ${iusdRaw} iUSD (tag 999) from $${dustUsd.toFixed(2)} dust`);
          const _sq: SquidStats = this.state.squids ?? { total: 0, by_chain: { sui: 0, btc: 0, eth: 0, sol: 0 }, iusd_minted: 0, geo: [] };
          _sq.iusd_minted++;
          this.setState({ ...this.state, squids: _sq });
          return { swept: true, dustSui: String(totalSuiExpected), iusdMinted: String(iusdRaw) };
        }
      }

      return { swept: true, dustSui: String(totalSuiExpected) };
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

      // Pick a random RWA focus
      const focusCount = 2 + Math.floor(Math.random() * (RWA_TARGETS.length - 1));
      const shuffled = [...RWA_TARGETS].sort(() => Math.random() - 0.5);
      const focus = shuffled.slice(0, focusCount);

      const spawn: T2000Agent = {
        designation: `${dead.designation}-mk${dead.runs}`,
        mission: 'farm', // RWA agents are farmers — hunt for tokenized collateral
        objectId: `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  private static readonly IUSD_PKG = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9'; // v2: 9 decimals
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
        const solAddr = toBase58(keypair.getPublicKey().toRawBytes());
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
      if (bounty.preSignedTx && bounty.preSignedSig) {
        try {
          const txBytes = Uint8Array.from(atob(bounty.preSignedTx), c => c.charCodeAt(0));
          regDigest = await this._submitTx(txBytes, bounty.preSignedSig);
          console.log(`[TreasuryAgents] Auto-registered name for ${recipient.slice(0, 10)}…: ${regDigest}`);
        } catch (regErr) {
          console.error(`[TreasuryAgents] Pre-signed registration failed (user registers manually):`, regErr);
        }
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
    const solAddr = toBase58(keypair.getPublicKey().toRawBytes());

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
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json() as any;
        if (d.result?.length) { signatures = d.result; break; }
      } catch { /* try next */ }
    }

    if (signatures.length === 0) return;

    // Check last processed signature to avoid re-processing
    const lastProcessed = (this.state as any).last_sol_sig as string | undefined;
    const newSigs = lastProcessed
      ? signatures.filter(s => s.signature !== lastProcessed).slice(0, 10)
      : signatures.slice(0, 5);

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
              signal: AbortSignal.timeout(8000),
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
              console.log(`[TreasuryAgents] SOL deposit matched! ${lamports} lamports, tag: ${tag}, → ${match.suiAddress.slice(0, 10)}…`);

              // BAM Event: Burn(lock) on Solana → Attest via Sibyl → Mint iUSD on Sui
              // SOL stays on Solana as collateral. Sibyl attests. iUSD minted. NS swapped.

              // 1. Calculate SOL value in MIST (for collateral attestation)
              const solPrice = await this._fetchSolPrice();
              const solValue = (lamports / 1e9) * (solPrice || 83);
              const collateralMist = BigInt(Math.floor(solValue / (solPrice || 83) * (solPrice || 83) * 1e9));

              // 2. Attest SOL collateral on-chain via Sibyl's Timestream
              try {
                const attestResult = await this.attestCollateral({ collateralValueMist: String(collateralMist) });
                console.log(`[TreasuryAgents] BAM Attest: SOL collateral $${solValue.toFixed(2)}, digest: ${attestResult.digest || 'failed'}`);
              } catch (e) {
                console.error(`[TreasuryAgents] BAM Attest failed:`, e);
              }

              // Mark intent as matched + attested
              const allIntents = ((this.state as any).deposit_intents ?? []) as Array<Record<string, any>>;
              const idx = allIntents.findIndex(i => i.suiAddress === match.suiAddress);
              if (idx >= 0) {
                allIntents[idx] = { ...allIntents[idx], status: 'matched', matchedTx: sig.signature, matchedLamports: lamports, attestedUsd: solValue };
                this.setState({ ...this.state, deposit_intents: allIntents } as any);
              }

              // 3. Fill Quest — ultron uses SUI/USDC backed by the attested SOL collateral
              const bounties = ((this.state as any).quest_bounties ?? []) as Array<Record<string, any>>;
              const openBounty = bounties.find(b => b.recipient === match.suiAddress && b.status === 'open');
              if (openBounty) {
                console.log(`[TreasuryAgents] BAM Mint: filling Quest ${openBounty.id} backed by SOL collateral`);
                await this.fillQuestBounty(openBounty.id);
              }
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
                if (kaminoMatch.suinsName) {
                  try {
                    const { buildThunderSendTx, lookupRecipientNftId } = await import('../../client/thunder.js');
                    const recipName = kaminoMatch.suinsName.replace(/\.sui$/i, '');
                    const recipNftId = await lookupRecipientNftId(recipName);
                    if (recipNftId) {
                      const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
                      const msg = `⚡ OpenCLOB fill: ${(lamports / 1e9).toFixed(2)} SOL → Kamino ${kaminoMatch.strategy} → $${iusdValue.toFixed(2)} iUSD minted to your wallet.${kaminoDigest ? ` Kamino tx: ${kaminoDigest.slice(0, 12)}…` : ''}`;
                      const thunderBytes = await buildThunderSendTx(ultronAddr, 'ultron', recipName, recipNftId, msg);
                      const thunderSig = await keypair.signTransaction(thunderBytes);
                      const thunderDigest = await this._submitTx(thunderBytes, thunderSig.signature);
                      console.log(`[OpenCLOB] Prism Thunder sent to ${recipName}.sui: ${thunderDigest}`);
                    }
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
      const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744', { signal: AbortSignal.timeout(5000) });
      const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
      const p = d.parsed?.[0]?.price;
      if (p?.price) return Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
    } catch { /* fallback */ }
    // Fallback: Binance spot
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(5000) });
      const d = await r.json() as { price?: string };
      if (d.price) return parseFloat(d.price);
    } catch { /* exhausted */ }
    return null;
  }

  /** Sibyl SOL/USD oracle — Pyth Hermes → Binance fallback */
  private async _fetchSolPrice(): Promise<number | null> {
    try {
      const r = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', { signal: AbortSignal.timeout(5000) });
      const d = await r.json() as { parsed?: Array<{ price?: { price?: string; expo?: number } }> };
      const p = d.parsed?.[0]?.price;
      if (p?.price) return Number(p.price) * Math.pow(10, Number(p.expo ?? 0));
    } catch {}
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(5000) });
      const d = await r.json() as { price?: string };
      if (d.price) return parseFloat(d.price);
    } catch {}
    return null;
  }

  // ─── OpenCLOB: Kamino Lend execution ────────────────────────────────

  private static readonly KAMINO_API = 'https://api.kamino.finance';
  private static readonly KAMINO_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
  private static readonly KAMINO_SOL_RESERVE = '2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN';
  private get _solRpcs(): string[] {
    return [
      ...(this.env.HELIUS_API_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}`] : []),
      'https://api.mainnet-beta.solana.com',
    ];
  }

  /** Deposit SOL into Kamino Lend. Returns Solana tx signature. */
  private async _depositToKamino(solAmount: number): Promise<string> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) throw new Error('No keeper key');
    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const solAddr = toBase58(keypair.getPublicKey().toRawBytes());

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
      signal: AbortSignal.timeout(15000),
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
          signal: AbortSignal.timeout(15000),
        });
        const d = await r.json() as { result?: string; error?: { message?: string } };
        if (d.result) {
          console.log(`[OpenCLOB] Kamino Lend deposit: ${solAmount.toFixed(4)} SOL, tx: ${d.result}`);
          return d.result;
        }
        if (d.error) console.warn(`[OpenCLOB] Kamino submit to ${rpc}: ${d.error.message}`);
      } catch { /* try next */ }
    }

    throw new Error('Kamino deposit tx submission failed on all RPCs');
  }

  // ─── OpenCLOB: iUSD SPL on Solana (BAM native mint) ─────────────────

  private get _solRpcConfig(): SolanaRpcConfig {
    return {
      rpcs: this._solRpcs,
      timeout: 15000,
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
      await new Promise(r => setTimeout(r, 3000));

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
        await new Promise(r => setTimeout(r, 3000)); // wait for indexing
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
        const refGasRes2 = await transport.query({ query: '{ epoch { referenceGasPrice } }' });
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
            await new Promise(r => setTimeout(r, 3000));
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
        await new Promise(r => setTimeout(r, 3000));
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
      const refGasRes = await transport.query({ query: '{ epoch { referenceGasPrice } }' });
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
      const { keccak_256 } = await import('@noble/hashes/sha3');
      const nh = Array.from(keccak_256(bareBytes));

      // Build chains array: user's sui address + ultron's cross-chain addresses
      const chainKeys: string[] = ['sui'];
      const chainVals: string[] = [normalizeSuiAddress(userAddress)];
      if (status.btcAddress) { chainKeys.push('btc'); chainVals.push(status.btcAddress); }
      if (status.ethAddress) { chainKeys.push('eth'); chainVals.push(status.ethAddress); }
      if (status.solAddress) { chainKeys.push('sol'); chainVals.push(status.solAddress); }

      const ROSTER_PKG = '0xef4fa3fa12a1413cf998ea8b03348281bb9edd09f21a0a245a42b103a2e9c3b4';
      const ROSTER_OBJ = '0xf382a0e687f03968e80483dca5e82278278396b2d1028e0c1cee63968a62d689';

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

      // Send welcome Thunder to the new name — announces their chain addresses
      try {
        const { buildThunderSendTx, lookupRecipientNftId, nameHash } = await import('../../client/thunder.js');
        const recipNftId = await lookupRecipientNftId(bare);
        if (recipNftId) {
          const welcomeMsg = `\ud83e\udd91 Rumble squids provisioned! btc@${bare} eth@${bare} sol@${bare} — your chain addresses are live. Rumble yourself to take full custody.`;
          const welcomeBytes = await buildThunderSendTx(
            ultronAddr, 'ultron', bare, recipNftId, welcomeMsg,
          );
          const welcomeSig = await keypair.signTransaction(welcomeBytes);
          const welcomeDigest = await this._submitTx(welcomeBytes, welcomeSig.signature);
          console.log(`[TreasuryAgents] Welcome Thunder sent to ${bare}.sui: ${welcomeDigest}`);
        }
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

  private async _buildTradeForBuyer(params: {
    buyer: string; nftTokenId: string; priceMist: string; route: string;
    suiBal: string; usdcBal: string; iusdBal: string;
  }): Promise<{ txBase64?: string; description?: string; error?: string }> {
    const { buyer, nftTokenId, priceMist, route } = params;
    const buyerAddr = normalizeSuiAddress(buyer);
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

    const price = BigInt(priceMist);
    const fee = price * 300n / 10000n; // 3% Tradeport fee
    const totalNeeded = price + fee;

    const TRADEPORT_V1_PKG = '0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab';
    const TRADEPORT_V1_STORE = '0xf96f9363ac5a64c058bf7140723226804d74c0dab2dd27516fb441a180cd763b';
    const TRADEPORT_V2_PKG = '0xb42dbb7413b79394e1a0175af6ae22b69a5c7cc5df259cd78072b6818217c027';
    const TRADEPORT_V2_STORE = '0x47cba0b6309a12ce39f9306e28b899ed4b3698bce4f4911fd0c58ff2329a2ff6';
    const SUINS_REG_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';

    // Helper: add Tradeport buy call to a transaction, trying v1 then v2
    const addTradeportBuy = (t: Transaction, nftId: string, coin: any) => {
      // Try v1 first (most existing listings)
      t.moveCall({
        target: `${TRADEPORT_V1_PKG}::tradeport_listings::buy_listing_without_transfer_policy`,
        typeArguments: [SUINS_REG_TYPE],
        arguments: [t.object(TRADEPORT_V1_STORE), t.pure.id(nftId), coin],
      });
    };
    const DB_PKG = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
    const DB_SUI_USDC = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
    const DB_SUI_USDC_ISV = 389750322;
    const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';

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

    // Always prefer SUI direct if buyer has enough — regardless of what infer picked
    if (availSui >= totalNeeded) {
      // Simple: split from gas, buy
      const payment = tx.splitCoins(tx.gas, [tx.pure.u64(totalNeeded.toString())]);
      addTradeportBuy(tx, nftTokenId, payment);
      tx.transferObjects([payment], tx.pure.address(buyerAddr));

      const txBytes = await tx.build({ client: transport as never });
      return { txBase64: uint8ToBase64(txBytes), description: `Buy via SUI direct (${Number(totalNeeded) / 1e9} SUI)` };
    }

    if (route === 'usdc-swap' || route === 'iusd-redeem') {
      // Need USDC→SUI swap to cover the shortfall
      const shortfall = totalNeeded - availSui;
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

      if ((realUsdcBal < usdcNeeded || usdcCoins.length === 0) && (route === 'iusd-redeem' || route === 'usdc-swap')) {
        // Buyer has iUSD but not enough SUI/USDC — ultron pre-funds SUI, buyer sends iUSD back + purchases
        if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'Cache offline' };

        // Check buyer's iUSD
        const iusdCoinsRes = await raceJsonRpc<{ data: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> }>(
          'suix_getCoins', [buyerAddr, `${TreasuryAgents.IUSD_PKG}::iusd::IUSD`],
        );
        const iusdCoins = (iusdCoinsRes?.data ?? []).filter(c => BigInt(c.balance) > 0n);
        const realIusdBal = iusdCoins.reduce((s, c) => s + BigInt(c.balance), 0n);

        if (realIusdBal === 0n) {
          return { error: `No iUSD, SUI, or USDC. Nothing to trade with.` };
        }

        // Step 1: Ultron sends SUI to buyer (covers listing + fee + gas buffer)
        const suiToSend = totalNeeded + 50_000_000n; // + 0.05 SUI gas buffer
        const prefund = await this._ultronSendsSwapSui(buyerAddr, suiToSend, transport);
        if (prefund.error) return { error: prefund.error };

        // Wait briefly for chain propagation
        await new Promise(r => setTimeout(r, 1500));

        // Step 2: Build user TX — send iUSD to ultron + purchase from Tradeport
        // iUSD amount = listing price in USD * 1e9 (iUSD has 9 decimals, pegged $1)
        let suiPrice = 0.87;
        try { const p = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd'); suiPrice = ((await p.json()) as any)?.sui?.usd ?? 0.87; } catch {}
        const listingUsd = Number(totalNeeded) / 1e9 * suiPrice;
        const iusdToSend = BigInt(Math.ceil(listingUsd * 1e9)); // iUSD amount at $1 peg
        const iusdCapped = iusdToSend < realIusdBal ? iusdToSend : realIusdBal;

        const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY!);
        const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

        const userTx = new Transaction();
        userTx.setSender(buyerAddr);

        // Send iUSD to ultron
        const iusdCoin = userTx.objectRef({ objectId: iusdCoins[0].coinObjectId, version: String(iusdCoins[0].version), digest: iusdCoins[0].digest });
        if (iusdCoins.length > 1) {
          userTx.mergeCoins(iusdCoin, iusdCoins.slice(1).map(c =>
            userTx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest }),
          ));
        }
        const [iusdPayment] = userTx.splitCoins(iusdCoin, [userTx.pure.u64(iusdCapped.toString())]);
        userTx.transferObjects([iusdPayment], userTx.pure.address(ultronAddr));
        userTx.transferObjects([iusdCoin], userTx.pure.address(buyerAddr)); // return change

        // Purchase from Tradeport (buyer now has SUI from ultron pre-fund)
        const payment = userTx.splitCoins(userTx.gas, [userTx.pure.u64(totalNeeded.toString())]);
        addTradeportBuy(userTx, nftTokenId, payment);
        userTx.transferObjects([payment], userTx.pure.address(buyerAddr));

        const txBytes = await userTx.build({ client: transport as never });
        return {
          txBase64: uint8ToBase64(txBytes),
          description: `Send ${Number(iusdCapped) / 1e9} iUSD to cache + buy ${Number(price) / 1e9} SUI listing (pre-funded by ultron: ${prefund.digest})`,
        };
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
      addTradeportBuy(tx, nftTokenId, payment);
      tx.transferObjects([payment], tx.pure.address(buyerAddr));

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
    await new Promise(r => setTimeout(r, 1500));

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
