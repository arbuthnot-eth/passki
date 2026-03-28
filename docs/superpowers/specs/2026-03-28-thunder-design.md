# Thunder — Seal-Encrypted SuiNS Messaging

## Summary

Thunder is encrypted messaging between SuiNS identities. Messages are Seal-encrypted (2-of-3 threshold), stored on Walrus as opaque blobs, with on-chain inbox pointers in a shared `ThunderMailbox` object. Fully opaque until the recipient decrypts — no sender identity, no message content, no social graph leaked.

Built on the forked and mainnet-deployed Sui Stack Messaging SDK (`@mysten/messaging` v0.4.0, package `0x74e34e2e4a2ba60d935db245c0ed93070bbbe23bf1558ae5c6a2a8590c8ad470`) which provides envelope encryption, Thunder action schema, and Move contract primitives.

## On-Chain Structure

### ThunderMailbox (shared object)

A single global shared object with dynamic fields keyed by recipient SuiNS name hash.

```
ThunderMailbox {
  id: UID
}
  └─ dynamic_field(sha3_256(name)) → ThunderInbox {
       pointers: vector<ThunderPointer>
     }

ThunderPointer {
  blob_id: vector<u8>,           // Walrus blob ID (content-addressed)
  sealed_namespace: vector<u8>,  // Seal namespace for decryption
  timestamp_ms: u64,             // when sent
}
```

**Permissions:**
- `deposit(mailbox, name_hash, pointer)` — permissionless, anyone can send
- `pop(mailbox, name_hash, nft)` — requires presenting the SuinsRegistration NFT for that name (proves ownership)
- `count(mailbox, name_hash)` — permissionless read (tells you how many pending, no content leaked)

### thunder_seal_policies (Move module)

Custom `seal_approve` entry function:
- Namespace = `sha3_256(recipient_suins_name)` (e.g. `sha3_256("cash")`)
- Policy: caller must own the SuinsRegistration NFT whose `domain` field matches the name
- Seal key servers (Overclock, NodeInfra, Studio Mirai) evaluate this policy before releasing decryption keys
- Deployed alongside the mailbox in the `contracts/thunder/` package

## Message Payload

The Seal-encrypted payload (stored on Walrus) contains:

```json
{
  "v": 1,
  "sender": "brando.sui",
  "senderAddress": "0xabc...def",
  "message": "hey, nice name",
  "timestamp": "2026-03-28T04:30:00.000Z",
  "suiami": "suiami:eyJ...base64.signature"
}
```

- `sender` / `senderAddress` — inside the encrypted blob, invisible until decrypted
- `suiami` — optional SUIAMI proof embedded in the message, so the recipient can cryptographically verify the sender's identity without a separate handshake
- `v` — version field for future schema evolution

The entire JSON is serialized to bytes, encrypted via Seal envelope encryption (AES-GCM with Seal-wrapped DEK), and written to Walrus as a single blob.

## Seal Encryption Flow

### Encrypt (sender side)

1. Resolve recipient SuiNS name to determine the Seal namespace: `namespace = sha3_256("cash")`
2. Use `@mysten/seal` to encrypt:
   - `packageId` = Thunder's `thunder_seal_policies` package
   - `id` = namespace bytes (the name hash)
   - `threshold` = 2 (of 3 key servers)
   - `data` = JSON payload bytes
3. Result: `EncryptedObject` (ciphertext + Seal metadata)
4. Write `EncryptedObject` bytes to Walrus → get `blobId`
5. Call `ThunderMailbox::deposit(mailbox, name_hash, ThunderPointer { blob_id, sealed_namespace, timestamp_ms })`

### Decrypt (recipient side)

1. Query `ThunderMailbox` for pending pointers at your name hash
2. For each pointer, fetch the blob from Walrus by `blob_id`
3. Create a Seal `SessionKey` (requires wallet signature — one session key can decrypt multiple messages)
4. Build a `seal_approve` transaction referencing your SuinsRegistration NFT
5. Call `client.seal.decrypt({ data: blob, sessionKey, txBytes })` — Seal key servers verify NFT ownership, release key
6. Parse decrypted JSON → reveal sender, message, optional SUIAMI proof
7. Call `ThunderMailbox::pop(mailbox, name_hash, nft)` to remove the pointer

