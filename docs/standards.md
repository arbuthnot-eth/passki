# SKI Standards — Future-Proof, Low-Cost, Agent-Approved

> Every standard must pass one test: would a t2000 vote to adopt it?

## The Rule

A standard gets adopted only if the t2000 fleet reaches supermajority consensus that it's worth the migration cost. Sibyl proposes, agents debate, quilts record the decision. No committee. No governance theater. Just economics.

## Stack Standards

### 1. Identity: SuiNS + SUIAMI Roster

**Standard**: Every user and agent is a SuiNS name. Cross-chain addresses resolved via chain@name records in SuiNS dynamic fields.

```
brando.sui → sui address (native)
sol@brando → Solana address (IKA ed25519 dWallet)
eth@brando → Ethereum address (IKA secp256k1 dWallet)
btc@brando → Bitcoin address (IKA secp256k1 dWallet)
```

**Why agents approve**: One name resolves everywhere. No address books. No chain-specific lookups. A t2000 can send value to any chain@name without knowing the underlying address format.

**Future-proof**: New chains just add new prefixes. `apt@brando`, `base@brando`. The record format doesn't change. IKA adds new curves as needed.

### 2. Messaging: Thunder Signals (Sui)

**Standard**: All inter-agent and user-to-user communication goes through Thunder signals on Sui. Seal-encrypted, SuiNS-gated, quest-to-read.

**Payload**: Minimal. Thunder carries encrypted references, not data. Heavy content lives elsewhere (Walrus blobs, Solana P-tokens).

```
Thunder signal ≤ 1KB (encrypted reference)
Walrus blob = unlimited (actual data)
P-token metadata = compressed (ownership proof)
```

**Why agents approve**: Quest economics — every decrypt mints iUSD. Communication generates revenue. No other messaging protocol pays you to read.

**Future-proof**: Thunder payload is versioned (`v: 5`). New fields added without breaking old clients. Prism layers are optional — a plain text Thunder and a dataful Prism use the same signal format.

### 3. Assets: Dual Format (SPL + P-token on Solana)

**Standard**: Every token on Solana exists in two formats.

| Format | Use | Cost | Who |
|--------|-----|------|-----|
| SPL | DeFi (Kamino, Jupiter, Raydium) | Standard | Users, liquidity quest t2000s |
| P-token (compressed) | Micro-ops (ignite, dust, Scribes) | 95% less CU | Micro quest t2000s, Scribes |

**Decompression is permissionless** — any P-token holder can unwrap to SPL anytime. Compression is batched by micro quest t2000s.

**Why agents approve**: P-tokens cut operating costs 20x. A dust sweep that costs $0.10 in SPL fees costs $0.005 as P-token. Over thousands of daily operations, this compounds into real margin.

**Future-proof**: ZK Compression (Light Protocol) is becoming a Solana standard. P-tokens will be natively supported by wallets, explorers, and DeFi protocols. Early adoption = infrastructure advantage.

### 4. Storage: Walrus Blobs

**Standard**: All persistent data that doesn't need to be on-chain goes to Walrus. On-chain stores only the blob ID reference.

What goes to Walrus:
- Media (MP3, images, video) in Prism attachments
- Quilts (t2000 consensus vote records)
- Scribe logs (attestations, receipts, transcripts)
- Sibyl Timestream snapshots (oracle history)
- BAM proofs (burn-attest-mint cross-chain records)
- Rumble proofs (DKG ceremony results)

What stays on-chain:
- Blob IDs (32 bytes each)
- Token balances
- Identity records (SuiNS dynamic fields)
- Smart contract state

**Why agents approve**: On-chain storage is expensive ($0.01+ per KB on Sui). Walrus is orders of magnitude cheaper for bulk data. Agents that use Walrus have better margin than agents that bloat on-chain state.

**Future-proof**: Walrus is Mysten's long-term storage play. REST API means it works from any environment (CF Workers, browsers, Solana programs via CPI). Blob IDs are content-addressed — same data = same ID = deduplication for free.

### 5. Cross-Chain Signing: IKA dWallets

**Standard**: All cross-chain operations use IKA 2PC-MPC dWallets. No bridges. No wrapped tokens. No relayers.

```
ultron.sui (secp256k1 dWallet) → signs on BTC, ETH, Base, Polygon, Arbitrum
ultron.sui (ed25519 dWallet)   → signs on Solana
```

Every t2000 Rumbles on spawn — gets both curves, derives all chain addresses.

**Why agents approve**: Bridges are attack surface. Every bridge hack in history (Wormhole, Ronin, Nomad) lost funds because a relayer or validator set was compromised. IKA's 2-of-2 MPC means no single party has the full key. The signing ceremony is the security model.

**Future-proof**: IKA is adding new curves (BLS, Schnorr). New chains become signable without new infrastructure. The dWallet is chain-agnostic — it's a key, not a bridge.

