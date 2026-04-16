# CF Edge Enrichment for SUIAMI — Design

**Date:** 2026-04-16
**Status:** Approved, ready for implementation plan
**Related:** docs/suiami-identity.mdx (Cloudflare Integration section)

## Goal

Attach Cloudflare edge metadata to every SUIAMI squid-blob-bearing write, stored as a user-owned history only the wallet itself can decrypt today (and delegated agents can decrypt tomorrow). Pure data-collection for v1 — no consumer gates on this data yet.

## Fields captured

Nine fields per attestation, worker-sourced, HMAC-signed:

| Field | Source | Notes |
|---|---|---|
| `country` | `cf-ipcountry` | 2-letter code |
| `asn` | `request.cf.asn` | integer |
| `threatScore` | `request.cf.threatScore` | 0-100, noisy on free tier |
| `ipHash` | SHA-256(salt ‖ IP) | worker-held salt, not rotated in v1 |
| `colo` | `request.cf.colo` | CF datacenter (e.g. "SJC") |
| `verifiedBot` | `request.cf.verifiedBot` | boolean |
| `tlsVersion` | `request.cf.tlsVersion` | e.g. "TLSv1.3" |
| `httpProtocol` | `request.cf.httpProtocol` | e.g. "HTTP/3" |
| `attestedAt` | server `Date.now()` | ms timestamp |

## Storage: per-chunk Seal-sealed Walrus (personal policy)

Each attestation is a single Walrus blob, Seal-encrypted under a new personal policy. Chosen over a rolling DO ring buffer or shared mutual-decrypt blob because it's IKA-native, zero-custody, and matches the encrypt.sui/alpha privacy brief from day one.

### Move contract changes

Two new functions on `contracts/suiami/sources/seal_roster.move` and `roster.move`:

```move
// seal_roster.move — new personal policy
entry fun seal_approve_cf_history(
  id: vector<u8>,
  record: &IdentityRecord,
  ctx: &TxContext,
) {
  assert!(tx_context::sender(ctx) == record.sui_address, ENotOwner);
  assert!(vector::length(&record.cf_history) > 0, ENoHistory);
  // Seal prefix check (id starts with record address bytes) as in existing policy
}

// roster.move — extend IdentityRecord + append entry
struct IdentityRecord has store {
  // ...existing fields
  cf_history: vector<String>, // Walrus blob IDs, append-only
}

public entry fun append_cf_history(
  record: &mut IdentityRecord,
  blob_id: String,
  ctx: &TxContext,
) {
  assert!(tx_context::sender(ctx) == record.sui_address, ENotOwner);
  vector::push_back(&mut record.cf_history, blob_id);
}
```

Existing records migrate with an empty vector — no data migration needed.

### Walrus chunk payload (before Seal encryption)

```
{
  "schema": 1,
  "data": {country, asn, threatScore, ipHash, colo,
           verifiedBot, tlsVersion, httpProtocol, attestedAt},
  "sig":  "<worker-HMAC-SHA256 over canonical(data)>"
}
```

HMAC is for tamper-evidence against a client that might swap values. Future consumers can verify the worker signed these values came from our edge.

## Write path

1. Client is about to build `request-suiami` or `buildFullSuiamiWriteTx`.
2. Client fetches `GET /api/cf-context` → `{data, sig}` from worker.
3. **Change detection:** if the user has prior chunks, decrypt only the tail chunk. Compare all fields except `attestedAt` — if identical, **skip the CF write entirely** (honors the "CF context rarely changes" reality; typical user ends up with 1-3 lifetime chunks).
4. Otherwise: Seal-encrypt the chunk under `seal_approve_cf_history`, upload to Walrus, call `append_cf_history(record, new_blob_id)` in the same PTB as the existing roster write. One signature covers both.

## Read path

V1: client-only, via a new `cfHistory()` console helper that decrypts all chunks and prints a sparse timeline. No server-side consumer yet. Future consumers (Chronicom, Sibyl) will need a delegate policy — see Extensions.

## Security & privacy

- Personal policy (`seal_approve_cf_history`) — only the wallet's own `sui_address` can decrypt. Not mutual-decrypt like the squid blob.
- Worker HMAC is tamper-evidence, not secrecy. Data is user-known; the goal is to let future consumers verify provenance.
- `ipHash` uses a fixed worker-held salt in v1. Rotation is deferred — rotating the salt invalidates comparability across chunks.
- No PII leaves the worker unencrypted to third parties. CF fields stay entirely inside Seal+Walrus.

## Rollout

1. Contract upgrade — adds one field + two entries. Policy is compatible upgrade (no breaking changes).
2. Worker — new `src/server/cf-context.ts`, wired into `src/server/index.ts` router at `/api/cf-context`. `CF_HMAC_SECRET` + `CF_IP_SALT` env vars.
3. Client — new `src/client/cf-history.ts`, called from `src/ski.ts` (`request-suiami` handler) and wrapped into `src/suins.ts` `buildFullSuiamiWriteTx`.
4. Tests — HMAC roundtrip unit test; manual test that change-detection skips a no-change write.
5. Deploy via `bun run build && npx wrangler deploy`.

## Out of scope for v1

- Delegated-agent decrypt policy — deferred until the first consumer actually needs it.
- Salt rotation.
- Aggregate analytics / cohort stats.
- UI surfaces beyond the console helper.
- ZK range/set proofs.

