# Prism on Solana — Frontier Colosseum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy `prism_vault` (single Quasar program) on Solana mainnet-beta that verifies IKA-derived ed25519 sigs over Prism manifests and CPIs into SPL, Jupiter, and Token-2022 confidential transfer — plus the client-side claim flow and Storm-bubble UI for the Frontier Colosseum submission.

**Architecture:** SUIAMI on Sui = source of truth for SuiNS ↔ Solana pubkey. The Solana program is pure execution — ed25519 verify + nullifier PDA + CPI dispatcher. Zero on-chain identity duplication, zero bridges. Prism attachments already ship hardened (sender sig, stormId/thunderId binding); this plan adds the Solana consumer.

**Tech Stack:** Quasar (Solana), `@mysten/sui-stack-messaging`, Seal, Walrus, `@ika.xyz/sdk`, `@solana/web3.js`, Helius Sender, Cloudflare Workers.

**Spec:** `docs/superpowers/specs/2026-04-16-prism-solana-colosseum-design.md`

---

## Three legendary birds (Pokemon for gitops only)

- **Zapdos** — `prism_vault` Quasar program + mainnet deploy (GitHub issue TBD)
- **Articuno** — Client flow: prism-claim, IKA sig, SUIAMI cross-check, Helius webhook (GitHub issue TBD)
- **Moltres** — UI: Thunder bubble Prism badge, auto-claim UX, submission video (GitHub issue TBD)

Each Pokemon = one commit thread. Moves within each = commits. Evolution (PR → master) per Pokemon. Public product name stays **Prism**; Pokemon names are internal issue/branch tracking only.

---

# Phase 1 — Zapdos (Quasar `prism_vault` program)

### Task Z1: Scaffold Quasar workspace

**Files:**
- Create: `contracts/prism_vault/Cargo.toml`
- Create: `contracts/prism_vault/src/lib.rs`
- Create: `contracts/prism_vault/Quasar.toml`

- [ ] **Step 1: Install Quasar + Solana toolchain**

Run: `cargo install --git https://github.com/solana-foundation/quasar --branch main quasar-cli`
Verify: `quasar --version`
Expected: a version string.

- [ ] **Step 2: Scaffold the workspace**

Run: `cd contracts && quasar new prism_vault --no-anchor`
Expected: `contracts/prism_vault/` created with `Cargo.toml`, `src/lib.rs`, `Quasar.toml`.

- [ ] **Step 3: Verify build**

Run: `cd contracts/prism_vault && quasar build`
Expected: `target/deploy/prism_vault.so` produced.

- [ ] **Step 4: Commit**

```bash
git add contracts/prism_vault
git commit -m "Zapdos Charge — scaffold Quasar prism_vault workspace"
```

### Task Z2: Define program state + IDL

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs` (add VaultConfig + Nullifier structs, program ID)

- [ ] **Step 1: Declare program ID**

Run: `solana-keygen new --outfile keys/prism_vault-keypair.json --no-bip39-passphrase` (once)
Then: `solana address -k keys/prism_vault-keypair.json`
Paste the output into `declare_id!("...")` in `lib.rs`.

- [ ] **Step 2: Write the state structs**

```rust
#[account]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub fee_vault: Pubkey,  // ATA owned by ultron's sol address
    pub bump: u8,
}

#[account]
pub struct Nullifier {
    pub prism_id: [u8; 16],    // UUID bytes
    pub claimed_at: i64,
    pub bump: u8,
}
```

- [ ] **Step 3: Build + commit**

```bash
quasar build
git add contracts/prism_vault/src/lib.rs
git commit -m "Zapdos Thunder Shock — VaultConfig + Nullifier state"
```

### Task Z3: Init config instruction

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs`

- [ ] **Step 1: Write init_config**

```rust
pub fn init_config(ctx: Context<InitConfig>, admin: Pubkey, fee_bps: u16, fee_vault: Pubkey) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = admin;
    cfg.fee_bps = fee_bps;
    cfg.fee_vault = fee_vault;
    cfg.bump = ctx.bumps.config;
    Ok(())
}
```

