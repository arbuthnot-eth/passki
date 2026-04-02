# Thunder Hybrid — Relayer Chat + On-Chain Economic Signals

> Regular messages go through a relayer (free, instant). Value-bearing signals stay on-chain (fees, proofs, purge mechanics).

## The Insight

Mysten's Messaging SDK Beta (March 31, 2026) introduced a **backend relayer pattern** — no tx per message. Messages flow through a relayer that can't read them (Seal encrypted). Only group membership and encryption keys live on-chain.

Thunder currently puts every signal on-chain. That's expensive (~0.003 SUI per signal) and slow (block confirmation). For "what up dinggong" that's overkill. For a $7.77 Prism with cross-chain collateral, on-chain is essential.

The hybrid: **two tiers of Thunder**.

## Two Tiers

### Tier 1: Relay Thunder (free, instant)

For regular conversation — text messages, media references, casual chat.

```
Sender → Seal encrypt → Relayer → Recipient
                          ↓
                    Walrus blob (persistence)
```

- **No gas per message** — relayer delivers for free
- **Seal encrypted** — relayer sees ciphertext only, can't read content
- **Walrus persistence** — messages stored as blobs, not on-chain objects
- **SuiNS gated** — relayer checks MemberCap or SuiNS NFT ownership before delivery
- **Real-time** — WebSocket push, no block wait
- **Scribe logged** — compressed P-token on Solana for audit trail (micro quest)

### Tier 2: Storm Thunder (on-chain, economic)

For value-bearing signals — Prisms, payments, ignite requests, quest-to-mint.

```
Sender → On-chain PTB → Storm shared object → Recipient purges → iUSD mint
```

- **Per-signal fee** — routes to iUSD cache
- **Delete-on-read** — purge returns storage rebate
- **On-chain proof** — every signal is verifiable, every purge is provable
- **Read receipts** — white bubble = signal purged from Storm
- **Cross-chain** — IKA dWallets enable BTC/ETH/SOL participation
- **Quest = Mint** — opening a Prism triggers iUSD mint from attached collateral
- **Random signals** — `random_signal` uses Sui's `Random` object for dice rolls

## When to Use Which

| Message type | Tier | Why |
|---|---|---|
| "hey what's up" | Relay | No economic value, no need for on-chain proof |
| "check this track" + MP3 | Relay | Media blob on Walrus, P-token on Solana, reference via relay |
| $7.77 Prism with payment | Storm | Value transfer needs on-chain proof + fee mechanics |
| Ignite request (burn iUSD for gas) | Storm | Burns iUSD on-chain, needs verifiable proof |
| Read receipt (✓ read by name.sui) | Storm | On-chain proof that signal was purged |
| t2000 consensus vote | Relay | Off-chain vote, quilted to Walrus after |
| Agent-to-agent coordination | Relay | High volume, low value per message |
| SUIAMI verification | Storm | Identity proof needs on-chain attestation |
| Random dice roll | Storm | Sui's `Random` object only works on-chain |
| Scribe attestation | Relay + Walrus | Log to Walrus blob, anchor blob ID on-chain later in batch |

## The Relayer

### Architecture

The relayer is a Cloudflare Durable Object — same infrastructure as Chronicoms, TreasuryAgents, and t2000s. It's NOT a centralized server. Each conversation gets its own DO instance.

```
┌──────────────┐     WebSocket      ┌──────────────┐
│  Sender app  ├───────────────────►│  Relay DO    │
│  (browser)   │◄───────────────────┤  (per-convo) │
└──────────────┘                    └──────┬───────┘
                                           │
                                    ┌──────┴───────┐
                                    │  Recipient   │
                                    │  (browser)   │
                                    └──────────────┘
                                           │
                                    ┌──────┴───────┐
                                    │   Walrus     │
                                    │  (persist)   │
                                    └──────────────┘
```

### What the Relayer CAN'T Do

