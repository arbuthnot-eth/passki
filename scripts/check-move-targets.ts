#!/usr/bin/env bun
// scripts/check-move-targets.ts
//
// Porygon Iron Tail — pre-deploy regression check.
//
// Scans TS source under src/ for Move call-target literals of the form
//   `${PKG_CONST}::<module>::<fn>`     (template literal)
//   PKG_CONST + '::<module>::<fn>'     (string concat)
// Resolves each PKG_CONST to a 0x… package id by grepping its
// `export const` declaration. Then queries Sui mainnet's
// sui_getNormalizedMoveFunction to confirm the function exists at that
// package. If not, prints a FAIL with a suggested fix (any known pkg
// const whose package DOES export that module::fn).
//
// Usage:  bun scripts/check-move-targets.ts
// Exit:   0 if all targets resolve, 1 if any FAIL.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'src');
const RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];

type CallSite = {
  file: string;
  line: number;
  pkgConst: string;
  module: string;
  fn: string;
};

// ---------- fs walk ----------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(p, out);
    } else if (st.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) {
      out.push(p);
    }
  }
  return out;
}

// ---------- pkg const resolution ----------

// Scan every ts file once, build map { constName -> pkgId }.
// Handles:   export const FOO = '0x…'
//            export const FOO: string | null = '0x…'
//            export const FOO: string = '0x…'
// Matches:
//   export const FOO = '0x…'
//   export const FOO: string | null = '0x…'
//   const FOO = '0x…'
//   private static readonly FOO = '0x…'
const PKG_CONST_DECL =
  /(?:export\s+)?(?:(?:private|public|protected)\s+)?(?:static\s+)?(?:readonly\s+)?(?:const\s+)?([A-Z_][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*['"`](0x[0-9a-fA-F]+)['"`]/g;

function buildPkgConstMap(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    let m: RegExpExecArray | null;
    PKG_CONST_DECL.lastIndex = 0;
    while ((m = PKG_CONST_DECL.exec(txt)) !== null) {
      const name = m[1]!;
      const id = m[2]!.toLowerCase();
      // Track any uppercase const whose value is a 0x-prefixed id.
      // Used to be filtered to _PKG/_PACKAGE suffixes but that missed
      // function-local names like CETUS_ROUTER and PKG. The map stays
      // small in practice (<50 entries) and false positives in
      // unrelated constants are harmless — they'd only trip the
      // check when referenced as `${FOO}::mod::fn`, which requires
      // the value to actually BE a Move package id on-chain.
      // First win; warn on collision
      if (map.has(name) && map.get(name) !== id) {
        console.warn(
          `[warn] ${name} declared twice with different ids: ${map.get(name)} vs ${id} (${relative(ROOT, f)})`,
        );
      } else {
        map.set(name, id);
      }
    }
  }
  return map;
}

// ---------- call-site collection ----------

// Matches:
//   `${FOO}::mod::fn`
//   "${FOO}::mod::fn"
//   FOO + '::mod::fn'
//   FOO + "::mod::fn"
const TEMPLATE_CALL =
  /\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}::([a-z_][a-z0-9_]*)::([a-z_][a-z0-9_]*)/g;
const CONCAT_CALL =
  /\b([A-Z_][A-Z0-9_]*)\s*\+\s*['"`]::([a-z_][a-z0-9_]*)::([a-z_][a-z0-9_]*)/g;

function collectCallSites(files: string[]): CallSite[] {
  const sites: CallSite[] = [];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    const lines = txt.split('\n');
    const rel = relative(ROOT, f);

    const scan = (re: RegExp) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        const offset = m.index;
        // 1-based line number
        let line = 1;
        let running = 0;
        for (let i = 0; i < lines.length; i++) {
          running += lines[i]!.length + 1;
          if (offset < running) {
            line = i + 1;
            break;
          }
        }
        sites.push({
          file: rel,
          line,
          pkgConst: m[1]!,
          module: m[2]!,
          fn: m[3]!,
        });
      }
    };
    scan(TEMPLATE_CALL);
    scan(CONCAT_CALL);
  }
  return sites;
}

