# SKI Architecture — Atomic Components

> **sui.ski** — once, everywhere. Private by default.

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER LAYER                                     │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │  SKI Dot │  │ SKI Menu │  │ Idle     │  │ Ski      │               │
│  │  ■ ● ◆ ◇│  │ Balance  │  │ Overlay  │  │ Context  │               │
│  │  status  │  │ Chips    │  │ GIF+Card │  │ $price   │               │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘               │
│       │              │              │              │                      │
│  ┌────┴──────────────┴──────────────┴──────────────┴─────┐              │
│  │                    NS Row                              │              │
│  │  [status] [name input] [.sui] [ACTION BUTTON]         │              │
│  │                                                        │              │
│  │  Actions: SUIAMI | MINT | TRADE | Quest | Thunder     │              │
│  └───────────────────────┬───────────────────────────────┘              │
│                           │                                              │
│  ┌────────────────────────┴──────────────────────────────┐              │
│  │                    Card                                │              │
│  │  [$balance] [name] [iUSD badge] [30D expiry] [⚡3]   │              │
│  └───────────────────────────────────────────────────────┘              │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Thunder  │  │ QR Prism │  │ Splash   │  │ Coin     │               │
│  │ Row      │  │ Solana   │  │ Sponsor  │  │ Chips    │               │
│  │ @input ⚡│  │ Pay QR   │  │ Free gas │  │ SUI/USDC │               │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         INFERENCE LAYER                                  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                     /api/infer                                │       │
│  │                                                               │       │
│  │  Input: { label, address }                                    │       │
│  │                                                               │       │
│  │  1. Read real on-chain balances (SUI, USDC, iUSD, NS, IKA)  │       │
│  │  2. Check name status + Tradeport listing                    │       │
│  │  3. Score actions by confidence                               │       │
│  │  4. Build TX server-side with correct payment route          │       │
│  │                                                               │       │
│  │  Output: { actions[], recommended, tx?, balances }           │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐       │
│  │ SUI Direct │  │ USDC Swap  │  │ iUSD→SUI   │  │ Quest      │       │
│  │ Route      │  │ Route      │  │ Redeem     │  │ Bounty     │       │
│  │ splitGas   │  │ DB→SUI     │  │ ultron     │  │ agents     │       │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        AGENT LAYER (QuestFi)                             │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │              TreasuryAgents Durable Object                    │       │
│  │                                                               │       │
│  │  ultron.sui — keeper wallet, autonomous signer               │       │
│  │                                                               │       │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │       │
│  │  │ Arb     │ │ Yield   │ │ Sweep   │ │ Shade   │           │       │
│  │  │ Scanner │ │ Rotator │ │ Dust    │ │ Sniper  │           │       │
│  │  │ NAVI FL │ │ NAVI/   │ │ USDC→   │ │ Grace   │           │       │
│  │  │ + Cetus │ │ Scallop │ │ SUI→    │ │ period  │           │       │
│  │  │ + DB    │ │ + DB    │ │ iUSD    │ │ execute │           │       │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │       │
│  │                                                               │       │
│  │  ┌───────────────────────────────────────────┐               │       │
│  │  │ t2000 Armory (derived objects on-chain)    │               │       │
│  │  │                                            │               │       │
│  │  │  Parent keeps 1% → redistributes by perf  │               │       │
│  │  │  Lazy agents die at 50 runs + 0 profit    │               │       │
│  │  │  Bold RWA agents spawn: XAUM/XAGM/TSLAx  │               │       │
│  │  │                                            │               │       │
│  │  │  deploy_quest → report_quest → cull →     │               │       │
│  │  │  spawn_rwa → distribute                    │               │       │
│  │  └───────────────────────────────────────────┘               │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                        │
│  │ Chronicom  │  │ Shade      │  │ Hunter     │                        │
│  │ DO         │  │ Executor   │  │ Stalker    │                        │
│  │ per-wallet │  │ DO Alarm   │  │ offer→fill │                        │
│  │ thunder ⚡ │  │ grace exec │  │ spread→    │                        │
│  │ count poll │  │ commitment │  │ iUSD cache │                        │
│  └────────────┘  └────────────┘  └────────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       ON-CHAIN LAYER (Sui Mainnet)                       │
│                                                                          │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │ iUSD   │ │Thunder │ │ Storm  │ │ Shade  │ │ t2000  │ │Balance │  │
│  │ v1     │ │ v2     │ │ v1     │ │ v4     │ │ v2     │ │ Seal   │  │
│  │        │ │ Zapdos │ │        │ │        │ │ Arceus │ │ Lugia  │  │
│  │Mint    │ │Signal  │ │Cross-  │ │Commit- │ │Deploy  │ │Seal    │  │
│  │Burn    │ │V2 dof  │ │chain   │ │reveal  │ │Quest   │ │Approve │  │
│  │Attest  │ │Claim   │ │Seal    │ │Seal    │ │Report  │ │Store   │  │
│  │Redeem  │ │Relay   │ │dWallet │ │Execute │ │Cull    │ │Balance │  │
│  │Revenue │ │Private │ │gate    │ │Escrow  │ │Spawn   │ │Decrypt │  │
│  │Tranche │ │Sweep   │ │        │ │        │ │Distrib │ │        │  │
│  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘  │
│      │          │          │          │          │          │         │
│  ┌───┴──────────┴──────────┴──────────┴──────────┴──────────┴────┐   │
│  │                    SUIAMI (v2)                                  │   │
│  │  Cross-chain identity: SuiNS → BTC/ETH/SOL via IKA dWallets  │   │
│  │  Roster on-chain • SUIAMI NFT = universal access pass         │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PRIVACY LAYER                                     │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Seal         │  │ IKA dWallet  │  │ Thunderbun   │                  │
│  │              │  │              │  │              │                  │
│  │ Encrypt      │  │ 2PC-MPC      │  │ ZK Groth16   │                  │
│  │ balances     │  │ threshold    │  │ location     │                  │
│  │ messages     │  │ signing      │  │ proofs       │                  │
│  │ roster       │  │              │  │              │                  │
│  │              │  │ secp256k1    │  │ Region lock  │                  │
│  │ 2-of-3       │  │  → BTC/ETH  │  │ without      │                  │
│  │ key servers  │  │ ed25519     │  │ revealing    │                  │
│  │              │  │  → SOL/SUI  │  │ coordinates  │                  │
│  │ Owner-only   │  │              │  │              │                  │
│  │ decrypt via  │  │ Fresh addr   │  │ Prove "in    │                  │
│  │ SuiNS NFT    │  │ per TX =    │  │ Argentina"   │                  │
│  │              │  │ unlinkable  │  │ without GPS  │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                          │
│  Privacy flow:                                                           │
│  SUIAMI (once) → Seal (encrypt at rest) → IKA (sign anywhere) →        │
│  Thunderbun (prove without revealing) → ultron (proxy execution)        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        YIELD LAYER (Cache)                               │
│                                                                          │
│          iUSD Treasury (110% overcollateralized)                         │
│          Everything above 110% = surplus for agents                     │
│                                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐       │
│  │ NAVI       │  │ Scallop    │  │ DeepBook   │  │ Kamino     │       │
│  │ Lending    │  │ Lending    │  │ LP/Arb     │  │ (Solana)   │       │
│  │ SUI+USDC   │  │ SUI+USDC   │  │ SUI/USDC   │  │ via IKA    │       │
│  │ Flash loan │  │ sCoin recv │  │ Maker fee  │  │ dWallet    │       │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘       │
│                                                                          │
│  Collateral: SUI • USDC • SOL • BTC • ETH • XAUM • XAGM • TSLAx     │
│  All cross-chain collateral controlled by IKA dWallets                  │
│  Sibyl oracle attests values • Tranched: senior (peg) + junior (growth)│
└─────────────────────────────────────────────────────────────────────────┘
```

## Atomic Components — English Definitions

### UI Components

**SKI Dot** — The identity indicator. Four states: blue square (owned/taken), green circle (available), red hexagon (grace period), black diamond (unknown). Appears in the header, NS row, and idle overlay. One glyph that tells you everything about a name's status.

**SKI Menu** — The main interaction panel. Collapses from the header. Contains the NS row, coin chips, amount input, and action button. Everything happens here — register names, swap tokens, send payments, verify identity.

**Idle Overlay** — The ambient interface. Drops below the header when nothing is happening. Shows the GIF, NS search, card, thunder input, and QR prism. Designed to be looked at, not clicked — until you need it.

**Ski Context** — The price/status badge below the action button. Shows `$26` for listings, `$8` for mints. Right-aligned with the action button. Blue square icon prefix. The at-a-glance cost of the current action.

**Card** — The identity+balance pill at the bottom of the idle overlay. Shows: `[$141] [stables] [iUSD] [30D] [⚡3]`. Balance in front (large, green $, white number), name, iUSD badge (after SUIAMI), expiry days, thunder count. For other people's names, shows their balance and expiry.

**NS Row** — The name input row. Status dot, text input, `.sui` suffix, action button. The action button morphs: SUIAMI (verify), MINT (register), TRADE (buy listing), Quest (bounty), Thunder (when composing a signal). One row, five modes.

**Coin Chips** — Token balance selectors. SUI, USDC, NS, IKA, XAUM, iUSD. Click to select payment method. The selected chip drives what token is used for registration, swaps, or trades.

**Thunder Row** — The encrypted messaging input. `@` button for tagging names, text input for the message, `⚡` send button. Messages are Seal-encrypted, stored on Walrus, keys XOR-masked with the recipient's NFT ID.

**QR Prism** — Solana Pay QR code for cross-chain Quest deposits. Shows in the bottom-right when Quest mode is active. Encodes a steganographic tag in the lamport amount for matching deposits to intents.

**Splash Sponsor** — Gas sponsorship indicator. When active, a sponsor wallet pays gas for all transactions. The user signs, sponsor pays. WaaP users are excluded (v1/v2 BCS mismatch).

### Inference Components

**/api/infer** — The intent inference engine. Takes `{ label, address }`, reads real on-chain balances via GraphQL, checks Tradeport listings, scores each possible action by confidence, builds the optimal TX server-side. Returns the TX bytes for the user to sign. The AI glue layer wraps this later — for now, deterministic scoring.

**Payment Routes** — Four atomic routes the infer engine selects from:
- **SUI Direct** — enough SUI in gas coins, split and pay
- **USDC Swap** — swap USDC→SUI via DeepBook, merge into gas, then pay
- **iUSD Redeem** — ultron pre-funds SUI to buyer, buyer sends iUSD back + purchases
- **Quest Bounty** — post intent, agents compete to fill, winner keeps spread

### Agent Components

**TreasuryAgents DO** — The central Durable Object. Runs ultron.sui's autonomous operations on a 15-second tick. Manages arb scanning, yield rotation, dust sweeps, shade execution, quest fills, and t2000 agent missions.

**ultron.sui** — The keeper wallet (`0xa84c...b3c3`). Signs all server-side transactions. Oracle for iUSD collateral attestation. Minter for iUSD. Executor for Shade orders. Relay for Thunder strikes. The single autonomous agent that runs 24/7.

**t2000 Armory** — On-chain shared object with agents as derived objects (dynamic_object_field). The parent keeps 1% of all profit and redistributes proportional to performance. Agents with 50+ runs and zero profit get culled. Bold new agents spawn focused on tokenized RWAs (XAUM, XAGM, TSLAx, NVIDIA, META).

**Chronicom DO** — Per-wallet Durable Object that caches Thunder signal counts. Polls on 5-second alarm intervals. Serves cached counts instantly to the UI. Fees from signals flow to the iUSD cache.

**ShadeExecutorAgent DO** — Executes Shade orders at grace period expiry via DO Alarms. Reads the commitment, decrypts the sealed payload (domain + target), and calls the on-chain `execute()` function when the timer fires.

### On-Chain Components (Move Contracts)

**iUSD** (`0x2c5653...` v1) — Yield-bearing stablecoin backed by diversified collateral. 9 decimals for steganographic encoding. Mint enforces 150% minimum collateral ratio. Senior tranche must cover 100% of supply (peg floor). Revenue from protocol fees (Thunder, Shade, swaps) flows to the Treasury. Oracle and minter roles gated to ultron.

**Thunder** (`0x1171e0...` v2 Zapdos) — Encrypted signals between SuiNS identities. Storm is the shared infrastructure object. v1: signals as dynamic_field vectors per name_hash. v2: SignalV2 as dynamic_object_field derived objects keyed by (recipient_address, idx) — each signal is a visible on-chain object queryable via GraphQL. AES keys XOR-masked with recipient's NFT ID. SUIAMI-verified signals are free (no fee).

**Storm** (`0xa3ed4f...` v1) — Cross-chain Thunder extension. IKA dWallet-gated Seal decryption for BTC/SOL/ETH addresses. Enables sending encrypted messages to any chain address, not just SuiNS names.

**Shade** (`0xb92278...` v4) — Privacy-preserving SuiNS grace-period sniping. Commitment-reveal pattern: hash(domain:holder) stored on-chain, domain hidden until execution. Seal encryption hides target/timing. Execute is permissionless — anyone with the preimage can call. Escrow in iUSD, liquidation if balance drops below threshold.

**t2000** (`0x1a160f...` v2 Arceus) — QuestFi agent deployment contract. v1: agents as owned objects. v2: agents as derived objects under Armory via dynamic_object_field. `deploy_quest` creates agents, `report_quest` logs profit with 1% parent cut, `cull` kills underperformers, `spawn_rwa` creates RWA-focused replacements, `distribute` sends accumulated parent cache proportional to lifetime profit.

**SUIAMI** (`0xef4fa3...` v2) — Cross-chain identity resolver. Maps SuiNS names to BTC/ETH/SOL addresses via IKA dWallets. The Roster is on-chain. The SUIAMI NFT is the universal access pass — unlocks all regional content, bypasses location gates, proves humanity.

**Balance Seal** (`0x1cf9ca...` v1 Lugia) — Seal access control for encrypted balance cards. `seal_approve` verifies the requester owns the SuiNS NFT referenced in the encrypted ID. `store_sealed_balance` lets ultron store encrypted blobs. BalancePolicy shared object maps name hashes to encrypted balance data.

### Privacy Components

**Seal** — Decentralized secrets management on Sui. 2-of-3 threshold encryption via key servers. Used for: balance cards, Thunder messages, Shade payloads, Roster entries. Only the SuiNS name owner can decrypt. SessionKey with 10-min TTL for time-limited access.

**IKA dWallet** — Threshold-signed cross-chain keys via 2PC-MPC. One DKG ceremony produces keys for all chains (secp256k1 for BTC/ETH, ed25519 for SOL/SUI). Fresh derived address per transaction = unlinkable. The DWalletCap deposited in the iUSD Treasury proves cross-chain collateral control.

**Thunderbun** — ZK location proofs via Groth16 on Sui. Desktop framework + Ligetron verifier. Proves "I am in Argentina" without revealing coordinates. Used for region-gating content at `*.superteam.sui.ski`. SUIAMI NFT bypasses the location check.

### Yield Components

**Cache** — The iUSD Treasury's operational state. 110% overcollateralized — everything above that threshold is surplus deployed by t2000 farm agents. The cache proves liquidity privately via Seal encryption. Agents compete for best yield across NAVI, Scallop, DeepBook, and Kamino (Solana via IKA).

**Yield Rotator** — Compares APYs across lending protocols every 15 minutes. Deploys surplus to the highest-yielding venue. Tracks positions in the DO state. Rebalancer checks drift every 24 hours and withdraws if collateral ratio drops below 110%.

**iUSD/SUI Swap** — `/api/iusd/swap` endpoint. Ultron sends SUI or USDC to the user, returns TX bytes for user to send equivalent iUSD back. Two-step atomic swap: ultron pre-funds, user signs one TX that pays iUSD + executes their intent.

**Dust Sweep** — Converts USDC/DEEP rounding dust from name acquisitions into SUI, attests as collateral, mints iUSD. The cache literally grows from swap rounding errors across thousands of transactions. Recursive flywheel.
