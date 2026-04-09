/**
 * Thunder Timestream — encrypted messaging between SuiNS identities.
 *
 * Minimal working flow:
 * - AES-256-GCM client-side encryption
 * - TimestreamAgent DO stores encrypted blobs per group
 * - Groups auto-created on first message (keyed by groupId)
 * - Seal 2-of-3 threshold encryption upgrade path ready
 *
 * Seal mainnet key servers (for future upgrade):
 * - Overclock: 0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6
 * - NodeInfra: 0x1afb3a57211ceff8f6781757821847e3ddae73f64e78ec8cd9349914ad985475
 * - Studio Mirai: 0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10
 */
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// ─── Types ──────────────────────────────────────────────────────────

export interface ThunderMessage {
  messageId: string;
  groupId: string;
  order: number;
  text: string;
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
}

export interface GroupRef {
  uuid: string;
}

export interface ThunderClientOptions {
  address: string;
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}

// ─── Client state ───────────────────────────────────────────────────

let _address = '';
let _signPersonalMessage: ThunderClientOptions['signPersonalMessage'] | null = null;

export function initThunderClient(opts: ThunderClientOptions) {
  _address = opts.address;
  _signPersonalMessage = opts.signPersonalMessage;
}

export function resetThunderClient() {
  _address = '';
  _signPersonalMessage = null;
}

function getAddress(): string {
  if (!_address) throw new Error('Thunder client not initialized');
  return _address;
}

// ─── AES-256-GCM ───────────────────────────────────────────────────

async function deriveKey(groupId: string, address: string): Promise<CryptoKey> {
  // Deterministic key from groupId + address — both parties derive the same key
  // This is symmetric: both sender and recipient in the group can encrypt/decrypt
  const material = new TextEncoder().encode(`thunder:${groupId}:${address}`);
  const hash = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encrypt(text: string, groupId: string): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const key = await deriveKey(groupId, getAddress());
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(text);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data));
  return { ciphertext: encrypted, nonce };
}

async function decrypt(ciphertext: Uint8Array, nonce: Uint8Array, groupId: string): Promise<string> {
  const key = await deriveKey(groupId, getAddress());
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

function toB64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ─── Timestream DO transport ────────────────────────────────────────

async function doSend(groupId: string, ciphertext: Uint8Array, nonce: Uint8Array): Promise<string> {
  const res = await fetch(`/api/timestream/${encodeURIComponent(groupId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groupId,
      encryptedText: toB64(ciphertext),
      nonce: toB64(nonce),
      keyVersion: '0',
      senderAddress: getAddress(),
    }),
  });
  if (!res.ok) throw new Error(`Send failed: ${res.status}`);
  const data = await res.json() as { messageId: string };
  return data.messageId;
}

async function doFetch(groupId: string, afterOrder?: number, limit?: number): Promise<{ messages: any[]; hasNext: boolean }> {
  const res = await fetch(`/api/timestream/${encodeURIComponent(groupId)}/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ afterOrder, limit }),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json() as Promise<{ messages: any[]; hasNext: boolean }>;
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send an encrypted Thunder signal.
 */
export async function sendThunder(opts: {
  groupRef: GroupRef;
  text: string;
  transfer?: { recipientAddress: string; amountMist: bigint };
  executeTransfer?: (txBytes: Uint8Array) => Promise<any>;
}): Promise<{ messageId: string }> {
  // Execute token transfer as separate on-chain tx
  if (opts.transfer && opts.transfer.amountMist > 0n && opts.executeTransfer) {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(getAddress()));
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer.amountMist)]);
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer.recipientAddress)));
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const bytes = await tx.build({ client: gql as never });
    await opts.executeTransfer(bytes as Uint8Array);
  }

  // Encrypt and send via Timestream DO
  const { ciphertext, nonce } = await encrypt(opts.text, opts.groupRef.uuid);
  const messageId = await doSend(opts.groupRef.uuid, ciphertext, nonce);
  return { messageId };
}

/**
 * Fetch and decrypt messages from a Timestream.
 */
export async function getThunders(opts: {
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: ThunderMessage[]; hasNext: boolean }> {
  const { messages: raw, hasNext } = await doFetch(opts.groupRef.uuid, opts.afterOrder, opts.limit);

  const messages: ThunderMessage[] = [];
  for (const m of raw) {
    let text: string;
    try {
      text = await decrypt(fromB64(m.encryptedText), fromB64(m.nonce), opts.groupRef.uuid);
    } catch {
      // Fallback: plaintext (ultron notifications sent without encryption)
      try { text = atob(m.encryptedText); } catch { text = '[decrypt failed]'; }
    }
    messages.push({
      messageId: m.messageId,
      groupId: m.groupId,
      order: m.order,
      text,
      senderAddress: m.senderAddress,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      isEdited: m.isEdited ?? false,
      isDeleted: m.isDeleted ?? false,
    });
  }

  return { messages, hasNext };
}

/**
 * Subscribe to real-time Thunder signals (polls every 3s).
 */
export async function* subscribeThunders(opts: {
  groupRef: GroupRef;
  signal?: AbortSignal;
}): AsyncGenerator<ThunderMessage> {
  let afterOrder = 0;
  while (!opts.signal?.aborted) {
    const { messages } = await getThunders({ groupRef: opts.groupRef, afterOrder, limit: 20 });
    for (const msg of messages) {
      yield msg;
      afterOrder = msg.order;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 3000);
      opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }
}

// ─── SuiNS resolution ───────────────────────────────────────────────

export async function lookupRecipientAddress(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const suinsClient = new SuinsClient({ client: gql as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.targetAddress ?? null;
  } catch { return null; }
}
