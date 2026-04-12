# .SKI — .Sui Key-In

.SKI once, everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

<a href="https://sui.ski"><img src="public/assets/sui-ski-qr.svg" width="160" alt="sui.ski QR code"></a>

---

## What .SKI Is

.SKI is a Sui-native messaging and cross-chain identity dApp where SuiNS names are communication endpoints. You send a thunder to `@name` and it lands as an encrypted storm conversation whose ciphertext lives on Walrus and whose keys live behind Seal. Every wallet, agent, and cross-chain address is IKA-native — no private keys sit on Cloudflare Workers, ever. The same UI rails carry Thunder messages, Thunder IOU transfers, shielded Pedersen commitments, Shade grace-period snipes, and SUIAMI cross-chain identity proofs.

Agents (ultron, chronicoms, t2000s) are Durable Objects that sign via IKA dWallet user shares + DWalletCap wrappers. `brando.sui` runs DKG in the browser and re-encrypts the user share to the agent. Either brando OR agent + IKA network = a valid signature.

## For Hackathon Devs (Frontier Colosseum)

SKI is the best IKA-based Web2 social login experience you can build with today. Here's what you get out of the box:

### WaaP — Wallet as a Protocol
Sign in with **X.com, Google, phone, or email**. No API keys. No seed phrases. No wallet extensions. It just works. If you're a dev, you know how amazing "no API keys" is.

### Rumble Your Squids
One button runs IKA DKG and provisions **native Bitcoin, Solana, and EVM dWallet addresses** — all from a single Sui account. Not wrapped. Not bridged. Real cross-chain keys. This is built and live on mainnet today.

### Anti-Spam — Stables Only
SKI is inherently anti-spam. Everything is measured in **stables**. You have 8 billion MONKE PENIS coins? SKI checks all exchanges, sees it's worth less than a cent, and filters it out — or auto-swaps it to USD (or Argentine Peso). No more `0.000256 CHODE` in your portfolio.

### Subcent Intents
The 6-7 digits after `$0.01` aren't noise — they're **steganographic intent tags**:
- Which chain are you swapping to?
- What is the receiving address?
- Other privately encoded data only legible to the participants

One number carries the instruction. No metadata leaks.

### What You Can Build With
- **Tradeport** — SuiNS marketplace listing proxy (`/api/tradeport/listing/:label`)
- **Walrus** — Seal-encrypted blob storage for Thunder ciphertext, Shade payloads, quilted batch writes
- **Solana/Helius** — Webhook-driven deposit watchers, SPL token resolution, Jupiter routing
- **Seal** — 2-of-3 threshold encryption (Overclock, Studio Mirai, H2O Nodes key servers)
- **IKA dWallets** — Native cross-chain signing, batch DKG, DWalletCap wrappers

---

## Native Cross-Chain Wallets via IKA dWallets

