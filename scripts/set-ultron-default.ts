#!/usr/bin/env bun
/**
 * Set ultron.sui as the default reverse-lookup name for the keeper wallet.
 *
 * Context: the `ultron.sui` SuiNS NFT is held by some other address (not
 * ultron itself) but its target is already set to ultron's address. The
 * forward record resolves (`ultron.sui` → 0xa84c...), but the reverse
 * record is empty, so UIs render the raw hex address for ultron.
 *
 * `controller::set_reverse_lookup(suins, domainName)` is gated by
 * "caller must be the current target of the name" — NOT by NFT ownership.
 * Since ultron is already the target, it can call setDefault from its own
 * keypair without needing to hold the NFT.
 *
 * Usage: SHADE_KEEPER_PRIVATE_KEY=suiprivkey1... bun scripts/set-ultron-default.ts
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SuinsClient, SuinsTransaction } from '@mysten/suins';

const TARGET_NAME = 'ultron.sui';
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

const PRIVATE_KEY = process.env.ULTRON_PRIVATE_KEY || process.env.SHADE_KEEPER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Set ULTRON_PRIVATE_KEY (or legacy SHADE_KEEPER_PRIVATE_KEY) env var (bech32 suiprivkey)');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const address = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
console.log(`Signer: ${address}`);

const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

// ─── Pre-flight: confirm forward resolution points to us ─────────────
const check = await fetch(GQL_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `{ nameRecord(name: "${TARGET_NAME}") { target { address } } }`,
  }),
});
const checkData = (await check.json()) as {
  data?: { nameRecord?: { target?: { address?: string } } };
};
const currentTarget = checkData.data?.nameRecord?.target?.address?.toLowerCase();
if (!currentTarget) {
  console.error(`FATAL: ${TARGET_NAME} has no target set on-chain.`);
  console.error('Someone needs to call setTargetAddress on the NFT first.');
  process.exit(1);
}
if (currentTarget !== address.toLowerCase()) {
  console.error(`FATAL: ${TARGET_NAME} target is ${currentTarget}, not us (${address}).`);
  console.error('set_reverse_lookup is gated on "caller must be current target".');
  console.error('Either update the NFT target first, or run this from the correct keypair.');
  process.exit(1);
}
console.log(`✓ ${TARGET_NAME} target is ${currentTarget} — match.`);

// ─── Pre-flight: check current reverse record ────────────────────────
const reverseCheck = await fetch(GQL_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `{ address(address: "${address}") { defaultNameRecord { domain } } }`,
  }),
});
const reverseData = (await reverseCheck.json()) as {
  data?: { address?: { defaultNameRecord?: { domain?: string } | null } };
};
const currentDefault = reverseData.data?.address?.defaultNameRecord?.domain;
if (currentDefault === TARGET_NAME) {
  console.log(`Reverse record already set to ${TARGET_NAME}. Nothing to do.`);
  process.exit(0);
}
console.log(`Current reverse record: ${currentDefault ?? '(none)'} — will set to ${TARGET_NAME}`);

// ─── Build tx ────────────────────────────────────────────────────────
const suinsClient = new SuinsClient({ client: gql as never, network: 'mainnet' });
const tx = new Transaction();
tx.setSender(address);
const suinsTx = new SuinsTransaction(suinsClient, tx);
suinsTx.setDefault(TARGET_NAME);

// ─── Build + sign + submit ───────────────────────────────────────────
const bytes = await tx.build({ client: gql as never });
const sig = await keypair.signTransaction(bytes);

const submitRes = await fetch(GQL_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `mutation($txBytes: String!, $sigs: [String!]!) {
      executeTransactionBlock(txBytes: $txBytes, signatures: $sigs) {
        effects { transactionBlock { digest } status errors }
      }
    }`,
    variables: {
      txBytes: Buffer.from(bytes).toString('base64'),
      sigs: [sig.signature],
    },
  }),
});
const submitData = (await submitRes.json()) as {
  data?: {
    executeTransactionBlock?: {
      effects?: {
        transactionBlock?: { digest?: string };
        status?: string;
        errors?: string[];
      };
    };
  };
  errors?: Array<{ message: string }>;
};

if (submitData.errors?.length) {
  console.error('GraphQL errors:', submitData.errors.map((e) => e.message).join(' | '));
  process.exit(1);
}
const effects = submitData.data?.executeTransactionBlock?.effects;
if (effects?.status !== 'SUCCESS') {
  console.error('Tx failed:', effects?.status, effects?.errors);
  process.exit(1);
}
console.log(`\n✓ Reverse lookup set. Digest: ${effects?.transactionBlock?.digest}`);
console.log(`  ${address} now reverse-resolves to ${TARGET_NAME}`);
console.log('\nUIs that reverse-lookup this address (Thunder identity header,');
console.log('squids display, sender resolution in getThunders, etc.) will');
console.log('start showing "ultron.sui" once the GraphQL indexer catches up.');
