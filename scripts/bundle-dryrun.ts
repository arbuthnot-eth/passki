import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { readFileSync } from 'fs';

const PKG = '0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7';
const CLOCK = '0x6';

// Load the key matching the active sui address
const ACTIVE_ADDR = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';
const keystore = JSON.parse(readFileSync('/home/brandon/.sui/sui_config/sui.keystore', 'utf-8')) as string[];
let kp: Ed25519Keypair | null = null;
for (const b64 of keystore) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes[0] !== 0) continue; // only ed25519
  const candidate = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
  if (candidate.toSuiAddress() === ACTIVE_ADDR) { kp = candidate; break; }
}
if (!kp) { console.error('No matching key for', ACTIVE_ADDR); process.exit(1); }
const SELF = kp.toSuiAddress();
console.log('sender:', SELF);

const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });

// Phase 3a dry run: create a 2-slot bundle with a target_count=1 and
// a 10-minute deadline. We'll immediately try to refund it once the
// deadline passes. For validation we just need proof that create_bundle
// executes on-chain and returns a valid OrderBundle shared object.
const tag = 400001;                 // route=4 (DeepBook), action=00, nonce=001
const targetCount = 1;
const deadlineMs = Date.now() + 10 * 60 * 1000;
const fakePoolId = '0x0000000000000000000000000000000000000000000000000000000000000001';

const tx = new Transaction();
tx.setSender(SELF);

// new_slot(0 /*DeepBook*/, fakePoolId, SELF)
const [slotA] = [tx.moveCall({
  target: `${PKG}::bundle::new_slot`,
  arguments: [
    tx.pure.u8(0),
    tx.pure.address(fakePoolId),
    tx.pure.address(SELF),
  ],
})];
const [slotB] = [tx.moveCall({
  target: `${PKG}::bundle::new_slot`,
  arguments: [
    tx.pure.u8(0),
    tx.pure.address(fakePoolId),
    tx.pure.address(SELF),
  ],
})];
const slots = tx.makeMoveVec({
  type: `${PKG}::bundle::OrderSlot`,
  elements: [slotA, slotB],
});
const [cap] = [tx.moveCall({
  target: `${PKG}::bundle::create_bundle`,
  arguments: [
    tx.pure.u32(tag),
    tx.pure.u8(targetCount),
    tx.pure.u64(deadlineMs),
    slots,
    tx.object(CLOCK),
  ],
})];
tx.transferObjects([cap], tx.pure.address(SELF));

const bytes = await tx.build({ client: gql as never });
const { signature } = await kp.signTransaction(bytes);

// Submit via JSON-RPC
const b64 = Buffer.from(bytes).toString('base64');
const res = await fetch('https://sui-rpc.publicnode.com', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'sui_executeTransactionBlock',
    params: [b64, [signature], { showEffects: true, showObjectChanges: true }, 'WaitForLocalExecution'],
  }),
});
const j = await res.json() as any;
if (j.error) { console.error('RPC error:', j.error); process.exit(1); }
console.log('digest:', j.result?.digest);
console.log('status:', j.result?.effects?.status);
const created = (j.result?.objectChanges ?? []).filter((c: any) => c.type === 'created');
for (const c of created) {
  console.log('created:', c.objectType, c.objectId);
}
