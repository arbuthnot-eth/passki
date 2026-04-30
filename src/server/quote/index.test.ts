import { describe, expect, test } from 'bun:test';
import {
  applyBuffer,
  fmtUsd,
  quoteAction,
  BUFFER_10_PERCENT,
  BUFFER_2X,
  BUFFER_3X,
  NO_BUFFER,
} from './index.ts';

describe('fmtUsd', () => {
  test('formats whole dollars', () => {
    expect(fmtUsd(0n)).toBe('$0.00');
    expect(fmtUsd(1_000_000n)).toBe('$1.00');
    expect(fmtUsd(123_000_000n)).toBe('$123.00');
  });
  test('truncates sub-cent', () => {
    expect(fmtUsd(7_500_000n)).toBe('$7.50');
    expect(fmtUsd(7_999_999n)).toBe('$7.99');
  });
});

describe('applyBuffer', () => {
  test('NO_BUFFER returns input', () => {
    expect(applyBuffer(1_000_000n, NO_BUFFER)).toBe(1_000_000n);
  });
  test('10% buffer', () => {
    expect(applyBuffer(7_500_000n, BUFFER_10_PERCENT)).toBe(8_250_000n);
  });
  test('2× buffer', () => {
    expect(applyBuffer(100_000n, BUFFER_2X)).toBe(200_000n);
  });
  test('3× buffer', () => {
    expect(applyBuffer(50_000n, BUFFER_3X)).toBe(150_000n);
  });
  test('rejects bps below 10000', () => {
    expect(() => applyBuffer(1_000_000n, 9_999)).toThrow();
  });
  test('rejects non-integer bps', () => {
    expect(() => applyBuffer(1_000_000n, 11_000.5)).toThrow();
  });
});

describe('quoteAction', () => {
  const mintComponents = [
    { key: 'ns_wholesale', label: 'NS-paid wholesale', baseline_usdc: 7_500_000n, buffer_bps: BUFFER_10_PERCENT },
    { key: 'gas', label: 'Sui gas', baseline_usdc: 50_000n, buffer_bps: BUFFER_3X },
    { key: 'facilitator', label: 'x402 facilitator', baseline_usdc: 100_000n, buffer_bps: BUFFER_2X },
    { key: 'margin', label: 'Mint margin', baseline_usdc: 500_000n, buffer_bps: NO_BUFFER, is_revenue: true },
  ];

  test('Mint quote shape — alice 5+char 1y', () => {
    const q = quoteAction({ components: mintComponents });
    expect(q.minimum_required_usdc).toBe('8150000');  // $8.15
    expect(q.total_usdc).toBe('9100000');              // $9.10
    expect(q.buffer_cushion_usdc).toBe('950000');     // $0.95
    expect(q.buffer_percent).toBeCloseTo(11.65, 1);
    expect(q.funded_percent).toBeNull();
    expect(q.components).toHaveLength(4);
  });

  test('funded_percent — paid below minimum', () => {
    const q = quoteAction({ components: mintComponents, paid_usdc: 5_000_000n });
    expect(q.funded_percent).toBeCloseTo(61.34, 1);
  });

  test('funded_percent — paid above total', () => {
    const q = quoteAction({ components: mintComponents, paid_usdc: 12_000_000n });
    expect(q.funded_percent).toBeCloseTo(147.23, 1);
  });

  test('rejects empty components', () => {
    expect(() => quoteAction({ components: [] })).toThrow();
  });

  test('rejects duplicate keys', () => {
    expect(() =>
      quoteAction({
        components: [
          { key: 'a', label: 'A', baseline_usdc: 1n, buffer_bps: NO_BUFFER },
          { key: 'a', label: 'A2', baseline_usdc: 1n, buffer_bps: NO_BUFFER },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test('rejects negative baseline', () => {
    expect(() =>
      quoteAction({
        components: [{ key: 'bad', label: 'Bad', baseline_usdc: -1n, buffer_bps: NO_BUFFER }],
      }),
    ).toThrow(/negative/);
  });

  test('marks revenue flag on output', () => {
    const q = quoteAction({ components: mintComponents });
    const margin = q.components.find((c) => c.key === 'margin');
    expect(margin?.is_revenue).toBe(true);
    const ns = q.components.find((c) => c.key === 'ns_wholesale');
    expect(ns?.is_revenue).toBe(false);
  });
});
