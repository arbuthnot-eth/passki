/**
 * Sneasel — private-send flow for `*.whelm.eth` (#197).
 *
 * Wraps the Move `bind_guest_stealth` entry with a client-side helper that
 * Seal-encrypts the cold-squid destination and gates decrypt to ultron
 * (or a designated sweep delegate) via `seal_approve_guest_stealth`.
 *
 * Call shape:
 *   await guestPrivate('amazon.brando', {
 *     hotAddr: '0xHOTeth...',                   // fresh IKA-derived receive addr
 *     coldAddr: '0xCOLDeth...',                 // real squid, never appears on-chain plaintext
 *     chain: 'eth',
 *     ttl: '90d',
 *     sweepDelegate: '0xcaA8d6F0...882d',       // eth@ultron
 *   });
 *
 * Observer-facing view:
 *   amazon.brando.whelm.eth → hotAddr (public CCIP-read, zero history)
 *   funds land at hotAddr, ultron's sweeper (Sneasel Pursuit DO) fires an
 *   IKA-signed sweep after decrypting coldAddr JIT via seal_approve_guest_stealth.
 *
 * Sneasel Blizzard (this move): wires real Seal encryption against the new
 * `seal_approve_guest_stealth(roster, parent_hash, label, clock, ctx)` policy.
 * Still gated on SUIAMI_STEALTH_PKG — Move upgrade must land first. Until
 * then encrypt/decrypt throw a clear message instead of silently producing
 * bytes that no deployed policy can approve.
 */

import type { Transaction as TxType } from '@mysten/sui/transactions';
import { Transaction } from '@mysten/sui/transactions';
import type { SessionKey } from '@mysten/seal';
import {
  getSealClient,
  sealRace,
  ROSTER_OBJ,
  ROSTER_INITIAL_SHARED_VERSION,
} from './suiami-seal.js';
import { grpcClient } from '../rpc.js';

// Set this to the SUIAMI package id AFTER the Move upgrade that landed
// `bind_guest_stealth` + `seal_approve_guest_stealth`. Until then the
// helpers refuse to build a PTB / cipher so nobody wastes gas on a
// doomed call and no plaintext-on-chain slips through.
export const SUIAMI_STEALTH_PKG: string | null = '0xf4910af0747d53df5e0900c10b1f362407564e717fdee321c2777d535e915c77';

export interface GuestPrivateParams {
  /** Hot receive address — freshly provisioned per guest. ETH addr for
   *  coinType=60, SOL for 501, etc. For now caller supplies; Sneasel
   *  Icy Wind will mint a fresh IKA dWallet per guest automatically. */
  hotAddr: string;
  /** Real cold-squid destination. Never stored on-chain plaintext —
   *  Seal-encrypted against seal_approve_guest_stealth policy. */
  coldAddr: string;
  /** "eth" | "sol" | "btc" | "tron" | "sui" — matches hotAddr chain. */
  chain: string;
  /** TTL string ("30d", "90d", "never") or ms number. */
  ttl: string | number;
  /** Sweep delegate — the address whose on-chain sender proof unlocks
   *  Seal decryption. Typically eth@ultron's IKA-derived address. */
  sweepDelegate: string;
}

export interface GuestPrivateResult {
  ok?: boolean;
  digest?: string;
  label?: string;
  parentName?: string;
  hotAddr?: string;
  chain?: string;
  ttlMs?: number;
  error?: string;
}

/** JSON schema actually sealed into `sealed_cold_dest`. Versioned so a
 *  future move (Sneasel Slash?) can migrate without breaking in-flight
 *  stealth entries.
 *
 *  v1 (legacy): baked the real coldAddr directly into an ultron-readable
 *  blob. Caused the sweep-graph collapse documented in Sneasel Ice Fang
 *  (plans/2026-04-18-sneasel-ice-fang.md §1).
 *
 *  v2 (Ice Fang): two-layer split. Layer 1 (this file's on-chain shape)
 *  seals a per-guest *intermediate* IKA dWallet addr under
 *  `seal_approve_guest_stealth` so ultron can only sign hot→intermediate.
 *  Layer 2 holds the real coldAddr and is parent-owner-only (client-side
 *  only for this move — Move-level second-layer policy is a follow-up).
 */
export interface ColdDestPayload {
  /** Legacy v1 field — present only on pre-Ice Fang payloads. */
  coldAddr?: string;
  chain: string;
  sweepDelegate?: string;
  version: number;
  createdAtMs: number;
}

