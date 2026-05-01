/**
 * Mint x402 settlement via IKA-native signing — Gholdengo Astonish.
 *
 * Settles a buyer-signed EIP-3009 transferWithAuthorization on Base by
 * having ultron's IKA secp256k1 dWallet sign the outer EVM transaction.
 *
 * **No private keys on the Worker.** Ultron's secp256k1 dWallet
 * (`0xbb8b…6acb`, cap `0x1034…498a2`) is the on-chain key behind
 * `0xcaA8…882d`. The Worker constructs the unsigned tx, computes the
 * keccak256 hash, hands it to UltronSigningAgent (Durable Object) which
 * runs the IKA presign+sign ceremony, gets back the secp256k1 signature,
 * recovers yParity, RLP-encodes the signed tx, submits to Base RPC.
 *
 * First commandment respected: every signing operation is mediated by
 * the IKA committee. The Worker never sees a plaintext private key.
 *
 * Status: implemented end-to-end, but ultron's Base address must be
 * funded with ETH for gas before the first settle call works. See
 * `relayHealth` (no longer present — was the violating relay path).
 * Top-up procedure: send ~$0.50 of ETH on Base to `0xcaA8…882d`. Each
 * `transferWithAuthorization` costs ~80k gas (~$0.005 at 0.01 gwei).
 *
 * For agent-friendly clients without an EVM wallet, this is the path:
 *   1. Agent signs EIP-3009 authorization with their wallet
 *   2. POSTs to /api/mint/register/:name with X-PAYMENT + sui_target
 *   3. Server verifies the buyer signature (Power Gem)
 *   4. settleViaIka pulls the USDC on Base via ultron's IKA dWallet
 *   5. registerFromUltronPool registers the SuiNS name
 *
 * For browser users, `src/client/mint-pay.ts` is the simpler path —
 * buyer's own wallet pays gas and submits. IKA-pay is the headless/agent
 * fallback where the buyer can't (or doesn't want to) pay Base gas.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  recoverAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { base } from 'viem/chains';
import {
  ULTRON_EVM_RECEIVER,
  USDC_BASE_ADDRESS,
  type VerifiedPayment,
} from './x402-paywall.js';

/** ultron's secp256k1 dWallet id — verified on-chain 2026-04-30. */
const ULTRON_SECP256K1_DWALLET_ID =
  '0xbb8bce5447722a4c6f5f64618164d8420551dfdbc7605afe279a85de1ebb6acb';

/** Estimated gas for transferWithAuthorization. ~78k typical, buffer to 120k. */
const TRANSFER_WITH_AUTH_GAS = 120_000n;

