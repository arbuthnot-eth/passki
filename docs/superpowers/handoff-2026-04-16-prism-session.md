# Prism hackathon — session handoff (2026-04-16)

Next session pick-up for Prism / Solana Frontier Colosseum submission.

## Where we are

**Frontier deadline: May 11, 2026 (3.5 weeks out).** `prism_vault` Quasar program scaffolded + 3 real modules shipped with unit tests.

- **10/10 tests green**
- **5/10 Zapdos moves landed:** Charge, Thunder Shock, Light Screen, Signal Beam, Double Team
- **Remaining:** Thunderbolt, Drill Peck, Agility, Roost, Sky Attack
- **Branch:** `devnet/nursery`, pushed through `08db5a6`
- **SBF build verified:** `target/deploy/prism_vault.so` (10KB)

## Read first (3 min)

- `~/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/MEMORY.md` — index
- `~/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/project_prism_vault.md` — program ID + keypair
- `~/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/project_suilana_ikasystem.md` — positioning
- `docs/superpowers/specs/2026-04-16-prism-solana-colosseum-design.md` — architecture
- `docs/superpowers/plans/2026-04-16-prism-solana-colosseum.md` — task plan

## Quasar sharp edges (SOLVED — apply these)

Thunderbolt got walked back because 3 Quasar idioms weren't obvious. Verified from `/tmp/quasar-src/examples/multisig/src/instructions/set_label.rs` + `/tmp/quasar-src/pod/src/`:

1. **Variable-length ix args** — use `PodVec<u8, N>` (re-exported as `Vec<u8, N>` from prelude) or `PodString<N>`. Example from multisig:
   ```rust
   pub fn set_label(ctx: Ctx<SetLabel>, label: String<32>) -> Result<(), ProgramError>
   ```
   For Thunderbolt: `manifest_json: Vec<u8, 2048>`, `ed25519_ix_data: Vec<u8, 1024>`.

2. **Seed type non-Address** — Quasar seeds macro calls `.to_le_bytes()` on non-Address seeds. `[u8; 16]` fails. Swap `Nullifier.prism_id` → `u128` (UUID is exactly 128 bits, clean mapping). `prism_id: u128` in `#[seeds(b"nullifier", prism_id: u128)]`. Update `parse_manifest` to return `u128`.

3. **Clock sysvar access** — import pattern:
   ```rust
   use quasar_lang::{prelude::*, sysvars::Sysvar as _};
   let clock = Clock::get()?;
   ```
   NOT a free `Clock::get()` without trait in scope.

## Pokemon issues

- **#164 Zapdos** — prism_vault program (5/10 moves landed)
- **#165 Articuno** — sealed client flow (blocked on Zapdos)
- **#166 Moltres** — UI + Frontier submission (blocked on Articuno)

## Priority-1 — Zapdos Thunderbolt (retry)

Per plan Z6. Apply the 3 idioms above:

1. `contracts/prism_vault/src/state.rs`: `Nullifier.prism_id: [u8;16]` → `u128`. Seeds: `#[seeds(b"nullifier", prism_id: u128)]`. Already has `set_inner` attribute.
2. `contracts/prism_vault/src/manifest.rs`: `ParsedManifest.prism_id: [u8;16]` → `u128`. Convert: `u128::from_le_bytes(bytes_16)` or helper.
3. Create `contracts/prism_vault/src/instructions/claim_transfer.rs`:
   - Accounts: `payer (Signer)`, `nullifier (Account<Nullifier>, init, seeds = Nullifier::seeds(prism_id), bump)`, `system_program`
   - `#[instruction(prism_id: u128)]` on struct
   - Handler: `validate_ed25519_ix_data` → `parse_manifest` → assert parsed == arg prism_id → `set_inner` on nullifier
4. `lib.rs` `#[program]` discriminator 1: args `prism_id: u128, manifest_json: Vec<u8, 2048>, ika_sig: [u8; 64], ika_pubkey: [u8; 32], ed25519_ix_data: Vec<u8, 1024>`
5. Import `Sysvar as _` + add Clock::get() for `claimed_at` timestamp.
6. Tests: extend `manifest.rs` tests with u128 assertions.
7. Commit: `Zapdos Thunderbolt — claim_transfer instruction`.

## Priority-2 — Drill Peck / Agility / Roost / Sky Attack

Per plan. Mainnet-beta deploy (Sky Attack) needs ~5 SOL on `keys/prism_vault-keypair.json`.

## Kamino integration (fresh research from this session)

**Best angle (differentiation 5/5):** iUSD → klend collateral → borrow USDC → Token-2022 CT to recipient. Novel: cross-chain IKA-signed manifests as collateral-authorization primitives. Requires iUSD reserve listing on klend — multi-week governance ask to Kamino risk team; start the convo ASAP if pursuing.

**Backup angle (diff 2/5):** Prism swap leg CPIs Kamino CLMM instead of Jupiter for stable pairs. Low effort but Jupiter already routes through Kamino CLMM.

