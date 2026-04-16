# CF Edge Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Cloudflare edge metadata on every SUIAMI squid-blob-bearing write, store as a Seal-sealed Walrus chunk under a personal-decrypt policy, with client-side change detection so typical users produce 1–3 lifetime chunks.

**Architecture:** Move contract gets one field (`cf_history: vector<String>`) and two entries (`append_cf_history`, `seal_approve_cf_history`). Worker exposes `/api/cf-context` returning HMAC-signed CF fields. Client fingerprints → compares against tail chunk → Seal-encrypts → uploads to Walrus → appends blob ID in the same PTB as the existing roster write.

**Tech Stack:** Move (Sui), Cloudflare Workers, `@mysten/sui` v2, `@mysten/seal`, `@mysten/walrus`, Bun, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-16-cf-edge-enrichment-design.md`

---

### Task 1: Extend IdentityRecord struct with cf_history field

**Files:**
- Modify: `contracts/suiami/sources/roster.move:49-69` (struct definition) + add getter

- [ ] **Step 1: Add `cf_history: vector<String>` to IdentityRecord struct**

In `contracts/suiami/sources/roster.move`, locate `public struct IdentityRecord has store, drop, copy { ... }` and add the field after `verified: bool`:

```move
public struct IdentityRecord has store, drop, copy {
    name: String,
    sui_address: address,
    chains: VecMap<String, String>,
    dwallet_caps: vector<address>,
    walrus_blob_id: String,
    seal_nonce: vector<u8>,
    verified: bool,
    cf_history: vector<String>,  // NEW: oldest-first Walrus blob IDs
    updated_ms: u64,
}
```

- [ ] **Step 2: Initialize `cf_history` in `set_identity`**

Find the `set_identity` entry fun body and the record-construction site. When the record is created, initialize the new field to an empty vector:

```move
cf_history: vector::empty<String>(),
```

If `set_identity` mutates an existing record rather than constructing a new one, ensure the empty-vector default is preserved for new records only. Do NOT touch existing records' `cf_history` in this entry.

- [ ] **Step 3: Add the getter after `record_verified`**

Below line ~206 in `roster.move`:

```move
public fun record_cf_history(record: &IdentityRecord): &vector<String> { &record.cf_history }
```

- [ ] **Step 4: Build the contract**

Run: `cd contracts/suiami && sui move build 2>&1 | tail -20`
Expected: `BUILDING suiami` with no errors. If existing callers fail to pattern-match the struct, update them to include `cf_history: vector::empty()` in the same PTB.

- [ ] **Step 5: Commit**

```bash
git add contracts/suiami/sources/roster.move
git commit -m "suiami: add cf_history field to IdentityRecord"
```

---

### Task 2: Add append_cf_history entry function

**Files:**
- Modify: `contracts/suiami/sources/roster.move` (add entry fun)

- [ ] **Step 1: Append the entry function at the end of `roster.move`**

```move
/// Append a Walrus blob ID to the caller's CF history. Only the record
/// owner (sui_address) can call. No size cap — client-side change
/// detection keeps typical users at 1-3 lifetime entries.
public entry fun append_cf_history(
    roster: &mut Roster,
    blob_id: String,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = tx_context::sender(ctx);
    assert!(has_address(roster, sender), ENotOwner);
    let record = table::borrow_mut(&mut roster.by_address, sender);
    vector::push_back(&mut record.cf_history, blob_id);
    record.updated_ms = clock::timestamp_ms(clock);
}
```

Note: confirm the actual table lookup method matches existing code in `roster.move`. If `lookup_by_address` is public and takes `&Roster`, introduce a mirror `lookup_by_address_mut` or adapt the call. Read `roster.move:168-193` first to match the pattern.

- [ ] **Step 2: Build the contract**

Run: `cd contracts/suiami && sui move build 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add contracts/suiami/sources/roster.move
git commit -m "suiami: append_cf_history entry"
```

---

### Task 3: Add seal_approve_cf_history policy

**Files:**
- Modify: `contracts/suiami/sources/seal_roster.move` (add entry fun)

- [ ] **Step 1: Read the existing `seal_approve_roster_reader` pattern**

Run: `cat contracts/suiami/sources/seal_roster.move`
Note the exact id-prefix check, the `ENotAuthorized` constant, and how `assert!(record_walrus_blob_id(record).length() > 0, ENoEncryptedData)` is expressed.

- [ ] **Step 2: Append the new policy entry at end of `seal_roster.move`**

```move
/// Personal CF-history decrypt policy. Authorizes iff the caller is the
/// record owner AND the record has at least one cf_history entry.
/// Id prefix check mirrors seal_approve_roster_reader.
entry fun seal_approve_cf_history(
    id: vector<u8>,
    roster: &Roster,
    ctx: &TxContext,
) {
    let sender = tx_context::sender(ctx);
    assert!(suiami::roster::has_address(roster, sender), ENotAuthorized);
    let record = suiami::roster::lookup_by_address(roster, sender);
    assert!(vector::length(suiami::roster::record_cf_history(record)) > 0, ENoEncryptedData);
    // Id must begin with the record's sui_address bytes (Seal identity prefix).
    let addr_bytes = sui::address::to_bytes(suiami::roster::record_sui_address(record));
    let id_len = vector::length(&id);
    let prefix_len = vector::length(&addr_bytes);
    assert!(id_len >= prefix_len, ENotAuthorized);
    let mut i = 0u64;
    while (i < prefix_len) {
        assert!(*vector::borrow(&id, i) == *vector::borrow(&addr_bytes, i), ENotAuthorized);
        i = i + 1;
    };
}
```

If `ENotAuthorized` or `ENoEncryptedData` aren't already defined, reuse the existing constants verified in Step 1 — do NOT duplicate.

- [ ] **Step 3: Build**

Run: `cd contracts/suiami && sui move build 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add contracts/suiami/sources/seal_roster.move
git commit -m "suiami: seal_approve_cf_history personal policy"
```

---

### Task 4: Publish contract upgrade

**Files:**
- None (uses existing UpgradeCap tracked in memory under `project_iusd_upgrade_cap.md` or suiami equivalent)

- [ ] **Step 1: Locate suiami UpgradeCap**

Run: `sui client objects --json 2>/dev/null | jq -r '.[] | select(.data.type | test("UpgradeCap")) | .data.objectId + " " + (.data.type // "")' 2>&1 | head -20`
Pick the UpgradeCap whose type references the suiami package. If unclear, check `~/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/` for an existing suiami upgrade-cap memory.

- [ ] **Step 2: Run the upgrade**

Run: `cd contracts/suiami && sui client upgrade --upgrade-capability <CAP_ID> --gas-budget 200000000 2>&1 | tail -30`
Expected: `Status: Success` and a new package ID in the output. Record the NEW package ID.

- [ ] **Step 3: Update client config with new package ID**

Find where the suiami package ID is referenced in client code:
Run: `grep -rn "suiami::roster\|SUIAMI_PACKAGE" src/ 2>&1 | head -10`
Update each reference (or the central constant) to the new package ID.

- [ ] **Step 4: Build + sanity-check**

Run: `bun run build 2>&1 | tail -5`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "suiami: publish cf_history upgrade, wire client to new package id"
```

