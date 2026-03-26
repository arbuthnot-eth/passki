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
import { deriveAddress, chainsForCurve, IkaCurve, type ChainConfig } from './chains.js';

let ikaClient: IkaClient | null = null;

function getClient(): IkaClient {
  if (!ikaClient) {
    // Dynamic import of SuiClient — Ika SDK expects @mysten/sui/client SuiClient
    // which may be re-exported or aliased in @mysten/sui v2
    const config = getNetworkConfig('mainnet');

    // Generic JSON-RPC proxy client — handles any method the IKA SDK calls.
    // Routes through /api/rpc (same-origin Worker proxy) to avoid CORS.
    const rpc = async (method: string, params: unknown[]) => {
      console.log(`[ika:rpc] ${method}`, params);
      const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      const json = await res.json() as { result?: unknown; error?: unknown };
      if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
      console.log(`[ika:rpc] ${method} → ok`);
      return json.result;
    };

    // Proxy object: intercepts any method call and routes to JSON-RPC.
    // Maps SuiClient method names to their JSON-RPC equivalents.
    const methodMap: Record<string, string> = {
      getObject: 'sui_getObject',
      multiGetObjects: 'sui_multiGetObjects',
      getOwnedObjects: 'suix_getOwnedObjects',
      getDynamicFields: 'suix_getDynamicFields',
      getNormalizedMoveFunction: 'sui_getNormalizedMoveFunction',
      getMoveFunction: 'sui_getNormalizedMoveFunction',
      getReferenceGasPrice: 'suix_getReferenceGasPrice',
      getCoins: 'suix_getCoins',
      dryRunTransactionBlock: 'sui_dryRunTransactionBlock',
      devInspectTransactionBlock: 'sui_devInspectTransactionBlock',
      executeTransactionBlock: 'sui_executeTransactionBlock',
    };

    const suiClientProxy = new Proxy({}, {
      get(_target, prop: string) {
        // Only intercept known RPC methods — return undefined for everything else
        // so the SDK can do normal property checks (typeof, in, etc.)
        if (!(prop in methodMap)) return undefined;
        return async (...args: any[]) => {
          const rpcMethod = methodMap[prop]!;
          // Flatten params based on method signature
          const p = args[0] ?? {};
          switch (prop) {
            case 'getObject':
              return rpc(rpcMethod, [p.id, p.options || { showContent: true, showBcs: true }]);
            case 'multiGetObjects':
              return rpc(rpcMethod, [p.ids, p.options || { showContent: true, showBcs: true }]);
            case 'getOwnedObjects':
              return rpc(rpcMethod, [p.owner, { filter: p.filter, options: p.options || { showContent: true, showBcs: true } }, p.cursor || null, p.limit || 50]);
            case 'getDynamicFields':
              return rpc(rpcMethod, [p.parentId, p.cursor || null, p.limit || 50]);
            case 'getNormalizedMoveFunction':
            case 'getMoveFunction':
              return rpc(rpcMethod, [p.package || p.packageId, p.module || p.moduleName, p.function || p.name || p.functionName]);
            case 'getReferenceGasPrice':
              return rpc(rpcMethod, []);
            case 'getCoins':
              return rpc(rpcMethod, [p.owner, p.coinType, p.cursor || null, p.limit || 50]);
            case 'dryRunTransactionBlock':
              return rpc(rpcMethod, [p.transactionBlock]);
            case 'devInspectTransactionBlock':
              return rpc(rpcMethod, [p.sender, p.transactionBlock, p.gasPrice || null, p.epoch || null]);
            case 'executeTransactionBlock':
              return rpc(rpcMethod, [p.transactionBlock, p.signature, p.options || { showEffects: true }, p.requestType || 'WaitForLocalExecution']);
            default:
              return rpc(rpcMethod, Array.isArray(args[0]) ? args[0] : [args[0]]);
          }
        };
      },
    });

    ikaClient = new IkaClient({
      config,
      suiClient: suiClientProxy as any,
    });
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
    const client = getClient();
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
  const client = getClient();
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

  // IKA coin: use keeper's existing IKA, or swap SUI→IKA via Cetus in the same PTB
  const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
  const SUI_TYPE = '0x2::sui::SUI';
  let ikaCoin;
  if (ikaCoins.length > 0) {
    ikaCoin = tx.object(ikaCoins[0].objectId);
  } else {
    // No IKA on keeper — swap SUI→IKA via Cetus CLMM in this PTB
    log('Swapping SUI→IKA via Cetus...');
    const CETUS_ROUTER = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d';
    const CETUS_GLOBAL_CONFIG = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
    const CETUS_IKA_SUI_POOL = '0xc23e7e8a74f0b18af4dfb7c3280e2a56916ec4d41e14416f85184a8aab6b7789';
    const SUI_CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006';
    const MIN_SQRT_PRICE = '4295048016';

    const swapAmount = tx.splitCoins(tx.gas, [tx.pure.u64(50_000_000)]); // 0.05 SUI (~$0.05 worth of IKA)
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
        swapAmount,
        zeroIka,
        tx.pure.bool(true),          // a_to_b (SUI→IKA)
        tx.pure.bool(true),          // by_amount_in
        swapAmountValue,
        tx.pure.u128(MIN_SQRT_PRICE),
        tx.pure.bool(false),
        tx.object(SUI_CLOCK),
      ],
    });
    // Return leftover SUI dust to keeper
    tx.transferObjects([receiveA], tx.pure.address(keeperAddress));
    ikaCoin = receiveB;
  }
  // SUI for DKG gas reimbursement (from keeper's gas coins)
  const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]);

  const ikaTx = new IkaTransaction({ ikaClient: client, transaction: tx, userShareEncryptionKeys });
  await ikaTx.registerEncryptionKey({ curve });

  const [dWalletCap] = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin,
    suiCoin,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });
  // DWalletCap stays with sender (user)

  // Step 5: Build bytes, get sponsor sig, user signs
  log('Signing transaction...');
  const txBytes = await tx.build({ client: client as any });

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
  const submitRes = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sui_executeTransactionBlock',
      params: [b64Tx, [userSig, sponsorSig], { showEffects: true }, 'WaitForLocalExecution'],
    }),
  });
  const submitJson = await submitRes.json() as any;
  const digest = submitJson?.result?.digest;
  if (!digest) throw new Error('DKG transaction failed: ' + JSON.stringify(submitJson?.error ?? submitJson));

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
      const client = getClient();
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
