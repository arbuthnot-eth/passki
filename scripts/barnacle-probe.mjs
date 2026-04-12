// Probe: find all live Thunder IOU escrows / ShieldedVaults involving
// brando.sui and/or barnacle.sui, and any shade orders where they're a
// party. Report recoverable amounts + the recall/claim path for each.
//
// Run: node scripts/barnacle-probe.mjs
const GQL = 'https://graphql.mainnet.sui.io/graphql';
const IOU_PKG = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const IOU_TYPE = `${IOU_PKG}::iou::Iou`;
const SHIELDED_PKG = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782';
const SHIELDED_TYPE = `${SHIELDED_PKG}::shielded::ShieldedVault`;
const SHADE_PKG = '0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203';
const SHADE_TYPE = `${SHADE_PKG}::shade::ShadeOrder`;

async function gql(query, variables = {}) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
}

async function resolve(name) {
  // SuiNS reverse: query the nameservice registry directly via GraphQL.
  // Simpler: curl the @mysten/suins via suins.io public API.
  const r = await fetch(`https://suins.io/api/domains/${name}`);
  if (r.ok) {
    const j = await r.json();
    return j?.targetAddress || null;
  }
  return null;
}

async function fetchObjectsByType(type, limit = 50) {
  // Pull all live objects of a given type, page up to `limit`. We can't
  // filter by shared-object sender/recipient in a single query — so we
  // fetch and post-filter in JS.
  const out = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const q = `query($t:String!,$c:String){ objects(filter:{type:$t},first:50,after:$c){ nodes { address version asMoveObject { contents { json } } } pageInfo { hasNextPage endCursor } } }`;
    const j = await gql(q, { t: type, c: cursor });
    const data = j?.data?.objects;
    if (!data?.nodes) { if (j.errors) console.warn('  !gql', JSON.stringify(j.errors).slice(0, 200)); break; }
    out.push(...data.nodes);
    if (!data.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
    if (out.length >= limit) break;
  }
  return out;
}

function norm(a) { return (a || '').toLowerCase(); }

console.log('→ resolving brando.sui and barnacle.sui…');
const [brando, barnacle] = await Promise.all([resolve('brando.sui'), resolve('barnacle.sui')]);
console.log('  brando.sui  →', brando);
console.log('  barnacle.sui →', barnacle);
if (!brando && !barnacle) { console.log('  (could not resolve either — falling back to scanning)'); }

const targets = new Set([brando, barnacle].filter(Boolean).map(norm));

const tableau = [
  { label: 'Thunder IOU (legacy)', type: IOU_TYPE },
  { label: 'Shielded Thunder vault', type: SHIELDED_TYPE },
  { label: 'Shade order', type: SHADE_TYPE },
];

for (const { label, type } of tableau) {
  console.log(`\n──── ${label} ────`);
  const nodes = await fetchObjectsByType(type);
  console.log(`  live objects found: ${nodes.length}`);
  let matches = 0;
  for (const n of nodes) {
    const j = n.asMoveObject?.contents?.json || {};
    const sender = norm(j.sender || j.owner || j.owner_address);
    const recipient = norm(j.recipient || j.recipient_address || j.target_address);
    const amount = j.balance || j.amount || j.deposit_mist;
    const expires = j.expires_ms;
    const nameHash = j.name_hash;
    const isMatch = (targets.size === 0) ? false : (targets.has(sender) || targets.has(recipient));
    if (!isMatch) continue;
    matches++;
    console.log(`  ${n.address}`);
    if (sender)    console.log(`    sender:    ${sender}${targets.has(sender) ? ' ★' : ''}`);
    if (recipient) console.log(`    recipient: ${recipient}${targets.has(recipient) ? ' ★' : ''}`);
    if (amount)    console.log(`    amount:    ${amount}`);
    if (expires)   console.log(`    expires:   ${new Date(Number(expires)).toISOString()}  (${Number(expires) < Date.now() ? 'EXPIRED' : 'live'})`);
    if (nameHash)  console.log(`    nameHash:  ${typeof nameHash === 'string' ? nameHash.slice(0, 16) + '…' : JSON.stringify(nameHash).slice(0, 40)}`);
  }
  console.log(`  matched: ${matches}`);
}
