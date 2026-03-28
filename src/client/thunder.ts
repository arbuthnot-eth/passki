/**
 * Thunder client — wallet-encrypt messaging between SuiNS identities.
 *
 * Envelope encryption: random AES-256-GCM key encrypts payload,
 * ECIES (X25519 ECDH + HKDF) encrypts the AES key to recipient's pubkey.
 * Ciphertext stored on Walrus, pointer deposited in Thunder.in on-chain.
 *
 * No Seal dependency — the wallet IS the key server.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { grpcClient, gqlClient } from '../rpc.js';
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  THUNDER_IN_ID,
  type ThunderPayload,
  type ThunderPointerData,
} from './thunder-types.js';

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

// ─── Envelope encryption (ECIES: X25519 + AES-256-GCM) ──────────────

/** Generate a random 32-byte X25519 keypair. */
function generateEphemeralKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Derive a shared AES-256 key from ECDH shared secret via HKDF-SHA256. */
function deriveAesKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, /*salt*/ undefined, 'thunder-v1', 32);
}

/** AES-256-GCM encrypt. Returns nonce (12 bytes) + ciphertext. */
async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext));
  // Prepend IV
  const result = new Uint8Array(12 + ciphertext.length);
  result.set(iv, 0);
  result.set(ciphertext, 12);
  return result;
}

/** AES-256-GCM decrypt. Input is nonce (12 bytes) + ciphertext. */
async function aesDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext));
}

/**
 * ECIES encrypt: generate ephemeral X25519 keypair, ECDH with recipient pubkey,
 * derive AES key, encrypt payload. Returns ephemeral pubkey + encrypted data.
 */
async function eciesEncrypt(recipientPubkey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const ephemeral = generateEphemeralKeypair();
  const sharedSecret = x25519(ephemeral.privateKey, recipientPubkey);
  const aesKey = deriveAesKey(sharedSecret);
  const encrypted = await aesEncrypt(aesKey, plaintext);
  // Format: [32 bytes ephemeral pubkey] [encrypted data]
  const result = new Uint8Array(32 + encrypted.length);
  result.set(ephemeral.publicKey, 0);
  result.set(encrypted, 32);
  return result;
}

/**
 * ECIES decrypt: extract ephemeral pubkey, ECDH with recipient private key,
 * derive AES key, decrypt payload.
 */
async function eciesDecrypt(recipientPrivateKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const ephemeralPubkey = data.slice(0, 32);
  const encrypted = data.slice(32);
  const sharedSecret = x25519(recipientPrivateKey, ephemeralPubkey);
  const aesKey = deriveAesKey(sharedSecret);
  return aesDecrypt(aesKey, encrypted);
}

// ─── Recipient pubkey lookup ─────────────────────────────────────────

/**
 * Derive an X25519 public key from a wallet's ed25519 public key.
 * Sui wallets use ed25519 — we convert to X25519 (Curve25519) for ECDH.
 *
 * The recipient's ed25519 pubkey is extracted from their on-chain tx signatures.
 */
async function getRecipientX25519Pubkey(address: string): Promise<Uint8Array> {
  // Query a recent transaction from this address to extract their ed25519 pubkey
  const res = await fetch('https://sui-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'suix_queryTransactionBlocks',
      params: [
        { filter: { FromAddress: normalizeSuiAddress(address) }, options: { showInput: true } },
        null, 1, true,
      ],
    }),
  });
  const json = await res.json() as any;
  const txData = json?.result?.data?.[0];
  if (!txData?.transaction?.txSignatures?.[0]) {
    throw new Error('Cannot find recipient public key — no transactions found');
  }

  // Sui signature format: [scheme_flag (1 byte)] [signature (64 bytes)] [pubkey (32 bytes)]
  const sigB64 = txData.transaction.txSignatures[0];
  const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
  const schemeFlag = sigBytes[0];

  if (schemeFlag !== 0x00) {
    throw new Error(`Recipient uses non-ed25519 key scheme (flag=${schemeFlag}) — Thunder v1 requires ed25519`);
  }

  // ed25519: flag(1) + sig(64) + pubkey(32) = 97 bytes
  const ed25519Pubkey = sigBytes.slice(65, 97);

  // Convert ed25519 pubkey to X25519 (Curve25519) for ECDH
  return ed25519.utils.toMontgomery(ed25519Pubkey);
}

/**
 * Derive the user's own X25519 private key from a wallet signature.
 * Uses signPersonalMessage to derive a deterministic key.
 */
async function deriveDecryptionKey(
  signPersonalMessage: (message: Uint8Array) => Promise<{ signature: string }>,
): Promise<Uint8Array> {
  // Sign a deterministic message to derive a stable private key
  const deriveMsg = new TextEncoder().encode('Thunder v1 decryption key derivation');
  const { signature } = await signPersonalMessage(deriveMsg);
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  // Hash the signature to get 32 bytes for X25519 private key
  return sha256(sigBytes);
}

// ─── Send a Thunder ──────────────────────────────────────────────────

/**
 * Encrypt a Thunder message to the recipient's wallet pubkey and store on Walrus.
 * Returns blobId + nameHashBytes for the on-chain deposit.
 */
export async function encryptThunder(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  recipientAddress: string,
  message: string,
  suiamiToken?: string,
): Promise<{ blobId: string; nameHashBytes: Uint8Array }> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  // Look up recipient's X25519 public key
  const recipientPubkey = await getRecipientX25519Pubkey(recipientAddress);

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

  // ECIES encrypt to recipient's pubkey
  const encrypted = await eciesEncrypt(recipientPubkey, payloadBytes);

  // Write to Walrus
  const blobId = await walrusWrite(encrypted);

  return { blobId, nameHashBytes: ns };
}

/**
 * Build the on-chain deposit transaction (registers the pointer in Thunder.in).
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

// ─── Query Thunder.in ────────────────────────────────────────────────

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
 * Decrypt a Thunder blob using the wallet's derived X25519 private key.
 * First call requires a wallet signature to derive the decryption key.
 */
let _cachedDecryptKey: Uint8Array | null = null;

export async function decryptThunder(
  blobId: string,
  signPersonalMessage: (message: Uint8Array) => Promise<{ signature: string }>,
): Promise<ThunderPayload> {
  // Derive decryption key (cached after first use in session)
  if (!_cachedDecryptKey) {
    _cachedDecryptKey = await deriveDecryptionKey(signPersonalMessage);
  }

  // Fetch encrypt blob from Walrus
  const blob = await walrusRead(blobId);

  // ECIES decrypt
  const cleartext = await eciesDecrypt(_cachedDecryptKey, blob);

  return JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
}

/**
 * Build the pop transaction (remove pointer from Thunder.in after decrypt).
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
 * Clear the cached decryption key (call on disconnect).
 */
export function clearThunderSession(): void {
  _cachedDecryptKey = null;
}