- Read message content (Seal encrypted, relayer doesn't have the key)
- Forge messages (sender signs each message, recipient verifies)
- Withhold messages (recipient can check Walrus blobs directly)
- Link sender to recipient (encrypted metadata)

### What the Relayer CAN Do

- Deliver messages in real-time (WebSocket push)
- Store encrypted blobs on Walrus for persistence
- Rate-limit spam (IP + SuiNS identity based)
- Serve message history (encrypted, from Walrus)

### Authentication

The relayer verifies identity before accepting connections:

1. Client connects via WebSocket with a signed challenge
2. Relayer verifies the signature against the sender's Sui address
3. Relayer checks SuiNS ownership (does this address own the claimed name?)
4. If verified, connection is accepted and messages flow

No MemberCap minting needed (unlike Mysten's SDK). SuiNS NFT ownership IS the membership proof. The relayer reads it from on-chain state — no tx required.

## What We Steal from Mysten's SDK

### 1. Groups SDK Integration

Mysten's `@mysten/sui-groups` provides RBAC (roles, permissions, pause/unpause). We can use this for:

- **Thunder channels** — group conversations beyond 1:1
- **t2000 fleet channels** — agent coordination rooms
- **Token-gated communities** — hold NS/iUSD/XAUM to join
- **Scribe rooms** — read-only channels where Scribes post attestations

### 2. Session Keys

Mysten's SDK supports session keys for automated messaging. Perfect for:

- **t2000 agents** — sign messages without full wallet access
- **Chronicoms** — post updates to channels automatically
- **Sibyl** — broadcast oracle data to subscriber channels

### 3. Encryption Key Rotation

Their SDK supports key rotation with history. Thunder currently uses a single AES key per signal. For long-lived relay conversations, key rotation prevents compromise of old messages if a key leaks.

### 4. Client Extension Pattern

`SuiClient.$extend(messaging(...))` is clean. We could expose Thunder as:

```ts
import { thunder } from '@ski/thunder';
const client = new SuiClient({ url }).extend(thunder({
  relayUrl: 'wss://relay.sui.ski',
  sealKeyServers: ['overclock', 'nodeinfra', 'studiomirai'],
}));

// Relay message (free, instant)
await client.thunder.send('brando.sui', 'what up dinggong');

// Storm signal (on-chain, economic)
await client.thunder.signal('brando.sui', { value: 7_770_000_000n, message: 'prism attached' });
```

## What Mysten's SDK Doesn't Have (Thunder's Moat)

### 1. Economic Layer

No per-message fees. No revenue routing. No iUSD mint on read. Thunder turns communication into economic activity. Every signal is a micro-transaction. Every purge improves the collateral ratio.

Mysten's SDK is plumbing. Thunder is plumbing + economics.

### 2. Ephemeral Messaging (Purge)

Mysten's SDK is append-only (`TableVec<Message>`). Messages accumulate forever. Thunder signals are ephemeral — purge on read, storage rebate returned. The chain stays clean.

This matters at scale: a channel with 10M messages in a `TableVec` becomes expensive to interact with. Thunder's Storm object stays lean because signals are consumed.

### 3. SuiNS-Native Identity

Mysten uses raw addresses + MemberCap objects. Thunder uses SuiNS names — `brando.sui`, `t2000.sui`. The name IS the identity. No MemberCap minting, no address management. You know a name, you can message them.

### 4. Cross-Chain via IKA

Storm (the cross-chain Thunder extension) lets BTC/ETH/SOL addresses participate via IKA dWallet-gated Seal decryption. Mysten's SDK is Sui-only.

### 5. Read Receipts

White bubble = signal purged from Storm = recipient read it. Mysten's SDK has no read mechanics at all.

### 6. Random Signals

Sui's `Random` object (0x8) in `random_signal` — dice rolls that neither sender nor recipient can predict. On-chain only. Mysten's relayer pattern can't do this.

### 7. Prisms (Rich Encrypted Transactions)

A Thunder signal can carry value (coins), media (Walrus blobs), ownership (P-tokens), and proofs (ZK via Thunderbun). Mysten's SDK carries text and attachments. No economic payload.

## Migration Path

Not a migration — a layering. Thunder keeps its on-chain Storm contract. The relay layer sits on top:

```
                    ┌─────────────────────┐
                    │   Thunder Client    │
                    │  .send() → relay    │
                    │  .signal() → chain  │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
          ┌──────┴──────┐            ┌───────┴───────┐
          │ Relay DO    │            │ Storm Contract │
          │ (free chat) │            │ (value signals)│
          │ WebSocket   │            │ PTB + fees     │
          │ Walrus blob │            │ Purge + rebate │
          └─────────────┘            └────────────────┘
```

### Phase 1: Build the Relay DO
- New CF Durable Object: `ThunderRelay`
- WebSocket connections authenticated via signed challenge
- Messages encrypted client-side with Seal, relayed as opaque bytes
- Persistence to Walrus (fire-and-forget blob store)
- Idle overlay shows relay messages in the same convo bubbles as Storm signals

### Phase 2: Integrate Groups
- Adopt `@mysten/sui-groups` for channel-based group messaging
- Token-gated channels (hold iUSD to join #cache-holders, hold NS to join #ns-holders)
- t2000 fleet channel for agent coordination
- Scribe channels for read-only attestation feeds

### Phase 3: Unified Client SDK
- `@ski/thunder` npm package
- `.send()` for relay (free), `.signal()` for on-chain (economic)
- `.prism()` for rich encrypted transactions
- `.ignite()` for cross-chain gas
- Session key support for agents

### Phase 4: Deprecate On-Chain Chat
- All non-economic messages move to relay
- Storm contract reserved for: Prisms, ignite, random signals, SUIAMI verification
- Existing on-chain signals still readable (backwards compatible)
- Gas savings: 95%+ reduction in Thunder-related tx costs

## Cost Comparison

| Operation | Current (all on-chain) | Hybrid (relay + chain) |
|---|---|---|
| "hey" message | ~0.003 SUI (~$0.003) | $0 (relay) |
| 100 messages/day | ~$0.30/day | ~$0 (relay) + ~$0.001 (Walrus) |
| $7.77 Prism | ~0.003 SUI | ~0.003 SUI (still on-chain) |
| Ignite request | ~0.003 SUI | ~0.003 SUI (still on-chain) |
| t2000 fleet coordination (1000 msgs) | ~$3.00 | ~$0.01 (Walrus batch) |

The relay makes casual communication free while keeping economic signals on-chain where they generate revenue. Best of both worlds.

## Open Questions

1. **Should relay messages count toward the ⛈️ signal score?** Probably yes — they're still Thunder messages, just delivered differently.

2. **Should relayed messages get white bubbles (read receipts)?** The relay can track delivery confirmation (WebSocket ACK). Not as strong as on-chain purge proof, but good enough for chat.

3. **Should the iUSD panel $ button route through relay or chain?** Depends on whether it's a swap (chain) or a balance check (relay/API).

4. **Should Chronicom thunder counts include relay messages?** The Chronicom polls on-chain Storm counts. Relay messages would need a separate count — maybe from the Relay DO's internal state.

5. **Can the relay be decentralized?** Multiple Relay DOs across CF's network provide geographic distribution. But trust still anchors to whoever runs the CF account. True decentralization would need a relay network (like libp2p) — future work.
