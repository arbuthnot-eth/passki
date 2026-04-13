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

// Must match client/thunder-stack.ts THUNDER_IOU_PACKAGE /
// THUNDER_IOU_SHIELDED_PACKAGE.
const THUNDER_IOU_PACKAGE = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const IOU_TYPE = `${THUNDER_IOU_PACKAGE}::iou::Iou`;
const THUNDER_IOU_SHIELDED_PACKAGE = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782';
const SHIELDED_TYPE = `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::ShieldedVault`;

interface SweeperEnv {
  SHADE_KEEPER_PRIVATE_KEY?: string;
  SUI_NETWORK?: string; // 'mainnet' | 'testnet'
}

interface IouSnapshot {
  address: string;
  /** Current on-chain version — present on every object. */
  version: number;
  /** Initial shared version, captured from the Shared owner. Required
   *  to reference the object as `sharedObjectRef` in a PTB. */
  initialSharedVersion: number;
  sender: string;
  recipient: string;
  expiresMs: number;
  amountMist: string;
  /** 'legacy' → thunder_iou::Iou, 'shielded' → thunder_iou_shielded::ShieldedVault */
  kind: 'legacy' | 'shielded';
}

/** Fetch all live shared escrows of a given type. Generic over both
 *  the legacy thunder_iou::Iou and the newer thunder_iou_shielded::
 *  ShieldedVault so one helper can scan either pool.
 *
 *  Uses a direct fetch() instead of SuiGraphQLClient.query() — the SDK
 *  wrapper was silently dropping the response for object-type filters
 *  (likely a variables-binding bug), leaving the sweeper with zero live
 *  vaults and nothing to recall. Probing the endpoint by hand works. */
async function fetchLiveVaults(type: string, kind: 'legacy' | 'shielded'): Promise<IouSnapshot[]> {
  const out: IouSnapshot[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 8; page++) {
    const query = `query($type: String!, $cursor: String) {
      objects(filter: { type: $type }, first: 50, after: $cursor) {
        nodes {
          address
          version
          owner { __typename ... on Shared { initialSharedVersion } }
          asMoveObject { contents { json } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    let data: unknown;
    try {
      const r = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { type, cursor } }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.json() as { data?: unknown; errors?: Array<{ message: string }> };
      if (body.errors) {
        console.warn(`[iou-sweeper] gql errors for ${kind}:`, body.errors.map((e) => e.message).join('; '));
        break;
      }
      data = body.data;
    } catch (err) {
      console.warn(`[iou-sweeper] gql fetch failed for ${kind}:`, err instanceof Error ? err.message : err);
      break;
    }
    type GqlNode = {
      address: string;
      version: string | number;
      owner?: { __typename?: string; initialSharedVersion?: string | number };
      asMoveObject?: { contents?: { json?: { sender?: string; recipient?: string; expires_ms?: string | number; balance?: string | number } } };
    };
    const root = data as { objects?: { nodes?: GqlNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | undefined;
    const nodes = root?.objects?.nodes ?? [];
    for (const n of nodes) {
      const json = n.asMoveObject?.contents?.json;
      if (!json) continue;
      const isv = n.owner?.initialSharedVersion;
      if (isv === undefined) continue; // not a shared object — skip
      out.push({
        address: n.address,
        version: Number(n.version),
        initialSharedVersion: Number(isv),
        sender: String(json.sender || ''),
        recipient: String(json.recipient || ''),
        expiresMs: Number(json.expires_ms || 0),
        amountMist: String(json.balance || '0'),
        kind,
      });
    }
    const pi = root?.objects?.pageInfo;
    if (!pi?.hasNextPage || !pi.endCursor) break;
    cursor = pi.endCursor;
  }
  return out;
}

/** Fetch all live escrows across both the legacy Iou and the shielded
 *  ShieldedVault types. Union result, tagged per entry so the
 *  recall builder can target the right move function. */
async function fetchLiveIous(): Promise<IouSnapshot[]> {
  const [legacy, shielded] = await Promise.all([
    fetchLiveVaults(IOU_TYPE, 'legacy').catch(() => [] as IouSnapshot[]),
    fetchLiveVaults(SHIELDED_TYPE, 'shielded').catch(() => [] as IouSnapshot[]),
  ]);
  return [...legacy, ...shielded];
}

/** Build + sign + submit a recall PTB for a single expired IOU. */
async function recallOne(iou: IouSnapshot, keypair: Ed25519Keypair): Promise<{ ok: boolean; digest?: string; error?: string }> {
  try {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(keypair.toSuiAddress()));
    const recallTarget = iou.kind === 'shielded'
      ? `${THUNDER_IOU_SHIELDED_PACKAGE}::shielded::recall`
      : `${THUNDER_IOU_PACKAGE}::iou::recall`;
    tx.moveCall({
      target: recallTarget,
      arguments: [
        tx.sharedObjectRef({ objectId: iou.address, initialSharedVersion: iou.initialSharedVersion, mutable: true }),
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
  // Thunder IOU packages are mainnet-only — devnet worker sets SUI_NETWORK=testnet
  // and has no mainnet keeper, so skip cleanly instead of burning cron cycles.
  const network = (env.SUI_NETWORK || 'mainnet').toLowerCase();
  if (network !== 'mainnet') {
    console.log('[iou-sweeper] non-mainnet worker — skipping');
    return { scanned: 0, expired: 0, recalled: 0, failed: 0 };
  }
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
