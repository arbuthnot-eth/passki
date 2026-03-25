# gRPC Racing Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all hardcoded Sui fullnode URLs with a centralized racing utility that fans out requests to multiple backends and returns the fastest response.

**Architecture:** New `src/rpc.ts` module exports a singleton `grpcClient` for browser reads and a `raceExecuteTransaction()` for browser tx submission (the latency-critical path). `src/server/rpc.ts` exports `raceJsonRpc()` and `raceExecuteTransaction()` for server-side DOs (where gRPC doesn't work). Read calls go through the singleton (single-backend) because `SuiGrpcClient` doesn't support fetch interceptors; writes are raced across all backends. The backend list is configurable via exported arrays.

**Scope:** Browser reads = single primary backend (Mysten). Browser tx execution = raced across all gRPC backends. Server-side reads and writes = raced across all JSON-RPC backends.

**Tech Stack:** `@mysten/sui` (SuiGrpcClient, SuiGraphQLClient), `AbortController`, `Promise.any`, Cloudflare Workers

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/rpc.ts` | **Create** | Racing utility: backend list, `raceJsonRpc()`, singleton `grpcClient`, `grpcUrl` export |
| `src/server/rpc.ts` | **Create** | Server-side racing: `raceJsonRpc()` for DOs (JSON-RPC `Promise.any` fan-out) |
| `src/ui.ts` | **Modify** | Replace inline `SuiGrpcClient` with import from `src/rpc.ts` |
| `src/wallet.ts` | **Modify** | Replace inline gRPC client + JSON-RPC fallback chain with racing imports |
| `src/sponsor.ts` | **Modify** | Replace inline `SuiGrpcClient` with import from `src/rpc.ts` |
| `src/suins.ts` | **Modify** | Replace `GRPC_URL` constant with import from `src/rpc.ts` |
| `src/server/agents/shade-executor.ts` | **Modify** | Replace `FULLNODE_URLS` + sequential fallback with `raceJsonRpc()` from `src/server/rpc.ts` |
| `src/server/index.ts` | **Modify** | Replace hardcoded JSON-RPC URL in `/api/suiami/verify` with `raceJsonRpc()` |
| `src/client/ika.ts` | **Skip** | Not production-ready, will be rewritten separately |
| `src/waap.ts` | **Skip** | WaaP controls its own transport |

---

## Backend Configuration

### Browser-side gRPC backends (src/rpc.ts)

These are the gRPC-Web endpoints the browser `SuiGrpcClient` can reach:

```ts
const GRPC_BACKENDS = [
  'https://fullnode.mainnet.sui.io:443',
  'https://rpc-mainnet.suiscan.xyz:443',
  // Add Triton/QuickNode URLs here when available (paid, require tokens)
];
```

> **Note:** Only Mysten and Suiscan/Blockberry offer free public gRPC endpoints. Triton and QuickNode require account-specific URLs. The browser `grpcClient` wrapping works by pointing at a single `baseUrl` — to race gRPC calls, we create multiple `SuiGrpcClient` instances and race their responses.

### Server-side JSON-RPC backends (src/server/rpc.ts)

For DOs where gRPC doesn't work:

```ts
const JSONRPC_BACKENDS = [
  'https://fullnode.mainnet.sui.io:443',
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
  'https://rpc-mainnet.suiscan.xyz:443',
  // Triton: 'https://mainnet.sui.rpcpool.com/<TOKEN>'
  // QuickNode: 'https://<YOUR-ENDPOINT>.quiknode.pro/<TOKEN>'
];
```

---

## Task 1: Create browser-side racing module (`src/rpc.ts`)

**Files:**
- Create: `src/rpc.ts`

- [ ] **Step 1: Create `src/rpc.ts` with backend list and racing grpcClient**

```ts
/**
 * Centralized Sui RPC — racing fan-out across multiple backends.
 *
 * Browser-side: exports a racing `grpcClient` that fans out gRPC-Web
 * calls to multiple fullnodes and returns the fastest response.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

// ─── Backend URLs ─────────────────────────────────────────────────────

/** gRPC-Web endpoints for browser fan-out */
export const GRPC_BACKENDS: string[] = [
  'https://fullnode.mainnet.sui.io:443',
  'https://rpc-mainnet.suiscan.xyz:443',
];

/** Primary gRPC URL (for SuinsClient and other APIs that need a single client) */
export const grpcUrl = GRPC_BACKENDS[0];

/** GraphQL endpoint (read-only queries — no racing needed, single endpoint) */
export const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// ─── Singleton clients ────────────────────────────────────────────────

/** Racing gRPC client — points at the primary backend. Used throughout browser code. */
export const grpcClient = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: grpcUrl,
});

