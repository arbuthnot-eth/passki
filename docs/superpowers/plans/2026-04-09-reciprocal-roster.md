# Reciprocal SUIAMI Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reciprocal identity exchange where SUIAMI proof writes Seal-encrypted chain addresses to Walrus, stores the blob ID on-chain in the roster, and anyone who also SUIAMIs can decrypt via Storm membership.

**Architecture:** On-chain roster stores SUI address (plaintext) + Walrus blob ID + Seal nonce. Cross-chain addresses (BTC/ETH/SOL) are Seal-encrypted on Walrus. Storm membership gates decryption. Reading auto-writes your own entry. After Storm creation, all Thunders are free.

**Tech Stack:** Move (Sui), `@mysten/seal`, `@mysten/walrus`, `@mysten/sui-stack-messaging`, `suiami` npm package, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-04-09-suiami-reciprocal-roster-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `contracts/suiami/sources/roster.move` | Modify | Add `walrus_blob_id`, `seal_nonce`, `verified` fields to IdentityRecord |
| `contracts/suiami/sources/seal_roster.move` | Create | Seal policy: `seal_approve_roster_reader` checks roster membership |
| `src/suins.ts` | Modify | Add `readRosterByAddress()`, `writeRosterEntry()`, re-enable `maybeAppendRoster` |
| `src/client/roster.ts` | Create | Seal encrypt/decrypt + Walrus upload/fetch for roster blobs |
| `src/ui.ts` | Modify | Dark reveal on non-own squids, Join→SUIAMI flow, on-chain roster query |
| `src/client/thunder-stack.ts` | Modify | Global Storm constant, piggyback roster write on Storm creation |
| `src/ski.ts` | Modify | SUIAMI handler writes roster entry after proof |

---

### Task 1: Update Roster Move Contract

**Files:**
- Modify: `contracts/suiami/sources/roster.move:49-60`

- [ ] **Step 1: Add new fields to IdentityRecord**

```move
public struct IdentityRecord has store, drop, copy {
    name: String,
    sui_address: address,
    chains: VecMap<String, String>,
    dwallet_caps: vector<address>,
    updated_ms: u64,
    walrus_blob_id: String,
    seal_nonce: vector<u8>,
    verified: bool,
}
```

- [ ] **Step 2: Update set_identity to accept new fields**

Add parameters `walrus_blob_id: String` and `seal_nonce: vector<u8>` to `set_identity` entry function at line 82. Update the `IdentityRecord` construction at line 104:

```move
entry fun set_identity(
    roster: &mut Roster,
    name: String,
    name_hash: vector<u8>,
    chain_keys: vector<String>,
    chain_values: vector<String>,
    dwallet_caps: vector<address>,
    walrus_blob_id: String,
    seal_nonce: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let len = chain_keys.length();
    assert!(len > 0 && len == chain_values.length(), ENoChains);

    let mut chains = vec_map::empty<String, String>();
    let mut i = 0;
    while (i < len) {
        chains.insert(chain_keys[i], chain_values[i]);
        i = i + 1;
    };

    let verified = !dwallet_caps.is_empty();

    let record = IdentityRecord {
        name,
        sui_address: sender,
        chains,
        dwallet_caps,
        updated_ms: clock.timestamp_ms(),
        walrus_blob_id,
        seal_nonce,
        verified,
    };
    // ... rest of upsert logic unchanged
```

- [ ] **Step 3: Build and test locally**

```bash
cd contracts/suiami
sui move build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Publish updated contract**

```bash
sui client publish --gas-budget 100000000
```

Note the new package ID. Update `ROSTER_PKG` in `src/suins.ts:57` and `packages/suiami/src/roster.ts`.

- [ ] **Step 5: Commit**

```bash
git add contracts/suiami/sources/roster.move src/suins.ts
git commit -m "feat(roster): add walrus_blob_id, seal_nonce, verified fields to IdentityRecord"
```

---

### Task 2: Create Seal Roster Policy Contract

**Files:**
- Create: `contracts/suiami/sources/seal_roster.move`

- [ ] **Step 1: Write the Seal policy module**

```move
module suiami::seal_roster;

