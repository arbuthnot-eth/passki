// SponsorAgent authorization: sponsor rights belong to the WebSocket that
// proved key ownership, never to a claimed address; signatures and digests
// are checked cryptographically; and clients can't write agent state.

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';

type Conn = { id: string; state: unknown; setState(s: unknown): void };
let current: Conn | undefined;
const conn = (id: string): Conn => ({ id, state: null, setState(s) { this.state = s; } });


mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));

let SponsorAgent: typeof import('../sponsor.js').SponsorAgent;
let parseSignedExpiry: typeof import('../sponsor.js').parseSignedExpiry;
beforeAll(async () => {
  // Bun shares module mocks across test files, so whichever 'agents' stub
  // loaded first wins. Only rely on a constructible Agent base; `make()`
  // below wires up state, name and the current connection itself.
  mock.module('agents', () => ({
    Agent: class {},
    callable: () => (_t: unknown, _k: string, d: PropertyDescriptor) => d,
  }));

  ({ SponsorAgent, parseSignedExpiry } = await import('../sponsor.js'));
});

const sponsor = Ed25519Keypair.generate();
const user = Ed25519Keypair.generate();
const attacker = Ed25519Keypair.generate();
const SPONSOR = sponsor.toSuiAddress();

function authMessage(expires = new Date(Date.now() + 86_400_000)) {
  return `.SKI 7d Splash (0.05 💧/tx)\n\n${SPONSOR}\n\nExpires At: ${expires.toISOString()}\nNonce: n`;
}

function make(): any {
  const agent: any = new SponsorAgent({} as any, {} as any);
  agent.state = structuredClone(agent.initialState);
  agent.setState = (s: unknown) => { agent.validateStateChange(s, 'server'); agent.state = s; };
  agent.currentConnection = () => current;
  agent.name = SPONSOR;
  agent.env = {};
  return agent;
}

async function registered() {
  const agent = make();
  const msg = authMessage();
  const { signature } = await sponsor.signPersonalMessage(new TextEncoder().encode(msg));
  const owner = conn('owner');
  current = owner;
  const r = await agent.register({ sponsorAddress: SPONSOR, authSignature: signature, authMessage: msg });
  expect(r.success).toBe(true);
  return { agent, owner, msg, signature };
}

async function sponsoredTxBytes() {
  const tx = new Transaction();
  tx.setSender(user.toSuiAddress());
  tx.setGasOwner(SPONSOR);
  tx.setGasPayment([{ objectId: '0x' + '1'.repeat(64), version: '1', digest: '11111111111111111111111111111111' }]);
  tx.setGasBudget(10_000_000);
  tx.setGasPrice(1000);
  return tx.build();
}

describe('SponsorAgent auth', () => {
  test('a claimed callerAddress grants nothing on another connection', async () => {
    const { agent } = await registered();
    current = conn('attacker');
    expect((await agent.addEntry({ address: attacker.toSuiAddress(), callerAddress: SPONSOR })).success).toBe(false);
    expect((await agent.enableUltronMode({ callerAddress: SPONSOR })).success).toBe(false);
    expect((await agent.deactivate({ callerAddress: SPONSOR })).success).toBe(false);
    expect((await agent.refreshGasCoins({ coins: [] })).success).toBe(false);
    expect(agent.state.approvedList).toEqual([]);
    expect(agent.state.active).toBe(true);
  });

  test('the registering connection can manage the sponsor list', async () => {
    const { agent, owner } = await registered();
    current = owner;
    expect((await agent.addEntry({ address: user.toSuiAddress() })).success).toBe(true);
    expect(agent.state.approvedList).toEqual([user.toSuiAddress()]);
  });

  test('the auth signature is never kept in (broadcast) state', async () => {
    const { agent, signature } = await registered();
    expect(JSON.stringify(agent.state)).not.toContain(signature);
  });

  test('cannot register a different address in this sponsor’s agent', async () => {
    const agent = make();
    const msg = authMessage().replace(SPONSOR, attacker.toSuiAddress());
    const { signature } = await attacker.signPersonalMessage(new TextEncoder().encode(msg));
    current = conn('attacker');
    const r = await agent.register({ sponsorAddress: attacker.toSuiAddress(), authSignature: signature, authMessage: msg });
    expect(r.success).toBe(false);
  });

  test('an expired signed authorization is refused', async () => {
    const agent = make();
    const msg = authMessage(new Date(Date.now() - 1000));
    const { signature } = await sponsor.signPersonalMessage(new TextEncoder().encode(msg));
    current = conn('owner');
    expect((await agent.register({ sponsorAddress: SPONSOR, authSignature: signature, authMessage: msg })).success).toBe(false);
  });

  test('junk signatures cannot squat a request, real ones are accepted', async () => {
    const { agent } = await registered();
    const bytes = await sponsoredTxBytes();
    current = conn('user');
    const { requestId } = await agent.requestSponsorship({ senderAddress: user.toSuiAddress(), txBytes: toBase64(bytes) });

    const forged = (await attacker.signTransaction(bytes)).signature;
    expect((await agent.submitUserSignature({ requestId, userSig: forged })).success).toBe(false);
    expect((await agent.submitSponsorSignature({ requestId, sponsorSig: forged })).success).toBe(false);

    expect((await agent.submitUserSignature({ requestId, userSig: (await user.signTransaction(bytes)).signature })).success).toBe(true);
    expect((await agent.submitSponsorSignature({ requestId, sponsorSig: (await sponsor.signTransaction(bytes)).signature })).success).toBe(true);

    // markSubmitted only accepts the digest those bytes actually hash to.
    expect((await agent.markSubmitted({ requestId, digest: 'x' })).success).toBe(false);
    const { TransactionDataBuilder } = await import('@mysten/sui/transactions');
    expect((await agent.markSubmitted({ requestId, digest: TransactionDataBuilder.getDigestFromBytes(bytes) })).success).toBe(true);
  });

  test('client-originated state writes are rejected', async () => {
    const { agent } = await registered();
    expect(() => agent.validateStateChange({ ...agent.state, ultronMode: true }, conn('attacker'))).toThrow();
    expect(() => agent.validateStateChange(agent.state, 'server')).not.toThrow();
  });

  test('parseSignedExpiry reads the signed Expires At line', () => {
    expect(parseSignedExpiry('x\nExpires At: 2026-11-29T00:00:00.000Z\nNonce: n')).toBe(Date.UTC(2026, 10, 29));
    expect(parseSignedExpiry('no expiry here')).toBeNull();
    expect(parseSignedExpiry('Expires At: not-a-date')).toBeNull();
  });
});
