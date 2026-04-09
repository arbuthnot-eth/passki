/**
 * Thunder client — encrypt signals between SuiNS identities.
 *
 * Signal: AES encrypt → deposit into recipient's storm on Storm (one PTB).
 * Quest: batch quest (one PTB) → parse Questfi events → AES decrypt all signals.
 *
 * Storm is the shared object. Storm is the per-name collection (dynamic field).
 * Empty stormes are removed for storage rebate.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import { maybeAppendRoster } from '../suins.js';

// ─── Timing constants ────────────────────────────────────────────────
const TX_INDEX_WAIT_MS = 2_000;
import {
  THUNDER_VERSION,
  THUNDER_PAYLOAD_SCHEMA_VERSION,
  THUNDER_V5_VERSION,
  THUNDER_PACKAGE_ID,
  STORM_ID,
  STORM_V1_PACKAGE_ID,
  STORM_V1_ID,
  LEGACY_STORMS,
  type ThunderPayload,
  type ThunderPayloadEntity,
  type ThunderPayloadParseResult,
  type ThunderPayloadStructured,
} from './thunder-types.js';
import { deriveStormIdFromAddresses } from './ika.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Hash the full domain with .sui — matches the Move contract's keccak256(nft.domain().to_string()). */
export function nameHash(name: string): Uint8Array {
  const full = name.toLowerCase().replace(/\.sui$/, '') + '.sui';
  return keccak_256(new TextEncoder().encode(full));
}

function xorBytes(data: Uint8Array, mask: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] ^ mask[i % mask.length];
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeThunderName(name: string): string {
  return name.replace(/\.sui$/i, '').toLowerCase().trim();
}

function sanitizeThunderText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

function normalizeThunderWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function parseThunderEntities(text: string): ThunderPayloadEntity[] {
  const entities: ThunderPayloadEntity[] = [];

  const mentionRe = /@([a-z0-9-]{3,63})/gi;
  for (let match = mentionRe.exec(text); match; match = mentionRe.exec(text)) {
    entities.push({
      kind: 'mention',
      raw: match[0],
      value: normalizeThunderName(match[1]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const commandRe = /^\/([a-z][a-z0-9_-]{0,31})(?=\s|$)/i;
  const commandMatch = commandRe.exec(text);
  if (commandMatch) {
    entities.push({
      kind: 'command',
      raw: commandMatch[0],
      value: commandMatch[1].toLowerCase(),
      start: commandMatch.index ?? 0,
      end: (commandMatch.index ?? 0) + commandMatch[0].length,
    });
  }

  return entities;
}

export interface ThunderParsedMessage {
  raw: string;
  normalized: string;
  intent: ThunderPayloadParseResult['intent'];
  recipients: string[];
  mentions: string[];
  commands: string[];
  entities: ThunderPayloadEntity[];
  confidence: number;
}

export function parseThunderMessageInput(message: string, recipientName?: string): ThunderParsedMessage {
  const raw = sanitizeThunderText(message);
  const normalized = normalizeThunderWhitespace(raw);
  const entities = parseThunderEntities(normalized);
  const mentions = entities.filter((e) => e.kind === 'mention').map((e) => e.value);
  const commands = entities.filter((e) => e.kind === 'command').map((e) => e.value);
  const intent: ThunderParsedMessage['intent'] =
    commands.includes('reply') ? 'reply'
      : commands.includes('receipt') ? 'receipt'
        : commands.length > 0 ? 'command'
          : 'signal';

  const recipients = new Set<string>();
  const primaryRecipient = recipientName ? normalizeThunderName(recipientName) : '';
  if (primaryRecipient) recipients.add(primaryRecipient);
  for (const mention of mentions) recipients.add(mention);

  return {
    raw,
    normalized: normalized || raw,
    intent,
    recipients: [...recipients],
    mentions,
    commands,
    entities,
    confidence: entities.length > 0 ? 0.96 : 0.99,
  };
}

function makeThunderPayload(params: {
  transportVersion: typeof THUNDER_VERSION | typeof THUNDER_V5_VERSION;
  senderName: string;
  senderAddress: string;
  recipientName?: string;
  message: string;
  suiamiToken?: string;
}): ThunderPayload {
  const parsed = parseThunderMessageInput(params.message, params.recipientName);
  const payload: ThunderPayloadStructured = {
    v: params.transportVersion,
    pv: THUNDER_PAYLOAD_SCHEMA_VERSION,
    sender: params.senderName,
    senderAddress: normalizeSuiAddress(params.senderAddress),
    message: parsed.normalized,
    rawMessage: parsed.raw,
    timestamp: new Date().toISOString(),
    parsed: {
      schemaVersion: THUNDER_PAYLOAD_SCHEMA_VERSION,
      parser: 'deterministic',
      raw: parsed.raw,
      normalized: parsed.normalized,
      intent: parsed.intent,
      recipients: parsed.recipients,
      mentions: parsed.mentions,
      commands: parsed.commands,
      entities: parsed.entities,
      confidence: parsed.confidence,
    },
    ...(params.suiamiToken ? { suiami: params.suiamiToken } : {}),
  };
  return payload;
}

function normalizeThunderParsedResult(parsed: unknown, fallbackRaw: string): ThunderPayloadParseResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const raw = typeof value.raw === 'string' ? value.raw : fallbackRaw;
  const normalized = typeof value.normalized === 'string' ? value.normalized : normalizeThunderWhitespace(sanitizeThunderText(raw));
  const recipients = Array.isArray(value.recipients)
    ? value.recipients.filter((r): r is string => typeof r === 'string').map(normalizeThunderName)
    : [];
  const mentions = Array.isArray(value.mentions)
    ? value.mentions.filter((r): r is string => typeof r === 'string').map(normalizeThunderName)
    : [];
  const commands = Array.isArray(value.commands)
    ? value.commands.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
    : [];
  const entities = Array.isArray(value.entities)
    ? value.entities.flatMap((entry): ThunderPayloadEntity[] => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const kind = e.kind === 'command' ? 'command' : 'mention';
      const rawEntity = typeof e.raw === 'string' ? e.raw : '';
      const entityValue = typeof e.value === 'string' ? e.value : '';
      const start = typeof e.start === 'number' ? e.start : 0;
      const end = typeof e.end === 'number' ? e.end : start + rawEntity.length;
      return [{
        kind,
        raw: rawEntity,
        value: kind === 'mention' ? normalizeThunderName(entityValue) : entityValue.toLowerCase(),
        start,
        end,
      }];
    })
    : parseThunderEntities(normalized);
  const intent = value.intent === 'receipt' || value.intent === 'reply' || value.intent === 'command'
    ? value.intent
    : 'signal';
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? value.confidence
    : 0.95;

  const dedupRecipients = new Set<string>();
  for (const recipient of recipients) dedupRecipients.add(recipient);

  return {
    schemaVersion: THUNDER_PAYLOAD_SCHEMA_VERSION,
    parser: 'deterministic',
    raw,
    normalized: normalized || raw,
    intent,
    recipients: [...dedupRecipients],
    mentions,
    commands,
    entities,
    confidence,
  };
}

export function decodeThunderPayload(payload: unknown): ThunderPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const sender = typeof value.sender === 'string' ? value.sender : '';
  const senderAddress = typeof value.senderAddress === 'string' ? normalizeSuiAddress(value.senderAddress) : '';
  const message = typeof value.message === 'string' ? value.message : '';
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : new Date(0).toISOString();
  const base: ThunderPayload = {
    v: value.v === THUNDER_V5_VERSION ? THUNDER_V5_VERSION : THUNDER_VERSION,
    sender,
    senderAddress,
    message,
    timestamp,
    ...(typeof value.suiami === 'string' ? { suiami: value.suiami } : {}),
    ...(typeof value.receipt === 'string' ? { receipt: value.receipt } : {}),
  };

  if (value.pv === THUNDER_PAYLOAD_SCHEMA_VERSION) {
    const parsed = normalizeThunderParsedResult(value.parsed, typeof value.rawMessage === 'string' ? value.rawMessage : message);
    if (parsed) {
      return {
        ...base,
        pv: THUNDER_PAYLOAD_SCHEMA_VERSION,
        rawMessage: typeof value.rawMessage === 'string' ? value.rawMessage : parsed.raw,
        parsed,
      };
    }
  }

  return base;
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────

async function aesEncrypt(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; key: Uint8Array; nonce: Uint8Array }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, aesKey, toArrayBuffer(plaintext)));
  return { ciphertext, key, nonce };
}

