// Full audit of every Thunder IOU / Shielded vault touching brando.sui
// or barnacle.sui — by sender and by recipient, live vs expired vs
// recalled. Answers "where did my recent sends go?".
//
// Run: node scripts/vault-audit.mjs
import { SuinsClient } from '@mysten/suins';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GQL = 'https://graphql.mainnet.sui.io/graphql';
const IOU_PKG = '0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79';
const IOU_TYPE = `${IOU_PKG}::iou::Iou`;
const SHIELDED_PKG = '0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782';
const SHIELDED_TYPE = `${SHIELDED_PKG}::shielded::ShieldedVault`;

const gql = new SuiGraphQLClient({ url: GQL, network: 'mainnet' });
const suins = new SuinsClient({ client: gql, network: 'mainnet' });

async function q(query, variables = {}) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
}

async function resolveAll(names) {
  const out = {};
  for (const n of names) {
    try {
      const rec = await suins.getNameRecord(n);
      out[n] = rec?.targetAddress || null;
    } catch { out[n] = null; }
  }
  return out;
}

async function scanType(type) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const query = `query($t:String!,$c:String){ objects(filter:{type:$t}, first:50, after:$c){ nodes { address version asMoveObject { contents { json } } } pageInfo { hasNextPage endCursor } } }`;
    const j = await q(query, { t: type, c: cursor });
    const data = j?.data?.objects;
    if (!data?.nodes) break;
    out.push(...data.nodes);
    if (!data.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  return out;
}

async function balance(addr) {
  const j = await q(`{ address(address: "${addr}") { balance(coinType: "0x2::sui::SUI") { totalBalance } } }`);
  return BigInt(j?.data?.address?.balance?.totalBalance || '0');
}

async function recentRecallsFor(targetAddr) {
  // Query all successful shielded::recall + legacy iou::recall txs and
  // pick out balance-change credits to targetAddr in the last day.
  const types = [
    `${SHIELDED_PKG}::shielded::recall`,
    `${IOU_PKG}::iou::recall`,
    `${IOU_PKG}::iou::recall_after_ttl`,
  ];
  const credits = [];
  for (const fn of types) {
    const j = await q(`{ transactions(last: 50, filter: {function: "${fn}"}) { nodes { digest effects { status checkpoint { timestamp } balanceChanges { nodes { owner { address } amount coinType { repr } } } } } } }`);
    const nodes = j?.data?.transactions?.nodes || [];
    for (const t of nodes) {
      if (t.effects?.status !== 'SUCCESS') continue;
      const ts = t.effects?.checkpoint?.timestamp || '';
      for (const c of t.effects?.balanceChanges?.nodes || []) {
        if (c.owner?.address?.toLowerCase() === targetAddr.toLowerCase()) {
          const amt = Number(BigInt(c.amount)) / 1e9;
          if (amt > 0) credits.push({ digest: t.digest, ts, fn, amt });
        }
      }
    }
  }
  return credits;
}

const NAMES = ['brando.sui', 'barnacle.sui'];
console.log('→ resolving targets…');
const addrs = await resolveAll(NAMES);
for (const n of NAMES) console.log(' ', n, '→', addrs[n]);

console.log('\n→ current SUI balances…');
for (const n of NAMES) {
  const b = addrs[n] ? await balance(addrs[n]) : 0n;
  console.log(` ${n}: ${(Number(b) / 1e9).toFixed(4)} SUI`);
}

console.log('\n→ recent recalls crediting each target…');
for (const n of NAMES) {
  if (!addrs[n]) continue;
  const credits = await recentRecallsFor(addrs[n]);
  console.log(`\n  ${n}: ${credits.length} recall credit(s)`);
  let sum = 0;
  for (const c of credits) {
    console.log(`    ${c.digest.slice(0,12)}…  ${c.ts}  +${c.amt.toFixed(4)} SUI  (${c.fn.split('::').slice(-2).join('::')})`);
    sum += c.amt;
  }
  console.log(`    total recalled-in: ${sum.toFixed(4)} SUI`);
}

console.log('\n→ scanning all live vaults touching either name…');
const targets = new Map();
for (const [n, a] of Object.entries(addrs)) if (a) targets.set(a.toLowerCase(), n);

for (const [label, type] of [['Thunder IOU', IOU_TYPE], ['Shielded vault', SHIELDED_TYPE]]) {
  const nodes = await scanType(type);
  const hits = [];
  for (const v of nodes) {
    const j = v.asMoveObject?.contents?.json || {};
    const sender = (j.sender || '').toLowerCase();
    const recipient = (j.recipient || '').toLowerCase();
    const s = targets.get(sender);
    const r = targets.get(recipient);
    if (!s && !r) continue;
    hits.push({ addr: v.address, sender: s, recipient: r, bal: BigInt(j.balance || 0), exp: Number(j.expires_ms || 0) });
  }
  console.log(`\n  ${label}: ${hits.length} match(es) in ${nodes.length} live objects`);
  let sum = 0n;
  for (const h of hits) {
    const state = h.exp && h.exp <= Date.now() ? 'EXPIRED' : 'live';
    const sym = h.sender ? `[${h.sender}]` : '  (?)  ';
    const rsm = h.recipient ? `→[${h.recipient}]` : '→(?)  ';
    console.log(`    ${h.addr.slice(0,10)}…  ${sym}${rsm}  ${(Number(h.bal)/1e9).toFixed(4)} SUI  ${state}`);
    sum += h.bal;
  }
  console.log(`    total still locked: ${(Number(sum)/1e9).toFixed(4)} SUI`);
}
