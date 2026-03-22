# SKI Component Refactor — Design Spec

## Goal

Refactor SKI's monolithic UI layer into composable Custom Elements that any page can mount without CSS conflicts. The backend, wallet adapter, and client agent code are untouched.

## Architecture

### Custom Elements

All components register as Custom Elements with the `ski-` prefix:

| Element | Purpose |
|---------|---------|
| `<ski-lift>` | All-in-one — composes all sub-elements internally |
| `<ski-dot>` | Status indicator dot |
| `<ski-button>` | SKI menu trigger button |
| `<ski-profile>` | Wallet icon + name + balance pill |
| `<ski-menu>` | Dropdown menu (SuiNS, tools, disconnect) |
| `<ski-modal>` | Wallet selection overlay |
| `<ski-balance>` | Balance cycler (SUI/USD/stables/NS) |

`<ski-lift>` is the batteries-included element. Drop it in and the full SKI experience appears. Each sub-element also works standalone — `<ski-balance>` in a navbar, `<ski-modal>` in a custom layout, etc.

### Consumer API

```html
<!-- Full experience -->
<script type="module" src="ski.js"></script>
<ski-lift></ski-lift>

<!-- Custom layout — pick what you need -->
<script type="module" src="ski.js"></script>
<nav>
  <ski-balance></ski-balance>
  <ski-dot></ski-dot>
</nav>
<ski-modal></ski-modal>

<!-- Imperative control -->
<script type="module">
  import { openModal, signIn } from 'sui.ski'
</script>
```

### Element Lifecycle

Each element extends `HTMLElement`:

- **`connectedCallback`** — acquires singleton `SkiContext`, subscribes to relevant state slices, performs initial render
- **`disconnectedCallback`** — unsubscribes, removes event listeners
- **`attributeChangedCallback`** — reacts to attribute changes (e.g., `<ski-button variant="dot">`)

### SkiContext (Singleton State)

A module-level singleton created lazily on first element mount. Replaces the scattered state reads across `wallet.ts` and `ui.ts`.

**Initialization:** The first `ski-*` element to mount calls `SkiContext.init()`, which sets up the wallet adapter, gRPC/GraphQL transport, and subscribes to Wallet Standard events. Subsequent elements reuse the existing instance. Standalone elements (e.g., `<ski-balance>` without `<ski-lift>`) trigger the same init — they just render empty/loading state until wallet data arrives.

**Shape:**

```ts
interface SkiContext {
  // State
  walletState: WalletState;        // status, wallet, account, address, icon
  appState: AppState;              // sui, usd, stableUsd, nsBalance, suinsName, ikaWalletId
  sponsorState: SponsorState;      // active, address, keeperMode, etc.
  uiState: {                       // UI-only toggles
    menuOpen: boolean;
    modalOpen: boolean;
    modalLayout: 'splash' | 'list';
    toolsCollapsed: boolean;
  };

  // Subscribe with selector — callback only fires when selected slice changes
  subscribe<T>(selector: (ctx: SkiContext) => T, callback: (value: T) => void): () => void;

  // Actions
  connect(wallet: Wallet): Promise<void>;
  disconnect(): void;
  signIn(): Promise<boolean>;
  openModal(): void;
  closeModal(): void;
  showToast(msg: string, opts?: ToastOptions): void;

  // Transport (internal, used by elements that fetch data)
  transport: SuiGrpcClient | SuiGraphQLClient;
  grpcClient: SuiGrpcClient;
}
```

The `subscribe` method takes a **selector function** — elements pick the slice they care about, and the callback only fires when that slice's value changes (shallow equality). This prevents unnecessary re-renders.

**Not exported directly** — consumers interact through elements and window events. Internal API stays private and changeable.

### CSS Strategy — `@layer ski`

- All styles live in `src/styles.ts` as a template literal wrapped in `@layer ski { ... }`
- **Auto-injected** — first `ski-*` element to connect checks for `<style id="ski-styles">` in `<head>`. If absent, creates it. All subsequent elements reuse it.
- **No external stylesheet import needed** — consumers don't need to import a CSS file
- **`ski-*` class prefix** on all class names (existing convention, enforced consistently)
- **CSS custom properties for theming** — `--ski-bg`, `--ski-text`, `--ski-border`, etc. Consumers override from their own CSS
- **Layer ordering** — `@layer ski` sits below the default layer, so host page styles win on conflict. SKI's styles are self-consistent within the layer.
- **Light DOM** — elements render into the regular DOM (no Shadow DOM). This means unqualified host rules like `button { color: red }` can leak in. Mitigation: all SKI selectors are scoped to element tag names or `ski-*` classes (e.g., `ski-modal button` instead of bare `button`). This is an accepted tradeoff — Shadow DOM would add complexity disproportionate to the isolation benefit for this project.

### Window Events (Communication Protocol)

Preserved as the bridge between SKI and external pages:

- `ski:wallet-connected`
- `ski:wallet-disconnected`
- `ski:sign-and-execute-transaction`
- `ski:transaction-result`
- `ski:pre-sign`

## File Structure

