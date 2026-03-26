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
import { bech32 } from '@scure/base';

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
 * Requires keccak256 — lazy-loaded to keep the base bundle small.
 */
async function evmAddress(pubkey: Uint8Array): Promise<string> {
  // secp256k1 compressed → uncompressed requires elliptic curve math.
  // For now, this is a placeholder — EVM address derivation will be
  // implemented when we add Ethereum dWallet support.
  // The compressed pubkey alone is insufficient without decompression.
  throw new Error('EVM address derivation not yet implemented — requires secp256k1 point decompression');
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
    deriveAddress: () => { throw new Error('EVM derivation not yet implemented'); },
  },
  'eip155:8453': {
    caipId: 'eip155:8453',
    name: 'Base',
    curve: IkaCurve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: HashScheme.KECCAK256,
    coinType: 60,
    deriveAddress: () => { throw new Error('EVM derivation not yet implemented'); },
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
