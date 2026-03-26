/**
 * Client-side Ika dWallet integration.
 *
 * Checks for existing dWallet capabilities owned by the connected address
 * and reports cross-chain status. The actual DKG provisioning requires
 * IKA + SUI coins and runs through IkaTransaction on the server.
 */

import { IkaClient, getNetworkConfig, publicKeyFromDWalletOutput, Curve } from '@ika.xyz/sdk';
import type { DWalletCap } from '@ika.xyz/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';

let ikaClient: IkaClient | null = null;

function getClient(): IkaClient {
  if (!ikaClient) {
    // Dynamic import of SuiClient — Ika SDK expects @mysten/sui/client SuiClient
    // which may be re-exported or aliased in @mysten/sui v2
    const config = getNetworkConfig('mainnet');

    // Lazy-init with a fetch-only client for read operations
    ikaClient = new IkaClient({
      config,
      suiClient: {
        getObject: async (params: { id: string; options?: object }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_getObject',
              params: [params.id, params.options || { showContent: true, showBcs: true }],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        multiGetObjects: async (params: { ids: string[]; options?: object }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_multiGetObjects',
              params: [params.ids, params.options || { showContent: true, showBcs: true }],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        getOwnedObjects: async (params: {
          owner: string;
          filter?: object;
          cursor?: string;
          limit?: number;
          options?: object;
        }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getOwnedObjects',
              params: [
                params.owner,
                { filter: params.filter, options: params.options || { showContent: true, showBcs: true } },
                params.cursor || null,
                params.limit || 50,
              ],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        getDynamicFields: async (params: { parentId: string; cursor?: string; limit?: number }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getDynamicFields',
              params: [params.parentId, params.cursor || null, params.limit || 50],
            }),
          });
          const json = await res.json();
          return json.result;
        },
      } as any,
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

// ── Bitcoin address derivation ───────────────────────────────────────

/**
 * Derive a native SegWit (bech32) Bitcoin address from a dWallet's public output.
 *
 * Flow:
 *   1. Extract compressed secp256k1 pubkey from dWallet output (via IKA WASM)
 *   2. SHA256 → RIPEMD160 = pubkey hash (Hash160)
 *   3. Encode as bech32 witness v0 program → bc1q... address
 */
export async function deriveBtcAddress(publicOutput: Uint8Array): Promise<string> {
  // 1. Get raw compressed public key (33 bytes) from dWallet output
  const bcsEncodedKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
  // BCS encodes a vector<u8> with a ULEB128 length prefix. For 33 bytes, prefix is 0x21.
  const rawPubkey = bcsEncodedKey.length === 33
    ? bcsEncodedKey
    : bcsEncodedKey.slice(bcsEncodedKey.length - 33);

  // 2. Hash160 = RIPEMD160(SHA256(pubkey))
  const hash160 = ripemd160(sha256(rawPubkey));

  // 3. Encode as bech32 witness v0 program (P2WPKH → bc1q...)
  const words = bech32.toWords(hash160);
  words.unshift(0); // witness version 0
  return bech32.encode('bc', words);
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
}

export async function getCrossChainStatus(address: string): Promise<CrossChainStatus> {
  const { hasDWallet, caps, count } = await checkExistingDWallets(address);
  let btcAddress = '';
  if (hasDWallet && caps[0]) {
    try {
      const client = getClient();
      const dWallet = await client.getDWallet(caps[0].dwallet_id);
      const publicOutput = (dWallet as any)?.state?.Active?.public_output;
      if (publicOutput) {
        btcAddress = await deriveBtcAddress(new Uint8Array(publicOutput));
      }
    } catch {}
  }
  return {
    ika: hasDWallet,
    dwalletCount: count,
    dwalletId: hasDWallet && caps[0] ? caps[0].dwallet_id : '',
    btcAddress,
  };
}
