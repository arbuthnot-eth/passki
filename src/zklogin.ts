/**
 * zkLogin Sign-In Provider for .SKI
 *
 * Generates ephemeral keypairs, builds OAuth redirect URLs,
 * handles callbacks, derives deterministic salts via HKDF,
 * fetches ZK proofs, assembles zkLogin signatures, and registers
 * as a Sui Wallet Standard provider.
 *
 * No JSON-RPC — epoch queries use SuiGraphQLClient.
 * No external salt server — salt derived locally via WebCrypto HKDF.
 * Proofs cached encrypt with device fingerprint (same pattern as waap-proof.ts).
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  generateRandomness,
  generateNonce,
  jwtToAddress,
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  getZkLoginSignature,
  decodeJwt,
} from '@mysten/sui/zklogin';
import type { ZkLoginSignatureInputs } from '@mysten/sui/zklogin';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { toBase64, fromBase64 } from '@mysten/bcs';
import { registerWallet } from '@wallet-standard/wallet';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { getDeviceId } from './fingerprint.js';

// ─── Configuration ──────────────────────────────────────────────────

export interface ZkLoginConfig {
  /** Google OAuth 2.0 client ID (implicit flow) */
  googleClientId: string;
  /** Apple Sign-In service ID */
  appleClientId: string;
  /** Redirect URI for OAuth callbacks */
  redirectUri: string;
  /** ZK prover endpoint — requests proxied through CF Worker to avoid CORS */
  proverUrl: string;
  /** GraphQL endpoint for epoch queries */
  graphqlUrl: string;
  /** Network identifier */
  network: 'mainnet' | 'testnet' | 'devnet';
}

/** Default config — placeholder OAuth client IDs, swap for real ones. */
export const ZKLOGIN_CONFIG: ZkLoginConfig = {
  // ── PLACEHOLDER: Replace with your Google Cloud Console OAuth 2.0 client ID ──
  googleClientId: 'GOOGLE_CLIENT_ID.apps.googleusercontent.com',
  // ── PLACEHOLDER: Replace with your Apple Developer Services ID ──
  appleClientId: 'APPLE_CLIENT_ID',
  redirectUri: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '',
  // Hybrid prover strategy:
  //   devnet/testnet → Enoki free tier (vampire mode)
  //   mainnet → self-hosted Docker prover behind CF Worker proxy
  proverUrl: '/api/zklogin/prove',
  graphqlUrl: 'https://graphql.mainnet.sui.io/graphql',
  network: 'mainnet',
};

/**
 * Override config at runtime (e.g. from ski.ts based on environment).
 * Merges partial overrides into the default config.
 */
export function configureZkLogin(overrides: Partial<ZkLoginConfig>): void {
  Object.assign(ZKLOGIN_CONFIG, overrides);
}

// ─── Types ──────────────────────────────────────────────────────────

export type OAuthProvider = 'google' | 'apple';

export interface EphemeralSession {
  /** Ed25519 keypair (ephemeral, lives in sessionStorage only) */
  keypair: Ed25519Keypair;
  /** Randomness string for nonce generation */
  randomness: string;
  /** Nonce derived from keypair + maxEpoch + randomness */
  nonce: string;
  /** Maximum epoch for which this session is valid */
  maxEpoch: number;
  /** Current epoch at session creation time */
  currentEpoch: number;
}

export interface ZkProof {
  proofPoints: {
    a: string[];
    b: string[][];
    c: string[];
  };
  issBase64Details: {
    value: string;
    indexMod4: number;
  };
  headerBase64: string;
}

export interface ZkLoginSession {
  address: string;
  provider: OAuthProvider;
  jwt: string;
  salt: string;
  proof: ZkProof;
  maxEpoch: number;
  addressSeed: string;
  ephemeralPublicKey: string;
  /** Epoch the proof expires after */
  expiresAtEpoch: number;
}

/**
 * Thrown when a cached zkLogin proof's maxEpoch has passed and the user
 * must re-authenticate. Callers can `catch (e) { if (e instanceof ZkLoginEpochExpiredError) e.recover(); }`
 * to re-trigger the OAuth flow without tight coupling to the UI layer.
 */
