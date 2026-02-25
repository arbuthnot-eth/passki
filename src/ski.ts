/**
 * .SKI v2 — One-button wallet sign-in.
 *
 * Entry point. Boots the UI and orchestrates the sign-in flow:
 *   1. Connect wallet (Wallet Standard)
 *   2. Sign personal message (proof of ownership)
 *   3. Fingerprint device (FingerprintJS)
 *   4. POST to session agent (Cloudflare Durable Object)
 *   5. Resolve SuiNS name (future)
 *   6. Provision Ika dWallet (future)
 */

import { getState, signPersonalMessage } from './wallet.js';
import { initUI, showToast, updateAppState } from './ui.js';
import { getDeviceId, buildSessionKey } from './fingerprint.js';
import { connectSession, authenticate, disconnectSession } from './client/session.js';

// ─── Sign-in message builder ─────────────────────────────────────────

function buildSignMessage(address: string, domain: string): string {
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return [
    `${domain} wants you to .SKI`,
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
}

// ─── Sign-in flow ────────────────────────────────────────────────────

export async function signIn(): Promise<{
  address: string;
  message: string;
  signature: string;
  bytes: string;
  visitorId: string;
} | null> {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.account) {
    showToast('Connect wallet first');
    return null;
  }

  const address = ws.address;
  const message = buildSignMessage(address, window.location.host);
  const messageBytes = new TextEncoder().encode(message);

  try {
    // Run signing and fingerprinting in parallel
    const [signResult, deviceId] = await Promise.all([
      signPersonalMessage(messageBytes),
      getDeviceId(),
    ]);

    const { signature, bytes } = signResult;
    const { visitorId, confidence } = deviceId;

    // Connect to session agent and authenticate
    const sessionKey = buildSessionKey(visitorId, address);
    connectSession(sessionKey, (state) => {
      // Reactive state updates from the agent
      if (state.suinsName) {
        updateAppState({ suinsName: state.suinsName });
      }
      if (state.ikaWalletId) {
        updateAppState({ ikaWalletId: state.ikaWalletId });
      }
    });

    const result = await authenticate({
      walletAddress: address,
      visitorId,
      confidence,
      signature,
      message,
    });

    if (!result.success) {
      showToast(result.error || 'Authentication failed');
      disconnectSession();
      return null;
    }

    showToast('.SKI session active');
    console.log('[.SKI] Session established for', address, '| device:', visitorId.slice(0, 8));

    return { address, message, signature, bytes, visitorId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Signing failed';
    if (!msg.toLowerCase().includes('reject')) {
      showToast(msg);
    }
    return null;
  }
}

// ─── Forget device ───────────────────────────────────────────────────

export { forgetDevice, disconnectSession } from './client/session.js';

// ─── Auto sign-in on wallet connect ──────────────────────────────────

window.addEventListener('ski:wallet-connected', async (e) => {
  const detail = (e as CustomEvent).detail;
  if (!detail?.address) return;
  await signIn();
});

// Listen for disconnect to clean up session
window.addEventListener('ski:wallet-disconnected', () => {
  disconnectSession();
});

// ─── Boot ────────────────────────────────────────────────────────────

initUI();
