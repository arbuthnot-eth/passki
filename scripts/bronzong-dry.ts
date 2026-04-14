// Dry-run the Bronzong Seal encrypt path against mainnet to prove the
// suiami package is reachable, the Seal key servers respond, and the
// access policy PTB builds cleanly. Does NOT require a wallet signature
// — encrypt is stateless, and we only dry-run the policy PTB shape.
//
// Run: bun run scripts/bronzong-dry.ts

import { SealClient } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const SUIAMI_PKG = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';
const ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
const ROSTER_INITIAL_SHARED_VERSION = 839068132;

const SEAL_SERVERS_MAINNET = [
  { objectId: '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6', weight: 1 }, // Overclock
  { objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10', weight: 1 }, // Studio Mirai
  { objectId: '0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a', weight: 1 }, // H2O Nodes
];

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});

async function main() {
  console.log('--- Bronzong dry-run against mainnet ---\n');

  console.log('[1/4] Constructing SealClient with 3 mainnet key servers…');
  const sealClient = new SealClient({
    suiClient: client as never,
    serverConfigs: SEAL_SERVERS_MAINNET,
    verifyKeyServers: false,
  });

  console.log('[2/4] Deriving 40-byte Seal identity for "superteam"…');
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  const nameHash = keccak_256(new TextEncoder().encode('superteam'));
  const sealIdBytes = new Uint8Array(40);
  sealIdBytes.set(nameHash.slice(0, 32), 0);
  const sealIdHex = Array.from(sealIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log(`      id hex: ${sealIdHex}`);
  console.log(`      id len: ${sealIdBytes.length} bytes = ${sealIdHex.length} hex chars`);

  console.log('[3/4] Calling SealClient.encrypt with suiami package (id as hex string)…');
  const squids = { btc: 'bc1q-test', eth: '0xtest', sol: 'test' };
  const plaintext = new TextEncoder().encode(JSON.stringify(squids));
  try {
    // Seal's createFullId(packageId, id) calls fromHex(id) internally,
    // so `id` MUST be a hex string (80 chars = 40 bytes). Passing a
    // Uint8Array trips "hexStr.startsWith is not a function".
    const { encryptedObject } = await sealClient.encrypt({
      packageId: SUIAMI_PKG,
      id: sealIdHex,
      data: plaintext,
      threshold: 2,
    });
    console.log(`      encryptedObject: ${encryptedObject.length} bytes`);
  } catch (e) {
    console.error('      ❌ encrypt failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log('[4/4] Building seal_approve_roster_reader policy PTB (dry-run)…');
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIAMI_PKG}::seal_roster::seal_approve_roster_reader`,
    arguments: [
      tx.sharedObjectRef({
        objectId: ROSTER_OBJ,
        initialSharedVersion: ROSTER_INITIAL_SHARED_VERSION,
        mutable: false,
      }),
      tx.pure.vector('u8', Array.from(sealIdBytes)),
    ],
  });
  try {
    const bytes = await tx.build({
      client: client as never,
      onlyTransactionKind: true,
    });
    console.log(`      ptb bytes: ${bytes.length}`);
  } catch (e) {
    console.error('      ❌ ptb build failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log('\n✅ all checks pass — Seal + suiami package + policy PTB all resolve');
  console.log('    Browser test will still prompt for a SessionKey personal-message signature');
  console.log('    and require the caller\'s own SUIAMI roster entry to actually decrypt.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
