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
  MAINNET_SUI_STACK_MESSAGING_PACKAGE_CONFIG,
  WalrusHttpStorageAdapter,
  type Attachment,
  type AttachmentFile,
  type AttachmentHandle,
  type DecryptedMessage,
  type GroupRef,
} from '@mysten/sui-stack-messaging';
import { SessionKey, type ExportedSessionKey } from '@mysten/seal';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { DappKitSigner, type SignPersonalMessageFn } from './dapp-kit-signer.js';

// ─── Constants ──────────────────────────────────────────────────────
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/**
 * Global SUIAMI Storm — public identity directory. Anyone with a SuiNS name can join.
 * Deterministic UUID: 'suiami-global' -> derived via @mysten/sui-stack-messaging derive.
 * Deploy: bun scripts/deploy-suiami-storm.ts
 */
export const GLOBAL_SUIAMI_STORM = '0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8';
export const GLOBAL_SUIAMI_STORM_UUID = 'suiami-global';

// DeepBook v3 SUI/USDC pool — used to swap SUI → USDC in the Thunder $ transfer
// path. USDC is the canonical Thunder stable: it's dollar-pegged, every wallet
// renders it as "≈ $N" on the confirm screen, and the SUI/USDC pool has deep
// two-sided liquidity. iUSD was considered as the destination asset but its
// Treasury is currently undercollateralized and the collateral-management
// functions are all PRIVATE, so minting is blocked. Revisit iUSD-as-canonical
// once the mint path is healthy and the iUSD/USDC pool is seeded two-sided.
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const DB_SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DB_USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
const DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION = 389750322;

// Walrus mainnet publisher / aggregator for Thunder file attachments.
// Attached files are encrypted client-side by the SDK's AttachmentsManager
// (Seal envelope per file) and uploaded as quilts via the HTTP publisher.
// The blob IDs travel with the message through the TimestreamAgent DO.
const WALRUS_PUBLISHER_URL = 'https://publisher.walrus-mainnet.h2o-nodes.com';
const WALRUS_AGGREGATOR_URL = 'https://aggregator.walrus-mainnet.h2o-nodes.com';
const WALRUS_EPOCHS = 10;

// Attachment size limits — kept well under public publisher 413 ceilings.
const ATTACH_MAX_FILES = 4;
const ATTACH_MAX_FILE_BYTES = 2_000_000;      // 2 MB per file
const ATTACH_MAX_TOTAL_BYTES = 5_000_000;     // 5 MB total per send

// Mainnet Seal key servers (free, open mode, 2-of-3 threshold):
// Overclock, Studio Mirai, H2O Nodes.
// NodeInfra excluded — broken CORS (duplicate Access-Control-Allow-Origin: *, *)
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
  /** Resolved attachment handles from AttachmentsManager.resolve.
   *  Each handle has fileName / mimeType / fileSize + a lazy data() loader. */
  attachments?: AttachmentHandle[];
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

// ─── Seal session key cache ─────────────────────────────────────────
// Phantom auto-signs trusted personal messages within a session, so users
// don't see a prompt on hard refresh. WaaP doesn't have that shortcut and
// re-prompts every time the SDK mints a fresh SessionKey.
//
// Fix: own the session key lifecycle via the SDK's `getSessionKey` tier.
// Export the key after signing, persist to localStorage, restore via
// SessionKey.import on the next page load. The earlier attempt at this
// failed because I passed the raw gqlClient as `suiClient` to
// SessionKey.create — the SDK's internal session-key-manager passes the
// EXTENDED client (the one returned from createSuiStackMessagingClient
// after the $extend chain). Using `_client` here closes that gap.
const SESSION_KEY_TTL_MIN = 30;
const SK_STORAGE_KEY = (addr: string) => `ski:seal-sk:v3:${addr.toLowerCase()}`;
let _sessionKeyPromise: Promise<SessionKey> | null = null;

