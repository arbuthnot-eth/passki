/**
 * Solana SPL Token operations — raw instruction construction for CF Workers.
 * No @solana/web3.js, no @solana/spl-token. Pure fetch() + Ed25519 signing.
 *
 * Used by OpenCLOB to mint iUSD natively on Solana via BAM attestation.
 * TODO: migrate to P-tokens for 95% CU savings once stable.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

// ── Program IDs (base58) ──────────────────────────────────────────────
// SPL Token (legacy) program. The previous constant here was a typo
// ('Jzqcg9bXRcwH6moLxHqRcbXBomN' instead of 'AJbNbGKPFXCWuBvf9Ss623VQ5DA')
// that decoded to 33 bytes, overrunning the 32-byte pubkey slot and
// corrupting every tx message we built.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// Helius Sender — low-latency dual-routed (validator + Jito) tx broadcast.
// Requires: skipPreflight=true, maxRetries=0, and a priority-fee tip
// of at least 0.0002 SOL via ComputeBudget.setComputeUnitPrice.
// https://www.helius.dev/docs/sending-transactions/sender
const HELIUS_SENDER_URL = 'https://sender.helius-rpc.com/fast';
// 0.0002 SOL = 200_000 lamports. For a 200k-CU tx this is
// 200_000 * 1_000_000 / 200_000 = 1_000_000 micro-lamports/CU.
// We set price at 1.2M micro-lamports/CU to clear the floor with margin.
const SENDER_MIN_CU_PRICE_MICROLAMPORTS = 1_200_000n;
const SENDER_CU_LIMIT = 200_000; // plenty for our 2-ix mint creations + 3-ix transfers

// ── Base58 ────────────────────────────────────────────────────────────
// Canonical Bitcoin-style Base58, verified to round-trip the Solana
// SystemProgram (32 zeros), TokenProgram, ATokenProgram pubkeys. An
// earlier hand-rolled version mis-counted leading-zero digits and
// mis-sized the big-endian buffer, producing 33-byte decodes for real
// 32-byte pubkeys and corrupting every tx message we built.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < B58.length; i++) m[B58.charCodeAt(i)] = i;
  return m;
})();

export function b58encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Leading zero bytes become leading '1's, not digits.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Size upper-bound: ceil(len * log(256) / log(58)) + 1 (≈ 1.366).
  const size = ((bytes.length - zeros) * 138 / 100 | 0) + 1;
  const b58buf = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += (b58buf[k] << 8);
      b58buf[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    if (carry !== 0) throw new Error('b58encode: non-zero carry');
    length = j;
  }

  // Skip leading zeros in b58buf (unused high bytes).
  let it = size - length;
  while (it < size && b58buf[it] === 0) it++;

  let str = '';
  for (let i = 0; i < zeros; i++) str += '1';
  for (; it < size; it++) str += B58[b58buf[it]];
  return str;
}

export function b58decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  // Leading '1's map to leading zero bytes; skip them when computing
  // the big-endian portion, then prepend back at the end.
  let zeros = 0;
  while (zeros < str.length && str.charCodeAt(zeros) === 49 /* '1' */) zeros++;

  // Upper bound: ceil(len * log(58) / log(256)) + 1 (≈ 0.733).
  const size = ((str.length - zeros) * 733 / 1000 | 0) + 1;
  const b256 = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const val = code < 128 ? B58_MAP[code] : -1;
    if (val < 0) throw new Error(`Invalid base58 char: ${str[i]}`);
    let carry = val;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * b256[k];
      b256[k] = carry & 0xff;
      carry >>= 8;
    }
    if (carry !== 0) throw new Error('b58decode: non-zero carry');
    length = j;
  }

  // Trim leading zeros in b256 after the decoded big-endian value.
  let it = size - length;
  while (it < size && b256[it] === 0) it++;

  const out = new Uint8Array(zeros + (size - it));
  // Leading '1's → zero bytes.
  for (let i = 0; i < zeros; i++) out[i] = 0;
  for (let i = 0; it < size; i++, it++) out[zeros + i] = b256[it];
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────
function u32LE(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64LE(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// Compact-u16 encoding (Solana transaction format)
function compactU16(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x4000) return new Uint8Array([n & 0x7f | 0x80, n >> 7]);
  return new Uint8Array([n & 0x7f | 0x80, (n >> 7) & 0x7f | 0x80, n >> 14]);
}

// SHA-256
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// ── PDA derivation ────────────────────────────────────────────────────
// A PDA is a 32-byte hash that is NOT a valid point on the ed25519 curve.
// The earlier check used WebCrypto's raw-importKey, which accepts any 32
// bytes without curve validation — so every bump succeeded and the loop
// fell off the end with "Could not find PDA". Use noble's point decoder
// as the authoritative curve check (decompression throws iff off-curve).
export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): Promise<[Uint8Array, number]> {
  for (let bump = 255; bump >= 0; bump--) {
    const seedsWithBump = [...seeds, new Uint8Array([bump])];
    const data = concat(...seedsWithBump, programId, new TextEncoder().encode('ProgramDerivedAddress'));
    const hash = await sha256(data);
    try {
      ed25519.Point.fromBytes(hash);
      continue; // On curve — not a valid PDA, try the next bump
    } catch {
      return [hash, bump]; // Off curve — valid PDA
    }
  }
  throw new Error('Could not find PDA');
}

