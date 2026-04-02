# Chronicom — Thunder Signal Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace client-side 30s thunder polling with a server-side Chronicom DO that caches signal counts for all wallet SuiNS names with 5s alarm cycles, and rework the idle overlay so the thunder button shows aggregate count, uses ⛈️ when signals exist, and defaults to quest/decrypt on first action.

**Architecture:** New `Chronicom` Durable Object keyed per wallet address. Client hits `GET /api/thunder/chronicom?addr=0x...&names=brando,atlas` every 5s, gets cached counts instantly. DO alarm re-queries on-chain via GraphQL every 5s, auto-sleeps after 2min inactivity. Idle overlay aggregates counts across all owned names; ⛈️+count badge when > 0, first Enter decrypts across all names.

**Tech Stack:** Cloudflare Durable Objects (Agent base from `agents` package), Hono routes, SuiGraphQL for on-chain reads, existing `nameHash` logic (keccak256).

---

### Task 1: Chronicom DO — Server-Side Signal Counter

**Files:**
- Create: `src/server/agents/chronicom.ts`
- Modify: `src/server/index.ts` (add route + export)
- Modify: `wrangler.jsonc` (add DO binding + migration)

- [ ] **Step 1: Create the Chronicom DO**

```typescript
// src/server/agents/chronicom.ts
/**
 * Chronicom — per-wallet thunder signal watcher.
 *
 * Caches signal counts for all of a wallet's SuiNS names.
 * 5s alarm cycle re-checks on-chain via GraphQL.
 * Auto-sleeps after 2 minutes of inactivity.
 */

import { Agent } from 'agents';
import { GQL_URL } from '../rpc.js';

const STORM_ID = '0xd67490b2047490e81f7467eedb25c726e573a311f9139157d746e4559282844f';
const ALARM_INTERVAL_MS = 5_000;
const INACTIVITY_TIMEOUT_MS = 120_000;

interface ChronicomState {
  /** name (bare, no .sui) → on-chain signal count */
  counts: Record<string, number>;
  /** names to watch */
  names: string[];
  /** last time a client polled */
  lastPollMs: number;
  /** whether alarm is scheduled */
  alarmActive: boolean;
}

interface Env {
  [key: string]: unknown;
}

/** keccak256 via SubtleCrypto — Workers have no @noble/hashes, use SHA-256 as placeholder.
 *  Actually we need keccak for name hashing. Workers DO have @noble/hashes via bundle. */
function nameHashHex(bare: string): string {
  // We'll import keccak at the top level. For Workers, we bundle it.
  // Inline the hash: keccak256(bare + '.sui') → hex
  const { keccak_256 } = require('@noble/hashes/sha3');
  const full = bare.toLowerCase() + '.sui';
  const hash = keccak_256(new TextEncoder().encode(full));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class Chronicom extends Agent<Env, ChronicomState> {
  initialState: ChronicomState = {
    counts: {},
    names: [],
    lastPollMs: 0,
    alarmActive: false,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._refresh();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/poll') || url.searchParams.has('poll')) {
      const namesParam = url.searchParams.get('names') || '';
      const names = namesParam.split(',').map(n => n.toLowerCase().replace(/\.sui$/, '').trim()).filter(Boolean);

      if (names.length > 0) {
        this.setState({ ...this.state, names, lastPollMs: Date.now() });
      } else {
        this.setState({ ...this.state, lastPollMs: Date.now() });
      }

      // Start alarm if not running
      if (!this.state.alarmActive && this.state.names.length > 0) {
        this.setState({ ...this.state, alarmActive: true });
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }

      return Response.json(this.state.counts);
    }

    // Default: return cached counts
    return Response.json(this.state.counts);
  }

  /** Alarm tick — refresh counts from on-chain, reschedule if still active */
  private async _refresh(): Promise<void> {
    const { names, lastPollMs } = this.state;

    // Auto-sleep if no client has polled recently
    if (Date.now() - lastPollMs > INACTIVITY_TIMEOUT_MS) {
      this.setState({ ...this.state, alarmActive: false });
      return;
    }

    if (names.length === 0) {
      this.setState({ ...this.state, alarmActive: false });
      return;
    }

    // Query on-chain counts via GraphQL
    const counts = await this._fetchCounts(names);
    this.setState({ ...this.state, counts, alarmActive: true });

    // Reschedule
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /** Fetch signal counts from Storm dynamic fields via GraphQL */
  private async _fetchCounts(names: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const n of names) result[n] = 0;

    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ object(address: "${STORM_ID}") { dynamicFields { nodes { name { json } value { ... on MoveValue { json } } } } } }`,
        }),
      });
      const gql = await res.json() as any;
      const nodes = gql?.data?.object?.dynamicFields?.nodes ?? [];

      // Build hex → bare lookup
      const hexToBare: Record<string, string> = {};
      for (const bare of names) {
        hexToBare[nameHashHex(bare)] = bare;
      }

      for (const n of nodes) {
        const val = n?.value?.json;
        if (!val?.signals) continue;
        // name.json is base64 of the keccak hash
        const keyB64 = typeof n.name?.json === 'string' ? n.name.json : '';
        // Decode base64 to hex for comparison
        try {
          const raw = atob(keyB64);
          const hex = Array.from(raw).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
          if (hexToBare[hex]) {
            result[hexToBare[hex]] = val.signals.length;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* return zeros on error */ }

    return result;
  }
}
```

- [ ] **Step 2: Fix the import — use ESM import instead of require**

Replace the `nameHashHex` function with a proper ESM import at the top:

```typescript
import { keccak_256 } from '@noble/hashes/sha3';

