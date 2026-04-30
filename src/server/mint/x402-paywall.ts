/**
 * Mint x402 paywall — Gholdengo Power Gem.
 *
 * Implements Coinbase's x402 protocol for paywalled HTTP endpoints:
 *   1. Client POSTs without X-PAYMENT → 402 + payment requirements JSON
 *   2. Client signs an EIP-712 transfer authorization with their wallet
 *   3. Client retries POST with X-PAYMENT: base64(authorization JSON)
 *   4. Server verifies signature locally (this module) and forwards
 *      verified payment to the registration handler
 *
 * Settlement (actually moving the USDC on-chain) is a separate concern
 * handled by Recover (next move). Power Gem only proves the protocol
 * surface — challenge + signature verify — works correctly.
 *
 * Reference: https://www.x402.org/ — Coinbase + Cloudflare's open spec.
 */

import { recoverTypedDataAddress, type Address } from 'viem';
import type { MintQuote } from './pricing.js';

// ─── Constants pinned to USDC on Base ──────────────────────────────────

/** USDC on Base mainnet (canonical for x402). */
export const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** ultron's IKA-DKG-derived EVM address. Receives all x402 USDC payments. */
export const ULTRON_EVM_RECEIVER =
  '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d' as const;

export const X402_VERSION = 1;
export const PAYMENT_TIMEOUT_SECONDS = 60;
export const X402_NETWORK = 'base'; // mainnet

// ─── 402 challenge shape ───────────────────────────────────────────────

export interface PaymentRequirement {
  scheme: 'exact';
  network: typeof X402_NETWORK;
  /** USDC base units (string for JSON-safety with bigints). */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: 'application/json';
  payTo: typeof ULTRON_EVM_RECEIVER;
  maxTimeoutSeconds: number;
  asset: typeof USDC_BASE_ADDRESS;
  extra: {
    name: 'USD Coin';
    version: '2';
  };
}

export interface X402Challenge {
  x402Version: typeof X402_VERSION;
  error: string;
  accepts: PaymentRequirement[];
}

export function buildChallenge(
  quote: MintQuote,
  resourceUrl: string,
  reasonError = 'X-PAYMENT header required',
): X402Challenge {
  return {
    x402Version: X402_VERSION,
    error: reasonError,
    accepts: [
      {
        scheme: 'exact',
        network: X402_NETWORK,
        maxAmountRequired: quote.total_usdc,
        resource: resourceUrl,
        description: `Mint ${quote.name}.sui (${quote.years}y) — total ${quote.display.total}, minimum required ${quote.display.minimum_required}`,
        mimeType: 'application/json',
        payTo: ULTRON_EVM_RECEIVER,
        maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
        asset: USDC_BASE_ADDRESS,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
}

// ─── X-PAYMENT header decode + EIP-712 verify ─────────────────────────

/**
 * EIP-3009 transferWithAuthorization payload — what the buyer signs.
 * Standard USDC contract on Base supports this; x402 uses it as the
 * payment-authorization primitive.
 */
export interface PaymentAuthorization {
  /** EIP-712 domain.name for USDC ("USD Coin"). */
  from: Address;
  to: Address;
  value: string; // USDC base units
  validAfter: string; // unix seconds
  validBefore: string; // unix seconds
  nonce: `0x${string}`; // 32-byte random
  signature: `0x${string}`; // 65-byte EIP-712 sig
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  scheme: 'exact';
  network: typeof X402_NETWORK;
  payload: PaymentAuthorization;
}

export function decodeXPaymentHeader(headerValue: string): PaymentPayload {
  let json: string;
  try {
    json = atob(headerValue);
  } catch {
    throw new Error('X-PAYMENT not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('X-PAYMENT not valid JSON');
  }
  const p = parsed as PaymentPayload;
  if (p?.x402Version !== X402_VERSION) {
    throw new Error(`X-PAYMENT x402Version mismatch (expected ${X402_VERSION})`);
  }
  if (p.scheme !== 'exact') {
    throw new Error(`X-PAYMENT scheme "${p.scheme}" unsupported (expected "exact")`);
  }
  if (p.network !== X402_NETWORK) {
    throw new Error(`X-PAYMENT network "${p.network}" unsupported (expected "${X402_NETWORK}")`);
  }
  if (!p.payload || typeof p.payload !== 'object') {
    throw new Error('X-PAYMENT missing payload');
  }
  return p;
}

/**
 * EIP-712 domain for USDC v2 on Base mainnet.
 * Critical for verify: any mismatch (chainId, contract, name, version) makes
 * the signature recover to a different address than the buyer.
 */
const USDC_BASE_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453, // Base mainnet
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface VerifiedPayment {
  buyer: Address;
  amount_usdc: bigint;
  nonce: `0x${string}`;
  validAfter: number;
  validBefore: number;
}

/**
 * Verify the buyer's EIP-712 signature recovers to the claimed `from`
 * address, the `to` matches our receiver, the amount covers `minRequired`,
 * and the time window is current.
 *
 * Throws on any failure with a specific reason. Returns a normalized
 * VerifiedPayment on success.
 *
 * @param payload    decoded X-PAYMENT payload
 * @param minRequired minimum USDC base units the payment must cover
 *                    (typically the quote's `total_usdc`, NOT minimum,
 *                    so the buffer cushion is preserved)
 */
export async function verifyPayment(
  payload: PaymentPayload,
  minRequired: bigint,
): Promise<VerifiedPayment> {
  const auth = payload.payload;

  // 1. Recipient must be ultron's EVM address.
  if (auth.to.toLowerCase() !== ULTRON_EVM_RECEIVER.toLowerCase()) {
    throw new Error(`payment to wrong receiver: ${auth.to}`);
  }

  // 2. Time window must be current.
  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (now < validAfter) throw new Error('payment not yet valid (validAfter in future)');
  if (now > validBefore) throw new Error('payment expired (validBefore in past)');
  // sanity: window must not be unreasonably long
  if (validBefore - validAfter > 24 * 60 * 60) {
    throw new Error('payment validity window exceeds 24h');
  }

  // 3. Amount must cover minimum required.
  let amount: bigint;
  try {
    amount = BigInt(auth.value);
  } catch {
    throw new Error('payment value not a valid integer');
  }
  if (amount < minRequired) {
    throw new Error(
      `payment underfunds: ${amount} < minRequired ${minRequired}`,
    );
  }

  // 4. Verify EIP-712 signature recovers to the claimed `from` address.
  const message = {
    from: auth.from,
    to: auth.to,
    value: amount,
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
  const recovered = await recoverTypedDataAddress({
    domain: USDC_BASE_DOMAIN,
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
    signature: auth.signature,
  });
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    throw new Error(
      `signature mismatch: recovered ${recovered}, claimed from ${auth.from}`,
    );
  }

  return {
    buyer: auth.from,
    amount_usdc: amount,
    nonce: auth.nonce,
    validAfter,
    validBefore,
  };
}
