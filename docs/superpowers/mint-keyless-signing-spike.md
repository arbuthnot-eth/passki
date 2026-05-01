# Mint Keyless Signing Spike — IKA + WaaP for Worker-Side Base

**Status:** research / spike
**Author:** Pneuma
**Date:** 2026-04-30
**Question:** Can a Cloudflare Worker sign a Base (EVM L2) tx with **no private key on the Worker**? Evaluate `@ika.xyz/sdk` and `@human.tech/waap-sdk` for that role.

> Constraint per CLAUDE.md First Commandment: no raw private keys on Workers, ever. DKG itself is browser-only — this spike concerns *post-DKG* signing only (an existing dWallet / wallet identity already provisioned). The Worker should be able to produce a Base tx signature without ever holding the secret material in plaintext at rest in the Worker.

---

## 1. IKA SDK in Cloudflare Workers

### 1.1 Package layout (what we have installed)

- `@ika.xyz/sdk@0.3.1` — pure-TS, dual ESM/CJS, no bundled WASM. Re-exports `IkaClient`, `IkaTransaction`, `prepareDKG`, `prepareDKGAsync`, `Curve`, `SignatureAlgorithm`, `createDKGUserOutput`, `encryptSecretShare`, the `coordinatorTransactions` / `systemTransactions` PTB builders, etc.
- `@ika.xyz/ika-wasm@0.2.1` — the dWallet MPC primitives, shipped as **three** builds:
  - `./dist/web` — `import` + browser `init()` (used today in `src/client/ika.ts`)
  - `./dist/node` — Node-flavoured glue (uses Node `fs`/buffers internally)
  - `./dist/bundler` — wasm-bindgen `bundler` target, designed for webpack/rollup/esbuild that embed the `.wasm` as an import

  `package.json` `exports` keys are `browser` / `node` / `default`(=bundler). Cloudflare Workers fit none of these labels cleanly — they are V8 isolates with WASM support but no `process.versions.node`, and they cannot read filesystem.

### 1.2 `wasm-loader.ts` behaviour

`node_modules/@ika.xyz/sdk/dist/esm/client/wasm-loader.js` does:

```js
const isNode = typeof process !== "undefined" && !!process.versions?.node;
async function init() {
  const mod = await import("@ika.xyz/ika-wasm");
  if (isNode) { ...uses node glue... }
  else { await (mod.default ?? mod.init)(); }
}
```

In a Worker, `process` is undefined (or `process.versions.node` is missing under nodejs_compat). The loader will fall through to the `else` branch and call `mod.default()` — that's the **web** init function which expects either `fetch` of a `.wasm` URL or a pre-instantiated module. Workers can do `WebAssembly.instantiate(wasmBinding)` from a wrangler `[[wasm_modules]]` binding, but the SDK gives no hook to pass one in. **Workaround would require monkey-patching `globalThis.fetch` for the wasm URL, or vendoring a fork of the wasm-loader.** Not impossible, but not first-class.

### 1.3 What needs WASM, what doesn't

From `node_modules/@ika.xyz/sdk/dist/esm/client/wasm-loader.d.ts`, the WASM exports include:

- DKG-only: `create_dkg_centralized_output_v1/v2`, `generate_secp_cg_keypair_from_seed`, `create_imported_dwallet_centralized_step`, `network_dkg_public_output_to_protocol_pp`
- **Signing (also needs WASM):** `create_sign_centralized_party_message`, `create_sign_centralized_party_message_with_centralized_party_dkg_output`, `parse_signature_from_sign_output`, `decrypt_user_share`, `verify_user_share`

Critical finding: the centralized party's signing message — i.e. the user-share half of the 2PC threshold ECDSA — is computed **inside the WASM**. There is no "post-DKG signing is plain TS" escape hatch. Worker-side signing implies Worker-side WASM execution.

### 1.4 What the IkaClient transport needs

`IkaClientOptions.suiClient: ClientWithCoreApi` — see `node_modules/@ika.xyz/sdk/dist/esm/client/types.d.ts` line 53 and `ika-client.d.ts` line 3. `ClientWithCoreApi` is the `@mysten/sui/client` v2 abstract type implemented by `SuiGrpcClient`, `SuiGraphQLClient`, and `SuiJsonRpcClient`. **In a Worker, gRPC is out (no HTTP/2 bidi), but GraphQL and JSON-RPC both work.** This is consistent with `src/client/ika.ts`'s `Promise.any` race across all three transports — in Worker context only the GraphQL/JSON-RPC paths are viable.

Conclusion: IkaClient construction itself is Worker-friendly. The blocker is the WASM init plumbing, not the network transport.

