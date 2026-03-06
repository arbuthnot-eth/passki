# SHIELD — Shade Security Model

Security documentation for the Shade subsystem of .SKI.

## Overview

Shade is a privacy-preserving time-locked escrow for SuiNS grace-period domain sniping. It uses an on-chain commitment-reveal scheme so that the target domain, recipient address, and execution timestamp remain hidden until the moment of execution.

Contract: `0xb9227899ff439591c6d51a37bca2a9bde03cea3e28f12866c0d207034d1c9203` (Sui mainnet)

---

## On-chain commitment-reveal

### Commitment

When a user creates a Shade order, the contract stores only an opaque hash:

```
commitment = keccak256(domain || execute_after_ms || target_address || salt)
```

The `ShadeOrder` is a **shared object** containing:

- **Owner address** — the wallet that created the order
- **Escrowed SUI balance** — locked funds for domain registration + gas
- **Commitment hash** — the keccak256 digest above

No domain name, target address, or timing information is stored on-chain until execution.

### Reveal

At execution time, the caller provides the full preimage (domain, execute_after_ms, target_address, salt). The contract recomputes the hash and verifies it matches the stored commitment before proceeding with the SuiNS registration.

---

## Permissionless execution

`execute()` is **permissionless** — anyone who possesses the preimage can call it. This enables keeper bots to auto-execute orders without requiring the original user's wallet to be online.

`cancel()` is **owner-only** — only the wallet that created the order can cancel it and reclaim the escrowed SUI.

---

## Execution routes

Shade supports three registration payment routes, selected automatically based on available liquidity and price conditions:

| Route | Path | When used |
|---|---|---|
| **A** | SUI -> NS via DeepBook | Default; swaps escrowed SUI for NS tokens on DeepBook, then pays SuiNS with NS |
| **B** | SUI -> USDC -> NS (two-hop) | Preferred when SUI price drops make Route A insufficient for the required NS amount |
| **Fallback** | SUI direct | Pays SuiNS registration fee directly in SUI, no swap needed |

Route B is preferred when SUI price volatility makes the single-hop swap insufficient to cover the NS-denominated registration cost.

---

## ShadeExecutorAgent (Cloudflare DO)

The `ShadeExecutorAgent` is a Cloudflare Durable Object that auto-executes Shade orders at grace-period expiry:

- Orders are scheduled via **DO Alarms** set to fire at the `execute_after_ms` timestamp
- The keeper address (`0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`) signs and submits the execution transaction using its own gas
- The keeper's private key (`SHADE_KEEPER_PRIVATE_KEY`) is stored as a Cloudflare Worker secret in bech32 `suiprivkey1...` format
- Transaction submission uses a multi-RPC fallback chain (PublicNode, BlockVision, Ankr) since gRPC is unavailable in Workers/DOs

---

## Seal encryption (removed)

Seal encryption (using Mysten's threshold encryption with Overclock, NodeInfra, and Studio Mirai key servers) was planned to encrypt the preimage at rest, adding a second privacy layer. It was dropped due to:

- Silent decryption failures in production
- Namespace mismatch between Seal package IDs and the Shade contract

The commitment-reveal scheme alone provides the core privacy guarantee: on-chain observers cannot determine which domain is being targeted until execution.

---

## Known issues

### WaaP cancel compatibility

WaaP has signature issues on shared-object-by-value calls (like legacy `cancel()`).
The cancel flow now uses:

1. `cancel_refund(&mut ShadeOrder)` user-signed call to return funds.
2. Keeper-signed `reap_cancelled(ShadeOrder)` cleanup to delete the cancelled object.

This preserves refund + object deletion while avoiding WaaP's by-value signing bug.

---

## Threat model summary

| Property | Guarantee |
|---|---|
| Domain privacy (pre-execution) | Hidden behind keccak256 commitment; no on-chain leakage |
| Escrow safety | Only owner can cancel; escrowed SUI returned on cancel |
| Execution liveness | Permissionless execute + DO Alarm keeper ensures timely execution |
| Keeper compromise | Keeper can execute early (if it has preimage) but cannot steal escrowed funds; funds flow to SuiNS registration or back to owner |
| Front-running | Preimage is known only to the user and the keeper; on-chain mempool observers see only the commitment hash until the execute tx is broadcast |
