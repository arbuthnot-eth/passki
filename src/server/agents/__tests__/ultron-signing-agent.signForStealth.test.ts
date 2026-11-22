/**
 * Weavile Assurance Move 1 — signForStealth callable tests.
 *
 * Validates the generic 32-byte hash signing entry point on
 * UltronSigningAgent:
 *   - input validation (0x prefix, exact 32-byte length, curve enum)
 *   - secp256k1 + ed25519 happy paths return a 64-byte 0x-hex signature
 *
 * The IKA ceremony is mocked at the UltronSigningAgent private-method
 * boundary (_requestPresign / _pollPresignCompleted / _requestSign /
 * _pollSignCompleted) so no network or WASM runs.
 */

import { describe, test, expect, mock, afterAll } from 'bun:test';

// bun's mock.module is process-wide and outlives this file, so the stubs
// below leaked into later test files (ultron-postal's handleTransfer got a
// fake Transaction and failed in full-suite runs). Snapshot the real
// modules first and put them back when this file is done.
const _realModules: Record<string, unknown> = {};
for (const spec of ['@mysten/sui/transactions', '@mysten/sui/keypairs/ed25519', '@mysten/sui/utils', '@mysten/sui/graphql', '@ika.xyz/sdk']) {
  try { _realModules[spec] = { ...(await import(spec)) }; } catch { /* not loadable in tests — nothing to restore */ }
}
afterAll(() => {
  for (const [spec, real] of Object.entries(_realModules)) mock.module(spec, () => real as Record<string, unknown>);
});