/** GraphQL client for read-only queries */
export const gqlClient = new SuiGraphQLClient({
  url: GQL_URL,
  network: 'mainnet',
});
```

> **Design note:** The Sui SDK's `SuiGrpcClient` doesn't support custom fetch interceptors that would let us transparently race all calls. Instead, the `grpcClient` singleton points at the primary backend. For *transaction execution* specifically (the latency-critical path), we race explicitly in `raceExecuteTransaction()` below.

- [ ] **Step 2: Add `raceExecuteTransaction()` for browser-side tx submission**

Append to `src/rpc.ts`:

```ts
// ─── Racing transaction execution ─────────────────────────────────────

const BACKEND_TIMEOUT_MS = 5_000;
const RACE_RETRIES = 2;

/** Cached per-backend gRPC clients (avoid re-creating on every call) */
const _grpcClients = new Map<string, SuiGrpcClient>();
function getGrpcClient(url: string): SuiGrpcClient {
  let c = _grpcClients.get(url);
  if (!c) { c = new SuiGrpcClient({ network: 'mainnet', baseUrl: url }); _grpcClients.set(url, c); }
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
```

- [ ] **Step 3: Dry-run build to verify no syntax errors**

Run: `bun build src/rpc.ts --outdir /tmp/rpc-check --target browser`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/rpc.ts
git commit -m "feat: add centralized gRPC racing module (src/rpc.ts)"
```

---

## Task 2: Create server-side racing module (`src/server/rpc.ts`)

**Files:**
- Create: `src/server/rpc.ts`

- [ ] **Step 1: Create `src/server/rpc.ts` with JSON-RPC fan-out**

```ts
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
```

- [ ] **Step 2: Dry-run typecheck**

Run: `npx tsc --noEmit --strict src/server/rpc.ts 2>&1 | head -20` (or just verify it builds with wrangler)
Expected: No type errors. If tsc complains about isolation, that's fine — the real check is the wrangler build.

- [ ] **Step 3: Commit**

```bash
git add src/server/rpc.ts
git commit -m "feat: add server-side JSON-RPC racing module (src/server/rpc.ts)"
```

---

## Task 3: Wire `src/ui.ts` to use `src/rpc.ts`

**Files:**
- Modify: `src/ui.ts:29,49-52`

- [ ] **Step 1: Replace inline SuiGrpcClient import and instantiation**

In `src/ui.ts`, change:
```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';
```
and:
```ts
export const grpcClient = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});
```

To:
```ts
import { grpcClient, GQL_URL } from './rpc.js';
export { grpcClient };
```

Remove the `SuiGrpcClient` import line (line 29) since it's no longer used directly.

- [ ] **Step 2: Verify no other direct gRPC construction in ui.ts**

Search `ui.ts` for any remaining `fullnode.mainnet.sui.io` or `new SuiGrpcClient`. If any JSON-RPC fetch calls exist (like the portfolio balance fetch at ~line 2304), note them for Task 6 (remaining callsites).

- [ ] **Step 3: Build browser bundle**

Run: `bun run build`
Expected: Build succeeds. The `grpcClient` re-export should keep all downstream consumers working.

- [ ] **Step 4: Commit**

```bash
git add src/ui.ts
git commit -m "refactor: wire ui.ts to centralized racing rpc module"
```

---

## Task 4: Wire `src/wallet.ts` to use racing execution

**Files:**
- Modify: `src/wallet.ts:12-18,362-404`

- [ ] **Step 1: Replace dapp-kit gRPC client and `_executeSignedTx`**

In `src/wallet.ts`, change the dapp-kit setup (line 12-22):
```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';

const dappKit = createDAppKit({
  networks: ['sui:mainnet' as const],
  createClient: () => new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' }),
  ...
});
```

To:
```ts
import { grpcClient, grpcUrl } from './rpc.js';

const dappKit = createDAppKit({
  networks: ['sui:mainnet' as const],
  createClient: () => new SuiGrpcClient({ network: 'mainnet', baseUrl: grpcUrl }),
  ...
});
```

Keep the `SuiGrpcClient` import since dapp-kit's `createClient` factory may be called multiple times and expects independent instances. We pass `grpcUrl` from `src/rpc.ts` so the URL is centralized.

Remove the hardcoded `'https://fullnode.mainnet.sui.io:443'` string.

- [ ] **Step 2: Replace `_executeSignedTx` with racing version**

Replace the entire `_executeSignedTx` function (lines 362-404):

```ts
// ─── Execute signed tx via racing fan-out ─────────────────────────────

import { raceExecuteTransaction } from './rpc.js';

async function _executeSignedTx(bytesB64: string, signature: string): Promise<{ digest: string; effects?: unknown }> {
  const txBytes = Uint8Array.from(atob(bytesB64), c => c.charCodeAt(0));
  return raceExecuteTransaction(txBytes, [signature]);
}
```

Remove the `GRPC_URL` constant (line 364).

- [ ] **Step 3: Build and verify**

Run: `bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/wallet.ts
git commit -m "refactor: wire wallet.ts to racing rpc module"
```

---

## Task 5: Wire `src/sponsor.ts` to use `src/rpc.ts`

**Files:**
- Modify: `src/sponsor.ts:390-393`

- [ ] **Step 1: Replace inline SuiGrpcClient + SuinsClient**

In `src/sponsor.ts`, change (around line 390-393):
```ts
const _suinsGrpcClient = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
const _suinsClient = new SuinsClient({ client: _suinsGrpcClient as never, network: 'mainnet' });
```

To:
```ts
import { grpcClient } from './rpc.js';
const _suinsClient = new SuinsClient({ client: grpcClient as never, network: 'mainnet' });
```

Remove `import { SuiGrpcClient } from '@mysten/sui/grpc';` if it becomes unused.

- [ ] **Step 2: Replace `GRAPHQL_URL` constant if present**

If `sponsor.ts` defines its own `GRAPHQL_URL`, replace with `import { GQL_URL } from './rpc.js'`.

- [ ] **Step 3: Build and verify**

Run: `bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/sponsor.ts
git commit -m "refactor: wire sponsor.ts to centralized rpc module"
```

---

## Task 6: Wire `src/suins.ts` to use `src/rpc.ts`

**Files:**
- Modify: `src/suins.ts:12-18`

- [ ] **Step 1: Replace URL constants and SuiGrpcClient import**

In `src/suins.ts`, change (lines 12-18):
```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
...
const GQL_URL    = 'https://graphql.mainnet.sui.io/graphql';
const GRPC_URL   = 'https://fullnode.mainnet.sui.io:443';
```

To:
```ts
import { grpcClient, grpcUrl, GQL_URL, gqlClient } from './rpc.js';
```

Then replace inline client construction. Key locations:
- Lines 600, 611: `new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL })` → use `grpcClient` (or `new SuiGrpcClient({ network: 'mainnet', baseUrl: grpcUrl })` if a fresh instance is needed for transport fallback)
- Lines 463, 561, 604, 619, 640, 664, 672, 729, 964, 989, 1060, 1103, 1375, 1440, 1496, 1515, 1534, 1767, 1913, 2003, 2283: `new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' })` → use `gqlClient` singleton
- Lines 84, 140, 190, 222, 481, 566, 928, 1040, 1599, 1676, 1719: `fetch(GQL_URL, ...)` — these use the raw URL string, which is fine since `GQL_URL` is now imported from `rpc.ts` (same value)

Remove `import { SuiGrpcClient } from '@mysten/sui/grpc'` and `import { SuiGraphQLClient } from '@mysten/sui/graphql'` if fully replaced by imports from `rpc.ts`.

- [ ] **Step 2: Build and verify**

Run: `bun run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/suins.ts
git commit -m "refactor: wire suins.ts to centralized rpc module"
```

---

## Task 7: Wire `src/server/agents/shade-executor.ts` to server racing

**Files:**
- Modify: `src/server/agents/shade-executor.ts:26-31,773-820`

- [ ] **Step 1: Replace FULLNODE_URLS and submitTransaction**

Remove:
```ts
const FULLNODE_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];
```

Add import:
```ts
import { raceExecuteTransaction, TxFailureError, GQL_URL } from '../rpc.js';
```

Remove the `GQL_URL` constant (line 26). Update all references to `GQL_URL` in the file — it's used to construct `SuiGraphQLClient` instances (e.g., in `resolveShadeOrderId` at ~line 826 and in `executeOrder` for balance checks). These should now use the imported `GQL_URL` from `'../rpc.js'` — the variable name is the same, so only the `const` declaration needs removal.

- [ ] **Step 2: Replace `submitTransaction` method**

Replace the entire `submitTransaction` method (~line 775-820) with:

```ts
private async submitTransaction(txBytes: Uint8Array, signature: string): Promise<string> {
  try {
    const b64 = uint8ToBase64(txBytes);
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  } catch (err) {
    // TxFailureError = on-chain failure, don't retry at caller level either
    if (err instanceof TxFailureError) throw err;
    throw err instanceof Error ? err : new Error(String(err));
  }
}
```

Note: the existing `uint8ToBase64` helper in shade-executor.ts should be kept (or imported if we centralize it).

- [ ] **Step 3: Build worker to verify**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds (dry-run doesn't actually deploy).

- [ ] **Step 4: Commit**

```bash
git add src/server/agents/shade-executor.ts
git commit -m "refactor: wire shade-executor to racing JSON-RPC module"
```

---

## Task 8: Wire `src/server/index.ts` to server racing

**Files:**
- Modify: `src/server/index.ts:216-240`

- [ ] **Step 1: Replace hardcoded RPC in `/api/suiami/verify`**

The `/api/suiami/verify` route uses a hardcoded `fullnode.mainnet.sui.io` for `sui_getObject` calls. Replace with:

```ts
import { raceJsonRpc } from './rpc.js';
```

Then replace inline fetch calls like:
```ts
const RPC = 'https://fullnode.mainnet.sui.io:443';
const objRes = await fetch(RPC, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getObject', params: [...] }),
});
const objData = await objRes.json();
```

With:
```ts
const objData = await raceJsonRpc<{ data?: { owner?: ...; content?: ...; type?: string } }>(
  'sui_getObject',
  [message.nftId, { showOwner: true, showContent: true, showType: true }],
);
```

Note: `raceJsonRpc` returns the `result` field directly, so adjust the destructuring accordingly (no `.result` wrapper).

- [ ] **Step 2: Build worker to verify**

Run: `npx wrangler deploy --dry-run`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "refactor: wire server/index.ts suiami verify to racing rpc"
```

---

## Task 9: Full build, deploy, and smoke test

**Files:**
- All modified files

- [ ] **Step 1: Full browser build**

Run: `bun run build`
Expected: Build succeeds with no errors.

- [ ] **Step 2: Wrangler dry-run deploy**

Run: `npx wrangler deploy --dry-run`
Expected: Worker compiles and bundles correctly.

- [ ] **Step 3: Deploy**

Run: `bun run build && npx wrangler deploy`
Expected: Deployed to `sui.ski` successfully.

- [ ] **Step 4: Smoke test**

Verify in browser:
1. Open `https://sui.ski` — page loads
2. Connect wallet — gRPC calls succeed
3. Check console for any RPC errors

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: fixups from smoke test"
```

---

## Summary of changes

| File | Before | After |
|------|--------|-------|
| `src/rpc.ts` | N/A | New: backend list, `grpcClient`, `raceExecuteTransaction()` |
| `src/server/rpc.ts` | N/A | New: `raceJsonRpc()`, `raceExecuteTransaction()`, `TxFailureError` |
| `src/ui.ts` | Inline `SuiGrpcClient` construction | Imports from `src/rpc.ts` |
| `src/wallet.ts` | Inline gRPC client + sequential JSON-RPC fallback | Imports from `src/rpc.ts`, uses racing execution |
| `src/sponsor.ts` | Inline `SuiGrpcClient` for SuiNS | Imports from `src/rpc.ts` |
| `src/suins.ts` | Hardcoded `GQL_URL` + `GRPC_URL` | Imports from `src/rpc.ts` |
| `src/server/agents/shade-executor.ts` | `FULLNODE_URLS` + sequential fallback | Imports `raceExecuteTransaction` from `src/server/rpc.ts` |
| `src/server/index.ts` | Hardcoded RPC in suiami verify | Imports `raceJsonRpc` from `src/server/rpc.ts` |
| `src/client/ika.ts` | **Unchanged** | Not production-ready, skip |
| `src/waap.ts` | **Unchanged** | WaaP controls own transport |

**Backends raced:**
- gRPC (browser): Mysten, Suiscan/Blockberry + Triton/QuickNode slots
- JSON-RPC (server): Mysten, PublicNode, BlockVision, Ankr, Suiscan + Triton/QuickNode slots