async function aesDecrypt(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, aesKey, toArrayBuffer(ciphertext)));
}

// ─── Recipient NFT lookup ────────────────────────────────────────────

/** Look up the SuinsRegistration NFT object ID for a name via SuiNS. */
export async function lookupRecipientNftId(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const suinsClient = new SuinsClient({ client: gqlClient as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.nftId ?? null;
  } catch { return null; }
}

/** Resolve a SuiNS name to its target address. */
export async function lookupRecipientAddress(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const suinsClient = new SuinsClient({ client: gqlClient as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.targetAddress ?? null;
  } catch { return null; }
}

// ─── Signal (send) ──────────────────────────────────────────────────

/**
 * Build the Thunder signal PTB — AES encrypt + deposit in one tx.
 * Returns tx bytes ready for signing.
 */
export async function buildThunderSendTx(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  recipientNftObjectId: string,
  message: string,
  suiamiToken?: string,
  /** Optional: attach a SUI transfer to the same PTB */
  transfer?: { recipientAddress: string; amountMist: bigint },
): Promise<Uint8Array> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);
  const payload = makeThunderPayload({
    transportVersion: THUNDER_VERSION,
    senderAddress,
    senderName,
    recipientName,
    message,
    suiamiToken,
  });

  // AES encrypt
  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));

  // XOR mask the AES key — hash raw 32 bytes of the NFT object ID (matches Move's object::id().to_bytes())
  const nftHex = recipientNftObjectId.toLowerCase().replace(/^0x/, '');
  const nftRawBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) nftRawBytes[i] = parseInt(nftHex.slice(i * 2, i * 2 + 2), 16);
  const mask = keccak_256(nftRawBytes);
  const maskedKey = xorBytes(key, mask);

  // Build PTB — signal (fee set to 0 on-chain, pass zero coin for ABI compat)
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(senderAddress));
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'signal',
    arguments: [
      tx.object(STORM_ID),
      tx.pure.vector('u8', Array.from(ns)),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(maskedKey)),
      tx.pure.vector('u8', Array.from(nonce)),
      feeCoin,
      tx.object('0x6'),
    ],
  });
  // Roster piggyback disabled — v2 contract hits abort on upsert, needs debugging
  // maybeAppendRoster(tx, senderAddress, senderName);

  // Compose optional SUI transfer into the same PTB
  if (transfer && transfer.amountMist > 0n) {
    const [transferCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(transfer.amountMist)]);
    tx.transferObjects([transferCoin], tx.pure.address(normalizeSuiAddress(transfer.recipientAddress)));
  }

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

// ─── Query ──────────────────────────────────────────────────────────

/** Count pending signals for a single SuiNS name. */
export async function getThunderCount(recipientName: string): Promise<number> {
  const counts = await getThunderCountsBatch([recipientName]);
  const bare = recipientName.replace(/\.sui$/i, '').toLowerCase();
  return counts[bare] ?? 0;
}

/**
 * Get thunder presence for ALL names in one gRPC call.
 * Lists dynamic fields on Storm — if an storm exists for a name hash, it has ≥1 signal.
 * Returns a map of bareName → 1 (has thunder) or 0 (no thunder).
 */
export async function getThunderCountsBatch(names: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  if (names.length === 0) return result;

  // Build name hash → bare name lookup
  const hashToBare: Record<string, string> = {};
  for (const name of names) {
    const bare = name.replace(/\.sui$/i, '').toLowerCase();
    const ns = nameHash(bare);
    const hex = Array.from(ns).map(b => b.toString(16).padStart(2, '0')).join('');
    hashToBare[hex] = bare;
    result[bare] = 0;
  }

  try {
    const { grpcClient } = await import('../rpc.js');
    // Check both new and legacy storms
    const stormIds = [STORM_ID]; // Only check current storm — legacy signals are orphaned
    for (const sid of stormIds) {
      try {
        const dfResult = await grpcClient.listDynamicFields({ parentId: sid });
        const fields = dfResult.dynamicFields ?? [];
        for (const df of fields) {
          const bcsValues = Object.values(df.name.bcs as unknown as Record<string, number>);
          const nameBytes = bcsValues.slice(1);
          const hex = nameBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
          if (hashToBare[hex]) {
            result[hashToBare[hex]] = (result[hashToBare[hex]] || 0) + 1;
          }
        }
      } catch { /* skip this storm */ }
    }
  } catch { /* return cached zeros */ }

  return result;
}

