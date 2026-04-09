/**
 * Thunder Timestream — Seal-encrypted messaging between SuiNS identities.
 *
 * Uses @mysten/sui-stack-messaging SDK with:
 * - Seal 2-of-3 threshold encryption (Overclock, NodeInfra, Studio Mirai)
 * - TimestreamAgent DO as transport backend
 * - On-chain Storms (PermissionedGroup<Messaging>) for Seal key management
 */
import {
  createSuiStackMessagingClient,
  type DecryptedMessage,
  type GroupRef,
} from '@mysten/sui-stack-messaging';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { DappKitSigner, type SignPersonalMessageFn } from './dapp-kit-signer.js';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// Mainnet Seal key servers (free, open mode, 2-of-3 threshold)
// Mainnet Seal key servers (free, open mode, 2-of-3 threshold)
// NodeInfra excluded — broken CORS (sends duplicate Access-Control-Allow-Origin: *, *)
const SEAL_SERVERS = [
  { objectId: '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6', weight: 1 }, // Overclock
  { objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10', weight: 1 }, // Studio Mirai
  { objectId: '0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a', weight: 1 }, // H2O Nodes
];

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
  senderVerified: boolean;
}

export interface ThunderClientOptions {
  address: string;
  signPersonalMessage: SignPersonalMessageFn;
}

// ─── Client state ───────────────────────────────────────────────────

type MessagingClient = ReturnType<typeof createSuiStackMessagingClient>;

let _client: MessagingClient | null = null;
let _signer: DappKitSigner | null = null;
let _address = '';

/**
 * Initialize the Thunder Timestream client with Seal encryption.
 * Called on wallet connect.
 */
export function initThunderClient(opts: ThunderClientOptions) {
  _address = opts.address;

  _signer = new DappKitSigner({
    address: opts.address,
    signPersonalMessage: (args) => opts.signPersonalMessage(args.message),
  });

  const gqlClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

  _client = createSuiStackMessagingClient(gqlClient as any, {
    seal: { serverConfigs: SEAL_SERVERS, verifyKeyServers: false },
    encryption: {
      sessionKey: {
        address: opts.address,
        onSign: async (message: Uint8Array) => {
          const { signature } = await opts.signPersonalMessage(message);
          return signature;
        },
      },
    },
    relayer: {
      transport: new TimestreamRelayer(),
    },
  });

  return _client;
}

export function getThunderClient(): MessagingClient {
  if (!_client) throw new Error('Thunder client not initialized');
  return _client;
}

export function resetThunderClient() {
  if (_client) {
    try { _client.messaging.disconnect(); } catch {}
  }
  _client = null;
  _signer = null;
  _address = '';
}

// ─── Timestream DO transport ────────────────────────────────────────
// Implements RelayerTransport inline — talks to /api/timestream/:groupId/*

function toB64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

