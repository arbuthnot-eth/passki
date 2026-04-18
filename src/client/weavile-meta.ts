/**
 * Weavile Razor Claw — stealth meta-address generation, serialization,
 * and PTB helpers (#198).
 *
 * Meta-address format:
 *   ska:<ika_dwallet_id_hex>:<chain=pubkey_hex>(|<chain=pubkey_hex>)*
 *
 *   e.g. ska:0xabcd…:eth=0x02ab…|sui=0x1234…|sol=0x5678…
 *
 * Chains → curve:
 *   - eth, btc, tron, polygon, base, arbitrum — secp256k1 (33-byte compressed)
 *   - sui, sol                                — ed25519 (32-byte pubkey)
 *
 * EVM family (polygon/base/arbitrum) shares the same secp256k1 view key
 * with `eth` in practice; this module lets callers decide per-chain.
 *
 * View keys generated here are CLIENT-SIDE temporary. Per the threat
 * model (`2026-04-18-sneasel-weavile-threat-model.md` T3/T4), the view
 * priv is subpoenable if stored anywhere server-side. For Razor Claw we
 * return both priv and pub so the browser can persist the priv under
 * whichever local-storage/IndexedDB encrypted cache SKI settles on;
 * later moves (Pursuit) move the priv off-client onto a scanner DO
 * with the understood T3 trade-off.
 *
 * NO PTB build happens without an explicit SUIAMI_WEAVILE_PKG — the
 * Move upgrade that lands `set_stealth_meta` is a separate "Razor Claw
 * deploy" move. This file refuses to emit a moveCall until then.
 */

import type { Transaction as TxType } from '@mysten/sui/transactions';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';

// ─── Package gating ────────────────────────────────────────────────
//
// Sneasel's SUIAMI_STEALTH_PKG points at the package that introduced
// `bind_guest_stealth` + `seal_approve_guest_stealth` (0xaf56…39a0).
// Weavile's `set_stealth_meta` is in a *later* Move upgrade that hasn't
// been published yet. Keep its pkg id null so nothing ships a doomed
// PTB before the deploy move lands.
export const SUIAMI_WEAVILE_PKG: string | null = '0xf4910af0747d53df5e0900c10b1f362407564e717fdee321c2777d535e915c77';

// ─── Chain curve registry ──────────────────────────────────────────

export type StealthChain =
  | 'eth' | 'btc' | 'tron' | 'polygon' | 'base' | 'arbitrum'
  | 'sui' | 'sol';

export type Curve = 'secp256k1' | 'ed25519';

export const CHAIN_CURVES: Record<StealthChain, Curve> = {
  eth: 'secp256k1',
  btc: 'secp256k1',
  tron: 'secp256k1',
  polygon: 'secp256k1',
  base: 'secp256k1',
  arbitrum: 'secp256k1',
  sui: 'ed25519',
  sol: 'ed25519',
};

export function curveForChain(chain: string): Curve {
  const c = CHAIN_CURVES[chain as StealthChain];
  if (!c) throw new Error(`[weavile] unknown chain "${chain}"`);
  return c;
}

// ─── Hex helpers ───────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`[weavile] odd-length hex "${hex.slice(0, 20)}…"`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ─── Key generation ────────────────────────────────────────────────

export interface ViewKeyPair {
  priv: Uint8Array;
  pub: Uint8Array; // compressed secp256k1 (33 bytes) or ed25519 (32 bytes)
}

/** Generate a fresh view keypair on the correct curve for `chain`. */
export function generateViewKeyForChain(chain: string): ViewKeyPair {
  const curve = curveForChain(chain);
  if (curve === 'secp256k1') {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, true); // compressed
    return { priv, pub };
  }
  // ed25519
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub };
}

export interface GenerateViewKeysResult {
  privHex: Record<string, string>;
  pubHex: Record<string, string>;
}

/**
 * Generate one view keypair per listed chain. EVM-family chains
 * (eth/polygon/base/arbitrum) could share a key in principle; we
 * generate separate keys here so operators can rotate per-chain
 * independently, and senders don't need to know "eth view key covers
 * arbitrum". Callers who want to share can pass `shareSecp256k1: true`.
 */
export function generateViewKeys(
  chains: string[],
  opts?: { shareSecp256k1?: boolean },
): GenerateViewKeysResult {
  if (!chains.length) throw new Error('[weavile] chains[] must be non-empty');
  const priv: Record<string, string> = {};
  const pub: Record<string, string> = {};
  let sharedSecp: ViewKeyPair | null = null;
  let sharedEd: ViewKeyPair | null = null;
  for (const chain of chains) {
    const curve = curveForChain(chain);
    let kp: ViewKeyPair;
    if (opts?.shareSecp256k1 && curve === 'secp256k1') {
      if (!sharedSecp) sharedSecp = generateViewKeyForChain(chain);
      kp = sharedSecp;
    } else if (opts?.shareSecp256k1 && curve === 'ed25519') {
      // Share ed25519 across sui/sol when the caller explicitly opts in.
      if (!sharedEd) sharedEd = generateViewKeyForChain(chain);
      kp = sharedEd;
    } else {
      kp = generateViewKeyForChain(chain);
    }
    priv[chain] = toHex(kp.priv);
    pub[chain] = toHex(kp.pub);
  }
  return { privHex: priv, pubHex: pub };
}