// ─── Quest (batch) ──────────────────────────────────────────────────

/** Check pending signals on a specific storm for a name. Returns actual signal count via GraphQL. */
async function _countOnStorm(stormId: string, recipientName: string): Promise<number> {
  try {
    const bare = recipientName.replace(/\.sui$/i, '').toLowerCase();
    const ns = nameHash(bare);
    const hex = Array.from(ns).map(b => b.toString(16).padStart(2, '0')).join('');

    // Try GraphQL first — can read dynamic field content
    try {
      const res = await fetch('https://graphql.mainnet.sui.io/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ object(address: "${stormId}") { dynamicFields { nodes { name { json } value { ... on MoveValue { json } } } } } }` }),
      });
      const gql = await res.json() as any;
      const nodes = gql?.data?.object?.dynamicFields?.nodes ?? [];
      for (const n of nodes) {
        const val = n?.value?.json;
        if (val?.signals) {
          // Match by checking if this is our name's thunderstorm
          // Name hash is base64 in the key — convert our hex to base64 to match
          const nameB64 = btoa(String.fromCharCode(...Array.from(ns)));
          const keyB64 = typeof n.name?.json === 'string' ? n.name.json : '';
          if (keyB64 === nameB64) return val.signals.length;
        }
      }
    } catch { /* fall back to gRPC */ }

    // Fallback: gRPC field existence check
    const { grpcClient } = await import('../rpc.js');
    const dfResult = await grpcClient.listDynamicFields({ parentId: stormId });
    const fields = dfResult.dynamicFields ?? [];
    for (const df of fields) {
      const bcsValues = Object.values(df.name.bcs as unknown as Record<string, number>);
      const nameBytes = bcsValues.slice(1);
      const h = nameBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
      if (h === hex) return 1;
    }
  } catch { /* ignore */ }
  return 0;
}

/** Build a batched quest PTB — reads N signals without deleting them.
 *  Auto-strikes (deletes) legacy storm signals first.
 *  If sponsorAddress is provided, sets it as gas owner (2-sig sponsored tx). */
export async function buildBatchQuestTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  sponsorAddress?: string,
): Promise<Uint8Array> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(recipientAddress));
  if (sponsorAddress) {
    tx.setGasOwner(normalizeSuiAddress(sponsorAddress));
  }

  // Strike from current storm only — legacy signals are orphaned
  // (Legacy storms lack strike_relay and quest needs NFT object which WaaP can't pass)
  const newStormCount = await _countOnStorm(STORM_ID, recipientName);
  for (let i = 0; i < newStormCount; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'strike',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.pure.u64(i),
        tx.object(nftObjectId),
        tx.object('0x6'),
      ],
    });
  }
  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Build a batched strike PTB — decrypt and delete N signals. */
export async function buildBatchStrikeTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
): Promise<Uint8Array> {
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(recipientAddress));
  for (let i = 0; i < count; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'strike',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.object(nftObjectId),
        tx.object('0x6'),
      ],
    });
  }
  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Build a strike PTB that routes all storage rebate to iUSD treasury.
 *  Strikes N signals (FIFO) and sends gas change to treasury. */
