// A client can't become ultron by putting ultron's (public) address in a
// request body that a Worker route forwards to the treasury.

import { describe, expect, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { stripUntrustedCaller } from '../caller-trust.js';
import { internalAuthToken } from '../ultron-key.js';

const env = { ULTRON_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey() };
const ULTRON = '0x' + 'a'.repeat(64);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://treasury-do/?pre-rumble', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('stripUntrustedCaller', () => {
  test('drops a client-supplied callerAddress and keeps everything else', async () => {
    const r = await stripUntrustedCaller(post({ name: 'x', userAddress: '0xb', callerAddress: ULTRON }), env);
    expect(await r.json()).toEqual({ name: 'x', userAddress: '0xb' });
    expect(r.headers.get('content-type')).toBe('application/json');
  });

  test('keeps it when the Worker vouches with the internal token', async () => {
    const r = await stripUntrustedCaller(post({ callerAddress: ULTRON }, { 'x-ski-as-ultron': internalAuthToken(env) }), env);
    expect(await r.json()).toEqual({ callerAddress: ULTRON });
  });

  test('a guessed or public-derived voucher does not count', async () => {
    for (const v of ['1', 'true', ULTRON.slice(0, 34)]) {
      const r = await stripUntrustedCaller(post({ callerAddress: ULTRON }, { 'x-ski-as-ultron': v }), env);
      expect(await r.json()).toEqual({});
    }
  });

  test('leaves other requests untouched', async () => {
    const get = new Request('https://treasury-do/?cache-state');
    expect(await stripUntrustedCaller(get, env)).toBe(get);
    const plain = post({ name: 'x' });
    expect(await stripUntrustedCaller(plain, env)).toBe(plain);
  });
});
