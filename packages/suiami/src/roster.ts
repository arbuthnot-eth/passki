/**
 * SUIAMI Roster — on-chain cross-chain identity resolver.
 *
 * Read and write chain address records from the shared roster object.
 * Dual-keyed: lookup by name hash OR by Sui address.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';

export const ROSTER_PACKAGE = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';
export const ROSTER_OBJECT = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';

export interface RosterRecord {
  name: string;
  sui_address: string;
  chains: Record<string, string>;
  dwallet_caps: string[];
  updated_ms: number;
}

export interface ReadOptions {
  graphqlUrl?: string;
}

const DEFAULT_GQL = 'https://graphql.mainnet.sui.io/graphql';

/** Read a roster entry by SuiNS name. Returns chain addresses or null. */
export async function readByName(name: string, opts?: ReadOptions): Promise<RosterRecord | null> {
  const gqlUrl = opts?.graphqlUrl ?? DEFAULT_GQL;
  const bare = name.replace(/\.sui$/i, '').toLowerCase();
  const nh = keccak_256(new TextEncoder().encode(bare));
  const nhB64 = btoa(String.fromCharCode(...nh));
  try {
    const res = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "${ROSTER_OBJECT}") { dynamicField(name: { type: "vector<u8>", bcs: "${nhB64}" }) { value { ... on MoveValue { json } } } } }`,
      }),
    });
    return parseRosterResponse(await res.json());
  } catch { return null; }
}

/** Read a roster entry by Sui address. */
export async function readByAddress(address: string, opts?: ReadOptions): Promise<RosterRecord | null> {
  const gqlUrl = opts?.graphqlUrl ?? DEFAULT_GQL;
  // BCS for address key: raw 32 bytes, base64 encoded
  const hex = address.replace(/^0x/, '').padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const addrB64 = btoa(String.fromCharCode(...bytes));
  try {
    const res = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "${ROSTER_OBJECT}") { dynamicField(name: { type: "address", bcs: "${addrB64}" }) { value { ... on MoveValue { json } } } } }`,
      }),
    });
    return parseRosterResponse(await res.json());
  } catch { return null; }
}

/** Read a roster entry by chain address (e.g., "btc:bc1q..."). */
export async function readByChain(chain: string, chainAddress: string, opts?: ReadOptions): Promise<RosterRecord | null> {
  const gqlUrl = opts?.graphqlUrl ?? DEFAULT_GQL;
  const key = `${chain}:${chainAddress}`;
  // BCS for String: ULEB128 length prefix + UTF-8 bytes
  const utf8 = new TextEncoder().encode(key);
  const bcsBytes = new Uint8Array(utf8.length + 1);
  bcsBytes[0] = utf8.length; // simple ULEB128 for lengths < 128
  bcsBytes.set(utf8, 1);
  const keyB64 = btoa(String.fromCharCode(...bcsBytes));
  try {
    const res = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "${ROSTER_OBJECT}") { dynamicField(name: { type: "0x1::string::String", bcs: "${keyB64}" }) { value { ... on MoveValue { json } } } } }`,
      }),
    });
    return parseRosterResponse(await res.json());
  } catch { return null; }
}

/** Compute the keccak256 name hash for a bare SuiNS name. */
export function nameHash(name: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(name.replace(/\.sui$/i, '').toLowerCase()));
}

/** Build a set_identity Move call for use in a PTB. */
export function buildSetIdentityArgs(
  name: string,
  chainAddresses: Record<string, string>,
  dwalletCaps: string[] = [],
) {
  const bare = name.replace(/\.sui$/i, '').toLowerCase();
  const nh = Array.from(nameHash(bare));
  const keys = Object.keys(chainAddresses);
  const values = keys.map(k => chainAddresses[k]);
  return {
    package: ROSTER_PACKAGE,
    module: 'roster',
    function: 'set_identity',
    rosterObject: ROSTER_OBJECT,
    name: bare,
    nameHash: nh,
    chainKeys: keys,
    chainValues: values,
    dwalletCaps,
  };
}

// ─── Internal ──────────────────────────────────────────────────────

function parseRosterResponse(gql: unknown): RosterRecord | null {
  const data = (gql as { data?: { object?: { dynamicField?: { value?: { json?: Record<string, unknown> } } } } })
    ?.data?.object?.dynamicField?.value?.json;
  if (!data?.chains) return null;
  const contents = (data.chains as { contents?: Array<{ key: string; value: string }> }).contents ?? [];
  if (contents.length === 0) return null;
  const chains: Record<string, string> = {};
  for (const { key, value } of contents) chains[key] = value;
  return {
    name: data.name as string,
    sui_address: data.sui_address as string,
    chains,
    dwallet_caps: (data.dwallet_caps as string[]) ?? [],
    updated_ms: Number(data.updated_ms ?? 0),
  };
}
