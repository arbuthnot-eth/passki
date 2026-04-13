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
 * Aggressive recall trigger — pokes the server-side iou-sweeper to
 * immediately scan + recall every expired Thunder IOU / ShieldedVault
 * on-chain. The sweeper already runs on a 10-minute cron; this hook
 * lets the client fire it on-demand so the connected wallet doesn't
 * wait up to 10 min for its expired outbound vaults to come home.
 *
 * Side-appropriate: the recall function is permissionless after TTL
 * and always returns funds to the original sender, so whoever is
 * looking at the UI benefits — sender gets their money back, recipient
 * gets the commitment slot cleared so a fresh Thunder can land.
 *
 * Fire-and-forget. Best-effort. Never throws.
 */
export async function pokeIouSweeper(): Promise<{ scanned?: number; recalled?: number; failed?: number; error?: string }> {
  const host = _host();
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  try {
    const r = await fetch(`${proto}://${host}/api/iou/sweep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json() as { scanned?: number; recalled?: number; failed?: number };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

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
 * Schedule a StableShadeOrder<T> for auto-execution. Same as
 * scheduleShadeExecution but targets the `scheduleStable` DO method
 * so the server knows to use execute_stable + iUSD→USDC→NS swap at
 * grace-end alarm time. `initialSharedVersion` is mandatory — the
 * executor builds a sharedObjectRef against the order object.
 */
export async function scheduleStableShadeExecution(params: {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string;
  ownerAddress: string;
  depositMist: string;
  initialSharedVersion: number;
  coinType?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (client) {
    try {
      return await client.call<{ success: boolean; error?: string }>('scheduleStable', [params]);
    } catch { /* fall through to HTTP */ }
  }
  const host = _host();
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${proto}://${host}/agents/shade-executor-agent/${params.ownerAddress}?schedule-stable`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{ success: boolean; error?: string }>;
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
 * Ask the shade executor keeper to delete a cancelled shade order object.
 * This is used after WaaP-safe cancel_refund() drained funds.
 */
export async function reapCancelledShadeOrder(
  ownerAddress: string,
  objectId: string,
): Promise<{ success: boolean; digest?: string; error?: string }> {
  const host = _host();
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${proto}://${host}/agents/shade-executor-agent/${ownerAddress}?reap-cancelled`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId }),
  });
  return res.json() as Promise<{ success: boolean; digest?: string; error?: string }>;
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

/**
 * Schedule a thunder sweep — DO will call thunder::sweep() after 7 days idle.
 */
export async function scheduleThunderSweep(ownerAddress: string, nameHash: string, domain: string): Promise<void> {
  try {
    const addr = _lastOwnerAddress || ownerAddress;
    const url = `${_host()}/agents/shade-executor-agent/${addr}?schedule-sweep`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nameHash, domain }),
    });
  } catch { /* non-blocking */ }
}

export type { ShadeExecutorOrder, ShadeExecutorState };
