import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
}

const app = new Hono<{ Bindings: Env }>();

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// ── Shade monitoring & manual poke ──────────────────────────────────

app.get('/api/shade/poke/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?poke=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get('/api/shade/status/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?status=1', {
      headers: { 'x-partykit-room': address },
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Schedule a shade order for auto-execution via HTTP POST
app.post('/api/shade/schedule/:address', async (c) => {
  const address = c.req.param('address');
  try {
    const params = await c.req.json();
    const id = c.env.ShadeExecutorAgent.idFromName(address);
    const stub = c.env.ShadeExecutorAgent.get(id);
    const res = await stub.fetch(new Request('https://shade-do/?schedule=1', {
      method: 'POST',
      headers: {
        'x-partykit-room': address,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    }));
    const text = await res.text();
    try { return c.json(JSON.parse(text)); }
    catch { return c.json({ raw: text, status: res.status }); }
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Tradeport listing proxy ──────────────────────────────────────────

const TRADEPORT_GQL = 'https://graphql.tradeport.gg';
const SUINS_COLLECTION_ID = '060fe4fb-9a3e-4170-a494-a25e62aba689';

app.get('/api/tradeport/listing/:label', async (c) => {
  const label = c.req.param('label').toLowerCase().replace(/\.sui$/, '');
  if (label.length < 3) return c.json({ listing: null });
  const name = `${label}.sui`;
  try {
    const res = await fetch(TRADEPORT_GQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-user': c.env.TRADEPORT_API_USER,
        'x-api-key': c.env.TRADEPORT_API_KEY,
      },
      body: JSON.stringify({
        query: `{ sui { nfts(where: { collection_id: { _eq: "${SUINS_COLLECTION_ID}" }, name: { _eq: "${name}" }, listed: { _eq: true } }, limit: 1) { token_id listings(where: { listed: { _eq: true } }) { id price seller market_name } } } }`,
      }),
    });
    type TpResult = { data?: { sui?: { nfts?: { token_id: string; listings: { id: string; price: number; seller: string; market_name: string }[] }[] } } };
    const json = await res.json() as TpResult;
    const nft = json?.data?.sui?.nfts?.[0];
    const listing = nft?.listings?.[0];
    if (!nft || !listing) return c.json({ listing: null });
    return c.json({
      listing: {
        listingId: listing.id,
        priceMist: String(listing.price),
        seller: listing.seller,
        nftTokenId: nft.token_id,
        marketName: listing.market_name,
      },
    });
  } catch {
    return c.json({ listing: null });
  }
});

export default app;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