### New / Changed

```
src/
├── ski.ts              # Entry point — registers elements, re-exports imperative API
├── context.ts          # SkiContext singleton (state + pub/sub + actions)
├── adapter.ts          # wallet.ts renamed — Wallet Standard bridge
├── styles.ts           # CSS template literal, @layer ski { ... }
├── icons.ts            # Named SVG string exports (walletIcon, copyIcon, etc.)
├── elements/
│   ├── ski-lift.ts     # All-in-one composed element
│   ├── ski-modal.ts    # Wallet selection overlay
│   ├── ski-button.ts   # SKI menu trigger
│   ├── ski-dot.ts      # Status indicator
│   ├── ski-profile.ts  # Wallet icon + name + balance pill
│   ├── ski-balance.ts  # Balance cycler
│   ├── ski-menu.ts     # Dropdown menu
│   ├── ski-sign-stage.ts # Sign tools panel (splash card, sign message)
│   └── ski-toast.ts    # Toast notifications (appended to body)
```

### Deleted

- `src/ui.ts` (5,632 lines) — logic distributed across `src/elements/*.ts` and `src/context.ts`
- `public/styles.css` (4,002 lines) — migrated into `src/styles.ts`

### Untouched

- `src/suins.ts` — PTB builders
- `src/sponsor.ts` — sponsorship logic
- `src/waap.ts`, `src/waap-proof.ts` — WaaP registration + proof caching
- `src/fingerprint.ts` — device fingerprinting
- `src/client/*` — DO websocket clients (session, sponsor, splash, shade)
- `src/server/*` — Worker + Durable Objects (SessionAgent, SponsorAgent, SplashDeviceAgent, ShadeExecutorAgent)

### Build

Unchanged: `bun build src/ski.ts --outdir public/dist --target browser`

Entry point stays the same — only what it imports changes.

## Migration Details

### ui.ts Decomposition

The 5,632-line `ui.ts` splits as follows:

| Current function(s) | Destination |
|---------------------|-------------|
| `render()` | eliminated — each element re-renders itself via `subscribe()` |
| `initUI()`, `bindEvents()` | `context.ts` (global keyboard/focus listeners move here) |
| `renderWidget()`, profile pill HTML | `elements/ski-profile.ts` |
| `renderSkiBtn()`, external button registries | `elements/ski-button.ts` |
| `renderSkiMenu()` (~1,000 lines) | `elements/ski-menu.ts` |
| `renderModal()` (~800 lines) | `elements/ski-modal.ts` |
| `renderSignStage()` (~500 lines) | `elements/ski-sign-stage.ts` (new element, not inlined into menu) |
| `renderModalLogo()`, dot state | `elements/ski-dot.ts` |
| `mountBalanceCycler()`, balance cycling | `elements/ski-balance.ts` |
| Inline SVGs throughout | `icons.ts` |
| `showToast()`, `showToastWithRetry()` | `elements/ski-toast.ts` (own element, appended to body) |
| `AppState`, `getAppState()`, `updateAppState()` | `context.ts` |
| `grpcClient`, transport setup | `context.ts` (exposed as `ctx.transport`, `ctx.grpcClient`) |
| `enrollAllKnownAddresses`, `SUI_DROP_URI` | `context.ts` (internal helpers) |
| `showBackpackLockedToast` | `elements/ski-toast.ts` (specialized toast variant) |
| `els` registry, DOM queries | eliminated — each element owns its own DOM |

### wallet.ts → adapter.ts

Renamed for clarity. Same responsibilities:
- Wallet Standard discovery and connection
- `WalletState` type and state management
- `signAndExecuteTransaction`, `signPersonalMessage`
- `subscribe()` for state change listeners

State management moves into `SkiContext` — adapter becomes a pure bridge that feeds state changes to the context.

### styles.css → styles.ts

The 4,002 lines of CSS migrate into a TypeScript module:

```ts
export const skiStyles = `
@layer ski {
  :root {
    --ski-bg: #05070d;
    --ski-panel: rgba(12, 14, 22, 0.92);
    --ski-text: #e6ebf5;
    --ski-muted: #9ca7bb;
    --ski-border: rgba(163, 184, 211, 0.24);
  }
  /* ... all ski-* rules ... */
}
`;
```

CSS custom properties renamed from `--bg` / `--text` to `--ski-bg` / `--ski-text` to avoid collisions with host pages.

### Injection

```ts
// Called once by first element to connect
export function injectStyles() {
  if (document.getElementById('ski-styles')) return;
  const style = document.createElement('style');
  style.id = 'ski-styles';
  style.textContent = skiStyles;
  document.head.appendChild(style);
}
```

## What This Does NOT Change

- No framework added — stays vanilla TypeScript with string templates + `innerHTML`
- No new dependencies
- Backend completely untouched (Workers, DOs, agents)
- Client agent files untouched (session, sponsor, splash, shade)
- SuiNS PTB builders untouched
- WaaP integration untouched
- Fingerprint untouched
- Build command unchanged
- Deploy command unchanged (`bun run build && npx wrangler deploy`)
