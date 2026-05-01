# No Worker Keys — First Commandment

**Status:** Tenet. Non-negotiable. Stake in the ground.
**Owner:** SKI core
**Date set:** 2026-04-30

## 1. The tenet

No private keys on Cloudflare Workers, ever — including relay keys, gas wallets, sponsor signers, x402 settlement keys, "ephemeral" session keys, and "just $5" rationalizations. There is no key small enough, no TTL short enough, and no use case urgent enough to justify a raw keypair living in a Worker, a Durable Object, or any edge runtime SKI controls.

## 2. Why this is the moat

SKI's posture is IKA-native. Every wallet, every agent, every cross-chain address is produced by IKA dWallet DKG and signed via re-encrypted user shares plus the IKA network — never by a server holding bytes. That is the structural claim Mysten's stock SDK cannot match, and it is the only reason the Suilana Ikasystem framing reads as architecture instead of marketing.

The moment a Worker holds a key, SKI is running the same architecture as every other wallet team that ships fast and apologizes later. Frontier becomes follower. The brand stake collapses into a slide deck.

## 3. Elevator pitch

For the **user**: sovereignty — no SKI-operated server can move your funds, draft a transaction in your name, or get subpoenaed into doing so. For the **agent**: composability — agent identities are first-class IKA dWallets, signable by their owner or their delegate, portable across chains without re-keying. For the **product**: an uncopyable moat — competitors who took the Worker-key shortcut cannot retrofit IKA-native posture without rewriting their signing layer. For the **operator**: a smaller blast radius — a compromised Worker leaks logs and rate limits, not custody.

## 4. Acceptable exceptions

None.

`ULTRON_PRIVATE_KEY` and `SHADE_KEEPER_PRIVATE_KEY` are the only two raw keys currently in production secrets. They are **phase-out targets**, tracked as technical debt, not precedents. New code does not get to cite them. "Ultron has one, so x402 can have one" is exactly the reasoning the 4-3 revert rejected.

## 5. What this rules out

- Relay EOAs holding ETH/SOL/SUI for settlement or rebroadcast
- Gasless meta-transaction submitters with server-held signing keys
- Server-side ECDSA / EdDSA for any chain, for any reason
- "Ephemeral session keys" minted in a DO and used to sign on the user's behalf
- Sponsor wallets implemented as raw keypairs in Worker secrets
- Bridge or x402 settlement keys provisioned outside the IKA path
- "Just-in-time" keys derived from a master secret stored at the edge

## 6. What this rules in

- IKA-mediated signing with re-encrypted user shares (browser DKG, agent re-encryption)
- Seal-gated session unlocks where ciphertext lives on Walrus and policy lives on-chain
- Browser-side transaction construction and submission (gRPC or GraphQL)
- Account-abstraction paymasters where authority is delegated, not custodial
- Third-party gas relayers consumed as **declared dependencies** — named in docs, scoped in policy, swappable
- WaaP-style enclaved signers operated by counterparties who publish their own attestation

The dividing line is simple: SKI never holds the bytes that move funds.

## 7. Public framing

Tweet, doc header, pitch slide — same line:

> **SKI runs zero private keys on its servers. Your dWallet, your share, your signature — every time.**

Variations are fine; the claim is not. When asked "what about gas relays?" the answer is: declared dependencies, never silent custody. When asked "what about Ultron?" the answer is: legacy, scheduled for IKA migration, not a template. When asked "isn't that slower?" the answer is: yes, and that is the cost of the moat.

---

*This file is the canonical reference. If a future PR proposes a Worker-held key for any reason, link here and close it.*