function nameHashHex(bare: string): string {
  const full = bare.toLowerCase() + '.sui';
  const hash = keccak_256(new TextEncoder().encode(full));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 3: Add the route in server/index.ts**

Add to `Env` interface:
```typescript
interface Env {
  ShadeExecutorAgent: DurableObjectNamespace;
  TreasuryAgents: DurableObjectNamespace;
  Chronicom: DurableObjectNamespace;  // ← add
  TRADEPORT_API_KEY: string;
  TRADEPORT_API_USER: string;
  SHADE_KEEPER_PRIVATE_KEY?: string;
}
```

Add route (before `export default app`):
```typescript
// Chronicom — per-wallet thunder signal watcher
app.get('/api/thunder/chronicom', async (c) => {
  const addr = c.req.query('addr');
  if (!addr) return c.json({ error: 'addr required' }, 400);
  const id = c.env.Chronicom.idFromName(addr);
  const stub = c.env.Chronicom.get(id);
  const url = new URL(c.req.url);
  url.pathname = '/poll';
  return stub.fetch(new Request(url.toString()));
});
```

Add export:
```typescript
export { Chronicom } from './agents/chronicom.js';
```

- [ ] **Step 4: Add DO binding to wrangler.jsonc**

Add to `durable_objects.bindings`:
```json
{
  "name": "Chronicom",
  "class_name": "Chronicom"
}
```

Add migration:
```json
{
  "tag": "v6",
  "new_sqlite_classes": ["Chronicom"]
}
```

- [ ] **Step 5: Build and verify no compile errors**

Run: `bun run build`
Expected: Builds without errors

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/chronicom.ts src/server/index.ts wrangler.jsonc
git commit -m "feat: Chronicom DO — server-side thunder signal watcher with 5s alarm"
```

---

### Task 2: Client — Switch Polling from Direct gRPC to Chronicom

**Files:**
- Modify: `src/ui.ts` (replace `_pollThunder` with chronicom fetch, aggregate counts for idle overlay)

- [ ] **Step 1: Replace `_pollThunder` with chronicom client**

Find the `_pollThunder` function (around line 8467) and replace:

```typescript
const _pollThunder = async () => {
  if (nsOwnedDomains.length === 0) return;
  const ws = getState();
  if (!ws.address) return;
  try {
    const nftNames = nsOwnedDomains.filter(d => d.kind === 'nft').map(d => d.name.replace(/\.sui$/, '').toLowerCase());
    if (nftNames.length === 0) return;
    const params = new URLSearchParams({ addr: ws.address, names: nftNames.join(',') });
    const res = await fetch(`/api/thunder/chronicom?${params}`);
    if (!res.ok) return;
    const counts = await res.json() as Record<string, number>;
    let changed = false;
    for (const [bare, count] of Object.entries(counts)) {
      const prev = _thunderCounts[bare] ?? 0;
      if (prev !== count) { _thunderCounts[bare] = count; changed = true; }
    }
    if (changed) {
      try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
      _patchNsOwnedList();
      _syncNftCardToInput();
      _updateIdleThunderBadge();
    }
  } catch { /* silent */ }
};
```

- [ ] **Step 2: Change poll interval from 30s to 5s**

Find `setInterval(_pollThunder, 30_000)` and change to:

```typescript
_thunderPollTimer = setInterval(_pollThunder, 5_000);
```

- [ ] **Step 3: Add `_totalThunderCount` helper and `_updateIdleThunderBadge`**

Add near the `_thunderCounts` declaration:

```typescript
/** Aggregate signal count across ALL owned names */
function _totalThunderCount(): number {
  let total = 0;
  for (const d of nsOwnedDomains) {
    if (d.kind !== 'nft') continue;
    const bare = d.name.replace(/\.sui$/, '').toLowerCase();
    total += _thunderCounts[bare] ?? 0;
  }
  return total;
}

/** Update the idle overlay thunder send button badge */
function _updateIdleThunderBadge(): void {
  if (!_idleOverlay) return;
  const sendBtn = _idleOverlay.querySelector('#ski-idle-thunder-send') as HTMLButtonElement | null;
  if (!sendBtn) return;
  const total = _totalThunderCount();
  if (total > 0) {
    // Quest mode: show count with storm cloud
    sendBtn.innerHTML = `\u26c8\ufe0f<span class="ski-idle-thunder-count">${total}</span>`;
    sendBtn.className = 'ski-idle-thunder-send ski-idle-thunder-send--quest';
    sendBtn.title = `Quest ${total} signal${total > 1 ? 's' : ''} across all names`;
    sendBtn.dataset.questMode = '1';
    sendBtn.dataset.questAll = '1';
    sendBtn.disabled = false;
  } else if (sendBtn.dataset.questAll === '1') {
    // Was in quest mode, now clear — reset to send mode
    sendBtn.innerHTML = '\u26a1';
    sendBtn.className = 'ski-idle-thunder-send';
    sendBtn.title = 'Send signal';
    delete sendBtn.dataset.questMode;
    delete sendBtn.dataset.questAll;
    sendBtn.disabled = false;
  }
}
```

- [ ] **Step 4: Call `_updateIdleThunderBadge` on overlay creation**

In `_showIdleOverlay`, after the overlay is appended to the DOM (after `(headerEl || document.body).appendChild(_idleOverlay)`), add:

```typescript
_updateIdleThunderBadge();
```

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts
git commit -m "feat: poll chronicom every 5s, aggregate thunder badge across all names"
```

---

### Task 3: Idle Overlay — Quest All Names on First Action

**Files:**
- Modify: `src/ui.ts` (rework `_sendIdleThunder` quest branch to iterate all names)

- [ ] **Step 1: Rework the quest branch in `_sendIdleThunder` to handle all names**

Find the quest mode block in `_sendIdleThunder` (around line 9658) and replace the quest branch:

```typescript
if (sendBtn?.dataset.questMode === '1') {
  // Quest ALL names with pending signals
  const isQuestAll = sendBtn.dataset.questAll === '1';
  sendBtn.innerHTML = '\u2026';
  sendBtn.disabled = true;
  try {
    const ws = getState();
    if (!ws.address) return;
    const { decryptAndQuest, getThunderCountsBatch } = await import('./client/thunder.js');

    // Build list of names to quest
    const toQuest: { name: string; nftId: string; count: number }[] = [];
    if (isQuestAll) {
      for (const d of nsOwnedDomains) {
        if (d.kind !== 'nft') continue;
        const bare = d.name.replace(/\.sui$/, '').toLowerCase();
        const c = _thunderCounts[bare] ?? 0;
        if (c > 0) toQuest.push({ name: bare, nftId: d.objectId, count: c });
      }
    } else {
      const questName = sendBtn.dataset.questName || '';
      if (!questName) return;
      const nftEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === questName.toLowerCase());
      if (!nftEntry) { showToast('NFT not found'); return; }
      toQuest.push({ name: questName, nftId: nftEntry.objectId, count: _thunderCounts[questName.toLowerCase()] ?? 1 });
    }

    if (toQuest.length === 0) { showToast('No signals to quest'); sendBtn.innerHTML = '\u26a1'; sendBtn.disabled = false; return; }

    let totalDecrypted = 0;
    const _myLog = app.suinsName?.replace(/\.sui$/, '') || toQuest[0].name;

    for (const { name, nftId, count } of toQuest) {
      try {
        const payloads = await decryptAndQuest(ws.address, name, nftId, count, async (txBytes) => {
          const { digest, effects } = await signAndExecuteTransaction(txBytes);
          return { digest: digest || '', effects };
        });
        for (const p of payloads) {
          const _pSender = p.sender || p.senderAddress.slice(0, 8);
          _freshQuestTs.add(Date.now());
          await _storeThunderLocal(_myLog, _pSender, p.message, 'in', _pSender, p.senderAddress);
        }
        totalDecrypted += payloads.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('reject')) showToast(`${name}: ${msg}`);
      }
    }

    // Refresh all counts
    const allNames = toQuest.map(q => q.name);
    const freshCounts = await getThunderCountsBatch(allNames);
    for (const [bare, count] of Object.entries(freshCounts)) {
      _thunderCounts[bare] = count;
    }
    try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
    await _refreshThunderLocalCounts();

    // Show conversation for the first quested name
    if (toQuest.length > 0) _expandIdleConvo(toQuest[0].name);

    // Reset button
    _updateIdleThunderBadge();
    sendBtn.disabled = false;
    if (totalDecrypted > 0) showToast(`\u26a1 ${totalDecrypted} signal${totalDecrypted > 1 ? 's' : ''} decrypted`);
  } catch (err) {
    sendBtn.innerHTML = '\u26c8\ufe0f';
    sendBtn.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('reject')) showToast(msg);
  }
  return;
}
```

- [ ] **Step 2: Update the initial quest mode activation in overlay creation**

Find the existing quest mode activation block (around line 9378-9420) that only activates for the currently viewed name. Replace with a check that activates quest mode based on the aggregate count:

```typescript
// Activate quest mode if ANY owned name has pending signals
const _totalPending = _totalThunderCount();
if (_totalPending > 0) {
  const sendBtn = _idleOverlay?.querySelector('#ski-idle-thunder-send') as HTMLButtonElement | null;
  if (sendBtn) {
    sendBtn.innerHTML = `\u26c8\ufe0f<span class="ski-idle-thunder-count">${_totalPending}</span>`;
    sendBtn.className = 'ski-idle-thunder-send ski-idle-thunder-send--quest';
    sendBtn.title = `Quest ${_totalPending} signal${_totalPending > 1 ? 's' : ''} across all names`;
    sendBtn.dataset.questMode = '1';
    sendBtn.dataset.questAll = '1';
  }
  const thunderInput = _idleOverlay?.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
  if (thunderInput && !thunderInput.value) thunderInput.placeholder = `${_totalPending} signal${_totalPending > 1 ? 's' : ''} waiting...`;
  // Auto-expand conversation for the name with most signals
  const topName = nsOwnedDomains
    .filter(d => d.kind === 'nft')
    .map(d => ({ bare: d.name.replace(/\.sui$/, '').toLowerCase(), count: _thunderCounts[d.name.replace(/\.sui$/, '').toLowerCase()] ?? 0 }))
    .sort((a, b) => b.count - a.count)[0];
  if (topName && topName.count > 0) _expandIdleConvo(topName.bare);
}
```

- [ ] **Step 3: Make Enter key trigger quest when signals are pending**

In `_sendIdleThunder`, the existing flow already checks `sendBtn?.dataset.questMode === '1'` first. The global Enter handler (around line 10099) triggers `_idleActionBtn.click()` — but we also want Enter from the thunder input to quest instead of send when signals are pending.

Find the thunder input Enter handler:
```typescript
if (e.key === 'Enter') { e.preventDefault(); _sendIdleThunder(); }
```

This already calls `_sendIdleThunder` which checks quest mode first. No change needed here — the quest branch runs before the send branch.

- [ ] **Step 4: Commit**

```bash
git add src/ui.ts
git commit -m "feat: quest all names — decrypt signals across all owned SuiNS names"
```

---

### Task 4: CSS — Thunder Count Badge + Quest Styling

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Add thunder count badge styles**

After the existing `.ski-idle-thunder-send--quest:hover` rule, add:

```css
.ski-idle-thunder-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 2px;
  border-radius: 999px;
  background: rgba(77, 162, 255, 0.4);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace;
  line-height: 1;
  animation: ski-thunder-pulse 2s ease-in-out infinite;
}

@keyframes ski-thunder-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/styles.css
git commit -m "feat: thunder count badge with pulse animation"
```

---

### Task 5: Deploy and Verify

**Files:** None (deployment only)

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: No errors, `ski.js` in `public/dist/`

- [ ] **Step 2: Deploy**

Run: `npx wrangler deploy`
Expected: Success, Chronicom DO listed in bindings output

- [ ] **Step 3: Verify chronicom endpoint**

Open browser: `https://sui.ski/api/thunder/chronicom?addr=0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3&names=ultron`
Expected: JSON response with counts (e.g., `{"ultron": 0}`)

- [ ] **Step 4: Verify idle overlay**

1. Connect wallet on sui.ski
2. Wait for idle overlay to appear
3. If any owned names have pending signals: button should show ⛈️ with count badge
4. If no signals: button should show ⚡
5. Press Enter or click ⛈️ button: should trigger quest/decrypt for all names with signals

- [ ] **Step 5: Commit if any fixes needed, then final deploy**

```bash
bun run build && npx wrangler deploy
```