export class ZkLoginEpochExpiredError extends Error {
  readonly provider: OAuthProvider;
  readonly currentEpoch: number;
  readonly maxEpoch: number;
  constructor(provider: OAuthProvider, currentEpoch: number, maxEpoch: number) {
    super(`zkLogin proof expired (current epoch ${currentEpoch} > maxEpoch ${maxEpoch}) — re-auth required`);
    this.name = 'ZkLoginEpochExpiredError';
    this.provider = provider;
    this.currentEpoch = currentEpoch;
    this.maxEpoch = maxEpoch;
  }
  /** Re-trigger the OAuth flow for the original provider. Navigates away from the page. */
  async recover(): Promise<void> {
    await startZkLogin(this.provider);
  }
}

export interface ZkLoginSessionHealth {
  /** True if there is an active session and current epoch ≤ maxEpoch. */
  valid: boolean;
  /** maxEpoch - currentEpoch. Negative means already expired. */
  epochsRemaining: number;
  /** True when the session should be re-proved soon (< 1 epoch remaining). */
  shouldRefresh: boolean;
}

interface SerializedEphemeralSession {
  /** Bech32 `suiprivkey1...` string from Ed25519Keypair.getSecretKey() */
  secretKey: string;
  randomness: string;
  nonce: string;
  maxEpoch: number;
  currentEpoch: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const SESSION_STORAGE_KEY = 'ski:zklogin-ephemeral';
const PROOF_STORAGE_KEY = 'ski:zklogin-proof';
const PROOF_CACHE_SALT = new TextEncoder().encode('ski-zklogin-proof-v1');

// ─── Epoch Query via GraphQL ────────────────────────────────────────

/**
 * Fetch the current epoch from the Sui GraphQL API.
 * No JSON-RPC — GraphQL only.
 */
export async function getCurrentEpoch(): Promise<number> {
  const gql = new SuiGraphQLClient({
    url: ZKLOGIN_CONFIG.graphqlUrl,
    network: ZKLOGIN_CONFIG.network,
  });
  const result = await gql.query({
    query: '{ epoch { epochId } }',
    variables: {},
  });
  const epochId = (result.data as { epoch: { epochId: number } })?.epoch?.epochId;
  if (epochId == null) throw new Error('Failed to fetch current epoch from GraphQL');
  return Number(epochId);
}

// ─── Ephemeral Session ──────────────────────────────────────────────

/**
 * Generate a fresh ephemeral Ed25519 keypair, randomness, and nonce.
 * maxEpoch = currentEpoch + 2 (proofs valid for ~2 epochs, ~48h).
 * Persisted in sessionStorage only — never localStorage.
 */
export async function generateEphemeralSession(): Promise<EphemeralSession> {
  const currentEpoch = await getCurrentEpoch();
  const maxEpoch = currentEpoch + 2;
  const keypair = Ed25519Keypair.generate();
  const randomness = generateRandomness();
  const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, BigInt(randomness));

  const session: EphemeralSession = { keypair, randomness, nonce, maxEpoch, currentEpoch };
  persistEphemeralSession(session);
  return session;
}

function persistEphemeralSession(session: EphemeralSession): void {
  try {
    const serialized: SerializedEphemeralSession = {
      // getSecretKey() returns a Bech32 suiprivkey1... string — store directly.
      // No encode/decode dance: fromSecretKey() accepts the same Bech32 string.
      secretKey: session.keypair.getSecretKey(),
      randomness: session.randomness,
      nonce: session.nonce,
      maxEpoch: session.maxEpoch,
      currentEpoch: session.currentEpoch,
    };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(serialized));
  } catch { /* sessionStorage unavailable */ }
}

/**
 * Restore an ephemeral session from sessionStorage.
 * Returns null if none exists or the data is corrupt.
 */
export function restoreEphemeralSession(): EphemeralSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SerializedEphemeralSession;
    const keypair = Ed25519Keypair.fromSecretKey(s.secretKey);
    return {
      keypair,
      randomness: s.randomness,
      nonce: s.nonce,
      maxEpoch: s.maxEpoch,
      currentEpoch: s.currentEpoch,
    };
  } catch {
    return null;
  }
}

/** Clear the ephemeral session from sessionStorage. */
export function clearEphemeralSession(): void {
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
}

// ─── OAuth URL Builders ─────────────────────────────────────────────

