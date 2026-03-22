# SKI Component Refactor — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor SKI's monolithic `ui.ts` (5,632 lines) and `styles.css` (4,002 lines) into composable Custom Elements (`ski-*`) with CSS layer isolation, so any page can mount SKI components without style conflicts.

**Architecture:** Singleton `SkiContext` holds all shared state with selector-based pub/sub. Each `ski-*` Custom Element subscribes to its relevant state slice and self-renders. CSS wrapped in `@layer ski { ... }` and auto-injected on first element mount.

**Tech Stack:** Vanilla TypeScript, Custom Elements API, `@layer` CSS, Bun bundler, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-10-ski-component-refactor-design.md`

---

## Chunk 1: Foundation Layer

### Task 1: Rename `wallet.ts` → `adapter.ts`

**Files:**
- Rename: `src/wallet.ts` → `src/adapter.ts`
- Modify: `src/ski.ts` (update import path)
- Modify: `src/ui.ts` (update import path — temporary, ui.ts gets deleted later)

- [ ] **Step 1: Rename the file**

```bash
mv src/wallet.ts src/adapter.ts
```

- [ ] **Step 2: Update import in `src/ski.ts`**

Change line 12:
```ts
// FROM:
import { getState, signPersonalMessage, signAndExecuteTransaction, signTransaction, getSuiWallets, connect, disconnect } from './wallet.js';
// TO:
import { getState, signPersonalMessage, signAndExecuteTransaction, signTransaction, getSuiWallets, connect, disconnect } from './adapter.js';
```

- [ ] **Step 3: Update import in `src/ui.ts`**

Change line 12-27:
```ts
// FROM:
} from './wallet.js';
// TO:
} from './adapter.js';
```

- [ ] **Step 4: Search for any other `./wallet.js` imports and update them**

```bash
grep -rn "from './wallet.js'" src/ --include='*.ts'
```

Update each hit to `'./adapter.js'`.

- [ ] **Step 5: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: rename wallet.ts to adapter.ts"
```

---

### Task 2: Extract SVGs into `icons.ts`

**Files:**
- Create: `src/icons.ts`
- Read: `src/ui.ts` lines 43-80 (SVG imports and social icons)

Extract all inline SVG strings and imported SVG assets from `ui.ts` into a dedicated module with human-readable names.

- [ ] **Step 1: Identify all SVGs in `ui.ts`**

From `ui.ts`, the following SVGs need extraction:
- Lines 43-45: `SKI_SVG_TEXT`, `SUI_DROP_SVG_TEXT`, `SUI_SKI_QR_SVG_TEXT` (imported from files)
- Lines 54-56: `SUI_DROP_URI`, `SKI_SVG_URI`, `SUI_SKI_QR_URI` (data URIs)
- Lines 64-73: `SOCIAL_ICON_X`, `SOCIAL_ICON_GOOGLE`, `SOCIAL_ICON_DISCORD`, `SOCIAL_ICON_EMAIL`
- Lines 76-108: `socialIconSvg()`, `detectWaapProvider()`, `storeWaapProvider()`, `waapProviderIcon()`

Also scan for other inline SVGs deeper in the file (copy icon, chevrons, disconnect icon, etc.).

```bash
grep -n 'svg\|SVG' src/ui.ts | head -60
```

- [ ] **Step 2: Create `src/icons.ts`**

```ts
// src/icons.ts — Named SVG exports for all inline icons used across SKI elements.

import SKI_SVG_TEXT from '../public/assets/ski.svg';
import SUI_DROP_SVG_TEXT from '../public/assets/sui-drop.svg';
import SUI_SKI_QR_SVG_TEXT from '../public/assets/sui-ski-qr.svg';

// ─── Data URIs ────────────────────────────────────────────────────────
export const SUI_DROP_URI = `data:image/svg+xml,${encodeURIComponent(SUI_DROP_SVG_TEXT)}`;
export const SKI_SVG_URI  = `data:image/svg+xml,${encodeURIComponent(SKI_SVG_TEXT)}`;
export const SUI_SKI_QR_URI = `data:image/svg+xml,${encodeURIComponent(SUI_SKI_QR_SVG_TEXT)}`;

// Re-export raw text for SVG manipulation (dot variants, lift toggle)
export { SKI_SVG_TEXT };

// ─── Social provider icons ───────────────────────────────────────────
const _fca = `style="forced-color-adjust:none;-webkit-forced-color-adjust:none"`;

export const socialIconX = `<svg width="38" height="38" ...>`;       // Copy full SVG from ui.ts:64
export const socialIconGoogle = `<svg width="38" height="38" ...>`;   // Copy full SVG from ui.ts:67
export const socialIconDiscord = `<svg width="38" height="38" ...>`;  // Copy full SVG from ui.ts:70
export const socialIconEmail = `<svg width="38" height="38" ...>`;    // Copy full SVG from ui.ts:73

// ─── Social provider helpers ─────────────────────────────────────────

export function socialIconSvg(walletName: string): string | null {
  // Copy from ui.ts:76-81
}

export function detectWaapProvider(label: string): 'google' | 'x' | 'email' | null {
  // Copy from ui.ts:84-90
}

export function storeWaapProvider(address: string, provider: 'google' | 'x' | 'email' | null): void {
  // Copy from ui.ts:93-96
}

export function waapProviderIcon(address: string | null): string {
  // Copy from ui.ts:99-108
}

// ─── Inline icons used throughout elements ───────────────────────────
// Scan ui.ts for all other inline SVGs (copy, chevron, disconnect, etc.)
// and export them here with descriptive names.
```