async function _loadOrMintSessionKey(opts: ThunderClientOptions): Promise<SessionKey> {
  if (_sessionKeyPromise) return _sessionKeyPromise;
  _sessionKeyPromise = (async () => {
    if (!_client) throw new Error('Thunder client not yet initialized');
    // Try to restore from localStorage.
    try {
      const raw = localStorage.getItem(SK_STORAGE_KEY(opts.address));
      if (raw) {
        const exported = JSON.parse(raw) as ExportedSessionKey;
        if (exported?.address?.toLowerCase() === opts.address.toLowerCase()) {
          const expiresAtMs = exported.creationTimeMs + exported.ttlMin * 60_000;
          // Require at least 60s of validity left so we don't restore a key
          // that will expire mid-encrypt.
          if (expiresAtMs > Date.now() + 60_000) {
            try {
              const restored = SessionKey.import(exported, _client as never);
              if (!restored.isExpired()) {
                console.log('[thunder] restored Seal session key, expires in', Math.round((expiresAtMs - Date.now()) / 60_000), 'min');
                return restored;
              }
            } catch (importErr) {
              console.warn('[thunder] SessionKey.import failed, will mint fresh:', importErr instanceof Error ? importErr.message : importErr);
              try { localStorage.removeItem(SK_STORAGE_KEY(opts.address)); } catch {}
            }
          } else {
            console.log('[thunder] cached Seal session key expired, will mint fresh');
          }
        }
      }
    } catch { /* fall through to mint */ }

    // Mint fresh — prompts the wallet once.
    console.log('[thunder] minting fresh Seal session key (will prompt wallet)');
    const key = await SessionKey.create({
      address: opts.address,
      packageId: MAINNET_SUI_STACK_MESSAGING_PACKAGE_CONFIG.originalPackageId,
      ttlMin: SESSION_KEY_TTL_MIN,
      suiClient: _client as never,
    });
    const personalMsg = key.getPersonalMessage();
    // opts.signPersonalMessage is actually a (msg: Uint8Array) => ... function
    // at runtime despite the SignPersonalMessageFn type declaring an object
    // arg — the caller in ui.ts passes bytes directly. Match the real runtime
    // shape or the wallet signs garbage and Seal servers reject the cert.
    const signed = await (opts.signPersonalMessage as unknown as (msg: Uint8Array) => Promise<{ signature: string }>)(personalMsg);
    await key.setPersonalMessageSignature(signed.signature);

    // Persist for restoration on next page load. The SDK's `export()` returns
    // an object with a booby-trapped `toJSON` property that throws if you call
    // JSON.stringify on it directly — intended to force IndexedDB usage. Pluck
    // the fields into a plain object ourselves so localStorage works.
    try {
      const raw = key.export() as ExportedSessionKey & { sessionKey: string };
      const serializable = {
        address: raw.address,
        packageId: raw.packageId,
        mvrName: raw.mvrName,
        creationTimeMs: raw.creationTimeMs,
        ttlMin: raw.ttlMin,
        personalMessageSignature: raw.personalMessageSignature,
        sessionKey: raw.sessionKey,
      };
      localStorage.setItem(SK_STORAGE_KEY(opts.address), JSON.stringify(serializable));
      console.log('[thunder] cached Seal session key for', SESSION_KEY_TTL_MIN, 'min');
    } catch (e) {
      console.warn('[thunder] failed to persist Seal session key:', e instanceof Error ? e.message : e);
    }
    return key;
  })();
  // On failure, drop the in-flight promise so the next caller retries cleanly.
  _sessionKeyPromise.catch(() => { _sessionKeyPromise = null; });
  return _sessionKeyPromise;
}

/**
 * Initialize the Thunder Timestream client with Seal encryption.
 * Called on wallet connect.
 */
export function initThunderClient(opts: ThunderClientOptions) {
  _address = opts.address;
  _sessionKeyPromise = null; // clear in-memory cache on re-init

  _signer = new DappKitSigner({
    address: opts.address,
    signPersonalMessage: (args) => opts.signPersonalMessage(args.message),
  });

  const gqlClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

  _warmer = () => _loadOrMintSessionKey(opts);
  _client = createSuiStackMessagingClient(gqlClient as any, {
    seal: { serverConfigs: SEAL_SERVERS, verifyKeyServers: true },
    encryption: {
      sessionKey: {
        getSessionKey: () => _loadOrMintSessionKey(opts),
      },
    },
    relayer: {
      transport: new TimestreamRelayer(),
    },
    attachments: {
      storageAdapter: new WalrusHttpStorageAdapter({
        publisherUrl: WALRUS_PUBLISHER_URL,
        aggregatorUrl: WALRUS_AGGREGATOR_URL,
        epochs: WALRUS_EPOCHS,
      }),
      maxAttachments: ATTACH_MAX_FILES,
      maxFileSizeBytes: ATTACH_MAX_FILE_BYTES,
      maxTotalFileSizeBytes: ATTACH_MAX_TOTAL_BYTES,
    },
  });

  return _client;
}

export function getThunderClient(): MessagingClient {
  if (!_client) throw new Error('Thunder client not initialized');
  return _client;
}

let _warmer: (() => Promise<SessionKey>) | null = null;

/**
 * Best-effort restore of a cached Seal session key. Does NOT mint a
 * fresh key — that happens on-demand in the encrypt/decrypt path. This
 * means warm-on-connect never prompts the wallet, so a broken wallet
 * signing backend (e.g. WaaP upstream outage) cannot block page load.
 */
