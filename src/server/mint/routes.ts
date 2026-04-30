/**
 * Mint HTTP routes.
 *
 * Routes:
 *   GET  /api/mint/quote/:name              — Make It Rain (live pricing)
 *   GET  /api/mint/quote/:name?years=N
 *   GET  /api/mint/quote/:name?paid_usdc=N  — adds funded_percent
 *   POST /api/mint/register/:name           — Power Gem (x402 paywall)
 *
 * Future:
 *   Recover    — actually executes the SuiNS register from NS pool after
 *                Power Gem verifies payment
 *   Shadow Ball — frontend "Pay with USDC" button
 */

import { Hono } from 'hono';
import { quoteMint } from './pricing.js';
import {
  buildChallenge,
  decodeXPaymentHeader,
  verifyPayment,
} from './x402-paywall.js';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', component: 'mint' }));

// ─── Make It Rain — live quote ─────────────────────────────────────────

app.get('/quote/:name', async (c) => {
  const rawName = c.req.param('name') || '';
  const bareName = rawName.replace(/\.sui$/i, '').toLowerCase();
  const yearsParam = c.req.query('years');
  const years = yearsParam ? parseInt(yearsParam, 10) : 1;

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

// ─── Power Gem — x402 paywall on registration ──────────────────────────

app.post('/register/:name', async (c) => {
  const rawName = c.req.param('name') || '';
  const bareName = rawName.replace(/\.sui$/i, '').toLowerCase();
  const yearsParam = c.req.query('years');
  const years = yearsParam ? parseInt(yearsParam, 10) : 1;

  // Live quote — same pricing as the quote endpoint, ensures consistency.
  let quote;
  try {
    quote = await quoteMint(bareName, years);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e), name: bareName, years },
      400,
    );
  }

  const xPaymentHeader = c.req.header('X-PAYMENT');
  const resourceUrl = `${new URL(c.req.url).origin}/api/mint/register/${bareName}`;

  // No payment header → return 402 with the x402 challenge.
  if (!xPaymentHeader) {
    return c.json(buildChallenge(quote, resourceUrl), 402);
  }

  // Decode + verify the payment authorization.
  let verified;
  try {
    const payload = decodeXPaymentHeader(xPaymentHeader);
    verified = await verifyPayment(payload, BigInt(quote.total_usdc));
  } catch (e) {
    return c.json(
      buildChallenge(
        quote,
        resourceUrl,
        e instanceof Error ? `payment verification failed: ${e.message}` : 'payment verification failed',
      ),
      402,
    );
  }

  // Payment verified. Settlement (actually moving the USDC + executing the
  // SuiNS register PTB) is Recover (next move). For now we return a
  // structured "pending settlement" response so clients can integrate the
  // protocol surface immediately.
  return c.json(
    {
      ok: true,
      stage: 'payment_verified',
      registration: 'pending_settlement',
      name: `${bareName}.sui`,
      years,
      payment: {
        buyer: verified.buyer,
        amount_usdc: verified.amount_usdc.toString(),
        nonce: verified.nonce,
        valid_after: verified.validAfter,
        valid_before: verified.validBefore,
      },
      quote: {
        minimum_required: quote.display.minimum_required,
        total: quote.display.total,
        wholesale: `$${(BigInt(quote.wholesale_usdc) / 1_000_000n).toString()}.00`,
      },
      next_step: 'Recover (Gholdengo move) — ultron will register from NS pool',
    },
    200,
  );
});

export default app;
