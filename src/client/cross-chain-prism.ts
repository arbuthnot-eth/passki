/**
 * Cross-Chain Prism — Seal ↔ Encrypt bridge primitive.
 *
 * A Prism wraps an Encrypt ciphertext ID (Solana-side FHE handle) and a
 * Seal-encrypted Sui payload into a single rich transaction vehicle that
 * can be bridged between chains via an IKA dWallet. The user's Sui wallet
 * authorizes the intent; the IKA dWallet (derived from that wallet) signs
 * the Solana tx that consumes the Encrypt ciphertext — no bridge, no
 * wrapped asset, funds simply move on Solana under the dWallet's ed25519
 * key share.
 *
 * === STUB WARNING ===
 * The Seal side of this primitive is A STUB. We do NOT import
 * `@mysten/seal` or `thunder-stack.ts` here — integrating Seal is
 * intentionally deferred until the Prism shape stabilizes. Until then,
 * `sealBlob` is a deterministic JSON blob hex-encoded and prefixed with
 * `SEAL_STUB_` so it is obviously fake at a glance. Never treat a
 * `SEAL_STUB_`-prefixed blob as a real ciphertext.
 *
 * The Solana side (Encrypt ciphertext ID + confidential transfer
 * instruction) comes from `./encrypt-pc-token` which is itself pre-alpha
 * against a CF Worker stub proxy — see that module's header for details.
 *
 * The IKA dWallet cap reference is ALSO a stub in this primitive — we
 * could call `checkExistingDWallets(suiSender)` from `./ika.ts` but that
 * pulls in the full IkaClient (gRPC, SDK) which is too heavy for a pure
 * primitive. Callers that need a real cap ref should resolve it
 * themselves and overwrite `dwalletCapRef` on the returned object, or we
 * wire it up in a follow-up once the Prism consumer lands.
 * ===
 */

import { buildConfidentialTransferTx } from './encrypt-pc-token.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossChainPrismOpts {
  /** Sui sender (the user's Sui address — IKA dWallet will derive from this). */
  suiSender: string;
  /** Solana recipient (base58). */
  solRecipient: string;
  /** Amount in smallest units. */
  amount: bigint;
  /** Solana SPL mint for the value being moved. */
  mint?: string;
  /** Human-readable message to Seal-encrypt as the Prism payload. */
  message?: string;
}

export interface CrossChainPrism {
  /** Unique prism ID (crypto.randomUUID). */
  prismId: string;
  /** Sui side: Seal-encrypted payload blob (hex) OR null in unknown/early-exit mode. */
  sealBlob: string | null;
  /** Solana side: Encrypt ciphertext ID for the amount. */
  encryptCiphertextId: string;
  /** Confidential swap/transfer instruction (from encrypt-pc-token). */
  solanaInstruction: unknown;
  /** IKA dWallet cap reference — the user's Sui wallet must own this. */
  dwalletCapRef: string | null;
  /** Cross-chain mode. */
  mode: 'stub' | 'live' | 'unknown';
  /** Human-readable explanation. */
  note: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Produce a `SEAL_STUB_`-prefixed hex blob that encodes the Prism intent
 * as JSON. This is NOT a real Seal ciphertext — it is transparent and
 * reversible, which is exactly what we want while Seal integration is
 * deferred. Real Seal blobs will come from a threshold encryption against
 * the Sui Seal key server set and will be opaque bytes, not hex JSON.
 */
function buildSealStubBlob(payload: {
  prismId: string;
  suiSender: string;
  solRecipient: string;
  amount: string; // bigint serialized as decimal string for JSON safety
  message?: string;
}): string {
  const json = JSON.stringify(payload);
  let hex = '';
  for (let i = 0; i < json.length; i++) {
    hex += json.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return `SEAL_STUB_${hex}`;
}

/**
 * Generate a UUID in a browser- and Worker-safe way. Prefers
 * `crypto.randomUUID()` (available in modern browsers, Node ≥19, and CF
 * Workers) and falls back to a getRandomValues-backed v4 UUID otherwise.
 */
function generatePrismId(): string {
  const c: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback v4
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a cross-chain Prism that wraps a Solana Encrypt ciphertext and a
 * (stub) Seal-encrypted Sui payload into a single bridgeable object.
 *
 * Flow:
 *   1. Mint a fresh prismId.
 *   2. Call `buildConfidentialTransferTx` to get the Solana-side Encrypt
 *      ciphertext ID + instruction shape. Inherit its `mode` field.
 *   3. If mode === 'unknown', bail out early without producing a Seal
 *      blob — callers gating real on-chain actions must treat this as a
 *      hard stop (see `detectEncryptMode` in encrypt-pc-token.ts).
 *   4. Otherwise, build a `SEAL_STUB_`-prefixed hex blob over the intent.
 *   5. Return the assembled Prism with `dwalletCapRef: null` (TODO: wire
 *      through `checkExistingDWallets(suiSender)` from ./ika.ts once the
 *      Prism consumer needs the real cap).
 */
export async function buildCrossChainPrism(
  opts: CrossChainPrismOpts,
): Promise<CrossChainPrism> {
  const prismId = generatePrismId();

  const solana = await buildConfidentialTransferTx({
    from: opts.suiSender, // Note: `from` here is logged inside the Encrypt
                          // instruction; the real Solana sender will be the
                          // IKA-derived address, resolved at execution time.
    to: opts.solRecipient,
    amount: opts.amount,
    mint: opts.mint,
  });

  const instruction = solana.instructions[0];
  const encryptCiphertextId = instruction?.data.amountCiphertextId ?? '';

  // Unknown mode is a hard stop — do not produce a Seal blob, do not let
  // callers accidentally submit anything downstream.
  if (solana.mode === 'unknown') {
    return {
      prismId,
      sealBlob: null,
      encryptCiphertextId,
      solanaInstruction: instruction ?? null,
      dwalletCapRef: null,
      mode: 'unknown',
      note:
        'UNKNOWN MODE: Encrypt proxy did not resolve to stub or live (transient network error fetching network_key). ' +
        'Prism was NOT sealed and MUST NOT be bridged. Retry buildCrossChainPrism() once detectEncryptMode() resolves.',
    };
  }

  const sealBlob = buildSealStubBlob({
    prismId,
    suiSender: opts.suiSender,
    solRecipient: opts.solRecipient,
    amount: opts.amount.toString(),
    message: opts.message,
  });

  // TODO(ika): resolve the user's DWalletCap via
  //   `import { checkExistingDWallets } from './ika.js'`
  // and set `dwalletCapRef` to the first cap's object ID. Deferred to
  // keep this primitive free of the IkaClient/gRPC surface.
  const dwalletCapRef: string | null = null;

  const note =
    solana.mode === 'stub'
      ? 'STUB MODE: Solana Encrypt ciphertext is a fake ID from the dotski-devnet proxy AND the Seal blob is a transparent SEAL_STUB_ hex payload. Neither side is real encryption. Safe for UI plumbing only.'
      : 'LIVE MODE (partial): Solana-side Encrypt ciphertext is real, but the Seal blob is still a SEAL_STUB_ hex payload — @mysten/seal integration is deferred. Do NOT treat sealBlob as confidential.';

  return {
    prismId,
    sealBlob,
    encryptCiphertextId,
    solanaInstruction: instruction ?? null,
    dwalletCapRef,
    mode: solana.mode,
    note,
  };
}
