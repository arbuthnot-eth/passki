# Thunder Privacy — Next Two Chunks

Date: 2026-04-11
Branch: `feat/thunder-messaging-stack` (base)
Status: spec — ready to start

## Context

The current Thunder messaging stack gives you free, Seal-encrypted text between two SuiNS identities, with on-chain `thunder_iou::Iou` shared-object escrows for `$amount` transfers. Two privacy gaps remain:

1. **No forward secrecy.** All messages in a storm are encrypted with a single DEK managed by the Seal key servers. Anyone ever added to the group can decrypt every past message. If a member is compromised, their entire history leaks. The Sui Stack Messaging SDK exposes `rotateEncryptionKey` but we've never called it.

2. **Transfer metadata is public.** `thunder_iou::create` emits an event with sender, recipient, amount, and expiry in plaintext. Anyone scanning Sui can see "Alice sent $37.50 to Bob on date X". The encrypted note wrapper around the transfer is private to storm members, but the underlying on-chain tx is not.

Both are fixable. This spec scopes two focused chunks: one per gap.

---

## Chunk A — Alakazam Lv. 36: forward secrecy via DEK rotation

**Pokemon:** Alakazam (TM25 learner in Gen 1) — psychic, "managed knowledge". Level 36 because that's the `rotateEncryptionKey` event we're chasing.

### Goal

Every time storm membership changes (add member, remove member, leave), rotate the group's DEK so messages encrypted under the old key cannot be decrypted by anyone added later, and messages encrypted under the new key cannot be decrypted by anyone removed before the rotation.

### Scope

In:
- Wire `client.messaging.tx.rotateEncryptionKey` into the client flow, invoked automatically on member-change operations.
- Invoke on `removeMembersAndRotateKey` paths specifically so leavers can't decrypt subsequent traffic.
- Track the `encryptionHistoryId` alongside the `groupId` in the client so `getMessages` can still decrypt pre-rotation history (the SDK already supports historical key lookup via `EncryptionHistoryRef`).
- Event listener in the WebSocket subscribe path for `rotated` events, so the other side refetches with the new key version.
- Update `sendThunder` and `getThunders` so they always pass the current key version after a rotation and the SDK walks back through history for old versions.

Out:
- Multi-member groups larger than 2 (current UI is strict 1:1).
- Automatic rotation on a time-based schedule (only on explicit member change).
- Full message re-encryption (existing ciphertexts stay on the DO under their original key version — the rotation only affects *new* messages).

### Architecture

```
member-change op
  ├── build PTB with rotateEncryptionKey or removeMembersAndRotateKey
  │    - generates a fresh DEK (EncryptionHistoryRef increments)
  │    - emits EncryptionKeyRotated on-chain
  ├── sign + execute
  ├── client caches the new encryptionHistoryId locally (ski:thunder-keyver:<gid>)
  ├── broadcast { kind: 'rotated', keyVersion } over WS to connected clients
  └── next sendThunder uses the new key version for encryption
```

`getThunders` doesn't need logic changes — the SDK's `EncryptionHistoryRef` already handles decryption of messages at historical key versions as long as the caller has been a member continuously. Leavers lose access to new messages because they're not granted the rotated DEK by the Seal policy.

### Failure modes

- **Rotation tx fails mid-flight** — old key is still live. Client should retry once; if second attempt fails, show a toast and leave the group unchanged. No half-rotated state.
- **WS broadcast lost** — the other side's next fetch discovers the new key version via GraphQL, so the WS event is belt-and-braces.
- **Rotated-key re-send race** — sender rotates, sends message A under new key; recipient still reading with old key. `getMessages` walks historical key versions automatically, so this resolves on next fetch.
- **Seal policy caches** — Seal session keys are package-scoped, not group-scoped. Rotating doesn't invalidate the session. Cached Seal permission lookups may need a TTL bump.

### Definition of done

- [ ] `rotateStormKey({ groupRef })` helper in `src/client/thunder-stack.ts` wraps `client.messaging.tx.rotateEncryptionKey`.
- [ ] `removeMemberFromStorm({ groupRef, member })` calls `removeMembersAndRotateKey` so leavers lose forward access.
- [ ] `TimestreamAgent.onConnect` and the WS `rotated` event both propagate key version to clients.
- [ ] `ski:thunder-keyver:<gid>` localStorage entry tracks the latest known key version per storm.
- [ ] After a rotation, a previous member who tries to fetch gets `ENotPermitted` from Seal and the decrypt path renders `🔒 [no access]` instead of garbage. (We already have that fallback — verify it still fires.)
- [ ] New thunders after rotation are undecryptable for any address removed before the rotation. Test with two browser profiles.
- [ ] No regression in the 1:1 same-pair flow: sender + recipient still read each other's messages with zero manual action after a self-add of the recipient.

