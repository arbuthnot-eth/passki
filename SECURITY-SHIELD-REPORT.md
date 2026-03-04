# .SKI Security Shield Report

> **Generated:** 2026-03-04 | **Swarm:** 4 agents (client-security, server-security, onchain-security, waste-hunter)
> **Target:** Codex handoff for next-round implementation

---

## Executive Summary

The SKI codebase has **strong cryptographic foundations** (sound commitment scheme, proper BCS encoding, good salt entropy) but suffers from a **systemic authentication gap** across all Cloudflare Durable Object (DO) callable methods. The Agents SDK `@callable()` decorator exposes methods over WebSocket with zero auth by default — every DO in the project inherits this vulnerability.

The second systemic issue is **over-reliance on localStorage** for security-sensitive state (sessions, sponsor auth, shade order secrets). Any XSS anywhere on `*.sui.ski` cascades into full session takeover.

| Severity | Count | Key Themes |
|----------|-------|-----------|
| **P0** | 3 | No auth on DO callables, shade secrets leaked via state broadcast, full sponsor state exposure |
| **P1** | 6 | XSS via cached SVG, session replay, DeepBook zero-slippage sandwiching, Seal identity mismatch, gas exhaustion, cross-subdomain cookie |
| **P2** | 13 | Open sponsorship drain, unauthenticated WebSockets, permissionless execute(), no order expiry, stale request cleanup |
| **P3** | 10 | Dead code, cache poisoning, race conditions, bundle bloat |
| **Waste** | 27 | Dead exports, duplicated logic, redundant instantiation, localStorage accumulation |

---

## P0 — Critical

### 1. No Authentication on Any DO Callable Method
**Location:** All `@callable()` methods in `shade-executor.ts`, `sponsor.ts`, `session.ts`, `splash.ts`
**Description:** Every `@callable()` method is exposed over WebSocket with zero authentication. Any client who connects to a DO instance by knowing the address-based instance name can invoke any method: `schedule()`, `cancel()`, `enableKeeperMode()`, `deactivate()`, `addEntry()`, `removeEntry()`, `forgetDevice()`, etc.
**Impact:**
- Cancel any user's Shade orders
- Deactivate any sponsor
- Enable keeper mode on any sponsor DO (server key auto-signs for attacker)
- Inject fake gas coins
- Read all Shade order secrets (domains, salts, timing)
**Fix:** Add caller authentication to all mutating callable methods. Options:
1. Require a signed message on WebSocket connect, verify in `onConnect()`
2. Add an `authenticate()` callable that must succeed before other methods work
3. Use Cloudflare Access or a JWT middleware on the Worker routing layer

### 2. Shade Order Secrets Leaked via WebSocket State Broadcast
**Location:** `shade-executor.ts:64-66`, `client/shade.ts:32-34`
**Description:** The `ShadeExecutorState` (containing all orders with `salt`, `domain`, `targetAddress`, `executeAfterMs`) is broadcast to ALL connected WebSocket clients via `onStateUpdate`. The entire Shade privacy model (commitment-reveal) is defeated.
**Impact:** Any WebSocket listener can see which domain is being sniped, the exact timing, the salt needed to front-run `execute()`, and the target address. Attacker can call `shade::execute` themselves.
**Fix:** Never broadcast order secrets via state. Use a sanitized state object (order IDs + status only). Serve full details only via authenticated query with caller verification.

### 3. `getSponsorState()` Leaks Full State Including Auth Credentials
**Location:** `sponsor.ts:375-377`
**Description:** Returns the entire `SponsorState` including `authSignature`, `authMessage`, all `pendingRequests` (with `txBytes`), `approvedList`, `keeperAddress`. Callable by anyone (see P0-1).
**Impact:** Leaks sponsor's authorization signature (replay potential), all pending transaction bytes, and keeper address.
**Fix:** Return a sanitized subset. Never expose `authSignature`, raw `txBytes`, or internal state to unauthenticated callers.

---

## P1 — High

