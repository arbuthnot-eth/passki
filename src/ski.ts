/**
 * .SKI v2 — One-button wallet sign-in.
 *
 * Entry point. Boots the UI and orchestrates the sign-in flow:
 *   1. Connect wallet (Wallet Standard)
 *   2. Sign personal message (proof of ownership)
 *   3. Fingerprint device (FingerprintJS)
 *   4. POST to session agent (Cloudflare Durable Object)
 */

import { Transaction } from '@mysten/sui/transactions';
import { getState, signPersonalMessage, signAndExecuteTransaction, signTransaction, getSuiWallets, connect, disconnect } from './wallet.js';
import { initUI, showToast, showToastWithRetry, showBackpackLockedToast, updateAppState, grpcClient, enrollAllKnownAddresses, SUI_DROP_URI, getAppState } from './ui.js';
import { restoreSponsor, isSponsorActive, isKeeperSponsorActive, executeSponsored, initSplashDO, getSponsorState, resolveNameToAddress } from './sponsor.js';
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
    const raw = localStorage.getItem(`ski:session:${address}`);
    if (!raw) return null;
    const s: StoredSession = JSON.parse(raw);
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(`ski:session:${address}`);
      return null;
    }
    return s;
  } catch { return null; }
}

function storeSession(s: StoredSession) {
  try { localStorage.setItem(`ski:session:${s.address}`, JSON.stringify(s)); } catch {}
}

// ─── Cross-domain session cookie (shared across sui.ski + all *.sui.ski) ─────
// Domain=sui.ski (RFC 6265, no leading dot) covers the root domain and every
// subdomain — sui.ski, splash.sui.ski, brandon.sui.ski, etc. — making it the
// common session point for all names. All StoredSession fields are ASCII-safe
// (hex/base64/ISO) so plain btoa() works without any encoding tricks.

const XDOMAIN_COOKIE = 'ski_xdomain';
const XDOMAIN_DOMAIN = 'sui.ski';

function writeSharedSession(s: StoredSession): void {
  try {
    const b64 = btoa(JSON.stringify(s));
    const maxAge = Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000));
    document.cookie = `${XDOMAIN_COOKIE}=${b64}; domain=${XDOMAIN_DOMAIN}; path=/; max-age=${maxAge}; secure; samesite=lax`;
  } catch {}
}

function readSharedSession(address: string): StoredSession | null {
  try {
    const entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(`${XDOMAIN_COOKIE}=`));
    if (!entry) return null;
    const s: StoredSession = JSON.parse(atob(entry.slice(XDOMAIN_COOKIE.length + 1)));
    if (s.address !== address) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) return null;
    return s;
  } catch { return null; }
}

function clearSharedSession(): void {
  try {
    document.cookie = `${XDOMAIN_COOKIE}=; domain=${XDOMAIN_DOMAIN}; path=/; max-age=0; secure; samesite=lax`;
  } catch {}
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
    `URI: https://sui.ski`,
    `Version: 2`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    '',
    'This signature activates your .SKI session and costs no gas.',
  ].join('\n');

  return { message, expiresAt };
}

// ─── Splash drop (device-level sponsor badge) ────────────────────────
//
// Activated automatically once the user signs in and a FingerprintJS
// visitorId is available — no extra signature required.
// Stored in SplashDeviceAgent (keyed by visitorId) so the drop persists
// across browser sessions and incognito windows on the same device.

