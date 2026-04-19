# Aggron Earthquake — SUIAMI upgrade publish plan

**Date:** 2026-04-18
**Arc:** Aggron (cache hardening → intent routing)
**Publisher:** plankton.sui (owns SUIAMI UpgradeCap `0x0d6439f1...`)
**Blocks:** ultron-as-router sub-cent intent routing

## Summary

Aggron Earthquake adds the on-chain mirror of the server-side
IntentRegistry: an `IntentRegistryAnchor` in `suiami::roster` that lets
a recipient explicitly authorize a "router" (e.g. ultron) to
Seal-decrypt their private chain records. Replaces the implicit
server-trust Seal gate with provable on-chain consent — ultron can only
decrypt a recipient's blob when that recipient has signed an
`authorize_router` transaction, and the authorization is revocable.

New Move surface:

- `roster::authorize_router(roster, recipient_name_hash, router_sui_address, clock, ctx)`
- `roster::revoke_router(roster, recipient_name_hash, router_sui_address, clock, ctx)`
- `roster::has_active_router(roster, recipient_name_hash, router_sui_address) → bool`
- `roster::router_authorization_authorized_at_ms(...) → u64`
- `roster::router_authorization_revoked_at_ms(...) → u64`
- `seal_roster::seal_approve_intent_router(id, roster, ctx)` — new Seal policy

Storage: dynamic fields on the shared `Roster` keyed by
`RouterAuthKey { recipient_name_hash: vector<u8>, router: address }`.
No new shared object.

## Pre-publish checklist

1. From repo root: `bun run check:move` (Porygon Iron Tail) — sanity-
   check no stale package pointers. Clean output required.
2. `cd contracts/suiami && sui move build` — must succeed with no
   errors (warnings about unused mut refs are pre-existing).
3. `sui move test` — all 67+ tests must pass, including the 9 new
   `router_auth_tests::*`:
   - `test_authorize_router_by_recipient_only_ok`
   - `test_authorize_router_by_non_recipient_aborts`
   - `test_revoke_router_sets_revoked_at_ms`
   - `test_revoke_router_with_no_authorization_aborts`
   - `test_seal_approve_intent_router_requires_active_authorization`
   - `test_seal_approve_intent_router_permits_authorized_router`
   - `test_seal_approve_intent_router_rejects_revoked_router`
   - `test_authorize_then_revoke_then_reauthorize`
   - `test_authorizations_are_scoped_per_recipient_and_router`

## Publish steps (plankton.sui)

```bash
# 1. Switch to plankton (holds the SUIAMI UpgradeCap)
sui client switch --address plankton.sui

# 2. Confirm UpgradeCap id (project_suiami_upgrade_cap.md)
#    Expected: 0x0d6439f1... owned by plankton.sui

# 3. Dry-run first
cd contracts/suiami
sui move build
sui client upgrade \
  --upgrade-capability 0x0d6439f1... \
  --gas-budget 500000000 \
  --dry-run

# 4. Publish upgrade
sui client upgrade \
  --upgrade-capability 0x0d6439f1... \
  --gas-budget 500000000

# 5. Record the new published-at from the upgrade output.
```

## Post-publish wiring

1. Update `src/client/suiami-seal.ts`:
   - Bump `SUIAMI_PKG_LATEST` to the new published-at.
   - Flip `AGGRON_EARTHQUAKE_PUBLISHED = true` so
     `buildAuthorizeRouterTx` / `buildRevokeRouterTx` unlock.
2. Update `contracts/suiami/Move.toml` `published-at` to match (so
   subsequent upgrades compose cleanly).
3. Commit the pkg id bump with message:
   `Aggron Earthquake — IntentRegistryAnchor live on mainnet`.
4. `bun run build && npx wrangler deploy` — two workers (`dotski`,
   `sui-ski`). ALWAYS deploy after building.

## Post-publish smoke test

From the browser console on skiski.io (connected as any recipient with
an existing SUIAMI record):

```js
// 1. Authorize ultron as a router for your own record.
await authorizeRouter('ultron');
//   → { ok: true, digest: '...', router: '0x9872c1f5...', recipientName: '...' }

// 2. Confirm on-chain state via gRPC read.
// (Add a roster.ts read helper for has_active_router if needed;
//  grep for lookupByAddress patterns.)

// 3. Ultron (server-side) can now Seal-decrypt that recipient's blob
//    by submitting a PTB calling seal_approve_intent_router with:
//    - arg0: 40-byte seal id (name_hash ‖ 8-byte version suffix)
//    - arg1: Roster shared object
//    - sender: ultron (0x9872c1f5edf4daffbdcf5f577567ce997a00db9d63a8a8fac4feb8b135b285f7)

// 4. Revoke to verify flipside.
await revokeRouter('ultron');
//   → { ok: true, digest: '...' }
//   → seal_approve_intent_router now aborts for ultron with ENotAuthorizedRouter.
```

## Rollback plan

Move upgrades are append-only — new entry functions can't be unshipped.
If the authorization semantics are wrong post-publish:

1. Do NOT roll back the package (you can't).
2. Ship a follow-up upgrade that adds
   `roster::authorize_router_v2` / `seal_approve_intent_router_v2`
   with the corrected semantics.
3. Leave v1 entries callable but unused — any stale authorizations
   remain reachable via the v1 dynamic-field key, but server code
   stops calling the v1 Seal policy.

Storage rebate: revocations keep the dynamic field (flipping
`revoked_at_ms`), so there's no storage churn on revoke. A future
`purge_router_authorization` entry could drop the field entirely if
ever needed.

## Files touched in this change

- `contracts/suiami/sources/roster.move` — +RouterAuthorization, +entry fns, +view helpers, +events
- `contracts/suiami/sources/seal_roster.move` — +ENotAuthorizedRouter, +seal_approve_intent_router
- `contracts/suiami/tests/router_auth_tests.move` — new file, 9 tests
- `src/client/suiami-seal.ts` — +AGGRON_EARTHQUAKE_PUBLISHED, +deriveRecipientNameHash, +buildAuthorizeRouterTx, +buildRevokeRouterTx
- `src/ski.ts` — +authorizeRouter / revokeRouter console hooks
- `docs/superpowers/plans/2026-04-18-aggron-earthquake-publish.md` — this file
