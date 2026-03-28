/**
 * Thunder client — Seal-encrypt messaging between SuiNS identities.
 *
 * Send: Seal encrypts payload → write blob to Walrus → deposit pointer on-chain.
 * Receive: query Thunderbun → fetch blob from Walrus → Seal decrypts → pop pointer.
 */

import { SealClient, SessionKey, EncryptedObject } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { grpcClient, gqlClient } from '../rpc.js';
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  THUNDER_IN_ID,
  SEAL_SERVER_CONFIGS,
  SEAL_THRESHOLD,
  type ThunderPayload,
  type ThunderPointerData,
} from './thunder-types.js';

// ─── Seal client (lazy init) ─────────────────────────────────────────

let _sealClient: SealClient | null = null;

function getSealClient(): SealClient {
  if (_sealClient) return _sealClient;
  _sealClient = new SealClient({
    suiClient: grpcClient as never,
    serverConfigs: SEAL_SERVER_CONFIGS,
  });
  return _sealClient;
}

// ─── Walrus HTTP (publisher for writes, aggregator for reads) ────────

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
  // Response shape: { newlyCreated: { blobObject: { blobId: "..." } } } or { alreadyCertified: { blobId: "..." } }
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

// ─── Send a Thunder ──────────────────────────────────────────────────

/**
 * Seal encrypt a Thunder message and write it to Walrus.
 * Returns the blobId — caller must then call buildThunderDepositTx and sign+execute.
 */
export async function encryptThunder(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  message: string,
  suiamiToken?: string,
): Promise<{ blobId: string; nameHashBytes: Uint8Array }> {
  const seal = getSealClient();
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

  // Seal encrypt
  const encryptResult = await seal.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: THUNDER_PACKAGE_ID,
    id: Array.from(ns).map(b => b.toString(16).padStart(2, '0')).join(''),
    data: payloadBytes,
  });

  // Write to Walrus
  const blobId = await walrusWrite(encryptResult.encryptedObject);

  return { blobId, nameHashBytes: ns };
}

/**
 * Build the on-chain deposit transaction (registers the pointer in Thunderbun).
 */
export async function buildThunderDepositTx(
  senderAddress: string,
  nameHashBytes: Uint8Array,
  blobId: string,
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
      tx.pure.vector('u8', Array.from(nameHashBytes)),
      tx.object('0x6'), // Clock
    ],
  });
  return tx.build({ client: gqlClient as never });
}

// ─── Query Thunderbun ────────────────────────────────────────────────

/**
 * Query how many Thunders are pending for a SuiNS name.
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
 * Peek at the first pending Thunder pointer.
 */
export async function peekThunder(recipientName: string): Promise<ThunderPointerData | null> {
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
      sealedNamespace: new Uint8Array(returnValues[1][0]),
      timestampMs: Number(new Uint8Array(returnValues[2][0]).reduce((a: number, b: number, i: number) => a + b * 256 ** i, 0)),
    };
  } catch {
    return null;
  }
}

// ─── Decrypt a Thunder ───────────────────────────────────────────────

/**
 * Decrypt a Thunder blob. Requires a Seal SessionKey.
 */
export async function decryptThunder(
  blobId: string,
  nftObjectId: string,
  sessionKey: SessionKey,
): Promise<ThunderPayload> {
  const seal = getSealClient();

  // Fetch encrypt blob from Walrus
  const blob = await walrusRead(blobId);

  // Build seal_approve tx
  const encObj = EncryptedObject.parse(blob);
  const tx = new Transaction();
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'seal_approve',
    arguments: [
      tx.pure.vector('u8', Array.from(encObj.id)),
      tx.object(nftObjectId),
    ],
  });
  const txBytes = await tx.build({ client: gqlClient as never });

  // Seal decrypts
  const cleartext = await seal.decrypt({
    data: blob,
    sessionKey,
    txBytes,
  });

  return JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
}

/**
 * Build the pop transaction (remove pointer from Thunderbun after decrypt).
 */
export async function buildThunderPopTx(
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
    function: 'pop',
    arguments: [
      tx.object(THUNDER_IN_ID),
      tx.pure.vector('u8', Array.from(ns)),
      tx.object(nftObjectId),
    ],
  });
  return tx.build({ client: gqlClient as never });
}

/**
 * Create a Seal session key for decrypting Thunders.
 * One session key per sign-in can decrypt all pending messages.
 */
export async function createThunderSessionKey(
  address: string,
  signPersonalMessage: (message: Uint8Array) => Promise<{ signature: string }>,
): Promise<SessionKey> {
  return SessionKey.create({
    address,
    packageId: THUNDER_PACKAGE_ID,
    ttlMin: 30,
    signer: { signPersonalMessage } as never,
    suiClient: grpcClient as never,
  });
}