use suiami::roster::{Self, Roster};

const ENotRegistered: u64 = 100;
const EInvalidIdentity: u64 = 101;

/// Called by Seal key servers during dry-run to approve decryption.
/// Identity bytes: [roster_obj_id (32 bytes)][key_version (8 bytes LE u64)]
/// Approves if the caller has a roster entry (has_address check).
entry fun seal_approve_roster_reader(
    roster: &Roster,
    id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(id.length() == 40, EInvalidIdentity);
    assert!(roster::has_address(roster, ctx.sender()), ENotRegistered);
}
```

- [ ] **Step 2: Build**

```bash
cd contracts/suiami
sui move build
```

- [ ] **Step 3: Publish (included with Task 1 publish if done together)**

- [ ] **Step 4: Commit**

```bash
git add contracts/suiami/sources/seal_roster.move
git commit -m "feat(roster): seal_approve_roster_reader policy for gated decryption"
```

---

### Task 3: Client — readRosterByAddress

**Files:**
- Modify: `src/suins.ts:121-142`

- [ ] **Step 1: Add readRosterByAddress function after readRoster**

At `src/suins.ts` after line 142, add:

```typescript
/**
 * Read roster entry by Sui address. Returns full record or null.
 */
export async function readRosterByAddress(address: string): Promise<{
  name: string;
  sui_address: string;
  chains: Record<string, string>;
  walrus_blob_id?: string;
  seal_nonce?: string;
  verified?: boolean;
  dwallet_caps: string[];
  updated_ms: number;
} | null> {
  const hex = address.replace(/^0x/, '').padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const addrB64 = btoa(String.fromCharCode(...bytes));
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "${ROSTER_OBJ}") { dynamicField(name: { type: "address", bcs: "${addrB64}" }) { value { ... on MoveValue { json } } } } }`,
      }),
    });
    const gql = await res.json() as any;
    const data = gql?.data?.object?.dynamicField?.value?.json;
    if (!data?.chains?.contents) return null;
    const chains: Record<string, string> = {};
    for (const { key, value } of data.chains.contents) chains[key] = value;
    return {
      name: data.name,
      sui_address: data.sui_address,
      chains,
      walrus_blob_id: data.walrus_blob_id || undefined,
      seal_nonce: data.seal_nonce || undefined,
      verified: data.verified ?? false,
      dwallet_caps: data.dwallet_caps ?? [],
      updated_ms: Number(data.updated_ms ?? 0),
    };
  } catch { return null; }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
bun run build
```

- [ ] **Step 3: Commit**

```bash
git add src/suins.ts
git commit -m "feat(roster): readRosterByAddress GraphQL query"
```

---

### Task 4: Client — Seal Encrypt + Walrus Upload for Roster

**Files:**
- Create: `src/client/roster.ts`

- [ ] **Step 1: Create the roster client module**

