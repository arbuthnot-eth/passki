import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceJsonRpc } from './rpc.js';
// ika-provision.ts is available for server-side DKG if needed in future,
// but DKG WASM must run client-side (browser) — Workers can't run it.

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TreasuryAgents: DurableObjectNamespace;
  Chronicom: DurableObjectNamespace;
  TimestreamAgent: DurableObjectNamespace;
  NameIndex: DurableObjectNamespace;
  Pokedex: DurableObjectNamespace;
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui signing key
  HELIUS_API_KEY?: string; // Solana RPC (Helius)
  HELIUS_WEBHOOK_SECRET?: string; // Validates incoming Helius webhook requests
}

const app = new Hono<{ Bindings: Env }>();

// ── Rate limiting middleware ────────────────────────────────────────────
// Simple per-IP sliding window. Uses in-memory Map (resets on cold start).
// Sufficient for edge abuse prevention; not a substitute for CF Rate Limiting rules.
const _rateCounters = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_DEFAULT = 240; // 240 req/min per IP (4/s steady)
const RATE_LIMIT_WRITE = 120;   // 120 req/min for mutating endpoints
// Timestream storm routes (thunder send/fetch/delete/purge-all) are
// exempt from the write limiter entirely — they're pure user data
// flowing through the DO which enforces its own per-participant auth,
// and bulk operations like strike/purge can legitimately burst past
// the generic write cap in a single user gesture.
const RATE_LIMIT_EXEMPT_PREFIXES = ['/api/timestream/'];

app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (RATE_LIMIT_EXEMPT_PREFIXES.some(p => path.startsWith(p))) {
    return next();
  }
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const isWrite = c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'DELETE';
  const limit = isWrite ? RATE_LIMIT_WRITE : RATE_LIMIT_DEFAULT;
  const key = `${ip}:${isWrite ? 'w' : 'r'}`;

  const now = Date.now();
  let entry = _rateCounters.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _rateCounters.set(key, entry);
  }

  entry.count++;
  if (entry.count > limit) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  // Prune stale entries periodically (every 100 requests)
  if (entry.count === 1 && _rateCounters.size > 10000) {
    for (const [k, v] of _rateCounters) {
      if (now > v.resetAt) _rateCounters.delete(k);
    }
  }

  return next();
});

// ── Admin route auth gate ──────────────────────────────────────────────
// Ultron-only routes require x-treasury-auth header matching the keeper-derived token.
// This prevents external callers from triggering treasury operations directly.
// Admin-only: treasury management, minting, pool creation, ultron operations.
// User-facing routes (/api/sponsor-gas, /api/iusd/swap, /api/infer, etc.) are NOT gated.
const ADMIN_ROUTES = [
  '/api/cache/start', '/api/cache/yield-rotate', '/api/cache/sweep-fees', '/api/cache/refill-sui',
  '/api/iusd/attest', '/api/iusd/mint',
  '/api/thunder/set-fee', '/api/swap-sui-for-deep', '/api/rumble-ultron',
  '/api/create-iusd-pool', '/api/seed-iusd-pool',
  '/api/create-iusd-sol-mint', '/api/bam-mint-iusd-sol',
  '/api/lend-usdc', '/api/kamino-deposit', '/api/migrate',
];
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (ADMIN_ROUTES.includes(path)) {
    const auth = c.req.header('x-treasury-auth') || c.req.header('authorization')?.replace('Bearer ', '');
    const expected = getTreasuryAuth(c.env);
    if (!expected || auth !== expected) {
      return c.json({ error: 'Unauthorized — admin route requires x-treasury-auth' }, 403);
    }
  }
  return next();
});

// ── Security headers middleware ─────────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  // Skip WebSocket upgrades and agent routes (handled by agents middleware)
  if (c.req.header('upgrade') === 'websocket') return;
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Permissions-Policy', 'clipboard-read=()'); // block clipboard read prompts (WalletConnect w3m-input-address)
  // CSP: allow self + Sui RPCs + Walrus + CDN for /squids marked page
  c.header('Content-Security-Policy', [
    "default-src 'self'",
    // Inline script in index.html for shell restore — nonce would be ideal but
    // requires templating; unsafe-inline scoped to script-src is the pragmatic
    // first step (still blocks eval, data: URIs, and remote script injection).
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://*.sui.io https://sui-rpc.publicnode.com https://rpc.ankr.com https://*.blockvision.org https://*.walrus.space https://aggregator.walrus-testnet.walrus.space https://fpcdn.io https://api.fpjs.io",
    "frame-ancestors 'self' https://*.sui.ski",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
});

/** Get the singleton TreasuryAgents DO stub. */
const treasuryStub = (c: { env: Env }) => {
  return c.env.TreasuryAgents.get(c.env.TreasuryAgents.idFromName('treasury'));
};

/**
 * Derive the internal auth token for TreasuryAgents requests.
 * Token = first 34 chars (0x + 32 hex) of ultron's derived Sui address.
 * Returns empty string if no keeper key configured.
 */
let _treasuryAuthCache: string | null = null;
function getTreasuryAuth(env: Env): string {
  if (_treasuryAuthCache !== null) return _treasuryAuthCache;
  if (!env.SHADE_KEEPER_PRIVATE_KEY) { _treasuryAuthCache = ''; return ''; }
  const kp = Ed25519Keypair.fromSecretKey(env.SHADE_KEEPER_PRIVATE_KEY);
  _treasuryAuthCache = normalizeSuiAddress(kp.getPublicKey().toSuiAddress()).slice(0, 34);
  return _treasuryAuthCache;
}

/**
 * Auth-wrapping proxy for the treasury DO stub.
 * Returns an object with a .fetch() that auto-injects x-treasury-auth.
 */
function authedTreasuryStub(c: { env: Env }) {
  const stub = treasuryStub(c);
  const auth = getTreasuryAuth(c.env);
  return {
    fetch(req: Request) {
      const headers = new Headers(req.headers);
      headers.set('x-treasury-auth', auth);
      if (!headers.has('x-partykit-room')) headers.set('x-partykit-room', 'treasury');
      return stub.fetch(new Request(req.url, {
        method: req.method,
        headers,
        body: req.body,
      }));
    },
  };
}

// hb.sui.ski should be handled by Hayabusa Worker — return 404 with CORS if it reaches here
app.use('*', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (host === 'hb.sui.ski') {
    return new Response('', {
      status: 404,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' },
    });
  }
  return next();
});

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// Test: can IKA WASM run in CF Workers?
app.get('/api/test-ika-wasm', async (c) => {
  const { testIkaWasm } = await import('./test-ika-wasm.js');
  const result = await testIkaWasm();
  return c.json(result);
});