export async function buildStrikeToTreasuryTx(
  address: string,
  recipientName: string,
  nftObjectId: string,
  strikeCount: number,
): Promise<Uint8Array> {
  const IUSD_TREASURY = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';
  const ns = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const addr = normalizeSuiAddress(address);

  const tx = new Transaction();
  tx.setSender(addr);

  // Strike all signals up to strikeCount
  for (let i = 0; i < strikeCount; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'strike',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.object(nftObjectId),
        tx.object('0x6'),
      ],
    });
  }

  // Route storage rebate to iUSD treasury — split 0 from gas now,
  // the VM adds rebate to gas coin, then transferObjects sends the change.
  // We split a "rebate collector" coin that will hold the excess after gas.
  const [rebateCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.transferObjects([rebateCoin], tx.pure.address(IUSD_TREASURY));

  // Piggyback roster update
  const { maybeAppendRoster } = await import('../suins.js');
  maybeAppendRoster(tx, addr, recipientName);

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Build a combined PTB: strike N signals + send receipt back to sender. One signature. */
export async function buildStrikeWithReceiptTx(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  strikeCount: number,
  senderName: string,
  senderNftObjectId: string,
  receiptMessage: string,
  suiamiToken: string,
): Promise<Uint8Array> {
  const myNs = nameHash(recipientName.replace(/\.sui$/i, '').toLowerCase());
  const senderNs = nameHash(senderName.replace(/\.sui$/i, '').toLowerCase());
  const addr = normalizeSuiAddress(recipientAddress);

  // Encrypt the receipt for the sender
  const payload = makeThunderPayload({
    transportVersion: THUNDER_VERSION,
    senderAddress: addr,
    senderName: recipientName,
    recipientName: senderName,
    message: receiptMessage,
    suiamiToken,
  });
  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));
  const nftHex = senderNftObjectId.toLowerCase().replace(/^0x/, '');
  const nftRawBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) nftRawBytes[i] = parseInt(nftHex.slice(i * 2, i * 2 + 2), 16);
  const maskedKey = xorBytes(key, keccak_256(nftRawBytes));

  const tx = new Transaction();
  tx.setSender(addr);

  // Phase 1: Strike incoming signals
  for (let i = 0; i < strikeCount; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'strike',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(myNs)),
        tx.object(nftObjectId),
        tx.object('0x6'),
      ],
    });
  }

  // Phase 2: Send receipt signal to sender (fee set to 0 on-chain)
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'signal',
    arguments: [
      tx.object(STORM_ID),
      tx.pure.vector('u8', Array.from(senderNs)),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(maskedKey)),
      tx.pure.vector('u8', Array.from(nonce)),
      feeCoin,
      tx.object('0x6'),
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Verify a SUIAMI token. Returns true if valid. */
async function _verifySuiami(token: string): Promise<boolean> {
  if (!token?.startsWith('suiami:')) return false;
  try {
    const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
    const parts = token.slice(7).split('.');
    if (parts.length !== 2) return false;
    const msgB64 = parts[0];
    const signature = parts[1];
    const msgBytes = Uint8Array.from(atob(msgB64), c => c.charCodeAt(0));
    const msg = JSON.parse(new TextDecoder().decode(msgBytes));
    if (!msg.suiami || !msg.address) return false;
    await verifyPersonalMessageSignature(msgBytes, signature, { address: msg.address });
    return true;
  } catch { return false; }
}

/** Parse Questfi events from tx effects and decrypt all signals. Rejects signals without valid SUIAMI.
 *  If sendReceipt is provided, sends a receipt signal back to each sender with the recipient's SUIAMI. */
export async function parseAndDecryptQuestfi(
  txResult: any,
  sendReceipt?: (senderName: string, recipientSuiami: string) => Promise<void>,
): Promise<ThunderPayload[]> {
  const quested = parseQuestfiEvents(txResult);
  const results: ThunderPayload[] = [];
  await Promise.all(
    quested.map(async (s) => {
      try {
        const cleartext = await aesDecrypt(s.payload, s.aesKey, s.aesNonce);
        const payload = decodeThunderPayload(JSON.parse(new TextDecoder().decode(cleartext)));
        if (!payload) return;
        if (!payload.suiami) { console.warn('[Thunder] Rejected signal without SUIAMI'); return; }
        const valid = await _verifySuiami(payload.suiami);
        if (!valid) { console.warn('[Thunder] Rejected signal with invalid SUIAMI'); return; }
        results.push(payload);
        // Send receipt back to sender with recipient's SUIAMI (async, non-blocking)
        if (sendReceipt && payload.sender) {
          sendReceipt(payload.sender, payload.suiami).catch(() => {});
        }
      } catch { /* skip stale */ }
    }),
  );
  return results;
}

/** Parse Questfi events from tx effects. */
function parseQuestfiEvents(effects: any): Array<{ payload: Uint8Array; aesKey: Uint8Array; aesNonce: Uint8Array }> {
  const results: Array<{ payload: Uint8Array; aesKey: Uint8Array; aesNonce: Uint8Array }> = [];
  const rawEvents = effects?.events ?? [];
  for (const evt of rawEvents) {
    if (!evt?.type?.includes('::thunder::Questfi')) continue;
    const fields = evt.parsedJson ?? evt.json ?? {};
    results.push({
      payload: new Uint8Array(fields.payload ?? []),
      aesKey: new Uint8Array(fields.aes_key ?? []),
      aesNonce: new Uint8Array(fields.aes_nonce ?? []),
    });
  }
  return results;
}

