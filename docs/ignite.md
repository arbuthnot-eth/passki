# Ignite — Cross-Chain Gas via iUSD

> Burn iUSD, get native gas on any chain. Permissionless. t2000 consensus.

## Concept

Any iUSD holder can request native gas on any chain by burning iUSD worth more than the gas costs. t2000 agents reach supermajority consensus on whether to fulfill the request. The spread (iUSD burned minus gas value) accrues to the cache.

No gates. No KYC. No bridges. Just economics.

## Flow

```
User                     Sui              TreasuryAgents DO        t2000 DOs          Walrus       Target Chain
  │                       │                      │                    │                  │              │
  ├─ ignite(chain,addr) ─►│                      │                    │                  │              │
  │                       │── burn iUSD          │                    │                  │              │
  │                       │── IgniteRequest ────►│                    │                  │              │
  │                       │                      │── fetch vote? ───►│                  │              │
  │                       │                      │◄── {APPROVE} ─────│                  │              │
  │                       │                      │                    │                  │              │
  │                       │                      │── tally (2/3+) ───│                  │              │
  │                       │                      │── quilt votes ────────────────────────►│              │
  │                       │                      │◄── blob ID ───────────────────────────│              │
  │                       │                      │── IKA 2PC-MPC sign ──────────────────────────────────►│
  │                       │◄─ IgniteFulfilled ───│                    │                  │    gas tx ──►│
  │◄── gas received ──────────────────────────────────────────────────────────────────────────────────────┤
```

## On-Chain Contract: `ignite.move`

```
module ignite::ignite {
    /// Request gas on a foreign chain by burning iUSD
    public entry fun request(
        treasury: &mut Treasury,
        payment: Coin<IUSD>,
        chain: vector<u8>,        // "sol", "eth", "btc", "base", "arb"
        recipient: vector<u8>,    // native address bytes on target chain
        ctx: &mut TxContext,
    ) {
        // Enforce minimum payment (covers gas + spread)
        let amount = coin::value(&payment);
        assert!(amount >= MIN_IGNITE_PAYMENT, E_UNDERPAID);
        
        // Burn the iUSD — gone forever, not transferred
        coin::burn(treasury_cap, payment);
        
        // Emit event for t2000 fleet to pick up
        event::emit(IgniteRequest {
            id: object::new(ctx),
            sender: tx_context::sender(ctx),
            chain,
            recipient,
            iusd_burned: amount,
            timestamp: clock::timestamp_ms(clock),
        });
    }
}
```

## t2000 Consensus

t2000 agents don't blindly execute. They debate:

### What they check
1. **Is the payment worth it?** — iUSD burned must exceed gas cost by at least 2x (configurable)
2. **Is the recipient real?** — Valid address format for the target chain
3. **Is the amount suspicious?** — Rate limiting: no single address gets > N ignites per day
4. **Do we have gas?** — ultron/t2000 dWallets must have native tokens on target chain

### Voting — Off-Chain + Quilt

On-chain Thunder signals per vote would cost more gas than the ignite itself. Instead:

1. **Off-chain consensus**: TreasuryAgents DO fans out to all t2000 DOs via internal `fetch()`. Each t2000 returns APPROVE/REJECT with reasoning (JSON). Zero gas — just Cloudflare DO-to-DO HTTP calls.

2. **Quilt**: All votes get batched into a single Walrus blob — the **quilt**. One `walrus store` call captures every t2000's vote, timestamp, and reasoning. Permanent, auditable, cheap.

3. **On-chain anchor**: One tx stores the Walrus blob ID on Sui as the consensus proof. Sibyl indexes quilts on the Timestream.

```
IgniteRequest event (1 tx, user pays)
  → TreasuryAgents fans out to t2000 DOs (free, internal HTTP)
    → Each t2000 returns { vote, reason, gasEstimate }
  → TreasuryAgents tallies: 2/3+ approve?
    → Quilt all votes into Walrus blob (1 store, ~$0.001)
    → Yes: IKA signs native gas tx on target chain (1 tx)
    → No: refund iUSD to sender (1 tx on Sui)
```

**Total on-chain cost**: 1 user tx (burn) + 1 Walrus store (quilt) + 1 execution or refund tx. The consensus itself is free.

- **Supermajority** (2/3+ of active t2000s) required to execute
- Timeout: 30 seconds (not 5 min — DOs respond in milliseconds)
- Quilt blob includes: request ID, all votes, final tally, execution tx hash (if approved)

### Execution
- Winning t2000 (first APPROVE voter, or highest leaderboard rank) gets execution rights
- Signs the native tx via IKA 2PC-MPC on target chain
- Emits `IgniteFulfilled` event with target chain tx hash + quilt blob ID
- Execution t2000 earns priority on Chronicom Leaderboard

## Pricing

The user overpays. That's the whole model.

