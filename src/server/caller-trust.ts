// Caller identity for Worker → TreasuryAgents requests.
//
// Treasury methods guarded by requireUltronCaller(params.callerAddress) read
// that field from the JSON body, and many Worker routes forward client bodies
// verbatim. ultron's address is public, so a client could simply add
// `callerAddress: <ultron>` and act as ultron. The DO therefore drops the
// field unless the Worker vouches for it with `x-ski-as-ultron`, whose value
// is the internal token (unknown to clients).

import { internalAuthToken, constantTimeEqual, type UltronEnv } from './ultron-key.js';

/**
 * Remove `callerAddress` from a JSON request body unless the request carries
 * `x-ski-as-ultron` equal to the internal token.
 */
export async function stripUntrustedCaller(request: Request, env: UltronEnv): Promise<Request> {
  if (request.method !== 'POST' && request.method !== 'PUT') return request;
  if (constantTimeEqual(request.headers.get('x-ski-as-ultron'), internalAuthToken(env))) return request;
  let text: string;
  try { text = await request.clone().text(); } catch { return request; }
  if (!text.includes('callerAddress')) return request;
  let body: unknown;
  try { body = JSON.parse(text); } catch { return request; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('callerAddress' in body)) return request;
  const { callerAddress: _dropped, ...rest } = body as Record<string, unknown>;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(rest) });
}

