import { describe, expect, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { internalAuthToken, constantTimeEqual } from '../ultron-key.js';

const kp = Ed25519Keypair.generate();
const env = { ULTRON_PRIVATE_KEY: kp.getSecretKey() };

describe('internalAuthToken', () => {
  test('is not derivable from the public address (the old token was)', () => {
    const token = internalAuthToken(env);
    const addr = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
    expect(token).not.toBe(addr.slice(0, 34));
    expect(addr.includes(token)).toBe(false);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic, so the Worker and Durable Objects agree', () => {
    expect(internalAuthToken(env)).toBe(internalAuthToken({ ...env }));
  });

  test('prefers a dedicated INTERNAL_AUTH_SECRET when set', () => {
    const withSecret = internalAuthToken({ ...env, INTERNAL_AUTH_SECRET: 'rotate-me' });
    expect(withSecret).not.toBe(internalAuthToken(env));
    expect(withSecret).toBe(internalAuthToken({ INTERNAL_AUTH_SECRET: 'rotate-me' }));
  });

  test('is empty (deny) when no secret is configured', () => {
    expect(internalAuthToken({})).toBe('');
  });
});

describe('constantTimeEqual', () => {
  test('matches only identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  test('never accepts empty or missing values', () => {
    expect(constantTimeEqual('', '')).toBe(false);
    expect(constantTimeEqual(null, 'x')).toBe(false);
    expect(constantTimeEqual(undefined, undefined)).toBe(false);
  });
});
