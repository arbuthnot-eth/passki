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