export async function warmThunderSession(opts?: { address?: string }): Promise<void> {
  try {
    const addr = (opts?.address || _address || '').toLowerCase();
    if (!addr || !_client) return;
    const raw = localStorage.getItem(SK_STORAGE_KEY(addr));
    if (!raw) return;
    const exported = JSON.parse(raw) as ExportedSessionKey;
    if (exported?.address?.toLowerCase() !== addr) return;
    const expiresAtMs = exported.creationTimeMs + exported.ttlMin * 60_000;
    if (expiresAtMs <= Date.now() + 60_000) return;
    // Import into a Promise and stash so _loadOrMintSessionKey picks
    // it up without having to re-parse or re-prompt.
    const restored = SessionKey.import(exported, _client as never);
    if (restored.isExpired()) return;
    _sessionKeyPromise = Promise.resolve(restored);
    console.log('[thunder] warmed Seal session key from cache, expires in', Math.round((expiresAtMs - Date.now()) / 60_000), 'min');
  } catch (e) {
    console.warn('[thunder] warm session restore failed (silent, will mint lazily on next op):', e instanceof Error ? e.message : e);
  }
}

export function resetThunderClient() {
  if (_client) {
    try { _client.messaging.disconnect(); } catch {}
  }
  _client = null;
  _signer = null;
  _address = '';
  _warmer = null;
  _sessionKeyPromise = null;
}

// ─── Timestream DO transport ────────────────────────────────────────
// Implements RelayerTransport inline — talks to /api/timestream/:groupId/*

function toB64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ─── Message padding (P1.2) ────────────────────────────────────────
// Pad to fixed buckets so ciphertext size does not leak plaintext length.
// Wire format: [u32 LE length][plaintext][zero padding up to bucket].
const PAD_BUCKETS = [256, 1024, 4096, 16384] as const;
const PAD_MAX = PAD_BUCKETS[PAD_BUCKETS.length - 1];

function padPlaintext(data: Uint8Array): Uint8Array {
  const len = data.length;
  const needed = 4 + len;
  if (needed > PAD_MAX) {
    // Oversize: still length-prefixed, just not bucketed.
    const out = new Uint8Array(needed);
    new DataView(out.buffer).setUint32(0, len, true);
    out.set(data, 4);
    return out;
  }
  const bucket = PAD_BUCKETS.find(b => b >= needed) ?? PAD_MAX;
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, len, true);
  out.set(data, 4);
  return out;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) return padded;
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  if (len > padded.length - 4 || len > PAD_MAX) return padded;
  return padded.slice(4, 4 + len);
}

/** Strip the pad/length prefix off an already-decoded string.
 *  The SDK returns decrypted text as a string; we re-encode, unpad, re-decode. */
