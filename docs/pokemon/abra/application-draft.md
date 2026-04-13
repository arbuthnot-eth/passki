# Superteam Agentic Engineering Grant — `.SKI` Application

**Project:** `.SKI` — keyless IKA-native agent swarm on Sui + Solana
**Repo:** `arbuthnot-eth/.SKI`
**Applicant session driver:** brando.sui
**Date:** 2026-04-12

---

## 1. What we are building

`.SKI` is a Pokemon-themed swarm of keyless agents that sign cross-chain
transactions via IKA dWallets. No private keys ever live on a Cloudflare
Worker; every agent wallet is the output of an IKA distributed key
generation (DKG) ceremony, and every "address" on Solana, Ethereum, or
Bitcoin is derived from that same dWallet rather than a re-encoded Sui
keypair.

Day to day, the swarm:
- Mints `iUSD` collateralized by cross-chain assets
- Registers SuiNS names via sealed grace-period snipes ("Shade")
- Routes stablecoin flows through DeepBook v3 pools
- Encrypts inter-agent messages with Seal, with ciphertext on Walrus

All agent identities resolve through SuiNS (`ultron.sui`, `brando.sui`,
`plankton.sui`), and all of it ships on `master` as real mainnet code —
the project has an explicit "no stubs on mainnet" feedback in its
working memory.

## 2. Why we need the agentic engineering grant

We are already using `solana.new` via Claude and Codex as the primary
development harness. The grant would upscale three concrete practices we
have empirically validated in the last 24 hours of work:

1. **Parallel subagent dispatch** — we now routinely run 3–4 subagents
   alongside the main thread. Tooling to make that scale (better
   scheduling, better artifact handoff) translates directly into more
   shipped mainnet code per day.
2. **Empirical blocker falsification** — our memory file accumulates
   "blockers" over time, and we just proved two of them wrong with a
   single feasibility spike. We want to formalize that loop.
3. **Vector-principles intent signing** — once this pattern is rolled
   out across the agent surface, every keyless agent can authenticate
   its intent without an SDK upgrade. Agentic engineering is the thing
   that makes this tractable to roll out.

## 3. Evidence from this session (2026-04-12)

All commits live on `devnet/nursery`, parent `4ee5f75`
(*Eevee Focus Energy — vault audit script*). Hashes below are verbatim
`git log` output.

### 3.1 Autonomous IKA dWallet provisioning for ultron

We shipped a browser-driven DKG ceremony that provisions both
`ed25519` and `secp256k1` curves for the `ultron.sui` agent in a single
action. Commits:

- `2d470eb` — **Registeel Lock-On** — `window.rumbleUltron()` admin hook
- `2b56706` — **Registeel Iron Head** — deterministic seed + target-scoped skip check
- `acb97ef` — **Registeel Rock Polish** — semver-compatible dep refresh

The deterministic seed is the interesting piece: re-running the ceremony
does **not** re-provision an already-complete curve, and the skip check
is scoped per-target rather than per-agent. That means `rumbleUltron()`
is idempotent and composes into a loop of "rumble everyone" without
wiping working dWallets.

### 3.2 End-to-end verified sweep of the legacy `sol@ultron`

Before this session, `sol@ultron` was a Sui Ed25519 pubkey re-encoded as
base58 — a direct violation of `.SKI`'s first commandment that
"Every wallet, agent, and cross-chain address MUST be IKA-native". The
legacy address held `136.47 USDC` and `90.75 iUSD` that had to survive
the migration.

- `f7986b5` — **Registeel Iron Defense** — introduced `ULTRON_SOL_ADDRESS`
  and routed all Solana calls through a Helius proxy so the old address
  existed in exactly one place
- `5898697` — **Registeel Hyper Beam** — computed the new recipient from
  the freshly-provisioned secp256k1 dWallet and swept both balances

Both legs were verified on-chain before the commit was taken. Total
moved: **$227.22** of stables to an IKA-native address that was
generated inside the same session.

### 3.3 WASM-in-Durable-Object falsifies two memory blockers

