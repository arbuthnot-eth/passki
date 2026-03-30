#!/usr/bin/env bun
/**
 * Rumble Ultron — provision IKA dWallets for ultron.sui server-side.
 *
 * Runs DKG for both curves (secp256k1 + ed25519) using ultron's keypair.
 * Must run locally (not in Workers — needs IKA WASM).
 *
 * Usage: bun scripts/rumble-ultron.ts
 *
 * Requires: SHADE_KEEPER_PRIVATE_KEY env var (ultron's bech32 suiprivkey)
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import {
  IkaClient,
  IkaTransaction,
  UserShareEncryptionKeys,
  createRandomSessionIdentifier,
  Curve,
} from '@ika.xyz/sdk';

const ULTRON_KEY = process.env.SHADE_KEEPER_PRIVATE_KEY;
if (!ULTRON_KEY) {
  console.error('Set SHADE_KEEPER_PRIVATE_KEY env var');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(ULTRON_KEY);
const ultronAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
console.log('Ultron address:', ultronAddr);

const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });

async function provisionCurve(curve: typeof Curve.SECP256K1 | typeof Curve.ED25519) {
  const label = curve === Curve.ED25519 ? 'ed25519 (SOL)' : 'secp256k1 (BTC/ETH)';
  console.log(`\n=== Provisioning ${label} ===`);

  // Init IKA client with gRPC (required for .core methods)
  const client = new IkaClient({ suiClient: grpc as never });
  await client.initialize();
  console.log('IKA client initialized');

  // Generate encryption keys
  const seedBytes = new Uint8Array(32);
  crypto.getRandomValues(seedBytes);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seedBytes, curve);
  const sessionIdentifier = createRandomSessionIdentifier();

  // Get protocol public parameters
  console.log('Fetching protocol public parameters...');
  const protocolPublicParameters = await client.getProtocolPublicParameters(curve);
  console.log('Got params:', protocolPublicParameters.length, 'bytes');

  // Prepare DKG (WASM crypto)
  console.log('Preparing DKG (WASM)...');
  const { prepareDKG } = await import('@ika.xyz/sdk');
  const dkgInput = await prepareDKG(
    protocolPublicParameters, curve, userShareEncryptionKeys.encryptionKey,
    sessionIdentifier, ultronAddr,
  );
  console.log('DKG prepared');

  // Network encryption key
  const encKey = await client.getLatestNetworkEncryptionKey();
  console.log('Encryption key ID:', encKey.id);

  // Check IKA balance
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const ikaCoins = await grpc.listCoins({ owner: ultronAddr, coinType: IKA_TYPE });
  const ikaCoinId = ikaCoins.objects?.[0]?.objectId;
  if (!ikaCoinId) throw new Error('Ultron has no IKA coins');
  console.log('IKA coin:', ikaCoinId);

  // Build DKG transaction
  const tx = new Transaction();
  tx.setSender(ultronAddr);

  const ikaCoin = tx.object(ikaCoinId);
  const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]); // 0.1 SUI for DKG

  const ikaTx = new IkaTransaction({ ikaClient: client, transaction: tx, userShareEncryptionKeys });

  await ikaTx.registerEncryptionKey({ curve });

  const dkgResult = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin,
    suiCoin,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });
  tx.transferObjects([dkgResult[0]], tx.pure.address(ultronAddr));
  tx.transferObjects([suiCoin], tx.pure.address(ultronAddr));

  // Build and sign
  console.log('Building transaction...');
  const txBytes = await tx.build({ client: grpc as never });
  const sig = await keypair.signTransaction(txBytes);

  // Submit
  console.log('Submitting...');
  const result = await grpc.core.executeTransactionBlock({
    transactionBlock: Array.from(txBytes),
    signatures: [sig.signature],
    options: { showEffects: true },
  });
  const digest = result.digest ?? '';
  console.log('Submitted! Digest:', digest);

  // Wait for dWallet activation
  console.log('Waiting for dWallet activation (up to 2 min)...');
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    // Check for DWalletCap
    const caps = await grpc.listDynamicFields({ parentId: ultronAddr }).catch(() => null);
    console.log(`  Check ${i + 1}/24...`);
  }
  console.log(`${label} DKG submitted. Check ultron's dWallet caps in a few minutes.`);
}

async function main() {
  // Check current balance
  const bals = await grpc.core.listBalances({ owner: ultronAddr });
  console.log('Ultron balances:');
  for (const b of bals.balances ?? []) {
    const ct = b.coinType?.split('::').pop() ?? '?';
    console.log(`  ${ct}: ${b.totalBalance}`);
  }

  // Provision secp256k1 first (BTC + ETH), then ed25519 (SOL)
  try {
    await provisionCurve(Curve.SECP256K1);
  } catch (err) {
    console.error('secp256k1 DKG failed:', err);
  }

  try {
    await provisionCurve(Curve.ED25519);
  } catch (err) {
    console.error('ed25519 DKG failed:', err);
  }

  console.log('\nDone! Check: curl https://sui.ski/api/treasury/rumble -X POST');
}

main().catch(console.error);
