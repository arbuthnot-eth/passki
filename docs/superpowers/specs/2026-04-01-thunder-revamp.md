# Thunder Revamp — Cross-Chain Encrypted Messaging via Sui Stack + IKA

**Date:** 2026-04-01
**Status:** Draft
**Repo:** [github.com/arbuthnot-eth/Thunder](https://github.com/arbuthnot-eth/Thunder)
**Upstream:** [github.com/MystenLabs/sui-stack-messaging](https://github.com/MystenLabs/sui-stack-messaging)

## Problem

Thunder v1 is a custom implementation of Seal-encrypted messaging between SuiNS identities. It works — ciphertext on Walrus, Seal key servers for decryption, Thunder signals on-chain — but it's bespoke. Mysten just released the official Sui Stack Messaging SDK (`@mysten/sui-stack-messaging`) which provides the same primitives with a production-grade relayer, group management, key rotation, and message verification built in.

Meanwhile, Mysten's SDK only supports **Sui wallets**. It has no concept of cross-chain identity or signing. SKI has IKA.

## Solution

Fork the Sui Stack Messaging SDK as Thunder. Extend it with IKA cross-chain identity so that any chain address can participate in encrypted conversations. Sui remains the coordination layer — groups, permissions, key history live on-chain. IKA provides native BTC/ETH/SOL addresses that can send and receive Thunders.

## What Mysten's SDK Gives Us (already built)

| Feature | How it works |
|---|---|
| **End-to-end encryption** | AES-256-GCM per message, Seal-managed DEKs |
| **Off-chain relayer** | Ciphertext delivery without on-chain cost per message |
| **On-chain groups** | `@mysten/sui-groups` — permissions, membership, key history on Sui |
| **Key rotation** | Atomic rotation + member removal in one PTB |
| **Message verification** | Per-message wallet signature, sender verification |
| **Walrus attachments** | Lazy-download encrypted files via AttachmentHandle |
| **Message recovery** | Fetch archived messages from Walrus without signer auth |
| **SuiNS integration** | Reverse lookup for human-readable group names |
| **Real-time subscription** | AsyncIterable message streams with AbortSignal |
| **Permissions system** | 7 permission types (sender, reader, editor, deleter, key rotator, SuiNS admin, metadata admin) |

## What Thunder Adds (IKA extension)

| Feature | How it works |
|---|---|
| **Cross-chain identity** | Any IKA-derived address (BTC/ETH/SOL) can be a group member |
| **Cross-chain message signing** | Agent signs Thunder messages with IKA dWallet — valid signature on any chain |
| **Storm groups** | Groups gated by IKA dWallet ownership — hold a BTC address derived from this dWallet to join |
| **Agent messaging** | Squids agents (ultron, t2000s) are first-class group members via squids::agent Roster |
| **Signing intents** | Agents express cross-chain signing requests as encrypted Thunders — MEV-protected, private |
| **Chronicom relay** | Chronicom DOs watch for Thunder signals and trigger IKA co-signing autonomously |
| **Prisms** | Rich encrypted transactions: Thunder gate + encrypted sender/timestamp + Walrus blob |

## Architecture

```
Thunder = Sui Stack Messaging SDK + IKA cross-chain extension

Upstream (Mysten)                    Thunder Extension (SKI)
┌─────────────────────┐             ┌──────────────────────────┐
│ @mysten/sui-groups  │             │ IKA dWallet identity     │
│ @mysten/seal        │             │ Cross-chain addressing   │
│ @mysten/sui         │             │ squids::agent integration│
│ Relayer (off-chain) │             │ Chronicom relay          │
│ Walrus (storage)    │             │ Storm (cross-chain gate) │
│ SuiNS (naming)      │             │ Prisms (rich encrypted)  │
└─────────────────────┘             └──────────────────────────┘
```

## Key Changes to Upstream SDK

### 1. Cross-chain group membership

Upstream: group members are Sui addresses only.

Thunder: group members can be identified by any chain address. Under the hood, every cross-chain address resolves to its IKA dWallet owner (a Sui address) for Seal policy evaluation. The mapping is stored in the SUIAMI Roster / squids::agent Roster.

```typescript
// Upstream — Sui only
await client.messaging.createAndShareGroup({
  signer: keypair,
  name: 'My Group',
  initialMembers: ['0xAlice...', '0xBob...'], // Sui addresses
});

// Thunder — any chain
await thunder.createStorm({
  signer,
  name: 'Cross-Chain Traders',
  members: [
    'ultron.sui',                    // SuiNS name → Sui address
    'bc1q...ultron-btc',             // BTC → resolves via SUIAMI Roster
    'FtdgskzfM...ultron-sol',        // SOL → resolves via SUIAMI Roster
    '0x...ultron-eth',               // ETH → resolves via SUIAMI Roster
  ],
});
```

### 2. Agent-native messaging

Squids agents are first-class participants. The `signMessage` call in the SDK uses IKA 2PC-MPC instead of a raw keypair:

```typescript
// Upstream — requires raw keypair
await client.messaging.sendMessage({
  signer: keypair,  // Ed25519Keypair with private key
  groupRef: { uuid },
  text: 'Hello',
});

// Thunder — agent signs via IKA, no private key
await thunder.sendSignal({
  agent: 'ultron',  // Enrolled in squids::agent Roster
  stormRef: { uuid },
  text: 'Sign this SOL tx: ...',
  // Signing happens via ika-worker.ts WASM in CF Worker
});
```

### 3. Seal policy integration with squids::agent

Upstream uses `@mysten/sui-groups` for access control. Thunder extends this so the Seal policy can reference the squids::agent Roster:

```move
// Thunder's seal_approve checks the squids::agent Roster
entry fun seal_approve(id: vector<u8>, roster: &Roster, ctx: &TxContext) {
    // Caller must be enrolled in the Roster OR be the Roster admin
    assert!(squids::agent::is_enrolled(roster, ctx.sender()), ENotEnrolled);
}
```

### 4. Signing intent signals

A new message type for cross-chain signing requests:

```typescript
// Agent expresses signing intent as an encrypted Thunder
await thunder.sendSigningIntent({
  agent: 'ultron',
  stormRef: { uuid: 'squids-signing-group' },
  intent: {
    chain: 'solana',
    tx: serializedSolTx,  // The transaction to sign
    urgency: 'immediate',
  },
});

// Chronicom watches for signing intents, triggers IKA co-sign
// Result returns as encrypted Thunder to the agent
```

### 5. Relayer configuration

Upstream provides a relayer service. Thunder can either:
- **Use Mysten's hosted relayer** (testnet/mainnet when available)
- **Self-host the relayer** on Cloudflare Workers (the relayer is Rust, but we can proxy)
- **Use Walrus as backup** for message persistence (already supported upstream)

## Terminology Mapping

| Upstream (Mysten) | Thunder (SKI) | Notes |
|---|---|---|
| Group | Storm | A conversation |
| Message | Thunder / Signal | A message within a Storm |
| Channel | — | Not used |
| Attachment | Prism | Rich encrypted payload |
| Member | Squid | Agent or user in a Storm |
| Key rotation | — | Same concept, same name |
| Relayer | Chronicom relay | Off-chain delivery |

## Migration from Thunder v1

Thunder v1 stores ciphertext directly on Walrus with Seal encryption. Thunder v2 (this revamp) uses the Sui Stack Messaging SDK's relayer for delivery and on-chain groups for permissions.

### What migrates
- Existing SuiNS-to-SuiNS messaging identity model
- Seal encryption (same key servers, same threshold)
- Walrus blob storage for attachments
- Thunder signal concept (encrypted message between identities)

### What changes
- Message delivery: on-chain events → off-chain relayer (cheaper, faster)
- Group management: custom → `@mysten/sui-groups` (standard, audited)
- Key management: manual → SDK-managed rotation + versioning
- Subscription: polling → AsyncIterable real-time streams
- Verification: custom → SDK's `verifyMessageSender`

### What's new
- Cross-chain identity via IKA
- Agent-native messaging via squids::agent
- Signing intent signals
- Storm groups gated by IKA dWallet ownership
- Prisms as first-class message type
- Message editing and soft-deletion
- Group archival with Walrus recovery

## Implementation Scope

### Phase 1: Fork + IKA identity layer
- Fork `sui-stack-messaging` to `arbuthnot-eth/Thunder`
- Add cross-chain address resolution (chain address → Sui address via SUIAMI Roster)
- Add squids::agent Roster as Seal policy source
- Rename upstream concepts to Thunder terminology
- Deploy relayer (self-hosted or Mysten-hosted)

### Phase 2: Agent messaging
- Integrate `ika-worker.ts` for agent message signing in CF Workers
- Add `sendSignal` method that uses IKA instead of raw keypair
- Add signing intent message type
- Wire Chronicom DOs to watch for signing intents

### Phase 3: Storm groups + Prisms
- Storm creation with cross-chain member resolution
- IKA dWallet-gated Storms (hold BTC/ETH/SOL address to join)
- Prisms as rich encrypted payloads (Thunder gate + Walrus blob)
- Message recovery from Walrus archives

### Phase 4: Replace Thunder v1
- Migrate existing Thunder signals to v2 format
- Update SKI client (`src/client/thunder.ts`) to use new SDK
- Update idle overlay Thunder UI
- Deprecate v1 endpoints
