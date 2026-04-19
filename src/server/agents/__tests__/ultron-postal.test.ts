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
  // Subclass that re-stubs handleTransfer so alarm-drain tests don't
  // hit the live Icy Wind pt2 network path. Tests in the
  // "handleTransfer (Icy Wind pt2 live path)" describe block call
  // handleTransfer directly (with fetch + signer mocks) instead.
  class Stubbed extends UltronPostalCtor {
    protected override _resolveHandler() {
      return async () => ({ digest: null, stub: true });
    }
  }
  const inst = new Stubbed({} as unknown as DurableObjectState, {});
  // Mirror the constructor setting state to initialState (AgentStub ctor
  // assigns `{} as S`; the real Agent base runs initialState, so we do it).
  // @ts-expect-error – accessing for test setup
  inst.state = { ...inst.initialState };
  return inst as UltronPostal;
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

function newFlakyInstance(onCall: () => void): UltronPostal {
  class Flaky extends UltronPostalCtor {
    protected override _resolveHandler() {
      return async () => {
        onCall();
        throw new mod.TransientDispatchError('boom');
      };
    }
  }
  const inst = new Flaky({} as unknown as DurableObjectState, {});
  // @ts-expect-error – mirror initialState like newInstance()
  inst.state = { ...inst.initialState };
  return inst as UltronPostal;
}

