/**
 * Mint payment helper — Gholdengo Recover pt2 (Browser Submit).
 *
 * Browser-side x402 settlement. The buyer's own wallet:
 *   1. Signs an EIP-3009 transferWithAuthorization for USDC on Base.
 *   2. Submits `usdc.transferWithAuthorization(...)` from the SAME wallet.
 *   3. Waits for confirmation, then re-calls our register endpoint with
 *      X-PAYMENT (the signed auth, base64) and X-PAYMENT-TX-HASH.
 *
 * Our Cloudflare Worker NEVER holds a private key — first commandment of
 * the codebase, no exceptions. There is no MINT_GAS_RELAY_PRIVATE_KEY,
 * no server-side settle.ts, no recover.ts. The buyer pays gas; ultron's
 * EVM-DKG receiver gets the USDC; the server only verifies + registers.
 *
 * Wire format mirrors `src/server/mint/x402-paywall.ts`:
 *   X-PAYMENT  = base64(JSON.stringify({ x402Version, scheme, network, payload }))
 *   payload    = { from, to, value, validAfter, validBefore, nonce, signature }
 */

import {
  encodeFunctionData,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';

// ─── Constants — must match server/mint/x402-paywall.ts exactly ──────────

/** USDC on Base mainnet. */
const USDC_BASE_ADDRESS =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** ultron.sui IKA-DKG-derived EVM address. Receives all x402 USDC. */
const ULTRON_EVM_RECEIVER =
  '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d' as const;

const X402_VERSION = 1 as const;
const X402_NETWORK = 'base' as const;
const BASE_CHAIN_ID = 8453 as const;

/** EIP-712 domain for USDC v2 on Base mainnet. */
const USDC_BASE_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: BASE_CHAIN_ID,
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

/** Validity window for the signed authorization. */
const VALID_AFTER_BACKDATE_SECONDS = 60n; // tolerate a minute of clock skew
const VALID_BEFORE_FORWARD_SECONDS = 30n * 60n; // 30 minutes to land on Base

/** Minimal ABI fragment for `transferWithAuthorization` on USDC. */
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────

/** Subset of the Mint quote response we actually consume. */
export interface MintQuoteLite {
  name: string;
  years: number;
  /** USDC base units as a decimal string (matches server JSON shape). */
  total_usdc: string;
}

export interface PayAndMintArgs {
  quote: MintQuoteLite;
  /** Connected viem WalletClient (must have an account + Base chain access). */
  wallet: WalletClient;
  /** Sui address that should receive the registered NFT. */
  suiTarget: string;
  /** Optional override for the register endpoint base URL. */
  apiBase?: string;
}

export interface PayAndMintResult {
  ok: boolean;
  stage: string;
  name: string;
  years: number;
  target: string;
  registration: { digest: string; nft_id: string };
  payment: { buyer: Address; amount_usdc: string; base_tx_hash: Hex | null };
  /** Raw response body for callers that want extra fields. */
  raw: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Crypto-random 32-byte nonce, hex-encoded. */
function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** Base64-encode a UTF-8 string in a browser-safe way. */
function b64encode(s: string): string {
  // btoa requires latin1; encode UTF-8 first then map bytes to latin1.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Split a 65-byte EIP-712 sig into v/r/s for the on-chain call. */
function splitSig(sig: Hex): { v: number; r: Hex; s: Hex } {
  const raw = sig.slice(2);
  if (raw.length !== 130) {
    throw new Error(`unexpected signature length: ${raw.length}`);
  }
  const r = ('0x' + raw.slice(0, 64)) as Hex;
  const s = ('0x' + raw.slice(64, 128)) as Hex;
  let v = parseInt(raw.slice(128, 130), 16);
  if (v < 27) v += 27; // some wallets return 0/1
  return { v, r, s };
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Sign an EIP-3009 authorization, submit `transferWithAuthorization` on Base
 * from the buyer's own wallet, then call the server's register endpoint with
 * the signed authorization in `X-PAYMENT` so it can verify + finalize the
 * Sui-side registration.
 *
 * Throws on any failure with a specific reason.
 */
export async function payAndMint(
  args: PayAndMintArgs,
): Promise<PayAndMintResult> {
  const { quote, wallet, suiTarget } = args;
  const apiBase = args.apiBase ?? '';

  const account = wallet.account;
  if (!account) {
    throw new Error('wallet has no connected account');
  }
  const from = account.address as Address;
  const to = ULTRON_EVM_RECEIVER as Address;
  const value = BigInt(quote.total_usdc);
  if (value <= 0n) {
    throw new Error(`quote.total_usdc must be positive (got ${quote.total_usdc})`);
  }

  // 1. Build authorization message.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - VALID_AFTER_BACKDATE_SECONDS;
  const validBefore = now + VALID_BEFORE_FORWARD_SECONDS;
  const nonce = randomNonce();

  const message = {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  } as const;

  // 2. Buyer signs typed data.
  const signature = (await wallet.signTypedData({
    account,
    domain: USDC_BASE_DOMAIN,
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  })) as Hex;

  // 3. Buyer submits the on-chain transferWithAuthorization themselves.
  const { v, r, s } = splitSig(signature);
  const data = encodeFunctionData({
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'transferWithAuthorization',
    args: [from, to, value, validAfter, validBefore, nonce, v, r, s],
  });

  // sendTransaction needs a chain object; viem accepts the chain id via
  // the wallet's current connection — fall back to chain on the wallet.
  const txHash = (await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to: USDC_BASE_ADDRESS,
    data,
    value: 0n,
  })) as Hex;

  // 4. Wait for confirmation if the wallet exposes a public client.
  // We don't strictly need the receipt for the server (it can verify
  // independently), but the buyer's UX is much better if we block here.
  await waitForBaseTx(wallet, txHash);

  // 5. Build X-PAYMENT (base64 of the signed payload).
  const paymentPayload = {
    x402Version: X402_VERSION,
    scheme: 'exact' as const,
    network: X402_NETWORK,
    payload: {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    },
  };
  const xPayment = b64encode(JSON.stringify(paymentPayload));

  // 6. POST to /api/mint/register/:name?sui_target=...
  const url = `${apiBase}/api/mint/register/${encodeURIComponent(quote.name)}?sui_target=${encodeURIComponent(
    suiTarget,
  )}&years=${quote.years}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': xPayment,
      'X-PAYMENT-TX-HASH': txHash,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason =
      typeof body?.error === 'string'
        ? body.error
        : `register failed (${res.status})`;
    throw new Error(reason);
  }

  return {
    ok: Boolean(body.ok),
    stage: typeof body.stage === 'string' ? body.stage : 'registered',
    name: typeof body.name === 'string' ? body.name : quote.name,
    years:
      typeof body.years === 'number' ? body.years : quote.years,
    target:
      typeof body.target === 'string' ? body.target : suiTarget,
    registration: (body.registration as PayAndMintResult['registration']) ?? {
      digest: '',
      nft_id: '',
    },
    payment: (body.payment as PayAndMintResult['payment']) ?? {
      buyer: from,
      amount_usdc: value.toString(),
      base_tx_hash: txHash,
    },
    raw: body,
  };
}

/**
 * Best-effort wait for a Base tx to confirm. If the wallet doesn't expose
 * a public client, we just yield to the buyer — server-side verification
 * can still confirm via X-PAYMENT-TX-HASH.
 */
async function waitForBaseTx(wallet: WalletClient, hash: Hex): Promise<void> {
  // Some wallet integrations attach a `.transport.request` we could call
  // via eth_getTransactionReceipt. Keep it minimal and non-fatal: poll up
  // to ~30s, swallow errors so a missing public client doesn't block mint.
  const transport = (
    wallet as unknown as { transport?: { request?: (args: unknown) => Promise<unknown> } }
  ).transport;
  if (!transport?.request) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const receipt = await transport.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      });
      if (receipt && (receipt as { status?: string }).status === '0x1') return;
      if (receipt && (receipt as { status?: string }).status === '0x0') {
        throw new Error(`Base tx reverted: ${hash}`);
      }
    } catch {
      // ignore + retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
