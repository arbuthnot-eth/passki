#!/usr/bin/env bun
/**
 * Silvally Press-Go — one-shot Machamp M5 Revenge.
 *
 * Modes:
 *   --publish            Publish contracts/silvally/ to mainnet, print package id.
 *   --rumble             Run one DKG (secp256k1), print DWalletCap id.
 *   --spike <PKG> <CAP>  Run init_policy + delegate_approve_spike + requestSign.
 *   --all                Publish → rumble → spike, threaded end-to-end.
 *
 * Requires:
 *   SHADE_KEEPER_PRIVATE_KEY  bech32 suiprivkey for publish + spike signer
 *
 * Proves: IKA's runtime honors a MessageApproval from a shared-object-
 * borrowed DWalletCap. If yes → Silvally + Crowds arc unblocks. If the
 * network rejects → pivot to escrow-fallback jacket (still First-Cmd-ok).
 */

import { execSync } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress, SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import {
  IkaClient,
  IkaTransaction,
  UserShareEncryptionKeys,
  createRandomSessionIdentifier,
  Curve,
  Hash,
  SignatureAlgorithm,
} from '@ika.xyz/sdk';

// ─── Config ────────────────────────────────────────────────────────
const SILVALLY_PATH = 'contracts/silvally';
const IKA_COORDINATOR_MAINNET = '0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3';
const IKA_NETWORK: 'mainnet' = 'mainnet';
const GRPC_URL = 'https://fullnode.mainnet.sui.io:443';

// ─── Signer ────────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.SHADE_KEEPER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Set SHADE_KEEPER_PRIVATE_KEY env var (bech32 suiprivkey)');
  process.exit(1);
}
const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
const signerAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

const grpc = new SuiGrpcClient({ network: IKA_NETWORK, baseUrl: GRPC_URL });

// ─── Mode dispatch ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args[0];

async function main() {
  console.log(`Signer: ${signerAddr}`);

  switch (mode) {
    case '--publish': return doPublish();
    case '--rumble':  return doRumble();
    case '--spike':   return doSpike(args[1], args[2]);
    case '--all': {
      const pkgId = await doPublish();
      const capId = await doRumble();
      return doSpike(pkgId, capId);
    }
    default:
      console.error('Usage: silvally-press-go.ts --publish | --rumble | --spike <PKG> <CAP> | --all');
      process.exit(1);
  }
}

