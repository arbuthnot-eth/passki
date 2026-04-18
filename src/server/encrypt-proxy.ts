/**
 * Encrypt Proxy — CF Worker bridge for the dWallet Encrypt pre-alpha service
 *
 * The browser-side `src/client/encrypt.ts` POSTs JSON to `/api/encrypt/*`.
 * This Hono sub-app answers those calls.
 *
 * ---------------------------------------------------------------------------
 * WHY A STUB?
 * ---------------------------------------------------------------------------
 * Cloudflare Workers cannot speak HTTP/2, and there is no native gRPC client
 * that works in the Workers runtime. That leaves three options for reaching
 * the upstream Encrypt service at `pre-alpha-dev-1.encrypt.ika-network.net:443`:
 *
 *   1. gRPC-Web over HTTP/1.1 — requires a gRPC-Web gateway on the upstream
 *      AND protoc-generated TypeScript for framing/parsing. Neither is
 *      currently available for the pre-alpha service.
 *   2. grpc-gateway JSON/REST — requires the upstream to expose a REST gateway.
 *      Unknown whether one exists.
 *   3. Stub / mock — bypass the upstream entirely, return realistic-looking
 *      responses so the browser client flow is exercisable end-to-end.
 *
 * Given the pre-alpha nature of Encrypt (no real encryption anyway — values
 * are plaintext on-chain and the service wipes data periodically before
 * Alpha 1), the STUB approach is preferred. It unblocks the devnet frontend
 * immediately and can be swapped for real gRPC-Web once proto definitions
 * and a confirmed gateway URL are available.
 *
 * TODO(encrypt-proxy): Replace stub handlers with real gRPC-Web calls once:
 *   - Proto definitions for `encrypt.v1.EncryptService` are published
 *   - protoc-generated TypeScript is added to the repo (or hand-written
 *     protobuf encoders for the 4–5 request/response messages we use)
 *   - Upstream gRPC-Web gateway URL is confirmed
 *   - See `buildGrpcWebFrame` / `parseGrpcWebFrame` helpers below for the
 *     wire-format scaffold.
 * ---------------------------------------------------------------------------
 */

import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Environment bindings used by the encrypt proxy. Kept local so we don't have
 * to edit the root `index.ts` env type.
 */
export interface EncryptProxyEnv {
  /** Upstream gRPC endpoint. Optional — falls back to pre-alpha devnet. */
  ENCRYPT_GRPC_URL?: string;
}

const DEFAULT_ENCRYPT_GRPC_URL = 'pre-alpha-dev-1.encrypt.ika-network.net:443';

/** Resolve the upstream URL with fallback. */
function resolveUpstream(env: EncryptProxyEnv): string {
  return env.ENCRYPT_GRPC_URL || DEFAULT_ENCRYPT_GRPC_URL;
}

/**
 * Convert a `host:port` gRPC endpoint into an `https://host` base URL suitable
 * for `fetch()` against a gRPC-Web gateway. Port 443 is the default so we can
 * safely drop it; any other port is preserved.
 */