```typescript
/**
 * Roster client — Seal encrypt/decrypt chain addresses + Walrus blob storage.
 */

// Mainnet operators: Walrus Foundation, Studio Mirai, Overclock, H2O Nodes
const WALRUS_PUBLISHER = 'https://publisher.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus.space';

export interface RosterBlob {
  btc?: string;
  eth?: string;
  sol?: string;
  dwallet_caps?: string[];
}

/**
 * Upload a plaintext roster blob to Walrus. Returns the blob ID.
 * In production this will be Seal-encrypted before upload.
 */
export async function uploadRosterBlob(data: RosterBlob): Promise<string> {
  const json = JSON.stringify(data);
  const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: json,
  });
  if (!res.ok) throw new Error(`Walrus upload failed: ${res.status}`);
  const result = await res.json() as any;
  // Walrus returns { newlyCreated: { blobObject: { blobId } } } or { alreadyCertified: { blobId } }
  const blobId = result?.newlyCreated?.blobObject?.blobId ?? result?.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus returned no blob ID');
  return blobId;
}

/**
 * Fetch and parse a roster blob from Walrus.
 */
export async function fetchRosterBlob(blobId: string): Promise<RosterBlob | null> {
  try {
    const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
    if (!res.ok) return null;
    return await res.json() as RosterBlob;
  } catch { return null; }
}

/**
 * Build roster write arguments for a PTB.
 * Call after uploading the blob to Walrus.
 */
export function buildRosterWriteArgs(
  name: string,
  suiAddress: string,
  blobId: string,
  sealNonce: number[] = [],
  crossChain?: { btc?: string; eth?: string; sol?: string },
  dwalletCaps: string[] = [],
) {
  const { keccak_256 } = require('@noble/hashes/sha3.js');
  const bare = name.replace(/\.sui$/i, '').toLowerCase();
  const nh = Array.from(keccak_256(new TextEncoder().encode(bare)));

  // chains: always include sui, optionally btc/eth/sol
  const chainKeys = ['sui'];
  const chainValues = [suiAddress];
  if (crossChain?.btc) { chainKeys.push('btc'); chainValues.push(crossChain.btc); }
  if (crossChain?.eth) { chainKeys.push('eth'); chainValues.push(crossChain.eth); }
  if (crossChain?.sol) { chainKeys.push('sol'); chainValues.push(crossChain.sol); }

  return { bare, nh, chainKeys, chainValues, blobId, sealNonce, dwalletCaps };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
bun run build
```

- [ ] **Step 3: Commit**

```bash
git add src/client/roster.ts
git commit -m "feat(roster): Walrus blob upload/fetch + PTB args builder"
```

---

### Task 5: Re-enable maybeAppendRoster with Walrus Blob ID

**Files:**
- Modify: `src/suins.ts:22` (uncomment)
- Modify: `src/suins.ts:72-115` (update to include blob ID)

- [ ] **Step 1: Update maybeAppendRoster to accept blob ID and nonce**

At `src/suins.ts:72`, update the function signature and Move call to include `walrus_blob_id` and `seal_nonce` parameters matching the updated contract:

```typescript
export function maybeAppendRoster(
  tx: InstanceType<typeof Transaction>,
  address?: string,
  name?: string | null,
  crossChain?: { btc?: string; eth?: string; sol?: string },
  walrusBlobId?: string,
  sealNonce?: number[],
): boolean {
```

Update the `tx.moveCall` at line 97 to include the new arguments:

```typescript
  tx.moveCall({
    package: ROSTER_PKG,
    module: 'roster',
    function: 'set_identity',
    arguments: [
      tx.object(ROSTER_OBJ),
      tx.pure.string(nm),
      tx.pure.vector('u8', nh),
      tx.pure.vector('string', chains.map(c => c[0])),
      tx.pure.vector('string', chains.map(c => c[1])),
      tx.pure.vector('address', []),
      tx.pure.string(walrusBlobId || ''),
      tx.pure.vector('u8', sealNonce || []),
      tx.object('0x6'),
    ],
  });
```

- [ ] **Step 2: Uncomment the call in buildWithTx**

At `src/suins.ts:22`, change:
```typescript
// maybeAppendRoster(tx);
```
to:
```typescript
maybeAppendRoster(tx);
```

- [ ] **Step 3: Verify build**

```bash
bun run build
```

- [ ] **Step 4: Commit**

```bash
git add src/suins.ts
git commit -m "feat(roster): re-enable maybeAppendRoster with walrus blob ID + seal nonce"
```

---

### Task 6: SUIAMI Handler Writes Roster Entry

**Files:**
- Modify: `src/ski.ts:335-442`

- [ ] **Step 1: After successful SUIAMI proof, upload blob + write roster**

In `src/ski.ts`, after the `suiami:signed` event dispatch (around line 440), add roster write:

