/**
 * Centralized Sui RPC — racing fan-out across multiple backends.
 *
 * Browser-side: exports a racing `grpcClient` that fans out gRPC-Web
 * calls to multiple fullnodes and returns the fastest response.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { detectNetwork } from './network.js';

// ─── Backend URLs ─────────────────────────────────────────────────────

/**
 * gRPC-Web endpoints for browser fan-out (mainnet).
 * Hayabusa (hb.sui.ski) is a racing gRPC proxy with two-tier caching
 * (L1 in-memory + L2 KV) that hedges requests across upstream fullnodes.
 */
const GRPC_BACKENDS_MAINNET: string[] = [
  'https://hb.sui.ski',
  'https://rpc-mainnet.suiscan.xyz:443',
];

/** gRPC-Web endpoints for browser fan-out (testnet). */
const GRPC_BACKENDS_TESTNET: string[] = [
  'https://fullnode.testnet.sui.io:443',
];

const GQL_URL_MAINNET = 'https://graphql.mainnet.sui.io/graphql';
const GQL_URL_TESTNET = 'https://graphql.testnet.sui.io/graphql';

const JSONRPC_URL_MAINNET = 'https://sui-rpc.publicnode.com';
const JSONRPC_URL_TESTNET = 'https://fullnode.testnet.sui.io:443';

/**
 * Resolved-at-module-load network for the current browser hostname.
 * Server-side (no globalThis.location) → mainnet. The devnet CF worker
 * serves the same bundle from dotski-devnet.*.workers.dev, where this
 * resolves to testnet.
 */
const ACTIVE_NETWORK: 'mainnet' | 'testnet' = detectNetwork();

/** gRPC racing backends for the active network. */
export const GRPC_BACKENDS: string[] =
  ACTIVE_NETWORK === 'testnet' ? GRPC_BACKENDS_TESTNET : GRPC_BACKENDS_MAINNET;

/** Primary gRPC URL (for SuinsClient and other APIs that need a single client). */
export const grpcUrl: string = GRPC_BACKENDS[0];

/** GraphQL endpoint (read-only queries — no racing needed, single endpoint). */
export const GQL_URL: string =
  ACTIVE_NETWORK === 'testnet' ? GQL_URL_TESTNET : GQL_URL_MAINNET;

/** JSON-RPC endpoint — IKA SDK pagination transport (sunsets April 2026). */
const JSONRPC_URL: string =
  ACTIVE_NETWORK === 'testnet' ? JSONRPC_URL_TESTNET : JSONRPC_URL_MAINNET;

// ─── Singleton clients ────────────────────────────────────────────────
// Three clients, each for its strengths:
//   gRPC   → tx building, general Sui ops (fast binary protocol)
//   GraphQL → read queries, IKA SDK (future-proof, no sunset)
//   JSON-RPC → IKA SDK fallback (only client it works with today, sunsets April 2026)

/** gRPC client — tx building, balance checks, general ops */
export const grpcClient = new SuiGrpcClient({
  network: ACTIVE_NETWORK,
  baseUrl: grpcUrl,
});

/** GraphQL client — read queries, future IKA SDK target */
export const gqlClient = new SuiGraphQLClient({
  url: GQL_URL,
  network: ACTIVE_NETWORK,
});

/** JSON-RPC client — IKA SDK (only working transport for IKA pagination) */
export const jsonRpcClient = new SuiJsonRpcClient({
  url: JSONRPC_URL,
  network: ACTIVE_NETWORK,
});

/** The network these singletons were constructed for. Exported for tests. */
export const rpcNetwork: 'mainnet' | 'testnet' = ACTIVE_NETWORK;

// ─── Racing transaction execution ─────────────────────────────────────

const BACKEND_TIMEOUT_MS = 5_000;
const RACE_RETRIES = 2;

/** Cached per-backend gRPC clients (avoid re-creating on every call) */
const _grpcClients = new Map<string, SuiGrpcClient>();
function getGrpcClient(url: string): SuiGrpcClient {
  let c = _grpcClients.get(url);
  if (!c) { c = new SuiGrpcClient({ network: ACTIVE_NETWORK, baseUrl: url }); _grpcClients.set(url, c); }
  return c;
}

/**
 * Race transaction execution across all gRPC backends.
 * Uses Promise.any — first success wins, rest ignored.
 * Falls back to JSON-RPC endpoints if all gRPC backends fail.
 */
export async function raceExecuteTransaction(
  txBytes: Uint8Array,
  signatures: string[],
): Promise<{ digest: string; effects?: unknown }> {
  // Phase 1: Race gRPC backends
  for (let attempt = 0; attempt <= RACE_RETRIES; attempt++) {
    try {
      const result = await Promise.any(
        GRPC_BACKENDS.map(async (url) => {
          const client = getGrpcClient(url);
          const res = await Promise.race([
            client.executeTransaction({ transaction: txBytes, signatures }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), BACKEND_TIMEOUT_MS),
            ),
          ]);
          const r = res as Record<string, unknown>;
          const digest = (r.digest as string) ?? '';
          if (!digest) throw new Error('no digest');
          return { digest, effects: r.effects };
        }),
      );
      return result;
    } catch {
      if (attempt === RACE_RETRIES) break;
    }
  }

  // Phase 2: Fall back to JSON-RPC endpoints
  const JSONRPC_FALLBACKS = [
    'https://sui-rpc.publicnode.com',
    'https://sui-mainnet-endpoint.blockvision.org',
    'https://rpc.ankr.com/sui',
    'https://rpc-mainnet.suiscan.xyz:443',
  ];

  const b64 = uint8ToBase64(txBytes);
  let lastErr: unknown;
  for (const url of JSONRPC_FALLBACKS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sui_executeTransactionBlock',
          params: [b64, signatures, { showEffects: true }, 'WaitForLocalExecution'],
        }),
      });
      const json = await res.json() as {
        result?: { digest?: string; effects?: Record<string, unknown> };
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? 'RPC error');
      const effects = json.result?.effects;
      const status = effects?.status as { status?: string; error?: string } | undefined;
      if (status?.status === 'failure') throw new Error(status.error || 'Transaction failed on-chain');
      return { digest: json.result?.digest ?? '', effects };
    } catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error('All RPC endpoints failed');
}

function uint8ToBase64(bytes: Uint8Array): string {
  let b = '';
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}
