// Probe Aftermath for iUSD routes. If a non-PSM iUSD → USDC or
// iUSD → SUI route exists, we can bypass the reserve bottleneck
// for the great.sui trade.

import { Aftermath } from 'aftermath-ts-sdk';

async function main() {
  const af = new Aftermath('MAINNET');
  await af.init();
  const router = af.Router();

  const IUSD = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
  const SUI  = '0x2::sui::SUI';
  const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

  const probes: Array<[string, string, string, bigint, number]> = [
    ['iUSD → SUI (10)',  IUSD, SUI,  10_000_000_000n, 1e9],
    ['iUSD → USDC (10)', IUSD, USDC, 10_000_000_000n, 1e6],
    ['iUSD → SUI (20)',  IUSD, SUI,  20_000_000_000n, 1e9],
    ['iUSD → USDC (20)', IUSD, USDC, 20_000_000_000n, 1e6],
  ];

  for (const [label, inType, outType, amt, outDiv] of probes) {
    console.log(`--- ${label} ---`);
    try {
      const r = await router.getCompleteTradeRouteGivenAmountIn({
        coinInAmount: amt,
        coinInType: inType,
        coinOutType: outType,
      });
      const outAmt = (r as any)?.coinOut?.amount;
      if (outAmt) {
        const out = Number(BigInt(outAmt)) / outDiv;
        console.log(`  out: ${outAmt} raw = ${out.toFixed(6)}`);
        const routes = (r as any)?.routes ?? [];
        const hops = routes.map((route: any) =>
          (route.paths ?? []).map((p: any) => p.protocolName ?? p.poolId ?? 'unknown').join('→')
        ).join(' | ');
        console.log(`  hops: ${hops}`);
      } else {
        console.log(`  no output amount`);
      }
    } catch (e) {
      console.log(`  ERR: ${e instanceof Error ? e.message : e}`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
