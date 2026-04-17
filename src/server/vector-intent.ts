/**
 * Vector-principles intent verifier — centralizes the five Vector
 * checks applied by `/api/cache/bam-mint-v2` so additional v2 endpoints
 * can reuse the same relayer/authority split without duplicating the
 * cryptography or the nonce DO plumbing.
 *
 * The five Vector principles enforced here:
 *
 *   1. Digest-bound intent — the client commits to the exact parameters
 *      via SHA-256 of a canonical (sorted-key) JSON serialization.
 *   2. Relayer/authority split — the client signs the digest; ultron
 *      only verifies + relays. The worker cannot mutate intent fields.
 *   3. Hash-chain state progression — per-publicKey nonce advances via
 *      the TreasuryAgents `magnemite-nonce` DO; replays are rejected.
 *   4. No pre-reveal — intent stays private until the POST lands.
 *   5. Expiration primitive — `intent.expiresMs` enforced server-side.
 *
 * Callers pass the parsed request body and the list of intent fields
 * they consider mandatory (on top of the implicit `nonce` and
 * `expiresMs`). On success the helper returns the parsed intent plus
 * the raw digest and hex-encoded public key so the caller can thread
 * the digest back into its response for client-side correlation.
 */

import type { Context } from 'hono';

export interface VectorIntentBody<TIntent> {
  intent: TIntent;
  signature: string;  // base64-encoded Ed25519 signature over the digest
  publicKey: string;  // base64-encoded 32-byte Ed25519 public key
}

export type VectorIntentResult<TIntent> =
  | {
      ok: true;
      intent: TIntent & { nonce: string; expiresMs: number };
      digest: Uint8Array;
      digestHex: string;
      pubKeyHex: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 409 | 500;
      error: string;
    };

/**
 * Canonically stringify an intent by sorting its top-level keys. Mirror
 * this function on the client (see `src/client/vector-intent.ts`) so
 * both sides produce byte-identical digests.
 */
export function canonicalizeIntent(intent: Record<string, unknown>): string {
  const keys = Object.keys(intent).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = intent[k];
  return JSON.stringify(sorted);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Vector-principles signed intent. The caller is expected to
 * have parsed the request body already (via `c.req.json()`) and to pass
 * the list of required intent fields.
 *
 * Returns `{ ok: true, ... }` on success, or `{ ok: false, status, error }`
 * which the caller should translate into `c.json({ error }, status)`.
 *
 * This helper also advances the per-publicKey nonce hash-chain via the
 * TreasuryAgents DO; a duplicate nonce yields a 409 without leaking
 * the previous seed.
 */
export async function verifyVectorIntent<TIntent extends Record<string, unknown>>(
  c: Context<{ Bindings: any }>,
  body: unknown,
  requiredFields: readonly (keyof TIntent & string)[],
): Promise<VectorIntentResult<TIntent>> {
  // ── Shape validation ────────────────────────────────────────────
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Missing request body' };
  }
  const b = body as Partial<VectorIntentBody<TIntent>>;
  if (!b.intent || !b.signature || !b.publicKey) {
    return { ok: false, status: 400, error: 'Missing intent, signature, or publicKey' };
  }
  const intent = b.intent as TIntent & { nonce?: string; expiresMs?: number };

  for (const field of requiredFields) {
    if (intent[field] === undefined || intent[field] === null || intent[field] === '') {
      return { ok: false, status: 400, error: `Intent missing required field: ${field}` };
    }
  }
  if (!intent.nonce) {
    return { ok: false, status: 400, error: 'Intent missing required field: nonce' };
  }
  if (!intent.expiresMs || typeof intent.expiresMs !== 'number') {
    return { ok: false, status: 400, error: 'Intent missing required field: expiresMs' };
  }

  // ── Expiration check ────────────────────────────────────────────
  if (intent.expiresMs <= Date.now()) {
    return {
      ok: false,
      status: 400,
      error: `Intent expired at ${new Date(intent.expiresMs).toISOString()}`,
    };
  }

  // ── Canonical serialization + digest ────────────────────────────
  const canonical = canonicalizeIntent(intent as Record<string, unknown>);
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const digest = sha256(new TextEncoder().encode(canonical));

  // ── Ed25519 signature verify ────────────────────────────────────
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(b.signature!), (ch) => ch.charCodeAt(0));
    pubBytes = Uint8Array.from(atob(b.publicKey!), (ch) => ch.charCodeAt(0));
  } catch {
    return { ok: false, status: 400, error: 'signature/publicKey must be base64' };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return { ok: false, status: 400, error: 'Invalid signature/publicKey length' };
  }
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  let valid = false;
  try {
    valid = ed25519.verify(sigBytes, digest, pubBytes);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 403, error: 'Signature verification failed' };
  }

  // ── Nonce advance via TreasuryAgents DO ─────────────────────────
  const pubKeyHex = toHex(pubBytes);
  const digestHex = toHex(digest);
  try {
    // Lazy-import so this module stays self-contained. The helper needs
    // the authed treasury stub that `src/server/index.ts` already
    // exposes; fall back to building one from the env here.
    const env = c.env as {
      TreasuryAgents: DurableObjectNamespace;
      SHADE_KEEPER_PRIVATE_KEY?: string;
    };
    const stub = env.TreasuryAgents.get(env.TreasuryAgents.idFromName('treasury'));
    // Derive the same x-treasury-auth token `authedTreasuryStub` uses
    // (first 34 chars of ultron's normalized Sui address).
    let auth = '';
    if (env.SHADE_KEEPER_PRIVATE_KEY) {
      const { normalizeSuiAddress } = await import('@mysten/sui/utils');
      const { ultronKeypair } = await import('./ultron-key.js');
      const kp = ultronKeypair(env);
      auth = normalizeSuiAddress(kp.getPublicKey().toSuiAddress()).slice(0, 34);
    }
    const nonceRes = await stub.fetch(new Request('https://treasury-do/?magnemite-nonce', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-partykit-room': 'treasury',
        'x-treasury-auth': auth,
      },
      body: JSON.stringify({
        publicKey: pubKeyHex,
        nonce: intent.nonce,
        digest: digestHex,
      }),
    }));
    if (!nonceRes.ok) {
      const errText = await nonceRes.text();
      return { ok: false, status: 409, error: `Nonce check failed: ${errText}` };
    }
  } catch (err) {
    return { ok: false, status: 500, error: `Nonce DO error: ${String(err)}` };
  }

  return {
    ok: true,
    intent: intent as TIntent & { nonce: string; expiresMs: number },
    digest,
    digestHex,
    pubKeyHex,
  };
}