// ─── Step 1 — Publish silvally ─────────────────────────────────────
async function doPublish(): Promise<string> {
  console.log('\n=== M5.1 Publish silvally ===');
  // Shell out — sui client handles keystore, gas, skip-dep-verification.
  const out = execSync(
    `sui client publish --gas-budget 300000000 --skip-dependency-verification --json ${SILVALLY_PATH}`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const parsed = JSON.parse(out);
  const pkgChange = parsed.objectChanges?.find((c: any) => c.type === 'published');
  if (!pkgChange) {
    console.error('No published package in tx output:', out);
    process.exit(1);
  }
  const pkgId = pkgChange.packageId as string;
  console.log(`✅ silvally published at ${pkgId}`);
  return pkgId;
}

// ─── Step 2 — Rumble one secp256k1 dWallet ─────────────────────────
async function doRumble(): Promise<string> {
  console.log('\n=== M5.2 Rumble dWallet (secp256k1) ===');
  const ika = new IkaClient({ suiClient: grpc as never });
  await ika.initialize();

  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const keys = await UserShareEncryptionKeys.fromRootSeedKey(seed, Curve.SECP256K1);
  const sessionIdentifier = createRandomSessionIdentifier();
  const protocolParams = await ika.getProtocolPublicParameters(Curve.SECP256K1);
  const dkgInput = await keys.prepareDKGFirstRound({
    curve: Curve.SECP256K1,
    protocolPublicParameters: protocolParams,
    sessionIdentifier,
  });

  const tx = new Transaction();
  tx.setSender(signerAddr);
  const ikaTx = new IkaTransaction({ ikaClient: ika, transaction: tx, userShareEncryptionKeys: keys });

  // Coin splits for IKA + SUI fees — assumes adequate balances.
  const [ikaFee] = tx.splitCoins(tx.object(await pickIkaCoin()), [tx.pure.u64(1_000_000_000n)]);
  const capResult = await ikaTx.requestDWalletDKG({
    curve: Curve.SECP256K1,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.createSessionIdentifier(),
    dwalletNetworkEncryptionKeyId: ika.getNetworkEncryptionKeyId(),
    ikaCoin: ikaFee,
    suiCoin: tx.gas,
  });
  tx.transferObjects([capResult], signerAddr);

  const bytes = await tx.build({ client: grpc as never });
  const { signature } = await keypair.signTransaction(bytes);
  const res = await grpc.executeTransaction({ transaction: bytes, signature });
  console.log('DKG first round tx:', res.digest);
  console.log('⚠️  Second round + acceptEncryptedUserShare + registerEncryptionKey still needed.');
  console.log('    See scripts/rumble-ultron.ts for the full 3-round pattern.');
  console.log('    For spike purposes, wait for DKG to complete then pass the DWalletCap id to --spike.');
  throw new Error('DKG continuation not wired — use rumble-ultron.ts as reference or run browser Rumble.');
}

async function pickIkaCoin(): Promise<string> {
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const coins = await grpc.getCoins({ owner: signerAddr, coinType: IKA_TYPE });
  const first = coins.data[0];
  if (!first) throw new Error('No IKA coins — top up signer first');
  return first.coinObjectId;
}

// ─── Step 3+4 — init_policy + delegate_approve_spike → requestSign ─
async function doSpike(pkgId: string, dwalletCapId: string): Promise<void> {
  if (!pkgId || !dwalletCapId) {
    console.error('Spike needs package id + DWalletCap id');
    process.exit(1);
  }
  console.log('\n=== M5.3 init_policy ===');
  console.log(`  silvally pkg: ${pkgId}`);
  console.log(`  DWalletCap:   ${dwalletCapId}`);

  const MAX_SUBNAMES = 100n;
  const EXPIRATION_MS = BigInt(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const initTx = new Transaction();
  initTx.setSender(signerAddr);
  const [ownerCap] = initTx.moveCall({
    target: `${pkgId}::dwallet_subname_policy::init_policy`,
    arguments: [
      initTx.object(dwalletCapId),
      initTx.pure.u64(MAX_SUBNAMES),
      initTx.pure.u64(EXPIRATION_MS),
    ],
  });
  initTx.transferObjects([ownerCap], signerAddr);

  const initBytes = await initTx.build({ client: grpc as never });
  const { signature: initSig } = await keypair.signTransaction(initBytes);
  const initRes = await grpc.executeTransaction({ transaction: initBytes, signature: initSig });
  console.log('init_policy tx:', initRes.digest);

  // Extract policy id from effects
  const policyObj = initRes.effects?.created?.find((c: any) =>
    c.owner?.Shared != null || typeof c.owner === 'object',
  );
  const policyId = policyObj?.reference?.objectId;
  if (!policyId) {
    console.error('Could not extract policy id from effects:', initRes.effects);
    process.exit(1);
  }
  console.log(`✅ SubnamePolicy shared at ${policyId}`);

  console.log('\n=== M5.4 delegate_approve_spike → requestSign ===');
  console.log('  (THE actual spike — IKA runtime test)');

  // This is where the fresh-brain press-go resumes: the full spike PTB
  // needs the dWallet object, presign, encrypted-user-share, and the
  // approve-message call piped into requestSign. See PRESS_GO.md step 4.
  //
  // For the helper, we stop here and emit a ready-to-paste PTB skeleton
  // the operator can finish from the browser Rumble flow if preferred.

  console.log(`
NEXT STEP (paste into browser Rumble UI or finish programmatically):

  const tx = new Transaction();
  tx.setSender('${signerAddr}');
  const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });

  const [approval] = tx.moveCall({
    target: '${pkgId}::dwallet_subname_policy::delegate_approve_spike',
    arguments: [
      tx.object('${policyId}'),
      tx.object('${IKA_COORDINATOR_MAINNET}'),
      tx.pure(bcs.vector(bcs.u8()).serialize(new Uint8Array(32).fill(0x42))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const [presignCap] = ikaTx.requestPresign({ dWallet, signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1, ikaCoin, suiCoin });
  const verifiedPresignCap = ikaTx.verifyPresignCap({ unverifiedPresignCap: presignCap });

  await ikaTx.requestSign({
    dWallet,
    messageApproval: approval,       // <-- KEY: approval came from our policy
    hashScheme: Hash.KECCAK256,
    verifiedPresignCap,
    presign,
    encryptedUserSecretKeyShare,
    message: new Uint8Array(32).fill(0x42),
    signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
    ikaCoin, suiCoin,
  });

If the tx lands and the signature verifies off-chain — Silvally PROVEN.
If IKA rejects the approval with an invalid-source abort → pivot to
escrow-fallback jacket (user-share re-encrypted to per-crowd agent key).
`);
}

main().catch((e) => { console.error('Press-go failed:', e); process.exit(1); });
