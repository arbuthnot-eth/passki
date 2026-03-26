/**
 * IKA 2PC-MPC Signing Ceremony — client-side adapter.
 *
 * Implements the 5-phase signing flow for dWallet threshold signatures:
 *   1. Consume a verified presign from the pool
 *   2. Decrypt user's secret key share
 *   3. Compute user's partial signature contribution
 *   4. Submit to IKA network (off-chain) or policy contract (on-chain)
 *   5. Poll for completed signature
 *
 * Adapted from inkwell-finance/ows-ika ceremony.ts (MIT).
 * Simplified for browser context — no filesystem, no policy engine.
 *
 * @see https://github.com/inkwell-finance/ows-ika
 * @see https://docs.ika.xyz/developers-guide/signing
 */

import { resolveChain, type ChainConfig, type HashScheme, type SignatureAlgorithm } from './chains.js';

// ─── Adapter Interface ──────────────────────────────────────────────
// This interface abstracts over the IKA SDK's signing operations.
// The actual implementation will call @ika.xyz/sdk methods, but this
// decoupling lets us test and reason about the ceremony independently.

export interface IkaSigningAdapter {
  /** Fetch presign data by ID from the IKA network. */
  getPresignData(presignId: string): Promise<Uint8Array>;

  /** Decrypt the user's secret key share from on-chain encrypted storage. */
  decryptUserShare(params: {
    decryptionKey: Uint8Array;
    encryptedShareId: string;
    publicOutput: Uint8Array;
    curve: number;
  }): Promise<{ secretShare: Uint8Array }>;

  /**
   * Compute the user's partial signature contribution.
   * This is the user's half of the 2PC-MPC — combined with the network's
   * half to produce a valid ECDSA/Schnorr/EdDSA signature.
   */
  computeUserSignContribution(params: {
    publicOutput: Uint8Array;
    userSecretKeyShare: Uint8Array;
    presignData: Uint8Array;
    message: Uint8Array;
    hashScheme: number;
    signatureAlgorithm: number;
    curve: number;
  }): Promise<Uint8Array>;

  /**
   * Submit the user's contribution to IKA and wait for the completed signature.
   * Off-chain mode — uses the raw DWalletCap directly.
   */
  requestSignature(params: {
    dwalletCapId: string;
    verifiedPresignCapId: string;
    userContribution: Uint8Array;
    message: Uint8Array;
    curve: number;
    signatureAlgorithm: number;
    hashScheme: number;
  }): Promise<{ signature: Uint8Array; signSessionId: string }>;
}

// ─── Presign Pool ───────────────────────────────────────────────────
// Browser-side presign management using localStorage.
// Each dWallet maintains a pool of pre-computed presigns that are
// consumed one-per-signature. Pool replenishment is a separate concern.

export interface PresignEntry {
  presignId: string;
  verifiedCapId: string;
  state: 'verified' | 'consumed';
  createdAt: string;
}

const PRESIGN_KEY_PREFIX = 'ski:presigns:';

