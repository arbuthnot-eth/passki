# Session Evidence — 2026-04-12 Registeel + Magneton Wave

Raw material for the Superteam agentic engineering grant application.
All hashes are on `devnet/nursery` (parent of `abra/superteam-grant`).

## Commits (9, parent `4ee5f75` Eevee Focus Energy)

| Hash      | Pokemon move                 | One-line outcome                                        |
|-----------|------------------------------|---------------------------------------------------------|
| 624ebcb   | Porygon Lock-On II           | User-funded `StableShadeOrder<iUSD>` wired end-to-end   |
| 2d470eb   | Registeel Lock-On            | `window.rumbleUltron()` browser admin hook              |
| 2b56706   | Registeel Iron Head          | Deterministic seed + target-scoped skip check           |
| acb97ef   | Registeel Rock Polish        | Semver-compatible dep refresh, no lockfile churn        |
| 5898697   | Registeel Hyper Beam         | Sweep legacy `sol@ultron` → IKA-derived recipient       |
| f7986b5   | Registeel Iron Defense       | `ULTRON_SOL_ADDRESS` const + Helius proxy               |
| b449dd3   | Registeel Toxic Spikes       | IKA WASM runs inside a Durable Object                   |
| e93062e   | Magneton Tri Attack          | Vector-intent helper + `send-iusd-v2` endpoint          |
| c788108   | Registeel Hammer Arm         | `UltronSigningAgent` Increment A + state finding        |

## Headline results

### 1. Autonomous IKA dWallet provisioning for ultron
- Browser-driven DKG ceremony for ed25519 + secp256k1 in one pass
- Deterministic seed derivation so re-running does not re-provision existing curves
- `window.rumbleUltron()` admin hook (2d470eb) surfaces the ceremony from the console
- Target-scoped skip check (2b56706) means Rumble is idempotent per curve

### 2. End-to-end verified legacy sweep
- Old `sol@ultron` address held `136.47 USDC` + `90.75 iUSD`
- New IKA-derived recipient computed from the freshly-provisioned secp256k1 dWallet
- Commit `5898697` (Hyper Beam) moved both balances cleanly, verified on-chain
- Supporting Helius proxy (f7986b5) isolates all Solana RPC behind one const

### 3. WASM-in-DO feasibility spike falsified two blocker claims
- Memory doc listed "IKA SDK requires gRPC" and "gRPC does not work in CF DOs" as
  joint blockers for server-side DKG
- Toxic Spikes (b449dd3) ran IKA WASM inside a Durable Object and proved both
  constraints were orthogonal — the SDK's WASM core does not need the gRPC
  transport layer for the cryptographic path we actually use
- Result: unblocked server-side keyless agents without waiting on SDK changes

### 4. Vector-principles intent authentication
- Magneton Tri Attack (e93062e) introduced a reusable vector-intent helper
- Applied to `send-iusd-v2` — first real endpoint to sign intent vectors rather
  than raw message bytes
- Establishes the pattern for the rest of the keyless-agent surface

### 5. Multi-subagent parallel execution
Throughout the session, the main thread dispatched subagents in parallel for:
- Bundle diet scoping (feasibility study, not yet committed)
- Magneton helper refactor (landed as e93062e)
- WASM-in-DO feasibility study (landed as b449dd3)
- **This grant application itself** (this very scaffold)

While those ran, the main thread kept moving on the ultron signing agent
(c788108) and a mainnet smoke script (uncommitted). Concurrency is the point.

## File paths worth citing

- `src/server/agents/ultron-signing-agent.ts` — Increment A state machine
- `src/server/sol/helius.ts` — Helius proxy + `ULTRON_SOL_ADDRESS`
- `src/client/rumble-ultron.ts` — browser DKG hook
- `src/lib/vector-intent.ts` — vector-principles helper
- `contracts/shade/` — `StableShadeOrder<iUSD>` move contracts
- `docs/session_2026_04_13_nursery_wrap.md` — prior wave's letter-to-next-swarm

## Measurements

- 9 commits in one session on `devnet/nursery`
- 2 memory-documented blockers falsified with empirical proof
- $227.22 in stables swept cleanly on mainnet (136.47 USDC + 90.75 iUSD)
- 4 concurrent subagent lanes at peak