// ── Squids spec (Walrus-hosted markdown, edge-cached) ──
const SQUIDS_BLOB = 'Cplsr0QVx14gd7bkdBW2zSyCCdz0TmXKlMfTDOm9L50';
app.get('/squids', async (c) => {
  // Serve from CF edge cache — Walrus fetch only on cache miss
  // Version in cache key — bump to bust cache on content changes
  const cacheKey = new Request('https://sui.ski/squids?v=2');
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const md = await fetch(`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${SQUIDS_BLOB}`).then(r => r.text());
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rumble Your Squids — Keyless IKA-Native Agents</title>
<meta property="og:title" content="Rumble Your Squids — Keyless IKA-Native Agents">
<meta property="og:description" content="Zero private keys on Cloudflare Workers. Agents sign via IKA 2PC-MPC. Cross-chain DeFi from the edge.">
<meta property="og:url" content="https://sui.ski/squids">
<meta property="og:site_name" content="sui.ski">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-dark.min.css">
<style>body{background:#0d1117;padding:2rem;display:flex;justify-content:center}.markdown-body{max-width:900px;width:100%;padding:2rem}</style>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
</head><body>
<article class="markdown-body" id="content"></article>
<script>document.getElementById('content').innerHTML=marked.parse(${JSON.stringify(md)});<\/script>
<script src="/dist/embed.js"><\/script>
</body></html>`;
  const res = new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

// Superteam routes removed

// ── JSON-RPC proxy (same-origin, avoids CORS for browser-side IKA SDK) ──
// Forwards to multiple Sui fullnodes with fallback.
const SUI_RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io:443',
];
app.post('/api/rpc', async (c) => {
  const body = await c.req.text();
  for (const url of SUI_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      // Accept any response that has JSON content (even non-200)
      const json = await res.text();
      if (json && json.startsWith('{')) {
        return c.text(json, 200, { 'content-type': 'application/json' });
      }
    } catch {}
  }
  return c.json({ error: 'All RPC endpoints failed' }, 502);
});

// ── Shade monitoring & manual poke ──────────────────────────────────

app.get('/api/shade/poke/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const shadeStub = c.env.ShadeExecutorAgent.get(c.env.ShadeExecutorAgent.idFromName(address));
    const res = await shadeStub.fetch(new Request('https://shade-do/?poke=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get('/api/shade/status/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const shadeStub = c.env.ShadeExecutorAgent.get(c.env.ShadeExecutorAgent.idFromName(address));
    const res = await shadeStub.fetch(new Request('https://shade-do/?status=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Schedule a shade order for auto-execution via HTTP POST
app.post('/api/shade/schedule/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const params = await c.req.json();
    const shadeStub = c.env.ShadeExecutorAgent.get(c.env.ShadeExecutorAgent.idFromName(address));
    const res = await shadeStub.fetch(new Request('https://shade-do/?schedule=1', {
      method: 'POST',
      headers: {
        'x-partykit-room': address,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── SuiNS ownership gate ────────────────────────────────────────────

const SUINS_REGISTRATION_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';
const SUINS_GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** Check if an address owns at least one SuiNS registration NFT. */
async function hasSuinsNft(address: string): Promise<boolean> {
  try {
    const res = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner:SuiAddress!,$type:String!){
          address(address:$owner){
            objects(filter:{type:$type},first:1){
              nodes{ address }
            }
          }
        }`,
        variables: { owner: address, type: SUINS_REGISTRATION_TYPE },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: unknown[] } } };
    };
    return (json?.data?.address?.objects?.nodes?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── Gas sponsorship via ultron ─────────────────────────────────

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * POST /api/sponsor-gas
 * Body: { txBytes: string, senderAddress?: string } (base64-encoded transaction bytes)
 * Returns: { sponsorSig: string, sponsorAddress: string }
 *
 * Signs the transaction as gas sponsor using the ultron keypair.
 * The client must have built the tx with setGasOwner(sponsorAddress)
 * and setGasPayment pointing to ultron's SUI coins.
 *
 * When senderAddress is provided, requires the sender to own a SuiNS
 * registration NFT (403 if not).
 */
// Proxy JSON-RPC to PublicNode (avoids CORS from browser)
app.post('/api/sui-rpc', async (c) => {
  const body = await c.req.text();
  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sponsor-gas', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const { txBytes, senderAddress } = await c.req.json<{ txBytes: string; senderAddress?: string }>();
    if (!txBytes) return c.json({ error: 'Missing txBytes' }, 400);

    // SuiNS gate: require sender to own a SuiNS registration NFT
    if (senderAddress) {
      const hasNft = await hasSuinsNft(senderAddress);
      if (!hasNft) return c.json({ error: 'SuiNS name required for gas sponsorship' }, 403);
    }

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const bytes = Uint8Array.from(atob(txBytes), ch => ch.charCodeAt(0));
    const { signature } = await keypair.signTransaction(bytes);

    return c.json({ sponsorSig: signature, sponsorAddress: keypair.toSuiAddress() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

/**
 * GET /api/sponsor-info
 * Returns ultron's address and gas coins so clients can build sponsored txs.
 */
app.get('/api/sponsor-info', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const keypair = Ed25519Keypair.fromSecretKey(key);
    const sponsorAddress = keypair.toSuiAddress();

    // Fetch gas coins via GraphQL
    const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            coins(type:"0x2::sui::SUI",first:5){
              nodes{ address version digest contents { json } }
            }
          }
        }`,
        variables: { a: sponsorAddress },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { coins?: { nodes?: Array<{ address: string; version: number; digest: string }> } } };
    };
    const nodes = json?.data?.address?.coins?.nodes ?? [];
    const gasCoins = nodes.map((n) => ({
      objectId: n.address,
      version: String(n.version),
      digest: n.digest,
    }));

    return c.json({ sponsorAddress, gasCoins });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA token funding (ultron → user) ────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const IKA_COIN_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const IKA_FUND_AMOUNT = 5_000_000_000n; // 5 IKA (9 decimals)

// ── SUI gas drip (ultron → user) for WaaP thunder claims ──────────────
// WaaP's signTransaction is broken (iframe re-serializes bytes), so the
// dual-sig sponsor flow can't work there. Workaround: drip just enough
// SUI to the user so they can pay gas themselves via signAndExecute.
// Gate: only drip if the user has < DRIP_MIN_MIST SUI, and only once
// per MIN_INTERVAL_MS per address. Fixed amount per drip.
const GAS_DRIP_MIST     = 20_000_000n; // 0.02 SUI ≈ 160 claim txs worth
const GAS_DRIP_MIN_MIST = 15_000_000n; // drip only if below this
// 60 s is enough to prevent drip spam but short enough that
// legitimate retries (sweep attempts, failed gas estimates) don't
// get stuck behind a cooldown wall. Was 60 min which left users
// unable to re-drip when a previous drip coin got spent elsewhere.
const GAS_DRIP_COOLDOWN_MS = 60 * 1000;
const _gasDripLog = new Map<string, number>(); // addr → last drip ts

app.post('/api/fund-gas', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);
  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address || !/^0x[0-9a-fA-F]{64}$/.test(address)) {
      return c.json({ error: 'Invalid address' }, 400);
    }
    const addrLower = address.toLowerCase();

    // Cooldown check
    const last = _gasDripLog.get(addrLower) ?? 0;
    if (Date.now() - last < GAS_DRIP_COOLDOWN_MS) {
      return c.json({ error: 'Cooldown — try again later', retryAfterMs: GAS_DRIP_COOLDOWN_MS - (Date.now() - last) }, 429);
    }

    // Balance check — skip drip if user already has enough gas
    const balRes = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            balance(coinType:"0x2::sui::SUI"){ totalBalance }
          }
        }`,
        variables: { a: address },
      }),
    });
    const balJson = await balRes.json() as { data?: { address?: { balance?: { totalBalance?: string } } } };
    const userBalance = BigInt(balJson?.data?.address?.balance?.totalBalance ?? '0');
    if (userBalance >= GAS_DRIP_MIN_MIST) {
      return c.json({ success: true, skipped: true, reason: 'already has gas', balance: userBalance.toString() });
    }

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Build via a real SuiGraphQLClient and pin ultron's explicit
    // gas coin. A stub `{ url }` client throws
    // 'Cannot read properties of undefined (getCurrentSystemState)'
    // at tx.build time because the v2 build path calls client.core
    // for gas-price discovery.
    const graphql = new SuiGraphQLClient({ url: SUINS_GQL_URL, network: 'mainnet' });
    const ultronCoinsRes = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            objects(filter:{ type: "0x2::coin::Coin<0x2::sui::SUI>" }, first: 5) {
              nodes { address version digest contents { json } }
            }
          }
        }`,
        variables: { a: ultronAddress },
      }),
    });
    const ultronCoinsJson = await ultronCoinsRes.json() as {
      data?: { address?: { objects?: { nodes?: Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }> } } };
    };
    const ultronCoins = (ultronCoinsJson?.data?.address?.objects?.nodes ?? [])
      .map(n => ({
        objectId: n.address,
        version: n.version,
        digest: n.digest,
        balance: BigInt(n.contents?.json?.balance ?? '0'),
      }))
      .filter(cc => cc.balance > 0n)
      .sort((a, b) => (a.balance > b.balance ? -1 : 1));
    if (ultronCoins.length === 0) {
      return c.json({ error: 'Ultron has no SUI to drip' }, 503);
    }

    const tx = new Transaction();
    tx.setSender(ultronAddress);
    tx.setGasPayment([{
      objectId: ultronCoins[0].objectId,
      version: ultronCoins[0].version,
      digest: ultronCoins[0].digest,
    }]);
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(GAS_DRIP_MIST.toString())]);
    tx.transferObjects([coin], tx.pure.address(address));

    const txBytes = await tx.build({ client: graphql as never });
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));

    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as { result?: { digest?: string }; error?: unknown };
    const digest = submitJson?.result?.digest;
    if (!digest) return c.json({ error: 'Drip failed', detail: submitJson?.error }, 500);

    _gasDripLog.set(addrLower, Date.now());
    return c.json({ success: true, digest, amountMist: GAS_DRIP_MIST.toString() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

/**
 * POST /api/ika/fund
 * Body: { address: string }
 *
 * Transfers a small amount of IKA from ultron to the user.
 * SuiNS-gated. Called before DKG so the user has IKA for the DKG fee.
 * Ultron signs and submits directly (no user signature needed).
 */
app.post('/api/ika/fund', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Find ultron's IKA coin
    const coinRes = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){
          address(address:$a){
            objects(filter:{type:$t},first:1){
              nodes{ address version digest contents { json } }
            }
          }
        }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${IKA_COIN_TYPE}>` },
      }),
    });
    const coinJson = await coinRes.json() as any;
    const ikaCoinObj = coinJson?.data?.address?.objects?.nodes?.[0];
    if (!ikaCoinObj) return c.json({ error: 'Ultron has no IKA' }, 503);

    // Build tx: split IKA and transfer to user
    const tx = new Transaction();
    tx.setSender(ultronAddress);
    const ikaSplit = tx.splitCoins(tx.object(ikaCoinObj.address), [tx.pure.u64(IKA_FUND_AMOUNT.toString())]);
    tx.transferObjects([ikaSplit], tx.pure.address(address));

    // Sign and submit via RPC
    const txBytes = await tx.build({ client: { url: SUI_RPC_URLS[0] } as any });

    // Use JSON-RPC for submission since we're server-side
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));

    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as any;
    const digest = submitJson?.result?.digest;

    if (!digest) return c.json({ error: 'Fund tx failed', detail: submitJson?.error }, 500);
    return c.json({ success: true, digest });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA dWallet creation (ultron-submitted, for WaaP) ────────────────

