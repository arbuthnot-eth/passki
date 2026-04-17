/**
 * Prism — rich cross-chain tx vehicle layered on Thunder attachments.
 *
 * A Prism is a Thunder message carrying two SDK-native attachments:
 *   1. `prism.manifest.json` — JSON describing the cross-chain payload
 *      (target chain, recipient, amount, mint, optional IKA dWallet cap
 *      reference, optional human note).
 *   2. `prism.payload.bin` — (optional) raw bytes the recipient needs to
 *      consume on the target chain (e.g. pre-signed Solana tx, ERC-20
 *      calldata, Bitcoin PSBT). Absent when the recipient rebuilds the
 *      tx from the manifest alone.
 *
 * Both are encrypted + Walrus-uploaded by the Thunder SDK's
 * AttachmentsManager — no parallel crypto, no parallel storage. The
 * sender runs `sendThunder({ ..., files: buildPrismAttachments(...) })`;
 * the recipient's Thunder reader returns AttachmentHandle[] and
 * `extractPrismFromMessage` resolves them into a typed manifest.
 *
 * There is no on-chain Prism object. A Prism is just a Thunder with a
 * manifest attachment. The `prism.manifest` extras.kind tag is the
 * only discriminator — anything else is a regular Thunder.
 */

import type {
  AttachmentFile,
  AttachmentHandle,
  DecryptedMessage,
} from './thunder-stack.js';

// ─── Types ──────────────────────────────────────────────────────────

export type PrismChain = 'solana' | 'ethereum' | 'bitcoin' | 'sui';

export interface PrismManifest {
  /** Schema version. Bump on breaking changes to this interface. */
  schema: 1;
  /** Per-prism identifier — crypto.randomUUID at build time. */
  prismId: string;
  /** Target chain where the payload resolves. */
  targetChain: PrismChain;
  /** Chain-native recipient address (base58 for Solana, 0x for EVM, bech32 for BTC, 0x for Sui). */
  recipient: string;
  /** Amount in smallest chain-native units, encoded as a decimal string
   *  (bigint-safe across the JSON boundary). */
  amount: string;
  /** Token identifier on the target chain — SPL mint, ERC-20 address, BTC asset id, Sui coin type. */
  mint?: string;
  /** IKA dWallet cap object ID the recipient should invoke to finalize
   *  the transfer. When absent the recipient is expected to resolve it
   *  themselves via their SUIAMI roster entry. */
  dwalletCapRef?: string;
  /** Human-readable note — displayed alongside the transfer confirm UI. */
  note?: string;
  /** ms epoch of manifest construction (sender-side clock). */
  createdAt: number;
}

/** Extras tags used by the SDK's AttachmentsManager to discriminate
 *  Prism attachments from regular files. */
const KIND_MANIFEST = 'prism.manifest';
const KIND_PAYLOAD = 'prism.payload';

// ─── Build ──────────────────────────────────────────────────────────

/** Build the AttachmentFile[] that encode a Prism, ready to pass as
 *  `sendThunder({ files: ... })`. Adds a random `prismId` and
 *  `createdAt` timestamp — caller only supplies the content fields. */
export function buildPrismAttachments(
  spec: Omit<PrismManifest, 'schema' | 'prismId' | 'createdAt'>,
  payload?: Uint8Array,
): AttachmentFile[] {
  const manifest: PrismManifest = {
    schema: 1,
    prismId: crypto.randomUUID(),
    createdAt: Date.now(),
    ...spec,
  };
  const manifestFile: AttachmentFile = {
    fileName: 'prism.manifest.json',
    mimeType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(manifest)),
    extras: { kind: KIND_MANIFEST, prismId: manifest.prismId, targetChain: manifest.targetChain },
  };
  if (!payload) return [manifestFile];
  const payloadFile: AttachmentFile = {
    fileName: 'prism.payload.bin',
    mimeType: 'application/octet-stream',
    data: payload,
    extras: { kind: KIND_PAYLOAD, prismId: manifest.prismId },
  };
  return [manifestFile, payloadFile];
}

// ─── Read ───────────────────────────────────────────────────────────

export interface ParsedPrism {
  manifest: PrismManifest;
  /** Resolver for the optional payload bytes — null when the Prism
   *  carries manifest only. Calling `.data()` triggers the SDK
   *  download+decrypt for the raw payload. */
  payloadHandle: AttachmentHandle | null;
}

/** Inspect a decrypted Thunder message for a Prism manifest. Returns
 *  the parsed manifest plus a handle to the optional payload, or null
 *  when the message is not a Prism. */
export async function extractPrismFromMessage(
  msg: DecryptedMessage,
): Promise<ParsedPrism | null> {
  const handles = (msg as unknown as { attachments?: AttachmentHandle[] }).attachments ?? [];
  if (handles.length === 0) return null;
  const manifestHandle = handles.find(
    (h) => h.extras && (h.extras as { kind?: string }).kind === KIND_MANIFEST,
  );
  if (!manifestHandle) return null;
  const manifestBytes = await manifestHandle.data();
  const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as PrismManifest;
  if (parsed.schema !== 1) return null;
  const payloadHandle = handles.find(
    (h) =>
      h.extras &&
      (h.extras as { kind?: string; prismId?: string }).kind === KIND_PAYLOAD &&
      (h.extras as { prismId?: string }).prismId === parsed.prismId,
  ) ?? null;
  return { manifest: parsed, payloadHandle };
}

/** Convenience predicate — is this Thunder a Prism? */
export function isPrism(msg: DecryptedMessage): boolean {
  const handles = (msg as unknown as { attachments?: AttachmentHandle[] }).attachments ?? [];
  return handles.some(
    (h) => h.extras && (h.extras as { kind?: string }).kind === KIND_MANIFEST,
  );
}
