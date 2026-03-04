import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';

interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
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

export default app;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
