/**
 * Multi-chain registry for IKA dWallet address derivation.
 *
 * Maps CAIP-2 chain identifiers to IKA curve parameters and address
 * derivation functions. A single secp256k1 dWallet can sign for Bitcoin,
 * Ethereum, and Sui. An ed25519 dWallet signs for Solana.
 *
 * Adapted from inkwell-finance/ows-ika (MIT) — stripped to the derivation
 * functions we actually need, with real implementations instead of stubs.
 *
 * @see https://github.com/inkwell-finance/ows-ika
 * @see https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32, base58 } from '@scure/base';

// ─── IKA Curve & Algorithm Enums ─────────────────────────────────────
// Mirrors @ika.xyz/sdk values so we don't need to import the full SDK
// in browser-side code that only needs chain resolution.

export enum IkaCurve {
  SECP256K1 = 0,
  SECP256R1 = 1,
  ED25519 = 2,
  RISTRETTO = 3,
}

export enum SignatureAlgorithm {
  ECDSASecp256k1 = 0,
  Taproot = 1,
  ECDSASecp256r1 = 2,
  EdDSA = 3,
  SchnorrkelSubstrate = 4,
}

export enum HashScheme {
  KECCAK256 = 0,
  SHA256 = 1,
  DoubleSHA256 = 2,
  SHA512 = 3,
  Merlin = 4,
}

// ─── Chain Config ────────────────────────────────────────────────────

export interface ChainConfig {
  /** CAIP-2 identifier (e.g. 'bip122:000000000019d6689c085ae165831e93') */
  caipId: string;
  /** Human-readable name */
  name: string;
  /** IKA curve for this chain's key type */
  curve: IkaCurve;
  /** Signature algorithm for signing */
  signatureAlgorithm: SignatureAlgorithm;
  /** Hash scheme for message digests */
  hashScheme: HashScheme;
  /** BIP-44 coin type */
  coinType: number;
  /**
   * Derive a chain-native address from a compressed public key.
   * For secp256k1: 33 bytes. For ed25519: 32 bytes.
   */
  deriveAddress: (compressedPubkey: Uint8Array) => string;
}

// ─── Address Derivation Functions ────────────────────────────────────

/**
 * Bitcoin P2WPKH (native SegWit) — bc1q... bech32 address.
 * Hash160 = RIPEMD160(SHA256(compressed_pubkey))
 * Witness program = [version=0, Hash160]
 */
function btcP2wpkhAddress(pubkey: Uint8Array): string {
  const hash160 = ripemd160(sha256(pubkey));
  const words = bech32.toWords(hash160);
  words.unshift(0); // witness version 0
  return bech32.encode('bc', words);
}

/**
 * EVM address — 0x prefixed, last 20 bytes of keccak256(uncompressed_pubkey[1:]).
 *
 * Steps:
 *   1. Decompress secp256k1 point (33 bytes → 65 bytes)
 *   2. Strip the 0x04 prefix → 64 bytes (raw x||y coordinates)
 *   3. keccak256 hash → 32 bytes
 *   4. Take last 20 bytes → EIP-55 checksum encode
 */
function evmAddress(compressedPubkey: Uint8Array): string {
  // Decompress: 33-byte compressed → 65-byte uncompressed (04 || x || y)
  const hex = Array.from(compressedPubkey, (b) => b.toString(16).padStart(2, '0')).join('');
  const point = secp256k1.Point.fromHex(hex);
  const uncompressed = point.toBytes(false); // false = uncompressed (65 bytes)

  // keccak256 of the 64-byte public key (skip the 0x04 prefix byte)
  const hash = keccak_256(uncompressed.slice(1));

  // Last 20 bytes = the raw address
  const addrBytes = hash.slice(12);

  // EIP-55 mixed-case checksum encoding
  const addrHex = Array.from(addrBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const checksumHash = Array.from(keccak_256(new TextEncoder().encode(addrHex)), (b) => b.toString(16).padStart(2, '0')).join('');
  let checksummed = '';
  for (let i = 0; i < addrHex.length; i++) {
    checksummed += parseInt(checksumHash[i], 16) >= 8
      ? addrHex[i].toUpperCase()
      : addrHex[i];
  }
  return '0x' + checksummed;
}

/**
 * Solana address — base58 encoding of the raw 32-byte ed25519 public key.
 * No hashing, no prefix — just the pubkey bytes in base58.
 */
function solanaAddress(pubkey: Uint8Array): string {
  // Ed25519 pubkeys from IKA are 32 bytes
  if (pubkey.length !== 32) {
    throw new Error(`Expected 32-byte ed25519 pubkey, got ${pubkey.length}`);
  }
  return base58.encode(pubkey);
}

/**
 * Tron address — base58check encoding with 0x41 network prefix.
 * Same 20-byte address as EVM (keccak256 of uncompressed pubkey), different encoding.
 */
function tronAddress(compressedPubkey: Uint8Array): string {
  const hex = Array.from(compressedPubkey, (b) => b.toString(16).padStart(2, '0')).join('');
  const point = secp256k1.Point.fromHex(hex);
  const uncompressed = point.toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = hash.slice(12); // last 20 bytes

  // Tron: 0x41 prefix + address bytes → base58check
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(addrBytes, 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum, 21);
  return base58.encode(full);
}

/**
 * Convert an EVM 0x address to a Tron T... address.
 * No pubkey needed — just re-encodes the same 20 bytes.
 */
export function ethToTron(ethAddr: string): string {
  const hex = ethAddr.replace(/^0x/i, '').toLowerCase();
  const addrBytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) addrBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(addrBytes, 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum, 21);
  return base58.encode(full);
}