**Implementation note:** The actual SVG strings are very long. Copy them verbatim from `ui.ts`. The agent implementing this task must read the full `ui.ts` to find ALL inline SVGs — there are many scattered throughout the 5,632 lines (in `renderSkiMenu`, `renderModal`, etc.).

- [ ] **Step 3: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

Expected: Build succeeds. `icons.ts` is not yet imported by anything but should compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/icons.ts && git commit -m "refactor: extract SVGs into icons.ts"
```

---

### Task 3: Create `styles.ts` — CSS layer migration

**Files:**
- Create: `src/styles.ts`
- Read: `public/styles.css` (4,002 lines)

Migrate all CSS into a TypeScript template literal wrapped in `@layer ski { ... }`. Rename CSS custom properties from `--bg` to `--ski-bg` etc.

- [ ] **Step 1: Read `public/styles.css` and understand the structure**

Key sections to identify:
- `:root` custom properties (lines ~1-10)
- Global resets (`*`, `body`)
- Component-specific rules (`.ski-*`, `.wk-*`, `.stage-*`, `.splash-*`)
- Animations (`@keyframes`)
- Media queries

- [ ] **Step 2: Create `src/styles.ts`**

```ts
// src/styles.ts — All SKI styles, wrapped in @layer ski for cascade isolation.

export const skiStyles = `
@layer ski {
  /* ─── Custom properties (scoped to ski elements) ─────────────── */
  :root {
    --ski-bg: #05070d;
    --ski-panel: rgba(12, 14, 22, 0.92);
    --ski-text: #e6ebf5;
    --ski-muted: #9ca7bb;
    --ski-border: rgba(163, 184, 211, 0.24);
    /* ... migrate ALL :root vars, prefixing with --ski- ... */
  }

  /* ─── Component styles ───────────────────────────────────────── */
  /* Copy ALL rules from styles.css, keeping ski-* prefixed class names.
     Remove global resets (* { box-sizing }, body { margin }) — those
     belong to the host page, not SKI.

     Scope bare element selectors to ski-* elements:
       button { ... }  →  ski-modal button { ... }
       input { ... }   →  ski-menu input { ... }
  */

  /* ... full CSS content ... */

  /* ─── Animations ─────────────────────────────────────────────── */
  @keyframes ski-modal-in { /* ... */ }
  /* ... */
}
`;

/** Inject SKI styles into <head> once. Called by first ski-* element to connect. */
export function injectStyles(): void {
  if (document.getElementById('ski-styles')) return;
  const style = document.createElement('style');
  style.id = 'ski-styles';
  style.textContent = skiStyles;
  document.head.appendChild(style);
}
```

**Critical rules for migration:**
1. Remove `* { box-sizing }` and `body { ... }` resets — host page owns those
2. Rename `--bg` → `--ski-bg`, `--text` → `--ski-text`, etc. throughout
3. Update all `var(--bg)` → `var(--ski-bg)` references
4. Scope bare element selectors: `button` → `[class*="ski-"] button` or use the specific parent
5. Keep all `@keyframes` inside the layer
6. Keep all `@media` queries inside the layer

- [ ] **Step 3: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

- [ ] **Step 4: Commit**

```bash
git add src/styles.ts && git commit -m "refactor: migrate CSS into styles.ts with @layer ski"
```

---

### Task 4: Create `context.ts` — Singleton state + pub/sub

**Files:**
- Create: `src/context.ts`
- Read: `src/ui.ts` lines 110-140 (AppState), `src/adapter.ts` (WalletState)

- [ ] **Step 1: Create `src/context.ts`**

```ts
// src/context.ts — Singleton SkiContext: shared state + selector-based pub/sub.

import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Wallet } from '@wallet-standard/base';
import type { WalletState } from './adapter.js';
import {
  getState as getWalletState,
  subscribe as walletSubscribe,
  connect as walletConnect,
  disconnect as walletDisconnect,
  autoReconnect,
  preloadStoredWallet,
} from './adapter.js';
import { injectStyles } from './styles.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface AppState {
  sui: number;
  usd: number | null;
  stableUsd: number;
  nsBalance: number;
  suinsName: string;
  ikaWalletId: string;
  copied: boolean;
  splashSponsor: boolean;
}

