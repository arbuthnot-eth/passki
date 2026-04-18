---
name: pokedex
description: Use when the user invokes /pokedex or asks "show me the pokedex", "what Pokemon are active", "status of the swarm", "which pokemon evolved", "which ones fainted", or similar swarm-status queries. Surveys all Pokemon-named GitHub issues + recent git history, groups by Active / Evolved / Fainted, and renders a Pokedex-style card. Fainted Pokemon are archived as historically insignificant — tracked only so the swarm doesn't rebuild the same bad idea twice.
version: 1.0.0
---

> **Note:** this is the `.SKI`-specialized in-repo version. A generic cross-platform version (Claude Code / Copilot CLI / Codex / Gemini) lives at `~/.claude/skills/pokedex/` and will be published at https://github.com/arbuthnot-eth/pokedex-skill.

# Pokedex

Survey the .SKI Pokemon Swarm's current state: which Pokemon are active in development, which have evolved (PR merged to master), and which have been fainted (walked back or cleaned up).

## Conventions

**Pokemon = a GitHub issue or a commit thread.** A Pokemon's title starts with the Pokemon's name followed by an em dash, e.g.:
- `Zapdos — prism_vault Quasar program on Solana mainnet-beta`
- `Xatu Future Sight — SUIAMI verified caps + who() reverse lookup`

**Moves = commits inside that Pokemon's thread.** Named as `<Pokemon> <Move>` prefix (e.g. `Zapdos Thunder Shock`).

**Evolution = PR merge to master.** A Pokemon is "evolved" if its issue is closed AND a PR referencing it landed on master.

**Fainted = walked back.** A Pokemon is "fainted" if its issue is closed without a successful PR merge, OR explicitly labeled `fainted`. Fainted Pokemon are historical records — they exist so the swarm doesn't repeat a bad idea. Don't feature them; archive them.

## How to run

When the user invokes /pokedex or asks about swarm status:

### Step 1 — Gather raw state

Run these in a single parallel Bash block:

```bash
# Open issues (likely active)
gh issue list --state open --limit 50 --json number,title,labels,updatedAt,state,url

# Closed issues (may be evolved or fainted)
gh issue list --state closed --limit 50 --json number,title,labels,closedAt,state,url,stateReason
```

```bash
# Recent merged PRs to master — to match issues to evolutions
gh pr list --state merged --base master --limit 30 --json number,title,mergeCommit,closingIssuesReferences,mergedAt
```

```bash
# Recent commits that mention Pokemon names — catches in-flight work not yet issue-tracked
git log --oneline -30 master..devnet/nursery 2>/dev/null || git log --oneline -30
```

### Step 2 — Classify

For each issue:
1. **Is the title Pokemon-shaped?** Check the first word/phrase before `—` against a Pokemon name. Names that have appeared so far: Zapdos, Articuno, Moltres, Porygon, Porygon ZA, Porygon2, Porygon-Z, Xatu, Magneton, Magnezone, Bronzong, Claydol, Lapras, Snorlax, Togepi, Togetic, Togekiss, Mewtwo. Accept any recognizable Pokemon name.
2. **Status derivation:**
   - `state == "open"` → **Active**
   - `state == "closed"` + matched by a merged PR → **Evolved**
   - `state == "closed"` + `stateReason == "not_planned"` OR label `fainted` → **Fainted**
   - `state == "closed"` + no matching merged PR + no fainted label → **Evolved** (assume default closure = completed; flag ambiguity only if clearly suspicious)

### Step 3 — Render

Output as three sections, in this order. Be concise — one line per Pokemon with the most important fact.

```
## Active (N Pokemon)

- ⚡ **Zapdos** #164 — prism_vault Quasar program — Zapdos Thunder Shock (2/10 moves) · 2h ago
- ❄️ **Articuno** #165 — sealed client flow — blocked on Zapdos
- 🔥 **Moltres** #166 — UI + Frontier submission — blocked on Articuno

## Evolved (M Pokemon)

- 🔮 **Xatu Future Sight** #161 → 92a7ae0 (2026-04-16)
- 🧲 **Magneton Tri Attack** #161 → ed3b91e (2026-04-16)
- 💾 **Porygon** #162 → 3dba9097 (2026-04-16)

## Fainted (K Pokemon, archived — historically insignificant)

- (none yet)
```

Emojis are optional flair — pick something appropriate to the Pokemon's type (electric=⚡, ice=❄️, fire=🔥, psychic=🔮, electric+steel=🧲, normal/digital=💾, fairy=✨, etc.). Drop them if output is rendering in a context that doesn't support emoji.

### Step 4 — Close the loop

After rendering, if any Pokemon are Active, end with a single line:

> **Next move:** <describe the unblocked next thing to do for the most important active Pokemon>

## When not to run

- Don't auto-invoke on every conversation. Wait for explicit user intent (/pokedex, "status", "what's active", etc.).
- Don't dispatch subagents for this; it's a cheap direct read.
- If `gh` is not authenticated, surface the error and stop — don't try to reconstruct state from local git alone.

## Extensions (future)

- Cross-reference GitHub issue labels with in-session TaskList to show which moves have local tracking too.
- Fold commit counts per Pokemon into the rendering ("Zapdos has 2 moves shipped, 8 queued").
- Auto-detect when a Pokemon has been stale >14 days → suggest fainting.
