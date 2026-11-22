/**
 * Route Sui JSON-RPC requests aimed at dead public endpoints to passki's
 * JSON-RPC shim (src/server/sui-jsonrpc-shim.ts).
 *
 * Public Sui JSON-RPC was shut down; many call sites still POST JSON-RPC to
 * sui-rpc.publicnode.com, fullnode.mainnet.sui.io, etc. This wraps
 * globalThis.fetch once so those requests are answered by the shim
 * instead — via /api/rpc in the browser, in-process on the Worker.
 *
 * Only POSTs with a string body containing a Sui JSON-RPC method are
 * touched. gRPC-Web (binary body) and everything else pass through.
 * Identical in-flight requests (e.g. code that races several backends)
 * share one shim call.
 */

const DEAD_SUI_JSONRPC_HOSTS = new Set([
  'sui-rpc.publicnode.com',
  'fullnode.mainnet.sui.io',
  'sui-mainnet-endpoint.blockvision.org',
  'rpc.ankr.com',
  'rpc-mainnet.suiscan.xyz',
]);

const SUI_METHOD = /"method"\s*:\s*"(sui|suix|unsafe)_/;

export type ShimHandler = (body: string) => Promise<Response>;

const INSTALLED = Symbol.for('passki.suiJsonRpcRedirect');

export function installSuiJsonRpcRedirect(handler: ShimHandler): void {
  const g = globalThis as any;
  if (g[INSTALLED]) return;
  const original: typeof fetch = g.fetch.bind(g);
  const inflight = new Map<string, Promise<Response>>();

  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const host = (() => { try { return new URL(url, 'https://passki.xyz').hostname; } catch { return ''; } })();
      if (DEAD_SUI_JSONRPC_HOSTS.has(host)) {
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        let body: string | undefined;
        if (typeof init?.body === 'string') body = init.body;
        else if (input instanceof Request && method === 'POST' && init?.body === undefined) body = await input.clone().text();
        if (method === 'POST' && body && SUI_METHOD.test(body)) {
          let p = inflight.get(body);
          if (!p) {
            p = handler(body).finally(() => inflight.delete(body!));
            inflight.set(body, p);
          }
          return (await p).clone();
        }
      }
    } catch { /* fall through to the real fetch */ }
    return original(input as any, init);
  };
  g[INSTALLED] = true;
}