## SKI UI Integration

### Send Flow

1. User types `cash.sui` in NS input → resolves to someone else's address (blue target row)
2. No amount entered, balance section collapsed or open → button shows **THUNDER** with thunderbolt icon in Thunderbun orange (`#FFB800`)
3. The `.sui` suffix area or a new row below the NS input becomes a message input (placeholder: "sealed message...")
4. User types message, hits THUNDER button (or Enter)
5. Button shows `...` during encrypt + Walrus write + on-chain deposit
6. Toast: `⚡ Thunder sent to cash.sui`
7. Message input clears, button returns to THUNDER state

### Receive Flow

1. On sign-in and periodic poll (every 30s): query `ThunderMailbox::count` for the user's primary SuiNS name
2. If count > 0: overlay a Thunderbun-orange thunderbolt (`⚡`) on the user's name chip in the SKI roster, with count badge (e.g. `⚡3`)
3. Thunderbolt persists regardless of what's typed in the NS input — it's not a notification to dismiss
4. **Click thunderbolt:**
   - First click triggers Seal session key creation (wallet signature prompt, one-time per session)
   - Decrypt the first pending Thunder → reveal sender name + message
   - Show message content in a toast or inline display
   - Populate the sender's SuiNS name into the NS input (for easy reply)
   - Pop the pointer from the on-chain mailbox
5. **Click again** → decrypt next Thunder in queue, same flow
6. When queue is empty, thunderbolt disappears

### Button Mode Logic

In `_updateSendBtnMode()`, add a new mode:

```
thunderMode = !coinChipsOpen && hasLabel && isTaken && !isOwned && !hasListing && nsTargetAddress != null
```

When `thunderMode`:
- Button text: `THUNDER` (or `⚡`)
- Button color: Thunderbun orange (`#FFB800`)
- Button enabled: always (no amount required)
- `.sui` suffix hides, message input appears in its place (or below)

Priority: `thunderMode` activates when viewing someone else's taken name with no amount — sits between SUIAMI and the existing SEND/SWAP modes.

## Files

| Component | File | Purpose |
|-----------|------|---------|
| Move contracts | `contracts/thunder/sources/thunder.move` | ThunderMailbox, ThunderPointer, deposit/pop/count, thunder_seal_policies with seal_approve |
| Thunder client | `src/client/thunder.ts` | Encrypt, write to Walrus, deposit pointer, query inbox, decrypt, pop |
| UI integration | `src/ui.ts` | THUNDER button mode, thunderbolt badge on roster, message input, decrypt-on-click flow |
| Thunder types | `src/client/thunder-types.ts` | ThunderPayload interface, constants |

## Dependencies

- `@mysten/seal` v1.1.1 (already installed)
- `@mysten/walrus` (add to package.json — for blob read/write)
- `@mysten/messaging` v0.4.0 (for `EnvelopeEncryption`, `serializeThunderAction`, Thunder action types) — or cherry-pick just the encryption primitives
- Seal key servers: Overclock, NodeInfra, Studio Mirai (already configured for Shade)

## Constraints

- **No sender identity leak**: sender name, address, and message content are all inside the Seal-encrypted payload. On-chain mailbox only reveals: "someone sent something to this name hash at this time."
- **Permissionless send**: anyone can deposit a Thunder pointer. No channel creation, no membership setup, no handshake required.
- **Gas costs**: sender pays gas for the mailbox deposit tx. Walrus writes are free (publisher mode). Recipient pays gas to pop/clear.
- **Walrus blob lifetime**: blobs have configurable epoch lifetime. Default to max available epochs. If a blob expires before decryption, the Thunder is lost — acceptable for v1.
- **Session key**: Seal decryption requires a session key (wallet signature). One session key per sign-in session can decrypt all pending Thunders.

## Out of Scope (v1)

- Group messaging / channels (future: use SDK's Channel model)
- Cross-chain decryption via IKA dWallets (that's Storm)
- Attachments / media (future: use SDK's Walrus attachment flow)
- Read receipts / delivery confirmation
- Message threading / replies (v1 reply is just: send a Thunder back)
- Spam prevention / rate limiting (future: require small SUI deposit per Thunder)