/**
 * Build the OAuth redirect URL for the given provider.
 * Google uses the implicit flow (response_type=id_token, token in URL hash).
 * Apple uses the form_post flow (id_token in POST body — needs CF Worker relay).
 */
export function buildOAuthUrl(provider: OAuthProvider, nonce: string): string {
  switch (provider) {
    case 'google': {
      const params = new URLSearchParams({
        client_id: ZKLOGIN_CONFIG.googleClientId,
        redirect_uri: ZKLOGIN_CONFIG.redirectUri,
        response_type: 'id_token',
        scope: 'openid',
        nonce,
        // Suppress account chooser for returning users
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    case 'apple': {
      const params = new URLSearchParams({
        client_id: ZKLOGIN_CONFIG.appleClientId,
        redirect_uri: ZKLOGIN_CONFIG.redirectUri,
        response_type: 'code id_token',
        response_mode: 'form_post',
        scope: 'openid',
        nonce,
      });
      return `https://appleid.apple.com/auth/authorize?${params}`;
    }
    default:
      throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
}

// ─── OAuth Callback Handling ────────────────────────────────────────

/**
 * Extract the JWT id_token from the current page URL.
 *
 * Google implicit flow: token is in the URL hash fragment as `id_token=...`
 * Apple form_post flow: CF Worker relays the POST body into a hash redirect,
 *   so the token arrives the same way.
 *
 * Returns null if no token is present (not an OAuth callback).
 */
export function handleOAuthCallback(): string | null {
  if (typeof window === 'undefined') return null;

  // Check URL hash (Google implicit flow + Apple relay)
  const hash = window.location.hash.substring(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const idToken = params.get('id_token');
    if (idToken) return idToken;
  }

  // Check URL query params (fallback for some relay patterns)
  const query = new URLSearchParams(window.location.search);
  const queryToken = query.get('id_token');
  if (queryToken) return queryToken;

  return null;
}

/**
 * Extract the `nonce` claim from a JWT without verifying the signature.
 * decodeJwt() from @mysten/sui/zklogin strips non-Sui claims, so we parse
 * the middle base64url segment directly for nonce validation.
 */
export function extractJwtNonce(jwt: string): string | null {
  try {
    const [, payload] = jwt.split('.');
    if (!payload) return null;
    // base64url → base64. Pad to length multiple of 4:
    //   len % 4 === 0 → 0 pads
    //   len % 4 === 2 → 2 pads
    //   len % 4 === 3 → 1 pad
    // (residue 1 is not a valid base64 length and will fail atob naturally)
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padCount = (4 - (b64.length % 4)) % 4;
    const padded = b64 + '='.repeat(padCount);
    const json = atob(padded);
    const claims = JSON.parse(json) as { nonce?: string };
    return typeof claims.nonce === 'string' ? claims.nonce : null;
  } catch {
    return null;
  }
}

/**
 * Detect the OAuth provider from a JWT's issuer claim.
 */
export function detectProvider(jwt: string): OAuthProvider {
  const decoded = decodeJwt(jwt);
  if (decoded.iss.includes('google') || decoded.iss.includes('accounts.google.com')) {
    return 'google';
  }
  if (decoded.iss.includes('apple')) {
    return 'apple';
  }
  throw new Error(`Unknown JWT issuer: ${decoded.iss}`);
}

// ─── Salt Derivation (HKDF, no external server) ────────────────────

/**
 * Derive a deterministic salt from JWT claims via HKDF.
 * Salt = HKDF(ikm=sub, salt=iss||aud, info="ski-zklogin-salt-v1").
 *
 * **Critical design note**: Do NOT include device-derived material (fingerprint,
 * user agent, etc.) in the salt — the zkLogin address is a pure function of
 * (iss, aud, sub, salt), so any change to salt re-maps the user to a new address
 * with no recovery path. Browser fingerprints change on updates, privacy mode,
 * cleared data — if the salt depended on them, returning users would silently
 * lose access to their existing address and any on-chain state.
 *
 * By deriving from JWT claims only:
 * - Same OAuth account → same Sui address, always, on every device
 * - No external salt server required
 * - Privacy: the OAuth provider already knows (iss, aud, sub); deriving the
 *   salt from the same inputs reveals nothing they don't already see
 *
 * 128-bit output is well within the BN254 field element bound zkLogin requires.
 */
export async function deriveSalt(jwt: string): Promise<string> {
  const decoded = decodeJwt(jwt);
  const enc = new TextEncoder();

  const aud = Array.isArray(decoded.aud) ? decoded.aud[0] ?? '' : decoded.aud ?? '';
  if (!decoded.sub || !decoded.iss || !aud) {
    throw new Error('deriveSalt: JWT missing sub/iss/aud claim');
  }

  // IKM = sub (user-specific). Not a secret but binds the salt to the user.
  const ikm = await crypto.subtle.importKey(
    'raw',
    enc.encode(decoded.sub),
    'HKDF',
    false,
    ['deriveBits'],
  );

  const hkdfSalt = enc.encode(`${decoded.iss}|${aud}`);
  const info = enc.encode('ski-zklogin-salt-v1');

  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info },
    ikm,
    128,
  );

  const bytes = new Uint8Array(bits);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return BigInt('0x' + hex).toString();
}

// ─── ZK Proof Fetching ──────────────────────────────────────────────

/**
 * Fetch a ZK proof from the prover endpoint.
 * Requests go through `/api/zklogin/prove` (CF Worker proxy) to avoid CORS.
 *
 * The prover expects:
 * - jwt: the raw JWT string
 * - extendedEphemeralPublicKey: base64 of the ephemeral public key
 * - maxEpoch: max epoch for which the proof is valid
 * - jwtRandomness: the randomness used to generate the nonce
 * - salt: the user's deterministic salt
 * - keyClaimName: 'sub' (default)
 */
export async function fetchZkProof(
  jwt: string,
  ephemeralPublicKey: string,
  maxEpoch: number,
  randomness: string,
  salt: string,
): Promise<ZkProof> {
  const body = {
    jwt,
    extendedEphemeralPublicKey: ephemeralPublicKey,
    maxEpoch,
    jwtRandomness: randomness,
    salt,
    keyClaimName: 'sub',
  };

  const res = await fetch(ZKLOGIN_CONFIG.proverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`ZK prover returned ${res.status}: ${text}`);
  }

  const proof = (await res.json()) as ZkProof;

  // Validate proof structure
  if (!proof.proofPoints?.a || !proof.proofPoints?.b || !proof.proofPoints?.c) {
    throw new Error('Invalid ZK proof structure from prover');
  }

  return proof;
}

// ─── Signature Assembly ─────────────────────────────────────────────

/**
 * Assemble a complete zkLogin signature from proof + ephemeral signature.
 *
 * @param proof - ZK proof from the prover
 * @param addressSeed - genAddressSeed result (decimal string)
 * @param maxEpoch - max epoch the proof is valid for
 * @param userSignature - base64 ephemeral key signature over the transaction
 */
export function assembleZkLoginSignature(
  proof: ZkProof,
  addressSeed: string,
  maxEpoch: number,
  userSignature: string,
): string {
  const inputs: ZkLoginSignatureInputs = {
    proofPoints: proof.proofPoints,
    issBase64Details: proof.issBase64Details,
    headerBase64: proof.headerBase64,
    addressSeed,
  };

  return getZkLoginSignature({
    inputs,
    maxEpoch,
    userSignature,
  });
}

// ─── Proof Cache (encrypt with device fingerprint) ──────────────────

/**
 * PBKDF2 → AES-GCM key derivation from device fingerprint.
 * Same pattern as waap-proof.ts — duplicated to keep modules independent.
 */
async function deriveProofCacheKey(visitorId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(visitorId),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: PROOF_CACHE_SALT, iterations: 50_000, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function ab2b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b642u8(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

/** Encrypt and persist a zkLogin proof+session for the given device fingerprint. */
export async function storeZkLoginProof(session: ZkLoginSession, visitorId: string): Promise<void> {
  try {
    const key = await deriveProofCacheKey(visitorId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(session)),
    );
    localStorage.setItem(
      PROOF_STORAGE_KEY,
      JSON.stringify({ iv: ab2b64(iv.buffer as ArrayBuffer), data: ab2b64(ciphertext) }),
    );
  } catch { /* storage or WebCrypto unavailable */ }
}

/**
 * Decrypt and return the cached zkLogin session for this fingerprint.
 * Returns null if no proof is stored, proof has expired, or fingerprint
 * doesn't match (AES-GCM decrypt fails = different device).
 */
export async function getZkLoginProof(visitorId: string): Promise<ZkLoginSession | null> {
  try {
    const raw = localStorage.getItem(PROOF_STORAGE_KEY);
    if (!raw) return null;
    const { iv, data } = JSON.parse(raw) as { iv: string; data: string };
    const key = await deriveProofCacheKey(visitorId);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b642u8(iv) },
      key,
      b642u8(data),
    );
    const session = JSON.parse(new TextDecoder().decode(plain)) as ZkLoginSession;

    // Check epoch expiry — if the proof's maxEpoch has passed, discard
    try {
      const currentEpoch = await getCurrentEpoch();
      if (currentEpoch > session.maxEpoch) {
        clearZkLoginProof();
        return null;
      }
    } catch {
      // If epoch check fails, return the cached session anyway —
      // the tx will fail at submission if the proof is actually expired.
    }

    return session;
  } catch {
    return null; // Wrong fingerprint, corrupt data, or expired
  }
}

