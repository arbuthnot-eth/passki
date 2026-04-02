/**
 * Chronicom — per-wallet thunder signal watcher.
 *
 * Caches signal counts for all of a wallet's SuiNS names.
 * 5s alarm cycle re-checks on-chain via GraphQL.
 * Auto-sleeps after 2 minutes of inactivity.
 *
 * Thunder protocol fees → iUSD surplus (not 1:1 backed).
 */

import { Agent } from 'agents';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { GQL_URL } from '../rpc.js';

const STORM_ID = '0xd67490b2047490e81f7467eedb25c726e573a311f9139157d746e4559282844f';
const ALARM_INTERVAL_MS = 5_000;
const INACTIVITY_TIMEOUT_MS = 120_000;

interface ChronicomState {
  counts: Record<string, number>;
  names: string[];
  lastPollMs: number;
  alarmActive: boolean;
}

interface Env {
  [key: string]: unknown;
}

function nameHashHex(bare: string): string {
  const full = bare.toLowerCase() + '.sui';
  const hash = keccak_256(new TextEncoder().encode(full));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Chronicom extends Agent<Env, ChronicomState> {
  initialState: ChronicomState = {
    counts: {},
    names: [],
    lastPollMs: 0,
    alarmActive: false,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._refresh();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/poll') || url.searchParams.has('poll')) {
      const namesParam = url.searchParams.get('names') || '';
      const names = namesParam.split(',').map(n => n.toLowerCase().replace(/\.sui$/, '').trim()).filter(Boolean);

      if (names.length > 0) {
        this.setState({ ...this.state, names, lastPollMs: Date.now() });
      } else {
        this.setState({ ...this.state, lastPollMs: Date.now() });
      }

      // Start alarm if not running
      if (!this.state.alarmActive && this.state.names.length > 0) {
        this.setState({ ...this.state, alarmActive: true });
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }

      return Response.json(this.state.counts);
    }

    return Response.json(this.state.counts);
  }

  private async _refresh(): Promise<void> {
    const { names, lastPollMs } = this.state;

    if (Date.now() - lastPollMs > INACTIVITY_TIMEOUT_MS || names.length === 0) {
      this.setState({ ...this.state, alarmActive: false });
      return;
    }

    const counts = await this._fetchCounts(names);
    this.setState({ ...this.state, counts, alarmActive: true });
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async _fetchCounts(names: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const n of names) result[n] = 0;

    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ object(address: "${STORM_ID}") { dynamicFields { nodes { name { json } value { ... on MoveValue { json } } } } } }`,
        }),
      });
      const gql = await res.json() as any;
      const nodes = gql?.data?.object?.dynamicFields?.nodes ?? [];

      const hexToBare: Record<string, string> = {};
      for (const bare of names) {
        hexToBare[nameHashHex(bare)] = bare;
      }

      for (const n of nodes) {
        const val = n?.value?.json;
        if (!val?.signals) continue;
        const keyB64 = typeof n.name?.json === 'string' ? n.name.json : '';
        try {
          const raw = atob(keyB64);
          const hex = Array.from(raw).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
          if (hexToBare[hex]) {
            result[hexToBare[hex]] = val.signals.length;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* return zeros on error */ }

    return result;
  }
}
