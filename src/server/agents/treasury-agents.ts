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

// ─── Types ────────────────────────────────────────────────────────────

// ─── t2000 Agent Registry ─────────────────────────────────────────────

interface T2000Agent {
  designation: string;
  mission: 'arb' | 'sweep' | 'snipe' | 'farm' | 'watch' | 'route' | 'storm';
  objectId: string;        // on-chain T2000 object ID
  dwalletId: string;       // IKA dWallet controlling this agent
  operator: address;
  deployed_ms: number;
  total_profit_mist: string;
  last_run_ms: number;
  runs: number;
  active: boolean;
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

export interface TreasuryAgentsState {
  positions: YieldPosition[];
  arb_history: ArbOpportunity[];
  t2000s: T2000Agent[];
  total_arb_profit_mist: string;
  total_yield_earned_mist: string;
  last_rebalance_ms: number;
  last_sweep_ms: number;
  tick_count: number;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui — autonomous agent keypair
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

    // Initiate — fires all open quests + SOL watcher + Shade deliberation immediately.
    if (url.pathname.endsWith('/initiate') || url.searchParams.has('poke')) {
      const results: Array<{ id: string; status: string; error?: string }> = [];
      // Watch SOL deposits first (may match new deposits)
      await this._watchSolDeposits();
      // Then try filling all open quests
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
      return new Response(JSON.stringify({ initiated: true, results }), { headers: { 'content-type': 'application/json' } });
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
          qr: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&color=ffffff&bgcolor=4da2ff&data=${encodeURIComponent(prismUri)}`,
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

    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      return new Response(JSON.stringify({
        positions: this.state.positions,
        arb_count: this.state.arb_history.length,
        t2000_count: (this.state.t2000s ?? []).filter(a => a.active).length,
        total_arb_profit: this.state.total_arb_profit_mist,
        total_yield_earned: this.state.total_yield_earned_mist,
        last_rebalance: this.state.last_rebalance_ms,
        last_sweep: this.state.last_sweep_ms,
        ticks: this.state.tick_count,
      }), { headers: { 'content-type': 'application/json' } });
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
      // Every tick: scan for arb + run t2000 missions + retry open Quests + watch SOL deposits + deliberate Shades + sweep NS
      await this._scanArb();
      await this._runT2000Missions();
      await this._retryOpenQuests();
      await this._watchSolDeposits();
      await this._deliberateShades();
      await this._sweepNsToIusd();

      // Every 15 min: check yield rotation
      const FIFTEEN_MIN = 15 * 60 * 1000;
      if (now - this.state.last_sweep_ms > FIFTEEN_MIN) {
        await this.sweepDust(); // Convert USDC/DEEP dust → SUI → attest → mint iUSD
        await this.sweepFees(); // Sweep SUI into NAVI lending
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
  async sweepFees(): Promise<{ swept: boolean; amount?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { swept: false };
    }

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const treasuryAddr = keypair.getPublicKey().toSuiAddress();
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check treasury SUI balance
      const balResult = await transport.query({
        query: `query { address(address: "${treasuryAddr}") { balance(type: "${SUI_TYPE}") { totalBalance } } }`,
      });
      const bal = BigInt(
        (balResult.data as any)?.address?.balance?.totalBalance ?? '0',
      );

      // Keep 0.1 SUI for gas, sweep the rest into NAVI lending
      const MIN_KEEP = 100_000_000n; // 0.1 SUI
      if (bal <= MIN_KEEP) return { swept: false };

      const sweepAmount = bal - MIN_KEEP;
      console.log(`[TreasuryAgents] Sweeping ${sweepAmount} MIST into NAVI`);

      // Build deposit-to-NAVI PTB
      const tx = new Transaction();
      tx.setSender(normalizeSuiAddress(treasuryAddr));

      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(sweepAmount)]);

      // Deposit SUI into NAVI lending pool
      tx.moveCall({
        target: `${NAVI.package}::incentive_v3::entry_deposit`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.pure.u8(0), // SUI pool ID
          depositCoin,
          tx.object(NAVI.incentiveV2),
          tx.object(NAVI.incentiveV3),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, signature);

      console.log(`[TreasuryAgents] Swept ${sweepAmount} MIST to NAVI: ${digest}`);

      this.setState({
        ...this.state,
        last_sweep_ms: Date.now(),
      });

      return { swept: true, amount: String(sweepAmount) };
    } catch (err) {
      console.error('[TreasuryAgents] Sweep error:', err);
      return { swept: false };
    }
  }

  // ─── Dust Sweep (recursive treasury growth) ─────────────────────────
  //
  // Every NS acquisition leaves USDC change, DEEP change, and rounding dust
  // in the ultron wallet. This sweep converts all non-SUI dust → SUI via
  // DeepBook, then attests it as collateral and mints iUSD. The treasury
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
    // TODO: Compare current allocation vs target allocation
    // If drift > 5%, execute rebalancing swaps via DeepBook
    // For now, just update timestamp
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
  }): Promise<{ success: boolean }> {
    const existing = (this.state.t2000s ?? []).find(a => a.objectId === params.objectId);
    if (existing) return { success: false };

    const agent: T2000Agent = {
      ...params,
      deployed_ms: Date.now(),
      total_profit_mist: '0',
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
  async deactivateT2000(params: { objectId: string }): Promise<{ success: boolean }> {
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

  /** Execute missions for all active t2000 agents. Called from _tick(). */
  private async _runT2000Missions() {
    const agents = (this.state.t2000s ?? []).filter(a => a.active);
    if (agents.length === 0) return;

    for (const agent of agents) {
      try {
        let profitMist = 0n;

        switch (agent.mission) {
          case 'arb':
            // Arb agents run the same scanner but track profit per-agent
            await this._scanArb();
            break;

          case 'sweep':
            // Sweep agents run fee collection
            const sweepResult = await this.sweepFees();
            if (sweepResult.swept && sweepResult.amount) {
              profitMist = BigInt(sweepResult.amount) / 100n; // attribute 1% as agent profit
            }
            break;

          case 'farm':
            // Farm agents are the yield rotator
            // Profit attributed from yield earned since last run
            break;

          case 'watch':
            // Liquidation monitor — scans health factors
            // TODO: implement liquidation scanning + execution
            break;

          case 'route':
            // Maker bot — places resting limit orders on DeepBook
            // TODO: implement maker order placement
            break;

          case 'storm':
            // Thunder Storm agent — sweeps storms, manages thunder counts
            // TODO: implement storm sweep scheduling
            break;

          case 'snipe':
            // Shade sniper — handled by ShadeExecutorAgent
            break;
        }

        // Update agent stats
        this.setState({
          ...this.state,
          t2000s: (this.state.t2000s ?? []).map(a => {
            if (a.objectId !== agent.objectId) return a;
            return {
              ...a,
              last_run_ms: Date.now(),
              runs: a.runs + 1,
              total_profit_mist: String(BigInt(a.total_profit_mist) + profitMist),
            };
          }),
        });

        // Report profit on-chain if significant (>0.01 SUI)
        if (profitMist > 10_000_000n && this.env.SHADE_KEEPER_PRIVATE_KEY) {
          try {
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
            const ultronAddr = keypair.getPublicKey().toSuiAddress();
            const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
            const T2000_PKG = '0x3e708a6e1dfd6f96b54e0145613d505e508577df4a80aa5523caf380abba5e33';

            const tx = new Transaction();
            tx.setSender(normalizeSuiAddress(ultronAddr));
            tx.moveCall({
              package: T2000_PKG,
              module: 't2000',
              function: 'report_mission',
              arguments: [
                tx.object(agent.objectId),
                tx.pure.vector('u8', Array.from(new TextEncoder().encode(agent.mission))),
                tx.pure.u64(profitMist),
                tx.object('0x6'),
              ],
            });

            const txBytes = await tx.build({ client: transport as never });
            const { signature } = await keypair.signTransaction(txBytes);
            await this._submitTx(txBytes, signature);
            console.log(`[TreasuryAgents] t2000 ${agent.designation}: reported ${profitMist} MIST profit`);
          } catch (err) {
            console.error(`[TreasuryAgents] t2000 ${agent.designation}: report_mission failed:`, err);
          }
        }
      } catch (err) {
        console.error(`[TreasuryAgents] t2000 ${agent.designation} mission failed:`, err);
      }
    }
  }

  // ─── IKA DKG (emergency provisioning) ────────────────────────────────

  /** Request a DKG session. The DO can't run WASM but can build the PTB.
   *  Returns the unsigned transaction bytes — the caller (browser or ultron)
   *  must sign and execute. If ultron key is available, signs server-side. */
  @callable()
  async requestDKG(params: {
    curve: 'secp256k1' | 'ed25519';
    userAddress: string;
  }): Promise<{ txBytes?: string; digest?: string; error?: string }> {
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
  async setThunderFee(params: { feeMist: number }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No ultron key' };
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
  async attestCollateral(params: { collateralValueMist: string }): Promise<{ digest?: string; error?: string }> {
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
  }): Promise<{ digest1?: string; digest2?: string; minted?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { error: 'No ultron key configured' };
    }

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
    const pending = intents.filter(i => i.status === 'pending');
    if (pending.length === 0) return;

    const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
    const solAddr = toBase58(keypair.getPublicKey().toRawBytes());

    // Fetch recent Solana transactions to ultron's address
    const SOL_RPCS = [
      'https://mainnet.helius-rpc.com/?api-key=1d8740dc-e5f4-421c-b823-e1bad1889eff',
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

  // ─── iUSD Purchase Route (ultron acquires NS for user) ──────────────

  private static readonly DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
  private static readonly DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  private static readonly DB_IUSD_USDC_POOL = ''; // TODO: set after pool creation
  private static readonly DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 0;
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
  }): Promise<{ digest?: string; nsDigest?: string; error?: string }> {
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
      // Route: SUI → USDC (DeepBook) → NS (DeepBook) → transfer to user
      // iUSD minted above is the accounting layer; the actual swap uses ultron's SUI
      // When iUSD/USDC pool is live, we'll route iUSD → USDC → NS instead
      const suiForNs = BigInt(collateralValueMist); // Use the collateral SUI amount
      const tx3 = new Transaction();
      tx3.setSender(ultronAddr);

      // SUI → USDC via DeepBook
      const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
      const DB_SUI_USDC_POOL_ISV = 389750322;
      const [suiPayment] = tx3.splitCoins(tx3.gas, [tx3.pure.u64(suiForNs)]);
      const [zeroDEEP1] = tx3.moveCall({ target: '0x2::coin::zero', typeArguments: [TreasuryAgents.DB_DEEP_TYPE] });
      const [suiChange, usdcOut, deepChange1] = tx3.moveCall({
        target: `${TreasuryAgents.DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: ['0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', TreasuryAgents.USDC_TYPE],
        arguments: [
          tx3.sharedObjectRef({ objectId: DB_SUI_USDC_POOL, initialSharedVersion: DB_SUI_USDC_POOL_ISV, mutable: true }),
          suiPayment, zeroDEEP1, tx3.pure.u64(0), tx3.object.clock(),
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

      // Send NS to user, keep everything else (SUI change + USDC dust + DEEP change)
      tx3.transferObjects([nsCoin], tx3.pure.address(normalizeSuiAddress(recipient)));
      tx3.transferObjects([suiChange, usdcChange, deepChange1, deepChange2], tx3.pure.address(ultronAddr));

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
  async swapSuiForDeep(params?: { amountMist?: string }): Promise<{ digest?: string; deepAcquired?: string; error?: string }> {
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
  async createIusdUsdcPool(): Promise<{ digest?: string; error?: string }> {
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
      const deepCoinsRes = await transport.query({
        query: `query {
          address(address: "${ultronAddr}") {
            coins(type: "${TreasuryAgents.DB_DEEP_TYPE}") {
              nodes {
                address
                version
                digest
                contents { json }
              }
            }
          }
        }`,
      });
      const deepCoins = (deepCoinsRes.data as any)?.address?.coins?.nodes ?? [];
      if (!deepCoins.length) {
        return { error: 'No DEEP coin objects found despite balance check passing' };
      }

      const tx = new Transaction();
      tx.setSender(ultronAddr);

      // Build DEEP coin: merge all DEEP coins into one, then split exact fee
      const deepRefs = deepCoins.map((c: any) => ({
        objectId: c.address,
        version: String(c.version),
        digest: c.digest,
      }));

      const primaryDeep = tx.objectRef(deepRefs[0]);
      if (deepRefs.length > 1) {
        tx.mergeCoins(primaryDeep, deepRefs.slice(1).map((r: any) => tx.objectRef(r)));
      }

      // Split exactly 500 DEEP for the creation fee
      const [feeCoin] = tx.splitCoins(primaryDeep, [tx.pure.u64(TreasuryAgents.POOL_CREATION_FEE)]);

      // Create the permissionless pool
      tx.moveCall({
        package: TreasuryAgents.DB_PACKAGE,
        module: 'pool',
        function: 'create_permissionless_pool',
        typeArguments: [TreasuryAgents.IUSD_TYPE, TreasuryAgents.USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: TreasuryAgents.DB_REGISTRY,
            initialSharedVersion: 0,
            mutable: true,
          }),
          tx.pure.u64(1000),              // tick_size (0.001 USDC per tick)
          tx.pure.u64(1_000_000_000),     // lot_size (1.0 iUSD at 9 decimals)
          tx.pure.u64(1_000_000_000),     // min_size (1.0 iUSD minimum)
          feeCoin,                         // creation_fee: Coin<DEEP>
          tx.object('0x6'),               // clock
        ],
      });

      // Return leftover DEEP to ultron
      tx.transferObjects([primaryDeep], tx.pure.address(ultronAddr));

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] iUSD/USDC DeepBook pool created: ${digest}`);
      // TODO: Parse transaction effects to extract the new pool object ID
      // and update DB_IUSD_USDC_POOL + DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION
      return { digest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] createIusdUsdcPool error:', errStr);
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
  async rumbleUltron(): Promise<{
    ultronAddress: string;
    btcAddress: string;
    ethAddress: string;
    solAddress: string;
    addresses: Array<{ chain: string; name: string; address: string }>;
    dwalletCaps: string[];
    needsDkg: { secp256k1: boolean; ed25519: boolean };
    error?: string;
  }> {
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

  // ─── Internal ───────────────────────────────────────────────────────

  private async _submitTx(txBytes: Uint8Array, signature: string): Promise<string> {
    const b64 = uint8ToBase64(txBytes);
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  }
}
