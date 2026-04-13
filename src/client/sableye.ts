/**
 * Sableye — private interaction set.
 *
 * Tracks SuiNS counterparties brando has touched privately (Thunder
 * messaging, Sui transfers, cross-chain credits). The set is stored
 * as ciphertext in the Chronicom Durable Object so the operator can
 * never see plaintext membership. The AES-GCM key is non-extractable
 * and lives in the browser's IndexedDB keystore — raw key material
 * never leaves the device.
 *
 * Shape of the decrypted payload:
 *   { names: string[]; byChain: Record<'sui'|'btc'|'sol'|'eth'|'tron', string[]>; lastTouch: Record<string, number> }
 *
 * Public API:
 *   warmSableye()        — fetch + decrypt on wallet connect, populates cache
 *   hasSableye(name)     — synchronous lookup (for roster render)
 *   noteCounterparty()   — record an interaction, debounced persist
 *   resetSableye()       — clear on disconnect
 *
 * See issue #145.
 */

const _IDB_NAME = 'ski-crypto';
const _IDB_STORE = 'keys';
const _IDB_KEY_ID = 'sableye-aes';
const _PERSIST_DEBOUNCE_MS = 2000;
const _MAX_NAMES = 512;

// Chronicom is keyed per-wallet by Sui address. warmSableye() stashes
// the owner so subsequent persists can target the right DO instance
// without importing ui.ts state.
let _ownerAddr = '';
const _chronicomUrl = () => `/api/chronicom/sableye?addr=${encodeURIComponent(_ownerAddr)}`;

type Chain = 'sui' | 'btc' | 'sol' | 'eth' | 'tron';

interface SableyePayload {
  names: string[];
  byChain: Partial<Record<Chain, string[]>>;
  lastTouch: Record<string, number>;
}

let _set: Set<string> = new Set();
let _payload: SableyePayload = { names: [], byChain: {}, lastTouch: {} };
let _keyPromise: Promise<CryptoKey | null> | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _dirty = false;

// ─── IndexedDB AES-GCM key ────────────────────────────────────────────
const _openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const req = indexedDB.open(_IDB_NAME, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(_IDB_STORE); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const _idbGet = (db: IDBDatabase, k: string) => new Promise<unknown>((resolve, reject) => {
  const tx = db.transaction(_IDB_STORE, 'readonly');
  const req = tx.objectStore(_IDB_STORE).get(k);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const _idbPut = (db: IDBDatabase, k: string, v: unknown) => new Promise<void>((resolve, reject) => {
  const tx = db.transaction(_IDB_STORE, 'readwrite');
  tx.objectStore(_IDB_STORE).put(v, k);
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
});
const _getKey = (): Promise<CryptoKey | null> => {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    try {
      const db = await _openDb();
      let key = await _idbGet(db, _IDB_KEY_ID) as CryptoKey | undefined;
      if (!key) {
        key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false, // non-extractable
          ['encrypt', 'decrypt'],
        );
        await _idbPut(db, _IDB_KEY_ID, key);
      }
      return key;
    } catch { return null; }
  })();
  _keyPromise.catch(() => { _keyPromise = null; });
  return _keyPromise;
};

const _bytesToB64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
const _b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// ─── Envelope encrypt/decrypt ─────────────────────────────────────────
async function _encrypt(payload: SableyePayload): Promise<string | null> {
  const key = await _getKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  return JSON.stringify({ v: 1, iv: _bytesToB64(iv), ct: _bytesToB64(ct) });
}

