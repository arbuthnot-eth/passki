/**
 * storm mainnet client — Hypnosis Field.
 *
 * Wraps the live `storm` Move package (scribed 2026-04-30 via Switcheroo,
 * replacing the deprecated `darkrai` package) into JS helpers that build
 * PTBs against `storm::nebula::*`. GroupStorm was dropped per swarm
 * verdict — Storms are Storms regardless of recipient count.
 *
 * Combine with `darkrai-storm.ts` (sender + recipient flow) to produce
 * real on-chain Nebulae instead of in-tab simulations.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

// ─── Mainnet addresses (see ~/.claude/.../memory/project_storm_mainnet.md) ──

/**
 * Type-identity address: stays at the original v1 publish. All Move types
 * resolve relative to this. ALWAYS use this for `${PKG}::module::Type`
 * strings (NEBULA_TYPE, CUMULO_TYPE, etc.).
 */
export const STORM_PACKAGE =
  '0xc2526368317a60be3d9e0c90deb9ecfd82278d7781b291c28ce7b02693b697ff';

/**
 * Latest published code (v2 — Cumulo added). Use for moveCall `target`s
 * because the Sui SDK looks up bytecode by latest publish, not original
 * type address.
 */
export const STORM_LATEST_PACKAGE =
  '0x88e8766b8e4815e4ca0e678d228ac80c8503d16ef559931eb72833cbd7d848cb';

export const STORM_VERSION_OBJECT =
  '0xcaa7bba1c57523951d0bf7ce1048b46f330ac4fed9b9aacfb6120646150289e6';

export const NEBULA_TYPE = `${STORM_PACKAGE}::nebula::Nebula`;
export const NEBULA_EPOCH_TYPE = `${STORM_PACKAGE}::nebula::NebulaEpoch`;
export const CUMULO_TYPE = `${STORM_PACKAGE}::cumulo::Cumulo`;

// ─── Cryptographic byte sizes (BE_short / BLS12-381) ──────────────────────

export const CT_BYTES = 704;
export const EK_BYTES = 576;
export const SBK_BYTES = 48;
export const PAD_BYTES = 576;

// ─── PTB builders ──────────────────────────────────────────────────────────

interface OpenNebulaArgs {
  suinsName: string;
  ekCompressed: Uint8Array;       // 576 bytes
  committeeRef: Uint8Array;        // opaque, points at Seal-protected sk
  ellMax: number;                  // power of two; production default 16
  epochPadding: number;            // 0 = no padding
}

/**
 * Build a tx that opens a Nebula (per-recipient inbox) and shares it.
 * Returned `tx` should be signed + executed by the recipient.
 */
export function buildOpenNebulaTx(args: OpenNebulaArgs): Transaction {
  if (args.ekCompressed.length !== EK_BYTES) {
    throw new Error(`ek must be ${EK_BYTES} bytes, got ${args.ekCompressed.length}`);
  }
  if (!isPowerOfTwo(args.ellMax)) {
    throw new Error('ellMax must be a power of two');
  }
  const tx = new Transaction();
  const nebula = tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::open`,
    arguments: [
      tx.pure(bcs.string().serialize(args.suinsName)),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.ekCompressed))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.committeeRef))),
      tx.pure.u64(args.ellMax),
      tx.pure.u64(args.epochPadding),
    ],
  });
  tx.transferObjects([nebula], tx.pure.address('0x0')); // placeholder — see makeShareSharedNebula
  return tx;
}

/**
 * Same as `buildOpenNebulaTx` but explicitly shares the resulting Nebula.
 * Use this for interactive sign-and-share from the recipient's wallet.
 */
export function buildOpenAndShareNebulaTx(args: OpenNebulaArgs): Transaction {
  if (args.ekCompressed.length !== EK_BYTES) {
    throw new Error(`ek must be ${EK_BYTES} bytes, got ${args.ekCompressed.length}`);
  }
  if (!isPowerOfTwo(args.ellMax)) {
    throw new Error('ellMax must be a power of two');
  }
  const tx = new Transaction();
  const nebula = tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::open`,
    arguments: [
      tx.pure(bcs.string().serialize(args.suinsName)),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.ekCompressed))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.committeeRef))),
      tx.pure.u64(args.ellMax),
      tx.pure.u64(args.epochPadding),
    ],
  });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [NEBULA_TYPE],
    arguments: [nebula],
  });
  return tx;
}

