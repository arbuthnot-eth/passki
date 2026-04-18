# Sneasel Ice Fang — fix the sweep-graph collapse

**Issue:** #197
**Arc:** Sneasel (private-send wiring for `*.whelm.eth`)
**Gate:** Ship-blocker. Sneasel cannot go public until Ice Fang lands.
**Dependencies:** `2026-04-18-sneasel-weavile-threat-model.md` (T2 section — chain analytics).

---

## 1. Problem statement

Current Sneasel design creates a **fresh hot address per guest** (`amazon.brando.whelm.eth` vs `venmo.brando.whelm.eth` resolve to distinct addrs), but every hot address sweeps to a **single ultron broker cluster** (`eth@ultron = 0xcaA8d6F0…882d`, hardcoded in `src/server/agents/sneasel-watcher.ts:46`).

Consequence:
- Chainalysis common-input heuristic clusters all hot addrs the first time they co-fund a sweep tx.
- Peel-chain analysis from the broker cluster forward links each counterparty's cold squid back to the same cohort.
- Arkham tags all `.whelm.eth` users as one entity.
- Amazon and Venmo still can't compare notes (UX win), but any observer with one of their payments can enumerate every other counterparty and the eventual cold squid. T2 is lost.

## 2. What Ice Fang must guarantee

1. **Per-guest distinct cold destination.** Amazon's funds and Venmo's funds must land at distinct on-chain cold addresses.
2. **Per-guest intermediate hop.** Hot → (guest-specific intermediate) → cold. Intermediate is a fresh IKA-derived dWallet, one per guest, unlinked from ultron's broker cluster.
3. **No batching across guests.** The sweep codepath must never pool multiple guests' hot-addr UTXOs into a single signed transaction. Batching within a single guest's multiple top-ups is fine.
4. **Seal ciphertext already per-guest** — verify this property holds and that nothing in the sweep codepath collapses it.

## 3. Code audit

### 3.1 Move layer (`contracts/suiami/sources/roster.move`)

**Already correct.** Each `GuestStealth` record (L1028-1048) is stored under its own `GuestStealthKey { parent_hash, label }` dynamic field and carries its own `sealed_cold_dest: vector<u8>`. Seal identity = `parent_hash || label` (`sneasel-guest.ts:135`), so ciphertexts are cryptographically per-guest. `seal_approve_guest_stealth` (L1155) gates decrypt on `stealth.sweep_delegate == ctx.sender()` — supports distinct delegates per guest today. **No Move upgrade required.** Pkg `0xaf56e9d0…a0` suffices.

### 3.2 Client encrypt (`src/client/sneasel-guest.ts`)

`sealEncryptColdDest` (L107) encrypts `ColdDestPayload` per (`parentHash`, `labelBytes`). Payload (L127-133) bakes the same `coldAddr` across all guests of one parent — that's the collapse at the cold-deposit step.

**Fix:** mint a per-guest intermediate IKA dWallet and seal *its* addr as `coldAddr`; real cold squid lives in a second, parent-only sealed layer that ultron never sees.

### 3.3 Watcher DO (`src/server/agents/sneasel-watcher.ts`)

- **L293-300 — grouping key.** `tick()` groups by `(chain, sweepDelegate)`. Since every guest uses the same ultron delegate, **every ready sweep lands in one batch.** This is the sweep-graph collapse at the signing layer.
- **L310-312 — TODO(Sneasel Beat Up).** As scoped ("one batched tx per (chain, delegate) group") this **is the bug**. Cancel it.
- **L46 — `ULTRON_ETH_ADDR`.** Reframe as co-signer / orchestrator, not destination. Keep constant, add clarifying comment.

### 3.4 Seal layer (`src/client/suiami-seal.ts`)

Per-guest Seal is already structural. No changes.

---

## 4. Required changes

### 4.1 `src/client/sneasel-guest.ts`

- New helper `mintGuestIntermediate({ chain, parentHash, label })` → `{ intermediateAddr, intermediateCapId }` via IKA DKG (reuse `rumble` machinery; simplest path = fresh DKG session per guest).
- Modify `buildGuestPrivateTx` (L262): before `sealEncryptColdDest`, split payload:
  - **Layer 1 (ultron-readable):** `{ intermediateAddr, chain, sweepDelegate: ultron, version: 2 }`
  - **Layer 2 (parent-owner-readable only):** `{ coldAddr, chain, version: 2 }` — separate sealed blob under a parent-gated policy OR client-side only.
