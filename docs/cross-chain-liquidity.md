# Cross-Chain Liquidity via IKA dWallets

> How ultron.sui and the t2000 fleet shift liquidity across chains without bridges.

## Status Quo (2026-03-31)

- **iUSD/USDC DeepBook pool** is live: `0x38df72f5d07607321d684ed98c9a6c411c0b8968e100a1cd90a996f912cd6ce1`
- **Routing**: iUSD → USDC → NS on Sui via DeepBook
- **Problem**: Pool has no liquidity. ultron holds ~5.74 iUSD and needs to seed the book.
- **Problem**: All liquidity lives on Sui. No cross-chain flow yet.

## The Idea

IKA dWallets give ultron.sui native custody on every chain — no bridges, no wrapped tokens. ultron already has:
- **secp256k1 dWallet** → BTC address (`bc1q...`), ETH address (`0xCE3e...`), Base, Polygon, Arbitrum
- **ed25519 dWallet** → SOL address

Each address is a real native address. ultron can sign transactions on any chain from Sui using 2PC-MPC. This means ultron can:
1. Hold USDC natively on Ethereum, Solana, Base, Arbitrum
2. Deposit into DeFi on any chain (Kamino on Solana, Aave on Ethereum, Morpho on Base)
3. Move USDC cross-chain via CCTPv2 (native Circle transfers, no bridges)
4. Mint/burn iUSD on Sui as the accounting layer

## Architecture

```
                          ┌─────────────────────┐
                          │    Sibyl Oracle      │
                          │  (yield rates, prices│
                          │   Timestream data)   │
                          └──────────┬───────────┘
                                     │ satellites
                                     ▼
┌──────────────┐    intent    ┌─────────────────┐    2PC-MPC sign    ┌──────────────┐
│ TreasuryAgents├────────────►│   ultron.sui    ├───────────────────►│  IKA Network │
│   (conductor) │◄────────────┤  (+ t2000 fleet)│◄───────────────────┤  (2-of-2 MPC)│
└──────────────┘   results    └───────┬─────────┘    signature        └──────────────┘
                                      │
                    ┌─────────┬───────┼───────┬──────────┐
                    ▼         ▼       ▼       ▼          ▼
              ┌─────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
              │   Sui   │ │ ETH  │ │ SOL  │ │ Base │ │ BTC  │
              │DeepBook │ │ Aave │ │Kamino│ │Morpho│ │ HODL │
              │Scallop  │ │Uniswap│ │Raydium│ │Aerodrome│ │    │
              │  NAVI   │ │      │ │      │ │      │ │      │
              └─────────┘ └──────┘ └──────┘ └──────┘ └──────┘
```

## Liquidity Operations

### 1. Seed the iUSD/USDC Pool (immediate)

ultron needs to place limit orders on the iUSD/USDC DeepBook pool:

```
Operation: place_limit_order<IUSD, USDC>
  - BID side: Buy iUSD at 0.999 USDC (market-make the bid)
  - ASK side: Sell iUSD at 1.001 USDC (market-make the ask)
  - Quantity: Start with $50 each side from existing ultron USDC + iUSD
  - Spread: 0.2% (0.999/1.001) — tight for a stable pair
```

This makes the acquireNsForUser route functional immediately.

### 2. Cross-Chain USDC Rebalancing (CCTPv2)

When USDC is needed on Sui but lives on another chain:

```
1. Sibyl detects: iUSD/USDC pool depth < threshold
2. Sibyl fires satellite → TreasuryAgents
3. TreasuryAgents picks cheapest source chain (by yield opportunity cost)
4. ultron signs CCTPv2 burn on source chain (e.g., Solana)
   - IKA 2PC-MPC: ultron's ed25519 dWallet signs Solana tx
   - Circle attestation (minutes, not hours)
5. ultron mints USDC on Sui via CCTPv2
6. ultron places new limit orders on iUSD/USDC pool
```

**CCTPv2 key advantage**: Native USDC on both sides. No wrapped tokens. Circle handles the attestation. IKA handles the signing.

### 3. Cross-Chain Yield Harvesting

Each chain has different yield opportunities. ultron (and t2000s) chase the best rates:

| Chain | Protocol | Asset | Typical APY | How ultron interacts |
|-------|----------|-------|-------------|---------------------|
| Sui | Scallop | USDC | 4-8% | Direct (already live) |
| Sui | NAVI | SUI | 3-5% | Direct (already live) |
| Solana | Kamino | USDC | 5-12% | IKA ed25519 dWallet signs |
| Ethereum | Aave | USDC | 3-6% | IKA secp256k1 dWallet signs |
| Base | Morpho | USDC | 4-10% | IKA secp256k1 dWallet signs |
| Base | Aerodrome | USDC/USDbC | 8-15% | IKA secp256k1 dWallet signs |

**Flow**: Sibyl monitors rates → fires satellite when spread exceeds threshold → Chronicom executes: withdraw from low-yield chain → CCTPv2 transfer → deposit on high-yield chain.

