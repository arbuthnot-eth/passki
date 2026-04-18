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
 * Mint a fresh per-guest intermediate dWallet. Ice Fang property:
 * every guest gets its OWN intermediate, never shared with ultron's
 * broker cluster and never shared across guests.
 *
 * TODO(Sneasel Icy Wind): replace stub with real IKA dWallet DKG per
 * guest — should reuse the `rumble` machinery with a fresh DKG session
 * keyed on (parentHash, label). The current return is a deterministic
 * placeholder derived from (parentHash, label, chain) so tests and
 * integration wiring can reference a stable intermediateAddr without
 * waiting on Icy Wind. It is clearly marked `0xICE_FANG_STUB_` so a
 * grep catches any accidental mainnet use.
 */
export async function mintGuestIntermediate(params: {
  chain: string;
  parentHash: Uint8Array;
  label: string;
}): Promise<{ intermediateAddr: string; intermediateCapId: string | null }> {
  // Deterministic stub: hex of sha-ish concat. Not cryptographic — just
  // a stable, recognizably-fake address string. Real impl will return
  // the IKA dWallet's chain-native address + its DWalletCap object id.
  const labelBytes = new TextEncoder().encode(params.label);
  const seed = new Uint8Array(params.parentHash.length + labelBytes.length + params.chain.length);
  seed.set(params.parentHash, 0);
  seed.set(labelBytes, params.parentHash.length);
  seed.set(new TextEncoder().encode(params.chain), params.parentHash.length + labelBytes.length);
  // Simple xor-fold so the label actually affects the first 16 bytes
  // of the stub addr (parentHash alone would shadow short labels).
  const folded = new Uint8Array(16);
  for (let i = 0; i < seed.length; i += 1) {
    folded[i % 16] ^= seed[i];
  }
  const hex = Array.from(folded)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  const intermediateAddr = `0xICE_FANG_STUB_${hex}`;
  return { intermediateAddr, intermediateCapId: null };
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
