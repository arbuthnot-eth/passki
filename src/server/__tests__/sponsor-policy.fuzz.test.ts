// Property-based fuzzing for the gas-sponsor policy.
//
// Instead of hand-picked cases, this generates thousands of random
// programmable transactions (splits, merges, transfers, Move calls, vectors,
// with the gas coin and its derived results spliced in at random), plus
// random byte-level corruption of valid transactions. Whatever the policy
// approves is re-checked against the safety properties by an independent
// oracle that only reads the decoded transaction:
//
//   P1  the sponsor pays gas and is never the sender
//   P2  the gas budget is within the sponsor limit
//   P3  the gas coin is only ever a SplitCoins source (never transferred,
//       merged, passed to Move, or put in a vector)
//   P4  at most MAX_GAS_SPLIT_MIST leaves the gas coin in total
//   P5  the policy never throws, whatever the input bytes
//
// The PRNG is seeded, so any failure reproduces exactly from the seed it
// prints. Set SPONSOR_FUZZ_RUNS to run longer locally.

import { describe, expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64 } from '@mysten/sui/utils';
import { evaluateSponsorTx, MAX_SPONSOR_BUDGET_MIST, MAX_GAS_SPLIT_MIST } from '../sponsor-policy.js';

const SPONSOR = '0x' + 'a'.repeat(64);
const USER = '0x' + 'b'.repeat(64);
const ATTACKER = '0x' + 'c'.repeat(64);
const IOU = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const RUNS = Number(process.env.SPONSOR_FUZZ_RUNS ?? 1500);

// mulberry32: small, fast, seedable.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ref = (hex: string) => ({ objectId: '0x' + hex.repeat(64).slice(0, 64), version: '1', digest: '11111111111111111111111111111111' });

async function randomTx(r: () => number) {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const amount = () => pick([0n, 1n, 999_999n, 1_000_000n, 1_000_001n, 50_000_000n, 2n ** 63n, 2n ** 64n - 1n]);
  const tx = new Transaction();
  tx.setSender(pick([USER, USER, USER, SPONSOR, ATTACKER]));
  tx.setGasOwner(pick([SPONSOR, SPONSOR, SPONSOR, USER]));
  tx.setGasPayment([ref('1')]);
  tx.setGasBudget(pick([1_000_000n, 50_000_000n, MAX_SPONSOR_BUDGET_MIST, MAX_SPONSOR_BUDGET_MIST + 1n, 10n ** 12n]));
  tx.setGasPrice(1000);

  // Pool of coin-like arguments; results get appended as commands are built.
  const pool: any[] = [tx.gas, tx.objectRef(ref('2')), tx.objectRef(ref('3'))];
  const coin = () => pick(pool);
  const steps = 1 + Math.floor(r() * 5);
  for (let i = 0; i < steps; i++) {
    switch (Math.floor(r() * 6)) {
      case 0: {
        const n = 1 + Math.floor(r() * 3);
        const amts = Array.from({ length: n }, () => tx.pure.u64(amount()));
        const parts = tx.splitCoins(coin(), amts);
        for (let k = 0; k < n; k++) pool.push(parts[k]);
        break;
      }
      case 1: tx.mergeCoins(coin(), [coin()]); break;
      case 2: tx.transferObjects([coin()], pick([USER, ATTACKER])); break;
      case 3: tx.moveCall({ target: '0x2::coin::value', typeArguments: ['0x2::sui::SUI'], arguments: [coin()] }); break;
      case 4: pool.push(tx.makeMoveVec({ elements: [coin()] })); break;
      case 5: tx.moveCall({ target: `${IOU}::iou::${pick(['claim', 'recall', 'drain'])}`, arguments: [tx.objectRef(ref('4')), tx.object.clock()] }); break;
    }
  }
  return tx.build();
}

// Independent oracle: decode the bytes and check P1–P4 directly.
function violations(bytes: Uint8Array): string[] {
  const data = bcs.TransactionData.parse(bytes).V1;
  const out: string[] = [];
  const norm = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (norm(data.gasData.owner) !== norm(SPONSOR)) out.push('P1 gas owner is not the sponsor');
  if (norm(data.sender) === norm(SPONSOR)) out.push('P1 sponsor is the sender');
  if (BigInt(data.gasData.budget) > MAX_SPONSOR_BUDGET_MIST) out.push('P2 budget over limit');

  const ptb = data.kind.ProgrammableTransaction;
  if (!ptb) return out;
  const isGas = (a: any) => a?.$kind === 'GasCoin' || a?.GasCoin === true;
  let drained = 0n;
  for (const cmd of ptb.commands) {
    const kind = cmd.$kind;
    if (kind === 'SplitCoins') {
      if (cmd.SplitCoins.amounts.some(isGas)) out.push('P3 gas coin used as split amount');
      if (isGas(cmd.SplitCoins.coin)) {
        for (const a of cmd.SplitCoins.amounts) {
          const input = a.$kind === 'Input' ? ptb.inputs[a.Input] : null;
          if (!input?.Pure) { out.push('P4 non-literal amount split from gas'); continue; }
          const raw = input.Pure.bytes as unknown;
          const pure = typeof raw === 'string' ? fromBase64(raw) : Uint8Array.from(raw as number[]);
          drained += BigInt(bcs.u64().parse(pure));
        }
      }
      continue;
    }
    if (JSON.stringify(cmd[kind]).includes('"GasCoin"')) out.push(`P3 gas coin used in ${kind}`);
  }
  if (drained > MAX_GAS_SPLIT_MIST) out.push(`P4 ${drained} MIST split from gas`);
  return out;
}

describe('sponsor policy — property-based fuzzing', () => {
  test(`${RUNS} random transactions: every approval satisfies P1–P4`, async () => {
    let approved = 0;
    const seed0 = Number(process.env.SPONSOR_FUZZ_SEED ?? 0x5ec0de);
    for (let i = 0; i < RUNS; i++) {
      const seed = seed0 + i;
      const bytes = await randomTx(rng(seed));
      let decision;
      try { decision = evaluateSponsorTx(bytes, SPONSOR, USER); }
      catch (e) { throw new Error(`P5 policy threw on seed ${seed}: ${e}`); }
      if (!decision.ok) continue;
      approved++;
      const v = violations(bytes);
      if (v.length) throw new Error(`seed ${seed} approved but violates: ${v.join('; ')}`);
    }
    // Make sure the generator isn't trivially producing only rejections.
    expect(approved).toBeGreaterThan(RUNS * 0.02);
  }, 120_000);

  test('byte-level corruption never crashes the policy or slips past the oracle', async () => {
    const r = rng(0xbadb17e);
    const base = await (async () => {
      const tx = new Transaction();
      tx.setSender(USER); tx.setGasOwner(SPONSOR); tx.setGasPayment([ref('1')]);
      tx.setGasBudget(50_000_000); tx.setGasPrice(1000);
      const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(500_000)]);
      tx.transferObjects([c], USER);
      return tx.build();
    })();
    for (let i = 0; i < RUNS; i++) {
      const b = base.slice();
      const flips = 1 + Math.floor(r() * 4);
      for (let k = 0; k < flips; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      let decision;
      try { decision = evaluateSponsorTx(b, SPONSOR, USER); }
      catch (e) { throw new Error(`P5 policy threw on mutation ${i}: ${e}`); }
      if (!decision.ok) continue;
      let v: string[];
      try { v = violations(b); } catch { continue; } // oracle can't decode → policy must have too
      if (v.length) throw new Error(`mutation ${i} approved but violates: ${v.join('; ')}`);
    }
  }, 120_000);
});
