// Owner proof: "the caller controls this Sui address".
//
// Reuses the `.SKI` sign-in message the browser already stores after the
// wallet signs it (localStorage `ski:session:<address>`), so per-user agents
// can authenticate their owner without another wallet prompt. The message
// must name the address, carry an `Expires At` in the future, and be signed
// by that address.

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress, fromBase64 } from '@mysten/sui/utils';

export interface OwnerProof { message: string; signature: string }

/** Header carrying a base64(JSON OwnerProof) on plain HTTP requests. */
export const OWNER_PROOF_HEADER = 'x-ski-owner-proof';

let _client: SuiGraphQLClient | null = null;
// Only consulted for zkLogin signatures.
const client = () => (_client ??= new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' }));

/**
 * Returns the proof's expiry (ms) if it proves control of `owner`, else null.
 * Never throws.
 */
export async function verifyOwnerProof(proof: unknown, owner: string, now = Date.now()): Promise<number | null> {
  try {
    const p = proof as Partial<OwnerProof> | null | undefined;
    if (!p || typeof p.message !== 'string' || typeof p.signature !== 'string') return null;
    if (p.message.length > 4096 || !p.message.startsWith('.SKI')) return null;

    const addr = normalizeSuiAddress(owner);
    const named = p.message.split('\n').some((line) => {
      const t = line.trim();
      return /^0x[0-9a-fA-F]{1,64}$/.test(t) && normalizeSuiAddress(t) === addr;
    });
    if (!named) return null;

    const m = /^Expires At: (.+)$/m.exec(p.message);
    const expiresAt = m ? Date.parse(m[1].trim()) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

    await verifyPersonalMessageSignature(new TextEncoder().encode(p.message), p.signature, { address: addr, client: client() });
    return expiresAt;
  } catch {
    return null;
  }
}

/** Decode the owner-proof header, or null if absent or malformed. */
export function ownerProofFromHeader(value: string | null): OwnerProof | null {
  if (!value) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64(value))) as OwnerProof;
  } catch {
    return null;
  }
}
