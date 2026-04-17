#!/usr/bin/env bun
/**
 * Pokemon-base-stat-aware semver bump driver for the monorepo.
 *
 * Reads commit messages between the last tag and HEAD, identifies the
 * Pokemon(s) named in the messages (convention: every commit subject
 * starts with `<Pokemon> <Move>` or contains `evolved in #NNN`), and
 * picks the release type off the maximum base-stat-total (BST) seen
 * or an explicit evolution marker.
 *
 * Bump table:
 *   - BST < 350               → patch   (Beldum 300)
 *   - BST 350–499             → minor   (Metang 420, Kadabra 400)
 *   - BST ≥ 500               → major   (Metagross 600, legendaries)
 *   - "evolved in #N" present → major   (PR merge = evolution canon)
 *
 * Outputs ONLY the bump type: `patch` | `minor` | `major`. Designed
 * to slot into `npm version $(bun scripts/pokemon-bump.ts ...)`.
 *
 * Usage:
 *   bun scripts/pokemon-bump.ts [--since=<ref>] [--cwd=<dir>]
 *     --since  defaults to the most recent tag via `git describe --tags --abbrev=0`
 *     --cwd    package dir; used to scope tags when multiple packages tag the same repo
 */

import { execSync, execFileSync } from 'node:child_process';

type Tier = 'patch' | 'minor' | 'major';

// Static BST table — the Pokemon we've actually used in commit
// threads this repo. Extend as new species show up. A full dataset
// (pokeapi.co) can be lazily fetched in a future iteration; keeping
// it inline avoids a network dep in CI.
const BST: Record<string, number> = {
  // Legendary birds (Prism trio)
  zapdos: 580, articuno: 580, moltres: 580,
  // Gen 2 psychic starter line (SUIAMI roster identity → Kadabra landed
  // the Seal decrypt fix at 028fa02)
  abra: 310, kadabra: 400, alakazam: 500,
  // Beldum line — waap.eth / ENS extension (#167)
  beldum: 300, metang: 420, metagross: 600,
  // Togepi line — Guest Protocol (planned)
  togepi: 245, togetic: 405, togekiss: 545,
  // Dragon pseudo-legendaries (iUSD / Prismatic Stables Module)
  bagon: 300, shelgon: 420, salamence: 600,
  // Eevee + evolutions — agent personalities
  eevee: 325, vaporeon: 525, jolteon: 525, flareon: 525,
  espeon: 525, umbreon: 525, leafeon: 525, glaceon: 525, sylveon: 525,
  // Ghost line
  gastly: 310, haunter: 405, gengar: 500,
  // Snorlax (big stable stuff)
  snorlax: 540,
  // Claydol — SUIAMI roster audit confusion
  baltoy: 300, claydol: 500,
  // Machine-ness
  magnemite: 325, magneton: 465, magnezone: 535,
  // Pokemon from MEMORY that we may commit under
  porygon: 395, porygon2: 515, 'porygon-za': 520, 'porygon-z': 535,
  chronicom: 0, // placeholder — made-up species, tracked as patch
  zoroark: 510, zorua: 330,
  pikachu: 320, raichu: 485,
};

interface Args { since?: string; cwd?: string; }
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--(since|cwd)=(.+)$/);
    if (m) (args as any)[m[1]] = m[2];
  }
  return args;
}

// Resolve git executable. /usr/bin/git is reliable on CI runners and
// dev containers; fall back to PATH if missing.
const GIT = (() => {
  for (const p of ['/usr/bin/git', '/usr/local/bin/git']) {
    try { execFileSync(p, ['--version'], { stdio: 'pipe' }); return p; } catch {}
  }
  return 'git';
})();

function git(args: string[], cwd?: string): string {
  return execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim();
}

function lastTag(cwd?: string): string | null {
  try { return git(['describe', '--tags', '--abbrev=0'], cwd); } catch { return null; }
}

function commitSubjects(since: string | null, cwd?: string): string[] {
  const range = since ? `${since}..HEAD` : 'HEAD';
  try {
    const log = git(['log', range, '--pretty=format:%s'], cwd);
    return log ? log.split('\n').filter(Boolean) : [];
  } catch (err) {
    console.error('[pokemon-bump] git log failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function tierForBst(bst: number): Tier {
  if (bst >= 500) return 'major';
  if (bst >= 350) return 'minor';
  return 'patch';
}

function tierRank(t: Tier): number {
  return t === 'major' ? 2 : t === 'minor' ? 1 : 0;
}

function pickTier(subjects: string[]): Tier {
  let tier: Tier = 'patch';
  let maxBst = 0;
  const named: string[] = [];
  for (const line of subjects) {
    // Evolution marker — PR merges are canon upgrades (legendary form).
    if (/evolved in #\d+/i.test(line) || /\[evolve\]/i.test(line)) {
      if (tierRank('major') > tierRank(tier)) tier = 'major';
    }
    // Find Pokemon names. Case-insensitive first-word or explicit mention.
    const words = line.split(/[\s—:]+/);
    for (const w of words) {
      const key = w.toLowerCase().replace(/[^a-z-]/g, '');
      if (key && key in BST) {
        named.push(key);
        const bst = BST[key];
        if (bst > maxBst) maxBst = bst;
      }
    }
  }
  if (maxBst > 0) {
    const bstTier = tierForBst(maxBst);
    if (tierRank(bstTier) > tierRank(tier)) tier = bstTier;
  }
  // stderr for humans; stdout = the bump type (shell-consumable)
  console.error(`[pokemon-bump] subjects: ${subjects.length}, pokemon: ${[...new Set(named)].join(', ') || '(none)'}, maxBst: ${maxBst}, tier: ${tier}`);
  return tier;
}

const args = parseArgs(process.argv);
const since = args.since ?? lastTag(args.cwd);
const subjects = commitSubjects(since, args.cwd);
const tier = pickTier(subjects);
process.stdout.write(tier);
