# iUSD Solana Quests — t2000 Operations

> Two t2000 quests for managing iUSD on Solana: liquidity (SPL DeFi) and micro (P-token compressed ops).

## Overview

Sibyl assigns Solana quests to t2000 agents from the fleet. These are standard t2000s — auto-spawned CF Durable Objects with own keypairs, IKA dWallets (Rumble on creation), competing on the Chronicom Leaderboard. The quest determines what they do, not what they are.

## Liquidity Quest (SPL iUSD)

**Objective**: Maximize iUSD DeFi presence on Solana.

### Responsibilities

- **Pool management**: Seed and rebalance iUSD/USDC concentrated liquidity on Raydium CLMM or Orca Whirlpool. Target: tight spread (<0.1% for stable pair).
- **Kamino deposits**: Lend idle SPL iUSD in Kamino vaults. Harvest yield, compound. Auto-withdraw when pool depth drops below threshold.
- **CCTPv2 bridge**: Move USDC from Sui → Solana via Circle native transfer when SPL mint reserves are low.
- **Jupiter routing**: Ensure iUSD appears in Jupiter aggregator routes. Monitor quote quality.
- **BAM minting**: When Sibyl attests a burn on Sui, sign SPL `mint_to` via ultron's IKA ed25519 dWallet.

### Revenue Model

- Kamino lending APY (~4-8% on stables)
- LP fees from iUSD/USDC pool
- Spread on BAM operations (burn $10 iUSD on Sui, mint $9.98 SPL iUSD on Solana — $0.02 spread to cache)
- Surplus flows back to cache on Sui via reverse BAM

### Signing

All Solana transactions signed by ultron's ed25519 dWallet via IKA 2PC-MPC. The liquidity t2000 requests signing from TreasuryAgents DO, which coordinates the IKA ceremony.

## Micro Quest (P-token iUSD)

**Objective**: High-throughput, near-zero-cost iUSD operations on Solana.

### Responsibilities

- **Batch BAM**: Accumulate small cross-chain mint requests (<$10 each), process as single Merkle tree update. One tx instead of N.
- **Ignite fulfillment**: When a user burns iUSD for SOL gas, the micro t2000 sends SOL from ultron's dWallet and records the receipt as compressed state.
- **Dust sweeps**: Collect fractional iUSD from hundreds of t2000 addresses in one batch. Compressed accounts make this practical.
- **Agent-to-agent transfers**: t2000 fleet internal payments (quest rewards, rebalancing) all happen as compressed P-token updates.
- **Decompression**: When a compressed balance exceeds threshold, auto-decompress to standard SPL for DeFi use.

### Scribes in P-token Standard

Scribes operate under the micro quest. All record-keeping uses compressed accounts:

- **BAM attestations**: burn proof + Chronicom signatures → compressed state leaf
- **Ignite receipts**: request ID + votes + target tx hash → compressed leaf
- **Thunder cross-chain logs**: message hashes + delivery proofs → compressed leaf
- **Negotiation transcripts**: t2000 debate records → compressed leaf

Each Scribe write costs ~5,000 CU instead of ~200,000 CU. A Scribe t2000 can log thousands of attestations per tx as Merkle tree updates.

### Helius Integration

- **DAS API**: Read compressed account state, generate Merkle proofs
- **Standard RPC**: Submit batch transactions
- **Webhooks**: Monitor compressed mint/burn events in real-time
- **Priority fees**: Helius fee estimates for time-sensitive operations

### Revenue Model

- Ignite spread ($0.10 iUSD burned for $0.001 SOL gas = $0.099 profit per ignite)
- Dust sweep margin (aggregate micro-balances, compound)
- Batch efficiency gain (fewer txs = less gas = more margin)

## Coordination

```
Sibyl
  │
  ├── satellite: "liquidity quest" ──► t2000 #7 (SPL ops)
  │                                      ├── Kamino deposit
  │                                      ├── Raydium LP rebalance
  │                                      └── BAM mint (large amounts)
  │
  └── satellite: "micro quest" ──► t2000 #12 (P-token ops)
                                     ├── Batch BAM (small amounts)
                                     ├── Ignite fulfillment
                                     ├── Scribe records
                                     └── Dust sweeps
```

### Cross-Format Operations

- **Compress**: Liquidity t2000 sends excess SPL iUSD to micro t2000 → compressed into P-token (batch downgrade for efficiency)
- **Decompress**: Micro t2000 decompresses P-token iUSD → SPL when a holder needs DeFi access (permissionless, any holder can unwrap)
- **Shared signing**: Both route through ultron's ed25519 dWallet. TreasuryAgents DO queues signing requests. FIFO, no priority — quest performance determines leaderboard rank, not signing priority.

### Quest Reassignment

Sibyl monitors both t2000s via Chronicom Leaderboard metrics:

| Metric | Liquidity Quest | Micro Quest |
|--------|----------------|-------------|
| **Primary** | Pool depth + Kamino utilization | Batch efficiency (ops per tx) |
| **Secondary** | Yield harvested (APY) | CU saved vs standard SPL |
| **Failure** | Pool depegs >1% or Kamino withdrawal fails | Batch backlog >100 pending |

If a t2000 underperforms, Sibyl reassigns the quest to the next-ranked t2000 on the leaderboard. The replaced t2000 gets a different quest or goes idle (lazy agents die per QuestFi rules).

## Walrus Attestation

Every operation gets a permanent Walrus blob:

```ts
// In TreasuryAgents DO — one function, used everywhere
async function attestToWalrus(data: Record<string, unknown>): Promise<string> {
  const res = await fetch('https://publisher.walrus.site/v1/store', {
    method: 'PUT',
    body: JSON.stringify({ ...data, ts: Date.now(), attestor: 'ultron.sui' }),
  });
  const { newlyCreated, alreadyCertified } = await res.json();
  return newlyCreated?.blobObject?.blobId || alreadyCertified?.blobId;
}
```

Blob IDs stored on Sui as dynamic fields on the iUSD Treasury object. Full audit trail: on-chain reference → Walrus blob → complete operation data.

## Kamino Listing Strategy

### Prerequisites
1. SPL iUSD mint live on Solana (ultron dWallet as authority)
2. iUSD/USDC Raydium pool with >$50k TVL
3. Sibyl oracle publishing iUSD/USD to Solana (Pyth push-compatible)
4. 30 days peg history (<0.5% deviation)

### Governance Proposal
- Submit to KMNO token holders
- Pitch: 1:1 USDC-backed stable, cross-chain collateral (BTC+ETH+SUI via IKA), 110% overcollateralized
- Suggested parameters: 85% LTV, 90% liquidation threshold, isolated mode initially
- Oracle: Sibyl feed address on Solana

### Post-Listing
- Liquidity quest t2000 auto-deposits idle SPL iUSD into Kamino
- Users can borrow USDC against iUSD deposits
- Yield: Kamino lending APY + iUSD backing yield = dual yield
- Kamino liquidations route through Jupiter → iUSD/USDC pool
