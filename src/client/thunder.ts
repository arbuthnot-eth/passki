/**
 * Thunder client — encrypt messaging between SuiNS identities.
 *
 * Send: generate AES key → encrypt payload → store blob on Walrus →
 *       deposit blob_id + AES key + nonce in Thunder.in (on-chain).
 * Receive: strike Thunder.in (NFT-gated) → get AES key + nonce →
 *          fetch blob from Walrus → AES decrypt.
 *
 * The Move contract IS the access control — no external key servers.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  THUNDER_IN_ID,
  type ThunderPayload,
} from './thunder-types.js';

// ─── Walrus HTTP ─────────────────────────────────────────────────────

const WALRUS_PUBLISHER = 'https://publisher.walrus-mainnet.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space';

async function walrusWrite(data: Uint8Array, epochs = 5): Promise<string> {
  const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs?epochs=${epochs}`, {
    method: 'PUT',
    body: data,
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Walrus write failed: ${res.status}`);
  const json = await res.json() as Record<string, unknown>;
  const newlyCreated = json.newlyCreated as { blobObject?: { blobId?: string } } | undefined;
  const alreadyCertified = json.alreadyCertified as { blobId?: string } | undefined;
  const blobId = newlyCreated?.blobObject?.blobId ?? alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus write: no blobId in response');
  return blobId;
}

async function walrusRead(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
  if (!res.ok) throw new Error(`Walrus read failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ─── Name hash (keccak256 to match Move contract) ────────────────────

function nameHash(bareName: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(bareName.toLowerCase()));
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

// ─── Send a Thunder ──────────────────────────────────────────────────

/**
 * Encrypt a Thunder message and store on Walrus.
 * Returns blobId, nameHashBytes, aesKey, aesNonce for the on-chain deposit.
 */
export async function encryptThunder(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  message: string,
  suiamiToken?: string,
): Promise<{ blobId: string; nameHashBytes: Uint8Array; aesKey: Uint8Array; aesNonce: Uint8Array }> {
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
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

  // AES encrypt
  const { ciphertext, key, nonce } = await aesEncrypt(payloadBytes);

  // Write ciphertext to Walrus
  const blobId = await walrusWrite(ciphertext);

  return { blobId, nameHashBytes: ns, aesKey: key, aesNonce: nonce };
}

/**
 * Build the on-chain deposit tx. Stores blob_id + AES key + nonce in Thunder.in.
 * The AES key is on-chain but only retrievable via strike (NFT-gated).
 */
export async function buildThunderDepositTx(
  senderAddress: string,
  nameHashBytes: Uint8Array,
  blobId: string,
  aesKey: Uint8Array,
  aesNonce: Uint8Array,
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(senderAddress));
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'deposit',
    arguments: [
      tx.object(THUNDER_IN_ID),
      tx.pure.vector('u8', Array.from(nameHashBytes)),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(blobId))),
      tx.pure.vector('u8', Array.from(aesKey)),
      tx.pure.vector('u8', Array.from(aesNonce)),
      tx.object('0x6'), // Clock
    ],
  });
  return tx.build({ client: gqlClient as never });
}

// ─── Query Thunder.in ────────────────────────────────────────────────

/**
 * Count pending thunders for a SuiNS name.
 */
export async function getThunderCount(recipientName: string): Promise<number> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  const tx = new Transaction();
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'count',
    arguments: [
      tx.object(THUNDER_IN_ID),
      tx.pure.vector('u8', Array.from(ns)),
    ],
  });

  try {
    const result = await gqlClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    const returnValues = (result as any)?.results?.[0]?.returnValues;
    if (!returnValues?.[0]) return 0;
    const bytes = new Uint8Array(returnValues[0][0]);
    let count = 0;
    for (let i = 0; i < Math.min(bytes.length, 8); i++) {
      count += bytes[i] * (256 ** i);
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Peek at the first thunder's blob_id + timestamp (no key revealed).
 */
export async function peekThunder(recipientName: string): Promise<{ blobId: Uint8Array; timestampMs: number } | null> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  const tx = new Transaction();
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'peek',
    arguments: [
      tx.object(THUNDER_IN_ID),
      tx.pure.vector('u8', Array.from(ns)),
    ],
  });

  try {
    const result = await gqlClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    const returnValues = (result as any)?.results?.[0]?.returnValues;
    if (!returnValues?.[0]) return null;
    return {
      blobId: new Uint8Array(returnValues[0][0]),
      timestampMs: Number(new Uint8Array(returnValues[1][0]).reduce((a: number, b: number, i: number) => a + b * 256 ** i, 0)),
    };
  } catch {
    return null;
  }
}

// ─── Strike (decrypt) ────────────────────────────────────────────────

/**
 * Strike — execute the on-chain tx to claim the AES key, then fetch + decrypt the blob.
 * Requires signing the strike tx (proves NFT ownership).
 */
export async function buildStrikeTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
): Promise<Uint8Array> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(recipientAddress));
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'strike',
    arguments: [
      tx.object(THUNDER_IN_ID),
      tx.pure.vector('u8', Array.from(ns)),
      tx.object(nftObjectId),
    ],
  });
  return tx.build({ client: gqlClient as never });
}

/**
 * After striking, parse the ThunderStruck event from tx effects to get the blob_id.
 * Then use strike_view via devInspect to get the AES key + nonce (before the bolt is removed).
 *
 * Alternative approach: call strike_view first (devInspect — read-only, returns key material),
 * then execute strike (actually removes the bolt).
 */
export async function decryptThunder(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  signAndExecuteTransaction: (txBytes: Uint8Array) => Promise<{ digest: string }>,
): Promise<ThunderPayload> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  // 1. Use devInspect with strike_view to read key material (doesn't mutate)
  //    Note: devInspect simulates the tx, so we get return values without executing
  const viewTx = new Transaction();
  viewTx.setSender(normalizeSuiAddress(recipientAddress));
  viewTx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'strike_view',
    arguments: [
      viewTx.object(THUNDER_IN_ID),
      viewTx.pure.vector('u8', Array.from(ns)),
      viewTx.object(nftObjectId),
    ],
  });

  const inspectResult = await gqlClient.devInspectTransactionBlock({
    transactionBlock: viewTx,
    sender: normalizeSuiAddress(recipientAddress),
  });

  const returnValues = (inspectResult as any)?.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length < 3) {
    throw new Error('strike_view returned no key material');
  }

  const blobIdBytes = new Uint8Array(returnValues[0][0]);
  const aesKey = new Uint8Array(returnValues[1][0]);
  const aesNonce = new Uint8Array(returnValues[2][0]);
  const blobId = new TextDecoder().decode(blobIdBytes);

  // 2. Execute the real strike tx to remove the bolt from on-chain
  const strikeTxBytes = await buildStrikeTx(recipientAddress, recipientName, nftObjectId);
  await signAndExecuteTransaction(strikeTxBytes);

  // 3. Fetch encrypt blob from Walrus
  const ciphertext = await walrusRead(blobId);

  // 4. AES decrypt
  const cleartext = await aesDecrypt(ciphertext, aesKey, aesNonce);

  return JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
}
