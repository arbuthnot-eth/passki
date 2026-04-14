// Dry-run the exact PTB that the idle-overlay TRADE button would
// build for great.sui, using superteam.sui's real on-chain balances.
// Proves (or disproves) that no top-up is needed — the trade fits
// in existing SUI + USDC + PSM burn capacity.

import { buildIusdBurnAndPurchaseTx } from '../src/suins.js';

const RPC = 'https://sui-rpc.publicnode.com';
const SUPERTEAM = '0x3ca0da71d19d9a1837ad3da155f03aab776aa33963864064eb81569f10e5222b';

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
  console.log('--- great.sui trade dry-run for superteam.sui ---\n');

  // Pull live balances
  const sui = await rpc<{ totalBalance: string }>('suix_getBalance', [SUPERTEAM, '0x2::sui::SUI']);
  const usdc = await rpc<{ totalBalance: string }>('suix_getBalance', [SUPERTEAM, '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC']);
  const iusd = await rpc<{ totalBalance: string }>('suix_getBalance', [SUPERTEAM, '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD']);

  const suiBal  = BigInt(sui.totalBalance);
  const usdcBal = BigInt(usdc.totalBalance);
  const iusdBal = BigInt(iusd.totalBalance);
  console.log(`Balances:`);
  console.log(`  SUI  : ${(Number(suiBal)/1e9).toFixed(6)}`);
  console.log(`  USDC : ${(Number(usdcBal)/1e6).toFixed(6)}`);
  console.log(`  iUSD : ${(Number(iusdBal)/1e9).toFixed(6)}`);
  console.log();

  // Query current reserve state
  const reserve = await rpc<{ data: { content: { fields: { s_balance: string; fee_bps: string } } } }>(
    'sui_getObject',
    ['0x62fcd184ef68d7267e4cf45f8af5ff7f23511c4741f26674875e691389ca264c', { showContent: true }],
  );
  const rf = reserve.data.content.fields;
  const reserveUsdc = BigInt(rf.s_balance);
  const feeBps = BigInt(rf.fee_bps);
  console.log(`Reserve:`);
  console.log(`  s_balance : ${reserveUsdc} mist ($${(Number(reserveUsdc)/1e6).toFixed(6)})`);
  console.log(`  fee_bps   : ${feeBps}`);
  console.log();

  // Pull SUI price from Pyth (or default)
  const suiPrice = 0.93127;

  // Listing details from /api/infer response
  const priceMist = 39_000_000_000n;
  const priceUsd = Number(priceMist) / 1e9 * suiPrice;
  console.log(`Listing: great.sui @ ${Number(priceMist)/1e9} SUI ≈ $${priceUsd.toFixed(2)}\n`);

  // Mirror the TRADE handler's shortfall math exactly
  const gasBuf = 100_000_000n;
  const suiAccum = suiBal > gasBuf ? suiBal - gasBuf : 0n;
  const suiShortfall = suiAccum < priceMist ? (priceMist - suiAccum) : 0n;
  const suiShortfallWithBuf = suiShortfall + (suiShortfall * 200n / 10000n);
  const usdcNeededForSwap = BigInt(Math.ceil((Number(suiShortfallWithBuf) / 1e9) * suiPrice * 1e6));
  const usdcShortfall = usdcBal < usdcNeededForSwap ? (usdcNeededForSwap - usdcBal) : 0n;
  console.log(`Shortfall math:`);
  console.log(`  SUI accumulated: ${suiAccum} mist`);
  console.log(`  SUI shortfall: ${suiShortfall} mist`);
  console.log(`  USDC needed (with 2% slip): ${usdcNeededForSwap} mist ($${(Number(usdcNeededForSwap)/1e6).toFixed(2)})`);
  console.log(`  USDC shortfall: ${usdcShortfall} mist ($${(Number(usdcShortfall)/1e6).toFixed(2)})`);
  console.log();

  let iusdBurnMist = 0n;
  if (usdcShortfall > 0n) {
    if (usdcShortfall > reserveUsdc) {
      console.log(`❌ PSM reserve too small: need $${(Number(usdcShortfall)/1e6).toFixed(2)}, reserve has $${(Number(reserveUsdc)/1e6).toFixed(2)}`);
      process.exit(1);
    }
    const grossUsdc = (usdcShortfall * 10000n) / (10000n - feeBps) + 1n;
    iusdBurnMist = grossUsdc * 1000n;
    console.log(`PSM burn plan:`);
    console.log(`  gross USDC: ${grossUsdc} mist`);
    console.log(`  iUSD to burn: ${iusdBurnMist} mist (${(Number(iusdBurnMist)/1e9).toFixed(4)} iUSD)`);
    console.log();
  }

  // Build the actual PTB
  console.log('Building PTB via buildIusdBurnAndPurchaseTx...');
  const txBytes = await buildIusdBurnAndPurchaseTx(
    SUPERTEAM,
    { type: 'tradeport', nftTokenId: '0xb00fcb896852ed385ac8fb80dad4c3e3f3ebaaca607289a320e1fe300de946ca', priceMist: String(priceMist) },
    suiPrice,
    iusdBurnMist,
  );
  console.log(`  built ${txBytes.length} bytes`);
  console.log();

  // Dry-run via JSON-RPC
  console.log('Dry-running...');
  const b64 = Buffer.from(txBytes).toString('base64');
  const dry = await rpc<{ effects?: { status?: { status: string; error?: string }; gasUsed?: Record<string, string> }; events?: Array<{ type: string; parsedJson?: unknown }> }>(
    'sui_dryRunTransactionBlock', [b64],
  );
  const status = dry.effects?.status?.status;
  if (status === 'success') {
    console.log(`  ✅ SUCCESS`);
    const g = dry.effects?.gasUsed;
    if (g) console.log(`  gas: comp=${g.computationCost}, storage=${g.storageCost}, rebate=${g.storageRebate}`);
    const events = dry.events ?? [];
    for (const ev of events) {
      const name = ev.type.split('::').slice(-1)[0];
      console.log(`  event: ${name} = ${JSON.stringify(ev.parsedJson)}`);
    }
  } else {
    console.log(`  ❌ FAILED: ${status}`);
    console.log(`  error: ${dry.effects?.status?.error ?? '(unknown)'}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
