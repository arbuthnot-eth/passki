# Mint — Browser-Side x402 Submit (Ops Doc)

Status: live. Server holds **no** EVM private key (first commandment, unconditional).
Buyer's own wallet submits the Base USDC `transferWithAuthorization` tx; the
SKI worker verifies the signature + on-chain receipt, then ultron registers
the SuiNS name from its NS pool.

Helper: `src/client/mint-pay.ts` (viem-based).
Server: `src/server/mint/routes.ts` (verify-only, no settle).

## Mobile UX flow (4G phone, three taps)

1. **Quote** — User types `splash` and taps "Make It Rain".
   Browser hits `GET /api/mint/quote/splash` and shows total USDC.
2. **Sign + submit** — User taps "Power Gem".
   - WaaP / EIP-1193 wallet pops a single sign sheet for the EIP-3009
     `transferWithAuthorization` typed-data.
   - `mint-pay.ts` then asks the wallet to **submit** the signed
     authorization on Base mainnet (the wallet broadcasts; we wait for 1
     confirmation, ~2s on Base).
3. **Post** — Helper re-calls `POST /api/mint/register/splash` with
   `X-PAYMENT` (the signed authorization) + `X-PAYMENT-TX-HASH` (Base
   receipt) + `X-SUI-TARGET` (the buyer's Sui address). Server verifies,
   ultron mints+transfers the NFT, response carries the Sui digest.

What the user sees: quote screen → wallet sheet → "registered ✓ splash.sui"
toast with both the Base hash and Sui digest. ~5–8 seconds end to end on 4G.

## WaaP note (Sui vs. Base)

WaaP's `signAndExecuteTransaction` server-side iframe path is **Sui-only** —
WaaP iframes a Sui SDK and submits via Sui RPC. It does **not** broadcast
EVM/Base txs.

For the Base leg, the buyer needs an EVM-capable wallet:

- **EIP-1193 injected wallet** (MetaMask / Rabby / Phantom-EVM): signs +
  submits in one step. Works on mobile via WalletConnect deeplink.
- **WaaP**: today, WaaP only signs typed data on the EVM side via
  `signPersonalMessage`-style flow; submission must be done by the SKI
  client itself using a public Base RPC (`mint-pay.ts` handles this when
  the wallet exposes only signing).
- **Phone-only with no EVM extension**: fall back to WalletConnect to a
  mobile EVM wallet; the SKI page never sees a key.

If the only connected wallet is Sui-WaaP with no EVM capability, the
client surfaces a "connect an EVM wallet to pay USDC on Base" prompt.

## Headers — `POST /api/mint/register/:name`

| Header | Required | Purpose |
| --- | --- | --- |
| `X-PAYMENT` | yes | Base64-encoded EIP-3009 authorization payload (see `decodeXPaymentHeader` in `x402-paywall.ts`). |
| `X-SUI-TARGET` | yes (or `?sui_target=`) | Sui address that receives the SuiNS NFT. |
| `X-PAYMENT-TX-HASH` | optional | Base tx hash from the buyer's submission; surfaced in response, future hardening will verify on-chain. |

Query params: `?years=N` (default 1), `?sui_target=0x…` (alternate to header).

Without `X-PAYMENT`, server returns `402` with a challenge body produced by
`buildChallenge(quote, resourceUrl)`.

## Curl example (full flow)

```bash
# 1. Quote
curl -s https://passki.xyz/api/mint/quote/splash?years=1 | jq
# → { "name": "splash", "years": 1, "total_usdc": "12500000", ... }

# 2. Hit register without payment — get the 402 challenge
curl -s -X POST 'https://passki.xyz/api/mint/register/splash?years=1' \
  -H 'X-SUI-TARGET: 0x2b35…7ee28'
# → 402 { "x402Version": 1, "accepts": [{ "scheme": "exact", "asset": "USDC", "maxAmountRequired": "12500000", … }] }

# 3. (Off-band) Buyer wallet signs EIP-3009 authorization and submits it on
#    Base mainnet, getting tx hash 0xBASEHASH.

# 4. Re-call with X-PAYMENT (b64 of the signed authorization) + tx hash
PAYMENT=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({
  scheme: "exact",
  network: "base",
  payload: { signature: "0x…", authorization: { from: "0xBuyer", to: "0xUltronEVM", value: "12500000", validAfter: "0", validBefore: "9999999999", nonce: "0x…" } }
})).toString("base64"))')

curl -s -X POST 'https://passki.xyz/api/mint/register/splash?years=1' \
  -H "X-PAYMENT: $PAYMENT" \
  -H 'X-PAYMENT-TX-HASH: 0xBASEHASH' \
  -H 'X-SUI-TARGET: 0x2b35…7ee28' | jq
# → { "ok": true, "stage": "registered", "name": "splash",
#     "registration": { "digest": "Sui…", "nft_id": "0x…" },
#     "payment": { "buyer": "0xBuyer", "amount_usdc": "12500000",
#                  "base_tx_hash": "0xBASEHASH" } }
```

## Invariants

- No `MINT_GAS_RELAY_PRIVATE_KEY`, no relayer, no settle endpoint, no recover
  endpoint. The Base tx is the buyer's responsibility; the server is
  verify-then-mint only.
- `registerFromUltronPool` is the only mutator the route calls after
  `verifyPayment` succeeds — see `src/server/mint/register.ts`.
- ultron's Sui keypair stays in the worker secret store; ultron's NS pool
  funds the registration. Buyer pays USDC on Base, SKI bridges value via
  ultron's pre-funded SuiNS supply.
