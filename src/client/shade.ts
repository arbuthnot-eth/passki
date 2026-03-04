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

  stateCallback = onStateUpdate ?? null;

  client = new AgentClient<ShadeExecutorState>({
    host: window.location.hostname === 'localhost' ? window.location.host : 'sui.ski',
    agent: 'shade-executor-agent',
    name: ownerAddress,
    onStateUpdate: (state: ShadeExecutorState) => {
      if (stateCallback) stateCallback(state);
    },
  });

  return client;
}

/**
 * Schedule a Shade order for auto-execution at grace expiry.
 * The DO sets an alarm and automatically submits the execute+register PTB.
 */
export async function scheduleShadeExecution(params: {
  objectId: string;
  domain: string;
  executeAfterMs: number;
  targetAddress: string;
  salt: string;
  ownerAddress: string;
  depositMist: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!client) throw new Error('ShadeExecutor not connected');
  return client.call<{ success: boolean; error?: string }>('schedule', [params]);
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
