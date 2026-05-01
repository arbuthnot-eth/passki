/**
 * IKA-native Mint settlement (frontier path).
 *
 * Goal: ultron signs + submits the buyer's pre-signed transferWithAuthorization
 * on Base WITHOUT any private key on the Worker. Uses ultron's existing
 * secp256k1 IKA dWallet (`0xbb8b…6acb`, cap `0x1034…498a2`) which already
 * backs the Base receiver address `0xcaA8…882d`.
 *
 * Status: SKETCH — interface only, not wired. The signing primitive
 * already exists in `src/server/agents/ultron-signing-agent.ts` via
 * `_requestSign({ curve: 'secp256k1', message, hashScheme: 'KECCAK256' })`.
 * The remaining work is EVM-tx construction around it. This file
 * documents the contract; implementation lands once we're ready to ship
 * the IKA path alongside browser-pay.
 *
 * The browser-pay path (`src/client/mint-pay.ts`) is the production
 * default. This module is the upgrade path that lets agents (no browser)
 * pay our endpoint without their own EVM wallet — they just sign the
 * EIP-3009 authorization, post X-PAYMENT, and ultron submits the on-chain
 * tx via its own IKA dWallet.
 *
 * Why this respects the first commandment:
 *   - No private key is added to the Worker. Ultron's secp256k1 user-share
 *     is encrypted at rest and used only via IKA committee co-signing.
 *   - Worker constructs the unsigned EVM tx and the keccak256 hash; the
 *     IKA flow returns a signature; Worker reassembles and submits.
 *   - Same trust model as Sui-side ultron operations today.
 */

import type { Hex } from 'viem';
import type { VerifiedPayment } from './x402-paywall.js';

interface IkaSettleEnv {
  UltronSigningAgent: DurableObjectNamespace;
  BASE_RPC_URL?: string; // defaults to https://mainnet.base.org
  // NO MINT_GAS_RELAY_PRIVATE_KEY. NO _PRIVATE_KEY anywhere.
}

export interface IkaSettlementResult {
  ok: true;
  base_tx_hash: Hex;
  amount_usdc: string;
  buyer: `0x${string}`;
  receiver: `0x${string}`;
  signed_via: 'ika-dwallet-secp256k1';
}

/**
 * IKA-native Mint settlement.
 *
 * Pseudocode (not yet implemented):
 *
 *   1. Fetch ultron's Base nonce + gas price (viem publicClient.getTransactionCount + getFeeData).
 *
 *   2. abi.encodeFunctionData('transferWithAuthorization', [
 *        payment.buyer, ULTRON_EVM_RECEIVER, payment.amount_usdc,
 *        payment.validAfter, payment.validBefore, payment.nonce,
 *        v, r, s,  // BUYER's signature, split per src/server/mint/settle.ts
 *      ])
 *
 *   3. Build EIP-1559 transaction:
 *        { chainId: 8453, to: USDC_BASE_ADDRESS, data, value: 0n,
 *          nonce, maxFeePerGas, maxPriorityFeePerGas, gas: ~80_000n }
 *
 *   4. RLP-encode the unsigned tx, prepend 0x02 (EIP-1559 type), keccak256
 *      to get the message hash.
 *
 *   5. Call UltronSigningAgent over Durable Object stub:
 *        const stub = env.UltronSigningAgent.get(env.UltronSigningAgent.idFromName('ultron'));
 *        const resp = await stub.fetch('/sign', {
 *          method: 'POST',
 *          body: JSON.stringify({
 *            curve: 'secp256k1',
 *            message: bytesToHex(messageHash),
 *            hashScheme: 'KECCAK256',
 *          }),
 *        });
 *        const { signature } = await resp.json();
 *      // signature is DER-encoded ECDSA secp256k1 from IKA committee.
 *
 *   6. Convert DER → (r, s) raw, compute v with EIP-155 chain_id=8453:
 *        v = 0 or 1 (parity) for EIP-1559 typed txs (the v is the parity of y).
 *      Note: EIP-1559 uses yParity (0 or 1), NOT the legacy v=27/28 or v=2*chain_id+35/36.
 *
 *   7. RLP-encode signed tx (type 0x02) with [chainId, nonce, maxPriorityFeePerGas,
 *      maxFeePerGas, gas, to, value, data, accessList=[], yParity, r, s].
 *
 *   8. publicClient.sendRawTransaction({ serializedTransaction: '0x02...' }).
 *
 *   9. Wait for receipt, verify status === 'success'.
 *
 *   10. Return IkaSettlementResult.
 *
 * Open questions before implementation:
 *   - The IKA committee returns DER-encoded ECDSA. Need a parser that
 *     handles non-standard r/s lengths and recovers yParity by trying both
 *     (or by recoverPublicKey + matching against ultron's known pubkey).
 *   - Gas estimation: transferWithAuthorization is ~78k gas typical.
 *     Buffer to 120k for safety.
 *   - Nonce management: under concurrent settlement, ultron's nonce can
 *     race. Needs a Durable-Object-serialized nonce queue OR retry-on-
 *     replacement-tx loop.
 *   - viem's `parseTransaction` / `serializeTransaction` may not accept
 *     foreign-signed bytes cleanly; may need to roll RLP manually with
 *     `@ethereumjs/rlp` (already a viem transitive dep).
 *
 * Wire-up plan:
 *   - Add an HTTP route on UltronSigningAgent that exposes the existing
 *     `_requestSign` for `curve='secp256k1', hashScheme='KECCAK256'` — confirm
 *     it's accessible via DO stub fetch.
 *   - Implement steps 1-10 above in this file, exporting `settleViaIka()`.
 *   - Modify `src/server/mint/routes.ts` POST /register/:name: if
 *     X-PAYMENT-MODE: ika is set (and X-PAYMENT-TX-HASH is absent),
 *     call settleViaIka before registerFromUltronPool.
 *   - Browser-pay (X-PAYMENT-TX-HASH supplied) remains the default path.
 *     IKA-pay becomes the agent-friendly fallback for clients without an
 *     EVM wallet.
 */
export async function settleViaIka(
  _env: IkaSettleEnv,
  _payment: VerifiedPayment,
  _signature: Hex,
): Promise<IkaSettlementResult> {
  throw new Error(
    'settleViaIka: not yet implemented. See JSDoc for steps 1-10. ' +
    'UltronSigningAgent already supports secp256k1+KECCAK256 signing; ' +
    'remaining work is EVM tx construction around it.',
  );
}
