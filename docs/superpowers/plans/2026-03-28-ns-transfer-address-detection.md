# NS Transfer Button + Address Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add address detection in the NS input (full 66-char Sui hex → SEND mode) and a green transfer button on the target row for owned names that opens a recipient input and transfers the SuinsRegistration NFT.

**Architecture:** Two independent features layered into the existing NS input system in `src/ui.ts`. Feature 1 extends the `input` event handler with a 66-char hex check. Feature 2 adds a green button to `_nsRouteHtml()` (the target row renderer), with new module state (`nsTransferInputOpen`, `nsTransferRecipient`) and a new `buildTransferNftTx()` PTB builder in `src/suins.ts`. Both features reuse existing patterns (paste handler for address detection, `nsShowTargetInput` for inline editor).

**Tech Stack:** TypeScript, `@mysten/sui` v2.5.0 Transaction builder, existing `fetchOwnedDomains` / `resolveSuiNSName` helpers, Cloudflare Workers deploy via `npx wrangler deploy`.

---

### Task 1: Address Detection in NS Input

**Files:**
- Modify: `src/ui.ts:6137-6186` (nsInput `input` event handler)

- [ ] **Step 1: Update the input handler's hex guard to handle full 66-char addresses**

In `src/ui.ts`, the `input` handler at ~line 6137 currently has a broad guard that returns early for any hex-like input:

```ts
// Current code (line 6141-6145):
// Detect Sui hex address typed/pasted into the name input
if (/^0x[0-9a-f]{20,64}$/i.test(val)) {
  // Handled by paste event — skip here to avoid double-processing
  return;
}
```

Replace this guard with logic that only skips partial hex (let paste handler deal with those) but handles the full 66-char address inline:

```ts
// Detect Sui hex address typed/pasted into the name input
if (/^0x[0-9a-f]+$/i.test(val)) {
  // Full 66-char Sui address — set as target, switch to SEND mode
  if (val.length === 66 && /^0x[0-9a-f]{64}$/i.test(val)) {
    nsTargetAddress = val;
    nsLabel = val;
    nsAvail = null;
    nsPriceUsd = null;
    nsPriceFetchFor = '';
    try { localStorage.setItem('ski:ns-label', ''); } catch {}
    _patchNsRoute();
    _patchNsStatus();
    _patchNsPrice();
    // Hide .sui and price chip for hex display
    const dotSui = document.querySelector('.wk-ns-dot-sui') as HTMLElement | null;
    const priceChip = document.getElementById('wk-ns-price-chip');
    const regBtn = document.getElementById('wk-dd-ns-register') as HTMLElement | null;
    const sendBtnNs = document.getElementById('wk-send-btn') as HTMLElement | null;
    if (dotSui) dotSui.style.display = 'none';
    if (priceChip) priceChip.style.display = 'none';
    if (regBtn) regBtn.style.display = 'none';
    if (sendBtnNs) sendBtnNs.style.display = '';
    // Reverse-resolve — if found, replace hex with the SuiNS name
    const _hexVal = val;
    lookupSuiNS(_hexVal).then((name: string | null) => {
      if (name && nsLabel === _hexVal) {
        const bare = name.replace(/\.sui$/, '');
        nsLabel = bare;
        try { localStorage.setItem('ski:ns-label', bare); } catch {}
        const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (inp) inp.value = bare;
        if (dotSui) dotSui.style.display = '';
        if (priceChip) priceChip.style.display = '';
        fetchAndShowNsPrice(bare);
      }
    });
  }
  // Partial hex (< 66 chars) — skip, let paste handler or further typing complete it
  return;
}
```

Key differences from paste handler:
- Only triggers at exactly 66 chars (`val.length === 66`), not 20-64 range
- Captures `_hexVal` for the async closure's stale-check (`nsLabel === _hexVal`)
- Partial hex still returns early (no name resolution attempted)

- [ ] **Step 2: Verify manually**

Build and deploy:
```bash
cd /home/brandon/Dev/Sui-Dev/Projects/SKI && bun run build && npx wrangler deploy
```

Test in browser:
1. Type a partial hex `0x1234` → nothing happens (black diamond, no SEND mode) ✓
2. Paste/type a full 66-char address → `.sui` hides, SEND button appears ✓
3. If the address has a SuiNS name, input auto-replaces with the name ✓

- [ ] **Step 3: Commit**

```bash
git add src/ui.ts
git commit -m "feat: detect full 66-char Sui addresses in NS input, switch to SEND mode"
```

---

### Task 2: Green Transfer Button — State & HTML

