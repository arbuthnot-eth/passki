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

function nameHash(bareName: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(bareName.toLowerCase()));
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

  // XOR mask the AES key
  const mask = keccak_256(new TextEncoder().encode(recipientNftObjectId.toLowerCase()));
  const maskedKey = xorBytes(key, mask);

  // Build PTB — one move call, payload stored on-chain
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(senderAddress));
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'deposit',
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

/** Count pending thunder for a SuiNS name. */
export async function getThunderCount(recipientName: string): Promise<number> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'count',
    arguments: [tx.object(STORM_ID), tx.pure.vector('u8', Array.from(ns))],
  });
  try {
    const result = await gqlClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    const rv = (result as any)?.results?.[0]?.returnValues;
    if (!rv?.[0]) return 0;
    const bytes = new Uint8Array(rv[0][0]);
    let count = 0;
    for (let i = 0; i < Math.min(bytes.length, 8); i++) count += bytes[i] * (256 ** i);
    return count;
  } catch { return 0; }
}

// ─── Strike (batch) ──────────────────────────────────────────────────

/** Build a batched strike PTB — one tx claims N thunder. */
export async function buildBatchClaimTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
): Promise<Uint8Array> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(recipientAddress));
  for (let i = 0; i < count; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'claim',
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
export async function claimAndDecryptAll(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  signAndExecuteTransaction: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: any }>,
): Promise<ThunderPayload[]> {
  const txBytes = await buildBatchClaimTx(recipientAddress, recipientName, nftObjectId, count);
  const result = await signAndExecuteTransaction(txBytes);

  const struck = parseStruckEvents(result.effects ?? result);
  if (struck.length === 0) throw new Error('No Struck events in tx effects');

  // Decrypt all payloads in parallel
  return Promise.all(
    struck.map(async (s) => {
      const cleartext = await aesDecrypt(s.payload, s.aesKey, s.aesNonce);
      return JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
    }),
  );
}
