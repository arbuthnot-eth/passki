/**
 * UltronPostal DO — scaffold tests. Mocks the `agents` package to expose
 * `setState` + `state` on a plain base class, then exercises dispatch,
 * alarm drain, retry, dead-letter, history ring buffer, and status.
 */
import { describe, test, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state: S;
      ctx: { storage: { setAlarm: (ms: number) => Promise<void>; getAlarm: () => Promise<number | null> } };
      env: unknown;
      _alarmAt: number | null = null;
      constructor(_ctx: unknown, env: unknown) {
        this.state = {} as S;
        this.env = env;
        const self = this;
        this.ctx = {
          storage: {
            setAlarm: async (ms: number) => { self._alarmAt = ms; },
            getAlarm: async () => self._alarmAt,
          },
        };
      }
      setState(s: S) { this.state = s; }
      // Base alarm is a no-op; subclasses override in constructor.
      async alarm() { /* no-op */ }
    },
    callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d,
  }));
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type UltronPostal = import('../ultron-postal.js').UltronPostal;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type DispatchTicket = import('../ultron-postal.js').DispatchTicket;
let UltronPostalCtor: typeof import('../ultron-postal.js').UltronPostal;
let mod: typeof import('../ultron-postal.js');

beforeAll(async () => {
  mod = await import('../ultron-postal.js');
  UltronPostalCtor = mod.UltronPostal;
});

function makeActivity(amount: bigint = 1_000_042n) {
  return {
    digest: '0xabc',
    fromAddress: '0xsender',
    toAddress: '0xultron',
    coinType: '0x2::sui::SUI',
    amountMist: amount,
    timestampMs: 1_700_000_000_000,
  };
}

function makeIntent(hasIntent = true) {
  return {
    rawAmount: 1_000_042n,
    intentCode: hasIntent ? 42 : 0,
    chainTag: 0,
    recipientIndex: 42,
    baseAmount: 1_000_000n,
    hasIntent,
  };
}

function newInstance(): UltronPostal {
  const inst = new UltronPostalCtor({} as unknown as DurableObjectState, {});
  // Mirror the constructor setting state to initialState (AgentStub ctor
  // assigns `{} as S`; the real Agent base runs initialState, so we do it).
  // @ts-expect-error – accessing for test setup
  inst.state = { ...inst.initialState };
  return inst;
}

describe('inferEnvelopeKind', () => {
  test('returns "transfer" for non-zero intent', () => {
    const k = mod.inferEnvelopeKind(makeActivity(), makeIntent(true));
    expect(k).toBe('transfer');
  });
  test('returns null for zero intent', () => {
    const k = mod.inferEnvelopeKind(makeActivity(1_000_000n), makeIntent(false));
    expect(k).toBeNull();
  });
});

