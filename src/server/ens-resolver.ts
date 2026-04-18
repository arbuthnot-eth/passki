// ENS CCIP-read gateway — Beldum Iron Defense (#167).
//
// Responds to ENSIP-10 wildcard lookups for subnames under any parent in
// ACCEPTED_PARENTS (whelm.eth, waap.eth). The on-chain
// `OffchainResolver` contract on mainnet reverts `OffchainLookup` when
// a wallet queries e.g. `alice.waap.eth`; the wallet follows the
// EIP-3668 redirect to `/ens-resolver/{sender}/{data}.json` on this
// worker, we decode the inner `resolve(name, data)` call, pull the
// label's chain addresses from the SUIAMI roster + on-chain IKA
// dWallets, ABI-encode the answer, sign it with the gateway signer,
// and return `{data: 0x…}`. The resolver contract verifies the
// signature against its constructor-registered signer list and
// returns the decoded answer to the wallet.
//
// Signer secret: `ENS_SIGNER_PRIVATE_KEY` (32-byte hex, no 0x needed,
// 0x tolerated). Generate with `openssl rand -hex 32`; its derived
// address goes into the resolver contract's `signers` array at deploy
// time. Rotating = redeploy + new signer address + `setResolver`.

import type { Context } from 'hono';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  bytesToHex,
  hexToBytes,
  concat,
  encodeAbiParameters,
  decodeAbiParameters,
  toHex,
  pad,
} from 'viem';

// ENSIP-10 + inner resolver selectors we serve.
const SEL_RESOLVE         = '0x9061b923'; // resolve(bytes,bytes)
const SEL_ADDR            = '0x3b3b57de'; // addr(bytes32)
const SEL_ADDR_COINTYPE   = '0xf1cb7e06'; // addr(bytes32,uint256)
const SEL_TEXT            = '0x59d1d43c'; // text(bytes32,string)

// SLIP-44 coin types we support natively. Sui has no SLIP-44 slot yet,
// so Sui addresses come through a `text("sui")` lookup instead.
const COIN_ETH = 60n;
const COIN_BTC = 0n;
const COIN_SOL = 501n;

// Parents this gateway serves subnames under. New entries go live the
// moment L1 binds `ENS.setResolver(namehash(<parent>), gatewayAddr)`.
// whelm.eth adopted first (2026-04-17 pivot, already IKA-native); waap.eth
// stays in the set so it lights up automatically after a future
// `whelm('waap')` without touching this file again.
const ACCEPTED_PARENTS: ReadonlySet<string> = new Set([
  'whelm.eth',
  'waap.eth',
]);

// Response TTL — how far in the future we sign the expiry. 5 min
// matches cb.id / Namestone conventions; long enough to ride through
// one confirmation cycle without being so long that signer rotation
// leaves stale answers floating.
const SIG_TTL_SEC = 300n;

// SUIAMI roster on Sui mainnet.
const SUIAMI_ROSTER_OBJ = '0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d';
const SUI_GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const SUI_RPC_URL = 'https://sui-rpc.publicnode.com';

// ─── DNS wire-format name decoder ───────────────────────────────────
//
// ENS passes names as length-prefixed labels, e.g.
//   0x05 "alice" 0x04 "waap" 0x03 "eth" 0x00
// Returns labels lowercased.
function decodeDnsName(bytes: Uint8Array): string[] {
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    if (i + 1 + len > bytes.length) throw new Error('malformed DNS name');
    labels.push(new TextDecoder().decode(bytes.slice(i + 1, i + 1 + len)).toLowerCase());
    i += 1 + len;
  }
  return labels;
}

// ─── SUIAMI roster lookup ───────────────────────────────────────────
//
// The roster is dual-keyed; both `name_hash` (Sui-side) and `ens_hash`
// (set via `set_ens_identity`, Beldum Take Down) share the same
// vector<u8> dynamic field namespace. We try ens_hash first
// (`keccak256("<label>.waap.eth")`), fall back to the bare name hash
// in case the user has a Sui entry but hasn't called `ensIssue` yet.

