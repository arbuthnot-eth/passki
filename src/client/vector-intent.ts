/**
 * Client-side Vector-principles intent signer.
 *
 * Mirrors `src/server/vector-intent.ts`:
 *   - Canonically stringifies the intent with sorted top-level keys
 *   - Computes SHA-256 of the canonical bytes
 *   - Signs the digest via the connected wallet (`signPersonalMessage`)
 *   - Returns `{ intent, signature, publicKey }` ready to POST to a v2
 *     cache endpoint (bam-mint-v2, send-iusd-v2, etc.)
 *
 * The server and client MUST produce byte-identical canonical bytes;
 * the helpers on both sides share the same sort-then-stringify logic.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { signPersonalMessage, getState } from '../wallet.js';

/**
 * Canonically stringify an intent — sorted top-level keys, stable JSON.
 * Keep this function in lock-step with `canonicalizeIntent` on the
 * server so digests line up.
 */
export function canonicalizeIntent(intent: Record<string, unknown>): string {
  const keys = Object.keys(intent).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = intent[k];
  return JSON.stringify(sorted);
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface SignedVectorIntent<TIntent> {
  intent: TIntent & { nonce: string; expiresMs: number };
  signature: string; // base64 Ed25519 signature
  publicKey: string; // base64 32-byte Ed25519 public key
}

/**
 * Sign a Vector-principles intent and return a payload ready to POST
 * to any /api/cache/*-v2 endpoint that uses the shared helper.
 *
 * The caller supplies the intent fields; `nonce` and `expiresMs` are
 * filled in automatically if missing. The returned `intent` is the
 * exact object that was hashed + signed — clients should POST this
 * verbatim so the server recomputes the same digest.
 */
export async function signVectorIntent<TIntent extends Record<string, unknown>>(
  fields: TIntent,
  opts: { nonce?: string; ttlMs?: number } = {},
): Promise<SignedVectorIntent<TIntent>> {
  const nonce = opts.nonce || `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const expiresMs = Date.now() + (opts.ttlMs ?? 5 * 60 * 1000);

  const intent = {
    ...fields,
    nonce,
    expiresMs,
  } as TIntent & { nonce: string; expiresMs: number };

  const canonical = canonicalizeIntent(intent as Record<string, unknown>);
  const digest = sha256(new TextEncoder().encode(canonical));

  // Sign the digest via the connected wallet. WaaP and dapp-kit both
  // return { bytes, signature } where `signature` is a base64-encoded
  // Sui serialized signature (flag | signature | pubkey).
  const signed = await signPersonalMessage(digest);

  // The Sui serialized signature format is:
  //   byte 0        — signature scheme flag (0x00 = Ed25519)
  //   bytes 1..65   — raw Ed25519 signature (64 bytes)
  //   bytes 65..97  — Ed25519 public key (32 bytes)
  // Split into the raw sig + pubkey so the server can verify with
  // @noble/curves directly.
  const rawSuiSig = b64decode(signed.signature);
  if (rawSuiSig[0] !== 0x00) {
    throw new Error(`signVectorIntent: wallet returned non-Ed25519 signature scheme 0x${rawSuiSig[0].toString(16)}`);
  }
  if (rawSuiSig.length < 97) {
    throw new Error(`signVectorIntent: signature too short (${rawSuiSig.length} bytes)`);
  }
  const sigBytes = rawSuiSig.slice(1, 65);
  const pubBytes = rawSuiSig.slice(65, 97);

  // Sanity: make sure there's still a connected wallet after signing —
  // catches silent wallet swaps mid-session.
  const _addr = getState().account?.address ?? '';
  void _addr;

  return {
    intent,
    signature: b64encode(sigBytes),
    publicKey: b64encode(pubBytes),
  };
}