// ─── Serialization ─────────────────────────────────────────────────

export interface MetaAddressParts {
  /** IKA dWallet id as 0x-prefixed 32-byte hex. */
  ikaDwalletId: string;
  /** chain → 0x-prefixed view pubkey hex. */
  viewPubkeysByChain: Record<string, string>;
}

/** Serialize to the on-wire `ska:…` format. Chain order is preserved
 *  by insertion order — callers should sort if they want canonical. */
export function serializeMetaAddress(parts: MetaAddressParts): string {
  const id = parts.ikaDwalletId.startsWith('0x')
    ? parts.ikaDwalletId
    : `0x${parts.ikaDwalletId}`;
  const entries = Object.entries(parts.viewPubkeysByChain);
  if (!entries.length) {
    // Valid: dWallet published, view keys still pending.
    return `ska:${id}:`;
  }
  const encoded = entries
    .map(([chain, pk]) => {
      if (!/^[a-z0-9]+$/.test(chain)) {
        throw new Error(`[weavile] invalid chain "${chain}" (must be [a-z0-9]+)`);
      }
      const pkHex = pk.startsWith('0x') ? pk : `0x${pk}`;
      return `${chain}=${pkHex}`;
    })
    .join('|');
  return `ska:${id}:${encoded}`;
}

/** Parse the on-wire format. Throws on malformed input. */
export function parseMetaAddress(metaStr: string): MetaAddressParts {
  if (!metaStr.startsWith('ska:')) {
    throw new Error(`[weavile] meta-address missing "ska:" prefix: ${metaStr.slice(0, 32)}`);
  }
  const rest = metaStr.slice(4);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) throw new Error('[weavile] meta-address missing view-keys segment');
  const idPart = rest.slice(0, firstColon);
  const viewPart = rest.slice(firstColon + 1);
  if (!/^0x[0-9a-fA-F]+$/.test(idPart)) {
    throw new Error(`[weavile] invalid ika_dwallet_id: ${idPart.slice(0, 20)}`);
  }
  const viewPubkeysByChain: Record<string, string> = {};
  if (viewPart.length > 0) {
    for (const segment of viewPart.split('|')) {
      const eq = segment.indexOf('=');
      if (eq < 0) throw new Error(`[weavile] malformed view segment "${segment.slice(0, 20)}"`);
      const chain = segment.slice(0, eq);
      const pk = segment.slice(eq + 1);
      if (!/^[a-z0-9]+$/.test(chain)) {
        throw new Error(`[weavile] invalid chain token "${chain}"`);
      }
      if (!/^0x[0-9a-fA-F]+$/.test(pk)) {
        throw new Error(`[weavile] invalid pubkey hex for "${chain}"`);
      }
      viewPubkeysByChain[chain] = pk;
    }
  }
  return { ikaDwalletId: idPart, viewPubkeysByChain };
}

// ─── Move PTB helper ───────────────────────────────────────────────

export interface SetStealthMetaArgs {
  rosterObj: string;
  /** 0x-prefixed hex of the IKA dWallet id. */
  ikaDwalletId: string;
  /** Parallel to chainKeys in order. */
  entries: Array<{ chain: string; viewPubkey: Uint8Array | string }>;
}

/** Append `set_stealth_meta` to the caller's PTB. Refuses to build
 *  until SUIAMI_WEAVILE_PKG is set (i.e. Razor Claw deploy has landed). */
export function buildSetStealthMetaTx(tx: TxType, args: SetStealthMetaArgs): void {
  if (!SUIAMI_WEAVILE_PKG) {
    throw new Error(
      '[weavile] SUIAMI_WEAVILE_PKG not set — Razor Claw deploy move pending. ' +
      'Scaffold landed the Move + tests; publish it before calling this.',
    );
  }
  const chainKeys: string[] = [];
  const pubkeys: number[][] = [];
  for (const { chain, viewPubkey } of args.entries) {
    if (!/^[a-z0-9]+$/.test(chain)) {
      throw new Error(`[weavile] invalid chain "${chain}"`);
    }
    const bytes = typeof viewPubkey === 'string' ? fromHex(viewPubkey) : viewPubkey;
    chainKeys.push(chain);
    pubkeys.push(Array.from(bytes));
  }
  tx.moveCall({
    target: `${SUIAMI_WEAVILE_PKG}::roster::set_stealth_meta`,
    arguments: [
      tx.object(args.rosterObj),
      tx.pure.id(args.ikaDwalletId),
      tx.pure.vector('string', chainKeys),
      tx.pure.vector('vector<u8>', pubkeys),
      tx.object('0x6'), // Clock
    ],
  });
}

/** Convenience: parse a meta-address and build the corresponding PTB. */
export function buildSetStealthMetaFromMetaStr(
  tx: TxType,
  rosterObj: string,
  metaStr: string,
): void {
  const parts = parseMetaAddress(metaStr);
  const entries = Object.entries(parts.viewPubkeysByChain).map(([chain, pk]) => ({
    chain,
    viewPubkey: pk,
  }));
  buildSetStealthMetaTx(tx, {
    rosterObj,
    ikaDwalletId: parts.ikaDwalletId,
    entries,
  });
}