**Quasar → Kamino CPI: viable.** Use Codama `renderers-rust` for codegen (no anchor-lang dep). Kamino programs:
- klend (Lend): `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- Repo: https://github.com/Kamino-Finance/klend
- SDKs: `@kamino-finance/klend-sdk`, `kliquidity-sdk`, `farms-sdk`, `scope-sdk`

**Deal-breakers to respect:**
- Pin Kamino IDL by commit hash; snapshot-test discriminator + account order in CI
- Every klend user ix requires a `refresh_reserve` CPI in the same tx (scope oracle)
- CU budget — klend deposits ~150K CU; keep Prism wrapper lean
- Jupiter v6 discourages direct CPI; use off-chain routing + on-chain account-list invoke (our existing pattern)
- solores is archived — mirror the crate if used

**No Frontier Kamino bounty.** Main hackathon removed all tracks; side-tracks on Superteam Earn don't show Kamino yet. Ping Kamino BD directly if pursuing.

**Model to copy:** Drift's klend integration for deposit/withdraw CPI semantics. Jupiter routes through Kamino CLMM for swap-venue precedent.

## LATE-BREAKING: Eitherway $20K side-track (2026-04-16)

Superteam Earn @SuperteamEarn tweet announced the **Eitherway Track** at Frontier:
- **$20,000 USDC prize pool**
- Must build with **Eitherway** (a Solana prompt-to-dApp builder tool, handle `@EitherwayAI`)
- Must deeply integrate ONE of: **Solflare, Kamino, DFlow, QuickNode**
- Requirement: "launch something that survives beyond the hackathon"

This is the track the user was pointing at when asking "what about using eitherway for kamino integration?" — the name caught me by surprise initially.

**Why this matters for us:** the iUSD→klend collateral→borrow USDC angle we researched (differentiation 5/5) lands directly in eligibility for $20K. Our Quasar `prism_vault` + SUIAMI already covers "survives beyond the hackathon" because sui.ski is live infra.

### Eitherway research — agent returned

**Product:** `eitherway.ai` (docs: `docs.eitherway.ai`, X: `@EitherwayAI`). AI prompt-to-production platform on Solana — uses **Claude (Anthropic) for code gen**. Pre-built templates include DeFi Yield Optimizer, Multi-Chain Portfolio Tracker, Token Deployment, NFT Marketplace, DAO Governance, Web3 Escrow. Baked-in infra: Supabase, Stripe, Helius, Pyth, Solflare, Filecoin, Google Cloud. Has a native `$EITHER` SPL token gating premium features/templates.

**Listing URL:** `https://superteam.fun/earn/listing/build-a-live-dapp-with-solflare-kamino-dflow-or-quicknode-with-eitherway-app/`

**Prize:** $20,000 USDC total (breakdown not surfaced in search — confirm on listing). **Winner announcement May 27, 2026**; submission deadline almost certainly aligned with Frontier May 11.

**Verified capabilities:** Phantom + Solflare wallet adapters. External backend (sui.ski Workers) via plain `fetch` = likely OK.

**Unverified (need 30-min trial at eitherway.ai):**
- Custom program calls to raw Quasar program (8-byte discriminator + Borsh) — not advertised
- Anchor IDL ingestion path
- Token-2022 confidential transfers — not mentioned, treat as unsupported-by-default
- Code export story (does the app survive if Eitherway shuts down?)

**Verdict (from agent):** **Use Eitherway as the Kamino dashboard layer for Prism — don't rebuild the whole frontend.** Narrative: *Prism sealed payments → auto-deposit into iUSD-backed Kamino vault, dashboard built in Eitherway.* Standalone "Kamino collateral cockpit" at `prism.sui.ski/vault` satisfies "deeply integrate Kamino" and "built with Eitherway" without touching the Quasar program path.

**Next-session actions for this track:**
1. Open listing in browser, screenshot prize breakdown + exact deadline + submission form + check for "100% Eitherway" clause (WebFetch was denied; requires manual verification)
2. Sign up at eitherway.ai; run the prompt: *"Kamino klend dashboard that deposits USDC via Solflare and displays health factor."* Verify: (a) can edit generated TS, (b) can paste custom IDL, (c) can deploy under custom domain
3. Ask in Eitherway/Superteam Discord whether hybrid-layer (Eitherway cockpit + external backend) qualifies BEFORE committing

**Red flags:**
- Prize split unconfirmed (winner-take-all vs tiered affects ROI)
- "Built with Eitherway" strictness — if fully Eitherway-generated is required, hybrid disqualified
- `$EITHER` token may gate premium templates (budget for purchase)
- Opaque code export — "survives beyond hackathon" becomes Eitherway-dependent

## Don't forget

- **Superteam Earn — April 15 deadline** for some side-tracks. Open `https://superteam.fun/earn/hackathon/frontier/` first thing, screenshot grid, spreadsheet. Top-3: Arcium (DIRECT fit), Metaplex (adjacent cNFT receipt), Squads (adjacent multisig wrap). **Plus the Eitherway track above.** See full list in prior session's synthesis.
- **Cloudflare for Startups** — 1hr app, up to $250K credits. https://www.cloudflare.com/forstartups/ — we qualify today.
- **Tweet at @sendaifun + @yashhsm + @colosseum** with 60s Prism demo when it exists. Skip the sendaifun PRs for now (LIGHT path verdict).
- **Zero to Agent Buenos Aires** — Vercel/v0 event, NOT Solana. Skip travel.

## Quick test commands

```bash
cd /home/brandon/Dev/Sui-Dev/Projects/SKI/contracts/prism_vault
cargo check          # should be clean with 4 cfg warnings
cargo test --lib     # should show 10 passing
cargo build-sbf      # produces target/deploy/prism_vault.so (~10KB)

# Solana CLI path (not in default PATH):
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

## Vocabulary cheat sheet

- **fainted** (not feinted) — walked-back/cleaned-up work
- **jacket** (not wrapper) — code-around-library
- **moves** — individual commits in a Pokemon thread
- **evolved** — PR merged to master
- **Pokemon** — GitHub issue, gitops only (public product stays **Prism**)
- **Suilana Ikasystem** — the category frame (mention a LOT)

## Clean-pause signature

Last commit pushed: `08db5a6 Zapdos Thunderbolt attempt — reverted to scaffold`
Branch ahead of master by ~14 commits — evolve when Thunderbolt + Drill Peck + Agility land.
