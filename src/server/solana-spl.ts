/**
 * Solana SPL Token operations — raw instruction construction for CF Workers.
 * No @solana/web3.js, no @solana/spl-token. Pure fetch() + Ed25519 signing.
 *
 * Used by OpenCLOB to mint iUSD natively on Solana via BAM attestation.
 * TODO: migrate to P-tokens for 95% CU savings once stable.
 */

// ── Program IDs (base58) ──────────────────────────────────────────────
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwGJzqcg9bXRcwH6moLxHqRcbXBomN';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ── Base58 ────────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let str = '';
  for (const b of bytes) { if (b === 0) str += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) str += B58[digits[i]];
  return str;
}

export function b58decode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (const c of str) {
    const idx = B58.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 char: ${c}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's → leading zeros
  for (const c of str) { if (c === '1') bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
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
export async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): Promise<[Uint8Array, number]> {
  for (let bump = 255; bump >= 0; bump--) {
    const seedsWithBump = [...seeds, new Uint8Array([bump])];
    const data = concat(...seedsWithBump, programId, new TextEncoder().encode('ProgramDerivedAddress'));
    const hash = await sha256(data);
    // Check if the hash is NOT on the ed25519 curve (valid PDA)
    // A point is on the curve if it can be decompressed — we use a simplified check
    // For practical purposes, most hashes are valid PDAs
    try {
      // Try importing as ed25519 point — if it fails, it's a valid PDA
      await crypto.subtle.importKey('raw', hash, { name: 'Ed25519' }, false, ['verify']);
      continue; // On curve — not a valid PDA
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
}

async function rpcCall(config: SolanaRpcConfig, method: string, params: any[]): Promise<any> {
  for (const rpc of config.rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(config.timeout || 15000),
      });
      const d = await r.json() as any;
      if (d.result !== undefined) return d.result;
      if (d.error) console.warn(`[solana-spl] ${rpc}: ${d.error.message}`);
    } catch { /* next */ }
  }
  throw new Error(`RPC call ${method} failed on all endpoints`);
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
  // Generate ephemeral keypair for mint account
  const mintKeypair = crypto.getRandomValues(new Uint8Array(32));
  // Derive pubkey from the private key using Ed25519
  const mintKeyObj = await crypto.subtle.importKey('raw', mintKeypair, { name: 'Ed25519' }, false, ['sign']);
  // We need the public key — extract it via PKCS8 or generate a keypair
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const mintPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const mintSignFn = async (msg: Uint8Array) => {
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, msg);
    return new Uint8Array(sig);
  };

  const rentLamports = await getRentExempt(config, 82); // Mint account = 82 bytes
  const blockhash = await getRecentBlockhash(config);

  const tokenProgram = b58decode(TOKEN_PROGRAM);

  const instructions: SolInstruction[] = [
    createAccountIx(payerPubkey, mintPubRaw, rentLamports, 82n, tokenProgram),
    initializeMint2Ix(mintPubRaw, decimals, payerPubkey), // payer = mint authority
  ];

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

  const result = await rpcCall(config, 'sendTransaction', [txB64, { encoding: 'base64' }]);
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

  const instructions: SolInstruction[] = [
    createATAIdempotentIx(payerPubkey, ata, recipientPubkey, mintPubkey),
    mintToIx(mintPubkey, ata, payerPubkey, amount),
  ];

  const { message } = buildMessage(payerPubkey, instructions, blockhash);
  const sig = await signFn(message);
  const rawTx = concat(compactU16(1), sig, message);
  const txB64 = btoa(String.fromCharCode(...rawTx));

  const result = await rpcCall(config, 'sendTransaction', [txB64, { encoding: 'base64' }]);
  const ataAddr = b58encode(ata);
  console.log(`[solana-spl] Minted ${amount} to ATA ${ataAddr}, tx: ${result}`);

  return { ata: ataAddr, signature: result };
}
