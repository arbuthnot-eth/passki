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
- **NEVER use JSON-RPC** (sui_getObject, suix_getCoins, etc.) in new code — sunsets April 2026
- Use `SuiGrpcClient` (gRPC) or `SuiGraphQLClient` (GraphQL) only
- Exception: CF Workers/DOs can't use gRPC (no HTTP/2) — use GraphQL there
- `raceJsonRpc` in treasury-agents.ts is legacy — migrate to GraphQL
- Exception: `sui_executeTransactionBlock` for tx submission (GraphQL is read-only)

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
