# Mint Relay — IKA-Native Settlement Threat Model

**Status:** Future path. No implementation. Documentation only.
**Date:** 2026-04-30
**Author:** Pistis (vote: option A, research IKA SDK server-side signing)
**Context:** Vote went 4–3 for browser-side x402 submission as today's ship. This
doc preserves the long-term IKA-native path so we don't lose the design space.

## 1. Goal

ultron's IKA-derived Base address `0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d`
must sign and submit its own outbound `transferWithAuthorization` (USDC EIP-3009)
calls **without any private key, seed, or recoverable share ever existing on a
Cloudflare Worker in plaintext form**.

This is the First Commandment: every wallet, agent, and cross-chain address
MUST be IKA-native. ultron's Base address came from IKA dWallet DKG — it must
also *sign* through IKA, never via a re-encoded raw key.

Concretely, when a relay endpoint is asked to settle an x402 payment from
ultron → user, the resulting Base transaction must carry an ECDSA secp256k1
signature produced by the IKA committee + an authorized user-share holder, not
by `wallet.sign()` over a stored private key.

## 2. Constraints

- **DKG is browser-only.** IKA SDK's WASM bundle for DKG runs in a browser
  context. Workers cannot perform DKG. ultron's keys were already DKG'd from
  brando's tab; we are only reasoning about the *signing* path here.
- **Workers cannot run gRPC.** No HTTP/2 bidirectional streaming. Any
  Worker-side IKA interaction must use GraphQL (read) or HTTP-RPC (`fetch`-able
  JSON-RPC) for Sui submission. IKA committee comms are HTTP-shaped, so that
  part is feasible; but any SDK path that secretly uses gRPC is out.
- **No raw key on Worker.** Even briefly. Even in a `Uint8Array` that gets
  zeroed. Workers' memory is shared across requests within an isolate; a single
  bug or eval-injection ends the game.
- **DWalletCap is the on-chain authority object.** Whoever holds (or is granted
  capability over) the DWalletCap can authorize signing requests through the
  IKA committee, but only in concert with a valid user share.
- **Base RPC submission is permissionless.** Anyone with a signed tx can push it
  to Base. The hard part is producing the signature, not the broadcast.

## 3. Design Sketches

### Sketch A — DO-mediated user share

A Durable Object (`UltronSignerDO`) holds a re-encrypted user share that is
**function-restricted** to producing signatures over `transferWithAuthorization`
calldata for ultron's Base address.

```
Worker (x402 endpoint) ──► UltronSignerDO ──► IKA committee
                                │
                                └──► returns r,s,v
Worker ──► Base RPC (PublicNode/Alchemy) with raw signed tx
```

- DO secret: an envelope-encrypted blob (`ENCRYPTED_USER_SHARE`) decryptable
  only inside the DO using a KEK from `cloudflare:workers` secret store.
- DO entry point validates: (a) caller is the mint-relay Worker via a shared
  HMAC, (b) tx template is `transferWithAuthorization` to a SUIAMI-resolved
  address, (c) amount ≤ per-tx cap, (d) per-window rate limit not exceeded.
- DO never exports the share — only the resulting signature.

**Pros:** least UX friction, server-side autonomy, ultron-as-agent semantics.
**Cons:** the share *does* live in DO memory while signing. KEK exfil = share
exfil = full ultron Base account compromise. Closest cousin to "private key on
a Worker," just dressed up.

### Sketch B — Browser-coordinated

The user's tab (already has IKA WASM loaded for DKG) participates in the
signing handshake. The Worker just relays.

```
Browser (brando.sui or ultron-controller tab)
   │  signs IKA partial via WASM
   ▼
Worker (x402 endpoint) — bundles IKA committee co-sig
   │
   ▼
Base RPC submit
```

- Worker holds zero share material.
- Browser must be online for any settlement. If we need ultron to settle while
  brando is asleep, Sketch B fails.
- Could be relaxed by giving ultron-the-agent its own browser-shaped runtime
  (a headless puppeteer-in-DO, or a separate IKA-aware service). At that
  point you're rebuilding Sketch A with extra steps.

**Pros:** strictly no server-side share, cleanest threat model.
**Cons:** ultron loses 24/7 autonomy. x402 settlement can't happen if no human
tab is alive. Defeats the "ultron is an agent" thesis.

### Sketch C — Sui-mediated (DWalletCap signs Base)

ultron submits a Sui transaction whose effect is "ask the IKA committee to
co-sign this Base calldata." The committee outputs an ECDSA secp256k1 sig
matching ultron's Base address. A thin off-chain relay (Worker) takes the sig
+ calldata and broadcasts to Base.

```
Worker ──► Sui tx (DWalletCap::request_sign(calldata)) via PublicNode JSON-RPC
                │
                ▼
        IKA committee processes, emits sig event on Sui
                │
                ▼
Worker reads event via GraphQL ──► raw-tx ──► Base RPC
```

- Worker holds an ultron-controlled Sui keypair (or, ideally, *also* an
  IKA-derived Sui sig path — recursive but already what ultron uses for Sui).
- The "authorization to ask IKA to sign for Base" lives on-chain as a
  capability transfer / Move policy rule. Per-tx caps, allowlists, and
  rate-limits become Move policy, not Worker code.
- Higher latency: two networks, one event-roundtrip.

**Pros:** policy lives on-chain and is auditable. Worker compromise yields
*nothing* if the policy module is tight (rate, allowlist, amount cap). Matches
the Silvally / SUIAMI pattern of putting authority in Move.
**Cons:** latency (Sui finality + IKA roundtrip + Base submit). Requires Move
work — a `mint_relay_policy` module. Also requires that ultron's *Sui*
signing path be IKA-native too, which it should already be.

