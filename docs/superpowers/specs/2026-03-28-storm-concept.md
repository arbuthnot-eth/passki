# Storm — Cross-Chain Sealed Messaging via IKA dWallets

## What This Document Is

A conceptual research document exploring how to extend Thunder (Seal-encrypted SuiNS-to-SuiNS messaging on Sui) so that messages can be addressed to BTC, SOL, or ETH addresses and decrypted only by someone who controls an IKA dWallet deriving to that cross-chain address. No implementation plan, no code -- just architecture, integration points, and open questions.

---

## Background: Thunder Recap

Thunder encrypts messages using Mysten's Seal so that only the holder of a specific SuiNS name NFT can decrypt. The flow:

1. Sender encrypts a message payload with Seal, using an identity derived from the recipient's SuiNS name hash.
2. Ciphertext goes to Walrus; a pointer goes on-chain in the `ThunderMailbox`.
3. Recipient presents their `SuinsRegistration` NFT to the `seal_approve` function. Seal key servers verify NFT ownership, release threshold decryption shares.
4. Recipient decrypts the message.

The critical design constraint: the `seal_approve` Move function is the sole gatekeeper. Seal key servers will only release decryption shares if a transaction calling `seal_approve` succeeds on-chain. Any access control logic that can be expressed in Move can therefore gate decryption.

---

## Storm: The Core Idea

Storm adds an alternative recipient type: a cross-chain address (BTC, ETH, or SOL). The recipient proves decryption rights not by holding a SuiNS NFT, but by holding a `DWalletCap` object whose associated dWallet derives to the target cross-chain address.

**Example:** Alice wants to send an encrypted message to whoever controls `bc1qtxapc28p93g54gpv5jjllh2tk7axr9lrm7hw23`. She encrypts using Storm. Bob holds a `DWalletCap` on Sui whose secp256k1 dWallet derives to exactly that Bitcoin address. Bob's `seal_approve` transaction proves this link, and Seal releases the decryption key to Bob.

---

## IKA dWallet Architecture (Relevant Details)

### DWalletCap

The `DWalletCap` is a Sui object created during the DKG ceremony. It is the authorization capability for all dWallet operations.

- **Module:** `coordinator_inner::DWalletCap` (package `0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317`)
- **Key field:** `dwallet_id` -- points to the associated dWallet object on IKA
- **Ownership:** Standard Sui object ownership. The address that owns the `DWalletCap` controls the dWallet. It is transferable.
- **Storable in contracts:** Can be embedded inside other Sui objects (e.g., `MyContract { dwallet_cap: DWalletCap }`) for programmable custody.

### dWallet Object

The dWallet object (on IKA, referenced by `dwallet_id`) contains:

- `state.public_output` -- a byte array containing the BCS-encoded public key
- For secp256k1: 33 bytes compressed (02/03 prefix + 32-byte x-coordinate)
- For ed25519: 32 bytes raw public key

### Cross-Chain Address Derivation

From the public key in `public_output`, addresses are derived deterministically:

| Chain | Curve | Derivation |
|-------|-------|------------|
| Bitcoin (P2WPKH) | secp256k1 | `bech32("bc", [0] ++ bech32Words(RIPEMD160(SHA256(pubkey))))` |
| Ethereum | secp256k1 | `0x ++ last20(keccak256(decompress(pubkey)[1:]))` with EIP-55 checksum |
| Base, Polygon, etc. | secp256k1 | Same as Ethereum (same key, same address) |
| Solana | ed25519 | `base58(pubkey)` -- raw 32 bytes, no hashing |

A single secp256k1 dWallet covers BTC + all EVM chains. Solana requires a separate ed25519 dWallet.

### The On-Chain Verification Problem

**This is the central technical challenge for Storm.**

