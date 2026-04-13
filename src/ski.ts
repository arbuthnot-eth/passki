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
import { restoreSponsor, isSponsorActive, isKeeperSponsorActive, initSplashDO, getSponsorState, resolveNameToAddress } from './sponsor.js';
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

async function establishSession(address: string, signature: string, bytes: string, visitorId: string, message = '') {
  const sessionKey = buildSessionKey(visitorId, address);
  connectSession(sessionKey, (state) => {
    if (state.suinsName) updateAppState({ suinsName: state.suinsName });
    if (state.ikaWalletId) updateAppState({ ikaWalletId: state.ikaWalletId });
    if ((state as any).btcAddress) updateAppState({ btcAddress: (state as any).btcAddress });
  });

  try {
    // Pass the actual signed message so server can validate nonce + expiry
    const result = await authenticate({
      walletAddress: address,
      visitorId,
      confidence: 1,
      signature,
      message,
    });
    if (!result.success) {
      disconnectSession();
      return false;
    }
  } catch {
    // Agent might not be deployed yet — that's OK for local dev
  }

  // Check for existing Ika dWallets (non-blocking, fully silent)
  // DKG provisioning is triggered manually via the "Create dWallet" button in the UI
  loadIka().then(async ({ getCrossChainStatus }) => {
    try {
      const status = await getCrossChainStatus(address);
      if (status.ika) {
        updateAppState({ ikaWalletId: status.dwalletId, btcAddress: status.btcAddress, ethAddress: status.ethAddress, solAddress: status.solAddress });
        try { localStorage.setItem(`ski:ika-addrs:${address}`, JSON.stringify({ btc: status.btcAddress, eth: status.ethAddress, sol: status.solAddress })); } catch {}
      }
    } catch {}
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

    await establishSession(address, signature, bytes, visitorId, message);

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
export { setModalLayout, type ModalLayout, mountBalanceCycler, mountSkiButton, mountDotButton, mountProfile, openModal } from './ui.js';
export { getState, getSuiWallets, connect, disconnect, subscribe, signAndExecuteTransaction, signPersonalMessage, signTransaction } from './wallet.js';

// Register <ski-button>, <ski-dot>, <ski-balance> Custom Elements
import './elements.js';

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

  // Clear sensitive per-address storage — session tokens, cross-chain addresses, balances.
  // Prevents replay and data leakage on shared devices.
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const sensitivePatterns = ['ski:session:', 'ski:ika-addrs:', 'ski:balances:'];
    for (const k of keys) {
      if (sensitivePatterns.some(p => k.startsWith(p))) {
        localStorage.removeItem(k);
      }
    }
  } catch {}
});

window.addEventListener('ski:request-disconnect', () => {
  disconnect().catch(() => {});
});

window.addEventListener('ski:request-signin', async () => {
  await signIn();
});

