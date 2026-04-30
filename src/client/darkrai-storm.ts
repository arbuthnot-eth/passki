/**
 * Darkrai Storm — end-to-end Bad Dreams demo.
 *
 * Models a Storm epoch using the byte-level Darkrai API:
 *   1. Storm-open: setup(ell) produces { ek, sk, dk }
 *      In production: sk is then Seal-encrypted to the existing 2-of-3
 *      committee (Overclock + NodeInfra + Studio Mirai) and stored in the
 *      Storm's PermissionedGroup<Messaging>.
 *   2. Senders: for each message, generate a fresh GT pad → SHA-256 → AES key,
 *      AES-GCM-wrap a `Thunder { sender, ts_ms, body }` payload, and
 *      encrypt(ek, pad) for the batch CT.
 *   3. Storm-close (epoch boundary): recipient Seal-decrypts to recover sk,
 *      runs pre_decrypt(sk, cts) → 48-byte sbk, then
 *      decrypt(dk, sbk, cts) → all pads, then AES-GCM-unwrap each payload.
 *
 * This file simulates step 1 + 2 + 3 in one tab — the Seal layer is
 * elided here (we hold sk locally) since the smoke is about validating
 * the Darkrai byte API end-to-end with real AEAD.
 *
 * Usage from devtools:
 *   await window.__darkraiStorm(8)   // 8-message Storm epoch demo
 */

interface DarkraiSetup {
  ek: Uint8Array;
  sk: Uint8Array;
  dk: Uint8Array;
  ell: number;
}

interface DarkraiModule {
  default: (path?: string) => Promise<unknown>;
  version: () => string;
  setup: (ell: number) => DarkraiSetup;
  random_pad: () => Uint8Array;
  encrypt: (ek: Uint8Array, pad: Uint8Array) => Uint8Array;
  pre_decrypt: (sk: Uint8Array, cts_concat: Uint8Array, ell: number) => Uint8Array;
  decrypt: (
    dk: Uint8Array,
    sbk: Uint8Array,
    cts_concat: Uint8Array,
    ell: number,
  ) => Uint8Array;
}

let cached: DarkraiModule | null = null;
async function loadDarkrai(): Promise<DarkraiModule> {
  if (cached) return cached;
  const url = '/wasm/darkrai/' + 'darkrai_wasm.js';
  const mod = (await import(/* @vite-ignore */ url)) as DarkraiModule;
  await mod.default();
  cached = mod;
  return cached;
}

// ─── AEAD layer (AES-256-GCM keyed by SHA-256(GT pad)) ──────────────────

async function padToAesKey(pad: Uint8Array): Promise<CryptoKey> {
  const h = await crypto.subtle.digest('SHA-256', pad);
  return crypto.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function slotNonce(slot: number): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(0, BigInt(slot), true);
  return n;
}

interface ThunderMessage {
  sender: string;            // SuiNS-style identifier
  ts_ms: number;
  body: { kind: 'text'; text: string } | { kind: 'attachment'; blob_id: string; blob_key_b64: string; mime: string; size: number };
}

async function aeadWrap(pad: Uint8Array, slot: number, msg: ThunderMessage): Promise<Uint8Array> {
  const key = await padToAesKey(pad);
  const plain = new TextEncoder().encode(JSON.stringify(msg));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: slotNonce(slot) }, key, plain);
  return new Uint8Array(ct);
}

async function aeadUnwrap(pad: Uint8Array, slot: number, ct: Uint8Array): Promise<ThunderMessage> {
  const key = await padToAesKey(pad);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: slotNonce(slot) }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

// ─── Mock messages ───────────────────────────────────────────────────────

function mockMessage(slot: number): ThunderMessage {
  const senders = ['brando.sui', 'ultron.whelm.eth', 'splash.sui', 'plankton.sui'];
  const sender = senders[slot % senders.length];
  const ts_ms = Date.now() - (slot * 60_000);
  if (slot % 2 === 0) {
    return { sender, ts_ms, body: { kind: 'text', text: `Storm slot ${slot} — text-only thunder ⚡` } };
  }
  // Mock an attachment ref. In production, blob_key would AEAD the actual Walrus blob.
  const fakeBlobKey = new Uint8Array(32);
  crypto.getRandomValues(fakeBlobKey);
  const blob_key_b64 = btoa(String.fromCharCode(...fakeBlobKey));
  return {
    sender,
    ts_ms,
    body: {
      kind: 'attachment',
      blob_id: `walrus_${slot}_${ts_ms.toString(36)}`,
      blob_key_b64,
      mime: slot % 4 === 1 ? 'image/jpeg' : 'video/mp4',
      size: slot % 4 === 1 ? 245_000 : 4_800_000,
    },
  };
}

// ─── End-to-end Storm epoch ──────────────────────────────────────────────

export interface StormReport {
  ell: number;
  setup_ms: number;
  encrypt_ms: number;
  pre_decrypt_ms: number;
  decrypt_ms: number;
  aead_unwrap_ms: number;
  total_ms: number;
  ek_bytes: number;
  sk_bytes: number;
  dk_bytes: number;
  sbk_bytes: number;
  ct_bytes_each: number;
  aead_total_bytes: number;
  onchain_epoch_bytes: number;
  attachment_count: number;
  all_messages_ok: boolean;
}