/** Remove the cached zkLogin proof (e.g. on explicit sign-out). */
export function clearZkLoginProof(): void {
  try { localStorage.removeItem(PROOF_STORAGE_KEY); } catch {}
}

// ─── Full Sign-In Flow ──────────────────────────────────────────────

/**
 * Complete the zkLogin sign-in flow after OAuth callback.
 * 1. Extracts JWT from URL
 * 2. Restores ephemeral session from sessionStorage
 * 3. Derives salt from device fingerprint + JWT
 * 4. Computes zkLogin address
 * 5. Fetches ZK proof from prover
 * 6. Caches everything encrypt with device fingerprint
 *
 * Returns null if not an OAuth callback or session is missing.
 */
export async function completeZkLogin(): Promise<ZkLoginSession | null> {
  const jwt = handleOAuthCallback();
  if (!jwt) return null;

  const session = restoreEphemeralSession();
  if (!session) {
    console.warn('[.SKI zkLogin] OAuth callback received but no ephemeral session found');
    return null;
  }

  // Critical: validate nonce binding before calling the prover. The Mysten
  // prover validates this too, but failing it locally costs ~0ms vs ~3s at the
  // prover and avoids leaking JWTs to the upstream on replay attempts.
  // decodeJwt's return type omits `nonce`, so we decode the payload ourselves.
  const decoded = decodeJwt(jwt);
  const jwtNonce = extractJwtNonce(jwt);
  if (jwtNonce !== session.nonce) {
    throw new Error('[.SKI zkLogin] JWT nonce mismatch — possible replay or injection');
  }

  const { visitorId } = await getDeviceId();
  const salt = await deriveSalt(jwt);
  const address = jwtToAddress(jwt, salt, false);

  const ephemeralPublicKey = getExtendedEphemeralPublicKey(session.keypair.getPublicKey());
  const proof = await fetchZkProof(
    jwt,
    ephemeralPublicKey,
    session.maxEpoch,
    session.randomness,
    salt,
  );

  const aud = Array.isArray(decoded.aud) ? decoded.aud[0] ?? '' : decoded.aud ?? '';
  const addressSeed = genAddressSeed(salt, 'sub', decoded.sub, aud).toString();
  const provider = detectProvider(jwt);

  const zkSession: ZkLoginSession = {
    address,
    provider,
    jwt,
    salt,
    proof,
    maxEpoch: session.maxEpoch,
    addressSeed,
    ephemeralPublicKey,
    expiresAtEpoch: session.maxEpoch,
  };

  // Cache the proof encrypt with device fingerprint
  await storeZkLoginProof(zkSession, visitorId);

  // Clean the URL hash so the JWT isn't visible in the address bar
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('id_token');
    window.history.replaceState(null, '', url.toString());
  }

  return zkSession;
}

