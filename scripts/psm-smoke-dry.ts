// One-shot dry-run of the PSM mint + burn builders against mainnet.
// Proves the PTB constructs cleanly and the Move calls resolve at
// the current Reserve state before any wallet signs anything real.
//
// Run: bun run scripts/psm-smoke-dry.ts

import { buildPsmMintTx, buildPsmBurnTx, queryReserveState, quoteMintOutIusdMist, quoteBurnOutUsdcMist } from '../src/client/psm.js';

const RPC = 'https://sui-rpc.publicnode.com';

// Ultron — has $0.371 USDC and plenty of SUI for gas.
const ULTRON = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';
const ULTRON_USDC = '0xfa3fbcdbe7ee6e3514aba80015105271668608e3d3bc049b7c23cabe66483d67';

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

async function b64(bytes: Uint8Array): Promise<string> {
  return Buffer.from(bytes).toString('base64');
}

async function main() {
  console.log('--- Volcarodon PSM smoke test ---\n');

  // 1. State
  const state = await queryReserveState();
  console.log('Reserve state:');
  console.log(`  s_balance    : ${state.sBalanceMist} mist ($${(Number(state.sBalanceMist) / 1e6).toFixed(6)})`);
  console.log(`  collected_fee: ${state.collectedFeeMist} mist ($${(Number(state.collectedFeeMist) / 1e6).toFixed(6)})`);
  console.log(`  fee_bps      : ${state.feeBps}`);
  console.log(`  total_t_minted: ${state.totalTMinted}`);
  console.log(`  total_t_burned: ${state.totalTBurned}`);
  console.log(`  total_s_in    : ${state.totalSIn}`);
  console.log(`  total_s_out   : ${state.totalSOut}`);
  console.log(`  admin         : ${state.admin}\n`);

  // 2. Mint dry-run: 10,000 USDC mist ($0.01) → iUSD
  const mintAmount = 10_000n;
  const expectedIusd = quoteMintOutIusdMist(mintAmount, state.feeBps);
  console.log(`MINT dry-run: ${mintAmount} USDC mist → expected ${expectedIusd} iUSD mist`);
  const mint = await buildPsmMintTx({
    sender: ULTRON,
    usdcCoinIds: [ULTRON_USDC],
    usdcAmountMist: mintAmount,
    minIusdOutMist: (expectedIusd * 9990n) / 10000n,
  });
  const mintRes = await rpc('sui_dryRunTransactionBlock', [await b64(mint.bytes)]);
  if (mintRes.error) {
    console.error(`  ❌ dryRun error: ${mintRes.error.message}`);
  } else {
    const eff = (mintRes.result as any)?.effects;
    console.log(`  status: ${eff?.status?.status}`);
    if (eff?.status?.error) console.log(`  error: ${eff.status.error}`);
    const gas = eff?.gasUsed;
    if (gas) console.log(`  gas : cost=${gas.computationCost}, storage=${gas.storageCost}, rebate=${gas.storageRebate}`);
    const events = (mintRes.result as any)?.events ?? [];
    for (const ev of events) {
      console.log(`  event: ${ev.type.split('::').slice(-1)[0]} = ${JSON.stringify(ev.parsedJson)}`);
    }
  }
  console.log();

  // 3. Burn dry-run: 10,000,000 iUSD mist (0.01 iUSD) → USDC
  //    Ultron has zero iUSD, so this dryRun will fail at "no input coin",
  //    which tells us the builder errors correctly rather than producing
  //    a malformed PTB. The meaningful burn dry-run is the one above's
  //    mint result — after that executes, ultron will hold 9,995 iUSD mist
  //    we can burn in a second step. Skipping for now.
  const burnAmount = 10_000_000n;
  const expectedUsdc = quoteBurnOutUsdcMist(burnAmount, state.feeBps);
  console.log(`BURN quote (hypothetical): ${burnAmount} iUSD mist → ${expectedUsdc} USDC mist`);
  console.log(`  (skipping dry-run — ultron has no iUSD; burn path will be proven on the live mint→burn round-trip)\n`);

  console.log('--- done ---');
}

main().catch(e => { console.error(e); process.exit(1); });
