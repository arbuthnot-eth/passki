/**
 * Encrypt PC-Token client — higher-level wrapper around `./encrypt` that
 * shapes a "confidential transfer" into a structured instruction object
 * consumable by a future Solana PC-Token program.
 *
 * --- PRE-ALPHA / STUBBED ---
 * The CF Worker proxy (`/api/encrypt/*`) currently returns fake ciphertext
 * IDs — nothing is truly encrypted and no on-chain Solana submission
 * happens from this module. We're wiring the BROWSER side of the flow
 * end-to-end so that the day a real Encrypt executor + PC-Token program
 * land, we only swap out the transport layer.
 *
 * This module intentionally does NOT import `@solana/web3.js`. The
 * returned shape is a plain object describing the instruction; the actual
 * `Transaction` assembly + signing is deferred until the real program
 * interface (account layout, discriminator bytes, data encoding) is
 * published.
 * ---
 */

import {
  EncryptClient,
  encryptBalance,
  buildTransferInputs,
  getEncryptClient,
  ENCRYPT_PROGRAM_ID,
  type EUint64,
} from './encrypt';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Base64 marker that the stubbed CF Worker proxy returns from
 * `/api/encrypt/network_key` when it is operating in stub mode. Matching
 * this marker (or running under the `dotski-devnet.*.workers.dev` host)
 * flips the module into 'stub' mode so callers can render appropriate
 * "pre-alpha, not real funds" UX.
 *
 * The literal below decodes to: "STUB_NETWORK_KEY_B64"
 */
export const STUB_NETWORK_KEY_MARKER = 'U1RVQl9ORVRXT1JLX0tFWV9CNjQ=';

/**
 * Check whether the current runtime is hitting the stubbed devnet proxy.
 * Returns:
 *   - 'stub'    — definitely on devnet stub (hostname or marker match)
 *   - 'live'    — network key came back as a non-stub value
 *   - 'unknown' — could not determine (network failure, non-browser context)
 *
 * Callers that gate real on-chain actions should treat 'unknown' as a hard
 * stop, NOT degrade it to either side. Transient network errors must never
 * silently flip the mode — that would either tell live users they're in
 * stub mode or tell stub users they can broadcast real transactions.
 */
export type EncryptMode = 'stub' | 'live' | 'unknown';

