/**
 * Darkrai mainnet — Hypnosis Field.
 *
 * Wraps the live `darkrai` Move package (scribed 2026-04-30) into JS helpers
 * that build PTBs against `darkrai::nebula::*` and `darkrai::group_storm::*`.
 *
 * Combine with `darkrai-storm.ts` (sender + recipient flow) to produce real
 * on-chain Nebulae instead of in-tab simulations.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

// ─── Mainnet addresses (see ~/.claude/.../memory/project_darkrai_mainnet.md) ──

export const DARKRAI_PACKAGE =
  '0xc10f1c6276fe397bfda2200ffbbe174ebbf2aa95ec2d92aa0906c66345e0cde6';
export const DARKRAI_VERSION_OBJECT =
  '0xda6aa3fb1a72117edce6f9ec424da255890ae795cb9d13f26716bd59b71044d9';

export const NEBULA_TYPE = `${DARKRAI_PACKAGE}::nebula::Nebula`;
export const NEBULA_EPOCH_TYPE = `${DARKRAI_PACKAGE}::nebula::NebulaEpoch`;
export const GROUP_STORM_TYPE = `${DARKRAI_PACKAGE}::group_storm::GroupStorm`;
export const GROUP_STORM_EPOCH_TYPE = `${DARKRAI_PACKAGE}::group_storm::GroupStormEpoch`;

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
    target: `${DARKRAI_PACKAGE}::nebula::open`,
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
    target: `${DARKRAI_PACKAGE}::nebula::open`,
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
    target: `${DARKRAI_PACKAGE}::nebula::post_thunder`,
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
    target: `${DARKRAI_PACKAGE}::nebula::seal_epoch`,
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
    target: `${DARKRAI_PACKAGE}::nebula::mark_bad_ct`,
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
    target: `${DARKRAI_PACKAGE}::nebula::rotate_epoch`,
    arguments: [tx.object(args.nebulaId), tx.object(args.prevEpochId)],
  });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [NEBULA_EPOCH_TYPE],
    arguments: [newEpoch],
  });
  return tx;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
