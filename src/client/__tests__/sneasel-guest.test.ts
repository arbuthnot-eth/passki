/**
 * Sneasel Ice Fang — client unit tests.
 *
 * Covers plan §5.2 seed items:
 *   - encrypts v2 intermediate payload (version===2, intermediateAddr, no coldAddr)
 *   - refuses if intermediate == sweepDelegate
 *   - two guests of same parent produce different Seal identities
 *
 * These tests avoid hitting real Seal key servers by mocking the
 * `sealRace` export via `mock.module`. The mock captures the
 * `encrypt()` args so we can assert on the payload shape + identity.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';

type EncryptCall = { packageId: string; id: string; data: Uint8Array; threshold: number };
const captured: EncryptCall[] = [];

// Mock sealRace before the module under test is imported. The Seal
// client `c` is a stub exposing only `encrypt()`; sealRace is a pure
// forwarder in the real impl so this is faithful enough for unit.
beforeAll(() => {
  mock.module('../suiami-seal.js', () => ({
    sealRace: async (fn: (c: { encrypt: (args: EncryptCall) => Promise<{ encryptedObject: Uint8Array }> }) => Promise<{ encryptedObject: Uint8Array }>) => {
      const stub = {
        async encrypt(args: EncryptCall) {
          captured.push(args);
          // Return deterministic fake ciphertext = id hash prefix.
          const bytes = new TextEncoder().encode(`ct:${args.id}`);
          return { encryptedObject: bytes };
        },
      };
      return fn(stub);
    },
    getSealClient: () => ({}),
    ROSTER_OBJ: '0xdeadbeef',
    ROSTER_INITIAL_SHARED_VERSION: 1,
  }));
  mock.module('../rpc.js', () => ({
    grpcClient: {},
    GQL_URL: 'https://example.invalid/graphql',
  }));
});

// Parent hash must be 32 bytes per sneasel-guest invariants.
function parentHash32(): Uint8Array {
  const p = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) p[i] = i + 1;
  return p;
}

describe('sealEncryptColdDest (Ice Fang v2)', () => {
  test('encrypts v2 intermediate payload', async () => {
    captured.length = 0;
    const { sealEncryptColdDest } = await import('../sneasel-guest.js');
    await sealEncryptColdDest({
      intermediateAddr: '0xINTERMEDIATE_A',
      chain: 'eth',
      parentHash: parentHash32(),
      labelBytes: new TextEncoder().encode('amazon'),
      sweepDelegate: '0xULTRON',
    });
    expect(captured.length).toBe(1);
    const decoded = new TextDecoder().decode(captured[0].data);
    const payload = JSON.parse(decoded);
    expect(payload.version).toBe(2);
    expect(payload.intermediateAddr).toBe('0xINTERMEDIATE_A');
    expect(payload.coldAddr).toBeUndefined();
    expect(payload.sweepDelegate).toBe('0xULTRON');
  });

  test('refuses to encrypt if intermediate == sweepDelegate (collapse guard)', async () => {
    const { sealEncryptColdDest } = await import('../sneasel-guest.js');
    await expect(
      sealEncryptColdDest({
        intermediateAddr: '0xULTRON',
        chain: 'eth',
        parentHash: parentHash32(),
        labelBytes: new TextEncoder().encode('amazon'),
        sweepDelegate: '0xULTRON',
      }),
    ).rejects.toThrow(/Ice Fang collapse/);
  });

  test('two guests of same parent produce different Seal identities', async () => {
    captured.length = 0;
    const { sealEncryptColdDest } = await import('../sneasel-guest.js');
    const parent = parentHash32();
    await sealEncryptColdDest({
      intermediateAddr: '0xINT_A',
      chain: 'eth',
      parentHash: parent,
      labelBytes: new TextEncoder().encode('amazon'),
      sweepDelegate: '0xULTRON',
    });
    await sealEncryptColdDest({
      intermediateAddr: '0xINT_B',
      chain: 'eth',
      parentHash: parent,
      labelBytes: new TextEncoder().encode('venmo'),
      sweepDelegate: '0xULTRON',
    });
    expect(captured.length).toBe(2);
    expect(captured[0].id).not.toBe(captured[1].id);
    // Sanity: the intermediates differ, so the sealed plaintexts
    // also differ — this is the cryptographic per-guest property.
    const payloadA = JSON.parse(new TextDecoder().decode(captured[0].data));
    const payloadB = JSON.parse(new TextDecoder().decode(captured[1].data));
    expect(payloadA.intermediateAddr).not.toBe(payloadB.intermediateAddr);
  });
});

describe('mintGuestIntermediateDryRun (Icy Wind preview)', () => {
  test('returns a stable, per-(parent,label) preview address', async () => {
    const { mintGuestIntermediateDryRun } = await import('../sneasel-guest.js');
    const a = mintGuestIntermediateDryRun({
      chain: 'eth',
      parentHash: parentHash32(),
      label: 'amazon',
    });
    const b = mintGuestIntermediateDryRun({
      chain: 'eth',
      parentHash: parentHash32(),
      label: 'venmo',
    });
    expect(a.previewAddr).toContain('ICY_WIND_PREVIEW_');
    expect(b.previewAddr).toContain('ICY_WIND_PREVIEW_');
    expect(a.previewAddr).not.toBe(b.previewAddr);
    expect(a.curve).toBe('secp256k1');
  });

  test('picks ed25519 for sol, secp256k1 for eth', async () => {
    const { mintGuestIntermediateDryRun } = await import('../sneasel-guest.js');
    const sol = mintGuestIntermediateDryRun({ chain: 'sol', parentHash: parentHash32(), label: 'x' });
    const eth = mintGuestIntermediateDryRun({ chain: 'eth', parentHash: parentHash32(), label: 'x' });
    expect(sol.curve).toBe('ed25519');
    expect(eth.curve).toBe('secp256k1');
  });

  test('same inputs → identical seed (deterministic keeper re-derivation)', async () => {
    const { deriveIcyWindSeed } = await import('../sneasel-guest.js');
    const s1 = deriveIcyWindSeed({ parentHash: parentHash32(), label: 'amazon', chain: 'eth' });
    const s2 = deriveIcyWindSeed({ parentHash: parentHash32(), label: 'amazon', chain: 'eth' });
    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
    expect(s1.length).toBe(32);
  });
});

describe('mintGuestIntermediate (real DKG path — env guards)', () => {
  test('real DKG path requires SUIAMI_STEALTH_PKG + network (callbacks required)', async () => {
    const { mintGuestIntermediate } = await import('../sneasel-guest.js');
    // Missing callbacks.signerAddress — must fail fast, never reach IKA net.
    await expect(
      mintGuestIntermediate({
        chain: 'eth',
        parentHash: parentHash32(),
        label: 'amazon',
        sweepDelegate: '0xULTRON_SUI',
        // @ts-expect-error — intentionally malformed to hit the guard
        callbacks: {},
      }),
    ).rejects.toThrow(/signerAddress required/);
  });
});
