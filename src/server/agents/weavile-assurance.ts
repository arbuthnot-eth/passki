/**
 * Weavile Assurance — paymaster-sponsored stealth sweep DO (Move 3 scaffold).
 *
 * WeavileAssuranceAgent is a Durable Object that accepts sweep enqueues from
 * WeavileScannerAgent on stealth-announcement match, issues a single-use
 * session ticket per sweep (§2.2/§2.3 of the design doc), and — in the live
 * path (Move 7) — assembles the chain-appropriate paymaster-sponsored
 * transaction, signs via UltronSigningAgent IKA 2PC-MPC, and submits.
 *
 * This is the Move 3 SCAFFOLD:
 *   - state shape: `pendingTickets`, `completedSweeps`
 *   - callables: `enqueueSweep`, `status`, `poke`
 *   - alarm stub: drains expired tickets, logs, reschedules
 *   - NO live sweep execution (EVM/SOL/Sui/BTC dispatch wires in Move 7)
 *
 * One DO instance per recipient (same sharding key as WeavileScannerAgent:
 * `hash(recipientSuiAddr)`). Move 5 wires the handoff from scanner → this DO.
 *
 * Related files:
 *   - src/server/agents/weavile-scanner.ts            — announcement match source
 *   - src/server/agents/weavile-assurance-evm.ts      — pure EVM UserOp helpers (Move 2)
 *   - src/server/agents/ultron-signing-agent.ts       — IKA 2PC-MPC signing (Move 1)
 *   - src/server/agents/sneasel-watcher.ts            — DO pattern reference
 *   - docs/superpowers/plans/2026-04-18-weavile-assurance.md — full design
 */

import { Agent, callable } from 'agents';
import type { UserOperation } from './weavile-assurance-evm.js';

// Keep the import alive for the Move 7 type graph without a runtime dep.
export type { UserOperation };

// ─── Constants ──────────────────────────────────────────────────────

/** Ticket validity window — §2.3 default. After expiry, next alarm
 *  drops the ticket; scanner re-enqueues (which issues a fresh id). */
export const TICKET_VALIDITY_MS = 15 * 60 * 1000;

/** Alarm cadence — drain expired tickets + (Move 7) fire ready sweeps. */
export const ASSURANCE_ALARM_MS = 60 * 1000;

/** Rolling cap on completedSweeps history. */
export const COMPLETED_HISTORY_MAX = 100;

/** N-policy rotation pool size — §2.2 paymaster-operator clustering
 *  mitigation. Pick `ticketId[0] % N` at submission time. */
export const POLICY_POOL_SIZE = 5;

// ─── Types ──────────────────────────────────────────────────────────

export type AssuranceChain = 'eth' | 'sol' | 'sui' | 'btc';

export interface AssurancePendingTicket {
  /** 32-byte random hex, 0x-prefixed. Single-use. */
  ticketId: string;
  /** Stealth address in chain-native format (hex EVM, base58 SOL, …). */
  stealthAddr: string;
  chain: AssuranceChain;
  /** EVM only — chainId at submit time. */
  chainId?: number;
  /** Brando's SUIAMI identity — routing anchor for Seal decrypt. */
  recipientSuiAddr: string;
  /** Opaque identifier the scanner passed through; resolved to the
   *  cold destination via Seal decrypt in Move 7. */
  coldDestSealRef: string;
  /** IKA dWallet holding the spend key for `stealthAddr`. */
  dwalletId: string;
  issuedAtMs: number;
  /** issuedAtMs + TICKET_VALIDITY_MS. */
  expiresAtMs: number;
  used: boolean;
  attempts: number;
}

export interface AssuranceCompletedSweep {
  ticketId: string;
  /** Compact form: first 10 + last 8 chars of stealthAddr. */
  stealthAddrShort: string;
  chain: string;
  /** userOpHash (EVM) / tx signature (SOL/Sui/BTC). */
  digest: string;
  executedAtMs: number;
}

export interface WeavileAssuranceState {
  pendingTickets: AssurancePendingTicket[];
  completedSweeps: AssuranceCompletedSweep[];
}