---

### Task 5: Worker endpoint `/api/cf-context`

**Files:**
- Create: `src/server/cf-context.ts`
- Modify: `src/server/index.ts` (add route)
- Modify: `wrangler.toml` (env var placeholders)

- [ ] **Step 1: Add env vars to wrangler.toml**

In `wrangler.toml`, under `[vars]` (or the appropriate section for non-secret vars), add:

```toml
# CF_HMAC_SECRET and CF_IP_SALT are injected via `wrangler secret put`.
# Do NOT commit secret values. These placeholders document the dependency.
```

Then run the secret puts (prompt for user to paste values):

```bash
echo "Set CF_HMAC_SECRET (32+ random chars):" && npx wrangler secret put CF_HMAC_SECRET
echo "Set CF_IP_SALT (32+ random chars):" && npx wrangler secret put CF_IP_SALT
```

- [ ] **Step 2: Create `src/server/cf-context.ts`**

```typescript
// CF edge context endpoint for SUIAMI CF-history enrichment.
// Returns HMAC-signed CF metadata the client encrypts + uploads to Walrus.

export interface CfFields {
  country: string;
  asn: number;
  threatScore: number;
  ipHash: string;       // hex, SHA-256(salt ‖ ip)
  colo: string;
  verifiedBot: boolean;
  tlsVersion: string;
  httpProtocol: string;
  attestedAt: number;   // ms epoch
}

export interface CfContextResponse {
  data: CfFields;
  sig: string;          // hex HMAC-SHA256 over canonical JSON of data
}

/** Canonical JSON — sorted keys, no whitespace. Stable across clients. */
function canonicalize(data: CfFields): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(data).sort()) sorted[k] = (data as unknown as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleCfContext(req: Request, env: { CF_HMAC_SECRET?: string; CF_IP_SALT?: string }): Promise<Response> {
  if (!env.CF_HMAC_SECRET || !env.CF_IP_SALT) {
    return new Response(JSON.stringify({ error: 'cf-context not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const data: CfFields = {
    country: String(req.headers.get('cf-ipcountry') ?? cf.country ?? 'XX'),
    asn: Number(cf.asn ?? 0),
    threatScore: Number(cf.threatScore ?? 0),
    ipHash: ip ? await sha256Hex(env.CF_IP_SALT + '\x1f' + ip) : '',
    colo: String(cf.colo ?? ''),
    verifiedBot: Boolean(cf.verifiedBot ?? false),
    tlsVersion: String(cf.tlsVersion ?? ''),
    httpProtocol: String(cf.httpProtocol ?? ''),
    attestedAt: Date.now(),
  };
  const sig = await hmac(env.CF_HMAC_SECRET, canonicalize(data));
  return new Response(JSON.stringify({ data, sig }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
```