### Test plan

1. Two-browser test: A and B in a storm. A sends, B reads. Add C via a throwaway call to `removeMembersAndRotateKey` fake (or just rotate with same members). C was never in the group; verify C's `getMessages` gets denied for new messages but can decrypt old ones it was never part of (i.e. nothing, because C was never there).
2. A removes B. A sends a new message. B's fetch should return the old messages but none after the rotation. Renders as "🔒 [no access]" for anything post-rotation that the Seal servers reject.
3. Round-trip: A rotates, A sends, B fetches — B's SDK walks the history and decrypts the new message under the new key version.
4. Drop the WS connection during rotation, reconnect, verify the keyVersion state syncs.

### Commit plan

Branch: `feat/thunder-forward-secrecy`

```
c1  feat(contracts): no-op — verify messaging::rotate_encryption_key already exposed
c2  feat(client): rotateStormKey helper + encryptionHistoryId cache
c3  feat(client): removeMember wrapper via removeMembersAndRotateKey
c4  feat(ws): broadcast { kind: 'rotated' } on state change
c5  feat(ui): wire rotation to leave-group action (hidden behind future member UI)
c6  test: two-browser manual test checklist + screen captures committed to docs/
```

---

## Chunk B — Mr. Mime Lv. 42: shielded transfers

**Pokemon:** Mr. Mime (TM25 learner) — "the Barrier Pokemon", invisible walls. Level 42 because the answer to hiding everything.

### Goal

Make the on-chain record of a `$amount` transfer reveal *only* that a transfer happened in a storm — not who, not how much. The Seal-encrypted storm note stays the source of truth for amount + participants; the chain stores a blinded commitment.

### Scope