// Module stubs are installed at import time (NOT inside beforeAll) so the
// dynamic import() below sees them. bun:test's `mock.module` is sync and
// intercepts subsequent imports.
{
  // Stub the `agents` runtime so Agent subclassing + @callable work
  // without the real Durable Object host.
  mock.module('agents', () => ({
    Agent: class AgentStub<_E, S> {
      state: S;
      name = 'test';
      env: unknown;
      ctx: { storage: { setAlarm: (ms: number) => void } };
      initialState!: S;
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
        this.ctx = { storage: { setAlarm: () => {} } };
        setTimeout(() => { this.state = this.initialState; }, 0);
      }
      setState(s: S) { this.state = s; }
      alarm = async () => {};
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));

  // Stub @ika.xyz/sdk — the file imports enum-like objects + classes at
  // module load time. We only need them to exist; signForStealth itself
  // calls private methods that we'll replace on the instance directly.
  mock.module('@ika.xyz/sdk', () => ({
    IkaClient: class { async initialize() {} async getDWallet() { return {}; } },
    IkaTransaction: class {},
    UserShareEncryptionKeys: { fromRootSeedKey: async () => ({}) },
    Curve: { ED25519: 'ED25519', SECP256K1: 'SECP256K1' },
    Hash: { KECCAK256: 'KECCAK256', SHA512: 'SHA512', SHA256: 'SHA256' },
    SignatureAlgorithm: { EdDSA: 'EdDSA', ECDSASecp256k1: 'ECDSASecp256k1' },
    getNetworkConfig: () => ({}),
    parseSignatureFromSignOutput: async (_c: unknown, _a: unknown, b: Uint8Array) => b,
  }));

  // Stub the WASM binding — any import is fine, just needs to not throw.
  mock.module('@ika.xyz/ika-wasm/web', () => ({
    initSync: () => {},
    generate_secp_cg_keypair_from_seed: () => ({}),
  }));

  // Stub the wasm binary import — Bun doesn't know about wrangler's
  // CompiledWasm rule, so we replace it with a harmless object.
  mock.module('../../wasm/dwallet_mpc_wasm_bg.wasm', () => ({ default: {} }));

  // Stub the ultron-key module and SuiGraphQLClient — they're imported
  // at module load for other methods but signForStealth never touches them.
  mock.module('../ultron-key.js', () => ({
    ultronKeypair: () => ({
      getPublicKey: () => ({ toSuiAddress: () => '0x0' }),
      signTransaction: async () => ({ signature: '' }),
    }),
  }));
  mock.module('@mysten/sui/graphql', () => ({
    SuiGraphQLClient: class {
      core = { executeTransaction: async () => ({ $kind: 'Transaction', Transaction: { digest: '' } }) };
    },
  }));
  mock.module('@mysten/sui/transactions', () => ({
    Transaction: class {
      setSender() {}
      build = async () => new Uint8Array();
      objectRef = () => ({});
      splitCoins = () => [{}];
      transferObjects() {}
      pure = { u64: () => ({}), address: () => ({}) };
      gas = {};
    },
  }));
  mock.module('@mysten/sui/keypairs/ed25519', () => ({
    Ed25519Keypair: class {
      static fromSecretKey() {
        return { getPublicKey: () => ({ toSuiAddress: () => '0x0' }) };
      }
    },
  }));
  mock.module('@mysten/sui/utils', () => ({
    normalizeSuiAddress: (a: string) => a,
  }));
}

// Import AFTER mocks so module-load-time side effects see the stubs.
const { UltronSigningAgent } = await import('../ultron-signing-agent.js');

// The real ULTRON_DWALLETS is internal; we match the shape from the file.
const ULTRON_SECP_DWALLET_ID = '0xbb8bce5447722a4c6f5f64618164d8420551dfdbc7605afe279a85de1ebb6acb';
const ULTRON_ED_DWALLET_ID = '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9';

function makeAgent(): InstanceType<typeof UltronSigningAgent> {
  // The AgentStub constructor takes (ctx, env). Pass nulls — signForStealth
  // never reads state, and the mocked private methods return canned values.
  const agent = new UltronSigningAgent(null as never, {} as never);
  return agent;
}

/**
 * Install fake private methods on an agent instance. Each returns the
 * success shape the real method would return — enough for signForStealth
 * to complete without touching network / WASM.
 */
function stubCeremony(
  agent: InstanceType<typeof UltronSigningAgent>,
  sigBytes: Uint8Array,
): void {
  const a = agent as unknown as Record<string, unknown>;
  a._requestPresign = async () => ({
    ok: true,
    presignObjectId: '0xpre',
    presignCapId: '0xcap',
    digest: '0xdigest',
    state: 'Requested',
    durationMs: 1,
  });
  a._pollPresignCompleted = async () => ({
    ok: true,
    completed: true,
    state: 'Completed',
    durationMs: 1,
  });
  a._requestSign = async () => ({
    ok: true,
    signSessionId: '0xsign',
    digest: '0xdigest',
    durationMs: 1,
  });
  a._pollSignCompleted = async () => ({
    ok: true,
    completed: true,
    signatureHex: Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    state: 'Completed',
    durationMs: 1,
  });
}

const VALID_HASH = '0x' + '11'.repeat(32);

describe('UltronSigningAgent.signForStealth', () => {
  test('rejects non-0x hash', async () => {
    const agent = makeAgent();
    stubCeremony(agent, new Uint8Array(64));
    await expect(
      agent.signForStealth({ dwalletId: ULTRON_SECP_DWALLET_ID, hash: '11'.repeat(32), curve: 'secp256k1' }),
    ).rejects.toThrow(/0x-prefixed/);
  });

  test('rejects hash that isn\'t exactly 32 bytes', async () => {
    const agent = makeAgent();
    stubCeremony(agent, new Uint8Array(64));
    await expect(
      agent.signForStealth({ dwalletId: ULTRON_SECP_DWALLET_ID, hash: '0x1234', curve: 'secp256k1' }),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      agent.signForStealth({ dwalletId: ULTRON_SECP_DWALLET_ID, hash: '0x' + '11'.repeat(33), curve: 'secp256k1' }),
    ).rejects.toThrow(/32 bytes/);
  });

  test('rejects unknown curve', async () => {
    const agent = makeAgent();
    stubCeremony(agent, new Uint8Array(64));
    await expect(
      agent.signForStealth({ dwalletId: ULTRON_SECP_DWALLET_ID, hash: VALID_HASH, curve: 'p256' as 'secp256k1' }),
    ).rejects.toThrow(/invalid curve/);
  });

  test('rejects unknown dwalletId', async () => {
    const agent = makeAgent();
    stubCeremony(agent, new Uint8Array(64));
    await expect(
      agent.signForStealth({ dwalletId: '0xdeadbeef', hash: VALID_HASH, curve: 'secp256k1' }),
    ).rejects.toThrow(/unknown dwalletId/);
  });

  test('mocks IKA ceremony + asserts 64-byte secp256k1 sig shape', async () => {
    const agent = makeAgent();
    const fakeSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) fakeSig[i] = (i * 3) & 0xff;
    stubCeremony(agent, fakeSig);

    const { sig } = await agent.signForStealth({
      dwalletId: ULTRON_SECP_DWALLET_ID,
      hash: VALID_HASH,
      curve: 'secp256k1',
    });
    expect(sig.startsWith('0x')).toBe(true);
    expect(sig.length).toBe(2 + 64 * 2); // 0x + 64 bytes hex
  });

  test('mocks IKA ceremony + asserts 64-byte ed25519 sig shape', async () => {
    const agent = makeAgent();
    const fakeSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) fakeSig[i] = (i * 7) & 0xff;
    stubCeremony(agent, fakeSig);

    const { sig } = await agent.signForStealth({
      dwalletId: ULTRON_ED_DWALLET_ID,
      hash: VALID_HASH,
      curve: 'ed25519',
    });
    expect(sig.startsWith('0x')).toBe(true);
    expect(sig.length).toBe(2 + 64 * 2);
  });
});