// ─── SUIAMI from Superteam card ──────────────────────────────────────
window.addEventListener('ski:request-suiami', async (e) => {
  const cardNet = (e as CustomEvent).detail?.network;
  // Use SKI menu's network selection if available, fallback to card's network
  const skiNet = (() => { try { return localStorage.getItem('ski:network-pref'); } catch { return null; } })();
  const network = skiNet || cardNet || 'sui';
  let ws = getState();

  // Not connected — connect via WaaP directly
  if (!ws.address) {
    showToast('Key-in with WaaP...');
    try {
      const wallets = getSuiWallets();
      const waapWallet = wallets.find(w => /waap/i.test(w.name));
      if (!waapWallet) { showToast('WaaP not available'); return; }
      await connect(waapWallet, { skipSilent: true });
      // Wait for state to update
      await new Promise<void>((resolve) => {
        const onConnect = () => { window.removeEventListener('ski:wallet-connected', onConnect); resolve(); };
        window.addEventListener('ski:wallet-connected', onConnect);
        setTimeout(() => { window.removeEventListener('ski:wallet-connected', onConnect); resolve(); }, 30000);
      });
      ws = getState();
      if (!ws.address) { showToast('Connection cancelled'); return; }
    } catch (err) {
      showToast('WaaP connection failed');
      return;
    }
  }

  // Use the name from the event detail (from overlay/menu NS input), fallback to app state
  const detailName = ((e as CustomEvent).detail?.name || '').replace(/\.sui$/, '');
  const appName = getAppState().suinsName;
  const cachedName = (() => { try { return localStorage.getItem(`ski:suins:${ws.address}`); } catch { return null; } })();
  const name = detailName || (appName || cachedName || ws.suinsName || '').replace(/\.sui$/, '') || 'nobody';

  try {
    const { buildSuiamiMessage, createSuiamiProof } = await import('./suiami.js');

    // Look up SuiNS NFT ID and expiry for the primary name
    let nftId = '';
    let expiresInDays = 0;
    if (name !== 'nobody') {
      try {
        const SUINS_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';
        const rpcUrl = '/api/rpc';
        let cursor: string | null = null;
        for (let page = 0; page < 10 && !nftId; page++) {
          const res = await fetch(rpcUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getOwnedObjects', params: [ws.address, { filter: { StructType: SUINS_TYPE }, options: { showContent: true } }, cursor, 50] }),
          });
          const json = await res.json() as any;
          const items = json?.result?.data ?? [];
          for (const item of items) {
            const fields = item?.data?.content?.fields;
            if (fields?.domain_name === `${name}.sui`) {
              nftId = item.data.objectId;
              const expirationMs = parseInt(fields?.expiration_timestamp_ms || '0', 10);
              if (expirationMs) {
                expiresInDays = Math.max(0, Math.ceil((expirationMs - Date.now()) / 86400000));
              }
              break;
            }
          }
          if (!json?.result?.hasNextPage) break;
          cursor = json?.result?.nextCursor ?? null;
        }
      } catch { /* non-fatal */ }
    }

    // V2 unified message with all chain addresses
    const appState = getAppState();
    const message = buildSuiamiMessage(name, ws.address, nftId, {
      btc: appState.btcAddress || undefined,
      sol: appState.solAddress || undefined,
      eth: appState.ethAddress || undefined,
    });
    if (name === 'nobody') message.suiami = 'I am nobody';

    const msgBytes = new TextEncoder().encode(JSON.stringify(message, null, 2));
    const { bytes, signature } = await signPersonalMessage(msgBytes);
    const proof = createSuiamiProof(message, bytes, signature);

    // Verify server-side + update squids button
    try {
      const verifyRes = await fetch('/api/suiami/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: proof.token }),
      });
      const v = await verifyRes.json() as { valid?: boolean };
      if (v.valid) {
        showToast(`${name}.sui \u2014 SUIAMI verified \u2713`);
      } else {
        showToast(`${name}.sui \u2014 SUIAMI signed \u2713`);
      }
    } catch {
      showToast(`${name}.sui \u2014 SUIAMI signed \u2713`);
    }

    window.dispatchEvent(new CustomEvent('suiami:signed', {
      detail: { proof: proof.token, message: proof.message, signature: proof.signature, name, address: ws.address },
    }));

    // Write SUIAMI attestation on-chain (Roster v3). Always writes — even
    // if the user hasn't rumbled cross-chain addresses yet — so their
    // IdentityRecord (name + Sui address) exists on-chain. If cross-chain
    // addresses are present, they're uploaded to Walrus first and the blob
    // ID is included in the record.
    try {
      const { uploadRosterBlob } = await import('./client/roster.js');
      const { maybeAppendRoster } = await import('./suins.js');
      const appSt = getAppState();
      const blobData: Record<string, string> = {};
      if (appSt.btcAddress) blobData.btc = appSt.btcAddress;
      if (appSt.ethAddress) blobData.eth = appSt.ethAddress;
      if (appSt.solAddress) blobData.sol = appSt.solAddress;
      let blobId = '';
      if (Object.keys(blobData).length > 0) {
        try { blobId = await uploadRosterBlob(blobData); } catch (walErr) {
          console.warn('[suiami] Walrus blob upload failed, proceeding without cross-chain:', walErr);
        }
      }
      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();
      maybeAppendRoster(tx, ws.address, name, undefined, blobId);
      const { digest } = await signAndExecuteTransaction(tx);
      console.log('[suiami] roster attestation written:', digest);
      showToast(`\u2713 SUIAMI on-chain for ${name}.sui`);
    } catch (rosterErr) {
      const msg = rosterErr instanceof Error ? rosterErr.message : String(rosterErr);
      console.error('[suiami] roster write failed:', rosterErr);
      // Don't fail the whole SUIAMI flow — the off-chain proof is still
      // valid even if the on-chain attestation couldn't be written.
      if (!msg.toLowerCase().includes('reject') && !msg.toLowerCase().includes('cancel')) {
        showToast(`SUIAMI saved \u2014 on-chain attest failed: ${msg.slice(0, 80)}`);
      }
    }
  } catch (err) {
    console.error('[suiami] Error:', err);
    showToast(err instanceof Error ? err.message : 'SUIAMI signing failed');
  }
});