async function ensureSplashDrop(address: string, visitorId: string): Promise<void> {
  const { checkDeviceSplash, activateDeviceSplash } = await import('./client/splash.js');
  const already = await checkDeviceSplash(visitorId);
  if (already) {
    updateAppState({ splashSponsor: true });
    return;
  }
  const ok = await activateDeviceSplash(visitorId, address);
  if (ok) updateAppState({ splashSponsor: true });
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

  // Check for existing valid session — local first, then cross-subdomain cookie
  const stored = getStoredSession(address) || readSharedSession(address);
  if (stored) {
    // If restored from cross-domain cookie, cache locally so future loads skip the cookie read
    try { if (!localStorage.getItem(`ski:session:${address}`)) storeSession(stored); } catch {}
    await establishSession(address, stored.signature, stored.bytes, stored.visitorId);
    // Ensure splash drop on session restore (non-blocking)
    ensureSplashDrop(address, stored.visitorId).catch(() => {});
    return true;
  }

  // Fresh connection — need to sign
  const isKeystone = /keystone/i.test(ws.walletName);
  const ttlMs = isKeystone ? TTL_KEYSTONE_MS : TTL_DEFAULT_MS;
  const { message, expiresAt } = buildSignMessage(address, ttlMs);
  const messageBytes = new TextEncoder().encode(message);

  // Update favicon to match the sign context before the wallet dialog appears
  const suinsName = (() => { try { return localStorage.getItem(`ski:suins:${address}`); } catch { return null; } })();
  const hasSignedBefore = (() => { try { return !!localStorage.getItem(`ski:signed:${address}`); } catch { return false; } })();
  const signVariant = suinsName ? 'blue-square' : (!hasSignedBefore ? 'green-circle' : 'black-diamond');
  window.dispatchEvent(new CustomEvent('ski:pre-sign', { detail: { variant: signVariant } }));

  try {
    const [signResult, deviceId] = await Promise.all([
      signPersonalMessage(messageBytes),
      getDeviceId(),
    ]);

    const { signature, bytes } = signResult;
    const { visitorId } = deviceId;

    // Persist session locally and in cross-domain cookie for *.sui.ski auto-restore
    storeSession({ address, signature, bytes, visitorId, expiresAt });
    writeSharedSession({ address, signature, bytes, visitorId, expiresAt });
    try { localStorage.setItem(`ski:signed:${address}`, '1'); } catch {}

    // Cache WaaP proof encrypted by this device's fingerprint so subsequent
    // clicks on the WaaP legend row can activate without re-opening the OAuth modal.
    // Also snapshot WaaP's own localStorage keys so the OAuth session survives
    // a browser storage clear (restored before the next silent-connect attempt).
    if (/waap/i.test(ws.walletName)) {
      const provider = (() => {
        try { return localStorage.getItem(`ski:waap-provider:${address}`) || 'x'; } catch { return 'x'; }
      })();
      import('./waap-proof.js').then(({ storeWaapProof, snapshotWaapOAuth }) => {
        const oauthSnapshot = snapshotWaapOAuth();
        return storeWaapProof({ address, provider, expiresAt, oauthSnapshot }, visitorId);
      }).catch(() => {});
    }

    await establishSession(address, signature, bytes, visitorId);

    if (!isReconnect) showToast(isKeystone ? 'Keystone session active — valid 24 h' : '.SKI session active');

    // Activate device splash drop now that we have a session + fingerprint
    if (!isReconnect) ensureSplashDrop(address, visitorId).catch(() => {});

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
      // wallet.ts already attempted a non-silent reconnect to open the Backpack
      // popup — if we're here the wallet is still locked or the Keystone device
      // is genuinely missing.  Give the user an actionable retry button.
      if (keystone) {
        showToastWithRetry(
          'Backpack lost your Keystone device. Re-import it in Backpack, or install the Keystone extension.',
          'Try again',
          () => signIn(isReconnect),
        );
      } else {
        showBackpackLockedToast();
      }
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
export { setModalLayout, type ModalLayout, mountBalanceCycler, mountSkiButton, mountDotButton, openModal } from './ui.js';

// ─── Auto sign-in on wallet connect ──────────────────────────────────

window.addEventListener('ski:wallet-connected', async (e) => {
  const detail = (e as CustomEvent).detail;
  if (!detail?.address) return;

  // Restore silently if we have a cached session for this specific address.
  if (localStorage.getItem(`ski:session:${detail.address}`)) {
    await signIn(/* isReconnect */ true);
    return;
  }

  // No stored session for this address.  Don't auto-sign for software wallets
  // (user must click SKI).  Keystone gets an auto-prompt because QR-signing
  // costs significant friction and sessions last 24 h.
  const ws = getState();
  if (ws.wallet && /keystone/i.test(ws.wallet.name)) {
    await signIn();
  }
});

window.addEventListener('ski:wallet-disconnected', () => {
  disconnectSession();
  clearSharedSession();
  updateAppState({ splashSponsor: false });
});

window.addEventListener('ski:request-signin', async () => {
  const ok = await signIn();
  if (ok) {
    if (window.location.hostname === 'sui.ski') {
      window.location.reload();
    } else {
      window.open('https://sui.ski', '_blank');
    }
  }
});

// ─── Sign & Execute Transaction ──────────────────────────────────────
//
// Any window that imports sui.ski can request a transaction be signed and
// executed by dispatching 'ski:sign-and-execute-transaction' with a detail of:
//   { transaction: Transaction, requestId?: string }
//
// The result is dispatched back as 'ski:transaction-result' with:
//   { requestId, success: true,  digest, effects }  — on success
//   { requestId, success: false, error }             — on failure

window.addEventListener('ski:sign-and-execute-transaction', async (e) => {
  const { transaction, requestId } = (e as CustomEvent).detail ?? {};

  const dispatch = (result: Record<string, unknown>) =>
    window.dispatchEvent(new CustomEvent('ski:transaction-result', { detail: { requestId, ...result } }));

  if (!transaction) {
    dispatch({ success: false, error: 'No transaction provided' });
    return;
  }

  const ws = getState();
  if (ws.status !== 'connected') {
    dispatch({ success: false, error: 'No wallet connected' });
    return;
  }

  try {
    // Splash sponsorship: only for users with no SUI balance (can't pay their own gas)
    const userHasGas = getAppState().sui >= 0.01;
    const sponsorActive = isKeeperSponsorActive() || isSponsorActive();

    if (!userHasGas && sponsorActive && transaction instanceof Transaction) {
      showToast(`<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash`, true);
      const sponsorAddr = getSponsorState().auth?.address ?? '';
      const { connectToSponsor, requestKeeperSponsoredTransaction } = await import('./client/sponsor.js');
      connectToSponsor(sponsorAddr);
      const { digest } = await requestKeeperSponsoredTransaction({
        tx: transaction,
        senderAddress: ws.address,
        sponsorAddress: sponsorAddr,
        signTransaction: async (txBytes: Uint8Array) => signTransaction(txBytes),
        grpcClient,
      });
      dispatch({ success: true, digest });
      return;
    }

    // Standard path — user pays their own gas
    const { digest, effects } = await signAndExecuteTransaction(transaction);
    dispatch({ success: true, digest, effects });
  } catch (err) {
    dispatch({ success: false, error: err instanceof Error ? err.message : 'Transaction failed' });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────

// Lazy-load WaaP so its ~1.5 MB UI bundle splits into a separate chunk
import('./waap.js').then(({ registerWaaP }) => registerWaaP()).catch(() => {});
initUI();

// Handle ?splash= URL param for cross-device Splash sponsorship
(async () => {
  const splashParam = new URLSearchParams(location.search).get('splash');
  if (!splashParam) return;
  try {
    const { connectToSponsor } = await import('./client/sponsor.js');
    let sponsorAddr = splashParam;
    if (!splashParam.startsWith('0x')) {
      const resolved = await resolveNameToAddress(
        splashParam.endsWith('.sui') ? splashParam : `${splashParam}.sui`,
      );
      if (resolved) sponsorAddr = resolved;
    }
    connectToSponsor(sponsorAddr);
  } catch {}
})();

// Restore the sponsor wallet silently after extensions have had time to register.
// 3 s matches the autoReconnect timeout in wallet.ts.
setTimeout(() => {
  restoreSponsor(getSuiWallets()).then((ok) => {
    if (ok) {
      const { wallet, account } = getSponsorState();
      if (wallet && account) initSplashDO(wallet, account).catch(() => {});
      // Auto-cover every remembered address as a beneficiary
      enrollAllKnownAddresses();
    }
  }).catch(() => {});
}, 3000);
