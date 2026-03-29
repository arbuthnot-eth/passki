/**
 * Thunder client — encrypt signals between SuiNS identities.
 *
 * Signal: AES encrypt → deposit into recipient's ragtag on Storm (one PTB).
 * Quest: batch quest (one PTB) → parse Questfi events → AES decrypt all signals.
 *
 * Storm is the shared object. Ragtag is the per-name collection (dynamic field).
 * Empty ragtages are removed for storage rebate.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import {
  THUNDER_VERSION,
  THUNDER_PACKAGE_ID,
  STORM_ID,
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

  // Build PTB — signal with fee
  // Fee: 0.003 SUI ≈ $0.009 iUSD equivalent, split from gas coin
  const SIGNAL_FEE_MIST = 3_000_000; // 0.003 SUI
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(senderAddress));
  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(SIGNAL_FEE_MIST)]);
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
 * Lists dynamic fields on Storm — if an ragtag exists for a name hash, it has ≥1 signal.
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
    // One gRPC call — list all ragtages on Storm
    const { grpcClient } = await import('../rpc.js');
    const dfResult = await grpcClient.listDynamicFields({ parentId: STORM_ID });
    const fields = dfResult.dynamicFields ?? [];

    // Match ragtages to our names
    for (const df of fields) {
      const bcsValues = Object.values(df.name.bcs as Record<string, number>);
      const nameBytes = bcsValues.slice(1); // skip BCS length prefix
      const hex = nameBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
      if (hashToBare[hex]) {
        result[hashToBare[hex]] = 1; // ragtag exists = has signal
      }
    }
  } catch { /* return cached zeros */ }

  return result;
}

// ─── Quest (batch) ──────────────────────────────────────────────────

/** Build a batched quest PTB — one tx claims N signals.
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
  for (let i = 0; i < count; i++) {
    tx.moveCall({
      package: THUNDER_PACKAGE_ID,
      module: 'thunder',
      function: 'quest',
      arguments: [
        tx.object(STORM_ID),
        tx.pure.vector('u8', Array.from(ns)),
        tx.object(nftObjectId),
        tx.object('0x6'), // clock
      ],
    });
  }
  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
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
