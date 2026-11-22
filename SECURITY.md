# Security Policy

passki is **unaudited mainnet beta** software. It moves real funds, so reports are very welcome.

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/arbuthnot-eth/passki/security/advisories/new). Please don't open a public issue or PR for anything exploitable. Machine-readable contact details are at [`/.well-known/security.txt`](https://passki.xyz/.well-known/security.txt).

Please include:

- the affected route, agent, or file;
- steps to reproduce, or a proof of concept;
- the impact as you understand it (funds at risk, data exposed, and so on).

What to expect:

| Step | Target |
|---|---|
| Acknowledgement | within 3 days |
| Initial assessment | within 7 days |
| Fix for critical issues (funds at risk) | as fast as possible, usually within 72 hours of confirmation |
| Public advisory | after the fix is deployed, crediting you unless you prefer otherwise |

## Scope

In scope: the passki.xyz Worker (`src/server`), the browser app (`src/`), the Move contracts in `contracts/`, and the `passki` and `suiami` npm packages.

Out of scope: third-party services passki builds on (WaaP, IKA, Seal, Walrus, SuiNS, Sui itself). Please report those upstream. Volumetric DoS and findings that need a compromised device or wallet are also out of scope.

## Safe harbor

Good-faith research that follows this policy is welcome, and we won't pursue it. Please don't access other users' data or funds, degrade the service for others, or move mainnet funds beyond what's needed to demonstrate an issue. Use your own accounts and the smallest possible amounts.

## How passki is secured

The [Security model](README.md#security-model) section of the README is the current, maintained description. It covers user-key custody (WaaP plus IKA 2PC-MPC), the service keys the Worker still holds, gas-sponsorship protections, embedding, and the supply-chain controls in CI.

## Fixed issues

| Date | Issue | Severity | Fix |
|---|---|---|---|
| 2026-11-22 | Treasury "intents" (`/api/cache/send-iusd-v2`, `/api/cache/bam-mint-v2`) checked the signature against a public key the caller supplied, so any freshly generated keypair could send ultron's iUSD anywhere or mint unlimited iUSD-SPL on Solana | Critical | The signer must be ultron's own key or an operator key listed in `VECTOR_INTENT_SIGNERS` |
| 2026-11-22 | `/api/cache/force-dispatch-sol` (public) credited a pending deposit intent with a caller-supplied `lamports` amount, so anyone could open an intent and mint iUSD against SOL they never sent | Critical | Admin-only |
| 2026-11-22 | Worker routes forwarded client JSON to treasury methods that authorize on `body.callerAddress`; adding ultron's public address made the caller ultron (e.g. `/api/cache/pre-rumble` had ultron sign roster identities for any name) | High | The treasury drops `callerAddress` from request bodies unless the Worker vouches with `x-ski-as-ultron` (the internal token) |
| 2026-11-22 | Admin token (`x-treasury-auth`) was the first 34 characters of ultron's **public** Sui address, so anyone could call admin routes | Critical | Token is now an HMAC of a server secret, compared in constant time (`internalAuthToken`) |
| 2026-11-22 | Treasury routes such as `/api/cache/migrate`, `/api/cache/send-iusd` and `/api/cache/ultron-transfer-iusd` had no route-level auth. The Worker attached the internal token itself, so the DO's check didn't help | Critical | Default-deny: every non-GET `/api/cache/*` route is admin-only unless explicitly allowlisted |
| 2026-11-22 | `/api/iusd/swap` paid out SUI/USDC before receiving iUSD, for any caller and amount; `/api/ignite` trusted a client-claimed burn amount | Critical | Both admin-only until they verify the user's payment on-chain first |
| 2026-11-22 | Server-only Durable Objects (TreasuryAgents and others) were reachable over public WebSockets at `/agents/*`, and `requireUltronCaller` accepted ultron's public address as proof of identity | Critical | Only browser-facing agents are routable; `requireUltronCaller` also refuses calls arriving over a client connection |
| 2026-11-22 | `/api/sponsor-gas` signed arbitrary transactions as the gas owner | Critical | Transaction policy, fuzz-tested, plus strict per-address and global daily budgets |
| 2026-11-22 | Any WebSocket client could overwrite a public agent's entire state (the agents SDK accepts client `cf_agent_state` writes by default), e.g. switching a SponsorAgent into ultron-paid mode or wiping someone's shade orders | Critical | Public agents reject every non-server state change (`rejectClientStateWrites`) |
| 2026-11-22 | `SponsorAgent` mutations trusted a caller-supplied address, and the sponsor's auth signature was broadcast in agent state (replayable) | High | Sponsor rights are bound to the WebSocket that verified the signature; the signature is no longer stored; user/sponsor signatures and submitted digests are verified cryptographically |
| 2026-11-22 | Pending shade orders (domain + commitment salt) were readable by anyone: the agent is named by the owner's public address and broadcast its state to every connection, and `/api/shade/status/:address` returned it over HTTP. Anyone could also cancel (`objectId: "all"`), reset or reap another user's orders | High | State is sent only to connections that authenticate with the owner's signed `.SKI` sign-in proof (no extra wallet prompt); HTTP reads and mutations need that proof or the internal token; SessionAgent no longer keeps the signature in broadcast state |
| 2026-11-22 | Anyone could schedule bogus shade orders, making the keeper (ultron) spend gas on executions doomed to fail; caller-supplied fields (`isStable`, deposit) were trusted | Medium | Scheduling verifies the order on-chain first: right type, shared, still funded, and the commitment equals keccak256 of the revealed parameters (the same check `shade::execute` makes). Deposit comes from the chain; at most 50 tracked orders per executor |
| 2026-11-22 | Rate limiters were configured with the old `unsafe` binding syntax, and the `/api/*` limiter counted per Worker instance, so neither limited much | Medium | Moved to first-class `ratelimits` bindings; dedicated limits for RPC and sponsorship |
| 2026-11-22 | App pages could be framed by any site (clickjacking) | Medium | `frame-ancestors` on every page; only the read-only `/embed` widget is frameable |
| 2026-04-06 | Missing auth on several Durable Object callables, CSP on Worker routes, session nonce validation, admin route gate (#53–#58) | High | See those issues |

## Known open issues

- **No full CSP on static pages yet.** Only `frame-ancestors` is enforced there. A nonce-based CSP needs the Worker to serve `index.html` (#53).
- **Shell-cache restore in `index.html` uses a regex HTML sanitizer.** It should use a DOM-based sanitizer or stop caching HTML (#55).
- **`ULTRON_PRIVATE_KEY` is still a raw key** on the Worker. The plan is IKA dWallet signing (see README).