export async function darkraiStorm(ell = 8): Promise<StormReport> {
  if (!Number.isInteger(ell) || ell <= 0 || (ell & (ell - 1)) !== 0) {
    throw new Error('ell must be a positive power of two');
  }
  const mod = await loadDarkrai();

  // ── Senders compose ell messages
  const messages = Array.from({ length: ell }, (_, i) => mockMessage(i));

  // ── Storm-open: committee setup
  const t0 = performance.now();
  const setup = mod.setup(ell);
  const setup_ms = performance.now() - t0;

  // ── Senders generate pads + AEAD-wrap payloads + batch-encrypt pads
  const t1 = performance.now();
  const pads: Uint8Array[] = [];
  const cts: Uint8Array[] = [];
  const aeadPayloads: Uint8Array[] = [];
  for (let i = 0; i < ell; i++) {
    const pad = mod.random_pad();
    pads.push(pad);
    aeadPayloads.push(await aeadWrap(pad, i, messages[i]));
    cts.push(mod.encrypt(setup.ek, pad));
  }
  const encrypt_ms = performance.now() - t1;

  // Concatenate CTs for the batch API
  const ctSize = cts[0].length;
  const ctsConcat = new Uint8Array(ell * ctSize);
  cts.forEach((c, i) => ctsConcat.set(c, i * ctSize));

  // ── Storm-close: recipient pre-decrypts (after Seal-recovering sk in prod)
  const t2 = performance.now();
  const sbk = mod.pre_decrypt(setup.sk, ctsConcat, ell);
  const pre_decrypt_ms = performance.now() - t2;

  // ── Recipient decrypts the batch
  const t3 = performance.now();
  const padsConcat = mod.decrypt(setup.dk, sbk, ctsConcat, ell);
  const decrypt_ms = performance.now() - t3;

  // Split pads
  const padSize = padsConcat.length / ell;
  const recoveredPads: Uint8Array[] = [];
  for (let i = 0; i < ell; i++) {
    recoveredPads.push(padsConcat.slice(i * padSize, (i + 1) * padSize));
  }

  // Sanity: the pads we just decrypted must equal the originals we encrypted
  for (let i = 0; i < ell; i++) {
    if (recoveredPads[i].length !== pads[i].length) {
      throw new Error(`pad ${i} length mismatch: ${recoveredPads[i].length} vs ${pads[i].length}`);
    }
    for (let j = 0; j < pads[i].length; j++) {
      if (recoveredPads[i][j] !== pads[i][j]) {
        throw new Error(`pad ${i} byte ${j} mismatch — batch decrypt failed`);
      }
    }
  }

  // ── AEAD-unwrap each payload with the corresponding pad
  const t4 = performance.now();
  const recoveredMessages: ThunderMessage[] = [];
  for (let i = 0; i < ell; i++) {
    recoveredMessages.push(await aeadUnwrap(recoveredPads[i], i, aeadPayloads[i]));
  }
  const aead_unwrap_ms = performance.now() - t4;

  const all_messages_ok = recoveredMessages.every((r, i) => JSON.stringify(r) === JSON.stringify(messages[i]));
  if (!all_messages_ok) {
    throw new Error('AEAD round-trip mismatch');
  }

  const aead_total_bytes = aeadPayloads.reduce((s, p) => s + p.length, 0);
  const attachment_count = messages.filter((m) => m.body.kind === 'attachment').length;
  const onchain_epoch_bytes = ell * ctSize + aead_total_bytes + sbk.length;

  const report: StormReport = {
    ell,
    setup_ms,
    encrypt_ms,
    pre_decrypt_ms,
    decrypt_ms,
    aead_unwrap_ms,
    total_ms: setup_ms + encrypt_ms + pre_decrypt_ms + decrypt_ms + aead_unwrap_ms,
    ek_bytes: setup.ek.length,
    sk_bytes: setup.sk.length,
    dk_bytes: setup.dk.length,
    sbk_bytes: sbk.length,
    ct_bytes_each: ctSize,
    aead_total_bytes,
    onchain_epoch_bytes,
    attachment_count,
    all_messages_ok,
  };

  console.info(`[darkrai-storm] ${mod.version()} — ℓ=${ell}, ${attachment_count} attachments`);
  console.table([
    { phase: 'setup', ms: setup_ms.toFixed(1) },
    { phase: 'sender encrypt + AEAD wrap', ms: encrypt_ms.toFixed(1) },
    { phase: 'pre-decrypt (recipient)', ms: pre_decrypt_ms.toFixed(1) },
    { phase: 'batch decrypt', ms: decrypt_ms.toFixed(1) },
    { phase: 'AEAD unwrap all', ms: aead_unwrap_ms.toFixed(1) },
    { phase: '── recipient total ──', ms: (pre_decrypt_ms + decrypt_ms + aead_unwrap_ms).toFixed(1) },
  ]);
  console.info('on-chain footprint per epoch:', report.onchain_epoch_bytes, 'bytes');
  console.info('all messages round-tripped:', all_messages_ok);
  return report;
}

declare global {
  interface Window {
    __darkraiStorm?: typeof darkraiStorm;
  }
}
if (typeof window !== 'undefined') {
  window.__darkraiStorm = darkraiStorm;
}
