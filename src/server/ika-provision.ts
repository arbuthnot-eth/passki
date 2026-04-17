/**
 * Server-side dWallet provisioning for SuiNS holders.
 *
 * Flow:
 *   1. Check if user already has a dWallet (skip if so)
 *   2. Build a sponsored PTB: swap SUI→IKA + DKG request
 *      - sender = user (owns the resulting DWalletCap)
 *      - gasOwner = keeper (pays gas + provides SUI for IKA swap)
 *   3. Keeper signs as gas sponsor
 *   4. Return tx bytes + sponsor sig to client
 *   5. Client signs as user, submits with both sigs
 *
 * The user ends up owning the DWalletCap directly — no transfer needed.
 */

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ultronKeypair } from './ultron-key.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  IkaClient, IkaTransaction, getNetworkConfig,
  Curve, UserShareEncryptionKeys,
  createRandomSessionIdentifier, prepareDKGAsync,
} from '@ika.xyz/sdk';
import { createGrpc7kAdapter } from './grpc-7k-adapter.js';

const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const SUI_TYPE = '0x2::sui::SUI';

// ── Cetus CLMM constants (IKA/SUI pool) ─────────────────────────────
// Direct swap via Cetus router — no SDK needed, just a Move call.
const CETUS_ROUTER = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d';
const CETUS_GLOBAL_CONFIG = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
const CETUS_IKA_SUI_POOL = '0xc23e7e8a74f0b18af4dfb7c3280e2a56916ec4d41e14416f85184a8aab6b7789';
const SUI_CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006';
// sqrt price limits from Cetus CLMM (tick math bounds)
const MIN_SQRT_PRICE = '4295048016';
const MAX_SQRT_PRICE = '79226673515401279992447579055';

export interface ProvisionResult {
  success: boolean;
  /** base64-encoded transaction bytes for the client to sign */
  txBytes?: string;
  /** Keeper's gas sponsor signature */
  sponsorSig?: string;
  /** If already provisioned, the existing dWallet ID */
  dwalletId?: string;
  error?: string;
}


/**
 * Build a sponsored DKG provisioning transaction.
 *
 * The transaction is built with:
 *   - sender = userAddress (will own the DWalletCap)
 *   - gasOwner = keeperAddress (pays gas)
 *
 * Returns the tx bytes (base64) and keeper's sponsor signature.
 * The client must sign as the user and submit with both signatures.
 */
export async function buildProvisionTx(
  userAddress: string,
  keeperPrivateKey: string,
): Promise<ProvisionResult> {
  const keypair = Ed25519Keypair.fromSecretKey(keeperPrivateKey);
  const keeperAddress = keypair.toSuiAddress();

  // Set up gRPC client + adapter (no JSON-RPC)
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
  const adapter = createGrpc7kAdapter(grpc);

  // Set up IKA client
  const config = getNetworkConfig('mainnet');
  const ikaClient = new IkaClient({ config, suiClient: adapter as any });

  // Check if user already has a dWallet
  const existing = await ikaClient.getOwnedDWalletCaps(userAddress, undefined, 1);
  if (existing.dWalletCaps.length > 0) {
    return { success: true, dwalletId: existing.dWalletCaps[0].dwallet_id };
  }

  // Prepare DKG crypto (WASM) — deterministic seed per user
  const curve = Curve.SECP256K1;
  const seed = new TextEncoder().encode(`ski:dwallet:${userAddress}`);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
  const sessionIdentifier = createRandomSessionIdentifier();
  const dkgInput = await prepareDKGAsync(
    ikaClient, curve, userShareEncryptionKeys, sessionIdentifier, userAddress,
  );

  // Get network encryption key
  const encKey = await ikaClient.getLatestNetworkEncryptionKey();

  // Fetch keeper's gas coins for sponsorship
  const keeperCoins = await grpc.listCoins({ owner: keeperAddress, coinType: '0x2::sui::SUI' });
  if (!keeperCoins.objects.length) {
    return { success: false, error: 'Keeper has no SUI for gas' };
  }

  // Build the PTB
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.setGasOwner(keeperAddress);
  tx.setGasPayment(keeperCoins.objects.slice(0, 3).map(c => ({
    objectId: c.objectId,
    version: c.version,
    digest: c.digest,
  })));

  // Swap SUI→IKA via direct Cetus CLMM call in the same PTB.
  // The keeper's gas coins provide the SUI; output IKA is used for DKG fee.
  // Fallback: if keeper already holds IKA, use that directly.
  const keeperIkaCoins = await grpc.listCoins({ owner: keeperAddress, coinType: IKA_TYPE });
  let ikaCoin;

  if (keeperIkaCoins.objects.length > 0) {
    // Keeper has IKA buffer — use it directly (faster, no swap slippage)
    ikaCoin = tx.object(keeperIkaCoins.objects[0].objectId);
  } else {
    // No IKA on keeper — swap SUI→IKA via Cetus in this PTB
    // In the IKA/SUI pool, SUI is coinX and IKA is coinY (SUI→IKA = X→Y = a2b)
    const swapAmount = tx.splitCoins(tx.gas, [tx.pure.u64(500_000_000)]); // 0.5 SUI
    const swapAmountValue = tx.moveCall({
      target: '0x2::coin::value',
      typeArguments: [SUI_TYPE],
      arguments: [swapAmount],
    });
    const [zeroIka] = tx.moveCall({
      target: '0x2::coin::zero',
      typeArguments: [IKA_TYPE],
    });
    const [receiveA, receiveB] = tx.moveCall({
      target: `${CETUS_ROUTER}::router::swap`,
      typeArguments: [SUI_TYPE, IKA_TYPE],
      arguments: [
        tx.object(CETUS_GLOBAL_CONFIG),
        tx.object(CETUS_IKA_SUI_POOL),
        swapAmount,       // coin A (SUI in)
        zeroIka,          // coin B (zero — we're swapping A→B)
        tx.pure.bool(true),   // a_to_b = true (SUI→IKA)
        tx.pure.bool(true),   // by_amount_in = true (exact input)
        swapAmountValue,      // amount
        tx.pure.u128(MIN_SQRT_PRICE), // sqrt_price_limit for a→b
        tx.pure.bool(false),  // is_exact_out
        tx.object(SUI_CLOCK),
      ],
    });
    // receiveA = leftover SUI (dust), receiveB = IKA output
    // Return leftover SUI dust to keeper
    tx.transferObjects([receiveA], tx.pure.address(keeperAddress));
    ikaCoin = receiveB;
  }

  const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]); // 0.1 SUI for DKG gas reimbursement

  // DKG request — user is the sender, so DWalletCap goes to them
  const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });
  await ikaTx.registerEncryptionKey({ curve });

  const [dWalletCap] = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin,
    suiCoin,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });

  // DWalletCap stays with the sender (user) — no transfer needed

  // Build and sign as gas sponsor
  const txBytes = await tx.build({ client: grpc as any });
  const { signature: sponsorSig } = await keypair.signTransaction(txBytes);

  // Return base64 tx bytes + sponsor sig for the client to co-sign
  const b64 = btoa(String.fromCharCode(...txBytes));

  return {
    success: true,
    txBytes: b64,
    sponsorSig,
  };
}