describe('generateTicketId', () => {
  test('is 32-byte 0x-prefixed hex', () => {
    expect(mod.generateTicketId()).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test('unique across calls', () => {
    expect(mod.generateTicketId()).not.toBe(mod.generateTicketId());
  });
});

describe('dispatch', () => {
  test('queues a transfer ticket when kind inferrable', async () => {
    const inst = newInstance();
    const r = await inst.dispatch({
      activity: makeActivity(),
      intent: makeIntent(true),
      recipientSuiamiName: 'hermes',
    });
    expect(r.action).toBe('queued');
    expect(r.kind).toBe('transfer');
    // @ts-expect-error – reading internal state
    expect(inst.state.pendingDispatches.length).toBe(1);
  });

  test('skips with no-intent-tag when intent is zero', async () => {
    const inst = newInstance();
    const r = await inst.dispatch({
      activity: makeActivity(1_000_000n),
      intent: makeIntent(false),
      recipientSuiamiName: 'hermes',
    });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('no-intent-tag');
  });

  test('skips with no-recipient when SUIAMI name blank', async () => {
    const inst = newInstance();
    const r = await inst.dispatch({
      activity: makeActivity(),
      intent: makeIntent(true),
      recipientSuiamiName: '',
    });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('no-recipient');
  });
});

describe('alarm drain', () => {
  test('drains up to DRAIN_PER_TICK pending per tick', async () => {
    const inst = newInstance();
    const many = 15;
    for (let i = 0; i < many; i++) {
      await inst.dispatch({
        activity: makeActivity(BigInt(1_000_000 + i)),
        intent: makeIntent(true),
        recipientSuiamiName: 'apollo',
      });
    }
    // @ts-expect-error – internal
    expect(inst.state.pendingDispatches.length).toBe(many);
    // @ts-expect-error – internal
    await inst._runDispatchAlarm();
    // @ts-expect-error – internal
    expect(inst.state.completedDispatches.length).toBe(mod.POSTAL_DRAIN_PER_TICK);
    // Remaining: many - DRAIN_PER_TICK still pending (not yet flushed).
    // @ts-expect-error – internal
    expect(inst.state.pendingDispatches.length).toBe(many - mod.POSTAL_DRAIN_PER_TICK);
  });

  test('handler stub returns { stub: true, digest: null }', async () => {
    const inst = newInstance();
    await inst.dispatch({
      activity: makeActivity(),
      intent: makeIntent(true),
      recipientSuiamiName: 'athena',
    });
    // @ts-expect-error – internal
    await inst._runDispatchAlarm();
    // @ts-expect-error – internal
    const c = inst.state.completedDispatches[0];
    expect(c.stub).toBe(true);
    expect(c.digest).toBeNull();
    expect(c.kind).toBe('transfer');
    expect(c.chain).toBe('sui');
  });
});

describe('retry + dead-letter', () => {
  test('transient error increments attempts and re-queues', async () => {
    const inst = newInstance();
    // Patch handlerFor via monkey-patch on the module: swap handleTransfer
    // to a flaky one for this test only.
    const original = mod.handleTransfer;
    let calls = 0;
    const flaky = async () => {
      calls++;
      throw new mod.TransientDispatchError('boom');
    };
    // @ts-expect-error – mutating exported binding for test
    (mod as { handleTransfer: unknown }).handleTransfer = flaky;
    // But handlerFor is a closure over the module-local handleTransfer
    // reference — so patch handlerFor directly too.
    const originalHandlerFor = mod.handlerFor;
    // @ts-expect-error – test override
    (mod as { handlerFor: unknown }).handlerFor = () => flaky;

    try {
      await inst.dispatch({
        activity: makeActivity(),
        intent: makeIntent(true),
        recipientSuiamiName: 'ares',
      });
      // @ts-expect-error – internal
      await inst._runDispatchAlarm();
      expect(calls).toBe(1);
      // @ts-expect-error – internal
      const pending = inst.state.pendingDispatches as DispatchTicket[];
      expect(pending.length).toBe(1);
      expect(pending[0]!.attempts).toBe(1);
      expect(pending[0]!.lastError).toBe('boom');
    } finally {
      // @ts-expect-error – restore
      (mod as { handleTransfer: unknown }).handleTransfer = original;
      // @ts-expect-error – restore
      (mod as { handlerFor: unknown }).handlerFor = originalHandlerFor;
    }
  });

  test('dead-letters after MAX_ATTEMPTS', async () => {
    const inst = newInstance();
    const flaky = async () => { throw new mod.TransientDispatchError('boom'); };
    const originalHandlerFor = mod.handlerFor;
    // @ts-expect-error – test override
    (mod as { handlerFor: unknown }).handlerFor = () => flaky;

    try {
      await inst.dispatch({
        activity: makeActivity(),
        intent: makeIntent(true),
        recipientSuiamiName: 'ares',
      });
      for (let i = 0; i < mod.POSTAL_MAX_ATTEMPTS; i++) {
        // @ts-expect-error – internal
        await inst._runDispatchAlarm();
      }
      // @ts-expect-error – internal
      const pending = inst.state.pendingDispatches as DispatchTicket[];
      expect(pending.length).toBe(1);
      expect(pending[0]!.attempts).toBe(mod.POSTAL_MAX_ATTEMPTS);
      expect(pending[0]!.lastError).toBe('boom');
      // Further alarm ticks shouldn't re-run the handler on a dead-letter.
      // @ts-expect-error – internal
      await inst._runDispatchAlarm();
      expect(pending[0]!.attempts).toBe(mod.POSTAL_MAX_ATTEMPTS);
    } finally {
      // @ts-expect-error – restore
      (mod as { handlerFor: unknown }).handlerFor = originalHandlerFor;
    }
  });
});

describe('history ring buffer', () => {
  test('completedDispatches bounded to POSTAL_HISTORY_MAX', async () => {
    const inst = newInstance();
    const total = mod.POSTAL_HISTORY_MAX + 7;
    for (let i = 0; i < total; i++) {
      await inst.dispatch({
        activity: makeActivity(BigInt(1_000_000 + i)),
        intent: makeIntent(true),
        recipientSuiamiName: 'zeus',
      });
    }
    // Drain enough ticks to complete all.
    const ticks = Math.ceil(total / mod.POSTAL_DRAIN_PER_TICK);
    for (let i = 0; i < ticks; i++) {
      // @ts-expect-error – internal
      await inst._runDispatchAlarm();
    }
    // @ts-expect-error – internal
    expect(inst.state.completedDispatches.length).toBe(mod.POSTAL_HISTORY_MAX);
  });
});

describe('status', () => {
  test('returns pending count + recent completions', async () => {
    const inst = newInstance();
    await inst.dispatch({
      activity: makeActivity(),
      intent: makeIntent(true),
      recipientSuiamiName: 'hera',
    });
    // @ts-expect-error – internal
    await inst._runDispatchAlarm();
    const s = await inst.status();
    expect(s.pendingCount).toBe(0);
    expect(s.recentCompletions.length).toBe(1);
    expect(s.recentCompletions[0]!.recipientSuiamiName).toBe('hera');
  });
});
