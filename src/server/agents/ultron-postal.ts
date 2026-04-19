/**
 * Ultron Postal Service — UltronEnvelope dispatcher DO (Apollo arc, Move 1).
 *
 * Receives decoded Sui-inbound intents from the SuiInboundWatcher, infers the
 * envelope `kind`, routes to the right handler, and tracks completion. This
 * scaffold ships the dispatch machinery + observability + retry — every
 * forward path is intentionally STUBBED with `TODO(icy-wind-pt2)` markers.
 *
 *   Dispatch → per-kind handler → stub returns { digest: null, stub: true }
 *
 * The live signing wiring drops in during Icy Wind pt2: handlers build the
 * PTB / cross-chain tx today (no state change on-chain), then hand bytes to
 * UltronSigningAgent.signForStealth. Until then, completedDispatches carries
 * `stub: true` so observability shows the queue is draining without minting
 * fake successes downstream.
 *
 * Shape + alarm cadence track AggronBatcher. One singleton DO (name:
 * "ultron-postal"). Sharding by kind comes later if a single alarm tick
 * can't keep up with inbound volume.
 *
 * Greek/roman gods only — no external gods in this file.
 *
 * Related:
 *   - memory/project_ultron_envelope.md                 — design direction
 *   - src/client/ultron-envelope.ts                     — envelope types
 *   - src/server/sui-inbound.ts                         — DecodedIntent
 *   - src/server/agents/ultron-signing-agent.ts         — signForStealth (hermes)
 *   - src/server/agents/aggron-batcher.ts               — alarm pattern reference
 */

import { Agent, callable } from 'agents';
import type { UltronEnv } from '../ultron-key.js';
import type { SuiInboundActivity, DecodedIntent } from '../sui-inbound.js';
import type { EnvelopeKind } from '../../client/ultron-envelope.js';
import { chainTagName } from '../sui-inbound.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Alarm cadence — 60s default drain tick. */
export const POSTAL_ALARM_MS = 60 * 1000;

/** Max tickets drained per alarm tick. */
export const POSTAL_DRAIN_PER_TICK = 10;

/** Retry ceiling — tickets past this stay in pendingDispatches with
 *  attempts === MAX + lastError, i.e. dead-lettered. Re-enqueue by a
 *  new dispatch call supersedes. */
export const POSTAL_MAX_ATTEMPTS = 3;

/** Rolling cap on completedDispatches history. */
export const POSTAL_HISTORY_MAX = 50;

// ─── Types ──────────────────────────────────────────────────────────

export interface DispatchTicket {
  /** 32-byte 0x-prefixed hex. Unique per ticket. */
  ticketId: string;
  kind: EnvelopeKind;
  activity: SuiInboundActivity;
  intent: DecodedIntent;
  recipientSuiamiName: string;
  /** Set once a handler resolves chainAt(recipient). */
  resolvedDestAddr?: string;
  queuedAtMs: number;
  attempts: number;
  lastError?: string;
  flushedAtMs?: number;
}

export interface CompletedDispatch {
  ticketId: string;
  kind: EnvelopeKind;
  recipientSuiamiName: string;
  chain: string;
  amountMist: string;
  /** null while stubbed; real tx digest after Icy Wind pt2. */
  digest: string | null;
  /** true while signing is stubbed. Flip to false/undefined when live. */
  stub?: boolean;
  flushedAtMs: number;
}

export interface UltronPostalState {
  pendingDispatches: DispatchTicket[];
  completedDispatches: CompletedDispatch[];
  lastDispatchedAtMs: number;
}

/** Transient errors retry; permanent errors go straight to dead-letter. */
export class TransientDispatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientDispatchError';
  }
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