- Bump `ColdDestPayload` → v2. Keep v1 parsing for cutover read-compat only.
- Expose `buildIntermediateSweepTx(intermediateCapId, coldAddr)` so the parent can fire the second hop on their own schedule.

### 4.2 `src/server/agents/sneasel-watcher.ts`

- **L46:** retain `ULTRON_ETH_ADDR`; add comment "orchestrator, not destination."
- **L293-300:** rewrite grouping — one batch per `(chain, parentHash, label)`. No cross-guest grouping.
- **L282-319 (`tick()`):** per-batch loop — fetch sealed blob, decrypt via `sealDecryptColdDest`, reject v1 payloads with clear error, sign hot→intermediate via IKA (`ultronKeypair` abstraction), submit with per-guest random jitter (30s–30min).
- **L33 `SWEEP_DEBOUNCE_MS`:** keep 30s floor; wrap with per-guest random upper bound.
- **L293 `TODO(Sneasel Beat Up)`:** delete. Replace with comment stating Beat Up is intentionally cancelled.

### 4.3 `contracts/suiami/sources/roster.move`

**No required upgrade.** See §6 for optional follow-up.

### 4.4 UI — DO NOT TOUCH

Per `feedback_no_subagent_ui_changes`. UI copy flip ("private" → "counterparty silo") is a separate brando-owned move.

---

## 5. Test plan

### 5.1 Move unit tests
None required for Ice Fang (distinct delegates already supported). If §6 lands:
- `test_rotate_sweep_delegate_preserves_ciphertext`
- `test_rotate_sweep_delegate_owner_only`

### 5.2 Client unit tests (new: `src/client/__tests__/sneasel-guest.test.ts`)
- `encrypts v2 intermediate payload` — `version===2`, intermediateAddr present, coldAddr absent.
- `refuses to encrypt if intermediate == sweepDelegate`.
- `refuses to encrypt if intermediate == coldAddr`.
- `two guests of same parent encrypt to different ciphertexts with different identities`.

### 5.3 DO integration tests (new: `src/server/agents/__tests__/sneasel-watcher.test.ts`)
- `tick() with two ready sweeps for distinct guests produces two batches, not one` — headline regression.
- `tick() with two ready sweeps for the SAME guest produces one batch` — intra-guest batching OK.
- `tick() rejects v1 sealed payload with clear error`.
- `tick() applies per-batch random jitter in the 30s-30min window`.

### 5.4 E2E smoke (manual mainnet)
1. Bind `amazon.brando.whelm.eth` w/ intermediate A.
2. Bind `venmo.brando.whelm.eth` w/ intermediate B.
3. Fund each hot with 0.001 ETH.
4. Wait ~35 min.
5. Confirm Etherscan: hot_amazon→A (one tx), hot_venmo→B (different block).
6. Manual Arkham/Chainalysis cluster check.

---

## 6. Optional Move add-on (follow-up, "Sneasel Slash")

`entry fun rotate_sweep_delegate(roster, parent_hash, label, new_delegate, new_sealed_cold_dest, clock, ctx)` near roster.move L1117. Lets parents migrate live guests without revoke/rebind. Requires Move package upgrade. Defer.

---

## 7. Known remaining holes after Ice Fang

1. **Ultron = traffic analyzer.** DO storage/memory sees `hot→intermediate` (and layer-2 coldAddr if delegated). T3 subpoena recovers graph. Weavile view-key model fixes.
2. **Gas-payer clustering.** Shared paymaster/gas wallet re-clusters. Needs 4337 w/ per-guest session tickets (Assurance).
3. **Long-tail timing/dust correlation.** 30min jitter beats blocks, not weeks.
4. **Intermediate first-fund dust** — fresh dWallet's first outbound can leak funding origin.
5. **Cross-chain scope.** ETH only (for Ice Fang itself). BTC/SOL/Sui equivalents come with Weavile multi-chain work (#198).

Track in `project_sneasel_arc.md` after Ice Fang lands.

---

## 8. Shipping order

1. Audit current scaffolding matches this doc.
2. Land §4.1 client changes (v2 payload + intermediate minting) — **no UI**.
3. Land §4.2 DO changes (per-guest batching, jitter, v1-reject).
4. Add tests §5.2, §5.3.
5. Manual E2E §5.4.
6. Flip threat-model checkbox Ice Fang → ☑.
7. UI copy update (separate move).
