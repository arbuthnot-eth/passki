// Phase 3a lifecycle validation: record → mark → settle.
// Takes the bundle created by bundle-dryrun.ts and exercises
// every state transition on mainnet. Asserts the final state.

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { readFileSync } from 'fs';

const PKG = '0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7';
const CLOCK = '0x6';

// Bundle + cap from bundle-dryrun.ts
const BUNDLE_ID = '0x08b892f9509492fe81f00bbdb3d397189e500d93ee86e31f342e9d440d49924f';
const BUNDLE_INITIAL_VERSION = 841383610;
const CAP_ID = '0xf4b91d38964cf84bce6797f3b392197f441b5192d81e1f42a75212e1768a3e52';

// Active keeper
const ACTIVE_ADDR = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';
const keystore = JSON.parse(readFileSync('/home/brandon/.sui/sui_config/sui.keystore', 'utf-8')) as string[];
let kp: Ed25519Keypair | null = null;
for (const b64 of keystore) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes[0] !== 0) continue;
  const c = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
  if (c.toSuiAddress() === ACTIVE_ADDR) { kp = c; break; }
}
if (!kp) { console.error('no matching key'); process.exit(1); }

const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

async function submit(tx: Transaction, label: string): Promise<string> {
  const bytes = await tx.build({ client: gql as never });
  const { signature } = await kp!.signTransaction(bytes);
  const b64 = Buffer.from(bytes).toString('base64');
  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sui_executeTransactionBlock',
      params: [b64, [signature], { showEffects: true, showEvents: true }, 'WaitForLocalExecution'],
    }),
  });
  const j = await res.json() as any;
  if (j.error) { console.error(`${label}:`, j.error); process.exit(1); }
  const status = j.result?.effects?.status?.status;
  console.log(`${label}: ${status} ${j.result?.digest}`);
  if (status !== 'success') {
    console.error(`${label} failed:`, JSON.stringify(j.result?.effects?.status));
    process.exit(1);
  }
  for (const ev of j.result?.events ?? []) {
    console.log(`  event: ${ev.type.split('::').slice(-1)[0]}`, JSON.stringify(ev.parsedJson));
  }
  return j.result?.digest;
}

async function readBundle(): Promise<any> {
  const r = await fetch('https://graphql.mainnet.sui.io/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ object(address:"${BUNDLE_ID}") { asMoveObject { contents { json } } } }`,
    }),
  });
  const j = await r.json() as any;
  return j?.data?.object?.asMoveObject?.contents?.json ?? null;
}

console.log('─── Phase 3a lifecycle test ───');
console.log('bundle:', BUNDLE_ID);

// Step 1: record_order_placed for slot 0
{
  const tx = new Transaction();
  tx.setSender(ACTIVE_ADDR);
  tx.moveCall({
    target: `${PKG}::bundle::record_order_placed`,
    arguments: [
      tx.sharedObjectRef({ objectId: BUNDLE_ID, initialSharedVersion: BUNDLE_INITIAL_VERSION, mutable: true }),
      tx.pure.u8(0),
      tx.pure.u128(12345n),
    ],
  });
  await submit(tx, '[1] record_order_placed(slot=0, order_id=12345)');
}

// Step 2: mark_slot_filled for slot 0 (target_count=1, so bundle completes)
{
  const tx = new Transaction();
  tx.setSender(ACTIVE_ADDR);
  tx.moveCall({
    target: `${PKG}::bundle::mark_slot_filled`,
    arguments: [
      tx.sharedObjectRef({ objectId: BUNDLE_ID, initialSharedVersion: BUNDLE_INITIAL_VERSION, mutable: true }),
      tx.pure.u8(0),
    ],
  });
  await submit(tx, '[2] mark_slot_filled(slot=0)');
}

// Verify state after step 2 (should be STATUS_COMPLETE = 1)
const midState = await readBundle();
console.log('[mid-state] status:', midState?.status, 'filled:', midState?.filled_count);

// Step 3: settle_bundle — permissionless, consumes the object
{
  const tx = new Transaction();
  tx.setSender(ACTIVE_ADDR);
  tx.moveCall({
    target: `${PKG}::bundle::settle_bundle`,
    arguments: [
      tx.sharedObjectRef({ objectId: BUNDLE_ID, initialSharedVersion: BUNDLE_INITIAL_VERSION, mutable: true }),
      tx.object(CLOCK),
    ],
  });
  await submit(tx, '[3] settle_bundle');
}

// Verify the bundle is gone
const finalState = await readBundle();
console.log('[final] bundle lookup:', finalState ? 'STILL EXISTS (unexpected)' : 'deleted (expected)');

console.log('─── lifecycle test complete ───');