**Files:**
- Modify: `src/ui.ts:3148-3153` (module state declarations)
- Modify: `src/ui.ts:3484-3495` (end of `_nsRouteHtml` / `_nsTargetRowHtml` — target row rendering)
- Modify: `public/styles.css:1893` (after green target row styles)

- [ ] **Step 1: Add module state variables**

After `nsNewTargetAddr` at line 3153, add:

```ts
let nsTransferInputOpen = false; // transfer-recipient inline editor open
let nsTransferRecipient = ''; // value in the transfer-recipient input
```

- [ ] **Step 2: Add green transfer button to target row HTML**

In `_nsRouteHtml()` at line 3495, the return statement builds the target row. When the name is owned (`canEditTarget` is true), append a green transfer button after the `extra` span:

Replace the final return (line 3492-3495):

```ts
  const isDim = colorClass === 'wk-ns-target-row--dim';
  const rowCls = isDim ? 'wk-ns-target-row--toggle' : 'wk-ns-target-row--copy';
  const rowTitle = isDim ? 'Show names' : `Copy Target ${shortAddr}`;
  return `<div class="wk-ns-target-row ${colorClass} ${rowCls}"${isDim ? '' : ` data-copy-target="${esc(displayAddr)}"`} title="${rowTitle}"><span class="wk-ns-target-icon${canEditTarget ? ' wk-ns-target-icon--editable' : ''}"${iconId}${iconTitle}>\u25ce</span><span class="wk-ns-target-addr">${shortAddr}</span>${extra}</div>`;
```

With:

```ts
  // Transfer input mode — replace target row with recipient input
  if (nsTransferInputOpen && canEditTarget) {
    return `<div class="wk-ns-target-row wk-ns-target-row--green wk-ns-target-row--transfer-input">
      <input id="wk-ns-transfer-input" class="wk-ns-transfer-input" type="text" value="${esc(nsTransferRecipient)}" placeholder="name.sui or 0x…" spellcheck="false" autocomplete="off">
      <button id="wk-ns-transfer-submit" class="wk-ns-transfer-submit" type="button" title="Transfer NFT">\u2192</button>
      <button id="wk-ns-transfer-cancel" class="wk-ns-transfer-cancel" type="button" title="Cancel">\u2715</button>
    </div>`;
  }

  const isDim = colorClass === 'wk-ns-target-row--dim';
  const rowCls = isDim ? 'wk-ns-target-row--toggle' : 'wk-ns-target-row--copy';
  const rowTitle = isDim ? 'Show names' : `Copy Target ${shortAddr}`;
  const transferBtn = canEditTarget ? `<button id="wk-ns-transfer-btn" class="wk-ns-transfer-btn" type="button" title="Transfer ${esc(nsLabel)}.sui NFT">\u27a4</button>` : '';
  return `<div class="wk-ns-target-row ${colorClass} ${rowCls}"${isDim ? '' : ` data-copy-target="${esc(displayAddr)}"`} title="${rowTitle}"><span class="wk-ns-target-icon${canEditTarget ? ' wk-ns-target-icon--editable' : ''}"${iconId}${iconTitle}>\u25ce</span><span class="wk-ns-target-addr">${shortAddr}</span>${extra}${transferBtn}</div>`;
```

- [ ] **Step 3: Add CSS for transfer button and input**

In `public/styles.css`, after the green target row styles (~line 1893), add:

```css
/* Transfer button — green arrow on owned name target row */
.wk-ns-transfer-btn {
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: rgba(34, 197, 94, 0.9);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  flex-shrink: 0;
  margin-left: auto;
  transition: all 0.15s;
}
.wk-ns-transfer-btn:hover {
  background: rgba(34, 197, 94, 0.25);
  border-color: rgba(34, 197, 94, 0.5);
}
/* Transfer recipient input row */
.wk-ns-target-row--transfer-input {
  gap: 4px;
}
.wk-ns-transfer-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: rgba(34, 197, 94, 0.9);
  font-family: inherit;
  font-size: 0.83rem;
  font-weight: 500;
  min-width: 0;
}
.wk-ns-transfer-input::placeholder {
  color: rgba(34, 197, 94, 0.4);
}
.wk-ns-transfer-submit {
  background: rgba(34, 197, 94, 0.2);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: rgba(34, 197, 94, 0.9);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  flex-shrink: 0;
}
.wk-ns-transfer-submit:hover { background: rgba(34, 197, 94, 0.35); }
.wk-ns-transfer-cancel {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.5);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 0.75rem;
  cursor: pointer;
  flex-shrink: 0;
}
.wk-ns-transfer-cancel:hover { color: rgba(255, 255, 255, 0.8); }
```