- [ ] **Step 3: Wire the route in `src/server/index.ts`**

Find the existing URL-pathname routing block (around line 248, `url.pathname` comparisons). Add a branch:

```typescript
if (url.pathname === '/api/cf-context') {
  const { handleCfContext } = await import('./cf-context');
  return handleCfContext(request, env as { CF_HMAC_SECRET?: string; CF_IP_SALT?: string });
}
```

Place it alongside the other `/api/` routes.

- [ ] **Step 4: Build + deploy**

Run: `bun run build && npx wrangler deploy 2>&1 | tail -10`
Expected: deploy success, new Version ID printed.

- [ ] **Step 5: Smoke-test**

Run: `curl -s https://sui.ski/api/cf-context | jq .`
Expected: JSON with `data.country`, `data.colo`, `data.asn` populated, `sig` is 64 hex chars.

- [ ] **Step 6: Commit**

```bash
git add src/server/cf-context.ts src/server/index.ts wrangler.toml
git commit -m "worker: /api/cf-context HMAC-signed CF edge metadata"
```

---

### Task 6: Client `src/client/cf-history.ts`

**Files:**
- Create: `src/client/cf-history.ts`

- [ ] **Step 1: Write the module**

```typescript
// CF edge enrichment client — fetches signed CF metadata from the worker,
// change-detects against the tail chunk, Seal-encrypts, uploads to Walrus,
// and returns the new blob ID for inclusion in a roster write PTB.

import type { Transaction } from '@mysten/sui/transactions';

export interface CfFields {
  country: string;
  asn: number;
  threatScore: number;
  ipHash: string;
  colo: string;
  verifiedBot: boolean;
  tlsVersion: string;
  httpProtocol: string;
  attestedAt: number;
}
export interface CfEnvelope { data: CfFields; sig: string }
export interface CfChunk { schema: 1; data: CfFields; sig: string }

const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

/** Fields compared for change detection (everything except attestedAt). */
const CHANGE_KEYS: Array<keyof CfFields> = [
  'country', 'asn', 'threatScore', 'ipHash', 'colo',
  'verifiedBot', 'tlsVersion', 'httpProtocol',
];

function fingerprintsMatch(a: CfFields, b: CfFields): boolean {
  return CHANGE_KEYS.every(k => a[k] === b[k]);
}

export async function fetchCfContext(): Promise<CfEnvelope | null> {
  try {
    const res = await fetch('/api/cf-context');
    if (!res.ok) return null;
    return await res.json() as CfEnvelope;
  } catch { return null; }
}

/** Decrypt the tail chunk to compare fingerprints. Returns null on any failure. */
async function decryptTailChunk(tailBlobId: string): Promise<CfFields | null> {
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${tailBlobId}`);
    if (!res.ok) return null;
    const encrypted = new Uint8Array(await res.arrayBuffer());
    const { decryptCfChunkBytes } = await import('./cf-history-seal');
    const chunk = await decryptCfChunkBytes(encrypted);
    return chunk?.data ?? null;
  } catch { return null; }
}

