// Verify a shade order against the chain before the keeper commits gas to it.
//
// Scheduling is open (the Worker's own treasury flows schedule on users'
// behalf), so instead of asking *who* is scheduling, we check *what* is being
// scheduled: the object must be a live ShadeOrder / StableShadeOrder<T> of
// the expected type, still funded, and its on-chain commitment must equal
// keccak256(domain || bcs(execute_after_ms) || bcs(target) || salt), exactly
// the check `shade::execute` makes. An order that passes here can't fail
// execution on a bad reveal, so a bogus order can't make ultron burn gas.

import { bcs } from '@mysten/sui/bcs';
import { fromBase64, fromHex, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Shared layout of ShadeOrder and StableShadeOrder<T>. */
const ShadeOrderBcs = bcs.struct('ShadeOrder', {
  id: bcs.Address,
  owner: bcs.Address,
  deposit: bcs.u64(),
  commitment: bcs.vector(bcs.u8()),
  sealed_payload: bcs.vector(bcs.u8()),
});

export function shadeCommitment(domain: string, executeAfterMs: number, targetAddress: string, saltHex: string): Uint8Array {
  const parts = [
    new TextEncoder().encode(domain),
    bcs.u64().serialize(BigInt(executeAfterMs)).toBytes(),
    bcs.Address.serialize(normalizeSuiAddress(targetAddress)).toBytes(),
    fromHex(saltHex),
  ];
  const pre = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { pre.set(p, o); o += p.length; }
  return keccak_256(pre);
}

export interface ChainOrder { type: string; bcs: Uint8Array; initialSharedVersion: number | null }

export interface ScheduleClaim {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string;
  /** Expected Move type, e.g. `0x…::shade::ShadeOrder` or `0x…::shade::StableShadeOrder<0x…::iusd::IUSD>`. */
  expectedType: string;
  initialSharedVersion?: number;
}

export type ScheduleCheck =
  | { ok: true; depositMist: string; owner: string; initialSharedVersion: number | null }
  | { ok: false; error: string };

const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Pure check of a claimed order against the on-chain object. */
export function checkScheduleClaim(claim: ScheduleClaim, chain: ChainOrder | null): ScheduleCheck {
  if (!chain) return { ok: false, error: 'Shade order not found on-chain' };
  let sameType = false;
  try { sameType = normalizeStructTag(chain.type) === normalizeStructTag(claim.expectedType); } catch { /* malformed */ }
  if (!sameType) return { ok: false, error: 'Object is not a shade order of the expected type' };
  if (chain.initialSharedVersion === null) return { ok: false, error: 'Shade order is not shared' };
  if (claim.initialSharedVersion !== undefined && Number(claim.initialSharedVersion) !== chain.initialSharedVersion) {
    return { ok: false, error: 'initialSharedVersion does not match the chain' };
  }

  let order: { id: string; owner: string; deposit: string; commitment: number[] };
  try { order = ShadeOrderBcs.parse(chain.bcs) as typeof order; } catch { return { ok: false, error: 'Could not decode shade order' }; }
  if (normalizeSuiAddress(order.id) !== normalizeSuiAddress(claim.objectId)) return { ok: false, error: 'Object id mismatch' };
  if (BigInt(order.deposit) === 0n) return { ok: false, error: 'Shade order has no deposit (refunded or cancelled)' };

  let expected: Uint8Array;
  try {
    if (!Number.isSafeInteger(claim.executeAfterMs) || claim.executeAfterMs < 0) throw new Error('bad time');
    if (!/^[0-9a-fA-F]*$/.test(claim.salt) || claim.salt.length % 2) throw new Error('bad salt');
    expected = shadeCommitment(claim.domain, claim.executeAfterMs, claim.targetAddress, claim.salt);
  } catch {
    return { ok: false, error: 'Malformed order parameters' };
  }
  if (!eqBytes(expected, Uint8Array.from(order.commitment))) {
    return { ok: false, error: 'Order parameters do not match the on-chain commitment' };
  }
  return { ok: true, depositMist: String(order.deposit), owner: normalizeSuiAddress(order.owner), initialSharedVersion: chain.initialSharedVersion };
}

/**
 * Fetch an object's type, BCS and shared version. Retries briefly, because
 * the UI schedules right after creating the order and the indexer can lag.
 */
export async function fetchChainOrder(objectId: string, gqlUrl: string, attempts = 4): Promise<ChainOrder | null> {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 750 * i));
    try {
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: SuiAddress!) { object(address: $id) {
            owner { __typename ... on Shared { initialSharedVersion } }
            asMoveObject { contents { bcs type { repr } } }
          } }`,
          variables: { id: objectId },
        }),
      });
      if (!res.ok) continue;
      const json = await res.json() as { data?: { object?: {
        owner?: { __typename?: string; initialSharedVersion?: number | string };
        asMoveObject?: { contents?: { bcs?: string; type?: { repr?: string } } };
      } | null } };
      const obj = json.data?.object;
      const contents = obj?.asMoveObject?.contents;
      if (!obj || !contents?.bcs || !contents.type?.repr) continue;
      const isv = obj.owner?.__typename === 'Shared' ? Number(obj.owner.initialSharedVersion) : null;
      return { type: contents.type.repr, bcs: fromBase64(contents.bcs), initialSharedVersion: isv };
    } catch { /* retry */ }
  }
  return null;
}