export interface UiState {
  menuOpen: boolean;
  modalOpen: boolean;
  modalLayout: 'splash' | 'list';
  toolsCollapsed: boolean;
}

export interface ToastOptions {
  isHtml?: boolean;
  duration?: number;
}

// ─── Subscription ─────────────────────────────────────────────────────

interface Subscription {
  selector: (ctx: SkiContext) => unknown;
  callback: (value: unknown) => void;
  lastValue: unknown;
}

// ─── Context ──────────────────────────────────────────────────────────

export class SkiContext {
  walletState: WalletState;
  appState: AppState;
  uiState: UiState;
  grpcClient: SuiGrpcClient;

  private subscriptions = new Set<Subscription>();
  private walletUnsub: (() => void) | null = null;
  private static instance: SkiContext | null = null;

  private constructor() {
    this.walletState = getWalletState();
    this.appState = {
      sui: 0,
      usd: null,
      stableUsd: 0,
      nsBalance: 0,
      suinsName: '',
      ikaWalletId: '',
      copied: false,
      splashSponsor: false,
    };
    this.uiState = {
      menuOpen: (() => { try { return localStorage.getItem('ski:lift') === '1'; } catch { return false; } })(),
      modalOpen: false,
      modalLayout: (() => { try { return (localStorage.getItem('ski:modal-layout') as 'splash' | 'list') || 'splash'; } catch { return 'splash' as const; } })(),
      toolsCollapsed: (() => { try { return localStorage.getItem('ski:tools-collapsed') === '1'; } catch { return false; } })(),
    };
    this.grpcClient = new SuiGrpcClient({
      network: 'mainnet',
      baseUrl: 'https://fullnode.mainnet.sui.io:443',
    });
  }

  /** Get or create the singleton context. Injects styles on first call. */
  static init(): SkiContext {
    if (SkiContext.instance) return SkiContext.instance;
    injectStyles();
    const ctx = new SkiContext();
    // Bridge wallet state changes into context
    ctx.walletUnsub = walletSubscribe((ws) => {
      ctx.walletState = ws;
      ctx.notify();
    });
    // Preload stored wallet for instant UI
    preloadStoredWallet();
    ctx.walletState = getWalletState();
    // Auto-reconnect (non-blocking)
    autoReconnect().catch(() => {});
    SkiContext.instance = ctx;
    return ctx;
  }

  /** Subscribe with a selector. Callback fires only when selected value changes. */
  subscribe<T>(selector: (ctx: SkiContext) => T, callback: (value: T) => void): () => void {
    const sub: Subscription = {
      selector: selector as (ctx: SkiContext) => unknown,
      callback: callback as (value: unknown) => void,
      lastValue: selector(this),
    };
    this.subscriptions.add(sub);
    return () => this.subscriptions.delete(sub);
  }

  /** Update app state and notify subscribers. */
  updateAppState(patch: Partial<AppState>): void {
    Object.assign(this.appState, patch);
    this.notify();
  }

  /** Update UI state and notify subscribers. */
  updateUiState(patch: Partial<UiState>): void {
    Object.assign(this.uiState, patch);
    this.notify();
  }

  // ─── Actions ──────────────────────────────────────────────────────

  async connect(wallet: Wallet): Promise<void> {
    await walletConnect(wallet);
  }

  disconnect(): void {
    walletDisconnect();
  }

  openModal(): void {
    this.updateUiState({ modalOpen: true });
  }

  closeModal(): void {
    this.updateUiState({ modalOpen: false });
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private notify(): void {
    for (const sub of this.subscriptions) {
      const newValue = sub.selector(this);
      if (newValue !== sub.lastValue) {
        sub.lastValue = newValue;
        sub.callback(newValue);
      }
    }
  }
}

// ─── Convenience exports ────────────────────────────────────────────

export function getContext(): SkiContext {
  return SkiContext.init();
}
```

- [ ] **Step 2: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

- [ ] **Step 3: Commit**

```bash
git add src/context.ts && git commit -m "feat: add SkiContext singleton with selector-based pub/sub"
```

---

### Task 4b: Fix selector equality in `SkiContext`

The `subscribe` method's `notify()` uses `!==` to compare selector results. Selectors that return object literals (e.g., `{ address, suinsName }`) create new objects every call, so `!==` always returns `true` — every subscriber fires on every state change.

**Fix:** Use shallow-equal comparison instead of reference equality.

- [ ] **Step 1: Add shallow-equal helper to `context.ts`**

```ts
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}
```

- [ ] **Step 2: Update `notify()` to use `shallowEqual`**

```ts
private notify(): void {
  for (const sub of this.subscriptions) {
    const newValue = sub.selector(this);
    if (!shallowEqual(newValue, sub.lastValue)) {
      sub.lastValue = newValue;
      sub.callback(newValue);
    }
  }
}
```

- [ ] **Step 3: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/context.ts && git commit -m "fix: use shallow-equal in SkiContext selector comparison"
```