### 4. QR SVG Stored XSS via localStorage Poisoning
**Location:** `ui.ts:639-648` (getQrSvg), `ui.ts:1125` (innerHTML injection)
**Description:** QR SVGs cached in localStorage (`ski:qr:*`) are injected via `innerHTML` without sanitization. Co-subdomain XSS, browser extensions, or shared devices can poison the cache.
**Impact:** Full XSS — steal sessions, wallet connections, localStorage auth.
**Fix:** Never cache raw SVG in localStorage. Regenerate on each render, or sanitize with DOMPurify before innerHTML.

### 5. Cross-Subdomain Session Cookie Without HttpOnly
**Location:** `ski.ts:56-79` (writeSharedSession / readSharedSession)
**Description:** `ski_xdomain` cookie set with `domain=sui.ski; secure; samesite=lax` but no `HttpOnly`. Contains base64 session data including `signature`, `bytes`, `visitorId`, `address`.
**Impact:** Any XSS on `*.sui.ski` reads the cookie and hijacks all sessions for 7 days.
**Fix:** Move cross-domain session to server-side token exchange with HttpOnly cookies. Client reads session via API endpoint, not cookie parsing.

### 6. Session Signature Replay — No Server-Side Nonce Verification
**Location:** `ski.ts:86-106` (buildSignMessage), `ski.ts:141` (authenticate sends `message: ''`)
**Description:** Sign-in message includes `crypto.randomUUID()` nonce, but `authenticate()` sends empty string — server never validates the nonce. Stolen signature+bytes replay indefinitely for 7 days.
**Impact:** Session hijacking via any credential leak vector.
**Fix:** Pass full signed message to `authenticate()`. Store and validate nonces server-side.

### 7. DeepBook Swaps With Zero Minimum Output — Sandwich Attacks
**Location:** `shade-executor.ts:419,461,474` — `tx.pure.u64(0)` as min output
**Description:** All DeepBook swap calls pass 0 as minimum output. MEV bots can sandwich the keeper's predictable transactions (alarm fires at exact grace expiry).
**Impact:** User loses significant deposit to slippage. Attacker profits from front-run + back-run.
**Fix:** Calculate expected output from pool reserves or quote function. Pass `expected * 0.95` as minimum. Consider using a private mempool or delayed submission.

### 8. Seal Identity Mismatch — Encrypted Payload Uses Commitment, Not Order ID
**Location:** `suins.ts:1031`
**Description:** `sealEncrypt()` uses the commitment hash as identity, but the Move contract's `seal_approve` verifies that the requested `id` has the order's `object::id` as namespace prefix. These don't match — Seal decryption via on-chain policy will fail.
**Impact:** Seal encryption is effectively dead code. Order recovery depends entirely on localStorage. If localStorage is cleared, order details are irrecoverable and funds may be permanently locked.
**Fix:** Options: (1) Two-step flow — create order, get object ID, then encrypt with correct identity; (2) Add `set_sealed_payload` to Move contract; (3) Accept localStorage dependency and document clearly.

### 9. Keeper Gas Exhaustion via Malicious Orders
**Location:** `shade-executor.ts:260-332`, combined with P0-1 (no auth)
**Description:** Keeper pays gas for every execution attempt. With no auth on `schedule()`, attacker creates thousands of fake orders. Each retries 3x at ~0.01 SUI = ~30 SUI per 1000 orders.
**Impact:** Keeper gas fund depletion blocks all legitimate Shade executions.
**Fix:** Validate orders on-chain before scheduling (verify ShadeOrder object exists). Add per-instance order caps. Rate-limit the schedule endpoint.

---

## P2 — Medium

### 10. Open Sponsorship Allows Unlimited Gas Draining
**Location:** `sponsor.ts:199-206` (isSponsoredAddress)
**Description:** Empty `sponsoredList` = ANY address is sponsored. No rate limiting.
**Impact:** Sponsor SUI balance drained by anyone who discovers the sponsor address.
**Fix:** Server-side per-sender daily caps in SponsorAgent DO.

### 11. Permissionless `execute()` — Preimage Leakage Enables Front-Running
**Location:** `contracts/shade/sources/shade.move:93`
**Description:** Anyone with the preimage (domain, salt, timing, target) can call `execute()` and receive the escrowed SUI to compose their own registration PTB — potentially targeting a different address.
**Fix:** Add optional `authorized_executor: Option<address>` field. If set, only that address can call `execute()`.

