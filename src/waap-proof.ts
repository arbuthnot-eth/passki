/**
 * WaaP Proof Cache — stores the result of a successful WaaP authentication,
 * encrypted with the device fingerprint (FingerprintJS visitorId) so it can
 * only be decrypted on the same device.
 *
 * On subsequent visits the same fingerprint decrypts the cached proof and
 * activates the WaaP wallet without re-opening the OAuth modal.
 *
 * The proof also carries an OAuth snapshot: a copy of every localStorage key
 * that WaaP wrote during auth.  If the browser cleared storage between visits,
 * we restore those keys before attempting a silent connect so WaaP finds its
 * own session and skips the OAuth modal.
 */

const STORAGE_KEY = 'ski:waap-proof';
const SALT = new TextEncoder().encode('ski-waap-proof-v1');

// Maximum byte size of the oauth snapshot we're willing to store.
const SNAP_MAX_BYTES = 128 * 1024; // 128 KB

export interface WaapProof {
  address: string;
  provider: string;
  expiresAt: string;
  /** Keys WaaP wrote to localStorage during its OAuth flow (non-ski: keys). */
  oauthSnapshot?: Record<string, string>;
}

async function deriveKey(visitorId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(visitorId),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: 50_000, hash: 'SHA-256' },
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

/**
 * Capture all non-ski localStorage keys (WaaP's own OAuth state).
 * Called right after WaaP auth so we have a complete snapshot to restore later.
 */
export function snapshotWaapOAuth(): Record<string, string> {
  const snap: Record<string, string> = {};
  try {
    let totalBytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.startsWith('ski:')) continue;
      const v = localStorage.getItem(k) ?? '';
      totalBytes += k.length + v.length;
      if (totalBytes > SNAP_MAX_BYTES) break; // skip if too large
      snap[k] = v;
    }
  } catch { /* storage unavailable */ }
  return snap;
}

/**
 * Restore WaaP's OAuth keys from snapshot back into localStorage.
 * Idempotent — setting a key to its current value has no effect.
 */
export function restoreWaapOAuth(snapshot: Record<string, string>): void {
  for (const [k, v] of Object.entries(snapshot)) {
    try { localStorage.setItem(k, v); } catch {}
  }
}

/** Encrypt and persist a WaaP proof for the given device fingerprint. */
export async function storeWaapProof(proof: WaapProof, visitorId: string): Promise<void> {
  try {
    const key = await deriveKey(visitorId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(proof)),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ iv: ab2b64(iv.buffer as ArrayBuffer), data: ab2b64(ciphertext) }),
    );
  } catch { /* storage or WebCrypto unavailable */ }
}

/**
 * Decrypt and return the stored WaaP proof for this fingerprint.
 * Returns null if no proof is stored, the proof has expired, or the
 * visitorId doesn't match (decryption fails = different device).
 */
export async function getWaapProof(visitorId: string): Promise<WaapProof | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { iv, data } = JSON.parse(raw) as { iv: string; data: string };
    const key = await deriveKey(visitorId);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b642u8(iv) },
      key,
      b642u8(data),
    );
    const proof = JSON.parse(new TextDecoder().decode(plain)) as WaapProof;
    if (new Date(proof.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return proof;
  } catch {
    return null; // Wrong fingerprint, corrupt data, or expired
  }
}

/** Remove the stored WaaP proof (e.g. on explicit sign-out / forget device). */
export function clearWaapProof(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