---

### Task 4c: Add missing fields to `SkiContext`

The spec requires `sponsorState`, `signIn()`, `showToast()`, and `transport` on `SkiContext`. Add them.

- [ ] **Step 1: Add `sponsorState` field**

```ts
import { getSponsorState, subscribeSponsor, type SponsorState } from './sponsor.js';

// In constructor:
this.sponsorState = getSponsorState();

// In init(), after wallet subscribe:
subscribeSponsor(() => {
  ctx.sponsorState = getSponsorState();
  ctx.notify();
});
```

- [ ] **Step 2: Add `transport` field**

```ts
import { SuiGraphQLClient } from '@mysten/sui/graphql';

// Add to class:
transport: SuiGrpcClient | SuiGraphQLClient;

// In constructor:
this.transport = this.grpcClient; // starts as gRPC, fallback sets to GraphQL
```

- [ ] **Step 3: Add `signIn()` method**

`signIn` lives in `ski.ts` and depends on session logic. Rather than moving it, expose it via a callback:

```ts
// In SkiContext class:
private _signIn: (() => Promise<boolean>) | null = null;

/** Register the signIn implementation (called by ski.ts on boot). */
registerSignIn(fn: () => Promise<boolean>): void {
  this._signIn = fn;
}

async signIn(): Promise<boolean> {
  if (!this._signIn) return false;
  return this._signIn();
}
```

In `ski.ts`, after context init:
```ts
getContext().registerSignIn(() => signIn());
```

- [ ] **Step 4: Add `showToast()` convenience method**

```ts
import { showToast as _showToast } from './elements/ski-toast.js';

showToast(msg: string, opts?: ToastOptions): void {
  _showToast(msg, opts?.isHtml);
}
```

- [ ] **Step 5: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/context.ts && git commit -m "feat: add sponsorState, transport, signIn, showToast to SkiContext"
```

---

## Chunk 2: Simple Elements

### Task 5: Create `ski-toast`

**Files:**
- Create: `src/elements/ski-toast.ts`
- Read: `src/ui.ts` lines 209-389 (all toast functions)

- [ ] **Step 1: Create `src/elements/` directory**

```bash
mkdir -p src/elements
```

- [ ] **Step 2: Create `src/elements/ski-toast.ts`**

This element is body-appended and doesn't render into a specific mount point. It provides the toast API used by other elements and the context.

```ts
// src/elements/ski-toast.ts — Toast notification system.
// Appends a toast root to <body> and manages toast lifecycle.
// Not a visible Custom Element in the traditional sense — it's
// a service element that provides showToast/showToastWithRetry.

import { injectStyles } from '../styles.js';

let toastSeq = 0;

function ensureRoot(position: 'bottom' | 'top' = 'bottom'): HTMLElement {
  const id = position === 'top' ? 'ski-toast-root-top' : 'ski-toast-root';
  let root = document.getElementById(id);
  if (!root) {
    injectStyles();
    root = document.createElement('div');
    root.id = id;
    root.className = position === 'top'
      ? 'ski-toast-root ski-toast-root--top'
      : 'ski-toast-root';
    document.body.appendChild(root);
  }
  return root;
}

export function showToast(msg: string, isHtml = false): void {
  // Copy logic from ui.ts:213-233
}

export function showCopyableToast(display: string, fullText: string, durationMs = 8000): void {
  // Copy logic from ui.ts:236-278
}

export function showBackpackLockedToast(): void {
  // Copy logic from ui.ts:291-358
  // Import getState from adapter.ts for walletIcon
}

export function showToastWithRetry(msg: string, retryLabel: string, retryFn: () => void): void {
  // Copy logic from ui.ts:361-388
}
```

**Implementation note:** Copy the toast functions verbatim from `ui.ts`. Update CSS class names if any were renamed during the `styles.ts` migration (e.g., `app-toast-root` → `ski-toast-root` if that rename happened). The toast functions are standalone — they don't depend on any other element.

- [ ] **Step 3: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

- [ ] **Step 4: Commit**

```bash
git add src/elements/ski-toast.ts && git commit -m "feat: extract toast system into ski-toast.ts"
```

---

### Task 6: Create `ski-dot` element

**Files:**
- Create: `src/elements/ski-dot.ts`
- Read: `src/ui.ts` — search for `renderModalLogo`, `updateSkiDot`, dot variant logic

- [ ] **Step 1: Create `src/elements/ski-dot.ts`**

```ts
// src/elements/ski-dot.ts — <ski-dot> status indicator.
// Shows green circle (new user), blue square (SuiNS), or black diamond (returning).

