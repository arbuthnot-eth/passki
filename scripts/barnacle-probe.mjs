// Scan live Thunder IOU / ShieldedVault / ShadeOrder objects for two
// SuiNS identities and report recoverable amounts + the path to reclaim
// each. Run: node scripts/barnacle-probe.mjs
import { SuinsClient } from '@mysten/suins';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const IOU_PKG = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const IOU_TYPE = `${IOU_PKG}::iou::Iou`;
const SHIELDED_PKG = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782';
const SHIELDED_TYPE = `${SHIELDED_PKG}::shielded::ShieldedVault`;
const SHADE_PKG = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';
const SHADE_TYPE = `${SHADE_PKG}::shade::ShadeOrder`;

const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
const suins = new SuinsClient({ client: gql, network: 'mainnet' });

async function q(query, variables) {
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

console.log('→ resolving brando.sui and barnacle.sui…');
const [brandoRec, barnacleRec] = await Promise.all([
  suins.getNameRecord('brando.sui').catch(() => null),
  suins.getNameRecord('barnacle.sui').catch(() => null),
]);
const brando = brandoRec?.targetAddress || null;
const barnacle = barnacleRec?.targetAddress || null;
console.log('  brando.sui   →', brando);
console.log('  barnacle.sui →', barnacle);

const targets = new Map();
if (brando) targets.set(brando.toLowerCase(), 'brando');
if (barnacle) targets.set(barnacle.toLowerCase(), 'barnacle');

function label(addr) { return targets.get((addr || '').toLowerCase()) || null; }
function short(a) { return a ? a.slice(0, 10) + '…' + a.slice(-6) : '—'; }

async function scanType(type, limit = 300) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 12; page++) {
    const query = `query($t:String!,$c:String){
      objects(filter:{type:$t}, first:50, after:$c){
        nodes { address version asMoveObject { contents { json } } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const j = await q(query, { t: type, c: cursor });
    if (j.errors) { console.warn('  gql errors:', JSON.stringify(j.errors).slice(0, 200)); break; }
    const data = j.data?.objects;
    if (!data?.nodes) break;
    out.push(...data.nodes);
    if (!data.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
    if (out.length >= limit) break;
  }
  return out;
}

const sections = [
  { title: 'Thunder IOU (legacy escrow)', type: IOU_TYPE, sumLabel: 'SUI', dec: 9, amtField: ['balance', 'amount', 'locked_amount'] },
  { title: 'Shielded Thunder vault',      type: SHIELDED_TYPE, sumLabel: 'SUI', dec: 9, amtField: ['balance', 'amount'] },
  { title: 'Shade order deposit',         type: SHADE_TYPE, sumLabel: 'SUI', dec: 9, amtField: ['deposit_mist', 'deposit'] },
];

const totals = {};

for (const { title, type, sumLabel, dec, amtField } of sections) {
  console.log(`\n──── ${title} ────`);
  const nodes = await scanType(type);
  console.log(`  live objects on chain: ${nodes.length}`);
  let matched = 0;
  let totalRaw = 0n;
  const totalBySide = { asSender: 0n, asRecipient: 0n, asOwner: 0n };
  for (const n of nodes) {
    const j = n.asMoveObject?.contents?.json || {};
    const sender = j.sender || j.owner || j.owner_address || null;
    const recipient = j.recipient || j.recipient_address || j.target_address || null;
    const s = label(sender);
    const r = label(recipient);
    if (!s && !r) continue;
    matched++;
    let amt = 0n;
    for (const f of amtField) {
      if (j[f] != null) { amt = BigInt(j[f]); break; }
    }
    totalRaw += amt;
    if (s) totalBySide.asSender += amt;
    if (r) totalBySide.asRecipient += amt;
    const exp = j.expires_ms || j.execute_after_ms || j.expire_ms;
    const expStr = exp ? `exp=${new Date(Number(exp)).toISOString()}${Number(exp) < Date.now() ? ' EXPIRED' : ''}` : '';
    console.log(
      `  ${n.address.slice(0,10)}…  ` +
      `${s ? `[${s}]` : '  '}→${r ? `[${r}]` : '(?)  '}  ` +
      `${(Number(amt) / 10 ** dec).toFixed(4)} ${sumLabel}  ${expStr}`,
    );
  }
  console.log(`  matched: ${matched}  total: ${(Number(totalRaw) / 10 ** dec).toFixed(4)} ${sumLabel}`);
  console.log(`    as sender:    ${(Number(totalBySide.asSender) / 10 ** dec).toFixed(4)} ${sumLabel}`);
  console.log(`    as recipient: ${(Number(totalBySide.asRecipient) / 10 ** dec).toFixed(4)} ${sumLabel}`);
  totals[title] = totalRaw;
}

console.log('\n──── Summary ────');
for (const [k, v] of Object.entries(totals)) {
  console.log(`  ${k}: ${(Number(v) / 1e9).toFixed(4)} SUI`);
}