// Derive ATA address
export async function deriveATA(
  wallet: Uint8Array,
  mint: Uint8Array,
): Promise<Uint8Array> {
  const tokenProgram = b58decode(TOKEN_PROGRAM);
  const ataProgram = b58decode(ATA_PROGRAM);
  const [pda] = await findProgramAddress([wallet, tokenProgram, mint], ataProgram);
  return pda;
}

// ── Instruction builders ──────────────────────────────────────────────

interface SolInstruction {
  programId: Uint8Array;
  accounts: Array<{ pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

/** System Program: CreateAccount */
function createAccountIx(
  payer: Uint8Array,
  newAccount: Uint8Array,
  lamports: bigint,
  space: bigint,
  owner: Uint8Array,
): SolInstruction {
  return {
    programId: b58decode(SYSTEM_PROGRAM),
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: newAccount, isSigner: true, isWritable: true },
    ],
    data: concat(u32LE(0), u64LE(lamports), u64LE(space), owner),
  };
}

/** SPL Token: InitializeMint2 (no rent sysvar needed) */
function initializeMint2Ix(
  mint: Uint8Array,
  decimals: number,
  mintAuthority: Uint8Array,
  freezeAuthority?: Uint8Array,
): SolInstruction {
  const data = freezeAuthority
    ? concat(new Uint8Array([20, decimals]), mintAuthority, new Uint8Array([1]), freezeAuthority)
    : concat(new Uint8Array([20, decimals]), mintAuthority, new Uint8Array([0]));
  return {
    programId: b58decode(TOKEN_PROGRAM),
    accounts: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  };
}

/** ATA Program: CreateIdempotent (won't fail if exists) */
function createATAIdempotentIx(
  payer: Uint8Array,
  ata: Uint8Array,
  wallet: Uint8Array,
  mint: Uint8Array,
): SolInstruction {
  return {
    programId: b58decode(ATA_PROGRAM),
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: b58decode(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: b58decode(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]), // CreateIdempotent
  };
}

/** ComputeBudget: SetComputeUnitLimit — bounds the max CU the tx can consume. */
function setComputeUnitLimitIx(units: number): SolInstruction {
  const b = new Uint8Array(5);
  b[0] = 2; // instruction discriminator for SetComputeUnitLimit
  new DataView(b.buffer).setUint32(1, units, true);
  return { programId: b58decode(COMPUTE_BUDGET_PROGRAM), accounts: [], data: b };
}

/** ComputeBudget: SetComputeUnitPrice — priority-fee tip in micro-lamports per CU. */
function setComputeUnitPriceIx(microLamports: bigint): SolInstruction {
  const b = new Uint8Array(9);
  b[0] = 3; // instruction discriminator for SetComputeUnitPrice
  new DataView(b.buffer).setBigUint64(1, microLamports, true);
  return { programId: b58decode(COMPUTE_BUDGET_PROGRAM), accounts: [], data: b };
}

/** Helper: prepend ComputeBudget instructions so Helius Sender's min-tip
 *  requirement (0.0002 SOL via priority fee) is always met. */