### 12. No Expiry/Timeout on ShadeOrder — Permanent Fund Lockup
**Location:** `contracts/shade/sources/shade.move:46-57`
**Description:** ShadeOrder has no expiration. If keeper fails and user loses localStorage, escrowed SUI is locked permanently on-chain.
**Fix:** Add `created_at` + `expire_after_ms`. Add `reclaim()` function for post-expiry refund.

### 13. Silent Seal Encryption Failure — No Backup Recovery
**Location:** `suins.ts:1030-1036`
**Description:** If Seal key servers are unreachable, failure is silently caught and empty `Uint8Array(0)` stored. No redundant recovery path.
**Fix:** Alert user that Seal encryption failed. Let them decide whether to proceed.

### 14. Stale Pending Requests Never Cleaned (Sponsor)
**Location:** `sponsor.ts:286-305`
**Description:** Requests in `awaiting_sigs`/`user_signed`/`sponsor_signed` are never timed out. 20 abandoned requests permanently fill the queue.
**Fix:** Add TTL (5 minutes). Prune expired requests on each `requestSponsorship()`.

### 15. Cross-User Order Scheduling
**Location:** `shade-executor.ts:131-173`
**Description:** `schedule()` accepts `ownerAddress` parameter without verifying it matches the DO instance name.
**Fix:** Validate `params.ownerAddress === this.name` (DO instance key).