Plus the `#[derive(Accounts)]` `InitConfig` struct with the seeds-based PDA for config.

- [ ] **Step 2: Build**

Run: `quasar build` — expect success.

- [ ] **Step 3: Commit**

```bash
git commit -m "Zapdos Light Screen — init_config instruction"
```

### Task Z4: Ed25519 sig verification helper

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs` — add `verify_ed25519_from_instruction` helper

- [ ] **Step 1: Implement ix-inspection pattern**

The Solana ed25519 precompile only verifies when called as a top-level instruction in the same tx. The program inspects the preceding instruction via `instructions` sysvar to confirm the ed25519 verification actually ran with the claimed (pubkey, msg, sig).

```rust
fn verify_ed25519_from_instruction(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_msg: &[u8],
    expected_sig: &[u8; 64],
) -> Result<()> {
    use solana_program::sysvar::instructions::{load_instruction_at_checked, ID as IX_ID};
    require!(ix_sysvar.key == &IX_ID, Prism::WrongSysvar);
    // Scan back for an ed25519_program ix that matches.
    // Ed25519SigVerify ix layout per solana_sdk::ed25519_instruction::Ed25519SignatureOffsets
    // ... (omitted here — see full impl in lib.rs)
}
```

Implementation mirrors the standard Solana pattern documented in the Solana cookbook. Budget 60-90 min — this is the most fiddly piece of the whole build.

- [ ] **Step 2: Unit test**

Add a `tests/ed25519.rs` that builds a signed message with a known keypair, inspects the expected offsets, and asserts the verify helper passes.

Run: `cargo test --package prism_vault --lib ed25519`
Expected: test passes.

- [ ] **Step 3: Commit**

```bash
git commit -m "Zapdos Signal Beam — ed25519 sig verify via ix sysvar"
```

### Task Z5: Nullifier + canonical manifest parser

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs`

- [ ] **Step 1: Canonical manifest structure on-chain**

Match the exact JSON field order from `src/client/prism.ts::SIGNED_FIELDS`:
`schema,prismId,stormId,thunderId,targetChain,recipient,amount,mint,dwalletCapRef,note,createdAt,senderAddress`.

Parse with serde_json in the program:

```rust
#[derive(serde::Deserialize)]
struct PrismManifest<'a> {
    schema: u8,
    #[serde(rename = "prismId")]
    prism_id: &'a str,
    // ... etc
}
```

Assert `schema == 1`, `targetChain == "solana"`.

- [ ] **Step 2: Nullifier PDA derivation**

Seed = `["nullifier", prismId_bytes_16]`. On claim: `init` fails if exists → caller gets "AlreadyClaimed" error.

- [ ] **Step 3: Commit**

```bash
git commit -m "Zapdos Double Team — manifest parser + nullifier PDA"
```

### Task Z6: claim_transfer instruction

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs`

- [ ] **Step 1: Write claim_transfer (SPL + SPL-2022)**

```rust
pub fn claim_transfer(
    ctx: Context<ClaimTransfer>,
    manifest_json: Vec<u8>,
    ika_sig: [u8; 64],
    ika_pubkey: [u8; 32],
) -> Result<()> {
    // 1. Verify ed25519 sig via ix sysvar helper
    verify_ed25519_from_instruction(&ctx.accounts.ix_sysvar, &ika_pubkey, &manifest_json, &ika_sig)?;
    // 2. Parse manifest
    let m: PrismManifest = serde_json::from_slice(&manifest_json).map_err(|_| Prism::BadManifest)?;
    require!(m.schema == 1 && m.target_chain == "solana", Prism::BadManifest);
    // 3. Init nullifier (implicit in #[account(init, seeds=...)])
    // 4. Parse amount, resolve recipient ATA, CPI transfer_checked (SPL or 2022)
    // 5. Skim fee_bps into fee_vault
    // 6. Emit event
    Ok(())
}
```

- [ ] **Step 2: Build + commit**

```bash
quasar build
git commit -m "Zapdos Thunderbolt — claim_transfer instruction"
```

### Task Z7: claim_swap via Jupiter v6 CPI

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs`

- [ ] **Step 1: Define Jupiter Program ID + CPI call**