/**
 * Attempt to restore a cached zkLogin session from localStorage.
 * Returns null if no valid cached session exists for this device.
 */
export async function restoreZkLoginSession(): Promise<ZkLoginSession | null> {
  const { visitorId } = await getDeviceId();
  return getZkLoginProof(visitorId);
}

// ─── Transaction Signing ────────────────────────────────────────────

/**
 * Check whether a cached zkLogin session's proof has expired on-chain.
 * On expiry: clears proof + ephemeral session, dispatches `ski:zklogin-expired`
 * event, and throws ZkLoginEpochExpiredError. Callers can catch and invoke
 * `.recover()` to re-trigger the OAuth flow.
 *
 * No-op if the epoch query itself fails — we fall through to signing and let
 * the tx fail at submission rather than block on a flaky GraphQL endpoint.
 */
async function assertEpochNotExpired(zkSession: ZkLoginSession): Promise<void> {
  let currentEpoch: number;
  try {
    currentEpoch = await getCurrentEpoch();
  } catch {
    return; // don't block signing on GraphQL flakes
  }
  if (currentEpoch > zkSession.maxEpoch) {
    clearZkLoginProof();
    clearEphemeralSession();
    activeZkSession = null;
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('ski:zklogin-expired', {
          detail: { provider: zkSession.provider, currentEpoch, maxEpoch: zkSession.maxEpoch },
        }));
      } catch {}
    }
    throw new ZkLoginEpochExpiredError(zkSession.provider, currentEpoch, zkSession.maxEpoch);
  }
}

