# Encrypt + IKA — Privacy Layer Assessment

## Current SKI Privacy Stack (Live)

| Layer | Primitive | What it hides |
|-------|-----------|---------------|
| Thunder | AES-256-GCM + NFT-masked key | Message content, sender identity |
| Shade | Commitment-reveal (keccak256) | Domain, target, timing |
| Prisms | AES-GCM + Walrus blob + commitment | Intent, amount, recipient mapping |
| Seal | 2-of-3 threshold decryption | Decryption gating (Overclock, NodeInfra, Studio Mirai) |
| OpenCLOB | Sub-cent steganographic tags | Cross-chain order matching (tag hidden in lamport dust) |

## Encrypt.xyz (dWallet Labs — same team as IKA)

**What:** FHE (Fully Homomorphic Encryption) execution network for Solana.
**Scheme:** REFHE — Ring-Enhanced FHE, lattice-based (BGV variant). 64-bit machine words, arithmetic + logical ops on same ciphertext. Post-quantum.
**Status:** Pre-devnet. Target devnet Q2 2026, mainnet end of 2026. No SDK, no docs shipped.

### How it works
1. Solana account data encrypted to FHE cluster's public key
2. Executors compute homomorphically (never decrypt)
3. Decryptors (MPC 2/3 threshold) reveal only necessary outputs
4. IKA coordinates cross-chain signing between Sui, executors, decryptors

### What Encrypt does that we can't
- **Compute on encrypted data** — dark pools, private AMMs, sealed-bid matching where the engine processes hidden orders
- **Post-quantum threshold** — REFHE is lattice-based. Our Seal uses BLS (not post-quantum)
- **Confidential DeFi** — hidden collateral ratios verified without revealing positions

### What we do that Encrypt can't (yet)
- Ship. Everything above is live mainnet.
- AES-GCM is hardware-accelerated, sub-millisecond. FHE is orders of magnitude slower.
- Commitment-reveal is zero-overhead. FHE adds ciphertext expansion.

## IKA Connection

Same team (dWallet Labs) builds both. Natural integration path:

```
Sui intent → IKA 2PC-MPC signs → Encrypt executes confidentially on Solana
```

OpenCLOB gets dark pool capabilities without rebuilding. When Encrypt ships, our BAM flow becomes:

1. User creates Prism intent (AES-GCM encrypted, Walrus stored)
2. IKA dWallet signs the Solana-side execution
3. Encrypt processes the order confidentially (FHE — amount hidden from validators)
4. Output decrypted via threshold, settled on Solana
5. Sibyl attests result on Sui Timestream
6. iUSD mints on Sui

## Arcium (Competitor — further along)

MPC-based (not FHE). Mainnet alpha live on Solana. Has Cerberus dishonest-majority protocol + Arcus Rust compiler that auto-encrypts programs. CSPL (Confidential SPL) token standard announced — makes any SPL token confidential with hidden balances.

More relevant near-term than Encrypt. Watch for CSPL — if iUSD SPL adopts it, transfer amounts become hidden.

## Solana Token-2022 Confidential Balances

Built into Solana natively. ElGamal encryption + ZK range proofs. Hidden balances and transfer amounts. Available now via Token-2022 extensions.

**Action item:** When iUSD SPL mint is created, consider Token-2022 with confidential balance extensions instead of standard TokenkegQ. Hidden iUSD amounts on Solana for free. P-token migration (TODO) should also evaluate Token-2022 compat.

## Gaps to Close

1. **Seal is not post-quantum** — BLS threshold. Long-term, migrate to lattice-based threshold when Encrypt/IKA ships it
2. **iUSD amounts visible on-chain** — Token-2022 confidential balances or Arcium CSPL would fix
3. **No private computation** — we encrypt at rest, decrypt to compute. FHE removes this step. Matters for dark pool OpenCLOB matching
4. **Walrus blobs are public** — encrypted content is private, but blob existence is visible. Timing analysis possible.

## Verdict

We are as private as possible with today's shipped primitives. FHE is the next leap but 6-12 months out. The IKA connection means we'll get first-mover access when Encrypt ships. No action needed now except:
- Track Encrypt devnet launch
- Evaluate Token-2022 confidential extensions for iUSD SPL
- Watch Arcium CSPL for near-term hidden balances