export function generateTicketId(random?: () => Uint8Array): string {
  const bytes = random ? random() : crypto.getRandomValues(new Uint8Array(32));
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Infer the envelope kind from an inbound activity + its decoded intent.
 * v1: every sub-cent inbound with a non-zero intent tag is a plain
 * `transfer`. Future moves fetch the Aggron-stored envelope blob from
 * Walrus and use its declared `kind`.
 */
export function inferEnvelopeKind(
  _activity: SuiInboundActivity,
  intent: DecodedIntent,
): EnvelopeKind | null {
  if (!intent.hasIntent) return null;
  return 'transfer';
}

// ─── Handlers (all stubbed for v1) ──────────────────────────────────
//
// Each handler receives the ticket + env and returns a Partial<CompletedDispatch>.
// Today they all return `{ digest: null, stub: true }`. The TODO markers
// below flag the exact lines where Icy Wind pt2 plugs signing in.

export async function handleTransfer(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // 1. Resolve the recipient's chain address via SUIAMI roster:
  //    chainAt(`${chainTagName(intent.chainTag)}@${ticket.recipientSuiamiName}`)
  //    — personal-mode roster → stealth addr; service-mode → stable.
  // 2. Build a Sui PTB that splits activity.amountMist of activity.coinType
  //    from ultron's coins and transfers to the resolved address.
  // 3. TODO(icy-wind-pt2): sign via UltronSigningAgent.signForStealth
  //    (ed25519 curve, ultron dwallet), submit, return real digest.
  return { digest: null, stub: true };
}

export async function handlePrism(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): build Quasar cross-chain route, sign via IKA
  // per source chain (secp256k1 for ETH/BTC, ed25519 for SOL), submit.
  return { digest: null, stub: true };
}

export async function handleDwalletTransfer(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): build DWalletCap transfer PTB (recipient = resolved
  // chainAt for sui@), sign via signForStealth ed25519, submit.
  return { digest: null, stub: true };
}

export async function handleStealthSweep(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): derive next stealth destination, build sweep PTB
  // (multi-coin aggregation), sign ed25519, submit. Sneasel arc consumer.
  return { digest: null, stub: true };
}

export async function handleGuestBind(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): bind a fresh guest IKA dWallet to the recipient's
  // roster entry (Seal-encrypt cold dest, enqueue to Aggron, sign bind PTB).
  return { digest: null, stub: true };
}

/** Pick the right handler for a ticket kind. */
export function handlerFor(
  kind: EnvelopeKind,
): (t: DispatchTicket, env: UltronEnv) => Promise<Partial<CompletedDispatch>> {
  switch (kind) {
    case 'transfer':
      return handleTransfer;
    case 'prism':
      return handlePrism;
    case 'dwallet-transfer':
      return handleDwalletTransfer;
    case 'stealth-sweep':
      return handleStealthSweep;
    case 'guest-bind':
      return handleGuestBind;
  }
}

// ─── Agent ──────────────────────────────────────────────────────────

export class UltronPostal extends Agent<UltronEnv, UltronPostalState> {
  initialState: UltronPostalState = {
    pendingDispatches: [],
    completedDispatches: [],
    lastDispatchedAtMs: 0,
  };

