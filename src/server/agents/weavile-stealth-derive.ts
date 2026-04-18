/**
 * Weavile Pursuit — stealth address derivation helpers (#198).
 *
 * Pure, unit-testable functions that turn a stealth announcement
 * `{ ephemeral_pub, view_tag }` plus a recipient `{ view_priv, spend_pub }`
 * into either a derived one-time stealth pubkey (on match) or `null`
 * (on view-tag mismatch, which is the O(1) fast-path that makes the
 * scan loop cheap).
 *
 * This file is deliberately curve-generic: the DO passes in the curve
 * string from the chain registry (`eth|btc|sui|sol|...`) and we pick
 * the right primitives per scheme-id per `weavile-scanner.md` §Derivation.
 *
 * Zero DO / network deps — everything is @noble/curves + @noble/hashes
 * so bun:test can hit it directly without mocks.
 *
 * Threat model: view_priv is the subpoenable secret (T3). This module
 * never persists it; callers hand it in per-derivation and are
 * responsible for zeroing memory if they care.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { blake2b } from '@noble/hashes/blake2.js';

// ─── Hex helpers ───────────────────────────────────────────────────

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`[weavile-derive] odd-length hex "${hex.slice(0, 20)}…"`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function asBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? fromHex(input) : input;
}

// ─── Types ─────────────────────────────────────────────────────────

export type DeriveCurve = 'secp256k1' | 'ed25519';

export interface DeriveInput {
  /** Sender's per-payment ephemeral pubkey. 33-byte compressed (secp256k1)
   *  or 32-byte (ed25519). */
  ephemeralPub: Uint8Array | string;
  /** 1-byte view-tag hint published alongside the announcement. */
  viewTag: number;
  /** Recipient's view private key (scalar). 32 bytes for both curves. */
  viewPriv: Uint8Array | string;
  /** Recipient's spend public key (the IKA dWallet's per-chain pubkey).
   *  33-byte compressed (secp256k1) or 32-byte (ed25519). */
  spendPub: Uint8Array | string;
  /** Curve to derive on. */
  curve: DeriveCurve;
}

export interface DeriveHit {
  matched: true;
  /** Derived stealth pubkey on the target curve (compressed for secp256k1). */
  stealthPub: Uint8Array;
  /** The tweak scalar s such that stealth_pub = spend_pub + s·G. Hex. */
  tweakHex: string;
  /** First byte of s — mirrors the announcement's view_tag on match. */
  derivedViewTag: number;
}

export interface DeriveMiss {
  matched: false;
  /** First byte of s — useful for debugging why a match failed. */
  derivedViewTag: number;
}

export type DeriveResult = DeriveHit | DeriveMiss;

// ─── Tweak derivation ──────────────────────────────────────────────

/** EIP-5564 §Naïve impl: `s = HKDF-SHA256(shared, salt=[], info="")`,
 *  32-byte output. Sui/Sol use plain SHA-256 over the shared secret
 *  per the scanner spec. Kept separate so each chain's scheme-id
 *  gets the exact hash it commits to on-chain. */
function hashTweakSecp(shared: Uint8Array): Uint8Array {
  // Length 32, single-block HKDF — deterministic tweak. We drop the
  // first byte (compression prefix) of the shared secret, matching
  // reference impls (Umbra, scopelift/stealth-address-kit) that ECDH
  // on secp256k1 and HKDF the X-coord only.
  const xOnly = shared.length === 33 ? shared.slice(1) : shared;
  return hkdf(sha256, xOnly, new Uint8Array(0), new Uint8Array(0), 32);
}

function hashTweakEd25519(shared: Uint8Array): Uint8Array {
  return sha256(shared);
}

// ─── Core derivation ───────────────────────────────────────────────

/**
 * Derive a stealth address for a single announcement event against a
 * single (view_priv, spend_pub) recipient.
 *
 * Fast-path: if `hash(ECDH(view_priv, ephemeral_pub))[0] != view_tag`,
 * returns `{ matched: false }` after one hash + one compare. This is
 * the dominant code path at scale (~255/256 announcements miss).
 *
 * Slow-path: on view-tag hit, compute `stealth_pub = spend_pub + s·G`
 * and return it. Caller is responsible for encoding to chain-native
 * address format (keccak-tail for EVM, base58check for BTC, blake2b
 * for Sui, base58 for Sol).
 */
