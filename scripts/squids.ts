#!/usr/bin/env bun
/**
 * squids — one-file CLI for SUIAMI roster management + local keystore.
 *
 *   bun run squids list
 *   bun run squids add    <name> [--sui 0x…] [--btc bc1…] [--eth 0x…] [--sol …]
 *   bun run squids get    <name>
 *   bun run squids remove <name>
 *   bun run squids publish <name>   — writes keystore → SUIAMI roster
 *   bun run squids bootstrap <name> [--sui …] [--btc …] [--eth …] [--sol …]
 *       (add + publish in one shot)
 *   bun run squids verify <name>    — reads roster and diffs against keystore
 *
 * Signing:
 *   - For the special identity `ultron`, delegates to the Worker endpoint
 *     /api/cache/ultron-roster (ultron's key lives in Worker secrets).
 *   - For any other name, signs via `sui client call` — the active sui cli
 *     address must be the intended record owner.
 *
 * Keystore:
 *   ~/.ski/squids.json  (JSON map name → {sui, btc, eth, sol}). Roster data
 *   is on-chain truth; this file is a local staging area for chain addresses
 *   that haven't been published yet (or for rotating records).
 *
 * Design anchor: reference_suiami_is_truth.md — the roster is the source of
 * truth. This CLI is one mechanism to WRITE to it; reads always hit the
 * roster directly.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3.js';

const ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
const ROSTER_PKG = '0x7bf4438feaf953e94b98dfc2aab0cf1aaad2250ee4e0fe87c9cc251965987de8';
const SUI_RPC = 'https://sui-rpc.publicnode.com';
const WORKER_URL = process.env.SKI_WORKER_URL || 'https://sui.ski';
// Per-repo keystore so snap-sandboxed bun and non-snap sh can both
// read/write it. Lives at $REPO/.ski/squids.json, gitignored.
const REPO_ROOT = (() => {
  // Walk up from script dir to find .git
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
})();
const KEYSTORE_PATH = join(REPO_ROOT, '.ski', 'squids.json');

type Chains = Partial<Record<'sui' | 'btc' | 'eth' | 'sol', string>>;
type Keystore = Record<string, Chains>;

// ─── Keystore I/O ──────────────────────────────────────────────────────

function loadKeystore(): Keystore {
  if (!existsSync(KEYSTORE_PATH)) return {};
  try { return JSON.parse(readFileSync(KEYSTORE_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveKeystore(ks: Keystore): void {
  mkdirSync(join(REPO_ROOT, '.ski'), { recursive: true });
  writeFileSync(KEYSTORE_PATH, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = args[++i] ?? ''; }
    else positional.push(a);
  }
  return { positional, flags };
}

// ─── Sui CLI shim ──────────────────────────────────────────────────────

let _suiBin: string | null = null;
function suiBin(): string {
  if (_suiBin) return _suiBin;
  if (process.env.SUI_BIN) { _suiBin = process.env.SUI_BIN; return _suiBin; }
  // Bun in snap sandbox rewrites $HOME — fall back to real path, then PATH.
  const cands = [
    '/home/brandon/.local/bin/sui',
    '/usr/local/bin/sui',
    `${homedir()}/.local/bin/sui`,
    '/usr/bin/sui',
    'sui',
  ];
  for (const cand of cands) {
    try { execSync(`${cand} --version`, { stdio: ['ignore', 'pipe', 'ignore'] }); _suiBin = cand; return cand; } catch { /* next */ }
  }
  throw new Error('sui cli not found. Set SUI_BIN=/path/to/sui or install it.');
}

function activeSuiAddress(): string {
  const out = execSync(`${suiBin()} client active-address`, { encoding: 'utf-8' }).trim();
  if (!out.startsWith('0x')) throw new Error(`sui client active-address returned: ${out}`);
  return out;
}

