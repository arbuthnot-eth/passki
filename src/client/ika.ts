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
  UserShareEncryptionKeys, createRandomSessionIdentifier, prepareDKG, prepareDKGAsync,
} from '@ika.xyz/sdk';
import type { DWalletCap } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { deriveAddress, chainsForCurve, IkaCurve, type ChainConfig } from './chains.js';
import { grpcClient, gqlClient, jsonRpcClient } from '../rpc.js';

let ikaClient: IkaClient | null = null;

/** JSON-RPC via same-origin proxy — used for getCoins, executeTransactionBlock */
let localJsonRpc: SuiJsonRpcClient | null = null;
function getLocalJsonRpc(): SuiJsonRpcClient {
  if (!localJsonRpc) {
    localJsonRpc = new SuiJsonRpcClient({ url: '/api/rpc', network: 'mainnet' });
  }
  return localJsonRpc;
}

let initPromise: Promise<void> | null = null;

async function getClient(): Promise<IkaClient> {
  if (!ikaClient) {
    const config = getNetworkConfig('mainnet');

    // Race all three transports — first one to initialize() wins.
    // gRPC has pagination bug, GraphQL hung before, JSON-RPC works but sunsets April 2026.
    // Promise.any takes the first success; if all fail, we get AggregateError.
    if (!initPromise) {
      const transports = [
        { name: 'GraphQL', client: gqlClient },
        { name: 'gRPC', client: grpcClient },
        { name: 'JSON-RPC', client: jsonRpcClient },
      ];

      initPromise = Promise.any(
        transports.map(async ({ name, client: suiClient }) => {
          const candidate = new IkaClient({ config, suiClient: suiClient as any });
          await candidate.initialize();
          console.log(`[ika] initialize() succeeded with ${name}`);
          ikaClient = candidate;
        }),
      ).catch((aggErr) => {
        // All three failed — use JSON-RPC anyway (known to partially work)
        console.warn('[ika] All transports failed initialize():', aggErr.errors?.map((e: any) => e?.message?.slice(0, 80)));
        ikaClient = new IkaClient({ config, suiClient: jsonRpcClient as any });
        return ikaClient.initialize().catch((err) => {
          console.warn('[ika] JSON-RPC fallback partial failure (non-fatal):', err?.message?.slice(0, 120));
        });
      });
    }
  }
  await initPromise;
  return ikaClient!;
}

// ── IKA mainnet encryption key constants ────────────────────────────
// The SDK's fetchEncryptionKeysFromNetwork crashes because it tries to read
// ALL 242 reconfiguration outputs (some pruned). We bypass it by reading
// the specific TableVec data we need directly.
const IKA_ENC_KEY = {
  id: '0x0a9c0b88a5c729378bce1a98a8c285f1dde26f89e53d07164dba8a059dc15587',
  epoch: 1,
  networkDKGOutputTableId: '0xaf474872701d540e9bd02bcac57e1708e8b735bbb8795905ac1a2a4f07e5bf1e',
  // Latest valid reconfiguration output (key=242 from reconfiguration_public_outputs)
  reconfigOutputTableId: '0x751cf7d555e3eac20d717422e75775b593a261e63f65687fb562a9387ae30ae8',
};

/**
 * Bypass the SDK's broken getProtocolPublicParameters.
 * Reads the two TableVec objects directly and calls WASM to convert.
 */
