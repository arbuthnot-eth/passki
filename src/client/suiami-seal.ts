// Bronzong — Seal-gated SUIAMI squid encryption (#157).
//
// Wraps `@mysten/seal` to encrypt a wallet's cross-chain squid
// addresses (BTC / ETH / SOL) under the
// `suiami::seal_roster::seal_approve_roster_reader` access policy.
// Anyone with their own SUIAMI Roster entry (that also has a
// non-empty walrus_blob_id) can decrypt anyone else's squid blob.
// Anyone without a SUIAMI cannot. This is the mutual-membership
// decrypt model discussed in #156 / #157.
//
// On-chain policy (already live on mainnet):
//
//   module suiami::seal_roster;
//   entry fun seal_approve_roster_reader(
//       roster: &Roster,
//       id: vector<u8>,
//       ctx: &TxContext,
//   ) {
//       assert!(id.length() == 40, EInvalidIdentity);
//       assert!(roster::has_address(roster, ctx.sender()), ENotRegistered);
//       let record = roster::lookup_by_address(roster, ctx.sender());
//       assert!(roster::record_walrus_blob_id(record).length() > 0, ENoEncryptedData);
//   }
//
// Key infrastructure:
//
//   - Seal key servers: same 2-of-3 mainnet set Thunder uses
//     (Overclock / Studio Mirai / H2O Nodes). Reused directly
//     from thunder-stack so the two clients can't drift.
//   - SessionKey: one per (address, packageId). Scoped to the
//     suiami package since Thunder's session key is scoped to
//     thunder's package and the two are not fungible. Cached in
//     localStorage with import/export so a refresh doesn't
//     re-prompt the wallet.
//   - Walrus: same testnet publisher/aggregator we already use
//     for roster blobs. Stores the full `encryptedObject` bytes
//     from Seal.encrypt — no extra AES layer, Seal handles it.
//
// Identity bytes (the 40-byte `id` arg to seal_approve_roster_reader):
//
//   [keccak256(bareName)[0..32]][u64_LE(0)]   // 32 + 8 = 40
//
// Deterministic per-name. Version suffix is currently 0 and gives
// us room to rotate keys later without changing the schema. The
// contract doesn't parse the id — it only checks `length == 40` —
// so any 40-byte value works, but keeping it deterministic means
// the reader can reconstruct it from the name alone without
// round-tripping through the Walrus blob first.