/** Layer 1 — what ultron sees after Seal decrypt. Points at a
 *  per-guest intermediate dWallet. */
export interface ColdDestV2Intermediate {
  intermediateAddr: string;
  chain: string;
  sweepDelegate: string;
  version: 2;
  createdAtMs: number;
}

/** Layer 2 — parent-owner-only. Held client-side during Ice Fang;
 *  a future move will add a parent-gated Seal policy for this. */
export interface ColdDestV2Final {
  coldAddr: string;
  chain: string;
  version: 2;
  createdAtMs: number;
}

// Helper — concat Uint8Arrays and emit hex (what SealClient.encrypt wants
// for `id`, since its createFullId helper runs fromHex internally).
function concatHex(a: Uint8Array, b: Uint8Array): string {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return Array.from(out)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Encrypt the cold destination with Seal, gated by
 * `suiami::roster::seal_approve_guest_stealth`.
 *
 * Seal identity shape: `parent_hash || label` (32 + label_len bytes).
 * This is deterministic per (parent, label) so the sweep delegate can
 * reconstruct the same identity at decrypt time without a side-channel.
 *
 * Returns raw `encryptedObject` bytes — these go straight into the
 * `sealed_cold_dest: vector<u8>` Move arg, no extra framing.
 */
export async function sealEncryptColdDest(params: {
  /** Per-guest IKA dWallet intermediate addr. NEVER the real cold squid —
   *  Ice Fang layer-1 seals this, layer-2 (parent-only) holds coldAddr. */
  intermediateAddr: string;
  chain: string;
  parentHash: Uint8Array;
  labelBytes: Uint8Array;
  sweepDelegate: string;
}): Promise<Uint8Array> {
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error(
      '[sneasel] SUIAMI_STEALTH_PKG not set — refusing to Seal-encrypt ' +
      'against a non-existent policy. Land the Move upgrade first.',
    );
  }
  if (params.parentHash.length !== 32) {
    throw new Error(`[sneasel] parentHash must be 32 bytes, got ${params.parentHash.length}`);
  }
  if (params.labelBytes.length === 0) {
    throw new Error('[sneasel] labelBytes must be non-empty');
  }
  if (!params.intermediateAddr) {
    throw new Error('[sneasel] intermediateAddr required (Ice Fang v2)');
  }
  // Invariants from plan §2: intermediate MUST be distinct from the
  // ultron delegate. A collapse here would reproduce the v1 sweep-graph
  // bug by making "intermediate" just an alias for ultron.
  if (params.intermediateAddr.toLowerCase() === params.sweepDelegate.toLowerCase()) {
    throw new Error('[sneasel] intermediateAddr must differ from sweepDelegate (Ice Fang collapse)');
  }

  const payload: ColdDestV2Intermediate = {
    intermediateAddr: params.intermediateAddr,
    chain: params.chain,
    sweepDelegate: params.sweepDelegate,
    version: 2,
    createdAtMs: Date.now(),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const idHex = concatHex(params.parentHash, params.labelBytes);

  const { encryptedObject } = await sealRace((c) =>
    c.encrypt({
      packageId: SUIAMI_STEALTH_PKG as string,
      id: idHex,
      data: plaintext,
      threshold: 2,
    }),
  );
  return encryptedObject;
}

/**
 * Legacy v1 encrypt path. Kept for READ-COMPAT only (so a decrypt of a
 * pre-Ice Fang stealth entry still works on the watcher side). New
 * bindings MUST call `sealEncryptColdDest` (v2). Calling this logs a
 * deprecation warning; it will be ripped out after all v1 entries
 * expire or get re-bound.
 *
 * @deprecated since Sneasel Ice Fang — use v2 `sealEncryptColdDest`.
 */
export async function sealEncryptColdDestLegacy(params: {
  coldAddr: string;
  chain: string;
  parentHash: Uint8Array;
  labelBytes: Uint8Array;
  sweepDelegate: string;
}): Promise<Uint8Array> {
  console.warn(
    '[sneasel] sealEncryptColdDestLegacy called — v1 cold-dest payload ' +
    'is deprecated (Ice Fang). Migrate callers to v2 `sealEncryptColdDest`.',
  );
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error('[sneasel] SUIAMI_STEALTH_PKG not set');
  }
  if (params.parentHash.length !== 32) {
    throw new Error(`[sneasel] parentHash must be 32 bytes, got ${params.parentHash.length}`);
  }
  if (params.labelBytes.length === 0) {
    throw new Error('[sneasel] labelBytes must be non-empty');
  }
  const payload: ColdDestPayload = {
    coldAddr: params.coldAddr,
    chain: params.chain,
    sweepDelegate: params.sweepDelegate,
    version: 1,
    createdAtMs: Date.now(),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const idHex = concatHex(params.parentHash, params.labelBytes);
  const { encryptedObject } = await sealRace((c) =>
    c.encrypt({
      packageId: SUIAMI_STEALTH_PKG as string,
      id: idHex,
      data: plaintext,
      threshold: 2,
    }),
  );
  return encryptedObject;
}

/**
 * Sneasel Icy Wind — per-guest IKA DKG.
 *
 * Ice Fang property: every guest gets its OWN intermediate dWallet,
 * never shared with ultron's broker cluster and never shared across
 * guests. Icy Wind replaces the Ice Fang stub with a real IKA DKG
 * ceremony per guest, keyed on a deterministic (parentHash, label)
 * encryption seed so the seed is reproducible but the DKG output
 * (public key, address) is non-deterministic (the IKA network
 * contributes randomness).
 *
 * Flow (real path):
 *   1. Resolve chain → IKA curve (secp256k1 for BTC/ETH/Sui/Tron/Base/
 *      Polygon/Arbitrum, ed25519 for Sol/Sui-ed25519).
 *   2. Derive a 32-byte encryption seed = sha256("sneasel-icy-wind" ||
 *      parentHash || label || chain). Deterministic per guest so a
 *      keeper can re-derive keys without a side-channel.
 *   3. Call `provisionDWallet(signerAddress, { requestedCurve, targetOwner:
 *      sweepDelegate, encryptionSeed, signTransaction, signAndExecuteTransaction })`.
 *      Reuses all of the existing rumble machinery — no new DKG logic.
 *   4. Read back the newly-active CrossChainStatus, pick the chain-native
 *      address (btc/eth/sol) matching the requested chain, and grab the
 *      freshly-minted DWalletCap id.
 *
 * Ownership: `sweepDelegate` receives the DWalletCap via `targetOwner`,
 * so ultron.sui (Sui-side sweep delegate) gets sign authority.
 *
 * NOTE: `sweepDelegate` is the Sui-side cap owner, NOT the eth@ultron
 * 0xcaA… address. Callers must pass ultron.sui (e.g.
 * 0x9872c1f5…b285f7). ETH-side sweep delegation is a separate concern
 * handled by Pursuit DO at sign-time.
 */
import type { Curve as IkaCurveType } from '@ika.xyz/sdk';
import { deriveAddress as deriveChainAddr, resolveChain, IkaCurve } from './chains.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ICY_WIND_SEED_DOMAIN = new TextEncoder().encode('sneasel-icy-wind');

/** Derive the deterministic per-guest encryption seed. Same (parent,label,chain)
 *  always produces the same 32 bytes. Keeper re-derives this from its copy
 *  of the parentHash + label to reconstruct user-share encryption keys. */
export function deriveIcyWindSeed(params: {
  parentHash: Uint8Array;
  label: string;
  chain: string;
}): Uint8Array {
  const labelBytes = new TextEncoder().encode(params.label);
  const chainBytes = new TextEncoder().encode(params.chain);
  const buf = new Uint8Array(
    ICY_WIND_SEED_DOMAIN.length + params.parentHash.length + labelBytes.length + chainBytes.length,
  );
  let off = 0;
  buf.set(ICY_WIND_SEED_DOMAIN, off); off += ICY_WIND_SEED_DOMAIN.length;
  buf.set(params.parentHash, off); off += params.parentHash.length;
  buf.set(labelBytes, off); off += labelBytes.length;
  buf.set(chainBytes, off);
  return sha256(buf);
}

/** Map a Sneasel chain string to an IKA curve. Throws on unsupported. */
function chainToIkaCurve(chain: string): 'secp256k1' | 'ed25519' {
  const cfg = resolveChain(chain);
  if (cfg.curve === IkaCurve.SECP256K1) return 'secp256k1';
  if (cfg.curve === IkaCurve.ED25519) return 'ed25519';
  throw new Error(`[sneasel:icy-wind] unsupported curve for chain ${chain}`);
}

/**
 * Dry-run preview of `mintGuestIntermediate`. Does NOT hit the IKA
 * network — returns the deterministic seed + the curve that would be
 * used, plus a stable `previewAddr` for UI display before the user
 * commits to signing a DKG tx.
 *
 * previewAddr is clearly marked `0xICY_WIND_PREVIEW_` so callers can't
 * accidentally bind it on-chain.
 */
export function mintGuestIntermediateDryRun(params: {
  chain: string;
  parentHash: Uint8Array;
  label: string;
}): {
  chain: string;
  curve: 'secp256k1' | 'ed25519';
  seedHex: string;
  previewAddr: string;
} {
  if (params.parentHash.length !== 32) {
    throw new Error(`[sneasel:icy-wind] parentHash must be 32 bytes, got ${params.parentHash.length}`);
  }
  if (!params.label) throw new Error('[sneasel:icy-wind] label required');
  const curve = chainToIkaCurve(params.chain);
  const seed = deriveIcyWindSeed(params);
  const seedHex = Array.from(seed).map((b) => b.toString(16).padStart(2, '0')).join('');
  // Preview addr = first 16 bytes of seed, folded with chain — purely
  // cosmetic, never a real address. Different per (parent,label,chain)
  // so the stub-uniqueness property the Ice Fang test relied on holds.
  const previewAddr = `0xICY_WIND_PREVIEW_${seedHex.slice(0, 32)}`;
  return { chain: params.chain, curve, seedHex, previewAddr };
}

/** Callbacks required to drive a real per-guest DKG. Mirrors the
 *  `ProvisionCallbacks` shape from `./ika.ts` but narrowed to what
 *  Icy Wind needs — the caller (UI) wires their wallet. */
export interface IcyWindCallbacks {
  /** Address that will submit the DKG tx (the parent — brando.sui /
   *  whelm.eth owner's Sui side). Must own SUI + IKA, or be eligible
   *  for sponsored gas via `/api/ika/provision`. */
  signerAddress: string;
  /** Sign-only (Phantom/Backpack sponsored path). */
  signTransaction: (txBytes: Uint8Array) => Promise<{ signature: string }>;
  /** Sign + execute (WaaP path). */
  signAndExecuteTransaction: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: unknown }>;
  isWaap?: boolean;
  onStatus?: (msg: string) => void;
}

