/**
 * Server-side Sui RPC — JSON-RPC fan-out for Cloudflare Workers/DOs.
 *
 * gRPC does NOT work in CF Workers (no HTTP/2 bidirectional streaming).
 * This module provides Promise.any racing across JSON-RPC endpoints.
 */

// ─── Backend URLs ─────────────────────────────────────────────────────

export const JSONRPC_BACKENDS: string[] = [
  'https://fullnode.mainnet.sui.io:443',
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
  'https://rpc-mainnet.suiscan.xyz:443',
];

/** GraphQL endpoint for read-only queries in DOs */
export const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// ─── Racing JSON-RPC ──────────────────────────────────────────────────

const BACKEND_TIMEOUT_MS = 5_000;
const RACE_RETRIES = 2;

export interface JsonRpcResult<T = unknown> {
  result?: T;
  error?: { code?: number; message?: string };
}

/**
 * Race a JSON-RPC call across all backends.
 * First successful response wins; rest are aborted.
 * Retries the full fan-out up to RACE_RETRIES times on total failure.
 */
export async function raceJsonRpc<T = unknown>(
  method: string,
  params: unknown[],
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  for (let attempt = 0; attempt <= RACE_RETRIES; attempt++) {
    const controllers = JSONRPC_BACKENDS.map(() => new AbortController());
    try {
      const result = await Promise.any(
        JSONRPC_BACKENDS.map(async (url, i) => {
          const timer = setTimeout(() => controllers[i].abort(), BACKEND_TIMEOUT_MS);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: controllers[i].signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as JsonRpcResult<T>;
            if (json.error) throw new Error(json.error.message ?? 'RPC error');
            // Abort all others
            controllers.forEach((c, j) => { if (j !== i) c.abort(); });
            return json.result as T;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      return result;
    } catch {
      if (attempt === RACE_RETRIES) break;
    }
  }
  throw new Error(`All ${JSONRPC_BACKENDS.length} RPC backends failed for ${method}`);
}

/**
 * Execute a signed transaction via racing JSON-RPC.
 * Aborts on MoveAbort/on-chain failures (no point retrying at another node).
 */
export async function raceExecuteTransaction(
  txBytesB64: string,
  signatures: string[],
): Promise<{ digest: string; effects?: unknown }> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'sui_executeTransactionBlock',
    params: [txBytesB64, signatures, { showEffects: true }, 'WaitForLocalExecution'],
  });

  for (let attempt = 0; attempt <= RACE_RETRIES; attempt++) {
    const controllers = JSONRPC_BACKENDS.map(() => new AbortController());
    try {
      const result = await Promise.any(
        JSONRPC_BACKENDS.map(async (url, i) => {
          const timer = setTimeout(() => controllers[i].abort(), BACKEND_TIMEOUT_MS);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: controllers[i].signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as {
              result?: { digest?: string; effects?: { status?: { status?: string; error?: string } } };
              error?: { message?: string };
            };
            if (json.error) throw new Error(`RPC error: ${json.error.message}`);

            const status = json.result?.effects?.status;
            if (status?.status !== 'success') {
              // On-chain failure — abort everything, don't retry
              controllers.forEach((c) => c.abort());
              throw new TxFailureError(status?.error ?? JSON.stringify(status));
            }

            // Success — abort losers
            controllers.forEach((c, j) => { if (j !== i) c.abort(); });
            return { digest: json.result?.digest ?? '', effects: json.result?.effects };
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      return result;
    } catch (err) {
      // Don't retry on-chain failures
      if (err instanceof TxFailureError) throw err;
      if (attempt === RACE_RETRIES) throw err;
    }
  }
  throw new Error('All RPC backends failed');
}

/** Sentinel error: the transaction executed but failed on-chain (MoveAbort, etc.) */
export class TxFailureError extends Error {
  constructor(message: string) {
    super(`Tx failed: ${message}`);
    this.name = 'TxFailureError';
  }
}
