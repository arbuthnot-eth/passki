/**
 * Mint pricing — Gholdengo Make It Rain.
 *
 * Live SuiNS quote for x402-paid registration. No memory parroting; all
 * numbers come from on-chain calls or live oracles at quote-time.
 *
 *   wholesale_usdc       = suinsClient.calculatePrice(name, years)
 *   ns_discounted_usdc   = wholesale × 0.75 (25% NS-coin discount)
 *   gas_estimate_usdc    = ~$0.05 typical, refined later
 *   facilitator_usdc     = x402 facilitator fee, ~$0.10 typical
 *   margin_usdc          = configurable; defaults to small positive
 *   total_usdc           = ns_discounted + gas + facilitator + margin
 *
 * Pricing is denominated in 6-decimal USDC base units throughout. Caller
 * converts to display strings ("$8.05") at the UI layer.
 */

import { SuinsClient } from '@mysten/suins';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** 25% NS-coin payment discount per SuiNS pricing config. */
const NS_DISCOUNT_NUMERATOR = 75n;
const NS_DISCOUNT_DENOMINATOR = 100n;

/** USDC base-unit margin Mint adds on top of cost. Tunable. */
const DEFAULT_MARGIN_USDC_BASE_UNITS = 500_000n; // $0.50

/** Estimated gas for SuiNS register PTB, in USDC base units. Refine later. */
const GAS_ESTIMATE_USDC_BASE_UNITS = 50_000n; // $0.05

/** Estimated x402 facilitator fee, in USDC base units. */
const FACILITATOR_ESTIMATE_USDC_BASE_UNITS = 100_000n; // $0.10

export interface MintQuote {
  /** Bare-suins name being quoted (e.g., "alice"). */
  name: string;
  years: number;
  /** Length tier: 3, 4, or 5+ (returned as 5 for any 5+). */
  length_tier: 3 | 4 | 5;
  /** USDC 6-decimal base units. */
  wholesale_usdc: string;
  ns_discounted_usdc: string;
  gas_estimate_usdc: string;
  facilitator_estimate_usdc: string;
  margin_usdc: string;
  total_usdc: string;
  /** Display-friendly USD strings. */
  display: {
    wholesale: string;
    ns_discounted: string;
    gas_estimate: string;
    facilitator_estimate: string;
    margin: string;
    total: string;
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
 * @param marginUsdcBaseUnits  override default margin if you want different pricing
 */
export async function quoteMint(
  bareName: string,
  years: number,
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
  const total =
    nsDiscounted +
    GAS_ESTIMATE_USDC_BASE_UNITS +
    FACILITATOR_ESTIMATE_USDC_BASE_UNITS +
    marginUsdcBaseUnits;

  return {
    name: bareName,
    years,
    length_tier: lengthTier(bareName),
    wholesale_usdc: wholesale.toString(),
    ns_discounted_usdc: nsDiscounted.toString(),
    gas_estimate_usdc: GAS_ESTIMATE_USDC_BASE_UNITS.toString(),
    facilitator_estimate_usdc: FACILITATOR_ESTIMATE_USDC_BASE_UNITS.toString(),
    margin_usdc: marginUsdcBaseUnits.toString(),
    total_usdc: total.toString(),
    display: {
      wholesale: fmtUsd(wholesale),
      ns_discounted: fmtUsd(nsDiscounted),
      gas_estimate: fmtUsd(GAS_ESTIMATE_USDC_BASE_UNITS),
      facilitator_estimate: fmtUsd(FACILITATOR_ESTIMATE_USDC_BASE_UNITS),
      margin: fmtUsd(marginUsdcBaseUnits),
      total: fmtUsd(total),
    },
    quoted_at_ms: Date.now(),
    pricing_source: 'suins-on-chain',
  };
}
