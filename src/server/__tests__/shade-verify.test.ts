// Shade scheduling is gated on the chain, not on identity: only an order
// whose on-chain commitment matches the revealed parameters (the same check
// shade::execute makes) gets tracked, so bogus orders can't burn keeper gas.

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { bcs } from '@mysten/sui/bcs';
import { fromHex, normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { checkScheduleClaim, shadeCommitment, type ChainOrder } from '../shade-verify.js';

const PKG = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';
const STABLE_PKG = '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837';
const IUSD = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
const LEGACY = `${PKG}::shade::ShadeOrder`;
const OWNER = normalizeSuiAddress('0xabc');
const ID = normalizeSuiAddress('0x1234');

const params = { objectId: ID, domain: 'brando', executeAfterMs: 1_790_000_000_000, targetAddress: OWNER, salt: 'ab'.repeat(32) };

const Layout = bcs.struct('ShadeOrder', {
  id: bcs.Address, owner: bcs.Address, deposit: bcs.u64(),
  commitment: bcs.vector(bcs.u8()), sealed_payload: bcs.vector(bcs.u8()),
});
function chainOrder(over: Partial<{ type: string; deposit: bigint; commitment: Uint8Array; isv: number | null; id: string }> = {}): ChainOrder {
  const commitment = over.commitment ?? shadeCommitment(params.domain, params.executeAfterMs, params.targetAddress, params.salt);
  return {
    type: over.type ?? LEGACY,
    initialSharedVersion: over.isv === undefined ? 42 : over.isv,
    bcs: Layout.serialize({ id: over.id ?? ID, owner: OWNER, deposit: over.deposit ?? 5_000_000_000n, commitment: Array.from(commitment), sealed_payload: [] }).toBytes(),
  };
}

describe('shadeCommitment', () => {
  test('matches the Move preimage: domain || u64 LE || address || salt', () => {
    const ms = new Uint8Array(8);
    new DataView(ms.buffer).setBigUint64(0, BigInt(params.executeAfterMs), true);
    const pre = new Uint8Array([...new TextEncoder().encode('brando'), ...ms, ...fromHex(OWNER.slice(2)), ...fromHex(params.salt)]);
    expect(shadeCommitment(params.domain, params.executeAfterMs, params.targetAddress, params.salt)).toEqual(keccak_256(pre));
  });
});

describe('checkScheduleClaim', () => {
  const claim = { ...params, expectedType: LEGACY };

  test('accepts a real order and reports the chain deposit', () => {
    expect(checkScheduleClaim(claim, chainOrder())).toEqual({ ok: true, depositMist: '5000000000', owner: OWNER, initialSharedVersion: 42 });
  });

  test.each([
    ['missing object', null],
    ['wrong type', chainOrder({ type: '0x2::coin::Coin<0x2::sui::SUI>' })],
    ['stable order claimed as legacy', chainOrder({ type: `${STABLE_PKG}::shade::StableShadeOrder<${IUSD}>` })],
    ['not shared', chainOrder({ isv: null })],
    ['refunded (zero deposit)', chainOrder({ deposit: 0n })],
    ['different object id in bcs', chainOrder({ id: normalizeSuiAddress('0x9') })],
    ['commitment mismatch', chainOrder({ commitment: new Uint8Array(32) })],
  ])('rejects %s', (_name, chain) => {
    expect(checkScheduleClaim(claim, chain as ChainOrder | null).ok).toBe(false);
  });

  test('any wrong revealed parameter fails the commitment', () => {
    for (const bad of [{ domain: 'brandon' }, { executeAfterMs: params.executeAfterMs + 1 }, { targetAddress: normalizeSuiAddress('0xdef') }, { salt: 'cd'.repeat(32) }]) {
      expect(checkScheduleClaim({ ...claim, ...bad }, chainOrder()).ok).toBe(false);
    }
  });

  test('malformed input is refused, not thrown', () => {
    expect(checkScheduleClaim({ ...claim, salt: 'zz' }, chainOrder()).ok).toBe(false);
    expect(checkScheduleClaim({ ...claim, executeAfterMs: -1 }, chainOrder()).ok).toBe(false);
    expect(checkScheduleClaim(claim, { ...chainOrder(), bcs: new Uint8Array([1, 2, 3]) }).ok).toBe(false);
  });

  test('stable orders must also match the claimed shared version', () => {
    const stable = { ...claim, expectedType: `${STABLE_PKG}::shade::StableShadeOrder<${IUSD}>` };
    const chain = chainOrder({ type: stable.expectedType });
    expect(checkScheduleClaim({ ...stable, initialSharedVersion: 42 }, chain).ok).toBe(true);
    expect(checkScheduleClaim({ ...stable, initialSharedVersion: 41 }, chain).ok).toBe(false);
  });
});

describe('ShadeExecutorAgent.scheduleOrder', () => {
  let Agent: any;
  beforeAll(async () => {
    mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
    mock.module('agents', () => ({ Agent: class { alarm = async () => {}; }, callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d }));
    ({ ShadeExecutorAgent: Agent } = await import('../agents/shade-executor.js'));
  });

  function make(chain: ChainOrder | null) {
    const a: any = new Agent({} as any, {} as any);
    a.name = OWNER;
    a.env = {};
    a.state = { orders: [], sweeps: [{ nameHash: '00', domain: 'kept', sweepAfterMs: 1, status: 'pending' }] };
    a.setState = (s: unknown) => { a.state = s; };
    a.onStateChanged = () => {};
    a.scheduleNextAlarm = () => {};
    a.fetchChainOrder = async () => chain;
    return a;
  }
  const req = { ...params, ownerAddress: OWNER, depositMist: '999999999999' };

  test('a bogus order is never tracked', async () => {
    const a = make(chainOrder({ commitment: new Uint8Array(32) }));
    expect((await a.scheduleOrder(req)).success).toBe(false);
    expect(a.state.orders).toEqual([]);
  });

  test('a real order is tracked with the chain deposit, and sweeps survive', async () => {
    const a = make(chainOrder());
    expect((await a.scheduleOrder({ ...req, isStable: true, status: 'completed' })).success).toBe(true);
    const [o] = a.state.orders;
    expect(o.depositMist).toBe('5000000000');
    expect(o.isStable).toBeUndefined();   // injected fields are dropped
    expect(o.status).toBe('pending');
    expect(a.state.sweeps).toHaveLength(1);
  });
});