function grpcEndpointToHttpBase(endpoint: string): string {
  const [host, port] = endpoint.split(':');
  if (!port || port === '443') return `https://${host}`;
  return `https://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Types (mirror src/client/encrypt.ts)
// ---------------------------------------------------------------------------

// TODO: replace with protoc-generated types when proto files are available
interface CreateInputRequest {
  value: string;       // base64
  fheType: number;
  programId: string;
  networkKey: string;
}

interface CreateInputResponse {
  ciphertextId: string;
  txSignature?: string;
}

interface DecryptionRequest {
  ciphertextId: string;
}

interface DecryptionResponse {
  value: string;       // base64
  fheType: number;
}

interface CiphertextInfo {
  id: string;
  fheType: number;
  programId: string;
  decrypted: boolean;
}

interface NetworkKeyResponse {
  key: string;         // base64
}

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const STUB_MODE_HEADER = ['X-Encrypt-Proxy-Mode', 'stub'] as const;

function stubLog(method: string, extra?: Record<string, unknown>): void {
  // Prefix is intentional so it grep-greps well in wrangler tail output.
  console.log(
    `[encrypt-proxy] STUB MODE — upstream gRPC not yet wired (${method})`,
    extra ?? {},
  );
}

/** Deterministic-ish stub ciphertext ID. */
function stubCiphertextId(): string {
  // crypto.randomUUID is available in the Workers runtime.
  return `stub_ct_${crypto.randomUUID()}`;
}

/** Stub Solana tx signature — 88 chars of base58-ish goo. */
function stubTxSignature(): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 88; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Stub network key — fixed marker so the browser can sanity-check it. */
const STUB_NETWORK_KEY_B64 = 'U1RVQl9ORVRXT1JLX0tFWV9CNjQ='; // "STUB_NETWORK_KEY_B64"

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

/**
 * Mount at `/api/encrypt` in the parent worker:
 *
 *     app.route('/api/encrypt', encryptProxy);
 */
export const encryptProxy = new Hono<{ Bindings: EncryptProxyEnv }>();

// -- health -----------------------------------------------------------------

encryptProxy.get('/health', (c) => {
  const upstream = resolveUpstream(c.env);
  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  return c.json({
    ok: true,
    endpoint: upstream,
    mode: 'stub',
    note: 'Encrypt proxy is in STUB MODE — upstream gRPC not yet wired.',
  });
});

// -- network key ------------------------------------------------------------

encryptProxy.get('/network_key', (c) => {
  stubLog('getNetworkKey');
  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  const res: NetworkKeyResponse = { key: STUB_NETWORK_KEY_B64 };
  return c.json(res);
});

// -- create input ciphertext ------------------------------------------------

encryptProxy.post('/create_input', async (c) => {
  let body: CreateInputRequest;
  try {
    body = await c.req.json<CreateInputRequest>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  if (typeof body.value !== 'string' || typeof body.fheType !== 'number') {
    return c.json(
      { error: 'missing required fields: value (base64 string), fheType (number)' },
      400,
    );
  }

  stubLog('createInput', {
    fheType: body.fheType,
    programId: body.programId,
    valueLen: body.value.length,
  });

  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  const res: CreateInputResponse = {
    ciphertextId: stubCiphertextId(),
    txSignature: stubTxSignature(),
  };
  return c.json(res);
});

// -- decrypt ----------------------------------------------------------------

encryptProxy.post('/decrypt', async (c) => {
  let body: DecryptionRequest;
  try {
    body = await c.req.json<DecryptionRequest>();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  if (!body.ciphertextId || typeof body.ciphertextId !== 'string') {
    return c.json({ error: 'missing required field: ciphertextId' }, 400);
  }

  stubLog('decrypt', { ciphertextId: body.ciphertextId });

  // Pre-alpha: there is no real encryption. Return an 8-byte zero buffer as
  // a plausible Uint64 "decryption" so the browser decodeValue() call yields
  // 0n rather than throwing.
  const zero8 = new Uint8Array(8);
  const value = btoa(String.fromCharCode(...zero8));

  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  const res: DecryptionResponse = {
    value,
    fheType: 4, // FheType.Uint64
  };
  return c.json(res);
});

// -- ciphertext info --------------------------------------------------------

encryptProxy.get('/ciphertext/:id', (c) => {
  const id = c.req.param('id');
  stubLog('getCiphertext', { id });

  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  const res: CiphertextInfo = {
    id,
    fheType: 4, // FheType.Uint64
    programId: '4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8',
    decrypted: false,
  };
  return c.json(res);
});

// -- catch-all --------------------------------------------------------------

encryptProxy.all('*', (c) => {
  c.header(STUB_MODE_HEADER[0], STUB_MODE_HEADER[1]);
  return c.json(
    {
      error: 'not_implemented',
      message:
        '[encrypt-proxy] Unknown route. STUB MODE only implements: GET /health, GET /network_key, POST /create_input, POST /decrypt, GET /ciphertext/:id',
      upstream: resolveUpstream(c.env),
    },
    501,
  );
});

export default encryptProxy;
