#!/usr/bin/env node
// First Commandment guard: no *_PRIVATE_KEY (or _KEYPAIR / _SECRET_KEY) in
// Cloudflare Worker config. Agents sign via IKA dWallets — never with raw
// keys baked into Worker secrets/vars.
//
// Exits 1 on any new violation. Legacy violations (being phased out) are
// noted but don't block.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Legacy keys acknowledged in MEMORY.md as violations being phased out.
// Do NOT add new entries here without an explicit Dikaiosyne vote.
const LEGACY_ALLOWLIST = new Set([
  'ULTRON_PRIVATE_KEY',
  'SHADE_KEEPER_PRIVATE_KEY',
]);

const VIOLATION_RE = /\b([A-Z0-9_]*?(?:_PRIVATE_KEY|_KEYPAIR|_SECRET_KEY))\b/g;

function gatherTargets() {
  const targets = [];
  const consider = (p) => {
    if (existsSync(p) && statSync(p).isFile()) targets.push(p);
  };

  // Explicit names
  consider(join(ROOT, 'wrangler.toml'));
  consider(join(ROOT, 'wrangler.jsonc'));
  consider(join(ROOT, '.dev.vars'));

  // Any *.toml or *.jsonc in repo root
  for (const entry of readdirSync(ROOT)) {
    if (entry.endsWith('.toml') || entry.endsWith('.jsonc')) {
      consider(join(ROOT, entry));
    }
  }

  // cf-workers/ tree, if present
  const cfDir = join(ROOT, 'cf-workers');
  if (existsSync(cfDir) && statSync(cfDir).isDirectory()) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === '.git') continue;
          walk(full);
        } else if (
          entry.endsWith('.toml') ||
          entry.endsWith('.jsonc') ||
          entry === '.dev.vars'
        ) {
          targets.push(full);
        }
      }
    };
    walk(cfDir);
  }

  return [...new Set(targets)];
}

function scan(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const newViolations = [];
  const legacyHits = [];
  lines.forEach((line, i) => {
    const stripped = line.replace(/\/\/.*$/, '').replace(/#.*$/, '');
    let m;
    VIOLATION_RE.lastIndex = 0;
    while ((m = VIOLATION_RE.exec(stripped)) !== null) {
      const name = m[1];
      const hit = { file, line: i + 1, name, text: line.trim() };
      if (LEGACY_ALLOWLIST.has(name)) legacyHits.push(hit);
      else newViolations.push(hit);
    }
  });
  return { newViolations, legacyHits };
}

const targets = gatherTargets();
const allNew = [];
const allLegacy = [];
for (const f of targets) {
  const { newViolations, legacyHits } = scan(f);
  allNew.push(...newViolations);
  allLegacy.push(...legacyHits);
}

if (allLegacy.length) {
  console.error(
    `[check-no-private-keys] note: ${allLegacy.length} legacy *_PRIVATE_KEY ref(s) ` +
      `acknowledged (phasing out): ` +
      [...new Set(allLegacy.map((h) => h.name))].join(', '),
  );
}

if (allNew.length) {
  console.error('');
  console.error(
    'FIRST COMMANDMENT VIOLATION — *_PRIVATE_KEY in Worker config.',
  );
  console.error(
    'Agents sign via IKA dWallets. No raw keys on Cloudflare Workers — ever.',
  );
  console.error('');
  for (const v of allNew) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
    console.error(`    > ${v.text}`);
  }
  console.error('');
  console.error(
    'If this is intentional and approved, add the name to LEGACY_ALLOWLIST in',
  );
  console.error('scripts/check-no-private-keys.mjs (requires explicit vote).');
  process.exit(1);
}

process.exit(0);