export async function detectEncryptMode(
  client?: EncryptClient,
): Promise<EncryptMode> {
  // Host sniff first — cheap, no network call.
  try {
    if (typeof location !== 'undefined' && location.hostname) {
      const h = location.hostname;
      if (/^dotski-devnet\..*\.workers\.dev$/i.test(h)) return 'stub';
    }
  } catch {
    /* non-browser, ignore */
  }

  // Fall back to the network key probe.
  try {
    const c = client ?? getEncryptClient();
    const nk = await c.getNetworkKey();
    if (nk.key === STUB_NETWORK_KEY_MARKER) return 'stub';
    return 'live';
  } catch {
    // Do NOT silently return 'stub' — callers gate real flows on this.
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildConfidentialTransferOpts {
  /** Sender Solana pubkey (base58). */
  from: string;
  /** Recipient Solana pubkey (base58). */
  to: string;
  /** Transfer amount in smallest units (e.g. 1 iUSD = 1_000_000_000 @ 9dp). */
  amount: bigint;
  /** SPL mint address (base58). Defaults to iUSD devnet mint placeholder. */
  mint?: string;
}

/**
 * Structured description of a PC-Token confidential transfer instruction.
 * This is NOT a `@solana/web3.js` `TransactionInstruction` — it's a
 * plain-object representation we can later feed into a real transaction
 * builder once proto definitions for the PC-Token program exist.
 */
export interface ConfidentialTransferInstruction {
  programId: string;
  accounts: string[];
  data: {
    discriminator: 'confidential_transfer';
    amountCiphertextId: string;
    from: string;
    to: string;
    mint: string;
  };
}

export interface BuildConfidentialTransferResult {
  instructions: ConfidentialTransferInstruction[];
  ciphertexts: { amount: EUint64 };
  mode: EncryptMode;
  note: string;
}

export interface ConfidentialTransferCostEstimate {
  gasSOL: number;
  encryptFeeUSDC: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Placeholder iUSD mint on Solana devnet. Real mint address will be
 * written here once the iUSD SPL mint ceremony runs against devnet.
 */
export const DEFAULT_IUSD_MINT = 'iUSD1111111111111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a confidential-transfer instruction object for PC-Token.
 *
 * Flow:
 *   1. Detect mode (stub vs live) from environment.
 *   2. Call `buildTransferInputs` to get an encrypted amount ciphertext ID.
 *   3. Shape the result into a plain `{ instructions, ciphertexts, ... }`
 *      object whose `.data.amountCiphertextId` is the ID a real PC-Token
 *      program would consume.
 *
 * Pre-alpha: the ciphertext ID is a fake string returned by the CF Worker
 * proxy; no real Solana transaction is submitted from here.
 */
export async function buildConfidentialTransferTx(
  opts: BuildConfidentialTransferOpts,
): Promise<BuildConfidentialTransferResult> {
  const { from, to, amount } = opts;
  const mint = opts.mint ?? DEFAULT_IUSD_MINT;

  const client = getEncryptClient();
  const mode = await detectEncryptMode(client);

  // Encrypt the amount via the proxy. Uses the default Encrypt program ID
  // for the ciphertext — the consuming PC-Token program is referenced
  // separately in the returned instruction's `programId` field.
  const { amountCiphertext } = await buildTransferInputs(
    from,
    to,
    amount,
    ENCRYPT_PROGRAM_ID,
    undefined,
    client,
  );

  const instruction: ConfidentialTransferInstruction = {
    // PC-Token program ID is not yet published; reuse the Encrypt program
    // ID as a placeholder so the instruction shape is non-empty. Swap to
    // the real PC-Token program ID once it lands.
    programId: ENCRYPT_PROGRAM_ID,
    accounts: [from, to, mint],
    data: {
      discriminator: 'confidential_transfer',
      amountCiphertextId: amountCiphertext.id,
      from,
      to,
      mint,
    },
  };

  const note =
    mode === 'stub'
      ? 'STUB MODE: ciphertext ID is a fake value from the dotski-devnet proxy. No Solana transaction is submitted. Shape matches what the future PC-Token confidential_transfer instruction will consume.'
      : mode === 'live'
        ? 'LIVE MODE: ciphertext ID came from the Encrypt network, but PC-Token program interface is not finalized — instruction is still returned as a plain object, not a @solana/web3.js Transaction.'
        : 'UNKNOWN MODE: could not determine whether upstream is stub or live. Transient network error fetching network_key. Callers gating real on-chain actions should treat this as a hard stop and retry detectEncryptMode().';

  return {
    instructions: [instruction],
    ciphertexts: { amount: amountCiphertext },
    mode,
    note,
  };
}

/**
 * Estimate the cost of a confidential transfer.
 *
 * Pre-alpha stub: returns fixed placeholder values. Real numbers will come
 * from (a) Solana `getFeeForMessage` once we have a real transaction, and
 * (b) the Encrypt network fee schedule once it is published.
 */
export function estimateConfidentialTransferCost(
  _amount: bigint,
): ConfidentialTransferCostEstimate {
  return {
    gasSOL: 0.00005,
    encryptFeeUSDC: 0,
    note: 'Placeholder estimate. Real gas will come from Solana `getFeeForMessage` once the PC-Token instruction is a real @solana/web3.js Transaction; Encrypt network fees are 0 during pre-alpha and will be published with Alpha 1.',
  };
}

// Re-export the low-level primitive for callers that want to encrypt a
// balance without building a full instruction.
export { encryptBalance };