// ─── Rumble — all-chain DKG provisioning ─────────────────────────────
window.addEventListener('ski:rumble', async (e) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    showToast('Connect wallet first');
    return;
  }

  // targetRumble: if set, DWalletCap goes to this address instead of the connected wallet
  const targetRumble = (e as CustomEvent).detail?.targetRumble as string | undefined;

  // Check SuiNS name requirement before starting — fail fast, no DKG spam
  if (!app.suinsName) {
    showToast('Rumble failed \u2014 SuiNS name/subname required');
    window.dispatchEvent(new CustomEvent('ski:rumble-complete', { detail: { btcAddress: '', ethAddress: '', solAddress: '', error: 'SuiNS name required' } }));
    return;
  }

  const targetLabel = targetRumble ? ` \u2192 ${targetRumble.slice(0, 8)}\u2026` : '';
  showToast(`Rumble starting${targetLabel} \u2014 provisioning all chains...`);

  try {
    const { rumble } = await loadIka();
    const result = await rumble(
      ws.address,
      (txBytes: Uint8Array) => signAndExecuteTransaction(txBytes),
      (stage: string) => {
        // Only toast failures and key milestones — progress shows in idle overlay panel
        if (stage.includes('failed') || stage.includes('Failed')) showToast(`Rumble: ${stage}`);
        window.dispatchEvent(new CustomEvent('ski:rumble-progress', { detail: stage }));
      },
      targetRumble,
    );

    // Update app state with all derived addresses
    updateAppState({
      ikaWalletId: result.dwalletCaps[0] ?? '',
      btcAddress: result.btcAddress,
      ethAddress: result.ethAddress,
      solAddress: result.solAddress,
    });

    // Chain addresses stored in app state — queried from on-chain, no localStorage

    // Summary toast — show success or failure clearly
    const chains: string[] = [];
    if (result.btcAddress) chains.push('BTC');
    if (result.ethAddress) chains.push('ETH');
    if (result.solAddress) chains.push('SOL');
    if (chains.length > 0) {
      showToast(`Rumble complete \u2014 ${chains.join(' + ')} ready`);
    } else {
      showToast(`Rumble failed \u2014 no chains provisioned. ${result.error || 'SuiNS name may be required.'}`);
    }

    // Dispatch result for UI / Roster consumers
    window.dispatchEvent(new CustomEvent('ski:rumble-complete', { detail: result }));
  } catch (err) {
    console.error('[rumble] Error:', err);
    showToast(err instanceof Error ? err.message : 'Rumble failed');
  }
});

