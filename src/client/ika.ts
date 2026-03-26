/**
 * Client-side Ika dWallet integration.
 *
 * Handles:
 *   - Checking for existing dWallets
 *   - Multi-chain address derivation (BTC, ETH, etc.)
 *   - DKG provisioning (WASM runs in browser, gas sponsored by keeper)
 */

import {
  IkaClient, IkaTransaction, getNetworkConfig,
  publicKeyFromDWalletOutput, Curve,
  UserShareEncryptionKeys, createRandomSessionIdentifier, prepareDKGAsync,
} from '@ika.xyz/sdk';
import type { DWalletCap } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { deriveAddress, chainsForCurve, IkaCurve, type ChainConfig } from './chains.js';
import { grpcClient } from '../rpc.js';

let ikaClient: IkaClient | null = null;
let jsonRpcClient: SuiJsonRpcClient | null = null;

function getJsonRpc(): SuiJsonRpcClient {
  if (!jsonRpcClient) {
    jsonRpcClient = new SuiJsonRpcClient({ url: '/api/rpc', network: 'mainnet' });
  }
  return jsonRpcClient;
}

let initPromise: Promise<void> | null = null;

async function getClient(): Promise<IkaClient> {
  if (!ikaClient) {
    const config = getNetworkConfig('mainnet');
    const rpc = getJsonRpc();

    // IKA SDK 0.3.1 calls client.core.getObjects/listOwnedObjects/listDynamicFields
    // These are v2 CoreClient methods — SuiGrpcClient implements them natively.
    ikaClient = new IkaClient({
      config,
      suiClient: grpcClient as any,
    });
    // Fire-and-forget initialize() — don't block on it.
    // It may fail (SDK bug with table vector parsing on mainnet) but
    // any data it caches still helps. The DKG flow lazy-fetches what it needs.
    if (!initPromise) {
      initPromise = ikaClient.initialize().catch((err) => {
        console.warn('[ika] initialize() partial failure (non-fatal):', err?.message?.slice(0, 100));
      });
    }
    // Don't await — let it run in background
  }
  return ikaClient;
}

/**
 * Check if the user has any existing dWallet capabilities.
 * Returns the first dWallet cap found, or null.
 */
export async function checkExistingDWallets(address: string): Promise<{
  hasDWallet: boolean;
  caps: DWalletCap[];
  count: number;
}> {
  try {
    const client = await getClient();
    const result = await client.getOwnedDWalletCaps(address, undefined, 10);
    return {
      hasDWallet: result.dWalletCaps.length > 0,
      caps: result.dWalletCaps,
      count: result.dWalletCaps.length,
    };
  } catch {
    // Ika network may not be reachable
    return { hasDWallet: false, caps: [], count: 0 };
  }
}

// ── Multi-chain address derivation ──────────────────────────────────

/**
 * Extract the raw compressed public key from a dWallet's public output.
 * Tries IKA WASM first, falls back to manual BCS extraction.
 */
async function extractPubkey(publicOutput: Uint8Array): Promise<Uint8Array> {
  try {
    const bcsEncodedKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
    return bcsEncodedKey.length === 33
      ? bcsEncodedKey
      : bcsEncodedKey.slice(bcsEncodedKey.length - 33);
  } catch {
    // WASM may fail — extract manually from public_output
    // Format: [version, 33, 02/03, ...32 bytes] — compressed secp256k1 pubkey
    if (publicOutput.length >= 35 && (publicOutput[2] === 2 || publicOutput[2] === 3) && publicOutput[1] === 33) {
      return publicOutput.slice(2, 35);
    }
    throw new Error('Could not extract public key from dWallet output');
  }
}

/**
 * Derive a chain-native address from a dWallet's public output.
 * Uses the chain registry to resolve curve params + derivation function.
 *
 * @example
 *   deriveChainAddress('btc', publicOutput)  // → 'bc1q...'
 *   deriveChainAddress('ethereum', pubOut)    // → '0x...' (when implemented)
 */
export async function deriveChainAddress(
  chainIdOrAlias: string,
  publicOutput: Uint8Array,
): Promise<string> {
  const rawPubkey = await extractPubkey(publicOutput);
  return deriveAddress(chainIdOrAlias, rawPubkey);
}

/** Convenience alias — derive Bitcoin address from dWallet public output. */
export async function deriveBtcAddress(publicOutput: Uint8Array): Promise<string> {
  return deriveChainAddress('btc', publicOutput);
}

/**
 * Get all chain addresses derivable from a single secp256k1 dWallet.
 * Returns only chains whose derivation is implemented.
 */