function unpadPlaintextText(text: string): string {
  try {
    const bytes = new TextEncoder().encode(text);
    return new TextDecoder().decode(unpadPlaintext(bytes));
  } catch { return text; }
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
        // Wire-format attachments from the SDK's AttachmentsManager.upload —
        // just forward the array. Each entry is already JSON-safe.
        attachments: params.attachments,
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
        // Forward wire attachments to the SDK so AttachmentsManager.resolve
        // can turn them into AttachmentHandle[] on read.
        attachments: Array.isArray(m.attachments) ? m.attachments : [],
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
    return {
      ...m,
      encryptedText: fromB64(m.encryptedText),
      nonce: fromB64(m.nonce),
      keyVersion: BigInt(m.keyVersion),
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
    };
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
  /** Optional file attachments — Seal-encrypted per file, uploaded to Walrus
   *  via the configured HTTP publisher. Limits enforced by the SDK. */
  files?: AttachmentFile[];
  /** Sign and execute a transaction (PTB for transfers + Storm creation) */
  signAndExecute?: (tx: Uint8Array | Transaction) => Promise<any>;
}): Promise<{ messageId: string }> {
  const groupId = 'uuid' in opts.groupRef ? opts.groupRef.uuid : '';

  const client = getThunderClient();
  const hasTransfer = opts.transfer && opts.transfer.amountMist > 0n && opts.signAndExecute;
  const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;

  // Check if Storm exists
  let needsStorm = false;
  try {
    await client.messaging.view.getCurrentKeyVersion({ uuid: groupId });
  } catch (e) {
    needsStorm = true;
    try { console.log('[thunder] Storm missing for uuid', groupId, '— will create. Reason:', e instanceof Error ? e.message : e); } catch {}
  }
  try { console.log('[thunder] sendThunder start', { groupId, needsStorm, hasTransfer, hasFiles, recipient: opts.recipientAddress }); } catch {}

  // ─── Build single PTB: transfer + Storm + SUIAMI roster ──────
  // One signature covers everything
  if ((hasTransfer || needsStorm) && opts.signAndExecute) {

    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(_address));

    // 1. Transfer — swap SUI → USDC via DeepBook, then transfer USDC to the
    // recipient. Phantom / WaaP / Suiet all render the net tx as "~$1.00 USDC
    // to <recipient>" instead of "1.06722 SUI" so the signing screen matches
    // the $ amount the user typed. amountMist is the SUI input size (computed
    // upstream from the USD amount × live SUI price × slippage buffer).
    if (hasTransfer) {
      // Swap SUI → USDC via DeepBook, then transfer the USDC to the recipient.
      // USDC is dollar-pegged, so Phantom / WaaP / Suiet render the confirm
      // screen as "≈ 1 USDC → <recipient>" matching the $ the user typed.
      const [suiIn] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.transfer!.amountMist)]);
      const [zeroDeep] = tx.moveCall({
        target: '0x2::coin::zero',
        typeArguments: [DB_DEEP_TYPE],
      });
      // swap_exact_base_for_quote(pool, base_in, deep_in, min_quote_out, clock)
      // returns [usdcOut, suiChange, deepChange].
      const hop = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: [DB_SUI_TYPE, DB_USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: DB_SUI_USDC_POOL,
            initialSharedVersion: DB_SUI_USDC_POOL_INITIAL_SHARED_VERSION,
            mutable: true,
          }),
          suiIn,
          zeroDeep,
          tx.pure.u64(0),
          tx.object('0x6'),
        ],
      });
      const recipientAddr = tx.pure.address(normalizeSuiAddress(opts.transfer!.recipientAddress));
      const senderAddr = tx.pure.address(normalizeSuiAddress(_address));
      tx.transferObjects([hop[0]], recipientAddr);
      tx.transferObjects([hop[1], hop[2]], senderAddr);
    }

    // 2. Storm creation (if no on-chain Storm exists)
    if (needsStorm) {
      const members = opts.recipientAddress ? [opts.recipientAddress] : [];
      // CRITICAL: pass `uuid` so the Storm is created at the deterministic
      // object ID we look up later via `encrypt({ uuid })`. Without this,
      // the SDK generates a random UUID and the object lands at a different
      // derived address than the encrypt path resolves — every send fails
      // with "Object <derived> not found" after the PTB succeeds.
      client.messaging.tx.createAndShareGroup({
        uuid: groupId,
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

    // Pre-build the transaction to Uint8Array using our own GraphQL transport
    // BEFORE handing off to the wallet. WaaP bundles a v1.x SuiClient whose
    // resolveTransactionPlugin reads `gasConfig.price` — but v2.x Transaction
    // uses `gasData`. If we pass the unbuilt Transaction, WaaP's internal
    // build path crashes with "Cannot read properties of undefined (reading
    // 'price')". Pre-building on our side with a v2 client bypasses WaaP's
    // broken resolver entirely; the iframe just signs the exact bytes.
    const _buildClient = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
    const _txBytes = await tx.build({ client: _buildClient as never });

    // One signature for transfer + Storm + SUIAMI
    const _execResult = await opts.signAndExecute(_txBytes);
    // Capture the tx digest for the transfer note — gives storm
    // participants a way to verify the on-chain record privately,
    // without exposing anything the on-chain tx doesn't already publish.
    const _txDigest: string = (_execResult && typeof _execResult === 'object' && 'digest' in _execResult)
      ? String((_execResult as { digest: unknown }).digest || '')
      : '';

    if (needsStorm) {
      // The freshly-shared PermissionedGroup object needs to propagate to
      // the fullnode the Seal SDK reads from. 4s here absorbs most of the
      // lag; encryptWithRetry below has an additional ~20s retry window.
      await new Promise(r => setTimeout(r, 4000));
      // Add both participants to the DO
      try {
        await fetch(`/api/timestream/${encodeURIComponent(groupId)}/add-participant`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: _address }),
        });
        if (opts.recipientAddress) {
          await fetch(`/api/timestream/${encodeURIComponent(groupId)}/add-participant`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address: opts.recipientAddress, addedBy: _address }),
          });
        }
      } catch {}
    }

    // Record the transfer as a private Thunder in the Timestream DO.
    // Route through Seal envelope encryption — the amount, recipient,
    // and tx digest are sensitive metadata and must never hit the DO
    // in cleartext. Plaintext is decryptable only by storm participants.
    //
    // Format: "💸 $1.12 → @justy · tx:abcd" where the tx suffix is the
    // last 4 chars of the on-chain digest. Storm participants can
    // verify the on-chain record via that suffix without leaking any
    // info the on-chain tx doesn't already publish. The 💸 prefix is
    // the render-side marker that styles the bubble green.
    if (hasTransfer) {
      const amtLabel = opts.text.match(/\$(\d+(?:\.\d{0,2})?)/)?.[1] || (Number(opts.transfer!.amountMist) / 1e9).toFixed(2);
      const _recipTag = opts.recipientName ? ` \u2192 @${opts.recipientName}` : '';
      const _digestSuffix = _txDigest ? ` \u00b7 tx:${_txDigest.slice(0, 6)}` : '';
      const transferNote = `\u{1F4B8} $${amtLabel}${_recipTag}${_digestSuffix}`;
      const noteBytes = padPlaintext(new TextEncoder().encode(transferNote));
      const noteEnv = await encryptWithRetry(groupId, noteBytes);
      await fetch(`/api/timestream/${encodeURIComponent(groupId)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          groupId,
          encryptedText: toB64(noteEnv.ciphertext),
          nonce: toB64(noteEnv.nonce),
          keyVersion: noteEnv.keyVersion.toString(),
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

  // ─── Attachment path — route through SDK's AttachmentsManager ───────
  // When files are attached, bypass the direct DO POST and use the SDK's
  // client.messaging.sendMessage. It orchestrates: encrypt text → upload
  // each file via Walrus HTTP publisher → build Attachment[] wire records
  // → post all of it through our TimestreamRelayer transport in one call.
  if (hasFiles) {
    if (!_signer) throw new Error('Thunder client not initialized');
    const result = await client.messaging.sendMessage({
      signer: _signer as never,
      groupRef: opts.groupRef,
      text: opts.text,
      files: opts.files,
    });
    return { messageId: result.messageId };
  }

  // ─── Seal-encrypt + send via Timestream DO (free, no on-chain tx) ───
  // NO plaintext fallback. If encryption fails, the send fails — we will
  // never store cleartext in the DO labeled as ciphertext.
  const msgBytes = padPlaintext(new TextEncoder().encode(opts.text));
  const envelope = await encryptWithRetry(groupId, msgBytes);
  await fetch(`/api/timestream/${encodeURIComponent(groupId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groupId,
      encryptedText: toB64(envelope.ciphertext),
      nonce: toB64(envelope.nonce),
      keyVersion: envelope.keyVersion.toString(),
      senderAddress: _address,
    }),
  });
  return { messageId: `msg-${Date.now()}` };
}