In:
- New `thunder_iou::shielded` Move module with a single shared `ShieldedPool<SUI>` object.
- Sender deposits SUI into the pool along with a Pedersen commitment `C = r·G + amount·H` and an encrypted recipient-key blob (encrypted with the recipient's address-derived pubkey).
- Recipient claims by proving knowledge of the opening `(r, amount)` under a Schnorr-like verifier and collecting `amount` from the pool.
- Sender recall after TTL: anyone can call `shielded::recall(commitment, blinding, sender_signature, clock)` — reveals nothing new vs. the current IOU design.
- Client builds: Pedersen commit off-chain via `@noble/curves`, stores opening in the encrypted storm note, sends PTB.
- Claim flow: client recovers `(r, amount)` from the decrypted note, builds the Schnorr proof, signs tx.

Out:
- Full zk-SNARK (Groth16) — Pedersen + Schnorr is the MVP, zk comes later if needed.
- Anonymous set across storms — each storm has its own pool or shares the global pool but commitments are per-storm.
- Hiding sender identity from the on-chain tx (sender is the PTB signer, can't hide without relayer).

### Architecture

```
sender composing @justy$1
  ├── compose draft.amount = 1 USDC (say)
  ├── client generates r (32 random bytes)
  ├── commitment C = r·G + 1_000_000·H   (u64 → scalar)
  ├── encrypt { r, amount } in the storm note via Seal
  ├── PTB:
  │    splitCoins gas → suiIn
  │    swap suiIn → 1 USDC via DeepBook (existing path)
  │    shielded::deposit(pool, usdc_coin, commitment, recipient_addr, ttl_ms, clock)
  ├── sign + execute
  └── encrypted storm note includes { commitment_hex, opening_ciphertext }

recipient claiming
  ├── decrypt storm note → recover r, amount
  ├── verify C on-chain matches
  ├── build Schnorr proof of opening: (z_r, z_amount)
  ├── shielded::claim(pool, commitment, z_r, z_amount, clock)
  └── pool::withdraw transfers the coin

keeper recall
  ├── sender's client or a keeper bot: shielded::recall(commitment, sender_sig)
  ├── only valid after TTL
  └── returns coin to committed sender address (stored alongside commitment)
```

### What the on-chain observer sees

| Field | Before (current Iou) | After (shielded) |
|---|---|---|
| Sender | ✅ visible | ✅ visible (tx signer) |
| Recipient | ✅ visible | ❌ hidden (recipient extracted from decrypted note) |
| Amount | ✅ visible | ❌ hidden (Pedersen commitment, computationally hiding) |
| TTL | ✅ visible | ✅ visible |
| Storm existence | ✅ visible | ✅ visible |

Recipient and amount become unlinkable to any specific on-chain event for anyone outside the storm.

### Failure modes

- **Commitment collision** — 32-byte randomness, negligible. Still check on deposit.
- **Binding failure** — Pedersen is computationally binding under DLP hardness; standard assumption.
- **Replay** — each commitment is a unique on-chain object. Cannot be replayed.
- **Recipient loses the opening** — their encrypted note in the storm is gone. Fall back to sender recall after TTL.
- **Leaked opening** — whoever has `(r, amount)` can claim. Same as losing your private key. Don't leak the note.

### Definition of done

- [ ] `contracts/thunder-iou-shielded/` package with `shielded::deposit`, `shielded::claim`, `shielded::recall` entry functions.
- [ ] Pedersen commit helper in `src/client/thunder-iou-shielded.ts` using `@noble/curves` secp256k1 points.
- [ ] Schnorr proof helper (not a SNARK — just a 2-value NIZK on commitment opening).
- [ ] `sendThunder` branches: hasTransfer → call shielded::deposit instead of thunder_iou::create, embed `{commitment, openingCipher}` in storm note.
- [ ] UI transfer bubble click: if the note carries a commitment, route to shielded claim PTB; otherwise fall back to existing `thunder_iou::claim`.
- [ ] Sweeper updated to scan both pools (`thunder_iou::Iou` and `shielded::Deposit`).
- [ ] E2E test: two browsers, send shielded $1, receive, claim, observe that a third browser inspecting the tx on Suivision cannot determine the amount or recipient.

### Test plan

1. Deposit 1 USDC shielded. Open Suivision, confirm tx shows only `shielded::deposit(<pool>, <coin>, <32-byte commitment>)` — no amount, no recipient address visible.
2. Recipient claims. Verify their wallet receives 1 USDC. Observe the claim tx on Suivision — amount is implicit from coin transfer but not linked to the original deposit's storm.
3. Recall: sender recalls after TTL. Balance returns to sender.
4. Malicious claim: third party with no opening tries to call `shielded::claim` with fake proof — must abort.
5. Commit-amount mismatch: sender commits to 2 USDC but only deposits 1 USDC — must abort on deposit.

### Commit plan

Branch: `feat/thunder-shielded-transfers`

```
c1  feat(contracts): thunder-iou-shielded package — Pedersen + Schnorr + pool
c2  test(contracts): move unit tests for deposit/claim/recall edge cases
c3  feat(deploy): publish shielded package, update Published.toml
c4  feat(client): @noble/curves Pedersen helper + Schnorr prove/verify
c5  feat(client): sendThunder integration, storm note commitment embed
c6  feat(ui): transfer bubble click routing (shielded vs legacy)
c7  feat(sweeper): scan + recall expired shielded deposits
c8  docs(spec): update with Suivision screenshots showing the hidden fields
```

---

## Execution notes

### Order of work

Both chunks are independent — they touch different parts of the stack and don't share state. Alakazam is entirely client-side (SDK is already deployed); Mr. Mime needs a new Move package.

**Recommended order if one person:** Alakazam first (smaller, faster feedback loop, no new contracts). Mr. Mime second (cryptography + deploy cycle).

**Recommended if parallel:** assign whoever has the Move context to Mr. Mime and whoever has the TypeScript context to Alakazam. They don't collide.

### Git hygiene

One issue per chunk. One branch per chunk off `feat/thunder-messaging-stack`. Commits tagged with the chunk name in the subject line so `git log --grep=Alakazam` / `--grep=Mr\.Mime` filter cleanly. PRs target `feat/thunder-messaging-stack` (not main), so the parent PR #72 picks them both up at final merge.

### Docs-as-you-go

Each commit updates this spec with a `// DONE: ...` annotation inside the relevant section, so reading the spec at any point tells you what's shipped and what's open without needing to cross-reference issues. When a chunk is complete, add a short "Shipped" subsection with the final commit/PR/branch link and any deviations from the original plan.