function publishViaSuiCli(name: string, chains: Chains): string {
  const sender = activeSuiAddress();
  // Ensure `sui` chain is set to the sender if the caller didn't specify.
  const merged: Chains = { sui: sender, ...chains };
  const keys = Object.keys(merged) as Array<keyof Chains>;
  const values = keys.map(k => merged[k]!);
  const nameHash = Array.from(keccak_256(new TextEncoder().encode(name)));
  const nameHashArr = '[' + nameHash.join(',') + ']';
  const keysArg = '[' + keys.map(k => `"${k}"`).join(',') + ']';
  const valsArg = '[' + values.map(v => `"${v}"`).join(',') + ']';
  const cmd = [
    `${suiBin()} client call`,
    `--package ${ROSTER_PKG}`,
    '--module roster',
    '--function set_identity',
    `--args ${ROSTER_OBJ} "${name}" "${nameHashArr}" "${keysArg}" "${valsArg}" "[]" "" "[]" 0x6`,
    '--gas-budget 100000000',
    '--json',
  ].join(' ');
  const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  // --json outputs full tx response; dig out the digest.
  try {
    const j = JSON.parse(out);
    return j.digest || j.effects?.transactionDigest || 'unknown';
  } catch {
    const m = out.match(/Digest:\s*([A-Za-z0-9]+)/);
    return m ? m[1] : 'unknown';
  }
}

async function publishUltronViaWorker(): Promise<string> {
  const res = await fetch(`${WORKER_URL}/api/cache/ultron-roster`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const j = await res.json() as { ok?: boolean; digest?: string; error?: string };
  if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j.digest ?? 'unknown';
}

// ─── Roster reads ──────────────────────────────────────────────────────

async function rosterRecordBySuiAddr(suiAddr: string): Promise<Chains | null> {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'suix_getDynamicFieldObject',
    params: [ROSTER_OBJ, { type: 'address', value: suiAddr }],
  };
  const r = await fetch(SUI_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json() as { result?: { data?: { content?: { fields?: { value?: { fields?: { chains?: { fields?: { contents?: Array<{ fields?: { key?: string; value?: string } }> } } } } } } } } };
  const contents = j.result?.data?.content?.fields?.value?.fields?.chains?.fields?.contents;
  if (!contents) return null;
  const chains: Chains = {};
  for (const entry of contents) {
    const k = entry.fields?.key;
    const v = entry.fields?.value;
    if (k && v && ['sui', 'btc', 'eth', 'sol'].includes(k)) chains[k as keyof Chains] = v;
  }
  return chains;
}

// ─── Commands ──────────────────────────────────────────────────────────

function cmdList(): void {
  const ks = loadKeystore();
  const names = Object.keys(ks).sort();
  if (!names.length) { console.log('(keystore empty — try `squids add <name>`)'); return; }
  for (const name of names) {
    const c = ks[name];
    const parts = (['sui', 'btc', 'eth', 'sol'] as const)
      .filter(k => c[k])
      .map(k => `${k}:${c[k]!.slice(0, 10)}…`);
    console.log(`${name}  ${parts.join(' ')}`);
  }
}

function cmdAdd(name: string, flags: Record<string, string>): void {
  if (!name) { console.error('usage: squids add <name> [--sui …] [--btc …] [--eth …] [--sol …]'); process.exit(1); }
  const ks = loadKeystore();
  const existing = ks[name] ?? {};
  const next: Chains = { ...existing };
  for (const k of ['sui', 'btc', 'eth', 'sol'] as const) {
    if (flags[k]) next[k] = flags[k];
  }
  ks[name] = next;
  saveKeystore(ks);
  console.log(`keystore[${name}] =`, next);
}

function cmdGet(name: string): void {
  const ks = loadKeystore();
  const entry = ks[name];
  if (!entry) { console.error(`not in keystore: ${name}`); process.exit(1); }
  console.log(JSON.stringify(entry, null, 2));
}

function cmdRemove(name: string): void {
  const ks = loadKeystore();
  if (!(name in ks)) { console.error(`not in keystore: ${name}`); process.exit(1); }
  delete ks[name];
  saveKeystore(ks);
  console.log(`removed ${name}`);
}

async function cmdPublish(name: string): Promise<void> {
  if (!name) { console.error('usage: squids publish <name>'); process.exit(1); }
  if (name === 'ultron') {
    const digest = await publishUltronViaWorker();
    console.log(`✓ ultron published via Worker — digest ${digest}`);
    return;
  }
  const ks = loadKeystore();
  const chains = ks[name];
  if (!chains) {
    console.error(`${name} not in keystore — run \`squids add ${name}\` first or pass chain flags to bootstrap`);
    process.exit(1);
  }
  const digest = publishViaSuiCli(name, chains);
  console.log(`✓ ${name} published via sui cli — digest ${digest}`);
}

async function cmdBootstrap(name: string, flags: Record<string, string>): Promise<void> {
  cmdAdd(name, flags);
  await cmdPublish(name);
}

async function resolveSuiNs(name: string): Promise<string | null> {
  const r = await fetch(SUI_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'suix_resolveNameServiceAddress',
      params: [`${name}.sui`],
    }),
  });
  const j = await r.json() as { result?: string | null };
  return j.result || null;
}

