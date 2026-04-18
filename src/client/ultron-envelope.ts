/**
 * UltronEnvelope — unified routing protocol for sends through
 * `ultron.whelm.eth`.
 *
 * One envelope type wraps every dispatch kind (coin transfers, Prism
 * cross-chain routes, DWalletCap handoffs, stealth sweeps, guest binds).
 * Sender Seal-encrypts against ultron's policy, queues to Aggron for
 * Quilt storage, then sends funds/caps to the appropriate ultron
 * chain-address tagged with the envelope's intent id. Ultron's inbound
 * watcher decrypts + dispatches.
 *
 * Design: memory/project_ultron_envelope.md
 * Related: Aggron Stone Edge (batcher), SUIAMI roster (recipient
 * resolution), sui-inbound.ts (sender-side of the Sui leg).
 */

import type { SessionKey } from '@mysten/seal';

export type EnvelopeKind =
  | 'transfer'
  | 'prism'
  | 'dwallet-transfer'
  | 'stealth-sweep'
  | 'guest-bind';

export type EnvelopeChain = 'sui' | 'eth' | 'sol' | 'btc';

export interface EnvelopeAsset {
  /** Chain-qualified coin type or token address.
   *  Sui: `0x2::sui::SUI`, `0x356…::wal::WAL`, USDC full path.
   *  EVM: lowercase 0x ERC20 contract (or `0x0` for native).
   *  SOL: SPL mint pubkey base58.
   *  BTC: `native`. */
  coinType: string;
  /** Raw mist/lamports/sats/wei, decimal-preserved as a numeric string. */
  amountMist: string;
}

export interface EnvelopeRecipient {
  /** Destination chain — which leg the dispatcher routes on. */
  chain: EnvelopeChain;
  /** Direct on-chain address in the chain's native format. Use one of
   *  address / whelmName / stealthMeta — precedence: stealthMeta >
   *  whelmName > address. */
  address?: string;
  /** Bare SUIAMI/whelm label ("hermes" for hermes.whelm.eth).
   *  Dispatcher resolves via the SUIAMI roster at decrypt time, so
   *  rotations after encrypt still route correctly. */
  whelmName?: string;
  /** Weavile stealth meta-address (`ska:<id>:<chain=hex>|`). Dispatcher
   *  derives a fresh per-payment stealth addr; unlinkable. */
  stealthMeta?: string;
}

export interface EnvelopeExtras {
  /** `dwallet-transfer` kind only — which DWalletCap to hand off. */
  dwalletCapId?: string;
  /** `prism` kind only — Quasar cross-chain route. */
  prismRoute?: { fromChain: string; mint: string; targetChain: string };
  /** Cross-chain router hint. */
  gatewayHint?: string;
  /** Human-readable memo. Encrypted alongside the envelope. */
  memo?: string;
}

export interface UltronEnvelope {
  version: 1;
  kind: EnvelopeKind;
  asset: EnvelopeAsset;
  recipient: EnvelopeRecipient;
  extras?: EnvelopeExtras;
  /** Optional — sender self-identifies for receipts / disputes. */
  senderSuiAddress?: string;
  /** ms epoch when envelope was built (client clock). */
  submittedAtMs: number;
}

// ─── Validation ─────────────────────────────────────────────────────

/** Throw with a clear message if the envelope is structurally invalid.
 *  Does NOT validate that the recipient resolves — that's dispatcher job. */
export function validateEnvelope(e: UltronEnvelope): void {
  if (e.version !== 1) throw new Error(`UltronEnvelope: unsupported version ${e.version}`);
  if (!e.kind) throw new Error('UltronEnvelope: kind required');
  const validKinds: EnvelopeKind[] = ['transfer', 'prism', 'dwallet-transfer', 'stealth-sweep', 'guest-bind'];
  if (!validKinds.includes(e.kind)) throw new Error(`UltronEnvelope: invalid kind ${e.kind}`);
  if (!e.asset?.coinType) throw new Error('UltronEnvelope: asset.coinType required');
  if (!e.asset?.amountMist) throw new Error('UltronEnvelope: asset.amountMist required');
  try { BigInt(e.asset.amountMist); }
  catch { throw new Error(`UltronEnvelope: asset.amountMist must parse as BigInt, got "${e.asset.amountMist}"`); }
  if (!e.recipient) throw new Error('UltronEnvelope: recipient required');
  const chains: EnvelopeChain[] = ['sui', 'eth', 'sol', 'btc'];
  if (!chains.includes(e.recipient.chain)) {
    throw new Error(`UltronEnvelope: recipient.chain must be one of ${chains.join('/')}`);
  }
  const anchors = [e.recipient.address, e.recipient.whelmName, e.recipient.stealthMeta].filter(Boolean);
  if (anchors.length === 0) {
    throw new Error('UltronEnvelope: recipient needs address OR whelmName OR stealthMeta');
  }
  // Kind-specific extras
  if (e.kind === 'dwallet-transfer' && !e.extras?.dwalletCapId) {
    throw new Error('UltronEnvelope: dwallet-transfer kind requires extras.dwalletCapId');
  }
  if (e.kind === 'prism' && !e.extras?.prismRoute) {
    throw new Error('UltronEnvelope: prism kind requires extras.prismRoute');
  }
}

