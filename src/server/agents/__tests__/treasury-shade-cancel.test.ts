// Shade cancels through ultron: ultron owns treasury-created orders on-chain,
// so the route must not let a stranger cancel someone's order or redirect the
// refund. Only the holder recorded at create time (proved with the stored
// .SKI sign-in) or an admin may cancel, and refunds go back to the holder.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { internalAuthToken } from '../../ultron-key.js';

const ultron = Ed25519Keypair.generate();
const holder = Ed25519Keypair.generate();
const attacker = Ed25519Keypair.generate();
const ENV = { ULTRON_PRIVATE_KEY: ultron.getSecretKey(), SHADE_KEEPER_PRIVATE_KEY: ultron.getSecretKey() };
const TOKEN = internalAuthToken(ENV);
const ORDER = '0x' + '7'.repeat(64);

let TreasuryAgents: any;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
  mock.module('agents', () => ({
    Agent: class { alarm = async () => {}; },
    callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d,
    getCurrentAgent: () => ({}),
  }));
  ({ TreasuryAgents } = await import('../treasury-agents.js'));
  // GraphQL: the order is a shared StableShadeOrder owned by ultron. Any
  // other query (tx building) fails, which is fine: we only assert on the
  // authorization decision, which comes first.
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const q = String(init?.body ?? '');
    if (q.includes('initialSharedVersion') && q.includes('StableShadeOrder') === false && q.includes(ORDER)) {
      return Response.json({ data: { object: {
        owner: { __typename: 'Shared', initialSharedVersion: 5 },
        asMoveObject: { contents: {
          type: { repr: '0x9978db0aa0283b4f9fee41a0b98bff91cfed548693766e2036317f9ee77e3837::shade::StableShadeOrder<0x2::iusd::IUSD>' },
          json: { owner: ultron.toSuiAddress(), deposit: '100' },
        } },
      } } });
    }
    return new Response('nope', { status: 500 });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

async function proof(kp: Ed25519Keypair) {
  const message = `.SKI Once, Everywhere\n\n${kp.toSuiAddress()}\n\nExpires At: ${new Date(Date.now() + 3_600_000).toISOString()}\n`;
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message));
  return toBase64(new TextEncoder().encode(JSON.stringify({ message, signature })));
}

function agent(shades: unknown[]) {
  const a: any = new TreasuryAgents({} as any, ENV as any);
  a.env = ENV;
  a.state = { shades };
  a.setState = (s: unknown) => { a.state = s; };
  return a;
}
const rows = () => [{ objectId: ORDER, domain: 'secretname', holder: holder.toSuiAddress(), status: 'active', depositMist: '100' }];

async function call(a: any, route: string, body: unknown, headers: Record<string, string> = {}) {
  const res: Response = await a.onRequest(new Request(`https://treasury-do/?${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-treasury-auth': TOKEN, ...headers },
    body: JSON.stringify(body),
  }));
  return res.status;
}

describe('shade-cancel-stable authorization', () => {
  test('a stranger cannot cancel, with or without their own proof', async () => {
    expect(await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER, forwardToAddress: attacker.toSuiAddress() })).toBe(403);
    expect(await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER }, { 'x-ski-owner-proof': await proof(attacker) })).toBe(403);
  });

  test('even the holder cannot send the refund elsewhere or strand it on ultron', async () => {
    const p = { 'x-ski-owner-proof': await proof(holder) };
    expect(await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER, forwardToAddress: attacker.toSuiAddress() }, p)).toBe(403);
    expect(await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER, noForward: true }, p)).toBe(403);
  });

  test('orders with no recorded holder are admin-only', async () => {
    expect(await call(agent([]), 'shade-cancel-stable', { objectId: ORDER }, { 'x-ski-owner-proof': await proof(holder) })).toBe(403);
  });

  test('the holder, or an admin, gets past authorization', async () => {
    const holderStatus = await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER, forwardToAddress: holder.toSuiAddress() }, { 'x-ski-owner-proof': await proof(holder) });
    expect(holderStatus).not.toBe(403);
    const adminStatus = await call(agent([]), 'shade-cancel-stable', { objectId: ORDER, noForward: true }, { 'x-ski-as-admin': TOKEN });
    expect(adminStatus).not.toBe(403);
  });

  test('a public-derived admin voucher does not count', async () => {
    expect(await call(agent(rows()), 'shade-cancel-stable', { objectId: ORDER, noForward: true }, { 'x-ski-as-admin': ultron.toSuiAddress().slice(0, 34) })).toBe(403);
  });
});

describe('legacy shade-cancel authorization', () => {
  const body = () => ({ domain: 'secretname', holder: holder.toSuiAddress() });
  test('public domain + holder are not enough', async () => {
    const a = agent(rows());
    expect(await call(a, 'shade-cancel', body())).toBe(403);
    expect(await call(a, 'shade-cancel', body(), { 'x-ski-owner-proof': await proof(attacker) })).toBe(403);
    expect(a.state.shades[0].status).toBe('active');
  });
  test('the holder can cancel', async () => {
    expect(await call(agent(rows()), 'shade-cancel', body(), { 'x-ski-owner-proof': await proof(holder) })).not.toBe(403);
  });
});