/**
 * POST /api/ika/create
 * Body: { address, authSignature, authBytes, dkgData }
 *
 * WaaP path: user can't sign transactions, so ultron submits the DKG tx.
 * The user proves intent via signPersonalMessage (authSignature).
 * Browser runs WASM prepareDKGAsync and sends the results as dkgData.
 * Ultron builds + signs + submits the tx, transfers DWalletCap to user.
 *
 * Uses requestDWalletDKGWithPublicUserShare (shared dWallet).
 */
app.post('/api/ika/create', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address, authSignature, dkgData } = await c.req.json<{
      address: string;
      authSignature: string;
      dkgData: {
        userDKGMessage: number[];
        userSecretKeyShare: number[];
        userPublicOutput: number[];
        sessionIdentifier: number[];
        encryptionKeyBytes: number[];
        signingPublicKeyBytes: number[];
        encryptionKeySignature: number[];
        curve: number;
      };
    }>();
    if (!address || !authSignature || !dkgData) return c.json({ error: 'Missing params' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    // TODO: verify authSignature matches address (cryptographic proof of intent)

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Fetch ultron's coins
    const GQL = 'https://graphql.mainnet.sui.io/graphql';
    const IKA_COIN_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

    const coinQuery = (coinType: string, limit: number) => fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){ address(address:$a){ objects(filter:{type:$t},first:${limit}){ nodes{ address version digest } } } }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${coinType}>` },
      }),
    }).then(r => r.json()) as Promise<any>;

    const [suiRes, ikaRes] = await Promise.all([
      coinQuery('0x2::sui::SUI', 5),
      coinQuery(IKA_COIN_TYPE, 3),
    ]);
    const mapCoins = (res: any) => (res?.data?.address?.objects?.nodes ?? []).map((n: any) => ({
      objectId: n.address, version: String(n.version), digest: n.digest,
    }));
    const suiCoins = mapCoins(suiRes);
    const ikaCoins = mapCoins(ikaRes);

    if (!suiCoins.length) return c.json({ error: 'Ultron has no SUI' }, 503);
    if (!ikaCoins.length) return c.json({ error: 'Ultron has no IKA' }, 503);

    // Build the DKG transaction — ultron is sender
    const tx = new Transaction();
    tx.setSender(ultronAddress);
    tx.setGasPayment(suiCoins.slice(0, 3));

    const ikaCoin = tx.object(ikaCoins[0].objectId);
    const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]);

    // IKA package constants
    const IKA_CONFIG = {
      packages: {
        ikaDwallet2pcMpcPackage: '0x23b5bd96051923f800c3a2150aacdcdd8d39e1df2dce4dac69a00d2d8c7f7e77',
      },
    };
    const COORDINATOR_ID = '0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3';

    const { bcs } = await import('@mysten/sui/bcs');
    const coordRef = tx.sharedObjectRef({ objectId: COORDINATOR_ID, initialSharedVersion: 595876492, mutable: true });

    // Register encryption key
    tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::register_encryption_key`,
      arguments: [
        coordRef,
        tx.pure.u32(dkgData.curve),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.encryptionKeyBytes))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.encryptionKeySignature))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.signingPublicKeyBytes))),
      ],
    });

    // Register session identifier
    const [sessionId] = tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::register_session_identifier`,
      arguments: [
        coordRef,
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.sessionIdentifier))),
      ],
    });

    // Fetch latest encryption key ID from coordinator
    const encKeyRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getDynamicFields',
        params: [COORDINATOR_ID, null, 1],
      }),
    });
    const encKeyJson = await encKeyRes.json() as any;
    const encKeyObjId = encKeyJson?.result?.data?.[0]?.objectId;
    if (!encKeyObjId) return c.json({ error: 'Could not find encryption key on coordinator' }, 500);

    // Build Option::none for signDuringDKGRequest
    const [noneOpt] = tx.moveCall({
      target: '0x1::option::none',
      typeArguments: [`${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator_inner::SignDuringDKGRequest`],
    });

    // Request shared dWallet DKG (public user secret key share)
    const [dWalletCap] = tx.moveCall({
      target: `${IKA_CONFIG.packages.ikaDwallet2pcMpcPackage}::coordinator::request_dwallet_dkg_with_public_user_secret_key_share`,
      arguments: [
        coordRef,
        tx.pure.id(encKeyObjId),
        tx.pure.u32(dkgData.curve),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userDKGMessage))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userSecretKeyShare))),
        tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(dkgData.userPublicOutput))),
        sessionId,
        noneOpt,
        ikaCoin,
        suiCoin,
      ],
    });

    // Transfer DWalletCap to the user + return leftover coins to ultron
    tx.transferObjects([dWalletCap], tx.pure.address(address));
    tx.transferObjects([suiCoin], tx.pure.address(ultronAddress));

    // Build with a real JSON-RPC client (Workers can't use gRPC)
    const { SuiJsonRpcClient: BuildClient } = await import('@mysten/sui/jsonRpc');
    const buildClient = new BuildClient({ url: SUI_RPC_URLS[0], network: 'mainnet' });
    const txBytes = await tx.build({ client: buildClient as any });
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));

    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as any;
    const digest = submitJson?.result?.digest;

    if (!digest) return c.json({ error: 'DKG tx failed', detail: submitJson?.error }, 500);
    return c.json({ success: true, digest });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── IKA dWallet provisioning ─────────────────────────────────────────

/**
 * POST /api/ika/provision
 * Body: { address: string }
 * Returns: { success, ultronAddress, suiCoins, ikaCoins }
 *
 * SuiNS-gated. Returns ultron wallet info so the client can build
 * a DKG transaction with ultron as gas sponsor. The DKG WASM
 * runs in the browser. Once built, the client sends the tx bytes
 * to /api/sponsor-gas for ultron's gas signature (which also
 * has the SuiNS gate), then co-signs and submits.
 */
app.post('/api/ika/provision', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const ultronAddress = keypair.toSuiAddress();

    // Fetch ultron's gas coins + IKA coins via GraphQL
    const GQL = 'https://graphql.mainnet.sui.io/graphql';
    const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

    const coinQuery = (coinType: string, limit: number) => fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!,$t:String!){
          address(address:$a){
            objects(filter:{type:$t},first:${limit}){
              nodes{ address version digest }
            }
          }
        }`,
        variables: { a: ultronAddress, t: `0x2::coin::Coin<${coinType}>` },
      }),
    }).then(r => r.json()) as Promise<any>;

    const [suiRes, ikaRes] = await Promise.all([
      coinQuery('0x2::sui::SUI', 5),
      coinQuery(IKA_TYPE, 3),
    ]);

    const mapCoins = (res: any) => (res?.data?.address?.objects?.nodes ?? []).map((n: any) => ({
      objectId: n.address, version: String(n.version), digest: n.digest,
    }));
    const suiCoins = mapCoins(suiRes);
    const ikaCoins = mapCoins(ikaRes);

    return c.json({
      success: true,
      ultronAddress,
      suiCoins,
      ikaCoins,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Tradeport listing proxy ──────────────────────────────────────────

const TRADEPORT_GQL = 'https://graphql.tradeport.gg';
const SUINS_COLLECTION_ID = '060fe4fb-9a3e-4170-a494-a25e62aba689';

app.get('/api/tradeport/listing/:label', async (c) => {
  const label = c.req.param('label').toLowerCase().replace(/\.sui$/, '');
  if (label.length < 3) return c.json({ listing: null });
  const name = `${label}.sui`;
  try {
    const res = await fetch(TRADEPORT_GQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-user': c.env.TRADEPORT_API_USER,
        'x-api-key': c.env.TRADEPORT_API_KEY,
      },
      body: JSON.stringify({
        query: `{ sui { nfts(where: { collection_id: { _eq: "${SUINS_COLLECTION_ID}" }, name: { _eq: "${name}" }, listed: { _eq: true } }, limit: 1) { token_id listings(where: { listed: { _eq: true } }) { id price seller market_name } } } }`,
      }),
    });
    type TpResult = { data?: { sui?: { nfts?: { token_id: string; listings: { id: string; price: number; seller: string; market_name: string }[] }[] } } };
    const json = await res.json() as TpResult;
    const nft = json?.data?.sui?.nfts?.[0];
    const listing = nft?.listings?.[0];
    if (!nft || !listing) return c.json({ listing: null });

    // QuestFi: pre-rumble listed names so chain addresses are ready before purchase
    // Fire and forget — don't block the listing response
    try {
      authedTreasuryStub(c).fetch(new Request('https://treasury-do/?pre-rumble', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury', ...cfGeoHeaders(c) },
        body: JSON.stringify({ name: label, source: 'questfi-snipe' }),
      })).catch(() => {});
    } catch {}

    return c.json({
      listing: {
        listingId: listing.id,
        priceMist: String(listing.price),
        seller: listing.seller,
        nftTokenId: nft.token_id,
        marketName: listing.market_name,
      },
    });
  } catch {
    return c.json({ listing: null });
  }
});