function withPriorityFee(ixs: SolInstruction[], cuPrice = SENDER_MIN_CU_PRICE_MICROLAMPORTS, cuLimit = SENDER_CU_LIMIT): SolInstruction[] {
  return [
    setComputeUnitLimitIx(cuLimit),
    setComputeUnitPriceIx(cuPrice),
    ...ixs,
  ];
}

/** SPL Token: TransferChecked — safer than Transfer because the amount and
 *  decimals are validated against the mint. Opcode 12. */
function transferCheckedIx(
  source: Uint8Array,
  mint: Uint8Array,
  destination: Uint8Array,
  owner: Uint8Array,
  amount: bigint,
  decimals: number,
): SolInstruction {
  return {
    programId: b58decode(TOKEN_PROGRAM),
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: concat(new Uint8Array([12]), u64LE(amount), new Uint8Array([decimals])),
  };
}

/** SPL Token: CloseAccount — reclaims the rent deposit from an SPL token
 *  account. The account must be empty (balance = 0). Opcode 9. */
function closeAccountIx(
  account: Uint8Array,
  destination: Uint8Array,
  owner: Uint8Array,
): SolInstruction {
  return {
    programId: b58decode(TOKEN_PROGRAM),
    accounts: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([9]),
  };
}

/** System Program: Transfer — native SOL transfer. Opcode 2. */
function systemTransferIx(
  source: Uint8Array,
  destination: Uint8Array,
  lamports: bigint,
): SolInstruction {
  return {
    programId: b58decode(SYSTEM_PROGRAM),
    accounts: [
      { pubkey: source, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
    ],
    data: concat(u32LE(2), u64LE(lamports)),
  };
}

/** SPL Token: MintTo */
function mintToIx(
  mint: Uint8Array,
  destination: Uint8Array,
  authority: Uint8Array,
  amount: bigint,
): SolInstruction {
  return {
    programId: b58decode(TOKEN_PROGRAM),
    accounts: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(new Uint8Array([7]), u64LE(amount)),
  };
}

// ── Transaction builder ───────────────────────────────────────────────

function buildMessage(
  payer: Uint8Array,
  instructions: SolInstruction[],
  recentBlockhash: Uint8Array, // 32 bytes
): { message: Uint8Array; signerCount: number } {
  // Collect all unique accounts, determine roles
  const accountMap = new Map<string, { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }>();
  const keyStr = (k: Uint8Array) => b58encode(k);

  // Payer is always first, signer + writable
  accountMap.set(keyStr(payer), { pubkey: payer, isSigner: true, isWritable: true });

  for (const ix of instructions) {
    for (const acc of ix.accounts) {
      const k = keyStr(acc.pubkey);
      const existing = accountMap.get(k);
      if (existing) {
        existing.isSigner = existing.isSigner || acc.isSigner;
        existing.isWritable = existing.isWritable || acc.isWritable;
      } else {
        accountMap.set(k, { ...acc });
      }
    }
    // Program ID as read-only non-signer
    const pk = keyStr(ix.programId);
    if (!accountMap.has(pk)) {
      accountMap.set(pk, { pubkey: ix.programId, isSigner: false, isWritable: false });
    }
  }

  // Sort: signers+writable, signers+readonly, non-signers+writable, non-signers+readonly
  const accounts = [...accountMap.values()].sort((a, b) => {
    if (a.isSigner !== b.isSigner) return a.isSigner ? -1 : 1;
    if (a.isWritable !== b.isWritable) return a.isWritable ? -1 : 1;
    return 0;
  });

  // Ensure payer is first
  const payerIdx = accounts.findIndex(a => keyStr(a.pubkey) === keyStr(payer));
  if (payerIdx > 0) {
    const [p] = accounts.splice(payerIdx, 1);
    accounts.unshift(p);
  }

  const numSigners = accounts.filter(a => a.isSigner).length;
  const numReadonlySigners = accounts.filter(a => a.isSigner && !a.isWritable).length;
  const numReadonlyNonSigners = accounts.filter(a => !a.isSigner && !a.isWritable).length;

  // Build account index lookup
  const accountIndex = new Map<string, number>();
  accounts.forEach((a, i) => accountIndex.set(keyStr(a.pubkey), i));

  // Compile instructions
  const compiledIxs: Uint8Array[] = [];
  for (const ix of instructions) {
    const progIdx = accountIndex.get(keyStr(ix.programId))!;
    const accIdxs = ix.accounts.map(a => accountIndex.get(keyStr(a.pubkey))!);
    compiledIxs.push(concat(
      new Uint8Array([progIdx]),
      compactU16(accIdxs.length),
      new Uint8Array(accIdxs),
      compactU16(ix.data.length),
      ix.data,
    ));
  }

  // Message: header(3) + accountKeys(compact + 32*n) + recentBlockhash(32) + instructions(compact + data)
  const header = new Uint8Array([numSigners, numReadonlySigners, numReadonlyNonSigners]);
  const accountKeys = concat(compactU16(accounts.length), ...accounts.map(a => a.pubkey));
  const ixsData = concat(compactU16(instructions.length), ...compiledIxs);

  return {
    message: concat(header, accountKeys, recentBlockhash, ixsData),
    signerCount: numSigners,
  };
}

// ── Public API ────────────────────────────────────────────────────────

export interface SolanaRpcConfig {
  rpcs: string[];
  timeout?: number;
  /** Optional Helius API key for the Sender endpoint. When set, every
   *  sendTransaction call goes through Helius Sender first (low-latency
   *  dual routing) and falls back to the `rpcs` pool on rejection. */
  heliusApiKey?: string;
}

/**
 * Submit a signed transaction via Helius Sender with an RPC fallback.
 * Sender gives low-latency dual routing (validator + Jito) but rejects
 * txs that don't meet its tip floor or skipPreflight/maxRetries
 * requirements. On any non-success, fall back to the regular RPC pool
 * via rpcCall('sendTransaction', ...).
 */
async function sendViaHelius(
  config: SolanaRpcConfig,
  txBase64: string,
  apiKey: string | undefined,
): Promise<string> {
  const url = apiKey ? `${HELIUS_SENDER_URL}?api-key=${apiKey}` : HELIUS_SENDER_URL;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'ski-' + Date.now(),
    method: 'sendTransaction',
    params: [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
  });
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(config.timeout || 15000),
    });
    if (r.ok) {
      const d = await r.json() as { result?: string; error?: { message?: string } };
      if (d.result) {
        console.log(`[solana-spl] Helius Sender accepted ${d.result.slice(0, 12)}…`);
        return d.result;
      }
      if (d.error) console.warn(`[solana-spl] Helius Sender rejected: ${d.error.message}`);
    } else {
      console.warn(`[solana-spl] Helius Sender HTTP ${r.status} ${r.statusText}`);
    }
  } catch (err) {
    console.warn(`[solana-spl] Helius Sender fetch failed: ${err instanceof Error ? err.message : err}`);
  }
  // Fallback — use the regular RPC pool (Helius RPC → publicnode → ankr → mainnet-beta)
  console.log('[solana-spl] falling back to RPC pool for sendTransaction');
  return rpcCall(config, 'sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
}

