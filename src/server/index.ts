import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';

const app = new Hono();

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

export default app;

// Export the SessionAgent class so wrangler can bind it as a Durable Object
export { SessionAgent } from './agents/session.js';