export async function deriveAllAddresses(
  publicOutput: Uint8Array,
): Promise<Array<{ chain: string; name: string; address: string }>> {
  const rawPubkey = await extractPubkey(publicOutput);
  const chains = chainsForCurve(IkaCurve.SECP256K1);
  const results: Array<{ chain: string; name: string; address: string }> = [];
  for (const chain of chains) {
    try {
      const address = chain.deriveAddress(rawPubkey);
      results.push({ chain: chain.caipId, name: chain.name, address });
    } catch {
      // Derivation not implemented for this chain — skip
    }
  }
  return results;
}

// ── Cross-chain status ──────────────────────────────────────────────

/**
 * Get cross-chain wallet info for display.
 */
export interface CrossChainStatus {
  ika: boolean;
  dwalletCount: number;
  dwalletId: string;
  btcAddress: string;
  ethAddress: string;
  /** All derivable addresses from this dWallet */
  addresses: Array<{ chain: string; name: string; address: string }>;
}

// ── DKG Provisioning (client-side) ──────────────────────────────────

export interface ProvisionCallbacks {
  /** Sign a transaction as the user (wallet popup). Returns base64 signature. */
  signTransaction: (txBytes: Uint8Array) => Promise<{ signature: string }>;
  /** WaaP: sign a personal message (proof of intent for server-side DKG). */
  signPersonalMessage?: (message: Uint8Array) => Promise<{ signature: string; bytes: string }>;
  /** Whether the wallet is WaaP (uses non-sponsored path). */
  isWaap?: boolean;
  /** Called with status updates during provisioning. */
  onStatus?: (msg: string) => void;
}

/**
 * Provision a new secp256k1 dWallet for the user.
 *
 * Flow:
 *   1. Check /api/ika/provision for SuiNS gate + keeper info
 *   2. Run DKG WASM in browser (prepareDKGAsync)
 *   3. Build PTB: DKG request with keeper as gas sponsor
 *   4. User signs as sender, keeper signs as gas owner via /api/sponsor-gas
 *   5. Submit with both signatures
 *   6. Poll for dWallet to reach Active state
 *
 * Returns the CrossChainStatus once the dWallet is active.
 */