interface Env {
  SUI_NETWORK?: string;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Crypto-random 32-byte ticketId, 0x-prefixed hex. */
export function generateTicketId(random?: () => Uint8Array): string {
  const bytes = random
    ? random()
    : crypto.getRandomValues(new Uint8Array(32));
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** §2.2 — policy index derived from first byte of ticketId. Deterministic
 *  on input. Spreads uniformly over [0, POLICY_POOL_SIZE) for random ids. */
export function pickPolicyIndex(ticketId: string): number {
  // ticketId is `0x` + 64 hex chars. First byte = chars 2..4.
  const h = ticketId.startsWith('0x') ? ticketId.slice(2) : ticketId;
  const firstByte = parseInt(h.slice(0, 2), 16);
  if (!Number.isFinite(firstByte)) return 0;
  return firstByte % POLICY_POOL_SIZE;
}

function shortenStealthAddr(addr: string): string {
  if (!addr || addr.length < 20) return addr ?? '';
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

// ─── Agent ──────────────────────────────────────────────────────────

export class WeavileAssuranceAgent extends Agent<Env, WeavileAssuranceState> {
  initialState: WeavileAssuranceState = {
    pendingTickets: [],
    completedSweeps: [],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runAssuranceAlarm();
    };
  }

  // ─── Callables ─────────────────────────────────────────────────────

  /** Enqueue a stealth sweep for gas-sponsored execution.
   *  Called by WeavileScannerAgent on match (Move 5 wires the DO binding). */
  @callable({
    description:
      'Enqueue a stealth sweep for gas-sponsored execution. Called by WeavileScannerAgent on match.',
  })
  async enqueueSweep(params: {
    stealthAddr: string;
    chain: AssuranceChain;
    chainId?: number;
    recipientSuiAddr: string;
    coldDestSealRef: string;
    dwalletId: string;
  }): Promise<{ ticketId: string; expiresAtMs: number }> {
    const ticket = this._issueTicket(params);
    this.setState({
      ...this.state,
      pendingTickets: [...this.state.pendingTickets, ticket],
    });
    this._scheduleAssuranceAlarm();
    return { ticketId: ticket.ticketId, expiresAtMs: ticket.expiresAtMs };
  }

  /** Current Assurance DO state — pending ticket count, recent completions. */
  @callable({
    description:
      'Current Assurance DO state — pending ticket count, recent completions.',
  })
  async status(): Promise<{
    pendingCount: number;
    pendingByChain: Record<string, number>;
    recentCompletions: AssuranceCompletedSweep[];
    nextAlarmMs: number | null;
  }> {
    const pendingByChain: Record<string, number> = {};
    for (const t of this.state.pendingTickets) {
      pendingByChain[t.chain] = (pendingByChain[t.chain] ?? 0) + 1;
    }
    const recent = this.state.completedSweeps.slice(-10);
    const nextAlarmMs = (await this.ctx.storage.getAlarm?.()) ?? null;
    return {
      pendingCount: this.state.pendingTickets.length,
      pendingByChain,
      recentCompletions: recent,
      nextAlarmMs: typeof nextAlarmMs === 'number' ? nextAlarmMs : null,
    };
  }

  /** Force a tick now — test/debug helper. */
  @callable({ description: 'Force a tick now — test/debug helper.' })
  async poke(): Promise<{ triggered: boolean }> {
    await this._runAssuranceAlarm();
    return { triggered: true };
  }

  // ─── Internals (exported surface for tests) ───────────────────────

  /** Create a fresh AssurancePendingTicket. Does not persist — caller
   *  is responsible for appending to state. */
  _issueTicket(params: {
    stealthAddr: string;
    chain: AssuranceChain;
    chainId?: number;
    recipientSuiAddr: string;
    coldDestSealRef: string;
    dwalletId: string;
  }): AssurancePendingTicket {
    const now = Date.now();
    return {
      ticketId: generateTicketId(),
      stealthAddr: params.stealthAddr,
      chain: params.chain,
      chainId: params.chainId,
      recipientSuiAddr: params.recipientSuiAddr,
      coldDestSealRef: params.coldDestSealRef,
      dwalletId: params.dwalletId,
      issuedAtMs: now,
      expiresAtMs: now + TICKET_VALIDITY_MS,
      used: false,
      attempts: 0,
    };
  }

  /** Single-use consume. Returns the ticket on success (marking used=true
   *  in state), else null for unknown / already-used / expired ids. */
  _consumeTicket(ticketId: string): AssurancePendingTicket | null {
    const now = Date.now();
    const idx = this.state.pendingTickets.findIndex(t => t.ticketId === ticketId);
    if (idx < 0) return null;
    const t = this.state.pendingTickets[idx];
    if (t.used) return null;
    if (t.expiresAtMs <= now) return null;
    const updated: AssurancePendingTicket = { ...t, used: true };
    const next = this.state.pendingTickets.slice();
    next[idx] = updated;
    this.setState({ ...this.state, pendingTickets: next });
    return updated;
  }

  /** §2.2 — stable index over [0, POLICY_POOL_SIZE). */
  _pickPolicyIndex(ticketId: string): number {
    return pickPolicyIndex(ticketId);
  }

  /** Alarm stub. Drains expired tickets, logs counts, reschedules.
   *
   *  TODO(Weavile Assurance Move 7) — live sweep dispatch:
   *    for each unused, unexpired ticket:
   *      1. Seal decrypt `coldDestSealRef` to plaintext cold dest
   *      2. switch (ticket.chain):
   *         'eth' → weavile-assurance-evm.buildUserOp + IKA signForStealth
   *                 + N-policy Pimlico submit
   *         'sol' → weavile-assurance-sol.buildSolSweepTx + Kora co-sign
   *         'sui' → SponsorAgent PTB + IKA ed25519 sign
   *         'btc' → weavile-assurance-btc CPFP path
   *      3. mark ticket used via _consumeTicket(ticketId)
   *      4. append to completedSweeps (trim at COMPLETED_HISTORY_MAX)
   *      5. increment attempts on error; re-issue ticket if expired mid-run
   */
  async _runAssuranceAlarm(): Promise<void> {
    try {
      const now = Date.now();
      const before = this.state.pendingTickets.length;
      const kept = this.state.pendingTickets.filter(t => t.expiresAtMs > now && !t.used);
      const expiredOrUsed = before - kept.length;
      if (expiredOrUsed > 0) {
        this.setState({ ...this.state, pendingTickets: kept });
      }
      const unexpired = kept.length;
      console.log(
        `[WeavileAssurance:${this.name}] alarm — drained ${expiredOrUsed} expired/used, ${unexpired} pending (sweep dispatch blocked on Move 7)`,
      );
    } catch (err) {
      console.error(`[WeavileAssurance:${this.name}] alarm error:`, err);
    } finally {
      this._scheduleAssuranceAlarm();
    }
  }

  // ─── Private ───────────────────────────────────────────────────────

  private _trimCompleted() {
    if (this.state.completedSweeps.length <= COMPLETED_HISTORY_MAX) return;
    const trimmed = this.state.completedSweeps.slice(-COMPLETED_HISTORY_MAX);
    this.setState({ ...this.state, completedSweeps: trimmed });
  }

  private _scheduleAssuranceAlarm() {
    this._trimCompleted();
    // Only schedule if there's live work (pending unexpired tickets) OR
    // nothing scheduled yet. We don't loop when idle.
    const now = Date.now();
    const hasUnexpired = this.state.pendingTickets.some(
      t => !t.used && t.expiresAtMs > now,
    );
    if (!hasUnexpired && this.state.pendingTickets.length === 0) {
      // Nothing to do — let the alarm lie dormant until next enqueueSweep.
      return;
    }
    this.ctx.storage.setAlarm(now + ASSURANCE_ALARM_MS);
  }

  // ─── Debug surface (pure, exported for tests) ─────────────────────

  static shortenStealthAddr(addr: string): string {
    return shortenStealthAddr(addr);
  }
}
