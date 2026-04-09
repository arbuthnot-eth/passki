/**
 * Roster client — Walrus blob upload/fetch for roster data.
 *
 * Uses Walrus testnet publisher/aggregator for storing and retrieving
 * cross-chain identity records associated with roster entries.
 *
 * Supports optional AES-GCM encryption as a stepping stone toward
 * full Seal encryption (wired when the policy contract is published).
 */

const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

/** Result of an encrypted roster blob upload. */
export interface EncryptedBlobResult {
  blobId: string;
  /** AES-GCM nonce (12 bytes) — needed for on-chain record */
  nonce: number[];
  /** Raw AES-256 key bytes (32 bytes) — caller must store securely */
  keyRaw: number[];
}

/**
 * Upload roster data to Walrus as a blob.
 * @param data - The data to store (will be JSON-stringified if not already a string/Uint8Array)
 * @param opts - Optional encryption settings
 * @returns Plain blob ID string when unencrypted, or EncryptedBlobResult when encrypted
 */
export async function uploadRosterBlob(
  data: unknown,
  opts?: { encrypt?: boolean },
): Promise<string | EncryptedBlobResult> {
  let body: Uint8Array | string;

  if (data instanceof Uint8Array) {
    body = data;
  } else if (typeof data === 'string') {
    body = data;
  } else {
    body = JSON.stringify(data);
  }

  // AES-GCM encrypt if requested
  let nonce: Uint8Array | undefined;
  let key: CryptoKey | undefined;
  if (opts?.encrypt) {
    key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    nonce = crypto.getRandomValues(new Uint8Array(12));
    const plainBytes =
      typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      plainBytes,
    );
    body = new Uint8Array(cipherBuf);
  }

  const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Walrus upload failed: ${res.status} ${res.statusText}`);
  }

  const result = await res.json() as any;
  // Walrus returns { newlyCreated: { blobObject: { blobId } } } or { alreadyCertified: { blobId } }
  const blobId =
    result?.newlyCreated?.blobObject?.blobId ??
    result?.alreadyCertified?.blobId;

  if (!blobId) {
    throw new Error('Walrus upload: no blobId in response');
  }

  if (opts?.encrypt && key && nonce) {
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return {
      blobId: blobId as string,
      nonce: Array.from(nonce),
      keyRaw: Array.from(rawKey),
    };
  }

  return blobId as string;
}

/**
 * Fetch and parse a roster blob from Walrus.
 * @param blobId - The Walrus blob ID to retrieve
 * @param decryptionOpts - Optional AES-GCM decryption key and nonce
 * @returns Parsed JSON data from the blob
 */
export async function fetchRosterBlob<T = unknown>(
  blobId: string,
  decryptionOpts?: { keyRaw: number[]; nonce: number[] },
): Promise<T> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);

  if (!res.ok) {
    throw new Error(`Walrus fetch failed: ${res.status} ${res.statusText}`);
  }

  if (decryptionOpts) {
    const cipherBytes = new Uint8Array(await res.arrayBuffer());
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(decryptionOpts.keyRaw),
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(decryptionOpts.nonce) },
      key,
      cipherBytes,
    );
    const text = new TextDecoder().decode(plainBuf);
    return JSON.parse(text) as T;
  }

  const text = await res.text();
  return JSON.parse(text) as T;
}