import { getContext, type SkiContext } from '../context.js';
import { SKI_SVG_TEXT } from '../icons.js';
import { injectStyles } from '../styles.js';

class SkiDot extends HTMLElement {
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        address: ctx.walletState.address,
        suinsName: ctx.appState.suinsName,
        modalOpen: ctx.uiState.modalOpen,
      }),
      () => this.render(),
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render() {
    // Determine variant based on state
    // Build SVG with correct dot variant
    // Set innerHTML
  }
}

customElements.define('ski-dot', SkiDot);
export { SkiDot };
```

**Implementation note:** The dot variant logic is scattered across `ui.ts` — find `getInlineSkiSvg`, `_buildSkiSvg`, `getPillSkiSvg`, `getSkiBtnSvg`, `updateSkiDot`, and `renderModalLogo`. Consolidate the variant determination (green-circle / blue-square / black-diamond) into this element.

- [ ] **Step 2: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

- [ ] **Step 3: Commit**

```bash
git add src/elements/ski-dot.ts && git commit -m "feat: add <ski-dot> custom element"
```

---

### Task 6b: Extract shared formatting helpers

**Files:**
- Create: `src/format.ts`
- Read: `src/ui.ts` lines 155-207

Extract helpers needed by multiple elements (`ski-balance`, `ski-profile`, `ski-menu`, `ski-modal`).

- [ ] **Step 1: Create `src/format.ts`**

```ts
// src/format.ts — Shared formatting utilities.

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function truncAddr(addr: string): string {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
}

export function fmtSui(n: number): string {
  // Copy from ui.ts:165-172
}

export function fmtUsd(n: number | null): string {
  // Copy from ui.ts:174-181
}

export function fmtMenuBalHtml(n: number | null): string {
  // Copy from ui.ts:184-201
}

export function fmtStable(n: number): string {
  // Copy from ui.ts:203-207
}
```

- [ ] **Step 2: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/format.ts && git commit -m "refactor: extract formatting helpers into format.ts"
```

---

### Task 7: Create `ski-balance` element

**Files:**
- Create: `src/elements/ski-balance.ts`
- Read: `src/ui.ts` — search for `mountBalanceCycler`, `balView`, `fmtSui`, `fmtUsd`, `fmtStable`

- [ ] **Step 1: Create `src/elements/ski-balance.ts`**

```ts
// src/elements/ski-balance.ts — <ski-balance> balance cycler.
// Cycles through SUI → USD → Stables → NS on click.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';

type BalView = 'sui' | 'usd' | 'stable' | 'ns';

class SkiBalance extends HTMLElement {
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;
  private view: BalView = 'sui';

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        sui: ctx.appState.sui,
        usd: ctx.appState.usd,
        stableUsd: ctx.appState.stableUsd,
        nsBalance: ctx.appState.nsBalance,
      }),
      () => this.render(),
    );
    this.addEventListener('click', this.cycle);
  }

  disconnectedCallback() {
    this.unsub?.();
    this.removeEventListener('click', this.cycle);
  }

  private cycle = () => {
    const views: BalView[] = ['sui', 'usd', 'stable', 'ns'];
    const i = views.indexOf(this.view);
    this.view = views[(i + 1) % views.length];
    this.render();
  };

  private render() {
    // Format balance based on current view
    // Set innerHTML with formatted value
  }
}

customElements.define('ski-balance', SkiBalance);
export { SkiBalance };
```