interface PostThunderArgs {
  nebulaId: string;
  epochId: string;
  ct: Uint8Array;                  // 704 bytes
  aeadPayload: Uint8Array;         // variable
  walrusBlobId: Uint8Array;        // 32 bytes for a Walrus blob id, or empty for text-only
}

/**
 * Build a tx that appends a Thunder to an open NebulaEpoch.
 * Sender is the wallet that signs this tx.
 */
export function buildPostThunderTx(args: PostThunderArgs): Transaction {
  if (args.ct.length !== CT_BYTES) {
    throw new Error(`ct must be ${CT_BYTES} bytes, got ${args.ct.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::post_thunder`,
    arguments: [
      tx.object(args.epochId),
      tx.object(args.nebulaId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.ct))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.aeadPayload))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.walrusBlobId))),
    ],
  });
  return tx;
}

interface SealEpochArgs {
  nebulaId: string;
  epochId: string;
  sbk: Uint8Array;                 // 48 bytes
  clockId?: string;                // defaults to system clock
}

/**
 * Build a tx that seals a NebulaEpoch with the recipient's published sbk.
 * Only the Nebula owner can seal.
 */
export function buildSealEpochTx(args: SealEpochArgs): Transaction {
  if (args.sbk.length !== SBK_BYTES) {
    throw new Error(`sbk must be ${SBK_BYTES} bytes, got ${args.sbk.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::seal_epoch`,
    arguments: [
      tx.object(args.epochId),
      tx.object(args.nebulaId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.sbk))),
      tx.object(args.clockId || '0x6'),
    ],
  });
  return tx;
}

interface MarkBadCtArgs {
  nebulaId: string;
  epochId: string;
  slot: number;
}

/**
 * Build a tx that flags a poisoned CT slot (Pistis mitigation).
 * Used when batch pre_decrypt's NIZK verify rejected and per-CT verify
 * identified the malformed sender.
 */
export function buildMarkBadCtTx(args: MarkBadCtArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::mark_bad_ct`,
    arguments: [
      tx.object(args.epochId),
      tx.object(args.nebulaId),
      tx.pure.u64(args.slot),
    ],
  });
  return tx;
}

interface RotateEpochArgs {
  nebulaId: string;
  prevEpochId: string;
}

/**
 * Build a tx that rotates from a sealed epoch to a new fresh epoch.
 * Owner-only; previous epoch must be sealed.
 */
export function buildRotateEpochTx(args: RotateEpochArgs): Transaction {
  const tx = new Transaction();
  const newEpoch = tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::nebula::rotate_epoch`,
    arguments: [tx.object(args.nebulaId), tx.object(args.prevEpochId)],
  });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [NEBULA_EPOCH_TYPE],
    arguments: [newEpoch],
  });
  return tx;
}

// ─── Cumulo PTB builders (group dedupe path) ──────────────────────────────

interface OpenCumuloArgs {
  name: string;
  walrusBlobId: Uint8Array;        // 1..64 bytes
  stormSalt: Uint8Array;            // 32 bytes (rotates per epoch)
}

/**
 * Open a Cumulo (group conversation cloud) and share it. Caller becomes
 * the creator and holds bolt-management auth.
 */
