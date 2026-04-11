/**
 * Thunder IOU sweeper — cron-driven cleanup of expired escrows.
 *
 * Invoked by the Cloudflare Worker's `scheduled()` handler every
 * 10 minutes (see wrangler.jsonc → triggers.crons). On each tick:
 *
 *   1. Query the Sui GraphQL for all `::iou::Iou` shared objects.
 *   2. Filter for ones whose `expires_ms` is in the past.
 *   3. For each, build + sign + submit a `recall` PTB using ultron's
 *      keeper key. `recall` is permissionless after TTL expiry and
 *      always returns the locked balance to `iou.sender`, so ultron
 *      just pays gas and triggers the return — no custody.
 *   4. Log success / failure counts.
 *
 * Expected steady-state cost:
 *   - 1 GraphQL query per tick (~1 KB out, small response)
 *   - N txs where N = expired IOUs this tick (usually 0)
 *   - Each recall tx returns ~gas rebate via object deletion, so the
 *     net cost to ultron is small.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { toBase64 } from '@mysten/sui/utils';

import { raceExecuteTransaction, GQL_URL } from './rpc.js';

// Must match client/thunder-stack.ts THUNDER_IOU_PACKAGE
const THUNDER_IOU_PACKAGE = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const IOU_TYPE = `${THUNDER_IOU_PACKAGE}::iou::Iou`;

interface SweeperEnv {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

interface IouSnapshot {
  address: string;
  version: number;
  sender: string;
  recipient: string;
  expiresMs: number;
  amountMist: string;
}

/** Fetch all live Thunder IOU shared objects. */
async function fetchLiveIous(): Promise<IouSnapshot[]> {
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  // Paginate through all objects of the Iou type. In practice we
  // expect < 1000 live IOUs at any given time; 200 per page with 5
  // page max is plenty of headroom.
  const out: IouSnapshot[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const query = `query($type: String!, $cursor: String) {
      objects(filter: { type: $type }, first: 200, after: $cursor) {
        nodes {
          address
          version
          asMoveObject { contents { json } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const res = await (gql as unknown as { query: (opts: { query: string; variables: Record<string, unknown> }) => Promise<{ data?: unknown }> }).query({
      query,
      variables: { type: IOU_TYPE, cursor },
    });
    type GqlNode = {
      address: string;
      version: string | number;
      asMoveObject?: { contents?: { json?: { sender?: string; recipient?: string; expires_ms?: string | number; balance?: string | number } } };
    };
    const data = res?.data as { objects?: { nodes?: GqlNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | undefined;
    const nodes = data?.objects?.nodes ?? [];
    for (const n of nodes) {
      const json = n.asMoveObject?.contents?.json;
      if (!json) continue;
      out.push({
        address: n.address,
        version: Number(n.version),
        sender: String(json.sender || ''),
        recipient: String(json.recipient || ''),
        expiresMs: Number(json.expires_ms || 0),
        amountMist: String(json.balance || '0'),
      });
    }
    const pi = data?.objects?.pageInfo;
    if (!pi?.hasNextPage || !pi.endCursor) break;
    cursor = pi.endCursor;
  }
  return out;
}

/** Build + sign + submit a recall PTB for a single expired IOU. */
async function recallOne(iou: IouSnapshot, keypair: Ed25519Keypair): Promise<{ ok: boolean; digest?: string; error?: string }> {
  try {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(keypair.toSuiAddress()));
    tx.moveCall({
      target: `${THUNDER_IOU_PACKAGE}::iou::recall`,
      arguments: [
        tx.sharedObjectRef({ objectId: iou.address, initialSharedVersion: iou.version, mutable: true }),
        tx.object('0x6'),
      ],
    });
    const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const txBytes = await tx.build({ client: transport as never });
    const { signature } = await keypair.signTransaction(txBytes);
    const { digest } = await raceExecuteTransaction(toBase64(txBytes), [signature]);
    return { ok: true, digest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Main sweeper entry. Called from the worker's scheduled() handler.
 * Errors are logged and swallowed so one bad IOU can't halt the sweep.
 */
export async function sweepExpiredIous(env: SweeperEnv): Promise<{ scanned: number; expired: number; recalled: number; failed: number }> {
  if (!env.SHADE_KEEPER_PRIVATE_KEY) {
    console.warn('[iou-sweeper] no SHADE_KEEPER_PRIVATE_KEY — skipping');
    return { scanned: 0, expired: 0, recalled: 0, failed: 0 };
  }
  const keypair = Ed25519Keypair.fromSecretKey(env.SHADE_KEEPER_PRIVATE_KEY);
  const now = Date.now();

  let live: IouSnapshot[] = [];
  try {
    live = await fetchLiveIous();
  } catch (err) {
    console.error('[iou-sweeper] fetch failed:', err instanceof Error ? err.message : err);
    return { scanned: 0, expired: 0, recalled: 0, failed: 0 };
  }

  const expired = live.filter(i => i.expiresMs > 0 && i.expiresMs <= now);
  if (expired.length === 0) {
    console.log(`[iou-sweeper] ${live.length} live IOUs, 0 expired — no work`);
    return { scanned: live.length, expired: 0, recalled: 0, failed: 0 };
  }

  console.log(`[iou-sweeper] ${live.length} live, ${expired.length} expired — recalling`);
  let recalled = 0;
  let failed = 0;
  for (const iou of expired) {
    const r = await recallOne(iou, keypair);
    if (r.ok) {
      recalled++;
      console.log(`[iou-sweeper] recalled ${iou.address.slice(0, 10)}… amt=${iou.amountMist} → ${iou.sender.slice(0, 10)}… digest=${r.digest}`);
    } else {
      failed++;
      console.warn(`[iou-sweeper] recall failed for ${iou.address.slice(0, 10)}…: ${r.error}`);
    }
  }
  return { scanned: live.length, expired: expired.length, recalled, failed };
}
