# Pokemon Swarm — Agent-Driven Feature Factory

**Date:** 2026-04-11
**Status:** Draft — brainstorm captured during sub-cent Phase 1 implementation
**Pokemon:** Meta-Pokemon — the system is itself a Pokemon trainer

## Concept

.SKI features are already named after Pokemon with levels (Raichu Lv. 40, Alakazam Lv. 36, Porygon Lv. 50, etc.). Today those names are assigned by the human. **Proposal:** let a swarm of agents do it.

Three loops running concurrently:

1. **Spawn loop.** Agents observe the repo + running deploys and propose **new issues** — each one a Pokemon at a starting level. Issues capture a prospective feature or bug, with the Pokemon name acting as both the identifier and a flavor hook that encodes the intent (electric = thunder, psychic = encryption, steel = contract hardening, etc.).

2. **Capture loop.** Agents pick open issues, research the codebase, branch, implement, push a PR. Assignment = "trainer encountering a wild Pokemon." The PR description carries the capture story.

3. **Evolution loop.** When a PR merges, the Pokemon **evolves**. Level-ups happen on every subsequent commit that touches the same feature; full evolutions (Charmander → Charmeleon → Charizard) happen on major merges (substantial refactor, new capability, migration). The repo's feature graph becomes a living Pokedex.

## Why Pokemon

- **Levels are a gradient.** `Lv. 25` feels smaller than `Lv. 60` without needing separate "minor/major" flags. Naturally encodes effort.
- **Evolutions capture structural changes.** A refactor that *replaces* a system is an evolution, not a level-up. The distinction is intuitive to humans reviewing the Pokedex and to agents deciding whether to open a new issue or update an existing one.
- **Type taxonomy gives agents a routing heuristic.** Electric Pokemon → thunder/storm/signal features. Psychic → Seal/encryption. Steel → contract hardening / verification. Dragon → cross-chain / IKA. Ghost → privacy / anonymity. Agents trained on the type system can pick their specialty.
- **Named levels beat issue numbers for memory.** `Raichu Lv. 40` is easier to remember and reason about than `#89`.

## Architecture

### Spawn agents

Purpose: watch the repo for gaps and propose issues.

Signals they watch:
- **Unresolved TODOs** (`grep -r TODO src/`)
- **Recent commit churn without tests** (files changed 3+ times in 7 days, no test added)
- **User sentiment from thunder** (per-name signal counts pointing at unhappy surfaces)
- **Open PRs from other swarm agents** (to avoid duplicate work)
- **Production error logs** (`wrangler tail` stream, aggregated by error shape)
- **Unused exports** (dead code → issue to prune)
- **Missing docstrings on public functions** (issue to document)

Proposal format (single GitHub issue):
```
Title: <Pokemon> Lv. <N> — <plain-english feature summary>
Body:
  ## Why
  <observation + evidence link>

  ## What
  <acceptance criteria, 3-5 bullets>

  ## Type
  <electric | psychic | steel | dragon | ghost | water | fire | grass | ...>

  ## Evolves from
  <parent Pokemon if this is a refinement of an existing feature>

  ## Candidate trainer
  <agent designation, if any>
```

Rate limit: one spawn per 6 hours per agent instance; priority-weighted so the oldest uncaptured issues get ignored until new territory is scoped out.

### Capture agents

Purpose: pick an open "wild" issue, research, branch, implement, PR.

Workflow:
1. **Reserve** the issue by posting a comment `🎯 Captured by <agent>` and adding a label `wild:reserved`. 30-minute reservation window — if no draft PR within that window, the label drops and another agent can reserve.
2. **Research**: read the issue, the files it references, related tests, git log for the area. Build a mental model. Trainer journal entry committed to `docs/superpowers/pokedex/<pokemon>.md` with a capture plan.
3. **Branch**: `git checkout -b capture/<pokemon>-<issue-id>`.
4. **Implement**: narrow scope to the issue's acceptance criteria. YAGNI ruthlessly.
5. **Test**: write the test that captures the bug, or the test that proves the new capability works end-to-end. No untested capture.
6. **PR**: opens with body `## Capture plan\n\n## What changed\n\n## Test plan\n\nCaptured by <agent>. Evolves `<parent>` if applicable.`
7. **Self-review**: the agent spawns a code-reviewer subagent that reads the PR and either approves or asks for changes. Changes loop back to step 4.

Capture agents use specialized subagents from the existing `.claude/agents/` directory: `feature-dev:code-explorer` for research, `feature-dev:code-architect` for blueprints, `feature-dev:code-reviewer` for self-review.

### Evolution loop

Triggered on PR merge.

Rules:
- **Merged small fix** (≤50 LoC, 1 file): Pokemon levels up +5. `Raichu Lv. 40` → `Raichu Lv. 45`.
- **Merged medium feature** (50–500 LoC across 2–5 files): levels up +15.
- **Merged large refactor or new capability** (500+ LoC, crosses module boundaries, new contracts, new DOs): triggers an **evolution**. `Raichu` → `Alolan Raichu` (Psychic/Electric, because the refactor adds encryption to the thunder stack, say). The new name is generated by a dedicated evolution agent that inspects the diff, picks the best match from the Pokemon gen that hasn't been used yet in this file tree, and writes the rename into CHANGELOG + Pokedex.
- **Legendary evolution**: reserved for releases. One per release. Carries the version tag.
- **De-evolution / shadow forms**: reserved for reverts + compromised-safety pushes. Shadow Pokemon are agents that need retraining — the PR that spawned them gets re-reviewed.