/**
 * Envelope-encrypt with a bounded retry. Storm creation in the same PTB
 * may race the on-chain key-version becoming queryable — the fullnode
 * read for the freshly-shared `PermissionedGroup` object can lag the
 * tx by several seconds. Retry for up to ~20s before giving up.
 * Never falls back to plaintext.
 */
async function encryptWithRetry(
  groupId: string,
  data: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: bigint }> {
  const client = getThunderClient();
  const delays = [500, 750, 1000, 1500, 2000, 2500, 3000, 3000, 3000, 3000]; // ~20s total
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await client.messaging.encryption.encrypt({ uuid: groupId, data });
    } catch (err) {
      lastErr = err;
      if (attempt >= delays.length) break;
      // Log first attempt failure so fresh-Storm races are visible in the console.
      if (attempt === 0) {
        try { console.warn(`[thunder] encrypt attempt 1 failed, retrying:`, err instanceof Error ? err.message : err); } catch {}
      }
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  throw new Error(`Thunder encrypt failed after ${delays.length + 1} attempts: ${String(lastErr)}`);
}

/**
 * Fetch messages from a Timestream DO.
 * Reads directly from the DO — messages are stored as base64 text.
 * Falls back to SDK's Seal-decrypt path for legacy encrypted messages.
 */
