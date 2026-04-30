/**
 * Aggron Harden pt2 — SuiInboundWatcher DO.
 *
 * Polls ultron's Sui address every ~60s via JSON-RPC, decodes sub-cent
 * intent tags (see `sui-inbound.ts`) on every positive inbound balance
 * change, and logs the routing decision. No actual forwarding yet — the
 * IKA-signed sweep ceremony lands in a follow-up move (Hermes pt3).
 *
 * Observability-only today: the DO keeps a bounded ring buffer of the
 * last ~100 observed activities and the last ~100 routing decisions so
 * operators can `status()` / `recentRouting()` and see what would have
 * been routed once signing is wired.
 *
 * One singleton instance (name: `ultron-inbound`). Sharding makes no
 * sense — the whole point is watching one address (sui@ultron).
 *
 * Related:
 *   - src/server/sui-inbound.ts — pure decoder/extractor helpers
 *   - src/server/agents/aggron-batcher.ts — sibling DO (Quilt batcher)
 *   - memory/project_aggron_batcher.md — architectural context
 *   - memory/project_ultron_envelope.md — routing model
 */

import { Agent, callable } from 'agents';
import {
  SUI_ULTRON_ADDRESS,
  SUI_ULTRON_ADDRESSES,
  decodeSubcentIntent,
  chainTagName,
  type SuiInboundActivity,
  type DecodedIntent,
} from '../sui-inbound.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Alarm cadence. 60 s matches the "tail-the-mempool" band without
 *  smashing the PublicNode RPC budget. */
export const SUI_INBOUND_ALARM_MS = 60 * 1000;

/** Ring-buffer caps — tunable if the DO ever shards. */
export const OBSERVED_MAX = 100;
export const ROUTING_LOG_MAX = 100;

/** Page size for `queryTransactionBlocks`. 50 is comfortably under the
 *  PublicNode / BlockVision limits and gives us plenty of overlap
 *  against the dedupe set between ticks. */
export const QUERY_LIMIT = 50;

/** Default JSON-RPC endpoint. Kept as a constant so tests can override. */
export const DEFAULT_FULLNODE_URL = 'https://sui-rpc.publicnode.com';

// ─── Types ──────────────────────────────────────────────────────────

/** One logged routing decision.
 *
 *  Status semantics:
 *    - `routed`     — registry lookup hit + UltronPostal dispatch succeeded
 *    - `unresolved` — registry miss OR dispatch threw (transient; next
 *                     alarm tick re-polls the same Sui tx, dedupe won't
 *                     apply because we don't record observed entries for
 *                     unresolved txs... actually we do — see note below)
 *    - `no-intent`  — decoded tail was zero (kept for completeness; the
 *                     current pipeline doesn't push these into
 *                     routingLog, but the type admits it for future use)
 */
export interface RoutingDecision {
  digest: string;
  coinType: string;
  fromAddress: string;
  amountMist: string; // bigint → decimal string (JSON-safe)
  intent: DecodedIntent & {
    amountMist: string; // rawAmount re-serialized as string
    baseAmount: string;
  };
  chainTagName: ReturnType<typeof chainTagName>;
  /** Would-be routing note for logs. */
  note: string;
  observedAtMs: number;
  /** Ms timestamp a dispatch actually fired; null until then. */
  routedAt: number | null;
  /** SUIAMI name resolved via IntentRegistry (absent on unresolved). */
  recipientSuiamiName?: string;
  /** Ticket id returned by UltronPostal.dispatch. */
  dispatchTicketId?: string;
  /** Dispatch/registry phase. See interface doc for semantics. */
  status: 'routed' | 'unresolved' | 'no-intent';
  /** Last error message if status === 'unresolved' due to a throw. */
  lastError?: string;
}

/** Shape returned by IntentRegistry.lookup. */
export interface IntentRegistryEntry {
  suiamiName: string;
  recipientIndex: number;
  chainTag?: string;
}

/** Shape returned by UltronPostal.dispatch. */
export interface UltronPostalTicket {
  ticketId: string;
  kind: string;
  action: string;
}

/** Lightweight serializable mirror of SuiInboundActivity. */
export interface ObservedActivity {
  digest: string;
  fromAddress: string;
  coinType: string;
  amountMist: string;
  timestampMs: number;
  observedAtMs: number;
}

