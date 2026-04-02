# Thunder v5 / Storm v1 — Private Metadata via ECDH Storm IDs

## Overview

Thunder v5 replaces public name_hash-keyed signals with ECDH-derived Storm IDs. Each pair of users gets a unique, opaque Storm ID computed from their IKA dWallet shared secret. Third parties see signals grouped under random-looking IDs with no link to identities. The message content remains AES encrypted (existing). The metadata (who talks to whom) is now private.

## The Problem (Thunder v4)

```
storm_key = keccak256("alice.sui")  ← anyone can compute this
```

Anyone can look up the Storm and see: "alice.sui has 13 pending signals." They can correlate senders by watching who submits signal txs targeting that key. The message content is encrypted but the social graph is public.

## The Fix (Thunder v5)

```
shared_secret = ECDH(alice_dWallet, bob_dWallet)
storm_id = keccak256(shared_secret || "thunder-storm")
```

Only Alice and Bob can compute this storm_id. Each conversation gets its own opaque ID. A third party sees signals under `0xab3f...` with no way to know it's Alice↔Bob.

## ECDH via IKA dWallets

IKA's 2PC-MPC threshold signatures support ECDH key agreement:

1. Alice has secp256k1 dWallet with public key `A`
2. Bob has secp256k1 dWallet with public key `B`
3. Shared secret: `ECDH(a, B) = ECDH(b, A)` — standard elliptic curve Diffie-Hellman
4. Neither party reveals their private key — IKA's 2PC-MPC computes the shared point

The shared secret is deterministic — both parties derive the same storm_id without communicating. No key exchange protocol needed.

## Storm v1 Contract

```move
module storm::storm;

struct Storm has key {
    id: UID,
    version: u64,
}

struct Thunderstorm has store {
    signals: vector<Signal>,
    last_activity_ms: u64,
}

struct Signal has store, drop {
    payload: vector<u8>,      // AES-encrypted message
    aes_key: vector<u8>,      // masked AES key
    aes_nonce: vector<u8>,    // AES nonce
    timestamp_ms: u64,
}

/// Signal into an opaque storm_id. Permissionless — anyone can write.
/// The storm_id is the ECDH-derived key, not a name hash.
entry fun signal(
    storm: &mut Storm,
    storm_id: vector<u8>,     // keccak256(ecdh_shared_secret || "thunder-storm")
    payload: vector<u8>,
    aes_key: vector<u8>,
    aes_nonce: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
)

/// Quest — read signals without deleting. Permissionless.
/// Only someone who knows the storm_id can find the signals.
/// Only someone with the AES key mask (recipient NFT hash) can decrypt.
entry fun quest(
    storm: &Storm,
    storm_id: vector<u8>,
    clock: &Clock,
)

/// Strike — read and delete signals. Permissionless.
/// Storage rebate goes to tx sender.
entry fun strike(
    storm: &mut Storm,
    storm_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
)

/// Sweep — delete empty thunderstorms after TTL. Permissionless.
entry fun sweep(
    storm: &mut Storm,
    storm_id: vector<u8>,
    clock: &Clock,
)
```

### Key Changes from v4

| v4 | v5 / Storm v1 |
|----|---------------|
| `name_hash` = `keccak256("alice.sui")` | `storm_id` = `keccak256(ecdh_shared_secret \|\| "thunder-storm")` |
| NFT-gated quest/strike | Permissionless — knowledge of storm_id is the auth |
| Signal fee | No fee (free signals) |
| `strike_relay` admin-gated | No relay needed — permissionless strike |
| Public social graph | Private — storm_ids are opaque |

### Why Permissionless Works

In v4, quest/strike required the SuiNS NFT because the name_hash was public — anyone could try to read signals addressed to "alice.sui." The NFT gate prevented unauthorized reads.

In v5, the storm_id itself is the secret. You can only find signals if you can compute the ECDH shared secret, which requires your dWallet private key share. Knowledge of the storm_id IS authorization. No NFT gate needed.

The AES encryption layer remains — even if someone discovers a storm_id (brute force, leak), they still can't decrypt without the masked key. Defense in depth.

## Client Flow

### Sending a Signal

1. Sender computes: `shared_secret = ECDH(sender_dWallet, recipient_pubkey)`
2. `storm_id = keccak256(shared_secret || "thunder-storm")`
3. AES encrypt message (same as v4)
4. Mask AES key with recipient's NFT hash (same as v4 — fallback decryption)
5. Call `storm::signal(storm, storm_id, payload, masked_key, nonce, clock)`

### Receiving Signals

1. Recipient knows all their conversation partners (local contact list)
2. For each contact: compute `storm_id = keccak256(ECDH(my_dWallet, contact_pubkey) || "thunder-storm")`
3. Check Storm for signals under each storm_id
4. Quest/strike to decrypt

### Discovery (First Contact)

Problem: how does Alice signal Bob if she doesn't know his dWallet public key?

Solution: the SUIAMI Roster. Bob's roster entry contains his dWallet public key (or the DWalletCap ID from which it can be derived). Alice looks up `roster/bob` → gets Bob's pubkey → computes ECDH → derives storm_id → sends signal.

The Roster lookup is public, but it only reveals that Alice looked up Bob's key — not that she sent him a signal. The storm_id is computed locally, never transmitted.

## Migration from v4

- v4 Storm continues to operate (legacy signals drain naturally)
- v5 Storm v1 deployed as new package + new shared object
- Client checks both Storms during transition period
- New signals go to v5, questing checks both
- After transition, v4 signals are swept for rebate

## Dependencies

- IKA dWallet with ECDH support (secp256k1 key agreement)
- SUIAMI Roster with dWallet public key entries
- Storm v1 Move contract (new package)

## File Changes

| File | Change |
|------|--------|
| `contracts/storm/sources/storm.move` | New — Storm v1 contract |
| `src/client/thunder.ts` | v5 signal/quest/strike with ECDH storm_id |
| `src/client/thunder-types.ts` | THUNDER_V5, STORM_V1_ID constants |
| `src/client/ika.ts` | ECDH shared secret derivation via dWallet |
| `src/ui.ts` | Wire v5 flow, dual-Storm checking during migration |