const USDC_ABI = [
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

interface IkaSettleEnv {
  UltronSigningAgent: DurableObjectNamespace;
  /** Base RPC URL. Defaults to https://mainnet.base.org. */
  BASE_RPC_URL?: string;
}

export interface IkaSettlementResult {
  ok: true;
  base_tx_hash: Hex;
  amount_usdc: string;
  buyer: Address;
  receiver: Address;
  signed_via: 'ika-dwallet-secp256k1';
}

function splitBuyerSig(sig: Hex): { v: number; r: Hex; s: Hex } {
  const stripped = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (stripped.length !== 130) {
    throw new Error(`buyer sig must be 65 bytes (130 hex), got ${stripped.length / 2}`);
  }
  return {
    r: `0x${stripped.slice(0, 64)}` as Hex,
    s: `0x${stripped.slice(64, 128)}` as Hex,
    v: parseInt(stripped.slice(128, 130), 16),
  };
}

function hexToU8(hex: Hex | string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Ask UltronSigningAgent (Durable Object) to sign a 32-byte keccak256
 * digest with ultron's secp256k1 IKA dWallet. Returns 64-byte (r||s).
 *
 * `signForStealth` is `@callable`; hono-agents exposes callables on the
 * DO at `/agents/<class>/<instance>/call/<method>`. We post the args as
 * a single object.
 */
async function callUltronSign(env: IkaSettleEnv, hash: Hex): Promise<Hex> {
  const id = env.UltronSigningAgent.idFromName('ultron');
  const stub = env.UltronSigningAgent.get(id);

  const resp = await stub.fetch(
    'https://internal/agents/ultron-signing-agent/ultron/call/signForStealth',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: {
          dwalletId: ULTRON_SECP256K1_DWALLET_ID,
          hash,
          curve: 'secp256k1',
        },
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => '<unreadable>');
    throw new Error(`UltronSigningAgent ${resp.status}: ${text.slice(0, 300)}`);
  }
  const result = (await resp.json()) as {
    sig?: Hex;
    result?: { sig?: Hex };
    error?: string;
  };
  const sig = result.sig ?? result.result?.sig;
  if (!sig) {
    throw new Error(`UltronSigningAgent returned no sig: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return sig;
}

/**
 * Recover yParity (0 or 1) by trying both v=27 and v=28 against the
 * known-correct ultron Base address.
 */
async function recoverYParity(messageHash: Hex, r: Hex, s: Hex): Promise<0 | 1> {
  for (const v of [27n, 28n] as const) {
    const recovered = await recoverAddress({ hash: messageHash, signature: { r, s, v } });
    if (recovered.toLowerCase() === ULTRON_EVM_RECEIVER.toLowerCase()) {
      return (v === 27n ? 0 : 1) as 0 | 1;
    }
  }
  throw new Error(
    `signature did not recover to ULTRON_EVM_RECEIVER (${ULTRON_EVM_RECEIVER}). ` +
    `IKA returned a sig for a different key. Check ULTRON_SECP256K1_DWALLET_ID.`,
  );
}

/**
 * Settle a buyer's x402 payment on Base via ultron's IKA dWallet.
 *
 * Steps:
 *   1. Encode `transferWithAuthorization` calldata with buyer's args + sig.
 *   2. Fetch ultron's nonce + gas data on Base.
 *   3. Build EIP-1559 unsigned tx (type 0x02, chainId=8453).
 *   4. keccak256 of serialized unsigned tx → message hash.
 *   5. UltronSigningAgent presign+sign ceremony → 64-byte (r||s).
 *   6. Recover yParity by trying both, match against ultron's known addr.
 *   7. RLP-encode signed tx (viem.serializeTransaction with signature).
 *   8. Submit to Base RPC, wait for receipt, verify status='success'.
 */
export async function settleViaIka(
  env: IkaSettleEnv,
  payment: VerifiedPayment,
  buyerSignature: Hex,
): Promise<IkaSettlementResult> {
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  // 1. Encode the transferWithAuthorization call.
  const buyerSig = splitBuyerSig(buyerSignature);
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'transferWithAuthorization',
    args: [
      payment.buyer,
      ULTRON_EVM_RECEIVER as Address,
      payment.amount_usdc,
      BigInt(payment.validAfter),
      BigInt(payment.validBefore),
      payment.nonce,
      buyerSig.v,
      buyerSig.r,
      buyerSig.s,
    ],
  });

  // 2. Fetch ultron's nonce + gas.
  const [nonce, feeData] = await Promise.all([
    publicClient.getTransactionCount({ address: ULTRON_EVM_RECEIVER as Address }),
    publicClient.estimateFeesPerGas(),
  ]);
  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error('Base RPC returned no EIP-1559 fee data');
  }

  // 3. Build EIP-1559 unsigned tx.
  const unsignedTx: TransactionSerializableEIP1559 = {
    chainId: 8453,
    type: 'eip1559',
    to: USDC_BASE_ADDRESS as Address,
    value: 0n,
    data,
    nonce,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    gas: TRANSFER_WITH_AUTH_GAS,
  };

  // 4. Serialize unsigned + keccak256 → message hash.
  const serializedUnsigned = serializeTransaction(unsignedTx);
  const messageHash = keccak256(serializedUnsigned);

  // 5. IKA presign+sign ceremony.
  const ultronSigHex = await callUltronSign(env, messageHash);
  const sigBytes = hexToU8(ultronSigHex);
  if (sigBytes.length !== 64) {
    throw new Error(
      `expected 64-byte (r||s) sig from IKA secp256k1, got ${sigBytes.length} bytes. ` +
      `Check parseSignatureFromSignOutput is returning raw concatenated form.`,
    );
  }
  const r = (`0x${ultronSigHex.replace(/^0x/, '').slice(0, 64)}`) as Hex;
  const s = (`0x${ultronSigHex.replace(/^0x/, '').slice(64, 128)}`) as Hex;

  // 6. Recover yParity.
  const yParity = await recoverYParity(messageHash, r, s);

  // 7. Re-serialize with signature.
  const signedTx = serializeTransaction(unsignedTx, { r, s, yParity });

  // 8. Submit to Base RPC + verify receipt.
  const baseTxHash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: baseTxHash,
    timeout: 60_000,
  });
  if (receipt.status !== 'success') {
    throw new Error(`tx reverted on Base: ${baseTxHash}`);
  }

  return {
    ok: true,
    base_tx_hash: baseTxHash,
    amount_usdc: payment.amount_usdc.toString(),
    buyer: payment.buyer,
    receiver: ULTRON_EVM_RECEIVER as Address,
    signed_via: 'ika-dwallet-secp256k1',
  };
}