/**
 * Sign a transaction with zkLogin.
 * Uses the ephemeral keypair to sign, then wraps in a zkLogin signature.
 * Throws ZkLoginEpochExpiredError if the proof's maxEpoch has passed.
 */
export async function signTransaction(
  txBytes: Uint8Array,
  zkSession: ZkLoginSession,
): Promise<string> {
  await assertEpochNotExpired(zkSession);

  const ephemeral = restoreEphemeralSession();
  if (!ephemeral) throw new Error('No ephemeral session — zkLogin session expired, sign in again');

  // Sign the transaction bytes with the ephemeral keypair
  const { signature: userSignature } = await ephemeral.keypair.signTransaction(txBytes);

  // Wrap in a zkLogin signature
  return assembleZkLoginSignature(
    zkSession.proof,
    zkSession.addressSeed,
    zkSession.maxEpoch,
    userSignature,
  );
}

/**
 * Sign a personal message with zkLogin.
 * Uses the ephemeral keypair to sign, then wraps in a zkLogin signature.
 * Throws ZkLoginEpochExpiredError if the proof's maxEpoch has passed.
 */
export async function signPersonalMessage(
  message: Uint8Array,
  zkSession: ZkLoginSession,
): Promise<string> {
  await assertEpochNotExpired(zkSession);

  const ephemeral = restoreEphemeralSession();
  if (!ephemeral) throw new Error('No ephemeral session — zkLogin session expired, sign in again');

  const { signature: userSignature } = await ephemeral.keypair.signPersonalMessage(message);

  return assembleZkLoginSignature(
    zkSession.proof,
    zkSession.addressSeed,
    zkSession.maxEpoch,
    userSignature,
  );
}

/**
 * Report the health of the currently active zkLogin session.
 * - `valid`: session exists and current epoch ≤ maxEpoch
 * - `epochsRemaining`: maxEpoch - currentEpoch (negative = expired)
 * - `shouldRefresh`: true when epochsRemaining < 1, i.e. re-prove on next free moment
 *
 * Returns `{ valid: false, epochsRemaining: -Infinity, shouldRefresh: true }` when
 * there is no active session or the epoch query fails.
 */
export async function getZkLoginSessionHealth(): Promise<ZkLoginSessionHealth> {
  if (!activeZkSession) {
    return { valid: false, epochsRemaining: -Infinity, shouldRefresh: true };
  }
  let currentEpoch: number;
  try {
    currentEpoch = await getCurrentEpoch();
  } catch {
    return { valid: false, epochsRemaining: -Infinity, shouldRefresh: true };
  }
  const epochsRemaining = activeZkSession.maxEpoch - currentEpoch;
  const valid = epochsRemaining >= 0;
  const shouldRefresh = epochsRemaining < 1;
  return { valid, epochsRemaining, shouldRefresh };
}

/**
 * Attempt a silent zkLogin refresh without a full OAuth redirect.
 *
 * Strategy: if the cached JWT is still within its own exp and the ephemeral
 * session is still in sessionStorage, re-hit the prover with a fresh maxEpoch
 * bump. The same JWT + nonce is reusable against the prover until its `exp`
 * claim passes, so we can mint a new proof without bouncing through Google/Apple.
 *
 * Returns `true` on success (activeZkSession updated + re-cached).
 * Returns `false` if a full OAuth redirect is required — caller should invoke
 * `startZkLogin(provider)` in that case.
 */