export interface SuiInboundWatcherState {
  /** Highest tx digest we've observed. Used solely as a display cursor;
   *  the real dedupe set lives in `observed[].digest`. */
  lastPolledCheckpoint: string | null;
  lastPolledAtMs: number;
  observed: ObservedActivity[];
  routingLog: RoutingDecision[];
}

interface Env {
  SUI_NETWORK?: string;
  /** Optional override for the JSON-RPC URL (tests / alternate providers). */
  SUI_FULLNODE_URL?: string;
  /** Intent→SUIAMI recipient registry DO (built by a sibling agent). */
  IntentRegistry?: DurableObjectNamespace;
  /** Ultron-side dispatcher DO (built by a sibling agent). */
  UltronPostal?: DurableObjectNamespace;
}

/** Minimal RPC-shape for the two sibling DOs. Declared here so this file
 *  doesn't import their class modules (parallel agents land them). */
export interface IntentRegistryStub {
  lookup(params: { intentIndex: number }): Promise<IntentRegistryEntry | null>;
}
export interface UltronPostalStub {
  dispatch(params: {
    activity: SuiInboundActivity;
    intent: DecodedIntent;
    recipientSuiamiName: string;
  }): Promise<UltronPostalTicket>;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Keep only the last `max` entries of a ring buffer. */
export function ringPush<T>(buf: T[], next: T[], max: number): T[] {
  const merged = buf.concat(next);
  return merged.length <= max ? merged : merged.slice(merged.length - max);
}

/** Serialize a DecodedIntent into a JSON-safe form (bigints → strings). */
export function serializeIntent(intent: DecodedIntent): RoutingDecision['intent'] {
  return {
    ...intent,
    amountMist: intent.rawAmount.toString(),
    baseAmount: intent.baseAmount.toString(),
  };
}

/** Walk a `queryTransactionBlocks` response into normalized inbound
 *  activities (positive credits TO ultron only). Intentionally duplicates
 *  the field-walking logic in `extractInboundToUltron` because the
 *  JSON-RPC shape is slightly different from the generic checkpoint
 *  shape (`balanceChanges[].owner` is an `AddressOwner` object wrapper;
 *  `amount` is a string; `effects` lives at top level). */
export function parseInboundFromRpc(
  response: unknown,
  ultronAddress: string | readonly string[] = SUI_ULTRON_ADDRESSES,
): SuiInboundActivity[] {
  const out: SuiInboundActivity[] = [];
  if (!response || typeof response !== 'object') return out;
  const r = response as Record<string, unknown>;
  const data = Array.isArray(r.data) ? r.data : [];
  const ultronAddrs = (Array.isArray(ultronAddress) ? ultronAddress : [ultronAddress as string]).map((a) => a.toLowerCase());
  for (const tx of data as Array<Record<string, unknown>>) {
    const digest = typeof tx.digest === 'string' ? tx.digest : '';
    const timestampMs = typeof tx.timestampMs === 'string'
      ? Number(tx.timestampMs)
      : typeof tx.timestampMs === 'number'
        ? tx.timestampMs
        : 0;
    const txBlock = tx.transaction as Record<string, unknown> | undefined;
    const txData = txBlock?.data as Record<string, unknown> | undefined;
    const sender = typeof txData?.sender === 'string' ? txData.sender : '';
    const changes = Array.isArray(tx.balanceChanges) ? tx.balanceChanges : [];
    for (const ch of changes as Array<Record<string, unknown>>) {
      const ownerField = ch.owner;
      let ownerAddr: string | null = null;
      if (typeof ownerField === 'string') ownerAddr = ownerField;
      else if (ownerField && typeof ownerField === 'object') {
        const o = ownerField as Record<string, unknown>;
        if (typeof o.AddressOwner === 'string') ownerAddr = o.AddressOwner;
        else if (typeof o.ObjectOwner === 'string') ownerAddr = o.ObjectOwner;
      }
      if (!ownerAddr || !ultronAddrs.includes(ownerAddr.toLowerCase())) continue;
      const coinType = typeof ch.coinType === 'string' ? ch.coinType : '';
      if (!coinType) continue;
      let amt: bigint;
      try {
        amt = BigInt(ch.amount as string | number | undefined ?? 0);
      } catch {
        continue;
      }
      if (amt <= 0n) continue;
      out.push({
        digest,
        fromAddress: sender,
        toAddress: ownerAddr,
        coinType,
        amountMist: amt,
        timestampMs,
      });
    }
  }
  return out;
}

// ─── Agent ──────────────────────────────────────────────────────────

/** Abstraction over the JSON-RPC client so tests can inject a fake
 *  without mocking `@mysten/sui/jsonRpc` wholesale. The real impl is a
 *  thin wrapper around SuiJsonRpcClient.queryTransactionBlocks. */
export interface QueryTransactionBlocksFn {
  (params: {
    filter: { ToAddress: string };
    options: { showBalanceChanges: boolean; showEffects: boolean; showInput: boolean };
    order: 'descending' | 'ascending';
    limit: number;
  }): Promise<unknown>;
}

export class SuiInboundWatcher extends Agent<Env, SuiInboundWatcherState> {
  initialState: SuiInboundWatcherState = {
    lastPolledCheckpoint: null,
    lastPolledAtMs: 0,
    observed: [],
    routingLog: [],
  };