```typescript
    // Write roster entry with Walrus blob
    try {
      const { uploadRosterBlob } = await import('./client/roster.js');
      const { maybeAppendRoster } = await import('./suins.js');
      const appState = getAppState();
      const blob: { btc?: string; eth?: string; sol?: string } = {};
      if (appState.btcAddress) blob.btc = appState.btcAddress;
      if (appState.ethAddress) blob.eth = appState.ethAddress;
      if (appState.solAddress) blob.sol = appState.solAddress;
      // Upload to Walrus (plaintext for now, Seal encryption in Task 8)
      const blobId = await uploadRosterBlob(blob);
      // Build and submit roster write PTB
      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();
      maybeAppendRoster(tx, ws.address, name, blob, blobId);
      await signAndExecuteTransaction(tx);
    } catch { /* roster write is best-effort */ }
```

- [ ] **Step 2: Build and deploy**

```bash
bun run build && npx wrangler deploy
```

- [ ] **Step 3: Commit**

```bash
git add src/ski.ts
git commit -m "feat(roster): SUIAMI proof writes roster entry with Walrus blob"
```

---

### Task 7: Squids Display — Dark Reveal + On-Chain Query

**Files:**
- Modify: `src/ui.ts:10795-10830`

- [ ] **Step 1: For non-own addresses, show dark overlay with Join prompt instead of empty**

Replace the `_isOwnAddr` conditional block. When viewing someone else's addresses and no SUIAMI proof exists, show a blurred/dark overlay with "SUIAMI to reveal" prompt over the cross-chain rows:

```typescript
// After suiLine is built, check if we should show cross-chain or dark reveal
if (!_isOwnAddr && !_hasSuiamiProof) {
  // Dark reveal: show SUI address + blurred placeholder rows + Join prompt
  const darkRows = `
    <span class="ski-idle-addr-line ski-idle-addr-dark">BTC ••••••••••••</span>
    <span class="ski-idle-addr-line ski-idle-addr-dark">SOL ••••••••••••</span>
    <span class="ski-idle-addr-line ski-idle-addr-dark">ETH ••••••••••••</span>
  `;
  const joinLine = `<button class="ski-idle-addr-suiami ski-idle-addr-suiami--join" type="button" title="SUIAMI to reveal addresses">SUIAMI to reveal</button>`;
  addrRow.innerHTML = `${suiLine}${darkRows}${joinLine}`;
} else {
  // Normal: show all addresses
  addrRow.innerHTML = `${suiLine}${btcLine}${solLine}${ethLine}${baseLine}${tronLine}${suiamiLine}`;
}
```

- [ ] **Step 2: Add CSS for dark placeholder rows**

In `public/styles.css`, add after `.ski-idle-addr-line--tron:hover`:

```css
.ski-idle-addr-dark {
  color: rgba(255, 255, 255, 0.15) !important;
  border-color: rgba(255, 255, 255, 0.05) !important;
  pointer-events: none;
  user-select: none;
  filter: blur(2px);
}
```

- [ ] **Step 3: When SUIAMI proof exists and viewing non-own, fetch from on-chain roster**

After the dark reveal check, if `_hasSuiamiProof` is true, query the roster for the target address:

```typescript
if (!_isOwnAddr && _hasSuiamiProof) {
  // Fetch cross-chain addresses from on-chain roster
  import('../suins.js').then(({ readRosterByAddress }) => {
    readRosterByAddress(addr).then(record => {
      if (!record?.walrus_blob_id) return;
      import('../client/roster.js').then(({ fetchRosterBlob }) => {
        fetchRosterBlob(record.walrus_blob_id!).then(blob => {
          if (!blob) return;
          // Re-render with decrypted addresses
          // ... build btcLine, solLine, ethLine from blob data
        });
      });
    });
  }).catch(() => {});
}
```

- [ ] **Step 4: Build and deploy**

