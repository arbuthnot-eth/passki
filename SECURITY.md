# .SKI Security Posture

> **Last audit:** 2026-04-06 | **Branch:** `security/hardening-q2-2026`

## What this branch fixes

| # | Fix | Issue | Severity |
|---|-----|-------|----------|
| 1 | CSP + security response headers on all Worker routes | #53 | P1 |
| 2 | Auth guards on SessionAgent mutating callables + sanitized state broadcast | #56 | P0 |
| 3 | Auth guards on SponsorAgent mutating callables + sanitized state broadcast | #56 | P0 |
| 4 | Auth guards on **all 13 TreasuryAgents** mutating callables (`requireUltronCaller`) | #56 | P0 |
| 5 | Internal auth token (`x-treasury-auth`) on all Worker→DO HTTP requests | #56 | P0 |
| 6 | ShadeExecutorAgent: owner validation on `schedule()`, salt stripped from state | #56 | P0 |
| 7 | Shell restore XSS sanitization in index.html | #55 | P1 |
| 8 | Session nonce validation — server checks message expiry | #57 | P1 |
| 9 | Pass real signed message to `authenticate()` (was empty string) | #57 | P1 |
| 10 | localStorage cleanup on disconnect (session tokens, IKA addrs, balances) | #54 | P2 |
| 11 | Per-IP rate limiting on all `/api/*` routes (60/min read, 20/min write) | #58 | P2 |
| 12 | Admin route auth gate — ultron-only routes require `x-treasury-auth` | #58 | P2 |

## Remaining open items

| Issue | Title | Severity | Notes |
|-------|-------|----------|-------|
| #53 | Nonce-based CSP (replace `unsafe-inline`) | P1 | Requires Worker to serve index.html (currently static assets) |
| #54 | localStorage TTL expiry + encrypted sponsor auth | P2 | Encrypt `ski:gas-sponsor` like waap-proof |
| #55 | QR SVG innerHTML + showToast footgun | P1 | Sanitize SVGs, remove `isHtml` param |
| #57 | HttpOnly cookie via server `Set-Cookie` | P1 | Requires new Worker endpoint |
| #58 | DeepBook slippage protection | P2 | Pass `expected * 0.95` as min output |

## Architecture

### DO authentication (complete)
- **SessionAgent**: `authenticate()` verifies signature + `.SKI` format + expiry. `getSession()` strips signature/message. `forgetDevice`, `updateSuinsName`, `updateIkaWalletId` require `walletAddress` match.
- **SponsorAgent**: `register()` verifies signature + `.SKI Splash`. All mutating methods require `callerAddress === sponsorAddress`. `getSponsorState()` strips `authSignature`, `authMessage`, redacts `txBytes`.
- **TreasuryAgents**: `requireUltronCaller()` on all 13 mutating callables. `verifyInternalAuth()` on all HTTP requests (checks `x-treasury-auth` header). Read-only params exempt.
- **ShadeExecutorAgent**: `schedule()` validates `ownerAddress === this.name`. `getOrders()`/`getStatus()` strip `salt` (commitment-reveal secret).
- **SplashDeviceAgent**: Low-risk (boolean state only). No auth change needed.

### Worker security layers
1. **Security headers** — CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy on all responses
2. **Rate limiting** — per-IP sliding window, 60/min GET, 20/min POST
3. **Admin route gate** — `/api/cache/*`, `/api/iusd/attest`, `/api/iusd/mint`, pool/lending/migration routes require `x-treasury-auth`
4. **Internal DO auth** — `authedTreasuryStub()` injects `x-treasury-auth` on all 35 Worker→TreasuryAgents fetch calls

### Client-side storage
- `ski:session:{address}` — cleared on disconnect
- `ski:waap-proof` — AES-256-GCM encrypted, device-fingerprint-bound
- `ski:gas-sponsor` — plaintext (TODO: encrypt like waap-proof)
- `ski:shell` — sanitized on restore (strips script tags, event handlers, javascript: URIs)
