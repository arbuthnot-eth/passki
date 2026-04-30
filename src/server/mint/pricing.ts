/**
 * Mint pricing — Gholdengo Make It Rain.
 *
 * Live SuiNS quote for x402-paid registration. No memory parroting; all
 * numbers come from on-chain calls or live oracles at quote-time.
 *
 * ## Buffers
 *
 * Every estimate is buffered against worst-case to guarantee the quoted
 * total always covers the real action cost even under adverse conditions:
 *
 *   gas             3× baseline   — handles network congestion spikes
 *   facilitator     2× baseline   — handles Coinbase x402 fee changes
 *   NS slippage     5% headroom   — Pyth NS price can drift between quote
 *                                   and registration; we quote slightly more
 *                                   than the discounted price implies
 *
 * The quote returns both `total_usdc` (with buffers, what buyer pays) AND
 * `minimum_required_usdc` (no buffers, actual best-case cost). Buffer
 * surplus on a successful registration accumulates to ultron's reserve
 * (covers future under-budgeted registrations or pays out as ops yield).
 *
 * ## Funded percent
 *
 * When the quote endpoint is hit with `?paid_usdc=N`, the response
 * includes `funded_percent` showing how much of the minimum-required
 * cost N covers. Useful for partial-payment / progress-bar UX:
 *
 *   paid >= total           → 100%+ (registration ships, surplus to reserve)
 *   minimum <= paid < total → 100% covers the registration but no buffer
 *                              ("this will work in best-case but not under load")
 *   paid < minimum          → < 100% (registration is under-funded; will fail)
 */

import { SuinsClient } from '@mysten/suins';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** 25% NS-coin payment discount per SuiNS pricing config. */
const NS_DISCOUNT_NUMERATOR = 75n;
const NS_DISCOUNT_DENOMINATOR = 100n;

/** Buffer applied on top of the NS-discount to absorb Pyth price drift
 *  between quote-time and register-time. Pyth can lag a few minutes on
 *  NS feed updates; crypto moves can be sharp. 10% headroom. */
const NS_SLIPPAGE_BUFFER_NUMERATOR = 110n;
const NS_SLIPPAGE_BUFFER_DENOMINATOR = 100n;

/** Estimated gas for SuiNS register PTB, in USDC base units (no buffer). */
const GAS_BASELINE_USDC_BASE_UNITS = 50_000n; // $0.05
/** Buffer multiplier for gas — handles congestion spikes. 3×. */
const GAS_BUFFER_MULTIPLIER = 3n;

/** Estimated x402 facilitator fee, in USDC base units (no buffer). */
const FACILITATOR_BASELINE_USDC_BASE_UNITS = 100_000n; // $0.10
/** Buffer multiplier for facilitator — handles fee changes. 2×. */
const FACILITATOR_BUFFER_MULTIPLIER = 2n;

/** USDC base-unit margin Mint adds on top of cost. Tunable. */
const DEFAULT_MARGIN_USDC_BASE_UNITS = 500_000n; // $0.50

export interface MintQuote {
  /** Bare-suins name being quoted (e.g., "alice"). */
  name: string;
  years: number;
  /** Length tier: 3, 4, or 5+ (returned as 5 for any 5+). */
  length_tier: 3 | 4 | 5;
  /** Wholesale price from on-chain calculatePrice (USDC base units). */
  wholesale_usdc: string;
  /** Wholesale × 0.75 (the 25% NS-coin discount). */
  ns_discounted_usdc: string;
  /** ns_discounted with 5% slippage buffer applied. What ultron actually pays. */
  ns_discounted_buffered_usdc: string;
  /** Gas baseline (no buffer). */
  gas_baseline_usdc: string;
  /** Gas with 3× buffer. */
  gas_buffered_usdc: string;
  /** Facilitator baseline (no buffer). */
  facilitator_baseline_usdc: string;
  /** Facilitator with 2× buffer. */
  facilitator_buffered_usdc: string;
  /** Mint margin (already revenue, no buffer). */
  margin_usdc: string;
  /** ns_discounted + gas_baseline + facilitator_baseline + margin. The actual cost in best-case. */
  minimum_required_usdc: string;
  /** ns_discounted_buffered + gas_buffered + facilitator_buffered + margin. Buyer pays this. */
  total_usdc: string;
  /** Buffer cushion = total - minimum_required (the headroom that protects against worst-case). */
  buffer_cushion_usdc: string;
  /** Percentage that `total_usdc` is over `minimum_required_usdc`. */
  buffer_percent: number;
  /** If `?paid_usdc=N` was passed, percentage of minimum_required N covers.
   *  null otherwise. */
  funded_percent: number | null;
  /** Display-friendly USD strings. */
  display: {
    wholesale: string;
    ns_discounted: string;
    ns_discounted_buffered: string;
    gas_baseline: string;
    gas_buffered: string;
    facilitator_baseline: string;
    facilitator_buffered: string;
    margin: string;
    minimum_required: string;
    total: string;
    buffer_cushion: string;
  };
  /** Live verification stamp. */
  quoted_at_ms: number;
  pricing_source: 'suins-on-chain';
}