type RosterRecord = {
  name: string;
  sui_address: string;
  chains: Record<string, string>;
  dwallet_caps: string[];
};

// SUIAMI original-id; dynamic-field type strings reference the original
// package per Sui's type resolution (upgrades preserve original id for
// type namespacing).
const SUIAMI_ORIGINAL_ID = '0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa';

async function queryDf(typeStr: string, bcs: Uint8Array): Promise<any> {
  const b64 = btoa(String.fromCharCode(...bcs));
  const q = `{ object(address:"${SUIAMI_ROSTER_OBJ}"){ dynamicField(name:{type:"${typeStr}",bcs:"${b64}"}){ value{ ...on MoveValue{ json } } } } }`;
  const r = await fetch(SUI_GQL_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json() as any;
  return j?.data?.object?.dynamicField?.value?.json ?? null;
}

function decodeRecord(rec: any): RosterRecord | null {
  if (!rec) return null;
  const chains: Record<string, string> = {};
  for (const { key, value } of rec.chains?.contents ?? []) chains[key] = value;
  return {
    name: rec.name ?? '',
    sui_address: rec.sui_address ?? '',
    chains,
    dwallet_caps: rec.dwallet_caps ?? [],
  };
}

// Edge-cache TTL for roster lookups. Records change rarely (register,
// revoke, mutate), so 60s absorbs the hot path for fintech resolvers
// hitting the same label thousands of times without staling so long
// that revocations linger.
const ROSTER_CACHE_TTL_SEC = 60;

async function lookupRosterUncached(bareLabel: string, parent: string): Promise<RosterRecord | null> {
  const ensName = `${bareLabel}.${parent}`;
  const ensHash = keccak_256(new TextEncoder().encode(ensName));
  const nameHash = keccak_256(new TextEncoder().encode(bareLabel));

  // ENS namespace first — typed EnsHashKey wrapper, disjoint from
  // Sui-name namespace, overwrite-protected. BCS: struct with single
  // `hash: vector<u8>` field → `ULEB128(len) || hash_bytes`. For a
  // 32-byte hash: 0x20 prefix + 32 bytes = 33 bytes total.
  const ensBcs = new Uint8Array(33);
  ensBcs[0] = 32;
  ensBcs.set(ensHash, 1);
  const ensType = `${SUIAMI_ORIGINAL_ID}::roster::EnsHashKey`;
  const fromEns = decodeRecord(await queryDf(ensType, ensBcs));
  if (fromEns) return fromEns;

  // Fallback: raw vector<u8> name_hash (Sui-name side, gated by SuiNS
  // NFT ownership via set_identity — can't be hijacked).
  return decodeRecord(await queryDf('vector<u8>', nameHash));
}

// Cache wrapper for lookupRoster. Uses caches.default so every CF
// colo serves a fresh copy; coordinating across colos via KV isn't
// worth the latency hit for a 60s window.
// v6 PublicChains whitelist — per-address dynamic field under
// `PublicChainsKey { addr }`. If the key exists, the record's ENS
// exposure is intersected with `visible`; chains outside the
// whitelist return null. If absent, v5 fallback applies and the full
// `record.chains` is exposed.
async function lookupPublicChains(suiAddress: string): Promise<Record<string, string> | null> {
  // BCS for PublicChainsKey { addr: address } = 32-byte address only
  const addrBytes = new Uint8Array(32);
  const hex = suiAddress.replace(/^0x/, '').padStart(64, '0');
  for (let i = 0; i < 32; i++) addrBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const typeStr = `${SUIAMI_ORIGINAL_ID}::roster::PublicChainsKey`;
  const raw = await queryDf(typeStr, addrBytes);
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const { key, value } of raw.visible?.contents ?? []) out[key] = value;
  return out;
}

