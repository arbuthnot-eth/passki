/**
 * Thunder Timestream — powered by @mysten/sui-stack-messaging SDK.
 * Replaces the deprecated custom AES-GCM + Storm signal layer.
 *
 * Seal threshold encryption (2-of-3 key servers), envelope encryption
 * (AES-256-GCM with Seal-managed DEKs), pluggable transport for message
 * delivery, on-chain group/permission management via PermissionedGroup<Messaging>.
 */
import {
  createSuiStackMessagingClient,
  type DecryptedMessage,
  type GroupRef,
  type RelayerTransport,
} from '@mysten/sui-stack-messaging';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// ─── Client singleton ───────────────────────────────────────────────

let _client: ReturnType<typeof createSuiStackMessagingClient> | null = null;

export interface ThunderClientOptions {
  /** Signer for Seal session key + message signing */
  signer: {
    signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
    toSuiAddress(): string;
  };
  /** Seal key server configs (from env or hardcoded) */
  sealServerConfigs: Array<{ objectId: string; weight: number }>;
  /** Custom transport backend (e.g. StormAgent DO) */
  transport?: RelayerTransport;
  /** HTTP relayer URL (if not using custom transport) */
  relayerUrl?: string;
}

/**
 * Initialize the Thunder Timestream messaging client.
 * Must be called with a signer before sending or reading messages.
 */
export function initThunderClient(opts: ThunderClientOptions) {
  const baseClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

  const relayerConfig: any = opts.transport
    ? { transport: opts.transport }
    : { relayerUrl: opts.relayerUrl || '' };

  _client = createSuiStackMessagingClient(baseClient as any, {
    seal: { serverConfigs: opts.sealServerConfigs },
    encryption: {
      sessionKey: { signer: opts.signer as any },
    },
    relayer: relayerConfig,
  });

  return _client;
}

/** Get the initialized client (throws if not initialized). */
export function getThunderClient() {
  if (!_client) throw new Error('Thunder client not initialized — call initThunderClient first');
  return _client;
}

/** Reset client (for sign-out / wallet switch). */
export function resetThunderClient() {
  if (_client) {
    try { _client.messaging.disconnect(); } catch {}
  }
  _client = null;
}

// ─── High-level API ─────────────────────────────────────────────────

/**
 * Send an encrypted Thunder signal to a Timestream (group).
 * If a transfer is specified, executes the SUI transfer as a separate
 * on-chain transaction (the SDK handles message encryption + transport).
 */
export async function sendThunder(opts: {
  signer: any;
  groupRef: GroupRef;
  text: string;
  /** Optional: SUI transfer executed as a separate on-chain tx */
  transfer?: { recipientAddress: string; amountMist: bigint };
  /** signAndExecuteTransaction callback for the transfer PTB */
  executeTransfer?: (txBytes: Uint8Array) => Promise<any>;
}): Promise<{ messageId: string }> {
  const client = getThunderClient();

  // Execute token transfer as separate on-chain transaction
  if (opts.transfer && opts.transfer.amountMist > 0n && opts.executeTransfer) {
    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(opts.signer.toSuiAddress()));
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer.amountMist)]);
    tx.transferObjects([coin], tx.pure.address(normalizeSuiAddress(opts.transfer.recipientAddress)));
    const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const bytes = await tx.build({ client: gql as never });
    await opts.executeTransfer(bytes as Uint8Array);
  }

  // Send encrypted message via SDK transport
  return client.messaging.sendMessage({
    signer: opts.signer,
    groupRef: opts.groupRef,
    text: opts.text,
  });
}

/**
 * Fetch and decrypt messages from a Timestream.
 */
export async function getThunders(opts: {
  signer: any;
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: DecryptedMessage[]; hasNext: boolean }> {
  const client = getThunderClient();
  return client.messaging.getMessages({
    signer: opts.signer,
    groupRef: opts.groupRef,
    afterOrder: opts.afterOrder,
    limit: opts.limit,
  });
}

/**
 * Subscribe to real-time Thunder signals in a Timestream.
 */
export function subscribeThunders(opts: {
  signer: any;
  groupRef: GroupRef;
  signal?: AbortSignal;
}): AsyncIterable<DecryptedMessage> {
  const client = getThunderClient();
  return client.messaging.subscribe({
    signer: opts.signer,
    groupRef: opts.groupRef,
    signal: opts.signal,
  });
}

/**
 * Create a new Timestream (messaging group) between SuiNS identities.
 */
export async function createTimestream(opts: {
  signer: any;
  name: string;
  members: string[];
  /** Optional: compose additional PTB commands (e.g. token transfer) */
  transaction?: Transaction;
}) {
  const client = getThunderClient();
  return client.messaging.createAndShareGroup({
    signer: opts.signer,
    name: opts.name,
    initialMembers: opts.members,
    transaction: opts.transaction,
  });
}

// ─── SuiNS resolution ───────────────────────────────────────────────

/** Resolve a SuiNS name to its target address. */
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
export type { DecryptedMessage, GroupRef, RelayerTransport };