async function rosterRecordByName(name: string): Promise<{ chains: Chains; sender: string } | null> {
  const nameHash = Array.from(keccak_256(new TextEncoder().encode(name)));
  const body = {
    jsonrpc: '2.0', id: 1, method: 'suix_getDynamicFieldObject',
    params: [ROSTER_OBJ, { type: 'vector<u8>', value: nameHash }],
  };
  const r = await fetch(SUI_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json() as { result?: { data?: { content?: { fields?: { value?: { fields?: { sui_address?: string; chains?: { fields?: { contents?: Array<{ fields?: { key?: string; value?: string } }> } } } } } } } } };
  const v = j.result?.data?.content?.fields?.value?.fields;
  if (!v) return null;
  const chains: Chains = {};
  for (const entry of v.chains?.fields?.contents ?? []) {
    const k = entry.fields?.key;
    const val = entry.fields?.value;
    if (k && val && ['sui', 'btc', 'eth', 'sol'].includes(k)) chains[k as keyof Chains] = val;
  }
  return { chains, sender: v.sui_address ?? '' };
}

async function rosterRecordByChainAddr(chain: string, addr: string): Promise<{ name: string; chains: Chains } | null> {
  const key = `${chain}:${addr}`;
  const body = {
    jsonrpc: '2.0', id: 1, method: 'suix_getDynamicFieldObject',
    params: [ROSTER_OBJ, { type: '0x1::string::String', value: key }],
  };
  const r = await fetch(SUI_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json() as { result?: { data?: { content?: { fields?: { value?: { fields?: { name?: string; chains?: { fields?: { contents?: Array<{ fields?: { key?: string; value?: string } }> } } } } } } } } };
  const v = j.result?.data?.content?.fields?.value?.fields;
  if (!v) return null;
  const chains: Chains = {};
  for (const entry of v.chains?.fields?.contents ?? []) {
    const k = entry.fields?.key;
    const val = entry.fields?.value;
    if (k && val && ['sui', 'btc', 'eth', 'sol'].includes(k)) chains[k as keyof Chains] = val;
  }
  return { name: v.name ?? '', chains };
}

async function cmdChainAt(target: string): Promise<void> {
  const m = target.match(/^(sui|btc|eth|sol)@(.+)$/);
  if (!m) { console.error('usage: squids chainAt <chain>@<name>   e.g. eth@ultron'); process.exit(1); }
  const [, chain, name] = m;
  const rec = await rosterRecordByName(name);
  if (!rec) { console.log(`✗ no roster record for ${name}`); return; }
  const addr = (rec.chains as Record<string, string>)[chain];
  if (!addr) {
    console.log(`✗ ${name} has no ${chain} address in roster`);
    console.log(`  available: ${Object.keys(rec.chains).join(', ') || '(none)'}`);
    return;
  }
  console.log(addr);
}

async function cmdWho(target: string): Promise<void> {
  // Accepts "eth:0x…", "btc:bc1…", "sol:…", "sui:0x…", or a bare 0x… address (tries eth then sui).
  let parsed: { chain: string; addr: string } | null = null;
  const colon = target.match(/^(sui|btc|eth|sol):(.+)$/);
  if (colon) parsed = { chain: colon[1], addr: colon[2] };
  else if (target.startsWith('bc1') || target.startsWith('1') || target.startsWith('3')) parsed = { chain: 'btc', addr: target };
  else if (/^0x[0-9a-fA-F]{40}$/.test(target)) parsed = { chain: 'eth', addr: target };
  else if (/^0x[0-9a-fA-F]{64}$/.test(target)) parsed = { chain: 'sui', addr: target };
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target)) parsed = { chain: 'sol', addr: target };
  if (!parsed) { console.error(`usage: squids who <chain>:<addr> | <0x…> | <bc1…> | <sol-b58>`); process.exit(1); }
  const rec = await rosterRecordByChainAddr(parsed.chain, parsed.addr);
  if (!rec) { console.log(`✗ no roster record for ${parsed.chain}:${parsed.addr.slice(0, 20)}…`); return; }
  console.log(`${rec.name}`);
  for (const [k, v] of Object.entries(rec.chains)) {
    console.log(`  ${k}  ${v}`);
  }
}