export async function tryRefreshZkLogin(): Promise<boolean> {
  if (!activeZkSession) return false;

  // Is the JWT itself still valid? `exp` is seconds since epoch.
  try {
    const decoded = decodeJwt(activeZkSession.jwt);
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof decoded.exp === 'number' && decoded.exp <= nowSec) {
      return false; // JWT expired — full OAuth required
    }
  } catch {
    return false;
  }

  // Ephemeral session must still be present — the prover binds the proof to
  // the extended ephemeral public key, so we can't re-prove without it.
  const ephemeral = restoreEphemeralSession();
  if (!ephemeral) return false;

  try {
    const currentEpoch = await getCurrentEpoch();
    // If the ephemeral session's maxEpoch is still in the future, reuse it;
    // otherwise we cannot refresh silently (nonce would change → new OAuth).
    if (currentEpoch > ephemeral.maxEpoch) return false;

    const extPubKey = getExtendedEphemeralPublicKey(ephemeral.keypair.getPublicKey());
    const proof = await fetchZkProof(
      activeZkSession.jwt,
      extPubKey,
      ephemeral.maxEpoch,
      ephemeral.randomness,
      activeZkSession.salt,
    );

    const refreshed: ZkLoginSession = {
      ...activeZkSession,
      proof,
      maxEpoch: ephemeral.maxEpoch,
      ephemeralPublicKey: extPubKey,
      expiresAtEpoch: ephemeral.maxEpoch,
    };

    const { visitorId } = await getDeviceId();
    await storeZkLoginProof(refreshed, visitorId);
    activeZkSession = refreshed;
    return true;
  } catch {
    return false;
  }
}

// ─── Wallet Standard Registration ───────────────────────────────────

/** Minimal ZK-themed SVG icon for the wallet picker */
const ZK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#00d4aa"/><stop offset="100%" stop-color="#0088ff"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)" rx="24"/><text x="64" y="78" text-anchor="middle" font-family="monospace" font-weight="bold" font-size="44" fill="white">ZK</text></svg>';
const ZKLOGIN_ICON = `data:image/svg+xml;base64,${btoa(ZK_SVG)}` as `data:image/svg+xml;base64,${string}`;

let zkWalletRegistered = false;
let activeZkSession: ZkLoginSession | null = null;

/**
 * Create and register a zkLogin Wallet Standard wallet.
 * Shows up in getSuiWallets() alongside WaaP and extension wallets.
 */
