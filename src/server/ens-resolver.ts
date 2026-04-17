// ENS CCIP-read gateway — Beldum Iron Defense (#167).
//
// Responds to ENSIP-10 wildcard lookups for `*.waap.eth`. The on-chain
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

const WAAP_ETH_LABEL = 'waap';
const WAAP_ETH_TLD   = 'eth';

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

async function lookupRoster(bareLabel: string): Promise<RosterRecord | null> {
  const ensName = `${bareLabel}.${WAAP_ETH_LABEL}.${WAAP_ETH_TLD}`;
  const ensHash = keccak_256(new TextEncoder().encode(ensName));
  const nameHash = keccak_256(new TextEncoder().encode(bareLabel));
  for (const hash of [ensHash, nameHash]) {
    const b64 = btoa(String.fromCharCode(...hash));
    const q = `{ object(address:"${SUIAMI_ROSTER_OBJ}"){ dynamicField(name:{type:"vector<u8>",bcs:"${b64}"}){ value{ ...on MoveValue{ json } } } } }`;
    const r = await fetch(SUI_GQL_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const j = await r.json() as any;
    const rec = j?.data?.object?.dynamicField?.value?.json;
    if (!rec) continue;
    const chains: Record<string, string> = {};
    for (const { key, value } of rec.chains?.contents ?? []) chains[key] = value;
    return {
      name: rec.name ?? '',
      sui_address: rec.sui_address ?? '',
      chains,
      dwallet_caps: rec.dwallet_caps ?? [],
    };
  }
  return null;
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

async function resolveSolFromCaps(caps: string[]): Promise<string | null> {
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
  return results.find(Boolean) ?? null;
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

// ─── Main handler ───────────────────────────────────────────────────

export async function handleEnsCcipRead(c: Context): Promise<Response> {
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
  // Expect `<label>.waap.eth`.
  if (labels.length < 3 || labels[labels.length - 2] !== WAAP_ETH_LABEL
      || labels[labels.length - 1] !== WAAP_ETH_TLD) {
    return c.json({ error: 'not a waap.eth subname', labels }, 400);
  }
  const bareLabel = labels[0];

  const record = await lookupRoster(bareLabel);
  const innerBytes = hexToBytes(innerCall);
  const innerSel = bytesToHex(innerBytes.slice(0, 4)).toLowerCase();

  let result: Uint8Array;
  if (innerSel === SEL_ADDR) {
    result = encodeAddrResult(record?.chains?.eth ?? null);
  } else if (innerSel === SEL_ADDR_COINTYPE) {
    // addr(bytes32,uint256): second param is SLIP-44 coinType.
    const [, coinType] = decodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      bytesToHex(innerBytes.slice(4)),
    ) as [`0x${string}`, bigint];
    if (!record) {
      result = encodeAddrCoinTypeResult(null);
    } else if (coinType === COIN_ETH) {
      result = encodeAddrCoinTypeResult(record.chains.eth ?? null);
    } else if (coinType === COIN_BTC) {
      // BTC: address string → UTF-8 bytes wrapped as `bytes`.
      const btc = record.chains.btc ?? null;
      result = encodeAddrCoinTypeResult(btc ? bytesToHex(new TextEncoder().encode(btc)) : null);
    } else if (coinType === COIN_SOL) {
      // SOL: roster stores plaintext if present; else derive from dWallet cap (curve=2).
      let sol = record.chains.sol ?? null;
      if (!sol && record.dwallet_caps.length > 0) {
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
    // `text("sui")` returns the Sui address; `text("name")` the bare label.
    let value = '';
    if (record) {
      if (key === 'sui') value = record.sui_address;
      else if (key === 'name') value = record.name || bareLabel;
      else if (key in record.chains) value = record.chains[key];
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
