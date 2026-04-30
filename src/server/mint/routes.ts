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

  try {
    const quote = await quoteMint(bareName, years);
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
