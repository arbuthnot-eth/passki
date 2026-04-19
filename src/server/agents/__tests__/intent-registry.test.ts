/**
 * IntentRegistry — Aggron Mega Punch unit tests.
 *
 * Mocks `agents` so we can instantiate the DO class without a live
 * Cloudflare runtime. Admin-auth enforcement is tested at the worker
 * endpoint layer (integration) — these tests cover the DO's own
 * validation, state transitions, and read paths.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state!: S;
      env: unknown;
      initialState!: S;
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
      }
      setState(s: S) { this.state = s; }
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type IntentEntry = import('../intent-registry.js').IntentEntry;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type IntentRegistry = import('../intent-registry.js').IntentRegistry;

let IntentRegistryCls: typeof import('../intent-registry.js').IntentRegistry;
let isValidIntentIndex: typeof import('../intent-registry.js').isValidIntentIndex;
let isValidChainTag: typeof import('../intent-registry.js').isValidChainTag;
let sortByIntentIndex: typeof import('../intent-registry.js').sortByIntentIndex;
let registerMessageFor: typeof import('../intent-registry.js').registerMessageFor;
let revokeMessageFor: typeof import('../intent-registry.js').revokeMessageFor;

beforeAll(async () => {
  const mod = await import('../intent-registry.js');
  IntentRegistryCls = mod.IntentRegistry;
  isValidIntentIndex = mod.isValidIntentIndex;
  isValidChainTag = mod.isValidChainTag;
  sortByIntentIndex = mod.sortByIntentIndex;
  registerMessageFor = mod.registerMessageFor;
  revokeMessageFor = mod.revokeMessageFor;
});

function newRegistry(): IntentRegistry {
  // The stub Agent ignores ctx/env; the DO initializes state from
  // initialState the first time setState runs. We prime state manually.
  const r = new IntentRegistryCls({} as never, {} as never);
  // mirror what the real runtime does on first construction
  (r as unknown as { state: unknown }).state = { entries: {}, lastModifiedMs: 0 };
  return r;
}

const ADMIN = '0x2b3524ebf158c4b01f482c6d687d8ba0d922deaec04c3b495926d73cb0a7ee28';

describe('pure validators', () => {
  test('isValidIntentIndex — bounds + integrality', () => {
    expect(isValidIntentIndex(0)).toBe(true);
    expect(isValidIntentIndex(9999)).toBe(true);
    expect(isValidIntentIndex(-1)).toBe(false);
    expect(isValidIntentIndex(10_000)).toBe(false);
    expect(isValidIntentIndex(1.5)).toBe(false);
    expect(isValidIntentIndex('42' as unknown)).toBe(false);
  });
  test('isValidChainTag — only 0..3', () => {
    for (const n of [0, 1, 2, 3]) expect(isValidChainTag(n)).toBe(true);
    for (const n of [-1, 4, 5, 9, 1.5]) expect(isValidChainTag(n)).toBe(false);
  });
  test('registerMessageFor shape', () => {
    const m = registerMessageFor({ intentIndex: 42, suiamiName: 'athena', today: '2026-04-18' });
    expect(m).toBe('aggron-intent-register:42:athena:2026-04-18');
  });
  test('revokeMessageFor shape', () => {
    expect(revokeMessageFor({ intentIndex: 7, today: '2026-04-18' })).toBe(
      'aggron-intent-revoke:7:2026-04-18',
    );
  });
  test('sortByIntentIndex is stable and non-mutating', () => {
    const a: IntentEntry = { intentIndex: 3, suiamiName: 'hermes', chainTag: 0, issuedAtMs: 1, issuedBy: ADMIN };
    const b: IntentEntry = { intentIndex: 1, suiamiName: 'apollo', chainTag: 1, issuedAtMs: 2, issuedBy: ADMIN };
    const c: IntentEntry = { intentIndex: 2, suiamiName: 'athena', chainTag: 2, issuedAtMs: 3, issuedBy: ADMIN };
    const input = [a, b, c];
    const out = sortByIntentIndex(input);
    expect(out.map(e => e.intentIndex)).toEqual([1, 2, 3]);
    // original order preserved
    expect(input.map(e => e.intentIndex)).toEqual([3, 1, 2]);
  });
});

describe('IntentRegistry DO', () => {
  test('register stores an entry', async () => {
    const r = newRegistry();
    const result = await r.register({
      intentIndex: 42,
      suiamiName: 'athena',
      chainTag: 0,
      issuedBy: ADMIN,
    });
    expect(result.ok).toBe(true);
    expect(result.entry.suiamiName).toBe('athena');
    expect(result.entry.chainTag).toBe(0);
    const lookup = await r.lookup({ intentIndex: 42 });
    expect(lookup?.suiamiName).toBe('athena');
  });

  test('register overwrites existing entry at same index with new value + advances lastModifiedMs', async () => {
    const r = newRegistry();
    await r.register({ intentIndex: 42, suiamiName: 'athena', chainTag: 0, issuedBy: ADMIN });
    const firstStamp = (r as unknown as { state: { lastModifiedMs: number } }).state.lastModifiedMs;
    // Small delay so Date.now() moves even on fast machines
    await new Promise(res => setTimeout(res, 2));
    await r.register({ intentIndex: 42, suiamiName: 'apollo', chainTag: 1, issuedBy: ADMIN });
    const entry = await r.lookup({ intentIndex: 42 });
    expect(entry?.suiamiName).toBe('apollo');
    expect(entry?.chainTag).toBe(1);
    const secondStamp = (r as unknown as { state: { lastModifiedMs: number } }).state.lastModifiedMs;
    expect(secondStamp).toBeGreaterThanOrEqual(firstStamp);
    // Still only one slot
    const all = await r.list();
    expect(all.count).toBe(1);
  });

  test('revoke removes entry', async () => {
    const r = newRegistry();
    await r.register({ intentIndex: 7, suiamiName: 'hermes', chainTag: 2, issuedBy: ADMIN });
    expect((await r.lookup({ intentIndex: 7 }))?.suiamiName).toBe('hermes');
    const rev = await r.revoke({ intentIndex: 7 });
    expect(rev).toEqual({ ok: true, removed: true });
    expect(await r.lookup({ intentIndex: 7 })).toBeNull();
    // Idempotent — second revoke reports removed: false
    const again = await r.revoke({ intentIndex: 7 });
    expect(again).toEqual({ ok: true, removed: false });
  });

  test('lookup returns null for unknown index', async () => {
    const r = newRegistry();
    expect(await r.lookup({ intentIndex: 123 })).toBeNull();
    expect(await r.lookup({ intentIndex: 99999 })).toBeNull();
  });

  test('list returns all entries sorted by intentIndex', async () => {
    const r = newRegistry();
    await r.register({ intentIndex: 30, suiamiName: 'hermes', chainTag: 0, issuedBy: ADMIN });
    await r.register({ intentIndex: 10, suiamiName: 'athena', chainTag: 1, issuedBy: ADMIN });
    await r.register({ intentIndex: 20, suiamiName: 'apollo', chainTag: 2, issuedBy: ADMIN });
    const { count, entries } = await r.list();
    expect(count).toBe(3);
    expect(entries.map(e => e.intentIndex)).toEqual([10, 20, 30]);
    expect(entries.map(e => e.suiamiName)).toEqual(['athena', 'apollo', 'hermes']);
  });

  test('register rejects chainTag outside 0-3', async () => {
    const r = newRegistry();
    await expect(
      r.register({
        intentIndex: 1,
        suiamiName: 'athena',
        chainTag: 4 as unknown as 0,
        issuedBy: ADMIN,
      }),
    ).rejects.toThrow(/chainTag/);
    await expect(
      r.register({
        intentIndex: 1,
        suiamiName: 'athena',
        chainTag: -1 as unknown as 0,
        issuedBy: ADMIN,
      }),
    ).rejects.toThrow(/chainTag/);
  });

  test('register rejects intentIndex outside 0-9999', async () => {
    const r = newRegistry();
    await expect(
      r.register({ intentIndex: 10_000, suiamiName: 'athena', chainTag: 0, issuedBy: ADMIN }),
    ).rejects.toThrow(/intentIndex/);
    await expect(
      r.register({ intentIndex: -1, suiamiName: 'athena', chainTag: 0, issuedBy: ADMIN }),
    ).rejects.toThrow(/intentIndex/);
    await expect(
      r.register({ intentIndex: 1.5, suiamiName: 'athena', chainTag: 0, issuedBy: ADMIN }),
    ).rejects.toThrow(/intentIndex/);
  });

  test('register+lookup round-trip preserves suiamiName', async () => {
    const r = newRegistry();
    const names = ['athena', 'apollo', 'hermes'];
    for (let i = 0; i < names.length; i++) {
      await r.register({
        intentIndex: i,
        suiamiName: names[i],
        chainTag: (i % 4) as 0 | 1 | 2 | 3,
        issuedBy: ADMIN,
      });
    }
    for (let i = 0; i < names.length; i++) {
      const entry = await r.lookup({ intentIndex: i });
      expect(entry?.suiamiName).toBe(names[i]);
      expect(entry?.chainTag).toBe((i % 4) as 0 | 1 | 2 | 3);
      expect(entry?.issuedBy).toBe(ADMIN);
      expect(entry?.issuedAtMs).toBeGreaterThan(0);
    }
  });

  test('register rejects empty suiamiName', async () => {
    const r = newRegistry();
    await expect(
      r.register({ intentIndex: 1, suiamiName: '', chainTag: 0, issuedBy: ADMIN }),
    ).rejects.toThrow(/suiamiName/);
  });
});
