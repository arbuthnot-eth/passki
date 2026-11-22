// Lombre — roster completeness check.
//
// Reads the SUIAMI IdentityRecord for a Sui address and reports whether
// the name's dWallet caps have matching chain entries published. When
// caps exist without published chains, the record is "incomplete" —
// the UI surfaces an exclamation pip and the Rumble CTA nags.
//
// Uses the `"sui:0x..."` string-keyed dynamic field on the SUIAMI
// roster object (original-id `0x2c1d63b…52fa`, shared at
// `0x30b4…ab1d`). Direct JSON-RPC read: the npm suiami/roster
// `readByAddress` uses a different dynamic-field shape that doesn't
// match what's actually stored.
//
// Every cap curve is expected to yield exactly one chain address:
//   - secp256k1 cap → eth + btc (two derivations from one cap)
//   - ed25519 cap   → sol
// For a "rumbled" identity we expect `chains` to cover the curves the
// caps can derive. Exact mapping lives below in `EXPECTED_CHAINS`.

const ROSTER_OBJECT = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';

const RPC_ENDPOINTS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];

export interface RosterRecordFull {
  name: string;
  suiAddress: string;
  chains: Record<string, string>;
  dwalletCaps: string[];
  walrusBlobId: string;
  sealNonce: number[];
}

/**
 * Read the full SUIAMI IdentityRecord by Sui address. Returns null when
 * no record exists. Used by Lombre Ice Beam to build a scribe PTB that
 * preserves name, walrus_blob_id, and seal_nonce while merging new
 * chain entries derived from existing dwallet_caps.
 */
export async function readRosterRecordFull(suiAddress: string): Promise<RosterRecordFull | null> {
  const addr = suiAddress.startsWith('0x') ? suiAddress.toLowerCase() : `0x${suiAddress.toLowerCase()}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'suix_getDynamicFieldObject',
    params: [ROSTER_OBJECT, { type: '0x1::string::String', value: `sui:${addr}` }],
  });
  try {
    const result = await raceRpc(body) as {
      data?: { content?: { fields?: { value?: { fields?: {
        name?: string;
        sui_address?: string;
        chains?: { fields?: { contents?: Array<{ fields?: { key?: string; value?: string } }> } };
        dwallet_caps?: string[];
        walrus_blob_id?: string;
        seal_nonce?: number[];
      } } } } };
    };
    const fields = result?.data?.content?.fields?.value?.fields;
    if (!fields) return null;
    const chains: Record<string, string> = {};
    for (const e of fields.chains?.fields?.contents ?? []) {
      const k = e.fields?.key;
      const v = e.fields?.value;
      if (typeof k === 'string' && typeof v === 'string') chains[k] = v;
    }
    return {
      name: fields.name ?? '',
      suiAddress: fields.sui_address ?? addr,
      chains,
      dwalletCaps: Array.isArray(fields.dwallet_caps) ? fields.dwallet_caps : [],
      walrusBlobId: fields.walrus_blob_id ?? '',
      sealNonce: Array.isArray(fields.seal_nonce) ? fields.seal_nonce.map(Number) : [],
    };
  } catch { return null; }
}

export interface RosterHealth {
  /** Record exists at all. */
  found: boolean;
  /** Name from the record (undefined when not found). */
  name?: string;
  /** Number of dWallet caps present. */
  capCount: number;
  /** Chain keys currently published. */
  publishedChains: string[];
  /** Chain keys we expected but didn't find. */
  missingChains: string[];
  /** Caps are present AND some expected chains missing. */
  incomplete: boolean;
  /** Every expected chain is published (regardless of cap count). */
  rumbled: boolean;
}

/**
 * Per-chain rostered status for a given SUIAMI record. Rows derived
 * from the same cap count as a single rostered publication:
 *   - `tron` and `base` reflect `eth`'s rostered state (same cap)
 *   - `sui` is always rostered (every record has a sui_address)
 */
export function chainIsRostered(health: RosterHealth, chainKey: string): boolean {
  const key = chainKey.toLowerCase();
  if (key === 'sui') return health.found;
  const derivedFromEth = key === 'tron' || key === 'base';
  const effectiveKey = derivedFromEth ? 'eth' : key;
  return health.publishedChains.includes(effectiveKey);
}

/**
 * Chains we expect once a cap is present. Conservative: if the identity
 * has any caps, we assume both curve sets got provisioned (the
 * canonical Rumble flow covers both), and expect eth + btc + sol.
 * Records predating multi-curve Rumble may trip "incomplete" until
 * re-rumbled — that's the intended nudge.
 */
const EXPECTED_CHAINS = ['eth', 'btc', 'sol'];

async function raceRpc(body: string): Promise<unknown> {
  const attempts = RPC_ENDPOINTS.map(async (url) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    const j = await r.json() as { error?: unknown; result?: unknown };
    if (j.error || j.result == null) throw new Error(`${url} rpc error`);
    return j.result;
  });
  return await Promise.any(attempts);
}

/**
 * Read the SUIAMI IdentityRecord for the given Sui address and compute
 * health. Safe to call frequently — 60s implicit caching is left to
 * callers (UI renderers typically debounce anyway).
 */
export async function rosterHealth(suiAddress: string): Promise<RosterHealth> {
  const addr = suiAddress.startsWith('0x') ? suiAddress.toLowerCase() : `0x${suiAddress.toLowerCase()}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'suix_getDynamicFieldObject',
    params: [ROSTER_OBJECT, { type: '0x1::string::String', value: `sui:${addr}` }],
  });
  try {
    const result = await raceRpc(body) as {
      data?: { content?: { fields?: { value?: { fields?: {
        name?: string;
        chains?: { fields?: { contents?: Array<{ fields?: { key?: string; value?: string } }> } };
        dwallet_caps?: string[];
      } } } } };
    };
    const fields = result?.data?.content?.fields?.value?.fields;
    if (!fields) {
      return {
        found: false,
        capCount: 0,
        publishedChains: [],
        missingChains: [...EXPECTED_CHAINS],
        incomplete: false,
        rumbled: false,
      };
    }
    const chains = (fields.chains?.fields?.contents ?? [])
      .map((e) => e.fields?.key)
      .filter((k): k is string => typeof k === 'string' && k !== 'sui');
    const capCount = Array.isArray(fields.dwallet_caps) ? fields.dwallet_caps.length : 0;
    const missing = EXPECTED_CHAINS.filter((c) => !chains.includes(c));
    return {
      found: true,
      name: fields.name,
      capCount,
      publishedChains: chains,
      missingChains: missing,
      incomplete: capCount > 0 && missing.length > 0,
      rumbled: missing.length === 0,
    };
  } catch {
    return {
      found: false,
      capCount: 0,
      publishedChains: [],
      missingChains: [...EXPECTED_CHAINS],
      incomplete: false,
      rumbled: false,
    };
  }
}
