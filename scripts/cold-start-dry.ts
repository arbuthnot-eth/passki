// Dry-run the cold-start SUI → USDC → iUSD single-PTB path.
// Proves the DeepBook swap + PSM mint chain constructs cleanly and
// executes end-to-end via sui_dryRunTransactionBlock. Uses ultron
// as the sender (it has 0.197 SUI — just above the 0.3 SUI minimum
// the Buy button enforces? actually not quite, let me use a smaller
// swap and lower the minimum for the dry run).
//
// Run: bun run scripts/cold-start-dry.ts

import { buildSuiToIusdTx } from '../src/suins.js';

const RPC = 'https://sui-rpc.publicnode.com';
// Plankton.sui (2.28 SUI at the time of writing) — just enough
// headroom to dry-run a 1.1 SUI swap, since superteam's SUI was
// consumed by the great.sui trade and ultron sits below the 1 SUI
// DeepBook minimum. Plankton is also the PSM reserve admin, so if
// this dry-run passes and we cross over to a real signed version,
// plankton is a fitting seeder for the first production mint call.
const SENDER = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json() as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

async function main() {
  console.log('--- Cold-start SUI → iUSD dry-run ---\n');

  const bal = await rpc<{ totalBalance: string }>('suix_getBalance', [SENDER, '0x2::sui::SUI']);
  const suiBal = BigInt(bal.totalBalance);
  console.log(`Sender SUI: ${Number(suiBal) / 1e9} SUI (${suiBal} mist)`);

  // DeepBook SUI/USDC pool's min_size is 1 SUI (1_000_000_000 mist)
  // and lot_size is 0.1 SUI. Anything smaller silently returns zero
  // and tanks the downstream PSM mint with EZeroAmount.
  const swapMist = 1_100_000_000n; // 1.1 SUI — clears min_size comfortably
  const suiPrice = 0.93127;
  const expectedUsd = (Number(swapMist) / 1e9) * suiPrice;
  console.log(`\nSwap plan: ${Number(swapMist) / 1e9} SUI ≈ $${expectedUsd.toFixed(4)}`);

  console.log('\nBuilding PTB via buildSuiToIusdTx...');
  const txBytes = await buildSuiToIusdTx({
    sender: SENDER,
    suiAmountMist: swapMist,
    suiPriceUsd: suiPrice,
  });
  console.log(`  built ${txBytes.length} bytes`);

  console.log('\nDry-running...');
  const b64 = Buffer.from(txBytes).toString('base64');
  const dry = await rpc<{
    effects?: { status?: { status: string; error?: string }; gasUsed?: Record<string, string> };
    events?: Array<{ type: string; parsedJson?: unknown }>;
  }>('sui_dryRunTransactionBlock', [b64]);
  const status = dry.effects?.status?.status;
  if (status === 'success') {
    console.log(`  ✅ SUCCESS`);
    const g = dry.effects?.gasUsed;
    if (g) console.log(`  gas: comp=${g.computationCost}, storage=${g.storageCost}, rebate=${g.storageRebate}`);
    for (const ev of dry.events ?? []) {
      const name = ev.type.split('::').slice(-1)[0];
      const short = JSON.stringify(ev.parsedJson).slice(0, 180);
      console.log(`  event: ${name} = ${short}`);
    }
  } else {
    console.log(`  ❌ FAILED: ${status}`);
    console.log(`  error: ${dry.effects?.status?.error ?? '(unknown)'}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
