import { describe, test, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state: S;
      constructor(_ctx: unknown, _env: unknown) { this.state = {} as S; }
      setState(s: S) { this.state = s; }
    },
    callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d,
  }));
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type Pending = import('../aggron-batcher.js').AggronPendingBlob;
let generateBlobId: typeof import('../aggron-batcher.js').generateBlobId;
let approxB64DecodedLen: typeof import('../aggron-batcher.js').approxB64DecodedLen;
let shouldFlushNow: typeof import('../aggron-batcher.js').shouldFlushNow;
let AGGRON_FLUSH_COUNT_MAX: number;
let AGGRON_FLUSH_BYTES_MAX: number;

beforeAll(async () => {
  const mod = await import('../aggron-batcher.js');
  generateBlobId = mod.generateBlobId;
  approxB64DecodedLen = mod.approxB64DecodedLen;
  shouldFlushNow = mod.shouldFlushNow;
  AGGRON_FLUSH_COUNT_MAX = mod.AGGRON_FLUSH_COUNT_MAX;
  AGGRON_FLUSH_BYTES_MAX = mod.AGGRON_FLUSH_BYTES_MAX;
});

describe('generateBlobId', () => {
  test('is 32-byte 0x-prefixed hex', () => {
    const id = generateBlobId();
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test('is unique across calls', () => {
    const a = generateBlobId();
    const b = generateBlobId();
    expect(a).not.toBe(b);
  });
});

describe('approxB64DecodedLen', () => {
  test('matches actual decoded length for no-padding, =, ==', () => {
    expect(approxB64DecodedLen('YWJj')).toBe(3); // "abc"
    expect(approxB64DecodedLen('YWI=')).toBe(2); // "ab"
    expect(approxB64DecodedLen('YQ==')).toBe(1); // "a"
  });
  test('empty string → 0', () => {
    expect(approxB64DecodedLen('')).toBe(0);
  });
});

function entry(sizeBytes: number): Pending {
  return {
    blobId: generateBlobId(),
    kind: 'misc',
    targetKey: 't',
    ciphertextB64: '',
    sizeBytes,
    submittedAtMs: Date.now(),
  };
}

describe('shouldFlushNow', () => {
  test('empty queue → false', () => {
    expect(shouldFlushNow([])).toBe(false);
  });
  test('count threshold trips flush', () => {
    const entries = Array.from({ length: AGGRON_FLUSH_COUNT_MAX }, () => entry(1));
    expect(shouldFlushNow(entries)).toBe(true);
  });
  test('bytes threshold trips flush', () => {
    const entries = [entry(AGGRON_FLUSH_BYTES_MAX)];
    expect(shouldFlushNow(entries)).toBe(true);
  });
  test('below both thresholds → false', () => {
    const entries = [entry(1_000), entry(1_000)];
    expect(shouldFlushNow(entries)).toBe(false);
  });
});