export async function getThunders(opts: {
  groupRef: GroupRef;
  afterOrder?: number;
  limit?: number;
}): Promise<{ messages: ThunderMessage[]; hasNext: boolean }> {
  const groupId = 'uuid' in opts.groupRef ? opts.groupRef.uuid : '';

  // Self-add to the DO participants list before fetching. The sender's
  // sendThunder flow is supposed to add the recipient after Storm creation,
  // but that hook runs inside try/catch and silently swallows failures —
  // so recipients regularly miss the add. Self-adding on first fetch is
  // the safety net. The DO's _handleAddParticipant accepts { address }
  // with no addedBy (no cross-participant auth required for plain adds).
  if (_address) {
    try {
      await fetch(`/api/timestream/${encodeURIComponent(groupId)}/add-participant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: _address }),
      });
    } catch { /* best-effort — proceed to fetch regardless */ }
  }

  // Direct DO fetch + Seal decrypt
  const client = getThunderClient();
  try {
    const res = await fetch(`/api/timestream/${encodeURIComponent(groupId)}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        afterOrder: opts.afterOrder,
        limit: opts.limit,
        address: _address,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { messages: any[]; hasNext: boolean; participants?: string[] };
      const participants: string[] = Array.isArray(data.participants) ? data.participants : [];
      // If any message carries attachments, fall through to the SDK read
      // path — AttachmentsManager.resolve is private and only reachable via
      // client.messaging.getMessages. The SDK handles the full pipeline
      // (decrypt text + resolve attachment handles) using our TimestreamRelayer.
      const hasAnyAttachments = data.messages.some((m: any) => Array.isArray(m.attachments) && m.attachments.length > 0);
      if (hasAnyAttachments) {
        if (!_signer) throw new Error('Thunder client not initialized');
        const sdkResult = await client.messaging.getMessages({
          signer: _signer as never,
          groupRef: opts.groupRef,
          afterOrder: opts.afterOrder,
          limit: opts.limit,
        });
        const sdkMessages: ThunderMessage[] = sdkResult.messages.map((dm: DecryptedMessage) => ({
          messageId: dm.messageId,
          groupId,
          order: dm.order,
          text: unpadPlaintextText(dm.text),
          senderAddress: dm.senderAddress,
          createdAt: dm.createdAt,
          updatedAt: dm.updatedAt,
          isEdited: dm.isEdited,
          isDeleted: dm.isDeleted,
          senderVerified: dm.senderVerified,
          attachments: dm.attachments,
        }));
        return { messages: sdkMessages, hasNext: sdkResult.hasNext };
      }
      const messages: ThunderMessage[] = [];
      for (const m of data.messages) {
        let text = '';
        const ciphertext = fromB64(m.encryptedText);
        const nonce = fromB64(m.nonce || '');
        const kv = BigInt(m.keyVersion || '0');
        try {
          // Try Seal decryption first
          const plaintext = await client.messaging.encryption.decrypt({
            uuid: groupId,
            envelope: { ciphertext, nonce, keyVersion: kv },
          });
          text = new TextDecoder().decode(unpadPlaintext(plaintext));
        } catch (decryptErr) {
          // Log the first decrypt failure per group so binary garbage
          // doesn't silently land in the UI. Two legitimate fallbacks:
          //   1. legacy unencrypted messages from pre-Seal days
          //   2. plaintext system notifications from server agents
          // Anything else is a real decrypt failure (missing perms,
          // wrong key version) and should surface to devtools.
          try { console.warn('[thunder] decrypt failed for', groupId, 'msg', m.messageId || m.order, ':', decryptErr instanceof Error ? decryptErr.message : decryptErr); } catch {}
          // Heuristic: if the ciphertext bytes look like printable UTF-8
          // plaintext, render them. Otherwise drop the message — binary
          // garbage in chat bubbles is strictly worse than silence.
          try {
            const candidate = new TextDecoder('utf-8', { fatal: true }).decode(ciphertext);
            // Printable-only check: no control chars except \n \t \r
            if (/^[\x20-\x7E\u00A0-\uFFFF\n\r\t]+$/.test(candidate) && candidate.length < 4096) {
              text = candidate;
            } else {
              text = '\u{1F512} [could not decrypt]';
            }
          } catch {
            text = '\u{1F512} [could not decrypt]';
          }
        }
        // P1.1 — prefer senderIndex → participants[] lookup, fall back to legacy senderAddress
        const resolvedSender = typeof m.senderIndex === 'number' && m.senderIndex >= 0 && m.senderIndex < participants.length
          ? participants[m.senderIndex]
          : (m.senderAddress || '');
        messages.push({
          messageId: m.messageId || m.id || `msg-${m.order}`,
          groupId,
          order: m.order ?? 0,
          text,
          senderAddress: resolvedSender,
          createdAt: m.timestamp ?? m.createdAt ?? Date.now(),
          updatedAt: m.timestamp ?? m.updatedAt ?? Date.now(),
          isEdited: false,
          isDeleted: false,
          senderVerified: false,
        });
      }
      return { messages, hasNext: data.hasNext ?? false };
    }
  } catch {}

  // Fallback: SDK path with Seal decryption
  const client2 = getThunderClient();
  const result = await client2.messaging.getMessages({
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

// ─── Real-time thunder subscribe (Jolteon Lv. 25) ───────────────────
// Opens a WebSocket to /api/timestream/<gid>/ws and routes pushed
// events (snapshot / thunder / edit / delete / purge) to the caller.
// Auto-reconnects with exponential backoff on drop. AbortSignal tears
// down the socket + cancels any pending reconnect.

export type ThunderStreamEvent =
  | { kind: 'snapshot'; messages: any[]; participants: string[] }
  | { kind: 'thunder'; message: any; participants: string[] }
  | { kind: 'edit'; message: any }
  | { kind: 'delete'; messageId: string }
  | { kind: 'purge'; purged: number }
  | { kind: 'error'; error: string };

export interface ThunderStreamHandle {
  close(): void;
}

export function subscribeThunderStream(opts: {
  groupId: string;
  onEvent: (ev: ThunderStreamEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  signal?: AbortSignal;
}): ThunderStreamHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 500;

  const url = (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/timestream/${encodeURIComponent(opts.groupId)}/ws`;
  })();

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn('[thunder] WS constructor threw, will retry:', e);
      schedule();
      return;
    }
    ws.addEventListener('open', () => {
      backoff = 500;
      opts.onOpen?.();
    });
    ws.addEventListener('message', (ev) => {
      try {
        // Filter internal framework protocol frames (cf_agent_* etc.)
        // and only surface our own JSON event envelopes.
        const text = typeof ev.data === 'string' ? ev.data : '';
        if (!text || text[0] !== '{') return;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed.kind !== 'string') return;
        if (!['snapshot', 'thunder', 'edit', 'delete', 'purge', 'error'].includes(parsed.kind)) return;
        opts.onEvent(parsed);
      } catch { /* ignore malformed frames */ }
    });
    ws.addEventListener('close', () => {
      opts.onClose?.();
      if (!closed) schedule();
    });
    ws.addEventListener('error', () => {
      try { ws?.close(); } catch {}
    });
  };

  const schedule = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(backoff, 10_000);
    backoff = Math.min(backoff * 2, 10_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const close = () => {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { ws?.close(); } catch {}
    ws = null;
  };

  opts.signal?.addEventListener('abort', close, { once: true });

  connect();
  return { close };
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
  /** UUID for deterministic object derivation. Same UUID → same on-chain address. */
  uuid?: string;
  name: string;
  members: string[];
  transaction?: Transaction;
}): Transaction {
  const client = getThunderClient();
  const tx = client.messaging.tx.createAndShareGroup({
    uuid: opts.uuid ?? opts.name,
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
// Forward lookup cache: bare name → address. Populated by
// lookupRecipientAddress and its cached variant. Pair-based storm
// group IDs are built from addresses so that primary-name rotations
// don't orphan conversation history.
const _forwardLookupCache: Record<string, string | null> = {};

/**
 * Compose the canonical Storm group ID from two Sui addresses. Lower-
 * cased + sorted so the ID is independent of which participant is the
 * "sender". Addresses are immutable, so this ID survives any primary
 * SuiNS rotation on either side.
 *
 * Length constraint: the Move-side `metadata::new` in the messaging
 * package asserts the `name`/`uuid` strings are below some maximum.
 * Full address pairs (2×64 = 128 hex chars) blow past that limit and
 * abort with code 0 at instruction 7. We truncate each address to its
 * leading 14 hex chars — 56 bits per side, 112 bits total — which is
 * more than enough to avoid collisions for any realistic user base.
 * Final ID length: `t-` + 14 + 14 = 30 chars.
 */
export function makeThunderGroupId(addrA: string, addrB: string): string {
  const a = (addrA || '').toLowerCase().replace(/^0x/, '').slice(0, 14);
  const b = (addrB || '').toLowerCase().replace(/^0x/, '').slice(0, 14);
  if (!a || !b) throw new Error('makeThunderGroupId: both addresses required');
  return `t-${[a, b].sort().join('')}`;
}

/** Cached forward lookup: bare name → target address. */
export async function lookupRecipientAddressCached(name: string): Promise<string | null> {
  const key = name.replace(/\.sui$/i, '').toLowerCase();
  if (key in _forwardLookupCache) return _forwardLookupCache[key];
  const addr = await lookupRecipientAddress(name);
  _forwardLookupCache[key] = addr;
  return addr;
}

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

/** Reverse lookup: address → primary SuiNS name (without .sui suffix). */
const _reverseLookupCache: Record<string, string | null> = {};
export async function reverseLookupName(address: string): Promise<string | null> {
  if (!address) return null;
  const key = address.toLowerCase();
  if (key in _reverseLookupCache) return _reverseLookupCache[key];
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ address(address: "${address}") { defaultNameRecord { domain } } }` }),
    });
    const data = await res.json() as any;
    const domain: string | undefined = data?.data?.address?.defaultNameRecord?.domain;
    const name = domain ? domain.replace(/\.sui$/, '') : null;
    _reverseLookupCache[key] = name;
    return name;
  } catch {
    _reverseLookupCache[key] = null;
    return null;
  }
}

