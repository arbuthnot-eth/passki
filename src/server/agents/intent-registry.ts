/**
 * Aggron Mega Punch — IntentRegistry DO.
 *
 * Maps 4-digit recipient indexes (0000–9999) to SUIAMI identities, one
 * per chain-tag. Paired with the sub-cent intent scheme in
 * `sui-inbound.ts` so a deposit tail like `10000` (chain=1=eth,
 * recipient=0000) resolves to "athena" (eth) without needing any extra
 * on-chain writes from the sender — the intent is encoded in dust digits.
 *
 * Single-instance DO (name: `aggron:intent-registry`). Writes are
 * admin-gated at the worker boundary via `requireUltronAdmin`; the DO
 * itself trusts its caller. Reads (lookup / list) are public — the
 * registry is intentionally non-secret, it's a routing table.
 *
 * Related:
 *   - src/server/sui-inbound.ts — decodeSubcentIntent, chain tags
 *   - src/server/agents/aggron-batcher.ts — sibling DO (reference shape)
 *   - memory/project_ultron_envelope.md — routing architecture
 *   - memory/reference_suiami_is_truth.md — roster-as-truth principle
 */

import { Agent, callable } from 'agents';
import { requireUltronAdmin, todayUtc, ADMIN_ADDRESSES } from '../ultron-policy.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Canonical singleton DO name. */
export const INTENT_REGISTRY_NAME = 'aggron:intent-registry';

/** Intent index bounds (matches the 4-digit recipient slot of
 *  decodeSubcentIntent). 0000 = reserved "no recipient". */
export const INTENT_INDEX_MIN = 0;
export const INTENT_INDEX_MAX = 9999;

/** Chain tag bounds (matches decodeSubcentIntent's top digit: 0=sui,
 *  1=eth, 2=sol, 3=btc). Values 4–9 are reserved but not yet assigned. */
export const CHAIN_TAG_MIN = 0;
export const CHAIN_TAG_MAX = 3;

// ─── Types ──────────────────────────────────────────────────────────

export type IntentChainTag = 0 | 1 | 2 | 3;

export interface IntentEntry {
  /** Recipient registry slot, 0000–9999. Matches the lower 4 digits
   *  of a sub-cent intent tag. */
  intentIndex: number;
  /** Bare SUIAMI label (no .sui suffix), e.g. "athena", "hermes". */
  suiamiName: string;
  /** 0=sui, 1=eth, 2=sol, 3=btc — matches the top digit of the tag. */
  chainTag: IntentChainTag;
  issuedAtMs: number;
  /** Admin address that registered this entry (audit trail). */
  issuedBy: string;
}

export interface IntentRegistryState {
  /** Keyed by `intentIndex` stringified so JSON round-trips cleanly. */
  entries: Record<string, IntentEntry>;
  /** Epoch ms of the last register/revoke. 0 = never modified. */
  lastModifiedMs: number;
}

export interface AdminAuth {
  adminAddress: string;
  signature: string;
  message: string;
}

interface Env {
  // IntentRegistry has no external deps — admin auth flows through the
  // worker boundary, not the DO directly. This shape is a placeholder
  // in case future moves want to call out (e.g. SUIAMI roster verify).
  SUI_NETWORK?: string;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Return true iff `n` is an integer in the valid intent-index range.
 *  Index 0 is technically valid storage-wise but has no semantic meaning
 *  (the sub-cent decoder treats 0 as "no intent"). We accept it at the
 *  validator level and let the decoder short-circuit. */
export function isValidIntentIndex(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= INTENT_INDEX_MIN &&
    n <= INTENT_INDEX_MAX
  );
}

/** Return true iff `n` is an integer in the 0–3 chain tag range. */
export function isValidChainTag(n: unknown): n is IntentChainTag {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= CHAIN_TAG_MIN &&
    n <= CHAIN_TAG_MAX
  );
}

/** Canonical message body for register signatures. Pins intentIndex +
 *  suiamiName + today's UTC date; captured signatures can't replay past
 *  midnight, and swapping the label post-sign is detected at verify. */
export function registerMessageFor(params: {
  intentIndex: number;
  suiamiName: string;
  today?: string;
}): string {
  const today = params.today ?? todayUtc();
  return `aggron-intent-register:${params.intentIndex}:${params.suiamiName}:${today}`;
}

/** Canonical message body for revoke signatures. */
export function revokeMessageFor(params: {
  intentIndex: number;
  today?: string;
}): string {
  const today = params.today ?? todayUtc();
  return `aggron-intent-revoke:${params.intentIndex}:${today}`;
}

/** Sort-by-intentIndex helper — used by `list()` and tests. */
export function sortByIntentIndex(entries: IntentEntry[]): IntentEntry[] {
  return [...entries].sort((a, b) => a.intentIndex - b.intentIndex);
}

// ─── Agent ──────────────────────────────────────────────────────────

export class IntentRegistry extends Agent<Env, IntentRegistryState> {
  initialState: IntentRegistryState = {
    entries: {},
    lastModifiedMs: 0,
  };

  // ─── Callables ─────────────────────────────────────────────────────