Today, address derivation from dWallet `public_output` happens off-chain in TypeScript (SKI's `src/client/chains.ts`). The derivation involves:

- secp256k1 point decompression (for EVM addresses)
- SHA-256, RIPEMD-160, keccak-256 hashing
- bech32 encoding (for BTC)
- base58 encoding (for SOL)
- EIP-55 checksum encoding (for ETH)

**Can this be done in Move?** Partially:

- **SHA-256**: Available via `sui::hash::sha256` (proposed/available in newer Sui versions) or via `std::hash`
- **keccak-256**: Available via `sui::hash::keccak256` (already used in Shade contract)
- **RIPEMD-160**: NOT available natively in Sui Move. Would need to be implemented as a Move module or added as a native function.
- **secp256k1 point decompression**: NOT available natively. Sui has `ecdsa_k1::secp256k1_verify` for signature verification but not raw point arithmetic.
- **bech32/base58 encoding**: NOT available natively. These are encoding algorithms that could be implemented in Move but would be gas-expensive.

**Verdict:** Full on-chain address derivation in Move is not feasible today for BTC (needs RIPEMD-160 + bech32) or SOL (needs base58). ETH is closer (keccak-256 is available, but point decompression is not).

---

## Seal Policy Design for Storm

### Option A: Direct Public Key Match (Recommended)

Instead of deriving the full chain address on-chain, the `seal_approve` function can verify a simpler property: **the dWallet's raw public key matches an expected value**.

The sender encrypts using an identity that encodes the target chain address. The `seal_approve` function:

1. Takes a reference to the caller's `DWalletCap`
2. Reads the dWallet's `public_output` to extract the raw public key
3. Compares it against an expected public key stored in (or derivable from) the identity

**The sender-side flow becomes:**

1. Sender knows the target address (e.g., `bc1qtxapc28...`)
2. Sender reverse-derives the public key that would produce that address (this is NOT possible for all address formats -- see "Open Questions")
3. Sender encrypts with identity = `[storm_pkg]::[chain_id]::[expected_pubkey]`
4. Seal policy checks: caller's DWalletCap -> dWallet -> public_output matches expected_pubkey

**Problem:** You cannot reverse-derive a public key from a Bitcoin/Ethereum/Solana address. The address is a hash of the public key (BTC: RIPEMD160(SHA256(pubkey)), ETH: last 20 bytes of keccak256(pubkey)). This is a one-way function by design.

### Option B: Off-Chain Address Derivation with On-Chain Pubkey Commitment

A hybrid approach:

1. **Registration phase:** The dWallet holder registers a `StormIdentity` on-chain that maps their dWallet's public key to their derived chain addresses. This is a one-time operation:
   ```
   StormIdentity {
     id: UID,
     dwallet_cap_id: ID,           // which DWalletCap this belongs to
     pubkey: vector<u8>,           // raw compressed public key from dWallet
     btc_address: vector<u8>,      // "bc1q..." as bytes
     eth_address: vector<u8>,      // "0xCE3e..." as bytes
     sol_address: vector<u8>,      // base58 Solana address as bytes
   }
   ```
2. **Validation at registration:** The `register_storm_identity` function takes `&DWalletCap`, reads the dWallet object to get `public_output`, extracts the pubkey, and stores it. The chain addresses are provided by the caller (off-chain derivation) but the pubkey is verified on-chain.
3. **seal_approve at decrypt:** Verifies the caller owns a `StormIdentity` whose stored address matches the identity the message was encrypted for.

**Advantages:**
- No complex crypto in Move (no RIPEMD-160, no bech32, no point decompression)
- Chain addresses are human-readable and stored as-is
- `seal_approve` is a simple byte comparison
- Registration is a one-time cost

**Risks:**
- The chain address stored in `StormIdentity` is not verified on-chain to actually derive from the pubkey -- a malicious registrant could claim any address
- Mitigation: the pubkey IS verified (extracted from dWallet's public_output). Anyone can re-derive the address off-chain and check. A future Move native for RIPEMD-160 or keccak+point-decompression would enable full on-chain verification.

### Option C: Pubkey-Only Identity (Simplest, Most Composable)

Eliminate address formats entirely from the on-chain layer:

1. Sender obtains the recipient's dWallet public key (not their chain address)
2. Encrypts with identity = `[storm_pkg]::[pubkey_bytes]`
3. `seal_approve` checks: caller's DWalletCap -> dWallet -> public_output matches the pubkey in the identity

**Advantages:**
- Simplest possible Move code
- No address format ambiguity
- Works for any chain, any curve
- Fully verifiable on-chain (public_output extraction is just byte slicing)

**Disadvantages:**
- Sender needs to know the recipient's dWallet public key, not just their chain address
- Breaks the user mental model: "I want to send a message to bc1q..." becomes "I need to look up the dWallet pubkey for bc1q..."
- Requires a discovery/resolution layer

### Recommended: Option B with Pubkey Fallback

Use Option B (StormIdentity registry) as the primary path for human-friendly addressing, with Option C (raw pubkey) as a lower-level primitive that power users and contracts can use directly.

---

## StormMailbox: Extending ThunderMailbox

Thunder's mailbox is keyed by `sha3_256(suins_name)`. Storm adds a parallel keying scheme:

```
StormMailbox {
  id: UID
}
  +-- dynamic_field(sha3_256("suins:" ++ name))      --> ThunderInbox  (Thunder path)
  +-- dynamic_field(sha3_256("chain:" ++ address))    --> ThunderInbox  (Storm path)
  +-- dynamic_field(sha3_256("pubkey:" ++ pubkey))    --> ThunderInbox  (Storm pubkey path)
```

All three key types use the same `ThunderInbox` / `ThunderPointer` structure. The difference is only in the `seal_approve` policy that gates decryption:

| Path | Keyed by | seal_approve checks |
|------|----------|---------------------|
| Thunder | SuiNS name hash | Caller owns SuinsRegistration NFT for that name |
| Storm (address) | Chain address hash | Caller owns StormIdentity with matching chain address |
| Storm (pubkey) | Raw pubkey hash | Caller owns DWalletCap whose dWallet public_output matches |

### Unified vs. Separate Mailboxes

**Option 1: Single mailbox, unified seal_approve.** One `seal_approve` function that dispatches based on a prefix byte in the identity:
- `0x01 ++ name_hash` -> Thunder path (check SuiNS NFT)
- `0x02 ++ address_hash` -> Storm address path (check StormIdentity)
- `0x03 ++ pubkey_hash` -> Storm pubkey path (check DWalletCap)

**Option 2: Separate packages.** Thunder and Storm are separate Move packages with separate `seal_approve` functions. Different Seal package IDs mean different encryption namespaces -- a Thunder message cannot accidentally be decrypted via a Storm policy or vice versa. Cleaner separation of concerns.

**Recommendation:** Option 2 (separate packages). Seal's identity namespace is `[package_id]::[inner_id]`, so separate packages give cryptographic separation for free. Composability comes from sharing the same `ThunderPointer` structure and Walrus storage layer, not from sharing Move modules.

---

## ENS Integration: Addressing Messages to vitalik.eth

### The Vision

A user types `vitalik.eth` into SKI's input. Storm:
1. Resolves `vitalik.eth` to an Ethereum address via ENS
2. Encrypts a message decryptable only by whoever holds a dWallet deriving to that ETH address
3. Deposits the pointer in StormMailbox keyed by the resolved ETH address

### ENS Resolution

ENS resolution always starts from Ethereum L1, regardless of where the name resolves to.

**Resolution methods (usable from a browser without running an Ethereum node):**

1. **Viem `getEnsAddress`**: Calls `resolve()` on the ENS Universal Resolver Contract via an Ethereum JSON-RPC provider. Supports ENSIP-19 multi-chain resolution via `coinType` parameter.

2. **ENS Universal Resolver**: A single contract on Ethereum L1 that handles all resolution -- direct on-chain, CCIP-Read (off-chain/L2), and wildcard. Client libraries abstract this entirely.

3. **CCIP-Read (EIP-3668)**: For names resolved off-chain or on L2 (e.g., `jesse.base.eth` resolved from Base), the Universal Resolver reverts with an `OffchainLookup` error. The client fetches data from a gateway URL, then the resolver verifies the response on-chain. This is transparent to the caller when using viem or ethers.js.

4. **ENS HTTP API**: `https://ens.xyz/api/resolve/{name}` provides a REST endpoint (no Ethereum node needed). Useful for Cloudflare Worker context where running a full viem client may be impractical.

**Reverse resolution (ETH address -> .eth name):** `getEnsName` / `lookupAddress`. Important for display: when a Storm recipient sees the sender used an ENS name, they can verify the forward resolution matches.

### ENS in Storm's Architecture

```
User types "vitalik.eth"
  |
  v
SKI client resolves via ENS API/viem --> "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  |
  v
Look up StormIdentity registry: does any registered identity claim this ETH address?
  |
  +-- YES: encrypt with that identity's Seal namespace, deposit in mailbox
  |
  +-- NO: message cannot be sent yet (recipient hasn't registered a StormIdentity)
       Show: "This address hasn't set up Storm yet"
```

**Key insight:** ENS resolution happens entirely off-chain in the client. It is NOT part of the Seal policy or Move contract. The on-chain layer only sees chain addresses (bytes). The client is responsible for resolving human-readable names to addresses before encryption.

### Multi-Chain Name Resolution (Future)

| Name System | Chain | Resolution |
|-------------|-------|------------|
| SuiNS (.sui) | Sui | On-chain, already in SKI |
| ENS (.eth) | Ethereum | Via Universal Resolver + CCIP-Read |
| SNS (.sol) | Solana | Solana Name Service SDK |
| BNS (.btc) | Bitcoin | BNS API / Stacks resolution |

Storm's architecture is name-system-agnostic. The client resolves any name to a chain address, then looks up the StormIdentity registry. Adding a new name system is a client-side change only.

---

## Cross-Chain Address Validation

When a user types a cross-chain address (not a name), the client must validate the format before attempting to send.

### Bitcoin

| Format | Prefix | Validation |
|--------|--------|------------|
| P2WPKH (native SegWit) | `bc1q` | bech32 decode, 20-byte witness program, version 0 |
| P2TR (Taproot) | `bc1p` | bech32m decode, 32-byte witness program, version 1 |
| P2PKH (legacy) | `1` | base58check decode, version byte 0x00, 20-byte hash |
| P2SH (script hash) | `3` | base58check decode, version byte 0x05, 20-byte hash |

IKA's secp256k1 dWallets derive P2WPKH (`bc1q...`) addresses. A message addressed to a `bc1p...` Taproot address would require either: (a) a separate Taproot derivation path in StormIdentity, or (b) the recipient to also register their Taproot address (same pubkey, different derivation).

### Ethereum

- Format: `0x` + 40 hex characters (20 bytes)
- EIP-55 checksum: mixed-case encoding where uppercase/lowercase is determined by keccak256 of the lowercase address
- Validation: check length, hex validity, optional EIP-55 checksum verification
- All EVM chains share the same address format (same key -> same address on ETH, Base, Polygon, etc.)

### Solana

- Format: base58-encoded, 32-44 characters
- No checksum in the address itself (base58 includes a check digit)
- Validation: base58 decode must produce exactly 32 bytes (ed25519 public key)
- Note: Solana addresses ARE the public key (no hashing), so Option C (pubkey-only identity) works directly for Solana

---

## The seal_approve Function for Storm

### Minimal Implementation (Option B)

```
// Pseudocode -- not real Move, illustrative only

entry fun seal_approve(
    id: vector<u8>,                    // Seal identity (inner, without package prefix)
    storm_identity: &StormIdentity,    // Caller's registered Storm identity
    ctx: &TxContext,
) {
    // 1. Verify caller owns this StormIdentity
    //    (Sui's object system enforces this -- storm_identity must be an owned object
    //     passed by the transaction sender)

    // 2. Extract the target chain address from the Seal identity
    //    id format: [chain_byte][address_bytes]
    //    chain_byte: 0x01 = BTC, 0x02 = ETH, 0x03 = SOL

    // 3. Look up the corresponding address in the StormIdentity
    //    e.g., if chain_byte == 0x02, compare id[1..] with storm_identity.eth_address

    // 4. Assert match -- if not, transaction aborts, Seal key servers refuse decryption
}
```

### What Seal Key Servers Do

1. User builds a transaction calling `seal_approve` with their `StormIdentity` object
2. User submits this transaction to the Seal key servers (NOT to the Sui network for execution)
3. Each key server **simulates** the transaction in a dry-run (or executes it in a sandbox)
4. If the transaction succeeds (does not abort), the key server releases its decryption share
5. If 2-of-3 key servers approve, the client combines shares and decrypts

The key servers never see the plaintext. They only verify that the on-chain policy would approve the caller's access.

---

## Discovery: How Does a Sender Find the Recipient?

### Problem

Alice wants to send a Storm message to `bc1qtxapc28...`. How does she know whether anyone has registered a StormIdentity for that address?

### Solution: On-Chain Registry with Off-Chain Index

1. **On-chain:** `StormIdentity` objects are created by `register_storm_identity()`. Each contains the dWallet pubkey and derived chain addresses.

2. **Indexing:** A Cloudflare Worker (or Sui event subscription) indexes `StormIdentityCreated` events and maintains a KV/D1 lookup: `chain_address -> storm_identity_object_id`.

3. **Client query:** Before encrypting, the client queries the index: "Is there a StormIdentity for `bc1qtxapc28...`?" If yes, proceed. If no, show "This address hasn't set up Storm."

4. **Decentralized alternative:** Use Sui dynamic fields on a shared `StormRegistry` object, keyed by chain address hash. No external index needed, but higher gas costs for registration and lookup requires on-chain reads.

### Bootstrap Problem

Storm only works for addresses whose holders have:
1. A Sui wallet
2. An IKA dWallet (completed DKG)
3. A registered StormIdentity

This is a small population today. The bootstrap strategy:
- Every SKI user who provisions an IKA dWallet automatically gets a StormIdentity registered
- No separate opt-in required -- if you have a dWallet, you are Storm-reachable at your derived addresses
- The on-chain registration can be part of the DKG transaction or a follow-up sponsored transaction

---

## Unified seal_approve: Thunder + Storm

Could a single `seal_approve` handle both Thunder (SuiNS NFT) and Storm (dWallet/StormIdentity)?

**Yes, but it is better not to.** Reasons:

1. **Seal namespaces are package-scoped.** The encryption identity is `[package_id]::[inner_id]`. Using separate packages means Thunder-encrypted messages are cryptographically impossible to decrypt via Storm's policy, and vice versa. This is a security feature, not a limitation.

2. **Object parameter differences.** Thunder's `seal_approve` takes `&SuinsRegistration`. Storm's takes `&StormIdentity` (or `&DWalletCap`). A unified function would need to accept both via generics or dynamic dispatch, which complicates the Move code for no gain.

3. **Independent evolution.** Thunder and Storm will evolve at different rates. Thunder is closer to implementation; Storm depends on IKA maturity and StormIdentity registration adoption.

**The shared layer is the mailbox and pointer format**, not the Seal policy. Both Thunder and Storm deposit `ThunderPointer` objects (same struct, same Walrus blobs). The client distinguishes them by which `seal_approve` package to call for decryption.

---

## Security Analysis

### Threat: Fake StormIdentity Registration

An attacker registers a `StormIdentity` claiming ETH address `0xd8dA...` (Vitalik's address) without actually controlling a dWallet that derives to it.

**Mitigation:** The `register_storm_identity` function MUST read the dWallet's `public_output` from the IKA network (via the `DWalletCap` -> `dwallet_id` -> dWallet object chain) and verify that the stored pubkey matches. The chain addresses are derived off-chain, but the pubkey is verified on-chain. Anyone can independently re-derive the addresses from the pubkey and detect a mismatch.

**Stronger mitigation (future):** If Sui adds RIPEMD-160 and secp256k1 point decompression as Move natives, full on-chain address derivation becomes possible, eliminating the trust assumption entirely.

### Threat: DWalletCap Transferred After Registration

Bob registers a StormIdentity, then transfers his `DWalletCap` to Charlie. Messages encrypted for Bob's BTC address are now decryptable by Charlie.

**This is correct and expected behavior.** The `DWalletCap` IS the key to the dWallet. Whoever holds it controls the derived addresses. If Bob transfers the cap, he transfers control. This is analogous to transferring a SuiNS NFT -- the new holder can decrypt Thunder messages for that name.

### Threat: Address Reuse Across Chains

A secp256k1 dWallet derives to the same address on all EVM chains. A message "to" an ETH address is also "to" the same address on Base, Polygon, etc. This is fine -- it is the same key.

### Threat: Seal Key Server Collusion

Same as Thunder. Seal uses 2-of-3 threshold. If two key servers collude, they can decrypt any message. Mitigation: choose independent, reputable key servers (Overclock, NodeInfra, Studio Mirai are operated by different entities).

---

## Open Questions

### 1. Can seal_approve access IKA dWallet objects cross-network?

The `DWalletCap` lives on Sui, but the dWallet object (with `public_output`) lives on the IKA network. In the current SKI implementation, reading the dWallet's `public_output` requires an RPC call to IKA. Can a Move function in `seal_approve` read an IKA object?

**Likely answer:** No, directly. But `DWalletCap` contains a `dwallet_id` field, and the dWallet object may be mirrored/accessible on Sui via IKA's Sui light client module. The `coordinator_inner` package on Sui may expose functions to read dWallet state. This needs investigation in the IKA Move source code.

**Workaround:** The `StormIdentity` registration step reads the pubkey off-chain and stores it on-chain on Sui. The `seal_approve` function only needs to read Sui-native objects.

### 2. Should Storm support addresses without dWallets?

Could someone receive a Storm message at their native BTC address (held by a hardware wallet, not a dWallet)? No -- the entire decryption flow requires a Sui transaction calling `seal_approve`. Without a Sui wallet + dWallet, there is no way to authenticate to the Seal key servers. Storm is specifically for dWallet-derived addresses.

### 3. What about Taproot (bc1p...) addresses?

IKA derives P2WPKH (`bc1q...`) addresses from secp256k1 keys. The same key can also derive a Taproot (`bc1p...`) address using a different derivation path (x-only pubkey, bech32m encoding). Should StormIdentity store both? Probably yes -- the Taproot address is deterministically derivable from the same pubkey.

### 4. How does Storm interact with SUIAMI?

SUIAMI is SKI's identity proof system (signed statement linking a SuiNS name to a Sui address). A Storm message payload (inside the Seal encryption) should include the sender's SUIAMI proof, just like Thunder. The recipient can verify the sender's SuiNS identity after decryption.

### 5. What happens when a SuiNS name holder ALSO has a dWallet?

If `shelby.sui` has both a SuiNS NFT and a dWallet deriving to `bc1q...`, they are reachable via both Thunder (`shelby.sui`) and Storm (`bc1q...`). These are separate encryption namespaces. The client should prefer Thunder (SuiNS name) when both are available, since it is simpler and does not require the StormIdentity registration step.

### 6. Gas costs for StormIdentity registration?

Creating a `StormIdentity` object requires a Sui transaction. If this is part of the DKG flow, it can be gas-sponsored by the keeper (same as the DKG transaction today). If separate, it needs its own sponsorship. Recommendation: bundle with DKG.

### 7. Privacy of the StormIdentity registry?

The `StormIdentity` object publicly links a Sui address to BTC/ETH/SOL addresses. This is a privacy tradeoff: you gain cross-chain messaging reachability but reveal your cross-chain address associations on-chain. This is the same tradeoff as registering a SuiNS name (publicly links name to address).

Mitigation: make registration optional. Users who want privacy can use the pubkey-only path (Option C) and share their pubkey out-of-band.

---

## Architecture Summary

```
                    SENDER                                    RECIPIENT
                    ======                                    =========

  "Send to bc1q..."                              Holds DWalletCap on Sui
        |                                         dWallet derives to bc1q...
        v                                         StormIdentity registered
  Resolve ENS/SNS/BNS (optional)                         |
        |                                                |
        v                                                v
  Look up StormIdentity registry           seal_approve(id, &StormIdentity, ctx)
  for target chain address                   - verify caller owns StormIdentity
        |                                    - verify StormIdentity.address matches id
        v                                    - Seal key servers release shares
  Seal.encrypt(                                          |
    pkg = storm_seal_policies,                           v
    id  = [chain_byte][address],             Seal.decrypt(blob, sessionKey, txBytes)
    threshold = 2,                                       |
    data = JSON payload                                  v
  )                                           Parse JSON: sender, message, SUIAMI
        |
        v
  Walrus.write(ciphertext) --> blobId
        |
        v
  StormMailbox.deposit(
    address_hash,
    StormPointer { blob_id, ... }
  )
```

---

## Relationship to Existing SKI Components

| Component | Thunder | Storm | Shared? |
|-----------|---------|-------|---------|
| Seal encryption/decryption | Yes | Yes | Same `@mysten/seal` SDK, same key servers |
| Walrus blob storage | Yes | Yes | Same Walrus publisher, same blob format |
| Mailbox pointer format | ThunderPointer | ThunderPointer (reused) | Same struct |
| Mailbox object | ThunderMailbox | StormMailbox (separate) | Different shared objects |
| seal_approve policy | SuiNS NFT ownership | StormIdentity + DWalletCap | Different packages |
| Client encryption | `src/client/thunder.ts` | `src/client/storm.ts` (new) | Shared encrypt/Walrus helpers |
| UI button mode | THUNDER (orange) | STORM (new color?) | Different modes in `_updateSendBtnMode` |
| Name resolution | SuiNS only | SuiNS + ENS + SNS + BNS | Storm adds multi-chain resolution |
| IKA dependency | None | DWalletCap + StormIdentity | Storm only |
| SUIAMI proof | In payload | In payload | Same SUIAMI system |

---

## References

- [IKA dWallet Documentation](https://docs.ika.xyz)
- [IKA GitHub Repository](https://github.com/dwallet-labs/ika)
- [IKA dWallets Core Concepts](https://github.com/dwallet-labs/ika/blob/main/docs/docs/core-concepts/dwallets.md)
- [Mysten Seal Mainnet Launch](https://www.mystenlabs.com/blog/seal-mainnet-launch-privacy-access-control)
- [Seal GitHub Repository](https://github.com/MystenLabs/seal)
- [Seal SDK Documentation](https://sdk.mystenlabs.com/seal)
- [Seal Examples](https://github.com/MystenLabs/seal/tree/main/examples)
- [ENS Offchain/L2 Resolvers (CCIP-Read)](https://docs.ens.domains/resolvers/ccip-read/)
- [ENS Address Resolution](https://docs.ens.domains/web/resolution/)
- [ENS Universal Resolver](https://docs.ens.domains/resolvers/universal/)
- [ENSv2 Architecture](https://ens.domains/blog/post/ensv2-architecture)
- [Viem getEnsAddress](https://viem.sh/docs/ens/actions/getEnsAddress)
- [IKA Capabilities and Approvals](https://docs.ika.xyz/docs/move-integration/core-concepts/capabilities-and-approvals)
- [Ika Mainnet Launch (Sui Blog)](https://blog.sui.io/ika-mainnet-launch-btcfi-interoperability/)
- [SKI Thunder Design Spec](./2026-03-28-thunder-design.md)
- [SKI IKA Quantum Resistance Doc](../../ika-quantum-resistance.md)
