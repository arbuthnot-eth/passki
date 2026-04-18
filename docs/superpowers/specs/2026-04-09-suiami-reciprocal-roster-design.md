# SUIAMI Reciprocal Roster — Seal + Walrus + Storm

**Date:** 2026-04-09  
**Status:** Design approved  
**Scope:** Reciprocal identity roster with Seal-encrypted chain addresses, deNFT delegation, global SUIAMI Storm

---

## Problem

Cross-chain identity (BTC/ETH/SOL addresses) for SuiNS names is stored in localStorage — not verifiable, not discoverable, not portable. Anyone viewing someone else's card in the idle overlay can see their SUI address but not their cross-chain addresses. There's no on-chain attestation that a given BTC/ETH/SOL address belongs to a SuiNS identity.

## Solution

A reciprocal identity exchange system where:
1. Chain addresses are **Seal-encrypted** and stored on **Walrus**
2. The on-chain **roster** stores SUI address (plaintext) + Walrus blob ID (pointer to encrypted cross-chain data)
3. **Storm membership** gates decryption — joining a Storm proves SuiNS identity via Seal
4. **Reading auto-writes** — the act of decrypting someone's addresses writes your own roster entry
5. **deNFT** wraps SubnameCap in IKA dWallet custody for delegated subname authority

## Architecture

### Storage Split (Hybrid)

| Layer | Data | Access |
|-------|------|--------|
| On-chain roster | SUI address, Walrus blob ID, Seal nonce, dWallet verification flag, `updated_ms` | Permissionless read |
| Walrus blob | Seal-encrypted bundle: `{ btc, eth, sol, dwallet_caps[] }` | Seal-gated decrypt |

SUI address stays plaintext because it's already visible from transaction sender. The cross-chain mapping is the gated secret.

### Proof Mechanism

**Consensus from 5-agent deliberation:** Storm-gated with roster as artifact.

- Storm membership proves SuiNS identity (Seal verifies NFT ownership during `seal_approve_reader`)
- Roster existence check (`has_address(sender)`) is the gate for decryption
- Joining a Storm auto-writes the user's roster entry in the same PTB
- dWallet attestation is an optional "verified" badge upgrade (not a prerequisite)

### Storm Architecture

**Global SUIAMI Storm** — a single shared `PermissionedGroup<Messaging>` that anyone with a SuiNS name can join. Acts as a public identity directory. Known, fixed object ID deployed once.

- Agents (Chronicoms, t2000s) live here permanently
- Joining writes your roster entry (SUI address + encrypted Walrus blob)
- All members can decrypt all other members' chain addresses
- This is where the viral loop runs: join = read = write

**Per-pair Storms** — existing 1:1 messaging channels. Creating one also writes/updates your roster entry as a side-effect. Private channel for Thunder signals.

Both Storm types write to the same on-chain roster object (`0xf382...d689`).

### SUIAMI Proof

One path, one sign. The existing `buildSuiamiMessage` already includes chain addresses:

```
SuiamiMessage {
  suiami: "I am {name}",
  sui: "{address}",
  btc?: "{bitcoin_addr}",
  eth?: "{ethereum_addr}",
  sol?: "{solana_addr}",
  nftId: "{sui_nft_id}",
  timestamp: number,
  ...
}
```

This same proof message is what gets Seal-encrypted and stored on Walrus. The signed proof is the content; Seal protects it at rest; the Storm gates who can decrypt it.

### Read Flow

1. User clicks squids on someone's card
2. SUI address shown immediately (plaintext from roster)
3. If user is in global Storm → Seal decrypts target's Walrus blob → cross-chain addresses render
4. If user is NOT in global Storm → "Join" button shown
5. Clicking "Join" → PTB: `set_identity(my_roster_entry)` + `join_storm(global_storm)` → one sign
6. After join → auto-decrypt target's blob → addresses render
7. User's own roster entry now exists → discoverable by others

### Write Flow

1. SUIAMI button clicked → builds proof with all available chain addresses (SUI + BTC/ETH/SOL from IKA dWallets)
2. Proof message is Seal-encrypted using global Storm's encryption key
3. Encrypted blob uploaded to Walrus → returns blob ID
4. PTB: `set_identity(roster, name, name_hash, chains=["sui"], values=[sui_addr], blob_id, seal_nonce)` + `join_storm(global_storm)` if not already member
5. One transaction, one sign
6. After Rumble (IKA DKG): re-run write with dWallet-derived addresses → upgrades roster entry with `dwallet_caps` (verified badge)

---

## deNFT — Delegated Name Token

### What It Is

A Move object that wraps a SuiNS SubnameCap inside an IKA dWallet custody layer. The padre (holder via dWallet) can batch-mint subnames of any length without holding the original SuiNS NFT.

### On-Chain Structure

```move
struct DelegatedNameToken has key, store {
    id: UID,
    parent_name: String,
    subname_cap_id: ID,          // wrapped SubnameCap
    dwallet_cap_id: ID,          // IKA DWalletCap — keyless custody
    minted_count: u64,
    revoked: bool,
    created_ms: u64,
}
```

### Authority Model

| Actor | Can Do |
|-------|--------|
| **Padre** (deNFT holder via dWallet) | Mint subnames (any length), batch mint, set subname targets |
| **Name owner** (SuiNS NFT holder) | Revoke deNFT, revoke any subnames padre created, reclaim SubnameCap, override anything |

The NFT is root authority. The deNFT is a delegated lease. Owner trumps padre always.

### Flow

