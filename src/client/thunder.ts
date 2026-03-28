/**
 * Thunder client — encrypt messaging between SuiNS identities.
 *
 * Send: AES encrypt → deposit payload + masked key on-chain (one PTB).
 * Receive: batch strike (one PTB) → parse Struck events →
 *          AES decrypt all payloads from events directly.
 *
 * No external storage — the encrypt payload lives on-chain in the
 * ThunderBolt struct, removed on strike. The contract IS the access control.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  STORM_ID,
  type ThunderPayload,
} from './thunder-types.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Hash the full domain with .sui — matches the Move contract's keccak256(nft.domain().to_string()). */
function nameHash(name: string): Uint8Array {
  const full = name.toLowerCase().replace(/\.sui$/, '') + '.sui';
  return keccak_256(new TextEncoder().encode(full));
}

function xorBytes(data: Uint8Array, mask: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] ^ mask[i % mask.length];
  return result;
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────

async function aesEncrypt(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; key: Uint8Array; nonce: Uint8Array }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));
  return { ciphertext, key, nonce };
}

async function aesDecrypt(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
}

// ─── Recipient NFT lookup ────────────────────────────────────────────

/** Look up the SuinsRegistration NFT object ID for a name via SuiNS. */
export async function lookupRecipientNftId(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const suinsClient = new SuinsClient({ client: gqlClient as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.nftId ?? null;
  } catch { return null; }
}

// ─── Send ────────────────────────────────────────────────────────────

/**
 * Build the full Thunder send PTB — AES encrypt + deposit in one tx.
 * Returns tx bytes ready for signing.
 */
export async function buildThunderSendTx(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  recipientNftObjectId: string,
  message: string,
  suiamiToken?: string,
): Promise<Uint8Array> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  // Build payload
  const payload: ThunderPayload = {
    v: THUNDER_VERSION,
    sender: senderName,
    senderAddress: normalizeSuiAddress(senderAddress),
    message,
    timestamp: new Date().toISOString(),
    ...(suiamiToken ? { suiami: suiamiToken } : {}),
  };

  // AES encrypt
  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));

  // XOR mask the AES key — hash raw 32 bytes of the NFT object ID (matches Move's object::id().to_bytes())
  const nftHex = recipientNftObjectId.toLowerCase().replace(/^0x/, '');
  const nftRawBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) nftRawBytes[i] = parseInt(nftHex.slice(i * 2, i * 2 + 2), 16);
  const mask = keccak_256(nftRawBytes);
  const maskedKey = xorBytes(key, mask);

  // Build PTB — one move call, payload stored on-chain
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(senderAddress));
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'bolt',
    arguments: [
      tx.object(STORM_ID),
      tx.pure.vector('u8', Array.from(ns)),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(maskedKey)),
      tx.pure.vector('u8', Array.from(nonce)),
      tx.object('0x6'),
    ],
  });
  return tx.build({ client: gqlClient as never });
}

// ─── Query ───────────────────────────────────────────────────────────

const RPC_URL = 'https://sui-rpc.publicnode.com';

/** Count pending strikes for a SuiNS name by querying the Cloud dynamic field directly. */
export async function getThunderCount(recipientName: string): Promise<number> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  try {
    // Find the dynamic field keyed by this name hash
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getDynamicFieldObject',
        params: [STORM_ID, { type: 'vector<u8>', value: Array.from(ns) }],
      }),
    });
    const json = await res.json() as any;
    const cloud = json?.result?.data?.content?.fields?.value?.fields;
    if (!cloud?.strikes) return 0;
    return Array.isArray(cloud.strikes) ? cloud.strikes.length : 0;
  } catch { return 0; }
}

// ─── Strike (batch) ──────────────────────────────────────────────────

/** Build a batched quest PTB — one tx claims N thunder.
 *  If sponsorAddress is provided, sets it as gas owner (2-sig sponsored tx). */
export async function buildBatchQuestTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  sponsorAddress?: string,
): Promise<Uint8Array> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(recipientAddress));
  if (sponsorAddress) {
    tx.setGasOwner(normalizeSuiAddress(sponsorAddress));
  }
  for (let i = 0; i < count; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'quest',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.object(nftObjectId),
      ],
    });
  }
  return tx.build({ client: gqlClient as never });
}

/** Parse Struck events from tx effects. */
function parseStruckEvents(effects: any): Array<{ payload: Uint8Array; aesKey: Uint8Array; aesNonce: Uint8Array }> {
  const results: Array<{ payload: Uint8Array; aesKey: Uint8Array; aesNonce: Uint8Array }> = [];
  const rawEvents = effects?.events ?? [];
  for (const evt of rawEvents) {
    if (!evt?.type?.includes('::thunder::Struck')) continue;
    const fields = evt.parsedJson ?? evt.json ?? {};
    results.push({
      payload: new Uint8Array(fields.payload ?? []),
      aesKey: new Uint8Array(fields.aes_key ?? []),
      aesNonce: new Uint8Array(fields.aes_nonce ?? []),
    });
  }
  return results;
}

/**
 * Strike all pending thunder in one PTB, then decrypt all payloads.
 * One wallet signature. Returns all decrypted messages.
 */
export async function decryptAndQuest(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  executeTx: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: any }>,
  sponsorAddress?: string,
): Promise<ThunderPayload[]> {
  const txBytes = await buildBatchQuestTx(recipientAddress, recipientName, nftObjectId, count, sponsorAddress);
  const result = await executeTx(txBytes);

  // Try parsing events from wallet response first
  let struck = parseStruckEvents(result.effects ?? result);

  // If no events found, fetch tx details from RPC (wallet may not return events)
  if (struck.length === 0 && result.digest) {
    // Wait briefly for tx to be indexed
    await new Promise(r => setTimeout(r, 2000));
    const txRes = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_getTransactionBlock',
        params: [result.digest, { showEvents: true, showEffects: true }],
      }),
    });
    const txJson = await txRes.json() as any;
    struck = parseStruckEvents(txJson?.result ?? {});
  }

  if (struck.length === 0) throw new Error('No Struck events in tx effects');

  // Decrypt all payloads in parallel — skip any that fail (bad key from old deploys)
  const results: ThunderPayload[] = [];
  await Promise.all(
    struck.map(async (s) => {
      try {
        const cleartext = await aesDecrypt(s.payload, s.aesKey, s.aesNonce);
        results.push(JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload);
      } catch { /* skip — likely stale strike from old deploy */ }
    }),
  );
  return results;
}