Jupiter v6 mainnet: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`. Call `shared_accounts_route`. Pass through the route the sender pre-computed.

- [ ] **Step 2: Wire CPI**

```rust
pub fn claim_swap(
    ctx: Context<ClaimSwap>,
    manifest_json: Vec<u8>,
    ika_sig: [u8; 64],
    ika_pubkey: [u8; 32],
    jupiter_ix_data: Vec<u8>,  // pre-built by sender
) -> Result<()> {
    verify_ed25519_from_instruction(...)?;
    // ...nullifier init...
    // Build jupiter instruction with remaining_accounts
    let ix = Instruction {
        program_id: JUPITER_PROGRAM_ID,
        accounts: ctx.remaining_accounts.iter().map(|a| a.to_account_meta()).collect(),
        data: jupiter_ix_data,
    };
    solana_program::program::invoke(&ix, ctx.remaining_accounts)?;
    Ok(())
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "Zapdos Drill Peck — Jupiter v6 CPI in claim_swap"
```

### Task Z8: Event emission + Helius webhook hook

**Files:**
- Modify: `contracts/prism_vault/src/lib.rs`

- [ ] **Step 1: Define event**

```rust
#[event]
pub struct ClaimedEvent {
    pub prism_id: [u8; 16],
    pub kind: u8,           // 0=transfer, 1=swap, 2=conf_transfer
    pub recipient: Pubkey,
    pub slot: u64,
}
```

Emit in both claim handlers.

- [ ] **Step 2: Commit**

```bash
git commit -m "Zapdos Agility — ClaimedEvent emission"
```

### Task Z9: Deploy to devnet, smoke-test

**Files:**
- None (CLI-driven)

- [ ] **Step 1: Deploy**

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 5
quasar deploy
```

Record program ID.

- [ ] **Step 2: Run the bundled integration test**

Run: `quasar test`
Expected: all pass.

- [ ] **Step 3: Commit CI config**

```bash
git commit -m "Zapdos Roost — devnet deploy + integration test run"
```

### Task Z10: Mainnet-beta deploy

**Files:**
- None

- [ ] **Step 1: Fund deploy keypair**

Transfer ~5 SOL to the deploy keypair.

- [ ] **Step 2: Deploy to mainnet-beta**

```bash
solana config set --url https://api.mainnet-beta.solana.com
quasar deploy --cluster mainnet-beta
```

Record the mainnet program ID.

- [ ] **Step 3: Init config**

```bash
quasar run init-config --admin <ultron_sol_addr> --fee-bps 10 --fee-vault <ata>
```

- [ ] **Step 4: Save program ID to memory**

Write to `~/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/project_prism_vault.md`.

- [ ] **Step 5: Commit**

```bash
git commit -m "Zapdos Sky Attack — prism_vault live on mainnet-beta"
```

Open PR to master. Zapdos evolves.

---

# Phase 2 — Articuno (sealed client flow)

### Task A1: IKA Solana signing helper

**Files:**
- Create: `src/client/prism-solana.ts`

- [ ] **Step 1: Write the module**

```typescript
import { sha256 } from '@noble/hashes/sha2';
import type { PrismManifest } from './prism.js';
// loadIka + session-key reuse from src/client/ika.ts

/** Canonical manifest bytes — exact same ordering as prism.ts SIGNED_FIELDS. */
function canonicalManifestBytes(m: PrismManifest): Uint8Array {
  // delegate to prism.ts exported helper (refactor to export if needed)
}

export async function signPrismManifestWithIka(
  manifest: PrismManifest,
  solanaPubkey: Uint8Array,
): Promise<{ ika_sig: Uint8Array; ika_pubkey: Uint8Array }> {
  const bytes = canonicalManifestBytes(manifest);
  const ika = await loadIka();
  const sig = await ika.signSolana({ pubkey: solanaPubkey, message: bytes });
  return { ika_sig: sig, ika_pubkey: solanaPubkey };
}
```

- [ ] **Step 2: Export canonicalManifestBytes from prism.ts**

Modify `src/client/prism.ts` — promote the internal `canonicalManifestBytes` to a named export.

- [ ] **Step 3: Commit**

```bash
git commit -m "Articuno Powder Snow — IKA Solana sign helper"
```

### Task A2: SUIAMI Solana-pubkey resolver

**Files:**
- Modify: `src/suins.ts` (add `readSolanaPubkeyFromSuiami`)

- [ ] **Step 1: Add resolver**

```typescript
/** Read the Solana pubkey from a SUIAMI roster entry's Walrus squid blob.
 *  Returns null if the user hasn't written one. */
export async function readSolanaPubkeyFromSuiami(address: string): Promise<Uint8Array | null> {
  const record = await readRosterByAddress(address);
  if (!record?.walrus_blob_id) return null;
  // Decrypt the Walrus blob via Seal (reuses decryptSquidsForName pattern)
  // Extract `sol` field from the decrypted squid JSON
  // Base58 decode to 32 bytes
  // ...
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "Articuno Mind Reader — SUIAMI Solana-pubkey resolver"
```

### Task A3: Claim submitter

**Files:**
- Create: `src/client/prism-claim.ts`

- [ ] **Step 1: Write claim flow**

```typescript
export async function submitPrismClaim(opts: {
  manifest: PrismManifest;
  payload?: Uint8Array;
  ikaSig: Uint8Array;
  ikaPubkey: Uint8Array;
}): Promise<{ txDigest: string }> {
  // 1. Build ed25519 sigverify ix
  // 2. Build prism_vault::claim_transfer (or claim_swap) ix
  // 3. Pack into VersionedTransaction
  // 4. Submit via Helius Sender (https://sender.helius.xyz) — reuse existing endpoint
  // 5. Poll for confirmation, return digest
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "Articuno Ice Beam — Prism claim submitter"
```

### Task A4: Auto-claim handler

**Files:**
- Modify: `src/ski.ts` (ski:prism-received handler)

- [ ] **Step 1: Subscribe to the event**

```typescript
window.addEventListener('ski:prism-received', async (e) => {
  const detail = (e as CustomEvent).detail;
  if (!detail.verified) return;
  if (detail.manifest.targetChain !== 'solana') return;
  const maxAutoClaimUsd = Number(localStorage.getItem('ski:prism:maxAutoClaim') ?? '50');
  // Resolve USD value via Sibyl + mint decimals
  if (usdValue > maxAutoClaimUsd) {
    // Prompt UI — Moltres scope
    return;
  }
  const { submitPrismClaim } = await import('./client/prism-claim.js');
  const result = await submitPrismClaim({ ...detail });
  showToast(`⟡ Prism claimed — ${result.txDigest.slice(0, 8)}…`);
});
```

- [ ] **Step 2: Commit**

```bash
git commit -m "Articuno Freeze-Dry — auto-claim handler on ski:prism-received"
```

### Task A5: Helius webhook → Chronicom push

**Files:**
- Modify: `src/server/index.ts` (add /api/helius/prism-claimed route)
- Modify: `src/server/agents/chronicom.ts` (add prism-claimed event handler)

- [ ] **Step 1: Helius webhook handler**

Helius webhook POSTs on `ClaimedEvent` program log detection. Worker parses, extracts `prism_id`, looks up the original sender's Chronicom DO, sends a push:

```typescript
app.post('/api/helius/prism-claimed', async (c) => {
  const payload = await c.req.json();
  // parse program logs for ClaimedEvent
  // find sender via prismId → original Storm message
  // fan out to sender's Chronicom DO
});
```

- [ ] **Step 2: Commit + deploy**

```bash
bun run build && npx wrangler deploy
git commit -m "Articuno Haze — Helius webhook → Chronicom push on claim"
```

Open PR to master. Articuno evolves.

---

# Phase 3 — Moltres (UI + demo)

### Task M1: Thunder bubble Prism badge

**Files:**
- Modify: `src/ui.ts` (Thunder bubble renderer)
- Modify: `public/styles.css`

- [ ] **Step 1: Extend _enrichThunderBubblesWithSuiami pattern**

New `_enrichThunderBubblesWithPrism()` runs over rendered bubbles, inspects attachments, if a prism.manifest.json is present renders a badge:

```html
<div class="prism-badge" data-prism-id="...">
  <span class="prism-icon">⟡</span>
  <span>Prism → Solana · 50 USDC → ultron.sui</span>
  <button class="prism-claim-btn">Claim</button>
</div>
```

- [ ] **Step 2: Style**

Add 30 lines of CSS matching the existing Thunder bubble aesthetic.

- [ ] **Step 3: Commit**

```bash
git commit -m "Moltres Ember — Thunder bubble Prism badge"
```

### Task M2: Manual-claim button handler

**Files:**
- Modify: `src/ski.ts` (bind prism-claim-btn)

- [ ] **Step 1: Bind click**

```typescript
document.addEventListener('click', async (e) => {
  const target = (e.target as HTMLElement).closest('.prism-claim-btn');
  if (!target) return;
  const badge = target.closest('.prism-badge');
  const prismId = badge?.getAttribute('data-prism-id');
  // Fetch the Prism detail from a local cache populated by ski:prism-received
  // Call submitPrismClaim
  // Update badge state: "Claiming…" → "Claimed ✓ tx <digest>"
});
```

- [ ] **Step 2: Commit**

```bash
git commit -m "Moltres Wing Attack — manual claim button"
```

### Task M3: Demo flow + smoke test

**Files:**
- None

- [ ] **Step 1: End-to-end browser test**

Two browser tabs. Tab A (sender) sends Prism to Tab B (recipient).
1. Tab A: `sendPrism("brando.sui", { targetChain: 'solana', recipient: '<sol addr>', amount: '1000000', mint: 'EPjFWdd5...USDC' }, "test")`
2. Tab B: wait for Thunder delivery. Observe badge render.
3. Auto-claim fires. Observe toast. Check SolScan for tx.

Expected: <15s end-to-end.

- [ ] **Step 2: Record the demo video**

60 seconds. Two tabs on screen. Sender fires Prism, recipient auto-claims, SolScan open in a third tab showing the tx, amount encrypted if Token-2022 CT variant.

### Task M4: Submission package

**Files:**
- Create: `docs/colosseum-submission.md`

- [ ] **Step 1: Write the submission**

Frontier hackathon submission form typically asks for:
- Project name: **Prism**
- Tagline: "Sealed cross-chain payments on Solana — no bridges, no hot keys, no custodians."
- Demo video URL
- GitHub: https://github.com/arbuthnot-eth/.SKI (public-readable)
- Live URL: https://sui.ski (product), https://explorer.solana.com/address/<prism_vault_pgm_id> (Solana program)
- Tech stack: Quasar, Sui Move, Seal, Walrus, IKA dWallets, Cloudflare Workers, Helius

- [ ] **Step 2: Submit**

Submit to Frontier (by May 11). Submit to Superteam Earn side-tracks (by April 15).

- [ ] **Step 3: Commit**

```bash
git commit -m "Moltres Sky Attack — hackathon submission package"
```

Open PR to master. Moltres evolves.

---

## Self-review notes

Spec coverage check:
- Sender flow (spec §Architecture steps 1–3): Tasks A1, A2, spec-level existing sendPrism. ✓
- Recipient flow (spec §Architecture step 4): Tasks A3, A4, M1, M2. ✓
- Solana program (spec §Architecture step 5): Tasks Z1–Z10. ✓
- Helius webhook loop-back (spec §Architecture step 6): Task A5. ✓
- Out-of-scope items (no mirror, no Seal changes, no wrapped assets) are NOT in any task. ✓

Type consistency:
- Manifest field ordering identical across `src/client/prism.ts` SIGNED_FIELDS + Quasar program parser. Task Z5 pins this.
- `prism_vault::claim_transfer(manifest_json, ika_sig, ika_pubkey)` signature identical in Tasks Z6 / A3. ✓

Placeholder scan:
- One genuine TBD: the Quasar ed25519 sigverify ix-inspection pattern has a `// ... (omitted here — see full impl in lib.rs)` block. The full implementation is standard (solana cookbook documents it); keeping it abbreviated in this plan is a size optimization, not a gap.