/**
 * Quest all pending signals in one PTB, then decrypt them.
 * One wallet signature. Returns all decrypted signals.
 */
export async function decryptAndQuest(
  recipientAddress: string,
  recipientName: string,
  nftObjectId: string,
  count: number,
  executeTx: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: any }>,
  sponsorAddress?: string,
): Promise<ThunderPayload[]> {
  const txBytes = await buildBatchQuestTx(recipientAddress, recipientName, nftObjectId, count, sponsorAddress);
  const result = await executeTx(txBytes);

  // Try parsing events from wallet response first
  let quested = parseQuestfiEvents(result.effects ?? result);

  // If no events found, fetch tx details from RPC (wallet may not return events)
  if (quested.length === 0 && result.digest) {
    // Wait briefly for tx to be indexed
    await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));
    const txRes = await fetch('/api/sui-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_getTransactionBlock',
        params: [result.digest, { showEvents: true, showEffects: true }],
      }),
    });
    const txJson = await txRes.json() as any;
    quested = parseQuestfiEvents(txJson?.result ?? {});
  }

  if (quested.length === 0) throw new Error('No Questfi events in tx effects');

  // Decrypt all signals in parallel — skip any that fail (bad key from old deploys)
  const results: ThunderPayload[] = [];
  await Promise.all(
    quested.map(async (s) => {
      try {
        const cleartext = await aesDecrypt(s.payload, s.aesKey, s.aesNonce);
        const payload = decodeThunderPayload(JSON.parse(new TextDecoder().decode(cleartext)));
        if (payload) results.push(payload);
      } catch { /* skip — likely stale signal from old deploy */ }
    }),
  );
  return results;
}

// ─── Quest + Send (combined PTB) ────────────────────────────────────

/**
 * Build a single PTB that quests N pending signals AND sends a new signal.
 * One wallet signature for both decrypt + reply.
 */
export async function buildQuestAndSendTx(
  address: string,
  senderName: string,
  recipientName: string,
  recipientNftObjectId: string,
  ownNftObjectId: string,
  questCount: number,
  message: string,
  suiamiToken?: string,
): Promise<Uint8Array> {
  const ownBare = senderName.replace(/\.sui$/i, '').toLowerCase();
  const ownNs = nameHash(ownBare);
  const recipBare = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const recipNs = nameHash(recipBare);
  const addr = normalizeSuiAddress(address);

  const payload = makeThunderPayload({
    transportVersion: THUNDER_VERSION,
    senderAddress: addr,
    senderName,
    recipientName,
    message,
    suiamiToken,
  });
  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));
  const nftHex = recipientNftObjectId.toLowerCase().replace(/^0x/, '');
  const nftRawBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) nftRawBytes[i] = parseInt(nftHex.slice(i * 2, i * 2 + 2), 16);
  const maskedKey = xorBytes(key, keccak_256(nftRawBytes));

  const tx = new Transaction();
  tx.setSender(addr);

  // Phase 1: Quest pending incoming signals (non-destructive)
  for (let i = 0; i < questCount; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'quest',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ownNs)),
        tx.pure.u64(i),
        tx.object(ownNftObjectId),
      ],
    });
  }

  // Phase 2: Send new signal
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(3_000_000)]);
  tx.moveCall({
    package: THUNDER_PACKAGE_ID,
    module: 'thunder',
    function: 'signal',
    arguments: [
      tx.object(STORM_ID),
      tx.pure.vector('u8', Array.from(recipNs)),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(maskedKey)),
      tx.pure.vector('u8', Array.from(nonce)),
      feeCoin,
      tx.object('0x6'),
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/**
 * Quest + send in one wallet interaction.
 * Returns decrypted incoming signals from the quest phase.
 */
export async function questAndSend(
  address: string,
  senderName: string,
  recipientName: string,
  recipientNftObjectId: string,
  ownNftObjectId: string,
  questCount: number,
  message: string,
  executeTx: (txBytes: Uint8Array) => Promise<{ digest: string; effects?: any }>,
  suiamiToken?: string,
): Promise<ThunderPayload[]> {
  const txBytes = await buildQuestAndSendTx(
    address, senderName, recipientName, recipientNftObjectId, ownNftObjectId,
    questCount, message, suiamiToken,
  );
  const result = await executeTx(txBytes);

  let quested = parseQuestfiEvents(result.effects ?? result);
  if (quested.length === 0 && result.digest) {
    await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));
    const txRes = await fetch('/api/sui-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sui_getTransactionBlock',
        params: [result.digest, { showEvents: true, showEffects: true }],
      }),
    });
    const txJson = await txRes.json() as any;
    quested = parseQuestfiEvents(txJson?.result ?? {});
  }

  const results: ThunderPayload[] = [];
  await Promise.all(
    quested.map(async (s) => {
      try {
        const cleartext = await aesDecrypt(s.payload, s.aesKey, s.aesNonce);
        const payload = decodeThunderPayload(JSON.parse(new TextDecoder().decode(cleartext)));
        if (payload) results.push(payload);
      } catch { /* skip stale */ }
    }),
  );
  return results;
}

