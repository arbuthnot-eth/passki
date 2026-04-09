# Thunder IOU — Private On-Chain Escrow

## Overview

Thunder IOUs are private escrow transfers between SuiNS identities. `@brando$1` sends $1 worth of SUI as a claimable IOU to brando.sui, recorded on the StormID (on-chain messaging group).

**Mainnet Package:** `0x05b21b79f0fe052f685e4eee049ded3394f71d8384278c23d60532be3f04535f`
**Module:** `thunder_iou::iou`

## Architecture

IOUs are dynamic fields on the StormID (`PermissionedGroup<Messaging>`). Each conversation's escrows live on its own Storm — no global contention, per-conversation isolation, storage rebate on activate.

**Design voted 2-1 by agent deliberation:**
- Rejected per-IOU shared objects (B) — too expensive at scale for agent economics
- Rejected privacy pool (C) — Seal liveness dependency = worst failure mode for IOUs
- Adopted dynamic fields on Storm (A) + optional `sealed_memo` from B for privacy

## Terminology

| Term | Meaning |
|------|---------|
| **Storm** | On-chain `PermissionedGroup<Messaging>` — the encrypted channel between two SuiNS names |
| **StormID** | Object ID of the Storm (group object) |
| **Initiate** | Create a private on-chain IOU (deposit SUI into StormID dynamic field) |
| **Activate** | Recipient redeems the IOU (proves SuiNS name ownership, withdraws balance) |
| **Expire** | Permissionless cleanup after TTL — returns SUI to sender, keeper gets storage rebate |
| **Thunder** | Seal-encrypted message in the Storm conversation |
| **Timestream** | Off-chain message storage (TimestreamAgent DO) |

## Contract Functions

### `initiate`

Sender deposits SUI as a dynamic field on the StormID.

```move
entry fun initiate(
    storm: &mut UID,              // StormID
    sender_name_hash: vector<u8>, // keccak256("sender.sui")
    recipient_name_hash: vector<u8>, // keccak256("recipient.sui")
    payment: Coin<SUI>,           // SUI to escrow
    ttl_ms: u64,                  // duration (e.g. 604_800_000 = 7 days)
    nonce: u64,                   // timestamp_ms for uniqueness
    sealed_memo: vector<u8>,      // Seal-encrypted context (optional)
    clock: &Clock,
    ctx: &TxContext,
)
```

### `activate`

Recipient redeems. Storage rebate from `dynamic_field::remove` offsets gas.

```move
entry fun activate(
    storm: &mut UID,
    key: vector<u8>,              // iou_key(sender_hash, recipient_hash, nonce)
    recipient_name_hash: vector<u8>, // must match initiate
    clock: &Clock,
    ctx: &mut TxContext,
)
```

### `expire`

Permissionless after TTL. Anyone can call (keeper incentivized by storage rebate).

```move
entry fun expire(
    storm: &mut UID,
    key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
)
```

### `iou_key`

Deterministic key derivation, computable off-chain:

```move
public fun iou_key(
    sender_name_hash: vector<u8>,
    recipient_name_hash: vector<u8>,
    nonce: u64,
): vector<u8>
// Returns keccak256(sender_hash || recipient_hash || bcs(nonce))
```

## Single PTB Flow

`@brando$1` composes everything in ONE transaction, ONE signature:

```
PTB {
  1. splitCoins(gas, $1_in_SUI) → iou_coin
  2. thunder_iou::iou::initiate(stormID, sender_hash, recipient_hash, iou_coin, 7d_ttl, nonce, sealed_memo, clock)
  3. sui_stack_messaging::messaging::create_and_share_group(name, members) [if no Storm exists]
  4. suiami::roster::set_identity(roster, name, name_hash, chains, values, caps, clock) [SUIAMI attestation]
}
```

## Gas Efficiency

### Sender (Initiate)

| Component | Gas Cost | Notes |
|-----------|----------|-------|
| `splitCoins` | ~0.001 SUI | Split from gas coin |
| `initiate` (dynamic field add) | ~0.002 SUI | Storage deposit for Iou struct (~200 bytes) |
| `createAndShareGroup` | ~0.04 SUI | One-time per Storm (two objects) |
| `set_identity` | ~0.003 SUI | Roster dynamic field upsert |
| **Total (first send)** | **~0.046 SUI** | Includes Storm creation |
| **Total (subsequent)** | **~0.003 SUI** | Storm already exists |

### Recipient (Activate)

| Component | Gas Cost | Notes |
|-----------|----------|-------|
| `activate` (dynamic field remove) | ~0.001 SUI | Base gas |
| Storage rebate from remove | -0.002 SUI | Reclaims Iou storage deposit |
| **Net cost** | **~free** | Rebate offsets or exceeds gas |