**Implementation note:** Copy `fmtSui`, `fmtUsd`, `fmtStable`, `fmtMenuBalHtml` helpers from `ui.ts` into this file (or a shared `src/format.ts` if they're needed by multiple elements). Find `mountBalanceCycler` in `ui.ts` to understand the exact cycling behavior and HTML output.

- [ ] **Step 2: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

- [ ] **Step 3: Commit**

```bash
git add src/elements/ski-balance.ts && git commit -m "feat: add <ski-balance> custom element"
```

---

## Chunk 3: Profile & Button Elements

### Task 8: Create `ski-profile` element

**Files:**
- Create: `src/elements/ski-profile.ts`
- Read: `src/ui.ts` — search for `renderWidget`, `wk-widget`, profile pill

- [ ] **Step 1: Create `src/elements/ski-profile.ts`**

The profile pill shows: wallet icon → social badge (if WaaP) → SuiNS name or truncated address → Ika badge (if active).

```ts
// src/elements/ski-profile.ts — <ski-profile> wallet identity pill.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';
import { waapProviderIcon } from '../icons.js';

class SkiProfile extends HTMLElement {
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        status: ctx.walletState.status,
        address: ctx.walletState.address,
        walletName: ctx.walletState.walletName,
        walletIcon: ctx.walletState.walletIcon,
        suinsName: ctx.appState.suinsName,
        ikaWalletId: ctx.appState.ikaWalletId,
      }),
      () => this.render(),
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render() {
    if (this.ctx.walletState.status !== 'connected') {
      this.innerHTML = '';
      return;
    }
    // Copy renderWidget() logic from ui.ts
    // Build profile pill HTML
  }
}

customElements.define('ski-profile', SkiProfile);
export { SkiProfile };
```

**Implementation note:** Find `renderWidget` in `ui.ts` and trace all the HTML it generates. It builds the `.wk-widget` container with wallet icon, social badge, name, and Ika badge. Copy the HTML template and adapt it to use `this.ctx` instead of `getState()` / `app.*`.

- [ ] **Step 2: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-profile.ts && git commit -m "feat: add <ski-profile> custom element"
```

---

### Task 9: Create `ski-button` element

**Files:**
- Create: `src/elements/ski-button.ts`
- Read: `src/ui.ts` — search for `renderSkiBtn`, `externalSkiBtns`

- [ ] **Step 1: Create `src/elements/ski-button.ts`**

The SKI button toggles the menu open/closed. Supports a `variant="dot"` attribute for dot-only rendering.

```ts
// src/elements/ski-button.ts — <ski-button> SKI menu trigger.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';

class SkiButton extends HTMLElement {
  static observedAttributes = ['variant'];
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        status: ctx.walletState.status,
        menuOpen: ctx.uiState.menuOpen,
        suinsName: ctx.appState.suinsName,
        splashSponsor: ctx.appState.splashSponsor,
      }),
      () => this.render(),
    );
    this.addEventListener('click', this.toggle);
  }

  disconnectedCallback() {
    this.unsub?.();
    this.removeEventListener('click', this.toggle);
  }

  attributeChangedCallback() {
    this.render();
  }

  private toggle = () => {
    const ctx = this.ctx;
    if (ctx.walletState.status !== 'connected') {
      ctx.openModal();
    } else {
      ctx.updateUiState({ menuOpen: !ctx.uiState.menuOpen });
    }
  };

  private render() {
    // Copy renderSkiBtn() logic from ui.ts
    // Build button HTML with SVG logo
  }
}

customElements.define('ski-button', SkiButton);
export { SkiButton };
```

- [ ] **Step 2: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-button.ts && git commit -m "feat: add <ski-button> custom element"
```

---

## Chunk 4: Complex Elements

### Task 10: Create `ski-modal` element

**Files:**
- Create: `src/elements/ski-modal.ts`
- Read: `src/ui.ts` — search for `renderModal`, `openModal`, `closeModal`, wallet list, splash legend

This is the largest element (~800 lines of render logic in `ui.ts`). It handles:
- Wallet list (standard + WaaP wallets)
- Splash/list layout toggle
- Wallet detail view (key info, balances)
- Logo with live balance overlay
- Legend (splash sponsor indicators)

- [ ] **Step 1: Create `src/elements/ski-modal.ts`**

```ts
// src/elements/ski-modal.ts — <ski-modal> wallet selection overlay.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';
import { getSuiWallets, connect, onWalletsChanged } from '../adapter.js';

class SkiModal extends HTMLElement {
  private unsub: (() => void) | null = null;
  private walletsUnsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        modalOpen: ctx.uiState.modalOpen,
        modalLayout: ctx.uiState.modalLayout,
        status: ctx.walletState.status,
        address: ctx.walletState.address,
        suinsName: ctx.appState.suinsName,
        sui: ctx.appState.sui,
        usd: ctx.appState.usd,
        splashSponsor: ctx.appState.splashSponsor,
      }),
      () => this.render(),
    );
    this.walletsUnsub = onWalletsChanged(() => this.render());
  }

  disconnectedCallback() {
    this.unsub?.();
    this.walletsUnsub?.();
  }

  private render() {
    if (!this.ctx.uiState.modalOpen) {
      this.innerHTML = '';
      return;
    }
    // Copy renderModal() logic from ui.ts
    // This is ~800 lines — port carefully
    // Replace getState() → this.ctx.walletState
    // Replace app.* → this.ctx.appState.*
    // Replace openModal/closeModal → this.ctx.openModal/closeModal
  }
}

customElements.define('ski-modal', SkiModal);
export { SkiModal };
```

- [ ] **Step 2: Port modal overlay + close behavior**

Read `renderModal()` in `ui.ts`. Port the overlay container, backdrop click-to-close, and Escape key handler. At this point the modal should open/close as an empty container.

- [ ] **Step 3: Port wallet list rendering**

Port the wallet roster — iterating `getSuiWallets()`, rendering each wallet row with icon/name, click-to-connect handler. Include WaaP social login rows.

- [ ] **Step 4: Port splash/list layout toggle**

Port the layout switcher (splash view vs. list view) and the splash legend (sponsor indicators, key arrows).

- [ ] **Step 5: Port wallet detail view**

