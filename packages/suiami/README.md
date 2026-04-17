# suiami

**Cross-chain identity resolver on Sui.** One name, every chain.

SUIAMI maps a SuiNS name (`brando.sui`) AND optional ENS subname (`brando.waap.eth`) to the wallet's BTC, ETH, SOL, and other chain addresses — all provably derived from IKA threshold-signed dWallets, not imported keys, not bridges. Reads are permissionless; writes are NFT-gated (SuiNS) or owner-gated (ENS).

- **Non-custodial.** All chain addresses come from IKA DKG. No team, server, or contract ever holds a signing key that can move user funds.
- **Seal-encrypted by default.** Cross-chain addresses live as Seal-encrypted Walrus blobs. On-chain entries hold only `sui`, a blob pointer, and a policy reference; everything else requires a session signature from the name owner.
- **Dual-indexed.** Look up by SuiNS name hash, by Sui address, or by chain-specific `"btc:..."` / `"eth:..."` / `"sol:..."` key.
- **ENS-extensible.** ENS names (typically subnames under `waap.eth`) bind to the same `IdentityRecord` via a typed `EnsHashKey` dynamic field, namespace-isolated from Sui names so there's no collision surface.
- **Upgrade-stable.** Package upgrades preserve the original-id; this SDK exports both the original-id (for PTB targets and type tags) and the latest published-at (for Seal-policy calls that need the newest functions).

## Install

```bash
npm i suiami @noble/hashes
```

## Read a record

```ts
import { readByName, readByAddress, readByEns } from 'suiami/roster';

// By SuiNS name (public lookup; no signing):
const brando = await readByName('brando.sui');
// { name, sui_address, chains: { btc, eth, sol, ... }, dwallet_caps, updated_ms } | null

// By Sui address:
const byAddr = await readByAddress('0x3ca0...222b');

// By ENS name (lives in the typed EnsHashKey namespace):
const viaEns = await readByEns('alice.waap.eth');
```

> `chains` on-chain returns only plaintext entries. Seal-encrypted squids
> live in the record's Walrus blob — fetch and decrypt client-side via
> `@mysten/seal` using the v3 `seal_approve_roster_reader_v3` policy.

## Build a PTB

```ts
import { buildSetIdentityArgs, buildSetEnsIdentityArgs, ROSTER_PACKAGE } from 'suiami/roster';
import { Transaction } from '@mysten/sui/transactions';

// SuiNS-name-gated write:
const args = buildSetIdentityArgs(
  'brando',
  { btc: 'bc1q...', eth: '0xce3e...', sol: 'Ftdg...' },
  ['0x2fe5...', '0xd570...'], // dWalletCap ids (empty ok)
);

const tx = new Transaction();
tx.moveCall({
  target: `${args.package}::${args.module}::${args.function}`,
  arguments: [
    tx.object(args.rosterObject),
    tx.pure.string(args.name),
    tx.pure.vector('u8', args.nameHash),
    tx.pure.vector('string', args.chainKeys),
    tx.pure.vector('string', args.chainValues),
    tx.pure.vector('address', args.dwalletCaps),
    tx.pure.string(/* walrus_blob_id */ ''),
    tx.pure.vector('u8', /* seal_nonce */ []),
    tx.object('0x6'),
  ],
});

// ENS bind (caller must already have a SUIAMI record; name is owner-locked first-come):
const ensArgs = buildSetEnsIdentityArgs('alice.waap.eth');
tx.moveCall({
  target: `${ensArgs.package}::${ensArgs.module}::${ensArgs.function}`,
  arguments: [
    tx.object(ensArgs.rosterObject),
    tx.pure.string(ensArgs.ensName),
    tx.pure.vector('u8', ensArgs.ensHash),
    tx.pure.vector('u8', ensArgs.ethOwnerSig), // placeholder until ecdsa_k1 verify ships
    tx.object('0x6'),
  ],
});
```

## Proof-carrying messages

For off-chain identity attestation (e.g. signing into `sui.ski` or a third-party app), SUIAMI builds a canonical message + bundle:

```ts
import { buildMessage, createProof, parseProof, extractName } from 'suiami';

const message = buildMessage('brando', '0x3ca0...222b', nftId, {
  btc: 'bc1q...', eth: '0xce3e...', sol: 'Ftdg...',
}, /* balanceUsd */ 42.17);

// Sign `message` with the wallet's personal-message endpoint, then:
const proof = createProof(message, bytes, signature);
// proof.token = "suiami:<base64url message>.<signature>"

// Verifier side:
const parsed = parseProof(proof.token);
// parsed.message.suiami === "I am brando"
```

Use `suiami/verify` for full signature + zkLogin verification against the Sui network.

## Contracts

The on-chain Move package lives in this repo under `/contracts/suiami` — two modules:

- `suiami::roster` — `IdentityRecord` state, `set_identity` (SuiNS-gated), `set_ens_identity` (owner-locked, overwrite-protected), `revoke_ens_identity`, `lookup_*`, mutators.
- `suiami::seal_roster` — `seal_approve_roster_reader_v3` policy for gated Walrus decrypt; accepts either `name_hash` or `ens_hash` (typed key) namespace.

Published at `ROSTER_PACKAGE_LATEST` (v5+); original-id at `ROSTER_PACKAGE`.

## Exports

- `suiami` — message builders, proof tokens, all roster re-exports
- `suiami/roster` — roster reads/writes, hashes, constants
- `suiami/verify` — proof-token verification helpers

## License

MIT
