import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';
import { ultronKeypair, hasUltronKey, requireUltronSig } from './ultron-key.js';
import { requireUltronAdmin, todayUtc } from './ultron-policy.js';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceJsonRpc } from './rpc.js';
import { createZkLoginApp } from './zklogin-proxy.js';
import { encryptProxy } from './encrypt-proxy.js';
import { verifyVectorIntent } from './vector-intent.js';
import { createPublicClient, http, erc20Abi, type Address } from 'viem';
import { mainnet } from 'viem/chains';
// ika-provision.ts is available for server-side DKG if needed in future,
// but DKG WASM must run client-side (browser) — Workers can't run it.

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TreasuryAgents: DurableObjectNamespace;
  Chronicom: DurableObjectNamespace;
  TimestreamAgent: DurableObjectNamespace;
  NameIndex: DurableObjectNamespace;
  Pokedex: DurableObjectNamespace;
  UltronSigningAgent: DurableObjectNamespace;
  Aegislash: DurableObjectNamespace;
  SneaselWatcherAgent: DurableObjectNamespace;
  WeavileScannerAgent: DurableObjectNamespace;
  WeavileAssuranceAgent: DurableObjectNamespace;
  AggronBatcher: DurableObjectNamespace;
  SuiInboundWatcher: DurableObjectNamespace;
  UltronPostal: DurableObjectNamespace;
  IntentRegistry: DurableObjectNamespace;
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
  SHADE_KEEPER_PRIVATE_KEY?: string; // ultron.sui signing key (legacy name — consume via ultronKeypair(env))
  ULTRON_PRIVATE_KEY?: string; // ultron.sui signing key (preferred name — consume via ultronKeypair(env))
  HELIUS_API_KEY?: string; // Solana RPC (Helius)
  HELIUS_WEBHOOK_SECRET?: string; // Validates incoming Helius webhook requests
  ALCHEMY_WEBHOOK_SECRET?: string; // Validates incoming Alchemy Address Activity webhooks
  ALCHEMY_ETH_URL?: string; // Alchemy ETH mainnet HTTPS endpoint (viem transport)
  ZKLOGIN_PROVER_URL?: string; // zkLogin prover upstream (devnet vampire / mainnet self-host)
  ENCRYPT_GRPC_URL?: string; // dWallet Encrypt upstream (pre-alpha devnet)
  CF_HMAC_SECRET?: string; // HMAC-SHA256 key for /api/cf-context signed envelopes
  CF_IP_SALT?: string; // SHA-256 salt for ipHash in CF edge context
}

const app = new Hono<{ Bindings: Env }>();

// ── zkLogin prover proxy + Encrypt FHE bridge ───────────────────────
// Mounted early so rate-limit middleware still applies via /api/* prefix.
// zkLogin: vampire Mysten's free devnet prover, self-host for mainnet later.
// Encrypt: stub mode until pre-alpha exposes gRPC-Web or grpc-gateway.
app.route('/api/zklogin', createZkLoginApp());
app.route('/api/encrypt', encryptProxy);