export function createZkLoginWallet(): Wallet {
  const accounts: WalletAccount[] = [];

  const wallet: Wallet = {
    name: 'zkLogin',
    version: '1.0.0' as const,
    icon: ZKLOGIN_ICON,
    chains: ['sui:mainnet' as const, 'sui:testnet' as const],
    accounts,
    features: {
      'standard:connect': {
        version: '1.0.0' as const,
        async connect(input?: { silent?: boolean }) {
          // Try restoring a cached session first
          const cached = await restoreZkLoginSession();
          if (cached) {
            activeZkSession = cached;
            const account = makeZkLoginAccount(cached.address);
            accounts.length = 0;
            accounts.push(account);
            return { accounts: [account] as readonly WalletAccount[] };
          }

          if (input?.silent) {
            // Silent connect — no cached session, return empty
            return { accounts: [] as readonly WalletAccount[] };
          }

          // Interactive connect — generate ephemeral session and redirect to Google
          // (UI should call startZkLogin() directly for provider choice, but default to Google)
          const session = await generateEphemeralSession();
          const url = buildOAuthUrl('google', session.nonce);
          window.location.href = url;

          // This won't resolve — page is navigating away
          return { accounts: [] as readonly WalletAccount[] };
        },
      },
      'standard:disconnect': {
        version: '1.0.0' as const,
        async disconnect() {
          activeZkSession = null;
          accounts.length = 0;
          clearEphemeralSession();
          clearZkLoginProof();
        },
      },
      'sui:signPersonalMessage': {
        version: '1.0.0' as const,
        async signPersonalMessage(input: { message: Uint8Array; account: WalletAccount }) {
          if (!activeZkSession) throw new Error('zkLogin: not connected');
          const sig = await signPersonalMessage(input.message, activeZkSession);
          return {
            signature: sig,
            bytes: toBase64(input.message),
          };
        },
      },
      'sui:signAndExecuteTransaction': {
        version: '2.0.0' as const,
        async signAndExecuteTransaction(input: {
          transaction: { toJSON: () => Promise<string> } | string;
          account: WalletAccount;
          chain?: string;
        }) {
          if (!activeZkSession) throw new Error('zkLogin: not connected');

          // Build the transaction bytes
          const gql = new SuiGraphQLClient({
            url: ZKLOGIN_CONFIG.graphqlUrl,
            network: ZKLOGIN_CONFIG.network,
          });

          let txBytes: Uint8Array;
          if (typeof input.transaction === 'string') {
            txBytes = fromBase64(input.transaction);
          } else {
            const txJson = await input.transaction.toJSON();
            const tx = Transaction.from(txJson);
            tx.setSender(activeZkSession.address);
            txBytes = await tx.build({ client: gql as never });
          }

          // Sign with zkLogin
          const signature = await signTransaction(txBytes, activeZkSession);

          // Execute via JSON-RPC (GraphQL is read-only — sui_executeTransactionBlock is the exception)
          const executeRes = await fetch('https://sui-rpc.publicnode.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_executeTransactionBlock',
              params: [
                toBase64(txBytes),
                [signature],
                { showEffects: true },
                'WaitForLocalExecution',
              ],
            }),
          });
          const executeJson = (await executeRes.json()) as {
            result?: { digest: string; effects: { status: { status: string } } };
            error?: { message: string };
          };

          if (executeJson.error) {
            throw new Error(`Transaction execution failed: ${executeJson.error.message}`);
          }

          return {
            digest: executeJson.result?.digest ?? '',
            bytes: toBase64(txBytes),
            signature,
            effects: toBase64(new TextEncoder().encode(JSON.stringify(executeJson.result?.effects ?? {}))),
          };
        },
      },
    },
  };

  return wallet;
}

function makeZkLoginAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: new Uint8Array(0), // zkLogin accounts don't expose a traditional public key
    chains: ['sui:mainnet' as const, 'sui:testnet' as const],
    features: [
      'sui:signPersonalMessage' as const,
      'sui:signAndExecuteTransaction' as const,
    ],
    label: 'zkLogin',
    icon: ZKLOGIN_ICON,
  };
}

/**
 * Register zkLogin as a Wallet Standard provider.
 * Call once from ski.ts during initialization.
 * Idempotent — safe to call multiple times.
 */
export async function registerZkLogin(): Promise<void> {
  if (zkWalletRegistered || typeof window === 'undefined') return;
  zkWalletRegistered = true;

  try {
    const wallet = createZkLoginWallet();
    registerWallet(wallet as unknown as Parameters<typeof registerWallet>[0]);
    console.log('[.SKI] zkLogin wallet registered');

    // Check if this is an OAuth callback and complete the flow automatically
    const jwt = handleOAuthCallback();
    if (jwt) {
      const session = await completeZkLogin();
      if (session) {
        activeZkSession = session;
        const account = makeZkLoginAccount(session.address);
        (wallet.accounts as WalletAccount[]).push(account);
        console.log('[.SKI] zkLogin sign-in completed:', session.address);
      }
    }
  } catch (err) {
    zkWalletRegistered = false;
    console.warn('[.SKI] zkLogin registration failed:', err);
  }
}

/**
 * Get the currently active zkLogin session, if any.
 */
export function getActiveZkSession(): ZkLoginSession | null {
  return activeZkSession;
}

/**
 * Initiate a zkLogin sign-in flow for a specific provider.
 * Generates an ephemeral session and redirects to the OAuth provider.
 */
export async function startZkLogin(provider: OAuthProvider): Promise<void> {
  const session = await generateEphemeralSession();
  const url = buildOAuthUrl(provider, session.nonce);
  window.location.href = url;
}

/**
 * Full sign-out: clear all zkLogin state.
 */
export function signOutZkLogin(): void {
  activeZkSession = null;
  clearEphemeralSession();
  clearZkLoginProof();
}