async function rpcCall(config: SolanaRpcConfig, method: string, params: any[]): Promise<any> {
  const failures: string[] = [];
  for (const rpc of config.rpcs) {
    const tag = rpc.replace(/^https?:\/\//, '').split('/')[0];
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(config.timeout || 15000),
      });
      if (!r.ok) {
        const reason = `${r.status} ${r.statusText}`;
        failures.push(`${tag}: ${reason}`);
        console.warn(`[solana-spl] ${rpc} ${method}: HTTP ${reason}`);
        continue;
      }
      const d = await r.json() as any;
      if (d.result !== undefined) return d.result;
      if (d.error) {
        failures.push(`${tag}: ${d.error.message}`);
        console.warn(`[solana-spl] ${rpc} ${method}: ${d.error.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${tag}: ${msg}`);
      console.warn(`[solana-spl] ${rpc} ${method}: ${msg}`);
    }
  }
  throw new Error(`RPC call ${method} failed on all endpoints — ${failures.join(' | ')}`);
}

/** Get recent blockhash for transaction construction */
async function getRecentBlockhash(config: SolanaRpcConfig): Promise<Uint8Array> {
  const result = await rpcCall(config, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
  return b58decode(result.value.blockhash);
}

/** Get rent-exempt minimum for an account size */
async function getRentExempt(config: SolanaRpcConfig, size: number): Promise<bigint> {
  const result = await rpcCall(config, 'getMinimumBalanceForRentExemption', [size]);
  return BigInt(result);
}

/**
 * Create a new SPL token mint on Solana.
 * Returns the mint address (base58).
 *
 * @param signFn - Ed25519 sign function (from IKA dWallet)
 * @param payerPubkey - 32-byte payer public key
 * @param decimals - token decimals (9 for iUSD)
 * @param config - RPC endpoints
 */
export async function createSplMint(
  signFn: (msg: Uint8Array) => Promise<Uint8Array>,
  payerPubkey: Uint8Array,
  decimals: number,
  config: SolanaRpcConfig,
): Promise<{ mintAddress: string; signature: string }> {
  // Generate ephemeral keypair for the mint account. WebCrypto's
  // Ed25519 raw-importKey only accepts public keys with 'verify' usage,
  // so we use generateKey and pull the raw public bytes out of that.
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const mintPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const mintSignFn = async (msg: Uint8Array) => {
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, msg);
    return new Uint8Array(sig);
  };

  const rentLamports = await getRentExempt(config, 82); // Mint account = 82 bytes
  const blockhash = await getRecentBlockhash(config);

  const tokenProgram = b58decode(TOKEN_PROGRAM);

  // ComputeBudget instructions must be first in the PTB. withPriorityFee
  // prepends setComputeUnitLimit + setComputeUnitPrice so Helius Sender's
  // 0.0002 SOL minimum tip is met.
  const instructions: SolInstruction[] = withPriorityFee([
    createAccountIx(payerPubkey, mintPubRaw, rentLamports, 82n, tokenProgram),
    initializeMint2Ix(mintPubRaw, decimals, payerPubkey), // payer = mint authority
  ]);

  const { message, signerCount } = buildMessage(payerPubkey, instructions, blockhash);

  // Sign with both payer and mint keypair
  const payerSig = await signFn(message);
  const mintSig = await mintSignFn(message);

  // Build signed transaction: [compact sigCount, ...sigs(64 each), message]
  const sigBytes = signerCount === 2
    ? concat(compactU16(2), payerSig, mintSig)
    : concat(compactU16(signerCount), payerSig, mintSig);

  const rawTx = concat(sigBytes, message);
  const txB64 = btoa(String.fromCharCode(...rawTx));

  const result = await sendViaHelius(config, txB64, config.heliusApiKey);
  const mintAddr = b58encode(mintPubRaw);
  console.log(`[solana-spl] Created mint: ${mintAddr}, tx: ${result}`);

  return { mintAddress: mintAddr, signature: result };
}

