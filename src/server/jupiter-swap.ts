/**
 * Jupiter SOL→USDC swap for Cloudflare Workers.
 *
 * Pure fetch() + ed25519 signing — no @solana/web3.js, no SDK.
 * Uses Jupiter's REST API (lite-api.jup.ag) to get a quote and
 * pre-serialized transaction, signs with ultron's ed25519 keypair,
 * and submits to Solana RPC.
 *
 * Flow:
 *   1. GET /quote — route SOL→USDC
 *   2. POST /swap — get base64 serialized tx
 *   3. Deserialize → sign with ed25519 → re-serialize
 *   4. Submit to Solana RPC (sendTransaction)
 */

import { b58encode, b58decode } from './solana-spl.js';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SOLANA_RPCS = [
  'https://api.mainnet-beta.solana.com',
];

interface SwapResult {
  digest: string;
  inputAmount: number;
  outputAmount: number;
  error?: string;
}

/**
 * Swap SOL → USDC on Jupiter.
 *
 * @param keypairSecret - 32-byte ed25519 secret (same as SHADE_KEEPER_PRIVATE_KEY)
 * @param lamports - SOL amount to swap (in lamports)
 * @param slippageBps - slippage tolerance (default 100 = 1%)
 * @param solanaRpcUrl - optional custom RPC
 */
export async function swapSolToUsdc(
  keypairSecret: string,
  lamports: bigint,
  slippageBps = 100,
  solanaRpcUrl?: string,
): Promise<SwapResult> {
  // Derive public key from secret
  const secretBytes = (() => {
    const clean = keypairSecret.startsWith('suiprivkey1')
      ? (() => { throw new Error('Pass raw hex or base64 secret, not bech32'); })()
      : keypairSecret;
    if (/^[0-9a-fA-F]{64}$/.test(clean)) {
      const b = new Uint8Array(32);
      for (let i = 0; i < 32; i++) b[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return b;
    }
    return Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  })();

  // Use @noble/curves for ed25519 — CF Workers' SubtleCrypto
  // can't import raw Ed25519 private keys for signing.
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const pubBytes = ed25519.getPublicKey(secretBytes);
  const walletPubkey = b58encode(pubBytes);

  console.log(`[jupiter] Swapping ${Number(lamports) / 1e9} SOL → USDC from ${walletPubkey}`);

  // Step 1: Get quote
  const quoteUrl = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${lamports.toString()}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    const err = await quoteRes.text();
    return { digest: '', inputAmount: 0, outputAmount: 0, error: `Quote failed: ${err}` };
  }
  const quoteData = await quoteRes.json() as {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    routePlan: unknown[];
  };
  console.log(`[jupiter] Quote: ${Number(quoteData.inAmount) / 1e9} SOL → ${Number(quoteData.outAmount) / 1e6} USDC`);

  // Step 2: Get swap transaction
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: walletPubkey,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapRes.ok) {
    const err = await swapRes.text();
    return { digest: '', inputAmount: 0, outputAmount: 0, error: `Swap tx build failed: ${err}` };
  }
  const swapData = await swapRes.json() as {
    swapTransaction: string;
    lastValidBlockHeight: number;
  };

  // Step 3: Deserialize, sign, re-serialize
  // Jupiter returns a versioned transaction (v0) as base64.
  // We need to:
  //   a) Decode base64 → raw bytes
  //   b) Extract the message portion (skip signature placeholders)
  //   c) Sign the message with ed25519
  //   d) Insert the signature
  //   e) Re-encode and submit
  const txBytes = Uint8Array.from(atob(swapData.swapTransaction), c => c.charCodeAt(0));

  // Versioned transaction format:
  //   [num_signatures: compact-u16] [signature_0: 64 bytes] ... [message bytes]
  // The first byte encodes the number of required signatures.
  // Jupiter pre-fills with a zeroed 64-byte placeholder for our sig.
  const numSigs = txBytes[0]; // compact-u16, usually just 1 byte for small values
  const sigStart = 1; // after the compact-u16 length
  const messageStart = sigStart + numSigs * 64;
  const message = txBytes.slice(messageStart);

  // Sign the message with @noble/curves ed25519
  const { ed25519: ed } = await import('@noble/curves/ed25519.js');
  const signature = ed.sign(message, secretBytes);

  // Insert signature into the tx (replace the first 64-byte placeholder)
  const signedTx = new Uint8Array(txBytes);
  signedTx.set(signature, sigStart);

  // Step 4: Submit to Solana RPC — try multiple endpoints
  const b64Signed = btoa(String.fromCharCode(...signedTx));
  const rpcs = [
    solanaRpcUrl,
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
  ].filter(Boolean) as string[];

  let digest = '';
  let lastError = '';
  for (const rpc of rpcs) {
    try {
      const submitRes = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sendTransaction',
          params: [b64Signed, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }],
        }),
      });
      const submitJson = await submitRes.json() as { result?: string; error?: { message: string } };
      if (submitJson.result) { digest = submitJson.result; break; }
      lastError = `${rpc}: ${JSON.stringify(submitJson.error).slice(0, 200)}`;
    } catch (e) {
      lastError = `${rpc}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (!digest) {
    return {
      digest: '',
      inputAmount: Number(quoteData.inAmount),
      outputAmount: Number(quoteData.outAmount),
      error: `Submit failed on all RPCs: ${lastError}`,
    };
  }
  console.log(`[jupiter] Swap submitted: ${digest}`);

  return {
    digest,
    inputAmount: Number(quoteData.inAmount),
    outputAmount: Number(quoteData.outAmount),
  };
}

/**
 * Get the current SOL→USDC quote without executing.
 */
export async function quoteSolToUsdc(lamports: bigint, slippageBps = 100): Promise<{
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  error?: string;
}> {
  try {
    const url = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${lamports.toString()}&slippageBps=${slippageBps}`;
    const res = await fetch(url);
    if (!res.ok) return { inAmount: '0', outAmount: '0', priceImpactPct: '0', error: await res.text() };
    const d = await res.json() as { inAmount: string; outAmount: string; priceImpactPct: string };
    return d;
  } catch (e) {
    return { inAmount: '0', outAmount: '0', priceImpactPct: '0', error: String(e) };
  }
}