// ─── Builders ───────────────────────────────────────────────────────

export function buildTransferEnvelope(params: {
  coinType: string;
  amountMist: string | bigint;
  chain: EnvelopeChain;
  /** Pass one — stealthMeta wins, then whelmName, then address. */
  to: { address?: string; whelmName?: string; stealthMeta?: string };
  memo?: string;
  senderSuiAddress?: string;
}): UltronEnvelope {
  const e: UltronEnvelope = {
    version: 1,
    kind: 'transfer',
    asset: { coinType: params.coinType, amountMist: String(params.amountMist) },
    recipient: {
      chain: params.chain,
      ...(params.to.address ? { address: params.to.address } : {}),
      ...(params.to.whelmName ? { whelmName: params.to.whelmName } : {}),
      ...(params.to.stealthMeta ? { stealthMeta: params.to.stealthMeta } : {}),
    },
    ...(params.memo ? { extras: { memo: params.memo } } : {}),
    ...(params.senderSuiAddress ? { senderSuiAddress: params.senderSuiAddress } : {}),
    submittedAtMs: Date.now(),
  };
  validateEnvelope(e);
  return e;
}

export function buildPrismEnvelope(params: {
  coinType: string;
  amountMist: string | bigint;
  fromChain: string;
  mint: string;
  targetChain: string;
  recipient: { address?: string; whelmName?: string };
  memo?: string;
}): UltronEnvelope {
  const e: UltronEnvelope = {
    version: 1,
    kind: 'prism',
    asset: { coinType: params.coinType, amountMist: String(params.amountMist) },
    recipient: {
      chain: params.targetChain as EnvelopeChain,
      ...(params.recipient.address ? { address: params.recipient.address } : {}),
      ...(params.recipient.whelmName ? { whelmName: params.recipient.whelmName } : {}),
    },
    extras: {
      prismRoute: {
        fromChain: params.fromChain,
        mint: params.mint,
        targetChain: params.targetChain,
      },
      ...(params.memo ? { memo: params.memo } : {}),
    },
    submittedAtMs: Date.now(),
  };
  validateEnvelope(e);
  return e;
}

export function buildDwalletTransferEnvelope(params: {
  dwalletCapId: string;
  recipient: { address?: string; whelmName?: string };
  /** Chain the cap lives on (Sui today). */
  chain?: EnvelopeChain;
  memo?: string;
}): UltronEnvelope {
  const e: UltronEnvelope = {
    version: 1,
    kind: 'dwallet-transfer',
    // DWalletCap transfers move an object, not fungible value — asset shape
    // is nominal ("one DWalletCap object") so downstream auditors see a
    // concrete record.
    asset: { coinType: 'sui::dwallet::DWalletCap', amountMist: '1' },
    recipient: {
      chain: params.chain ?? 'sui',
      ...(params.recipient.address ? { address: params.recipient.address } : {}),
      ...(params.recipient.whelmName ? { whelmName: params.recipient.whelmName } : {}),
    },
    extras: {
      dwalletCapId: params.dwalletCapId,
      ...(params.memo ? { memo: params.memo } : {}),
    },
    submittedAtMs: Date.now(),
  };
  validateEnvelope(e);
  return e;
}

// ─── Serialization ──────────────────────────────────────────────────

/** Canonical JSON bytes — deterministic key ordering so Seal identity
 *  doesn't drift between encrypt and decrypt. */
export function serializeEnvelope(e: UltronEnvelope): Uint8Array {
  validateEnvelope(e);
  const ordered = {
    version: e.version,
    kind: e.kind,
    asset: { coinType: e.asset.coinType, amountMist: e.asset.amountMist },
    recipient: orderedRecipient(e.recipient),
    extras: e.extras ? orderedExtras(e.extras) : undefined,
    senderSuiAddress: e.senderSuiAddress,
    submittedAtMs: e.submittedAtMs,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

function orderedRecipient(r: EnvelopeRecipient): EnvelopeRecipient {
  return {
    chain: r.chain,
    ...(r.address ? { address: r.address } : {}),
    ...(r.whelmName ? { whelmName: r.whelmName } : {}),
    ...(r.stealthMeta ? { stealthMeta: r.stealthMeta } : {}),
  };
}

function orderedExtras(x: EnvelopeExtras): EnvelopeExtras {
  return {
    ...(x.dwalletCapId ? { dwalletCapId: x.dwalletCapId } : {}),
    ...(x.prismRoute ? { prismRoute: x.prismRoute } : {}),
    ...(x.gatewayHint ? { gatewayHint: x.gatewayHint } : {}),
    ...(x.memo ? { memo: x.memo } : {}),
  };
}

export function parseEnvelope(bytes: Uint8Array): UltronEnvelope {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as UltronEnvelope;
  validateEnvelope(parsed);
  return parsed;
}

// Keep `SessionKey` referenced so future callers importing from here
// get a single import root for seal-encrypt wiring.
export type { SessionKey };