  constructor(ctx: DurableObjectState, env: UltronEnv) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runDispatchAlarm();
    };
  }

  /** Queue a decoded intent for dispatch. SuiInboundWatcher calls this
   *  once it's decoded + looked up the recipient SUIAMI name. */
  @callable({
    description:
      'Queue an UltronEnvelope dispatch. Caller supplies the inbound ' +
      'activity, decoded intent, and resolved recipient SUIAMI name. ' +
      'UltronPostal infers the envelope kind and routes to the handler.',
  })
  async dispatch(params: {
    activity: SuiInboundActivity;
    intent: DecodedIntent;
    recipientSuiamiName: string;
  }): Promise<{
    ticketId: string;
    kind: EnvelopeKind | null;
    action: 'queued' | 'skipped';
    reason?: string;
  }> {
    const { activity, intent, recipientSuiamiName } = params;
    if (!activity || !intent) {
      throw new Error('ultronPostal.dispatch: activity + intent required');
    }
    if (!recipientSuiamiName) {
      return {
        ticketId: '',
        kind: null,
        action: 'skipped',
        reason: 'no-recipient',
      };
    }
    const kind = inferEnvelopeKind(activity, intent);
    if (!kind) {
      return {
        ticketId: '',
        kind: null,
        action: 'skipped',
        reason: 'no-intent-tag',
      };
    }
    const ticket: DispatchTicket = {
      ticketId: generateTicketId(),
      kind,
      activity,
      intent,
      recipientSuiamiName,
      queuedAtMs: Date.now(),
      attempts: 0,
    };
    const next = [...this.state.pendingDispatches, ticket];
    this.setState({ ...this.state, pendingDispatches: next });
    await this._scheduleAlarm();
    return { ticketId: ticket.ticketId, kind, action: 'queued' };
  }

  /** State snapshot — queue depth + recent completions. */
  @callable({ description: 'UltronPostal state snapshot.' })
  async status(): Promise<{
    pendingCount: number;
    recentCompletions: CompletedDispatch[];
    nextAlarmMs: number | null;
  }> {
    const pending = this.state.pendingDispatches.filter(
      t => t.attempts < POSTAL_MAX_ATTEMPTS || t.flushedAtMs == null,
    );
    const nextAlarm = (await this.ctx.storage.getAlarm?.()) ?? null;
    return {
      pendingCount: pending.length,
      recentCompletions: this.state.completedDispatches.slice(-10),
      nextAlarmMs: typeof nextAlarm === 'number' ? nextAlarm : null,
    };
  }

  /** Force an immediate drain — admin/debug. */
  @callable({ description: 'Run the dispatch alarm immediately.' })
  async poke(): Promise<{ triggered: boolean }> {
    await this._runDispatchAlarm();
    return { triggered: true };
  }

  // ─── Internal ────────────────────────────────────────────────────

  async _runDispatchAlarm(): Promise<void> {
    const ready = this.state.pendingDispatches
      .filter(t => !t.flushedAtMs && t.attempts < POSTAL_MAX_ATTEMPTS)
      .slice(0, POSTAL_DRAIN_PER_TICK);

    if (ready.length === 0) {
      await this._scheduleAlarm();
      return;
    }

    let working = this.state.pendingDispatches.slice();
    const completions: CompletedDispatch[] = [];

    for (const ticket of ready) {
      const handler = handlerFor(ticket.kind);
      try {
        const res = await handler(ticket, this.env);
        const completion: CompletedDispatch = {
          ticketId: ticket.ticketId,
          kind: ticket.kind,
          recipientSuiamiName: ticket.recipientSuiamiName,
          chain: chainTagName(ticket.intent.chainTag),
          amountMist: ticket.activity.amountMist.toString(),
          digest: res.digest ?? null,
          ...(res.stub != null ? { stub: res.stub } : {}),
          flushedAtMs: Date.now(),
        };
        completions.push(completion);
        working = working.map(t =>
          t.ticketId === ticket.ticketId
            ? { ...t, attempts: t.attempts + 1, flushedAtMs: completion.flushedAtMs }
            : t,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = err instanceof TransientDispatchError;
        working = working.map(t => {
          if (t.ticketId !== ticket.ticketId) return t;
          const attempts = t.attempts + 1;
          // Permanent errors also bump to MAX so they dead-letter immediately.
          const finalAttempts = isTransient ? attempts : POSTAL_MAX_ATTEMPTS;
          return { ...t, attempts: finalAttempts, lastError: msg };
        });
      }
    }

    // Drop tickets that completed successfully (have flushedAtMs) from
    // pending — completions are the source of truth for them. Tickets at
    // the retry cap without a flushedAtMs stay in pending as dead-letter.
    const prunedPending = working.filter(t => !t.flushedAtMs);
    const history = [...this.state.completedDispatches, ...completions].slice(
      -POSTAL_HISTORY_MAX,
    );

    this.setState({
      ...this.state,
      pendingDispatches: prunedPending,
      completedDispatches: history,
      lastDispatchedAtMs: Date.now(),
    });

    await this._scheduleAlarm();
  }

  private async _scheduleAlarm(overrideMs?: number): Promise<void> {
    const at = Date.now() + (overrideMs ?? POSTAL_ALARM_MS);
    await this.ctx.storage.setAlarm(at);
  }
}