1. `coulson.sui` owner calls `create_denft(nft, dwallet_cap)` → mints deNFT, SubnameCap wrapped inside
2. Padre calls `batch_mint_subnames(denft, names: vector<String>, targets: vector<address>)` → creates phil.coulson.sui, maria.coulson.sui, etc.
3. No length restriction on subnames — `a.coulson.sui` is valid
4. Owner calls `revoke_denft(denft)` → burns delegation, SubnameCap returns to owner
5. Owner calls `revoke_subname(nft, subname)` → removes any subname padre created
6. IKA network can co-sign revocation (brando OR IKA network = valid, first commandment)

### Subnames + Roster

Subnames created via deNFT auto-join the global SUIAMI Storm. Their roster entries reference the padre's attestation. When a subname holder Rumbles independently, their entry upgrades with their own dWallet attestation.

---

## Contract Changes

### Roster Contract (`suiami::roster`)

Add to `IdentityRecord`:
```move
struct IdentityRecord has store, drop, copy {
    name: String,
    sui_address: address,
    chains: VecMap<String, String>,    // plaintext SUI only
    dwallet_caps: vector<address>,
    updated_ms: u64,
    // NEW FIELDS:
    walrus_blob_id: String,            // Walrus blob containing Seal-encrypted cross-chain addresses
    seal_nonce: vector<u8>,            // Seal encryption nonce
    verified: bool,                    // true if dwallet_caps is non-empty (dWallet-attested)
}
```

### New Contract: `suiami::denft`

```move
module suiami::denft {
    // create_denft: wraps SubnameCap + DWalletCap
    // batch_mint_subnames: padre mints N subnames in one tx
    // revoke_denft: owner reclaims SubnameCap
    // revoke_subname: owner removes a subname
}
```

### Seal Policy: `suiami::seal_roster`

```move
module suiami::seal_roster {
    // seal_approve_roster_reader: checks has_address(sender) on roster
    // Called by Seal key servers during dry-run
    // Identity bytes: [roster_obj_id (32 bytes)][key_version (8 bytes)]
}
```

---

## Client Changes

### `src/suins.ts`

- **`readRosterByAddress(addr)`** — new function, GraphQL query using address-keyed dynamic field on roster object
- **`writeRosterWithSeal(name, suiAddr, chainAddrs, sealKey)`** — Seal-encrypt chain addresses, upload to Walrus, write roster entry with blob ID
- **Re-enable `maybeAppendRoster`** — fix v2 contract upsert abort, include Walrus blob ID
- **`createDeNFT(nft, dwalletCap)`** — build PTB for deNFT creation
- **`batchMintSubnames(denft, names[], targets[])`** — build PTB for batch subname creation

### `src/ui.ts`

- **Squids display** — query roster by address for cross-chain data instead of localStorage
- **Join button** → triggers global Storm join + roster write PTB
- **SUIAMI button** → on success, also writes roster entry with Seal-encrypted blob
- **Verified badge** — visual indicator when `verified: true` (has dWallet attestation)

### `src/client/thunder-stack.ts`

- **Storm creation** — piggyback `set_identity` on Storm creation PTB
- **Global Storm** — hardcode global Storm object ID, join on SUIAMI proof success

---

## Seal Infrastructure

Reuse existing 2-of-3 threshold:
- Overclock: `0x1455...08b6` (weight: 1)
- Studio Mirai: `0xe0eb...fd10` (weight: 1)
- H2O Nodes: `0x4a65...286a` (weight: 1)

Seal policy: `seal_approve_roster_reader` — checks `has_address(ctx.sender())` on roster object. Same dry-run pattern as Thunder's `seal_approve_reader`.

---

## Walrus Storage

- **Aggregator:** `https://aggregator.walrus.space` (migrated to mainnet via Metang Rain Dance 2026-04-17; production operators: Walrus Foundation, Studio Mirai, Overclock, H2O Nodes)
- **Blob format:** JSON `{ btc: "bc1q...", eth: "0x...", sol: "5Kz...", dwallet_caps: ["0x..."] }`
- **Encryption:** Seal-encrypt before upload, store nonce on-chain in roster
- **Caching:** CF edge cache with 1hr TTL (same pattern as squids spec blob)

---

## Viral Loop

```
User A has roster entry
    → User B views A's card, clicks squids
    → B sees "Join" button
    → B clicks Join → one sign → B's roster entry written + B joins global Storm
    → B can now decrypt A's chain addresses
    → B is now discoverable by User C
    → C views B's card... (loop continues)
```

Every read creates a write. The roster grows with every lookup. Agents (t2000s, Chronicoms) seed the network by joining the global Storm permanently.

---

## Implementation Order

1. **Seal roster policy contract** — `seal_approve_roster_reader` Move module
2. **Roster contract update** — add `walrus_blob_id`, `seal_nonce`, `verified` fields
3. **`readRosterByAddress`** — client-side GraphQL query
4. **`writeRosterWithSeal`** — Seal encrypt + Walrus upload + roster write
5. **Global Storm deployment** — create fixed PermissionedGroup, hardcode ID
6. **Re-enable `maybeAppendRoster`** — fix upsert abort, include blob ID
7. **Squids display** — query on-chain roster instead of localStorage
8. **Join button wiring** — Storm join + roster write PTB
9. **deNFT contract** — `suiami::denft` module
10. **deNFT client** — `createDeNFT`, `batchMintSubnames` PTB builders
11. **Verified badge UI** — visual indicator for dWallet-attested entries