// v6 Guest lookup. BCS for GuestKey { parent_hash: vector<u8>, label: vector<u8> } =
// ULEB128(parent_len) || parent_bytes || ULEB128(label_len) || label_bytes.
// Both parent_hash and label are caller-defined byte vectors.
async function lookupGuest(parentHash: Uint8Array, label: string): Promise<{ target: string; chain: string; expires_ms: number } | null> {
  const labelBytes = new TextEncoder().encode(label);
  // ULEB128 encode length (our values are always small — single byte)
  const bcs = new Uint8Array(1 + parentHash.length + 1 + labelBytes.length);
  bcs[0] = parentHash.length;
  bcs.set(parentHash, 1);
  bcs[1 + parentHash.length] = labelBytes.length;
  bcs.set(labelBytes, 1 + parentHash.length + 1);
  const typeStr = `${SUIAMI_ORIGINAL_ID}::roster::GuestKey`;
  const raw = await queryDf(typeStr, bcs);
  if (!raw) return null;
  const expires_ms = Number(raw.expires_ms);
  if (Date.now() >= expires_ms) return null; // TTL enforced at read
  return {
    target: raw.target ?? '',
    chain: raw.chain ?? '',
    expires_ms,
  };
}

async function lookupRoster(bareLabel: string, parent: string): Promise<RosterRecord | null> {
  const key = new Request(`https://cache.internal/ens-resolver/roster/${parent}/${bareLabel}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const body = await hit.text();
    return body === 'null' ? null : (JSON.parse(body) as RosterRecord);
  }
  const fresh = await lookupRosterUncached(bareLabel, parent);
  await cache.put(
    key,
    new Response(fresh ? JSON.stringify(fresh) : 'null', {
      headers: { 'cache-control': `public, max-age=${ROSTER_CACHE_TTL_SEC}` },
    }),
  );
  return fresh;
}

// ─── IKA dWallet pubkey → Solana base58 address ─────────────────────
//
// For chains the roster doesn't store plaintext (SOL / BTC / ETH all
// live encrypted in the Walrus blob normally), derive from the
// IKA-custodied DWallet object: curve tag + public_output bytes. We
// follow the same path used to pull `superteam.sui`'s SOL address
// (2026-04-17): dWalletCap → dwallet_id → DWallet.state.public_output
// → parse BCS `Option<vector<u8>>` header → raw 32 bytes = ed25519
// pubkey for curve=2 / compressed secp256k1 for curve=0.

async function fetchDwalletPubkey(dwalletId: string): Promise<{ curve: number; pubkey: Uint8Array } | null> {
  const r = await fetch(SUI_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getObject',
      params: [dwalletId, { showContent: true }] }),
  });
  const j = await r.json() as any;
  const f = j?.result?.data?.content?.fields;
  if (!f) return null;
  const curve = Number(f.curve);
  const po: any[] = f?.state?.fields?.public_output ?? [];
  if (po.length < 34 || po[0] !== 1 || po[1] !== 32) return null;
  const pubkey = Uint8Array.from(po.slice(2, 34).map(Number));
  return { curve, pubkey };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

// dWallet pubkeys are immutable post-DKG — cache aggressively.
// 1h TTL is plenty; the only "change" would be a user rumbling a new
// dWallet which creates a *new* cap id, so stale entries are harmless.
const DWALLET_CACHE_TTL_SEC = 3600;

async function resolveSolFromCaps(caps: string[]): Promise<string | null> {
  if (caps.length === 0) return null;
  const cache = caches.default;
  // Deterministic key across caps set (order-insensitive).
  const keyStr = [...caps].sort().join('|');
  const cacheKey = new Request(`https://cache.internal/ens-resolver/sol-caps/${encodeURIComponent(keyStr)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.text();
    return body === 'null' ? null : body;
  }

  // dWalletCap points at a DWallet; curve=2 is ed25519 (Solana). Race
  // caps in parallel; first curve=2 wins.
  const results = await Promise.all(caps.map(async (capId) => {
    const r = await fetch(SUI_RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getObject',
        params: [capId, { showContent: true }] }),
    });
    const j = await r.json() as any;
    const dwalletId = j?.result?.data?.content?.fields?.dwallet_id;
    if (!dwalletId) return null;
    const dw = await fetchDwalletPubkey(dwalletId);
    if (!dw || dw.curve !== 2) return null;
    return base58(dw.pubkey);
  }));
  const sol = results.find(Boolean) ?? null;
  await cache.put(
    cacheKey,
    new Response(sol ?? 'null', {
      headers: { 'cache-control': `public, max-age=${DWALLET_CACHE_TTL_SEC}` },
    }),
  );
  return sol;
}