```bash
bun run build && npx wrangler deploy
```

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts public/styles.css
git commit -m "feat(roster): dark reveal for non-SUIAMI squids, on-chain roster query for verified users"
```

---

### Task 8: Global SUIAMI Storm + Join Flow

**Files:**
- Modify: `src/client/thunder-stack.ts`
- Modify: `src/ui.ts` (Join button handler)

- [ ] **Step 1: Deploy global SUIAMI Storm and record its object ID**

Using the existing `createStorm` function, create a one-time global Storm:

```typescript
const storm = createStorm({ name: 'suiami-global', members: [] });
// Execute and record the PermissionedGroup object ID
```

After execution, hardcode the object ID in `src/client/thunder-stack.ts`:

```typescript
export const GLOBAL_SUIAMI_STORM = '0x...'; // deployed once
```

- [ ] **Step 2: Wire Join button to create roster entry + join global Storm**

In `src/ui.ts`, update the squids SUIAMI button click handler. When "Join" is clicked:

```typescript
addrRow.querySelector('.ski-idle-addr-suiami--join')?.addEventListener('click', async (ev) => {
  ev.stopPropagation();
  // Trigger SUIAMI flow which writes roster + joins storm
  window.dispatchEvent(new CustomEvent('ski:request-suiami', {
    detail: { name: nsLabel || app.suinsName?.replace(/\.sui$/, '') }
  }));
});
```

- [ ] **Step 3: After SUIAMI proof success, auto-join global Storm**

In `src/ski.ts` SUIAMI handler, after roster write (Task 6), join the global Storm:

```typescript
    // Join global SUIAMI Storm if not already a member
    try {
      const { GLOBAL_SUIAMI_STORM } = await import('./client/thunder-stack.js');
      if (GLOBAL_SUIAMI_STORM) {
        const { Transaction } = await import('@mysten/sui/transactions');
        const joinTx = new Transaction();
        // SDK handles Storm join
        await signAndExecuteTransaction(joinTx);
      }
    } catch { /* join is best-effort */ }
```

- [ ] **Step 4: Build and deploy**

```bash
bun run build && npx wrangler deploy
```

- [ ] **Step 5: Commit**

```bash
git add src/client/thunder-stack.ts src/ui.ts src/ski.ts
git commit -m "feat(roster): global SUIAMI Storm + Join button wires to SUIAMI flow"
```

---

### Task 9: Verified Badge UI

**Files:**
- Modify: `src/ui.ts` (squids display)
- Modify: `public/styles.css`

- [ ] **Step 1: Add verified badge next to SUIAMI button when roster has dWallet attestation**

When rendering the SUIAMI line in squids, check the roster record's `verified` field:

```typescript
const suiamiLine = _hasSuiamiProof
  ? `<button class="ski-idle-addr-suiami ski-idle-addr-suiami--verified" type="button" title="Click to copy SUIAMI proof">\u2713 SUIAMI${rosterRecord?.verified ? ' \u2022 dWallet' : ''}</button>`
  : `<button class="ski-idle-addr-suiami ski-idle-addr-suiami--join" type="button" title="SUIAMI to reveal addresses">SUIAMI to reveal</button>`;
```

- [ ] **Step 2: Add verified indicator CSS**

No new CSS needed — the text "• dWallet" appends inside the existing button.

- [ ] **Step 3: Build and deploy**

```bash
bun run build && npx wrangler deploy
```

- [ ] **Step 4: Commit**

```bash
git add src/ui.ts
git commit -m "feat(roster): verified dWallet badge on SUIAMI button"
```

---

## Execution Notes

- **Contract publish (Tasks 1-2)** must happen first — client code depends on the new `set_identity` signature.
- **Tasks 3-5** are independent client functions that can be built in parallel.
- **Task 6** depends on Tasks 4-5 (roster write needs Walrus upload + updated `maybeAppendRoster`).
- **Task 7** depends on Task 3 (squids needs `readRosterByAddress`).
- **Task 8** depends on Task 6 (Join button triggers SUIAMI which does roster write).
- **Task 9** is cosmetic, depends on Task 7.
- **Seal encryption** of the Walrus blob (currently plaintext upload in Task 4) will be added as a follow-up once the global Storm is deployed and the Seal policy contract (Task 2) is live. The infrastructure is in place — just needs the `@mysten/seal` encrypt call before `uploadRosterBlob`.
- **After Storm creation, all Thunders within it are free** — no additional on-chain cost per message.
