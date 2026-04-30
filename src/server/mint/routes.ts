/**
 * Mint HTTP routes — Gholdengo Make It Rain.
 *
 * Hono sub-app providing:
 *   GET /api/mint/quote/:name      — live pricing breakdown (no payment)
 *   GET /api/mint/quote/:name?years=N
 *
 * Future moves:
 *   POST /api/mint/register        — Power Gem (x402 paywall)
 *   etc.
 */

import { Hono } from 'hono';
import { quoteMint } from './pricing.js';

const app = new Hono();

app.get('/quote/:name', async (c) => {
  const rawName = c.req.param('name') || '';
  const bareName = rawName.replace(/\.sui$/i, '').toLowerCase();
  const yearsParam = c.req.query('years');
  const years = yearsParam ? parseInt(yearsParam, 10) : 1;

  // ?paid_usdc=N — if set, response includes funded_percent
  const paidParam = c.req.query('paid_usdc');
  let paidUsdcBaseUnits: bigint | null = null;
  if (paidParam) {
    try {
      paidUsdcBaseUnits = BigInt(paidParam);
      if (paidUsdcBaseUnits < 0n) throw new Error('negative');
    } catch {
      return c.json({ error: 'paid_usdc must be a non-negative integer (USDC base units)' }, 400);
    }
  }

  try {
    const quote = await quoteMint(bareName, years, paidUsdcBaseUnits);
    return c.json(quote, 200);
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
        name: bareName,
        years,
      },
      400,
    );
  }
});

app.get('/health', (c) => c.json({ status: 'ok', component: 'mint' }));

export default app;