/**
 * Decide whether to write a new CF chunk, and if so return the Walrus blob
 * ID of the freshly uploaded+encrypted chunk. Callers then pass this ID to
 * `append_cf_history` in the same PTB as their existing roster write.
 *
 * @param ownerAddress user's Sui address (sender of the enclosing PTB)
 * @param tailBlobId   most recent entry in `cf_history`, or empty string
 */
export async function maybeBuildCfChunk(
  ownerAddress: string,
  tailBlobId: string,
): Promise<string | null> {
  const env = await fetchCfContext();
  if (!env) return null;
  if (tailBlobId) {
    const prev = await decryptTailChunk(tailBlobId);
    if (prev && fingerprintsMatch(prev, env.data)) return null;
  }
  const { encryptCfChunkToWalrus } = await import('./cf-history-seal');
  const { blobId } = await encryptCfChunkToWalrus(ownerAddress, {
    schema: 1, data: env.data, sig: env.sig,
  });
  return blobId;
}

export { WALRUS_PUBLISHER, WALRUS_AGGREGATOR };
```

- [ ] **Step 2: Commit (module stub, depends on seal helper from Task 7)**

```bash
git add src/client/cf-history.ts
git commit -m "client: cf-history module (depends on cf-history-seal helper)"
```

---

### Task 7: Seal encrypt/decrypt helper `src/client/cf-history-seal.ts`

**Files:**
- Create: `src/client/cf-history-seal.ts`

- [ ] **Step 1: Read existing seal wrapper**

Run: `grep -n "sealRace\|SessionKey\|SealClient\|encrypt\|decrypt" src/client/suiami-seal.ts | head -30`
Note the `sealRace`, `SessionKey` mint/import helpers, and package ID references.

- [ ] **Step 2: Write the module**

```typescript
// CF-history Seal encryption — mirrors suiami-seal.ts but targets the
// personal `seal_approve_cf_history` policy (only the record owner can
// decrypt, not mutual-decrypt).

import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { sealRace, buildPersonalSessionKey } from './suiami-seal';
// NOTE: if buildPersonalSessionKey does not exist, use getOrMintSessionKey
//       and check the exact export from suiami-seal.ts before writing this
//       import. Same for sealRace. Update imports to match.

import type { CfChunk } from './cf-history';

const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';

