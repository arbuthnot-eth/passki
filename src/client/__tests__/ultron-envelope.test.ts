import { describe, test, expect } from 'bun:test';
import {
  buildTransferEnvelope,
  buildPrismEnvelope,
  buildDwalletTransferEnvelope,
  serializeEnvelope,
  parseEnvelope,
  validateEnvelope,
  type UltronEnvelope,
} from '../ultron-envelope.js';

const SUI_HERMES = '0x' + 'aa'.repeat(32);

describe('buildTransferEnvelope', () => {
  test('builds a sui transfer envelope with whelmName', () => {
    const e = buildTransferEnvelope({
      coinType: '0x2::sui::SUI',
      amountMist: 1_000_000_000n,
      chain: 'sui',
      to: { whelmName: 'hermes' },
    });
    expect(e.version).toBe(1);
    expect(e.kind).toBe('transfer');
    expect(e.recipient.whelmName).toBe('hermes');
    expect(e.asset.amountMist).toBe('1000000000');
  });

  test('refuses without any recipient anchor', () => {
    expect(() =>
      buildTransferEnvelope({
        coinType: '0x2::sui::SUI',
        amountMist: 1n,
        chain: 'sui',
        to: {},
      }),
    ).toThrow(/recipient needs/);
  });

  test('accepts stealthMeta over whelmName', () => {
    const e = buildTransferEnvelope({
      coinType: '0x2::sui::SUI',
      amountMist: 1n,
      chain: 'sui',
      to: { stealthMeta: 'ska:0xabc:sui=def|' },
    });
    expect(e.recipient.stealthMeta).toContain('ska:');
  });
});

describe('buildPrismEnvelope', () => {
  test('requires prismRoute', () => {
    const e = buildPrismEnvelope({
      coinType: 'usdc-sol',
      amountMist: 1000n,
      fromChain: 'sol',
      mint: 'USDC',
      targetChain: 'eth',
      recipient: { whelmName: 'athena' },
    });
    expect(e.kind).toBe('prism');
    expect(e.extras?.prismRoute?.targetChain).toBe('eth');
  });
});

describe('buildDwalletTransferEnvelope', () => {
  test('builds dwallet-transfer envelope', () => {
    const e = buildDwalletTransferEnvelope({
      dwalletCapId: '0xDEAD',
      recipient: { whelmName: 'apollo' },
    });
    expect(e.kind).toBe('dwallet-transfer');
    expect(e.extras?.dwalletCapId).toBe('0xDEAD');
    expect(e.asset.coinType).toContain('DWalletCap');
  });

  test('refuses without dwalletCapId', () => {
    expect(() =>
      buildDwalletTransferEnvelope({
        // @ts-expect-error
        dwalletCapId: undefined,
        recipient: { whelmName: 'apollo' },
      }),
    ).toThrow(/dwalletCapId/);
  });
});

describe('validateEnvelope', () => {
  test('rejects unknown kind', () => {
    const e = { version: 1, kind: 'banana', asset: { coinType: 'x', amountMist: '1' }, recipient: { chain: 'sui', address: SUI_HERMES }, submittedAtMs: 0 } as unknown as UltronEnvelope;
    expect(() => validateEnvelope(e)).toThrow(/invalid kind/);
  });

  test('rejects non-bigint amountMist', () => {
    const e: UltronEnvelope = {
      version: 1, kind: 'transfer',
      asset: { coinType: 'x', amountMist: 'notanumber' },
      recipient: { chain: 'sui', address: SUI_HERMES },
      submittedAtMs: 0,
    };
    expect(() => validateEnvelope(e)).toThrow(/BigInt/);
  });

  test('rejects unknown chain', () => {
    const e = {
      version: 1, kind: 'transfer',
      asset: { coinType: 'x', amountMist: '1' },
      recipient: { chain: 'tron', address: '0xtron' },
      submittedAtMs: 0,
    } as unknown as UltronEnvelope;
    expect(() => validateEnvelope(e)).toThrow(/recipient.chain/);
  });
});

describe('serializeEnvelope / parseEnvelope', () => {
  test('round-trips identically', () => {
    const e = buildTransferEnvelope({
      coinType: '0x2::sui::SUI',
      amountMist: 42n,
      chain: 'sui',
      to: { whelmName: 'hermes' },
      memo: 'for coffee',
    });
    const bytes = serializeEnvelope(e);
    const parsed = parseEnvelope(bytes);
    expect(parsed.kind).toBe(e.kind);
    expect(parsed.recipient.whelmName).toBe('hermes');
    expect(parsed.extras?.memo).toBe('for coffee');
    expect(parsed.asset.amountMist).toBe('42');
  });

  test('deterministic encoding for identical input (Seal-identity-safe)', () => {
    const e1 = buildTransferEnvelope({
      coinType: '0x2::sui::SUI',
      amountMist: 1n,
      chain: 'sui',
      to: { whelmName: 'hermes' },
    });
    const e2 = { ...e1, submittedAtMs: e1.submittedAtMs };
    expect(Buffer.from(serializeEnvelope(e1)).toString('hex'))
      .toBe(Buffer.from(serializeEnvelope(e2)).toString('hex'));
  });
});
