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
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  STORM_ID,
  LEGACY_STORMS,
  type ThunderPayload,
} from './thunder-types.js';

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

// ─── AES-256-GCM ─────────────────────────────────────────────────────

async function aesEncrypt(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; key: Uint8Array; nonce: Uint8Array }> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));
  return { ciphertext, key, nonce };
}

async function aesDecrypt(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
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
): Promise<Uint8Array> {
  const bareName = recipientName.replace(/\.sui$/i, '').toLowerCase();
  const ns = nameHash(bareName);

  // Build signal
  const payload: ThunderPayload = {
    v: THUNDER_VERSION,
    sender: senderName,
    senderAddress: normalizeSuiAddress(senderAddress),
    message,
    timestamp: new Date().toISOString(),
    ...(suiamiToken ? { suiami: suiamiToken } : {}),
  };

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
          const bcsValues = Object.values(df.name.bcs as Record<string, number>);
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
      const bcsValues = Object.values(df.name.bcs as Record<string, number>);
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
  const payload: ThunderPayload = {
    v: THUNDER_VERSION,
    sender: recipientName,
    senderAddress: addr,
    message: receiptMessage,
    timestamp: new Date().toISOString(),
    suiami: suiamiToken,
  };
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
        const payload = JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload;
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
    await new Promise(r => setTimeout(r, 2000));
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
        results.push(JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload);
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

  const payload: ThunderPayload = {
    v: THUNDER_VERSION,
    sender: senderName,
    senderAddress: addr,
    message,
    timestamp: new Date().toISOString(),
    ...(suiamiToken ? { suiami: suiamiToken } : {}),
  };
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
    await new Promise(r => setTimeout(r, 2000));
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
        results.push(JSON.parse(new TextDecoder().decode(cleartext)) as ThunderPayload);
      } catch { /* skip stale */ }
    }),
  );
  return results;
}