async function _decrypt(envelope: string): Promise<SableyePayload | null> {
  try {
    const env = JSON.parse(envelope) as { v?: number; iv?: string; ct?: string };
    if (!env?.iv || !env?.ct) return null;
    const key = await _getKey();
    if (!key) return null;
    const iv = _b64ToBytes(env.iv);
    const ct = _b64ToBytes(env.ct);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const obj = JSON.parse(new TextDecoder().decode(pt)) as SableyePayload;
    if (!obj || !Array.isArray(obj.names)) return null;
    return { names: obj.names, byChain: obj.byChain || {}, lastTouch: obj.lastTouch || {} };
  } catch { return null; }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Load the encrypted set from Chronicom + decrypt into local cache.
 * Call on wallet connect. Safe to call multiple times — idempotent.
 */
export async function warmSableye(ownerAddr: string): Promise<void> {
  if (!ownerAddr) return;
  _ownerAddr = ownerAddr;
  try {
    const r = await fetch(_chronicomUrl());
    if (!r.ok) return;
    const j = await r.json() as { cipher?: string; updatedAt?: number; xchainLog?: Array<{ fromAddress: string; chain: string; ts: number }> };
    if (j.cipher) {
      const dec = await _decrypt(j.cipher);
      if (dec) {
        _payload = dec;
        _set = new Set(dec.names);
      }
    }
    // Merge any cross-chain webhook touches the server has logged since
    // last sync. The server only knows fromAddresses; we rely on the
    // browser's own reverseLookupName (in ui/thunder stack) to map back
    // to SuiNS names later — for now we just stash the raw log so the
    // ui layer can process it on demand.
    if (Array.isArray(j.xchainLog) && j.xchainLog.length > 0) {
      _pendingXchainLog = j.xchainLog;
    }
  } catch { /* non-blocking */ }
}

let _pendingXchainLog: Array<{ fromAddress: string; chain: string; ts: number }> = [];

/**
 * Drain the pending xchain webhook log. The caller (ui.ts) is expected
 * to resolve each fromAddress to a bare name via its reverse-lookup
 * cache and feed results back via `noteCounterparty`.
 */
export function drainXchainLog(): Array<{ fromAddress: string; chain: string; ts: number }> {
  const out = _pendingXchainLog;
  _pendingXchainLog = [];
  return out;
}

/** Synchronous membership check — safe to call from render loops. */
export function hasSableye(bareName: string): boolean {
  if (!bareName) return false;
  return _set.has(bareName.toLowerCase());
}

/**
 * Record an interaction with a counterparty. Idempotent — adding an
 * existing name just refreshes the lastTouch timestamp. Persists to
 * Chronicom with a 2s debounce so a burst of 10 thunders costs one
 * round-trip, not ten.
 */
export function noteCounterparty(bareName: string, chain: Chain): void {
  if (!bareName) return;
  const name = bareName.replace(/\.sui$/, '').toLowerCase();
  if (!name) return;
  let changed = false;
  if (!_set.has(name)) {
    _set.add(name);
    _payload.names.push(name);
    // Cap the set to prevent unbounded growth. Drop the least-recently
    // touched entry. Rare in practice but keeps the ciphertext bounded.
    if (_payload.names.length > _MAX_NAMES) {
      let oldestName = _payload.names[0];
      let oldestTs = _payload.lastTouch[oldestName] ?? 0;
      for (const n of _payload.names) {
        const ts = _payload.lastTouch[n] ?? 0;
        if (ts < oldestTs) { oldestName = n; oldestTs = ts; }
      }
      _set.delete(oldestName);
      _payload.names = _payload.names.filter(n => n !== oldestName);
      delete _payload.lastTouch[oldestName];
      for (const c of Object.keys(_payload.byChain) as Chain[]) {
        _payload.byChain[c] = (_payload.byChain[c] || []).filter(n => n !== oldestName);
      }
    }
    changed = true;
  }
  const chainList = _payload.byChain[chain] || [];
  if (!chainList.includes(name)) {
    chainList.push(name);
    _payload.byChain[chain] = chainList;
    changed = true;
  }
  const prevTs = _payload.lastTouch[name] ?? 0;
  const now = Date.now();
  if (now - prevTs > 60_000) {
    // Throttle lastTouch bumps to once per minute per name — avoids
    // gratuitous persist churn when a single session fires many events.
    _payload.lastTouch[name] = now;
    changed = true;
  }
  if (changed) _schedulePersist();
}

/** Force an immediate persist — used on disconnect or navigation. */
export async function flushSableye(): Promise<void> {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (!_dirty) return;
  await _persist();
}

/** Clear in-memory state on disconnect. Does NOT clear Chronicom cipher. */
export function resetSableye(): void {
  _ownerAddr = '';
  _set = new Set();
  _payload = { names: [], byChain: {}, lastTouch: {} };
  _pendingXchainLog = [];
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  _dirty = false;
}

function _schedulePersist(): void {
  _dirty = true;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persist().catch(() => {}); }, _PERSIST_DEBOUNCE_MS);
}

async function _persist(): Promise<void> {
  if (!_ownerAddr) return;
  const cipher = await _encrypt(_payload);
  if (!cipher) return;
  try {
    const r = await fetch(_chronicomUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cipher }),
    });
    if (r.ok) _dirty = false;
  } catch { /* non-blocking */ }
}
