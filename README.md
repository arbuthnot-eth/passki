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

### Squids Panel — Cross-Chain Balance Display

Clicking the 🦑 squid quick-action opens the **squids panel**, the idle-overlay view of every chain the user's IKA dWallet derives. Each row shows the chain glyph, truncated address, and live USD balance:

- **SUI** — native + stables via gRPC `listBalances` (Mysten fullnode)
- **BTC** — native via mempool.space `/api/address/<addr>` (free, key-less)
- **SOL** — native + iUSD-SPL via Helius `/api/sol-rpc` proxy (`getBalance` + `getTokenAccountsByOwner`)
- **ETH (mainnet)** — native + USDC ERC-20 via **viem** + Alchemy HTTPS transport (`ALCHEMY_ETH_URL` secret, `eth_getBalance` + `erc20Abi.balanceOf`)
- **TRON** — USDT-TRC20 via TronGrid `/v1/accounts/<addr>` (free tier)

Derived addresses come from the IKA dWallet `public_output` — even dWallets stuck in `AwaitingKeyHolderSignature` produce valid BCS-derived addresses, so users see their cross-chain identity the moment DKG starts instead of waiting for the accept-share step. Balances roll into the single `app.usd` total alongside Sui and stables so the header balance pill is a true net-worth aggregate across every chain brando holds.

**QR top slot** — above the chain rows, a chain-colored QR code with the selected chain's logo inlaid (green `$` for SUI, orange `₿` for BTC, official Solana parallelograms for SOL, indigo `Ξ` for ETH, red Tron triangles for TRON). Clicking a chain row updates the QR + highlights the row in its chain color; clicking the QR expands it to 260×260. Hovering a row swaps the truncated hex for the identity form (`brando.sui` / `btc@brando` / `sol@brando` / `eth@brando` / `tron@brando`) while the native `title` tooltip shows the full hex — both visible simultaneously.

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

### Thunder Attachments (Regizapdos #147)

Full attachment support lands via `@mysten/sui-stack-messaging` — Seal-encrypted per file, uploaded to Walrus via the configured HTTP publisher, decrypted on click via the SDK's `handle.data()`. All three main send paths (`iUSD transfer`, `SUI shielded transfer`, plain text send) wire `files: AttachmentFile[]` through `sendThunder`. Ancillary paths (read receipts, quick-reply) deliberately don't carry attachments.

**Cache hydration** — `_ThunderEntry` in the stale-while-revalidate localStorage cache preserves attachment refs (`storageId`, `fileName`, `mimeType`, `fileSize`) so reopened storms paint chips/thumbs immediately instead of flashing text-only. Bytes stay in Walrus; only refs cross the localStorage boundary. The AES-GCM key in IndexedDB stays non-extractable.

**Size limits** (aligned with SDK enforcement):
- Per-file: **2 MB** (was 10 MB UI-side, SDK always enforced 2 MB)
- Per message: **4 files** (was 10 UI-side)
- Total per message: **5 MB** (new pre-upload guard — 4×2 MB silent failures now caught at attach time)

Errors fire as UI toasts before the SDK rejects. Walrus upload failures fail the whole send cleanly — no silent text orphaning. WaaP attachment path verification is deferred (needs live repro).

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

## Mega Sableye — Private Interaction Set (#148)

Roster chips render with a **black diamond** glyph for names brando has privately interacted with (Thunder send, value transfer, cross-chain credit). The set lives as **AES-GCM ciphertext** in the user's Chronicom Durable Object — the operator only ever sees the opaque blob, and the wrapping key is a **non-extractable** `CryptoKey` persisted in browser IndexedDB so raw key material never leaves the device.

**Client — `src/client/sableye.ts`:**
- `warmSableye(addr)` — fetch ciphertext from Chronicom, AES-GCM decrypt into in-memory `Set<string>`
- `noteCounterparty(name, chain)` — add + debounce 2s persist back to Chronicom
- `hasSableye(name)` — synchronous lookup for render loops (`_renderRosterChip` calls this)
- `drainXchainLog()` — pulls any server-side webhook touches and processes them through `reverseLookupName`
- `flushSableye()` / `resetSableye()` — lifecycle

**Chronicom DO slice — `src/server/agents/chronicom.ts`:**
- `sableye: { cipher?: string; updatedAt?: number; xchainLog?: [...] }`
- Rejects non-string cipher at the write boundary; DO inspection yields only ciphertext
- Worker routes `GET/POST /api/chronicom/sableye?addr=<address>`

**Event hooks (minimal resource impact):**
- **Thunder** — `sendThunder` in `thunder-stack.ts` dispatches `ski:thunder-sent` with the recipient name; ui records the counterparty on every send
- **Cross-chain** — Helius + Alchemy webhook handlers append to `sableye.xchainLog` via an internal `/sableye-xchain-append` DO route (rides nursery PR #132 — depends on webhook handlers not yet on master)
- **Roster render** — `_renderRosterChip` consults `hasSableye(bareName)` synchronously; black diamond on hit, blue square on miss

See issue #145, PR #148.

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

.SKI runs a Pokedex coordinator Durable Object that watches GitHub issues, branches, and PRs as a live swarm. Per the naming convention: legendary Pokemon are releases, regular Pokemon with level tags are commits and issues, merged PRs are evolutions (canon forms first — Mega, Gigantamax — otherwise Pokemon Infinite Fusion cross-species forms). Recent evolutions include:

- **Mega Sableye** (#148) — Seal-encrypted private interaction set; black-diamond roster glyphs; Chronicom ciphertext slice
- **Regizapdos** (#147, Zapdos × Registeel fusion) — Thunder attachment hardening; cache hydration of attachment refs; SDK-aligned size limits (2 MB/file, 4 files, 5 MB total)
- **Raichu Lv.40** — ultron-sponsored thunder gas
- **Mr. Mime Lv.42** — shielded Pedersen transfers
- **Alakazam Lv.36** — forward secrecy via DEK rotation
- **Psyduck Lv.22** — collected-pill fix
- **Diglett Lv.18** — dust gate
- **Dugtrio Lv.36** — batched shielded deposits

**gitcatch** — the full commit → evolve → deploy cycle. `gitcatch Pokemon` commits outstanding moves as Pokemon-named commits, lands the PR as an evolution (canon Mega / Gigantamax first, then Infinite Fusion cross-species naming), and deploys to mainnet. Memory: `feedback_gitcatch.md`.

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