// ─── Error humanization ─────────────────────────────────────────────
// Map common Thunder failure modes to user-facing messages so we don't show
// "Unexpected error" for everything. Pattern-matching the raw error message
// from the SDK / chain. Returns null when the user cancelled (caller should
// silently ignore in that case to avoid a misleading toast).

export type ThunderErrorKind =
  | 'cancelled'
  | 'insufficient-gas'
  | 'insufficient-balance'
  | 'pool-liquidity'
  | 'iusd-undercollateralized'
  | 'object-not-found'
  | 'sequence-too-old'
  | 'session-expired'
  | 'seal-decrypt-failed'
  | 'storm-not-found'
  | 'unknown';

export interface HumanizedError {
  kind: ThunderErrorKind;
  message: string;
  /** When true, the caller should NOT show a toast — user dismissed the popup. */
  silent: boolean;
}

export function humanizeThunderError(err: unknown): HumanizedError {
  const raw = err instanceof Error ? (err.stack || err.message) : String(err ?? '');
  const lower = raw.toLowerCase();
  // Log the full raw error so diagnostics aren't lost to the toast slice.
  // The UI toast shows only the first ~300 chars; this console line carries
  // the complete stack including truncated package/module/function paths.
  try { console.error('[thunder] send error (full):', err); } catch {}

  // ── User cancelled — never show a toast ─────────────────────────
  if (lower.includes('reject') || lower.includes('cancel') || lower.includes('user denied') || lower.includes('user closed')) {
    return { kind: 'cancelled', message: 'Cancelled', silent: true };
  }

  // ── Gas / balance issues ────────────────────────────────────────
  if (lower.includes('gasbalancetoolow') || lower.includes('insufficient gas') || lower.includes('not enough gas')) {
    return { kind: 'insufficient-gas', message: 'Not enough SUI to cover gas. Top up your wallet and retry.', silent: false };
  }
  if (lower.includes('insufficientcoinbalance') || lower.includes('insufficient balance') || lower.includes('balance too low') || lower.includes('notenoughcoins')) {
    return { kind: 'insufficient-balance', message: 'Not enough balance for this send.', silent: false };
  }

  // ── DeepBook pool liquidity (abort code 12) ─────────────────────
  if (/moveabort.*abort code:\s*12/i.test(raw) || lower.includes('insufficient liquidity')) {
    return { kind: 'pool-liquidity', message: 'Pool liquidity too low. Try a smaller amount.', silent: false };
  }

  // ── iUSD undercollateralized (abort code 1 in iusd::mint) ───────
  if (/moveabort.*abort code:\s*1.*iusd::mint/i.test(raw)) {
    return { kind: 'iusd-undercollateralized', message: 'iUSD mint blocked — collateral state is unhealthy.', silent: false };
  }

  // ── Storm / object not found (fresh-Storm propagation race) ─────
  const objNotFound = /object\s+0x[a-f0-9]+\s+not found/i.test(raw);
  if (objNotFound && lower.includes('storm')) {
    return { kind: 'storm-not-found', message: 'Storm not yet live on-chain. Wait a few seconds and retry.', silent: false };
  }
  if (objNotFound) {
    return { kind: 'object-not-found', message: 'On-chain object not found. The network may be lagging — retry in a moment.', silent: false };
  }

  // ── Wallet sequence drift ───────────────────────────────────────
  if (lower.includes('sequencenumbertooold') || lower.includes('stale')) {
    return { kind: 'sequence-too-old', message: 'Wallet state out of sync. Refresh the page and retry.', silent: false };
  }

  // ── Seal session / decrypt issues ───────────────────────────────
  if (lower.includes('expiredsessionkey') || lower.includes('session expired') || lower.includes('session key.*expired')) {
    return { kind: 'session-expired', message: 'Encryption session expired. Sign in to your wallet again to continue.', silent: false };
  }
  if (lower.includes('decryption') || lower.includes('decrypt failed') || lower.includes('noaccess')) {
    return { kind: 'seal-decrypt-failed', message: 'Decryption failed. The message may have been deleted or you may not be a Storm member.', silent: false };
  }

  // ── Fall through ────────────────────────────────────────────────
  // Surface a longer slice of the original message so unmapped errors
  // include the package/module/function that aborted. The toast CSS
  // wraps long text across multiple lines.
  const summary = (err instanceof Error ? err.message : String(err ?? '')).slice(0, 400) || 'Send failed';
  return { kind: 'unknown', message: `Send failed: ${summary}`, silent: false };
}

// Re-export types
export type { Attachment, AttachmentFile, AttachmentHandle, DecryptedMessage, GroupRef, SignPersonalMessageFn };