// ─── Admin: Rumble Ultron ─────────────────────────────────────────────
// Expose window.rumbleUltron('ed25519' | 'secp256k1' | 'both') so an
// admin can provision ultron's IKA dWallets from the devtools console
// without shipping visible UI. The connected wallet pays the IKA + SUI
// and signs the DKG tx; the resulting DWalletCap transfers to ultron.
//
// Note: this provisions the cap but does NOT do user-share re-encryption
// — ultron owns the cap but cannot yet sign autonomously without the
// browser that ran DKG. Autonomous signing is a follow-up.
const ULTRON_ADDRESS = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';
const _rumbleUltron = async (curves: 'ed25519' | 'secp256k1' | 'both' = 'ed25519') => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    showToast('Connect wallet first');
    return { error: 'not connected' };
  }
  const { rumble } = await loadIka();
  const { Curve } = await import('@ika.xyz/sdk');
  const curveSet = curves === 'both'
    ? [Curve.SECP256K1, Curve.ED25519]
    : curves === 'secp256k1'
      ? [Curve.SECP256K1]
      : [Curve.ED25519];

  // Fetch the deterministic encryption seed from the admin-gated server
  // endpoint. The seed is derived from SHADE_KEEPER_PRIVATE_KEY so a
  // keeper runtime can reconstruct the same encryption keys and sign
  // autonomously on ultron's behalf later — no seed storage needed.
  // Only one curve at a time for now (the endpoint + flow is per-curve).
  const primaryCurve = curves === 'secp256k1' ? 'secp256k1' : 'ed25519';
  console.log(`[rumble-ultron] fetching deterministic seed (${primaryCurve})…`);
  let encryptionSeed: Uint8Array | undefined;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const message = `rumble-ultron:${ULTRON_ADDRESS}:${today}`;
    const { signPersonalMessage } = await import('./wallet.js');
    const sig = await signPersonalMessage(new TextEncoder().encode(message));
    const seedRes = await fetch('/api/cache/rumble-ultron-seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        curve: primaryCurve,
        adminAddress: ws.address,
        signature: sig.signature,
        message,
      }),
    });
    const seedJson = await seedRes.json() as { seedHex?: string; error?: string };
    if (!seedRes.ok || !seedJson.seedHex) {
      throw new Error(seedJson.error || `HTTP ${seedRes.status}`);
    }
    encryptionSeed = new Uint8Array(seedJson.seedHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    console.log('[rumble-ultron] seed fetched, length:', encryptionSeed.length);
  } catch (err) {
    console.error('[rumble-ultron] seed fetch failed:', err);
    showToast(`Seed fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { error: err instanceof Error ? err.message : String(err) };
  }

  showToast(`Rumble Ultron \u2014 provisioning ${curves} \u2192 ${ULTRON_ADDRESS.slice(0, 10)}\u2026`);
  try {
    const result = await rumble(
      ws.address,
      (txBytes: Uint8Array) => signAndExecuteTransaction(txBytes),
      (stage: string) => console.log(`[rumble-ultron] ${stage}`),
      ULTRON_ADDRESS,
      { curves: curveSet, encryptionSeed },
    );
    console.log('[rumble-ultron] result:', result);
    const chains: string[] = [];
    if (result.btcAddress) chains.push('BTC');
    if (result.ethAddress) chains.push('ETH');
    if (result.solAddress) chains.push('SOL');
    if (chains.length) {
      showToast(`Ultron rumbled \u2014 ${chains.join(' + ')} cap \u2192 ultron`);
    } else {
      showToast(`Ultron rumble failed \u2014 ${result.error || 'check console'}`);
    }
    return result;
  } catch (err) {
    console.error('[rumble-ultron] error:', err);
    showToast(err instanceof Error ? err.message : 'Rumble Ultron failed');
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
// Expose on multiple globals so it's reachable from `rumbleUltron()`
// bare, `window.rumbleUltron()`, and `globalThis.rumbleUltron()`.
(window as unknown as { rumbleUltron: typeof _rumbleUltron }).rumbleUltron = _rumbleUltron;
(globalThis as unknown as { rumbleUltron: typeof _rumbleUltron }).rumbleUltron = _rumbleUltron;
console.log('[ski] rumbleUltron hook installed — call rumbleUltron("ed25519")');

// Sweep the OLD raw-keypair sol@ultron into a new IKA-derived recipient.
// Pass the recipient address explicitly (typically the new sol@ultron
// from window.rumbleUltron). Admin-gated via the same signed-message
// pattern as the seed endpoint.
const _sweepSolUltron = async (recipient: string) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    showToast('Connect wallet first');
    return { error: 'not connected' };
  }
  if (!recipient || recipient.length < 32) {
    return { error: 'pass the new sol@ultron address as recipient' };
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const message = `sweep-sol-ultron:${recipient}:${today}`;
    const { signPersonalMessage } = await import('./wallet.js');
    const sig = await signPersonalMessage(new TextEncoder().encode(message));
    console.log(`[sweep-sol-ultron] submitting sweep → ${recipient.slice(0, 8)}\u2026`);
    const res = await fetch('/api/cache/sweep-sol-ultron', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient,
        adminAddress: ws.address,
        signature: sig.signature,
        message,
      }),
    });
    const json = await res.json() as { error?: string; swept?: unknown[]; solSweep?: unknown; oldSolAddress?: string };
    if (!res.ok || json.error) {
      console.error('[sweep-sol-ultron] failed:', json);
      showToast(`Sweep failed: ${json.error || `HTTP ${res.status}`}`);
      return json;
    }
    console.log('[sweep-sol-ultron] result:', json);
    const splCount = json.swept?.length ?? 0;
    showToast(`Swept ${splCount} SPL + ${json.solSweep ? 'SOL' : 'no SOL'} \u2192 ${recipient.slice(0, 8)}\u2026`);
    return json;
  } catch (err) {
    console.error('[sweep-sol-ultron] error:', err);
    showToast(err instanceof Error ? err.message : 'Sweep failed');
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
(window as unknown as { sweepSolUltron: typeof _sweepSolUltron }).sweepSolUltron = _sweepSolUltron;
(globalThis as unknown as { sweepSolUltron: typeof _sweepSolUltron }).sweepSolUltron = _sweepSolUltron;
console.log('[ski] sweepSolUltron hook installed — call sweepSolUltron("<new-sol-address>")');

// Ultron writes its own SUIAMI Roster entry with all four IKA-native
// chain addresses. Admin-gated via signed personal message from an
// allowlisted Sui address; ultron signs the actual roster tx server-side
// with its own keypair, so no browser session needs to be online past
// the one admin signature.
const _ultronRoster = async () => {
  try {
    console.log('[ultron-roster] submitting (no-auth, self-referential)...');
    const res = await fetch('/api/cache/ultron-roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const json = await res.json() as {
      ok?: boolean; error?: string; digest?: string;
      ultronSuiAddr?: string;
      chains?: { sui: string; btc: string; eth: string; sol: string };
      debug?: Record<string, unknown>;
    };
    if (!res.ok || json.error) {
      console.error('[ultron-roster] failed:', json.error);
      if (json.debug) {
        console.error('[ultron-roster] debug:');
        for (const [k, v] of Object.entries(json.debug)) {
          console.error(`  ${k}:`, v);
        }
      }
      showToast(`Ultron roster failed: ${json.error || `HTTP ${res.status}`}`);
      return json;
    }
    console.log('[ultron-roster] result:', json);
    showToast(`Ultron roster written \u2014 ${json.digest?.slice(0, 8)}\u2026`);
    return json;
  } catch (err) {
    console.error('[ultron-roster] error:', err);
    showToast(err instanceof Error ? err.message : 'Ultron roster failed');
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
(window as unknown as { ultronRoster: typeof _ultronRoster }).ultronRoster = _ultronRoster;
(globalThis as unknown as { ultronRoster: typeof _ultronRoster }).ultronRoster = _ultronRoster;
console.log('[ski] ultronRoster hook installed — call ultronRoster()');

// Nuke every cached Seal session key + reset the circuit breaker so the
// next Thunder interaction prompts a fresh wallet sign. Use when the
// wallet backend starts rejecting mint sigs unexpectedly (possibly due
// to a stale Silk session or a poisoned localStorage entry written by a
// prior SDK version).
const _clearSealCache = () => {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ski:seal-sk:')) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    console.log(`[clearSealCache] purged ${stale.length} Seal session key entries`);
    // Force a page reload so module-level state (circuit breaker flags,
    // in-memory promise cache) also resets cleanly.
    console.log('[clearSealCache] reloading in 1s...');
    setTimeout(() => location.reload(), 1000);
    return { purged: stale.length };
  } catch (err) {
    console.error('[clearSealCache] error:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
(window as unknown as { clearSealCache: typeof _clearSealCache }).clearSealCache = _clearSealCache;
console.log('[ski] clearSealCache hook installed — call clearSealCache() to reset Seal key state');

// ─── Auto Pre-Rumble on name registration ──────────────────────────────
// When a new name is registered, fire pre-rumble in the background so the
// name immediately has chain addresses (ultron-custodial until user Rumbles).
window.addEventListener('ski:name-acquired', (e) => {
  const name = (e as CustomEvent).detail?.name;
  const ws = getState();
  if (!name || !ws.address) return;
  // Fire and forget — don't block the UI
  fetch('/api/cache/pre-rumble', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name.replace(/\.sui$/, ''), userAddress: ws.address }),
  }).then(r => r.json()).then((res: any) => {
    if (res.digest) console.log(`[pre-rumble] ${name} chain addresses provisioned: ${res.digest}`);
    else if (res.error) console.warn(`[pre-rumble] ${name}: ${res.error}`);
  }).catch(() => {});
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

initUI();

// Start WaaP loading immediately — don't wait for window.load.
// The preflight fetch inside registerWaaP is non-blocking and the SDK init
// is fast, so this shaves seconds off the time the modal shows stale state.
//
// zkLogin loads in parallel — it's a lightweight Wallet Standard provider
// that registers alongside WaaP, Backpack, etc.  Configure network based on
// hostname so devnet/testnet points at testnet GraphQL and mainnet at mainnet.
import('./zklogin.js').then(({ registerZkLogin, configureZkLogin }) => {
  try {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isDevnet =
      /dotski-devnet\.[a-z0-9-]+\.workers\.dev$/i.test(host) ||
      /^devnet\./i.test(host) ||
      host === 'localhost' ||
      host === '127.0.0.1';
    configureZkLogin(isDevnet
      ? { graphqlUrl: 'https://graphql.testnet.sui.io/graphql', network: 'testnet' }
      : { graphqlUrl: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });
  } catch { /* hostname unavailable */ }
  registerZkLogin();
}).catch((err) => {
  console.warn('[.SKI] zkLogin lazy-load failed:', err);
});
import('./waap.js').then(({ registerWaaP, purgeWaaPState, reinitWaaP }) => {
  registerWaaP();
  // Console helpers on window.ski:
  //   ski.resetWaaP()           — nuclear WaaP state purge + reinit
  //   ski.reinitWaaP()          — just re-register the iframe
  //   ski.rotateStorm(uuid)     — rotate Seal DEK for a storm (Alakazam Lv. 36)
  //   ski.kickFromStorm(uuid, members) — remove + rotate atomically
  //   ski.getKeyVersion(uuid)   — read the cached key version
  try {
    (window as any).ski = Object.assign((window as any).ski || {}, {
      resetWaaP: async () => {
        await purgeWaaPState();
        await registerWaaP();
        console.log('[.SKI] WaaP state purged and re-registered. Refresh the page to reconnect from scratch.');
      },
      reinitWaaP,
      rotateStorm: async (uuid: string) => {
        const { rotateStormKey } = await import('./client/thunder.js');
        const { signAndExecuteTransaction } = await import('./wallet.js');
        const r = await rotateStormKey({
          uuid,
          signAndExecute: async (tx) => signAndExecuteTransaction(tx as never),
        });
        console.log('[.SKI] storm rotated', uuid, r);
        return r;
      },
      kickFromStorm: async (uuid: string, members: string[]) => {
        const { removeMemberFromStorm } = await import('./client/thunder.js');
        const { signAndExecuteTransaction } = await import('./wallet.js');
        const r = await removeMemberFromStorm({
          uuid,
          members,
          signAndExecute: async (tx) => signAndExecuteTransaction(tx as never),
        });
        console.log('[.SKI] storm members removed + key rotated', uuid, r);
        return r;
      },
      getKeyVersion: async (uuid: string) => {
        const { getCachedKeyVersion } = await import('./client/thunder.js');
        return getCachedKeyVersion(uuid).toString();
      },
      /** Cache $X NS → cash the user's entire NS balance into iUSD
       *  delivered back to their own wallet via a single atomic PTB:
       *
       *    merge NS coins
       *    → DeepBook swap_exact_base_for_quote (NS → USDC)
       *    → DeepBook swap_exact_base_for_quote (USDC → iUSD)
       *    → transferObjects [iUSD, change coins] to sender
       *
       *  The user ends up with iUSD in their own wallet — NOT in
       *  ultron's cache. iUSD is the system's cross-chain stable,
       *  so from there it's redeemable via the existing Ignite
       *  path to any chain's gas token or USDC equivalent.
       *
       *  Gas: sponsored path for non-WaaP (ultron is gas payer via
       *  signTransaction + /api/sponsor-gas); drip-then-execute for
       *  WaaP (because signTransaction is broken there).
       */
      sweepNsToCache: async () => {
        const [{ Transaction }, { SuiGraphQLClient }, { normalizeSuiAddress }, wallet, sponsorInfo] = await Promise.all([
          import('@mysten/sui/transactions'),
          import('@mysten/sui/graphql'),
          import('@mysten/sui/utils'),
          import('./wallet.js'),
          fetch('/api/sponsor-info').then(r => r.json()).catch(() => null) as Promise<{ sponsorAddress?: string; gasCoins?: Array<{ objectId: string; version: string; digest: string }> } | null>,
        ]);
        const ultron = sponsorInfo?.sponsorAddress;
        const sponsorGasCoins = sponsorInfo?.gasCoins ?? [];
        if (!ultron) { console.error('[.SKI] sweepNsToCache: ultron address unavailable'); return null; }
        const addr = (wallet as any).getState?.()?.address;
        if (!addr) { console.error('[.SKI] sweepNsToCache: no wallet connected'); return null; }
        const walletName = (wallet as any).getState?.()?.walletName || '';
        const isWaaP = /waap/i.test(walletName);

        // Fetch user's NS coins via GraphQL.
        const NS_TYPE = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
        const gql = new SuiGraphQLClient({ url: 'https://graphql.mainnet.sui.io/graphql', network: 'mainnet' });
        const res = await fetch('https://graphql.mainnet.sui.io/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: `{
            address(address: "${addr}") {
              objects(filter: { type: "0x2::coin::Coin<${NS_TYPE}>" }, first: 50) {
                nodes { address version digest contents { json } }
              }
            }
          }` }),
        });
        const data = await res.json() as { data?: { address?: { objects?: { nodes?: Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }> } } } };
        const nodes = data?.data?.address?.objects?.nodes ?? [];
        const coins = nodes.filter(n => BigInt(n.contents?.json?.balance ?? '0') > 0n);
        if (coins.length === 0) { console.log('[.SKI] sweepNsToCache: no NS to sweep'); return { swept: 0, digest: null }; }
        const totalNs = coins.reduce((s, c) => s + BigInt(c.contents?.json?.balance ?? '0'), 0n);

        // DeepBook constants (mirror src/suins.ts).
        const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
        const DB_NS_USDC_POOL = '0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060';
        const DB_NS_USDC_POOL_INITIAL_SHARED_VERSION = 414947421;
        const DB_IUSD_USDC_POOL = '0x38df72f5d07607321d684ed98c9a6c411c0b8968e100a1cd90a996f912cd6ce1';
        const DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION = 832866334;
        const DB_DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
        const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
        const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';

        /** Build the cache PTB: NS → USDC → iUSD → sender. */
        const buildSweepTx = (opts: { gasOwner?: string; gasCoins?: Array<{ objectId: string; version: string; digest: string }> }) => {
          const tx = new Transaction();
          tx.setSender(normalizeSuiAddress(addr));
          if (opts.gasOwner && opts.gasCoins?.length) {
            tx.setGasOwner(normalizeSuiAddress(opts.gasOwner));
            tx.setGasPayment(opts.gasCoins.map(c => ({
              objectId: c.objectId, version: c.version, digest: c.digest,
            })));
          }
          // 1. Merge NS coins into one.
          const nsPrimary = tx.objectRef({ objectId: coins[0].address, version: coins[0].version, digest: coins[0].digest });
          if (coins.length > 1) {
            tx.mergeCoins(nsPrimary, coins.slice(1).map(c => tx.objectRef({ objectId: c.address, version: c.version, digest: c.digest })));
          }
          // 2. DeepBook swap NS → USDC.
          const [zeroDeep1] = tx.moveCall({
            target: '0x2::coin::zero',
            typeArguments: [DB_DEEP_TYPE],
          });
          const [usdcOut, nsChange, deepChange1] = tx.moveCall({
            target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
            typeArguments: [NS_TYPE, USDC_TYPE],
            arguments: [
              tx.sharedObjectRef({
                objectId: DB_NS_USDC_POOL,
                initialSharedVersion: DB_NS_USDC_POOL_INITIAL_SHARED_VERSION,
                mutable: true,
              }),
              nsPrimary,
              zeroDeep1,
              tx.pure.u64(0),          // min_quote_out — 0 = accept any
              tx.object('0x6'),         // clock
            ],
          });
          // 3. DeepBook swap USDC → iUSD (iUSD is base, USDC is quote).
          //    Use swap_exact_quote_for_base: spend all USDC for as
          //    much iUSD as we can get.
          const [zeroDeep2] = tx.moveCall({
            target: '0x2::coin::zero',
            typeArguments: [DB_DEEP_TYPE],
          });
          const [iusdOut, usdcChange, deepChange2] = tx.moveCall({
            target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
            typeArguments: [IUSD_TYPE, USDC_TYPE],
            arguments: [
              tx.sharedObjectRef({
                objectId: DB_IUSD_USDC_POOL,
                initialSharedVersion: DB_IUSD_USDC_POOL_INITIAL_SHARED_VERSION,
                mutable: true,
              }),
              usdcOut,
              zeroDeep2,
              tx.pure.u64(0),
              tx.object('0x6'),
            ],
          });
          // 4. Transfer everything back to the sender. iUSD is the
          //    win; the *change coins (NS/USDC/DEEP slivers) all
          //    return to the user too so no dust stays stuck in
          //    the PTB.
          tx.transferObjects(
            [iusdOut, nsChange, usdcChange, deepChange1, deepChange2],
            tx.pure.address(normalizeSuiAddress(addr)),
          );
          return tx;
        };

        // Path 1: dual-sig gasless sweep. User signs as sender, ultron
        // signs as gas owner via /api/sponsor-gas. No SUI needed in the
        // user's wallet. Only works on wallets where signTransaction is
        // NOT broken (every wallet except WaaP).
        if (!isWaaP && sponsorGasCoins.length > 0) {
          try {
            const tx = buildSweepTx({ gasOwner: ultron, gasCoins: sponsorGasCoins });
            const bytes = await tx.build({ client: gql as never });
            const userSig = await wallet.signTransaction(bytes);
            const b64 = btoa(String.fromCharCode(...bytes));
            const sigRes = await fetch('/api/sponsor-gas', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ txBytes: b64, senderAddress: addr }),
            });
            if (sigRes.ok) {
              const { sponsorSig } = await sigRes.json() as { sponsorSig: string };
              const { SuiGrpcClient } = await import('@mysten/sui/grpc');
              const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
              const exec = await (grpc as unknown as { core: { executeTransaction: (r: { transaction: Uint8Array; signatures: string[] }) => Promise<Record<string, unknown>> } }).core.executeTransaction({
                transaction: bytes,
                signatures: [userSig.signature, sponsorSig],
              });
              const digest = (exec as any)?.digest ?? (exec as any)?.Transaction?.digest ?? '';
              console.log(`[.SKI] swept ${Number(totalNs) / 1e6} NS → ultron gaslessly (${digest || 'no digest'})`);
              return { swept: Number(totalNs) / 1e6, digest };
            }
            console.warn('[.SKI] sponsored sweep rejected — falling back to drip path');
          } catch (err) {
            console.warn('[.SKI] sponsored sweep failed, falling back to drip path:', err instanceof Error ? err.message : err);
          }
        }

        // Path 2: drip fallback. Ultron sends 0.02 SUI to the user,
        // then we pass that specific coin as explicit gas payment on
        // the sweep tx so GraphQL's build path doesn't need to
        // auto-select gas (which hits the same insufficient-balance
        // error when the indexer hasn't caught up yet).
        //
        // Works on every wallet including WaaP (uses signAndExecute,
        // not signTransaction).
        try {
          const dripRes = await fetch('/api/fund-gas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address: addr }),
          });
          const dripJson = await dripRes.json().catch(() => ({})) as { skipped?: boolean; digest?: string; error?: string };
          if (dripRes.ok && dripJson.digest) {
            console.log('[.SKI] drip landed:', dripJson.digest);
          }
        } catch { /* best effort */ }

        // Poll for a SUI coin on the user's address, up to 10s.
        // The drip may already have landed from a prior call, or the
        // user may already hold some SUI — the poll covers all cases.
        let userSuiCoin: { objectId: string; version: string; digest: string } | null = null;
        const pollDeadline = Date.now() + 10_000;
        while (Date.now() < pollDeadline) {
          try {
            const r2 = await fetch('https://graphql.mainnet.sui.io/graphql', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: `{
                address(address: "${addr}") {
                  objects(filter: { type: "0x2::coin::Coin<0x2::sui::SUI>" }, first: 5) {
                    nodes { address version digest contents { json } }
                  }
                }
              }` }),
            });
            const j2 = await r2.json() as { data?: { address?: { objects?: { nodes?: Array<{ address: string; version: string; digest: string; contents?: { json?: { balance?: string } } }> } } } };
            const suiNodes = j2?.data?.address?.objects?.nodes ?? [];
            // Pick the largest SUI coin — usually the just-dripped one.
            let best: typeof suiNodes[number] | null = null;
            let bestBal = 0n;
            for (const n of suiNodes) {
              const bal = BigInt(n.contents?.json?.balance ?? '0');
              if (bal > bestBal) { bestBal = bal; best = n; }
            }
            if (best && bestBal >= 5_000_000n) { // need at least 0.005 SUI
              userSuiCoin = { objectId: best.address, version: best.version, digest: best.digest };
              break;
            }
          } catch { /* poll again */ }
          await new Promise(r => setTimeout(r, 800));
        }
        if (!userSuiCoin) {
          throw new Error('No SUI coin found after drip. /api/fund-gas may be on cooldown — try again in a few minutes, or top up the wallet with ~0.01 SUI.');
        }

        // Build with explicit gas payment pointing at the user's SUI
        // coin, so tx.build doesn't try to auto-select gas (which was
        // failing on the insufficient-balance error at the GraphQL
        // layer before the dripped coin was indexed).
        const tx = buildSweepTx({});
        tx.setGasPayment([userSuiCoin]);
        const bytes = await tx.build({ client: gql as never });
        const r = await wallet.signAndExecuteTransaction(bytes);
        const digest = (r as any)?.digest ?? '';
        console.log(`[.SKI] swept ${Number(totalNs) / 1e6} NS → ultron (${digest || 'no digest'})`);
        return { swept: Number(totalNs) / 1e6, digest };
      },
    });
  } catch {}
}).catch(() => {});

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

// Handle ?prism= URL param — Prism intent QR code
// Format: prism=usdc:10.006296 → send 10.006296 USDC to ultron, triggers quest fill
(async () => {
  const prismParam = new URLSearchParams(location.search).get('prism');
  if (!prismParam) return;
  // Store prism intent — the UI will pick it up when wallet connects
  try { sessionStorage.setItem('ski:prism-intent', prismParam); } catch {}
  // Clean URL
  const url = new URL(location.href);
  url.searchParams.delete('prism');
  history.replaceState(null, '', url.pathname + url.search);
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
