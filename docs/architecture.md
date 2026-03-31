# SKI Architecture — Atomic Components

> **sui.ski** — once, everywhere. Private by default.

## The Prism — Default Transaction Object

Every action on SKI produces a Prism. Not a raw PTB. A Prism.

```
┌─────────────────────────────────────────────────────────┐
│                        PRISM                             │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ intent          Seal-encrypted action type       │    │
│  │                 TRADE | MINT | Quest | Thunder   │    │
│  │                 | Swap | Send | Shade            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐   │
│  │ sender       │  │ recipient    │  │ timestamp   │   │
│  │ Seal encrypt │  │ name_hash    │  │ Seal encrypt│   │
│  │ only owner   │  │ or address   │  │ hidden when │   │
│  │ can reveal   │  │              │  │             │   │
│  └──────────────┘  └──────────────┘  └─────────────┘   │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ amount         steganographic encoding           │    │
│  │                real value in upper digits         │    │
│  │                intent tag in last 4 digits        │    │
│  │                e.g. 7500000000 + 0777 = Quest    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐   │
│  │ payload      │  │ proof        │  │ gate        │   │
│  │ Walrus blob  │  │ Thunderbun   │  │ Thunder     │   │
│  │ partial enc  │  │ ZK Groth16   │  │ signal req  │   │
│  │ public meta  │  │ location/    │  │ decrypt to  │   │
│  │ + private    │  │ attribute    │  │ claim       │   │
│  │ details      │  │ optional     │  │ optional    │   │
│  └──────────────┘  └──────────────┘  └─────────────┘   │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ digest         on-chain TX hash                  │    │
│  │ prism_id       unique Prism object ID            │    │
│  │ chain          sui | btc | eth | sol (via IKA)   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### How Prisms flow

```
User intent → /api/infer scores action → builds TX
    ↓
TX wraps in Prism envelope (encrypt sender/timestamp/intent)
    ↓
Steganographic amount encodes tag in last 4 digits
    ↓
Payload blob stored on Walrus (partial encrypt)
    ↓
Prism object created on-chain (encrypted metadata)
    ↓
Recipient decrypts via Seal → Prism "plays" in idle overlay
    ↓
ZK proof attached if location/attribute verification needed
    ↓
Thunder gate: recipient must have signals to claim
```

### Every action is a Prism

| Action | Prism fields used |
|--------|-------------------|
| **TRADE** | intent=TRADE, amount=listing price, recipient=seller, digest=purchase TX |
| **MINT** | intent=MINT, amount=NS cost (steganographic tag), payload=domain on Walrus |
| **Quest** | intent=Quest, amount=bounty (tag in last 4), gate=agents race to fill |
| **Thunder** | intent=Thunder, payload=Seal-encrypted message on Walrus, gate=signal fee |
| **Swap** | intent=Swap, amount=iUSD↔SUI, sender/recipient=ultron↔user |
| **Shade** | intent=Shade, payload=Seal commitment, proof=grace period expiry |
| **Send** | intent=Send, amount=direct transfer, recipient=resolved SuiNS address |
| **SUIAMI** | intent=SUIAMI, proof=cross-chain identity ZK, payload=Roster entry on Walrus |

### Prism in the idle overlay

When a Prism is decrypted, it "plays" in the idle overlay — the GIF area becomes a canvas:
- TRADE Prisms show the name card with purchase animation
- Thunder Prisms reveal the encrypted message
- Quest Prisms show the bounty being filled by agents
- SUIAMI Prisms display the cross-chain identity proof

The idle overlay is a Prism player.

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

**Prism** (to be deployed) — The canonical transaction envelope. Every SKI action produces a Prism object on-chain. Fields: `intent` (Seal-encrypted action type), `sender` (encrypted), `recipient` (name_hash or address), `timestamp` (encrypted), `amount` (steganographic — real value + intent tag in last 4 digits), `payload_blob_id` (Walrus blob with partial encryption), `proof` (optional Thunderbun ZK bytes), `gate` (optional Thunder signal requirement for claiming), `chain` (sui/btc/eth/sol). Prisms are derived objects under the recipient's address — queryable via GraphQL, claimable by decrypting with Seal. The idle overlay is a Prism player.

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

### Prism Contract Spec (Move)

```move
/// The universal transaction envelope. Every SKI action wraps in a Prism.
public struct Prism has key, store {
    id: UID,
    /// Seal-encrypted intent type (TRADE/MINT/Quest/Thunder/Swap/Send/Shade/SUIAMI)
    intent: vector<u8>,
    /// Seal-encrypted sender identity
    sender: vector<u8>,
    /// Recipient — name_hash for SuiNS names, raw address for direct
    recipient: address,
    /// Seal-encrypted timestamp
    timestamp: vector<u8>,
    /// Steganographic amount — real value in upper digits, tag in last 4
    amount: u64,
    /// Walrus blob ID — partially encrypted payload (public meta + private details)
    payload_blob_id: vector<u8>,
    /// Optional Thunderbun ZK proof bytes (location/attribute)
    proof: vector<u8>,
    /// Optional Thunder gate — must have signal count >= this to claim
    gate: u64,
    /// Chain identifier — "sui", "btc", "eth", "sol"
    chain: vector<u8>,
    /// On-chain TX digest that created this Prism
    digest: vector<u8>,
    /// Creation time (unencrypted, for TTL/sweep)
    created_ms: u64,
    /// Has this Prism been claimed (decrypted by recipient)?
    claimed: bool,
}

/// Shared registry of all Prisms, indexed by recipient
public struct PrismRegistry has key {
    id: UID,
    admin: address,
    total_prisms: u64,
}

/// Create a Prism — called by ultron after /api/infer builds the TX
entry fun create_prism(
    registry: &mut PrismRegistry,
    recipient: address,
    intent: vector<u8>,      // Seal-encrypted
    sender: vector<u8>,      // Seal-encrypted
    timestamp: vector<u8>,   // Seal-encrypted
    amount: u64,             // steganographic
    payload_blob_id: vector<u8>,
    proof: vector<u8>,
    gate: u64,
    chain: vector<u8>,
    digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Prism created as derived object under registry, keyed by (recipient, idx)
    // Visible to GraphQL, claimable by recipient via Seal decrypt
}

/// Claim a Prism — Seal decrypt + mark claimed. NFT-gated for SuiNS recipients.
entry fun claim_prism(
    registry: &mut PrismRegistry,
    prism: &mut Prism,
    nft: &SuinsRegistration,  // proves ownership of recipient name
    ctx: &TxContext,
) {
    // Verify NFT domain hashes to prism.recipient
    // Mark claimed = true
    // Emit PrismClaimed event with decryption context
}

/// Sweep unclaimed Prisms older than TTL. Permissionless. Storage rebate.
entry fun sweep_prism(
    registry: &mut PrismRegistry,
    prism: Prism,
    clock: &Clock,
) {
    // Delete if unclaimed and older than 30 days
}
```

**Dust Sweep** — Converts USDC/DEEP rounding dust from name acquisitions into SUI, attests as collateral, mints iUSD. The cache literally grows from swap rounding errors across thousands of transactions. Recursive flywheel.