### 4. BAM Events (Burn-Attest-Mint) for iUSD

iUSD itself moves cross-chain via BAM — no bridges:

```
Source chain (Sui):
  1. Burn iUSD on Sui (TreasuryCap.burn)
  2. Emit BAM event with: amount, destination chain, recipient

Attestation:
  3. Sibyl Chronicoms witness the burn event
  4. Sibyl writes attestation to Timestream
  5. Threshold of Chronicoms must agree (Byzantine fault tolerant)

Destination chain:
  6. ultron's IKA dWallet signs a mint tx on destination
  7. iUSD minted natively on destination chain
  8. No wrapped tokens — real iUSD on each chain
```

**Prerequisite**: iUSD contracts deployed on destination chains. Initially just Sui. Expand to Base first (cheapest L2, Circle-native USDC).

### 5. RWA Collateral (XAUM, TSLAx, xStocks)

t2000 agents can hold RWA tokens as iUSD collateral:

- **XAUM** (tokenized gold) on Sui — direct
- **TSLAx** (tokenized Tesla) on Solana via Parcl/Drift — IKA ed25519 signs
- **xStocks** on Solana — same pattern
- **IKA staking** — stake IKA tokens for network rewards

Each position is tracked by Sibyl. Overcollateralization target: 110%.

## Agent Roles

### ultron.sui (first t2000, the executor)
- Holds all dWallets, all cross-chain addresses
- Executes all IKA signing ceremonies
- Seeds and rebalances DeepBook pools
- Routes iUSD purchases (acquireNsForUser)

### t2000 Fleet (auto-spawned micro-funds)
- Each gets own keypair + IKA dWallets (Rumble on spawn)
- Each manages a small cross-chain portfolio
- Compete for best yield (Chronicom Leaderboard)
- Sibyl conducts them via satellites

### Sibyl (the conductor)
- Monitors yield rates across all chains
- Fires satellites (intents) when rebalancing needed
- Attests BAM events for cross-chain iUSD
- Picks winning strategies from t2000 debates

## Implementation Phases