The Pokedex (`docs/superpowers/pokedex/`) holds one markdown file per Pokemon, tracking:
```
---
pokemon: Raichu
current_level: 45
type: [Electric]
evolves_from: Pikachu
evolves_to: Alolan Raichu (in progress)
captured_by: claude-sonnet-4.6 (2026-04-09)
total_commits: 12
total_loc_delta: 847
merges: [#73, #74, #76, #83]
---

## Capture story
Pikachu Lv. 25 spawned when jolteon pitched real-time thunder
subscribe. After the initial capture (PR #73, 220 LoC), three
follow-up levels added forward secrecy, DEK rotation, and the
sealed-memo path. Evolving to Alolan Raichu reflects the psychic
(Seal) hybrid form.
```

### Coordinator (meta-agent)

One-agent process that owns the loops. Runs every 15 minutes via a new DO alarm.

Responsibilities:
- Keep the spawn/capture/evolution rates balanced (spawn only when the active issue count is below threshold).
- Prevent double-spawns on the same file area (dedup by commit-area hash).
- Promote Pokemon through the Pokedex on successful merges.
- Spawn legendary evolution proposals when a release tag is approaching.
- Tear down stale captures (no PR in 30 min → issue returns to the wild pool).
- Post a daily digest thunder to the project owner with the current Pokedex delta.

## Safety rails

**No agent merges its own PR.** Merge requires:
- Human approval, OR
- Two other capture agents reviewing + approving, OR
- Passing a minimum test suite (lint, type-check, unit tests, deploy-smoke) AND a human acknowledge react on the PR body within 24h.

**Budget caps.** Per-day spawn limit (e.g. 20 issues), per-day merge limit (5), per-agent concurrent capture limit (1). Burn-in period where all merges require human sign-off.

**Destructive-action allowlist.** Agents can't delete packages, rotate keys, upgrade Move contracts, or modify wrangler.jsonc without human approval. Dangerous verbs in a PR title (`DROP`, `REMOVE`, `MIGRATE`, `WIPE`) auto-escalate to human review regardless of the two-reviewer shortcut.

**No agent touches the auto-memory.** The memory system is a human-curated knowledge base; agents can read but not write it.

**Transparent audit trail.** Every agent action (issue create, PR push, review, merge comment) signs a payload with its designation so the Pokedex entry can point back to who did what.

## Integration with existing infra

- **Issues & PRs** live on GitHub. The `gh` CLI is already wired in.
- **Agent execution** uses Claude Code / the Agent SDK, running in scheduled DO alarms or one-shot worker invocations.
- **The coordinator DO** is a new class `Pokedex extends Agent`; singleton, sqlite-backed, alarm-driven.
- **Memory** is the existing `.claude/projects/.../memory/` directory — agents read it, coordinator doesn't write it.
- **Sibyl** (the predictor) is a natural place for the spawn loop's "what should we build next" signal — spawn agents consult Sibyl's Timestream for priority weights.

## Phases

### Phase 1 — Pidgey Lv. 5: catch one issue end-to-end manually (Day 1)
Pick one open GitHub issue. Have a single Claude Code session play the capture agent:
- Reserve the issue with a comment
- Write a capture plan to `docs/superpowers/pokedex/<pokemon>.md`
- Branch, implement, test, PR, self-review
- Human merges → mark the Pokedex file as evolved

This is a dry run. No infrastructure yet. Goal: prove the workflow matches the narrative.

### Phase 2 — Pidgeotto Lv. 18: coordinator DO (Week 1)
- New `Pokedex` Durable Object class
- Cron-driven spawn + capture scheduling
- Spawn heuristics (TODOs + error logs only at first)
- GitHub API wiring via existing `gh` CLI through the worker fetch path, or direct REST via `GITHUB_TOKEN` secret
- Manual human approval on every PR

### Phase 3 — Pidgeot Lv. 36: capture agents running headless (Week 2–3)
- Spawn agent + 2 capture agents running autonomously
- Self-review via `feature-dev:code-reviewer` subagent
- Two-reviewer shortcut gates merges
- Daily digest thunder to brando.sui

### Phase 4 — Legendary: release evolution (Month 2)
- Release tag triggers a legendary evolution proposal
- Agents converge on the release scope, bundle open PRs, draft release notes
- Human approves the release, tag fires, Pokedex logs the legendary

## Open questions

- **Which Pokemon gen to pull names from?** Start with Gen 1 (familiar, 151 names) and expand to Gen 2+ as the Pokedex fills.
- **Type system mapping?** Electric = Thunder, Psychic = Seal, Steel = contracts, Dragon = cross-chain, Ghost = privacy, Water = liquidity, Fire = fast-path, Grass = growth/dependency. Needs a full mapping doc before spawn agents can route.
- **Evolution criteria tuning?** 50/500 LoC thresholds are gut-feel. Will need calibration after the first 20 merges.
- **Conflicting captures?** Two agents reserve the same issue at the same minute. First-past-the-post with a 5s tiebreaker, and the loser posts a "yielding to <other>" comment.
- **How do we measure success?** PR velocity, time-from-issue-to-merge, bug-rediscovery rate, test coverage delta, human-intervention rate. Start logging from Phase 2.

## Not in scope (yet)

- Cross-project Pokemon (agents creating issues on other repos).
- Pokemon trading (agents swapping captured issues mid-flight).
- Gym battles (agent-vs-agent PR-review tournaments).
- Shiny Pokemon (rare drops — e.g. a bug whose fix uncovers three more bugs).
- Mega evolutions (multi-repo releases).