/**
 * Mint a fresh per-guest intermediate dWallet via real IKA DKG.
 *
 * Requires `SUIAMI_STEALTH_PKG` to be set (so bound entries have a
 * policy to approve against) and an IKA-ready signer. Returns the
 * chain-native intermediate address + the DWalletCap object id now
 * owned by `sweepDelegate`.
 *
 * Throws cleanly (not the old stub) if the env isn't ready — the
 * companion `mintGuestIntermediateDryRun` exists for preview paths
 * that must not submit.
 */
export async function mintGuestIntermediate(params: {
  chain: string;
  parentHash: Uint8Array;
  label: string;
  sweepDelegate: string;
  callbacks: IcyWindCallbacks;
}): Promise<{ intermediateAddr: string; intermediateCapId: string | null; chain: string }> {
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error(
      '[sneasel:icy-wind] SUIAMI_STEALTH_PKG not set — refusing to mint a ' +
      'per-guest dWallet we cannot bind. Land the Move upgrade first.',
    );
  }
  if (params.parentHash.length !== 32) {
    throw new Error(`[sneasel:icy-wind] parentHash must be 32 bytes, got ${params.parentHash.length}`);
  }
  if (!params.label) throw new Error('[sneasel:icy-wind] label required');
  if (!params.sweepDelegate) throw new Error('[sneasel:icy-wind] sweepDelegate required');
  if (!params.callbacks?.signerAddress) {
    throw new Error('[sneasel:icy-wind] callbacks.signerAddress required — need a funded IKA signer');
  }

  // Resolve curve + derive the deterministic per-guest encryption seed.
  const preview = mintGuestIntermediateDryRun({
    chain: params.chain,
    parentHash: params.parentHash,
    label: params.label,
  });

  // Dynamic import of ika.ts so tests that only exercise dry-run / guard
  // paths don't drag the full IKA SDK + WASM into the module graph.
  const ika = await import('./ika.js');
  const ikaCurve: IkaCurveType = preview.curve === 'ed25519' ? ika.Curve.ED25519 : ika.Curve.SECP256K1;
  const seed = deriveIcyWindSeed({
    parentHash: params.parentHash,
    label: params.label,
    chain: params.chain,
  });

  params.callbacks.onStatus?.(`[icy-wind] DKG ${preview.curve} for ${params.label}…`);

  // Real DKG — targetOwner is the sweepDelegate so ultron ends up
  // holding the DWalletCap directly, no second-step transfer needed.
  const status = await ika.provisionDWallet(params.callbacks.signerAddress, {
    signTransaction: params.callbacks.signTransaction,
    signAndExecuteTransaction: params.callbacks.signAndExecuteTransaction,
    isWaap: params.callbacks.isWaap,
    onStatus: params.callbacks.onStatus,
    requestedCurve: ikaCurve,
    targetOwner: params.sweepDelegate,
    encryptionSeed: seed,
  });

  // Pick the chain-native address out of the post-DKG status.
  let intermediateAddr = '';
  if (preview.curve === 'ed25519') {
    intermediateAddr = status.solAddress;
  } else {
    // secp256k1 family — pick based on caller's chain.
    const chainCfg = resolveChain(params.chain);
    if (chainCfg.name === 'Ethereum' || chainCfg.name === 'Base' ||
        chainCfg.name === 'Polygon' || chainCfg.name === 'Arbitrum' ||
        chainCfg.name === 'Optimism') {
      intermediateAddr = status.ethAddress;
    } else if (chainCfg.name === 'Bitcoin') {
      intermediateAddr = status.btcAddress;
    } else {
      // Fallback: find by name in status.addresses, else re-derive from
      // scratch (provisionDWallet only populates btc/eth/sol fast paths).
      const hit = status.addresses.find((a) => a.name === chainCfg.name);
      intermediateAddr = hit?.address ?? '';
    }
  }
  if (!intermediateAddr) {
    throw new Error(
      `[sneasel:icy-wind] DKG completed but no ${params.chain} address derived — ` +
      'check CrossChainStatus.addresses and extend the chain switch if needed.',
    );
  }

  // The DWalletCap now owned by sweepDelegate — grab the most recent one.
  // status.dwalletCaps is the signer's caps; we want the recipient's.
  let intermediateCapId: string | null = null;
  try {
    const recipStatus = await ika.getCrossChainStatus(params.sweepDelegate);
    intermediateCapId = recipStatus.dwalletCaps[recipStatus.dwalletCaps.length - 1] ?? null;
  } catch {
    // Non-fatal — caller may resolve via on-chain query later.
    intermediateCapId = null;
  }

  params.callbacks.onStatus?.(`[icy-wind] intermediate=${intermediateAddr.slice(0, 12)}…`);
  return { intermediateAddr, intermediateCapId, chain: params.chain };
}