## 4. Attack Surface

### Sketch A
- **KEK exfil from DO secret binding:** total compromise. Attacker drains
  ultron's Base USDC up to per-window cap before alerting.
- **DO code injection (e.g. dependency supply-chain):** can call sign() with
  attacker-chosen calldata up to policy cap. Mitigated by tx-template
  validation, but template parser is itself attack surface.
- **Replay:** EIP-3009 nonces protect against on-chain replay. Off-chain
  replay (DO signs same tx twice) wastes a nonce but doesn't double-spend.
- **Worker → DO HMAC compromise:** attacker can request signatures within
  policy. Same blast radius as Worker compromise.
- **What compromise yields:** policy-capped USDC drain per window, until
  rotation. If KEK leaks: full account, no cap.

### Sketch B
- **Browser tab XSS:** attacker signs whatever the tab signs. Standard wallet
  threat. SKI already lives with this for brando.sui.
- **Worker compromise:** attacker can *relay* but not *sign*. Can withhold
  legitimate sigs (DoS) but cannot mint or move funds.
- **What compromise yields:** Worker comp = nothing. Tab comp = whatever's
  signable in that session.

### Sketch C
- **Sui keypair compromise on Worker:** attacker can submit `request_sign`
  calls. Move policy must enforce: caller == ultron (which means the keypair
  IS ultron's authority). So this collapses to "Worker can mint within
  on-chain policy." Mitigated by policy caps + allowlist.
- **IKA committee compromise:** breaks every sketch equally. Out of scope.
- **Sui RPC poisoning:** attacker tricks Worker into thinking a sig was
  emitted that wasn't — but the sig is on-chain and verifiable. Hard to fake.
- **What compromise yields:** policy-capped activity. Move policy is the
  hard cap, and it's auditable on Sui.

## 5. Open Questions

1. **Does IKA SDK expose a Worker-runnable signing path post-DKG?** Memory
   says DKG is browser-only. Signing might or might not need WASM. Need to
   read IKA SDK source for `sign()` vs `dkg()` boundaries. **Spike:** import
   IKA SDK in a Worker context, try a sign call against a pre-DKG'd dWallet.
2. **Can DWalletCap policies enforce a calldata template?** Sketch C depends
   on Move-side validation that the bytes being signed are a
   `transferWithAuthorization` to an allowed recipient. Need to verify the
   Move primitives. **Spike:** prototype `mint_relay_policy::request_sign`
   that parses EIP-712 typed-data hash from input bytes.
3. **What is the latency of IKA sign for ECDSA secp256k1 today?** If it's
   >5s, Sketch C is too slow for x402 (sub-second expectation).
   **Spike:** time `sign()` on devnet with secp256k1 curve.
4. **Can we make DO storage tamper-evident?** For Sketch A, can we attest
   that the encrypted share blob hasn't been swapped by an admin with KV
   write access? Workers don't have TEEs. Probably no.
5. **Is there a "signing-only" share form?** A re-encryption that *cannot*
   reconstruct the full key, only contribute to a sign call? The IKA paper
   suggests yes (threshold signing); SDK ergonomics unknown.

## 6. Gas-Payment Strategy

Even with a perfect IKA signature, the Base tx needs ETH for gas. ultron's
Base address holds USDC, not ETH (intentional — we don't want a hot key with
ETH). Options:

- **Sponsor-relay (preferred MVP):** a dedicated `gas-sponsor` EOA on Base
  funded with a few hundred bucks of ETH wraps the signed tx in a paymaster
  call or simply broadcasts after a meta-tx pattern. Refilled monthly from
  treasury. Compromise = gas funds drained, no user impact.
- **ERC-4337 paymaster (clean):** ultron's Base address is a smart account.
  A paymaster contract pays gas if the userOp targets `transferWithAuthorization`
  with allowed parameters. Policy enforced on-chain. Higher complexity:
  ultron must be deployed as a smart account, not an EOA. Currently it *is*
  an EOA derived from IKA secp256k1 — switching breaks the IKA-derivation
  invariant unless we set up a 4337 wallet *owned by* the IKA address.
- **Micro-relay marketplace (Gelato, Pimlico, Biconomy):** outsource gas. Pay
  per relay in USDC. Adds a third-party trust assumption + ongoing cost.
  Simplest wiring, worst cost profile at scale.
- **EIP-3009 native:** `transferWithAuthorization` itself is gasless from the
  USDC sender's perspective — a third party submits and pays gas, USDC moves
  signed-not-submitted. So in fact, *any* address with ETH can submit
  ultron's signed authorization. This is the natural fit: ultron signs,
  sponsor-relay submits + pays gas, USDC moves from ultron → user. No
  paymaster contract needed for v1.

**Recommended:** start with sponsor-relay + EIP-3009 native (no 4337). Move
to 4337 only if we want richer policy enforcement on Base side (per-recipient
caps, etc.) or if sponsor-relay key management becomes its own threat.

## 7. Recommendation

Pursue **Sketch C (Sui-mediated)** first. Reasons:

1. Worker holds no share material at all — closest match to the First
   Commandment.
2. Authorization policy lives in Move, where it's auditable and upgradable
   via UpgradeCap (already a known SKI pattern via plankton.sui).
3. Latency cost is real but bounded; for x402 settlement we can pre-sign or
   batch.
4. Ties cleanly into the Ultron Envelope dispatcher — Base sends become just
   another envelope kind.

Sketch A is the fallback if IKA committee latency proves prohibitive.
Sketch B is the right answer for *user-initiated* sends (and is what
brando.sui already does for SuiNS), but wrong for autonomous ultron.

**First spike:** Open Question #1 (Worker-runnable IKA signing) and #3 (sign
latency). Both unblock the choice between A and C.