import { SealClient, SessionKey, type ExportedSessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { grpcClient, GQL_URL } from '../rpc.js';

// Original package ID (first-publish address) — required by Seal's
// SessionKey.create. Seal strictly validates SessionKey packageId
// against original-id; upgrade addresses here produce
// `Package ID used in PTB is invalid` on decrypt.
export const SUIAMI_PKG = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';

// Latest published-at — use for PTB `target:` strings. Seal key
// servers resolve the Move function at the target address directly
// (not via original→latest redirection), so new entry functions
// added in upgrades (`_v2`, etc.) MUST be called at the latest
// published-at or Seal returns `FunctionNotFound`. Bump this on every
// SUIAMI upgrade (Published.toml → published-at).
export const SUIAMI_PKG_LATEST = '0xea0b948522bf759ccde5fb10b74bae99b8929495926a53678c9d4cbd0fd4f202';
export const ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
export const ROSTER_INITIAL_SHARED_VERSION = 839068132;

// Same 2-of-3 threshold Seal key servers Thunder uses on mainnet.
// Kept in sync manually with src/client/thunder-stack.ts. If those
// change, update both — silent drift would split the two clients'
// decrypt availability.
const SEAL_SERVERS_MAINNET = [
  { objectId: '0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6', weight: 1 }, // Overclock
  { objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10', weight: 1 }, // Studio Mirai
  { objectId: '0x4a65b4ff7ba8f4b538895ee35959f982a95f0db7e2a202ec989d261ea927286a', weight: 1 }, // H2O Nodes
];

// Walrus mainnet reads race across multiple operator aggregators and
// writes fall through multiple publishers — see src/client/walrus.ts.
// Several of those operators (H2O Nodes, Studio Mirai, Overclock) also
// run the Seal key servers used above, so the trust surface collapses
// to one set of custodians instead of two.
import { fetchWalrusBlob, putWalrusBlob } from './walrus.js';

const SESSION_KEY_TTL_MIN = 30;
const SK_STORAGE_PREFIX = 'ski:suiami-seal-sk:v1:';
const skKey = (addr: string) => `${SK_STORAGE_PREFIX}${addr.toLowerCase()}`;

// Two SealClient instances — one backed by gRPC (CLAUDE.md-preferred
// transport in the browser) and one by GraphQL. `getSealClient()`
// hands out the gRPC-backed one by default, but `sealCall()` races
// both and halts on the first success. The gRPC client should win
// most of the time; GraphQL is there as a fallback for environments
// where gRPC-web CORS or connectivity flakes (seen historically when
// Mysten rate-limits a single transport).
let _sealClientGrpc: SealClient | null = null;
let _sealClientGql: SealClient | null = null;
let _sessionKey: SessionKey | null = null;
let _sessionKeyAddr = '';

function getSealClient(): SealClient {
  if (_sealClientGrpc) return _sealClientGrpc;
  _sealClientGrpc = new SealClient({
    suiClient: grpcClient as never,
    serverConfigs: SEAL_SERVERS_MAINNET,
    verifyKeyServers: false,
  });
  return _sealClientGrpc;
}

function getSealClientGql(): SealClient {
  if (_sealClientGql) return _sealClientGql;
  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  _sealClientGql = new SealClient({
    suiClient: gql as never,
    serverConfigs: SEAL_SERVERS_MAINNET,
    verifyKeyServers: false,
  });
  return _sealClientGql;
}

/** Race a Seal operation across gRPC + GraphQL transports, halting
 *  on first success. Returns the winning result; throws only if both
 *  transports fail. Matches the treasury/shade-executor race pattern.
 *
 *  Both SealClient instances share the same SessionKey (which is
 *  transport-agnostic) and the same key-server responses, so the
 *  only thing that diverges is the underlying `core.getObject` /
 *  package version check. Racing them is safe. */
async function sealRace<T>(op: (client: SealClient) => Promise<T>): Promise<T> {
  const grpcTry = op(getSealClient()).then(
    (v) => ({ ok: true as const, v, src: 'grpc' as const }),
    (e) => ({ ok: false as const, e, src: 'grpc' as const }),
  );
  const gqlTry = op(getSealClientGql()).then(
    (v) => ({ ok: true as const, v, src: 'gql' as const }),
    (e) => ({ ok: false as const, e, src: 'gql' as const }),
  );
  const first = await Promise.race([grpcTry, gqlTry]);
  if (first.ok) return first.v;
  // First attempt lost — wait for the other to settle.
  const second = await (first.src === 'grpc' ? gqlTry : grpcTry);
  if (second.ok) return second.v;
  throw first.e;
}

/** Derive the deterministic Seal identity for a bare name.
 *
 *  Returns both the raw 40 bytes (for the on-chain `seal_nonce`
 *  field) and the matching hex string (what `SealClient.encrypt`
 *  actually accepts — its internal `createFullId(packageId, id)`
 *  helper calls `fromHex(id)` on whatever you pass in).
 *
 *  The contract checks `id.length() == 40` at the Move `vector<u8>`
 *  level, so we need 40 bytes = 80 hex chars. The shape itself is
 *  keccak256(bareName)[0..32] concatenated with u64_LE(0) — giving
 *  each name its own deterministic identity with an 8-byte version
 *  suffix we can bump later for key rotation. */
export function deriveSuiamiSealId(bareName: string): { bytes: Uint8Array; hex: string } {
  const normalized = bareName.replace(/\.sui$/i, '').toLowerCase();
  const nameHash = keccak_256(new TextEncoder().encode(normalized));
  const bytes = new Uint8Array(40);
  bytes.set(nameHash.slice(0, 32), 0);
  // Last 8 bytes are u64_LE(0) — already zero-initialized, nothing to do.
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bytes, hex };
}

/** Load (or mint) a SessionKey scoped to the suiami package.
 *
 *  Lifecycle mirrors Thunder's:
 *    1. If an in-memory session key exists and matches the address
 *       and isn't expired, reuse it.
 *    2. Otherwise, try localStorage — import, restore in-memory.
 *    3. If none or import fails, mint a new one via SessionKey.create,
 *       get the personal message, ask the wallet to sign, attach the
 *       signature, export, persist to localStorage.
 *
 *  One wallet prompt per 30-minute window per address. Cached so a
 *  hard refresh doesn't re-prompt. */
export async function getSuiamiSessionKey(
  address: string,
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>,
): Promise<SessionKey> {
  if (_sessionKey && _sessionKeyAddr === address && !_sessionKey.isExpired()) {
    return _sessionKey;
  }
  try {
    const raw = localStorage.getItem(skKey(address));
    if (raw) {
      const exported = JSON.parse(raw) as ExportedSessionKey;
      const client = getSealClient();
      const restored = SessionKey.import(exported, client as never);
      if (!restored.isExpired() && restored.getAddress() === address) {
        _sessionKey = restored;
        _sessionKeyAddr = address;
        return restored;
      }
    }
  } catch (importErr) {
    console.warn('[suiami-seal] SessionKey.import failed, will mint fresh:', importErr instanceof Error ? importErr.message : importErr);
  }

  console.log('[suiami-seal] minting fresh SessionKey — wallet prompt incoming');
  const fresh = await SessionKey.create({
    address,
    packageId: SUIAMI_PKG,
    ttlMin: SESSION_KEY_TTL_MIN,
    suiClient: grpcClient as never,
  });
  const personalMessage = fresh.getPersonalMessage();
  const { signature } = await signPersonalMessage(personalMessage);
  fresh.setPersonalMessageSignature(signature);

  try {
    const exported = fresh.export();
    localStorage.setItem(skKey(address), JSON.stringify(exported));
  } catch (persistErr) {
    console.warn('[suiami-seal] SessionKey.export/persist failed:', persistErr);
  }

  _sessionKey = fresh;
  _sessionKeyAddr = address;
  return fresh;
}

/** Encrypt a JSON squid payload under the suiami Seal policy, upload
 *  the ciphertext to Walrus, and return both the blob id and the
 *  deterministic seal identity bytes (so callers can store / re-derive
 *  them on the roster entry if desired).
 *
 *  The encrypted payload is self-describing — the Seal SDK embeds its
 *  own metadata in `encryptedObject`, so decrypt only needs the blob
 *  bytes + a matching seal id + a valid SessionKey. */
export async function encryptSquidsToWalrus(
  squids: Record<string, string>,
  bareName: string,
): Promise<{ blobId: string; sealId: Uint8Array }> {
  const { bytes: sealIdBytes, hex: sealIdHex } = deriveSuiamiSealId(bareName);
  const plaintext = new TextEncoder().encode(JSON.stringify(squids));

  // Race gRPC + GraphQL Seal clients, halt on first success. Seal's
  // `createFullId(packageId, id)` internally runs `fromHex(id)` so we
  // MUST pass a hex string here, not the raw bytes — passing a
  // Uint8Array trips `hexStr.startsWith is not a function` in
  // @mysten/utils and halts the whole operation.
  const { encryptedObject } = await sealRace((c) =>
    c.encrypt({
      packageId: SUIAMI_PKG,
      id: sealIdHex,
      data: plaintext,
      threshold: 2,
    }),
  );

  const res = await putWalrusBlob(encryptedObject, {
    headers: { 'content-type': 'application/octet-stream' },
  });
  const result = await res.json() as any;
  const blobId = result?.newlyCreated?.blobObject?.blobId ?? result?.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus upload: no blobId in response');

  return { blobId: blobId as string, sealId: sealIdBytes };
}

/** Decrypt a squid blob by fetching it from Walrus and running Seal
 *  decrypt with a PTB that evaluates `seal_approve_roster_reader` as
 *  the access policy. Returns the parsed squid JSON, or null if the
 *  caller is not a valid SUIAMI member (NoAccessError from Seal).
 *
 *  The PTB is built with `onlyTransactionKind: true` so Seal key
 *  servers can dry-run it against mainnet state without requiring a
 *  gas budget or signature. */
export async function decryptSquidsForName(opts: {
  name: string;
  blobId: string;
  address: string;
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}): Promise<Record<string, string>> {
  const fetchRes = await fetchWalrusBlob(opts.blobId);
  const encryptedObject = new Uint8Array(await fetchRes.arrayBuffer());

  // Reconstruct the same 40-byte Seal identity that encrypt used.
  // This is deterministic per bareName so the reader needs no
  // additional on-chain lookup beyond the blob id.
  const { bytes: sealIdBytes } = deriveSuiamiSealId(opts.name);

  const tx = new Transaction();
  // v3 policy: `id` first per Seal convention. Tries name_hash
  // namespace first, falls through to typed EnsHashKey namespace so
  // either Sui-name or ENS-name-keyed encrypts decrypt safely. v2 is
  // still supported on-chain (compatible upgrade) but v3 is strictly
  // better: v2 alone won't find ENS-bound blobs written after v5.
  tx.moveCall({
    target: `${SUIAMI_PKG_LATEST}::seal_roster::seal_approve_roster_reader_v3`,
    arguments: [
      tx.pure.vector('u8', Array.from(sealIdBytes)),
      tx.sharedObjectRef({
        objectId: ROSTER_OBJ,
        initialSharedVersion: ROSTER_INITIAL_SHARED_VERSION,
        mutable: false,
      }),
    ],
  });
  // `onlyTransactionKind: true` omits gas/sender so Seal key servers
  // can dry-run the approval call without needing a real signature.
  const txBytes = await tx.build({
    client: grpcClient as never,
    onlyTransactionKind: true,
  });

  const sessionKey = await getSuiamiSessionKey(opts.address, opts.signPersonalMessage);
  const plaintext = await sealRace((c) =>
    c.decrypt({
      data: encryptedObject,
      sessionKey,
      txBytes,
    }),
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ─── CF history (Porygon) ───────────────────────────────────────────
//
// Same Seal infrastructure as the squid path, but targets the
// `seal_approve_cf_history` personal policy. Only the record owner
// can decrypt their own CF chunks. Deterministic 40-byte Seal id =
// 32-byte sender address ‖ 8 zero bytes — every one of a user's
// chunks shares the same id so a single session-key approval
// decrypts the whole history.

/** Derive the deterministic Seal id for a wallet's CF-history chunks.
 *  Matches the on-chain `seal_approve_cf_history` prefix check which
 *  asserts `id[0..32] == sender address bytes`. */
export function deriveCfHistorySealId(address: string): { bytes: Uint8Array; hex: string } {
  const clean = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const bytes = new Uint8Array(40);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  // Last 8 bytes stay zero — nothing to do.
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bytes, hex };
}

/** Encrypt a CF chunk under the personal cf-history policy and upload
 *  to Walrus. Returns the blob id for inclusion in a roster write PTB. */
export async function encryptCfChunkToWalrus(
  address: string,
  chunk: unknown,
): Promise<{ blobId: string }> {
  const { hex: sealIdHex } = deriveCfHistorySealId(address);
  const plaintext = new TextEncoder().encode(JSON.stringify(chunk));

  const { encryptedObject } = await sealRace((c) =>
    c.encrypt({
      packageId: SUIAMI_PKG,
      id: sealIdHex,
      data: plaintext,
      threshold: 2,
    }),
  );

  const res = await putWalrusBlob(encryptedObject, {
    headers: { 'content-type': 'application/octet-stream' },
  });
  const result = (await res.json()) as { newlyCreated?: { blobObject?: { blobId?: string } }; alreadyCertified?: { blobId?: string } };
  const blobId = result?.newlyCreated?.blobObject?.blobId ?? result?.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus upload: no blobId in response');
  return { blobId };
}

/** Decrypt a single CF chunk by Walrus blob id. Requires the caller
 *  to be the record owner — the personal Seal policy enforces this. */
export async function decryptCfChunkForAddress(opts: {
  blobId: string;
  address: string;
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}): Promise<unknown | null> {
  let encryptedObject: Uint8Array;
  try {
    const fetchRes = await fetchWalrusBlob(opts.blobId);
    encryptedObject = new Uint8Array(await fetchRes.arrayBuffer());
  } catch { return null; }
  const { bytes: sealIdBytes } = deriveCfHistorySealId(opts.address);

  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIAMI_PKG}::seal_roster::seal_approve_cf_history`,
    arguments: [
      tx.sharedObjectRef({
        objectId: ROSTER_OBJ,
        initialSharedVersion: ROSTER_INITIAL_SHARED_VERSION,
        mutable: false,
      }),
      tx.pure.vector('u8', Array.from(sealIdBytes)),
    ],
  });
  const txBytes = await tx.build({
    client: grpcClient as never,
    onlyTransactionKind: true,
  });

  const sessionKey = await getSuiamiSessionKey(opts.address, opts.signPersonalMessage);
  try {
    const plaintext = await sealRace((c) =>
      c.decrypt({
        data: encryptedObject,
        sessionKey,
        txBytes,
      }),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/** Clear any cached SUIAMI session key. For tests and the wallet's
 *  "disconnect" event, same pattern as clearSealCache() for thunder. */
export function clearSuiamiSessionCache(address?: string): void {
  _sessionKey = null;
  _sessionKeyAddr = '';
  if (address) {
    try { localStorage.removeItem(skKey(address)); } catch {}
  }
}