Real Bitcoin, Ethereum, and Solana addresses controlled by your Sui account — no bridges, no wrapping, no custodians. Powered by [IKA](https://docs.ika.xyz)'s 2PC-MPC threshold signatures.

### What One Sui Account Controls

| Curve | Chains | Address Format |
|-------|--------|----------------|
| **secp256k1** (1 DKG) | Bitcoin, Ethereum, Base, Polygon, Arbitrum, Optimism, Tron (USDT only) | `bc1q...`, `0x...`, `T...` |
| **ed25519** (1 DKG) | Solana | base58 |

Two DKG ceremonies. Two dWallets. Eight chains. One Sui account.

### Why This Matters

- **No bridges** — BTC stays on Bitcoin, SOL stays on Solana. IKA generates real native addresses whose signing is governed by Sui smart contracts.
- **Non-collusive security** — 2PC-MPC means neither the user nor the network can sign alone. 100+ mainnet operators with Byzantine threshold.
- **Quantum-ready architecture** — Sui's flag-byte signature scheme lets the network add post-quantum primitives via a new flag byte — no hard fork, no address migration. See [`docs/ika-quantum-resistance.md`](docs/ika-quantum-resistance.md).

---

## First Commandment: IKA-Native, Keyless Agents

- **Every wallet, agent, and cross-chain address MUST be IKA-native.**
- **No private keys on Cloudflare Workers — ever.** Agents sign via IKA dWallet user shares + DWalletCap wrapper.
- Cross-chain addresses (BTC, ETH, SOL) come from IKA dWallet DKG — always. No raw keypair re-encoding as cross-chain addresses.
- `brando.sui` runs DKG in-browser, re-encrypts user share to the agent. Either brando OR agent + IKA network = valid signature.
- Batch DKG provisioning for agents = "Rumble your squids."
- If a dWallet doesn't exist yet, the feature is blocked until DKG is run — no shortcuts.

## Terminology

| Word | Meaning |
|---|---|
| **Storm** | A conversation (not channel/group) |
| **Thunder** | A message or signal |
| **Quest** | The act of reading/opening |
| **Purge** | Delete-on-read (never "decrypt") |
| **Cache** | Fund storage (never "treasury/reserve/dao") |
| **Rumble** | IKA DKG ceremony (never multi-token swap routing) |
| **SKI Pass** | Access/membership proof |
| **Stables** | Dollar-pegged value (never "stablecoins") |
| **Sibyl** | The predictor (never "Sybil") |
| **chain@name** | Address format: `sol@ultron`, `eth@brando`, `btc@stables` |
| **encrypt / decrypt** | Always verb forms, never "encrypted/encryption" |

## Core Principles

- **IKA-native, keyless agents.** Every cross-chain address is IKA dWallet derived. No private keys on workers. Batch DKG = "Rumble your squids."
- **Cache, not treasury.** Funds flow through caches — high-performance temporary stores.
- **Stables, not stablecoins.** iUSD is a stable backed by activity yield.
- **Encrypt, not encrypted.** Use verb forms — encrypt/decrypt.

---

## Domain Structure

| Domain | Purpose |
|---|---|
| `sui.ski` | Root — main application, embeddable widget, API endpoints |
| `<name>.sui.ski` | SuiNS profile pages (e.g. `brando.sui.ski`) |

Cross-domain session cookie (`ski:xdomain`) on `domain=sui.ski` for auth persistence across subdomains.

---

## UI Overview

The `.SKI` header bar renders four elements:

- **Dot** — wallet status shape (green circle = unconnected, black diamond = connected, blue square = has SuiNS name). Toggles modal/menu.
- **Profile pill** — wallet icon, social badge, SuiNS name + squid emoji (IKA status), live balance. Clicks to `.sui.ski` profile page.
- **SKI button** — branded button. Three-state cycle: menu → idle overlay → menu.
- **Balance pill** — live USD balance. Click to cycle SUI/USD display.

### Idle Overlay

After 15s of inactivity (or via SKI button cycle), the menu collapses into a compact overlay with:
- Pixel art video (cached via Cache API for instant replay)
- Name search input with full SuiNS resolution
- Squids rows — styled SUI/BTC/SOL/ETH/Base/Tron address rows with chain-colored icons, per-row USD balances, toggle-select to copy
- Rumble button — runs IKA DKG to provision all chain wallets
- Thunder messaging row
- Version badge linking to npm

The overlay restores instantly on hard refresh via `ski:last-address` localStorage fallback, with IKA addresses cached to `ski:ika-addrs:${address}`.

### SKI Modal

Single-column overlay with key detail pane, Splash legend (keys grouped by shape tier), wallet list, and WaaP social login row. Long-press lock (2.2s) pins a wallet. Layout toggle persists preference.

### SKI Menu

Dropdown with SuiNS name management, marketplace purchase (Tradeport/kiosk), Shade orders, Thunder messaging, coin chip swaps, SUIAMI identity proofs, and key management.

---

## Thunder — Seal-Encrypted Messaging

Thunder is a thin wrapper around [`@mysten/sui-stack-messaging`](https://github.com/MystenLabs/sui-stack-messaging) with a custom Cloudflare Durable Object relayer (`TimestreamAgent`).

- **Encryption** — Seal 2-of-3 threshold DEK + AES-GCM envelope. Relayer never sees plaintext. Key servers verified on first encrypt (`verifyKeyServers: true`).
- **Transport** — `TimestreamAgent` DO, one instance per `groupId`, speaks HTTP to `/api/timestream/:groupId/:action` (`send`, `fetch`, `fetch-one`, `update`, `delete`, `add-participant`).
- **Identity** — SuiNS names (`alice.sui`) resolved via SuinsClient to target address / NFT owner.
- **Storm** — on-chain `PermissionedGroup<Messaging>` (upstream Move package) anchors key-version history and membership; messages live off-chain in the DO.
- **Global SUIAMI Storm** — `0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8` (uuid `suiami-global`), public identity directory. Joining is a public act by design.
- **Seal servers** — Overclock, Studio Mirai, H2O Nodes (mainnet, open/free). 2-of-3 threshold.

### Privacy Phase 1 (2026-04-10)

- **No plaintext fallback** — `encryptWithRetry` retries up to 5× and fails the send rather than storing cleartext. Transfer notes also encrypted.
- **Message padding** — plaintext padded to fixed buckets `[256, 1024, 4096, 16384]` bytes before Seal, killing the ciphertext-length side channel.
- **Timestamp jitter** — DO rounds `createdAt`/`updatedAt` to 10s buckets + ±5s noise on ingest. Monotonic `order` preserves UI sort.
- **Sender index on the wire** — new messages store `senderIndex` (position in the DO's participant list) instead of the raw Sui address. A dump of `messages` no longer reveals who authored what.
- **Attachment guard** — DO rejects `attachments: [...]` at the send boundary; our transport does not round-trip them, and silently accepting would leak blob IDs outside the Seal envelope.

Remaining Phase 2 items (sealed sender, non-derivable group IDs, encrypted membership) are deferred — see `docs/superpowers/specs/2026-04-10-thunder-privacy-audit-and-roadmap.md`.

### Thunder IOU + Thunder IOU Shielded

Thunder carries value as well as text. A `$amount` in a thunder composes a token transfer into the same PTB as the signal.

- **Thunder IOU** — plain escrowed transfers with recall + expiry. Package: `0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79`.
- **Thunder IOU Shielded** — BLS12-381 Pedersen commitment transfers. Amounts are hidden on-chain; the recipient decrypts a sealed opening via Seal and reveals via a zero-knowledge verification in Move. Package: `0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782`.
- **Dust gate** — sub-cent sends bypass the shielded path (per `Diglett Lv.18`) and route to plain IOU.
- **Batching** — `buildShieldedDepositManyTx` (Dugtrio Lv.36) and the in-flight Mr. Rime Lv.52 aggregate-vault evolution batch multiple deposits in one PTB.

Active IOU work in the Pokedex covers the activate/redeem UI (Pikachu), iUSD-yield escrow (Typhlosion), iUSD gas (Ampharos), Seal-encrypted `sealed_memo` (Magnezone), multi-token `Iou<T>` (Garchomp), and the IKA cross-chain activate to ETH/SOL/BTC (Metagross).

### Gas-Free Stables Everywhere

Thunder sends work with **zero SUI** in the sender's wallet:

- **iUSD-native transfers** — when the sender lacks SUI, the send routes through `iusdTransfer` (plain `transferObjects` of iUSD coins). Gas is either ultron-sponsored (non-WaaP) or covered by a 0.1 SUI drip from ultron (WaaP).
- **iUSD→USDC→SUI two-hop swap** — `buildSwapTx` chains the seeded iUSD/USDC DeepBook pool with the main SUI/USDC pool. Slippage protection at 90% minimum output; liquidity pre-check rejects swaps exceeding pool depth.
- **iUSD→USDC→NS registration** — `buildIusdSwap` path in `buildRegisterSplashNsTx` swaps iUSD through both pools and registers a SuiNS name with the NS-discounted path. One signature.
- **Tradeport iUSD-redeem** — `/api/infer` detects iUSD holders and routes marketplace buys through ultron pre-fund (SUI advanced, user repays in iUSD+USDC). Tightened accounting: Pyth price passed from infer to DO, gas buffer + 0.5% safety margin charged to the buyer.
- **TTL reduction** — `IOU_DEFAULT_TTL_MS` reduced from 7 days to 10 minutes. The `iou-sweeper` cron (every 10 min) auto-recalls expired vaults permissionlessly via ultron.

### SUIAMI Batch Claim/Recall

The Storm action button turns green **SUIAMI** when unclaimed transfer vaults exist in the current conversation. One click builds a batch PTB with `claim` or `recall` per vault and signs in one tx. Settled transfers collapse into a single gray summary line showing net amounts and tx count.

The ↩ button on the quick-amount chip row scans ALL `ShieldedVault` objects on-chain where the connected wallet is the sender, and batch-recalls them.

### Shade v5 — Generic Stable Deposits

Shade contract upgraded to v5 (`0x9978db0a...`) with `create_stable<T>`, `execute_stable<T>`, `cancel_stable<T>`. Shade deposits can now be denominated in **any coin type** (iUSD, USDC, etc.) — no SUI required. UpgradeCap owned by `plankton.sui`, policy 0 (compatible).

### SOL → Shade Pipeline

One-scan cross-chain shade placement:

1. Type a grace-period name → Solana QR appears (centered, large, Solana logo) on the idle overlay
2. Scan with Phantom/Solflare → send SOL to `sol@ultron`
3. SOL watcher detects deposit (route=3, shade intent) → attests SOL collateral → mints iUSD to ultron
4. Auto-fires `_shadeProxy` → `create_stable<IUSD>` → shade order placed with iUSD deposit
5. At grace expiry → `execute_stable<IUSD>` → name registers to the depositor's Sui address

Zero SUI. Zero clicks after the scan. SOL value teleports cross-chain via iUSD synthetic accounting.

### iUSD/USDC DeepBook Pool

Pool `0x38df72f5...` seeded via `seedIusdPoolV3` — one atomic PTB: create shared BalanceManager, deposit all iUSD+USDC, place ASK @ 1.01 + BID @ 0.99, share BM. Current package dispatch uses `0x337f4f4f...` (latest DeepBook mainnet), not the origin package.

## SUIAMI

SUI-Authenticated Message Identity — cryptographic proof that a SuiNS name belongs to you. Verified server-side via `/api/suiami/verify`.

### SUIAMI Roster

Cross-chain identity resolver. Maps SuiNS names to BTC/ETH/SOL addresses via IKA dWallets in a shared on-chain registry with reverse lookup.

**v2 Package:** `0xef4fa3fa12a1413cf998ea8b03348281bb9edd09f21a0a245a42b103a2e9c3b4`

### SUIAMI Reciprocal Roster

Seal-encrypted cross-chain identity exchange. No cleartext cross-chain addresses ever appear on-chain — only the SUI address (already public) and a Walrus blob ID.

**How it works:**
1. User proves SUIAMI ownership (signed message + SuiNS NFT verification)
2. Cross-chain addresses (BTC/ETH/SOL) are AES-GCM encrypted and uploaded to Walrus as a blob
3. Only the blob ID is written to the on-chain roster — no cleartext addresses on-chain
4. Decryption is Storm-gated via Seal policy (`seal_approve_roster_reader`): you must hold a valid SUIAMI proof to decrypt anyone's addresses
5. **Reciprocal:** reading someone's roster entry requires your own SUIAMI proof, which auto-writes your entry if it doesn't exist yet
6. **Viral:** every lookup adds a new roster entry, growing the network organically

**Contracts:**
- Roster Package: `0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa`
- Roster Object: `0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d`
- Seal Policy: `seal_approve_roster_reader`

**npm:** [`suiami@0.2.0`](https://github.com/arbuthnot-eth/SUIAMI)

**Key files:**
- `contracts/suiami/sources/roster.move` — on-chain roster contract
- `contracts/suiami/sources/seal_roster.move` — Seal decryption policy
- `src/client/roster.ts` — Walrus blob upload/fetch with AES-GCM encryption
- `src/suins.ts` — `readRosterByAddress`, `maybeAppendRoster`
- `scripts/deploy-suiami-storm.ts` — one-time global Storm deployment

---

## Shade

Privacy-preserving SuiNS grace-period domain sniping. Commitment-reveal hides domain/target/timing on-chain until execution. Seal encryption for payload privacy.

- **ShadeExecutorAgent** — Cloudflare DO auto-executes at grace expiry via alarms
- **`execute()`** — permissionless; anyone with the preimage can call
- Three routes: SUI→NS, SUI→USDC→NS, SUI direct fallback

**Contract:** `0xfcd0b2b4f69758cd3ed0d35a55335417cac6304017c3c5d9a5aaff75c367aaff`

See [SHIELD.md](SHIELD.md) for the security model.

---

## iUSD — Yield-Bearing Stable

Dollar-pegged stable backed by diversified reserves (gold, silver, equities, energy, dollar instruments) custodied natively across BTC, ETH, SOL, and SUI via IKA dWallet threshold signatures.

### Reserve Composition

| Tranche | Assets | Target |
|---------|--------|--------|
| **Senior (60%)** | USDC, BUIDL (T-bills), staked SUI/SOL | ≥100% of supply |
| **Junior (40%)** | XAUM, XAGM, TSLAx/NVDAx/SPYx, BTC, crude | Absorbs losses first |

150% minimum collateral ratio. 9-decimal steganographic encoding fingerprints every mint.

**v2 Package:** `0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9`

---

## OpenCLOB — Cross-Chain Order Book

Phase 3a is live: the `thunder_openclob::bundle` Move package is published and the `treasury-agents` scanner watches bundles over GraphQL. Sub-cent steganographic tags act as order-matching keys. Phase 3b adds a client-side bundle builder (merged) and a keeper settlement path (in-flight).

**Package:** `0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7`

See `docs/superpowers/specs/2026-04-11-openclob-bundle-tags.md`.

## Pokemon Swarm

.SKI runs a Pokedex coordinator Durable Object that watches GitHub issues, branches, and PRs as a live swarm. Per the naming convention: legendary Pokemon are releases, regular Pokemon with level tags are commits and issues, merged PRs are evolutions. Recent evolutions include Raichu Lv.40 (ultron-sponsored thunder gas), Mr. Mime Lv.42 (shielded Pedersen transfers), Alakazam Lv.36 (forward secrecy via DEK rotation), Psyduck Lv.22 (collected-pill fix), Diglett Lv.18 (dust gate), and Dugtrio Lv.36 (batched shielded deposits).

The Pokedex DO is bound as `PokedexAgent` and exposes `/api/pokedex/*` routes. See `docs/superpowers/specs/2026-04-11-pokemon-swarm-agents.md`.

## Upcoming — Ghost Line for Colosseum Frontier

Active in-flight work for the Ika + Encrypt side track of Colosseum Frontier. Submission deadline approximately 2026-05-11; side-track prize pool $15K USDC via Superteam Earn, main track $2.5M+.

Thesis: native Ika dWallets on Solana plus Encrypt FHE claim logic equals bridgeless and encrypted capital markets on Solana, extending the existing Thunder and Storm UX to cross-chain. We keep the same storm → thunder → claim shell users already know, and swap the substrate to Ika pre-alpha on Solana (`solana-pre-alpha.ika.xyz`) and Encrypt (`docs.encrypt.xyz`).

Ghost line issues:

- **#101 Gastly Lv.20** — Solana redeem UI scaffold (stage 1)
- **#102 Haunter Lv.40** — Sui-side claim + swap + burn + poltergeist keeper pickup (stage 2)
- **#103 Gengar Lv.55** — feature-complete Solana redeem for encrypt.xyz Colosseum (stage 3)
- **#104 Shelgon Lv.45** — shadow-DKG provisioning; keeper runs DKG alone, user share encrypted to recipient pubkey
- **#105 Salamence Lv.65** — user reclaims shadow dWallet on first login

Demo target: a judge opens a phone at the Colosseum stage, receives a live \$5 thunder, claims it as native USDC-SPL on `sol@name`, and sees it land in Phantom within 30 seconds. Zero bridges. The amount is never visible on-chain until claim execution inside an Encrypt FHE function. The Solana-side dWallet is provisioned on-demand via Ika.

## Sibyl — The Predictor

Custom oracle. Timestreams flow price through time. Pythia (ultron.sui) channels visions. Offerings flow to the iUSD cache. Sibyl's Court: Anthropologists (research), Hunters (iUSD yield), Rogues (IKA squid breeding).

## ultron.sui — Autonomous Agent

**Address:** `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`

Keeper wallet for all server-side signing: iUSD minting, Shade execution, Thunder relay, dust sweeps, fee collection.

---

## Deployed Contracts

| Contract | Package / Object |
|----------|------------------|
| iUSD v2 | `0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9` |
| SUIAMI Roster v3 (reciprocal) | `0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa` |
| SUIAMI Roster object | `0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d` |
| Global SUIAMI Storm | `0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8` |
| Shade | `0xfcd0b2b4f69758cd3ed0d35a55335417cac6304017c3c5d9a5aaff75c367aaff` |
| Ignite | `0x66a44a869fe8ea7354620f7c356514efc30490679aa5cb24b453480e97790677` |
| Thunder IOU | `0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79` |
| Thunder IOU Shielded | `0x3b1dcced3f585157f48afd14a84f42e65ee57dd38be9dd73d7d94a0a1b690782` |
| Thunder OpenCLOB (bundle) | `0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7` |

Thunder uses the upstream [`@mysten/sui-stack-messaging`](https://github.com/MystenLabs/sui-stack-messaging) Move package; no custom Thunder or Storm contract. An earlier hybrid-stack package (`0xa3ed4fdf...cdf942`) was published but never wired into the client and has been stripped from the source tree.

---

## What's Next — Live Pokedex

The authoritative roadmap is the GitHub issue tracker, watched by the Pokedex DO and surfaced via `/api/pokedex/*`. Major in-flight lines:

- **Ghost** (#101-105) — Gastly / Haunter / Gengar Solana redeem for Colosseum Frontier; Shelgon / Salamence shadow-DKG provisioning
- **Dragon** (#78-79) — Garchomp multi-token `Iou<T>`, Metagross IKA cross-chain activate
- **Electric** (#76, #80) — Ampharos iUSD gas, Electivire decentralized activity feed via IOU events
- **Fire** (#75) — Typhlosion iUSD yield on escrowed IOU balances
- **Psychic** (#77, #94) — Magnezone Seal-encrypted `sealed_memo`, Mr. Rime aggregate shielded vault
- **Thunder v4** (#63, #68-71) — migration to Sui Stack Messaging SDK, compose-preview UX, composable PTB alongside signal
- **Security** (#54-58) — session cookie hardening, innerHTML XSS sweep, rate limiting, localStorage TTL

Closed recently: Raichu Lv.40 (ultron-sponsored thunder gas), Mr. Mime Lv.42 (shielded Pedersen transfers), Alakazam Lv.36 (DEK rotation forward secrecy), Jolteon Lv.25 (WebSocket thunder subscribe), Diglett Lv.18 (dust gate), and Psyduck Lv.22 (collected pill).

---

## Install

```bash
npm install sui.ski
# or
bun add sui.ski
```

## Embed via script tag

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/sui.ski/public/styles.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/sui.ski/public/dist/ski.js"></script>
```

Add the widget markup:

```html
<div class="ski-header">
  <div class="ski-wallet" id="ski-wallet">
    <button class="ski-btn ski-dot" id="ski-dot" style="display:none"></button>
    <div id="ski-profile"></div>
    <button class="ski-btn" id="ski-btn" style="display:none"></button>
    <div id="ski-menu"></div>
  </div>
</div>
<div id="ski-modal"></div>
```

Auto-initializes on load.

## Embed via bundler

```ts
import 'sui.ski';
```

Same DOM markup required.

## Events

```ts
window.addEventListener('ski:wallet-connected', (e: CustomEvent) => {
  const { address, walletName } = e.detail;
});

window.addEventListener('ski:wallet-disconnected', () => {});

window.dispatchEvent(new CustomEvent('ski:request-signin'));
```

## Requesting a transaction

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

Splash sponsorship is applied automatically when active.

---

## Self-Hosting

```bash
bun install
npx wrangler login
bun run build && npx wrangler deploy
```

Never skip the deploy step. Never use `bun run deploy` — only `npx wrangler deploy`. Two workers back the app: `dotski` (agents, treasury, messaging DOs) and `sui-ski` (subnames, auth).

### Durable Objects

| Binding | Purpose |
|---|---|
| `SessionAgent` | Signed session verification |
| `SponsorAgent` | Splash sponsor state |
| `SplashDeviceAgent` | Per-device Splash activation |
| `ShadeExecutorAgent` | Auto-executes Shade orders at grace expiry |
| `TreasuryAgents` | ultron.sui — iUSD minting, collateral, NS acquisition, Thunder relay |
| `Chronicom` | Per-wallet thunder signal watcher with cached counts |
| `TimestreamAgent` | Per-group Thunder message storage (Seal-encrypted, one DO per `groupId`) |

### API Routes

| Route | Purpose |
|---|---|
| `/agents/*` | WebSocket upgrade for DO agents |
| `/api/health` | Health check |
| `/api/shade/*` | Shade order management |
| `/api/suiami/verify` | SUIAMI proof verification (GraphQL-backed) |
| `/api/timestream/:groupId/:action` | Thunder transport — Seal-encrypted message DO (`send`/`fetch`/`fetch-one`/`update`/`delete`/`add-participant`) |
| `/api/thunder/chronicom` | Per-wallet signal count cache |
| `/api/tradeport/listing/:label` | Tradeport listing proxy |

---

## Stack

- `@mysten/sui` ^2.13.0, `@mysten/suins` ^1.0.2, `@human.tech/waap-sdk` 1.3.0, `@ika.xyz/sdk` 0.3.1
- Messaging: `@mysten/sui-stack-messaging` ^0.0.2, `@mysten/sui-groups` ^0.0.1 (Thunder)
- Encryption: `@mysten/seal` ^1.1.1 (2-of-3 threshold — Overclock, Studio Mirai, H2O Nodes)
- Storage: `@mysten/walrus` ^1.1.0 (blobs + quilted batch writes)
- Solana: Helius (RPC + webhook deposit watchers), Jupiter (routing), Kamino (lending)
- DEX: `aftermath-ts-sdk` (aggregation), DeepBook v3, Bluefin CLMM, Cetus CLMM
- Marketplace: Tradeport (SuiNS listing proxy)
- Transport: `SuiGrpcClient` primary, `SuiGraphQLClient` fallback — **no JSON-RPC** (sunsets April 2026). Cloudflare Workers and DOs cannot speak gRPC (no HTTP/2 bidi streaming), so server code uses GraphQL. GraphQL is read-only, so `sui_executeTransactionBlock` submission falls back through PublicNode → BlockVision → Ankr.
- Build: `bun build src/ski.ts --outdir public/dist --target browser` with JSON import for version injection
- Deploy: Cloudflare Workers + Durable Objects (`dotski` + `sui-ski`)

## Local Development

```bash
bun install
bun run dev          # watches src/ski.ts
bun run dev:wrangler # wrangler dev with hot reload
```

## License

MIT
