// Strict daily budgets for gas sponsorship.
//
// Cloudflare's rate-limit binding is approximate (counts sync between
// machines lazily), so it slows abuse but can't bound spend. This Durable
// Object can: one instance per sender address plus one "global" instance,
// each processing requests one at a time, so concurrent reservations can't
// race past the cap.
//
// We reserve the transaction's full gas *budget* before signing. The actual
// gas used is never more than that, so the cap is a hard upper bound on
// what ultron can spend per address per UTC day, and in total per day.

import { DurableObject } from 'cloudflare:workers';

export interface QuotaState { day: string; spentMist: bigint }
export type Reservation = { ok: true; spentMist: bigint } | { ok: false; spentMist: bigint };

/** Pure budgeting rule: resets at UTC midnight, refuses anything over cap. */
export function reserve(state: QuotaState | null, today: string, amountMist: bigint, capMist: bigint): { next: QuotaState; result: Reservation } {
  const spent = state && state.day === today ? state.spentMist : 0n;
  if (amountMist < 0n) throw new Error('negative reservation');
  if (spent + amountMist > capMist) return { next: { day: today, spentMist: spent }, result: { ok: false, spentMist: spent } };
  const next = { day: today, spentMist: spent + amountMist };
  return { next, result: { ok: true, spentMist: next.spentMist } };
}

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class SponsorQuota extends DurableObject {
  private async load(): Promise<QuotaState | null> {
    const raw = await this.ctx.storage.get<{ day: string; spentMist: string }>('q');
    return raw ? { day: raw.day, spentMist: BigInt(raw.spentMist) } : null;
  }

  /** Atomically reserve `amountMist` against today's cap. Amounts are decimal strings (bigint-safe over RPC). */
  async reserve(amountMist: string, capMist: string): Promise<{ ok: boolean; spentMist: string }> {
    const { next, result } = reserve(await this.load(), utcDay(), BigInt(amountMist), BigInt(capMist));
    if (result.ok) await this.ctx.storage.put('q', { day: next.day, spentMist: next.spentMist.toString() });
    return { ok: result.ok, spentMist: result.spentMist.toString() };
  }

  /** Give back a reservation that didn't lead to a signature. */
  async refund(amountMist: string): Promise<void> {
    const s = await this.load();
    if (!s || s.day !== utcDay()) return;
    const left = s.spentMist - BigInt(amountMist);
    await this.ctx.storage.put('q', { day: s.day, spentMist: (left < 0n ? 0n : left).toString() });
  }

  async spentToday(): Promise<string> {
    const s = await this.load();
    return s && s.day === utcDay() ? s.spentMist.toString() : '0';
  }
}

// ── Caller helper (used by /api/sponsor-gas and SponsorAgent) ────────────

const DEFAULT_PER_SENDER_MIST = 1_000_000_000n; // 1 SUI / address / day
const DEFAULT_TOTAL_MIST = 10_000_000_000n;     // 10 SUI / day across everyone

type QuotaEnv = {
  SPONSOR_QUOTA?: DurableObjectNamespace<SponsorQuota>;
  SPONSOR_DAILY_CAP_PER_SENDER_MIST?: string;
  SPONSOR_DAILY_CAP_TOTAL_MIST?: string;
};

const capFrom = (v: string | undefined, d: bigint) => { try { return v ? BigInt(v) : d; } catch { return d; } };

/**
 * Reserve `budgetMist` against both the sender's and the global daily cap.
 * Fails closed: if the quota store is unavailable, nothing gets sponsored.
 */
export async function reserveSponsorBudget(env: QuotaEnv, sender: string, budgetMist: bigint): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ns = env.SPONSOR_QUOTA;
  if (!ns) return { ok: false, reason: 'Sponsor quota unavailable' };
  const perSender = capFrom(env.SPONSOR_DAILY_CAP_PER_SENDER_MIST, DEFAULT_PER_SENDER_MIST);
  const total = capFrom(env.SPONSOR_DAILY_CAP_TOTAL_MIST, DEFAULT_TOTAL_MIST);
  const amount = budgetMist.toString();
  try {
    const mine = ns.get(ns.idFromName(`sender:${sender.toLowerCase()}`));
    if (!(await mine.reserve(amount, perSender.toString())).ok) {
      return { ok: false, reason: 'Daily sponsored-gas limit reached for this address' };
    }
    const all = ns.get(ns.idFromName('global'));
    if (!(await all.reserve(amount, total.toString())).ok) {
      await mine.refund(amount);
      return { ok: false, reason: 'Daily sponsored-gas limit reached — try again tomorrow' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[sponsor-quota] error:', err);
    return { ok: false, reason: 'Sponsor quota unavailable' };
  }
}

export async function sponsorSpentToday(env: QuotaEnv): Promise<{ spentMist: bigint; capMist: bigint } | null> {
  const ns = env.SPONSOR_QUOTA;
  if (!ns) return null;
  const spent = await ns.get(ns.idFromName('global')).spentToday();
  return { spentMist: BigInt(spent), capMist: capFrom(env.SPONSOR_DAILY_CAP_TOTAL_MIST, DEFAULT_TOTAL_MIST) };
}

// ── General daily budgets (faucets, IKA funding, DKG) ───────────────────
//
// Same Durable Object, different instance names. Each limit is a named
// counter with a daily cap; a reservation succeeds only if it fits under
// *every* limit, and partial reservations are rolled back. Units are
// whatever the caller counts (MIST, IKA base units, or 1 per call).

export interface BudgetLimit { key: string; cap: bigint }

export async function reserveDailyBudgets(
  env: QuotaEnv,
  limits: BudgetLimit[],
  amount: bigint,
): Promise<{ ok: true } | { ok: false; key: string }> {
  const ns = env.SPONSOR_QUOTA;
  if (!ns) return { ok: false, key: 'unavailable' };
  const done: Array<{ reserve(a: string, c: string): Promise<{ ok: boolean }>; refund(a: string): Promise<void> }> = [];
  const a = amount.toString();
  try {
    for (const l of limits) {
      const stub = ns.get(ns.idFromName(`budget:${l.key}`));
      if (!(await stub.reserve(a, l.cap.toString())).ok) {
        await Promise.all(done.map((d) => d.refund(a)));
        return { ok: false, key: l.key };
      }
      done.push(stub);
    }
    return { ok: true };
  } catch (err) {
    console.error('[budget] error:', err);
    await Promise.allSettled(done.map((d) => d.refund(a)));
    return { ok: false, key: 'unavailable' };
  }
}