async function getProtocolPublicParametersDirect(
  _client: IkaClient,
  curve: typeof Curve.SECP256K1,
): Promise<Uint8Array> {
  console.log('[ika:dkg] Bypassing SDK — reading TableVec data directly...');

  // Use gRPC for TableVec reads — fast binary protocol, no query size limit.
  // readTableVecAsRawBytes uses hasNextPage (not the broken cursor===cursor pattern)
  // so gRPC pagination works fine here. GraphQL hits 5KB query payload limit.
  const config = getNetworkConfig('mainnet');
  const readerClient = new IkaClient({ config, suiClient: grpcClient as any });
  await readerClient.initialize().catch(() => {}); // non-fatal
  const reader = readerClient as any;

  console.log('[ika:dkg] Reading network DKG public output (JSON-RPC)...');
  const networkDkgOutput = await reader.readTableVecAsRawBytes(IKA_ENC_KEY.networkDKGOutputTableId);
  console.log('[ika:dkg] Network DKG output:', networkDkgOutput.length, 'bytes');

  console.log('[ika:dkg] Reading reconfiguration public output (JSON-RPC)...');
  const reconfigOutput = await reader.readTableVecAsRawBytes(IKA_ENC_KEY.reconfigOutputTableId);
  console.log('[ika:dkg] Reconfig output:', reconfigOutput.length, 'bytes');

  console.log('[ika:dkg] Converting to protocol public parameters (WASM)...');
  const crypto = await import('../../node_modules/@ika.xyz/sdk/dist/esm/client/cryptography.js');
  const params = await crypto.reconfigurationPublicOutputToProtocolPublicParameters(
    curve, reconfigOutput, networkDkgOutput,
  );
  console.log('[ika:dkg] Protocol public parameters:', params.length, 'bytes');
  return params;
}