/**
 * Mint iUSD SPL tokens to a recipient on Solana.
 * Creates ATA if needed (idempotent), then mints.
 *
 * @param signFn - Ed25519 sign function (mint authority)
 * @param payerPubkey - 32-byte payer public key (= mint authority)
 * @param mintPubkey - 32-byte mint public key
 * @param recipientPubkey - 32-byte recipient wallet public key
 * @param amount - amount in smallest units (1 iUSD = 1_000_000_000 with 9 decimals)
 * @param config - RPC endpoints
 */
export async function mintSplTokens(
  signFn: (msg: Uint8Array) => Promise<Uint8Array>,
  payerPubkey: Uint8Array,
  mintPubkey: Uint8Array,
  recipientPubkey: Uint8Array,
  amount: bigint,
  config: SolanaRpcConfig,
): Promise<{ ata: string; signature: string }> {
  const ata = await deriveATA(recipientPubkey, mintPubkey);
  const blockhash = await getRecentBlockhash(config);

  const instructions: SolInstruction[] = withPriorityFee([
    createATAIdempotentIx(payerPubkey, ata, recipientPubkey, mintPubkey),
    mintToIx(mintPubkey, ata, payerPubkey, amount),
  ]);

  const { message } = buildMessage(payerPubkey, instructions, blockhash);
  const sig = await signFn(message);
  const rawTx = concat(compactU16(1), sig, message);
  const txB64 = btoa(String.fromCharCode(...rawTx));

  const result = await sendViaHelius(config, txB64, config.heliusApiKey);
  const ataAddr = b58encode(ata);
  console.log(`[solana-spl] Minted ${amount} to ATA ${ataAddr}, tx: ${result}`);

  return { ata: ataAddr, signature: result };
}