export function deriveStealthForEvent(input: DeriveInput): DeriveResult {
  const ephPub = asBytes(input.ephemeralPub);
  const viewPriv = asBytes(input.viewPriv);
  const spendPub = asBytes(input.spendPub);

  if (input.curve === 'secp256k1') {
    // secp256k1.getSharedSecret(priv, pub) → 33-byte compressed point.
    const shared = secp256k1.getSharedSecret(viewPriv, ephPub, true);
    const s = hashTweakSecp(shared);
    const derivedViewTag = s[0];
    if (derivedViewTag !== input.viewTag) {
      return { matched: false, derivedViewTag };
    }
    // stealth_pub = spend_pub + s·G. @noble/curves v2 exposes Point
    // arithmetic via secp256k1.Point (formerly ProjectivePoint).
    const G = secp256k1.Point.BASE;
    const sPoint = G.multiply(bytesToScalarSecp(s));
    const spendPoint = secp256k1.Point.fromBytes(spendPub);
    const stealthPoint = spendPoint.add(sPoint);
    const stealthPub = stealthPoint.toBytes(true); // compressed
    return {
      matched: true,
      stealthPub,
      tweakHex: toHex(s),
      derivedViewTag,
    };
  }

  // ed25519
  // We can't use x25519 directly here because the view/spend keys are
  // ed25519-shaped (Sui/Sol use ed25519). Use noble's edwards point
  // ECDH approximation: shared = (viewPriv_scalar) · ephPub_point.
  const ephPoint = ed25519.Point.fromBytes(ephPub);
  // ed25519 secret keys are 32-byte seeds; the scalar is derived via
  // SHA-512 clamping. @noble/curves v2 exposes `ed25519.utils.getExtendedPublicKey`
  // to access the scalar. Guard against callers passing a raw scalar
  // by checking length: both are 32 bytes, so we always treat input
  // as a seed and clamp.
  const scalar = ed25519Scalar(viewPriv);
  const shared = ephPoint.multiply(scalar).toBytes();
  const s = hashTweakEd25519(shared);
  const derivedViewTag = s[0];
  if (derivedViewTag !== input.viewTag) {
    return { matched: false, derivedViewTag };
  }
  const sScalar = bytesToScalarEd(s);
  const G = ed25519.Point.BASE;
  const sPoint = G.multiply(sScalar);
  const spendPoint = ed25519.Point.fromBytes(spendPub);
  const stealthPoint = spendPoint.add(sPoint);
  const stealthPub = stealthPoint.toBytes();
  return {
    matched: true,
    stealthPub,
    tweakHex: toHex(s),
    derivedViewTag,
  };
}

// ─── Scalar helpers ─────────────────────────────────────────────────

function bytesToScalarSecp(bytes: Uint8Array): bigint {
  // Interpret as big-endian, reduce mod N.
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  const N = secp256k1.Point.Fn.ORDER;
  return ((x % N) + N) % N;
}

function bytesToScalarEd(bytes: Uint8Array): bigint {
  // ed25519 scalars are little-endian mod L.
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]);
  const L = ed25519.Point.Fn.ORDER;
  return ((x % L) + L) % L;
}

function ed25519Scalar(seed: Uint8Array): bigint {
  // RFC 8032 §5.1.5: hash 32-byte seed with SHA-512, take low 32 bytes,
  // clamp, interpret little-endian.
  // We avoid pulling sha512 by using noble's internal helper:
  // ed25519.utils.getExtendedPublicKey exists but expects seed; the
  // simpler route is to accept that callers who pass a seed get
  // correct ECDH by re-implementing clamp here. For the Pursuit-move
  // scaffold, we treat the 32-byte input as already-clamped-scalar
  // if caller sets a flag — otherwise seed. Default: seed + clamp.
  if (seed.length !== 32) throw new Error(`[weavile-derive] ed25519 seed must be 32 bytes, got ${seed.length}`);
  // noble/curves v2 exposes ed25519.utils.getExtendedPublicKey which
  // returns { scalar } — that's the canonical path.
  const ext = (ed25519.utils as unknown as {
    getExtendedPublicKey(seed: Uint8Array): { scalar: bigint };
  }).getExtendedPublicKey(seed);
  return ext.scalar;
}

// ─── Sui address encoding ──────────────────────────────────────────
//
// Standard Sui spec: an address is blake2b-256(flag || pubkey) truncated
// to 32 bytes, hex-encoded with 0x prefix. Signature scheme flags
// follow sui::crypto::SignatureScheme (0 = Ed25519, 1 = Secp256k1,
// 2 = Secp256r1, 3 = MultiSig, 5 = zkLogin, 6 = Passkey).
// Reference: Sui docs → "Address" and the sui-types crate.

export const SUI_SIG_FLAG_ED25519 = 0x00;
export const SUI_SIG_FLAG_SECP256K1 = 0x01;

/** Encode a Sui address from an Ed25519 public key (32 bytes).
 *  Matches `sui_types::crypto::PublicKey::Ed25519(...).to_address()`. */
export function suiAddressFromEd25519Pubkey(pubkey32: Uint8Array): string {
  if (pubkey32.length !== 32) {
    throw new Error(`[weavile-derive] ed25519 pubkey must be 32 bytes, got ${pubkey32.length}`);
  }
  const msg = new Uint8Array(33);
  msg[0] = SUI_SIG_FLAG_ED25519;
  msg.set(pubkey32, 1);
  const digest = blake2b(msg, { dkLen: 32 });
  return '0x' + toHex(digest);
}

/** Convenience wrapper over `deriveStealthForEvent` for Sui consumers.
 *  Returns the stealth pubkey + the Sui-native address string.
 *  Sui uses the same ed25519 math as the Solana path — only the
 *  address encoding differs. */
export function deriveSuiStealthForEvent(params: {
  ephemeralPub: Uint8Array | string;
  viewTag: number;
  viewPriv: Uint8Array | string;
  spendPub: Uint8Array | string;
}): (DeriveHit & { suiAddress: string }) | DeriveMiss {
  const base = deriveStealthForEvent({
    ...params,
    curve: 'ed25519',
  });
  if (!base.matched) return base;
  return {
    ...base,
    suiAddress: suiAddressFromEd25519Pubkey(base.stealthPub),
  };
}

export const __test__ = { hashTweakSecp, hashTweakEd25519, bytesToScalarSecp, bytesToScalarEd, ed25519Scalar };
