// Porygon — CF edge enrichment client.
//
// Fetches signed CF metadata from the worker, change-detects against
// a localStorage-cached fingerprint (no decrypt roundtrip), Seal-
// encrypts, uploads to Walrus, and appends the `append_cf_history`
// moveCall to the caller's PTB.
//
// Called from suins.ts's `buildWithTx` chokepoint so every PTB that
// newly writes the SUIAMI roster also writes a CF chunk if the
// fingerprint has changed. Typical user: 1-3 chunks lifetime.

import type { Transaction } from '@mysten/sui/transactions';
import { encryptCfChunkToWalrus, decryptCfChunkForAddress, SUIAMI_PKG, ROSTER_OBJ, ROSTER_INITIAL_SHARED_VERSION } from './suiami-seal.js';

export interface CfFields {
  country: string;
  asn: number;
  threatScore: number;
  ipHash: string;
  colo: string;
  verifiedBot: boolean;
  tlsVersion: string;
  httpProtocol: string;
  attestedAt: number;
}
export interface CfEnvelope { data: CfFields; sig: string }
export interface CfChunk { schema: 1; data: CfFields; sig: string }

/** Fields compared for change-detection. Excludes `attestedAt` so
 *  timestamp noise doesn't trigger writes. */
const CHANGE_KEYS: Array<keyof CfFields> = [
  'country', 'asn', 'threatScore', 'ipHash', 'colo',
  'verifiedBot', 'tlsVersion', 'httpProtocol',
];

/** localStorage key for the last-written fingerprint per address. */
const CF_LS_KEY = (addr: string) => `ski:cf-hist:v1:${addr.toLowerCase()}`;

function fingerprintOf(data: CfFields): string {
  const sorted: Record<string, unknown> = {};
  for (const k of CHANGE_KEYS) sorted[k] = data[k];
  return JSON.stringify(sorted);
}

export async function fetchCfContext(): Promise<CfEnvelope | null> {
  try {
    const res = await fetch('/api/cf-context');
    if (!res.ok) return null;
    return (await res.json()) as CfEnvelope;
  } catch {
    return null;
  }
}

/** Append a `roster::append_cf_history` moveCall to the given tx, but
 *  only when the CF fingerprint has changed since the last local
 *  write. Silently no-ops on mainnet miss, network error, or unchanged
 *  fingerprint. Never throws — CF enrichment is best-effort.
 *
 *  Uses localStorage as the change-detect oracle (not the Walrus blob)
 *  so we don't need a SessionKey / wallet prompt to decide whether to
 *  write. First-time writers always write (no cached fingerprint). */
export async function maybeAttachCfHistoryToTx(
  tx: Transaction,
  ownerAddress: string,
): Promise<boolean> {
  // Idempotency guard — a single tx should carry at most one CF chunk
  // write, regardless of how many code paths try to attach it.
  const txAny = tx as unknown as { _cfAttached?: boolean };
  if (txAny._cfAttached) return false;
  try {
    const env = await fetchCfContext();
    if (!env) return false;
    const currentFp = fingerprintOf(env.data);
    let priorFp = '';
    try { priorFp = localStorage.getItem(CF_LS_KEY(ownerAddress)) ?? ''; } catch {}
    if (priorFp === currentFp) return false;

    const chunk: CfChunk = { schema: 1, data: env.data, sig: env.sig };
    const { blobId } = await encryptCfChunkToWalrus(ownerAddress, chunk);

    tx.moveCall({
      target: `${SUIAMI_PKG}::roster::append_cf_history`,
      arguments: [
        tx.sharedObjectRef({
          objectId: ROSTER_OBJ,
          initialSharedVersion: ROSTER_INITIAL_SHARED_VERSION,
          mutable: true,
        }),
        tx.pure.string(blobId),
        tx.object('0x6'),
      ],
    });

    try { localStorage.setItem(CF_LS_KEY(ownerAddress), currentFp); } catch {}
    txAny._cfAttached = true;
    return true;
  } catch (err) {
    console.warn('[cf-history] attach failed (non-fatal):', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Decrypt and return the full CF history for the caller. Used by
 *  the `cfHistory()` console helper — requires a wallet session key. */
export async function readCfHistory(opts: {
  ownerAddress: string;
  blobIds: string[];
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}): Promise<CfChunk[]> {
  const out: CfChunk[] = [];
  for (const id of opts.blobIds) {
    const chunk = (await decryptCfChunkForAddress({
      blobId: id,
      address: opts.ownerAddress,
      signPersonalMessage: opts.signPersonalMessage,
    })) as CfChunk | null;
    if (chunk) out.push(chunk);
  }
  return out;
}
