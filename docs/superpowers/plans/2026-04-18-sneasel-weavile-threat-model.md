# Threat model — Sneasel / Weavile private-send architecture

**Date:** 2026-04-18 · **Issues:** #197 (Sneasel), #198 (Weavile) · **Status:** Authoritative

Written after a 3-voter deliberation swarm (research + engineering-reuse + adversarial red-team) converged on: build both models, ship neither without the conditions below.

---

## Language discipline (voter 3's "don't lie to users")

- **Sneasel (guest subnames)** is a **counterparty-siloing UX primitive.** It lets you give Amazon and Venmo different addresses so they can't enumerate each other's payments. It is **not** a privacy layer against chain analytics, subpoena, or targeted surveillance.
- **Weavile (stealth addresses)** is a **per-payment unlinkability layer.** Every payment lands at a mathematically fresh, ECDH-derived address that isn't visible on-chain without the view key.

Any user-facing surface that suggests Sneasel alone is "private" is a security bug. Sneasel is useful, but it protects against a weaker adversary than users will assume.

---

## Adversary tiers

### T1 — curious counterparty
Amazon wants to know what else Brando buys.

- **Sneasel defeats.** Amazon sees `0xhotA`, has no access to `0xhotV` where Venmo pays.
- **Weavile defeats.** Amazon sees a fresh addr per payment, can't link to anything.

### T2 — chain analytics (Arkham, Nansen, Chainalysis)
Cluster all addresses that behave like one user.

- **Sneasel FAILS.** All hot addrs sweep to ultron's broker cluster via common-input heuristics. Arkham will tag all `.whelm.eth` users as one cohort and trace individual cold squids via peel-chain analysis. **This is the fatal Sneasel flaw.**
  - **Mitigation (Sneasel Ice Fang):** per-guest distinct cold destinations + per-guest Seal encryption. No common broker.
- **Weavile defeats, conditional on gas-funding hygiene.** Without EIP-4337 paymaster, funding stealth addrs from a common source re-links the graph (arxiv 2308.01703, Umbra anonymity analysis). With paymaster-sponsored sweeps + randomized timing, no peel.
  - **Ship-gate (Weavile Assurance):** 4337 integration before public launch.

### T3 — server subpoena (regulatory pressure on CF, DO, Seal key servers)
Legal process compels gateway logs or encrypted data.

- **Sneasel partially FAILS.**
  - CCIP-read gateway logs reveal *who queried which subname* → counterparty graph without touching chain.
  - Seal's 2-of-3 threshold is a low bar — compelling 2 key servers gets the cold destinations.
  - **Mitigation (partial):** rotate Seal key servers toward jurisdictional diversity, minimize gateway logging.
- **Weavile partially FAILS.**
  - CCIP-resolver logs (Fluidkey-pattern fresh-per-resolve) still show *who asked for brando's stealth-meta-addr*.
  - View-key custody on the DO is subpoenable — but it's non-spending, so only historical payments are deanoned, not future ones (unless the attacker also breaks ECDH, which they can't).
  - **Mitigation:** view-key rotation policy, client-side scanner as a v2 opt-out from DO custody.

### T4 — hot-key compromise
Attacker steals the ultron broker key / view key / spend-share.

- **Sneasel:** ultron key compromise → attacker can steal funds in-flight at hot addrs (limited window if sweeps batch quickly). Cold squids are safe if Seal + IKA shares are intact.
- **Weavile:**
  - View key compromise → attacker sees all past payments, cannot steal.
  - Spend-share compromise alone → attacker needs IKA network cooperation to sweep → effectively safe unless IKA network is also compromised (2-of-3 IKA threshold).
  - Both compromised → catastrophic, but requires 2 independent breaks.

### T5 — "forced disclosure" / rubber-hose
User hands over keys under duress.

- **Sneasel:** user reveals parent-SUIAMI key → attacker can write guest subnames, but not read historical cold destinations without ultron's cooperation.
- **Weavile:** user reveals view key → attacker reads historical payments. User reveals spend share → attacker still needs IKA network to sweep (T4 again). **Recipient-keyless spending is actually a deniability feature under T5.**

---

## Marketing language we refuse to ship

- ❌ "`*.whelm.eth` sends are private."
  - Correct: "`*.whelm.eth` lets you publish chain-resolvable identity. Privacy level depends on whether you use a plain address, a Sneasel guest subname, or a Weavile stealth meta-address."
- ❌ "Sneasel is privacy-preserving."
  - Correct: "Sneasel lets you give different counterparties different addresses so they can't compare notes. It's not private against chain analytics."
- ❌ "Stealth addresses are anonymous."
  - Correct: "Stealth addresses are unlinkable on-chain from your identity, provided sweep gas is paymaster-sponsored and the view key stays out of adversary hands."

The only place we use the word "private" without qualification is in Weavile **after** Assurance (4337 paymaster) lands, and only then with a link to this doc.

---

## Required conditions before public claims

### Sneasel
- ☐ **Ice Fang** shipped — per-guest distinct cold dests, per-guest Seal key, no common broker
- ☐ Public docs explicitly say "counterparty silo, not privacy layer"
- ☐ UI never labels Sneasel as "private"

### Weavile
- ☐ **Razor Claw** — EIP-6538 registry + ENS text record, IKA-imported spend key
- ☐ **Pursuit** — scanner DO with non-spending view key
- ☐ **Assurance** — 4337 paymaster in sweep path, batched + randomized timing
- ☐ **Ice Punch** — Seal-encrypted per-stealth cold destinations
- ☐ Public docs name remaining T3 (server subpoena) and T5 (forced disclosure) risks

---

## Scope correction 2026-04-18 (project lead override)

Earlier draft scoped Weavile as ETH-only citing "no production reference" for ed25519 stealth (SIP Protocol issue #93). Project lead rejected: **SKI has the missing infrastructure** — IKA 2PC-MPC cross-curve signing + SUIAMI-baked gas sponsorship on every chain. We ship multi-chain from day one and become the reference.

Meta-address format: `ska:<ika_dwallet_id>:<per-chain-view-pubkeys>`. Math is curve-general; IKA handles spend-side composition per chain.

## Things we deliberately do NOT ship

- **Self-custody of spend keys.** SKI's differentiator is keyless-recipient via IKA 2PC-MPC. Offering a "just give me the private key" escape hatch would undo the security model and invite T5 attacks.
- **Transparent "privacy indicators" in UI without this doc behind them.** Green checkmark UX that misleads users is worse than no privacy primitive at all.
- **Quantum-resistant stealth** — post-quantum curves not yet in production for any chain in scope. Revisit if post-quantum moves mainstream.

---

## References

- EIP-5564: Stealth Addresses
- EIP-6538: Stealth Meta-Address Registry
- Umbra anonymity analysis — arxiv 2308.01703
- Fluidkey technical walkthrough (CCIP-resolver fresh-per-query pattern)
- Voter transcripts from 2026-04-18 deliberation swarm (in-session, not in repo)

## Review cadence

Update this doc whenever:
1. A new adversary tier emerges (e.g., quantum, MEV-backrun, etc.)
2. A shipping gate flips (Ice Fang lands, Assurance lands, etc.)
3. SKI adds a cross-chain stealth path (e.g., SIP Protocol matures, IKA multi-curve stealth)

Owner of this doc: whoever owns the next Sneasel/Weavile arc. Do not let it rot.