  private _queryFn: QueryTransactionBlocksFn | null = null;
  private _registryStub: IntentRegistryStub | null = null;
  private _postalStub: UltronPostalStub | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runPollAlarm();
    };
    // Kick off the recurring poll on first construction if none is set.
    void this._ensureAlarm();
  }

  /** Test-only hook. Swap in a stub `queryTransactionBlocks` to avoid
   *  network traffic. */
  setQueryFn(fn: QueryTransactionBlocksFn | null): void {
    this._queryFn = fn;
  }

  /** Test-only hook — inject a fake IntentRegistry callable. */
  setRegistryStub(stub: IntentRegistryStub | null): void {
    this._registryStub = stub;
  }

  /** Test-only hook — inject a fake UltronPostal callable. */
  setPostalStub(stub: UltronPostalStub | null): void {
    this._postalStub = stub;
  }

  // ─── Callables ─────────────────────────────────────────────────────

  @callable({ description: 'SuiInboundWatcher state snapshot.' })
  async status(): Promise<{
    ultronAddress: string;
    observedCount: number;
    routingCount: number;
    lastPolledAtMs: number;
    lastPolledCheckpoint: string | null;
    recentRouting: RoutingDecision[];
    nextAlarmMs: number | null;
  }> {
    const nextAlarmMs = (await this.ctx.storage.getAlarm?.()) ?? null;
    return {
      ultronAddress: SUI_ULTRON_ADDRESS,
      observedCount: this.state.observed.length,
      routingCount: this.state.routingLog.length,
      lastPolledAtMs: this.state.lastPolledAtMs,
      lastPolledCheckpoint: this.state.lastPolledCheckpoint,
      recentRouting: this.state.routingLog.slice(-10),
      nextAlarmMs: typeof nextAlarmMs === 'number' ? nextAlarmMs : null,
    };
  }

  @callable({ description: 'Force an immediate poll cycle.' })
  async poke(): Promise<{ polled: number; newActivities: number; intents: number }> {
    return this._runPollAlarm();
  }

  @callable({ description: 'Recent routing decisions (logs only, no forwarding).' })
  async recentRouting(params?: { limit?: number }): Promise<RoutingDecision[]> {
    const n = Math.max(1, Math.min(params?.limit ?? 25, ROUTING_LOG_MAX));
    return this.state.routingLog.slice(-n);
  }

  // ─── Internals ─────────────────────────────────────────────────────

  async _runPollAlarm(): Promise<{ polled: number; newActivities: number; intents: number }> {
    let polled = 0;
    let newActivities = 0;
    let intents = 0;
    try {
      const query = await this._resolveQueryFn();
      const resp = await query({
        filter: { ToAddress: SUI_ULTRON_ADDRESS },
        options: { showBalanceChanges: true, showEffects: false, showInput: true },
        order: 'descending',
        limit: QUERY_LIMIT,
      });
      const activities = parseInboundFromRpc(resp);
      polled = activities.length;

      const seen = new Set(this.state.observed.map(o => o.digest));
      const now = Date.now();
      const newObserved: ObservedActivity[] = [];
      const newRouting: RoutingDecision[] = [];
      let highestDigest: string | null = this.state.lastPolledCheckpoint;

      for (const a of activities) {
        if (a.digest && seen.has(a.digest)) continue;
        if (a.digest) seen.add(a.digest);
        newActivities += 1;
        newObserved.push({
          digest: a.digest,
          fromAddress: a.fromAddress,
          coinType: a.coinType,
          amountMist: a.amountMist.toString(),
          timestampMs: a.timestampMs,
          observedAtMs: now,
        });
        const intent = decodeSubcentIntent(a.amountMist, a.coinType);
        if (intent.hasIntent) {
          intents += 1;
          const tagName = chainTagName(intent.chainTag);
          const entry: RoutingDecision = {
            digest: a.digest,
            coinType: a.coinType,
            fromAddress: a.fromAddress,
            amountMist: a.amountMist.toString(),
            intent: serializeIntent(intent),
            chainTagName: tagName,
            note: `route ${intent.baseAmount.toString()} (${a.coinType}) ` +
              `to registry[${intent.recipientIndex}] on chain=${tagName}`,
            observedAtMs: now,
            routedAt: null,
            status: 'unresolved',
          };

          // 1. Resolve recipient via IntentRegistry.
          let registryEntry: IntentRegistryEntry | null = null;
          try {
            const registry = this._getRegistryStub();
            if (registry) {
              registryEntry = await registry.lookup({ intentIndex: intent.recipientIndex });
            }
          } catch (err) {
            entry.lastError = err instanceof Error ? err.message : String(err);
          }

          if (!registryEntry) {
            if (!entry.lastError) {
              entry.lastError = 'registry miss';
            }
            console.log(
              `[SuiInboundWatcher] unresolved@${a.digest.slice(0, 10)}… — ${entry.lastError}`,
            );
            newRouting.push(entry);
          } else {
            entry.recipientSuiamiName = registryEntry.suiamiName;
            // 2. Dispatch to UltronPostal.
            try {
              const postal = this._getPostalStub();
              if (!postal) throw new Error('UltronPostal binding not available');
              const ticket = await postal.dispatch({
                activity: a,
                intent,
                recipientSuiamiName: registryEntry.suiamiName,
              });
              entry.dispatchTicketId = ticket.ticketId;
              entry.status = 'routed';
              entry.routedAt = Date.now();
              console.log(
                `[SuiInboundWatcher] routed@${a.digest.slice(0, 10)}… → ` +
                `${registryEntry.suiamiName} [${ticket.ticketId}]`,
              );
            } catch (err) {
              entry.lastError = err instanceof Error ? err.message : String(err);
              console.warn(
                `[SuiInboundWatcher] dispatch failed@${a.digest.slice(0, 10)}… — ${entry.lastError}`,
              );
            }
            newRouting.push(entry);
          }
        }
        if (!highestDigest) highestDigest = a.digest || null;
      }

      this.setState({
        lastPolledCheckpoint: highestDigest,
        lastPolledAtMs: now,
        observed: ringPush(this.state.observed, newObserved, OBSERVED_MAX),
        routingLog: ringPush(this.state.routingLog, newRouting, ROUTING_LOG_MAX),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SuiInboundWatcher] poll error: ${msg}`);
    }
    await this._ensureAlarm();
    return { polled, newActivities, intents };
  }

  private async _resolveQueryFn(): Promise<QueryTransactionBlocksFn> {
    if (this._queryFn) return this._queryFn;
    const { SuiJsonRpcClient } = await import('@mysten/sui/jsonRpc');
    const url = this.env.SUI_FULLNODE_URL || DEFAULT_FULLNODE_URL;
    const sui = new SuiJsonRpcClient({ url });
    const bound: QueryTransactionBlocksFn = (params) =>
      sui.queryTransactionBlocks(
        params as unknown as Parameters<typeof sui.queryTransactionBlocks>[0],
      ) as unknown as Promise<unknown>;
    this._queryFn = bound;
    return bound;
  }

  private _getRegistryStub(): IntentRegistryStub | null {
    if (this._registryStub) return this._registryStub;
    const ns = this.env.IntentRegistry;
    if (!ns) return null;
    const id = ns.idFromName('aggron:intent-registry');
    return ns.get(id) as unknown as IntentRegistryStub;
  }

  private _getPostalStub(): UltronPostalStub | null {
    if (this._postalStub) return this._postalStub;
    const ns = this.env.UltronPostal;
    if (!ns) return null;
    const id = ns.idFromName('ultron-postal');
    return ns.get(id) as unknown as UltronPostalStub;
  }

  private async _ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm?.();
    if (typeof existing === 'number' && existing > Date.now()) return;
    await this.ctx.storage.setAlarm(Date.now() + SUI_INBOUND_ALARM_MS);
  }
}
