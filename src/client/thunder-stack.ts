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
import { keccak_256 } from '@noble/hashes/sha3.js';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const IOU_PACKAGE = '0x05b21b79f0fe052f685e4eee049ded3394f71d8384278c23d60532be3f04535f';

/**
 * Global SUIAMI Storm — public identity directory. Anyone with a SuiNS name can join.
 * Deterministic UUID: 'suiami-global' -> derived via @mysten/sui-stack-messaging derive.
 * Deploy: bun scripts/deploy-suiami-storm.ts
 */
export const GLOBAL_SUIAMI_STORM = '0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8';
export const GLOBAL_SUIAMI_STORM_UUID = 'suiami-global';

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
 * Send a Thunder signal. Two modes:
 *
 * 1. **Amount transfer** (@name$5): Pure PTB — splitCoins + transferObjects.
 *    No Storm needed. Records the transfer as a private Thunder in the DO.
 *
 * 2. **Message** (@name hello): Seal-encrypted via SDK. Requires Storm.
 *    Auto-creates Storm on-chain if it doesn't exist.
 */
export async function sendThunder(opts: {
  groupRef: GroupRef;
  text: string;
  recipientAddress?: string;
  senderName?: string;
  recipientName?: string;
  transfer?: { recipientAddress: string; amountMist: bigint };
  /** Sign and execute a transaction (PTB for transfers + Storm creation) */
  signAndExecute?: (tx: Uint8Array | Transaction) => Promise<any>;
}): Promise<{ messageId: string }> {
  const groupId = 'uuid' in opts.groupRef ? opts.groupRef.uuid : '';

  const client = getThunderClient();
  const hasTransfer = opts.transfer && opts.transfer.amountMist > 0n && opts.signAndExecute;

  // Check if Storm exists
  let needsStorm = false;
  try {
    await client.messaging.view.getCurrentKeyVersion({ uuid: groupId });
  } catch {
    needsStorm = true;
  }

  // ─── Build single PTB: transfer + Storm + SUIAMI roster ──────
  // One signature covers everything
  if (hasTransfer || needsStorm) {
    if (!opts.signAndExecute) throw new Error('signAndExecute required for transfers and Storm creation');

    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(_address));

    // 1. Transfer
    if (hasTransfer) {
      if (needsStorm) {
        // Storm initiation (first contact) — direct transfer + Storm creation
        // Can't call iou::initiate on a shared object in the same PTB that shares it
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer!.amountMist)]);
        tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer!.recipientAddress)));
      } else {
        // iOUSD object — private on-chain escrow on existing Storm (7-day TTL)
        const [iouCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer!.amountMist)]);
        const senderBare = (opts.senderName || '') + '.sui';
        const recipBare = (opts.recipientName || '') + '.sui';
        const senderHash = Array.from(keccak_256(new TextEncoder().encode(senderBare)));
        const recipHash = Array.from(keccak_256(new TextEncoder().encode(recipBare)));
        const { groupId: stormObjectId } = client.messaging.derive.resolveGroupRef(opts.groupRef);
        tx.moveCall({
          package: IOU_PACKAGE,
          module: 'iou',
          function: 'initiate',
          arguments: [
            tx.object(stormObjectId),
            tx.pure.vector('u8', senderHash),
            tx.pure.vector('u8', recipHash),
            iouCoin,
            tx.pure.u64(604_800_000), // 7 day TTL
            tx.pure.u64(Date.now()),  // nonce
            tx.pure.vector('u8', []), // sealed_memo
            tx.object('0x6'),         // Clock
          ],
        });
      }
    }

    // 2. Storm creation (if no on-chain Storm exists)
    if (needsStorm) {
      const members = opts.recipientAddress ? [opts.recipientAddress] : [];
      client.messaging.tx.createAndShareGroup({
        name: groupId || 'thunder-storm',
        initialMembers: members,
        transaction: tx,
      });
    }

    // 3. SUIAMI Roster attestation (piggyback sender identity on-chain)
    try {
      const { maybeAppendRoster } = await import('../suins.js');
      maybeAppendRoster(tx, _address);
    } catch { /* roster piggyback is best-effort */ }

    // One signature for transfer + Storm + SUIAMI
    await opts.signAndExecute(tx);

    if (needsStorm) {
      await new Promise(r => setTimeout(r, 2000));
    }

    // Record the transfer as a private Thunder in the Timestream DO
    if (hasTransfer) {
      const amtLabel = opts.text.match(/\$(\d+(?:\.\d{0,2})?)/)?.[1] || (Number(opts.transfer!.amountMist) / 1e9).toFixed(2);
      const transferNote = `\u26a1 $${amtLabel} sent`;
      await fetch(`/api/timestream/${encodeURIComponent(groupId)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          groupId,
          encryptedText: btoa(transferNote),
          nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))),
          keyVersion: '0',
          senderAddress: _address,
        }),
      });
    }

    // If there's no message text beyond the amount, we're done
    if (hasTransfer) {
      const textWithoutAmount = opts.text.replace(/@\S+\$\d+(?:\.\d{0,2})?/g, '').trim();
      if (!textWithoutAmount) {
        return { messageId: 'transfer' };
      }
    }
  }

  // ─── Seal-encrypted message (Storm must exist by now) ─────────
  return client.messaging.sendMessage({
    signer: _signer!,
    groupRef: opts.groupRef,
    text: opts.text,
  });
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

// ─── Storm existence check ──────────────────────────────────────────

/** Check if an on-chain Storm exists for a given UUID. */
export async function stormExists(uuid: string): Promise<boolean> {
  try {
    const client = getThunderClient();
    await client.messaging.view.getCurrentKeyVersion({ uuid });
    return true;
  } catch {
    return false;
  }
}

// ─── SuiNS resolution ───────────────────────────────────────────────

/** Resolve a SuiNS name to its address. Tries target address first, falls back to NFT owner. */
export async function lookupRecipientAddress(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const suinsClient = new SuinsClient({ client: gql as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    // Target address is the preferred resolution
    if (record?.targetAddress) return record.targetAddress;
    // Fallback: NFT owner address (if target not set but name is owned)
    if (record?.nftId) {
      try {
        const res = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: `{ object(address: "${record.nftId}") { owner { ... on AddressOwner { owner { address } } } } }` }),
        });
        const data = await res.json() as any;
        const ownerAddr = data?.data?.object?.owner?.owner?.address;
        if (ownerAddr) return ownerAddr;
      } catch {}
    }
    return null;
  } catch { return null; }
}

/** Reverse lookup: address → primary SuiNS name. */
export async function reverseLookupName(address: string): Promise<string | null> {
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ address(address: "${address}") { defaultSuinsName } }` }),
    });
    const data = await res.json() as any;
    const name = data?.data?.address?.defaultSuinsName;
    return name ? name.replace(/\.sui$/, '') : null;
  } catch { return null; }
}

// Re-export types
export type { DecryptedMessage, GroupRef, SignPersonalMessageFn };
