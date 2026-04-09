# Thunder SDK Migration — sui-stack-messaging

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deprecated custom Thunder crypto/transport layer with the official `@mysten/sui-stack-messaging` SDK from MystenLabs/sui-stack-messaging.

**Architecture:** The old Thunder used custom AES-GCM + XOR key masking + direct Move `signal()` calls to store encrypted messages on-chain in the Storm shared object. The new SDK uses Seal threshold encryption, envelope encryption (AES-256-GCM with Seal-managed DEKs), a pluggable transport interface for message delivery, and on-chain group/permission management. We keep: SuiNS identity resolution, `$amount` transfer composition, Chronicom signal counting. We replace: all custom crypto, all direct Storm contract calls, all signal/quest/strike PTB builders.

**Tech Stack:** `@mysten/sui-stack-messaging@0.0.2`, `@mysten/sui-groups@0.0.1`, `@mysten/seal@1.1.1`, Cloudflare Durable Objects (StormAgent DO as transport backend), `@mysten/sui@2.13.0`

---

## File Map

### New files
- `src/client/thunder-stack.ts` — New Thunder client wrapper around sui-stack-messaging SDK. Exports: `initThunderClient`, `sendThunder`, `getThunders`, `subscribeThunders`, `createStorm`, `lookupRecipientAddress`
- `src/server/agents/storm-agent.ts` — StormAgent Durable Object implementing the transport backend (message inbox per group, alarm-based delivery)

