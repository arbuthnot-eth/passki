import { AgentClient } from 'agents/client';
import type { SessionState } from '../server/agents/session.js';

let client: AgentClient<SessionState> | null = null;
let stateCallback: ((state: SessionState) => void) | null = null;

/**
 * Connect to the SessionAgent Durable Object via WebSocket.
 * The instance name is the sessionKey (visitorId-address).
 */
export function connectSession(
  sessionKey: string,
  onStateUpdate?: (state: SessionState) => void,
): AgentClient<SessionState> {
  if (client) {
    try { client.close(); } catch { /* ignore */ }
  }

  stateCallback = onStateUpdate ?? null;

  client = new AgentClient<SessionState>({
    host: window.location.hostname === 'localhost' ? window.location.host : 'sui.ski',
    agent: 'session-agent',
    name: sessionKey,
    onStateUpdate: (state: SessionState) => {
      if (stateCallback) stateCallback(state);
    },
  });

  return client;
}

/**
 * Authenticate with the session agent after wallet sign + fingerprint.
 */
export async function authenticate(params: {
  walletAddress: string;
  visitorId: string;
  confidence: number;
  signature: string;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!client) throw new Error('Session not connected');
  return client.call<{ success: boolean; error?: string }>('authenticate', [params]);
}

/**
 * Get current session state from the agent.
 */
export async function getSession(): Promise<SessionState | null> {
  if (!client) return null;
  return client.call<SessionState>('getSession', []);
}

/**
 * Tell the agent to forget this device-wallet binding.
 */
export async function forgetDevice(): Promise<void> {
  if (!client) return;
  await client.call('forgetDevice', []);
}

/**
 * Disconnect the WebSocket connection.
 */
export function disconnectSession(): void {
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }
  stateCallback = null;
}

export function getSessionClient(): AgentClient<SessionState> | null {
  return client;
}
