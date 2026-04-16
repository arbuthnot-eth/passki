// CF edge context endpoint for SUIAMI CF-history enrichment.
// Returns HMAC-signed CF metadata the client encrypts + uploads to Walrus.
//
// Nine fields, all sourced from request.cf + headers. HMAC is for
// tamper-evidence so future consumers can verify the data came from
// our edge — the data itself is user-known, not secret.

export interface CfFields {
  country: string;
  asn: number;
  threatScore: number;
  ipHash: string;
  colo: string;
  verifiedBot: boolean;
  tlsVersion: string;
  httpProtocol: string;
  attestedAt: number;
}

export interface CfContextResponse {
  data: CfFields;
  sig: string;
}

/** Canonical JSON — sorted keys, no whitespace. Stable across clients. */
function canonicalize(data: CfFields): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(data).sort()) {
    sorted[k] = (data as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleCfContext(
  req: Request,
  env: { CF_HMAC_SECRET?: string; CF_IP_SALT?: string },
): Promise<Response> {
  if (!env.CF_HMAC_SECRET || !env.CF_IP_SALT) {
    return new Response(JSON.stringify({ error: 'cf-context not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const data: CfFields = {
    country: String(req.headers.get('cf-ipcountry') ?? cf.country ?? 'XX'),
    asn: Number(cf.asn ?? 0),
    threatScore: Number(cf.threatScore ?? 0),
    ipHash: ip ? await sha256Hex(env.CF_IP_SALT + '\x1f' + ip) : '',
    colo: String(cf.colo ?? ''),
    verifiedBot: Boolean(cf.verifiedBot ?? false),
    tlsVersion: String(cf.tlsVersion ?? ''),
    httpProtocol: String(cf.httpProtocol ?? ''),
    attestedAt: Date.now(),
  };
  const sig = await hmac(env.CF_HMAC_SECRET, canonicalize(data));
  return new Response(JSON.stringify({ data, sig }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