### 1.5 Best-case Worker-side flow (post-DKG)

Assuming we solve WASM bootstrap (vendored loader + `[[wasm_modules]]` binding, or `fetch` shim), and assuming the Worker has previously received an **encrypted user share** via the Sneasel/whelm.eth re-encryption path (so the agent dWallet has its share encrypted to the agent's class-groups public key, not stored in plaintext):

```
1. Worker boot:
   - IkaClient with suiClient = SuiGraphQLClient (mainnet GraphQL endpoint)
   - UserShareEncryptionKeys reconstituted from agent's class-groups decryption key
     (still a secret on the Worker — but a class-groups *decryption* key, not a
     blockchain-level private key; this is the IKA security-model assumption)
   - WASM warmed via ensureWasmInitialized()

2. Build the Base tx (eip-1559 unsigned, RLP-encoded by viem or ethers, hashed via keccak256)
   → produces 32-byte digest `messageHash`.

3. Pre-create or reuse a Presign object on-chain (SignatureAlgorithm.ECDSASecp256k1
   for Base). Presign is per-message in the imported-key flow (see SDK doc on
   `requestPresign`: "If you are using ecdsa(k1,r1) and imported key dwallet, you
   must call this function always").

4. PTB: IkaTransaction.approveImportedKeyMessage + requestSignWithImportedKey({
       dWallet, importedKeyMessageApproval, hashScheme: NONE,
       verifiedPresignCap, presign, encryptedUserSecretKeyShare,
       message: messageHash, signatureScheme: ECDSASecp256k1, ikaCoin, suiCoin })
   Submit via SuiGraphQLClient.core.executeTransaction (works post-2026-04-13).

5. Poll Sui object for the Sign object's signature output; parse with
   parse_signature_from_sign_output(); RLP-encode signed Base tx with v/r/s;
   broadcast to Base RPC via ordinary fetch.
```

**Caveats:**
- The Worker still holds the *class-groups decryption key* in memory (or at rest in a CF secret) to decrypt `encryptedUserSecretKeyShare`. CLAUDE.md's rule is "no private keys on Workers — ever" but the IKA model intentionally treats the class-groups key as the *user-side* secret. This needs a policy ruling: is a class-groups key a "private key" for purposes of the First Commandment? If yes, IKA cannot give us Worker signing without DOs holding the key share + being woken by an authorisation signal from brando.
- Per-tx Sui gas (IKA + SUI coins) is required. Ultron keeper already handles this for Shade — same plumbing.
- Latency: each Base tx = 1 Sui presign tx + 1 Sui sign tx + IKA network round trips. Order of seconds, not milliseconds.

### 1.6 Verdict on IKA

**Feasible but rough.** Two unsolved items: (a) Worker WASM bootstrap (engineering work, ~1 day), (b) policy on whether class-groups key on Worker counts as "key on Worker" (governance call). If both are resolved, IKA gives us a *real* keyless Base signer rooted in the same dWallet identity SUIAMI already resolves — strategic alignment is excellent.

---

## 2. WaaP SDK + WaaP CLI

### 2.1 Does it support EVM/Base?

**Yes.** `@human.tech/waap-sdk@1.3.0` is primarily an EVM wallet — the README's headline example is `eth_requestAccounts` / `eth_sendTransaction`. From `dist/lib/provider/types.d.ts`:

- `EthereumProviderInterface.request(args)` — full EIP-1193
- `eth_sendTransaction` (with `asyncTxs: true` returns hash early and emits `waap_tx_pending` / `waap_tx_confirmed` / `waap_tx_failed` events)
- `eth_signTransaction`, `personal_sign`, `eth_signTypedData_v4`
- `wallet_switchEthereumChain` exists in WaaP today; Base (chainId 8453) is a standard EVM chain that WaaP supports out of the box per their docs

The Sui integration (`initWaaPSui`, used in `src/waap.ts`) is layered on top of the same iframe channel — it's the *added* path, not the default one. EVM is WaaP's native turf.

### 2.2 Can it sign server-side, no key on Worker?

**No, not as currently shipped.** Every signing path runs through `WalletMessageManager` which constructs from `iframeWindow: Window` and posts messages over `window.postMessage`. From `WalletMessageManager.d.ts`:

```
constructor(iframeWindow: Window, useStaging: boolean);
```

And `EthereumProvider.d.ts`:

```
constructor(iframeWindow: Window, ...);
// Helper method to set up window.waap for WaaP
```

The signing oracle is the WaaP iframe loaded from `waap.xyz`. There is no `WaaPNodeClient`, no JWT-bearer REST endpoint exposed for "sign this digest as user X", no documented direct API. The SDK is iframe-only.

### 2.3 RequestPermissionToken — almost a delegation primitive, not quite

`waap-interface-core` exports `RequestPermissionTokenParams` / `RequestPermissionTokenResult` and the SDK exposes `requestPermissionToken(params)` (EthereumProvider.d.ts line 100). This is the closest WaaP gets to "agent" semantics: the user can grant a scoped token. But (a) the doc surface only shows it being called from the iframe-backed provider, (b) there is no documented "redeem this token in a Worker against a WaaP REST endpoint to sign," and (c) the resulting token's spendable scope is undocumented in the SDK types we have locally — would need to read WaaP server-side docs at human.tech.

### 2.4 Is there a WaaP CLI?

`npm view` is sandbox-blocked in this environment, so I could not query the registry directly. From the local install: there is **no** `@human.tech/waap-cli` package, no `bin` field in `@human.tech/waap-sdk/package.json`, no `cli/` directory. Public docs at `docs.waap.xyz` (as referenced in `src/waap.ts` headers) are organised around web-SDK integration; I have no evidence of a CLI tool. **Treat as: probably does not exist; if it does, it's undocumented.** Worth a 5-minute web search before relying on this finding.

### 2.5 WaaP ↔ IKA relationship

WaaP (Human.tech / formerly Silk) and IKA (dWallet Labs) are unrelated companies with unrelated cryptographic stacks. WaaP uses standard EOA-style private keys held in a TEE/MPC backend hidden behind the iframe — the user never sees the key, but Human.tech's servers ultimately custody it. IKA uses 2PC-MPC threshold ECDSA where neither side ever holds the full key. They could in principle compose (WaaP holding a class-groups key for an IKA dWallet) but no such integration ships today.

### 2.6 Verdict on WaaP

**Not viable for Worker-signed Base today.** WaaP requires a browser DOM with iframe + `postMessage`. To get a Worker-side EVM signature out of WaaP we would need either:
1. A Human.tech-provided server-side signing endpoint with delegated permission tokens (no public evidence this exists), or
2. A headless puppeteer instance running the WaaP iframe inside the Worker — operationally hostile, latency-prohibitive, and arguably violates WaaP's threat model.

WaaP stays in the toolkit for **browser-side EVM UX** (which is huge — it's already wired for SuiNS/whelm.eth registration flows). But it is not the Base-signing oracle for our Worker.

---

## 3. Cross-Comparison

| Dimension | IKA SDK | WaaP SDK |
|---|---|---|
| Base/EVM tx support | Yes (via ECDSA secp256k1, post-DKG) | Yes (native EVM provider) |
| Works in CF Worker | Conditionally — needs WASM bootstrap workaround | No — DOM/iframe required |
| Worker-side signing without holding a chain-level private key | Yes, modulo class-groups key policy | Not without an undocumented Human.tech server API |
| Identity continuity with `whelm.eth` / SUIAMI roster | Native — same dWallet that signs Sui PTBs signs Base | Separate identity; bridging WaaP ↔ SUIAMI is extra work |
| Engineering distance to first Base tx from Worker | ~2–3 days (vendor wasm-loader + Sneasel-style encrypted-share path + presign plumbing) | Indeterminate — gated on existence of an undocumented WaaP server endpoint |
| Sunset/lock-in risk | dWallet Labs single-vendor, but open-source SDK, BSD-3 license | Human.tech-hosted iframe, fully proprietary backend |
| April 2026 RPC sunset relevance | Already migrating to GraphQL — no new exposure | N/A (signing is over postMessage, not RPC) |

### 3.1 Recommendation: spike IKA first

**Spike IKA.** It is the only path that satisfies the First Commandment as written. The two unknowns (WASM bootstrap, class-groups-key policy) are concrete and addressable in-house. WaaP's blockers are external (someone else's product roadmap).

Suggested spike scope (one Pokemon's worth):
1. Get `@ika.xyz/ika-wasm` instantiating inside a CF Worker via `[[wasm_modules]]`. Vendor a 30-line `wasm-loader.ts` replacement that calls `WebAssembly.instantiate(env.IKA_WASM)` and sets the exported namespace.
2. Smoke test: have the Worker call `verify_secp_signature` (lightweight, no Sui round-trip) on a known-good signature.
3. End-to-end: agent dWallet signs a Base testnet tx using a pre-built `IkaTransaction.requestSignWithImportedKey` path. Use Base Sepolia, no funds at risk.
4. Document class-groups key handling in a follow-up memory note so the brando-policy decision can be made on real evidence, not speculation.

Keep WaaP exactly where it is: the browser EVM/Sui provider for end-users.