Port the detail panel that appears when clicking a connected wallet's key — shows address, balances, copy button.

- [ ] **Step 6: Port logo with live balance overlay**

Port `getInlineSkiSvg()` / `renderModalLogo()` — the SKI logo with dot variant and balance text overlay.

- [ ] **Step 7: Wire event handlers**

Ensure all click handlers work: wallet select → `connect()`, layout toggle, detail view open/close, disconnect, copy address.

- [ ] **Step 8: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-modal.ts && git commit -m "feat: add <ski-modal> custom element"
```

---

### Task 11: Create `ski-menu` element

**Files:**
- Create: `src/elements/ski-menu.ts`
- Read: `src/ui.ts` — search for `renderSkiMenu`

The dropdown menu (~1,000 lines). Contains: SuiNS operations, Shade orders, balance display, copy address, disconnect, sponsor controls.

- [ ] **Step 1: Create `src/elements/ski-menu.ts`**

```ts
// src/elements/ski-menu.ts — <ski-menu> dropdown menu.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';

class SkiMenu extends HTMLElement {
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        menuOpen: ctx.uiState.menuOpen,
        status: ctx.walletState.status,
        address: ctx.walletState.address,
        suinsName: ctx.appState.suinsName,
        sui: ctx.appState.sui,
        splashSponsor: ctx.appState.splashSponsor,
      }),
      () => this.render(),
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render() {
    if (!this.ctx.uiState.menuOpen || this.ctx.walletState.status !== 'connected') {
      this.innerHTML = '';
      return;
    }
    // Copy renderSkiMenu() logic from ui.ts (~1000 lines)
    // Port all SuiNS operations, Shade UI, sponsor controls
  }
}

customElements.define('ski-menu', SkiMenu);
export { SkiMenu };
```

- [ ] **Step 2: Port menu container + open/close behavior**

Read `renderSkiMenu()` in `ui.ts`. Port the dropdown container, positioning below the SKI button, and click-outside-to-close. At this point the menu opens/closes as an empty container.

- [ ] **Step 3: Port balance header section**

Port the top balance display with SUI/USD values and the 3-decimal formatted balances.

- [ ] **Step 4: Port SuiNS panel**

Port the SuiNS section — domain list, register form, subname creation, set-default, set-target-address. Wire event handlers for each SuiNS operation (calls into `suins.ts` PTB builders).

- [ ] **Step 5: Port Shade panel**

Port the Shade section — order list, create order form, cancel/execute buttons, status indicators. Wire event handlers for Shade operations.

- [ ] **Step 6: Port sponsor panel**

Port the sponsor section — activate/deactivate sponsor, keeper mode toggle, beneficiary list management. Wire event handlers using `sponsor.ts` functions.

- [ ] **Step 7: Port disconnect + copy address**

Port the disconnect button, copy-address button, and any remaining menu items.

- [ ] **Step 8: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-menu.ts && git commit -m "feat: add <ski-menu> custom element"
```

---

### Task 13: Create `ski-sign-stage` element

**Files:**
- Create: `src/elements/ski-sign-stage.ts`
- Read: `src/ui.ts` — search for `renderSignStage`

The sign stage panel (~500 lines) — splash card, sign message prompt, tools panel.

- [ ] **Step 1: Create `src/elements/ski-sign-stage.ts`**

```ts
// src/elements/ski-sign-stage.ts — <ski-sign-stage> sign tools panel.

import { getContext, type SkiContext } from '../context.js';
import { injectStyles } from '../styles.js';

class SkiSignStage extends HTMLElement {
  private unsub: (() => void) | null = null;
  private ctx!: SkiContext;

  connectedCallback() {
    injectStyles();
    this.ctx = getContext();
    this.render();
    this.unsub = this.ctx.subscribe(
      (ctx) => ({
        status: ctx.walletState.status,
        toolsCollapsed: ctx.uiState.toolsCollapsed,
        splashSponsor: ctx.appState.splashSponsor,
      }),
      () => this.render(),
    );
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private render() {
    // Copy renderSignStage() logic from ui.ts (~500 lines)
  }
}

customElements.define('ski-sign-stage', SkiSignStage);
export { SkiSignStage };
```

- [ ] **Step 2: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-sign-stage.ts && git commit -m "feat: add <ski-sign-stage> custom element"
```

---

## Chunk 5: Composition & Wiring

### Task 14: Create `ski-lift` element (all-in-one)

**Files:**
- Create: `src/elements/ski-lift.ts`

- [ ] **Step 1: Create `src/elements/ski-lift.ts`**

```ts
// src/elements/ski-lift.ts — <ski-lift> batteries-included SKI element.
// Composes all sub-elements into the full SKI experience.

import { getContext } from '../context.js';
import { injectStyles } from '../styles.js';