// Debug: dump all Tradeport listings + activities for a name so we can
// spot-check whether a current asking price ever had a lower historical.
app.get('/api/tradeport/history/:label', async (c) => {
  const label = c.req.param('label').toLowerCase().replace(/\.sui$/, '');
  const name = `${label}.sui`;
  try {
    const res = await fetch(TRADEPORT_GQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-user': c.env.TRADEPORT_API_USER,
        'x-api-key': c.env.TRADEPORT_API_KEY,
      },
      body: JSON.stringify({
        query: `{ sui { nfts(where: { collection_id: { _eq: "${SUINS_COLLECTION_ID}" }, name: { _eq: "${name}" } }, limit: 1) { token_id name listings(order_by: { price: asc }) { id price seller market_name listed block_time } actions(order_by: { block_time: desc }, limit: 20) { type price sender receiver market_name block_time } } } }`,
      }),
    });
    const json = await res.json() as any;
    return c.json(json);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'failed' }, 500);
  }
});

// ── SuiAMI identity proof verification ────────────────────────────
app.post('/api/suiami/verify', async (c) => {
  try {
    const { token } = await c.req.json<{ token: string }>();
    if (!token?.startsWith('suiami:')) return c.json({ valid: false, error: 'Invalid token format' }, 400);

    const body = token.slice(7);
    const dotIdx = body.lastIndexOf('.');
    if (dotIdx < 0) return c.json({ valid: false, error: 'Malformed token' }, 400);

    const msgB64 = body.slice(0, dotIdx);
    const signature = body.slice(dotIdx + 1);
    const message = JSON.parse(atob(msgB64));

    if (!message.suiami || !message.sui || !message.nftId) {
      return c.json({ valid: false, error: 'Missing required fields' }, 400);
    }

    const age = Date.now() - (message.timestamp ?? 0);
    if (age > 5 * 60 * 1000 || age < -30_000) {
      return c.json({ valid: false, error: 'Token expired or future-dated' }, 400);
    }

    let ownershipVerified = false;
    let nameVerified = false;
    let onChainError: string | undefined;

    try {
      const res = await fetch('https://graphql.mainnet.sui.io/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: SuiAddress!) {
            object(address: $id) {
              owner { __typename ... on AddressOwner { address { address } } }
              asMoveObject { contents { type { repr } json } }
            }
          }`,
          variables: { id: message.nftId },
        }),
      });
      const gql = await res.json() as any;
      const obj = gql?.data?.object;
      const ownerAddr = obj?.owner?.__typename === 'AddressOwner' ? (obj.owner.address?.address ?? '') : '';
      const norm = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      ownershipVerified = !!ownerAddr && norm(ownerAddr) === norm(message.sui);

      const objType = obj?.asMoveObject?.contents?.type?.repr ?? '';
      if (!objType.includes('suins_registration::SuinsRegistration') && !objType.includes('SubDomainRegistration')) {
        onChainError = 'Object is not a SuiNS registration NFT';
        ownershipVerified = false;
      }

      const fields = obj?.asMoveObject?.contents?.json ?? {};
      const nftName = ((fields.domain_name ?? fields.name ?? '') as string).replace(/\.sui$/, '');
      const claimedName = message.suiami.replace(/^I am /, '');
      nameVerified = nftName === claimedName;
    } catch {
      onChainError = 'On-chain verification failed (RPC error)';
    }

    return c.json({
      valid: ownershipVerified && nameVerified,
      ownershipVerified,
      nameVerified,
      onChainError,
      suiami: message.suiami,
      ski: message.ski,
      address: message.sui,
      nftId: message.nftId,
      timestamp: message.timestamp,
      signature,
    });
  } catch (err) {
    return c.json({ valid: false, error: 'Parse error' }, 400);
  }
});

// ── Thunder strike relay (ultron submits, user authorizes via signPersonalMessage) ──
app.post('/api/thunder/strike-relay', async (c) => {
  try {
    const body = await c.req.json() as {
      nameHash: string; nftId: string; authMsg: string; authSig: string; senderAddress: string; count: number;
    };
    if (!body.nameHash || !body.nftId || !body.authMsg || !body.authSig || !body.senderAddress) {
      return c.json({ error: 'Missing params' }, 400);
    }
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?strike-relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown DO error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── iUSD attest collateral (ultron signs, oracle-gated) ───────────
app.post('/api/iusd/attest', async (c) => {
  try {
    const body = await c.req.json() as { collateralValueMist: string };
    if (!body.collateralValueMist) return c.json({ error: 'Missing collateralValueMist' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?attest-collateral', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown DO error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── iUSD mint (routed to TreasuryAgents DO) ───────────────────────
app.post('/api/iusd/mint', async (c) => {
  try {
    const body = await c.req.json() as { recipient: string; collateralValueMist: string; mintAmount: string };
    if (!body.recipient || !body.collateralValueMist || !body.mintAmount) {
      return c.json({ error: 'Missing params' }, 400);
    }
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?mint-iusd', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try {
      const result = JSON.parse(text);
      return c.json(result, res.status as any);
    } catch {
      return c.json({ error: text || 'Unknown DO error' }, 500);
    }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── iUSD swap — burn iUSD, get SUI or USDC ──────────────────────────
// Ultron pre-sends SUI/USDC to user, returns TX for user to send iUSD back
app.post('/api/iusd/swap', async (c) => {
  try {
    const { address, amount, outputToken } = await c.req.json() as {
      address: string; amount: string; outputToken: 'SUI' | 'USDC';
    };
    if (!address || !amount) return c.json({ error: 'Missing address or amount' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?iusd-swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({ address, amount, outputToken: outputToken ?? 'SUI' }),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Start treasury agents tick ───────────────────────────────────────
app.post('/api/cache/start', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?start', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    return c.json(await res.json() as any);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Cache state (iUSD supply, collateral, ratio, surplus) ───────────
app.get('/api/cache/state', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?cache-state', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    return c.json(await res.json() as any);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Manual yield rotate ──────────────────────────────────────────────
app.post('/api/cache/yield-rotate', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?yield-rotate', { headers: { 'x-partykit-room': 'treasury' } }));
    return c.json(await res.json() as any, res.status as any);
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

// ── Manual sweep fees ────────────────────────────────────────────────
app.post('/api/cache/sweep-fees', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?sweep-fees', { headers: { 'x-partykit-room': 'treasury' } }));
    return c.json(await res.json() as any, res.status as any);
  } catch (err) { return c.json({ error: String(err) }, 500); }
});

// ── Refill ultron SUI cache (swap USDC→SUI) ─────────────────────────
app.post('/api/cache/refill-sui', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?refill-sui', {
      method: 'GET',
      headers: { 'x-partykit-room': 'treasury' },
    }));
    return c.json(await res.json() as any, res.status as any);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── /api/infer — Intent inference engine ────────────────────────────
// Reads real on-chain balances, determines best action + payment route,
// builds TX server-side. AI glue layer wraps this later.
app.post('/api/infer', async (c) => {
  try {
    const { label, address } = await c.req.json() as { label: string; address: string };
    if (!label || !address) return c.json({ error: 'Missing label or address' }, 400);

    const GQL = 'https://graphql.mainnet.sui.io/graphql';
    const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
    const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

    // ── Step 1: Read ALL on-chain balances ──────────────────────────
    const balRes = await fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ address(address: "${address}") { balances { nodes { coinType { repr } totalBalance } } } }`,
      }),
    });
    const balJson = await balRes.json() as any;
    const balNodes = balJson?.data?.address?.balances?.nodes ?? [];

    const balances: Record<string, { raw: bigint; usd: number }> = {};
    let suiBal = 0n, usdcBal = 0n, iusdBal = 0n, nsBal = 0n;
    // Fetch SUI price
    let suiPrice = 0;
    try {
      const pr = await fetch('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744&parsed=true');
      const pj = await pr.json() as any;
      suiPrice = Number(pj?.parsed?.[0]?.price?.price ?? 0) * Math.pow(10, Number(pj?.parsed?.[0]?.price?.expo ?? 0));
    } catch { suiPrice = 0.87; }

    for (const b of balNodes) {
      const ct = b.coinType?.repr ?? '';
      const raw = BigInt(b.totalBalance ?? '0');
      if (ct.includes('::sui::SUI')) { suiBal = raw; balances['SUI'] = { raw, usd: Number(raw) / 1e9 * suiPrice }; }
      else if (ct.includes('::usdc::USDC')) { usdcBal = raw; balances['USDC'] = { raw, usd: Number(raw) / 1e6 }; }
      else if (ct.includes('::iusd::IUSD')) { iusdBal = raw; balances['iUSD'] = { raw, usd: Number(raw) / 1e9 }; }
      else if (ct.includes('::ns::NS')) { nsBal = raw; balances['NS'] = { raw, usd: Number(raw) / 1e6 * 0.03 }; }
    }

    const suiUsd = Number(suiBal) / 1e9 * suiPrice;
    const usdcUsd = Number(usdcBal) / 1e6;
    const iusdUsd = Number(iusdBal) / 1e9;
    const totalUsd = suiUsd + usdcUsd + iusdUsd;

    // ── Step 2: Check name status + listing ─────────────────────────
    const name = `${label.replace(/\.sui$/, '')}.sui`;
    const [statusRes, tpRes] = await Promise.allSettled([
      fetch(GQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ address: resolveSuiNsAddress(domain: "${name}") }`,
        }),
      }).then(r => r.json()).catch(() => ({ data: { address: null } })),
      fetch(TRADEPORT_GQL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-user': c.env.TRADEPORT_API_USER,
          'x-api-key': c.env.TRADEPORT_API_KEY,
        },
        body: JSON.stringify({
          query: `{ sui { nfts(where: { collection_id: { _eq: "${SUINS_COLLECTION_ID}" }, name: { _eq: "${name}" }, listed: { _eq: true } }, limit: 1) { token_id listings(where: { listed: { _eq: true } }) { id price seller market_name } } } }`,
        }),
      }).then(r => r.json()),
    ]);

    const resolved = statusRes.status === 'fulfilled'
      ? (statusRes.value as any)?.data?.resolveSuinsAddress?.address ?? null
      : null;
    const isRegistered = !!resolved;

    const tpData = tpRes.status === 'fulfilled' ? tpRes.value as any : null;
    const tpNft = tpData?.data?.sui?.nfts?.[0];
    const tpListing = tpNft?.listings?.[0];
    const listing = tpListing ? {
      nftTokenId: tpNft.token_id as string,
      priceMist: String(tpListing.price),
      seller: tpListing.seller as string,
      priceUsd: suiPrice > 0 ? (Number(tpListing.price) / 1e9 * suiPrice) : null,
    } : null;

    // ── Step 3: Agent deliberation — score each action ──────────────
    const actions: Array<{ action: string; confidence: number; reason: string; route?: string }> = [];

    if (listing) {
      const listingPriceSui = Number(listing.priceMist) / 1e9;
      const fee = listingPriceSui * 0.03; // 3% Tradeport fee
      const totalCostSui = listingPriceSui + fee;
      const totalCostUsd = totalCostSui * suiPrice;

      // Can we afford it?
      if (suiUsd >= totalCostUsd * 1.05) {
        actions.push({ action: 'TRADE', confidence: 0.95, reason: `SUI direct — ${totalCostSui.toFixed(2)} SUI`, route: 'sui-direct' });
      } else if (suiUsd + usdcUsd >= totalCostUsd * 1.02) {
        actions.push({ action: 'TRADE', confidence: 0.90, reason: `USDC→SUI swap + purchase`, route: 'usdc-swap' });
      } else if (suiUsd + usdcUsd + iusdUsd >= totalCostUsd) {
        actions.push({ action: 'TRADE', confidence: 0.85, reason: `iUSD redeem→USDC→SUI + purchase`, route: 'iusd-redeem' });
      } else {
        actions.push({ action: 'TRADE', confidence: 0.10, reason: `Insufficient balance ($${totalUsd.toFixed(2)} < $${totalCostUsd.toFixed(2)})`, route: 'blocked' });
      }
    }

    if (!isRegistered) {
      const mintCostUsd = 7.50; // 5+ char with NS discount
      if (totalUsd >= mintCostUsd) {
        actions.push({ action: 'MINT', confidence: listing ? 0.05 : 0.90, reason: `Register ${name} ($${mintCostUsd})`, route: 'ns-register' });
      }
      actions.push({ action: 'Quest', confidence: listing ? 0.02 : 0.40, reason: `Post bounty for agents to fill`, route: 'quest-bounty' });
    }

    // Sort by confidence
    actions.sort((a, b) => b.confidence - a.confidence);
    const best = actions[0];

    // ── Step 4: Build TX for the winning action ─────────────────────
    let txBase64: string | null = null;
    let txDescription: string | null = null;

    if (best?.action === 'TRADE' && listing && best.route !== 'blocked') {
      // Delegate to TreasuryAgents DO for server-side TX building
      // (it has the keypair and can handle iUSD redemption atomically)
      const doRes = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?build-trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          buyer: address,
          nftTokenId: listing.nftTokenId,
          priceMist: listing.priceMist,
          route: best.route,
          suiBal: String(suiBal),
          usdcBal: String(usdcBal),
          iusdBal: String(iusdBal),
        }),
      }));
      const doJson = await doRes.json() as any;
      if (doJson?.txBase64) {
        txBase64 = doJson.txBase64;
        txDescription = doJson.description;
      } else if (doJson?.error) {
        best.reason = doJson.error;
      }
    }

    return c.json({
      label: name,
      address,
      balances: {
        sui: { mist: String(suiBal), usd: suiUsd },
        usdc: { raw: String(usdcBal), usd: usdcUsd },
        iusd: { raw: String(iusdBal), usd: iusdUsd },
        total_usd: totalUsd,
      },
      suiPrice,
      nameStatus: isRegistered ? 'taken' : 'available',
      listing,
      actions,
      recommended: best,
      tx: txBase64 ? { base64: txBase64, description: txDescription } : null,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Thunder admin (set fee via TreasuryAgents ultron) ──────────────
app.post('/api/thunder/set-fee', async (c) => {
  try {
    const body = await c.req.json() as { feeMist: number };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?set-thunder-fee', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Swap SUI→DEEP (acquire DEEP for pool creation) ──────────────
app.post('/api/cache/swap-sui-for-deep', async (c) => {
  try {
    const body = await c.req.json() as { amountMist?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?swap-sui-for-deep', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Rumble — server-side IKA dWallet check/provision for ultron.sui ──
app.post('/api/cache/rumble', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?rumble-ultron', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({}),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Create iUSD/USDC DeepBook pool ──────────────────────────────
app.post('/api/cache/create-iusd-pool', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?create-iusd-pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({}),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── CF geo extraction helper ─────────────────────────────────────────
function cfGeoHeaders(c: any): Record<string, string> {
  const cf = (c.req.raw as any)?.cf;
  const h: Record<string, string> = {};
  if (cf?.latitude) h['x-cf-lat'] = String(cf.latitude);
  if (cf?.longitude) h['x-cf-lon'] = String(cf.longitude);
  if (cf?.city) h['x-cf-city'] = String(cf.city);
  if (cf?.country) h['x-cf-country'] = String(cf.country);
  return h;
}

// ── Pre-Rumble for new name (auto-provision chain addresses) ────────
app.post('/api/cache/pre-rumble', async (c) => {
  try {
    const body = await c.req.json() as { name: string; userAddress: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?pre-rumble', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury', ...cfGeoHeaders(c) },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Squid stats — geo-mapped pre-rumble counter (private) ───────────
app.get('/api/cache/squid-stats', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 500);
  // Auth: must sign a recent timestamp (within 60s)
  const sig = c.req.header('x-ultron-sig');
  const ts = c.req.header('x-ultron-ts');
  if (!sig || !ts) return c.json({ error: 'Unauthorized' }, 401);
  const age = Math.abs(Date.now() - Number(ts));
  if (age > 60_000) return c.json({ error: 'Timestamp expired' }, 401);
  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const keypair = Ed25519Keypair.fromSecretKey(key);
    const msgBytes = new TextEncoder().encode(`squid-stats:${ts}`);
    const expected = await keypair.sign(msgBytes);
    const { toBase64 } = await import('@mysten/sui/utils');
    if (toBase64(expected) !== sig) return c.json({ error: 'Invalid signature' }, 403);
  } catch {
    return c.json({ error: 'Auth failed' }, 403);
  }
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?squid-stats', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Seed iUSD/USDC DeepBook pool ────────────────────────────────────
app.post('/api/cache/seed-iusd-pool', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?seed-iusd-pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({}),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Ignite — cross-chain gas via iUSD burn ──────────────────────────
app.post('/api/ignite', async (c) => {
  try {
    const body = await c.req.json() as { requestId: string; chain: string; encryptedRecipient: string; iusdBurned: number };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?ignite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Acquire NS for user (iUSD route via TreasuryAgents) ───────────
app.post('/api/cache/acquire-ns', async (c) => {
  try {
    const body = await c.req.json() as any;
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?acquire-ns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Chronicom — per-wallet thunder signal watcher
app.get('/api/thunder/chronicom', async (c) => {
  const addr = c.req.query('addr');
  if (!addr) return c.json({ error: 'addr required' }, 400);
  const names = c.req.query('names') || '';
  const chronicomStub = c.env.Chronicom.get(c.env.Chronicom.idFromName(addr));
  const res = await chronicomStub.fetch(new Request(`https://chronicom-do/?poll&names=${encodeURIComponent(names)}`, {
    headers: { 'x-partykit-room': addr },
  }));
  const text = await res.text();
  try { return c.json(JSON.parse(text), res.status as any); }
  catch { return c.json({ error: text }, 500); }
});

