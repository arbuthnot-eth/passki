import { Hono } from 'hono';

// ── zkLogin prover proxy ───────────────────────────────────────────────
// Browser CORS prevents direct calls to Mysten's prover endpoints, and
// switching prover URLs without a redeploy is useful, so we proxy here.
//
// Hybrid vampire mode:
//   - devnet/testnet → free public Mysten prover
//   - mainnet        → self-hosted mysten/zklogin:prover-stable (TODO)
//
// The upstream URL comes from env.ZKLOGIN_PROVER_URL with a devnet fallback.
// We refuse to pay Enoki — self-host for mainnet instead.

const DEFAULT_PROVER_URL = 'https://prover-dev.mystenlabs.com/v1';

interface ProveRequestBody {
  jwt: string;
  extendedEphemeralPublicKey: string;
  maxEpoch: number | string;
  jwtRandomness: string;
  salt: string;
  keyClaimName: string;
}

interface ZkLoginEnv {
  ZKLOGIN_PROVER_URL?: string;
}

// ── In-memory proof cache ──────────────────────────────────────────────
// zkLogin proofs are expensive (~3s). Within a session the same request
// often repeats on transient failures, so cache briefly by SHA-256 of
// the canonical request body. Resets on cold start — that's fine.
const PROOF_CACHE_TTL_MS = 60_000;
const _proofCache = new Map<string, { proof: unknown; expiresAt: number }>();

function pruneProofCache(now: number): void {
  if (_proofCache.size < 256) return;
  for (const [k, v] of _proofCache) {
    if (now > v.expiresAt) _proofCache.delete(k);
  }
}

async function hashRequest(body: ProveRequestBody): Promise<string> {
  // Canonical JSON: stable key order so equivalent requests hash equal.
  const canonical = JSON.stringify({
    jwt: body.jwt,
    extendedEphemeralPublicKey: body.extendedEphemeralPublicKey,
    maxEpoch: String(body.maxEpoch),
    jwtRandomness: body.jwtRandomness,
    salt: body.salt,
    keyClaimName: body.keyClaimName,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function validateBody(raw: unknown): { ok: true; body: ProveRequestBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  const required = [
    'jwt',
    'extendedEphemeralPublicKey',
    'maxEpoch',
    'jwtRandomness',
    'salt',
    'keyClaimName',
  ] as const;
  for (const k of required) {
    if (r[k] === undefined || r[k] === null || r[k] === '') {
      return { ok: false, error: `Missing required field: ${k}` };
    }
  }
  if (typeof r.jwt !== 'string') return { ok: false, error: 'jwt must be a string' };
  if (typeof r.extendedEphemeralPublicKey !== 'string') {
    return { ok: false, error: 'extendedEphemeralPublicKey must be a string' };
  }
  if (typeof r.jwtRandomness !== 'string') return { ok: false, error: 'jwtRandomness must be a string' };
  if (typeof r.salt !== 'string') return { ok: false, error: 'salt must be a string' };
  if (typeof r.keyClaimName !== 'string') return { ok: false, error: 'keyClaimName must be a string' };
  if (typeof r.maxEpoch !== 'number' && typeof r.maxEpoch !== 'string') {
    return { ok: false, error: 'maxEpoch must be a number or string' };
  }
  return {
    ok: true,
    body: {
      jwt: r.jwt,
      extendedEphemeralPublicKey: r.extendedEphemeralPublicKey,
      maxEpoch: r.maxEpoch as number | string,
      jwtRandomness: r.jwtRandomness,
      salt: r.salt,
      keyClaimName: r.keyClaimName,
    },
  };
}

function resolveProverUrl(env: ZkLoginEnv | undefined): string {
  const fromEnv = env?.ZKLOGIN_PROVER_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return DEFAULT_PROVER_URL;
}

/**
 * Main prover proxy handler. Hono-compatible: accepts a context `c` and
 * returns a Response. Exported standalone so it can be mounted directly
 * if a caller prefers not to use the sub-app wrapper.
 */
export async function handleZkLoginProve(c: {
  req: { json: () => Promise<unknown> };
  env: ZkLoginEnv;
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const validated = validateBody(raw);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }
  const body = validated.body;

  const now = Date.now();
  pruneProofCache(now);

  const cacheKey = await hashRequest(body);
  const cached = _proofCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return c.json(cached.proof as Record<string, unknown>);
  }

  const proverUrl = resolveProverUrl(c.env);

  // Normalize maxEpoch to string — the Mysten prover accepts either but
  // string is the documented form and matches what the browser SDK sends.
  const upstreamPayload = {
    jwt: body.jwt,
    extendedEphemeralPublicKey: body.extendedEphemeralPublicKey,
    maxEpoch: String(body.maxEpoch),
    jwtRandomness: body.jwtRandomness,
    salt: body.salt,
    keyClaimName: body.keyClaimName,
  };

  let upstream: Response;
  try {
    upstream = await fetch(proverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[zklogin-proxy] upstream fetch failed:', msg, 'url:', proverUrl);
    return c.json({ error: 'zkLogin prover unreachable', detail: msg }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    console.error(
      '[zklogin-proxy] upstream returned',
      upstream.status,
      'url:',
      proverUrl,
      'body:',
      text.slice(0, 512),
    );
    return c.json(
      {
        error: 'zkLogin prover error',
        status: upstream.status,
        detail: text.slice(0, 1024),
      },
      502,
    );
  }

  let proof: unknown;
  try {
    proof = await upstream.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[zklogin-proxy] upstream returned non-JSON:', msg);
    return c.json({ error: 'zkLogin prover returned non-JSON response' }, 502);
  }

  _proofCache.set(cacheKey, { proof, expiresAt: now + PROOF_CACHE_TTL_MS });

  return c.json(proof as Record<string, unknown>);
}

/**
 * Build a Hono sub-app exposing the zkLogin proxy routes. Mount at
 * `/api/zklogin/*` from the main app:
 *
 *   app.route('/api/zklogin', createZkLoginApp());
 *
 * Routes:
 *   POST /prove   — forwards to upstream prover, caches for 60s
 *   GET  /health  — returns { ok, prover } for monitoring
 */
export function createZkLoginApp(): Hono<{ Bindings: ZkLoginEnv }> {
  const app = new Hono<{ Bindings: ZkLoginEnv }>();

  app.post('/prove', async (c) => {
    return handleZkLoginProve({
      req: { json: () => c.req.json() },
      env: c.env,
      json: (body, status) => c.json(body as Record<string, unknown>, (status ?? 200) as 200),
    });
  });

  app.get('/health', (c) => {
    return c.json({ ok: true, prover: resolveProverUrl(c.env) });
  });

  return app;
}

export { DEFAULT_PROVER_URL };