/** Race a promise against a timeout. Rejects with a clear message on expiry. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
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
  /** Sign AND execute a transaction (WaaP needs this — server-side execution). */
  signAndExecuteTransaction: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: unknown }>;
  /** Whether the wallet is WaaP (uses signAndExecuteTransaction, non-sponsored). */
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
  console.log('[ika:dkg] Step 1: /api/ika/provision...');
  const provRes = await fetch('/api/ika/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: userAddress }),
  });
  if (!provRes.ok) {
    const err = await provRes.json().catch(() => ({ error: 'Provision check failed' })) as { error?: string };
    throw new Error(err.error ?? 'Not eligible for sponsored DKG');
  }
  const { keeperAddress, suiCoins } = await provRes.json() as {
    keeperAddress: string;
    suiCoins: Array<{ objectId: string; version: string; digest: string }>;
    ikaCoins: Array<{ objectId: string; version: string; digest: string }>;
  };
  console.log('[ika:dkg] Step 1: OK — keeper:', keeperAddress, 'suiCoins:', suiCoins.length);

  if (!suiCoins.length) throw new Error('Keeper has no SUI for gas');

  // Step 2: Prepare DKG crypto
  // Split into sub-steps so we can see exactly where it hangs:
  //   2a. IKA client init
  //   2b. getProtocolPublicParameters (network — fetches 250+ objects)
  //   2c. prepareDKG (WASM — pure crypto, no network)
  log('Preparing...');
  console.log('[ika:dkg] Step 2a: getClient + initialize...');
  const client = await withTimeout(getClient(), 60_000, 'IKA client init');
  console.log('[ika:dkg] Step 2a: client ready');

  const curve = Curve.SECP256K1;
  const seedBytes = new Uint8Array(32);
  crypto.getRandomValues(seedBytes);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seedBytes, curve);
  const sessionIdentifier = createRandomSessionIdentifier();

  // Skip SDK's getProtocolPublicParameters — it hangs with GraphQL/gRPC (pagination bug)
  // and fails with JSON-RPC (pruned reconfiguration objects). Read TableVec data directly.
  console.log('[ika:dkg] Step 2b: getProtocolPublicParameters (direct bypass)...');
  log('Fetching params...');
  const protocolPublicParameters = await getProtocolPublicParametersDirect(client, curve);
  console.log('[ika:dkg] Step 2b: got protocolPublicParameters, length:', protocolPublicParameters.length);

  console.log('[ika:dkg] Step 2c: prepareDKG (WASM crypto)...');
  log('Computing DKG...');
  const dkgInput = await prepareDKG(
    protocolPublicParameters, curve, userShareEncryptionKeys.encryptionKey,
    sessionIdentifier, userAddress,
  );
  console.log('[ika:dkg] Step 2c: prepareDKG DONE');

  // Step 3: Network encryption key — use known ID (SDK's getLatestNetworkEncryptionKey
  // calls fetchEncryptionKeysFromNetwork which hangs with GraphQL/gRPC)
  console.log('[ika:dkg] Step 3: using known encryption key ID');
  const encKey = { id: IKA_ENC_KEY.id };
  console.log('[ika:dkg] Step 3: encKey id:', encKey.id);

  // Step 4: Build the PTB — unified path for ALL wallets (WaaP + Phantom + Backpack)
  log('Building...');
  console.log('[ika:dkg] Step 4: building transactions...');
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

  // Check if user already has IKA
  const userIkaCheck = await getLocalJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
  let userIkaCoinId = (userIkaCheck as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;
  console.log('[ika:dkg] Step 4: user IKA coin:', userIkaCoinId ?? 'none');

  if (!userIkaCoinId) {
    log('Funding...');
    console.log('[ika:dkg] Step 4: requesting IKA funding...');
    const fundRes = await fetch('/api/ika/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: userAddress }),
    });
    if (!fundRes.ok) {
      const err = await fundRes.json().catch(() => ({ error: 'Fund failed' })) as { error?: string };
      throw new Error(err.error ?? 'IKA funding failed');
    }
    await new Promise(r => setTimeout(r, 2000));
    const recheck = await getLocalJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
    userIkaCoinId = (recheck as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;
    if (!userIkaCoinId) throw new Error('IKA funding succeeded but coin not found yet — try again');
    console.log('[ika:dkg] Step 4: funded, IKA coin:', userIkaCoinId);
  }

  // SUI for DKG gas reimbursement — use user's own SUI
  const userSuiCheck = await getLocalJsonRpc().getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
  const userSuiCoinId = (userSuiCheck as any)?.data?.[0]?.coinObjectId;
  if (!userSuiCoinId) throw new Error('No SUI coins found');
  console.log('[ika:dkg] Step 4: user SUI coin:', userSuiCoinId);

  if (callbacks.isWaap) {
    // ── WaaP: combine reg + DKG into single tx (one signAndExecuteTransaction call) ──
    // WaaP's signAndExecuteTransaction is intermittently broken (re-serialization bug).
    // Combining into one tx avoids: separate reg tx failing + indexer timing + coin staleness.
    log('Building tx...');
    console.log('[ika:dkg] Step 4: WaaP — building combined reg+DKG transaction...');

    const dkgTx = new Transaction();
    dkgTx.setSender(userAddress);

    const ikaCoin2 = dkgTx.object(userIkaCoinId);
    // Split from gas coin — don't reference the SUI coin explicitly or builder
    // can't also use it for gas (only 1 SUI coin, causes "insufficient balance")
    const suiCoin2 = dkgTx.splitCoins(dkgTx.gas, [dkgTx.pure.u64(100_000_000)]);

    const ikaTx2 = new IkaTransaction({ ikaClient: client, transaction: dkgTx, userShareEncryptionKeys });

    // Register encryption key + DKG in same PTB — sequential execution within tx
    await ikaTx2.registerEncryptionKey({ curve });

    const dkgResult = await ikaTx2.requestDWalletDKG({
      curve,
      dkgRequestInput: dkgInput,
      sessionIdentifier: ikaTx2.registerSessionIdentifier(sessionIdentifier),
      ikaCoin: ikaCoin2,
      suiCoin: suiCoin2,
      dwalletNetworkEncryptionKeyId: encKey.id,
    });
    dkgTx.transferObjects([dkgResult[0]], dkgTx.pure.address(userAddress));
    dkgTx.transferObjects([suiCoin2], dkgTx.pure.address(userAddress));

    log('Signing...');
    console.log('[ika:dkg] Step 5: WaaP — building + signAndExecuteTransaction...');
    // Match working WaaP tx pattern: gRPC first, GraphQL fallback
    let txBytes: Uint8Array;
    try {
      txBytes = await dkgTx.build({ client: grpcClient as never });
    } catch {
      txBytes = await dkgTx.build({ client: gqlClient as never });
    }
    const execResult = await callbacks.signAndExecuteTransaction(txBytes);
    const digest = execResult.digest ?? '';
    console.log('[ika:dkg] Step 5: WaaP exec result digest:', digest);

    if (!digest) {
      console.error('[ika:dkg] DKG tx failed — no digest');
      throw new Error('DKG transaction failed — no digest returned');
    }

    log('Activating...');
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const status = await getCrossChainStatus(userAddress);
      if (status.ika && status.btcAddress) {
        log('Active!');
        return status;
      }
      log(`Activating (${i + 1}/24)`);
    }
    return getCrossChainStatus(userAddress);
  }

  // ── Phantom/Backpack: separate reg tx (sponsored) then DKG tx ──
  log('Registering key...');
  console.log('[ika:dkg] Step 4a: register encryption key tx...');
  {
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
        await getLocalJsonRpc().executeTransactionBlock({
          transactionBlock: regB64,
          signature: [regUserSig, regSponsorSig],
          options: { showEffects: true },
          requestType: 'WaitForLocalExecution',
        });
      } catch (regErr) {
        console.warn('[ika:dkg] Step 4a: registration tx failed (may already exist):', regErr);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── Build the DKG transaction (Phantom/Backpack) ──
  log('Building DKG tx...');
  console.log('[ika:dkg] Step 4b: building DKG transaction...');

  const userSuiCheck2 = await getLocalJsonRpc().getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
  const userSuiCoinId2 = (userSuiCheck2 as any)?.data?.[0]?.coinObjectId;
  const userIkaCheck2 = await getLocalJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
  const userIkaCoinId2 = (userIkaCheck2 as any)?.data?.find((c: any) => BigInt(c.balance || '0') > 0n)?.coinObjectId;

  const dkgTx = new Transaction();
  dkgTx.setSender(userAddress);
  const refreshProv = await fetch('/api/ika/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: userAddress }),
  });
  const refreshData = await refreshProv.json() as any;
  dkgTx.setGasOwner(keeperAddress);
  dkgTx.setGasPayment((refreshData.suiCoins ?? suiCoins).slice(0, 3));

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
  dkgTx.transferObjects([dkgResult[0]], dkgTx.pure.address(userAddress));
  dkgTx.transferObjects([suiCoin2], dkgTx.pure.address(userAddress));

  // Step 5: Sign and submit (Phantom/Backpack — sponsored)
  log('Signing...');
  let digest: string;
  {
    // Phantom/Backpack: sponsored tx (two signatures)
    console.log('[ika:dkg] Step 5: building sponsored tx bytes...');
    const txBytes = await dkgTx.build({ client: grpcClient as any });
    const b64Tx = btoa(String.fromCharCode(...txBytes));

    console.log('[ika:dkg] Step 5: requesting sponsor sig...');
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

    console.log('[ika:dkg] Step 5: requesting user sig...');
    const { signature: userSig } = await callbacks.signTransaction(txBytes);
    console.log('[ika:dkg] Step 5: user signed, sig length:', userSig.length);

    log('Submitting...');
    console.log('[ika:dkg] Step 5: submitting with both sigs...');
    const rpcSubmit = getLocalJsonRpc();
    const execResult = await rpcSubmit.executeTransactionBlock({
      transactionBlock: b64Tx,
      signature: [userSig, sponsorSig],
      options: { showEffects: true },
      requestType: 'WaitForLocalExecution',
    }) as any;
    digest = execResult?.digest ?? '';
    console.log('[ika:dkg] Step 5: exec result digest:', digest, 'status:', execResult?.effects?.status?.status);
  }

  if (!digest) {
    console.error('[ika:dkg] DKG tx failed — no digest');
    throw new Error('DKG transaction failed — no digest returned');
  }

  log('Activating...');

  // Step 6: Poll for dWallet to become active
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
    const rpc = getLocalJsonRpc();
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