// Import to ensure custom elements are registered
import './ski-dot.js';
import './ski-button.js';
import './ski-profile.js';
import './ski-menu.js';
import './ski-modal.js';
import './ski-balance.js';
import './ski-sign-stage.js';
import './ski-toast.js';

class SkiLift extends HTMLElement {
  connectedCallback() {
    injectStyles();
    getContext(); // ensure singleton is initialized

    this.innerHTML = `
      <div class="ski-wallet">
        <ski-profile></ski-profile>
        <ski-button></ski-button>
        <ski-dot></ski-dot>
      </div>
      <ski-menu></ski-menu>
      <ski-modal></ski-modal>
      <ski-sign-stage></ski-sign-stage>
    `;
  }
}

customElements.define('ski-lift', SkiLift);
export { SkiLift };
```

- [ ] **Step 2: Verify build, commit**

```bash
bun build src/ski.ts --outdir public/dist --target browser
git add src/elements/ski-lift.ts && git commit -m "feat: add <ski-lift> composed custom element"
```

---

### Task 15: Rewire `ski.ts` entry point

**Files:**
- Modify: `src/ski.ts`

Replace the `ui.ts` import with element imports. Keep all sign-in logic, session management, and event handlers.

- [ ] **Step 1: Update imports in `src/ski.ts`**

Remove:
```ts
import { initUI, showToast, showToastWithRetry, showBackpackLockedToast, updateAppState, grpcClient, enrollAllKnownAddresses, SUI_DROP_URI, getAppState } from './ui.js';
```

Replace with:
```ts
import { getContext } from './context.js';
import { showToast, showToastWithRetry, showBackpackLockedToast } from './elements/ski-toast.js';
import { SUI_DROP_URI } from './icons.js';
import './elements/ski-lift.js'; // registers all custom elements
```

- [ ] **Step 2: Replace `updateAppState` calls with `getContext().updateAppState`**

Find all `updateAppState({...})` calls in `ski.ts` and replace with `getContext().updateAppState({...})`.

- [ ] **Step 3: Replace `grpcClient` references**

Replace `grpcClient` with `getContext().grpcClient`.

- [ ] **Step 4: Replace `getAppState()` calls**

Replace `getAppState()` with `getContext().appState`.

- [ ] **Step 5: Replace `initUI()` boot call**

Remove `initUI();` (line 365). The context initializes lazily when `<ski-lift>` mounts.

- [ ] **Step 6: Move `enrollAllKnownAddresses` into `context.ts`**

Find `enrollAllKnownAddresses` in `ui.ts`, move it to `context.ts`, and export it.

- [ ] **Step 7: Update exports**

Replace:
```ts
export { setModalLayout, type ModalLayout, mountBalanceCycler, mountSkiButton, mountDotButton, openModal } from './ui.js';
```

With:
```ts
export { getContext } from './context.js';
export function openModal() { getContext().openModal(); }
export function signIn() { /* already exported above */ }
```

- [ ] **Step 8: Verify build**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

**IMPORTANT:** This task and the next (index.html update + old file deletion) must be committed atomically. The app will be broken if `ski.ts` stops calling `initUI()` but `index.html` still has the old markup. Complete all steps before committing.

- [ ] **Step 9: Update `public/index.html`**

Remove the `<link>` to `styles.css` (styles are auto-injected now).
Replace the existing widget markup with:

```html
<ski-lift></ski-lift>
```

Remove any element IDs that the old `ui.ts` looked up (`ski-wallet`, `wk-widget`, `ski-dot`, `ski-btn`, `ski-menu`, `ski-modal`, `ski-sign`).

- [ ] **Step 10: Delete `src/ui.ts`**

```bash
rm src/ui.ts
```

- [ ] **Step 11: Delete `public/styles.css`**

```bash
rm public/styles.css
```

- [ ] **Step 12: Full build and verify**

```bash
bun build src/ski.ts --outdir public/dist --target browser
```

Expected: Build succeeds with no errors. No imports reference `ui.ts` or `styles.css`.

- [ ] **Step 13: Commit (atomic — all changes together)**

```bash
git add -A && git commit -m "refactor: rewire ski.ts, update index.html, delete ui.ts and styles.css"
```

---

### Task 16: Deploy and smoke test

- [ ] **Step 1: Build and deploy**

```bash
bun run build && npx wrangler deploy
```

- [ ] **Step 2: Smoke test in browser**

Verify:
1. `<ski-lift>` renders the full widget (dot, button, profile)
2. Clicking SKI button opens modal
3. Wallet list appears with all registered wallets
4. Connecting a wallet shows profile pill with name/address
5. Balance cycler works (click to cycle SUI → USD → stables → NS)
6. SKI menu opens with all panels (SuiNS, Shade, sponsor)
7. Toast notifications appear and dismiss
8. Sign-in flow completes (personal message → session)
9. Disconnect works

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: post-deploy smoke test fixes"
```
