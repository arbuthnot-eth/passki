/**
 * Mint HTTP routes.
 *
 * Routes:
 *   GET  /api/mint/quote/:name              — Make It Rain (live pricing)
 *   GET  /api/mint/quote/:name?years=N
 *   GET  /api/mint/quote/:name?paid_usdc=N  — adds funded_percent
 *   POST /api/mint/register/:name           — Power Gem (x402 paywall, verify-only)
 *
 * Settlement model: buyer's own wallet submits the Base payment tx (see
 * `src/client/mint-pay.ts`). Our server NEVER holds a private key —
 * first commandment is unconditional. After the buyer's tx confirms,
 * they re-call this endpoint with the X-PAYMENT header carrying the
 * already-settled authorization + the Base tx hash; server verifies the
 * signature, checks the Base tx, and triggers ultron's Sui-side register.
 */

import { Hono } from 'hono';
import { quoteMint } from './pricing.js';
import {
  buildChallenge,
  decodeXPaymentHeader,
  verifyPayment,
} from './x402-paywall.js';
import { registerFromUltronPool } from './register.js';
import { settleViaIka } from './ika-settle.js';

interface MintRoutesEnv {
  ULTRON_PRIVATE_KEY?: string;
  SHADE_KEEPER_PRIVATE_KEY?: string;
  UltronSigningAgent: DurableObjectNamespace;
  BASE_RPC_URL?: string;
  // No MINT_GAS_RELAY_PRIVATE_KEY here. Ever.
}

const app = new Hono<{ Bindings: MintRoutesEnv }>();

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

// ─── Power Gem — x402 paywall (verify-only, no server-side settlement) ──

app.post('/register/:name', async (c) => {
  const rawName = c.req.param('name') || '';
  const bareName = rawName.replace(/\.sui$/i, '').toLowerCase();
  const yearsParam = c.req.query('years');
  const years = yearsParam ? parseInt(yearsParam, 10) : 1;

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

  if (!xPaymentHeader) {
    return c.json(buildChallenge(quote, resourceUrl), 402);
  }

  const suiTarget = c.req.query('sui_target') || c.req.header('X-SUI-TARGET');
  if (!suiTarget) {
    return c.json(
      { error: 'sui_target query param or X-SUI-TARGET header required' },
      400,
    );
  }

  // Verify the buyer's signed authorization.
  let verified;
  let payload;
  try {
    payload = decodeXPaymentHeader(xPaymentHeader);
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

  // Settlement mode:
  //   X-PAYMENT-MODE: browser  (default) — buyer already submitted the Base tx
  //                                         themselves; pass tx hash in
  //                                         X-PAYMENT-TX-HASH for record.
  //   X-PAYMENT-MODE: ika                — server submits via ultron's IKA
  //                                         secp256k1 dWallet (agent-friendly).
  const mode = (c.req.header('X-PAYMENT-MODE') || 'browser').toLowerCase();
  let baseTxHash: string | null = null;

  if (mode === 'ika') {
    try {
      const settled = await settleViaIka(c.env, verified, payload.payload.signature);
      baseTxHash = settled.base_tx_hash;
    } catch (e) {
      return c.json(
        { ok: false, stage: 'ika_settle_failed', error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  } else {
    // Browser mode — buyer's wallet has already submitted the Base tx.
    baseTxHash = c.req.header('X-PAYMENT-TX-HASH') || null;
    if (!baseTxHash) {
      return c.json(
        {
          error: 'X-PAYMENT-TX-HASH required in browser mode (the Base tx your wallet just submitted), or set X-PAYMENT-MODE: ika to have ultron settle via its IKA dWallet',
        },
        400,
      );
    }
  }

  // Register on Sui from ultron's NS pool.
  try {
    const registration = await registerFromUltronPool({
      env: c.env,
      bareName,
      years,
      target: suiTarget,
    });
    return c.json(
      {
        ok: true,
        stage: 'registered',
        name: registration.domain,
        years: registration.years,
        target: registration.target,
        registration: {
          digest: registration.digest,
          nft_id: registration.nft_id,
        },
        payment: {
          buyer: verified.buyer,
          amount_usdc: verified.amount_usdc.toString(),
          base_tx_hash: baseTxHash,
          settled_via: mode === 'ika' ? 'ika-dwallet-secp256k1' : 'browser-wallet',
        },
      },
      200,
    );
  } catch (e) {
    return c.json(
      { ok: false, stage: 'verified_register_failed', error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

export default app;