function loadPresignPool(dwalletId: string): PresignEntry[] {
  try {
    const raw = localStorage.getItem(`${PRESIGN_KEY_PREFIX}${dwalletId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePresignPool(dwalletId: string, pool: PresignEntry[]): void {
  try {
    localStorage.setItem(`${PRESIGN_KEY_PREFIX}${dwalletId}`, JSON.stringify(pool));
  } catch {}
}

/** Consume one verified presign from the pool. Returns null if empty. */
export function consumePresign(dwalletId: string): PresignEntry | null {
  const pool = loadPresignPool(dwalletId);
  const available = pool.find((p) => p.state === 'verified');
  if (!available) return null;
  available.state = 'consumed';
  savePresignPool(dwalletId, pool);
  return available;
}

/** Add a verified presign to the pool. */
export function addPresign(dwalletId: string, entry: PresignEntry): void {
  const pool = loadPresignPool(dwalletId);
  pool.push(entry);
  savePresignPool(dwalletId, pool);
}

/** Count available (unconsumed) presigns. */
export function availablePresignCount(dwalletId: string): number {
  return loadPresignPool(dwalletId).filter((p) => p.state === 'verified').length;
}

// ─── Sign Request ───────────────────────────────────────────────────

export interface SignRequest {
  /** Target chain — CAIP-2 ID or alias ('btc', 'ethereum', etc.) */
  chainId: string;
  /** Raw message bytes to sign (e.g., Bitcoin sighash, EVM tx hash) */
  message: Uint8Array;
  /** dWallet object ID on Sui */
  dwalletId: string;
  /** DWalletCap object ID (ownership proof) */
  dwalletCapId: string;
  /** Override signature algorithm (defaults to chain's default) */
  signatureAlgorithm?: number;
  /** Override hash scheme (defaults to chain's default) */
  hashScheme?: number;
}

export interface SignResult {
  /** Raw signature bytes — r||s (64 bytes for ECDSA) */
  signature: Uint8Array;
  /** On-chain sign session ID for audit trail */
  signSessionId: string;
  /** Chain that was signed for */
  chain: ChainConfig;
}

/**
 * Execute the full 2PC-MPC signing ceremony for a dWallet.
 *
 * This is the core function — it orchestrates all 5 phases:
 *   1. Consume presign
 *   2. Decrypt share
 *   3. Compute user contribution
 *   4. Submit to IKA
 *   5. Return completed signature
 *
 * The caller is responsible for:
 *   - Ensuring presigns are available (replenish if needed)
 *   - Providing the decryption key (from user's encrypted share)
 *   - Broadcasting the signed transaction to the target chain
 */
export async function signWithDWallet(
  request: SignRequest,
  sharePayload: {
    decryptionKey: Uint8Array;
    encryptedShareId: string;
    publicOutput: Uint8Array;
  },
  adapter: IkaSigningAdapter,
): Promise<SignResult> {
  const chain = resolveChain(request.chainId);
  const sigAlgo = request.signatureAlgorithm ?? chain.signatureAlgorithm;
  const hash = request.hashScheme ?? chain.hashScheme;

  // Phase 1: Consume a pre-computed presign
  const presign = consumePresign(request.dwalletId);
  if (!presign) {
    throw new Error(
      `No verified presigns available for dWallet ${request.dwalletId}. ` +
      `Replenish the presign pool before signing.`,
    );
  }

  // Phase 2: Decrypt user's secret key share
  let secretShare: Uint8Array;
  try {
    const decrypted = await adapter.decryptUserShare({
      decryptionKey: sharePayload.decryptionKey,
      encryptedShareId: sharePayload.encryptedShareId,
      publicOutput: sharePayload.publicOutput,
      curve: chain.curve,
    });
    secretShare = decrypted.secretShare;
  } catch (err) {
    // Re-mark presign as verified so it's not wasted
    const pool = loadPresignPool(request.dwalletId);
    const entry = pool.find((p) => p.presignId === presign.presignId);
    if (entry) { entry.state = 'verified'; savePresignPool(request.dwalletId, pool); }
    throw err;
  }

  // Phase 3: Compute user's partial signature contribution
  const presignData = await adapter.getPresignData(presign.presignId);
  let userContribution: Uint8Array;
  try {
    userContribution = await adapter.computeUserSignContribution({
      publicOutput: sharePayload.publicOutput,
      userSecretKeyShare: secretShare,
      presignData,
      message: request.message,
      hashScheme: hash,
      signatureAlgorithm: sigAlgo,
      curve: chain.curve,
    });
  } finally {
    // Zero out secret share immediately after use
    secretShare.fill(0);
  }

  // Phase 4: Submit to IKA network, wait for completed signature
  const result = await adapter.requestSignature({
    dwalletCapId: request.dwalletCapId,
    verifiedPresignCapId: presign.verifiedCapId,
    userContribution,
    message: request.message,
    curve: chain.curve,
    signatureAlgorithm: sigAlgo,
    hashScheme: hash,
  });

  // Phase 5: Return the completed signature
  return {
    signature: result.signature,
    signSessionId: result.signSessionId,
    chain,
  };
}