| Chain | Typical gas cost | Min ignite payment | Spread |
|-------|-----------------|-------------------|--------|
| Solana | ~$0.001 | $0.10 iUSD | ~100x |
| Base | ~$0.01 | $0.10 iUSD | ~10x |
| Ethereum | ~$1-5 | $10 iUSD | ~2-5x |
| Bitcoin | ~$1-10 | $15 iUSD | ~1.5-3x |
| Arbitrum | ~$0.01 | $0.10 iUSD | ~10x |

Minimum payments are floor prices. Users can pay more for priority. t2000s can reject if spread is too thin (gas spike).

## Gas Reserves

t2000 fleet maintains gas reserves across chains:

- **SOL**: ultron ed25519 dWallet holds SOL on Solana
- **ETH**: ultron secp256k1 dWallet holds ETH on Ethereum
- **Base ETH**: Same secp256k1 dWallet, different chain
- **BTC**: Same secp256k1 dWallet, BTC network

### Replenishment
When gas reserves run low on a chain:
1. Sibyl detects low balance via Chronicom polling
2. Fires satellite to TreasuryAgents
3. TreasuryAgents uses cache USDC to buy native gas on target chain
4. CCTPv2 for USDC movement + DEX swap for native token

## Why This Works

1. **Permissionless** — No gates. Economics protect the system. Overpayment = anti-spam.
2. **Profitable** — Every ignite grows the cache. The spread compounds.
3. **Decentralized execution** — t2000 supermajority, not a single keeper. Byzantine fault tolerant.
4. **No bridges** — IKA dWallets sign native transactions. Real gas, real addresses.
5. **Universal** — Works on any chain where ultron has a dWallet (all of them after Rumble).
6. **Composable** — Other protocols can integrate ignite. Hold iUSD, get gas anywhere.

## The Ignite Flywheel

```
User needs gas on Solana
  → Burns $0.10 iUSD
    → t2000s approve (100x spread, easy yes)
      → ultron sends 0.001 SOL to user
        → User can now transact on Solana
          → User earns yield on Solana
            → User buys more iUSD
              → Cache grows
                → More gas reserves funded
                  → More ignites possible
                    → iUSD becomes the universal gas token
```

## Edge Cases

**Gas spike**: ETH gas spikes to $50. User paid $10 iUSD. t2000s vote REJECT (spread negative). User can retry with higher payment or wait for gas to drop.

**Drain attack**: Attacker burns $0.10 iUSD 1000 times for SOL. Each ignite is profitable (100x spread). System earns $100 in iUSD, sends $1 in SOL. Net positive. Rate limiting per address prevents nuisance.

**No gas reserves**: ultron is dry on ETH. t2000s vote REJECT with reason "NO_RESERVES". Sibyl triggers replenishment. User retries later.

**Refund path**: If supermajority rejects or times out (30s), the IgniteRequest includes the sender address. A `refund()` function mints iUSD back to sender (minus small processing fee to prevent spam refund loops).

## Quilt — Batched Consensus on Walrus

A quilt is a single Walrus blob containing all t2000 votes for one ignite request. Structure:

```json
{
  "type": "ignite-quilt",
  "requestId": "0xabc...",
  "timestamp": 1711900800000,
  "chain": "sol",
  "recipient": "7xKX...",
  "iusdBurned": 100000000,
  "votes": [
    { "agent": "ultron.sui", "vote": "APPROVE", "gasEstimate": 1000, "reason": "100x spread" },
    { "agent": "aida.sui", "vote": "APPROVE", "gasEstimate": 1200, "reason": "profitable" },
    { "agent": "vision.sui", "vote": "APPROVE", "gasEstimate": 900, "reason": "reserves healthy" }
  ],
  "tally": { "approve": 3, "reject": 0, "total": 3, "threshold": 2 },
  "result": "APPROVED",
  "executionTx": "5xYz...",
  "executorAgent": "ultron.sui"
}
```

Quilts serve double duty:
- **Audit trail** — Every ignite decision is permanently recorded on Walrus
- **Dispute resolution** — If an ignite fails, the quilt proves what agents decided and why
- **Leaderboard data** — Sibyl reads quilts to score t2000 agents on accuracy and speed
- **Reusable pattern** — Any t2000 consensus (not just ignite) can use quilts

## Implementation Order

1. **Move contract** — `ignite::ignite` with `request()`, `refund()`, events
2. **API endpoint** — `POST /api/ignite` (convenience wrapper, builds PTB for user)
3. **t2000 consensus** — Off-chain DO-to-DO voting + Walrus quilt storage
4. **IKA execution** — Signing ceremony triggered by winning t2000
5. **Gas reserves** — Sibyl monitoring + auto-replenishment
6. **UI** — Ignite button on idle overlay (the ⚡ quick-action button?)
