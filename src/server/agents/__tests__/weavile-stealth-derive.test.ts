/**
 * Unit tests for weavile-stealth-derive helpers. Covers:
 *   - Sui address encoding from an ed25519 pubkey (standard Sui spec:
 *     blake2b-256(flag=0x00 || pubkey), truncated, 0x-prefixed).
 *   - deriveSuiStealthForEvent determinism + mismatch-on-different-ephemeral.
 *
 * Pure crypto, no network.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  suiAddressFromEd25519Pubkey,
  deriveSuiStealthForEvent,
  deriveStealthForEvent,
  SUI_SIG_FLAG_ED25519,
} from '../weavile-stealth-derive.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

describe('suiAddressFromEd25519Pubkey', () => {
  test('matches the Sui spec (blake2b-256 over [flag=0x00 || pubkey])', () => {
    // Pin an arbitrary 32-byte pubkey, compute the expected address
    // by re-implementing the spec inline, and assert our helper agrees.
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i;
    const input = new Uint8Array(33);
    input[0] = SUI_SIG_FLAG_ED25519;
    input.set(pub, 1);
    const expected = '0x' + hex(blake2b(input, { dkLen: 32 }));
    expect(suiAddressFromEd25519Pubkey(pub)).toBe(expected);
  });

  test('produces a 0x-prefixed 64 hex char string', () => {
    const pub = ed25519.utils.randomSecretKey();
    const fullPub = ed25519.getPublicKey(pub);
    const addr = suiAddressFromEd25519Pubkey(fullPub);
    expect(addr).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('rejects non-32-byte pubkey', () => {
    expect(() => suiAddressFromEd25519Pubkey(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  test('different pubkeys yield different addresses', () => {
    const a = suiAddressFromEd25519Pubkey(new Uint8Array(32).fill(1));
    const b = suiAddressFromEd25519Pubkey(new Uint8Array(32).fill(2));
    expect(a).not.toBe(b);
  });
});

describe('deriveSuiStealthForEvent', () => {
  // Use deterministic test seeds so the same inputs always produce the
  // same stealth address. Recipient holds (viewPriv, spendPub); sender
  // generates a per-payment ephemeral.
  const viewPriv = new Uint8Array(32).fill(0x11);
  const spendSeed = new Uint8Array(32).fill(0x22);
  const spendPub = ed25519.getPublicKey(spendSeed);

  const ephSeed = new Uint8Array(32).fill(0x33);
  const ephPub = ed25519.getPublicKey(ephSeed);

  test('returns suiAddress on view-tag match', () => {
    // Compute the expected view tag by running the non-Sui path,
    // pass it in so we force a match.
    const probe = deriveStealthForEvent({
      ephemeralPub: ephPub, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const result = deriveSuiStealthForEvent({
      ephemeralPub: ephPub, viewTag: probe.derivedViewTag, viewPriv, spendPub,
    });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.suiAddress).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.tweakHex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('deterministic across calls with identical inputs', () => {
    const probe = deriveStealthForEvent({
      ephemeralPub: ephPub, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const r1 = deriveSuiStealthForEvent({
      ephemeralPub: ephPub, viewTag: probe.derivedViewTag, viewPriv, spendPub,
    });
    const r2 = deriveSuiStealthForEvent({
      ephemeralPub: ephPub, viewTag: probe.derivedViewTag, viewPriv, spendPub,
    });
    expect(r1.matched && r2.matched).toBe(true);
    if (r1.matched && r2.matched) {
      expect(r1.suiAddress).toBe(r2.suiAddress);
      expect(r1.tweakHex).toBe(r2.tweakHex);
    }
  });

  test('different ephemeralPub → different suiAddress', () => {
    const altEph = ed25519.getPublicKey(new Uint8Array(32).fill(0x44));
    const probe1 = deriveStealthForEvent({
      ephemeralPub: ephPub, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const probe2 = deriveStealthForEvent({
      ephemeralPub: altEph, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const r1 = deriveSuiStealthForEvent({
      ephemeralPub: ephPub, viewTag: probe1.derivedViewTag, viewPriv, spendPub,
    });
    const r2 = deriveSuiStealthForEvent({
      ephemeralPub: altEph, viewTag: probe2.derivedViewTag, viewPriv, spendPub,
    });
    expect(r1.matched && r2.matched).toBe(true);
    if (r1.matched && r2.matched) {
      expect(r1.suiAddress).not.toBe(r2.suiAddress);
    }
  });

  test('view-tag miss short-circuits without computing stealth addr', () => {
    // Force a mismatch by flipping the view tag. Result should be
    // { matched: false, derivedViewTag } with no suiAddress field.
    const probe = deriveStealthForEvent({
      ephemeralPub: ephPub, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const wrongTag = (probe.derivedViewTag + 1) & 0xff;
    const result = deriveSuiStealthForEvent({
      ephemeralPub: ephPub, viewTag: wrongTag, viewPriv, spendPub,
    });
    expect(result.matched).toBe(false);
  });

  test('hex string inputs work the same as Uint8Array inputs', () => {
    const ephPubHex = '0x' + hex(ephPub);
    const spendPubHex = '0x' + hex(spendPub);
    const viewPrivHex = '0x' + hex(viewPriv);
    const probe = deriveStealthForEvent({
      ephemeralPub: ephPub, viewTag: 0, viewPriv, spendPub, curve: 'ed25519',
    });
    const hexResult = deriveSuiStealthForEvent({
      ephemeralPub: ephPubHex,
      viewTag: probe.derivedViewTag,
      viewPriv: viewPrivHex,
      spendPub: spendPubHex,
    });
    const bytesResult = deriveSuiStealthForEvent({
      ephemeralPub: ephPub,
      viewTag: probe.derivedViewTag,
      viewPriv,
      spendPub,
    });
    expect(hexResult.matched && bytesResult.matched).toBe(true);
    if (hexResult.matched && bytesResult.matched) {
      expect(hexResult.suiAddress).toBe(bytesResult.suiAddress);
    }
  });
});

// Keep fromHex referenced even though none of the current tests use
// it directly — future vectors will.
void fromHex;
