# Regigigas — Ultron Keyless Rumble via IKA Encrypted User Share

**Issue:** #170
**Status:** Path B chosen — awaiting rotation run
**Depends on:** Probopass #169 (fromSecretKey choke point — landed 2026-04-17)

## Goal

Retire `SHADE_KEEPER_PRIVATE_KEY` / `ULTRON_PRIVATE_KEY` as a raw Ed25519 secret on the Cloudflare Worker. Replace with:

- **User share** encrypted to a server-held **Authentication Key** (CF Secret, encryption-only).
- **IKA dWallet** holding Ultron's public key via imported-key ed25519 DKG.
- DO signing: `ultronKeypair(env)` internally decrypts the share + co-signs with IKA network per-request.

First Commandment satisfied: no raw signing key on the Worker; co-signing requires brando.sui's encryption authority + IKA threshold.

## Prereqs

- IKA SDK: `prepareImportedKeyDWalletVerification(ikaClient, Curve.ED25519, ...)` — shipped (`reference_ika_imported_key_ed25519.md`).
- Probopass Magnet Bomb done: all Ultron signing funnels through `ultronKeypair(env)`, so the raw→IKA swap is one line inside `src/server/ultron-key.ts`.

## Approach — Path B (rotate, sweep, repoint, then rumble)

1. **`scripts/rotate-ultron.ts`** — generate Ed25519 bech32 locally, `wrangler secret put ULTRON_PRIVATE_KEY` over stdin, print Ultron's new Sui address only. **Do NOT delete `SHADE_KEEPER_PRIVATE_KEY` yet** — the old address still holds assets + owns ultron.sui.
2. **Asset sweep** (signed with the old key via legacy `ultronKeypair()` reading `SHADE_KEEPER_PRIVATE_KEY` as fallback) — one PTB per coin type from old address → new address. Covers SUI (keep a tiny gas reserve for later cleanup tx), NS, IKA, iUSD, USDC, any iUSD SPL balances, plus DWalletCaps + IOU ownership transfers.
3. **Repoint ultron.sui** — `suinsTx.setTargetAddress({ nft: ultronSui, address: newUltronAddr })` + `suinsTx.setDefault('ultron.sui')` from the old address, so reverse-resolve and any `chainAt('sui@ultron')` flow resolves to the new address.
4. **Address-ref sweep** in code/docs/memory — see section below.
5. **Browser rumble flow** (extend `src/ski.ts` `whelm()` pattern — `rumbleUltron(rawKey)`).
   - Run `prepareImportedKeyDWalletVerification(ikaClient, Curve.ED25519, rawKeyBytes, ...)`.
   - Encrypt resulting user share to an Authentication Key held by brando.sui. Re-encrypt a copy to the server-side Auth Key for Ultron's DO signing path.
   - Publish the encrypted share + DWalletCap to on-chain (SUIAMI roster entry for ultron.sui).
6. **New secret: `ULTRON_AUTH_KEY_BECH32`** — encryption key (not a signing key) held by the Worker. Decrypts Ultron's user share in the DO before co-signing with IKA network. Rotation policy: every N days, re-encrypt share to fresh Auth Key.
7. **`ultronKeypair(env)` swap** — internally:
   - Read `ULTRON_AUTH_KEY_BECH32`, load encrypted share from durable storage (or IKA chain state).
   - Decrypt share, construct IKA signing context, return an object matching the existing `Ed25519Keypair`-shaped surface (`.sign(bytes)`, `.signTransaction(bytes)`, `.getPublicKey().toSuiAddress()`). Internally these route to `ikaClient.core.sign()` + the DWalletCap threshold.
8. **Parallel-run** — keep the raw key path in `ultronKeypair()` behind `env.ULTRON_IKA_RUMBLED !== 'true'`. Flip the flag once DO signing has been verified end-to-end on mainnet with a low-stakes tx.
9. **Retire** — only after sweep + repoint + parallel-run success with zero fall-through, delete `SHADE_KEEPER_PRIVATE_KEY` **and** `ULTRON_PRIVATE_KEY` bindings. Done.

## Address-churn sweep (Path B)

Ultron's address changes because imported-key DKG derives a fresh dWallet address from the new private key. Places to update after rotation:

- `public/suiami-identity.html` — Ultron address mentions.
- Memory: `project_ultron.md`, CLAUDE.md Ultron wallet references.
- Docs: `docs/superpowers/handoff-*` that pin the old address.
- `src/server/agents/shade-executor.ts` — if any hardcoded Ultron address (use `ultronAddress(env)` dynamically).

One commit per sweep slice, keep Pokemon-move cadence.

## Open questions (decide before execution)

1. **Single Auth Key or tiered?** Single = simpler; tiered = brando's Auth Key for ceremonial ops, DO Auth Key for per-request signing, refreshable.
2. **Auth Key rotation cadence?** Every 90 days? Every release? On-demand?
3. **Parallel-run window length?** Recommend ≥7 days on mainnet before retiring raw secret.

## Exit criteria

- No `ULTRON_PRIVATE_KEY` / `SHADE_KEEPER_PRIVATE_KEY` bindings on the Worker.
- `wrangler secret list` shows only encryption keys, never signing keys.
- Ultron signs a live mainnet tx via IKA co-signing, verified on Suiscan.
- Memory updated: First Commandment satisfied end-to-end for Ultron.
