/**
 * ShadeExecutor client — connects to the ShadeExecutorAgent Durable Object
 * via WebSocket for scheduling and monitoring Shade order auto-execution.
 *
 * Keyed by the owner's Sui address (one executor per user).
 */

import { AgentClient } from 'agents/client';
import type { ShadeExecutorState, ShadeExecutorOrder } from '../server/agents/shade-executor.js';

let client: AgentClient<ShadeExecutorState> | null = null;
let stateCallback: ((state: ShadeExecutorState) => void) | null = null;
let _lastOwnerAddress = '';

const _host = () => window.location.hostname === 'localhost' ? window.location.host : 'sui.ski';

/**
 * Connect to the ShadeExecutorAgent Durable Object via WebSocket.
 * Instance name = owner's Sui address (one executor per user).
 */
export function connectShadeExecutor(
  ownerAddress: string,
  onStateUpdate?: (state: ShadeExecutorState) => void,
): AgentClient<ShadeExecutorState> {
  if (client) {
    try { client.close(); } catch { /* ignore */ }
  }

  _lastOwnerAddress = ownerAddress;
  stateCallback = onStateUpdate ?? null;

  client = new AgentClient<ShadeExecutorState>({
    host: _host(),
    agent: 'shade-executor-agent',
    name: ownerAddress,
    onStateUpdate: (state: ShadeExecutorState) => {
      if (stateCallback) stateCallback(state);
    },
  });

  return client;
}

/**
 * Schedule via HTTP POST — reliable fallback that doesn't depend on WebSocket.
 */
async function _scheduleViaHttp(params: {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string;
  ownerAddress: string;
  depositMist: string;
  preferredRoute?: 'sui-ns' | 'sui-usdc-ns';
}): Promise<{ success: boolean; error?: string }> {
  const host = _host();
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${proto}://${host}/agents/shade-executor-agent/${params.ownerAddress}?schedule`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{ success: boolean; error?: string }>;
}

/**
 * Schedule a Shade order for auto-execution at grace expiry.
 * Tries WebSocket RPC first, falls back to HTTP POST if WS is unavailable.
 */
export async function scheduleShadeExecution(params: {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string;
  ownerAddress: string;
  depositMist: string;
  preferredRoute?: 'sui-ns' | 'sui-usdc-ns';
}): Promise<{ success: boolean; error?: string }> {
  // Try WebSocket RPC first
  if (client) {
    try {
      return await client.call<{ success: boolean; error?: string }>('schedule', [params]);
    } catch { /* WS failed — fall through to HTTP */ }
  }
  // HTTP fallback — always works
  return _scheduleViaHttp(params);
}

/**
 * Cancel a scheduled Shade order (removes the alarm).
 * Call this after the user cancels the on-chain order.
 */
export async function cancelShadeExecution(
  objectId: string,
): Promise<{ success: boolean }> {
  if (!client) throw new Error('ShadeExecutor not connected');
  return client.call<{ success: boolean }>('cancel', [{ objectId }]);
}

/**
 * Get all orders tracked by this executor instance.
 */
export async function getShadeExecutorOrders(): Promise<ShadeExecutorOrder[]> {
  if (!client) throw new Error('ShadeExecutor not connected');
  const result = await client.call<{ orders: ShadeExecutorOrder[] }>('getOrders', []);
  return result.orders;
}

/**
 * Get the status of a specific order.
 */
export async function getShadeOrderStatus(
  objectId: string,
): Promise<ShadeExecutorOrder | null> {
  if (!client) throw new Error('ShadeExecutor not connected');
  return client.call<ShadeExecutorOrder | null>('getStatus', [{ objectId }]);
}

/**
 * Reset failed orders so they can retry execution.
 * Optionally pass an objectId to reset a single order; omit to reset all.
 */
export async function resetFailedShadeOrders(
  ownerAddress: string,
  objectId?: string,
): Promise<{ reset: number }> {
  const host = _host();
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${proto}://${host}/agents/shade-executor-agent/${ownerAddress}?reset-failed`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(objectId ? { objectId } : {}),
  });
  return res.json() as Promise<{ reset: number }>;
}

/**
 * Disconnect the WebSocket connection.
 */
export function disconnectShadeExecutor(): void {
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }
  stateCallback = null;
}

export type { ShadeExecutorOrder, ShadeExecutorState };
