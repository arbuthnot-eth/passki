/**
 * Mint pricing — Gholdengo Make It Rain.
 *
 * Live SuiNS quote for x402-paid registration. Composes the generic
 * `quoteAction` helper from `src/server/quote/` with Mint-specific cost
 * components.
 *
 * No memory parroting; wholesale comes from on-chain `calculatePrice` at
 * each request. Buffers are tuned per-component (NS slippage, gas spike,
 * facilitator fee changes). See `src/server/quote/index.ts` for the
 * generic helper's contract — including `funded_percent` semantics.
 */

import { SuinsClient } from '@mysten/suins';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  quoteAction,
  BUFFER_10_PERCENT,
  BUFFER_2X,
  BUFFER_3X,
  NO_BUFFER,
  type ActionQuote,
} from '../quote/index.js';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** 25% NS-coin payment discount per SuiNS pricing config. */
const NS_DISCOUNT_NUMERATOR = 75n;
const NS_DISCOUNT_DENOMINATOR = 100n;

/** Estimated Sui gas for a SuiNS register PTB. Refined later from dry-runs. */
const GAS_BASELINE_USDC = 50_000n; // $0.05

/** Estimated x402 facilitator fee. Real number depends on Coinbase config. */
const FACILITATOR_BASELINE_USDC = 100_000n; // $0.10

/** Mint margin (revenue, no buffer). Tunable by caller. */
const DEFAULT_MARGIN_USDC = 500_000n; // $0.50

export interface MintQuote extends ActionQuote {
  /** Bare-suins name being quoted (e.g., "alice"). */
  name: string;
  years: number;
  /** Length tier: 3, 4, or 5+ (returned as 5 for any 5+). */
  length_tier: 3 | 4 | 5;
  /** Wholesale price from on-chain calculatePrice (USDC base units). */
  wholesale_usdc: string;
  pricing_source: 'suins-on-chain';
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
 * @param bareName            e.g., "alice" (no .sui suffix)
 * @param years               1..5 (registration term in years)
 * @param paidUsdcBaseUnits   if set, response includes `funded_percent` =
 *                            (this / minimum_required) × 100
 * @param marginUsdcBaseUnits override default $0.50 margin
 */
export async function quoteMint(
  bareName: string,
  years: number,
  paidUsdcBaseUnits: bigint | null = null,
  marginUsdcBaseUnits: bigint = DEFAULT_MARGIN_USDC,
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

  const action = quoteAction({
    components: [
      {
        key: 'ns_wholesale',
        label: 'NS-paid wholesale',
        baseline_usdc: nsDiscounted,
        buffer_bps: BUFFER_10_PERCENT, // Pyth NS feed lag + intra-tx drift
      },
      {
        key: 'gas',
        label: 'Sui gas',
        baseline_usdc: GAS_BASELINE_USDC,
        buffer_bps: BUFFER_3X, // network-congestion spikes
      },
      {
        key: 'facilitator',
        label: 'x402 facilitator',
        baseline_usdc: FACILITATOR_BASELINE_USDC,
        buffer_bps: BUFFER_2X, // Coinbase x402 fee changes
      },
      {
        key: 'margin',
        label: 'Mint margin',
        baseline_usdc: marginUsdcBaseUnits,
        buffer_bps: NO_BUFFER,
        is_revenue: true,
      },
    ],
    paid_usdc: paidUsdcBaseUnits,
  });

  return {
    ...action,
    name: bareName,
    years,
    length_tier: lengthTier(bareName),
    wholesale_usdc: wholesale.toString(),
    pricing_source: 'suins-on-chain',
  };
}
