# Prism on Solana — Frontier Colosseum Design

**Date:** 2026-04-16
**Status:** Approved, ready for implementation plan
**Hackathon:** Solana Frontier Hackathon (Colosseum, Apr 6 – May 11, 2026)
**Related specs:**
- `docs/superpowers/specs/2026-04-16-cf-edge-enrichment-design.md` (SUIAMI cf_history)
- `docs/suiami-identity.mdx` (SUIAMI substrate)

## Goal

Ship **Prism on Solana** as the Frontier Colosseum submission: a Quasar program on Solana mainnet-beta that consumes Prisms (Thunder attachments carrying IKA-signed cross-chain manifests) and executes SPL transfers, Jupiter swaps, and Token-2022 confidential transfers — with zero bridge, zero custodian, zero on-chain identity duplication.

## Core principle — SUIAMI doubles as Solana identity

SUIAMI's Sui-side roster is the authoritative SuiNS ↔ Solana pubkey mapping (IKA dWallets derive the Solana ed25519 key from the same DKG that mints the Sui address). We do **not** mirror SUIAMI on Solana. The Solana program is a pure execution primitive — it verifies an ed25519 signature and dispatches a CPI. Identity resolution happens client-side (Sui GraphQL lookup of the SUIAMI record).

Sender-side Prism signatures (already shipped in the 2026-04-16 hardening) bind each manifest to the sender's Sui address; clients reject Prisms where the manifest's Solana pubkey doesn't match the SUIAMI record for the claimed `senderAddress`.

## Non-goals

- **No on-chain SUIAMI mirror on Solana.** Every prior design considered one; this one skips it entirely.
- **No new cross-chain message bus.** Prism / Thunder / Storm stay as-is.
- **No new identity primitive.** SUIAMI is the source of truth.
- **No Seal changes.** The existing `@mysten/sui-stack-messaging` attachment Seal policy gates delivery.
- **No wrapped assets.** The dWallet signs Solana native actions; SPL tokens stay SPL tokens.

## Architecture

```
  Sender (Sui browser)              Thunder SDK               Solana
  ──────────────────              ──────────────            ───────────
  1. sendPrism("ultron.sui", {     AttachmentsManager         (no tx yet)
       targetChain: 'solana',  →   encrypt + Walrus  →
       recipient: <sol-pubkey>,    → ski:prism-received ←      (stored
       amount, mint, action        event in receiver's           as
     })                              Storm bubble               Walrus
                                                                blob)

  2. Sender signs manifest via IKA dWallet's Solana share:
       ed25519_sign(canonical_manifest) → ika_sig

  3. Manifest + ika_sig travel in Prism attachment

  Receiver (Sui browser)
  ──────────────────
  4. ski:prism-received handler:
       - Extract manifest + payload
       - Verify sender sig (already hardened)
       - Fetch SUIAMI record for senderAddress to cross-check sol pubkey
       - If verified + auto-claim enabled: call prism_vault::claim

  Solana — prism_vault (Quasar program)
  ──────────────────
  5. claim(manifest, ika_sig, route):
       a. ed25519_program CPI — verify ika_sig over canonical(manifest)
          using ika_pubkey from manifest
       b. Derive nullifier PDA = hash(manifest.prismId)
       c. Assert PDA does not exist → init; else abort (already claimed)
       d. Dispatch action:
            - SPL transfer      → spl_token::transfer_checked
            - SPL-2022 confidential → token_2022::confidential_transfer
            - Jupiter swap      → jupiter_v6::shared_accounts_route CPI
       e. Emit ClaimedEvent(prismId, action, recipient, slot)

  6. Helius webhook on ClaimedEvent → CF Worker → Chronicom DO → push
     notification back to sender's Storm (close the loop).
```

## On-chain data model (Solana)

`prism_vault` program — single Quasar program.

**Accounts:**
- `VaultConfig` (PDA seed `"config"`) — admin, fee params, allowed action variants. Initialized once by `ultron.sui`-controlled address.
- `Nullifier` (PDA seed `["nullifier", prismId_bytes]`) — exists iff the Prism has been claimed. Single-claim enforcement.

**Instructions:**
- `init_config(admin, fee_bps)` — admin-only, one-shot.
- `claim_transfer(manifest_json, ika_sig, ika_pubkey)` — SPL or SPL-2022 transfer. Manifest encodes amount, mint, recipient ATA.
- `claim_swap(manifest_json, ika_sig, ika_pubkey, jup_route)` — Jupiter swap + transfer.
- `set_config(fee_bps)` — admin update.