/**
 * Decrypt a sealed cold destination. Called server-side by
 * SneaselWatcher (Pursuit DO) when a hot_addr sees inbound funds.
 *
 * The caller must supply a pre-authenticated SessionKey — the sweep
 * delegate (e.g. ultron) mints it once on DO boot via the same
 * personal-message flow the browser uses. Scoped to SUIAMI_STEALTH_PKG
 * so Seal key servers accept the PTB target.
 */
export async function sealDecryptColdDest(params: {
  sealedBlob: Uint8Array;
  parentHash: Uint8Array;
  labelBytes: Uint8Array;
  sweepDelegate: SessionKey;
}): Promise<ColdDestPayload> {
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error(
      '[sneasel] SUIAMI_STEALTH_PKG not set — no policy to evaluate. ' +
      'Land the Move upgrade first.',
    );
  }
  if (params.parentHash.length !== 32) {
    throw new Error(`[sneasel] parentHash must be 32 bytes, got ${params.parentHash.length}`);
  }

  // Build an approval PTB that calls seal_approve_guest_stealth with the
  // same (parent_hash, label) the encrypt path used. `onlyTransactionKind`
  // lets Seal key servers dry-run without a gas budget or signature.
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIAMI_STEALTH_PKG}::roster::seal_approve_guest_stealth`,
    arguments: [
      tx.sharedObjectRef({
        objectId: ROSTER_OBJ,
        initialSharedVersion: ROSTER_INITIAL_SHARED_VERSION,
        mutable: false,
      }),
      tx.pure.vector('u8', Array.from(params.parentHash)),
      tx.pure.vector('u8', Array.from(params.labelBytes)),
      tx.object('0x6'), // Clock
    ],
  });
  const txBytes = await tx.build({
    client: grpcClient as never,
    onlyTransactionKind: true,
  });

  // fetchKeys is implicit in SealClient.decrypt — it calls the key
  // servers itself if the session key hasn't cached the approval yet.
  const plaintext = await sealRace((c) =>
    c.decrypt({
      data: params.sealedBlob,
      sessionKey: params.sweepDelegate,
      txBytes,
    }),
  );

  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as ColdDestPayload;
  if (typeof parsed.chain !== 'string' || typeof parsed.version !== 'number') {
    throw new Error('[sneasel] decrypted cold-dest payload malformed');
  }
  return parsed;
}

// Silence "unused import" — getSealClient is re-exported conceptually via
// sealRace, but we keep the explicit import so a reader following the
// Bronzong pattern can grep for it without chasing through re-exports.
void getSealClient;

/** Build (but do NOT submit) the bind_guest_stealth PTB. Caller submits
 *  via the usual signAndExecuteTransaction path. */
export async function buildBindGuestStealthTx(
  tx: TxType,
  args: {
    rosterObj: string;
    parentHash: number[];
    labelBytes: number[];
    hotAddr: string;
    chain: string;
    sealedColdDest: Uint8Array;
    ttlMs: number;
    sweepDelegate: string;
  },
): Promise<void> {
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error(
      '[sneasel] SUIAMI_STEALTH_PKG not set — Move upgrade pending. ' +
      'Sneasel Ice Shard landed the entry fns; next is sui move test then publish.',
    );
  }
  tx.moveCall({
    target: `${SUIAMI_STEALTH_PKG}::roster::bind_guest_stealth`,
    arguments: [
      tx.object(args.rosterObj),
      tx.pure.vector('u8', args.parentHash),
      tx.pure.vector('u8', args.labelBytes),
      tx.pure.string(args.hotAddr),
      tx.pure.string(args.chain),
      tx.pure.vector('u8', Array.from(args.sealedColdDest)),
      tx.pure.u64(args.ttlMs),
      tx.pure.address(args.sweepDelegate),
      tx.object('0x6'), // Clock
    ],
  });
}

/**
 * High-level helper — encrypts coldAddr with Seal, then appends the
 * bind_guest_stealth move call to the caller's PTB. One-stop for the UI
 * side of Sneasel (Icy Wind will call this with a freshly-minted hot
 * addr).
 *
 * Does NOT submit. Caller signs + executes via the usual wallet path.
 */
export async function buildGuestPrivateTx(
  tx: TxType,
  args: {
    rosterObj: string;
    parentHash: Uint8Array;
    labelBytes: Uint8Array;
    hotAddr: string;
    /** Real cold squid — Ice Fang keeps this in the client-side layer-2
     *  blob, never sealed into the layer-1 (ultron-readable) payload. */
    coldAddr: string;
    /** Per-guest IKA dWallet intermediate — the only address ultron
     *  ever sees as "cold dest". Required by Ice Fang v2. */
    intermediateAddr: string;
    chain: string;
    ttlMs: number;
    sweepDelegate: string;
  },
): Promise<{ sealedColdDest: Uint8Array; layer2: ColdDestV2Final }> {
  // Ice Fang invariants: intermediate must not collapse onto ultron or
  // onto the real cold squid. The second check in particular is what
  // keeps the parent-only layer-2 meaningfully distinct from layer-1.
  if (args.intermediateAddr.toLowerCase() === args.sweepDelegate.toLowerCase()) {
    throw new Error('[sneasel] intermediateAddr must differ from sweepDelegate (Ice Fang collapse)');
  }
  if (args.intermediateAddr.toLowerCase() === args.coldAddr.toLowerCase()) {
    throw new Error('[sneasel] intermediateAddr must differ from coldAddr (Ice Fang collapse)');
  }
  const sealedColdDest = await sealEncryptColdDest({
    intermediateAddr: args.intermediateAddr,
    chain: args.chain,
    parentHash: args.parentHash,
    labelBytes: args.labelBytes,
    sweepDelegate: args.sweepDelegate,
  });
  const layer2: ColdDestV2Final = {
    coldAddr: args.coldAddr,
    chain: args.chain,
    version: 2,
    createdAtMs: Date.now(),
  };
  await buildBindGuestStealthTx(tx, {
    rosterObj: args.rosterObj,
    parentHash: Array.from(args.parentHash),
    labelBytes: Array.from(args.labelBytes),
    hotAddr: args.hotAddr,
    chain: args.chain,
    sealedColdDest,
    ttlMs: args.ttlMs,
    sweepDelegate: args.sweepDelegate,
  });
  return { sealedColdDest, layer2 };
}