- [ ] **Step 4: Commit**

```bash
git add src/ui.ts public/styles.css
git commit -m "feat: green transfer button on owned name target row with inline recipient input"
```

---

### Task 3: Transfer Button Event Wiring

**Files:**
- Modify: `src/ui.ts:6209-6288` (route area click delegation handler)

- [ ] **Step 1: Add transfer button click → open input**

In the route area click handler (`document.getElementById('wk-ns-route')?.addEventListener('click', ...)`) at ~line 6209, add handlers for the new transfer button elements. Insert before the existing target-cancel handler (~line 6271):

```ts
    // Transfer button — open recipient input
    if (target.id === 'wk-ns-transfer-btn') {
      e.stopPropagation();
      nsTransferInputOpen = true;
      nsTransferRecipient = '';
      _patchNsRoute();
      // Auto-focus the input
      setTimeout(() => {
        const inp = document.getElementById('wk-ns-transfer-input') as HTMLInputElement | null;
        if (inp) inp.focus();
      }, 50);
      return;
    }
    // Transfer cancel
    if (target.id === 'wk-ns-transfer-cancel') {
      e.stopPropagation();
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      _patchNsRoute();
      return;
    }
```

- [ ] **Step 2: Add input/keydown delegation for transfer input**

In the existing route area `input` handler (~line 6291), add alongside the existing `wk-ns-target-input` check:

```ts
    if (target.id === 'wk-ns-transfer-input') {
      nsTransferRecipient = (target as HTMLInputElement).value.trim();
    }
```

In the existing route area `keydown` handler (~line 6297), add alongside the existing checks:

```ts
    if (target.id === 'wk-ns-transfer-input' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-ns-transfer-submit')?.click();
    }
    if (target.id === 'wk-ns-transfer-input' && (e as KeyboardEvent).key === 'Escape') {
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      _patchNsRoute();
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/ui.ts
git commit -m "feat: wire transfer button click, input, and keyboard events"
```

---

### Task 4: buildTransferNftTx PTB Builder

**Files:**
- Modify: `src/suins.ts` (add `buildTransferNftTx` export, after `buildSendTx` at ~line 2427)

- [ ] **Step 1: Add the transfer builder function**

After `buildSendTx` in `src/suins.ts` (~line 2427), add:

```ts
/**
 * Build a transaction that transfers a SuinsRegistration NFT to a recipient.
 * Looks up the NFT object ID from owned domains, then does transferObjects.
 */
export async function buildTransferNftTx(
  senderAddress: string,
  domain: string,
  recipientAddress: string,
): Promise<Uint8Array> {
  const sender = normalizeSuiAddress(senderAddress);
  const recipient = normalizeSuiAddress(recipientAddress);
  if (sender === recipient) throw new Error('Recipient matches sender — cannot transfer to self');

  // Find the NFT object for this domain
  const owned = await fetchOwnedDomains(sender);
  const fullDomain = domain.endsWith('.sui') ? domain : `${domain}.sui`;
  const nft = owned.find(d => d.name === fullDomain && d.kind === 'nft');
  if (!nft) throw new Error(`No SuinsRegistration NFT found for ${fullDomain}`);
  if (nft.inKiosk) throw new Error(`${fullDomain} is listed in a kiosk — delist first`);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects(
    [tx.object(nft.objectId)],
    tx.pure.address(recipient),
  );

  return tx.build({ client: gqlClient as never });
}
```

- [ ] **Step 2: Add the export to the import line in ui.ts**

In `src/ui.ts` line 43, the long import from `./suins.js` — add `buildTransferNftTx` to the import list:

Find in the existing import:
```ts
} from './suins.js';
```

Add `buildTransferNftTx` to the destructured imports (alongside the other `build*` functions).

- [ ] **Step 3: Commit**

```bash
git add src/suins.ts src/ui.ts
git commit -m "feat: buildTransferNftTx PTB builder for SuinsRegistration NFT transfer"
```

---

### Task 5: Transfer Submit Handler

**Files:**
- Modify: `src/ui.ts:6309-6378` (route area click delegation — add transfer-submit handler)

- [ ] **Step 1: Add transfer-submit click handler**

In the route area click handler, add a handler for `wk-ns-transfer-submit`. Insert in the same click delegation block where the transfer-btn and transfer-cancel handlers were added (Task 3). Best placed right after the transfer-cancel handler:

```ts
  // Transfer-submit uses click delegation (button is created dynamically by _patchNsRoute)
  let _transferSubmitBusy = false;
  document.getElementById('wk-ns-route')?.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id !== 'wk-ns-transfer-submit') return;
    ev.stopPropagation();
    if (_transferSubmitBusy) return;
    const ws2 = getState();
    if (!ws2.address) return;
    let addr = nsTransferRecipient.trim();
    if (!addr) { showToast('Enter a recipient address or name'); return; }
    const submitBtn = document.getElementById('wk-ns-transfer-submit') as HTMLButtonElement | null;
    _transferSubmitBusy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u2026'; }
    try {
      // Resolve SuiNS name to address if input isn't a hex address
      if (!/^0x[0-9a-fA-F]{64}$/.test(addr)) {
        const namePart = addr.replace(/\.sui$/i, '').toLowerCase();
        if (namePart.length < 3 || !/^[a-z0-9-]+$/.test(namePart)) {
          showToast('Enter a valid Sui address (0x…) or SuiNS name');
          return;
        }
        const resolved = await resolveSuiNSName(namePart);
        if (!resolved) {
          showToast(`${namePart}.sui doesn't resolve to an address`);
          return;
        }
        addr = resolved;
      }

      const label = nsLabel.trim();
      const domain = label.endsWith('.sui') ? label : `${label}.sui`;
      const txBytes = await buildTransferNftTx(ws2.address, domain, addr);
      await signAndExecuteTransaction(txBytes);

      const short = addr.slice(0, 6) + '\u2026' + addr.slice(-4);
      showToast(`Transferred ${domain} to ${short} \u2713`);

      // Clean up state
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      nsOwnedFetchedFor = ''; // force re-fetch owned domains
      nsOwnedDomains = nsOwnedDomains.filter(d => d.name !== domain);
      _cacheOwnedDomains(ws2.address, nsOwnedDomains);
      nsAvail = null;
      nsTargetAddress = null;
      nsNftOwner = null;
      _patchNsRoute();
      _patchNsStatus();
      _patchNsOwnedList();

      // Background refresh
      fetchOwnedDomains(ws2.address).then(domains => {
        nsOwnedDomains = domains;
        nsOwnedFetchedFor = ws2.address;
        _cacheOwnedDomains(ws2.address, domains);
        _patchNsOwnedList();
      }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transfer failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      _transferSubmitBusy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '\u2192'; }
    }
  });
```

**Important:** This new click listener must be registered as a *separate* `addEventListener('click', ...)` on `wk-ns-route` (same pattern as the existing target-submit handler at line 6311). The `_transferSubmitBusy` lock prevents double-clicks, matching the existing `_targetSubmitBusy` pattern.

- [ ] **Step 2: Reset transfer state in _clearNsInput and disconnect**

Find where `nsShowTargetInput = false` is reset (lines 6272, 6304, 6352, 7223). In each of those blocks, add alongside it:

```ts
nsTransferInputOpen = false;
nsTransferRecipient = '';
```

This ensures the transfer input closes when the NS input is cleared, or on disconnect.

- [ ] **Step 3: Commit**

```bash
git add src/ui.ts
git commit -m "feat: transfer submit handler — resolves recipient, transfers NFT, refreshes state"
```

---

### Task 6: Build, Deploy, and Manual Test

**Files:** None (verification only)

- [ ] **Step 1: Build**

```bash
cd /home/brandon/Dev/Sui-Dev/Projects/SKI && bun run build
```

Expected: No TypeScript errors, bundle produced in `public/dist/`.

- [ ] **Step 2: Deploy**

```bash
npx wrangler deploy
```

Expected: Successful deploy to Cloudflare Workers.

- [ ] **Step 3: Manual test — address detection**

In browser at sui.ski:
1. Sign in with a wallet
2. In NS input, type a full 66-char Sui address character by character → at 66 chars, `.sui` hides, target row shows the address, SEND button activates
3. If address has a SuiNS name, input auto-resolves to the name
4. Type partial hex `0x1234abcd` → stays as black diamond, no SEND mode switch

- [ ] **Step 4: Manual test — transfer button**

1. Type an owned SuiNS name → purple target row appears
2. Green `➤` button visible at right end of target row
3. Click green button → row transforms to input with green border, placeholder "name.sui or 0x…"
4. Type a SuiNS name → hit Enter → resolves name, builds transfer tx, wallet prompts for signature
5. Press Escape → cancels, returns to normal target row
6. (Optional) Actually execute a transfer to verify the PTB works end-to-end

- [ ] **Step 5: Commit final state if any fixes needed**

```bash
git add -A && git commit -m "fix: address any issues found during manual testing"
```

Only if fixes were needed. Skip if everything worked.