  /** Register (or overwrite) an intent → SUIAMI mapping. The worker
   *  boundary has already passed `requireUltronAdmin`; we re-validate
   *  ranges here so callers that talk to the DO directly can't insert
   *  garbage state. */
  @callable({
    description:
      'Register a recipient slot. Overwrites any existing entry at the ' +
      'same intentIndex. Worker endpoint gates with requireUltronAdmin.',
  })
  async register(params: {
    intentIndex: number;
    suiamiName: string;
    chainTag: IntentChainTag;
    issuedBy: string;
  }): Promise<{ ok: true; entry: IntentEntry }> {
    const { intentIndex, suiamiName, chainTag, issuedBy } = params;
    if (!isValidIntentIndex(intentIndex)) {
      throw new Error(
        `intentIndex must be an integer in [${INTENT_INDEX_MIN}, ${INTENT_INDEX_MAX}]`,
      );
    }
    if (!isValidChainTag(chainTag)) {
      throw new Error(
        `chainTag must be an integer in [${CHAIN_TAG_MIN}, ${CHAIN_TAG_MAX}]`,
      );
    }
    if (typeof suiamiName !== 'string' || suiamiName.length === 0) {
      throw new Error('suiamiName must be a non-empty string');
    }
    if (typeof issuedBy !== 'string' || issuedBy.length === 0) {
      throw new Error('issuedBy must be a non-empty string');
    }
    const now = Date.now();
    const entry: IntentEntry = {
      intentIndex,
      suiamiName,
      chainTag,
      issuedAtMs: now,
      issuedBy,
    };
    const key = String(intentIndex);
    const nextEntries = { ...this.state.entries, [key]: entry };
    this.setState({ entries: nextEntries, lastModifiedMs: now });
    return { ok: true, entry };
  }

  /** Remove an entry at `intentIndex`. Idempotent — revoking an empty
   *  slot succeeds with `removed: false`. Worker endpoint gates with
   *  requireUltronAdmin. */
  @callable({ description: 'Revoke an intent mapping.' })
  async revoke(params: {
    intentIndex: number;
  }): Promise<{ ok: true; removed: boolean }> {
    const { intentIndex } = params;
    if (!isValidIntentIndex(intentIndex)) {
      throw new Error(
        `intentIndex must be an integer in [${INTENT_INDEX_MIN}, ${INTENT_INDEX_MAX}]`,
      );
    }
    const key = String(intentIndex);
    if (!(key in this.state.entries)) {
      return { ok: true, removed: false };
    }
    // Clone + delete so we don't mutate the live state object.
    const nextEntries = { ...this.state.entries };
    delete nextEntries[key];
    this.setState({ entries: nextEntries, lastModifiedMs: Date.now() });
    return { ok: true, removed: true };
  }

  /** Public read: resolve a single intent index. Returns `null` for
   *  unknown slots rather than throwing. */
  @callable({ description: 'Lookup one entry by intentIndex (public read).' })
  async lookup(params: { intentIndex: number }): Promise<IntentEntry | null> {
    const { intentIndex } = params;
    if (!isValidIntentIndex(intentIndex)) return null;
    const key = String(intentIndex);
    return this.state.entries[key] ?? null;
  }

  /** Public read: full dump of the registry, sorted by intentIndex. */
  @callable({ description: 'List all registered entries (public read).' })
  async list(): Promise<{ count: number; entries: IntentEntry[] }> {
    const entries = sortByIntentIndex(Object.values(this.state.entries));
    return { count: entries.length, entries };
  }
}

// ─── Worker-side helpers ────────────────────────────────────────────

/** Minimal env shape needed to reach the IntentRegistry DO. */
export interface IntentRegistryEnv {
  IntentRegistry: DurableObjectNamespace;
}

/** Get the singleton DO stub. */
export function getIntentRegistryStub(env: IntentRegistryEnv): DurableObjectStub {
  return env.IntentRegistry.get(env.IntentRegistry.idFromName(INTENT_REGISTRY_NAME));
}

/**
 * Resolve a (recipientIndex, chainTag) pair against the live DO. This is
 * the production-default `rosterLookup` for `lookupRecipientByIntent`.
 * Returns the bare SUIAMI name or null if the slot is empty or the
 * chain tag mismatches.
 */
export async function rosterLookupFromRegistry(
  env: IntentRegistryEnv,
  recipientIndex: number,
  chainTag: string,
): Promise<string | null> {
  const stub = getIntentRegistryStub(env) as unknown as {
    lookup(p: { intentIndex: number }): Promise<IntentEntry | null>;
  };
  const entry = await stub.lookup({ intentIndex: recipientIndex });
  if (!entry) return null;
  // The decoder passes chainTag as the string name (sui/eth/sol/btc);
  // verify consistency so a cross-chain mismatch returns null instead
  // of silently resolving to the wrong identity.
  const chainName = chainTagNumberToName(entry.chainTag);
  if (chainName !== chainTag) return null;
  return entry.suiamiName;
}

/** Local copy of the tag→name map (avoids importing sui-inbound into
 *  the DO module and creating a cycle). */
function chainTagNumberToName(tag: IntentChainTag): 'sui' | 'eth' | 'sol' | 'btc' {
  switch (tag) {
    case 0: return 'sui';
    case 1: return 'eth';
    case 2: return 'sol';
    case 3: return 'btc';
  }
}

// ─── Re-exports for worker convenience ──────────────────────────────

export { requireUltronAdmin, todayUtc, ADMIN_ADDRESSES };