/**
 * Sweep a single SPL token account from `owner` to `recipient`.
 *
 * One transaction that: (1) creates the recipient ATA idempotently so
 * transfer always lands, (2) transferChecked'd the full balance, and
 * (3) closeAccount's the source ATA so the ~0.002 SOL rent deposit comes
 * back to `owner` (which gets picked up by the SOL sweep afterwards).
 *
 * Signing is the caller's responsibility — pass the same ed25519 sign fn
 * that signs for `ownerPubkey`.
 */
export async function sweepSplAccount(
  signFn: (msg: Uint8Array) => Promise<Uint8Array>,
  ownerPubkey: Uint8Array,
  recipientPubkey: Uint8Array,
  sourceAta: Uint8Array,
  mintPubkey: Uint8Array,
  amount: bigint,
  decimals: number,
  config: SolanaRpcConfig,
): Promise<{ signature: string; destAta: string }> {
  const destAta = await deriveATA(recipientPubkey, mintPubkey);
  const blockhash = await getRecentBlockhash(config);

  const instructions: SolInstruction[] = withPriorityFee([
    createATAIdempotentIx(ownerPubkey, destAta, recipientPubkey, mintPubkey),
    transferCheckedIx(sourceAta, mintPubkey, destAta, ownerPubkey, amount, decimals),
    closeAccountIx(sourceAta, ownerPubkey, ownerPubkey),
  ]);

  const { message } = buildMessage(ownerPubkey, instructions, blockhash);
  const sig = await signFn(message);
  const rawTx = concat(compactU16(1), sig, message);
  const txB64 = btoa(String.fromCharCode(...rawTx));

  const result = await sendViaHelius(config, txB64, config.heliusApiKey);
  console.log(`[solana-spl] Swept ${amount} of mint ${b58encode(mintPubkey).slice(0, 8)}… → ${b58encode(destAta).slice(0, 8)}…, tx: ${result}`);

  return { signature: result, destAta: b58encode(destAta) };
}

/**
 * Drain the SOL balance of `owner` to `recipient`, leaving only the tx fee.
 * Use after sweepSplAccount so ATA rent refunds have landed and the total
 * balance reflects everything we can safely drain.
 */
export async function sweepNativeSol(
  signFn: (msg: Uint8Array) => Promise<Uint8Array>,
  ownerPubkey: Uint8Array,
  recipientPubkey: Uint8Array,
  lamports: bigint,
  config: SolanaRpcConfig,
): Promise<{ signature: string; drained: bigint }> {
  const blockhash = await getRecentBlockhash(config);
  // Reserve exactly the priority-fee amount the tx will burn. With a
  // single System.transfer + ComputeBudget headers at the baseline CU
  // limit we need ~5_000 lamports base fee plus cuPrice*cuLimit/1e6
  // priority. 1.2M micro-lamports/CU × 200k CU = 240k extra lamports.
  const reserveFee = 5_000n + (SENDER_MIN_CU_PRICE_MICROLAMPORTS * BigInt(SENDER_CU_LIMIT)) / 1_000_000n;
  if (lamports <= reserveFee) {
    throw new Error(`Balance ${lamports} too low to cover ${reserveFee} fee reserve`);
  }
  const drain = lamports - reserveFee;

  const instructions: SolInstruction[] = withPriorityFee([
    systemTransferIx(ownerPubkey, recipientPubkey, drain),
  ]);

  const { message } = buildMessage(ownerPubkey, instructions, blockhash);
  const sig = await signFn(message);
  const rawTx = concat(compactU16(1), sig, message);
  const txB64 = btoa(String.fromCharCode(...rawTx));

  const result = await sendViaHelius(config, txB64, config.heliusApiKey);
  console.log(`[solana-spl] Drained ${drain} lamports → ${b58encode(recipientPubkey).slice(0, 8)}…, tx: ${result}`);

  return { signature: result, drained: drain };
}
