# Whelm.eth Mainnet Deploy — Step by Step

After this lands, every `*.whelm.eth` subname (ultron, future agents, future
guests) resolves through the SUIAMI roster via CCIP-read in any wallet that
supports ENS. `name@chain` cross-chain syntax (per ENSv2 / ENSIP-19) is
also lit up — Base/Arbitrum/Optimism/Polygon all return ultron's EVM
address; BTC/SOL/SUI return their respective chain addresses from the
SUIAMI roster.

## What's already prepared

| | |
|---|---|
| Contract source | `contracts/offchain-resolver/OffchainResolver.sol` |
| Compiled bytecode + ABI | `contracts/offchain-resolver/dist/OffchainResolver.json` |
| Deploy script | `scripts/deploy-offchain-resolver.mjs` |
| Gateway endpoint | `https://passki.xyz/ens-resolver/:sender/:data` (live) |
| Worker hot signer | `0xe7AC32BfF3B1A0af5F3E9a0c9E44A1E0B4e3De0a11` (live) |
| ENSIP-19 chain-aware addr | extended in `src/server/ens-resolver.ts` (this session) |

## Where to send ETH

**`0xa964B8b83290b60F27D57a8B9e07862CeB5e1BC1`**

This is the wallet that owns whelm.eth via the ENS NameWrapper. Verified
on-chain (`NameWrapper.ownerOf(namehash('whelm.eth'))`) 2026-04-30.

Current balance: 0.00106 ETH. Send another **~0.015 ETH** (≈ $40-50 at
current prices) to cover both transactions with headroom.

Two transactions will fire from this wallet:
1. **Deploy OffchainResolver.sol** — ~1.4M gas, ~0.005 ETH at typical mainnet rates
2. **NameWrapper.setResolver(whelm.eth, deployedAddr)** — ~80k gas, ~0.0003 ETH

Total expected cost: **~0.006 ETH**. The 0.015 ETH suggestion has 2-3×
buffer for gas spikes.

## Constructor args (locked in)

```
_url     = "https://passki.xyz/ens-resolver/{sender}/{data}.json"
_signers = [
    "0xe7AC32BfF3B1A0af5F3E9a0c9E44A1E0B4e3De0a11",  // worker hot signer (ENS_SIGNER_PRIVATE_KEY addr)
    "0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d",   // ultron's IKA EVM addr (standing co-signer)
]
```

The worker signer signs CCIP-read responses today. The ultron co-signer is
the rotation path — when we want to retire the hot signer and only sign
via IKA-mediated threshold flow, ultron can call `addSigners`/`removeSigners`
without redeploying. Both are admin-allowed by default since the deployer
becomes admin.

## Run the deploy

From a machine you trust (NOT a worker, NOT this repo's CI). The
`WHELM_DEPLOY_PRIVATE_KEY` is touched only in this terminal session and
never persisted anywhere in the project.

```bash
# 1. Confirm the contract still compiles cleanly (already done — the
#    artifact is committed). Re-run if you ever modify the .sol file.
bun scripts/compile-offchain-resolver.mjs

# 2. Deploy + bind in one shot. Reads WHELM_DEPLOY_PRIVATE_KEY from env.
WHELM_DEPLOY_PRIVATE_KEY=0xYOURKEY \
ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
bun scripts/deploy-offchain-resolver.mjs
```

Output:
```
Deployer wallet: 0xa964...1BC1
✓ confirmed deployer owns whelm.eth via NameWrapper
balance: 0.0163... ETH

[1/2] deploying OffchainResolver to mainnet...
  tx: 0x...
✓ deployed at 0x<RESOLVER_ADDRESS>

[2/2] binding whelm.eth → 0x<RESOLVER_ADDRESS> via NameWrapper.setResolver...
  tx: 0x...
✓ whelm.eth resolver is now 0x<RESOLVER_ADDRESS>

=== DONE ===
```

## Verify

```bash
# 1. Worker signer still alive
curl -s https://passki.xyz/api/ens-signer-address
# → {"address":"0xe7ac32bf8f8bc705a269687bf7c730e44f840a11"}

# 2. ENS resolver pointer (should be the contract you just deployed)
# Easiest: check on https://app.ens.domains/whelm.eth
```

Then in any ENS-aware wallet (MetaMask, Rabby, Coinbase Wallet,
Phantom-EVM):

- Paste `ultron.whelm.eth` into a "send" field
- Wallet should resolve it to `0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d`
- Send any ETH/USDC/EVM token there — lands at ultron's IKA Base/EVM identity
- Try the same on the Base or Arbitrum network in MetaMask — same address resolves; same address holds value there too

For wallets that adopt the new `name@chain` syntax (per ENSv2 / on.eth):
- `ultron.whelm.eth@base` → ultron's EVM addr (via ENSIP-19 chain coinType)
- `ultron.whelm.eth@solana` → ultron's SOL addr (via ENSIP-9 SLIP-44 coinType 501)
- `ultron.whelm.eth@bitcoin` → ultron's BTC addr (via ENSIP-9 SLIP-44 coinType 0)

## After success — record it

1. Update memory `project_whelm_eth_pivot.md` with the deployed address.
2. Update `README.md` "Live deployments" table (or equivalent).
3. Optionally rotate ENS_SIGNER_PRIVATE_KEY by calling `addSigners` /
   `removeSigners` from the admin (deployer) wallet. Use a Worker-bound
   IKA flow when the IKA-spike work lands — avoids further private-key
   exposure on the hot signer.

## First commandment compliance

- The deploy private key lives in your local terminal env var for the
  duration of `scripts/deploy-offchain-resolver.mjs` — NEVER on a
  Cloudflare Worker.
- The worker hot signer (`0xe7AC32Bf…`) IS still on the Worker today
  (legacy `ENS_SIGNER_PRIVATE_KEY` secret) — that's the next thing to
  retire after the IKA-native signing spike (per
  `docs/superpowers/mint-relay-ika-threat-model.md`).
- ultron's standing co-signer slot is already in the resolver's `signers`
  set, so when we cut over to IKA-only signing, no contract redeploy
  needed — just call `removeSigners([ENS_SIGNER_HOT_ADDR])`.
