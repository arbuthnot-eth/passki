/**
 * Roster client — Walrus blob upload/fetch for Seal-encrypted roster data.
 *
 * Uses Walrus testnet publisher/aggregator for storing and retrieving
 * encrypted cross-chain identity records associated with roster entries.
 */

const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

/**
 * Upload roster data to Walrus as a blob.
 * @param data - The data to store (will be JSON-stringified if not already a string/Uint8Array)
 * @returns The Walrus blob ID
 */
export async function uploadRosterBlob(
  data: unknown,
): Promise<string> {
  const body =
    data instanceof Uint8Array
      ? data
      : typeof data === 'string'
        ? data
        : JSON.stringify(data);

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

  return blobId as string;
}

/**
 * Fetch and parse a roster blob from Walrus.
 * @param blobId - The Walrus blob ID to retrieve
 * @returns Parsed JSON data from the blob
 */
export async function fetchRosterBlob<T = unknown>(blobId: string): Promise<T> {
  const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);

  if (!res.ok) {
    throw new Error(`Walrus fetch failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  return JSON.parse(text) as T;
}
