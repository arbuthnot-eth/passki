<div align="center">

# suiami

**One name, every chain. Zero bridges.**

Resolve a single SuiNS or ENS name to native BTC, ETH, and SOL addresses — each one signed by an IKA threshold MPC dWallet, encrypted by Seal, queryable from anywhere.

[![npm](https://img.shields.io/npm/v/suiami)](https://www.npmjs.com/package/suiami)
[![bundle](https://img.shields.io/bundlephobia/minzip/suiami)](https://bundlephobia.com/package/suiami)
[![license](https://img.shields.io/npm/l/suiami)](./LICENSE)
[![Sui](https://img.shields.io/badge/Sui-mainnet-blue)](https://suiscan.xyz/mainnet/object/0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa)
[![Suilana Ikasystem](https://img.shields.io/badge/part_of-Suilana_Ikasystem-violet)](https://sui.ski)
[![by brando.sui](https://img.shields.io/badge/by-brando.sui-black)](https://sui.ski)

</div>

---

```bash
npm i suiami
```

```ts
import { readByName, readByEns } from 'suiami/roster';

const brando = await readByName('brando.sui');
// { name, sui_address, chains: { btc, eth, sol, … }, dwallet_caps, updated_ms }

const alice = await readByEns('alice.waap.eth');
// same shape — ENS subnames resolve through the same roster
```

That's it. No bridge contracts, no RPC endpoints to configure, no wallet handshake. Any JS runtime, any edge worker, any browser.

## Why this exists

ENS resolves Ethereum addresses for Ethereum-aware apps. `username.cb.id` is custodial. Lens and Farcaster are social graphs that terminate at a profile, not a UTXO. Sui zkLogin onboards users to one chain.

**SUIAMI is the plumbing.** Given a name, hand me the right address on the right chain — BTC, ETH, SOL, Sui — where the name owner *actually* holds the key. The key isn't in a bridge contract. It isn't on our server. It's a threshold share across the IKA validator set plus the owner's local share — neither half can sign alone.

## Who it's for

- **Sui dApp builders** who want ENS reach without writing a bridge. Your `*.waap.eth` users already work in MetaMask, Coinbase Wallet, Brave, Rainbow.
- **Fintech / onramp engineers** who need `alice.waap.eth` to resolve to ETH when sending ETH and BTC when sending BTC. One CCIP-read call per send. [PayPal resolves ENS across SLIP-44 coins](https://developer.paypal.com) today — so do we.
- **Privacy-minded users** who want one handle across chains without publishing every address. Your roster lives as Seal-encrypted Walrus blobs; only you can decrypt, and only the record for the chain being queried needs to reveal.

## vs the field

| | `suiami` | ENS | cb.id | SIWE | zkLogin | Lens / Farcaster | Namestone |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Resolves to native BTC | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Resolves to native SOL | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Keys are threshold-MPC | ✅ | ❌ | ❌ | n/a | ❌ | n/a | ❌ |
| Non-custodial issuer | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | partial |
| Cross-chain records encrypted | ✅ | ❌ | ❌ | n/a | n/a | ❌ | ❌ |
| CCIP-read compatible gateway | ✅ | ✅ | ✅ | n/a | n/a | ❌ | ✅ |
| Answerable from Sui + Ethereum | ✅ | Eth | Eth | Eth | Sui | — | Eth |

## How it works

```
   sender query                  on-chain                          name owner
   ──────────────                ────────                         ────────────
   readByName("brando.sui")  →   Sui Roster ([0x30b4…ab1d])  →    IdentityRecord
          │                            │                                │
          └─ GraphQL dynamic field ────┘                                │
                                                                        │
   readByEns("alice.waap.eth") →  EnsHashKey namespace                  │
                                                                        │
   *.waap.eth via PayPal / MetaMask / Coinbase                          │
          │                                                             │
          └─ ENSIP-10 OffchainLookup → /ens-resolver/:sender/:data ─────┘
                                              │
                                              ├─ SLIP-44 ETH (60)
                                              ├─ SLIP-44 BTC (0)
                                              ├─ SLIP-44 SOL (501) ← derived from IKA dWallet ed25519 pubkey
                                              └─ text("sui")
```

Every chain address comes from an IKA dWallet DKG — the private key was never reconstructed at the user, never existed on our server. Signing requires `2f+1` IKA validators to cooperate with the user's local share. Reads are permissionless; decrypts of Seal-encrypted cross-chain records are owner-only via the v3 `seal_approve_roster_reader_v3` policy.

## API

```ts
// Lookups (public — no wallet required)
readByName(name, opts?)         // "brando.sui"
readByAddress(address, opts?)   // "0x3ca0…222b"
readByChain(chain, addr, opts?) // "btc", "bc1q…" — reverse lookup
readByEns(ensName, opts?)       // "alice.waap.eth"

// Hashes
nameHash(bareName)              // keccak256(bare)
ensHash(ensName)                // keccak256(full)

// PTB builders (for client-side tx construction)
buildSetIdentityArgs(name, chains, caps?)        // SuiNS-gated write
buildSetEnsIdentityArgs(ensName, ethSig?)        // ENS bind (owner-locked)

// Proof tokens (off-chain identity attestation)
buildMessage(name, addr, nftId, chains?, balanceUsd?)
createProof(message, bytes, signature)
parseProof(token)
extractName(message)

// Constants
ROSTER_PACKAGE         // original id — use for PTB targets + type tags
ROSTER_PACKAGE_LATEST  // latest published-at — Seal v3 policy calls
ROSTER_OBJECT          // shared Roster object id

// Server-side verification
import { verify } from 'suiami/verify';
const result = await verify(token, { maxAgeMs: 300_000 });
// checks sig freshness, fetches on-chain SuiNS NFT ownership, validates domain match.
// Node / Deno / Cloudflare Workers / Bun — works everywhere.
```

## Trust layer

- **IKA 2PC-MPC**: every chain address derives from a DKG round across the IKA validator set. No single party — including the user — ever reconstructs the full key. Signing requires threshold cooperation.
- **Seal policy (on-chain Move)**: `suiami::seal_roster::seal_approve_roster_reader_v3` — gate-keeps decrypt of the Walrus-stored cross-chain squids. Caller's Sui address must match the record's owner.
- **Seal key servers** (mainnet, 2-of-3): Overclock, Studio Mirai, H2O Nodes. No centralized decrypt bottleneck.
- **Walrus**: cross-chain records live as Seal-encrypted blobs on Walrus. Blobs are currently pinned to the Walrus testnet publisher/aggregator — mainnet migration tracked upstream.
- **Mainnet package**: original-id [`0x2c1d63b3…e1052fa`](https://suiscan.xyz/mainnet/object/0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa) · v5 published-at [`0xea0b9485…d4f202`](https://suiscan.xyz/mainnet/object/0xea0b948522bf759ccde5fb10b74bae99b8929495926a53678c9d4cbd0fd4f202).
- **UpgradeCap holder**: `plankton.sui`. Changes gate-kept by a known Sui address, not a relayer or admin key.

> **Unaudited.** Use at your own risk. Third-party review is on the roadmap. In the meantime: read the Move, read the TypeScript, read the tests in the `.SKI` monorepo.

## Powered by

[**Sui**](https://sui.io) · [**IKA**](https://ika.xyz) · [**SuiNS**](https://suins.io) · [**Seal**](https://docs.sui.io/build/seal) · [**Walrus**](https://www.walrus.xyz) · [**ENS**](https://ens.domains) · [**Cloudflare Workers**](https://workers.cloudflare.com)

## Links

- **Repo:** [arbuthnot-eth/.SKI](https://github.com/arbuthnot-eth/.SKI/tree/master/packages/suiami) (monorepo)
- **Live app:** [sui.ski](https://sui.ski) — the reference implementation consuming this SDK
- **Move contracts:** [`contracts/suiami`](https://github.com/arbuthnot-eth/.SKI/tree/master/contracts/suiami)
- **Issues:** [arbuthnot-eth/.SKI/issues](https://github.com/arbuthnot-eth/.SKI/issues)
- **npm:** [suiami](https://www.npmjs.com/package/suiami)

## License

MIT

---

<div align="center">

Part of the **Suilana Ikasystem** — Sui settlement, Solana speed, Ethereum and Bitcoin reserves, IKA threshold signatures across all of it.

</div>