All claims:
1. Parse manifest; assert `manifest.targetChain == "solana"` and `schema == 1`.
2. Compute `canonical_manifest` via deterministic JSON field ordering matching `src/client/prism.ts::SIGNED_FIELDS`.
3. Ed25519 verify `ika_sig` over `canonical_manifest` with `ika_pubkey` via `ed25519_program` CPI (pre-instruction ix inspection).
4. Derive nullifier PDA, init (fails if exists).
5. CPI the action.
6. Emit `ClaimedEvent`.

**Fees:** `config.fee_bps` (default 10 = 0.1%) skimmed from output into a vault ATA owned by `ultron.sui`'s Solana address. Routes to iUSD cache via a follow-up keeper tx.

## Client flow (reuses existing)

**Sender:** `sendPrism()` console helper already builds the Prism attachment and sends it through `sendThunder`. To produce the ed25519 sig:
- New function `buildSolanaPrismPayload(manifest)` in `src/client/prism-solana.ts` — returns `{ ika_sig, ika_pubkey }` by asking the IKA client to sign the canonical manifest bytes with the user's Solana share.

**Recipient:**
- Existing `ski:prism-received` handler subscribes.
- New module `src/client/prism-claim.ts`:
  - `resolveRecipientFromSuiami(senderAddress)` → verify the Prism manifest's `ika_pubkey` equals the SUIAMI record's stored Solana pubkey for `senderAddress`. Reject on mismatch.
  - `submitClaim(manifest, ika_sig, ika_pubkey)` → build `prism_vault::claim_*` tx, submit via Helius Sender.
  - Auto-claim gated on a user-set `maxAutoClaimUsd` threshold (default $50). Above that, UI prompts.

**Demo UI:**
- Thunder bubble renders a Prism badge (from earlier hardening UI roadmap — ship now).
- `⟡ Prism → Solana — 50 USDC → ultron.sui` with a "Claim on Solana" button for manual-path.
- Auto-claim path: toast "⟡ Prism claimed — txn <digest>" on success.

## Grant + hackathon parallels

- **Primary submission:** Solana Frontier Hackathon, due May 11, 2026.
- **Side-tracks:** Superteam Earn Frontier side-tracks (Metaplex, Privy, Arcium) — due April 15, 2026. Submit same build.
- **Double-dip:** ETHGlobal OpenAgents (Apr 24 – May 3) — Prism as cross-chain agent payment rail, reuse codebase.
- **Accelerator:** Colosseum post-hack $250K for top 10 teams; apply immediately on submission.
- **Grants to apply for in parallel:**
  - Cloudflare for Startups (up to $250K credits, 1-hr app)
  - IKA Foundation RFP (rolling)
  - Sui Foundation RFP ($10K–$100K + SUI bonuses)

## Risks / calibration

- **Quasar on-chain syntax uncertainty** — validate on day 0: ed25519 sigverify precompile helper, PDA bump derivation, CPI shape. All 3 Quasar pitch agents flagged this as unknown; worst case is 2hrs of doc-reading, not a blocker.
- **Token-2022 Confidential Transfer maturity** — mainnet adoption thin; dry-run the decrypt path multiple times pre-demo.
- **Seal key server availability** — Overclock / Studio Mirai / H2O Nodes. Test all 3 during rehearsal.
- **Jupiter route staleness** — routes expire fast; build Jupiter CPI with fresh route fetched at claim-time, not send-time.
- **IKA Solana signing latency** — 2PC ceremony adds seconds. If too slow for demo, pre-sign in the send flow.

## Success criteria

- `prism_vault` deployed to Solana mainnet-beta.
- `claim_transfer`, `claim_swap`, and a Token-2022 CT variant all execute live on mainnet.
- sui.ski user sends a Prism, recipient auto-claims on Solana in <15 seconds end-to-end.
- Submission video shows two browser tabs, no bridge, no hot keys, encrypted amount on SolScan.
- Submitted to Frontier by May 11. Submitted to Superteam side-tracks by April 15.

## Pokemon tracking — three legendary birds

For gitops only. Public product name is "Prism." Pokemon are purely internal issue/commit tracking per the project's gitcatch workflow.

- **Zapdos** (electric/flying) — the `prism_vault` Quasar program (core execution primitive; lightning = Solana speed).
- **Articuno** (ice/flying) — the sealed client flow (prism-claim / IKA sig / SUIAMI cross-check / Helius webhook → Chronicom push).
- **Moltres** (fire/flying) — the UI + demo (Thunder bubble Prism badge, auto-claim UX, submission video).

Moves (commits) within each Pokemon; evolution (PR merge) per Pokemon. Final trio submission = hackathon package.
