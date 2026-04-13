# Nursery Status — `devnet/nursery` Branch

> **Snapshot date:** 2026-04-12
> **Live:** https://dotski-devnet.imbibed.workers.dev
> **Worker name:** `dotski-devnet`
> **HEAD commit at wrap:** see `git log --oneline -20`

This document captures the state of the `devnet/nursery` work at the moment the parallel development loop was paused. Three voters (product, risk, loop-sustainability) unanimously recommended stopping the feature wave after 5 rounds to let a human review the 14 commits before any of it reaches mainnet.

## What's here

Three Pokemon issues, ~14 commits, 5 cross-review rounds, 12 real bugs caught and fixed.

| Pokemon | Issue | State |
|---|---|---|
| Zoroark | arbuthnot-eth/.SKI#123 | zkLogin provider complete; gated on real OAuth client IDs |
| Eevee | arbuthnot-eth/.SKI#124 | Encrypt FHE client + demo + PC-Token + PC-Swap + cross-chain Prism; all stub-side until pre-alpha exposes a gateway |
| Bagon → Shelgon | arbuthnot-eth/.SKI#125 | Devnet worker deployed, all 9 DOs live, testnet SuiNS + partial Seal; Salamence evolution blocked on testnet IKA DKG data |

## Exercisable today (not stubbed)

- **Devnet worker** — `https://dotski-devnet.imbibed.workers.dev` — live, all 9 Durable Objects bound, cron `*/10 * * * *` registered.
- **zkLogin `/api/zklogin/prove` proxy** — forwards to Mysten's free devnet prover (`https://prover-dev.mystenlabs.com/v1`). `/api/zklogin/health` returns `{ok:true}` intentionally without leaking the upstream URL.
- **Encrypt `/api/encrypt/*` proxy** — stub mode (see blockers below). All 5 routes respond with realistic shape + `X-Encrypt-Proxy-Mode: stub` header. Browser client round-trips successfully.
- **`/encrypt-demo.html`** — smoke-test UI, hits all three proxy routes end-to-end.
- **Testnet SuiNS registration** (`buildRegisterSplashNsTx` and primary NS paths) — now targets testnet package constants via `getSuinsNetwork()`. Mainnet paths unaffected.
- **Testnet Seal** (`src/client/thunder-stack.ts`) — 2-of-2 threshold using two verified Mysten testnet key servers. Third server dropped when review caught a malformed (65-hex-char) object ID.
- **`src/network-detection.test.ts`** — 33 unit tests covering `getSuinsNetwork` + `getIkaNetwork` against every host shape we care about. Run with `bun test src/network-detection.test.ts`.

## Stubbed today (by design, scaffolded ahead of real integration)

- **Encrypt FHE client** (`src/client/encrypt.ts`, `encrypt-pc-token.ts`, `encrypt-proxy.ts`) — pre-alpha service has no gRPC-Web gateway and CF Workers can't speak HTTP/2. Proxy returns deterministic fake ciphertext IDs. Shape matches what PC-Token / PC-Swap will consume; swap transport when real gateway exists.
- **Cross-chain Prism** (`src/client/cross-chain-prism.ts`) — both sides stubbed. Seal side emits `SEAL_STUB_<hex>` blobs (transparent JSON), Encrypt side inherits its own stub status. `dwalletCapRef` is always `null` with a `TODO(ika)`.
- **PC-Token / PC-Swap program IDs** — reuse `ENCRYPT_PROGRAM_ID` as placeholder since real program IDs not yet published.
- **Default iUSD mint address** (`DEFAULT_IUSD_MINT`) — placeholder until mint ceremony runs on Solana devnet.

## Blocked today (waiting on external input)