/** Build the 40-byte Seal id: address bytes ‖ 8-byte random nonce. */
function buildSealId(ownerAddress: string): Uint8Array {
  const addrBytes = bcs.Address.serialize(normalizeSuiAddress(ownerAddress)).toBytes();
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const id = new Uint8Array(addrBytes.length + nonce.length);
  id.set(addrBytes, 0);
  id.set(nonce, addrBytes.length);
  return id;
}

export async function encryptCfChunkToWalrus(
  ownerAddress: string,
  chunk: CfChunk,
): Promise<{ blobId: string; sealId: Uint8Array }> {
  const sealId = buildSealId(ownerAddress);
  const plaintext = new TextEncoder().encode(JSON.stringify(chunk));
  // Seal id is already hex-prefixed by the package; pass raw bytes to encrypt.
  const { encryptedObject } = await sealRace((c) =>
    c.encrypt({
      packageId: (await import('./suiami-seal')).SUIAMI_PACKAGE_ID,
      id: sealId,
      threshold: 2,
      data: plaintext,
    }),
  );
  const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs`, {
    method: 'PUT',
    body: encryptedObject,
  });
  if (!res.ok) throw new Error(`Walrus upload failed: ${res.status}`);
  const j = await res.json();
  const blobId = j?.newlyCreated?.blobObject?.blobId ?? j?.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus: no blobId in response');
  return { blobId: blobId as string, sealId };
}

export async function decryptCfChunkBytes(encryptedObject: Uint8Array): Promise<CfChunk | null> {
  try {
    const { decryptWithPersonalPolicy } = await import('./suiami-seal');
    // Use the personal policy wrapper — it should call the Move
    // `seal_approve_cf_history` entry during dry-run. If suiami-seal.ts
    // currently only has `decryptWithRosterPolicy`, add a parallel helper
    // that swaps in `seal_approve_cf_history` as the policy function name.
    const plaintext = await decryptWithPersonalPolicy(encryptedObject);
    if (!plaintext) return null;
    return JSON.parse(new TextDecoder().decode(plaintext)) as CfChunk;
  } catch {
    return null;
  }
}
```

**CRITICAL:** Before writing this file, open `src/client/suiami-seal.ts` and confirm the exact names of the exports used (`sealRace`, `SUIAMI_PACKAGE_ID`, any session-key helpers). Swap to real names. If the file only exposes a roster-policy decrypt, add a sibling function `decryptWithPersonalPolicy(bytes)` that calls `seal_approve_cf_history` instead of `seal_approve_roster_reader`. Keep both wrappers so the existing mutual-decrypt flow is untouched.

- [ ] **Step 3: Build**

Run: `bun run build 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/client/cf-history-seal.ts src/client/suiami-seal.ts
git commit -m "client: Seal encrypt/decrypt helpers for cf-history personal policy"
```

---

### Task 8: Wire into `request-suiami` handler

**Files:**
- Modify: `src/ski.ts` (the `ski:request-suiami` event handler)

- [ ] **Step 1: Locate the handler**

Run: `grep -n "ski:request-suiami\|maybeAppendRoster" src/ski.ts | head -10`

- [ ] **Step 2: Add CF-chunk build + append call**

Inside the handler, after `maybeAppendRoster` is added to `tx` and before the pre-build/sign step:

```typescript
try {
  const { getCrossChainStatus } = await loadIka();
  const ccs = await getCrossChainStatus(ws.address);
  const tailBlobId = ''; // TODO: read from roster on-chain if we have it; empty for first write
  const { maybeBuildCfChunk } = await import('./client/cf-history');
  const cfBlobId = await maybeBuildCfChunk(ws.address, tailBlobId);
  if (cfBlobId) {
    tx.moveCall({
      target: `${SUIAMI_PACKAGE_ID}::roster::append_cf_history`,
      arguments: [
        tx.object(ROSTER_SHARED_OBJECT_ID),
        tx.pure.string(cfBlobId),
        tx.object('0x6'),
      ],
    });
  }
} catch (cfErr) {
  console.warn('[cf-history] skipped:', cfErr);
}
```

Replace `SUIAMI_PACKAGE_ID` and `ROSTER_SHARED_OBJECT_ID` with the constants already imported in this file (check the existing `maybeAppendRoster` call for their exact names).

- [ ] **Step 3: Tail-blob lookup — read roster for current `cf_history` tail**

Add a helper that reads the record via GraphQL/gRPC and extracts the last `cf_history` entry. If the file already has `readRosterByAddress`, extend that to return `cfHistory: string[]` too, then:

```typescript
const tailBlobId = ccs.cfHistoryTail ?? '';
```

If extending `readRosterByAddress` is out of scope for this task, leave `tailBlobId = ''` (first-write-only path) and file a TODO to refine after Task 10.

- [ ] **Step 4: Build + deploy + smoke-test**

```bash
bun run build && npx wrangler deploy
```

Then exercise the `ski:request-suiami` flow in the browser and confirm console shows `[cf-history]` messages and a new `append_cf_history` call in the tx effects.

- [ ] **Step 5: Commit**

```bash
git add src/ski.ts
git commit -m "ski: wire cf-history into request-suiami PTB"
```

---

### Task 9: Wire into `buildFullSuiamiWriteTx`

**Files:**
- Modify: `src/suins.ts` (the `buildFullSuiamiWriteTx` export)

- [ ] **Step 1: Extend the `opts` type**

Add to the existing `opts:` destructure/type:

```typescript
cfBlobId?: string; // optional: blob ID of a freshly-written CF chunk to append
```

- [ ] **Step 2: Append call inside the function**

After the existing `set_identity` moveCall and before `tx.build`:

```typescript
if (opts.cfBlobId) {
  tx.moveCall({
    target: `${SUIAMI_PACKAGE_ID}::roster::append_cf_history`,
    arguments: [
      tx.object(ROSTER_SHARED_OBJECT_ID),
      tx.pure.string(opts.cfBlobId),
      tx.object('0x6'),
    ],
  });
}
```

Use the same package-id constant the existing roster calls use in this file.

- [ ] **Step 3: Update callers to pass `cfBlobId`**

Find the `upgradeSuiami` callsite in `src/ski.ts` and the other caller(s):

Run: `grep -rn "buildFullSuiamiWriteTx" src/ | head -10`

Before each call, add:

```typescript
const { maybeBuildCfChunk } = await import('./client/cf-history');
const cfBlobId = (await maybeBuildCfChunk(ws.address, '')) ?? undefined;
// then in the existing opts: cfBlobId,
```

- [ ] **Step 4: Build**

Run: `bun run build 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/suins.ts src/ski.ts
git commit -m "suins: buildFullSuiamiWriteTx accepts cfBlobId; upgradeSuiami wires it"
```

---

### Task 10: `cfHistory()` console helper

**Files:**
- Modify: `src/ski.ts` (add a global helper, next to `suiamiAudit` and `who`)

- [ ] **Step 1: Add the helper near the `who` helper**

```typescript
const _cfHistory = async () => {
  try {
    const ws = getWalletState();
    if (!ws?.address) { console.error('[cfHistory] no wallet'); return; }
    const { readRosterByAddress } = await import('./suins');
    const record = await readRosterByAddress(ws.address);
    if (!record) { console.log('[cfHistory] no SUIAMI record'); return; }
    const blobIds = (record as unknown as { cf_history?: string[] }).cf_history ?? [];
    if (blobIds.length === 0) { console.log('[cfHistory] empty'); return; }
    const { WALRUS_AGGREGATOR } = await import('./client/cf-history');
    const { decryptCfChunkBytes } = await import('./client/cf-history-seal');
    for (const id of blobIds) {
      const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${id}`);
      if (!res.ok) { console.log('[cfHistory]', id, 'walrus fetch failed'); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const chunk = await decryptCfChunkBytes(bytes);
      if (!chunk) { console.log('[cfHistory]', id, 'decrypt failed'); continue; }
      const d = chunk.data;
      console.log(`[cfHistory] ${new Date(d.attestedAt).toISOString()} ${d.country}/${d.colo} ASN${d.asn} TLS${d.tlsVersion} ${d.httpProtocol}${d.verifiedBot ? ' [bot]' : ''}`);
    }
  } catch (err) {
    console.error('[cfHistory] failed:', err);
  }
};
(window as unknown as { cfHistory: typeof _cfHistory }).cfHistory = _cfHistory;
(globalThis as unknown as { cfHistory: typeof _cfHistory }).cfHistory = _cfHistory;
console.log('[ski] cfHistory hook installed — call cfHistory() to inspect your CF timeline');
```

Ensure `readRosterByAddress` returns `cf_history` as a field; if not, extend its parser (the contract getter is `record_cf_history`). Update the GraphQL projection (or whatever parse path `readRosterByAddress` uses) to include the new field.

- [ ] **Step 2: Build + deploy**

```bash
bun run build && npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 3: Manual smoke-test (human loop)**

