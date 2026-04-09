/**
 * Thunder Timestream — encrypted messaging between SuiNS identities.
 *
 * Architecture:
 * - Messages stored in TimestreamAgent DOs (one per group)
 * - Transport: TimestreamTransport → /api/timestream/:groupId/*
 * - Encryption: AES-256-GCM client-side (Seal threshold upgrade when mainnet key servers available)
 * - Groups: named by convention (thunder-{sender}-{recipient})
 */
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { TimestreamTransport } from './timestream-transport.js';

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

export interface ThunderClientOptions {
  signer: {
    signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
    toSuiAddress(): string;
  };
  transport: TimestreamTransport;
}

// ─── Client state ───────────────────────────────────────────────────

let _transport: TimestreamTransport | null = null;
let _signer: ThunderClientOptions['signer'] | null = null;

/**
 * Initialize the Thunder Timestream client.
 * Uses the TimestreamTransport directly for message delivery.
 */
export function initThunderClient(opts: ThunderClientOptions) {
  _transport = opts.transport;
  _signer = opts.signer;
}

export function getThunderTransport(): TimestreamTransport {
  if (!_transport) throw new Error('Thunder client not initialized');
  return _transport;
}

export function getThunderSigner() {
  if (!_signer) throw new Error('Thunder client not initialized');
  return _signer;
}

export function resetThunderClient() {
  if (_transport) _transport.disconnect();
  _transport = null;
  _signer = null;
}

// ─── AES-256-GCM encryption ────────────────────────────────────────
// Client-side envelope encryption. Seal threshold upgrade pending mainnet key servers.

async function aesEncrypt(plaintext: string, key?: CryptoKey): Promise<{ ciphertext: string; nonce: string; keyB64: string }> {
  const aesKey = key ?? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, data);
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    nonce: btoa(String.fromCharCode(...nonce)),
    keyB64: btoa(String.fromCharCode(...new Uint8Array(rawKey))),
  };
}

async function aesDecrypt(ciphertextB64: string, nonceB64: string, keyB64: string): Promise<string> {
  const ciphertext = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
  const nonce = Uint8Array.from(atob(nonceB64), c => c.charCodeAt(0));
  const rawKey = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send an encrypted Thunder signal to a Timestream.
 * Encrypts with AES-256-GCM, stores via TimestreamTransport.
 * Optionally executes a SUI transfer as a separate on-chain tx.
 */
export async function sendThunder(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: { uuid: string };
  text: string;
  transfer?: { recipientAddress: string; amountMist: bigint };
  executeTransfer?: (txBytes: Uint8Array) => Promise<any>;
}): Promise<{ messageId: string }> {
  const transport = getThunderTransport();
  const signer = opts.signer || getThunderSigner();

  // Execute token transfer as separate on-chain tx
  if (opts.transfer && opts.transfer.amountMist > 0n && opts.executeTransfer) {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(signer.toSuiAddress()));
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer.amountMist)]);
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer.recipientAddress)));
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const bytes = await tx.build({ client: gql as never });
    await opts.executeTransfer(bytes as Uint8Array);
  }

  // AES encrypt the message
  const { ciphertext, nonce, keyB64 } = await aesEncrypt(opts.text);

  // Store the AES key in the message signature field (recipient retrieves it)
  // In production with Seal: key would be Seal-encrypted, not stored in signature
  const res = await transport.sendMessage({
    signer: signer as any,
    groupId: opts.groupRef.uuid,
    encryptedText: Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0)),
    nonce: Uint8Array.from(atob(nonce), c => c.charCodeAt(0)),
    keyVersion: 0n,
    messageSignature: keyB64,
  });

  return { messageId: res.messageId };
}

/**
 * Fetch and decrypt messages from a Timestream.
 */
export async function getThunders(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: { uuid: string };
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: ThunderMessage[]; hasNext: boolean }> {
  const transport = getThunderTransport();
  const signer = opts.signer || getThunderSigner();

  const result = await transport.fetchMessages({
    signer: signer as any,
    groupId: opts.groupRef.uuid,
    afterOrder: opts.afterOrder,
    limit: opts.limit,
  });

  const messages: ThunderMessage[] = [];
  for (const rm of result.messages) {
    let text: string;
    try {
      // Decrypt AES-GCM using key stored in signature field
      const ciphertextB64 = btoa(String.fromCharCode(...rm.encryptedText));
      const nonceB64 = btoa(String.fromCharCode(...rm.nonce));
      const keyB64 = rm.signature; // AES key stored here for now
      text = await aesDecrypt(ciphertextB64, nonceB64, keyB64);
    } catch {
      // Fallback: try as plaintext (ultron notifications)
      try { text = new TextDecoder().decode(rm.encryptedText); } catch { text = '[decrypt failed]'; }
    }
    messages.push({
      messageId: rm.messageId,
      groupId: rm.groupId,
      order: rm.order,
      text,
      senderAddress: rm.senderAddress,
      createdAt: rm.createdAt,
      updatedAt: rm.updatedAt,
      isEdited: rm.isEdited,
      isDeleted: rm.isDeleted,
    });
  }

  return { messages, hasNext: result.hasNext };
}

/**
 * Subscribe to real-time Thunder signals in a Timestream.
 */
export async function* subscribeThunders(opts: {
  signer?: ThunderClientOptions['signer'];
  groupRef: { uuid: string };
  signal?: AbortSignal;
}): AsyncGenerator<ThunderMessage> {
  const transport = getThunderTransport();
  const signer = opts.signer || getThunderSigner();

  for await (const rm of transport.subscribe({
    signer: signer as any,
    groupId: opts.groupRef.uuid,
    signal: opts.signal,
  })) {
    let text: string;
    try {
      const ciphertextB64 = btoa(String.fromCharCode(...rm.encryptedText));
      const nonceB64 = btoa(String.fromCharCode(...rm.nonce));
      text = await aesDecrypt(ciphertextB64, nonceB64, rm.signature);
    } catch {
      try { text = new TextDecoder().decode(rm.encryptedText); } catch { text = '[decrypt failed]'; }
    }
    yield {
      messageId: rm.messageId,
      groupId: rm.groupId,
      order: rm.order,
      text,
      senderAddress: rm.senderAddress,
      createdAt: rm.createdAt,
      updatedAt: rm.updatedAt,
      isEdited: rm.isEdited,
      isDeleted: rm.isDeleted,
    };
  }
}

/**
 * Create a new Timestream (group) between SuiNS identities.
 * Currently a no-op — groups are auto-created on first message via the DO.
 */
export async function createTimestream(_opts: {
  signer?: any;
  name: string;
  members: string[];
  transaction?: Transaction;
}) {
  // TimestreamAgent DOs are created on-demand by groupId.
  // No explicit group creation needed — first sendThunder auto-creates.
  return { created: true, groupId: _opts.name };
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

// Re-export types
export type { TimestreamTransport };