### 16. Unbounded Order Accumulation on Shade Executor
**Location:** `shade-executor.ts:131-173`
**Description:** No `MAX_ORDERS` cap (unlike sponsor's `MAX_PENDING = 20`).
**Fix:** Add `MAX_ORDERS = 50`.

### 17. No Rate Limiting on HTTP API Endpoints
**Location:** `server/index.ts:18-71`
**Description:** `/api/shade/poke/:address`, `/api/shade/status/:address`, `/api/shade/schedule/:address` — no rate limiting, no auth.
**Fix:** Rate limiting middleware + auth for mutating endpoints.

### 18. Hardcoded ISV Values Fragile to Protocol Upgrades
**Location:** `shade-executor.ts:33-37,40-41`
**Description:** DeepBook pool ISVs and Pyth price info ISV are hardcoded. Protocol upgrades that recreate objects break all execution silently.
**Fix:** Fetch ISV dynamically or add health check that verifies objects exist.

### 19. Multiple Orders for Same Domain — Failed Orders Lock Funds
**Location:** `shade-executor.ts:227-237`
**Description:** If multiple users shade the same domain, only the first succeeds. Others exhaust retries and mark `failed` — but deposits remain locked on-chain.
**Fix:** After MAX_RETRIES, notify user that manual cancellation is needed. Consider adding auto-cancel capability.

### 20. Sponsor Auth Stored in Plaintext localStorage
**Location:** `sponsor.ts:77-113`
**Description:** Full `SponsorAuth` (including `authSig`, `authBytes`, `authMessage`) in plaintext localStorage. Any XSS reads and replays.
**Fix:** Encrypt with device-fingerprint-derived key, or move to server-side session.

### 21. `enableKeeperMode()` Callable by Any WebSocket Client
**Location:** `sponsor.ts:141-163`
**Description:** Any connected client can enable keeper mode, causing the server key to auto-sign for that sponsor instance.
**Fix:** Restrict to verified sponsor owner only (check auth signature).

### 22. `submitUserSignature` / `submitSponsorSignature` Not Caller-Verified
**Location:** `sponsor.ts:316-356`
**Description:** Any client can submit signatures for any pending request.
**Fix:** Verify caller identity matches expected signer.

---

## P3 — Low / Informational

### 23. Error Messages May Leak Internal Details
**Location:** `shade-executor.ts:119-124`, `server/index.ts:29,69`
**Fix:** Sanitize errors before returning to clients.

### 24. localStorage Poisoning of SuiNS Cache
**Location:** `ui.ts:1136-1137`
**Fix:** Validate resolved names before caching.

### 25. Sponsor Auto-Sign Loop — No Transaction Validation
**Location:** `client/sponsor.ts:350-366`
**Fix:** Validate tx contents before auto-signing (check Move call targets, gas budget).

### 26. Race Condition in Wallet State Updates
**Location:** `wallet.ts:53-56`
**Fix:** Use state machine or mutex for wallet state transitions.

### 27. Session Agent WebSocket Instance Name is Guessable
**Location:** `fingerprint.ts:31-33`, `client/session.ts:11-31`
**Fix:** Add connection-level auth token.

### 28. `SplashDeviceAgent.activate()` — No Auth
**Location:** `splash.ts:19-27`
**Fix:** Add signature verification.

### 29. No Upper Bound on Shade Deposit Amount
**Location:** `contracts/shade/sources/shade.move:72`
**Fix:** Add reasonable upper bound or client-side confirmation.

### 30. NS Dust Burned to 0x0 — Wasteful
**Location:** `shade-executor.ts:423,426`
**Fix:** Return NS remainder to user instead of burning.

### 31. Commitment Scheme Sound — No Issues Found
**Location:** `contracts/shade/sources/shade.move:106-110`, `suins.ts:932-956`
**Note:** keccak256 with proper domain separation, 256-bit random salt. No vulnerability.

### 32. Keeper Private Key in Worker Env — Standard Tradeoff
**Location:** `shade-executor.ts:69,250,263`
**Fix:** Keep balance minimal, implement key rotation, monitor for unexpected txs.

---

## Waste & Optimization Opportunities

### Dead Code (delete immediately)

| Item | Location | Lines Saved |
|------|----------|-------------|
| `signTransactionOnly()` | `wallet.ts:297-318` | ~22 |
| `dryRunTransaction()` | `shade-executor.ts:527-549` | ~23 |
| `getSession()` | `client/session.ts:50-53` | ~4 |
| `getSessionClient()` | `client/session.ts:74` | ~3 |
| `getShadeExecutorClient()` | `client/shade.ts:98` | ~3 |
| `ASSETS` object | `ui.ts:59-61` | ~3 |
| `ski:splash-sponsor` write | `ski.ts:407` | ~1 |

### Duplicate Logic (extract helpers)

| Duplication | Locations | Suggestion |
|-------------|-----------|------------|
| Backpack `UserKeyring` retry | `wallet.ts:260,351,418` (~90 lines) | Extract `withBackpackRetry(fn)` |
| `Uint8Array` base64 augmentation | `wallet.ts:384-391,444-452` | Extract `augmentBytes(tx)` |
| `truncAddr` | `ui.ts:165`, `sponsor.ts:396` | Shared utility, unify format |
| GraphQL/gRPC URL strings | 6+ files | Extract to `src/constants.ts` |
| `SuiGraphQLClient` + `SuinsClient` instantiation | ~15 functions in `suins.ts` | Module-level singletons (like `sponsor.ts` does) |
| Gas coin fetching via GraphQL | `sponsor.ts:534-567`, `server/agents/sponsor.ts:175-200` | Share query/parsing |
| `GRAPHQL_URL` / `GQL_URL` same value | `suins.ts:17,20` | Consolidate to one constant |

### Production Hygiene

| Issue | Location | Action |
|-------|----------|--------|
| Client-side `console.log` (session debug) | `ski.ts:172,222,417` | Remove — leaks session info to browser console |
| `startAutoSigning` polls every 5s despite WebSocket | `client/sponsor.ts:357-366` | Replace with WebSocket `onStateUpdate` |
| `pollForReady` 600ms loop | `client/sponsor.ts:370-383` | Replace with promise resolving on state update |
| `@mysten/deepbook-v3` dependency | `package.json` | Remove if no actual imports exist |
| Inline SVG strings (~5KB social icons) | `ui.ts:69-78` | Move to external .svg files |

### localStorage Accumulation (no cleanup)

These keys accumulate forever per-address with no expiry or cleanup sweep:
- `ski:signed:{address}` — "has signed" flags
- `ski:suins:{address}` — cached SuiNS names (stale if changed)
- `ski:balances:{address}` — balance cache
- `ski:wallet-keys:{walletName}` — persisted account addresses
- `ski:waap-provider:{address}` — social provider
- `ski:wallet-icon:{walletName}` — icon data URIs (can be large)
- `ski:qr:*` — cached QR SVGs (also XSS vector, see P1-4)

**Fix:** Add cleanup sweep on disconnect that removes keys for addresses no longer active.

---

## Kumo UI / DO Architecture Recommendations

### 1. Authentication Layer for Agents SDK
The `@callable()` decorator in the Cloudflare Agents SDK provides no built-in auth. Every DO needs a custom auth layer.

**Recommended pattern:**
```typescript
// Base class for all authenticated DOs
abstract class AuthenticatedAgent<State, Env> extends Agent<State, Env> {
  private authenticatedAddresses = new Set<string>();

  @callable()
  async authenticate(params: { address: string; signature: string; message: string }) {
    // Verify Sui personal message signature
    const valid = await verifyPersonalMessageSignature(params);
    if (valid) this.authenticatedAddresses.add(params.address);
    return { success: valid };
  }

  protected requireAuth(address: string) {
    if (!this.authenticatedAddresses.has(address))
      throw new Error('Unauthorized');
  }
}
```

### 2. State Broadcast Filtering
DO state broadcast should be filtered per-connection. The Agents SDK broadcasts full state to all clients. For sensitive state:

```typescript
// Override setState to broadcast sanitized state
setState(state: FullState) {
  super.setState(state);
  // Broadcast sanitized version (strip secrets)
  this.broadcastToClients(this.sanitizeState(state));
}
```

### 3. Replace Polling with WebSocket State Push
Three polling patterns should be converted to WebSocket-driven:
- `startAutoSigning()` — 5s interval polling `getSponsorState`
- `pollForReady()` — 600ms polling for sponsor signature
- Shade countdown timer — already partially converted (this session)

### 4. DO Alarm Best Practices
- Always validate order status in `alarm()` handler (already done correctly)
- Add alarm deduplication for concurrent orders
- Consider using `waitUntil()` for non-critical post-alarm work (e.g., cleanup)

---

## Innovation Roadmap — Next Rounds

### Round 1: Security Hardening (Codex Priority)
1. **Add auth layer to all DOs** (P0 — blocks everything else)
2. **Sanitize state broadcasts** — never broadcast secrets (P0)
3. **Add slippage protection to DeepBook swaps** (P1)
4. **Fix or remove Seal encryption** — currently dead code (P1)
5. **Add order expiry to Move contract** with `reclaim()` function (P2)
6. **Server-side session token exchange** — eliminate JS-readable cookies (P1)
7. **Rate limiting on all HTTP API endpoints** (P2)

### Round 2: Waste Cleanup
1. Delete all dead code (6 exports, ~56 lines)
2. Extract `withBackpackRetry()` and `augmentBytes()` helpers
3. Create `src/constants.ts` for shared URLs
4. Module-level transport singletons in `suins.ts`
5. localStorage cleanup sweep on disconnect
6. Remove client-side `console.log` statements

### Round 3: Architecture Evolution
1. **Replace all polling with WebSocket state push** — sponsor auto-sign, pollForReady, countdown
2. **Add `authorized_executor` to Shade Move contract** — prevent front-running
3. **Implement key rotation** for keeper keypair
4. **Add per-sender rate limits** in SponsorAgent DO
5. **Move sponsor auth to encrypted storage** or server-side session
6. **Add health monitoring** for hardcoded ISV values and DeepBook pools

### Round 4: Resilience
1. **Add auto-cancel after MAX_RETRIES** for failed Shade orders
2. **Secondary recovery path** for Shade orders (beyond localStorage)
3. **Transaction validation in auto-sign loop** — whitelist allowed Move calls
4. **Alarm deduplication** for concurrent Shade orders on same domain
5. **Keeper balance monitoring + alerting** — prevent gas exhaustion

---

*Report compiled from 4 parallel security shield agents analyzing 15 source files, 1 Move contract, and all client/server interaction patterns.*