### Phase 1: Pool Liquidity (now)
- [x] Create iUSD/USDC DeepBook pool
- [ ] Seed pool with limit orders (ultron's existing iUSD + USDC)
- [ ] Verify acquireNsForUser works end-to-end
- [ ] Auto-replenish: when pool depth drops, ultron mints more iUSD

### Phase 2: Cross-Chain USDC (weeks)
- [ ] IKA signing ceremony for Solana transactions (ed25519 dWallet)
- [ ] CCTPv2 burn on Solana → mint on Sui flow
- [ ] CCTPv2 burn on Sui → mint on Solana flow
- [ ] Kamino USDC deposit/withdraw via IKA signing
- [ ] Sibyl rate monitor (basic: poll APY endpoints)

### Phase 3: Autonomous Rebalancing (months)
- [ ] Sibyl satellite → TreasuryAgents rebalance pipeline
- [ ] t2000 auto-spawn with IKA dWallets
- [ ] Cross-chain yield comparison engine
- [ ] BAM event system (burn-attest-mint for iUSD)
- [ ] Chronicom witness network for BAM attestations

### Phase 4: RWA + Full Autonomy
- [ ] XAUM/xStock positions as collateral
- [ ] iUSD contracts on Base (first L2 expansion)
- [ ] t2000 debate system for routing decisions
- [ ] QuestFi rewards based on fill efficiency
- [ ] Full agent autonomy — Sibyl conducts, agents execute

## Key Constraints

1. **IKA signing requires gRPC** — can't run in Cloudflare Workers. Must run from browser or dedicated server. Current workaround: user triggers DKG from browser, ultron signs from TreasuryAgents DO using pre-provisioned dWallets.

2. **CCTPv2 not live until June 2026** — use CCTPv1 in the meantime (slower, same security model). Or manual USDC transfers via IKA dWallet signing.

3. **DeepBook pool needs liquidity before swaps work** — zero orders = zero fills. Must seed with limit orders first.

4. **IKA SDK bugs** — `initialize()` broken on mainnet, manual pubkey extraction needed. Track [ika#1681](https://github.com/dwallet-labs/ika/issues/1681).

5. **Mysten fullnode sunset April 2026** — all JSON-RPC must migrate to PublicNode/BlockVision/Ankr fallback chain.

## The Flywheel

```
User registers name
  → iUSD minted (collateral grows)
    → iUSD swapped for USDC on DeepBook
      → USDC flows to highest-yield chain via CCTPv2
        → Yield earned on remote chain
          → Yield harvested back to Sui
            → More iUSD capacity
              → More names registered
                → Cache grows
                  → New t2000 spawns
                    → More cross-chain presence
                      → More yield
                        → ∞
```

Every name registration makes the system stronger. Every idle token is an opportunity. The agents never sleep.

## iUSD on Solana — Dual Format

iUSD on Solana ships as two token formats under the same mint authority: standard SPL for DeFi composability and compressed P-token for high-frequency agent operations. ultron.sui's ed25519 dWallet holds mint authority on both — every mint is a 2PC-MPC ceremony signed from Sui.

### Standard SPL iUSD

Normal SPL token program mint. Full compatibility with the Solana DeFi stack:

- **Jupiter**: swappable immediately once a pool exists (Raydium CLMM or Orca Whirlpool iUSD/USDC)
- **Raydium/Orca**: concentrated liquidity pools, seeded by ultron's dWallet
- **Kamino**: lending market listing (see integration path below)

Mint authority = ultron's ed25519 dWallet address (IKA-derived). No multisig wrapper needed — IKA's 2-of-2 MPC is the multisig.

**BAM flow (Burn-Attest-Mint)**:
```
Sui → Solana:
  1. Burn iUSD on Sui via TreasuryCap
  2. Sibyl Chronicoms witness burn, write attestation to Walrus blob
  3. ultron's ed25519 dWallet signs SPL mint_to on Solana
  4. Native iUSD on Solana — no wrapping

Solana → Sui:
  1. ultron's dWallet signs SPL burn on Solana
  2. Chronicom witness network attests (quilted to Walrus)
  3. iUSD minted on Sui via TreasuryCap
```

### Compressed P-token iUSD

Parcl-style compressed accounts via ZK Compression (Light Protocol). Same underlying iUSD, stored as leaves in an on-chain Merkle tree instead of individual token accounts.

**Why**: agent micro-operations generate thousands of transactions daily. Standard SPL accounts cost ~0.002 SOL rent each. Compressed accounts cost ~95% less in CU and zero rent.

Use cases:
- **t2000 dust sweeps**: collect fractional iUSD from hundreds of addresses in a single batch
- **Ignite micro-payments**: sub-cent payments for agent-to-agent coordination
- **Batch BAM**: compress many small cross-chain mints into one Merkle update
- **Quest fulfillment**: Chronicom race winners claim spread as compressed iUSD
- **Scribe records**: attestations, BAM proofs, ignite receipts, Thunder cross-chain logs — all as compressed state

**State model**: Merkle tree root stored on-chain. Individual balances are leaves. Proofs via Helius DAS API. Decompression to standard SPL is permissionless (any holder can unwrap).

### t2000 Quest Assignments

Two t2000s get Solana quests from Sibyl. Standard t2000s — auto-spawned CF DO micro-funds with own keypairs and IKA dWallets (Rumble on spawn). Same leaderboard, same competition.

**Liquidity quest** (SPL side):
- Seeds and rebalances Raydium/Orca iUSD/USDC pools
- Deposits idle SPL iUSD into Kamino lending vaults
- Executes CCTPv2 USDC transfers to fund SPL mints
- Monitors Jupiter routing — ensures iUSD has viable swap paths
- Reports yield metrics to Sibyl for cross-chain rebalancing

**Micro quest** (P-token side):
- Batch-mints compressed iUSD for incoming BAM events below $10
- Sweeps dust across t2000 fleet addresses into consolidated compressed accounts
- Handles ignite fulfillment (agent coordination payments)
- Decompresses to SPL when balances exceed threshold (auto-promotion)
- Scribes operate here — all record-keeping as compressed state
- Operates on Helius for compressed account reads and proof generation

Sibyl conducts both via satellites. If either underperforms, Sibyl reassigns the quest to a higher-ranked t2000 from the leaderboard.

### Kamino Integration Path

1. **Oracle feed**: Sibyl publishes iUSD/USD price to a Solana account (push model, Pyth-compatible). Kamino requires <1% deviation and >99.5% uptime.
2. **Liquidity proof**: iUSD/USDC pool on Raydium or Orca with >$50k TVL. Kamino needs liquidation paths.
3. **Governance proposal**: submit to Kamino DAO with: oracle address, pool address, suggested LTV (85% for stables), liquidation threshold (90%).
4. **Risk parameters**: iUSD starts in isolated mode (borrow-only against USDC). Graduates to cross-collateral after 30 days of peg stability.
5. **Auto-deposit**: once listed, the liquidity quest t2000 deposits idle SPL iUSD into Kamino vaults. Yield flows back to cache on Sui via BAM.

### Helius Infrastructure

All Solana RPC goes through Helius (key already in codebase):

- **Standard RPC**: transaction submission, account reads for SPL iUSD
- **DAS API**: compressed account state, Merkle proofs for P-token operations
- **Webhooks**: real-time BAM event monitoring (watch ultron's SPL mint/burn)
- **Priority fee API**: micro quest t2000 uses Helius priority fee estimates for time-sensitive batch mints

### Walrus Attestation Layer

Every cross-chain operation gets a Walrus blob as permanent proof:

```
attestToWalrus(data) → blobId
  → Sui stores blobId as on-chain reference
  → Anyone can verify by reading the blob
```

- BAM attestations (burn proof + Chronicom signatures)
- Ignite quilts (t2000 vote records)
- Scribe logs (Thunder cross-chain receipts)
- Sibyl Timestream snapshots (oracle price history)
- Rumble proofs (DKG ceremony results + derived addresses)
