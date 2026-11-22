// Treasury intents (send-iusd-v2, bam-mint-v2) spend or mint treasury funds,
// so a valid signature is not enough: the signer must be authorized.
// Before the fix, any freshly generated keypair could sign
// { recipient: me, amountMist: everything } and the Worker relayed it.

import { describe, expect, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64, toHex } from '@mysten/sui/utils';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalizeIntent, verifyVectorIntent, authorizedSigners } from '../vector-intent.js';

const ultron = Ed25519Keypair.generate();
const operator = Ed25519Keypair.generate();
const attacker = Ed25519Keypair.generate();

let nonceCalls = 0;
function ctx(extra: Record<string, unknown> = {}) {
  const stub = { fetch: async () => { nonceCalls++; return new Response('{}', { status: 200 }); } };
  return {
    env: {
      ULTRON_PRIVATE_KEY: ultron.getSecretKey(),
      TreasuryAgents: { idFromName: () => 'id', get: () => stub },
      ...extra,
    },
  } as any;
}

async function signed(kp: Ed25519Keypair, intent: Record<string, unknown>) {
  const digest = sha256(new TextEncoder().encode(canonicalizeIntent(intent)));
  const signature = await kp.sign(digest);
  return { intent, signature: toBase64(signature), publicKey: toBase64(kp.getPublicKey().toRawBytes()) };
}

const intent = () => ({ recipient: '0x' + 'c'.repeat(64), amountMist: '1000000000000000', nonce: crypto.randomUUID(), expiresMs: Date.now() + 60_000 });

describe('verifyVectorIntent signer authorization', () => {
  test('a valid signature from an arbitrary key is refused before the nonce is touched', async () => {
    nonceCalls = 0;
    const r = await verifyVectorIntent(ctx(), await signed(attacker, intent()), ['recipient', 'amountMist']);
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(nonceCalls).toBe(0);
  });

  test("ultron's own key is authorized", async () => {
    const r = await verifyVectorIntent(ctx(), await signed(ultron, intent()), ['recipient', 'amountMist']);
    expect(r.ok).toBe(true);
  });

  test('operator keys listed in VECTOR_INTENT_SIGNERS are authorized (hex or base64)', async () => {
    const hex = toHex(operator.getPublicKey().toRawBytes());
    expect((await verifyVectorIntent(ctx({ VECTOR_INTENT_SIGNERS: hex }), await signed(operator, intent()), ['recipient'])).ok).toBe(true);
    const b64 = toBase64(operator.getPublicKey().toRawBytes());
    expect((await verifyVectorIntent(ctx({ VECTOR_INTENT_SIGNERS: `junk, ${b64}` }), await signed(operator, intent()), ['recipient'])).ok).toBe(true);
  });

  test('no configured key means nobody is authorized', () => {
    expect(authorizedSigners({}).size).toBe(0);
  });

  test('a tampered intent still fails the signature check', async () => {
    const body = await signed(ultron, intent());
    (body.intent as any).recipient = '0x' + 'd'.repeat(64);
    expect((await verifyVectorIntent(ctx(), body, ['recipient'])).ok).toBe(false);
  });
});