### Keeper (Expire)

| Component | Gas Cost | Notes |
|-----------|----------|-------|
| `expire` (dynamic field remove) | ~0.001 SUI | Base gas |
| Storage rebate | -0.002 SUI | Incentivizes ultron.sui / Chronicoms |
| **Net cost** | **~negative** | Keeper profits from rebate |

## Gas Payment in iUSD

When the sender's primary balance is iUSD (not SUI), the PTB handles conversion:

```
PTB {
  1. Split iUSD from sender's iUSD coins
  2. iusd::burn(iusd_coin) → get SUI equivalent back (burn-to-SUI)
     OR
     deepbook::swap(iusd_coin, SUI) → market swap on DeepBook
  3. Use resulting SUI for:
     a. Gas payment (set as gas coin)
     b. IOU escrow deposit (initiate)
  4. Remainder returned to sender
}
```

**Priority order for gas sourcing:**
1. SUI balance (cheapest — no swap needed)
2. iUSD → burn to SUI (protocol-level, no slippage)
3. USDC → DeepBook swap to SUI (market rate, minimal slippage)

The iUSD burn path is preferred because it reduces iUSD supply (deflationary) and doesn't touch DEX liquidity.

## iUSD Yield Integration

While SUI sits in escrow (between initiate and activate/expire), it's **idle capital**. The yield path:

```
Initiate → SUI deposited in IOU on StormID
         ↓
ultron keeper (TreasuryAgents alarm tick):
  1. Read IOU balance from StormID dynamic field
  2. Flash loan the equivalent from NAVI (0% fee)
  3. Deposit flash-loaned SUI into Scallop/NAVI lending
  4. Yield accrues to ultron's lending position
         ↓
Activate/Expire:
  1. IOU balance returned to recipient/sender (from StormID, not lending)
  2. Yield earned during escrow period → mint iUSD
  3. iUSD goes to cache (110% overcollateralized surplus)
```

**Key insight:** The IOU balance on the StormID is the real escrow. The yield farming happens on a *separate copy* via flash loan. The two are decoupled — the IOU can be activated at any time regardless of the lending position.

## Events (Decentralized Activity)

```move
IouInitiated { storm_id, iou_key, sender, recipient_name_hash, amount_mist, expires_ms, nonce }
IouActivated { storm_id, iou_key, recipient, amount_mist }
IouExpired   { storm_id, iou_key, returned_to, amount_mist }
```

Events are the decentralized activity feed. Timestream DOs index these via GraphQL subscriptions. No centralized database.

**Privacy:** `amount_mist` is visible in events. For private amounts, use the `sealed_memo` field (Seal-encrypted, only Storm members can decrypt). The event amount can be omitted in a future upgrade by storing amount only in the sealed memo + commitment hash.

## Seal Key Servers (Mainnet)

For `sealed_memo` encryption/decryption, 2-of-3 threshold:

| Operator | Object ID | URL |
|----------|-----------|-----|
| Overclock | `0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6` | `https://seal-mainnet-open.overclock.run` |
| Studio Mirai | `0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10` | `https://open.key-server.mainnet.seal.mirai.cloud` |
| H2O Nodes | `0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a` | `https://seal.sui-mainnet.h2o-nodes.com` |

## Future Extensions

### Multi-Token (`Iou<T>`)
Parameterize with `Balance<T>` — enables USDC, iUSD, NS token IOUs. Same key scheme, add `type_name::get<T>()` to key derivation.

### Cross-Chain Claims (IKA)
Recipient on ETH/SOL activates via IKA dWallet signature. Contract verifies against SUIAMI Roster entry for that chain address.

### Conditional IOUs (Sibyl)
`activate` checks a Sibyl oracle attestation (e.g. "if SOL price > $200"). Conditional execution without oracles in the hot path.

### Proof-of-Payment Badges
`activate` mints a transferable NFT receipt. Badge contains `storm_id`, amount tier (bucketed for privacy), timestamp.

### Recurring IOUs (Subscriptions)
`IntervalIou` struct with `interval_ms`, `installment_amount`. Claimer calls `activate_installment` which verifies clock, pays one installment, increments next claimable.

## Related

- [Thunder Timestream](./2026-03-28-thunder-design.md) — Seal-encrypted messaging
- [Storm concept](./2026-03-28-storm-concept.md) — On-chain conversation groups
- [iUSD](../../README.md) — Yield-bearing stablecoin
- [Shade](../../../contracts/shade/) — Commitment-reveal escrow (inspiration for IOU design)