class TimestreamRelayer {
  async sendMessage(params: any) {
    const res = await fetch(`/api/timestream/${encodeURIComponent(params.groupId)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: params.groupId,
        encryptedText: toB64(params.encryptedText),
        nonce: toB64(params.nonce),
        keyVersion: params.keyVersion.toString(),
        senderAddress: params.signer.toSuiAddress(),
        signature: params.messageSignature || '',
      }),
    });
    if (!res.ok) throw new Error(`Send failed: ${res.status}`);
    return res.json() as Promise<{ messageId: string }>;
  }

  async fetchMessages(params: any) {
    const res = await fetch(`/api/timestream/${encodeURIComponent(params.groupId)}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        afterOrder: params.afterOrder,
        beforeOrder: params.beforeOrder,
        limit: params.limit,
      }),
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const data = await res.json() as { messages: any[]; hasNext: boolean };
    return {
      messages: data.messages.map((m: any) => ({
        ...m,
        encryptedText: fromB64(m.encryptedText),
        nonce: fromB64(m.nonce),
        keyVersion: BigInt(m.keyVersion),
        attachments: [],
      })),
      hasNext: data.hasNext,
    };
  }

  async fetchMessage(params: any) {
    const res = await fetch(`/api/timestream/${encodeURIComponent(params.groupId)}/fetch-one`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: params.messageId }),
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const m = await res.json() as any;
    return { ...m, encryptedText: fromB64(m.encryptedText), nonce: fromB64(m.nonce), keyVersion: BigInt(m.keyVersion), attachments: [] };
  }

  async updateMessage(params: any) {
    await fetch(`/api/timestream/${encodeURIComponent(params.groupId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: params.messageId,
        senderAddress: params.signer.toSuiAddress(),
        encryptedText: toB64(params.encryptedText),
        nonce: toB64(params.nonce),
        keyVersion: params.keyVersion.toString(),
        signature: params.messageSignature || '',
      }),
    });
  }

  async deleteMessage(params: any) {
    await fetch(`/api/timestream/${encodeURIComponent(params.groupId)}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: params.messageId,
        senderAddress: params.signer.toSuiAddress(),
      }),
    });
  }

  async *subscribe(params: any): AsyncIterable<any> {
    let afterOrder = params.afterOrder ?? 0;
    while (!params.signal?.aborted) {
      const { messages } = await this.fetchMessages({
        signer: params.signer,
        groupId: params.groupId,
        afterOrder,
        limit: params.limit ?? 20,
      });
      for (const msg of messages) {
        yield msg;
        afterOrder = msg.order;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3000);
        params.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }

  disconnect() {}
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send a Seal-encrypted Thunder signal.
 * Auto-creates the on-chain Storm if it doesn't exist yet.
 * SDK handles: AES-256-GCM envelope encryption + Seal threshold key management.
 */
export async function sendThunder(opts: {
  groupRef: GroupRef;
  text: string;
  recipientAddress?: string;
  transfer?: { recipientAddress: string; amountMist: bigint };
  /** Sign and execute a transaction (for Storm creation + token transfers).
   *  Accepts Uint8Array (pre-built) or Transaction object (WaaP compat). */
  signAndExecute?: (tx: Uint8Array | Transaction) => Promise<any>;
}): Promise<{ messageId: string }> {
  const client = getThunderClient();

  // Execute token transfer as separate on-chain tx
  if (opts.transfer && opts.transfer.amountMist > 0n && opts.signAndExecute) {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(_address));
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer.amountMist)]);
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer.recipientAddress)));
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const bytes = await tx.build({ client: gql as never });
    await opts.signAndExecute(bytes as Uint8Array);
  }

  // Try to send — if Storm doesn't exist, create it first
  try {
    return await client.messaging.sendMessage({
      signer: _signer!,
      groupRef: opts.groupRef,
      text: opts.text,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Storm not found — auto-create on-chain and retry
    if (errMsg.includes('not found') || errMsg.includes('Object') || errMsg.includes('null')) {
      if (!opts.signAndExecute) throw new Error('Storm does not exist and no signAndExecute provided to create it');
      const uuid = 'uuid' in opts.groupRef ? opts.groupRef.uuid : undefined;
      const members = opts.recipientAddress ? [opts.recipientAddress] : [];
      // Use tx.* to get a Transaction object — pass directly for WaaP compat
      const stormTx = client.messaging.tx.createAndShareGroup({
        name: uuid || 'thunder-storm',
        initialMembers: members,
      });
      stormTx.setSender(normalizeSuiAddress(_address));
      await opts.signAndExecute(stormTx);
      // Wait for indexing
      await new Promise(r => setTimeout(r, 2000));
      // Retry send after Storm creation
      return client.messaging.sendMessage({
        signer: _signer!,
        groupRef: opts.groupRef,
        text: opts.text,
      });
    }
    throw err;
  }
}

/**
 * Fetch and decrypt messages from a Timestream.
 * SDK handles: Seal decryption via key server dry-run.
 */
export async function getThunders(opts: {
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: ThunderMessage[]; hasNext: boolean }> {
  const client = getThunderClient();
  const result = await client.messaging.getMessages({
    signer: _signer!,
    groupRef: opts.groupRef,
    afterOrder: opts.afterOrder,
    limit: opts.limit,
  });

  return {
    messages: result.messages.map(m => ({
      messageId: m.messageId,
      groupId: m.groupId,
      order: m.order,
      text: m.text,
      senderAddress: m.senderAddress,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      senderVerified: m.senderVerified,
    })),
    hasNext: result.hasNext,
  };
}

/**
 * Subscribe to real-time Thunder signals.
 */
export async function* subscribeThunders(opts: {
  groupRef: GroupRef;
  signal?: AbortSignal;
}): AsyncGenerator<ThunderMessage> {
  const client = getThunderClient();
  for await (const m of client.messaging.subscribe({
    signer: _signer!,
    groupRef: opts.groupRef,
    signal: opts.signal,
  })) {
    yield {
      messageId: m.messageId,
      groupId: m.groupId,
      order: m.order,
      text: m.text,
      senderAddress: m.senderAddress,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      senderVerified: m.senderVerified,
    };
  }
}

/**
 * Create a new Storm (on-chain messaging group for Seal key management).
 * Auto-called on first message to a new conversation.
 */
export function createStorm(opts: {
  name: string;
  members: string[];
  transaction?: Transaction;
}): Transaction {
  const client = getThunderClient();
  const tx = client.messaging.tx.createAndShareGroup({
    name: opts.name,
    initialMembers: opts.members,
    transaction: opts.transaction,
  });
  tx.setSender(normalizeSuiAddress(_address));
  return tx;
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
export type { DecryptedMessage, GroupRef, SignPersonalMessageFn };
