# Helius Webhook for SOL Deposit Detection

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Replace polling-based SOL deposit detection with Helius webhook push

## Problem

`_watchSolDeposits()` runs every alarm tick, polling Solana RPCs for transactions to ultron's address. This wastes resources — deposits happen rarely but polling runs constantly. Latency depends on alarm interval rather than actual Solana confirmation time.

## Design

### Architecture

```
Solana tx confirmed
  → Helius detects SOL transfer to ultron's address
  → POST https://sui.ski/api/sol-webhook (with auth header)
  → Hono worker validates HELIUS_WEBHOOK_SECRET
  → Forwards payload to TreasuryAgents DO
  → DO matches sub-cent tag to pending intent
  → BAM attest + Quest fill (existing logic)
```

### Components

#### 1. Worker route: `POST /api/sol-webhook`

Location: `src/server/index.ts`

- Validates `Authorization` header against `env.HELIUS_WEBHOOK_SECRET`
- Rejects unauthorized requests with 401
- Forwards the raw Helius payload body to `TreasuryAgents` DO via `treasuryStub.fetch('/sol-webhook', ...)`
- Returns 200 immediately after forwarding (Helius expects fast response, retries on non-2xx)

#### 2. DO handler: `TreasuryAgents.onRequest('/sol-webhook')`

Location: `src/server/agents/treasury-agents.ts`

- Parses Helius enhanced transaction payload (array of transactions)
- For each transaction, extracts native SOL transfers where destination = ultron's Solana address
- Runs existing tag-matching logic:
  - Extract 6-digit tag from `lamports % 1000000`
  - Match against pending `deposit_intents` by tag
  - Match against pending `kamino_intents` by tag
- On match: BAM attest + Quest fill (unchanged from current `_watchSolDeposits`)
- Updates `last_sol_sig` in state to track processed signatures
- Returns 200

#### 3. Remove polling from `_tick()`

- Remove `await this._watchSolDeposits()` from the tick loop
- Keep `_watchSolDeposits()` as a private method (unchanged)
- Expose it via a new manual endpoint: `POST /api/cache/rescan-deposits`
  - Worker route forwards to DO
  - DO calls `this._watchSolDeposits()` and returns results
  - For edge-case recovery if webhook misses something

#### 4. Helius webhook configuration

- **Type:** Enhanced (parsed transaction data, human-readable)
- **Transaction type:** Any (filter in our handler by destination address)
- **Account address:** ultron's Solana address (derived from `SHADE_KEEPER_PRIVATE_KEY`)
- **Webhook URL:** `https://sui.ski/api/sol-webhook`
- **Auth header:** `Authorization: Bearer <HELIUS_WEBHOOK_SECRET>`
- **Retries:** Helius built-in, up to 24h on failure

#### 5. New secrets

- `HELIUS_WEBHOOK_SECRET` — Wrangler secret, used to validate incoming webhook requests
- Added to `Env` interface in both `index.ts` and `treasury-agents.ts`

### Helius Enhanced Transaction Payload

Helius sends an array of enhanced transactions. Relevant fields:

```typescript
interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  type: string; // "TRANSFER", "SWAP", etc.
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number; // lamports
  }>;
  // ... other fields we don't need
}
```

We filter `nativeTransfers` where `toUserAccount === ultronSolAddress`.

### What stays the same

- `deposit-intent` endpoint — creates intents with sub-cent tags
- `deposit-status` endpoint — polls intent status
- Sub-cent tag derivation: `SHA-256(suiAddress) % 1000000`
- BAM attest + Quest fill logic
- Kamino intent matching
- `_watchSolDeposits()` method body (reused by manual rescan)

### What changes

- `_tick()` no longer calls `_watchSolDeposits()`
- New `POST /api/sol-webhook` worker route with auth validation
- New `POST /sol-webhook` DO handler parsing Helius enhanced payloads
- New `POST /api/cache/rescan-deposits` manual recovery endpoint
- `Env` interfaces gain `HELIUS_WEBHOOK_SECRET?: string`

### Security

- Webhook auth via shared secret in `Authorization` header
- Sub-cent tag is an intent identifier, not an auth mechanism
- Intent must exist in DO state (created via `deposit-intent`) before a deposit can match
- Intents are one-shot: status changes to `matched` after first match, preventing replay
- Tag collision risk: 1 in 1M (6-digit space). Requires simultaneous pending intents. Acceptable at current volume.

### Setup steps (manual, post-deploy)

1. `npx wrangler secret put HELIUS_WEBHOOK_SECRET` — set a random secret
2. In Helius dashboard → Webhooks → Create:
   - URL: `https://sui.ski/api/sol-webhook`
   - Auth header: `Authorization: Bearer <same secret>`
   - Type: Enhanced
   - Account: ultron's Solana address
   - Network: Mainnet
