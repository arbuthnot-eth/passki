# Aggron — SKI-Native Knowledge Graph Design

**Voter 2 (SKI-native architect), 2026-04-18**

**Status:** Parked design. Ship only if the red-team conditions below clear. Until then, the cheap path (extend Pokedex + Scribes to emit `memory/_graph.md`) is landing instead. See the Aggron swarm deliberation notes in the session log for voter transcripts.

A graph that thinks in DOs, Walrus blobs, and Pokemon arcs — not nodes.json.

## Inputs

Five ingestion streams, all push-model, all idempotent by content hash:

1. **Git stream** — `post-commit` hook pings `AggronIngestAgent` with `{sha, subject, files, diffStat}`. Subject regex parses `<Pokemon> <Move> — ...` for arc linkage.
2. **GitHub stream** — existing `Pokedex` DO already observes issues; it forwards `issue.opened/closed/labeled/commented` to Aggron via a thin fanout.
3. **Docs stream** — a Scribe agent walks `docs/superpowers/plans/*`, `docs/releases/*`, `memory/*.md` on a 10-min alarm, emits `{path, section-anchor, sha256, summary}` for changed files only. Summary is from Workers AI (`@cf/meta/llama-3.1-8b`), not OpenAI — keep the loop on-edge.
4. **Move/TS source stream** — same Scribe, but emits symbol-level chunks (`module::function`, `exported const`) via a lightweight regex extractor. No tree-sitter WASM in the bundle — we don't need AST fidelity, we need reference edges.
5. **Brando stream** — memory/ dir diffs + feedback/*.md entries. Each `feedback_*.md` becomes a first-class `decision` node.

Freshness: every stream is push + versioned by `(source, content-hash)`. No polling of third parties except the Scribe alarm.

## Nodes & Edges

**Node types:** `arc` (Pokemon), `move` (commit), `issue`, `pr`, `doc-section`, `memory-entry`, `decision` (feedback_*), `symbol` (Move/TS), `quote` (brando utterance from session logs), `package` (Move package on-chain), `agent` (DO class).

**Edge types:** `blocks`, `supersedes`, `reverts`, `mentioned-by`, `evolved-from` (Pokemon evolution), `feinted-into` (walked-back), `agrees-with`, `contradicts`, `lands-in-arc`, `signed-by` (IKA dWallet), `lives-in-DO`.

Edges carry a `confidence ∈ [0,1]` and a `provenance` pointer (commit sha, doc anchor, quote line). `contradicts` is never auto-derived — it requires a decision node to assert it, so swarms can't gaslight each other.

## Storage Layer

Three tiers, each chosen for what it's actually good at:

- **DO SQLite (hot graph)** — `AggronGraphAgent` singleton DO holds the working set: nodes + edges from the last 90 days, all open arcs, all decisions. SQLite FTS5 on node.summary. This is what subagents query.
- **Walrus blob (cold, immutable snapshots)** — every 24h the DO serializes a compacted graph slice (CBOR, not JSON — edges are dense) and stores the blob-id on-chain in a Move `AggronEpoch` registry object. Anyone can replay history without trusting the DO.
- **Move dynamic fields (truth anchors)** — only the `decision` and `package` nodes get on-chain mirrors, under a shared `AggronCanon` object. Gives us signed provenance for "did brando actually reject that idea" without bloating chain state.

Seal-gate the Walrus blob only when a decision node touches guest/squid/cold-dest material — default is cleartext so scribes can replay.

## Compute Layer

`AggronGraphAgent` (singleton DO, name `aggron`) owns writes + queries. Community detection runs in-DO via a streaming label-propagation pass on each commit — not Leiden (no igraph in Workers), but LPA on a 5k-node working set is cheap and converges in <50ms. The cohort label is the arc name when available, else a hash.

Heavy re-clustering (weekly) runs in a `AggronReaperAgent` child DO triggered by alarm, so the hot DO never blocks on it. Render is SSR'd SVG from the hot DO at `/api/aggron/render?cohort=hermes` — no client-side graph lib.

## Agent Interface

One DO fetch surface, three verbs:

- `POST /aggron/ask` — `{query, cohort?, asOf?}` returns ranked node-ids + edges. Query language is a tiny DSL: `arc:stuck refs:"2PC-MPC"` — no SPARQL, no Cypher, no bureaucracy.
- `POST /aggron/assert` — agents emit edges with provenance. Contradicts/supersedes require a `decision` node id.
- `GET /aggron/trace/:nodeId` — full provenance chain back to commit/doc/quote. This is what killer-query #3 depends on.

Subagents get a thin `aggronClient` helper; they never touch SQLite directly.

## Three Killer Queries

1. **"Which arcs are stuck on an IKA 2PC-MPC assumption?"** — `arc:open blocks:* refs-symbol:"2PC-MPC" OR refs-package:"ika_dwallet_2pc_mpc"` — cross-references symbol edges with arc status. Today this requires grepping memory/ + issues + plans manually.
2. **"Has brando already rejected this idea, and where?"** — `decision:reject similar-to:<proposal-embedding> limit:5` — returns feedback_*.md entries + the quote node that spawned them. Prevents the swarm from re-proposing feinted ideas.
3. **"What's the provenance of this design choice?"** — `trace` from a symbol or decision node back through commits → PRs → plans → quotes. Answers "why does `ultronKeypair` exist as an abstraction" in one hop.

If you can't name three, don't build it. These are the three.

## What NOT to Do (anti-Graphify)

- **Don't bundle tree-sitter.** We don't need full AST — reference-edge fidelity is enough, and the WASM cost is real in a Workers bundle.
- **Don't emit a flat `graph.json`.** That's a desktop-tool artifact. Our graph is a DO with query surface; exports are CBOR snapshots to Walrus, not a JSON file in the repo.
- **Don't run NetworkX/Leiden.** No Python on Workers. LPA in-DO is fine for 5k nodes; Leiden is premature.
- **Don't ingest media via Whisper/Vision.** Our inputs are text-native. If brando starts recording voice memos, revisit — until then, the Vision+Whisper column is dead weight.
- **Don't build a generic ontology.** Nodes are `arc/move/decision/quote`, not `Entity/Relation/Concept`. SKI vocab in, SKI vocab out.
- **Don't let it become its own bureaucracy.** No approval flow for edges. Agents assert; decisions override. The graph is a lens, not a gate.

## Activation conditions (from red-team)

Park this design until all three clear:

1. Brando names three specific questions he tried to answer this month where grep + Pokedex + memory/ failed and a graph query would have worked.
2. A subagent protocol exists that *requires* graph consultation before writing (load-bearing, not decorative).
3. The freshness story is concrete: who updates it, on what trigger, what happens on conflict with MEMORY.md.

## Commit cadence (when/if activated)

Lands as: `Aggron Iron Defense — AggronGraphAgent DO scaffold`, then `Aggron Metal Sound — ingest streams`, then `Aggron Heavy Slam — query DSL + three killer queries`.

## Cheap alternative (shipping instead)

Per voter 3: teach Pokedex to emit a `/pokedex graph` view that walks Pokemon arcs → touched files (from commits) → referenced memory topic files, writes `memory/_graph.md` as an index-of-indexes. One hour. Revisit full design only if the red-team conditions clear.