// ─── Gateway signature ──────────────────────────────────────────────
//
// Matches ensdomains/offchain-resolver's SignatureVerifier.sol:
//   message = 0x1900 || resolver || uint64(expires) || keccak(callData) || keccak(result)
//   sig = eth_sign(keccak(message))   // EIP-191 prefix-less, raw keccak
// 65 bytes (r ‖ s ‖ v).

function privateKeyBytes(hex: string): Uint8Array {
  const stripped = hex.replace(/^0x/, '');
  if (stripped.length !== 64) throw new Error('ENS_SIGNER_PRIVATE_KEY must be 32 bytes hex');
  return hexToBytes(`0x${stripped}`);
}

function signResolverMessage(
  privKey: Uint8Array,
  resolver: `0x${string}`,
  expires: bigint,
  callData: Uint8Array,
  result: Uint8Array,
): Uint8Array {
  const msg = concat([
    hexToBytes('0x1900'),
    hexToBytes(resolver),
    hexToBytes(pad(toHex(expires), { size: 8 })),
    keccak_256(callData),
    keccak_256(result),
  ]);
  const digest = keccak_256(msg);
  const sig = secp256k1.sign(digest, privKey);
  // Serialize to 65-byte (r||s||v) compact form Ethereum expects.
  const r = hexToBytes(pad(toHex(sig.r), { size: 32 }));
  const s = hexToBytes(pad(toHex(sig.s), { size: 32 }));
  const v = sig.recovery! + 27;
  return concat([r, s, new Uint8Array([v])]);
}

// ─── ABI encoders per inner selector ────────────────────────────────

function encodeAddrResult(addr: string | null): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [{ type: 'address' }],
      [(addr ?? '0x0000000000000000000000000000000000000000') as `0x${string}`],
    ),
  );
}

function encodeAddrCoinTypeResult(bytesAddr: string | null): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [{ type: 'bytes' }],
      [(bytesAddr ?? '0x') as `0x${string}`],
    ),
  );
}

function encodeTextResult(value: string): Uint8Array {
  return hexToBytes(encodeAbiParameters([{ type: 'string' }], [value]));
}

// ─── Signer-address helper — derives the public ETH address that the
// Worker signs CCIP-read responses from. Called by deployOffchainResolver
// to stamp the correct signer into the contract's constructor.

