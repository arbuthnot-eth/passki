import { describe, expect, mock, test } from 'bun:test';

// The DO base class only exists inside workerd; the budgeting rule under
// test is a pure function, so stub the import.
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
const { reserve, utcDay } = await import('../agents/sponsor-quota.js');

const CAP = 1_000_000_000n; // 1 SUI

describe('sponsor quota', () => {
  test('accumulates within a day and refuses past the cap', () => {
    let s = reserve(null, '2026-11-22', 400_000_000n, CAP);
    expect(s.result).toEqual({ ok: true, spentMist: 400_000_000n });
    s = reserve(s.next, '2026-11-22', 500_000_000n, CAP);
    expect(s.result.ok).toBe(true);
    const over = reserve(s.next, '2026-11-22', 200_000_000n, CAP);
    expect(over.result).toEqual({ ok: false, spentMist: 900_000_000n });
    expect(over.next.spentMist).toBe(900_000_000n); // a refusal doesn't consume budget
  });

  test('exactly hitting the cap is allowed', () => {
    expect(reserve(null, '2026-11-22', CAP, CAP).result.ok).toBe(true);
  });

  test('resets on a new UTC day', () => {
    const full = reserve(null, '2026-11-22', CAP, CAP).next;
    expect(reserve(full, '2026-11-23', 1n, CAP).result).toEqual({ ok: true, spentMist: 1n });
  });

  test('rejects negative amounts (no minting budget)', () => {
    expect(() => reserve(null, '2026-11-22', -1n, CAP)).toThrow();
  });

  test('utcDay is the ISO date in UTC', () => {
    expect(utcDay(Date.UTC(2026, 10, 22, 23, 59, 59))).toBe('2026-11-22');
    expect(utcDay(Date.UTC(2026, 10, 23, 0, 0, 0))).toBe('2026-11-23');
  });
});

describe('reserveDailyBudgets', () => {
  // In-memory stand-in for the DO namespace: one counter per instance name.
  function fakeNs() {
    const spent = new Map<string, bigint>();
    return {
      spent,
      idFromName: (n: string) => n,
      get: (n: string) => ({
        async reserve(a: string, cap: string) {
          const next = (spent.get(n) ?? 0n) + BigInt(a);
          if (next > BigInt(cap)) return { ok: false, spentMist: String(spent.get(n) ?? 0n) };
          spent.set(n, next);
          return { ok: true, spentMist: String(next) };
        },
        async refund(a: string) { spent.set(n, (spent.get(n) ?? 0n) - BigInt(a)); },
      }),
    };
  }

  test('fresh addresses from one IP still hit the per-IP cap, with no leaked reservations', async () => {
    const { reserveDailyBudgets } = await import('../agents/sponsor-quota.js');
    const ns = fakeNs();
    const env = { SPONSOR_QUOTA: ns as any };
    const limits = (addr: string) => [
      { key: `fund-gas:addr:${addr}`, cap: 200n },
      { key: 'fund-gas:ip:1.2.3.4', cap: 300n },
      { key: 'fund-gas:global', cap: 3000n },
    ];
    for (const a of ['a', 'b', 'c']) expect((await reserveDailyBudgets(env, limits(a), 100n)).ok).toBe(true);
    const r = await reserveDailyBudgets(env, limits('d'), 100n);
    expect(r).toEqual({ ok: false, key: 'fund-gas:ip:1.2.3.4' });
    expect(ns.spent.get('budget:fund-gas:addr:d')).toBe(0n);   // rolled back
    expect(ns.spent.get('budget:fund-gas:global')).toBe(300n);  // the refused request never counted
  });

  test('fails closed without the DO binding', async () => {
    const { reserveDailyBudgets } = await import('../agents/sponsor-quota.js');
    expect(await reserveDailyBudgets({}, [{ key: 'x', cap: 10n }], 1n)).toEqual({ ok: false, key: 'unavailable' });
  });
});
