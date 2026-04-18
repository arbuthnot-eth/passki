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
export const SUIAMI_STEALTH_PKG: string | null = '0xaf56e9d096a69ccc68486cfcc88d5ed08db1cf37c88d255ab14ba0e3a7ab39a0';

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
 *  stealth entries. */
export interface ColdDestPayload {
  coldAddr: string;
  chain: string;
  sweepDelegate: string;
  version: number;
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
  coldAddr: string;
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
  if (typeof parsed.coldAddr !== 'string' || typeof parsed.chain !== 'string') {
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
    coldAddr: string;
    chain: string;
    ttlMs: number;
    sweepDelegate: string;
  },
): Promise<{ sealedColdDest: Uint8Array }> {
  const sealedColdDest = await sealEncryptColdDest({
    coldAddr: args.coldAddr,
    chain: args.chain,
    parentHash: args.parentHash,
    labelBytes: args.labelBytes,
    sweepDelegate: args.sweepDelegate,
  });
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
  return { sealedColdDest };
}
