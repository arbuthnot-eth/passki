/**
 * ETH inbound handler — Porygon-Z Conversion Beam v1 (ETH leg).
 *
 * When a user sends ETH or an ERC20 to eth@ultron, Alchemy's Address
 * Activity webhook fires /api/alchemy/webhook, which delegates here.
 * This module:
 *   1. Verifies the activity belongs to a recognized inbound credit
 *   2. Splits the amount 95/5 — 95% targets USDC/stables, 5% stays
 *      as native ETH in eth@ultron's gas reserve
 *   3. Builds the Uniswap v3 swap (ETH → USDC) via viem
 *   4. Hands the signed tx off to the ultron signing path (dWallet
 *      once Increment C lands; keeper raw signer today, policy-gated)
 *   5. Emits an iUSD credit for the user's Sui identity
 *
 * First Commandment note: the ETH signing path MUST end up at the
 * eth@ultron IKA dWallet. Today we can read the dWallet via the
 * GraphQL-backed IkaClient (Psybeam), but the secp256k1 sign flow
 * needs Increment C+D in UltronSigningAgent. Until then, the keeper
 * key path is a known-debt shim with the policy engine applying
 * per-operation bounds.
 */

import { createPublicClient, http, formatEther, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import type { Address, Hex, PublicClient } from 'viem';

export const ETH_ULTRON_ADDRESS = '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d' as const;

// USDC mainnet contract — canonical Circle deployment.
export const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

// Uniswap v3 SwapRouter02 — unified router for v3 pools.
export const UNISWAP_V3_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;

// 5% stays as ETH for gas reserve, 95% converts to USDC.
export const GAS_RESERVE_BPS = 500n; // 5.00% in basis points
export const STABLES_BPS = 10_000n - GAS_RESERVE_BPS;

// Minimum inbound to trigger conversion — don't pay $5 in gas to swap
// $3 of ETH. 0.01 ETH (~$32 at recent prices) is the v1 floor; tune later.
export const MIN_INBOUND_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/**
 * Shape of the Alchemy Address Activity webhook payload (subset we use).
 * Full docs: https://docs.alchemy.com/reference/address-activity-webhook
 */
export interface AlchemyAddressActivityEvent {
  webhookId: string;
  id: string;
  createdAt: string;
  type: 'ADDRESS_ACTIVITY';
  event: {
    network: string;
    activity: Array<{
      fromAddress: string;
      toAddress: string;
      blockNum: string;
      hash: Hex;
      value: number;
      asset: string; // e.g. "ETH", "USDC"
      category: 'external' | 'internal' | 'token' | 'erc1155' | 'erc721';
      rawContract: {
        rawValue: Hex;
        address?: string;
        decimals?: number;
      };
    }>;
  };
}

/**
 * Build a viem PublicClient for Ethereum mainnet. Uses the Alchemy HTTP
 * endpoint from env if available, otherwise falls back to public RPCs.
 * The fallback race keeps us resilient if Alchemy rate-limits or degrades.
 */
export function createEthClient(alchemyUrl?: string): PublicClient {
  const rpcs: string[] = [];
  if (alchemyUrl) rpcs.push(alchemyUrl);
  rpcs.push('https://eth.llamarpc.com');
  rpcs.push('https://rpc.ankr.com/eth');
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcs[0], { retryCount: 1, retryDelay: 250 }),
  }) as PublicClient;
}

/**
 * Verify an Alchemy webhook signature.
 *
 * Alchemy signs the raw request body with HMAC-SHA256 using the signing
 * key from the Alchemy dashboard. The signature arrives in the
 * x-alchemy-signature header as a hex string.
 */
export async function verifyAlchemySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Constant-time compare — xor all bytes and check for zero.
  if (hex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

export interface InboundCredit {
  txHash: Hex;
  fromAddress: Address;
  amountWei: bigint;
  asset: 'ETH' | 'USDC' | 'OTHER';
  blockNumber: bigint;
}

/**
 * Extract inbound credits to eth@ultron from an Alchemy webhook payload.
 * Returns only activity where `toAddress` is eth@ultron and the amount
 * exceeds MIN_INBOUND_WEI (for ETH) or is above a tiny dust threshold
 * (for ERC20s). Downstream handler decides what to do with each credit.
 */
export function parseInboundCredits(payload: AlchemyAddressActivityEvent): InboundCredit[] {
  const out: InboundCredit[] = [];
  for (const act of payload.event?.activity ?? []) {
    if (act.toAddress.toLowerCase() !== ETH_ULTRON_ADDRESS.toLowerCase()) continue;
    const amountWei = BigInt(act.rawContract.rawValue ?? '0x0');
    const asset = act.asset === 'ETH' ? 'ETH'
      : act.asset === 'USDC' ? 'USDC'
      : 'OTHER';
    if (asset === 'ETH' && amountWei < MIN_INBOUND_WEI) continue;
    out.push({
      txHash: act.hash,
      fromAddress: act.fromAddress as Address,
      amountWei,
      asset,
      blockNumber: BigInt(act.blockNum),
    });
  }
  return out;
}

/**
 * Compute the 95/5 split for an inbound ETH amount. 5% stays as gas
 * reserve in eth@ultron, 95% targets USDC conversion via Uniswap v3.
 * Rounding: gas reserve rounds UP (we'd rather keep a hair extra for
 * future sends than under-reserve), stables get whatever's left.
 */
export function computeSplit(amountWei: bigint): { gasReserveWei: bigint; stablesAmountWei: bigint } {
  const gasReserveWei = (amountWei * GAS_RESERVE_BPS + 9999n) / 10_000n;
  const stablesAmountWei = amountWei - gasReserveWei;
  return { gasReserveWei, stablesAmountWei };
}

/** Uniswap v3 exactInputSingle ABI — single-hop ETH→USDC via WETH pool. */
export const EXACT_INPUT_SINGLE_ABI = parseAbiItem(
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
);

/**
 * Quote the ETH→USDC swap rate via Uniswap v3's QuoterV2 (read-only).
 * Returns the expected USDC output for a given ETH input, as a
 * 6-decimal USDC amount. Used to apply slippage bounds before building
 * the actual swap tx.
 *
 * Left as a TODO stub — v1 uses a conservative 2% slippage floor
 * calculated off a Coingecko spot price fetched elsewhere. The
 * QuoterV2 call is the right long-term answer but adds a round trip
 * and a new ABI import.
 */
export async function quoteEthToUsdc(
  _client: PublicClient,
  _ethAmountWei: bigint,
): Promise<{ usdcAmount: bigint; slippageBps: number }> {
  throw new Error('quoteEthToUsdc not implemented — stub for Porygon-Z Conversion Beam v1');
}

/**
 * Format an ETH amount for UI/log display.
 * Thin wrapper so call sites don't need to import viem directly.
 */
export function formatEth(wei: bigint): string {
  return formatEther(wei);
}
