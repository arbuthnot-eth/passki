import { describe, expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { evaluateSponsorTx } from '../sponsor-policy.js';

const SPONSOR = '0x' + 'a'.repeat(64);
const USER = '0x' + 'b'.repeat(64);
const ATTACKER = '0x' + 'c'.repeat(64);
const IOU_PKG = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const ref = (n: string) => ({ objectId: '0x' + n.repeat(64), version: '1', digest: '11111111111111111111111111111111' });

async function bytes(build: (tx: Transaction) => void, opts: { sender?: string; owner?: string; budget?: number } = {}) {
  const tx = new Transaction();
  tx.setSender(opts.sender ?? USER);
  tx.setGasOwner(opts.owner ?? SPONSOR);
  tx.setGasPayment([ref('1')]);
  tx.setGasBudget(opts.budget ?? 50_000_000);
  tx.setGasPrice(1000);
  build(tx);
  return tx.build();
}

describe('evaluateSponsorTx — refuses', () => {
  test('splitting the gas coin and sending it away', async () => {
    const b = await bytes(tx => { const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(5_000_000_000)]); tx.transferObjects([c], ATTACKER); });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: false });
  });
  test('transferring the gas coin itself', async () => {
    const b = await bytes(tx => { tx.transferObjects([tx.gas], ATTACKER); });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: false, reason: 'Gas coin cannot be transferred' });
  });
  test('passing the gas coin to a Move call', async () => {
    const b = await bytes(tx => { tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: ['0x2::sui::SUI'], arguments: [tx.gas] }); });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: false });
  });
  test('ultron as sender', async () => {
    const b = await bytes(tx => { tx.transferObjects([tx.objectRef(ref('2'))], ATTACKER); }, { sender: SPONSOR });
    expect(evaluateSponsorTx(b, SPONSOR, SPONSOR)).toMatchObject({ ok: false, reason: 'Sponsor cannot be the sender' });
  });
  test('senderAddress that does not match the tx sender', async () => {
    const b = await bytes(tx => { tx.moveCall({ target: '0x2::clock::timestamp_ms', arguments: [tx.object.clock()] }); }, { sender: ATTACKER });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: false, reason: 'senderAddress does not match transaction sender' });
  });
  test('ungated (no senderAddress) for anything but IOU claim/recall', async () => {
    const b = await bytes(tx => { tx.moveCall({ target: '0x2::clock::timestamp_ms', arguments: [tx.object.clock()] }); });
    expect(evaluateSponsorTx(b, SPONSOR)).toMatchObject({ ok: false, reason: 'senderAddress required for this transaction' });
  });
  test('oversized budget', async () => {
    const b = await bytes(() => {}, { budget: 5_000_000_000 });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: false, reason: 'Gas budget exceeds sponsor limit' });
  });
  test('garbage bytes', () => {
    expect(evaluateSponsorTx(new Uint8Array([1, 2, 3]), SPONSOR, USER)).toMatchObject({ ok: false });
  });
});

describe('evaluateSponsorTx — allows', () => {
  test('a gated tx that only uses the sender\'s own coins (DKG shape)', async () => {
    const b = await bytes(tx => {
      const [c] = tx.splitCoins(tx.objectRef(ref('3')), [tx.pure.u64(100_000_000)]);
      tx.transferObjects([c], USER);
    });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toEqual({ ok: true, sender: USER, gated: true });
  });
  test('a tiny literal split from gas (Pyth oracle fee)', async () => {
    const b = await bytes(tx => {
      const [fee] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
      tx.moveCall({ target: '0x2::coin::value', typeArguments: ['0x2::sui::SUI'], arguments: [fee] });
    });
    expect(evaluateSponsorTx(b, SPONSOR, USER)).toMatchObject({ ok: true });
  });
  test('ungated IOU claim', async () => {
    const b = await bytes(tx => {
      tx.moveCall({ target: `${IOU_PKG}::iou::claim`, arguments: [tx.sharedObjectRef({ objectId: ref('4').objectId, initialSharedVersion: 1, mutable: true }), tx.object.clock()] });
    });
    expect(evaluateSponsorTx(b, SPONSOR)).toEqual({ ok: true, sender: USER, gated: false });
  });
});