---

## Extensions — interesting directions

These are not in v1 scope but worth tracking. Several lean heavily on the Cloudflare Developer Platform, which is the natural second wind for this feature once the on-chain substrate exists.

### 1. Merkle chain-of-custody across chunks

Each new chunk includes `prev_hash: sha256(prev_chunk_bytes)`. History becomes tamper-evident against *us* too — if the worker ever rewrote a chunk, the next chunk's hash wouldn't match the chain tip. Cost: 32 bytes per chunk. Pairs naturally with a user-signature field below.

### 2. Dual signatures (worker HMAC + user Sui sig)

Chunk carries both the edge HMAC and a user-side signature over the same canonicalized bytes. Proves both "this came from our edge at time T" AND "the wallet was in control at time T". Closes the gap where a stolen session cookie could mint a bogus chunk.

### 3. Delegated-decrypt policy for agents

Parallel Move function `seal_approve_cf_delegate(id, record, agent_cap, ctx)` that authorizes decrypt when the caller holds an `AgentDelegationCap` the user minted. Unlocks Chronicom/Sibyl reads without weakening the personal policy for everyone else. Natural consumer-activation story.

### 4. ZK range / set proofs (Thunderbun fit)

Prove "country ∈ allowed_set" or "asn is in residential list" without revealing the raw value. Groth16 on Sui is already a Thunderbun primitive. Unlocks compliance gating (OFAC check, regional eligibility) with zero PII leakage.

### 5. Cloudflare Analytics Engine — anonymized aggregates

Write **only hashed cohort bins** (e.g. `country_bin`, `asn_residential_bool`, `colo`) to CF Analytics Engine on every attestation. $0.25/M writes, 90-day retention, no per-user fingerprinting. Chronicom reads aggregates for "% of SUIAMI members on residential ASNs" etc. without decrypting anyone. Perfect for public stats pages without touching per-user storage. Would live at `docs/suiami-identity.mdx`-rendered endpoint.

### 6. Cloudflare Vectorize — cohort discovery

Embed each CF fingerprint as a vector (nine normalized fields → 16-dim vector), store in Vectorize with the wallet address as metadata. Client can query "who has a similar fingerprint to me?" with LSH buckets. Privacy: only members who've opted in get indexed; decryption still requires the personal Seal policy. Enables encrypt.sui/superteam.sui crowd-matching ("people with your CF signature tend to be on Brave + TLSv1.3").

### 7. Cloudflare Workers AI — bot-pattern classifier at edge

Run a small classifier (e.g. `@cf/huggingface/distilbert-sst-2` or a custom LoRA) over the CF fingerprint + User-Agent to output `{is_automated: bool, confidence: float}` server-side, signed by the worker, bundled into the chunk. Better signal than raw `threatScore`, stays private via the personal policy. Unlocks a high-quality Chronicom input without us writing heuristics.

### 8. Cloudflare Turnstile — invisible challenge on high-value writes

For squid-blob writes the user considers sensitive (mint, upgrade, cross-crowd Rumble), issue a Turnstile challenge from the cf-context endpoint. Pass/fail bit lands in the chunk as `turnstile: "pass" | "fail" | "skipped"`. Differentiates human-in-the-loop writes from scripted ones without user friction.

### 9. Cloudflare KV — cached signed context

Cache `{data, sig}` in CF KV keyed by `ipHash` with 60s TTL. Cuts HMAC-compute and CF-request-object reads by ~99% under hot traffic. Writes to KV from the worker; reads are sub-ms at edge. Irrelevant at our volume today, free speedup at scale.

### 10. Cloudflare Workers Logpush — compliance archive to R2

Stream the CF-context envelopes (data-only, never plaintext SUIAMI content) to R2 via Workers Logpush. 10-year retention for audit/compliance at R2 pricing. Useful if iUSD or any regulated crowd ever needs "we have edge attestations for every identity write."

### 11. Cloudflare Browser Rendering — audit snapshots

On high-value writes (agent provisioning, large cross-chain routing), Browser Rendering captures a timestamped screenshot of the user's confirmation UI. Seal-encrypted under personal policy, blob-id bundled into the CF chunk. Gives a user-private audit trail a lawyer would recognize.

### 12. D1 — public aggregate dashboard

A D1 database fed by Analytics Engine rollups, powering a public `sui.ski/stats` page: "SUIAMI: 1,248 verified identities across 43 countries, 89% residential ASNs, 67% Brave/Chrome, median TLS 1.3." Zero per-user data, all derived from anonymized bins. Marketing surface that proves the decentralized identity graph is real and growing.

---

## Decision log

- **Option B (per-chunk Seal-sealed Walrus) chosen by 4/5-agent vote** over ring buffer (A), rolling blob rewrite (C), IndexedDB-local (D), hot+cold hybrid (E). Rationale: IKA-native, zero-custody, clean forward path to delegated-decrypt without migrating storage.
- **Change-detection client-side** added to the write path after user flagged CF context rarely changes. Ensures the chunk count stays in the 1-3 range for typical users.
- **No consumer gates on CF data in v1.** Matches earlier decision to ship enrichment as pure data-collection.
- **Worker HMAC, not server-side Seal.** Seal is the user's encryption; worker signature is provenance. Keeping them orthogonal lets the user rotate Seal sessions without invalidating past HMAC-signed data.