| Blocker | What it unblocks | Action needed |
|---|---|---|
| Real Google + Apple OAuth client IDs | **Zoroark → mainnet** (picker currently shows placeholders) | Register clients in Google Cloud Console / Apple Developer Portal, set `ZKLOGIN_CONFIG.googleClientId` + `appleClientId` in `src/zklogin.ts` (or via wrangler secret + build-time replace) |
| Self-hosted ZK prover (mainnet) | Zoroark on mainnet without Enoki paywall | Deploy `mysten/zklogin:prover-stable` Docker image on a 16-core/16GB VM (Fly.io, Railway, bare VPS), wire CF Worker proxy to its `/v1` endpoint |
| dWallet Encrypt Alpha 1 with gRPC-Web gateway | **Eevee → real confidential iUSD** | External: wait for `dwallet-labs/encrypt-pre-alpha` to ship Alpha 1 with a publicly reachable gRPC-Web endpoint OR a grpc-gateway JSON bridge |
| Testnet IKA DKG TableVec object IDs | **Bagon → Salamence** (cross-chain DKG on testnet) | External: IKA testnet network needs `networkDKGOutputTableId` + `reconfigOutputTableId` populated, then hand-add to `IKA_ENC_KEY` alongside the mainnet values |
| Verified third Seal testnet key server | Strict 2-of-3 threshold on testnet Thunder | Look up canonical testnet server list in the Seal registry; add to `SEAL_SERVERS_TESTNET` in `src/client/thunder-stack.ts` |
| Real testnet NS Pyth feed | Testnet NS-pay PTBs (vs USDC-pay) | `@mysten/suins` testnet `coins.NS.feed` is currently the HFT placeholder feed. `requireNsFeed()` hard-blocks until a real testnet feed ships |

## Signal to restart a feature wave

Per voter 3, a new wave is worth the context cost when **any one** of these lands:

1. IKA publishes testnet protocol params + TableVec object IDs
2. Encrypt / PC-Swap real program IDs publicly deployed to Solana devnet
3. A verified third Seal testnet key server is registered
4. A real user (not a reviewer) surfaces a bug in wave 1–3 code

Until one of those happens, additional waves will mostly stub stubs.

## The 12 bugs the 5 reviews caught (for the next reviewer)

1. **Ed25519 secret key round-trip double-encoded** — stored Bech32 via `TextEncoder→base64→TextDecoder`. Worked by accident; fixed to store the Bech32 string directly.
2. **JWT nonce never validated locally** — prover checked it, but we were leaking JWTs to the upstream on every replay attempt. Added `extractJwtNonce` + local check in `completeZkLogin`.
3. **Salt derived from device fingerprint** — a browser update would silently re-map users to new Sui addresses with no recovery. Salt is now `HKDF(ikm=sub, salt=iss|aud, info=ski-zklogin-salt-v1)` — pure JWT-based, portable across devices.
4. **Prover URL leak in `/api/zklogin/health`** — mainnet self-hosted prover URL would have been publicly discoverable, allowing the proxy to be bypassed. Health endpoint now returns `{ok:true}` only.
5. **128-bit salt bound comment wrong** — real zkLogin bound is BN254 field element, not 2^128. Comment corrected.
6. **`extractJwtNonce` base64url padding round 1** — `'==='.slice((len+3)%4)` failed on mod-3 residues.
7. **`extractJwtNonce` padding round 2** — `'===='.slice(b64.length % 4)` added 4 pads for residue-0, breaking every Google JWT with length-multiple-of-4 payload. Final fix: `(4 - (b64.length % 4)) % 4`.
8. **`detectEncryptMode` silent stub degradation** — catch returned `'stub'` on any network error. Added `'unknown'` as third mode; callers gating real on-chain actions now hard-stop on unknown.
9. **Local dev devnet detection missed `localhost` / `127.0.0.1`** — wrangler dev was pointing at mainnet GraphQL while the worker served testnet. Added both to the hostname helpers.
10. **`UserRejectedRequest` cancel hang** — picker cancel returned `{accounts:[]}`, leaving wallet.ts's 5-minute timeout as the only exit path. Now throws so the race fails fast.
11. **NS Pyth feed misdirect on testnet** — `@mysten/suins` testnet `coins.NS.feed` is an HFT placeholder. Added `requireNsFeed()` guard — NS-pay PTBs explicitly mainnet-only.
12. **Malformed Seal testnet server #3** — hand-coded object ID had 65 hex chars, not 64. Dropped to 2-of-2 config until a verified third is added.

## The test that didn't run

No real-browser end-to-end test has exercised any of this code against real OAuth, a real prover, or a real Sui node. All verification to date is: typecheck, build, HTTP curl probe, 5 rounds of static review, and the 33-test hostname detection matrix added in this wrap commit.

The one test that would catch a round-6 bug is: deploy `devnet/nursery` to a staging host that resolves to mainnet, then do one real `.sui` lookup and one real zkLogin round-trip in a Chromium session. That's the next thing to try — AFTER a human has read the 14 commits and blessed the direction.