// NameIndex — global target-reverse map shared across all sui.ski visitors.
// Client writes mappings whenever it resolves `@name → address`, and
// reads them as a last-resort fallback when SuiNS primary + owned-NFT
// lookups both return null. Singleton DO (idFromName('singleton')).
app.post('/api/name-index/set', async (c) => {
  const stub = c.env.NameIndex.get(c.env.NameIndex.idFromName('singleton'));
  const body = await c.req.text();
  const res = await stub.fetch(new Request('https://do/set', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-partykit-room': 'singleton',
      'x-partykit-namespace': 'NameIndex',
    },
    body,
  }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/name-index/bulk', async (c) => {
  const stub = c.env.NameIndex.get(c.env.NameIndex.idFromName('singleton'));
  const body = await c.req.text();
  const res = await stub.fetch(new Request('https://do/bulk', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-partykit-room': 'singleton',
      'x-partykit-namespace': 'NameIndex',
    },
    body,
  }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.get('/api/name-index/get/:address', async (c) => {
  const address = c.req.param('address');
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) return c.json({ error: 'bad address' }, 400);
  const stub = c.env.NameIndex.get(c.env.NameIndex.idFromName('singleton'));
  const res = await stub.fetch(new Request(`https://do/get/${address}`, {
    method: 'GET',
    headers: {
      'x-partykit-room': 'singleton',
      'x-partykit-namespace': 'NameIndex',
    },
  }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

// ── Pokedex — Pokemon Swarm coordinator (Phase 2) ───────────────────────
// Singleton DO orchestrating spawn/capture/evolve loops from
// docs/superpowers/specs/2026-04-11-pokemon-swarm-agents.md. Phase 2
// exposes observation ingestion + stubbed spawn logging; Phase 3 will
// plug live GitHub REST calls into the same DO.
async function _pokedexForward(c: any, path: string, init: RequestInit = {}): Promise<Response> {
  const stub = c.env.Pokedex.get(c.env.Pokedex.idFromName('singleton'));
  const headers: Record<string, string> = {
    'x-partykit-room': 'singleton',
    'x-partykit-namespace': 'Pokedex',
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await stub.fetch(new Request(`https://do${path}`, { ...init, headers }));
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
}

app.post('/api/pokedex/observe-todos', async (c) => {
  const body = await c.req.text();
  return _pokedexForward(c, '/observe-todos', { method: 'POST', body });
});

app.post('/api/pokedex/observe-errors', async (c) => {
  const body = await c.req.text();
  return _pokedexForward(c, '/observe-errors', { method: 'POST', body });
});

app.post('/api/pokedex/observe-issues', async (c) => {
  const body = await c.req.text();
  return _pokedexForward(c, '/observe-issues', { method: 'POST', body });
});

app.post('/api/pokedex/tick', async (c) => {
  return _pokedexForward(c, '/tick', { method: 'POST' });
});

app.get('/api/pokedex/state', async (c) => {
  return _pokedexForward(c, '/state', { method: 'GET' });
});

app.get('/api/pokedex/spawned', async (c) => {
  return _pokedexForward(c, '/spawned', { method: 'GET' });
});

app.post('/api/pokedex/mark-captured', async (c) => {
  const body = await c.req.text();
  return _pokedexForward(c, '/mark-captured', { method: 'POST', body });
});

app.post('/api/pokedex/mark-merged', async (c) => {
  const body = await c.req.text();
  return _pokedexForward(c, '/mark-merged', { method: 'POST', body });
});

// Timestream — per-group encrypted message transport (Thunder Timestream)
app.post('/api/timestream/:groupId/:action', async (c) => {
  const groupId = c.req.param('groupId');
  const action = c.req.param('action');
  if (!groupId || !action) return c.json({ error: 'groupId and action required' }, 400);
  const stub = c.env.TimestreamAgent.get(c.env.TimestreamAgent.idFromName(groupId));
  const body = await c.req.text();
  const res = await stub.fetch(new Request(`https://timestream-do/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-partykit-room': groupId },
    body,
  }));
  const text = await res.text();
  try { return c.json(JSON.parse(text), res.status as any); }
  catch { return c.json({ error: text }, 500); }
});

// Thunder subscribe WebSocket — Jolteon Lv. 25.
// Clients open a WS to /api/timestream/:groupId/ws and receive real-time
// thunder events pushed by the TimestreamAgent DO. The Agent's Server
// base class handles the WS handshake + hibernation; we just forward
// the upgrade request to the right DO stub.
app.get('/api/timestream/:groupId/ws', async (c) => {
  const groupId = c.req.param('groupId');
  if (!groupId) return c.json({ error: 'groupId required' }, 400);
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'WebSocket upgrade required' }, 426);
  }
  const stub = c.env.TimestreamAgent.get(c.env.TimestreamAgent.idFromName(groupId));
  // Forward the raw request — the DO's Server base class recognizes
  // the Upgrade header and performs the handshake + onConnect.
  // The partykit room header tags this connection to the right room.
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-partykit-room', groupId);
  return stub.fetch(new Request(c.req.raw.url, {
    method: 'GET',
    headers,
  }));
});

// Migrate ultron: sweep all assets to new keeper + update ultron.sui target address
app.post('/api/cache/migrate', async (c) => {
  try {
    const body = await c.req.json() as { newKeeper: string };
    if (!body.newKeeper) return c.json({ error: 'newKeeper required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Quest bounty — post a Quest for Chronicoms to fill (register name for user)
app.post('/api/cache/quest-bounty', async (c) => {
  try {
    const body = await c.req.json() as {
      commitment: string;
      amount: number;
      accepted: string[];
      recipient: string;
    };
    if (!body.commitment || !body.amount || !body.recipient) {
      return c.json({ error: 'Missing params' }, 400);
    }
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?quest-bounty', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text || 'Unknown error' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── OpenCLOB: iUSD SPL on Solana ────────────────────────────────────
app.post('/api/cache/create-iusd-sol-mint', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?create-iusd-sol-mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: '{}',
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post('/api/cache/bam-mint-iusd-sol', async (c) => {
  try {
    const body = await c.req.json() as { recipientSolAddress: string; amount: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?bam-mint-iusd-sol', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Kamino deposit — SOL → Kamino Lend → attest → mint iUSD ─────────
app.post('/api/cache/kamino-deposit', async (c) => {
  try {
    const body = await c.req.json() as { suiAddress: string; amountUsd: number; strategy?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?kamino-deposit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Quest bounties — list bounties (optionally filter by recipient)
app.get('/api/cache/quest-bounties', async (c) => {
  try {
    const recipient = c.req.query('recipient') || '';
    const res = await authedTreasuryStub(c).fetch(new Request(`https://treasury-do/?quest-bounties&recipient=${encodeURIComponent(recipient)}`, {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Quest fill — manually trigger fill for a bounty
app.post('/api/cache/quest-fill', async (c) => {
  try {
    const body = await c.req.json() as { bountyId: string };
    if (!body.bountyId) return c.json({ error: 'bountyId required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?quest-fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Lend USDC to NAVI for yield
app.post('/api/cache/lend', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?lend-usdc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: '{}',
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Shade — create a Shade order (lock iUSD for grace-period name sniping)
app.post('/api/cache/shade-create', async (c) => {
  try {
    const body = await c.req.json() as any;
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Shade list — get active Shade orders
app.get('/api/cache/shade-list', async (c) => {
  try {
    const holder = c.req.query('holder') || '';
    const res = await authedTreasuryStub(c).fetch(new Request(`https://treasury-do/?shade-list&holder=${encodeURIComponent(holder)}`, {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Poke — instant hook after sending funds. Fires SOL watcher + fills all open quests.
app.all('/api/cache/initiate', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?initiate', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Deposit intent — get steganographic SOL amount with tag for routing
app.post('/api/cache/deposit-intent', async (c) => {
  try {
    const body = await c.req.json() as { suiAddress: string; amountUsd: number };
    if (!body.suiAddress || !body.amountUsd) return c.json({ error: 'Missing params' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?deposit-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Deposit status — check if SOL deposit was matched
app.get('/api/cache/deposit-status', async (c) => {
  try {
    const suiAddress = c.req.query('suiAddress') || '';
    if (!suiAddress) return c.json({ error: 'suiAddress required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request(`https://treasury-do/?deposit-status&suiAddress=${encodeURIComponent(suiAddress)}`, {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Deposit addresses — where to send SUI/SOL/USDC to fund the cache
app.get('/api/cache/rumble', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?deposit-addresses', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Helius webhook: instant SOL deposit detection ──
app.post('/api/sol-webhook', async (c) => {
  const secret = c.env.HELIUS_WEBHOOK_SECRET;
  if (secret) {
    const auth = c.req.header('Authorization') || '';
    if (auth !== `Bearer ${secret}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  try {
    const body = await c.req.text();
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/sol-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body,
    }));
    return c.json({ ok: true }, res.status as any);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Manual rescan: recovery endpoint for missed deposits ──
app.post('/api/cache/rescan-deposits', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/rescan-deposits', {
      method: 'POST',
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Manual sweep endpoint — useful for testing the sweeper without
// waiting for the cron tick. No auth because the sweep itself is
// permissionless (anyone can call iou::recall after TTL), so this
// endpoint can't be abused to move funds anywhere other than back
// to their original senders.
app.post('/api/iou/sweep', async (c) => {
  try {
    const { sweepExpiredIous } = await import('./iou-sweeper.js');
    const result = await sweepExpiredIous(c.env as unknown as { SHADE_KEEPER_PRIVATE_KEY?: string });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Worker default export: Hono fetch + Cron Triggers scheduled().
// The scheduled() handler is invoked by Cloudflare on the cron
// schedule declared in wrangler.jsonc (every 10 minutes). It runs
// the Thunder IOU sweeper so expired escrows get recalled without
// requiring either the sender or the recipient to be online.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        const { sweepExpiredIous } = await import('./iou-sweeper.js');
        const result = await sweepExpiredIous(env as unknown as { SHADE_KEEPER_PRIVATE_KEY?: string });
        console.log('[cron] iou-sweeper:', JSON.stringify(result));
      } catch (err) {
        console.error('[cron] iou-sweeper threw:', err instanceof Error ? err.message : err);
      }
    })());
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
export { TreasuryAgents } from './agents/treasury-agents.js';
export { Chronicom } from './agents/chronicom.js';
export { TimestreamAgent } from './agents/timestream.js';
export { NameIndex } from './agents/name-index.js';
export { Pokedex } from './agents/pokedex.js';
