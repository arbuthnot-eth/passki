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

let ikaClient: IkaClient | null = null;
let jsonRpcClient: SuiJsonRpcClient | null = null;

function getJsonRpc(): SuiJsonRpcClient {
  if (!jsonRpcClient) {
    // Point at our same-origin proxy — avoids CORS, routes to PublicNode/Mysten
    // network param is required for Move type resolution (MVR)
    jsonRpcClient = new SuiJsonRpcClient({ url: '/api/rpc', network: 'mainnet' });
  }
  return jsonRpcClient;
}

let initPromise: Promise<void> | null = null;

async function getClient(): Promise<IkaClient> {
  if (!ikaClient) {
    const config = getNetworkConfig('mainnet');
    const rpc = getJsonRpc();

    // IKA SDK expects a JSON-RPC SuiClient (getObject, multiGetObjects, etc.)
    // SuiJsonRpcClient is the real thing — no Proxy, no shims.
    ikaClient = new IkaClient({
      config,
      suiClient: rpc as any,
    });
    // Pre-fetch coordinator objects, encryption keys, and protocol state.
    // initialize() may partially fail on mainnet (SDK bug with table vector parsing)
    // but the cached data it does fetch still speeds up subsequent calls.
    if (!initPromise) {
      initPromise = ikaClient.initialize().catch((err) => {
        console.warn('[ika] initialize() partial failure (non-fatal):', err?.message?.slice(0, 100));
      });
    }
    await initPromise;
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
 * The IKA WASM returns BCS-encoded bytes; we strip the length prefix.
 */
async function extractPubkey(publicOutput: Uint8Array): Promise<Uint8Array> {
  const bcsEncodedKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
  // BCS encodes a vector<u8> with a ULEB128 length prefix. For 33 bytes, prefix is 0x21.
  return bcsEncodedKey.length === 33
    ? bcsEncodedKey
    : bcsEncodedKey.slice(bcsEncodedKey.length - 33);
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

  // Step 1: Check eligibility + get keeper info
  log('Checking SuiNS eligibility...');
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
  log('Preparing DKG cryptography...');
  const client = await getClient();
  const curve = Curve.SECP256K1;
  const seed = new TextEncoder().encode(`ski:dwallet:${userAddress}`);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
  const sessionIdentifier = createRandomSessionIdentifier();
  const dkgInput = await prepareDKGAsync(
    client, curve, userShareEncryptionKeys, sessionIdentifier, userAddress,
  );

  // Step 3: Get network encryption key
  log('Fetching network encryption key...');
  const encKey = await client.getLatestNetworkEncryptionKey();

  // Step 4: Build the PTB
  log('Building DKG transaction...');
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.setGasOwner(keeperAddress);
  tx.setGasPayment(suiCoins.slice(0, 3));

  // Fund user with IKA from keeper (if user doesn't have any)
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const SUI_TYPE = '0x2::sui::SUI';

  // Check if user already has IKA
  const userIkaCheck = await getJsonRpc().getCoins({ owner: userAddress, coinType: IKA_TYPE });
  let userIkaCoinId = (userIkaCheck as any)?.data?.[0]?.coinObjectId;

  if (!userIkaCoinId) {
    // Request IKA funding from keeper
    log('Funding IKA tokens...');
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
    userIkaCoinId = (recheck as any)?.data?.[0]?.coinObjectId;
    if (!userIkaCoinId) throw new Error('IKA funding succeeded but coin not found yet — try again');
  }

  let ikaCoin = tx.object(userIkaCoinId);

  const _ = SUI_TYPE; // keep import used
  // SUI for DKG gas reimbursement (from keeper's gas coins)
  const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]);

  const ikaTx = new IkaTransaction({ ikaClient: client, transaction: tx, userShareEncryptionKeys });
  // registerEncryptionKey returns a Move object the SDK doesn't consume,
  // causing UnusedValueWithoutDrop. Skip if first-time — the DKG call
  // handles key registration internally when needed.
  // TODO: check if already registered and only call when necessary
  // await ikaTx.registerEncryptionKey({ curve });

  const dkgResult = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin,
    suiCoin,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });
  // DKG returns [DWalletCap, Option<ID>] — transfer cap to user, drop the option
  tx.transferObjects([dkgResult[0]], tx.pure.address(userAddress));
  // Transfer leftover coins back to keeper (DKG takes coins by value but may not fully consume)
  tx.transferObjects([ikaCoin], tx.pure.address(keeperAddress));
  tx.transferObjects([suiCoin], tx.pure.address(keeperAddress));

  // Step 5: Build bytes, get sponsor sig, user signs
  log('Signing transaction...');
  const txBytes = await tx.build({ client: getJsonRpc() as any });

  // Get keeper's gas sponsor signature
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

  // User signs
  const { signature: userSig } = await callbacks.signTransaction(txBytes);

  // Step 6: Submit with both signatures
  log('Submitting DKG transaction...');
  const rpcSubmit = getJsonRpc();
  const execResult = await rpcSubmit.executeTransactionBlock({
    transactionBlock: btoa(String.fromCharCode(...txBytes)),
    signature: [userSig, sponsorSig],
    options: { showEffects: true },
    requestType: 'WaitForLocalExecution',
  }) as any;
  const digest = execResult?.digest;
  if (!digest) throw new Error('DKG transaction failed');

  log('DKG submitted! Waiting for dWallet activation...');

  // Step 7: Poll for dWallet to become active
  for (let i = 0; i < 24; i++) { // 2 minutes max
    await new Promise(r => setTimeout(r, 5000));
    const status = await getCrossChainStatus(userAddress);
    if (status.ika && status.btcAddress) {
      log('dWallet active!');
      return status;
    }
    log(`Waiting for activation... (${i + 1}/24)`);
  }

  // Return whatever we have even if not fully active yet
  return getCrossChainStatus(userAddress);
}

export async function getCrossChainStatus(address: string): Promise<CrossChainStatus> {
  const { hasDWallet, caps, count } = await checkExistingDWallets(address);
  let btcAddress = '';
  let ethAddress = '';
  let addresses: Array<{ chain: string; name: string; address: string }> = [];
  if (hasDWallet && caps[0]) {
    try {
      const client = await getClient();
      const dWallet = await client.getDWallet(caps[0].dwallet_id);
      const publicOutput = (dWallet as any)?.state?.Active?.public_output;
      if (publicOutput) {
        const output = new Uint8Array(publicOutput);
        addresses = await deriveAllAddresses(output);
        btcAddress = addresses.find(a => a.name === 'Bitcoin')?.address ?? '';
        ethAddress = addresses.find(a => a.name === 'Ethereum')?.address ?? '';
      }
    } catch {}
  }
  return {
    ika: hasDWallet,
    dwalletCount: count,
    dwalletId: hasDWallet && caps[0] ? caps[0].dwallet_id : '',
    btcAddress,
    ethAddress,
    addresses,
  };
}
