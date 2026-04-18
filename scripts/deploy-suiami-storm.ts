#!/usr/bin/env bun
/**
 * Deploy Global SUIAMI Storm — one-time on-chain deployment.
 *
 * Creates the global PermissionedGroup<Messaging> that serves as SUIAMI's
 * public identity directory. Anyone with a SuiNS name can join.
 *
 * Uses a deterministic UUID ('suiami-global') so the object ID is known
 * before deployment: 0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8
 *
 * Usage: bun scripts/deploy-suiami-storm.ts
 *
 * Requires: SHADE_KEEPER_PRIVATE_KEY env var (brando/ultron bech32 suiprivkey)
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  createSuiStackMessagingClient,
  MAINNET_SUI_STACK_MESSAGING_PACKAGE_CONFIG,
} from '@mysten/sui-stack-messaging';

const STORM_UUID = 'suiami-global';
const STORM_NAME = 'SUIAMI Global';

// Seal key servers (mainnet, 2-of-3 threshold)
const SEAL_SERVERS = [
  { objectId: '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6', weight: 1 }, // Overclock
  { objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10', weight: 1 }, // Studio Mirai
  { objectId: '0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a', weight: 1 }, // H2O Nodes
];

// ─── Signer ────────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.ULTRON_PRIVATE_KEY || process.env.SHADE_KEEPER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Set ULTRON_PRIVATE_KEY (or legacy SHADE_KEEPER_PRIVATE_KEY) env var (bech32 suiprivkey)');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const address = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
console.log('Deployer:', address);

// ─── Client ────────────────────────────────────────────────────────
const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

const client = createSuiStackMessagingClient(gql as any, {
  seal: { serverConfigs: SEAL_SERVERS, verifyKeyServers: false },
  encryption: {
    sessionKey: { signer: keypair },
  },
  relayer: {
    transport: {
      // Minimal no-op transport — we only need tx building, not message relay
      async sendMessage() { return { messageId: '' }; },
      async fetchMessages() { return { messages: [], hasNext: false }; },
      async fetchMessage() { return {} as any; },
      async updateMessage() {},
      async deleteMessage() {},
      async *subscribe() {},
      disconnect() {},
    },
  },
});

// ─── Derive & verify ───────────────────────────────────────────────
const groupId = client.messaging.derive.groupId({ uuid: STORM_UUID });
const encHistId = client.messaging.derive.encryptionHistoryId({ uuid: STORM_UUID });
console.log('Expected Group ID:', groupId);
console.log('Expected EncryptionHistory ID:', encHistId);

// ─── Check if already deployed ─────────────────────────────────────
try {
  await client.messaging.view.getCurrentKeyVersion({ uuid: STORM_UUID });
  console.log('\nGlobal SUIAMI Storm already exists on-chain. Nothing to do.');
  process.exit(0);
} catch {
  console.log('\nStorm not found on-chain. Deploying...');
}

// ─── Deploy ────────────────────────────────────────────────────────
const result = await client.messaging.createAndShareGroup({
  signer: keypair,
  uuid: STORM_UUID,
  name: STORM_NAME,
  initialMembers: [], // Open — members added via Thunder tag flow
});

console.log('\nDeployed!');
console.log('Digest:', result.digest);
console.log('Group ID:', groupId);
console.log('\nUpdate GLOBAL_SUIAMI_STORM in src/client/thunder-stack.ts with:');
console.log(`export const GLOBAL_SUIAMI_STORM = '${groupId}';`);
