# .SKI — .Sui Key-In

One-button Sui wallet sign-in. Connect once, authenticate everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

---

## What it does

.SKI is a drop-in wallet widget for Sui dApps. It adds two elements to your page:

- **Left pill** — connected wallet icon, social badge (WaaP), SuiNS name or truncated address, live SUI balance with click-to-toggle SUI/USD display. Clicking it opens the wallet's `.sui.ski` profile in a new tab when a SuiNS name is set.
- **.SKI button** — opens the Key-In modal, or switches wallet if the menu is already open.

### Key-In modal

The modal lists every installed Sui wallet extension with a legend grid showing each key that has ever connected. For each wallet it shows:

- SuiNS name (resolved, cached, displayed as a subdomain link)
- Shape badge: diamond (hardware/WaaP), blue square (SuiNS), green circle (software)
- Live SUI balance + USD value (price fetched from Binance, 5-minute cache)
- Supported networks and Wallet Standard features
- Ika cross-chain dWallet badge when active

The connected wallet and address are pre-selected when the modal opens. Clicking any row switches to that wallet in one tap.

**Long-press lock** — press and hold a row for 2.2 s to lock the right-pane detail to that wallet. Hover won't update the detail while locked. Long-press again to unlock. An amber ring indicates the locked state.

### Balance cycler

The balance display in both the modal header and the key detail card toggles between SUI-primary and USD-primary on click. The preference is saved to `localStorage` (`ski:bal-pref`) and persists across sessions.

### Session layer

After connecting, .SKI requests one personal message signature to prove key ownership. The signed proof is tied to a FingerprintJS `visitorId` (device fingerprint) and stored in `localStorage`. On reload the session is restored silently — no re-signing required until it expires (7 days for software wallets, 24 hours for hardware/Keystone).

Session format: `{ address, signature, bytes, visitorId, expiresAt }` — stored under `ski:session`.

The included Cloudflare Durable Object (`SessionAgent`) can verify sessions server-side if you deploy your own worker.

### Splash sponsorship

Splash is a device-level gas sponsor system built on top of .SKI. A wallet owner can activate Splash to cover gas fees for every key that has ever connected from the same device. Sponsored transactions use Sui's sponsored transaction flow — the user approves in their wallet as usual, and the sponsor's wallet countersigns separately.

- Activate via the Splash button in the .SKI modal header brand column
- Devices that connect through a sponsor's `?splash={address}` URL are enrolled automatically
- SuiNS names can be used as the sponsor parameter: `?splash=brando.sui`
- The drop badge appears on keys covered by an active sponsor

---

## Install

```bash
npm install sui.ski
# or
bun add sui.ski
```

## Embed via script tag (CDN)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sui.ski/public/styles.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/sui.ski/public/dist/ski.js"></script>
```

Add the widget markup anywhere in your `<body>`:

```html
<div class="wallet-widget" id="wallet-widget">
  <div id="wk-widget"></div>
  <button class="wallet-ski-btn" id="wallet-ski-btn" style="display:none"></button>
  <div id="wallet-menu-root"></div>
</div>
<div id="ski-modal-root"></div>
```

The script auto-initializes on load — no further JS required.

## Embed via bundler

```ts
import 'sui.ski';
```

Same DOM markup as above is required.

## Events

```ts
window.addEventListener('ski:wallet-connected', (e: CustomEvent) => {
  const { address, walletName } = e.detail;
});

window.addEventListener('ski:wallet-disconnected', () => {});

// Request sign-in (opens modal, then triggers sign + redirect to sui.ski)
window.dispatchEvent(new CustomEvent('ski:request-signin'));
```

## Requesting a transaction

Any page can ask .SKI to sign and execute a transaction:

```ts
import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();
// ... build your transaction

window.dispatchEvent(new CustomEvent('ski:sign-and-execute-transaction', {
  detail: { transaction: tx, requestId: 'my-req-1' }
}));

window.addEventListener('ski:transaction-result', (e: CustomEvent) => {
  const { requestId, success, digest, error } = e.detail;
});
```

If a Splash sponsor is active and the transaction is a `Transaction` object, the sponsored flow is used automatically.

## Modal API

```ts
import { openModal } from 'sui.ski';
import { setModalLayout, type ModalLayout } from 'sui.ski';

// Layouts: 'splash' (default, includes Splash toggle), 'list' (wallet list only), 'layout2' (no Splash strip)
setModalLayout('list');
```

## Supported wallets

Any wallet implementing the [Sui Wallet Standard](https://docs.sui.io/standards/wallet-standard):

| Wallet | Notes |
|---|---|
| Phantom | |
| Backpack | Keystone hardware wallet via Backpack supported (24 h session) |
| Slush | |
| Suiet | |
| Keystone | Direct extension; auto-prompts on connect |
| WaaP | Social/email wallet (Google, X, email); always shown as diamond; provider badge displayed |
| Any Sui Wallet Standard extension | |

## Self-hosting / Cloudflare Worker deploy

```bash
bun install
npx wrangler login
bun run deploy   # builds + deploys in one step
```

The worker hosts three Durable Objects:

| Binding | Purpose |
|---|---|
| `SessionAgent` | Verifies signed sessions server-side |
| `SponsorAgent` | Manages Splash sponsor state |
| `SplashDeviceAgent` | Tracks per-device Splash activation (keyed by FingerprintJS `visitorId`) |

## Local development

```bash
bun install
bun run dev          # watches src/ski.ts, rebuilds on change
# in a second terminal:
bun run dev:wrangler # wrangler dev with hot reload
```

Open `http://localhost:8787` — always use `http://localhost` (not `file://`) so wallet extensions have a valid origin.

## License

MIT
