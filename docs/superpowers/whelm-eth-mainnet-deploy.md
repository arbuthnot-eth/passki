# Whelm.eth Mainnet Deploy

The flow already exists in the SKI UI — two existing admin buttons trigger Phantom prompts. No script export, no terminal, no private-key handling outside Phantom.

## Where to send ETH

**`0xa964B8b83290b60F27D57a8B9e07862CeB5e1BC1`**

This is the Phantom-controlled wallet that owns whelm.eth via the ENS NameWrapper (verified on-chain 2026-04-30). It already holds 0.00106 ETH; **add ~0.004 ETH** for headroom (~$10–15 at current ETH prices).

Real cost breakdown at typical 2026-era mainnet rates (~1-2 gwei base fee):
- Deploy `OffchainResolver`: ~1.4M gas → ~0.001-0.003 ETH
- `NameWrapper.setResolver(whelm.eth, addr)`: ~80k gas → ~0.0001 ETH
- Total: ~0.0035 ETH ≈ $10. Add 50% buffer for spikes → ~0.005 ETH total.

## How to run it (already wired)

1. Open passki.xyz in a browser with Phantom unlocked.
2. Open SKI settings panel (admin section).
3. Click **"Deploy Resolver"** — Phantom prompts; sign. The predicted contract address gets saved to `localStorage` as `ski:offchain-resolver-addr`.
4. Wait ~12-24s for the deploy tx to land.
5. Click **"Bind whelm.eth"** — Phantom prompts; sign. This calls `NameWrapper.setResolver(namehash('whelm.eth'), <deployedAddr>)`, pointing whelm.eth at your fresh OffchainResolver.
6. Done. `ultron.whelm.eth` resolves through the gateway in any wallet.

The two buttons live in the existing UI:
- `wk-deploy-resolver` → calls `window.deployOffchainResolver()` (`src/ski.ts:2266`)
- `wk-bind-whelm-eth` → calls `window.bindWhelmEthResolver()` (`src/ski.ts:1836`)

Both helpers use `window.ethereum` (Phantom). They never touch private keys outside Phantom; the worker plays no role in either tx. First commandment respected.

## Constructor args (auto-built by the helper)

```
_url     = "https://sui.ski/ens-resolver/{sender}/{data}.json"
_signers = [
    <fetched live from /api/ens-signer-address>,    // worker hot signer
    "0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d",   // ultron's IKA EVM addr
]
```

The signer list is **dynamic**: the helper fetches the worker's hot signer from `/api/ens-signer-address` at deploy time so a stale value never gets baked in. ultron's IKA-derived EVM address is the standing co-signer slot for future rotation (when we cut over to IKA-only signing, just `removeSigners([hot])`, no contract redeploy needed).

## Verify after success

In any ENS-aware wallet (MetaMask, Rabby, Coinbase Wallet, Phantom-EVM):

- Paste `ultron.whelm.eth` → resolves to `0xcaA8…882d`
- Try the new ENSv2 cross-chain syntax: `ultron.whelm.eth@base` → same EVM address (lit up by the ENSIP-19 chain-coinType handler in `src/server/ens-resolver.ts`)
- `ultron.whelm.eth@solana` → ultron's SOL address (existing SLIP-44 path)
- `ultron.whelm.eth@bitcoin` → ultron's BTC address (same)

## Regenerating the bytecode

If `OffchainResolver.sol` source changes, regenerate the TypeScript artifact:

```bash
bun scripts/compile-offchain-resolver.mjs
# emits contracts/offchain-resolver/dist/OffchainResolver.json
# the existing src/client/offchain-resolver-artifact.ts is the live bytecode
# the deploy helper uses; update it from the JSON output if the source changes
```

## After success — record it

1. Update memory `project_whelm_eth_pivot.md` with the deployed resolver address.
2. Update README "Live deployments" with the address.
3. Optionally rotate `ENS_SIGNER_PRIVATE_KEY` later by calling `addSigners` / `removeSigners` from the deployer (admin) wallet.
