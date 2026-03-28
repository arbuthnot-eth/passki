/**
 * Thunder client — encrypt messaging between SuiNS identities.
 *
 * Send: AES encrypt → Walrus blob → deposit (masked key + blobId) on-chain.
 * Receive: batch strike (one PTB, N bolts) → parse ThunderStruck events →
 *          fetch blobs from Walrus in parallel → AES decrypt all.
 *
 * The Move contract IS the access control — no external key servers.
 * AES keys are XOR-masked with keccak256(nft_object_id) on-chain.
 * strike un-XORs and emits the real key in ThunderStruck events.
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
  return newlyCreated?.blobObject?.blobId ?? alreadyCertified?.blobId ?? (() => { throw new Error('Walrus: no blobId'); })();
}

async function walrusRead(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
  if (!res.ok) throw new Error(`Walrus read failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

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
 * Encrypt a Thunder and store on Walrus.
 * Returns masked key material for the on-chain deposit.
 */
export async function encryptThunder(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  recipientNftObjectId: string,
  message: string,
  suiamiToken?: string,
): Promise<{ blobId: string; nameHashBytes: Uint8Array; maskedAesKey: Uint8Array; aesNonce: Uint8Array }> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  const payload: ThunderPayload = {
    v: THUNDER_VERSION,
    sender: senderName,
    senderAddress: normalizeSuiAddress(senderAddress),
    message,
    timestamp: new Date().toISOString(),
    ...(suiamiToken ? { suiami: suiamiToken } : {}),
  };

  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));

  // XOR mask the AES key with keccak256(nft_object_id)
  const mask = keccak_256(new TextEncoder().encode(recipientNftObjectId.toLowerCase()));
  const maskedKey = xorBytes(key, mask);

  const blobId = await walrusWrite(ciphertext);
  return { blobId, nameHashBytes: ns, maskedAesKey: maskedKey, aesNonce: nonce };
}

/** Build the deposit PTB. One move call — minimal gas. */
export async function buildThunderDepositTx(
  senderAddress: string,
  nameHashBytes: Uint8Array,
  blobId: string,
  maskedAesKey: Uint8Array,
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
      tx.pure.vector('u8', Array.from(maskedAesKey)),
      tx.pure.vector('u8', Array.from(aesNonce)),
      tx.object('0x6'),
    ],
  });
  return tx.build({ client: gqlClient as never });
}

// ─── Query ───────────────────────────────────────────────────────────

/** Count pending thunders for a SuiNS name. */
export async function getThunderCount(recipientName: string): Promise<number> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'count',
    arguments: [tx.object(THUNDER_IN_ID), tx.pure.vector('u8', Array.from(ns))],
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

/** ThunderStruck event data parsed from tx effects. */
export interface ThunderStruckEvent {
  blobId: string;
  aesKey: Uint8Array;
  aesNonce: Uint8Array;
}

/**
 * Build a batched strike PTB — one tx claims N thunders.
 * Each strike emits a ThunderStruck event with the un-XOR'd AES key.
 */
export async function buildBatchStrikeTx(
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
      function: 'strike',
      arguments: [
        tx.object(THUNDER_IN_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.object(nftObjectId),
      ],
    });
  }

  return tx.build({ client: gqlClient as never });
}

/**
 * Parse ThunderStruck events from transaction effects.
 * Returns the decrypt material for each struck bolt.
 */
export function parseThunderStruckEvents(effects: any): ThunderStruckEvent[] {
  const events: ThunderStruckEvent[] = [];
  const rawEvents = effects?.events ?? [];
  for (const evt of rawEvents) {
    if (!evt?.type?.includes('::thunder::ThunderStruck')) continue;
    const fields = evt.parsedJson ?? evt.json ?? {};
    const blobIdBytes = fields.blob_id ?? [];
    const aesKeyBytes = fields.aes_key ?? [];
    const aesNonceBytes = fields.aes_nonce ?? [];
    events.push({
      blobId: typeof blobIdBytes === 'string' ? blobIdBytes : new TextDecoder().decode(new Uint8Array(blobIdBytes)),
      aesKey: new Uint8Array(aesKeyBytes),
      aesNonce: new Uint8Array(aesNonceBytes),
    });
  }
  return events;
}

/**
 * Strike all pending thunders in one PTB, then fetch + decrypt all blobs in parallel.
 * One wallet signature. Returns all decrypted payloads.
 */
export async function strikeAndDecryptAll(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  signAndExecuteTransaction: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: any }>,
): Promise<ThunderPayload[]> {
  // 1. Batch strike — one PTB, one signature
  const txBytes = await buildBatchStrikeTx(recipientAddress, recipientName, nftObjectId, count);
  const result = await signAndExecuteTransaction(txBytes);

  // 2. Parse ThunderStruck events from effects
  const struck = parseThunderStruckEvents(result.effects ?? result);
  if (struck.length === 0) throw new Error('No ThunderStruck events in tx effects');

  // 3. Fetch all blobs from Walrus in parallel
  const blobs = await Promise.all(struck.map(s => walrusRead(s.blobId)));

  // 4. AES decrypt all in parallel
  const payloads = await Promise.all(
    struck.map(async (s, i) => {
      const cleartext = await aesDecrypt(blobs[i], s.aesKey, s.aesNonce);
      return JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
    }),
  );

  return payloads;
}