/**
 * Sui address — BLAKE2b-256([flag_byte=0x01] || compressed_secp256k1_pubkey).
 * Flag 0x01 = secp256k1 scheme in Sui's multi-scheme addressing.
 */
function suiSecp256k1Address(_pubkey: Uint8Array): string {
  // Sui normally uses ed25519 (flag 0x00). secp256k1 addresses (flag 0x01)
  // are rare and require BLAKE2b which we don't bundle yet.
  throw new Error('Sui secp256k1 address derivation not yet implemented');
}

// ─── Chain Registry ──────────────────────────────────────────────────

export const CHAIN_REGISTRY: Record<string, ChainConfig> = {
  // ── Bitcoin ───────────────────────────────────────────────────────
  'bip122:000000000019d6689c085ae165831e93': {
    caipId: 'bip122:000000000019d6689c085ae165831e93',
    name: 'Bitcoin',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.Taproot,
    hashScheme: HashScheme.SHA256,
    coinType: 0,
    deriveAddress: btcP2wpkhAddress,
  },

  // ── EVM chains (same curve, same derivation, different CAIP-2) ───
  'eip155:1': {
    caipId: 'eip155:1',
    name: 'Ethereum',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: evmAddress,
  },
  'eip155:8453': {
    caipId: 'eip155:8453',
    name: 'Base',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: evmAddress,
  },
  'eip155:137': {
    caipId: 'eip155:137',
    name: 'Polygon',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: evmAddress,
  },
  'eip155:42161': {
    caipId: 'eip155:42161',
    name: 'Arbitrum',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: evmAddress,
  },
  'eip155:10': {
    caipId: 'eip155:10',
    name: 'Optimism',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: evmAddress,
  },

  // ── Tron (USDT only) ────────────────────────────────────────────
  'tron:mainnet': {
    caipId: 'tron:mainnet',
    name: 'Tron',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 195,
    deriveAddress: tronAddress,
  },

  // ── Solana ──────────────────────────────────────────────────────
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    caipId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    name: 'Solana',
    curve: IkaCurve.ED25519,
    signatureAlgorithm: SignatureAlgorithm.EdDSA,
    hashScheme: HashScheme.SHA512,
    coinType: 501,
    deriveAddress: solanaAddress,
  },

  // ── Sui ──────────────────────────────────────────────────────────
  'sui:mainnet': {
    caipId: 'sui:mainnet',
    name: 'Sui',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.SHA256,
    coinType: 784,
    deriveAddress: suiSecp256k1Address,
  },
};

// ── Aliases ──────────────────────────────────────────────────────────

const CHAIN_ALIASES: Record<string, string> = {
  bitcoin: 'bip122:000000000019d6689c085ae165831e93',
  btc: 'bip122:000000000019d6689c085ae165831e93',
  ethereum: 'eip155:1',
  eth: 'eip155:1',
  base: 'eip155:8453',
  polygon: 'eip155:137',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  tron: 'tron:mainnet',
  trx: 'tron:mainnet',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  sol: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  sui: 'sui:mainnet',
};

/**
 * Resolve a chain alias or CAIP-2 ID to its full config.
 *
 * @example
 *   resolveChain('btc')     // → Bitcoin config
 *   resolveChain('eip155:1') // → Ethereum config
 */
export function resolveChain(chainIdOrAlias: string): ChainConfig {
  const caipId = CHAIN_ALIASES[chainIdOrAlias.toLowerCase()] ?? chainIdOrAlias;
  const config = CHAIN_REGISTRY[caipId];
  if (!config) {
    throw new Error(`Unsupported chain: ${chainIdOrAlias} (resolved to ${caipId})`);
  }
  return config;
}

/**
 * Get all chains that use a given IKA curve.
 * Useful for showing which chains a single dWallet can sign for.
 *
 * @example
 *   chainsForCurve(IkaCurve.SECP256K1) // → [Bitcoin, Ethereum, Base, Sui]
 */
export function chainsForCurve(curve: IkaCurve): ChainConfig[] {
  return Object.values(CHAIN_REGISTRY).filter((c) => c.curve === curve);
}

/**
 * Derive a chain-native address from a dWallet's compressed public key.
 * Convenience wrapper that resolves chain + calls deriveAddress.
 */
export function deriveAddress(chainIdOrAlias: string, compressedPubkey: Uint8Array): string {
  const chain = resolveChain(chainIdOrAlias);
  return chain.deriveAddress(compressedPubkey);
}