export async function provisionDWallet(
  userAddress: string,
  callbacks: ProvisionCallbacks,
): Promise<CrossChainStatus> {
  const log = callbacks.onStatus ?? (() => {});
  console.log('[ika:dkg] provisionDWallet called for', userAddress, 'isWaap:', callbacks.isWaap);

  // Step 1: Check eligibility + get keeper info
  log('Checking...');
  const provRes = await fetch('/api/ika/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: userAddress }),
  });
  if (!provRes.ok) {
    const err = await provRes.json().catch(() => ({ error: 'Provision check failed' })) as { error?: string };
    throw new Error(err.error ?? 'Not eligible for sponsored DKG');
  }
  const { keeperAddress, suiCoins, ikaCoins } = await provRes.json() as {
    keeperAddress: string;
    suiCoins: Array<{ objectId: string; version: string; digest: string }>;
    ikaCoins: Array<{ objectId: string; version: string; digest: string }>;
  };

  if (!suiCoins.length) throw new Error('Keeper has no SUI for gas');

  // Step 2: Prepare DKG crypto (WASM — runs in browser)
  // This fetches 250+ encryption key objects — takes 1-3 minutes on first run
  log('Preparing (1-3 min)...');
  console.log('[ika:dkg] Step 2: prepareDKGAsync starting...');
  const client = await getClient();
  const curve = Curve.SECP256K1;
  // Random seed per attempt — deterministic seeds cause session conflicts on retry
  const seedBytes = new Uint8Array(32);
  crypto.getRandomValues(seedBytes);
  const seed = seedBytes;
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
  const sessionIdentifier = createRandomSessionIdentifier();
  const dkgInput = await prepareDKGAsync(
    client, curve, userShareEncryptionKeys, sessionIdentifier, userAddress,
  );
  console.log('[ika:dkg] Step 2: prepareDKGAsync DONE');

  // Step 3: Get network encryption key
  log('Fetching keys...');
  console.log('[ika:dkg] Step 3: getLatestNetworkEncryptionKey...');
  const encKey = await client.getLatestNetworkEncryptionKey();

  // Step 4: Build the PTB
  log('Building...');
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.setGasOwner(keeperAddress);
  tx.setGasPayment(suiCoins.slice(0, 3));

  // Fund user with IKA from keeper (if user doesn't have any)
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const SUI_TYPE = '0x2::sui::SUI';

  // Check if user already has IKA
  const userIkaCheck = await getJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
  let userIkaCoinId = (userIkaCheck as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;

  if (!userIkaCoinId) {
    // Request IKA funding from keeper
    log('Funding...');
    const fundRes = await fetch('/api/ika/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: userAddress }),
    });
    if (!fundRes.ok) {
      const err = await fundRes.json().catch(() => ({ error: 'Fund failed' })) as { error?: string };
      throw new Error(err.error ?? 'IKA funding failed');
    }
    // Wait a moment for the tx to be indexed
    await new Promise(r => setTimeout(r, 2000));
    // Re-fetch user's IKA coins
    const recheck = await getJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
    userIkaCoinId = (recheck as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;
    if (!userIkaCoinId) throw new Error('IKA funding succeeded but coin not found yet — try again');
  }

  let ikaCoin = tx.object(userIkaCoinId);

  const _ = SUI_TYPE; // keep import used
  // SUI for DKG gas reimbursement — use user's own SUI (not gas, which is keeper-owned)
  const userSuiCheck = await getJsonRpc().getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
  const userSuiCoinId = (userSuiCheck as any)?.data?.[0]?.coinObjectId;
  if (!userSuiCoinId) throw new Error('No SUI coins found');
  const suiCoin = tx.splitCoins(tx.object(userSuiCoinId), [tx.pure.u64(100_000_000)]);

  const ikaTx = new IkaTransaction({ ikaClient: client, transaction: tx, userShareEncryptionKeys });
  // Register encryption key in a SEPARATE transaction first
  // (must be finalized on-chain before DKG can reference it)
  log('Registering key...');
  const regTx = new Transaction();
  regTx.setSender(userAddress);
  regTx.setGasOwner(keeperAddress);
  regTx.setGasPayment(suiCoins.slice(0, 1));
  const regIkaTx = new IkaTransaction({ ikaClient: client, transaction: regTx, userShareEncryptionKeys });
  await regIkaTx.registerEncryptionKey({ curve });

  const regBytes = await regTx.build({ client: grpcClient as any });
  const regB64 = btoa(String.fromCharCode(...regBytes));
  const regSponsorRes = await fetch('/api/sponsor-gas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txBytes: regB64, senderAddress: userAddress }),
  });
  if (regSponsorRes.ok) {
    const { sponsorSig: regSponsorSig } = await regSponsorRes.json() as { sponsorSig: string };
    const { signature: regUserSig } = await callbacks.signTransaction(regBytes);
    try {
      await getJsonRpc().executeTransactionBlock({
        transactionBlock: regB64,
        signature: [regUserSig, regSponsorSig],
        options: { showEffects: true },
        requestType: 'WaitForLocalExecution',
      });
    } catch {
      // May already be registered — continue
    }
    // Wait for registration to finalize
    await new Promise(r => setTimeout(r, 2000));
  }

  // Now build the DKG transaction (encryption key is on-chain)
  log('Building...');
  const dkgTx = new Transaction();
  dkgTx.setSender(userAddress);
  dkgTx.setGasOwner(keeperAddress);
  // Re-fetch keeper coins (may have changed after reg tx)
  const refreshProv = await fetch('/api/ika/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: userAddress }),
  });
  const refreshData = await refreshProv.json() as any;
  dkgTx.setGasPayment((refreshData.suiCoins ?? suiCoins).slice(0, 3));

  const userSuiCheck2 = await getJsonRpc().getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
  const userSuiCoinId2 = (userSuiCheck2 as any)?.data?.[0]?.coinObjectId;
  const userIkaCheck2 = await getJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
  const userIkaCoinId2 = (userIkaCheck2 as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;

  const ikaCoin2 = dkgTx.object(userIkaCoinId2 || userIkaCoinId);
  const suiCoin2 = dkgTx.splitCoins(dkgTx.object(userSuiCoinId2 || userSuiCoinId), [dkgTx.pure.u64(100_000_000)]);

  const ikaTx2 = new IkaTransaction({ ikaClient: client, transaction: dkgTx, userShareEncryptionKeys });

  const dkgResult = await ikaTx2.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx2.registerSessionIdentifier(sessionIdentifier),
    ikaCoin: ikaCoin2,
    suiCoin: suiCoin2,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });
  // DKG returns [DWalletCap, Option<ID>] — transfer cap to user
  dkgTx.transferObjects([dkgResult[0]], dkgTx.pure.address(userAddress));
  // SUI split survives &mut borrow — send back to user
  dkgTx.transferObjects([suiCoin2], dkgTx.pure.address(userAddress));

  // Step 5: Sign and submit
  log('Signing...');
  let digest: string;

  if (callbacks.isWaap) {
    // WaaP path: user signs a personal message (proof of intent),
    // server (keeper) builds + signs + submits the DKG tx.
    // Uses shared dWallet (requestDWalletDKGWithPublicUserShare).
    log('Authorizing...');
    const authMessage = new TextEncoder().encode(
      `Authorize IKA dWallet creation for ${userAddress} at ${Date.now()}`
    );
    const { signature: authSig } = await callbacks.signPersonalMessage!(authMessage);

    log('Submitting...');
    const createRes = await fetch('/api/ika/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: userAddress,
        authSignature: authSig,
        dkgData: {
          userDKGMessage: Array.from(dkgInput.userDKGMessage),
          userSecretKeyShare: Array.from(dkgInput.userSecretKeyShare),
          userPublicOutput: Array.from(dkgInput.userPublicOutput),
          sessionIdentifier: Array.from(sessionIdentifier),
          encryptionKeyBytes: Array.from(userShareEncryptionKeys.encryptionKey),
          signingPublicKeyBytes: Array.from(userShareEncryptionKeys.getSigningPublicKeyBytes()),
          encryptionKeySignature: Array.from(await userShareEncryptionKeys.getEncryptionKeySignature()),
          curve: 0, // SECP256K1
        },
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ error: 'Create failed' })) as { error?: string };
      throw new Error(err.error ?? 'DKG creation failed');
    }
    const createResult = await createRes.json() as { digest?: string };
    digest = createResult.digest ?? '';
  } else {
    // Normal path: sponsored tx (Phantom/Backpack)
    const txBytes = await dkgTx.build({ client: grpcClient as any });
    const b64Tx = btoa(String.fromCharCode(...txBytes));
    const sponsorRes = await fetch('/api/sponsor-gas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txBytes: b64Tx, senderAddress: userAddress }),
    });
    if (!sponsorRes.ok) {
      const err = await sponsorRes.json().catch(() => ({ error: 'Sponsor signing failed' })) as { error?: string };
      throw new Error(err.error ?? 'Gas sponsorship failed');
    }
    const { sponsorSig } = await sponsorRes.json() as { sponsorSig: string };
    const { signature: userSig } = await callbacks.signTransaction(txBytes);

    log('Submitting...');
    const rpcSubmit = getJsonRpc();
    const execResult = await rpcSubmit.executeTransactionBlock({
      transactionBlock: b64Tx,
      signature: [userSig, sponsorSig],
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution',
    }) as any;
    digest = execResult?.digest ?? '';
  }

  if (!digest) throw new Error('DKG transaction failed');

  log('Activating...');

  // Step 7: Poll for dWallet to become active
  for (let i = 0; i < 24; i++) { // 2 minutes max
    await new Promise(r => setTimeout(r, 5000));
    const status = await getCrossChainStatus(userAddress);
    if (status.ika && status.btcAddress) {
      log('Active!');
      return status;
    }
    log(`Activating (${i + 1}/24)`);
  }

  // Return whatever we have even if not fully active yet
  return getCrossChainStatus(userAddress);
}

