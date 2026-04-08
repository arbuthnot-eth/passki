# .SKI — .Sui Key-In

.SKI once, everywhere.

[![npm](https://img.shields.io/npm/v/sui.ski)](https://www.npmjs.com/package/sui.ski)
[![Live](https://img.shields.io/badge/live-sui.ski-blue)](https://sui.ski)

<a href="https://sui.ski"><img src="public/assets/sui-ski-qr.svg" width="160" alt="sui.ski QR code"></a>

---

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
- **Seal** — 2-of-3 threshold encryption (Overclock, NodeInfra, Studio Mirai key servers)
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

## Thunder — Encrypt Signals

On-chain encrypt messaging between SuiNS identities. Powered by [Seal](https://docs.mystenlabs.com/seal) threshold encryption (2-of-3 key servers) with ciphertext on [Walrus](https://walrus.xyz).

- **Signal** — encrypt a message to any `.sui` name; only the NFT owner can decrypt
- **Quest** — claim and decrypt signals, NFT-gated via Seal policies
- **Strike** — delete signals on-chain, routing storage rebates to cache
- **@tags** — mention SuiNS names with autocomplete from roster

**Move contract (v4):** `0xb16f344c9f778be79d81ad3b3bd799476681d339a099ff9acaf2b7ea9e5d9581`

## Storm v1

Permissionless on-chain messaging primitive used by Thunder v5. No fees, no admin keys, no NFT gates. ECDH-derived storm_id hides who talks to whom.

**Package:** `0xa3ed4fdf1369313647efcef77fd577aa4b77b50c62e5c5e29d4c383390cdf942`

## SUIAMI

SUI-Authenticated Message Identity — cryptographic proof that a SuiNS name belongs to you. Verified server-side via `/api/suiami/verify`.

### SUIAMI Roster

Cross-chain identity resolver. Maps SuiNS names to BTC/ETH/SOL addresses via IKA dWallets in a shared on-chain registry with reverse lookup.

**v2 Package:** `0xef4fa3fa12a1413cf998ea8b03348281bb9edd09f21a0a245a42b103a2e9c3b4`

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

## Sibyl — The Predictor

Custom oracle. Timestreams flow price through time. Pythia (ultron.sui) channels visions. Offerings flow to the iUSD cache. Sibyl's Court: Anthropologists (research), Hunters (iUSD yield), Rogues (IKA squid breeding).

## ultron.sui — Autonomous Agent

**Address:** `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`

Keeper wallet for all server-side signing: iUSD minting, Shade execution, Thunder relay, dust sweeps, fee collection.

---

## Deployed Contracts

| Contract | Package |
|----------|---------|
| iUSD v2 | `0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9` |
| SUIAMI Roster v2 | `0xef4fa3fa12a1413cf998ea8b03348281bb9edd09f21a0a245a42b103a2e9c3b4` |
| Storm v1 | `0xa3ed4fdf1369313647efcef77fd577aa4b77b50c62e5c5e29d4c383390cdf942` |
| Thunder v4 | `0xb16f344c9f778be79d81ad3b3bd799476681d339a099ff9acaf2b7ea9e5d9581` |
| Shade | `0xfcd0b2b4f69758cd3ed0d35a55335417cac6304017c3c5d9a5aaff75c367aaff` |
| Ignite | `0x66a44a869fe8ea7354620f7c356514efc30490679aa5cb24b453480e97790677` |

---

## TODO — What's Next

### Subcent Intent Engine
- [ ] Parse steganographic digits from iUSD amounts into structured intents
- [ ] Route intents to correct chain + receiving address
- [ ] Private encoding scheme legible only to sender/receiver participants

### Anti-Spam Token Filtering
- [ ] Aggregate token value across all exchanges (Sui, Solana, EVM)
- [ ] Filter sub-cent holdings from display
- [ ] Auto-swap dust to stables (USD, ARS, etc.) via DEX aggregation
- [ ] User-configurable threshold for what counts as "spam"

### Solana Deep Integration
- [ ] Helius webhook-driven deposit watchers for all SPL tokens
- [ ] Jupiter aggregator routing for auto-swap to USDC
- [ ] Kamino lending integration (TSLAx/NVDAx collateral)
- [ ] CCTPv2 bridging: Phantom → Helius → Jupiter → USDC → iUSD

### Cross-Chain Balance Chips
- [ ] Real-time balance display per chain (SUI + SOL + ETH + BTC)
- [ ] Stables aggregation: USDC, USDT, USD1, iUSD across all chains
- [ ] RWA token display: XAUM, XAGM, TSLAx, NVDAx
- [ ] Helius for Solana balances, Alchemy/Infura for EVM, Esplora for BTC

### Rumble — Batch DKG UX
- [ ] One-button DKG for all curve types (secp256k1 + ed25519)
- [ ] Derive all chain addresses + write to SUIAMI Roster in single PTB
- [ ] "Rumble your squids" button in idle overlay

### Chronicom — Signal Caching
- [ ] Per-wallet Durable Object caching thunder counts
- [ ] 5s alarm polling (replaces 30s client gRPC polling)
- [ ] `/api/thunder/chronicom` serves cached counts instantly

### Storm v2 — Cross-Chain Messaging
- [ ] Thunder signals addressable to BTC/ETH/SOL addresses via IKA dWallet-gated Seal decryption
- [ ] StormIdentity linking DWalletCap public key to chain addresses

### Hunters — Offer Stalkers
- [ ] Chronicom agents monitor SuiNS name offers across Tradeport
- [ ] Auto-execute trades when prices match Sibyl attestation
- [ ] Storage rebates (~0.95 SUI per kiosk trade) → iUSD cache

### OpenCLOB — Cross-Chain Order Book
- [ ] Unified CLOB across DeepBook, Kamino, Cetus, Bluefin
- [ ] Sub-cent steganographic tags as order matching
- [ ] BAM (Burn/Attest/Mint) via IKA 2PC-MPC signing
- [ ] iUSD settlement, agents as market makers

### Prisms — Rich Encrypted Transactions
- [ ] Thunder gate + encrypted sender/timestamp + Walrus blob
- [ ] Partial encryption with ZK proofs (Thunderbun/Groth16)

### QuestFi — Agent Economics
- [ ] Parent keeps 1%, redistributes by performance
- [ ] Lazy agents die, bold RWA agents spawn
- [ ] 110% overcollateralization surplus deployed

### Satellites — Sibyl's Flash Liquidity
- [ ] Hot-potato flash loans from Sibyl
- [ ] Borrow NS, register name, repay in any token
- [ ] Discount spread → iUSD cache

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

### Durable Objects

| Binding | Purpose |
|---|---|
| `SessionAgent` | Signed session verification |
| `SponsorAgent` | Splash sponsor state |
| `SplashDeviceAgent` | Per-device Splash activation |
| `ShadeExecutorAgent` | Auto-executes Shade orders at grace expiry |
| `TreasuryAgents` | ultron.sui — iUSD minting, collateral, NS acquisition, Thunder relay |
| `Chronicom` | Per-wallet thunder signal watcher with cached counts |

### API Routes

| Route | Purpose |
|---|---|
| `/agents/*` | WebSocket upgrade for DO agents |
| `/api/health` | Health check |
| `/api/shade/*` | Shade order management |
| `/api/suiami/verify` | SUIAMI proof verification |
| `/api/thunder/strike-relay` | Server-side Thunder relay for WaaP wallets |
| `/api/tradeport/listing/:label` | Tradeport listing proxy |
| `/api/thunder/chronicom` | Per-wallet signal count cache |

---

## Stack

- `@mysten/sui` ^2.13.0, `@mysten/suins` ^1.0.2, `@human.tech/waap-sdk` 1.2.4, `@ika.xyz/sdk` 0.3.1
- Encryption: `@mysten/seal` ^1.1.1 (2-of-3 threshold key servers)
- Storage: `@mysten/walrus` ^1.1.0 (blobs + quilted batch writes)
- Solana: Helius (RPC + webhook deposit watchers), Jupiter (routing), Kamino (lending)
- DEX: `aftermath-ts-sdk` (aggregation), DeepBook v3, Bluefin CLMM, Cetus CLMM
- Marketplace: Tradeport (SuiNS listing proxy)
- Transport: `SuiGrpcClient` primary, `SuiGraphQLClient` fallback — **no JSON-RPC** (sunsets April 2026)
- Build: `bun build` with JSON import for version injection
- Deploy: Cloudflare Workers + Durable Objects

## Local Development

```bash
bun install
bun run dev          # watches src/ski.ts
bun run dev:wrangler # wrangler dev with hot reload
```

## License

MIT
