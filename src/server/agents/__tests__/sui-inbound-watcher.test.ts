/**
 * SuiInboundWatcher — Aggron Harden pt2 unit tests.
 *
 * Mocks `agents` like the sibling suites (weavile-assurance.test.ts,
 * aggron-batcher.test.ts) so we can instantiate the DO scaffold
 * without a live Cloudflare runtime and inject a fake JSON-RPC.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';
import { SUI_ULTRON_ADDRESS, SUI_COIN_TYPE } from '../../sui-inbound.js';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state!: S;
      name = 'ultron-inbound';
      ctx: {
        storage: {
          setAlarm: (ms: number) => void;
          getAlarm?: () => Promise<number | null>;
        };
      };
      env: unknown;
      initialState!: S;
      private _alarm: number | null = null;
      alarm = async () => {};
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
        this.ctx = {
          storage: {
            setAlarm: (ms: number) => { this._alarm = ms; },
            getAlarm: async () => this._alarm,
          },
        };
      }
      setState(s: S) { this.state = s; }
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));
});

function makeActivity(params: {
  digest: string;
  amount: string | number;
  coinType?: string;
  sender?: string;
}) {
  return {
    digest: params.digest,
    timestampMs: '1700000000000',
    transaction: {
      data: { sender: params.sender || '0xsenderaaa' },
    },
    balanceChanges: [
      {
        owner: { AddressOwner: SUI_ULTRON_ADDRESS },
        coinType: params.coinType || SUI_COIN_TYPE,
        amount: String(params.amount),
      },
    ],
  };
}

async function makeAgent() {
  const mod = await import('../sui-inbound-watcher.js');
  const agent = new mod.SuiInboundWatcher(
    {} as unknown as DurableObjectState,
    { SUI_NETWORK: 'mainnet' },
  );
  agent.state = {
    lastPolledCheckpoint: null,
    lastPolledAtMs: 0,
    observed: [],
    routingLog: [],
  };
  return { agent, mod };
}

// ─── Pure helpers ──────────────────────────────────────────────────

describe('parseInboundFromRpc', () => {
  test('keeps positive credits to ultron, drops other owners', async () => {
    const mod = await import('../sui-inbound-watcher.js');
    const resp = {
      data: [
        makeActivity({ digest: '0xAAA', amount: '1000' }),
        {
          digest: '0xBBB',
          timestampMs: '0',
          transaction: { data: { sender: '0xsender' } },
          balanceChanges: [
            { owner: { AddressOwner: '0xsomeoneelse' }, coinType: SUI_COIN_TYPE, amount: '500' },
          ],
        },
      ],
    };
    const out = mod.parseInboundFromRpc(resp);
    expect(out).toHaveLength(1);
    expect(out[0].digest).toBe('0xAAA');
    expect(out[0].amountMist).toBe(1000n);
  });

  test('drops zero / negative amounts', async () => {
    const mod = await import('../sui-inbound-watcher.js');
    const resp = { data: [
      makeActivity({ digest: '0xneg', amount: '-100' }),
      makeActivity({ digest: '0xzero', amount: '0' }),
    ] };
    expect(mod.parseInboundFromRpc(resp)).toHaveLength(0);
  });
});

describe('ringPush', () => {
  test('bounds to max, keeps tail', async () => {
    const mod = await import('../sui-inbound-watcher.js');
    const buf = [1, 2, 3];
    const next = [4, 5, 6, 7];
    expect(mod.ringPush(buf, next, 5)).toEqual([3, 4, 5, 6, 7]);
    expect(mod.ringPush(buf, next, 100)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// ─── Alarm / poll behavior ─────────────────────────────────────────

describe('_runPollAlarm', () => {
  test('decodeSubcentIntent is effectively called per inbound credit (intent detected)', async () => {
    const { agent } = await makeAgent();
    // amount ends in …10042 → chainTag=1 (eth), recipient=0042
    let calls = 0;
    agent.setQueryFn(async () => {
      calls += 1;
      return { data: [makeActivity({ digest: '0xA', amount: '1000010042' })] };
    });
    const r = await agent._runPollAlarm();
    expect(calls).toBe(1);
    expect(r.polled).toBe(1);
    expect(r.newActivities).toBe(1);
    expect(r.intents).toBe(1);
    expect(agent.state.routingLog).toHaveLength(1);
    const entry = agent.state.routingLog[0];
    expect(entry.chainTagName).toBe('eth');
    expect(entry.intent.recipientIndex).toBe(42);
    expect(entry.routedAt).toBeNull();
    // No registry/postal stubs → status=unresolved, registry miss.
    expect(entry.status).toBe('unresolved');
    expect(entry.lastError).toBeDefined();
  });

  test('zero-tail activities are observed but not routed', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xclean', amount: '1000000000' })],
    }));
    const r = await agent._runPollAlarm();
    expect(r.newActivities).toBe(1);
    expect(r.intents).toBe(0);
    expect(agent.state.routingLog).toHaveLength(0);
    expect(agent.state.observed).toHaveLength(1);
  });

  test('duplicate txs across polls are deduped', async () => {
    const { agent } = await makeAgent();
    const sameTx = makeActivity({ digest: '0xDUP', amount: '1000010042' });
    agent.setQueryFn(async () => ({ data: [sameTx] }));
    await agent._runPollAlarm();
    await agent._runPollAlarm();
    await agent._runPollAlarm();
    expect(agent.state.observed).toHaveLength(1);
    expect(agent.state.routingLog).toHaveLength(1);
  });

  test('routingLog is bounded to ROUTING_LOG_MAX entries', async () => {
    const { agent, mod } = await makeAgent();
    // Stuff the state with ROUTING_LOG_MAX - 2 entries already.
    const now = Date.now();
    agent.state = {
      ...agent.state,
      routingLog: Array.from({ length: mod.ROUTING_LOG_MAX - 2 }, (_, i) => ({
        digest: `0xold${i}`,
        coinType: SUI_COIN_TYPE,
        fromAddress: '0x',
        amountMist: '0',
        intent: {
          rawAmount: 0n,
          intentCode: 1,
          chainTag: 0,
          recipientIndex: 1,
          baseAmount: 0n,
          hasIntent: true,
          amountMist: '0',
        } as never,
        chainTagName: 'sui' as const,
        note: 'old',
        observedAtMs: now,
        routedAt: null,
        status: 'unresolved' as const,
      })),
    };
    // Feed 10 new intent-bearing txs → total exceeds cap.
    const data = Array.from({ length: 10 }, (_, i) =>
      makeActivity({ digest: `0xnew${i}`, amount: `${1_000_000_000 + 10042 + i}` }),
    );
    agent.setQueryFn(async () => ({ data }));
    await agent._runPollAlarm();
    expect(agent.state.routingLog.length).toBe(mod.ROUTING_LOG_MAX);
    // Newest entry should be present at tail.
    expect(agent.state.routingLog[agent.state.routingLog.length - 1].digest).toBe('0xnew9');
  });

  test('observed buffer is bounded to OBSERVED_MAX entries', async () => {
    const { agent, mod } = await makeAgent();
    const data = Array.from({ length: mod.OBSERVED_MAX + 20 }, (_, i) =>
      makeActivity({ digest: `0xobs${i}`, amount: `${1_000_000_000 + i}` }),
    );
    agent.setQueryFn(async () => ({ data }));
    await agent._runPollAlarm();
    expect(agent.state.observed.length).toBe(mod.OBSERVED_MAX);
  });
});

// ─── Callables ─────────────────────────────────────────────────────

describe('status + recentRouting', () => {
  test('status returns observed count and recent routing', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [
        makeActivity({ digest: '0xA', amount: '1000010042' }),
        makeActivity({ digest: '0xB', amount: '2000020007' }),
      ],
    }));
    await agent._runPollAlarm();
    const s = await agent.status();
    expect(s.ultronAddress).toBe(SUI_ULTRON_ADDRESS);
    expect(s.observedCount).toBe(2);
    expect(s.routingCount).toBe(2);
    expect(s.recentRouting).toHaveLength(2);
    const recent = await agent.recentRouting({ limit: 1 });
    expect(recent).toHaveLength(1);
  });

  test('poke triggers a poll and returns counts', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xP', amount: '1000010003' })],
    }));
    const r = await agent.poke();
    expect(r.polled).toBe(1);
    expect(r.intents).toBe(1);
  });
});

// ─── IntentRegistry + UltronPostal wiring ─────────────────────────

describe('registry + postal wiring', () => {
  test('intent + registry match + dispatch OK → status=routed + ticketId', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xhermes', amount: '1000010042' })],
    }));
    agent.setRegistryStub({
      lookup: async ({ intentIndex }) =>
        intentIndex === 42
          ? { suiamiName: 'hermes.sui', recipientIndex: 42 }
          : null,
    });
    agent.setPostalStub({
      dispatch: async () => ({
        ticketId: 'tkt-athena-001',
        kind: 'sweep',
        action: 'forward',
      }),
    });
    await agent._runPollAlarm();
    expect(agent.state.routingLog).toHaveLength(1);
    const entry = agent.state.routingLog[0];
    expect(entry.status).toBe('routed');
    expect(entry.recipientSuiamiName).toBe('hermes.sui');
    expect(entry.dispatchTicketId).toBe('tkt-athena-001');
    expect(entry.routedAt).not.toBeNull();
    expect(entry.lastError).toBeUndefined();
  });

  test('intent + registry miss → status=unresolved, no ticketId', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xapollo', amount: '1000010099' })],
    }));
    agent.setRegistryStub({
      lookup: async ({ intentIndex }) =>
        intentIndex === 42
          ? { suiamiName: 'hermes.sui', recipientIndex: 42 }
          : null,
    });
    let dispatchCalls = 0;
    agent.setPostalStub({
      dispatch: async () => {
        dispatchCalls += 1;
        return { ticketId: 'should-not-be-called', kind: '', action: '' };
      },
    });
    await agent._runPollAlarm();
    expect(dispatchCalls).toBe(0);
    expect(agent.state.routingLog).toHaveLength(1);
    const entry = agent.state.routingLog[0];
    expect(entry.status).toBe('unresolved');
    expect(entry.dispatchTicketId).toBeUndefined();
    expect(entry.recipientSuiamiName).toBeUndefined();
    expect(entry.routedAt).toBeNull();
  });

  test('no intent → routingLog skipped, observed recorded', async () => {
    const { agent } = await makeAgent();
    let lookups = 0;
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xzeus', amount: '1000000000' })],
    }));
    agent.setRegistryStub({
      lookup: async () => {
        lookups += 1;
        return null;
      },
    });
    await agent._runPollAlarm();
    expect(lookups).toBe(0);
    expect(agent.state.routingLog).toHaveLength(0);
    expect(agent.state.observed).toHaveLength(1);
  });

  test('registry stub throws → status=unresolved + lastError set', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xares', amount: '1000010042' })],
    }));
    agent.setRegistryStub({
      lookup: async () => {
        throw new Error('registry down: olympus unreachable');
      },
    });
    await agent._runPollAlarm();
    expect(agent.state.routingLog).toHaveLength(1);
    const entry = agent.state.routingLog[0];
    expect(entry.status).toBe('unresolved');
    expect(entry.lastError).toContain('olympus unreachable');
    expect(entry.dispatchTicketId).toBeUndefined();
    expect(entry.routedAt).toBeNull();
  });

  test('dispatch stub throws → status=unresolved, recipient resolved, lastError set', async () => {
    const { agent } = await makeAgent();
    agent.setQueryFn(async () => ({
      data: [makeActivity({ digest: '0xposeidon', amount: '1000010042' })],
    }));
    agent.setRegistryStub({
      lookup: async () => ({ suiamiName: 'poseidon.sui', recipientIndex: 42 }),
    });
    agent.setPostalStub({
      dispatch: async () => {
        throw new Error('postal jammed');
      },
    });
    await agent._runPollAlarm();
    expect(agent.state.routingLog).toHaveLength(1);
    const entry = agent.state.routingLog[0];
    expect(entry.status).toBe('unresolved');
    expect(entry.recipientSuiamiName).toBe('poseidon.sui');
    expect(entry.dispatchTicketId).toBeUndefined();
    expect(entry.lastError).toContain('postal jammed');
  });
});
