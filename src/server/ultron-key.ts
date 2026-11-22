// Single choke point for deriving the ultron.sui signing keypair.
//
// Raw-key today: reads SHADE_KEEPER_PRIVATE_KEY (bech32 `suiprivkey1…`)
// and derives an Ed25519 keypair. Tomorrow — once IKA imported-key
// ed25519 DKG ships — this helper swaps to a DWalletCap + IKA
// threshold signature without touching any of the 90+ server-side
// call sites.
//
// NEVER call `Ed25519Keypair.fromSecretKey(env.SHADE_KEEPER_PRIVATE_KEY)`
// directly. Always go through ultronKeypair(env) so the raw→IKA
// migration has exactly one line to change.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export interface UltronEnv {
    /**
     * Preferred name for ultron's Ed25519 private key (bech32 `suiprivkey1…`).
     * Use this for new deploys and future rotations.
     */
    ULTRON_PRIVATE_KEY?: string;
    /** Optional dedicated secret for Worker→DO / admin-route auth. */
    INTERNAL_AUTH_SECRET?: string;
    /**
     * Legacy name — ultron originally shipped as the Shade keeper only.
     * Still accepted for backwards compatibility during the rename
     * window; delete once ULTRON_PRIVATE_KEY is written on every
     * environment.
     */
    SHADE_KEEPER_PRIVATE_KEY?: string;
}

/** Resolve ultron's secret from either the preferred or legacy env name. */
function resolveUltronSecret(env: UltronEnv): string | undefined {
    return env.ULTRON_PRIVATE_KEY ?? env.SHADE_KEEPER_PRIVATE_KEY;
}

/** True if ultron is configured on this env (preferred or legacy name). */
export function hasUltronKey(env: UltronEnv): boolean {
    return !!resolveUltronSecret(env);
}

/**
 * Ultron.sui Ed25519 keypair. One call site away from IKA MPC.
 *
 * Throws if no secret is configured — call sites that tolerate an
 * unconfigured keeper should gate on `hasUltronKey(env)` before
 * invoking, matching the runtime pattern across the agents.
 */
export function ultronKeypair(env: UltronEnv): Ed25519Keypair {
    const secret = resolveUltronSecret(env);
    if (!secret) {
        throw new Error('ultronKeypair: no ULTRON_PRIVATE_KEY or SHADE_KEEPER_PRIVATE_KEY configured');
    }
    return Ed25519Keypair.fromSecretKey(secret);
}

/** Ultron.sui public address. Cheaper than ultronKeypair when only the address is needed. */
export function ultronAddress(env: UltronEnv): string {
    return ultronKeypair(env).getPublicKey().toSuiAddress();
}

/**
 * Hono context gate: require a valid ultron-signed request. Used on
 * privileged admin/debug endpoints (debug-mint, debug-sol-watch,
 * reset-sol-cursor, squid-stats). Caller produces the signature by
 * signing `${context}:${ts}` with ultron's keypair and sends:
 *   - `x-ultron-sig`: base64 signature
 *   - `x-ultron-ts`: millisecond timestamp (≤60s old)
 *
 * Returns `null` on success, or a `Response` to short-circuit with on
 * failure. Usage:
 *
 *     const denied = await requireUltronSig(c, 'debug-mint');
 *     if (denied) return denied;
 */
export async function requireUltronSig(
    c: { req: { header(name: string): string | undefined }; env: UltronEnv; json(body: unknown, status?: number): Response },
    context: string,
): Promise<Response | null> {
    if (!hasUltronKey(c.env)) {
        return c.json({ error: 'Not configured' }, 503);
    }
    const sig = c.req.header('x-ultron-sig');
    const ts = c.req.header('x-ultron-ts');
    if (!sig || !ts) return c.json({ error: 'Unauthorized' }, 401);
    const age = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(age) || age > 60_000) return c.json({ error: 'Timestamp expired' }, 401);
    try {
        const keypair = ultronKeypair(c.env);
        const msgBytes = new TextEncoder().encode(`${context}:${ts}`);
        const expected = await keypair.sign(msgBytes);
        const { toBase64 } = await import('@mysten/sui/utils');
        if (toBase64(expected) !== sig) return c.json({ error: 'Invalid signature' }, 403);
    } catch {
        return c.json({ error: 'Auth failed' }, 403);
    }
    return null;
}

/**
 * Shared secret for admin routes and Worker→Durable Object calls
 * (`x-treasury-auth`).
 *
 * This used to be the first 34 characters of ultron's Sui address, which
 * is public (on-chain, and returned by /api/sponsor-info), so anyone could
 * compute it. It's now an HMAC of a real secret: INTERNAL_AUTH_SECRET if
 * set (so the token survives ultron moving to IKA signing), otherwise
 * ultron's private key. Returns '' when neither is configured, which
 * callers must treat as "deny".
 */
export function internalAuthToken(env: UltronEnv): string {
    const secret = env.INTERNAL_AUTH_SECRET ?? resolveUltronSecret(env);
    if (!secret) return '';
    return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes('passki-internal-auth:v1')));
}

/** Constant-time string comparison, so response timing can't leak how much of a token matched. */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    // Compare fixed-length digests so the length of `a` isn't leaked either.
    const x = sha256(utf8ToBytes(a));
    const y = sha256(utf8ToBytes(b));
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}