describe('retry + dead-letter', () => {
  test('transient error increments attempts and re-queues', async () => {
    let calls = 0;
    const inst = newFlakyInstance(() => { calls++; });
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
  });

  test('dead-letters after MAX_ATTEMPTS', async () => {
    let calls = 0;
    const inst = newFlakyInstance(() => { calls++; });
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
    const callsAtCap = calls;
    // @ts-expect-error – internal
    await inst._runDispatchAlarm();
    expect(calls).toBe(callsAtCap);
    expect(pending[0]!.attempts).toBe(mod.POSTAL_MAX_ATTEMPTS);
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

// ─── Icy Wind pt2 — handleTransfer live path ───────────────────────
//
// We mock `suiami/roster`, chain-at, and global fetch so handleTransfer
// runs end-to-end without touching the network. The injected signer
// observes the dwalletId + curve and returns a fake 64-byte sig.

describe('handleTransfer (Icy Wind pt2 live path)', () => {
  const ULTRON_DWALLET = '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9';
  // 32 bytes of 0x11 — produces a deterministic Sui address. Not a real pubkey.
  const FAKE_PUBKEY_HEX = '11'.repeat(32);
  const FAKE_SIG_HEX = 'ab'.repeat(64);
  const FAKE_DIGEST = 'AbCdEf1234567890';

  function installFetchStub(opts: {
    onSubmit?: (body: string) => void;
    submitError?: boolean;
  } = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      const body = init?.body ? String(init.body) : '';
      const parsed = body ? JSON.parse(body) : {};
      const method = parsed.method as string | undefined;
      if (method === 'sui_getObject') {
        const po = [1, 32, ...Array.from({ length: 32 }, () => 0x11)];
        return new Response(JSON.stringify({
          result: { data: { content: { fields: { state: { fields: { public_output: po } } } } } },
        }), { status: 200 });
      }
      if (method === 'suix_getBalance' || method === 'sui_getBalance') {
        return new Response(JSON.stringify({
          result: {
            coinType: '0x2::sui::SUI',
            coinObjectCount: 1,
            totalBalance: '10000000000',
            fundsInAddressBalance: '0',
          },
        }), { status: 200 });
      }
      if (method === 'suix_getReferenceGasPrice' || method === 'sui_getReferenceGasPrice') {
        return new Response(JSON.stringify({ result: '1000' }), { status: 200 });
      }
      if (method === 'suix_getCoins' || method === 'sui_getCoins') {
        return new Response(JSON.stringify({
          result: {
            data: [{
              coinObjectId: '0x' + '44'.repeat(32),
              version: '1',
              // Base58 32-byte digest that is NOT the reservation magic.
              digest: '11111111111111111111111111111111',
              balance: '10000000000',
              coinType: '0x2::sui::SUI',
              previousTransaction: '0x0',
              digestLong: '',
            }],
            hasNextPage: false,
            nextCursor: null,
          },
        }), { status: 200 });
      }
      if (method === 'sui_executeTransactionBlock') {
        if (opts.submitError) {
          return new Response(JSON.stringify({
            error: { message: 'permanent fail' },
          }), { status: 200 });
        }
        opts.onSubmit?.(body);
        return new Response(JSON.stringify({
          result: {
            digest: FAKE_DIGEST,
            effects: { status: { status: 'success' } },
          },
        }), { status: 200 });
      }
      // getCoins / anything else — return empty success.
      return new Response(JSON.stringify({ result: { data: [] } }), { status: 200 });
    };
    // SuiJsonRpcClient.getCoins uses fetch internally too; the default
    // above returns `result: { data: [] }` for unknown methods. We only
    // hit getCoins for non-SUI coin paths — SUI splits from tx.gas.
  }

  beforeAll(async () => {
    // Mock the roster so resolveRecipientSuiAddress returns a known addr.
    mock.module('suiami/roster', () => ({
      readByName: async (_name: string) => ({
        sui_address: '0x' + 'cd'.repeat(32),
        chains: { sui: '0x' + 'cd'.repeat(32) },
      }),
    }));
  });

  test('signs via injected SignForStealth and submits a real digest', async () => {
    installFetchStub();
    let observed: { dwalletId: string; curve: string; hash: string } | null = null;
    const fakeSigner = async (p: { dwalletId: string; curve: 'ed25519' | 'secp256k1'; hash: string }) => {
      observed = { dwalletId: p.dwalletId, curve: p.curve, hash: p.hash };
      return { sig: '0x' + FAKE_SIG_HEX };
    };

    const ticket: import('../ultron-postal.js').DispatchTicket = {
      ticketId: '0x' + 'aa'.repeat(32),
      kind: 'transfer',
      activity: {
        digest: '0xabc',
        fromAddress: '0xsender',
        toAddress: '0xultron',
        coinType: '0x2::sui::SUI',
        amountMist: 1_000_000n,
        timestampMs: 1,
      },
      intent: {
        rawAmount: 1_000_042n,
        intentCode: 42,
        chainTag: 0,
        recipientIndex: 42,
        baseAmount: 1_000_000n,
        hasIntent: true,
      },
      recipientSuiamiName: 'hermes',
      queuedAtMs: Date.now(),
      attempts: 0,
    };

    const res = await mod.handleTransfer(ticket, {} as never, fakeSigner);
    expect(res.stub).toBe(false);
    expect(res.digest).toBe(FAKE_DIGEST);
    expect(observed).not.toBeNull();
    expect(observed!.dwalletId).toBe(ULTRON_DWALLET);
    expect(observed!.curve).toBe('ed25519');
    // Hash must be 32 bytes hex.
    expect(observed!.hash).toMatch(/^0x[0-9a-f]{64}$/);
    // silence unused local
    void FAKE_PUBKEY_HEX;
  });

  test('throws (permanent) when submit RPC returns an error', async () => {
    installFetchStub({ submitError: true });
    const fakeSigner = async () => ({ sig: '0x' + FAKE_SIG_HEX });
    const ticket: import('../ultron-postal.js').DispatchTicket = {
      ticketId: '0x' + 'bb'.repeat(32),
      kind: 'transfer',
      activity: {
        digest: '0xdef',
        fromAddress: '0xsender',
        toAddress: '0xultron',
        coinType: '0x2::sui::SUI',
        amountMist: 500_000n,
        timestampMs: 1,
      },
      intent: {
        rawAmount: 500_000n,
        intentCode: 1,
        chainTag: 0,
        recipientIndex: 1,
        baseAmount: 500_000n,
        hasIntent: true,
      },
      recipientSuiamiName: 'ares',
      queuedAtMs: Date.now(),
      attempts: 0,
    };
    await expect(mod.handleTransfer(ticket, {} as never, fakeSigner)).rejects.toThrow();
  });
});
