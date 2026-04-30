/**
 * Power Gem tests — x402 challenge + payment verify.
 *
 * Uses viem's local-account signing to produce real EIP-712 signatures
 * we can round-trip through the verify path. Catches real bugs, not just
 * shape mismatches.
 */
import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import {
  USDC_BASE_ADDRESS,
  ULTRON_EVM_RECEIVER,
  buildChallenge,
  decodeXPaymentHeader,
  verifyPayment,
  X402_VERSION,
} from './x402-paywall.ts';
import type { PaymentPayload } from './x402-paywall.ts';
import type { MintQuote } from './pricing.ts';

const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function fakeQuote(name: string, total = '9100000', minimum = '8150000'): MintQuote {
  return {
    name,
    years: 1,
    length_tier: 5,
    wholesale_usdc: '10000000',
    pricing_source: 'suins-on-chain',
    components: [],
    minimum_required_usdc: minimum,
    total_usdc: total,
    buffer_cushion_usdc: (BigInt(total) - BigInt(minimum)).toString(),
    buffer_percent: 11.65,
    funded_percent: null,
    display: { minimum_required: '$8.15', total: '$9.10', buffer_cushion: '$0.95' },
    quoted_at_ms: Date.now(),
  };
}

async function makeSignedPayment(
  privKey: `0x${string}`,
  amountUsdc: bigint,
  toOverride?: `0x${string}`,
  validityWindow = 60,
): Promise<PaymentPayload> {
  const account = privateKeyToAccount(privKey);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 5;
  const validBefore = now + validityWindow;
  const nonce = keccak256(toBytes(`nonce-${Date.now()}-${Math.random()}`));
  const message = {
    from: account.address,
    to: toOverride || ULTRON_EVM_RECEIVER,
    value: amountUsdc,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };
  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: 'base',
    payload: {
      from: account.address,
      to: message.to,
      value: amountUsdc.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    },
  };
}

describe('buildChallenge', () => {
  test('shape matches x402 spec', () => {
    const ch = buildChallenge(fakeQuote('alice'), 'https://passki.xyz/api/mint/register');
    expect(ch.x402Version).toBe(X402_VERSION);
    expect(ch.accepts).toHaveLength(1);
    expect(ch.accepts[0].network).toBe('base');
    expect(ch.accepts[0].scheme).toBe('exact');
    expect(ch.accepts[0].payTo).toBe(ULTRON_EVM_RECEIVER);
    expect(ch.accepts[0].asset).toBe(USDC_BASE_ADDRESS);
    expect(ch.accepts[0].maxAmountRequired).toBe('9100000');
  });

  test('description includes display amounts', () => {
    const ch = buildChallenge(fakeQuote('alice'), '/api/mint/register');
    expect(ch.accepts[0].description).toContain('alice.sui');
    expect(ch.accepts[0].description).toContain('$9.10');
    expect(ch.accepts[0].description).toContain('$8.15');
  });
});

describe('decodeXPaymentHeader', () => {
  test('rejects non-base64', () => {
    expect(() => decodeXPaymentHeader('not\x00valid\x00b64\x00')).toThrow();
  });
  test('rejects invalid JSON', () => {
    expect(() => decodeXPaymentHeader(btoa('not json'))).toThrow(/JSON/);
  });
  test('rejects wrong x402Version', () => {
    const enc = btoa(JSON.stringify({ x402Version: 999, scheme: 'exact', network: 'base', payload: {} }));
    expect(() => decodeXPaymentHeader(enc)).toThrow(/x402Version/);
  });
  test('rejects wrong scheme', () => {
    const enc = btoa(JSON.stringify({ x402Version: 1, scheme: 'streaming', network: 'base', payload: {} }));
    expect(() => decodeXPaymentHeader(enc)).toThrow(/scheme/);
  });
});

describe('verifyPayment', () => {
  const privKey = generatePrivateKey();

  test('valid signed payment returns VerifiedPayment', async () => {
    const payload = await makeSignedPayment(privKey, 9_100_000n);
    const verified = await verifyPayment(payload, 8_150_000n);
    expect(verified.amount_usdc).toBe(9_100_000n);
    expect(verified.buyer).toBe(privateKeyToAccount(privKey).address);
  });

  test('rejects under-funded payment', async () => {
    const payload = await makeSignedPayment(privKey, 5_000_000n);
    expect(verifyPayment(payload, 8_150_000n)).rejects.toThrow(/underfunds/);
  });

  test('rejects payment to wrong receiver', async () => {
    const payload = await makeSignedPayment(
      privKey,
      9_100_000n,
      '0x0000000000000000000000000000000000000001',
    );
    expect(verifyPayment(payload, 8_150_000n)).rejects.toThrow(/wrong receiver/);
  });

  test('rejects expired payment', async () => {
    // sign with -10s window → already expired
    const payload = await makeSignedPayment(privKey, 9_100_000n, undefined, -10);
    expect(verifyPayment(payload, 8_150_000n)).rejects.toThrow(/expired/);
  });

  test('rejects forged signature (modified value after signing)', async () => {
    const payload = await makeSignedPayment(privKey, 8_150_000n);
    payload.payload.value = '12000000'; // attacker bumps after signing
    expect(verifyPayment(payload, 8_150_000n)).rejects.toThrow(/signature mismatch/);
  });
});