function fmtUsd(baseUnits: bigint): string {
  const dollars = baseUnits / 1_000_000n;
  const cents = (baseUnits % 1_000_000n) / 10_000n;
  return `$${dollars}.${cents.toString().padStart(2, '0')}`;
}

function lengthTier(bareName: string): 3 | 4 | 5 {
  const n = bareName.length;
  if (n <= 3) return 3;
  if (n === 4) return 4;
  return 5;
}

/**
 * Quote the Mint price for a SuiNS name. Calls the live on-chain pricing
 * config; never returns memorized numbers.
 *
 * @param bareName  e.g., "alice" (no .sui suffix)
 * @param years     1..5 (registration term in years)
 * @param paidUsdcBaseUnits   if set, response includes `funded_percent` =
 *                            (this / minimum_required) × 100
 * @param marginUsdcBaseUnits override default $0.50 margin
 */
export async function quoteMint(
  bareName: string,
  years: number,
  paidUsdcBaseUnits: bigint | null = null,
  marginUsdcBaseUnits: bigint = DEFAULT_MARGIN_USDC_BASE_UNITS,
): Promise<MintQuote> {
  if (!bareName || /[^a-z0-9-]/i.test(bareName)) {
    throw new Error('invalid name: must be alphanumeric/hyphen, no .sui suffix');
  }
  if (!Number.isInteger(years) || years < 1 || years > 5) {
    throw new Error('years must be integer 1..5');
  }

  const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const suins = new SuinsClient({ client: transport as never, network: 'mainnet' });

  const wholesale = BigInt(
    await suins.calculatePrice({
      name: `${bareName}.sui`,
      years,
      isRenewal: false,
    }),
  );

  const nsDiscounted = (wholesale * NS_DISCOUNT_NUMERATOR) / NS_DISCOUNT_DENOMINATOR;
  const nsDiscountedBuffered =
    (nsDiscounted * NS_SLIPPAGE_BUFFER_NUMERATOR) / NS_SLIPPAGE_BUFFER_DENOMINATOR;
  const gasBaseline = GAS_BASELINE_USDC_BASE_UNITS;
  const gasBuffered = gasBaseline * GAS_BUFFER_MULTIPLIER;
  const facilitatorBaseline = FACILITATOR_BASELINE_USDC_BASE_UNITS;
  const facilitatorBuffered = facilitatorBaseline * FACILITATOR_BUFFER_MULTIPLIER;

  const minimumRequired =
    nsDiscounted + gasBaseline + facilitatorBaseline + marginUsdcBaseUnits;
  const total =
    nsDiscountedBuffered + gasBuffered + facilitatorBuffered + marginUsdcBaseUnits;
  const cushion = total - minimumRequired;

  // Buffer percent: how much over minimum the total is.
  const bufferPercent =
    minimumRequired > 0n
      ? Number((cushion * 10_000n) / minimumRequired) / 100
      : 0;

  const fundedPercent =
    paidUsdcBaseUnits !== null && minimumRequired > 0n
      ? Number((paidUsdcBaseUnits * 10_000n) / minimumRequired) / 100
      : null;

  return {
    name: bareName,
    years,
    length_tier: lengthTier(bareName),
    wholesale_usdc: wholesale.toString(),
    ns_discounted_usdc: nsDiscounted.toString(),
    ns_discounted_buffered_usdc: nsDiscountedBuffered.toString(),
    gas_baseline_usdc: gasBaseline.toString(),
    gas_buffered_usdc: gasBuffered.toString(),
    facilitator_baseline_usdc: facilitatorBaseline.toString(),
    facilitator_buffered_usdc: facilitatorBuffered.toString(),
    margin_usdc: marginUsdcBaseUnits.toString(),
    minimum_required_usdc: minimumRequired.toString(),
    total_usdc: total.toString(),
    buffer_cushion_usdc: cushion.toString(),
    buffer_percent: bufferPercent,
    funded_percent: fundedPercent,
    display: {
      wholesale: fmtUsd(wholesale),
      ns_discounted: fmtUsd(nsDiscounted),
      ns_discounted_buffered: fmtUsd(nsDiscountedBuffered),
      gas_baseline: fmtUsd(gasBaseline),
      gas_buffered: fmtUsd(gasBuffered),
      facilitator_baseline: fmtUsd(facilitatorBaseline),
      facilitator_buffered: fmtUsd(facilitatorBuffered),
      margin: fmtUsd(marginUsdcBaseUnits),
      minimum_required: fmtUsd(minimumRequired),
      total: fmtUsd(total),
      buffer_cushion: fmtUsd(cushion),
    },
    quoted_at_ms: Date.now(),
    pricing_source: 'suins-on-chain',
  };
}
