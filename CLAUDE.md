# CLAUDE.md — .SKI Project Instructions

## First Commandment: IKA-Native, Keyless Agents
- **Every wallet, agent, and cross-chain address MUST be IKA-native**
- **No private keys on Cloudflare Workers — ever.** Agents sign via IKA dWallet user shares + DWalletCap wrapper
- Cross-chain addresses (BTC, ETH, SOL) come from IKA dWallet DKG — always
- No raw keypair re-encoding as cross-chain addresses (e.g. Sui Ed25519 pubkey as Solana base58)
- brando.sui runs DKG in browser, re-encrypts user share to agent. Either brando OR agent + IKA network = valid signature
- Batch DKG provisioning for agents = "Rumble your squids"
- If a dWallet doesn't exist yet, the feature is blocked until DKG is run — no shortcuts

## Bug Reporting Protocol
When a bug is reported, don't start by trying to fix it. Instead:
1. Write a test that reproduces the bug
2. Have subagents try to fix the bug and prove it with a passing test

## Transport
- **Prefer gRPC/GraphQL in new code.** `SuiGrpcClient` (gRPC, HTTP/2 required) or `SuiGraphQLClient` (GraphQL).
- **JSON-RPC is fine in existing races.** `raceJsonRpc` (treasury-agents), `FULLNODE_URL` list (shade-executor), JSON-RPC fallback in `client/ika.ts` — all resilience, all stay. Don't rip them out. The April 2026 sunset affects Mysten's endpoint; PublicNode/BlockVision/Ankr will continue to serve JSON-RPC-compatible APIs from their own backing nodes.
- **Update 2026-04-13:** `SuiGraphQLClient.core.executeTransaction` works for tx submission — the "GraphQL is read-only" note is stale. New code doesn't need JSON-RPC for `executeTransactionBlock`.
- CF Workers/DOs can't use gRPC (no HTTP/2 bidi streaming) — use GraphQL there. Browser can use either.

## Terminology
- "cache" not "treasury/reserve/dao" for fund storage
- "stables" not "stablecoins"
- "Sibyl" never "Sybil"
- "encrypt/decrypt" verb forms, not "encrypted/encryption"
- chain@name not name@chain: sol@ultron, eth@brando
- "Rumble" = IKA DKG ceremony only, not multi-token swap routing
- "Storm" = conversation (not channel/group)
- "Thunder" = message/signal
- "SKI Pass" = access/membership proof
- "Purge" = delete-on-read (not decrypt)
- "Quest" = the act of reading/opening
- "Whelm" = relocate ENS ownership + dust ETH into an IKA dWallet (see `whelm()` in `src/ski.ts`). First use: whelm.eth. Engulf, submerge — the Phantom seed goes dormant, the dWallet takes over.

## DeepBook v3 — BalanceManager Black Hole
- **NEVER create an owned BalanceManager.** Owned BMs become deposit black holes — funds go in, can't come out.
- BMs MUST be shared objects. Deposit AND place orders in the SAME transaction.
- If an owned BM already exists with funds: `withdraw_all` first (Step 0).
- Never leave a deposit in a BM without immediately using it in the same PTB.
- `swap_exact_quantity` abort code 12 = insufficient pool liquidity, NOT a BM issue.

## Build & Deploy
```bash
bun run build && npx wrangler deploy
```
ALWAYS deploy after building. Never skip deploy. Never use `bun run deploy`.

## Stack
- `@mysten/sui` v2.13.0, `@mysten/suins` ^1.0.2
- Build: `bun build src/ski.ts --outdir public/dist --target browser`
- Cloudflare Workers + Durable Objects for server
- Two workers: `dotski` (agents/treasury) and `sui-ski` (subnames/auth)
