/**
 * Weavile Assurance — DO scaffold unit tests (Move 3).
 *
 * Mocks the `agents` module the same way sneasel-watcher.test.ts does:
 * a minimal Agent stub that exposes state/setState/ctx.storage so we can
 * exercise the ticket lifecycle + callable surface without spinning a
 * real Durable Object runtime.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state: S;
      name = 'test';
      ctx: {
        storage: {
          setAlarm: (ms: number) => void;
          getAlarm?: () => Promise<number | null>;
        };
      };
      env: unknown;
      initialState!: S;
      private _alarm: number | null = null;
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
        this.ctx = {
          storage: {
            setAlarm: (ms: number) => { this._alarm = ms; },
            getAlarm: async () => this._alarm,
          },
        };
        setTimeout(() => { this.state = this.initialState; }, 0);
      }
      setState(s: S) { this.state = s; }
      alarm = async () => {};
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));
});

function makeAgent() {
  // Require after mock is installed.
  return import('../weavile-assurance.js').then(mod => {
    const agent = new mod.WeavileAssuranceAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    agent.state = { pendingTickets: [], completedSweeps: [] };
    return { agent, mod };
  });
}

const BASE_ENQUEUE = {
  stealthAddr: '0xhermeshermeshermeshermeshermeshermeshermes',
  chain: 'eth' as const,
  chainId: 1,
  recipientSuiAddr: '0xbrando',
  coldDestSealRef: 'seal:athena:1',
  dwalletId: 'dwallet:hermes',
};

// ─── _issueTicket ──────────────────────────────────────────────────

describe('_issueTicket', () => {
  test('produces a 32-byte hex ticketId, unique across calls', async () => {
    const { agent } = await makeAgent();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const t = agent._issueTicket(BASE_ENQUEUE);
      // 0x + 64 hex chars = 66 length.
      expect(t.ticketId).toMatch(/^0x[0-9a-f]{64}$/);
      ids.add(t.ticketId);
    }
    expect(ids.size).toBe(100);
  });

  test('sets expiresAtMs = issuedAtMs + TICKET_VALIDITY_MS', async () => {
    const { agent, mod } = await makeAgent();
    const t = agent._issueTicket(BASE_ENQUEUE);
    expect(t.expiresAtMs - t.issuedAtMs).toBe(mod.TICKET_VALIDITY_MS);
    expect(t.used).toBe(false);
    expect(t.attempts).toBe(0);
  });
});

// ─── _consumeTicket ────────────────────────────────────────────────

describe('_consumeTicket', () => {
  test('accepts a fresh ticket and marks it used', async () => {
    const { agent } = await makeAgent();
    const t = agent._issueTicket(BASE_ENQUEUE);
    agent.state = { ...agent.state, pendingTickets: [t] };
    const consumed = agent._consumeTicket(t.ticketId);
    expect(consumed).not.toBeNull();
    expect(consumed?.used).toBe(true);
    // State now has used=true.
    expect(agent.state.pendingTickets[0].used).toBe(true);
  });

  test('rejects a used ticket (returns null)', async () => {
    const { agent } = await makeAgent();
    const t = agent._issueTicket(BASE_ENQUEUE);
    agent.state = { ...agent.state, pendingTickets: [t] };
    expect(agent._consumeTicket(t.ticketId)).not.toBeNull();
    expect(agent._consumeTicket(t.ticketId)).toBeNull();
  });

  test('rejects an expired ticket (returns null)', async () => {
    const { agent } = await makeAgent();
    const t = agent._issueTicket(BASE_ENQUEUE);
    // Force expiry.
    const expired = { ...t, expiresAtMs: Date.now() - 1 };
    agent.state = { ...agent.state, pendingTickets: [expired] };
    expect(agent._consumeTicket(t.ticketId)).toBeNull();
  });

  test('rejects unknown ticketId (returns null)', async () => {
    const { agent } = await makeAgent();
    expect(agent._consumeTicket('0xdeadbeef')).toBeNull();
  });
});

// ─── _pickPolicyIndex ──────────────────────────────────────────────

describe('_pickPolicyIndex', () => {
  test('is deterministic on input', async () => {
    const { agent } = await makeAgent();
    const id = '0x7f' + '00'.repeat(31);
    expect(agent._pickPolicyIndex(id)).toBe(agent._pickPolicyIndex(id));
    // 0x7f = 127, 127 % 5 = 2
    expect(agent._pickPolicyIndex(id)).toBe(2);
  });

  test('spreads across all POLICY_POOL_SIZE values given 10k random ticketIds', async () => {
    const { agent, mod } = await makeAgent();
    const buckets = new Array<number>(mod.POLICY_POOL_SIZE).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      const id = mod.generateTicketId();
      buckets[agent._pickPolicyIndex(id)] += 1;
    }
    for (const b of buckets) {
      expect(b).toBeGreaterThan(0);
    }
  });
});

// ─── enqueueSweep ──────────────────────────────────────────────────

describe('enqueueSweep', () => {
  test('stores a pending ticket and returns ticketId + expiresAtMs', async () => {
    const { agent } = await makeAgent();
    const before = Date.now();
    const r = await agent.enqueueSweep(BASE_ENQUEUE);
    expect(r.ticketId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.expiresAtMs).toBeGreaterThan(before);
    expect(agent.state.pendingTickets).toHaveLength(1);
    expect(agent.state.pendingTickets[0].ticketId).toBe(r.ticketId);
    expect(agent.state.pendingTickets[0].chain).toBe('eth');
  });

  test('schedules an alarm if none exists', async () => {
    const { agent } = await makeAgent();
    const spy: number[] = [];
    agent.ctx.storage.setAlarm = (ms: number) => { spy.push(ms); };
    await agent.enqueueSweep(BASE_ENQUEUE);
    expect(spy.length).toBeGreaterThanOrEqual(1);
    expect(spy[0]).toBeGreaterThan(Date.now() - 1_000);
  });
});

// ─── status ────────────────────────────────────────────────────────

describe('status', () => {
  test('returns counts by chain', async () => {
    const { agent } = await makeAgent();
    await agent.enqueueSweep({ ...BASE_ENQUEUE, chain: 'eth' });
    await agent.enqueueSweep({ ...BASE_ENQUEUE, chain: 'sol', stealthAddr: 'AthenaAthenaAthenaAthena' });
    await agent.enqueueSweep({ ...BASE_ENQUEUE, chain: 'sol', stealthAddr: 'AthenaAthenaAthenaAthena2' });
    const s = await agent.status();
    expect(s.pendingCount).toBe(3);
    expect(s.pendingByChain.eth).toBe(1);
    expect(s.pendingByChain.sol).toBe(2);
    expect(s.recentCompletions).toEqual([]);
  });
});

// ─── _runAssuranceAlarm ───────────────────────────────────────────

describe('_runAssuranceAlarm', () => {
  test('drains expired tickets and leaves unexpired ones', async () => {
    const { agent } = await makeAgent();
    const fresh = agent._issueTicket(BASE_ENQUEUE);
    const stale = {
      ...agent._issueTicket({ ...BASE_ENQUEUE, stealthAddr: '0xstaleAthenaAthenaAthenaAthenaAthena1234' }),
      expiresAtMs: Date.now() - 1,
    };
    agent.state = { ...agent.state, pendingTickets: [fresh, stale] };
    await agent._runAssuranceAlarm();
    expect(agent.state.pendingTickets).toHaveLength(1);
    expect(agent.state.pendingTickets[0].ticketId).toBe(fresh.ticketId);
  });
});