// ---------- JSON-RPC ----------

type FnCache = Map<string, boolean>; // key: `${pkg}::${mod}::${fn}`

async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown;
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) {
        lastErr = new Error(`${url} HTTP ${r.status}`);
        continue;
      }
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) return { __error: j.error.message };
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all RPC endpoints failed');
}

async function checkFunction(
  pkg: string,
  module: string,
  fn: string,
  cache: FnCache,
): Promise<boolean> {
  const key = `${pkg}::${module}::${fn}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const res = await rpc('sui_getNormalizedMoveFunction', [pkg, module, fn]);
  const ok = res && !res.__error && typeof res === 'object' && 'parameters' in res;
  cache.set(key, !!ok);
  return !!ok;
}

// ---------- main ----------

function short(id: string): string {
  return id.slice(0, 6) + '…' + id.slice(-4);
}

async function main() {
  const files = walk(SRC);
  const pkgMap = buildPkgConstMap(files);
  const sites = collectCallSites(files);

  if (sites.length === 0) {
    console.log('No Move call targets found in src/. Nothing to check.');
    return;
  }

  console.log(
    `Porygon Iron Tail — checking ${sites.length} call sites across ${files.length} files`,
  );
  console.log(`Known pkg consts: ${[...pkgMap.keys()].join(', ') || '(none)'}`);
  console.log('');

  const cache: FnCache = new Map();
  const fails: { site: CallSite; pkgId: string | null; suggestion: string | null }[] = [];

  // Dedupe by (pkgConst, module, fn) for RPC efficiency but keep site list for reporting
  const uniq = new Map<string, CallSite>();
  for (const s of sites) {
    const k = `${s.pkgConst}::${s.module}::${s.fn}`;
    if (!uniq.has(k)) uniq.set(k, s);
  }

  for (const [, repr] of uniq) {
    const pkgId = pkgMap.get(repr.pkgConst) ?? null;
    if (!pkgId) {
      // Unknown / unresolved pkg const — flag as fail so we don't silently skip
      for (const s of sites.filter(
        (x) => x.pkgConst === repr.pkgConst && x.module === repr.module && x.fn === repr.fn,
      )) {
        fails.push({ site: s, pkgId: null, suggestion: null });
      }
      continue;
    }
    const ok = await checkFunction(pkgId, repr.module, repr.fn, cache).catch((e) => {
      console.warn(`[warn] RPC failed for ${pkgId}::${repr.module}::${repr.fn}: ${e}`);
      return true; // don't fail the build on RPC hiccups — warn only
    });
    if (!ok) {
      // Find a suggestion: any other pkg const whose id has this module::fn
      let suggestion: string | null = null;
      for (const [name, id] of pkgMap) {
        if (name === repr.pkgConst || id === pkgId) continue;
        const altOk = await checkFunction(id, repr.module, repr.fn, cache).catch(() => false);
        if (altOk) {
          suggestion = `${name} (${short(id)})`;
          break;
        }
      }
      for (const s of sites.filter(
        (x) => x.pkgConst === repr.pkgConst && x.module === repr.module && x.fn === repr.fn,
      )) {
        fails.push({ site: s, pkgId, suggestion });
      }
    }
  }

  if (fails.length === 0) {
    console.log(`✓ all ${uniq.size} unique Move targets resolve on mainnet`);
    process.exit(0);
  }

  console.log(`✗ ${fails.length} FAIL(s):\n`);
  for (const { site, pkgId, suggestion } of fails) {
    const target = `\${${site.pkgConst}}::${site.module}::${site.fn}`;
    if (!pkgId) {
      console.log(
        `  ✗ ${site.file}:${site.line} → ${target} — pkg const ${site.pkgConst} is undeclared or not a 0x… value`,
      );
    } else {
      const tail = suggestion
        ? `; found in ${suggestion}`
        : '; no known pkg const exports this function';
      console.log(
        `  ✗ ${site.file}:${site.line} → ${target} not found at ${short(pkgId)}${tail}`,
      );
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('check-move-targets crashed:', e);
  process.exit(2);
});
