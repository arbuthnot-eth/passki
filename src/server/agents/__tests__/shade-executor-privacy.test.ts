// ShadeExecutorAgent privacy: an order's domain and commitment salt are
// visible only to the owner (WebSocket that authenticated with an owner
// proof, an HTTP owner proof, or the internal token), and only the owner
// can cancel, reset, reap or schedule sweeps.

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';

let ShadeExecutorAgent: any;
let verifyOwnerProof: typeof import('../../owner-proof.js').verifyOwnerProof;
let internalAuthToken: typeof import('../../ultron-key.js').internalAuthToken;

beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
  // Bun shares module mocks across files; rely only on a constructible base.
  mock.module('agents', () => ({
    Agent: class { alarm = async () => {}; },
    callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d,
  }));
  ({ ShadeExecutorAgent } = await import('../shade-executor.js'));
  ({ verifyOwnerProof } = await import('../../owner-proof.js'));
  ({ internalAuthToken } = await import('../../ultron-key.js'));
});

const owner = Ed25519Keypair.generate();
const stranger = Ed25519Keypair.generate();
const OWNER = owner.toSuiAddress();

type Conn = { id: string; state: unknown; sent: string[]; setState(s: unknown): void; send(m: string): void };
const conn = (id: string): Conn => ({ id, state: null, sent: [], setState(s) { this.state = s; }, send(m) { this.sent.push(m); } });

function sessionMessage(addr: string, expires = new Date(Date.now() + 86_400_000)) {
  return `.SKI Once, Everywhere\n\n${addr}\n\nURI: https://sui.ski\nVersion: 2\nNonce: n\nExpires At: ${expires.toISOString()}\n\nThis signature activates your .SKI session and costs no gas.`;
}
async function proof(kp: Ed25519Keypair, addr = kp.toSuiAddress(), expires?: Date) {
  const message = sessionMessage(addr, expires);
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message));
  return { message, signature };
}
const header = (p: unknown) => toBase64(new TextEncoder().encode(JSON.stringify(p)));

const ORDER = {
  objectId: '0x' + '9'.repeat(64), domain: 'secretname', executeAfterMs: Date.now() + 3_600_000,
  targetAddress: OWNER, salt: 'deadbeef', ownerAddress: OWNER, depositMist: '1000',
  status: 'pending', retries: 0, createdAt: Date.now(),
};

let current: Conn | undefined;
let connections: Conn[] = [];
const ENV = { ULTRON_PRIVATE_KEY: Ed25519Keypair.generate().getSecretKey() };

function make(): any {
  const a: any = new ShadeExecutorAgent({} as any, ENV as any);
  a.name = OWNER;
  a.env = ENV;
  a.state = { orders: [{ ...ORDER }] };
  a.setState = (s: unknown) => { a.validateStateChange(s, 'server'); a.state = s; a.onStateChanged(); };
  a.currentConnection = () => current;
  a.getConnections = () => connections;
  a.scheduleNextAlarm = () => {};
  return a;
}

describe('owner proof', () => {
  test('accepts the stored sign-in proof for the named address', async () => {
    expect(await verifyOwnerProof(await proof(owner), OWNER)).toBeGreaterThan(Date.now());
  });
  test('rejects another key, another address, expiry, and junk', async () => {
    expect(await verifyOwnerProof(await proof(stranger, OWNER), OWNER)).toBeNull(); // signed by the wrong key
    expect(await verifyOwnerProof(await proof(stranger), OWNER)).toBeNull();        // names a different address
    expect(await verifyOwnerProof(await proof(owner, OWNER, new Date(Date.now() - 1)), OWNER)).toBeNull();
    expect(await verifyOwnerProof({ message: '.SKI', signature: 'x' }, OWNER)).toBeNull();
    expect(await verifyOwnerProof(null, OWNER)).toBeNull();
  });
});

describe('ShadeExecutorAgent privacy', () => {
  test('never sends state automatically to a new connection', () => {
    expect(make().shouldSendProtocolMessages()).toBe(false);
  });

  test('strangers learn nothing over WebSocket and cannot mutate', async () => {
    const a = make();
    current = conn('stranger');
    expect(await a.getOrders()).toEqual({ orders: [] });
    expect(await a.getStatus({ objectId: ORDER.objectId })).toBeNull();
    expect(JSON.stringify(await a.poke())).not.toContain('secretname');
    expect((await a.authenticate(await proof(stranger))).success).toBe(false);
    expect((await a.cancel({ objectId: 'all', ownerAddress: OWNER })).success).toBe(false);
    expect((await a.resetFailed({ force: true })).reset).toBe(0);
    expect((await a.scheduleSweep({ nameHash: '00', domain: 'x' })).success).toBe(false);
    expect((await a.reapCancelled({ objectId: ORDER.objectId })).success).toBe(false);
    expect(a.state.orders).toHaveLength(1);
  });

  test('the authenticated owner gets state pushed, and only they do', async () => {
    const a = make();
    const mine = conn('owner');
    const theirs = conn('stranger');
    connections = [mine, theirs];
    current = mine;
    expect((await a.authenticate(await proof(owner))).success).toBe(true);
    expect(mine.sent.at(-1)).toContain('deadbeef'); // owner can recover the salt cross-device
    expect((await a.getOrders()).orders).toHaveLength(1);

    expect((await a.cancel({ objectId: ORDER.objectId })).success).toBe(true);
    expect(mine.sent.length).toBe(2);       // pushed on change
    expect(theirs.sent).toEqual([]);         // never to others
    connections = [];
  });

  test('HTTP status needs an owner proof or the internal token', async () => {
    const a = make();
    const get = (headers: Record<string, string> = {}) => a.onRequest(new Request('https://x/?status', { headers }));

    expect((await get()).status).toBe(401);
    expect((await get({ 'x-ski-owner-proof': header(await proof(stranger)) })).status).toBe(401);
    expect((await get({ 'x-treasury-auth': OWNER.slice(0, 34) })).status).toBe(401); // the old public-derived token

    const ok = await get({ 'x-ski-owner-proof': header(await proof(owner)) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('deadbeef');
    expect((await get({ 'x-treasury-auth': internalAuthToken(ENV) })).status).toBe(200);
  });

  test('HTTP poke hides domains from strangers; HTTP cancel needs auth', async () => {
    const a = make();
    const poke = await (await a.onRequest(new Request('https://x/?poke'))).text();
    expect(poke).not.toContain('secretname');
    const cancel = await a.onRequest(new Request('https://x/?cancel', { method: 'POST', body: JSON.stringify({ objectId: 'all' }) }));
    expect(cancel.status).toBe(401);
    expect(a.state.orders).toHaveLength(1);
  });

  test('client-originated state writes are rejected', () => {
    expect(() => make().validateStateChange({ orders: [] }, conn('x'))).toThrow();
  });
});