export async function getCrossChainStatus(address: string): Promise<CrossChainStatus> {
  let btcAddress = '';
  let ethAddress = '';
  let addresses: Array<{ chain: string; name: string; address: string }> = [];
  let dwalletId = '';
  let hasDWallet = false;

  try {
    // Use a fresh JSON-RPC client to avoid any cached/broken state
    const rpc = new SuiJsonRpcClient({ url: '/api/rpc', network: 'mainnet' });
    // Direct RPC check — bypass broken IKA SDK initialize()
    const DWALLET_CAP_TYPE = '0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317::coordinator_inner::DWalletCap';
    const owned = await rpc.getOwnedObjects({
      owner: address,
      filter: { StructType: DWALLET_CAP_TYPE },
      options: { showContent: true },
      limit: 1,
    });
    console.log('[ika:status] owned response:', JSON.stringify(owned).slice(0, 200));
    const cap = (owned as any)?.data?.[0]?.data;
    console.log('[ika:status] cap:', cap ? 'found' : 'null');
    if (cap) {
      hasDWallet = true;
      dwalletId = cap.content?.fields?.dwallet_id ?? '';

      // Fetch the dWallet object to get public_output
      if (dwalletId) {
        const dw = await rpc.getObject({ id: dwalletId, options: { showContent: true } });
        console.log('[ika:status] dw response:', JSON.stringify(dw).slice(0, 300));
        const state = (dw as any)?.data?.content?.fields?.state?.fields;
        // Check Active or AwaitingKeyHolderSignature (both have public_output)
        const publicOutput = state?.public_output;
        if (publicOutput && Array.isArray(publicOutput)) {
          const output = new Uint8Array(publicOutput);
          addresses = await deriveAllAddresses(output);
          btcAddress = addresses.find(a => a.name === 'Bitcoin')?.address ?? '';
          ethAddress = addresses.find(a => a.name === 'Ethereum')?.address ?? '';
        }
      }
    }
  } catch {}

  return {
    ika: hasDWallet,
    dwalletCount: hasDWallet ? 1 : 0,
    dwalletId,
    btcAddress,
    ethAddress,
    addresses,
  };
}
