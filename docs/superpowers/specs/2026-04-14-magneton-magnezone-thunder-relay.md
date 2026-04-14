# Magneton → Magnezone — Thunder universal relay + mixnet evolution

**Issue:** [#151](https://github.com/arbuthnot-eth/.SKI/issues/151)
**Status:** spec / design — no implementation yet
**Filed:** 2026-04-14
**Pokemon line:** Magneton (double-envelope relay) → Magnezone (onion mixnet)

## The problem

Thunder's current architecture creates one on-chain `PermissionedGroup<Messaging>` ("Storm") per pair of users on first contact. Cost:

- **~1.13 SUI per Storm creation** (gas + on-chain group state)
- **Count: O(relationships²)** — quadratic growth with the social graph
- **User friction:** first-time recipients see a silent dead-end when the quick-amt auto-send fires before the Storm exists

Every new pair pays the cost again. A user with 50 counterparties pays 50 × 1.13 SUI = ~$52 just in Storm creation fees before sending a single message.

## The idea

**Route every conversation through ultron as a universal relay.** Each user has exactly ONE Storm — with ultron. All other "conversations" are logical overlays on that single Storm, with ultron acting as an encrypted-mail post office.

### Magneton — double-envelope version (content-private)

The transport:

```
A                              ultron                          B
│                               │                              │
│ encrypt(msg) to B's key       │                              │
│ ─────────► inner_cipher       │                              │
│                               │                              │
│ encrypt({                     │                              │
│   inner_cipher,               │                              │
│   routing: {to: B, ts, id}    │                              │
│ }) to ultron's key            │                              │
│ ─────────► outer_envelope     │                              │
│                               │                              │
│ sendThunder(outer_envelope    │                              │
│   → thunder-ultron)           │                              │
│═══════════════════════════════►                              │
│                               │ decrypt outer                │
│                               │ → {inner, routing}           │
│                               │ lookup B's thunder-ultron    │
│                               │ relay inner as new thunder   │
│                               │ with header from=A           │
│                               │══════════════════════════════►
│                               │                              │ decrypt inner
│                               │                              │ with B's key
│                               │                              │ → plaintext
```

**Key property:** ultron CANNOT read `inner_cipher` because it's locked to B's session key, which ultron doesn't have. Ultron only sees routing metadata (who → who + timestamps).

### Magnezone — onion mixnet evolution (graph-private)

Magneton leaves the routing graph exposed to ultron. Magnezone upgrades the transport to a **multi-hop onion route** across a fleet of ultron sub-agents, each seeing only prev + next hop:

```
A → relay-01 → relay-02 → relay-03 → B

  outer-3 wrapped for relay-01
    outer-2 wrapped for relay-02
      outer-1 wrapped for relay-03
        inner wrapped for B
```

Each relay peels its layer, sees only the immediate next hop, forwards. The full A→B path is never reconstructable by any single relay (or any N-1 subset).

Additional mixnet tactics:
- **Timing obfuscation:** relays hold messages for a random 0–30s delay before forwarding, breaking send→receive timing correlation
- **Cover traffic:** relays send dummy padded messages to each other every minute regardless of real load, so observers can't distinguish active from idle pairs
- **Padding buckets** (already in Thunder Phase 1): fixed-size ciphertexts [256, 1024, 4096, 16384] make envelopes visually indistinguishable
- **Path randomization:** sender picks a random permutation of 2–4 relays per send, no sticky routes

## Architecture comparison

| Property | Today (pair Storms) | Magneton (relay) | Magnezone (mixnet) |
|---|---|---|---|
| Setup cost per user | 1.13 SUI × N_relationships | 1.13 SUI × 1 (once, with ultron) | 1.13 SUI × 1 |
| Per-message gas | 1× | 1× + ultron relay gas (sponsored) | 1× + N_hops relay gas |
| Contents privacy | ✓ (direct Seal) | ✓ (inner cipher) | ✓ (inner cipher) |
| Graph privacy | ✓ | ✗ (ultron sees who → who) | ✓ (no relay sees full path) |
| Timing privacy | partial (jitter on DO) | partial | ✓ (random hold + cover traffic) |
| Latency (typical) | 2–5s | 5–30s | 30–60s |
| Compromise: one relay | n/a | full graph leak | prev + next hop only |
| Compromise: all relays | n/a | full graph leak | degrades to Magneton |
| First-send to new contact | blocks on Storm creation | works instantly | works instantly |

## Moves plan

### Magneton

**Lv.10 Thunder Wave** — Silent `thunder-ultron` Storm creation
- On first wallet connect, check if `thunder-ultron` Storm exists for this user; if not, create it
- Sponsored by ultron (zero SUI cost to user)
- Hidden from UI — no creation prompt, no "opening Storm" toast

**Lv.20 Thunder Shock** — `sendThunder` double-envelope wrap
- Client-side rewrite of the send path in `thunder-stack.ts`
- When sending to a non-ultron counterparty, build the double-envelope:
  ```ts
  const innerCipher = await seal.encrypt(plaintext, recipient.sessionKey);
  const outerEnvelope = await seal.encrypt(
    { inner: innerCipher, route: { to: recipientName, createdAt, msgId } },
    ultron.sessionKey
  );
  ```
- Submit as a normal thunder on the sender's `thunder-ultron` Storm
- Keep the existing pair-Storm path as a fallback / legacy migration

**Lv.30 Tri-Attack** — Ultron relay daemon
- New method in `TreasuryAgents` DO: `_relayThunderTick()`
- Cron tick (10–30s cadence): for every `thunder-ultron` Storm ultron is a member of, poll for new thunders
- For each pending outer envelope:
  1. Decrypt with ultron's session key
  2. Extract `{inner_cipher, routing_header}`
  3. Look up recipient's `thunder-ultron` Storm ID
  4. Submit the inner cipher as a new thunder on the recipient's relay Storm, tagged `from: <original sender>`
- Idempotency: store processed message IDs in DO state to prevent duplicate delivery on retries
- Error handling: on recipient lookup failure, retry with exponential backoff; surface unrecoverable failures via Thunder signal back to sender

**Lv.40 Mirror Shot** — Recipient read path
- UI polls `thunder-ultron` Storm instead of pair Storms for incoming messages
- Each decrypted inner cipher's routing header provides the logical `from` field
- Index messages by `from` in the client state so the UI still groups conversations by counterparty
- `_thunderCounts[name]` aggregates from inner routing headers, not Storm membership

**Lv.50 Discharge** — UI transparency
- Preview cards, Storm badges, and convo pane work identically regardless of whether a message came from a pair Storm or a relay
- Logical "storm with X" is synthesized from the subset of messages in `thunder-ultron` with routing header `from == X` or `to == X`
- `_expandIdleConvo(name)` reads/writes the logical view

**Evolution PR merge → Magnezone fusion form**

### Magnezone

**Lv.60 Zap Cannon** — Multi-hop onion relay
- Sender picks 3 random relays from the active ultron fleet
- Builds nested Seal envelopes (one per hop + one inner for recipient)
- First relay receives the outermost; peels it, sees next hop only, forwards
- Recipient peels the innermost, gets plaintext

**Lv.70 Lock-On** — Ultron relay fleet spawn
- Deploy `t2000-relay-01`, `t2000-relay-02`, `t2000-relay-03` as IKA-native autonomous agents
- Each relay has its own session key + DWalletCap + dedicated `thunder-ultron-relay-NN` Storm pattern
- Relay selection: client queries `/api/cache/relay-fleet` for the list of active relays, picks N at random

**Lv.80 Flash Cannon** — Timing obfuscation + cover traffic
- Each relay tick adds a uniform random delay (0–30s) before forwarding
- Each relay sends at least one dummy padded thunder per minute to a rotating peer, regardless of real load
- Dummies are indistinguishable from real messages (same padding bucket, same ciphertext shape)
- Cover traffic cost is a flat per-relay per-minute budget, sponsored by ultron

**Lv.90 Gravity** — Adversary model + threat model review
- Document the mixnet threat model formally
- Publish an external review by a crypto-literate third party
- Ship a public "I am being relayed" indicator in the Thunder UI so users know when they're on the mixnet

## Migration

Magneton is backwards-compatible:

- Existing pair Storms continue to work; the client falls through to them when no `thunder-ultron` relay path is set up
- Pending pair-Storm conversations can be lazily migrated on next open: unsent messages re-wrapped through ultron, pair Storm marked as deprecated
- The thunder UI shows no change — same bubbles, same names, same input flow

## Threat model (Magneton)

**Honest-but-curious ultron:** ultron follows the protocol but may log routing metadata. In this model, Magneton provides:
- ✓ Content privacy (inner cipher locked to recipient)
- ✓ Resistance to external observers (they only see `thunder-ultron` traffic)
- ✗ Routing graph privacy (ultron sees who → who)
- ✗ Timing correlation resistance (ultron sees exact send/receive times)

**Compromised ultron:** attacker gets the full social graph + timing but NOT the message contents. Similar to what an email provider sees today.

**Compromised Seal key servers:** same risk as today — attacker could decrypt inner ciphers. Mitigated by the 2-of-3 Seal threshold (Overclock, Studio Mirai, H2O Nodes).

## Threat model (Magnezone)

**Adversary watches the chain:** sees which ultron relays send/receive how many thunders at what rate. Timing obfuscation + cover traffic make real vs dummy indistinguishable.

**Adversary compromises 1 relay:** sees prev + next hop of any message that passed through it, nothing else. No full path reconstructable from a single relay's view.

**Adversary compromises N–1 relays:** can reconstruct most of the path for messages that traversed compromised relays only; messages routing through the one honest relay remain private for that hop.

**Adversary compromises all relays:** degrades to Magneton's metadata leak.

**Recommendation:** ≥3 relays owned by legally/geographically distinct operators (different jurisdictions, different keystores, different deploy pipelines).

## Out of scope

- **Federating relays** across non-ultron operators → that's a post-Magnezone decentralization step
- **ZK-proof relay audits** → Magnezone could optionally prove "I forwarded every message I received"
- **Incentivized relays** → ultron is altruistic today; later relays could earn iUSD
- **Attachment onion routing** → attachments hit Walrus directly; only the Seal cipher header gets onion-wrapped

## Links

- Issue: [#151](https://github.com/arbuthnot-eth/.SKI/issues/151)
- Related: Sableye #145 (private interaction set, client-side counterpart)
- Related: Thunder Privacy Phase 1 memory (padding buckets + sender index + timestamp jitter — reuse directly)