In the browser at sui.ski:
1. Run `cfHistory()` — expect empty if no writes yet.
2. Trigger a `ski:request-suiami` (mint/attest flow).
3. Re-run `cfHistory()` — expect 1 timeline entry with today's country/colo.
4. Refresh page, re-run `cfHistory()` — still 1 entry (change-detection skipped the second write).
5. Toggle VPN to a different country, trigger another write, run `cfHistory()` — expect 2 entries.

- [ ] **Step 4: Commit**

```bash
git add src/ski.ts src/suins.ts
git commit -m "ski: cfHistory() console helper + readRosterByAddress cf_history field"
```

---

### Task 11: End-to-end verification

**Files:**
- None (all manual / smoke test)

- [ ] **Step 1: Type check + full build**

Run: `bun run build 2>&1 | tail -10`
Expected: clean, bundle size within ~100 KB of pre-feature.

- [ ] **Step 2: Contract sanity**

Run: `sui client call --package <NEW_PACKAGE_ID> --module roster --function append_cf_history --args <ROSTER_ID> \"smoke-test-blob-id\" 0x6 --gas-budget 10000000 2>&1 | tail -10`
Expected: succeeds for a wallet that has a roster record; fails with `ENotOwner` for one that doesn't.

- [ ] **Step 3: Curl the worker endpoint from multiple networks**