// ── CF edge context for SUIAMI CF-history enrichment ────────────────
// Returns HMAC-signed CF metadata the client encrypts + uploads to
// Walrus. Read-only, no rate-limit concerns beyond the generic /api/*
// limiter below.
app.get('/api/cf-context', async (c) => {
  const { handleCfContext } = await import('./cf-context.js');
  return handleCfContext(c.req.raw, c.env as { CF_HMAC_SECRET?: string; CF_IP_SALT?: string });
});

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
  '/api/iusd/attest', '/api/iusd/mint', '/api/iusd/mint-deposit',
  '/api/thunder/set-fee', '/api/swap-sui-for-deep', '/api/rumble-ultron',
  '/api/create-iusd-pool', '/api/seed-iusd-pool',
  '/api/create-iusd-sol-mint', '/api/bam-mint-iusd-sol',
  '/api/lend-usdc', '/api/kamino-deposit', '/api/kamino-deposit-usdc', '/api/migrate',
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
  // X-Frame-Options omitted — we use frame-ancestors (CSP) instead, which is
  // the modern replacement. XFO SAMEORIGIN conflicts with WaaP's cross-origin
  // iframe lifecycle in some browsers.
  c.header('Permissions-Policy', 'clipboard-read=()'); // block clipboard read prompts (WalletConnect w3m-input-address)
  // CSP: allow self + Sui RPCs + Walrus + CDN for /squids marked page.
  // WaaP (human.tech) needs explicit frame-src + connect-src entries for its
  // iframe-based wallet protocol. Without these, every WaaP auth/signing
  // iframe is silently blocked by the default-src 'self' fallback and the
  // whole wallet looks broken. The domains come from @human.tech/waap-constants.
  const WAAP_FRAME = [
    'https://waap.xyz',
    'https://*.waap.xyz',
    'https://*.silk-protector.com',
    'https://*.silk-protector-microservice-km.com',
    'https://*.silk-protector-microservice-pe.com',
    'https://*.silkwallet.net',
    'https://silksecure.net',
    'https://*.silksecure.net',
    'https://dashboard.silk.sc',
    'https://gastank.app-76797b4474a8.enclave.evervault.com',
  ].join(' ');
  const WAAP_CONNECT = [
    'https://*.waap.xyz',
    'https://prod-waap-ws-relay.fly.dev',
    'wss://prod-waap-ws-relay.fly.dev',
    'https://*.silk-protector.com',
    'https://*.silk-protector-microservice-km.com',
    'https://*.silk-protector-microservice-pe.com',
    'https://*.silkwallet.net',
    'https://silksecure.net',
    'https://*.silksecure.net',
    'https://gastank.app-76797b4474a8.enclave.evervault.com',
    'https://api.fpjs.io',
    'https://fpcdn.io',
  ].join(' ');
  // OAuth providers WaaP redirects to for social auth
  const OAUTH_FORMS = [
    'https://accounts.google.com',
    'https://api.twitter.com',
    'https://x.com',
    'https://twitter.com',
    'https://discord.com',
    'https://github.com',
  ].join(' ');
  c.header('Content-Security-Policy', [
    "default-src 'self'",
    // Inline script in index.html for shell restore — nonce would be ideal but
    // requires templating; unsafe-inline scoped to script-src is the pragmatic
    // first step (still blocks eval, data: URIs, and remote script injection).
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    `connect-src 'self' https://*.sui.io https://sui-rpc.publicnode.com https://rpc.ankr.com https://*.blockvision.org https://*.walrus.space https://*.h2o-nodes.com ${WAAP_CONNECT}`,
    `frame-src 'self' ${WAAP_FRAME}`,
    "frame-ancestors 'self' https://*.sui.ski",
    "base-uri 'self'",
    `form-action 'self' ${OAUTH_FORMS}`,
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
  if (!hasUltronKey(env)) { _treasuryAuthCache = ''; return ''; }
  const kp = ultronKeypair(env);
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

// ENS CCIP-read gateway — Beldum Iron Defense (#167). Serves
// wildcard `*.waap.eth` resolver callbacks from the on-chain
// OffchainResolver (EIP-3668 redirect target). See
// src/server/ens-resolver.ts.
app.get('/ens-resolver/:sender/:data', async (c) => {
  const { handleEnsCcipRead } = await import('./ens-resolver.js');
  return handleEnsCcipRead(c);
});
app.post('/ens-resolver/:sender/:data', async (c) => {
  const { handleEnsCcipRead } = await import('./ens-resolver.js');
  return handleEnsCcipRead(c);
});
app.get('/api/ens-signer-address', async (c) => {
  const { handleEnsSignerAddress } = await import('./ens-resolver.js');
  return handleEnsSignerAddress(c);
});

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

  const md = await fetch(`https://aggregator.walrus-mainnet.h2o-nodes.com/v1/blobs/${SQUIDS_BLOB}`).then(r => r.text());
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

// ── JSON-RPC proxy (same-origin, avoids CORS for browser-side IKA SDK) ──
// Forwards to multiple Sui fullnodes with fallback.
const SUI_RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://fullnode.mainnet.sui.io:443',
];
// Shared rate limit gate for the generic RPC proxies. Reuses
// ENS_RATE_LIMITER (60 req/min) with a `rpc:` key prefix so an abusive
// client can't spend our whole budget by alternating between endpoints.
async function rpcRateCheck(c: Context, scope: string): Promise<Response | null> {
  const rl = (c.env as any).ENS_RATE_LIMITER as
    | { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
    | undefined;
  if (!rl) return null;
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown';
  const { success } = await rl.limit({ key: `${scope}:${ip}` });
  if (!success) return c.json({ error: 'rate limit exceeded' }, 429);
  return null;
}

app.post('/api/rpc', async (c) => {
  const blocked = await rpcRateCheck(c, 'rpc');
  if (blocked) return blocked;
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

// ── Shade Lock-On III — user's pending Shade orders ──
// Scan on-chain for both legacy ShadeOrder and StableShadeOrder<T>
// objects where owner == the requested address. Returns a flat list
// with { objectId, coinType, stable, depositMist, sealedPayload,
// commitment, graceEndMs, status } so a UI can render pending orders
// with countdown + refund buttons without opening DevTools.
//
// Entirely GraphQL — does not call the ShadeExecutorAgent DO. Safe to
// poll from any client. No auth gate since the data is already public
// on-chain; we just filter by owner address (which is visible in the
// `owner` field of every order object).
app.get('/api/shade/orders/:address', async (c) => {
  const address = c.req.param('address');
  const lower = address.toLowerCase();
  const SHADE_V4_PACKAGE = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';
  const SHADE_V5_PACKAGE = '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837';
  const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
  const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  const GQL = 'https://graphql.mainnet.sui.io/graphql';
  type OrderNode = {
    address: string;
    asMoveObject?: {
      contents?: {
        json?: {
          owner?: string;
          deposit?: string;
          sealed_payload?: string;
          commitment?: string;
          grace_end_ms?: string;
          execute_after_ms?: string;
        };
        type?: { repr?: string };
      };
    };
  };
  const queryType = async (type: string): Promise<OrderNode[]> => {
    try {
      const res = await fetch(GQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($type: String!) {
            objects(filter: { type: $type }) {
              nodes { address asMoveObject { contents { json type { repr } } } }
            }
          }`,
          variables: { type },
        }),
      });
      if (!res.ok) return [];
      const json = await res.json() as { data?: { objects?: { nodes?: OrderNode[] } } };
      return json?.data?.objects?.nodes ?? [];
    } catch { return []; }
  };
  // Scan legacy + stable-over-iUSD + stable-over-USDC in parallel. Stable
  // type scans are generic per coin type; adding more stables is a matter
  // of appending to this list. The contract is `StableShadeOrder<T>` so
  // each instantiation is its own Move type and must be queried separately.
  const [legacy, stableIusd, stableUsdc] = await Promise.all([
    queryType(`${SHADE_V4_PACKAGE}::shade::ShadeOrder`),
    queryType(`${SHADE_V5_PACKAGE}::shade::StableShadeOrder<${IUSD_TYPE}>`),
    queryType(`${SHADE_V5_PACKAGE}::shade::StableShadeOrder<${USDC_TYPE}>`),
  ]);
  const now = Date.now();
  const toOrder = (n: OrderNode, stable: boolean, coinType: string) => {
    const json = n.asMoveObject?.contents?.json ?? {};
    const graceEndMs = Number(json.grace_end_ms ?? json.execute_after_ms ?? 0);
    const status = graceEndMs === 0
      ? 'pending'
      : now < graceEndMs
      ? 'waiting'
      : 'expired';
    return {
      objectId: n.address,
      stable,
      coinType,
      owner: json.owner ?? '',
      depositMist: json.deposit ?? '0',
      sealedPayload: json.sealed_payload,
      commitment: json.commitment,
      graceEndMs,
      msUntilGrace: graceEndMs === 0 ? null : graceEndMs - now,
      status,
    };
  };
  const orders = [
    ...legacy
      .filter(n => (n.asMoveObject?.contents?.json?.owner ?? '').toLowerCase() === lower)
      .map(n => toOrder(n, false, 'SUI')),
    ...stableIusd
      .filter(n => (n.asMoveObject?.contents?.json?.owner ?? '').toLowerCase() === lower)
      .map(n => toOrder(n, true, IUSD_TYPE)),
    ...stableUsdc
      .filter(n => (n.asMoveObject?.contents?.json?.owner ?? '').toLowerCase() === lower)
      .map(n => toOrder(n, true, USDC_TYPE)),
  ];
  return c.json({ address, count: orders.length, orders });
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
  const blocked = await rpcRateCheck(c, 'sui-rpc');
  if (blocked) return blocked;
  const body = await c.req.text();
  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sponsor-gas', async (c) => {
  if (!hasUltronKey(c.env)) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const { txBytes, senderAddress } = await c.req.json<{ txBytes: string; senderAddress?: string }>();
    if (!txBytes) return c.json({ error: 'Missing txBytes' }, 400);

    // SuiNS gate: require sender to own a SuiNS registration NFT
    if (senderAddress) {
      const hasNft = await hasSuinsNft(senderAddress);
      if (!hasNft) return c.json({ error: 'SuiNS name required for gas sponsorship' }, 403);
    }

    const keypair = ultronKeypair(c.env);
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
  if (!hasUltronKey(c.env)) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const keypair = ultronKeypair(c.env);
    const sponsorAddress = keypair.toSuiAddress();

    // Fetch gas coins via GraphQL. The `coins` field on Address
    // doesn't exist in current mainnet GraphQL schema — use
    // `objects` filtered by Coin<SUI> type instead. Previous
    // version silently returned an empty list, breaking every
    // sponsored thunder send.
    const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            objects(filter:{type:"0x2::coin::Coin<0x2::sui::SUI>"}, first:5){
              nodes{ address version digest contents { json } }
            }
          }
        }`,
        variables: { a: sponsorAddress },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: Array<{ address: string; version: number | string; digest: string; contents?: { json?: { balance?: string } } }> } } };
    };
    const nodes = json?.data?.address?.objects?.nodes ?? [];
    // Sort by balance desc so the largest coin is first — matches
    // what tx.setGasPayment wants as primary.
    const sortedNodes = nodes
      .map(n => ({ n, bal: BigInt(n.contents?.json?.balance ?? '0') }))
      .sort((a, b) => (a.bal > b.bal ? -1 : 1))
      .map(({ n }) => n);
    const gasCoins = sortedNodes.map((n) => ({
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
const GAS_DRIP_MIST     = 100_000_000n; // 0.1 SUI — covers ~20 standard txs incl. 0.04 iUSD-transfer PTB
const GAS_DRIP_MIN_MIST = 60_000_000n;  // drip only if below 0.06 SUI
// 60 s is enough to prevent drip spam but short enough that
// legitimate retries (sweep attempts, failed gas estimates) don't
// get stuck behind a cooldown wall. Was 60 min which left users
// unable to re-drip when a previous drip coin got spent elsewhere.
const GAS_DRIP_COOLDOWN_MS = 60 * 1000;
const _gasDripLog = new Map<string, number>(); // addr → last drip ts

app.post('/api/fund-gas', async (c) => {
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);
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

    const keypair = ultronKeypair(c.env);
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
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = ultronKeypair(c.env);
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
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);

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

    const keypair = ultronKeypair(c.env);
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
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const keypair = ultronKeypair(c.env);
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

// Chansey v3 deposit-mint — attest cross-chain collateral + mint iUSD
app.post('/api/iusd/mint-deposit', async (c) => {
  try {
    const body = await c.req.json() as {
      recipient: string; depositedUsdMist: string;
      assetKey: string; chainKey: string;
    };
    if (!body.recipient || !body.depositedUsdMist) return c.json({ error: 'Missing params' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?mint-iusd-deposit', {
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
// ── One-off refund of stranded NS in ultron's wallet ────────────────
// Specifically to recover the 406.30 NS sent to brando on 2026-04-03
// via the failed quest fill that then got manually swept to ultron
// on 2026-04-11 (digest 9TsU2E6VkkEbesP7qjbJJzkXrt3nBhDbtdDPCKnQHLos).
// That sweep predated the client-side NS→USDC→iUSD PTB, so the NS
// went to ultron instead of back to brando as iUSD.
//
// This endpoint runs ultron-signed + ultron-paid: no user signature
// needed. PTB: merge all ultron's NS → NS/USDC swap → USDC/iUSD
// swap → transfer iUSD to the requested recipient. One-shot, hard-
// gated to the stranded-sweep recipient so nobody else can drain
// ultron's NS balance via this endpoint.
app.post('/api/cache/refund-stranded-ns', async (c) => {
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);
  // Hardcoded recipient — this is a one-off refund for a specific
  // on-chain event, not a general admin endpoint.
  const RECIPIENT = '0xbec4fec9d1639fbe5e8ab93bf2475d6907f6534a78407912e618e94195afa057';
  const NS_TYPE = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
  const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
  const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
  const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  const DB_NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060';
  const DB_NS_USDC_POOL_INITIAL_SHARED_VERSION = 414947421;
  const DB_IUSD_USDC_POOL = '0x38df72f5d07607321d684ed98c9a6c411c0b8968e100a1cd90a996f912cd6ce1';
  const DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 832866334;

  try {
    const keypair = ultronKeypair(c.env);
    const ultronAddress = normalizeSuiAddress(keypair.toSuiAddress());
    const graphql = new SuiGraphQLClient({ url: SUINS_GQL_URL, network: 'mainnet' });

    // The 406.30 NS stranded earlier was already converted to
    // USDC by the existing _sweepNsToIusd alarm tick (ultron's
    // NS balance dropped from ~406 to ~0.07 and its USDC balance
    // rose by ~7.43). So the refund path is now: transfer the
    // equivalent USDC (7_430_000 raw = $7.43) from ultron to the
    // recipient directly. No swap needed.
    //
    // Unused constants for the no-longer-taken swap path, kept
    // for when this endpoint is ever repurposed for a live sweep.
    void NS_TYPE; void IUSD_TYPE; void DB_PACKAGE; void DB_DEEP_TYPE;
    void DB_NS_USDC_POOL; void DB_NS_USDC_POOL_INITIAL_SHARED_VERSION;
    void DB_IUSD_USDC_POOL; void DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION;

    const REFUND_USDC_RAW = 7_430_000n; // $7.43 at 6 decimals

    // Fetch ultron's USDC coins; merge and split off the refund amount.
    const usdcRes = await fetch(SUINS_GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            objects(filter:{ type: "0x2::coin::Coin<${USDC_TYPE}>" }, first: 50) {
              nodes { address version digest contents { json } }
            }
          }
        }`,
        variables: { a: ultronAddress },
      }),
    });
    const usdcJson = await usdcRes.json() as {
      data?: { address?: { objects?: { nodes?: Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }> } } };
    };
    const usdcNodes = usdcJson?.data?.address?.objects?.nodes ?? [];
    const usdcCoins = usdcNodes
      .map(n => ({ objectId: n.address, version: n.version, digest: n.digest, balance: BigInt(n.contents?.json?.balance ?? '0') }))
      .filter(n => n.balance > 0n)
      .sort((a, b) => (a.balance > b.balance ? -1 : 1));
    if (usdcCoins.length === 0) {
      return c.json({ error: 'Ultron has no USDC to refund' }, 404);
    }
    const totalUsdc = usdcCoins.reduce((s, c2) => s + c2.balance, 0n);
    if (totalUsdc < REFUND_USDC_RAW) {
      return c.json({ error: `Ultron only has ${Number(totalUsdc) / 1e6} USDC, need ${Number(REFUND_USDC_RAW) / 1e6}` }, 503);
    }

    const tx = new Transaction();
    tx.setSender(ultronAddress);

    const usdcPrimary = tx.objectRef(usdcCoins[0]);
    if (usdcCoins.length > 1) {
      tx.mergeCoins(usdcPrimary, usdcCoins.slice(1).map(cc => tx.objectRef(cc)));
    }
    const [refundCoin] = tx.splitCoins(usdcPrimary, [tx.pure.u64(REFUND_USDC_RAW.toString())]);
    tx.transferObjects([refundCoin], tx.pure.address(normalizeSuiAddress(RECIPIENT)));
    // Leftover merged coin stays with ultron.
    const totalNs = 0n;

    const txBytes = await tx.build({ client: graphql as never });
    const { signature } = await keypair.signTransaction(txBytes);
    const b64 = btoa(String.fromCharCode(...txBytes));
    const submitRes = await fetch(SUI_RPC_URLS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_executeTransactionBlock',
        params: [b64, [signature], { showEffects: true, showBalanceChanges: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as { result?: { digest?: string; balanceChanges?: Array<Record<string, unknown>> }; error?: unknown };
    const digest = submitJson?.result?.digest;
    if (!digest) return c.json({ error: 'Refund failed', detail: submitJson?.error }, 500);

    return c.json({
      success: true,
      digest,
      totalNsSwept: String(totalNs),
      totalNsUi: Number(totalNs) / 1e6,
      recipient: RECIPIENT,
      balanceChanges: submitJson.result?.balanceChanges,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

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

      // Preference order favors stables: if the buyer holds
      // meaningful iUSD (>$5), route through iusd-redeem so the
      // cache recaptures USDC/iUSD in exchange for the SUI it
      // advances. Only fall back to SUI-direct when the buyer
      // has no stables worth mentioning.
      const hasMeaningfulIusd = iusdUsd >= 5;
      const canAffordWithStables = iusdUsd + usdcUsd + suiUsd >= totalCostUsd;

      if (hasMeaningfulIusd && canAffordWithStables) {
        actions.push({ action: 'TRADE', confidence: 0.95, reason: `iUSD + USDC → cache + SUI listing`, route: 'iusd-redeem' });
      } else if (suiUsd >= totalCostUsd * 1.05) {
        actions.push({ action: 'TRADE', confidence: 0.90, reason: `SUI direct — ${totalCostSui.toFixed(2)} SUI`, route: 'sui-direct' });
      } else if (suiUsd + usdcUsd >= totalCostUsd * 1.02) {
        actions.push({ action: 'TRADE', confidence: 0.85, reason: `USDC→SUI swap + purchase`, route: 'usdc-swap' });
      } else if (canAffordWithStables) {
        actions.push({ action: 'TRADE', confidence: 0.80, reason: `iUSD redeem→USDC→SUI + purchase`, route: 'iusd-redeem' });
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
          // Pass the Pyth SUI price so the DO bills the user
          // against the same number /api/infer saw. CoinGecko
          // fallback inside the DO would otherwise drift and
          // leave ultron out-of-pocket on the pre-fund spread.
          suiPriceUsd: suiPrice,
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

// ── Solana RPC proxy — relays browser JSON-RPC calls to Helius ──────
// Why: api.mainnet-beta.solana.com 403s on most browser origins and
// publicnode is rate-limited. Sui.ski has a Helius developer plan
// stashed in HELIUS_API_KEY, but we can't ship the key to the
// browser. This endpoint proxies JSON-RPC POST bodies to Helius with
// the key server-side so the client just talks to same-origin.
//
// Read-only scope: we don't accept methods that cost money (like
// sendTransaction) through this proxy — those still route via our
// own signer paths. Balance/account/tx lookups are what the browser
// actually needs.
const SOL_RPC_ALLOWED_METHODS = new Set([
  'getBalance',
  'getAccountInfo',
  'getMultipleAccounts',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getProgramAccounts',
  'getSignaturesForAddress',
  'getTransaction',
  'getSignatureStatuses',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getSlot',
  'getEpochInfo',
  'getHealth',
  'getBlockHeight',
  'getFeeForMessage',
  'simulateTransaction',
]);
app.post('/api/sol-rpc', async (c) => {
  try {
    const blocked = await rpcRateCheck(c, 'sol-rpc');
    if (blocked) return blocked;
    if (!c.env.HELIUS_API_KEY) return c.json({ error: 'Helius key not configured' }, 500);
    const body = await c.req.json() as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    if (!body || typeof body.method !== 'string') {
      return c.json({ error: 'Invalid JSON-RPC body' }, 400);
    }
    if (!SOL_RPC_ALLOWED_METHODS.has(body.method)) {
      return c.json({ error: `Method ${body.method} not allowed on proxy` }, 403);
    }
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${c.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params ?? [] }),
    });
    const j = await r.json();
    // Mirror the upstream response verbatim so callers that parse
    // raw JSON-RPC shapes don't need any special-casing.
    return c.json(j as Record<string, unknown>, r.status as any, {
      'cache-control': 'no-store',
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Cross-chain balance proxies — IKA dWallet-derived addresses ─────
// Browser hits these to populate the BTC/ETH/TRON chips in the idle
// overlay squids row. Each endpoint returns raw on-chain amounts;
// browser combines with CoinGecko prices for USD totals.

// BTC — mempool.space (free, no key). Sums confirmed + unconfirmed.
// Edge-cache wrapper: CF Workers doesn't honor cache-control for
// Worker responses automatically, so explicitly put/get the cache for
// hot read-only endpoints. 30s TTL across balance endpoints matches
// the cache-control hint and absorbs wallet-UI refresh polling.
async function edgeCacheBalance(c: Context, ttlSec: number, handler: () => Promise<Response>): Promise<Response> {
  const url = new URL(c.req.url);
  const cacheKey = new Request(`https://cache.internal${url.pathname}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const fresh = await handler();
  if (fresh.ok) {
    const clone = fresh.clone();
    const cached = new Response(clone.body, {
      status: clone.status,
      headers: { ...Object.fromEntries(clone.headers), 'cache-control': `public, max-age=${ttlSec}` },
    });
    await cache.put(cacheKey, cached);
  }
  return fresh;
}

app.get('/api/balance/btc/:addr', async (c) => {
  const addr = c.req.param('addr');
  if (!/^(bc1|[13])[a-zA-Z0-9]{20,90}$/.test(addr)) return c.json({ error: 'invalid BTC addr' }, 400);
  return edgeCacheBalance(c, 30, async () => {
    try {
      const r = await fetch(`https://mempool.space/api/address/${addr}`);
      if (!r.ok) return c.json({ error: `mempool.space ${r.status}` }, 502);
      const j = await r.json() as { chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number }; mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } };
      const conf = (j.chain_stats?.funded_txo_sum ?? 0) - (j.chain_stats?.spent_txo_sum ?? 0);
      const unconf = (j.mempool_stats?.funded_txo_sum ?? 0) - (j.mempool_stats?.spent_txo_sum ?? 0);
      return c.json({ sats: conf + unconf }, 200, { 'cache-control': 'public,max-age=30' });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
});

// ETH (mainnet) — viem + Alchemy transport. Native wei + USDC raw (6dp).
const USDC_MAINNET: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
app.get('/api/balance/eth/:addr', async (c) => {
  const addr = c.req.param('addr');
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return c.json({ error: 'invalid ETH addr' }, 400);
  if (!c.env.ALCHEMY_ETH_URL) return c.json({ error: 'ALCHEMY_ETH_URL not configured' }, 500);
  return edgeCacheBalance(c, 30, async () => {
    try {
      const client = createPublicClient({ chain: mainnet, transport: http(c.env.ALCHEMY_ETH_URL) });
      const [wei, usdcRaw] = await Promise.all([
        client.getBalance({ address: addr as Address }),
        client.readContract({
          address: USDC_MAINNET,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [addr as Address],
        }),
      ]);
      return c.json({ wei: wei.toString(), usdcRaw: usdcRaw.toString() }, 200, { 'cache-control': 'public,max-age=30' });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
});

// TRON — TronGrid. Returns TRX (sun) + USDT-TRC20 raw.
// USDT-TRC20 contract: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
app.get('/api/balance/tron/:addr', async (c) => {
  const addr = c.req.param('addr');
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return c.json({ error: 'invalid TRON addr' }, 400);
  return edgeCacheBalance(c, 30, async () => {
    try {
      const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}`);
      if (!r.ok) return c.json({ error: `trongrid ${r.status}` }, 502);
      const j = await r.json() as { data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }> };
      const acct = j.data?.[0];
      const sun = acct?.balance ?? 0;
      let usdtRaw = '0';
      for (const entry of acct?.trc20 ?? []) {
        const v = entry['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'];
        if (v) { usdtRaw = v; break; }
      }
      return c.json({ sun, usdtRaw }, 200, { 'cache-control': 'public,max-age=30' });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
});

// SOL (mainnet) — Helius JSON-RPC. Returns SOL lamports + USDC raw (6dp).
// USDC-SPL mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
app.get('/api/balance/sol/:addr', async (c) => {
  const addr = c.req.param('addr');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return c.json({ error: 'invalid SOL addr' }, 400);
  if (!c.env.HELIUS_API_KEY) return c.json({ error: 'HELIUS_API_KEY not configured' }, 500);
  return edgeCacheBalance(c, 30, async () => {
    try {
      const url = `https://mainnet.helius-rpc.com/?api-key=${c.env.HELIUS_API_KEY}`;
      // Batch: getBalance (SOL) + getTokenAccountsByOwner filtered to USDC mint.
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr] },
          {
            jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner',
            params: [addr, { mint: USDC_SOL_MINT }, { encoding: 'jsonParsed' }],
          },
        ]),
      });
      if (!r.ok) return c.json({ error: `helius ${r.status}` }, 502);
      const arr = (await r.json()) as Array<{ result?: { value?: unknown } }>;
      const lamports = (arr[0]?.result?.value as number | undefined) ?? 0;
      const accounts = (arr[1]?.result?.value as Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> | undefined) ?? [];
      let usdcRaw = '0';
      for (const acc of accounts) {
        const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amt && amt !== '0') { usdcRaw = amt; break; }
      }
      return c.json({ lamports, usdcRaw }, 200, { 'cache-control': 'public,max-age=30' });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });
});

// ── UltronSigningAgent WASM smoke test (Registeel Toxic Spikes) ─────
// Spike endpoint to validate that the IKA WASM binary loads inside a
// Durable Object runtime. Proves/disproves the two claims from the
// project_ultron_do_signing feasibility study:
//   1. dwallet_mpc_wasm_bg.wasm imports + initializes in a Worker DO
//   2. A pure-crypto exported function runs without throwing
//
// If this returns {ok:true}, the full UltronSigningAgent plan unlocks
// (presign + decrypt + sign + submit all layer on top of the same
// initSync path).
app.get('/api/ultron/wasm-spike', async (c) => {
  try {
    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    );
    const res = await stub.fetch(new Request('https://ultron-signer/wasm-spike', {
      method: 'GET',
      headers: { 'x-partykit-room': 'ultron' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// Increment A of the full signing flow: read ultron's ed25519 dWallet
// via JSON-RPC + IkaClient inside the DO. If this returns the dWallet
// in Active state with a non-empty public_output, the transport path
// is proven and every subsequent signing step uses the same surface.
app.get('/api/ultron/read-dwallet', async (c) => {
  try {
    const curve = c.req.query('curve') || 'ed25519';
    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    );
    const res = await stub.fetch(new Request(`https://ultron-signer/read-dwallet?curve=${encodeURIComponent(curve)}`, {
      method: 'GET',
      headers: { 'x-partykit-room': 'ultron' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// Increment B of the signing flow: accept ultron's encrypted user share
// to transition the dWallet from AwaitingKeyHolderSignature → Active.
// Re-derives the deterministic seed from SHADE_KEEPER_PRIVATE_KEY,
// reconstructs UserShareEncryptionKeys, builds a PTB calling
// IkaTransaction.acceptEncryptedUserShare, signs with ultron's keypair,
// and submits via JSON-RPC. Admin-gated: this is a one-time mutation.
// Write ultron's cross-chain identity into the SUIAMI Roster. Chains
// come from the two IKA DKG ceremonies landed earlier in this session
// (ed25519 for SOL, secp256k1 for BTC/ETH) — first time ultron is
// registered roster-side with real IKA-derived addresses, not raw
// keypair re-encodings. Admin-gated via signed personal message;
// signs + submits server-side with ultron's own keypair so no browser
// session needs to be online. Ultron doing its own SUIAMI — finally.
app.post('/api/cache/ultron-roster', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    // No auth gate. The endpoint is self-referential: ultron writes its
    // own IKA-derived addresses to its own roster entry with its own
    // keypair. There's no path for a caller to extract value — the
    // worst case is someone rate-spamming ultron into paying trivial
    // gas for repeated identical writes. Accept {} body.
    try { await c.req.json(); } catch { /* body optional */ }

    const { Transaction } = await import('@mysten/sui/transactions');
    const { normalizeSuiAddress } = await import('@mysten/sui/utils');
    const { keccak_256 } = await import('@noble/hashes/sha3.js');
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');

    const keypair = ultronKeypair(c.env);
    const ultronSuiAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

    // IKA-derived addresses from the DKG ceremonies. Hardcoded because
    // ultron's DWalletCaps are static — any change would require a new
    // DKG. These exact bytes were verified via on-chain readouts earlier
    // in the session.
    const BTC_ULTRON = 'bc1qz5glnvhxacqva2cgydehqhgxjx22jru86gwgp9';
    const ETH_ULTRON = '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d';
    const SOL_ULTRON = 'GfVzGHiSPyTnX6bawnahJnUPXeASF6qKPd224VQws1DW';
    const name = 'ultron';
    const nameHash = Array.from(keccak_256(new TextEncoder().encode(name)));

    const ROSTER_PKG = '0x7bf4438feaf953e94b98dfc2aab0cf1aaad2250ee4e0fe87c9cc251965987de8';
    const ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';

    const tx = new Transaction();
    tx.setSender(ultronSuiAddr);
    tx.moveCall({
      package: ROSTER_PKG,
      module: 'roster',
      function: 'set_identity',
      arguments: [
        tx.object(ROSTER_OBJ),
        tx.pure.string(name),
        tx.pure.vector('u8', nameHash),
        tx.pure.vector('string', ['sui', 'btc', 'eth', 'sol']),
        tx.pure.vector('string', [ultronSuiAddr, BTC_ULTRON, ETH_ULTRON, SOL_ULTRON]),
        tx.pure.vector('address', []),
        tx.pure.string(''),
        tx.pure.vector('u8', []),
        tx.object('0x6'),
      ],
    });

    const transport = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });
    const txBytes = await tx.build({ client: transport as never });
    const { signature } = await keypair.signTransaction(txBytes);

    // Submit via the JSON-RPC fallback chain shade-executor uses.
    const rpcEndpoints = [
      'https://sui-rpc.publicnode.com',
      'https://sui-mainnet-endpoint.blockvision.org',
      'https://rpc.ankr.com/sui',
    ];
    let digest = '';
    let lastErr = '';
    for (const url of rpcEndpoints) {
      try {
        const txBytesB64 = btoa(String.fromCharCode(...txBytes));
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_executeTransactionBlock',
            params: [txBytesB64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
          }),
        });
        const j = await r.json() as {
          result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } };
          error?: { message?: string };
        };
        if (j.error) { lastErr = j.error.message ?? 'rpc error'; continue; }
        const effStatus = j.result?.effects?.status?.status;
        if (effStatus && effStatus !== 'success') {
          lastErr = j.result?.effects?.status?.error ?? 'effects failed';
          continue;
        }
        digest = j.result?.digest ?? '';
        if (digest) break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (!digest) return c.json({ error: `All RPC endpoints failed: ${lastErr}` }, 502);

    return c.json({
      ok: true,
      digest,
      ultronSuiAddr,
      chains: { sui: ultronSuiAddr, btc: BTC_ULTRON, eth: ETH_ULTRON, sol: SOL_ULTRON },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

app.post('/api/ultron/accept-share', async (c) => {
  try {
    const curve = c.req.query('curve') || 'ed25519';
    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    );
    const res = await stub.fetch(new Request(`https://ultron-signer/accept-share?curve=${encodeURIComponent(curve)}`, {
      method: 'POST',
      headers: { 'x-partykit-room': 'ultron' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// ── Aggron sync publish (Stone Edge shortcut) ──────────────────────
// PUT /api/aggron/publish
// Accepts raw ciphertext bytes and publishes them as a one-blob Walrus
// Quilt via @mysten/walrus SDK, signed by ultron (WAL paid from
// ultron's balance). This bypasses the dying HTTP publisher pool
// entirely — the SDK writes the blob via a Sui PTB directly against
// Walrus storage contracts.
//
// Returns { blobId } matching the legacy publisher response shape so
// existing client callers (e.g. encryptSquidsToWalrus) slot in with
// no other changes on the reader side (aggregators still work fine).
app.put('/api/aggron/publish', async (c) => {
  if (!hasUltronKey(c.env)) return c.json({ error: 'ultron key not configured' }, 503);
  try {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ error: 'empty body' }, 400);
    const identifier = c.req.query('id') || `aggron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const kind = c.req.query('kind') || 'misc';

    const { WalrusClient } = await import('@mysten/walrus');
    const { SuiJsonRpcClient } = await import('@mysten/sui/jsonRpc');
    const initWalrusWasm = (await import('@mysten/walrus-wasm')).default;
    // Pre-init the walrus-wasm with the in-bundle CompiledWasm module
    // — CF Workers disallow runtime WebAssembly.instantiate() of fetched
    // bytes, so we import the module statically (same pattern as IKA).
    const walrusWasmModule = (await import('./wasm/walrus_wasm_bg.wasm')).default;
    await initWalrusWasm({ module_or_path: walrusWasmModule as unknown as WebAssembly.Module });
    // GraphQL caps queries at 5000B; Walrus SDK's internal fetches
    // blow past that. JSON-RPC via PublicNode works in Workers.
    const sui = new SuiJsonRpcClient({ url: 'https://sui-rpc.publicnode.com' });
    const walrus = new WalrusClient({
      network: 'mainnet',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      suiClient: sui as any,
      // wasmUrl is ignored once initWalrusWasm has run above.
      wasmUrl: 'about:blank',
      // Upload relay — offloads the storage-node fan-out write. Worker
      // only needs to reach ONE relay host, not the whole committee.
      uploadRelay: {
        host: 'https://upload-relay.mainnet.walrus.space',
        // Relay charges a tip; cap it at 0.01 SUI so a misconfigured
        // relay can't drain ultron. Tip is paid in SUI at encoded-size rate.
        sendTip: { max: 10_000_000 },
      },
    });
    const signer = ultronKeypair(c.env);
    // epochs = how many Walrus epochs (~2 weeks each on mainnet) to
    // retain the blob. 12 ≈ 6 months. Re-publish to extend.
    // deletable = lets the owner reclaim the storage if needed.
    // Retry once — the most common failure is a gas-coin version
    // race when two publishes overlap. Wait ~2s, re-read coins, retry.
    const doPublish = () => walrus.writeQuilt({
      blobs: [{ contents: body, identifier, tags: { kind } }],
      signer,
      epochs: 12,
      deletable: true,
    });
    let result;
    try {
      result = await doPublish();
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      // Transient errors worth retrying: coin version, RPC hiccup,
      // upload-relay timeout, object not found (stale cache).
      const isTransient = /coin|version|object not found|timeout|fetch|502|503|ETIMEDOUT|ECONNRESET/i.test(msg);
      if (!isTransient) throw firstErr;
      console.warn(`[aggron/publish] transient, retrying once: ${msg}`);
      await new Promise(r => setTimeout(r, 2000));
      result = await doPublish();
    }
    return c.json({
      blobId: result.blobId,
      newlyCreated: { blobObject: { blobId: result.blobId } },
      quiltObjectId: result.blobObject?.id ?? null,
      patches: result.index.patches.map(p => ({
        identifier: p.identifier,
        patchId: p.patchId,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.warn('[aggron/publish]', msg, stack);
    return c.json({ error: msg, stack: stack?.split('\n').slice(0, 8) }, 500);
  }
});

// ── Aggron Mega Punch — IntentRegistry endpoints ───────────────────
// Maps sub-cent intent indexes (0000–9999) to SUIAMI identities per
// chain tag. Writes are admin-gated (requireUltronAdmin), reads are
// public — the registry is a routing table, not secret material.
//
// Scheme recap: a deposit to sui@ultron with dust tail `10000` decodes
// as chainTag=1 (eth), recipientIndex=0000 → IntentRegistry slot 0000
// for eth-tagged entries. See `src/server/sui-inbound.ts`.
type IntentRegisterBody = {
  intentIndex: number;
  suiamiName: string;
  chainTag: 0 | 1 | 2 | 3;
  adminAddress: string;
  signature: string;
  message: string;
};

type IntentRevokeBody = {
  intentIndex: number;
  adminAddress: string;
  signature: string;
  message: string;
};

function _intentRegistryStub(c: { env: Env }) {
  return c.env.IntentRegistry.get(c.env.IntentRegistry.idFromName('aggron:intent-registry')) as unknown as {
    register(p: { intentIndex: number; suiamiName: string; chainTag: 0|1|2|3; issuedBy: string }): Promise<unknown>;
    revoke(p: { intentIndex: number }): Promise<unknown>;
    lookup(p: { intentIndex: number }): Promise<unknown>;
    list(): Promise<unknown>;
  };
}

app.post('/api/aggron/intent/register', async (c) => {
  let body: IntentRegisterBody;
  try {
    body = await c.req.json<IntentRegisterBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { intentIndex, suiamiName, chainTag } = body;
  if (typeof intentIndex !== 'number' || !Number.isInteger(intentIndex) || intentIndex < 0 || intentIndex > 9999) {
    return c.json({ error: 'intentIndex must be integer 0..9999' }, 400);
  }
  if (typeof suiamiName !== 'string' || suiamiName.length === 0) {
    return c.json({ error: 'suiamiName required' }, 400);
  }
  if (typeof chainTag !== 'number' || chainTag < 0 || chainTag > 3) {
    return c.json({ error: 'chainTag must be 0..3' }, 400);
  }
  const denied = await requireUltronAdmin(c, body, {
    context: 'aggron-intent-register',
    messageFor: (b) => `aggron-intent-register:${b.intentIndex}:${b.suiamiName}:${todayUtc()}`,
  });
  if (denied) return denied;
  try {
    const stub = _intentRegistryStub(c);
    const result = await stub.register({
      intentIndex,
      suiamiName,
      chainTag,
      issuedBy: body.adminAddress.toLowerCase(),
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/api/aggron/intent/revoke', async (c) => {
  let body: IntentRevokeBody;
  try {
    body = await c.req.json<IntentRevokeBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { intentIndex } = body;
  if (typeof intentIndex !== 'number' || !Number.isInteger(intentIndex) || intentIndex < 0 || intentIndex > 9999) {
    return c.json({ error: 'intentIndex must be integer 0..9999' }, 400);
  }
  const denied = await requireUltronAdmin(c, body, {
    context: 'aggron-intent-revoke',
    messageFor: (b) => `aggron-intent-revoke:${b.intentIndex}:${todayUtc()}`,
  });
  if (denied) return denied;
  try {
    const stub = _intentRegistryStub(c);
    const result = await stub.revoke({ intentIndex });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/aggron/intent', async (c) => {
  try {
    const stub = _intentRegistryStub(c);
    const result = await stub.list();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/aggron/intent/:index', async (c) => {
  const raw = c.req.param('index');
  const intentIndex = Number(raw);
  if (!Number.isInteger(intentIndex) || intentIndex < 0 || intentIndex > 9999) {
    return c.json({ error: 'intentIndex must be integer 0..9999' }, 400);
  }
  try {
    const stub = _intentRegistryStub(c);
    const entry = await stub.lookup({ intentIndex });
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json({ entry });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Walrus publisher proxy ──────────────────────────────────────────
// PUT /api/walrus/publish
// Forwards the raw body to the first Walrus mainnet publisher that
// accepts it. Fixes client-side DNS blocks (ERR_NAME_NOT_RESOLVED) and
// CORS failures against the Walrus publisher pool. Worker edge has
// clean DNS + we control CORS, so the browser can always reach us.
app.put('/api/walrus/publish', async (c) => {
  const publishers = [
    'https://publisher.mainnet.walrus.mirai.cloud',
    'https://publisher.walrus-mainnet.h2o-nodes.com',
    'https://publisher.walrus.space',
    'https://sm-walrus-mainnet-publisher.stakesquid.com',
  ];
  const body = await c.req.arrayBuffer();
  const errors: string[] = [];
  for (const base of publishers) {
    try {
      const res = await fetch(`${base}/v1/blobs`, { method: 'PUT', body });
      if (res.ok) {
        const json = await res.json();
        return c.json(json);
      }
      errors.push(`${base}: HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return c.json({ error: `all Walrus publishers failed: ${errors.join('; ')}` }, 502);
});

// ── Weavile Assurance Move 6 — persist paymaster-signer dWallet ──────
// POST /api/admin/paymaster-signer
// Body: { dwalletId, ethAddress, adminAddress, signature, message }
// Admin-gated (must be one of the addresses in ADMIN_ADDRESSES). Stores
// the dWallet that signs paymasterAndData for Weavile stealth sweeps
// directly into UltronSigningAgent DO state — no code paste, no
// redeploy. Rotating the signer is just another call with a new pair.
app.post('/api/admin/paymaster-signer', async (c) => {
  const body = await c.req.json() as {
    dwalletId?: string;
    ethAddress?: string;
    adminAddress?: string;
    signature?: string;
    message?: string;
  };
  const { requireUltronAdmin, todayUtc } = await import('./ultron-policy.js');
  const denied = await requireUltronAdmin(c, body as Required<typeof body>, {
    context: 'set-paymaster-signer',
    messageFor: (b) => `set-paymaster-signer:${b.ethAddress}:${todayUtc()}`,
  });
  if (denied) return denied;
  try {
    if (!body.dwalletId || !body.ethAddress) {
      return c.json({ error: 'dwalletId and ethAddress required' }, 400);
    }
    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    ) as unknown as {
      setPaymasterSigner: (p: { dwalletId: string; ethAddress: string }) => Promise<{ ok: boolean; setAtMs: number }>;
    };
    const result = await stub.setPaymasterSigner({
      dwalletId: body.dwalletId,
      ethAddress: body.ethAddress,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// POST /api/ultron-postal/test-live-transfer — Icy Wind pt2.
// Admin-gated live transfer via UltronPostal.handleTransfer. Routes to
// the DO's `testLiveTransfer` callable, which builds + IKA-signs + submits
// a real Sui transfer to sui@<recipientSuiamiName>.
app.post('/api/ultron-postal/test-live-transfer', async (c) => {
  const body = await c.req.json() as {
    recipientSuiamiName?: string;
    amountMist?: string;
    coinType?: string;
    adminAddress?: string;
    signature?: string;
    message?: string;
  };
  const denied = await requireUltronAdmin(c, body as Required<typeof body>, {
    context: 'ultron-postal-test-live-transfer',
    messageFor: (b) => `ultron-postal-test-live-transfer:${b.recipientSuiamiName}:${b.amountMist}:${todayUtc()}`,
  });
  if (denied) return denied;
  try {
    if (!body.recipientSuiamiName || !body.amountMist) {
      return c.json({ error: 'recipientSuiamiName and amountMist required' }, 400);
    }
    const stub = c.env.UltronPostal.get(
      c.env.UltronPostal.idFromName('ultron-postal'),
    ) as unknown as {
      testLiveTransfer: (p: {
        recipientSuiamiName: string;
        amountMist: string;
        coinType?: string;
      }) => Promise<{ ok: boolean; digest?: string; error?: string }>;
    };
    const result = await stub.testLiveTransfer({
      recipientSuiamiName: body.recipientSuiamiName,
      amountMist: body.amountMist,
      ...(body.coinType ? { coinType: body.coinType } : {}),
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// GET /api/admin/paymaster-signer/ultron-default
// Returns ultron's existing secp256k1 dwalletId + its ETH address.
// The "Rumble Paymaster Squid" button hits this, then POSTs the
// result to /api/admin/paymaster-signer. No new DKG — ultron's squid
// already exists and is IKA-native; the separation between "funds
// dWallet" and "paymaster signer dWallet" is theatrical under
// 2PC-MPC.
app.get('/api/admin/paymaster-signer/ultron-default', async (c) => {
  try {
    // These mirror ULTRON_DWALLETS.secp256k1 in ultron-signing-agent.ts
    // and the ETH_ULTRON constant used elsewhere in index.ts. Kept as
    // a single source of truth in the signing agent; duplicated here
    // only for the initial GET surface — future rotations will read
    // from DO state.
    return c.json({
      dwalletId: '0xbb8bce5447722a4c6f5f64618164d8420551dfdbc7605afe279a85de1ebb6acb',
      ethAddress: '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d',
      note: 'ultron existing secp256k1 squid; reused as paymaster signer per 2026-04-18 design revision',
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// GET /api/admin/paymaster-signer — read current stored paymaster-signer.
// Not secret (only public addr + dwalletId), so no admin gate — useful
// for UI status. Returns null until setPaymasterSigner has been called.
app.get('/api/admin/paymaster-signer', async (c) => {
  try {
    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    ) as unknown as {
      getPaymasterSigner: () => Promise<{ dwalletId: string; ethAddress: string; setAtMs: number } | null>;
    };
    const result = await stub.getPaymasterSigner();
    return c.json(result ?? { unset: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// ── Leafeon Increment D glue: full signing chain end-to-end ──────────
// POST /api/ultron/sign
// Body: { curve: 'secp256k1'|'ed25519', message: '<hex>', hashScheme: 'KECCAK256'|'SHA256'|... }
// Chains four DO calls:
//   1. /request-presign  — Increment C PTB, returns { presignObjectId, presignCapId }
//   2. /poll-presign     — waits until presign state === Completed
//   3. /request-sign     — Increment D PTB, returns { signSessionId }
//   4. /poll-sign        — waits until sign state === Completed, parses signature
// Returns { ok, presignDigest, presignObjectId, signDigest, signSessionId, signatureHex, durationMs }.
//
// Admin-ish: this burns real IKA on every call, so it's POST + gated
// behind the same DO route guard as accept-share. Callers should already
// have ultron's dwallet in Active state (run /accept-share first if not).
app.post('/api/ultron/sign', async (c) => {
  const t0 = Date.now();
  try {
    const body = await c.req.json() as {
      curve?: 'ed25519' | 'secp256k1';
      message?: string;
      hashScheme?: string;
    };
    const curve = body.curve ?? 'secp256k1';
    const messageHex = (body.message ?? '').replace(/^0x/, '');
    const hashScheme = body.hashScheme ?? (curve === 'ed25519' ? 'SHA512' : 'KECCAK256');
    if (!messageHex) return c.json({ error: 'message (hex) required' }, 400);

    const stub = c.env.UltronSigningAgent.get(
      c.env.UltronSigningAgent.idFromName('ultron-spike'),
    );
    const headers = { 'content-type': 'application/json', 'x-partykit-room': 'ultron' };

    // 1. Request presign (Increment C)
    const presignRes = await stub.fetch(new Request(
      `https://ultron-signer/request-presign?curve=${encodeURIComponent(curve)}`,
      { method: 'POST', headers },
    ));
    const presignJson = await presignRes.json() as {
      ok?: boolean; error?: string; digest?: string;
      presignObjectId?: string; presignCapId?: string;
    };
    if (!presignJson.ok || !presignJson.presignObjectId || !presignJson.presignCapId) {
      return c.json({
        ok: false,
        step: 'request-presign',
        error: presignJson.error ?? 'request-presign missing ids',
        presignJson,
        durationMs: Date.now() - t0,
      }, 500);
    }
    const presignDigest = presignJson.digest;
    const presignObjectId = presignJson.presignObjectId;
    const presignCapId = presignJson.presignCapId;

    // 2. Poll presign until Completed
    const pollPresignRes = await stub.fetch(new Request(
      `https://ultron-signer/poll-presign?id=${encodeURIComponent(presignObjectId)}`,
      { method: 'GET', headers },
    ));
    const pollPresignJson = await pollPresignRes.json() as {
      ok?: boolean; error?: string; completed?: boolean; state?: string;
    };
    if (!pollPresignJson.ok || !pollPresignJson.completed) {
      return c.json({
        ok: false,
        step: 'poll-presign',
        error: pollPresignJson.error ?? 'presign not completed',
        presignDigest, presignObjectId,
        pollPresignJson,
        durationMs: Date.now() - t0,
      }, 500);
    }

    // 3. Request sign (Increment D)
    const signReqBody = JSON.stringify({ curve, presignObjectId, presignCapId, messageHex, hashScheme });
    const signRes = await stub.fetch(new Request(
      'https://ultron-signer/request-sign',
      { method: 'POST', headers, body: signReqBody },
    ));
    const signJson = await signRes.json() as {
      ok?: boolean; error?: string; digest?: string; signSessionId?: string;
    };
    if (!signJson.ok || !signJson.signSessionId) {
      return c.json({
        ok: false,
        step: 'request-sign',
        error: signJson.error ?? 'request-sign missing session id',
        presignDigest, presignObjectId,
        signJson,
        durationMs: Date.now() - t0,
      }, 500);
    }
    const signDigest = signJson.digest;
    const signSessionId = signJson.signSessionId;

    // 4. Poll sign until Completed and parse signature
    const pollSignRes = await stub.fetch(new Request(
      `https://ultron-signer/poll-sign?id=${encodeURIComponent(signSessionId)}&curve=${encodeURIComponent(curve)}`,
      { method: 'GET', headers },
    ));
    const pollSignJson = await pollSignRes.json() as {
      ok?: boolean; error?: string; completed?: boolean; signatureHex?: string; state?: string;
    };
    if (!pollSignJson.ok || !pollSignJson.signatureHex) {
      return c.json({
        ok: false,
        step: 'poll-sign',
        error: pollSignJson.error ?? 'sign not completed',
        presignDigest, presignObjectId,
        signDigest, signSessionId,
        pollSignJson,
        durationMs: Date.now() - t0,
      }, 500);
    }

    return c.json({
      ok: true,
      curve,
      presignDigest,
      presignObjectId,
      signDigest,
      signSessionId,
      signatureHex: pollSignJson.signatureHex,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      durationMs: Date.now() - t0,
    }, 500);
  }
});

// ── Probe: old sol@ultron balances ──────────────────────────────────
// Derives the legacy Solana address from SHADE_KEEPER_PRIVATE_KEY
// (raw ed25519 pubkey, base58-encoded) and reports SOL + SPL balances
// at that address. Used before running the sweep to see exactly what
// needs to move to the new IKA-derived sol@ultron.
//
// Read-only: the address itself is public info, so no auth needed.
app.get('/api/cache/ultron-sol-probe', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const { b58encode } = await import('./solana-spl.js');
    const keypair = ultronKeypair(c.env);
    const oldSolAddress = b58encode(keypair.getPublicKey().toRawBytes());

    const SOL_RPCS = [
      'https://sui-rpc.publicnode.com', // ignored, SOL only — keep list pure
    ];
    // Use the same Helius-first logic we use elsewhere — direct fetch keeps
    // the endpoint self-contained and avoids importing the full rpcCall helper.
    const helius = c.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${c.env.HELIUS_API_KEY}`
      : 'https://api.mainnet-beta.solana.com';

    const rpc = async (method: string, params: unknown[]) => {
      const r = await fetch(helius, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
      const j = await r.json() as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };

    const [solRes, tokenRes] = await Promise.all([
      rpc('getBalance', [oldSolAddress, { commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [
        oldSolAddress,
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]),
    ]);

    const solLamports = Number((solRes as { value?: number })?.value ?? 0);
    const tokenAccounts = ((tokenRes as { value?: Array<{ pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmountString: string } } } } } }> })?.value ?? [])
      .map((t) => ({
        ata: t.pubkey,
        mint: t.account.data.parsed.info.mint,
        amount: t.account.data.parsed.info.tokenAmount.amount,
        decimals: t.account.data.parsed.info.tokenAmount.decimals,
        uiAmount: t.account.data.parsed.info.tokenAmount.uiAmountString,
      }))
      .filter((t) => BigInt(t.amount) > 0n);

    return c.json({
      oldSolAddress,
      solLamports,
      solUi: solLamports / 1e9,
      tokenAccounts,
      totalTokens: tokenAccounts.length,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Split ultron's SUI into multiple small coins for presign payments ──
// IKA's request_presign Move function consumes a SUI Coin object as a
// payment arg by VALUE, which means it must be a real on-chain object
// rather than the output of splitCoins (the SDK's payment helper rejects
// splitCoins outputs as "Unused result without the drop ability"). To
// keep ultron's main SUI coin intact for gas, we split it into a handful
// of small coins ahead of time so each presign call has its own dedicated
// payment coin. Idempotent: running it again just creates more small
// coins. No auth needed — this only rearranges ultron's own SUI.
app.post('/api/cache/ultron-split-sui', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json().catch(() => ({})) as { count?: number; sizeMist?: string };
    const count = Math.max(1, Math.min(20, Number(body.count ?? 5)));
    const sizeMist = BigInt(body.sizeMist ?? '50000000'); // default 0.05 SUI per piece

    const { Transaction } = await import('@mysten/sui/transactions');
    const { normalizeSuiAddress, toBase64 } = await import('@mysten/sui/utils');
    const keypair = ultronKeypair(c.env);
    const ultronAddr = normalizeSuiAddress(keypair.toSuiAddress());

    // Pull ultron's largest SUI coin to use as gas via raw JSON-RPC.
    const coinsRes = await fetch('https://sui-rpc.publicnode.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'suix_getCoins',
        params: [ultronAddr, '0x2::sui::SUI'],
      }),
    });
    const coinsJson = await coinsRes.json() as { result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> } };
    const coins = (coinsJson.result?.data ?? []).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
    if (coins.length === 0) return c.json({ error: 'ultron has no SUI coins' }, 400);
    const gasCoin = coins[0];

    // Reference price for build via raw JSON-RPC.
    const gasPriceRes = await fetch('https://sui-rpc.publicnode.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getReferenceGasPrice', params: [] }),
    });
    const gasPriceJson = await gasPriceRes.json() as { result?: string };
    const gasPrice = BigInt(gasPriceJson.result ?? '1000');

    // Build the split tx. setGasPayment + setGasPrice + setGasBudget
    // pin everything explicitly so the SDK doesn't try to do a network
    // discovery round trip during build (which is what was failing
    // through the GraphQL transport).
    const tx = new Transaction();
    tx.setSender(ultronAddr);
    tx.setGasPayment([{ objectId: gasCoin.coinObjectId, version: gasCoin.version, digest: gasCoin.digest }]);
    tx.setGasPrice(gasPrice);
    tx.setGasBudget(50_000_000n); // 0.05 SUI for split tx
    const splits: Array<bigint> = [];
    for (let i = 0; i < count; i++) splits.push(sizeMist);
    const newCoins = tx.splitCoins(tx.gas, splits.map(s => tx.pure.u64(s)));
    const recipients: unknown[] = [];
    for (let i = 0; i < count; i++) recipients.push(newCoins[i]);
    tx.transferObjects(recipients as never[], tx.pure.address(ultronAddr));
    const txBytes = await tx.build();
    const { signature } = await keypair.signTransaction(txBytes);
    // Submit via JSON-RPC executeTransactionBlock — the blessed exception
    // for tx submit per CLAUDE.md.
    const submitRes = await fetch('https://sui-rpc.publicnode.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sui_executeTransactionBlock',
        params: [toBase64(txBytes), [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const submitJson = await submitRes.json() as { result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } }; error?: { message?: string } };
    if (submitJson.error) {
      return c.json({ error: `submit failed: ${submitJson.error.message}` }, 500);
    }
    const status = submitJson.result?.effects?.status?.status;
    if (status !== 'success') {
      return c.json({ error: `tx status ${status}: ${submitJson.result?.effects?.status?.error ?? ''}` }, 500);
    }
    return c.json({
      ok: true,
      digest: submitJson.result?.digest ?? '',
      ultronAddr,
      count,
      sizeMist: sizeMist.toString(),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// ── Ultron iUSD transfer ─────────────────────────────────────────────
// One-shot endpoint that signs as ultron and transfers iUSD to a
// recipient. Used to return the 90.75 iUSD loss from the orphan
// forwardToAddress mistake back to the t2000 treasury — ultron only
// holds ~$43, so this is a partial repayment. The remainder is
// blocked on iUSD mint headroom which is currently at 0 (see
// /api/cache/realize-yield and contracts/iusd/sources/iusd.move
// EInsufficientCollateral abort).
app.post('/api/cache/ultron-transfer-iusd', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json().catch(() => ({})) as { recipient?: string; amountMist?: string };
    if (!body.recipient) return c.json({ error: 'recipient required' }, 400);

    const { Transaction } = await import('@mysten/sui/transactions');
    const { normalizeSuiAddress, toBase64 } = await import('@mysten/sui/utils');
    const keypair = ultronKeypair(c.env);
    const ultronAddr = normalizeSuiAddress(keypair.toSuiAddress());
    const recipient = normalizeSuiAddress(body.recipient);

    const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';

    // Pull ultron's SUI coins (for gas) + iUSD coins.
    const rpcCall = async (method: string, params: unknown[]) => {
      const r = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return r.json() as Promise<{ result?: unknown; error?: { message?: string } }>;
    };

    const suiJ = await rpcCall('suix_getCoins', [ultronAddr, '0x2::sui::SUI']) as { result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> } };
    const suiCoins = (suiJ.result?.data ?? []).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
    if (suiCoins.length === 0) return c.json({ error: 'ultron has no SUI coins for gas' }, 400);
    const gasCoin = suiCoins[0];

    const iusdJ = await rpcCall('suix_getCoins', [ultronAddr, IUSD_TYPE]) as { result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> } };
    const iusdCoins = iusdJ.result?.data ?? [];
    if (iusdCoins.length === 0) return c.json({ error: 'ultron has no iUSD' }, 400);
    const totalIusdMist = iusdCoins.reduce((acc, c2) => acc + BigInt(c2.balance), 0n);
    const amountMist = body.amountMist ? BigInt(body.amountMist) : totalIusdMist;
    if (amountMist > totalIusdMist) return c.json({ error: `amount ${amountMist} > available ${totalIusdMist}` }, 400);

    const gasPriceJ = await rpcCall('suix_getReferenceGasPrice', []) as { result?: string };
    const gasPrice = BigInt(gasPriceJ.result ?? '1000');

    const tx = new Transaction();
    tx.setSender(ultronAddr);
    tx.setGasPayment([{ objectId: gasCoin.coinObjectId, version: gasCoin.version, digest: gasCoin.digest }]);
    tx.setGasPrice(gasPrice);
    tx.setGasBudget(50_000_000n);

    // Pass every iUSD coin as an owned object ref. Merge into the
    // first then split if we're not sending the full amount, else
    // just merge + transferObjects the merged coin to recipient.
    const iusdRefs = iusdCoins.map(cc => tx.objectRef({ objectId: cc.coinObjectId, version: cc.version, digest: cc.digest }));
    const primary = iusdRefs[0];
    if (iusdRefs.length > 1) {
      tx.mergeCoins(primary, iusdRefs.slice(1));
    }
    if (amountMist === totalIusdMist) {
      tx.transferObjects([primary], tx.pure.address(recipient));
    } else {
      const [toSend] = tx.splitCoins(primary, [tx.pure.u64(amountMist)]);
      tx.transferObjects([toSend], tx.pure.address(recipient));
    }

    const txBytes = await tx.build();
    const { signature } = await keypair.signTransaction(txBytes);
    const submitJ = await rpcCall('sui_executeTransactionBlock', [toBase64(txBytes), [signature], { showEffects: true, showBalanceChanges: true }, 'WaitForLocalExecution']) as { result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } }; error?: { message?: string } };
    if (submitJ.error) return c.json({ error: `submit failed: ${submitJ.error.message}` }, 500);
    const status = submitJ.result?.effects?.status?.status;
    if (status !== 'success') return c.json({ error: `tx status ${status}: ${submitJ.result?.effects?.status?.error ?? ''}` }, 500);
    return c.json({
      ok: true,
      digest: submitJ.result?.digest ?? '',
      ultronAddr,
      recipient,
      amountMist: amountMist.toString(),
      amountUsd: Number(amountMist) / 1e9,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// ── Volcarodon PSM round-trip smoke test (ultron-signed) ──────────────
// Mints a tiny amount of USDC → iUSD via psm::mint_from_usdc, waits for
// propagation, then burns the minted iUSD back via psm::burn_for_usdc.
// Uses ultron's keeper key (SHADE_KEEPER_PRIVATE_KEY) so the round-trip
// happens without any user signature. Returns both digests, the reserve
// state before and after, and the net cost in USDC for the two 50 bps
// fees. Default amount is 10,000 USDC mist ($0.01). Not admin-gated —
// ultron is funding the test itself; worst case it loses ~0.01% of its
// $0.371 USDC balance per call.
app.post('/api/cache/psm-smoke', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json().catch(() => ({})) as { amountMist?: string };

    const { Transaction } = await import('@mysten/sui/transactions');
    const { normalizeSuiAddress, toBase64 } = await import('@mysten/sui/utils');

    const keypair = ultronKeypair(c.env);
    const ultronAddr = normalizeSuiAddress(keypair.toSuiAddress());

    const PSM_PKG     = '0xe0e0113e44c38ef5cfbbac826cfff0cf0438109b0358b0039aca8d183065f5af';
    const PSM_RESERVE = '0x62fcd184ef68d7267e4cf45f8af5ff7f23511c4741f26674875e691389ca264c';
    const PSM_RESERVE_INITIAL_SHARED_VERSION = 843442664;
    const IUSD_TYPE   = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
    const USDC_TYPE   = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    const TYPE_ARGS   = [IUSD_TYPE, USDC_TYPE];

    const rpcCall = async (method: string, params: unknown[]) => {
      const r = await fetch('https://sui-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return r.json() as Promise<{ result?: any; error?: { message?: string } }>;
    };

    // Snapshot reserve state before.
    const reserveBeforeJ = await rpcCall('sui_getObject', [PSM_RESERVE, { showContent: true }]);
    const rbFields = reserveBeforeJ.result?.data?.content?.fields;
    const reserveBefore = {
      sBalanceMist:    String(rbFields?.s_balance ?? '0'),
      totalTMinted:    String(rbFields?.total_t_minted ?? '0'),
      totalTBurned:    String(rbFields?.total_t_burned ?? '0'),
      totalSIn:        String(rbFields?.total_s_in ?? '0'),
      totalSOut:       String(rbFields?.total_s_out ?? '0'),
      feeBps:          Number(rbFields?.fee_bps ?? '50'),
    };
    const feeBps = reserveBefore.feeBps;

    const usdcAmountMist = BigInt(body.amountMist ?? '10000'); // $0.01 default

    // Pull ultron's SUI + USDC.
    const suiJ = await rpcCall('suix_getCoins', [ultronAddr, '0x2::sui::SUI']);
    const suiCoins = (suiJ.result?.data ?? []).sort((a: any, b: any) => Number(BigInt(b.balance) - BigInt(a.balance)));
    if (!suiCoins.length) return c.json({ error: 'ultron has no SUI for gas' }, 400);

    const usdcJ = await rpcCall('suix_getCoins', [ultronAddr, USDC_TYPE]);
    const usdcCoins = (usdcJ.result?.data ?? []) as Array<{ coinObjectId: string; version: string; digest: string; balance: string }>;
    if (!usdcCoins.length) return c.json({ error: 'ultron has no USDC' }, 400);
    const totalUsdc = usdcCoins.reduce((s, c2) => s + BigInt(c2.balance), 0n);
    if (usdcAmountMist > totalUsdc) return c.json({ error: `requested ${usdcAmountMist} > ultron USDC ${totalUsdc}` }, 400);

    const gasPriceJ = await rpcCall('suix_getReferenceGasPrice', []);
    const gasPrice = BigInt(gasPriceJ.result ?? '1000');

    // ─── Step 1: MINT ─────────────────────────────────────────────
    const mintTx = new Transaction();
    mintTx.setSender(ultronAddr);
    mintTx.setGasPayment([{ objectId: suiCoins[0].coinObjectId, version: suiCoins[0].version, digest: suiCoins[0].digest }]);
    mintTx.setGasPrice(gasPrice);
    mintTx.setGasBudget(50_000_000n);

    const usdcRefs = usdcCoins.map(cc => mintTx.objectRef({ objectId: cc.coinObjectId, version: cc.version, digest: cc.digest }));
    const primaryUsdc = usdcRefs[0];
    if (usdcRefs.length > 1) mintTx.mergeCoins(primaryUsdc, usdcRefs.slice(1));
    const [usdcContribution] = mintTx.splitCoins(primaryUsdc, [mintTx.pure.u64(usdcAmountMist)]);

    // Mirror the on-chain convert_s_to_t math: base = usdc * 1000
    // (scaling to 9 decimals), then minus fee_bps. Slippage floor at
    // 10 bps below contract output to absorb any rounding.
    const expectedIusdMist = (usdcAmountMist * 1000n * BigInt(10000 - feeBps)) / 10000n;
    const minIusdOut = (expectedIusdMist * 9990n) / 10000n;

    mintTx.moveCall({
      target: `${PSM_PKG}::psm::mint_from_usdc`,
      typeArguments: TYPE_ARGS,
      arguments: [
        mintTx.sharedObjectRef({ objectId: PSM_RESERVE, initialSharedVersion: PSM_RESERVE_INITIAL_SHARED_VERSION, mutable: true }),
        usdcContribution,
        mintTx.pure.u64(minIusdOut),
      ],
    });

    const mintBytes = await mintTx.build();
    const { signature: mintSig } = await keypair.signTransaction(mintBytes);
    const mintSubmitJ = await rpcCall('sui_executeTransactionBlock', [toBase64(mintBytes), [mintSig], { showEffects: true, showBalanceChanges: true, showEvents: true }, 'WaitForLocalExecution']);
    if (mintSubmitJ.error) return c.json({ error: `mint submit failed: ${mintSubmitJ.error.message}` }, 500);
    const mintStatus = mintSubmitJ.result?.effects?.status?.status;
    if (mintStatus !== 'success') {
      return c.json({ error: `mint tx status ${mintStatus}: ${mintSubmitJ.result?.effects?.status?.error ?? ''}` }, 500);
    }
    const mintDigest = mintSubmitJ.result?.digest ?? '';

    // Propagation — give the indexer a beat before re-fetching coins.
    await new Promise(r => setTimeout(r, 2000));

    // ─── Step 2: BURN the minted iUSD back ───────────────────────
    const suiJ2 = await rpcCall('suix_getCoins', [ultronAddr, '0x2::sui::SUI']);
    const suiCoins2 = (suiJ2.result?.data ?? []).sort((a: any, b: any) => Number(BigInt(b.balance) - BigInt(a.balance)));
    if (!suiCoins2.length) return c.json({ error: 'ultron lost all SUI between mint and burn (impossible)' }, 500);

    const iusdJ = await rpcCall('suix_getCoins', [ultronAddr, IUSD_TYPE]);
    const iusdCoins = (iusdJ.result?.data ?? []) as Array<{ coinObjectId: string; version: string; digest: string; balance: string }>;
    if (!iusdCoins.length) return c.json({ error: 'mint succeeded but no iUSD visible — indexer lag?', mintDigest }, 500);
    const totalIusd = iusdCoins.reduce((s, c2) => s + BigInt(c2.balance), 0n);

    // Only burn the amount the mint produced, in case ultron had any
    // stray iUSD from another path we don't want to touch.
    const burnAmount = expectedIusdMist > totalIusd ? totalIusd : expectedIusdMist;

    const burnTx = new Transaction();
    burnTx.setSender(ultronAddr);
    burnTx.setGasPayment([{ objectId: suiCoins2[0].coinObjectId, version: suiCoins2[0].version, digest: suiCoins2[0].digest }]);
    burnTx.setGasPrice(gasPrice);
    burnTx.setGasBudget(50_000_000n);

    const iusdRefs = iusdCoins.map(cc => burnTx.objectRef({ objectId: cc.coinObjectId, version: cc.version, digest: cc.digest }));
    const primaryIusd = iusdRefs[0];
    if (iusdRefs.length > 1) burnTx.mergeCoins(primaryIusd, iusdRefs.slice(1));
    const [iusdContribution] = burnTx.splitCoins(primaryIusd, [burnTx.pure.u64(burnAmount)]);

    const expectedUsdcOut = (burnAmount / 1000n) * BigInt(10000 - feeBps) / 10000n;
    const minUsdcOut = (expectedUsdcOut * 9990n) / 10000n;

    burnTx.moveCall({
      target: `${PSM_PKG}::psm::burn_for_usdc`,
      typeArguments: TYPE_ARGS,
      arguments: [
        burnTx.sharedObjectRef({ objectId: PSM_RESERVE, initialSharedVersion: PSM_RESERVE_INITIAL_SHARED_VERSION, mutable: true }),
        iusdContribution,
        burnTx.pure.u64(minUsdcOut),
      ],
    });

    const burnBytes = await burnTx.build();
    const { signature: burnSig } = await keypair.signTransaction(burnBytes);
    const burnSubmitJ = await rpcCall('sui_executeTransactionBlock', [toBase64(burnBytes), [burnSig], { showEffects: true, showBalanceChanges: true, showEvents: true }, 'WaitForLocalExecution']);
    if (burnSubmitJ.error) return c.json({ error: `burn submit failed: ${burnSubmitJ.error.message}`, mintDigest }, 500);
    const burnStatus = burnSubmitJ.result?.effects?.status?.status;
    if (burnStatus !== 'success') {
      return c.json({ error: `burn tx status ${burnStatus}: ${burnSubmitJ.result?.effects?.status?.error ?? ''}`, mintDigest }, 500);
    }
    const burnDigest = burnSubmitJ.result?.digest ?? '';

    // Snapshot reserve state after.
    await new Promise(r => setTimeout(r, 1500));
    const reserveAfterJ = await rpcCall('sui_getObject', [PSM_RESERVE, { showContent: true }]);
    const raFields = reserveAfterJ.result?.data?.content?.fields;
    const reserveAfter = {
      sBalanceMist:    String(raFields?.s_balance ?? '0'),
      totalTMinted:    String(raFields?.total_t_minted ?? '0'),
      totalTBurned:    String(raFields?.total_t_burned ?? '0'),
      totalSIn:        String(raFields?.total_s_in ?? '0'),
      totalSOut:       String(raFields?.total_s_out ?? '0'),
      collectedFeeMist: String(raFields?.collected_fee ?? '0'),
    };

    const netCostMist = usdcAmountMist - BigInt(reserveAfter.totalSOut) + BigInt(reserveBefore.totalSOut);
    return c.json({
      ok: true,
      ultronAddr,
      mintDigest,
      burnDigest,
      usdcInMist: usdcAmountMist.toString(),
      iusdMintedMist: expectedIusdMist.toString(),
      iusdBurnedMist: burnAmount.toString(),
      usdcOutMist: expectedUsdcOut.toString(),
      netCostUsdcMist: netCostMist.toString(),
      netCostUsd: Number(netCostMist) / 1e6,
      feeBps,
      reserveBefore,
      reserveAfter,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, 500);
  }
});

// ── Sweep old sol@ultron → new IKA-derived sol@ultron ─────────────────
// Drains all SOL + SPL balances from the legacy raw-keypair address
// (old sol@ultron = base58(suiPubkey)) to a recipient — in practice
// the new IKA-derived address from window.rumbleUltron('ed25519').
// The server signs with the same SHADE_KEEPER_PRIVATE_KEY because the
// old address is literally base58(pubkey(keeperKey)), so the same
// 32-byte private key is the Solana private key for that wallet.
//
// Admin-gated like /api/cache/rumble-ultron-seed.
app.post('/api/cache/sweep-sol-ultron', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json() as {
      recipient: string;
      adminAddress: string;
      signature: string;
      message: string;
    };
    if (!body.recipient) {
      return c.json({ error: 'Missing recipient' }, 400);
    }
    const denied = await requireUltronAdmin(c, body, {
      context: 'sweep-sol-ultron',
      messageFor: (b) => `sweep-sol-ultron:${b.recipient}:${todayUtc()}`,
    });
    if (denied) return denied;

    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { b58encode, b58decode, sweepSplAccount, sweepNativeSol } = await import('./solana-spl.js');
    type SolanaRpcConfig = import('./solana-spl.js').SolanaRpcConfig;

    const keypair = ultronKeypair(c.env);
    const ownerPub = keypair.getPublicKey().toRawBytes();
    const oldSolAddress = b58encode(ownerPub);
    const recipientPub = b58decode(body.recipient);
    if (recipientPub.length !== 32) {
      return c.json({ error: `recipient ${body.recipient} did not decode to 32 bytes` }, 400);
    }
    // Extract the raw 32-byte ed25519 secret so we can sign with noble.
    // SuiKeypair.getSecretKey() returns bech32; getKeyScheme/export paths
    // vary by version, so we use the bech32 decoder from @mysten/sui.
    const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
    const decoded = decodeSuiPrivateKey(c.env.SHADE_KEEPER_PRIVATE_KEY);
    if (decoded.scheme !== 'ED25519') {
      return c.json({ error: `Unsupported keeper scheme: ${decoded.scheme}` }, 500);
    }
    const rawSecret = decoded.secretKey;

    // The SPL sweep uses ed25519.sign(msg, 32-byte private key) which
    // @noble/curves/ed25519 accepts directly. Solana signature format is
    // the raw 64-byte ed25519 signature.
    const signFn = async (msg: Uint8Array): Promise<Uint8Array> => {
      return ed25519.sign(msg, rawSecret);
    };

    const helius = c.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${c.env.HELIUS_API_KEY}`
      : 'https://api.mainnet-beta.solana.com';
    const rpcConfig: SolanaRpcConfig = {
      rpcs: [
        helius,
        'https://sui-rpc.publicnode.com', // placeholder, not Solana — we could add a publicnode Solana if one exists
        'https://api.mainnet-beta.solana.com',
      ].filter(u => !u.includes('sui-rpc')),
      heliusApiKey: c.env.HELIUS_API_KEY,
    };

    // Step 1: query current balances (so we sweep exactly what's there).
    const rpc = async (method: string, params: unknown[]) => {
      const r = await fetch(helius, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
      const j = await r.json() as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const tokenRes = await rpc('getTokenAccountsByOwner', [
      oldSolAddress,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    const accounts = ((tokenRes as { value?: Array<{ pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }> })?.value ?? [])
      .map((t) => ({
        ata: t.pubkey,
        mint: t.account.data.parsed.info.mint,
        amount: BigInt(t.account.data.parsed.info.tokenAmount.amount),
        decimals: t.account.data.parsed.info.tokenAmount.decimals,
      }))
      .filter((t) => t.amount > 0n);

    const swept: Array<{ mint: string; amount: string; decimals: number; signature: string; destAta: string }> = [];
    // Step 2: sweep each SPL token account.
    for (const acc of accounts) {
      try {
        const res = await sweepSplAccount(
          signFn,
          ownerPub,
          recipientPub,
          b58decode(acc.ata),
          b58decode(acc.mint),
          acc.amount,
          acc.decimals,
          rpcConfig,
        );
        swept.push({
          mint: acc.mint,
          amount: acc.amount.toString(),
          decimals: acc.decimals,
          signature: res.signature,
          destAta: res.destAta,
        });
      } catch (err) {
        console.error(`[sweep-sol-ultron] SPL sweep failed for ${acc.mint}:`, err);
        return c.json({
          error: `SPL sweep failed for ${acc.mint}: ${err instanceof Error ? err.message : String(err)}`,
          partial: swept,
        }, 500);
      }
    }

    // Step 3: wait for SPL txs to settle + rent refunds to land, then drain SOL.
    await new Promise((r) => setTimeout(r, accounts.length > 0 ? 6000 : 0));
    const solRes = await rpc('getBalance', [oldSolAddress, { commitment: 'confirmed' }]);
    const lamports = BigInt((solRes as { value?: number })?.value ?? 0);
    let solSweep: { signature: string; drained: string } | null = null;
    try {
      const drain = await sweepNativeSol(signFn, ownerPub, recipientPub, lamports, rpcConfig);
      solSweep = { signature: drain.signature, drained: drain.drained.toString() };
    } catch (err) {
      console.warn('[sweep-sol-ultron] SOL drain skipped:', err instanceof Error ? err.message : err);
    }

    return c.json({
      oldSolAddress,
      recipient: body.recipient,
      swept,
      solSweep,
    });
  } catch (err) {
    console.error('[sweep-sol-ultron] error:', err);
    return c.json({ error: String(err) }, 500);
  }
});

// ── Rumble Ultron seed — deterministic encryption-key seed for ultron's
//    IKA dWallet. Server derives from SHADE_KEEPER_PRIVATE_KEY so the
//    same seed can be re-derived later for autonomous ultron signing.
//
//    Admin-gated: caller must sign a personal message "rumble-ultron:
//    <ultronAddress>:<YYYY-MM-DD>" with an address in the allowlist.
//    The seed is effectively a signing credential — never expose without
//    proof the caller is authorized to act on ultron's behalf.
const ULTRON_ADDRESS = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';
app.post('/api/cache/rumble-ultron-seed', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json() as {
      curve: 'ed25519' | 'secp256k1';
      adminAddress: string;
      signature: string;
      message: string;
    };
    if (body.curve !== 'ed25519' && body.curve !== 'secp256k1') {
      return c.json({ error: 'curve must be ed25519 or secp256k1' }, 400);
    }
    const denied = await requireUltronAdmin(c, body, {
      context: 'rumble-ultron-seed',
      messageFor: () => `rumble-ultron:${ULTRON_ADDRESS}:${todayUtc()}`,
    });
    if (denied) return denied;
    // Derive the deterministic seed. The keeper key is the root secret;
    // the curve + ultron address discriminate per-dWallet so we can reuse
    // the same mechanism for secp256k1 later without clobbering ed25519.
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const keeperBytes = new TextEncoder().encode(c.env.SHADE_KEEPER_PRIVATE_KEY);
    const saltBytes = new TextEncoder().encode(`ultron-dkg:${body.curve}:${ULTRON_ADDRESS}`);
    const seedInput = new Uint8Array(keeperBytes.length + saltBytes.length);
    seedInput.set(keeperBytes, 0);
    seedInput.set(saltBytes, keeperBytes.length);
    const seed = sha256(seedInput);
    const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
    return c.json({ seedHex, ultronAddress: ULTRON_ADDRESS });
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

// ── Whelm Ultron (fungible phase) — relocate Ultron's coins into new dWallet ─
// First half of the Whelm Ultron ceremony. Admin-gated (same ADMIN_ADDRESSES
// allowlist as rumble-ultron-seed). Signs with the legacy Ultron key still
// in env. Transfers IKA / DEEP / NS / USDC / iUSD and all-but-0.05-SUI from
// old Ultron → new Ultron. Leaves DWalletCaps, BalanceManager, and iusd::
// RedeemRequest for the second half (re-encrypt ceremony).
app.post('/api/cache/whelm-ultron-fungibles', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    if (!c.env.SHADE_KEEPER_PRIVATE_KEY) return c.json({ error: 'Legacy SHADE_KEEPER_PRIVATE_KEY not present — nothing to sweep from' }, 400);

    const body = await c.req.json() as {
      adminAddress: string;
      signature: string;
      message: string;
      targetAddress: string;
      dryRun?: boolean;
    };
    if (!body.targetAddress || !/^0x[0-9a-fA-F]{64}$/.test(body.targetAddress)) {
      return c.json({ error: 'targetAddress must be 32-byte hex' }, 400);
    }
    const denied = await requireUltronAdmin(c, body, {
      context: 'whelm-ultron-fungibles',
      messageFor: (b) => `whelm-ultron-fungibles:${b.targetAddress.toLowerCase()}:${todayUtc()}`,
    });
    if (denied) return denied;

    // Build sweep using the LEGACY key explicitly — we want to sign with
    // old Ultron, even though ultronKeypair() now prefers the new one.
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const legacyKp = Ed25519Keypair.fromSecretKey(c.env.SHADE_KEEPER_PRIVATE_KEY);
    const oldUltron = normalizeSuiAddress(legacyKp.getPublicKey().toSuiAddress());
    const newUltron = body.targetAddress.toLowerCase();
    if (oldUltron.toLowerCase() === newUltron) {
      return c.json({ error: 'targetAddress equals legacy-derived Ultron address — nothing to sweep' }, 400);
    }

    const SUI_T = '0x2::sui::SUI';
    // Keep enough SUI on legacy to cover the sweep PTB's own gas budget
    // plus headroom. 0.05 SUI was too tight — any PTB touching 6 coin
    // types reserves > 0.05 SUI for gas, and `splitCoins(tx.gas, [total -
    // 0.05])` underflows at resolution time ("Insufficient coin balance
    // for operation"). 0.2 SUI leaves comfortable room for a wide PTB.
    const GAS_DUST_MIST = 200_000_000n;
    // Don't bother transferring SUI if what's left above gas dust is
    // dust itself — emits a split/transfer pair that can only trip the
    // resolver without moving meaningful value.
    const SUI_MIN_TRANSFER_MIST = 50_000_000n;
    const COIN_TYPES = [
      { type: '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA', label: 'IKA' },
      { type: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP', label: 'DEEP' },
      { type: '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS', label: 'NS' },
      { type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', label: 'USDC' },
      { type: '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD', label: 'iUSD' },
      { type: SUI_T, label: 'SUI' },
    ];

    // Use JSON-RPC for the coin inventory — GraphQL filter shape varies
    // by release and has returned empty results in the whelm path even
    // when balances are present (2026-04-17). JSON-RPC suix_getCoins is
    // schema-stable and consistent with the rest of the treasury path.
    const RPC = 'https://sui-rpc.publicnode.com';
    async function listCoins(coinType: string): Promise<Array<{ objectId: string; version: string; digest: string; balance: bigint }>> {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'suix_getCoins',
          params: [oldUltron, coinType, null, 200],
        }),
      });
      const j = await r.json() as { result?: { data?: Array<{ coinObjectId: string; version: string; digest: string; balance: string }> } };
      const arr = j?.result?.data ?? [];
      return arr.map((o) => ({
        objectId: o.coinObjectId,
        version: String(o.version),
        digest: o.digest,
        balance: BigInt(o.balance),
      }));
    }

    interface Plan { type: string; label: string; count: number; total: bigint; transfer: bigint; }
    const plans: Plan[] = [];
    const coinsByType = new Map<string, Awaited<ReturnType<typeof listCoins>>>();
    for (const c2 of COIN_TYPES) {
      const coins = await listCoins(c2.type);
      const total = coins.reduce((a, x) => a + x.balance, 0n);
      if (total === 0n) continue;
      const keep = c2.type === SUI_T ? GAS_DUST_MIST : 0n;
      const transfer = total > keep ? total - keep : 0n;
      // Skip SUI entirely if the amount above gas-dust isn't worth moving.
      // Prevents a split-from-gas that could underflow at resolution.
      if (c2.type === SUI_T && transfer < SUI_MIN_TRANSFER_MIST) continue;
      coinsByType.set(c2.type, coins);
      plans.push({ type: c2.type, label: c2.label, count: coins.length, total, transfer });
    }

    if (plans.length === 0) {
      // Include resolved addresses so the UI shows which address was
      // checked — catches the case where SHADE_KEEPER_PRIVATE_KEY has
      // been overwritten to the new key (then oldUltron == newUltron
      // and there's nothing to find).
      return c.json({
        ok: true,
        dryRun: true,
        oldUltron,
        newUltron,
        plans: [],
        message: oldUltron === newUltron
          ? `SHADE_KEEPER_PRIVATE_KEY derives to the NEW address (${oldUltron}) — it was likely overwritten during rotation. The original old-Ultron key is no longer on the Worker.`
          : `No fungible coins found on ${oldUltron}. Verify balances on-chain.`,
      });
    }

    const { Transaction } = await import('@mysten/sui/transactions');
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
    const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

    const tx = new Transaction();
    tx.setSender(oldUltron);
    for (const p of plans) {
      const coins = coinsByType.get(p.type)!;
      if (p.type === SUI_T) {
        if (p.transfer <= 0n) continue;
        const nonPrimary = coins.slice(1).map((x) => tx.object(x.objectId));
        if (nonPrimary.length > 0) tx.mergeCoins(tx.gas, nonPrimary);
        const [transferable] = tx.splitCoins(tx.gas, [tx.pure.u64(p.transfer.toString())]);
        tx.transferObjects([transferable], tx.pure.address(newUltron));
      } else {
        const [primary, ...rest] = coins;
        if (rest.length > 0) tx.mergeCoins(tx.object(primary.objectId), rest.map((x) => tx.object(x.objectId)));
        tx.transferObjects([tx.object(primary.objectId)], tx.pure.address(newUltron));
      }
    }

    const txBytes = await tx.build({ client: gql as never });
    const serialized = plans.map((p) => ({ ...p, total: p.total.toString(), transfer: p.transfer.toString() }));

    if (body.dryRun) {
      return c.json({ ok: true, dryRun: true, oldUltron, newUltron, plans: serialized, txBytesLen: txBytes.length });
    }

    const { signature } = await legacyKp.signTransaction(txBytes);
    const { toBase64: _toBase64 } = await import('@mysten/sui/utils');
    // Submit via JSON-RPC (PublicNode). gql.core.executeTransaction has
    // returned BCS schema mismatches on wide sweep PTBs — JSON-RPC is
    // schema-stable and handles the same payload cleanly.
    const execResp = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sui_executeTransactionBlock',
        params: [
          _toBase64(txBytes),
          [signature],
          { showEffects: true },
          'WaitForLocalExecution',
        ],
      }),
    });
    const execJson = await execResp.json() as {
      result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } };
      error?: { message?: string };
    };
    const digest = execJson?.result?.digest ?? '';
    const status = execJson?.result?.effects?.status?.status;
    const execError = execJson?.error?.message
      ?? (status && status !== 'success' ? execJson?.result?.effects?.status?.error : undefined);
    return c.json({ ok: !execError, digest, execError, oldUltron, newUltron, plans: serialized });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Whelm the squids — sweep owned DWalletCap objects from old Ultron to
// new Ultron in a single transferObjects PTB. Non-coin objects that
// aren't DWalletCaps (BalanceManager, RedeemRequest, etc.) are reported
// as "skipped" so the caller knows what stayed behind. Coins go through
// /api/cache/whelm-ultron-fungibles.
app.post('/api/cache/whelm-ultron-objects', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    if (!c.env.SHADE_KEEPER_PRIVATE_KEY) return c.json({ error: 'Legacy SHADE_KEEPER_PRIVATE_KEY not present — nothing to sweep from' }, 400);

    const body = await c.req.json() as {
      adminAddress: string;
      signature: string;
      message: string;
      targetAddress: string;
      dryRun?: boolean;
    };
    if (!body.targetAddress || !/^0x[0-9a-fA-F]{64}$/.test(body.targetAddress)) {
      return c.json({ error: 'targetAddress must be 32-byte hex' }, 400);
    }
    const denied = await requireUltronAdmin(c, body, {
      context: 'whelm-ultron-objects',
      messageFor: (b) => `whelm-ultron-objects:${b.targetAddress.toLowerCase()}:${todayUtc()}`,
    });
    if (denied) return denied;

    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const legacyKp = Ed25519Keypair.fromSecretKey(c.env.SHADE_KEEPER_PRIVATE_KEY);
    const oldUltron = normalizeSuiAddress(legacyKp.getPublicKey().toSuiAddress());
    const newUltron = body.targetAddress.toLowerCase();
    if (oldUltron.toLowerCase() === newUltron) {
      return c.json({ error: 'targetAddress equals legacy-derived Ultron address — nothing to sweep' }, 400);
    }

    const RPC = 'https://sui-rpc.publicnode.com';
    const allObjs: Array<{ objectId: string; type: string }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'suix_getOwnedObjects',
          params: [oldUltron, { options: { showType: true } }, cursor, 50],
        }),
      });
      const j = await r.json() as {
        result?: {
          data?: Array<{ data?: { objectId: string; type?: string } }>;
          hasNextPage?: boolean;
          nextCursor?: string;
        };
      };
      const page = j?.result?.data ?? [];
      for (const row of page) {
        const d = row?.data;
        if (!d?.type) continue;
        allObjs.push({ objectId: d.objectId, type: d.type });
      }
      if (!j?.result?.hasNextPage) break;
      cursor = j?.result?.nextCursor ?? null;
      if (!cursor) break;
    }

    // Sweep only DWalletCap — other types may lack `store` ability and
    // revert the whole PTB. Everything non-coin non-cap is surfaced as
    // "skipped" so the caller sees what stayed behind.
    const isCoin = (t: string) => t.startsWith('0x2::coin::Coin<');
    const isDWalletCap = (t: string) => /::coordinator_inner::DWalletCap$/.test(t);

    const sweep = allObjs.filter((o) => isDWalletCap(o.type));
    const skipped = allObjs.filter((o) => !isCoin(o.type) && !isDWalletCap(o.type));

    if (sweep.length === 0) {
      return c.json({
        ok: true,
        dryRun: true,
        oldUltron,
        newUltron,
        plans: [],
        skipped,
        message: `No DWalletCaps found on ${oldUltron}.${skipped.length ? ` ${skipped.length} other non-coin object(s) stayed behind.` : ''}`,
      });
    }

    const { Transaction } = await import('@mysten/sui/transactions');
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
    const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

    const tx = new Transaction();
    tx.setSender(oldUltron);
    tx.transferObjects(
      sweep.map((o) => tx.object(o.objectId)),
      tx.pure.address(newUltron),
    );
    const txBytes = await tx.build({ client: gql as never });

    if (body.dryRun) {
      return c.json({ ok: true, dryRun: true, oldUltron, newUltron, plans: sweep, skipped, txBytesLen: txBytes.length });
    }

    const { signature } = await legacyKp.signTransaction(txBytes);
    const { toBase64 } = await import('@mysten/sui/utils');
    const execResp = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sui_executeTransactionBlock',
        params: [toBase64(txBytes), [signature], { showEffects: true }, 'WaitForLocalExecution'],
      }),
    });
    const execJson = await execResp.json() as {
      result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } };
      error?: { message?: string };
    };
    const digest = execJson?.result?.digest ?? '';
    const status = execJson?.result?.effects?.status?.status;
    const execError = execJson?.error?.message
      ?? (status && status !== 'success' ? execJson?.result?.effects?.status?.error : undefined);
    return c.json({ ok: !execError, digest, execError, oldUltron, newUltron, plans: sweep, skipped });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
  const denied = await requireUltronSig(c, 'squid-stats');
  if (denied) return denied;
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

// Scan + batch-recall all ShieldedVaults where the caller is sender
app.post('/api/recall-vaults', async (c) => {
  if (!hasUltronKey(c.env)) return c.json({ error: 'Not configured' }, 503);
  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    const SHIELDED_TYPE = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782::shielded::ShieldedVault';
    const GQL = 'https://graphql.mainnet.sui.io/graphql';

    // Query ALL ShieldedVault objects on-chain (they're shared, so
    // we query by type). Filter client-side for sender == address.
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ objects(filter: { type: "${SHIELDED_TYPE}" }, first: 50) {
          nodes { address version digest owner { ... on Shared { initialSharedVersion } } asMoveObject { contents { json } } }
        } }`,
      }),
    });
    const gql = await res.json() as any;
    const nodes = gql?.data?.objects?.nodes ?? [];
    const addrLower = address.toLowerCase();
    const myVaults = nodes.filter((n: any) =>
      (n.asMoveObject?.contents?.json?.sender || '').toLowerCase() === addrLower
    );

    if (myVaults.length === 0) {
      return c.json({ vaults: [], count: 0, message: `No recallable vaults found (scanned ${nodes.length} total)` });
    }

    // Return ALL vaults with ISV + version + digest so the
    // client can build with explicit sharedObjectRef (skips
    // the GraphQL resolver's dry-run which breaks on recall's
    // ctx.sender() check).
    const vaultInfos: Array<{ objectId: string; balance: string; balanceSui: number; isv: number; version: string; digest: string }> = [];
    for (const v of myVaults) {
      const bal = v.asMoveObject?.contents?.json?.balance || '0';
      const isv = Number(v.owner?.initialSharedVersion || v.version);
      vaultInfos.push({ objectId: v.address, balance: bal, balanceSui: Number(bal) / 1e9, isv, version: String(v.version), digest: v.digest || '' });
    }

    const totalSui = vaultInfos.reduce((s, v) => s + v.balanceSui, 0);
    return c.json({
      vaults: vaultInfos,
      count: vaultInfos.length,
      totalSui,
      description: `Recall ${vaultInfos.length} vault${vaultInfos.length > 1 ? 's' : ''} (${totalSui.toFixed(4)} SUI)`,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Jupiter SOL→USDC swap on Solana (ultron signs)
app.post('/api/cache/jupiter-swap', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { lamports?: string; slippageBps?: number };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?jupiter-swap', {
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

// Recover iUSD/USDC from shared BM → send to recipient
app.post('/api/cache/recover-shared-bm', async (c) => {
  try {
    const body = await c.req.json() as { recipient: string; bmId?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?recover-shared-bm', {
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

// Shade proxy — ultron fronts the SUI deposit so user never needs SUI
app.post('/api/cache/shade-proxy', async (c) => {
  try {
    const body = await c.req.json() as { label: string; targetAddress: string; graceEndMs?: number };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-proxy', {
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

// Chansey v3 clean seeder — atomic one-PTB BalanceManager + ASK + BID + share
app.post('/api/cache/seed-iusd-pool-v3', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { iusdQtyMist?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?seed-iusd-pool-v3', {
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

// ── Sableye Lv.10 — Leer ──────────────────────────────────────────────
// Seal-encrypted counterparty set per wallet. The worker proxies the
// ciphertext blob to the owner's Chronicom DO as-is; only the browser
// (with Seal decrypt keys) ever sees plaintext. Consistent with the
// existing public chronicom surface — no new auth middleware.
app.get('/api/chronicom/sableye', async (c) => {
  const addr = c.req.query('addr');
  if (!addr) return c.json({ error: 'addr required' }, 400);
  const stub = c.env.Chronicom.get(c.env.Chronicom.idFromName(addr));
  const res = await stub.fetch(new Request('https://chronicom-do/sableye', {
    method: 'GET',
    headers: { 'x-partykit-room': addr },
  }));
  const text = await res.text();
  try { return c.json(JSON.parse(text), res.status as any); }
  catch { return c.json({ error: text }, 500); }
});

app.post('/api/chronicom/sableye', async (c) => {
  const addr = c.req.query('addr');
  if (!addr) return c.json({ error: 'addr required' }, 400);
  const body = await c.req.text();
  const stub = c.env.Chronicom.get(c.env.Chronicom.idFromName(addr));
  const res = await stub.fetch(new Request('https://chronicom-do/sableye', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-partykit-room': addr },
    body,
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

// ── Shade: cancel a StableShadeOrder whose salt is lost ──
// Owner-only (ultron). Refunds the full deposit back to ultron.
// Used when the preimage is unrecoverable and the order can't
// execute through the happy path.
app.post('/api/cache/shade-cancel-stable', async (c) => {
  try {
    const body = await c.req.json() as { objectId: string; noForward?: boolean; forwardToAddress?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-cancel-stable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, res.status as any); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Shade: reschedule a stable order that slipped through ──
// One-shot recovery path for StableShadeOrder objects that were
// created before the schedule-stable dispatch was wired in the
// shade-proxy. Calls the TreasuryAgents DO which verifies the
// salt is in state, resolves initialSharedVersion on-chain, and
// pushes scheduleStable() to the ShadeExecutorAgent.
app.post('/api/cache/shade-reschedule', async (c) => {
  try {
    const body = await c.req.json() as { objectId: string; initialSharedVersion?: number };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-reschedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, res.status as any); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── OpenCLOB: iUSD SPL on Solana ────────────────────────────────────
// Public read: returns the mainnet iUSD SPL mint address so the browser
// can fetch cross-chain iUSD balances against the user's Solana dWallet.
app.get('/api/cache/iusd-sol-mint', async (c) => {
  try {
    const res = await treasuryStub(c).fetch(new Request('https://treasury-do/?iusd-sol-mint', {
      method: 'GET',
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    const headers: Record<string, string> = { 'cache-control': 'public, max-age=300' };
    try { return c.json(JSON.parse(text), res.status as any, headers); }
    catch { return c.json({ error: text || 'unknown' }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post('/api/cache/create-iusd-sol-mint', async (c) => {
  try {
    // Self-derive ultron from the worker's own keeper key — the DO expects
    // callerAddress to equal its own ultron, and only the worker can compute
    // it. The DO method is idempotent (returns existing mint if already
    // created), so the endpoint is safe to leave public: worst case, a
    // caller races us for the one-time creation, and we wanted it anyway.
    if (!hasUltronKey(c.env)) {
      return c.json({ error: 'No keeper key configured' }, 500);
    }
    const kp = ultronKeypair(c.env);
    const ultronAddress = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());

    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?create-iusd-sol-mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({ callerAddress: ultronAddress }),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post('/api/cache/bam-mint-iusd-sol', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key configured' }, 500);
    const body = await c.req.json() as { recipientSolAddress: string; amount: string };
    const kp = ultronKeypair(c.env);
    const callerAddress = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?bam-mint-iusd-sol', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({ ...body, callerAddress }),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Magnemite: BAM mint v2 — intent-authorized, Vector-principles ──
// Applies the five Vector principles without requiring the Vector
// program on-chain:
//
//   1. Digest-bound intent — client commits to exact mint parameters
//      via SHA-256 of a canonical JSON serialization
//   2. Relayer/authority split — client signs the digest with their
//      wallet key, ultron verifies + relays but cannot modify
//   3. Hash-chain state progression — per-signer nonce advances
//      deterministically; prior seeds invalidate on replay
//   4. No pre-reveal — intent stays private until POST
//   5. Expiration primitive — intent.expiresMs enforced server-side
//
// Request: { intent: {...}, signature: "base64", publicKey: "base64" }
// Intent canonical shape (keys sorted alphabetically before hash):
//   { amount, expiresMs, mintAddress, nonce, recipientSolAddress }
app.post('/api/cache/bam-mint-v2', async (c) => {
  try {
    if (!hasUltronKey(c.env)) return c.json({ error: 'No keeper key' }, 500);
    const body = await c.req.json();

    // All five Vector principles live in the shared helper now.
    const verified = await verifyVectorIntent<{
      recipientSolAddress: string;
      amount: string;
      mintAddress: string;
    }>(c, body, ['recipientSolAddress', 'amount', 'mintAddress']);
    if (!verified.ok) return c.json({ error: verified.error }, verified.status as any);
    const { intent: i, digestHex } = verified;

    // Signature is valid, nonce is fresh, intent is not expired.
    // Ultron now acts as a pure relayer: calls the existing BAM mint
    // flow with no ability to alter recipient or amount.
    const kp = ultronKeypair(c.env);
    const callerAddress = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?bam-mint-iusd-sol', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({
        recipientSolAddress: i.recipientSolAddress,
        amount: i.amount,
        callerAddress,
      }),
    }));
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return c.json({ ...parsed, intentDigest: digestHex }, res.status as any);
    } catch { return c.json({ error: text }, 500); }
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

// Kamino USDC deposit — deposit idle Solana USDC to Kamino Lend (admin)
app.post('/api/cache/kamino-deposit-usdc', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { amount?: number };
    const amt = body.amount ? `&amount=${body.amount}` : '';
    const res = await authedTreasuryStub(c).fetch(new Request(`https://treasury-do/?kamino-deposit-usdc${amt}`, {
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

// Kamino positions — proof of reserves (public, read-only)
app.get('/api/cache/kamino-positions', async (c) => {
  try {
    const res = await treasuryStub(c).fetch(new Request('https://treasury-do/?kamino-positions', {
      headers: { 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
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
// Shuckle Lv.30 (#117) — attest ultron's live SUI+USDC balances to the
// iUSD Treasury via iusd::update_collateral. Unblocks iUSD mint by
// bringing the collateral ratio above 110%. Fires automatically every
// 5 min from the TreasuryAgents tick loop; this endpoint is the manual
// trigger for operators.
app.post('/api/cache/attest-collateral', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?attest-collateral', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Snorunt Lv.30 — directly attest a SOL-chain collateral delta under
// a separate 'SOL' asset key. Cross-chain collateral should never
// collide with the Sui-chain 'SUI' record that attestLiveCollateral
// owns. Takes { valueUsdCents } so the caller can be precise.
app.post('/api/cache/attest-sol-collateral', async (c) => {
  try {
    const body = await c.req.json() as { valueUsdCents: number };
    if (!body.valueUsdCents) return c.json({ error: 'valueUsdCents required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/attest-sol-collateral', {
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

// Snorunt Lv.30 — force-dispatch a known Solana deposit sig for
// deposits whose getSignaturesForAddress returns empty from the
// worker context (rate-limited RPC, etc.). Manual unblock path.
app.post('/api/cache/force-dispatch-sol', async (c) => {
  try {
    const body = await c.req.json() as { sig: string; lamports: number; suiAddress: string };
    if (!body.sig || !body.lamports || !body.suiAddress) return c.json({ error: 'sig, lamports, suiAddress required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/force-dispatch-sol', {
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

// Snorunt Lv.30 — debug endpoint to see what _watchSolDeposits sees.
// Ultron-sig gated (leaks internal watcher state).
app.post('/api/cache/debug-sol-watch', async (c) => {
  const denied = await requireUltronSig(c, 'debug-sol-watch');
  if (denied) return denied;
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/debug-sol-watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Snorunt Lv.30 — reset the sol-watcher's last-processed cursor.
// One-off fix for deposits stuck in pending because the old filter
// logic excluded a single sig instead of walking forward from it.
// Ultron-sig gated (mutates internal watcher state).
app.post('/api/cache/reset-sol-cursor', async (c) => {
  const denied = await requireUltronSig(c, 'reset-sol-cursor');
  if (denied) return denied;
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/reset-sol-cursor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Chansey v3 — redeem iUSD for USDC. User-initiated: they transfer
// iUSD to ultron via their own wallet, then POST their tx digest +
// address here. Server verifies the transfer and pays back the
// equivalent USDC from ultron's balance, 1:1 (no fee for v1).
app.post('/api/cache/redeem-iusd', async (c) => {
  try {
    const body = await c.req.json() as { suiAddress: string; suiTxDigest: string };
    if (!body.suiAddress || !body.suiTxDigest) return c.json({ error: 'suiAddress and suiTxDigest required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/redeem-iusd', {
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

// Chansey v3 — transfer ultron's iUSD to a recipient (credit path).
app.post('/api/cache/send-iusd', async (c) => {
  try {
    const body = await c.req.json() as { recipient: string; amountMist?: string };
    if (!body.recipient) return c.json({ error: 'recipient required' }, 400);
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/send-iusd', {
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

// ── Magneton: send-iusd v2 — intent-authorized ──────────────────────
// Same Vector principles as bam-mint-v2. Client signs a digest over
// { recipient, amountMist, nonce, expiresMs }; ultron verifies + relays
// to the existing treasury-do/send-iusd handler without any ability to
// mutate the recipient or amount.
app.post('/api/cache/send-iusd-v2', async (c) => {
  try {
    const body = await c.req.json();
    const verified = await verifyVectorIntent<{
      recipient: string;
      amountMist: string;
    }>(c, body, ['recipient', 'amountMist']);
    if (!verified.ok) return c.json({ error: verified.error }, verified.status as any);
    const { intent: i, digestHex } = verified;

    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/send-iusd', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
      body: JSON.stringify({
        recipient: i.recipient,
        amountMist: i.amountMist,
      }),
    }));
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return c.json({ ...parsed, intentDigest: digestHex }, res.status as any);
    } catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Debug mint endpoint — ultron-sig gated. Mints iUSD to an arbitrary
// recipient, so anyone who could call it unauthenticated could drain
// the mint authority. Locked on Probopass Lv.45.
app.post('/api/cache/debug-mint', async (c) => {
  const denied = await requireUltronSig(c, 'debug-mint');
  if (denied) return denied;
  try {
    const body = await c.req.json() as { usdCents: number; recipient?: string; pkg?: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/debug-mint', {
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

// Chansey Lv.40 (#76) — manual activity-yield mint trigger. The
// treasury mints iUSD up to its current surplus above 110% and sends
// it to ultron's wallet. No-op if senior <= 1.1 * supply. Also fires
// automatically on the 5-min tick loop after attestLiveCollateral.
app.post('/api/cache/realize-yield', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?realize-yield', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Shuckle Lv.30 stage 2 (#117) — zero out the phantom DUST collateral
// record that the old broken sweepDust path accumulated. One-shot
// cleanup; after this runs, attestLiveCollateral is the only writer.
app.post('/api/cache/zero-dust-record', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?zero-dust-record', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Shuckle Lv.30 stage 2 (#117) — recover the owned BalanceManager that
// was holding 34.75 iUSD + $28.99 USDC stranded. One PTB withdraws both
// balances, burns the recovered iUSD (reducing supply from 133.62 to
// 98.87), and sends the USDC back to ultron for the next attest cycle.
app.post('/api/cache/recover-owned-bm', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?recover-owned-bm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Shuckle Lv.30 (#117) — unwind ultron's sSUI (Scallop receipt) back
// to liquid SUI. One-time cleanup: ultron should not hold assets the
// collateral attestation doesn't understand.
app.post('/api/cache/unwind-ssui', async (c) => {
  try {
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?unwind-ssui', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Cancel a shade in Treasury DO state (user-initiated unshade)
app.post('/api/cache/shade-cancel', async (c) => {
  try {
    const body = await c.req.json() as { domain: string; holder: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-cancel', {
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

app.post('/api/cache/shade-purge-stale', async (c) => {
  try {
    const body = await c.req.json() as { domain: string; holder: string };
    const res = await authedTreasuryStub(c).fetch(new Request('https://treasury-do/?shade-purge-stale', {
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

// ── Helius webhook: general-purpose event receiver ──
// Auth-gated via HELIUS_WEBHOOK_SECRET. Logs payload and dispatches the
// set of touched accounts so downstream DOs can trigger balance refresh
// or event-aware behavior. Separate from /api/sol-webhook, which remains
// the treasury-specific deposit-detection entry point.
app.post('/api/helius/webhook', async (c) => {
  const secret = c.env.HELIUS_WEBHOOK_SECRET;
  if (secret) {
    const auth = c.req.header('Authorization') || '';
    const expected = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (expected !== secret) return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const payload = await c.req.json().catch(() => []) as Array<Record<string, unknown>>;
    const events = Array.isArray(payload) ? payload : [payload];
    const touched = new Set<string>();
    for (const ev of events) {
      const type = ev.type as string | undefined;
      const sig = ev.signature as string | undefined;
      // Enhanced Helius payload carries accountData[]; raw payload carries
      // transaction.message.accountKeys[]. Walk whichever is present.
      const accountData = ev.accountData as Array<{ account?: string }> | undefined;
      if (Array.isArray(accountData)) {
        for (const a of accountData) if (a.account) touched.add(a.account);
      }
      const nativeTransfers = ev.nativeTransfers as Array<{ fromUserAccount?: string; toUserAccount?: string }> | undefined;
      if (Array.isArray(nativeTransfers)) {
        for (const t of nativeTransfers) {
          if (t.fromUserAccount) touched.add(t.fromUserAccount);
          if (t.toUserAccount) touched.add(t.toUserAccount);
        }
      }
      const tokenTransfers = ev.tokenTransfers as Array<{
        fromUserAccount?: string;
        toUserAccount?: string;
        tokenAmount?: number;
        mint?: string;
      }> | undefined;
      if (Array.isArray(tokenTransfers)) {
        for (const t of tokenTransfers) {
          if (t.fromUserAccount) touched.add(t.fromUserAccount);
          if (t.toUserAccount) touched.add(t.toUserAccount);
        }
        // ── Porygon-Z Agility v1 — inbound iUSD SPL credit detection ──
        // When a user sends iUSD SPL to sol@ultron we log a credit intent
        // that downstream TreasuryAgents will pick up and process into a
        // Sui-side BAM v2 mint for the sender's Sui identity. This closes
        // the Shade cross-chain funding gap: the user can bridge in from
        // their Solana iUSD balance and the credit lands as Sui iUSD
        // ready to fund a Shade order. Minting itself happens in the
        // treasury fan-out below — we only detect + log here.
        //
        // ULTRON_SOL_ADDRESS is ultron's IKA-native Solana address from
        // the Registeel Hyper Beam sweep; the iUSD SPL mint address is
        // whatever OpenCLOB's createIusdSolMint minted first (stored in
        // TreasuryAgents DO state). We don't hardcode the mint here —
        // let the downstream handler compare against DO state so a fresh
        // mint deployment doesn't require a redeploy of this file.
        const ULTRON_SOL = 'GfVzGHiSPyTnX6bawnahJnUPXeASF6qKPd224VQws1DW';
        for (const t of tokenTransfers) {
          if (t.toUserAccount !== ULTRON_SOL) continue;
          if (!t.fromUserAccount || t.fromUserAccount === ULTRON_SOL) continue;
          const amount = Number(t.tokenAmount ?? 0);
          if (amount <= 0) continue;
          console.log(`[agility] inbound SPL credit to sol@ultron: ${amount} of mint ${t.mint} from ${t.fromUserAccount} (sig ${sig})`);

          // ── Sableye Lv.40 — Astonish (SOL leg) ──
          // Append cross-chain touch to ultron's Chronicom xchainLog so the
          // browser can map fromAddress → SuiNS name via its cached SUIAMI
          // roster and render a private counterparty hit. We write to
          // ultron's Chronicom because the webhook only knows ultron as the
          // destination; TODO: parse tx memo / webhook metadata to find the
          // real destination user and write to their Chronicom instead.
          try {
            const fromAddr = t.fromUserAccount;
            const txHash = sig ?? '';
            c.executionCtx.waitUntil((async () => {
              try {
                const stub = c.env.Chronicom.get(c.env.Chronicom.idFromName(ULTRON_ADDRESS));
                await stub.fetch(new Request('https://chronicom-do/sableye-xchain-append', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-partykit-room': ULTRON_ADDRESS },
                  body: JSON.stringify({ fromAddress: fromAddr, chain: 'sol', ts: Date.now(), txHash }),
                }));
              } catch (e) {
                console.warn('[sableye] append failed:', e instanceof Error ? e.message : e);
              }
            })());
          } catch (e) {
            console.warn('[sableye] append failed:', e instanceof Error ? e.message : e);
          }

          // Porygon-Z Agility v2 — fan out to TreasuryAgents.processAgilityInbound
          // which verifies the mint, resolves the Solana sender to a Sui
          // identity via SUIAMI roster, records the credit in DO state,
          // and would call mintIusd on the Sui side. v2 stops short of
          // the real mint and only logs `[agility-v2] WOULD mint …`.
          // Fire-and-forget so the webhook response isn't blocked.
          const fromSolAddress = t.fromUserAccount;
          const mintAddress = t.mint ?? '';
          // Convert human-readable tokenAmount → raw units (9 decimals for iUSD SPL).
          // Helius' tokenAmount is already divided by decimals; we ceil to avoid
          // rounding-down to 0 on tiny transfers.
          const amountRaw = String(Math.ceil(amount * 1e9));
          const inboundSig = sig ?? '';
          c.executionCtx.waitUntil(
            authedTreasuryStub(c).fetch(new Request('https://treasury-do/?agility-inbound', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
              body: JSON.stringify({ fromSolAddress, amountRaw, mintAddress, sig: inboundSig }),
            })).catch((e) => console.warn('[agility-v2] fan-out failed:', e?.message ?? e)),
          );
        }
      }
      console.log(`[helius-webhook] ${type ?? 'UNKNOWN'} ${sig ?? ''} touched ${touched.size} accounts`);
    }
    // Forward to treasury so it can cache-invalidate per-address state.
    // Fire-and-forget; the HTTP 200 to Helius must not wait on fan-out.
    if (touched.size > 0) {
      const addresses = Array.from(touched);
      c.executionCtx.waitUntil(
        authedTreasuryStub(c).fetch(new Request('https://treasury-do/?helius-event', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-partykit-room': 'treasury' },
          body: JSON.stringify({ events, addresses }),
        })).catch((e) => console.warn('[helius-webhook] treasury fan-out failed:', e?.message ?? e)),
      );
    }
    return c.json({ ok: true, received: events.length, touched: touched.size });
  } catch (err) {
    console.warn('[helius-webhook] parse failed:', err instanceof Error ? err.message : err);
    return c.json({ error: String(err) }, 400);
  }
});

// ── Porygon-Z Agility v2 — inbound credit status for a Sui address ──
// Returns recent iUSD SPL credits detected into sol@ultron that the
// worker has resolved to the caller's Sui identity via SUIAMI roster.
// v2 status is always 'detected' — v3 will surface 'minted' + digest.
app.get('/api/agility/status/:address', async (c) => {
  const address = c.req.param('address');
  const limit = c.req.query('limit') ?? '20';
  try {
    const res = await authedTreasuryStub(c).fetch(new Request(
      `https://treasury-do/?agility-status&address=${encodeURIComponent(address)}&limit=${encodeURIComponent(limit)}`,
      { headers: { 'x-partykit-room': 'treasury' } },
    ));
    const text = await res.text();
    try { return c.json(JSON.parse(text), res.status as any); }
    catch { return c.json({ error: text }, 500); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Alchemy webhook — ETH leg of Porygon-Z Conversion Beam ──
// Address Activity notifications for eth@ultron. Verifies the HMAC-SHA256
// signature Alchemy attaches to the raw body, parses inbound credits,
// and delegates to eth-inbound.ts for the 95/5 split + Uniswap swap +
// cross-chain iUSD mint. Returns 200 fast so Alchemy doesn't retry while
// we process — the actual swap/mint work happens in waitUntil.
app.post('/api/alchemy/webhook', async (c) => {
  const { verifyAlchemySignature, parseInboundCredits, computeSplit, formatEth, ETH_ULTRON_ADDRESS } =
    await import('./eth-inbound');
  const rawBody = await c.req.text();
  const sig = c.req.header('x-alchemy-signature');
  const secret = c.env.ALCHEMY_WEBHOOK_SECRET;
  if (!secret) {
    // Fail loud in logs but return 200 — we don't want Alchemy to retry
    // forever just because we haven't configured the secret yet.
    console.warn('[alchemy-webhook] ALCHEMY_WEBHOOK_SECRET not set, accepting without verification');
  } else {
    const ok = await verifyAlchemySignature(rawBody, sig ?? null, secret);
    if (!ok) return c.json({ error: 'Invalid signature' }, 401);
  }
  type AlchemyEvent = Parameters<typeof parseInboundCredits>[0];
  let payload: AlchemyEvent;
  try {
    payload = JSON.parse(rawBody) as AlchemyEvent;
  } catch (err) {
    console.warn('[alchemy-webhook] JSON parse failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const credits = parseInboundCredits(payload);
  console.log(`[alchemy-webhook] ${payload.event?.activity?.length ?? 0} activity entries, ${credits.length} qualifying credits for ${ETH_ULTRON_ADDRESS}`);
  for (const credit of credits) {
    const split = computeSplit(credit.amountWei);
    console.log(`[alchemy-webhook] credit ${credit.txHash} from ${credit.fromAddress} ${formatEth(credit.amountWei)} ETH → split ${formatEth(split.stablesAmountWei)} to stables + ${formatEth(split.gasReserveWei)} reserved`);

    // ── Sableye Lv.40 — Astonish (ETH leg) ──
    // See Helius handler above. Write touch to ultron's Chronicom for now;
    // TODO: once the webhook carries per-user destination metadata, write
    // to the real destination user's Chronicom.
    try {
      const fromAddr = credit.fromAddress;
      const txHash = credit.txHash;
      c.executionCtx.waitUntil((async () => {
        try {
          const stub = c.env.Chronicom.get(c.env.Chronicom.idFromName(ULTRON_ADDRESS));
          await stub.fetch(new Request('https://chronicom-do/sableye-xchain-append', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partykit-room': ULTRON_ADDRESS },
            body: JSON.stringify({ fromAddress: fromAddr, chain: 'eth', ts: Date.now(), txHash }),
          }));
        } catch (e) {
          console.warn('[sableye] append failed:', e instanceof Error ? e.message : e);
        }
      })());
    } catch (e) {
      console.warn('[sableye] append failed:', e instanceof Error ? e.message : e);
    }
    // TODO (Porygon-Z Tri Attack): kick off the Uniswap v3 swap + iUSD mint
    // via a dedicated ConversionBeamAgent DO. For v1 scaffold we just log;
    // the actual swap requires the eth@ultron dWallet signing path
    // (UltronSigningAgent Increment C/D) before we can move real funds.
  }
  return c.json({ ok: true, received: payload.event?.activity?.length ?? 0, qualifying: credits.length });
});

// ── Weavile Pursuit webhook router (#198 Metal Claw) ────────────────
// Provider webhooks for multi-chain stealth announcement delivery. Each
// endpoint HMAC-verifies the raw body, normalizes provider-specific
// payloads into our AnnouncementEvent shape, and fans each event to the
// appropriate WeavileScannerAgent DO. DO sharding: one instance per
// recipient — but the webhook doesn't know which recipient an event
// belongs to (that's the whole point of stealth addresses), so we
// broadcast to a per-provider singleton DO (`weavile:all`) that holds
// every recipient's subscriptions. A future optimization splits this by
// recipient-hash once the DO fan-out becomes the bottleneck.

// Alchemy webhook format for `GRAPHQL` log subscription: body is
// `{ event: { data: { block: { logs: [{ data, topics, transaction: { hash }, account: { address } }] } } } }`.
// We accept either the "Custom Webhook"-shaped payload above or a
// hand-posted `{ logs: [...] }` shape for testing.
app.post('/api/webhook/weavile/eth', async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('x-alchemy-signature');
  const secret = c.env.ALCHEMY_WEBHOOK_SECRET;
  if (secret) {
    const { verifyAlchemySignature } = await import('./eth-inbound.js');
    const ok = await verifyAlchemySignature(rawBody, sig ?? null, secret);
    if (!ok) return c.json({ error: 'Invalid signature' }, 401);
  } else {
    console.warn('[weavile-eth-webhook] ALCHEMY_WEBHOOK_SECRET not set — accepting without verification');
  }
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  // Extract logs[] from either Alchemy Custom Webhook or our test shape.
  const p = payload as {
    event?: { data?: { block?: { logs?: unknown[] } } };
    logs?: unknown[];
  };
  const rawLogs = (p.event?.data?.block?.logs ?? p.logs ?? []) as Array<{
    address?: string;
    topics?: string[];
    data?: string;
    blockNumber?: string;
    transactionHash?: string;
    transaction?: { hash?: string };
    account?: { address?: string };
  }>;
  const { parseEthAnnouncementLog, ERC5564_ANNOUNCER_ADDRESS } = await import('./agents/weavile-scanner.js');
  const events: unknown[] = [];
  for (const l of rawLogs) {
    const address = (l.address ?? l.account?.address ?? '').toLowerCase();
    if (address && address !== ERC5564_ANNOUNCER_ADDRESS) continue;
    const parsed = parseEthAnnouncementLog({
      address,
      topics: l.topics ?? [],
      data: l.data ?? '0x',
      blockNumber: l.blockNumber ?? '0x0',
      transactionHash: l.transactionHash ?? l.transaction?.hash ?? '',
    });
    if (parsed) events.push(parsed);
  }
  // Fan to the singleton scanner DO. `weavile:all` is the convention
  // until per-recipient sharding lands in Ice Punch.
  if (events.length > 0) {
    c.executionCtx.waitUntil((async () => {
      try {
        const stub = c.env.WeavileScannerAgent.get(c.env.WeavileScannerAgent.idFromName('weavile:all'));
        for (const ev of events) {
          await stub.fetch(new Request('https://weavile-do/onAnnouncementEvent', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partykit-room': 'weavile:all' },
            body: JSON.stringify({ event: ev }),
          }));
        }
      } catch (e) {
        console.warn('[weavile-eth-webhook] fan-out failed:', e instanceof Error ? e.message : e);
      }
    })());
  }
  return c.json({ ok: true, parsed: events.length, received: rawLogs.length });
});

// Sui webhook — no canonical provider yet; kept as a stub so our own
// cron or a third-party relay can POST normalized AnnouncementEvent
// payloads. Secret: reuses CF_HMAC_SECRET (ours, not a vendor's) so we
// can sign server→self calls for authenticated replays.
app.post('/api/webhook/weavile/sui', async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('x-ski-signature') ?? '';
  const secret = c.env.CF_HMAC_SECRET;
  if (secret) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const h = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const hex = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== sig.toLowerCase()) return c.json({ error: 'Invalid signature' }, 401);
  } else {
    console.warn('[weavile-sui-webhook] CF_HMAC_SECRET not set — accepting without verification');
  }
  // TODO(Ice Punch): normalize Sui GraphQL event JSON → AnnouncementEvent
  // and fan to the singleton scanner DO. For now just log + 200.
  try {
    const payload = JSON.parse(rawBody) as { events?: unknown[] };
    console.log(`[weavile-sui-webhook] stub received ${Array.isArray(payload.events) ? payload.events.length : 0} events`);
  } catch { /* ignore */ }
  return c.json({ ok: true, stub: true });
});

// Helius webhook for Solana stealth announcements. Program id TBD (see
// contracts/sol-stealth-announcer/README.md). Until the program lands
// we accept + verify + log, but don't fan out to the scanner DO.
app.post('/api/webhook/weavile/sol', async (c) => {
  const rawBody = await c.req.text();
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const secret = c.env.HELIUS_WEBHOOK_SECRET;
  if (secret) {
    if (bearer !== secret) return c.json({ error: 'Invalid signature' }, 401);
  } else {
    console.warn('[weavile-sol-webhook] HELIUS_WEBHOOK_SECRET not set — accepting without verification');
  }
  // TODO(Quick Attack Sol): parse Helius enhanced payload, locate
  // program logs from sol-stealth-announcer, map to AnnouncementEvent,
  // fan to scanner DO. Stubbed today.
  try {
    const payload = JSON.parse(rawBody) as unknown;
    const n = Array.isArray(payload) ? payload.length : 1;
    console.log(`[weavile-sol-webhook] stub received ${n} events — sol announcer program not deployed`);
  } catch { /* ignore */ }
  return c.json({ ok: true, stub: true });
});

// ── Helius webhook management ──
// Register a new webhook subscription through Helius's v0 API. Admin
// endpoint: requires the internal treasury auth header derived from the
// ultron keeper key, same gate we use elsewhere.
app.post('/api/cache/helius-webhook-register', async (c) => {
  try {
    if (!c.env.HELIUS_API_KEY) return c.json({ error: 'HELIUS_API_KEY not set' }, 500);
    const body = await c.req.json() as {
      accountAddresses: string[];
      transactionTypes?: string[];
      webhookType?: string;
    };
    if (!Array.isArray(body.accountAddresses) || body.accountAddresses.length === 0) {
      return c.json({ error: 'accountAddresses required' }, 400);
    }
    // Derive our own public webhook URL from the inbound host — works
    // identically on sui.ski and the dotski-devnet staging worker.
    const origin = new URL(c.req.url).origin;
    const webhookURL = `${origin}/api/helius/webhook`;
    const secret = c.env.HELIUS_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'HELIUS_WEBHOOK_SECRET not set — configure it first' }, 500);
    const createRes = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=${c.env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookURL,
        authHeader: `Bearer ${secret}`,
        webhookType: body.webhookType || 'enhanced',
        transactionTypes: body.transactionTypes || ['TRANSFER', 'SWAP', 'TOKEN_MINT', 'NFT_SALE'],
        accountAddresses: body.accountAddresses,
      }),
    });
    const text = await createRes.text();
    try { return c.json(JSON.parse(text), createRes.status as any); }
    catch { return c.json({ error: text }, createRes.status as any); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// List all registered webhooks for this project — read-only, no auth
// needed (the API key scope already restricts to our project).
app.get('/api/cache/helius-webhook-list', async (c) => {
  try {
    if (!c.env.HELIUS_API_KEY) return c.json({ error: 'HELIUS_API_KEY not set' }, 500);
    const r = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=${c.env.HELIUS_API_KEY}`);
    const text = await r.text();
    try { return c.json(JSON.parse(text), r.status as any); }
    catch { return c.json({ error: text }, r.status as any); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Delete a webhook by ID — cleanup path for stale subscriptions.
app.post('/api/cache/helius-webhook-delete', async (c) => {
  try {
    if (!c.env.HELIUS_API_KEY) return c.json({ error: 'HELIUS_API_KEY not set' }, 500);
    const body = await c.req.json() as { webhookID: string };
    if (!body.webhookID) return c.json({ error: 'webhookID required' }, 400);
    const r = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks/${body.webhookID}?api-key=${c.env.HELIUS_API_KEY}`, { method: 'DELETE' });
    const text = await r.text();
    try { return c.json(JSON.parse(text), r.status as any); }
    catch { return c.json({ ok: r.ok }, r.status as any); }
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
    const result = await sweepExpiredIous(c.env);
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
        const result = await sweepExpiredIous(env);
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
export { UltronSigningAgent } from './agents/ultron-signing-agent.js';
export { Aegislash } from './agents/aegislash.js';
export { SneaselWatcherAgent } from './agents/sneasel-watcher.js';
export { WeavileScannerAgent } from './agents/weavile-scanner.js';
export { WeavileAssuranceAgent } from './agents/weavile-assurance.js';
export { AggronBatcher } from './agents/aggron-batcher.js';
export { SuiInboundWatcher } from './agents/sui-inbound-watcher.js';
export { UltronPostal } from './agents/ultron-postal.js';
export { IntentRegistry } from './agents/intent-registry.js';
