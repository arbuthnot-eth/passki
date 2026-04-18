# OffchainResolver — ENS CCIP-read contract for `*.whelm.eth` / `*.waap.eth`

Standard ENSIP-10 / EIP-3668 resolver that redirects ENS lookups to the sui.ski
Cloudflare Worker gateway at `/ens-resolver/:sender/:data.json`. Responses are
signed by `ENS_SIGNER_PRIVATE_KEY` (hot signer on the Worker) with ultron's ETH
dWallet address as a standing co-signer for threshold-signed rotation.

## Why this contract exists

The SUIAMI roster lives on Sui. ENS lives on Ethereum L1. CCIP-read bridges them:
the wallet queries `alice.whelm.eth`, Ethereum returns `OffchainLookup(...)`, the
wallet fetches the signed response from our Worker, the contract's
`resolveWithProof` verifies the signer, the wallet renders the answer.

One deployed contract serves many parents. The gateway demultiplexes by the
DNS-encoded name inside the `name` field — see `src/server/ens-resolver.ts`
`ACCEPTED_PARENTS` set.

## Deploy recipe

Prerequisites:
- Solidity ^0.8.20 toolchain (Foundry preferred; Hardhat / Remix work too).
- `@ensdomains/ens-contracts` v1.x for `IExtendedResolver` + `SignatureVerifier`.
- An ETH wallet with ~$2 for deployment gas (whelm.eth dWallet recommended).

Constructor args:

```solidity
address[] memory signers = new address[](2);
signers[0] = 0xe7AC32BfF3B1A0af5F3E9a0c9E44A1E0B4e3De0a11; // ENS_SIGNER_PRIVATE_KEY addr (Smeargle 2026-04-17)
signers[1] = 0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d; // ultron ETH dWallet (threshold co-signer)

string memory url = "https://sui.ski/ens-resolver/{sender}/{data}.json";

new OffchainResolver(url, signers);
```

## Post-deploy wiring

Once deployed at `0xABCD…`, bind it to each accepted parent:

```js
// whelm.eth — IKA-native dWallet signs (already whelmed)
await ensRegistry.setResolver(
  namehash('whelm.eth'),
  offchainResolverAddr,
);

// waap.eth — waits for future `whelm('waap')` ceremony
```

Then call `OffchainResolver.setAdmin(ultronDwalletAddr)` so future rotations are
threshold-gated instead of hot-key gated.

## Gas budget (mainnet, ~50 gwei scenarios)

- Deploy: ~$2 (Foundry-optimized) to $3 (unoptimized)
- `setResolver` per parent: ~$0.20
- `setAdmin`: ~$0.15
- `rotateSigners`: ~$0.20 per rotation

## Source of the signer addresses

See `docs/superpowers/handoff-2026-04-17-metang-arc.md` — Smeargle rotated the ENS
signer key on 2026-04-17 (old `0x04354d56…3902` printed to terminal, rotated to
`0xe7AC32Bf…0a11`). The ultron ETH dWallet `0xcaA8d6F0…882d` is the imported-key
IKA dWallet earmarked for this threshold role.