From two different networks (e.g. home + phone hotspot):
```bash
curl -s https://sui.ski/api/cf-context | jq '.data | {country, asn, colo}'
```
Confirm `asn` and `colo` differ across networks.

- [ ] **Step 4: Deploy**

```bash
bun run build && npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 5: Tag**

```bash
git tag -a cf-enrichment-v1 -m "CF edge enrichment for SUIAMI — per-chunk Seal+Walrus"
```

---

## Self-review notes

Spec coverage check:
- Fields captured (spec §Fields): Task 5 writes all 9. ✓
- Storage model (spec §Storage): Tasks 1–3 add Move struct/entries/policy; Tasks 6–7 client storage. ✓
- Write path steps 1–4 (spec): Task 5 step 1, Tasks 6–7 steps 2–3, Tasks 8–9 step 4. ✓
- Read path (spec): Task 10. ✓
- Rollout items 1–5 (spec): Tasks 4, 5, 8–9, 11, 11 respectively. ✓
- Out-of-scope items are NOT in any task. ✓

Type consistency:
- `CfFields` identical in `src/server/cf-context.ts` and `src/client/cf-history.ts`. ✓
- `CfChunk.schema` pinned to `1` in both encrypt + decrypt paths. ✓
- `append_cf_history(roster, blob_id, clock, ctx)` signature matches Tasks 2 / 8 / 9 / 11. ✓
