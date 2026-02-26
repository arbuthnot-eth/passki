/**
 * .SKI v2 — One-button wallet sign-in.
 *
 * Entry point. Boots the UI and orchestrates the sign-in flow:
 *   1. Connect wallet (Wallet Standard)
 *   2. Sign personal message (proof of ownership)
 *   3. Fingerprint device (FingerprintJS)
 *   4. POST to session agent (Cloudflare Durable Object)
 */

import { getState, signPersonalMessage, getSuiWallets, connect, disconnect } from './wallet.js';
import { initUI, showToast, updateAppState } from './ui.js';
import { getDeviceId, buildSessionKey } from './fingerprint.js';
import { connectSession, authenticate, disconnectSession } from './client/session.js';
// Ika is heavy (~150KB), lazy-load only after sign-in
const loadIka = () => import('./client/ika.js');

// ─── Session persistence ─────────────────────────────────────────────

interface StoredSession {
  address: string;
  signature: string;
  bytes: string;
  visitorId: string;
  expiresAt: string;
}

function getStoredSession(address: string): StoredSession | null {
  try {
    const raw = localStorage.getItem('ski:session');
    if (!raw) return null;
    const s: StoredSession = JSON.parse(raw);
    if (s.address !== address) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem('ski:session');
      return null;
    }
    return s;
  } catch { return null; }
}

function storeSession(s: StoredSession) {
  try { localStorage.setItem('ski:session', JSON.stringify(s)); } catch {}
}

// ─── Sign-in message builder ─────────────────────────────────────────

const TTL_DEFAULT_MS  = 7 * 24 * 60 * 60 * 1000; //  7 days  — software wallets
const TTL_KEYSTONE_MS = 1 * 24 * 60 * 60 * 1000; // 24 hours — hardware wallet (QR sign once / day)

function buildSignMessage(address: string, ttlMs = TTL_DEFAULT_MS): { message: string; expiresAt: string } {
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const message = [
    `.SKI Once, Everywhere`,
    '',
    address,
    '',
    `URI: ${window.location.origin}`,
    `Version: 2`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    '',
    'This signature activates your .SKI session and costs no gas.',
  ].join('\n');

  return { message, expiresAt };
}

// ─── Sign-in flow ────────────────────────────────────────────────────

async function establishSession(address: string, signature: string, bytes: string, visitorId: string) {
  const sessionKey = buildSessionKey(visitorId, address);
  connectSession(sessionKey, (state) => {
    if (state.suinsName) updateAppState({ suinsName: state.suinsName });
    if (state.ikaWalletId) updateAppState({ ikaWalletId: state.ikaWalletId });
  });

  try {
    const result = await authenticate({
      walletAddress: address,
      visitorId,
      confidence: 1,
      signature,
      message: '',
    });
    if (!result.success) {
      disconnectSession();
      return false;
    }
  } catch {
    // Agent might not be deployed yet — that's OK for local dev
  }

  // Check for existing Ika dWallets (non-blocking)
  loadIka().then(({ getCrossChainStatus }) => getCrossChainStatus(address)).then((status) => {
    if (status.ika) {
      updateAppState({ ikaWalletId: status.dwalletId });
    }
  }).catch(() => {});

  return true;
}

export async function signIn(isReconnect = false): Promise<boolean> {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.account) return false;

  const address = ws.address;

  // Check for existing valid session (skip re-signing on page reload)
  const stored = getStoredSession(address);
  if (stored) {
    console.log('[.SKI] Restoring session for', address);
    await establishSession(address, stored.signature, stored.bytes, stored.visitorId);
    return true;
  }

  // Fresh connection — need to sign
  const isKeystone = /keystone/i.test(ws.walletName);
  const ttlMs = isKeystone ? TTL_KEYSTONE_MS : TTL_DEFAULT_MS;
  const { message, expiresAt } = buildSignMessage(address, ttlMs);
  const messageBytes = new TextEncoder().encode(message);

  try {
    const [signResult, deviceId] = await Promise.all([
      signPersonalMessage(messageBytes),
      getDeviceId(),
    ]);

    const { signature, bytes } = signResult;
    const { visitorId } = deviceId;

    // Persist session so we don't re-prompt on reload
    storeSession({ address, signature, bytes, visitorId, expiresAt });

    await establishSession(address, signature, bytes, visitorId);

    if (!isReconnect) showToast(isKeystone ? 'Keystone session active — valid 24 h' : '.SKI session active');
    console.log('[.SKI] Session established for', address, '| device:', visitorId.slice(0, 8));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Signing failed';

    // Backpack throws this invariant when its internal Keystone hardware-wallet
    // keyring is missing (e.g. device was re-paired or keyring was reset).
    // Fall back to the Keystone wallet if it is registered in the browser,
    // but only if we are not already using it (guards against infinite retry).
    if (msg.includes('UserKeyring not found')) {
      const currentWallet = getState().wallet;
      const keystone = getSuiWallets().find((w) => /keystone/i.test(w.name));
      if (keystone && keystone !== currentWallet) {
        showToast('Switching to Keystone…');
        try {
          await disconnect();
          await connect(keystone);
          return signIn(isReconnect);
        } catch { /* fall through to user-friendly message */ }
      }
      // No Keystone extension found, or the fallback itself failed.
      // Give the user an actionable message instead of the raw invariant UUID.
      showToast('Backpack lost your Keystone device. Re-import it in Backpack, or install the Keystone extension.');
      return false;
    }

    if (!msg.toLowerCase().includes('reject')) {
      showToast(msg);
    }
    return false;
  }
}

// ─── Forget device ───────────────────────────────────────────────────

export { forgetDevice, disconnectSession } from './client/session.js';

// ─── Auto sign-in on wallet connect ──────────────────────────────────

window.addEventListener('ski:wallet-connected', async (e) => {
  const detail = (e as CustomEvent).detail;
  if (!detail?.address) return;

  const hasStored = !!localStorage.getItem('ski:session');
  if (hasStored) {
    // Restore an already-signed session without re-prompting.
    await signIn(/* isReconnect */ true);
    return;
  }

  // Keystone Pro: QR-sign once, cache for 24 h.
  // Auto-prompt on fresh connect so the user does not need to click SKI again.
  const ws = getState();
  if (ws.wallet && /keystone/i.test(ws.wallet.name)) {
    await signIn();
  }
});

window.addEventListener('ski:wallet-disconnected', () => {
  disconnectSession();
});

window.addEventListener('ski:request-signin', async () => {
  const ok = await signIn();
  if (ok) window.open('https://sui.ski', '_blank');
});

// ─── Boot ────────────────────────────────────────────────────────────

initUI();
