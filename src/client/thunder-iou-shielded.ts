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
 * Generate a 32-byte Pedersen blinding that's guaranteed to be a
 * valid BLS12-381 Fr scalar (i.e. < Fr.ORDER).
 *
 * This MUST match what the on-chain contract's
 * `bls12381::scalar_from_bytes` accepts. Raw 32 random bytes have
 * a ~50% chance of encoding a value >= Fr.ORDER, which the
 * contract rejects with abort code 1 in group_ops::from_bytes.
 *
 * Approach: generate, reduce mod ORDER, serialize back as BIG-ENDIAN.
 * Sui's bls12381 module documents scalars as big-endian (see
 * sui-framework/sources/crypto/bls12381.move: "Scalars are encoded
 * using big-endian byte order" and SCALAR_ONE_BYTES = 0x00..01).
 *
 * The client-side pedersenCommit below also parses the blinding
 * as big-endian so both sides compute identical commitments.
 */
export function randomBlinding(): Uint8Array {
  const raw = randomBytes(32);
  // Parse as big-endian bigint.
  let val = 0n;
  for (let i = 0; i < 32; i++) val = (val << 8n) | BigInt(raw[i]);
  val %= bls12_381.fields.Fr.ORDER;
  // Serialize back as 32-byte big-endian.
  const out = new Uint8Array(32);
  let v = val;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Parse 32 big-endian bytes into a bigint scalar. */
function scalarFromBeBytes(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < 32; i++) val = (val << 8n) | BigInt(bytes[i]);
  return val;
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
  // Noble 2.x: BASE lives under G1.Point (was G1.BASE in 1.x).
  // toBytes() returns compressed 48-byte encoding by default.
  const G = bls12_381.G1.Point.BASE;
  const H = hGenerator();
  // Parse blinding as big-endian to match Sui's serialization
  // convention + randomBlinding's output format above.
  const rScalar = scalarFromBeBytes(blinding);
  const rG = G.multiply(rScalar % bls12_381.fields.Fr.ORDER);
  const aH = H.multiply(amountMist % bls12_381.fields.Fr.ORDER);
  const C = rG.add(aH);
  return C.toBytes();
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
 * Dugtrio Lv.36 — build a PTB with N shielded deposits in one tx.
 *
 * One `splitCoins(gas, [a1, a2, ..., aN])` split emits N new
 * Coin<SUI> results, each passed to its own
 * `shielded::deposit` moveCall. Result: ONE gas fee amortized
 * across N escrow creations, and ONE storm-note encryption
 * round per slot only (the caller is responsible for having
 * Seal-encrypted each sealedOpening against the right group).
 *
 * Use when multiple shielded sends can be bundled into a single
 * signature — either multiple @recipients in one compose line,
 * or a debounced queue of rapid-fire sends to the same storm.
 *
 * Caller must supply the same number of entries in each array
 * of the `deposits` list. The function returns the built bytes
 * AND the unbuilt Transaction so WaaP callers can pass the
 * Transaction object directly per the WaaP Holy Grail pattern.
 */
export async function buildShieldedDepositManyTx(opts: {
  sender: string;
  deposits: Array<{
    amountMist: bigint;
    blinding: Uint8Array;
    sealedOpening: Uint8Array;
    ttlMs?: number;
  }>;
  gasPayment?: Array<{ objectId: string; version: string; digest: string }>;
}): Promise<{ tx: Transaction; bytes: Uint8Array }> {
  if (opts.deposits.length === 0) {
    throw new Error('buildShieldedDepositManyTx: deposits must be non-empty');
  }
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  if (opts.gasPayment?.length) {
    tx.setGasPayment(opts.gasPayment.map(c => ({
      objectId: c.objectId,
      version: c.version,
      digest: c.digest,
    })));
  }
  // Single splitCoins call — one gas fee amortized across all
  // deposit outputs. tx.splitCoins returns a tuple of results;
  // Transaction's destructuring accessor semantics expose each
  // by index even when there are more than 2.
  const amounts = opts.deposits.map(d => tx.pure.u64(d.amountMist));
  const splitResults = tx.splitCoins(tx.gas, amounts);
  for (let i = 0; i < opts.deposits.length; i++) {
    const d = opts.deposits[i];
    const ttl = d.ttlMs ?? SHIELDED_DEFAULT_TTL_MS;
    tx.moveCall({
      target: `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::deposit`,
      arguments: [
        // splitResults is an array proxy; splitResults[i] gives the
        // i-th nested result of the single splitCoins op.
        (splitResults as unknown as Array<ReturnType<typeof tx.splitCoins>[0]>)[i],
        tx.pure.vector('u8', Array.from(d.blinding)),
        tx.pure.u64(BigInt(ttl)),
        tx.pure.vector('u8', Array.from(d.sealedOpening)),
        tx.object('0x6'),
      ],
    });
  }
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const bytes = await tx.build({ client: gql as never });
  return { tx, bytes };
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
  sponsor?: {
    sponsorAddress: string;
    gasCoins: Array<{ objectId: string; version: string; digest: string }>;
  };
}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  if (opts.sponsor) {
    tx.setGasOwner(opts.sponsor.sponsorAddress);
    tx.setGasPayment(opts.sponsor.gasCoins.map(c => ({
      objectId: c.objectId,
      version: c.version,
      digest: c.digest,
    })));
  }
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
  sponsor?: {
    sponsorAddress: string;
    gasCoins: Array<{ objectId: string; version: string; digest: string }>;
  };
}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(opts.sender));
  if (opts.sponsor) {
    tx.setGasOwner(opts.sponsor.sponsorAddress);
    tx.setGasPayment(opts.sponsor.gasCoins.map(c => ({
      objectId: c.objectId,
      version: c.version,
      digest: c.digest,
    })));
  }
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