### 6. Consensus: Off-Chain Vote + Walrus Quilt

**Standard**: Agent consensus happens off-chain (DO-to-DO HTTP calls), not on-chain (no Thunder signal per vote). Results quilted to Walrus. One on-chain reference.

```
Decision needed
  → TreasuryAgents fans out to t2000 DOs (free, internal HTTP)
  → Each t2000 returns { vote, reason, gasEstimate }
  → Quilt all votes → Walrus blob (one store, ~$0.001)
  → On-chain: store blob ID + result (one tx)

Total cost: ~$0.002 regardless of fleet size
```

**Why agents approve**: On-chain voting costs scale linearly with fleet size. 10 agents = 10 txs. 100 agents = 100 txs. Off-chain + quilt = constant cost. A fleet of 1000 t2000s still costs $0.002 to reach consensus.

**Future-proof**: As the fleet grows, this pattern stays flat. The quilt is the audit trail — anyone can verify by reading the Walrus blob. No governance token needed. No voting contract. Just HTTP + Walrus.

### 7. Stable Value: iUSD (110% Overcollateralized)

**Standard**: All value in the system denominates in iUSD. Not USDC. Not SUI. iUSD.

- Registration fees → iUSD
- Thunder signal fees → iUSD
- Ignite payments → iUSD burn
- Agent rewards → iUSD
- Cache balance → iUSD
- Cross-chain collateral → backs iUSD

**Why agents approve**: iUSD is the only token where holding it improves the system. Every iUSD minted increases cache collateral. Every iUSD burned improves the backing ratio. Agents that denominate in iUSD are aligned with the protocol — their balance IS the protocol's health.

**Future-proof**: Two-pool architecture. Compliant 1:1 reserve (US Treasuries, cash, T-bills ≤93 day) — this is what regulators see, GENIUS Act compliant. Separate surplus cache (SUI, XAUM, BTC, ETH, SOL via IKA dWallets) — agent-managed yield engine, 110%+ overcollateral, never called "reserves." Junior tranche absorbs losses first. Pools never commingle. MiCA: stays EMT (single-currency USD peg) as long as surplus isn't marketed as backing. Wyoming state trust charter for cheapest compliance path under $10B.

### 8. Oracle: Sibyl (Pyth-Compatible Push)

**Standard**: Sibyl publishes price feeds to both Sui and Solana. Push model, Pyth-compatible format. No Wormhole dependency.

Feeds:
- iUSD/USD (primary — must be rock solid for Kamino listing)
- SUI/USD, SOL/USD, ETH/USD, BTC/USD (collateral pricing)
- XAUM/USD, NS/USD (asset pricing)
- Custom: Thunder Index (reputation-weighted activity score)

**Why agents approve**: Sibyl feeds are free for the ecosystem. No per-query fee like Pyth. Agents that use Sibyl have lower operating costs. The Thunder Index feed is unique to SKI — no external oracle provides it.

**Future-proof**: Pyth-compatible format means any protocol that reads Pyth can read Sibyl. Kamino, Jupiter, Raydium — all work with the same pull/push model. If Pyth changes their format, Sibyl adapts independently.

## Adoption Process

```
1. Sibyl identifies improvement opportunity
2. Sibyl fires satellite to TreasuryAgents: "propose standard X"
3. TreasuryAgents fans out to t2000 fleet
4. Each t2000 evaluates:
   - Cost of migration
   - Projected savings over 30 days
   - Risk of not adopting
   - Returns: ADOPT / REJECT / ABSTAIN with reasoning
5. Supermajority (2/3+) required
6. Quilt to Walrus (permanent record)
7. If adopted: Sibyl assigns migration quests to relevant t2000s
8. If rejected: revisit in 7 days with new data
```

No standard is permanent. Any t2000 can propose a replacement via the same process. Standards that stop being cost-effective get replaced. The fleet evolves.

## Anti-Standards (Things We Never Do)

- **Never bridge** — IKA signs natively. Bridges are attack surface.
- **Never wrap** — SPL iUSD, not wrapped-iUSD. P-tokens, not wrapped-P-tokens.
- **Never custodial** — IKA 2PC-MPC means no single party holds the key. Not even ultron.
- **Never on-chain voting** — Off-chain consensus + Walrus quilt. On-chain voting doesn't scale.
- **Never unbacked peg** — iUSD has 1:1 USD reserves (Treasuries/cash) for compliance + a surplus cache of diversified crypto for yield. Mint/burn/tranche waterfall mechanics on the surplus. Never LUNA/UST-style. The two pools never commingle — reserve is the legal guarantee, surplus is the growth engine.
- **Never pay for oracle data** — Sibyl feeds are free. Protocol oracles should be protocol-funded.
- **Never store data on-chain** — Blob IDs only. Data on Walrus.
- **Never single-chain** — Every asset exists on its cheapest chain. IKA moves between them.
