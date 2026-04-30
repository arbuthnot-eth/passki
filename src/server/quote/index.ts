/**
 * Generic priced-action quote primitive.
 *
 * Any user-facing paid action with multiple cost components and volatile
 * pricing should consume this. Examples:
 *   Mint     — SuiNS registration (NS wholesale + gas + facilitator + margin)
 *   Subcent  — cross-chain routing (bridge + swap + dest-chain gas + margin)
 *   iUSD     — redemption (oracle slippage + gas + margin)
 *   Storm    — paid Thunder send (per-message + AEAD overhead + margin)
 *
 * Pattern:
 *   - Each component has a baseline cost and a buffer factor (bps).
 *   - `quoteAction` returns both `minimum_required` (no buffers) and `total`
 *     (with buffers), plus per-component breakdown.
 *   - Optional `paid_usdc` returns `funded_percent = paid / minimum × 100`,
 *     for partial-payment progress UX.
 *
 * All amounts are USDC 6-decimal base units. Display formatting at the UI.
 */

/** Buffer factor in basis points. 10000 = 1.0× (no buffer). */
export type BufferBps = number;

export const NO_BUFFER: BufferBps = 10_000;
export const BUFFER_5_PERCENT: BufferBps = 10_500;
export const BUFFER_10_PERCENT: BufferBps = 11_000;
export const BUFFER_2X: BufferBps = 20_000;
export const BUFFER_3X: BufferBps = 30_000;

export interface CostComponent {
  /** Stable machine-readable identifier (e.g. "ns_wholesale", "gas"). */
  key: string;
  /** Human label for display (e.g. "NS-paid wholesale", "Sui gas"). */
  label: string;
  /** Baseline cost in USDC 6-decimal base units. */
  baseline_usdc: bigint;
  /** Buffer factor in bps. 11000 = 10% buffer; 30000 = 3× multiplier. */
  buffer_bps: BufferBps;
  /** True if this component is revenue (e.g. margin), not a real cost.
   *  Revenue components count toward `total` and `minimum_required`,
   *  but flagged so callers can show "of which Mint margin: $0.50". */
  is_revenue?: boolean;
}

export interface QuotedComponent {
  key: string;
  label: string;
  baseline_usdc: string;
  buffered_usdc: string;
  buffer_bps: BufferBps;
  is_revenue: boolean;
  display: {
    baseline: string;
    buffered: string;
  };
}

export interface ActionQuote {
  components: QuotedComponent[];
  /** Sum of baselines — actual best-case cost. */
  minimum_required_usdc: string;
  /** Sum of buffered amounts — what the buyer pays. */
  total_usdc: string;
  /** total - minimum, the headroom that absorbs worst-case. */
  buffer_cushion_usdc: string;
  /** cushion / minimum × 100. Two decimal places. */
  buffer_percent: number;
  /** If `paid_usdc` provided, paid / minimum × 100. Two decimal places.
   *  100% = paid covers minimum required. Above 100% = covers buffer too.
   *  null if no paid_usdc passed. */
  funded_percent: number | null;
  display: {
    minimum_required: string;
    total: string;
    buffer_cushion: string;
  };
  /** Live verification stamp. */
  quoted_at_ms: number;
}

export interface QuoteActionInput {
  components: CostComponent[];
  paid_usdc?: bigint | null;
}

/** Format USDC base units as a display string ($X.YY). */
export function fmtUsd(baseUnits: bigint): string {
  const dollars = baseUnits / 1_000_000n;
  const cents = (baseUnits % 1_000_000n) / 10_000n;
  return `$${dollars}.${cents.toString().padStart(2, '0')}`;
}

/** Apply a bps buffer to a baseline. */
export function applyBuffer(baseline: bigint, bufferBps: BufferBps): bigint {
  if (!Number.isInteger(bufferBps) || bufferBps < 10_000) {
    throw new Error(`buffer_bps must be integer ≥ 10000 (no buffer = 10000); got ${bufferBps}`);
  }
  return (baseline * BigInt(bufferBps)) / 10_000n;
}

/** Compute a percentage with two-decimal precision via bigint math. */
function pctTwoDp(numer: bigint, denom: bigint): number {
  if (denom <= 0n) return 0;
  return Number((numer * 10_000n) / denom) / 100;
}

/**
 * Quote a multi-component paid action.
 *
 * @throws if any component has an invalid buffer_bps or negative baseline.
 */
export function quoteAction({ components, paid_usdc = null }: QuoteActionInput): ActionQuote {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('quoteAction: components must be a non-empty array');
  }
  const seenKeys = new Set<string>();
  let minimum = 0n;
  let total = 0n;
  const quoted: QuotedComponent[] = components.map((c) => {
    if (seenKeys.has(c.key)) throw new Error(`quoteAction: duplicate component key "${c.key}"`);
    seenKeys.add(c.key);
    if (c.baseline_usdc < 0n) {
      throw new Error(`quoteAction: component "${c.key}" has negative baseline`);
    }
    const buffered = applyBuffer(c.baseline_usdc, c.buffer_bps);
    minimum += c.baseline_usdc;
    total += buffered;
    return {
      key: c.key,
      label: c.label,
      baseline_usdc: c.baseline_usdc.toString(),
      buffered_usdc: buffered.toString(),
      buffer_bps: c.buffer_bps,
      is_revenue: !!c.is_revenue,
      display: {
        baseline: fmtUsd(c.baseline_usdc),
        buffered: fmtUsd(buffered),
      },
    };
  });

  const cushion = total - minimum;
  const bufferPercent = pctTwoDp(cushion, minimum);
  const fundedPercent = paid_usdc !== null && paid_usdc !== undefined
    ? pctTwoDp(paid_usdc, minimum)
    : null;

  return {
    components: quoted,
    minimum_required_usdc: minimum.toString(),
    total_usdc: total.toString(),
    buffer_cushion_usdc: cushion.toString(),
    buffer_percent: bufferPercent,
    funded_percent: fundedPercent,
    display: {
      minimum_required: fmtUsd(minimum),
      total: fmtUsd(total),
      buffer_cushion: fmtUsd(cushion),
    },
    quoted_at_ms: Date.now(),
  };
}
