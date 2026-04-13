/**
 * Chronicom — per-wallet Thunder Timestream signal watcher.
 *
 * Caches unread message counts per SuiNS name.
 * Counts are updated by the Timestream transport (push model)
 * instead of polling on-chain Storm dynamic fields.
 *
 * Auto-sleeps after 2 minutes of inactivity.
 */

import { Agent } from 'agents';

const ALARM_INTERVAL_MS = 5_000;
const INACTIVITY_TIMEOUT_MS = 120_000;

interface SableyeXchainEntry {
  fromAddress: string;
  chain: 'sol' | 'eth' | 'btc';
  ts: number;
  txHash?: string;
}

interface SableyeSlice {
  cipher?: string;
  updatedAt?: number;
  xchainLog?: SableyeXchainEntry[];
}

const SABLEYE_XCHAIN_LOG_CAP = 200;

interface ChronicomState {
  counts: Record<string, number>;
  names: string[];
  lastPollMs: number;
  alarmActive: boolean;
  sableye?: SableyeSlice;
}

interface Env {
  [key: string]: unknown;
}

export class Chronicom extends Agent<Env, ChronicomState> {
  initialState: ChronicomState = {
    counts: {},
    names: [],
    lastPollMs: 0,
    alarmActive: false,
    sableye: { cipher: undefined, updatedAt: undefined, xchainLog: [] },
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._tick();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /increment — Timestream transport pushes new message notifications
    if (request.method === 'POST' && (url.pathname.endsWith('/increment') || url.searchParams.has('increment'))) {
      const body = await request.json() as { name?: string; count?: number };
      if (body.name) {
        const bare = body.name.toLowerCase().replace(/\.sui$/, '');
        const counts = { ...this.state.counts };
        counts[bare] = (counts[bare] ?? 0) + (body.count ?? 1);
        this.setState({ ...this.state, counts });
      }
      return Response.json({ ok: true });
    }

    // POST /clear — mark messages as read for a name
    if (request.method === 'POST' && (url.pathname.endsWith('/clear') || url.searchParams.has('clear'))) {
      const body = await request.json() as { name?: string };
      if (body.name) {
        const bare = body.name.toLowerCase().replace(/\.sui$/, '');
        const counts = { ...this.state.counts };
        counts[bare] = 0;
        this.setState({ ...this.state, counts });
      }
      return Response.json({ ok: true });
    }

    // GET /poll — register watched names, return current counts
    if (url.pathname.endsWith('/poll') || url.searchParams.has('poll')) {
      const namesParam = url.searchParams.get('names') || '';
      const names = namesParam.split(',').map(n => n.toLowerCase().replace(/\.sui$/, '').trim()).filter(Boolean);

      if (names.length > 0) {
        this.setState({ ...this.state, names, lastPollMs: Date.now() });
      } else {
        this.setState({ ...this.state, lastPollMs: Date.now() });
      }

      if (!this.state.alarmActive && this.state.names.length > 0) {
        this.setState({ ...this.state, alarmActive: true });
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }

      return Response.json(this.state.counts);
    }

    // ── Sableye Lv.10 — Leer ─────────────────────────────────────────────
    // Seal-encrypted counterparty set. The DO never sees plaintext; it
    // persists the ciphertext blob as-is and exposes an xchainLog that is
    // appended to by webhook handlers (Astonish) when cross-chain credits
    // from known counterparties land.
    if (url.pathname.endsWith('/sableye') || url.searchParams.has('sableye')) {
      if (request.method === 'GET') {
        const s = this.state.sableye ?? {};
        return Response.json({
          cipher: s.cipher ?? null,
          updatedAt: s.updatedAt ?? 0,
          xchainLog: s.xchainLog ?? [],
        });
      }
      if (request.method === 'POST') {
        let body: { cipher?: unknown };
        try { body = await request.json() as { cipher?: unknown }; }
        catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
        if (typeof body.cipher !== 'string' || body.cipher.length === 0) {
          return Response.json({ error: 'cipher must be a non-empty string' }, { status: 400 });
        }
        const prev = this.state.sableye ?? {};
        const next: SableyeSlice = {
          cipher: body.cipher,
          updatedAt: Date.now(),
          xchainLog: prev.xchainLog ?? [],
        };
        this.setState({ ...this.state, sableye: next });
        return Response.json({ ok: true, updatedAt: next.updatedAt });
      }
    }

    // ── Sableye Lv.40 — Astonish ─────────────────────────────────────────
    // Internal append route for webhook handlers. Takes a single entry
    // `{ fromAddress, chain, ts?, txHash? }` and pushes it to xchainLog,
    // capped at SABLEYE_XCHAIN_LOG_CAP (oldest dropped).
    if (request.method === 'POST' && (url.pathname.endsWith('/sableye-xchain-append') || url.searchParams.has('sableye-xchain-append'))) {
      let body: Partial<SableyeXchainEntry>;
      try { body = await request.json() as Partial<SableyeXchainEntry>; }
      catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
      const fromAddress = typeof body.fromAddress === 'string' ? body.fromAddress : '';
      const chain = body.chain;
      if (!fromAddress || (chain !== 'sol' && chain !== 'eth' && chain !== 'btc')) {
        return Response.json({ error: 'fromAddress + chain required' }, { status: 400 });
      }
      const entry: SableyeXchainEntry = {
        fromAddress,
        chain,
        ts: typeof body.ts === 'number' ? body.ts : Date.now(),
        ...(typeof body.txHash === 'string' ? { txHash: body.txHash } : {}),
      };
      const prev = this.state.sableye ?? {};
      const log = [...(prev.xchainLog ?? []), entry];
      while (log.length > SABLEYE_XCHAIN_LOG_CAP) log.shift();
      this.setState({ ...this.state, sableye: { ...prev, xchainLog: log } });
      return Response.json({ ok: true, size: log.length });
    }

    return Response.json(this.state.counts);
  }

  private async _tick(): Promise<void> {
    const { lastPollMs, names } = this.state;

    if (Date.now() - lastPollMs > INACTIVITY_TIMEOUT_MS || names.length === 0) {
      this.setState({ ...this.state, alarmActive: false });
      return;
    }

    // Keep alarm alive for clients polling
    this.setState({ ...this.state, alarmActive: true });
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