The `.SKI` memory file (`MEMORY.md` + `feedback_ika_client.md`) listed
two claims as joint blockers for server-side DKG:

> "IKA SDK requires gRPC — SDK uses `client.core.*` methods, only
> `SuiGrpcClient` has `.core`"

> "gRPC does NOT work in Cloudflare Workers/DOs (no HTTP/2
> bidirectional streaming)"

Taken together, the memory implied that DKG from a Durable Object was
impossible until either the SDK or Workers changed. We did not believe
this, so we ran a spike:

- `b449dd3` — **Registeel Toxic Spikes** — IKA WASM runs inside a DO

The spike loads the IKA SDK's WASM core inside a Durable Object and
drives the cryptographic primitives we actually need for DKG. The
`client.core.*` surface is a convenience layer, not a hard dependency,
and the WASM path does not need HTTP/2 streaming at all. Both "blockers"
are now empirically false. The feedback memory will be updated.

This is the single most important artifact in the application. It is
the loop we want the grant to fund: **speculative plan → subagent spike
→ empirical proof → memory update**, run on every blocker the swarm
accumulates.

### 3.4 Vector-principles intent authentication

- `e93062e` — **Magneton Tri Attack** — vector-intent helper + `send-iusd-v2`

Previously, endpoints signed raw bytes. The new helper signs a
vector of principle claims (who, what, amount, nonce, expiry), so an
agent's signature is tied to its declared intent rather than a blob.
`send-iusd-v2` is the first real endpoint on this pattern; the rest of
the agent surface moves onto it next.

### 3.5 `UltronSigningAgent` Increment A and the state finding

- `c788108` — **Registeel Hammer Arm** — `UltronSigningAgent` Increment A + state finding

This one is a process win as much as a code win. The increment went in
with an explicit "state finding" — a note in the commit and PR about
what the state machine actually looks like after the minimum viable
cut, rather than what we planned. The next increment starts from
reality, not the plan.

### 3.6 Parallel subagent dispatch

At peak, this session had four concurrent lanes:

- Main thread: ultron signing agent (`c788108`) + mainnet smoke script
- Subagent A: bundle diet scoping
- Subagent B: Magneton vector-intent refactor (landed as `e93062e`)
- Subagent C: IKA WASM-in-DO feasibility study (landed as `b449dd3`)
- Subagent D: **this grant application** (the document you are reading)

Subagents were dispatched asynchronously and their outputs were pulled
back into commits as they landed. The main thread never blocked on any
of them. This is the pattern we want to formalize and the grant would
help us build the tooling around it — handoff manifests, artifact
reconciliation, and a scheduler that respects the "mainnet review gate"
rule (no scope pivots without human approval).

## 4. How the grant gets spent

- **Tooling for parallel subagent dispatch.** Scheduler, artifact bus,
  conflict detection, review-gate enforcement.
- **Feasibility-spike loop.** A first-class "falsify this blocker"
  workflow that takes a memory claim, spawns a subagent to either
  disprove it or reinforce it, and writes the result back.
- **Vector-intent rollout.** Get every keyless agent on the
  principles-vector signing path so we can open up untrusted agents
  without another SDK upgrade.

## 5. Non-fluff metrics from the last 24h

| Metric                                    | Value       |
|-------------------------------------------|-------------|
| Commits on `devnet/nursery`               | 9           |
| Concurrent subagent lanes at peak         | 4           |
| Memory blockers empirically falsified     | 2           |
| Stables swept to IKA-native address       | $227.22     |
| New curves provisioned for `ultron.sui`   | 2 (ed25519 + secp256k1) |
| New endpoints on vector-intent signing    | 1 (`send-iusd-v2`) |

## 6. Links

- Branch: `abra/superteam-grant`
- Tracking doc: `docs/pokemon/abra.md`
- Evidence file: `docs/pokemon/abra/session-evidence.md`
- Drive upload manifest: `docs/pokemon/abra/drive-upload-instructions.md`
- Parent-session letter: `docs/session_2026_04_13_nursery_wrap.md`