async function cmdVerify(name: string): Promise<void> {
  const ks = loadKeystore();
  const local = ks[name];
  // Resolve sui address: keystore wins, else SuiNS, else active sui cli.
  let sender = local?.sui;
  if (!sender) sender = (await resolveSuiNs(name)) ?? undefined;
  if (!sender) { console.error(`can't resolve sui addr for ${name} — add to keystore or register ${name}.sui`); process.exit(1); }
  const onchain = await rosterRecordBySuiAddr(sender);
  if (!onchain) {
    console.log(`✗ ${name} NOT in roster for ${sender.slice(0, 10)}…`);
    if (local) console.log(`  local: ${JSON.stringify(local)}`);
    return;
  }
  console.log(`on-chain: ${JSON.stringify(onchain)}`);
  if (!local) { console.log(`(no keystore entry — roster-only view)`); return; }
  const keys = new Set([...Object.keys(local), ...Object.keys(onchain)]);
  let drift = 0;
  for (const k of keys) {
    const L = (local as Record<string, string>)[k];
    const R = (onchain as Record<string, string>)[k];
    if (L !== R) { console.log(`  drift ${k}: local=${L ?? '∅'} on-chain=${R ?? '∅'}`); drift++; }
  }
  if (drift === 0) console.log(`✓ ${name} in sync (${Object.keys(onchain).length} chain(s))`);
  else console.log(`✗ ${name} has ${drift} field(s) drifting — run \`squids publish ${name}\` to push`);
}

// ─── Dispatch ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case 'list': cmdList(); break;
    case 'add': cmdAdd(rest[0], flags); break;
    case 'get': cmdGet(rest[0]); break;
    case 'remove': cmdRemove(rest[0]); break;
    case 'publish': await cmdPublish(rest[0]); break;
    case 'bootstrap': await cmdBootstrap(rest[0], flags); break;
    case 'verify': await cmdVerify(rest[0]); break;
    case 'chainAt': case 'at': await cmdChainAt(rest[0]); break;
    case 'who': await cmdWho(rest[0]); break;
    default:
      console.log('squids — SUIAMI roster CLI + local keystore');
      console.log('  bun run squids list');
      console.log('  bun run squids add    <name> [--sui] [--btc] [--eth] [--sol]');
      console.log('  bun run squids get    <name>');
      console.log('  bun run squids remove <name>');
      console.log('  bun run squids publish <name>    (ultron → Worker, else → sui cli)');
      console.log('  bun run squids bootstrap <name> [chain flags]');
      console.log('  bun run squids verify <name>     (diff keystore vs roster)');
      console.log('  bun run squids chainAt <chain>@<name>   resolve eth@ultron → 0x…');
      console.log('  bun run squids who <addr>        reverse lookup any chain addr → name');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(err => { console.error('error:', err.message ?? err); process.exit(1); });