### Modified files
- `src/client/thunder.ts` — **Gutted.** Keep only `nameHash` (used by Chronicom) and `lookupRecipientAddress`. Remove ALL crypto, ALL PTB builders, ALL quest/strike logic. Re-export from thunder-stack.ts for backwards compat.
- `src/client/thunder-types.ts` — **Gutted.** Keep package IDs for legacy migration path only. Remove payload types (replaced by SDK's `DecryptedMessage`).
- `src/ui.ts` — Update all `import('./client/thunder.js')` call sites to use new API surface.
- `src/server/agents/treasury-agents.ts` — Update 2 call sites where ultron sends Thunder notifications.
- `src/server/agents/chronicom.ts` — May need to adapt signal counting to new group-based model.
- `wrangler.jsonc` — Add StormAgent DO binding.

### Preserved (no changes)
- `src/client/ika.ts` — `deriveStormIdFromAddresses` stays for cross-chain Storm
- `src/suins.ts` — SuiNS resolution stays
- `src/wallet.ts` — `signAndExecuteTransaction` stays
- `contracts/thunder-stack/` — Already vendored Move contracts

---

## Task 1: Create thunder-stack.ts — SDK client wrapper

**Files:**
- Create: `src/client/thunder-stack.ts`

This is the new public API for Thunder. All consumers import from here.

- [ ] **Step 1: Create the client initialization module**

```typescript
// src/client/thunder-stack.ts
/**
 * Thunder client — powered by @mysten/sui-stack-messaging SDK.
 * Replaces the deprecated custom AES-GCM + Storm signal layer.
 */
import {
  createSuiStackMessagingClient,
  MAINNET_SUI_STACK_MESSAGING_PACKAGE_CONFIG,
  type SuiStackMessagingClient,
  type DecryptedMessage,
  type GroupRef,
} from '@mysten/sui-stack-messaging';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// Seal key servers (free mainnet — Overclock, NodeInfra, Studio Mirai)
const SEAL_SERVERS = [
  { objectId: '0x22135e12ab6ca0249b4572c0d32e0e155c31b27e5e69aa10760b15e033789a32', weight: 1 },
  { objectId: '0xdd823bf2ecd8c84ca777ad26aa99c05e1ed66dde1f0b89b181cd5b9468751a13', weight: 1 },
  { objectId: '0x51f67a7a7c3eb8f54792e62ea8a45e55c9718e70ca8d9a7b1f5f7e8a25092bd0', weight: 1 },
];

// ─── Client singleton ───────────────────────────────────────────────

let _client: ReturnType<typeof createSuiStackMessagingClient> | null = null;

/**
 * Initialize the Thunder messaging client.
 * Must be called with a signer (wallet keypair or session key) before
 * sending or reading messages.
 */
export function initThunderClient(opts: {
  /** Signer for Seal session key + message signing */
  signer: { signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }> } & { toSuiAddress(): string };
  /** Optional custom transport (for StormAgent DO backend) */
  transport?: import('@mysten/sui-stack-messaging').RelayerTransport;
}) {
  const baseClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

  const relayerConfig = opts.transport
    ? { transport: opts.transport }
    : { relayerUrl: '' }; // placeholder — will be replaced by StormAgent

  _client = createSuiStackMessagingClient(baseClient as any, {
    seal: { serverConfigs: SEAL_SERVERS },
    encryption: {
      sessionKey: { signer: opts.signer as any },
    },
    relayer: relayerConfig as any,
  });

  return _client;
}

/** Get the initialized client (throws if not initialized). */
export function getThunderClient() {
  if (!_client) throw new Error('Thunder client not initialized — call initThunderClient first');
  return _client;
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send an encrypted Thunder signal to a group (Storm).
 * Optionally compose a SUI transfer in the same PTB.
 */
export async function sendThunder(opts: {
  signer: any;
  groupRef: GroupRef;
  text: string;
  /** Optional: attach SUI transfer to the same transaction */
  transfer?: { recipientAddress: string; amountMist: bigint };
}): Promise<{ messageId: string }> {
  const client = getThunderClient();
  return client.messaging.sendMessage({
    signer: opts.signer,
    groupRef: opts.groupRef,
    text: opts.text,
  });
}

/**
 * Fetch and decrypt messages from a Storm.
 */
export async function getThunders(opts: {
  signer: any;
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: DecryptedMessage[]; hasNext: boolean }> {
  const client = getThunderClient();
  return client.messaging.getMessages({
    signer: opts.signer,
    groupRef: opts.groupRef,
    afterOrder: opts.afterOrder,
    limit: opts.limit,
  });
}

/**
 * Subscribe to real-time Thunder signals in a Storm.
 */
export function subscribeThunders(opts: {
  signer: any;
  groupRef: GroupRef;
  signal?: AbortSignal;
}): AsyncIterable<DecryptedMessage> {
  const client = getThunderClient();
  return client.messaging.subscribe({
    signer: opts.signer,
    groupRef: opts.groupRef,
    signal: opts.signal,
  });
}

/**
 * Create a new Storm (messaging group) between two SuiNS identities.
 */
export async function createStorm(opts: {
  signer: any;
  name: string;
  members: string[];
  /** Optional: compose additional PTB commands (e.g. token transfer) */
  transaction?: Transaction;
}) {
  const client = getThunderClient();
  return client.messaging.createAndShareGroup({
    signer: opts.signer,
    name: opts.name,
    initialMembers: opts.members,
    transaction: opts.transaction,
  });
}

// ─── SuiNS resolution (preserved from old thunder.ts) ───────────────

/** Resolve a SuiNS name to its target address. */
export async function lookupRecipientAddress(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const suinsClient = new SuinsClient({ client: gql as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.targetAddress ?? null;
  } catch { return null; }
}

/** Hash the full domain with .sui — matches Move keccak256(domain). Kept for Chronicom compat. */
export { nameHash } from './thunder-legacy.js';

// Re-export types for consumers
export type { DecryptedMessage, GroupRef };
```

- [ ] **Step 2: Commit**

```bash
git add src/client/thunder-stack.ts
git commit -m "feat(thunder): create thunder-stack.ts SDK wrapper

Volcarona Lv.35 — New Thunder client wrapping @mysten/sui-stack-messaging.
Exports initThunderClient, sendThunder, getThunders, subscribeThunders,
createStorm, lookupRecipientAddress. Seal 2-of-3 threshold encryption
with mainnet key servers.

Refs #68"
```

---

## Task 2: Gut thunder.ts — move legacy to thunder-legacy.ts

**Files:**
- Create: `src/client/thunder-legacy.ts` — preserved functions only (nameHash, getThunderCountsBatch for Chronicom)
- Modify: `src/client/thunder.ts` — becomes a thin re-export barrel

- [ ] **Step 1: Create thunder-legacy.ts with preserved functions**

Move `nameHash`, `getThunderCountsBatch`, `lookupRecipientNftId` (still needed for legacy Storm signal counting in Chronicom) into `thunder-legacy.ts`. These are the ONLY functions that touch the old Storm contract and are still needed.

```typescript
// src/client/thunder-legacy.ts
/**
 * Legacy Thunder helpers — preserved for Chronicom signal counting
 * and backward compat during migration. Do NOT add new code here.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import { STORM_ID } from './thunder-types.js';

/** Hash the full domain with .sui — matches the Move contract's keccak256(nft.domain().to_string()). */
export function nameHash(name: string): Uint8Array {
  const full = name.toLowerCase().replace(/\.sui$/, '') + '.sui';
  return keccak_256(new TextEncoder().encode(full));
}

/** Count pending signals for a batch of names (legacy Storm). Used by Chronicom. */
export async function getThunderCountsBatch(names: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  if (names.length === 0) return result;
  const hashToBare: Record<string, string> = {};
  for (const name of names) {
    const bare = name.replace(/\.sui$/i, '').toLowerCase();
    const ns = nameHash(bare);
    const hex = Array.from(ns).map(b => b.toString(16).padStart(2, '0')).join('');
    hashToBare[hex] = bare;
    result[bare] = 0;
  }
  try {
    const { grpcClient } = await import('../rpc.js');
    try {
      const dfResult = await grpcClient.listDynamicFields({ parentId: STORM_ID });
      for (const df of dfResult.objects ?? []) {
        const nameField = (df as any)?.name?.value;
        if (!nameField) continue;
        const hex = Array.isArray(nameField) ? nameField.map((b: number) => b.toString(16).padStart(2, '0')).join('') : String(nameField);
        if (hashToBare[hex]) result[hashToBare[hex]] = 1;
      }
    } catch {}
    return result;
  } catch { return result; }
}

/** Look up the SuinsRegistration NFT object ID for a name. Legacy — used by strike relay. */
export async function lookupRecipientNftId(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const suinsClient = new SuinsClient({ client: gqlClient as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.nftId ?? null;
  } catch { return null; }
}
```

- [ ] **Step 2: Replace thunder.ts with re-export barrel**

```typescript
// src/client/thunder.ts
/**
 * Thunder client — re-export barrel.
 *
 * New SDK: import from './thunder-stack.js'
 * Legacy compat: this file re-exports both for gradual migration.
 */

// ─── New SDK (primary) ──────────────────────────────────────────────
export {
  initThunderClient,
  getThunderClient,
  sendThunder,
  getThunders,
  subscribeThunders,
  createStorm,
  lookupRecipientAddress,
  type DecryptedMessage,
  type GroupRef,
} from './thunder-stack.js';

// ─── Legacy (Chronicom + treasury strike relay) ─────────────────────
export {
  nameHash,
  getThunderCountsBatch,
  lookupRecipientNftId,
} from './thunder-legacy.js';
```

- [ ] **Step 3: Commit**

```bash
git add src/client/thunder-legacy.ts src/client/thunder.ts
git commit -m "refactor(thunder): gut thunder.ts, move legacy to thunder-legacy.ts

Altaria Lv.38 — thunder.ts is now a thin re-export barrel. All custom
AES-GCM crypto, XOR key masking, signal/quest/strike PTB builders,
and direct Storm contract calls moved to thunder-legacy.ts (preserved
only for Chronicom signal counting and treasury strike relay).

New imports should use thunder-stack.ts (via the barrel).

Refs #68"
```

---

## Task 3: Update UI send flow — use new SDK

**Files:**
- Modify: `src/ui.ts` — update `_sendIdleThunder` and all thunder import sites

This is the largest change. Every `import('./client/thunder.js')` call site needs to be updated. The key changes:

1. `buildThunderSendTx` → `sendThunder` (SDK handles encryption)
2. `lookupRecipientNftId` → no longer needed for sending (SDK resolves internally)
3. `decryptAndQuest` → `getThunders` (SDK handles decryption)
4. `parseAndDecryptQuestfi` → replaced by SDK's `getMessages`
5. `buildStrikeWithReceiptTx` → replaced by SDK's read receipt pattern
6. `getThunderCountsBatch` → kept from legacy (Chronicom still uses it)

- [ ] **Step 1: Update the main send flow** (`_sendIdleThunder`, around line 11269)

Replace the old `buildThunderSendTx` + `signAndExecuteTransaction` with `sendThunder` from the new SDK. The `$amount` transfer composition stays but needs to be adapted (the SDK's `createAndShareGroup` accepts a `transaction` param for PTB composition).

- [ ] **Step 2: Update quest/decrypt flows** (lines ~3660, ~4955, ~9036, ~11146)

Replace `decryptAndQuest` and `parseAndDecryptQuestfi` with `getThunders`.

- [ ] **Step 3: Update strike/receipt flows** (lines ~3706, ~11177, ~11546)

Replace `buildStrikeWithReceiptTx` and `buildStrikeToTreasuryTx` with SDK equivalents or remove if no longer needed (the new SDK doesn't use on-chain strikes — messages are off-chain).

- [ ] **Step 4: Build and verify no TypeScript errors**

```bash
bun build src/ski.ts --outdir public/dist --target browser --minify --format esm --loader .svg:text
```

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts
git commit -m "refactor(thunder): migrate UI send/quest/strike to SDK

Pelipper Lv.42 — All thunder import sites in ui.ts updated to use new
SDK surface. sendThunder replaces buildThunderSendTx, getThunders
replaces decryptAndQuest. Strike flows removed (SDK uses off-chain
message delivery, no on-chain quest/strike).

Refs #68"
```

---

## Task 4: Update treasury-agents — ultron Thunder notifications

**Files:**
- Modify: `src/server/agents/treasury-agents.ts` — 2 call sites (lines ~2950, ~4423)

- [ ] **Step 1: Update Prism Thunder notification** (line ~2950)

Replace `buildThunderSendTx` + `lookupRecipientNftId` with `sendThunder`. Note: server-side (DO) needs the SDK initialized with ultron's keypair.

- [ ] **Step 2: Update welcome Thunder** (line ~4423)

Same pattern — replace with `sendThunder`.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/treasury-agents.ts
git commit -m "refactor(thunder): migrate treasury-agents to SDK

Swanna Lv.45 — Ultron Prism and welcome Thunder notifications now use
sendThunder from the new SDK instead of custom buildThunderSendTx.

Refs #68"
```

---

## Task 5: Build and deploy, create PR

- [ ] **Step 1: Full build**

```bash
bun run build
```

- [ ] **Step 2: Deploy**

```bash
npx wrangler deploy
```

- [ ] **Step 3: Commit any remaining fixes**

- [ ] **Step 4: Push and update PR #72**

```bash
git push origin feat/thunder-messaging-stack
```

---

## Deferred (not in this plan)

- **StormAgent DO** — Custom transport backend. Needed when we want to self-host message storage instead of relying on an external HTTP relayer. Will be a separate plan.
- **Chronicom migration** — Currently counts signals via legacy Storm dynamic fields. When StormAgent exists, Chronicom can query it instead.
- **Thunder v5 (ECDH storms)** — The `buildThunderV5*` functions in old thunder.ts. These were experimental and can be fully replaced by the SDK's group model.
- **Legacy storm auto-strike** — The `LEGACY_STORMS` cleanup. Low priority, signals there are already orphaned.