export function buildOpenAndShareCumuloTx(args: OpenCumuloArgs): Transaction {
  if (args.stormSalt.length !== 32) {
    throw new Error(`stormSalt must be 32 bytes, got ${args.stormSalt.length}`);
  }
  if (args.walrusBlobId.length < 1 || args.walrusBlobId.length > 64) {
    throw new Error(`walrusBlobId must be 1..64 bytes, got ${args.walrusBlobId.length}`);
  }
  const tx = new Transaction();
  const cumulo = tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::open`,
    arguments: [
      tx.pure(bcs.string().serialize(args.name)),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.walrusBlobId))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.stormSalt))),
    ],
  });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [CUMULO_TYPE],
    arguments: [cumulo],
  });
  return tx;
}

interface LightBoltArgs {
  cumuloId: string;
  /** Blinded RecipientId — typically `keccak256(dWallet_pubkey || storm_salt)`. 32 bytes. */
  recipientId: Uint8Array;
  /** AES-256-GCM key for the Walrus blob, batch-threshold-encrypted to recipient's `ek_user`. */
  encryptedAesKey: Uint8Array;
  clockId?: string;
}

/**
 * Light a Bolt — add a member to the Cumulo. Creator-only. The
 * `encryptedAesKey` is the recipient's ticket; possessing it (and being
 * able to batch-decrypt it via their Nebula's `sk_user`) yields the
 * Walrus blob's AES key.
 */
export function buildLightBoltTx(args: LightBoltArgs): Transaction {
  if (args.recipientId.length !== 32) {
    throw new Error(`recipientId must be 32 bytes, got ${args.recipientId.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::light_bolt`,
    arguments: [
      tx.object(args.cumuloId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.recipientId))),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.encryptedAesKey))),
      tx.object(args.clockId || '0x6'),
    ],
  });
  return tx;
}

interface GoDarkArgs {
  cumuloId: string;
  recipientId: Uint8Array;
}

/**
 * Go dark — revoke a Bolt. Creator-only. Removes the recipient's access
 * ticket but does NOT invalidate already-distributed AES keys; pair with
 * `buildRotateBlobTx` for full revocation.
 */
export function buildGoDarkTx(args: GoDarkArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::go_dark`,
    arguments: [
      tx.object(args.cumuloId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.recipientId))),
    ],
  });
  return tx;
}

interface RotateSaltArgs {
  cumuloId: string;
  newSalt: Uint8Array; // 32 bytes
}

/**
 * Rotate the storm_salt — forward secrecy + cross-thunder unlinkability.
 * Existing RecipientIds become unmatched; creator must `goDark` stale
 * entries and re-`lightBolt` with new IDs.
 */
export function buildRotateSaltTx(args: RotateSaltArgs): Transaction {
  if (args.newSalt.length !== 32) {
    throw new Error(`newSalt must be 32 bytes, got ${args.newSalt.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::rotate_salt`,
    arguments: [
      tx.object(args.cumuloId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.newSalt))),
    ],
  });
  return tx;
}

interface RotateBlobArgs {
  cumuloId: string;
  newBlobId: Uint8Array;
}

/**
 * Replace the Walrus blob id. Use to invalidate stored ciphertext for
 * revoked members (pair with go_dark + new bolts for surviving membership).
 */
export function buildRotateBlobTx(args: RotateBlobArgs): Transaction {
  if (args.newBlobId.length < 1 || args.newBlobId.length > 64) {
    throw new Error(`newBlobId must be 1..64 bytes, got ${args.newBlobId.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::rotate_blob`,
    arguments: [
      tx.object(args.cumuloId),
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(args.newBlobId))),
    ],
  });
  return tx;
}

interface PostCumuloThunderArgs {
  cumuloId: string;
  slot: number;
}

/**
 * Emit a ThunderPosted event for a slot inside the Cumulo's Walrus blob.
 * Anyone can post — access control is at the AES-key layer, not on-chain.
 */
export function buildPostCumuloThunderTx(args: PostCumuloThunderArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${STORM_LATEST_PACKAGE}::cumulo::post_thunder`,
    arguments: [tx.object(args.cumuloId), tx.pure.u64(args.slot)],
  });
  return tx;
}

// ─── Adaptive routing helper ───────────────────────────────────────────────

/** Threshold above which Cumulo dedupe beats per-recipient direct Nebula. */
export const CUMULO_PAYLOAD_THRESHOLD_BYTES = 1024;
/** Above this recipient count, Cumulo wins regardless of payload size. */
export const CUMULO_RECIPIENT_THRESHOLD = 2;

/**
 * Decide which path a multi-recipient send should take.
 * Per Aletheia's break-even: small payloads + few recipients → direct Nebula.
 * Large payloads OR many recipients → Cumulo dedupe.
 */
export function chooseSendPath(payloadBytes: number, recipientCount: number): 'nebula' | 'cumulo' {
  if (recipientCount <= CUMULO_RECIPIENT_THRESHOLD && payloadBytes < CUMULO_PAYLOAD_THRESHOLD_BYTES) {
    return 'nebula';
  }
  return 'cumulo';
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