export async function handleEnsSignerAddress(c: Context): Promise<Response> {
  const signerHex = (c.env as any).ENS_SIGNER_PRIVATE_KEY as string | undefined;
  if (!signerHex) return c.json({ error: 'ENS_SIGNER_PRIVATE_KEY not configured' }, 500);
  try {
    const priv = privateKeyBytes(signerHex);
    const pub = secp256k1.getPublicKey(priv, false); // uncompressed, 65 bytes (0x04 || X || Y)
    const addrBytes = keccak_256(pub.slice(1)).slice(-20);
    const addr = '0x' + bytesToHex(addrBytes).slice(2);
    return c.json({ address: addr.toLowerCase() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
}

// ─── Main handler ───────────────────────────────────────────────────

export async function handleEnsCcipRead(c: Context): Promise<Response> {
  // Rate limit per source IP. 60 req/min window — a single fintech
  // batch rarely hits this; a DoS burst gets a 429 before we spend
  // signer time or upstream Sui quota.
  const rateLimiter = (c.env as any).ENS_RATE_LIMITER as
    | { limit: (opts: { key: string }) => Promise<{ success: boolean }> }
    | undefined;
  if (rateLimiter) {
    const ip = c.req.header('cf-connecting-ip')
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? 'unknown';
    const { success } = await rateLimiter.limit({ key: ip });
    if (!success) {
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
  }

  const sender = c.req.param('sender') as `0x${string}`;
  const dataParam = c.req.param('data') ?? '';
  const data = hexToBytes(dataParam.replace(/\.json$/, '') as `0x${string}`);
  const signerHex = (c.env as any).ENS_SIGNER_PRIVATE_KEY as string | undefined;
  if (!signerHex) {
    return c.json({ error: 'ENS_SIGNER_PRIVATE_KEY not configured' }, 500);
  }

  // Outer selector must be resolve(bytes,bytes) (ENSIP-10).
  const outerSel = bytesToHex(data.slice(0, 4));
  if (outerSel.toLowerCase() !== SEL_RESOLVE) {
    return c.json({ error: `unexpected selector ${outerSel}` }, 400);
  }
  const [dnsName, innerCall] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    bytesToHex(data.slice(4)),
  ) as [`0x${string}`, `0x${string}`];

  const labels = decodeDnsName(hexToBytes(dnsName));
  // Expect `<label>.<parent>.<tld>` or `<guest>.<label>.<parent>.<tld>` with
  // `<parent>.<tld>` ∈ ACCEPTED_PARENTS (whelm.eth, waap.eth).
  if (labels.length < 3) {
    return c.json({ error: 'name too short', labels }, 400);
  }
  const activeParent = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (!ACCEPTED_PARENTS.has(activeParent)) {
    return c.json({ error: `not a subname under an accepted parent (${activeParent})`, labels }, 400);
  }

  const innerBytes = hexToBytes(innerCall);
  const innerSel = bytesToHex(innerBytes.slice(0, 4)).toLowerCase();

  // v6 Guest subname branch — if labels.length === 4
  // (e.g. ['pay','brando','waap','eth']), try GuestKey first.
  // Parent hash = keccak256("<parent>.waap.eth"); label = bytes of
  // labels[0]. Expired guests return null from lookupGuest.
  if (labels.length >= 4) {
    const guestLabel = labels[0];
    const parentFull = labels.slice(1).join('.');
    const parentHash = keccak_256(new TextEncoder().encode(parentFull));
    const guest = await lookupGuest(parentHash, guestLabel);
    if (guest) {
      let result: Uint8Array;
      if (innerSel === SEL_ADDR) {
        // addr(bytes32) — only makes sense if guest targets eth.
        result = encodeAddrResult(guest.chain === 'eth' ? guest.target : null);
      } else if (innerSel === SEL_ADDR_COINTYPE) {
        const [, coinType] = decodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint256' }],
          bytesToHex(innerBytes.slice(4)),
        ) as [`0x${string}`, bigint];
        const chainOk =
          (coinType === COIN_ETH && guest.chain === 'eth') ||
          (coinType === COIN_BTC && guest.chain === 'btc') ||
          (coinType === COIN_SOL && guest.chain === 'sol');
        if (!chainOk) {
          result = encodeAddrCoinTypeResult(null);
        } else if (coinType === COIN_ETH) {
          result = encodeAddrCoinTypeResult(guest.target);
        } else {
          result = encodeAddrCoinTypeResult(bytesToHex(new TextEncoder().encode(guest.target)));
        }
      } else if (innerSel === SEL_TEXT) {
        const [, key] = decodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'string' }],
          bytesToHex(innerBytes.slice(4)),
        ) as [`0x${string}`, string];
        result = encodeTextResult(key === 'name' ? `${guestLabel}.${parentFull}` : key === guest.chain ? guest.target : '');
      } else {
        return c.json({ error: `unsupported inner selector ${innerSel}` }, 400);
      }
      const expires = BigInt(Math.floor(Date.now() / 1000)) + SIG_TTL_SEC;
      const privKey = privateKeyBytes(signerHex);
      const signature = signResolverMessage(privKey, sender, expires, data, result);
      const encoded = encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
        [bytesToHex(result), expires, bytesToHex(signature)],
      );
      return c.json({ data: encoded, guest: true });
    }
    // Guest not bound or expired → fall through to parent lookup so
    // `pay.brando.waap.eth` still resolves to brando's canonical chains
    // when no guest is active. Deliberate design (graceful fallback).
  }

  const bareLabel = labels[labels.length - 3]; // user label directly under the accepted parent
  const record = await lookupRoster(bareLabel, activeParent);

  // v6: intersect chain exposure with PublicChains whitelist when set.
  // If the record owner opted into whitelist mode, serve only chains in
  // `visible`. v5 fallback (no whitelist key) exposes full record.chains.
  let publicChainsFilter: Record<string, string> | null = null;
  if (record?.sui_address) {
    publicChainsFilter = await lookupPublicChains(record.sui_address);
  }
  const chainKey = (key: string): string | null => {
    if (!record) return null;
    if (publicChainsFilter) {
      // Whitelist mode: key must exist in `visible`.
      return publicChainsFilter[key] ?? null;
    }
    return record.chains?.[key] ?? null;
  };

  let result: Uint8Array;
  if (innerSel === SEL_ADDR) {
    result = encodeAddrResult(chainKey('eth'));
  } else if (innerSel === SEL_ADDR_COINTYPE) {
    // addr(bytes32,uint256): second param is SLIP-44 coinType.
    const [, coinType] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      bytesToHex(innerBytes.slice(4)),
    ) as [`0x${string}`, bigint];
    if (!record) {
      result = encodeAddrCoinTypeResult(null);
    } else if (coinType === COIN_ETH) {
      result = encodeAddrCoinTypeResult(chainKey('eth'));
    } else if (coinType === COIN_BTC) {
      const btc = chainKey('btc');
      result = encodeAddrCoinTypeResult(btc ? bytesToHex(new TextEncoder().encode(btc)) : null);
    } else if (coinType === COIN_SOL) {
      let sol = chainKey('sol');
      if (!sol && !publicChainsFilter && record.dwallet_caps.length > 0) {
        // v5 fallback: derive SOL from dWallet cap. With whitelist
        // mode, only publish what the owner explicitly listed.
        sol = await resolveSolFromCaps(record.dwallet_caps);
      }
      result = encodeAddrCoinTypeResult(sol ? bytesToHex(new TextEncoder().encode(sol)) : null);
    } else {
      result = encodeAddrCoinTypeResult(null);
    }
  } else if (innerSel === SEL_TEXT) {
    const [, key] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'string' }],
      bytesToHex(innerBytes.slice(4)),
    ) as [`0x${string}`, string];
    let value = '';
    if (record) {
      if (key === 'sui') value = record.sui_address;
      else if (key === 'name') value = record.name || bareLabel;
      else {
        const v = chainKey(key);
        if (v) value = v;
      }
    }
    result = encodeTextResult(value);
  } else {
    return c.json({ error: `unsupported inner selector ${innerSel}` }, 400);
  }

  const expires = BigInt(Math.floor(Date.now() / 1000)) + SIG_TTL_SEC;
  const privKey = privateKeyBytes(signerHex);
  const signature = signResolverMessage(privKey, sender, expires, data, result);

  const encoded = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    [bytesToHex(result), expires, bytesToHex(signature)],
  );
  return c.json({ data: encoded });
}
