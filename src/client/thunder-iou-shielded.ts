/**
 * Thunder IOU Shielded — client-side helpers.
 *
 * Mirrors the thunder_iou_shielded Move module. Builds Pedersen
 * commitments over BLS12-381 G1 and constructs deposit / claim /
 * recall PTBs.
 *
 *   deposit:  C = r*G + amount*H ; store (C, balance, sender, expiry)
 *   claim:    reveal (r, amount); contract recomputes C, verifies,
 *             transfers balance to claimer
 *   recall:   sender (or any keeper) reclaims after TTL; balance
 *             always returns to iou.sender
 *
 * See contracts/thunder-iou-shielded/sources/shielded.move for the
 * on-chain entry functions and the honest privacy notes.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress, toBase64, fromBase64 } from '@mysten/sui/utils';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { randomBytes } from '@noble/curves/utils.js';

const THUNDER_IOU_SHIELDED_PACKAGE = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782';
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** Domain tag for the H generator — must byte-match H_DOMAIN_TAG in shielded.move. */
const H_DOMAIN_TAG = new TextEncoder().encode('thunder-iou-shielded::H::v1');

/** Default TTL for shielded transfers: 7 days in ms, matching the legacy IOU path. */
export const SHIELDED_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Derive the H generator the same way the on-chain module does:
 * hash_to_g1(H_DOMAIN_TAG). Matches sui::bls12381::hash_to_g1 which
 * uses the BLS12-381 G1 hash-to-curve (SSWU + cofactor clearing).
 */
function hGenerator() {
  return bls12_381.G1.hashToCurve(H_DOMAIN_TAG, { DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_' });
}

/**
 * Generate 32 random bytes as the Pedersen blinding factor. The
 * client keeps these bytes in the Seal-encrypted opening blob so the
 * recipient can reconstruct them at claim time.
 */
export function randomBlinding(): Uint8Array {
  return randomBytes(32);
}

/**
 * Compute the Pedersen commitment C = r*G + amount*H.
 *
 * amount: u64 (will be coerced into the BLS12-381 scalar field)
 * r:      32 random bytes interpreted as a scalar mod r_field
 *
 * Returns the compressed G1 point as a 48-byte Uint8Array, which is
 * the exact format Sui's group_ops::bytes(G1) produces on-chain and
 * is what the contract stores as the commitment field.
 */
export function pedersenCommit(amountMist: bigint, blinding: Uint8Array): Uint8Array {
  if (blinding.length !== 32) throw new Error('pedersenCommit: blinding must be 32 bytes');
  // Build G1 points via Noble's BLS12-381 API.
  const G = bls12_381.G1.BASE;
  const H = hGenerator();
  // Scalars are reduced into the curve's scalar field automatically
  // by the multiply method when given bigint / bytes.
  const rScalar = BigInt('0x' + Array.from(blinding).map(b => b.toString(16).padStart(2, '0')).join(''));
  const rG = G.multiply(rScalar % bls12_381.fields.Fr.ORDER);
  const aH = H.multiply(amountMist % bls12_381.fields.Fr.ORDER);
  const C = rG.add(aH);
  // Compressed encoding — 48 bytes. toRawBytes() defaults to
  // compressed form per Noble's BLS spec.
  return C.toRawBytes(true);
}

/**
 * Build the deposit PTB. Returns pre-built tx bytes ready for
 * signAndExecute. Caller is responsible for providing a funded
 * SUI Coin and the random blinding factor.
 */
export async function buildShieldedDepositTx(opts: {
  sender: string;
  amountMist: bigint;
  blinding: Uint8Array;
  sealedOpening: Uint8Array;
  ttlMs?: number;
}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  const ttl = opts.ttlMs ?? SHIELDED_DEFAULT_TTL_MS;
  const [suiIn] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.amountMist)]);
  tx.moveCall({
    target: `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::deposit`,
    arguments: [
      suiIn,
      tx.pure.vector('u8', Array.from(opts.blinding)),
      tx.pure.u64(BigInt(ttl)),
      tx.pure.vector('u8', Array.from(opts.sealedOpening)),
      tx.object('0x6'),
    ],
  });
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  return await tx.build({ client: gql as never });
}

/**
 * Build the claim PTB. Recipient supplies the opening recovered from
 * the Seal-decrypted storm note and the shared vault object ref.
 */
export async function buildShieldedClaimTx(opts: {
  sender: string;
  vaultObjectId: string;
  vaultInitialSharedVersion: number;
  blinding: Uint8Array;
  amountMist: bigint;
}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  tx.moveCall({
    target: `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::claim`,
    arguments: [
      tx.sharedObjectRef({
        objectId: opts.vaultObjectId,
        initialSharedVersion: opts.vaultInitialSharedVersion,
        mutable: true,
      }),
      tx.pure.vector('u8', Array.from(opts.blinding)),
      tx.pure.u64(opts.amountMist),
      tx.object('0x6'),
    ],
  });
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  return await tx.build({ client: gql as never });
}

/** Build the recall PTB. Permissionless after TTL. */
export async function buildShieldedRecallTx(opts: {
  sender: string;
  vaultObjectId: string;
  vaultInitialSharedVersion: number;
}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  tx.moveCall({
    target: `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::recall`,
    arguments: [
      tx.sharedObjectRef({
        objectId: opts.vaultObjectId,
        initialSharedVersion: opts.vaultInitialSharedVersion,
        mutable: true,
      }),
      tx.object('0x6'),
    ],
  });
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  return await tx.build({ client: gql as never });
}

/**
 * Encode the opening (blinding, amount) into a compact byte blob
 * suitable for Seal-encryption alongside the storm note. Layout:
 *
 *   [ 0  ..  32 ] blinding (32 bytes)
 *   [ 32 ..  40 ] amount as little-endian u64
 *
 * Kept intentionally simple and fixed-size so a future Schnorr NIZK
 * variant can add fields by bumping a version prefix.
 */
export function encodeOpening(blinding: Uint8Array, amountMist: bigint): string {
  if (blinding.length !== 32) throw new Error('encodeOpening: blinding must be 32 bytes');
  const out = new Uint8Array(40);
  out.set(blinding, 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(32, amountMist, true);
  return toBase64(out);
}

export function decodeOpening(b64: string): { blinding: Uint8Array; amountMist: bigint } {
  const raw = fromBase64(b64);
  if (raw.length !== 40) throw new Error('decodeOpening: wrong length');
  const blinding = raw.slice(0, 32);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const amountMist = view.getBigUint64(32, true);
  return { blinding, amountMist };
}
