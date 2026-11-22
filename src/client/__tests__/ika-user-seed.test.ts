import { describe, expect, test, beforeEach } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import {
  deriveUserEncryptionSeed, clearUserEncryptionSeed, NonDeterministicWalletError, userSeedMessage,
} from '../ika-user-seed.js';

const kp = Ed25519Keypair.generate();
const addr = kp.toSuiAddress();
const deterministic = async (m: Uint8Array) => ({ signature: (await kp.signPersonalMessage(m)).signature });

describe('deriveUserEncryptionSeed', () => {
  beforeEach(() => clearUserEncryptionSeed());

  test('same wallet + address always yields the same 32-byte seed', async () => {
    const a = await deriveUserEncryptionSeed(addr, deterministic, { verify: true });
    clearUserEncryptionSeed();
    const b = await deriveUserEncryptionSeed(addr, deterministic, { verify: false });
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('rejects a wallet whose signatures are not deterministic', async () => {
    let n = 0;
    const random = async () => ({ signature: toBase64(new Uint8Array(97).fill(++n)) });
    await expect(deriveUserEncryptionSeed(addr, random, { verify: true })).rejects.toBeInstanceOf(NonDeterministicWalletError);
  });

  test('caches per address so it prompts once per session', async () => {
    let calls = 0;
    const counting = async (m: Uint8Array) => { calls++; return deterministic(m); };
    await deriveUserEncryptionSeed(addr, counting, { verify: true });
    await deriveUserEncryptionSeed(addr, counting, { verify: true });
    expect(calls).toBe(2);
  });

  test('message is bound to the address', () => {
    expect(new TextDecoder().decode(userSeedMessage(addr))).toContain(addr.toLowerCase());
  });
});