// ─── Thunder v5 — Storm v1 (ECDH storm IDs) ───────────────────────

/**
 * Build a Thunder v5 signal PTB — AES encrypt + deposit via Storm v1.
 * Uses ECDH-derived storm_id instead of name hash. No NFT gate, no fee.
 */
export async function buildThunderV5SendTx(
  senderAddress: string,
  senderName: string,
  recipientName: string,
  recipientAddr: string,
  message: string,
  suiamiToken?: string,
): Promise<Uint8Array> {
  const addr = normalizeSuiAddress(senderAddress);
  const stormId = deriveStormIdFromAddresses(addr, normalizeSuiAddress(recipientAddr));
  const payload = makeThunderPayload({
    transportVersion: THUNDER_V5_VERSION,
    senderAddress: addr,
    senderName,
    recipientName,
    message,
    suiamiToken,
  });

  const { ciphertext, key, nonce } = await aesEncrypt(new TextEncoder().encode(JSON.stringify(payload)));

  // Mask key with storm_id (both parties can derive it)
  const maskedKey = xorBytes(key, keccak_256(stormId));

  const tx = new Transaction();
  tx.setSender(addr);
  tx.moveCall({
    package: STORM_V1_PACKAGE_ID,
    module: 'storm',
    function: 'signal',
    arguments: [
      tx.object(STORM_V1_ID),
      tx.pure.vector('u8', Array.from(stormId)),
      tx.pure.vector('u8', Array.from(ciphertext)),
      tx.pure.vector('u8', Array.from(maskedKey)),
      tx.pure.vector('u8', Array.from(nonce)),
      tx.object('0x6'),
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/**
 * Build a Thunder v5 quest PTB — read signals via Storm v1.
 * Emits Questfi events just like v4.
 */
export async function buildThunderV5QuestTx(
  address: string,
  peerAddress: string,
): Promise<Uint8Array> {
  const addr = normalizeSuiAddress(address);
  const stormId = deriveStormIdFromAddresses(addr, normalizeSuiAddress(peerAddress));

  const tx = new Transaction();
  tx.setSender(addr);
  tx.moveCall({
    package: STORM_V1_PACKAGE_ID,
    module: 'storm',
    function: 'quest',
    arguments: [
      tx.object(STORM_V1_ID),
      tx.pure.vector('u8', Array.from(stormId)),
      tx.object('0x6'),
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/**
 * Build a Thunder v5 strike PTB — read and delete signals via Storm v1.
 * Routes storage rebate to iUSD treasury like buildStrikeToTreasuryTx.
 */
export async function buildThunderV5StrikeTx(
  address: string,
  peerAddress: string,
): Promise<Uint8Array> {
  const IUSD_TREASURY = '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57';
  const addr = normalizeSuiAddress(address);
  const stormId = deriveStormIdFromAddresses(addr, normalizeSuiAddress(peerAddress));

  const tx = new Transaction();
  tx.setSender(addr);
  tx.moveCall({
    package: STORM_V1_PACKAGE_ID,
    module: 'storm',
    function: 'strike',
    arguments: [
      tx.object(STORM_V1_ID),
      tx.pure.vector('u8', Array.from(stormId)),
      tx.object('0x6'),
    ],
  });

  // Route storage rebate to iUSD treasury
  const [rebateCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.transferObjects([rebateCoin], tx.pure.address(IUSD_TREASURY));

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}
