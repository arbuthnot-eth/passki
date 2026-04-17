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
    // addresses are present, they're Seal-encrypted (policy-gated on
    // `suiami::seal_roster::seal_approve_roster_reader`) and uploaded to
    // Walrus. The decrypt path requires the reader to be a SUIAMI
    // member themselves — mutual-membership model.
    //
    // Bronzong Lv.20 (#157) — Seal upload replaces the AES+localStorage
    // path shipped in Claydol (#156). The Seal-encrypted ciphertext
    // carries everything needed for threshold decrypt; nothing needs
    // to live in localStorage.
    try {
      const { encryptSquidsToWalrus } = await import('./client/suiami-seal.js');
      const { maybeAppendRoster } = await import('./suins.js');
      const appSt = getAppState();
      const blobData: Record<string, string> = {};
      if (appSt.btcAddress) blobData.btc = appSt.btcAddress;
      if (appSt.ethAddress) blobData.eth = appSt.ethAddress;
      if (appSt.solAddress) blobData.sol = appSt.solAddress;
      let blobId = '';
      let sealNonce: number[] = [];
      if (Object.keys(blobData).length > 0) {
        try {
          const { blobId: bId, sealId } = await encryptSquidsToWalrus(blobData, name);
          blobId = bId;
          sealNonce = Array.from(sealId);
        } catch (walErr) {
          console.warn('[suiami] Seal/Walrus upload failed, writing identity without cross-chain:', walErr);
        }
      }
      const { Transaction } = await import('@mysten/sui/transactions');
      const { normalizeSuiAddress } = await import('@mysten/sui/utils');
      const tx = new Transaction();
      tx.setSender(normalizeSuiAddress(ws.address));
      // Attach dwallet caps so the roster entry flips verified:true
      // when the user has already rumbled. If not, caps array is empty
      // and the entry stays unverified — same behavior as before.
      let dwalletCaps: string[] = [];
      try {
        const { getCrossChainStatus } = await loadIka();
        dwalletCaps = (await getCrossChainStatus(ws.address)).dwalletCaps ?? [];
      } catch {}
      maybeAppendRoster(tx, ws.address, name, undefined, blobId, sealNonce, dwalletCaps);
      // Piggyback CF edge enrichment (Porygon) — lazy, change-detected,
      // best-effort. Non-fatal on failure; never blocks SUIAMI write.
      try {
        const { maybeAttachCfHistoryToTx } = await import('./client/cf-history.js');
        await maybeAttachCfHistoryToTx(tx, ws.address);
      } catch {}
      // Pre-build to bytes so WaaP's v1 SDK doesn't crash reading
      // gasConfig.price (v2 uses gasData, v1 reads gasConfig).
      const rosterBytes = await tx.build({ client: grpcClient as never });
      const { digest } = await signAndExecuteTransaction(rosterBytes);
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

// ── Post-trade configure: browser-console repair tool ──
//
// If the trade follow-up configure ever fails (rejection, lag, any
// reason), the user still owns the new name but its target_address is
// still pointing wherever the seller last set it. Run this helper from
// the browser console: `configureNameRecords('great')` — it will find
// the SuinsRegistration NFT for great.sui in the connected wallet,
// pull the user's existing SUIAMI Roster squid config (if any), build
// the post-trade configure PTB, and sign it. One-shot, idempotent —
// calling it twice just re-writes the same records.
const _configureNameRecords = async (nameOrDomain: string) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    showToast('Connect wallet first');
    return { error: 'not connected' };
  }
  const bare = (nameOrDomain || '').replace(/\.sui$/i, '').toLowerCase();
  if (!bare) {
    console.error('[configureNameRecords] empty name');
    return { error: 'empty name' };
  }
  const fullDomain = `${bare}.sui`;
  try {
    const { buildPostTradeConfigureTx, fetchExistingSquidConfig, fetchOwnedDomains } = await import('./suins.js');
    const owned = await fetchOwnedDomains(ws.address);
    const match = owned.find(d => d.name === fullDomain && d.kind === 'nft');
    if (!match) {
      console.error(`[configureNameRecords] you don't own ${fullDomain}`);
      showToast(`${fullDomain} not in wallet`);
      return { error: 'not owned' };
    }
    showToast(`\u{1F527} Configuring ${fullDomain} records\u2026`);
    const existingCfg = await fetchExistingSquidConfig(ws.address);
    const cfgBytes = await buildPostTradeConfigureTx({
      sender: ws.address,
      nftId: match.objectId,
      domain: fullDomain,
      walrusBlobId: existingCfg?.walrusBlobId,
      sealNonce: existingCfg?.sealNonce,
      writeRoster: true,
    });
    const { digest } = await signAndExecuteTransaction(cfgBytes);
    const hasSquids = !!(existingCfg?.walrusBlobId);
    const summary = hasSquids
      ? `\u2713 ${fullDomain} records set \u2014 SUIAMI squids linked`
      : `\u2713 ${fullDomain} points at your wallet`;
    showToast(summary);
    console.log(`[configureNameRecords] ${fullDomain} configured — digest ${digest}`);
    return { ok: true, digest, domain: fullDomain, nftId: match.objectId, hasSquids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[configureNameRecords] failed:', err);
    if (!msg.toLowerCase().includes('reject') && !msg.toLowerCase().includes('cancel')) {
      showToast(`Configure failed: ${msg.slice(0, 100)}`);
    }
    return { error: msg };
  }
};
(window as unknown as { configureNameRecords: typeof _configureNameRecords }).configureNameRecords = _configureNameRecords;
(globalThis as unknown as { configureNameRecords: typeof _configureNameRecords }).configureNameRecords = _configureNameRecords;
console.log('[ski] configureNameRecords hook installed — call configureNameRecords("<bare-name>") to set target + SUIAMI roster for an owned name');

// ── Claydol Lv.10 Confusion — SUIAMI roster audit (#156) ──
//
// Browser-console diagnostic. Reads the connected wallet's current
// SUIAMI Roster entry via the address-keyed dynamic field, prints the
// full state with a clear "cross-chain resolvable: yes | NO" summary,
// and returns the structured record for programmatic use.
const _suiamiAudit = async () => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    console.error('[suiamiAudit] not connected');
    return { error: 'not connected' };
  }
  try {
    const { readRosterByAddress } = await import('./suins.js');
    const record = await readRosterByAddress(ws.address);
    if (!record) {
      console.log(`[suiamiAudit] no roster entry for ${ws.address}`);
      console.log('  → run upgradeSuiami() to write one');
      return { ok: false, reason: 'no-entry', address: ws.address };
    }
    const hasWalrus = !!record.walrus_blob_id;
    const hasNonce = !!(record.seal_nonce?.length);
    const hasKey = (() => {
      try { return !!localStorage.getItem(`ski:roster-key:${ws.address}`); }
      catch { return false; }
    })();
    const resolvable = hasWalrus && hasNonce;
    console.log(`[suiamiAudit] roster entry for ${ws.address}:`);
    console.log(`  name:                 ${record.name}`);
    console.log(`  sui_address:          ${record.sui_address}`);
    console.log(`  walrus_blob_id:       ${record.walrus_blob_id || '(empty — needs upgrade)'}`);
    console.log(`  seal_nonce:           ${record.seal_nonce?.length ?? 0} bytes`);
    console.log(`  chains on-chain:      ${Object.keys(record.chains).join(', ') || '(none)'}`);
    console.log(`  verified:             ${record.verified}`);
    console.log(`  dwallet_caps:         ${record.dwallet_caps.length}`);
    console.log(`  updated_ms:           ${record.updated_ms}`);
    console.log(`  local AES key:        ${hasKey ? 'present' : 'MISSING — decrypt unavailable'}`);
    console.log(`  cross-chain resolvable: ${resolvable ? 'yes' : 'NO — run upgradeSuiami()'}`);
    return { ok: true, record, resolvable, hasKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[suiamiAudit] query failed:', err);
    return { error: msg };
  }
};
(window as unknown as { suiamiAudit: typeof _suiamiAudit }).suiamiAudit = _suiamiAudit;
(globalThis as unknown as { suiamiAudit: typeof _suiamiAudit }).suiamiAudit = _suiamiAudit;
console.log('[ski] suiamiAudit hook installed — call suiamiAudit() to check current roster state');

// ── who(key) — SUIAMI reverse lookup by chain:address ──
//
// SUIAMI is the pronoun — `who` is the question. Given any chain-keyed
// address, return the Roster entry that owns it. Uses the
// `lookup_by_chain` dynamic field the contract maintains as a third
// index alongside name_hash and address.
//
// Accepts:
//   who("0xa84c…")       → bare 64-hex address
//   who("eth:0xd8…")     → Ethereum
//   who("btc:bc1q…")     → Bitcoin
//   who("sol:5Kz…")      → Solana
//
// Caveat: non-native chains are only reverse-resolvable when the owner
// opted to write the address plaintext on-chain. The default Roster
// write keeps BTC/ETH/SOL Seal-encrypted in the Walrus blob and does
// not index them here — a deliberate privacy choice. `who` will miss
// those entries and that's expected.
const _who = async (input: string) => {
  if (!input || typeof input !== 'string') {
    console.error('[who] usage: who("<chain>:<address>") or who("<bare-0x-address>")');
    return { error: 'bad-input' };
  }
  let key = input.trim();
  // Bare 0x-prefixed 64-hex address → auto-wrap
  if (!key.includes(':') && /^0x[0-9a-f]{64}$/i.test(key)) key = `sui:${key.toLowerCase()}`;
  if (!key.includes(':')) {
    console.error('[who] key must be "<chain>:<address>" (chain ∈ sui/eth/btc/sol/…)');
    return { error: 'bad-format' };
  }
  try {
    const { readRosterByChain } = await import('./suins.js');
    const record = await readRosterByChain(key);
    if (!record) {
      console.log(`[who] no SUIAMI entry for ${key}`);
      return { ok: false, key };
    }
    console.log(`[who] ${key} →`);
    console.log(`  name:            ${record.name}`);
    console.log(`  address:         ${record.sui_address}`);
    console.log(`  verified:        ${record.verified}`);
    console.log(`  dwallet_caps:    ${record.dwallet_caps.length}`);
    console.log(`  chains on-chain: ${Object.keys(record.chains).join(', ') || '(none)'}`);
    console.log(`  walrus_blob_id:  ${record.walrus_blob_id || '(none)'}`);
    return { ok: true, key, record };
  } catch (err) {
    console.error('[who] query failed:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
(window as unknown as { who: typeof _who }).who = _who;
(globalThis as unknown as { who: typeof _who }).who = _who;
console.log('[ski] who hook installed — call who("<chain>:<address>") or who("<bare-0x-addr>") for reverse roster lookup');

// ── cfHistory() — Porygon CF-edge timeline ──
//
// Reads the caller's cf_history Walrus blob IDs off-chain (via GraphQL
// on the Roster shared object's dynamic_field), decrypts each chunk
// via Seal, prints a sparse timeline. Prompts for a SessionKey the
// first call in a 30-min window.
const _cfHistory = async () => {
  try {
    const ws = getState();
    if (ws.status !== 'connected' || !ws.address) {
      console.error('[cfHistory] no wallet connected');
      return;
    }
    const addr = ws.address.toLowerCase();
    const raw = new Uint8Array(32);
    const hex = addr.replace(/^0x/, '').padStart(64, '0');
    for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const addrB64 = btoa(String.fromCharCode(...raw));
    const { SUIAMI_PKG, ROSTER_OBJ } = await import('./client/suiami-seal.js');
    const { GQL_URL } = await import('./rpc.js');

    // Try both possible type paths for CfHistoryKey — Sui type tags
    // for structs added in an upgrade can be qualified by either the
    // original or the upgraded package ID depending on indexer.
    const typePaths = [
      `${SUIAMI_PKG}::roster::CfHistoryKey`,
      `0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa::roster::CfHistoryKey`,
    ];
    let json: { blobs?: string[]; updated_ms?: string } | null = null;
    for (const t of typePaths) {
      try {
        const res = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `{ object(address: "${ROSTER_OBJ}") { dynamicField(name: { type: "${t}", bcs: "${addrB64}" }) { value { ... on MoveValue { json } } } } }`,
          }),
        });
        const gql = await res.json() as { data?: { object?: { dynamicField?: { value?: { json?: unknown } } } } };
        const candidate = gql?.data?.object?.dynamicField?.value?.json as { blobs?: string[]; updated_ms?: string } | undefined;
        if (candidate?.blobs) { json = candidate; break; }
      } catch {}
    }
    const blobIds = json?.blobs ?? [];
    if (blobIds.length === 0) {
      console.log('[cfHistory] empty — no CF chunks written yet');
      return;
    }
    console.log(`[cfHistory] ${blobIds.length} chunk(s) on-chain, decrypting\u2026`);

    const { readCfHistory } = await import('./client/cf-history.js');
    const { signPersonalMessage } = await import('./wallet.js');
    const chunks = await readCfHistory({
      ownerAddress: ws.address,
      blobIds,
      signPersonalMessage,
    });
    if (chunks.length === 0) {
      console.log('[cfHistory] all decrypts failed — Seal key servers or session-key issue');
      return;
    }
    // Sort by attestedAt ascending
    chunks.sort((a, b) => (a.data.attestedAt ?? 0) - (b.data.attestedAt ?? 0));
    for (const c of chunks) {
      const d = c.data;
      const ts = new Date(d.attestedAt).toISOString();
      console.log(`[cfHistory] ${ts}  ${d.country}/${d.colo}  ASN${d.asn}  ${d.tlsVersion}  ${d.httpProtocol}${d.verifiedBot ? '  [bot]' : ''}  threat=${d.threatScore}`);
    }
    return chunks;
  } catch (err) {
    console.error('[cfHistory] failed:', err);
  }
};
(window as unknown as { cfHistory: typeof _cfHistory }).cfHistory = _cfHistory;
(globalThis as unknown as { cfHistory: typeof _cfHistory }).cfHistory = _cfHistory;
console.log('[ski] cfHistory hook installed — call cfHistory() to decrypt your CF-edge timeline');

// ── sendPrism() — rich cross-chain Thunder via Prism manifest ──
//
// Usage:
//   sendPrism("alice.sui", {
//     targetChain: "solana",
//     recipient: "5Kz...", amount: "1000000", mint: "EPjFWdd5...USDC",
//     note: "USDC on Solana — claim via your IKA dWallet"
//   }, "hey alice, heads up — prism inbound")
const _sendPrism = async (
  recipientNameOrAddr: string,
  spec: {
    targetChain: 'solana' | 'ethereum' | 'bitcoin' | 'sui';
    recipient: string;
    amount: string;
    mint?: string;
    dwalletCapRef?: string;
    note?: string;
  },
  textBody = '',
  payload?: Uint8Array,
) => {
  try {
    const ws = getState();
    if (ws.status !== 'connected' || !ws.address) {
      console.error('[prism] no wallet connected');
      return;
    }
    const { sendThunder, lookupRecipientAddress, makeThunderGroupId } = await import('./client/thunder.js');
    const { buildPrismAttachments } = await import('./client/prism.js');
    const { signPersonalMessage } = await import('./wallet.js');
    const recipientAddress = recipientNameOrAddr.startsWith('0x')
      ? recipientNameOrAddr
      : (await lookupRecipientAddress(recipientNameOrAddr));
    if (!recipientAddress) {
      console.error('[prism] could not resolve recipient', recipientNameOrAddr);
      return;
    }
    const stormId = makeThunderGroupId(ws.address, recipientAddress);
    const files = await buildPrismAttachments(
      { ...spec, stormId, senderAddress: ws.address },
      payload,
      signPersonalMessage,
    );
    console.log('[prism] sending', { recipient: recipientAddress, manifest: JSON.parse(new TextDecoder().decode(files[0].data)) });
    const res = await sendThunder({
      senderAddress: ws.address,
      recipientAddress,
      text: textBody,
      files,
    } as never);
    console.log('[prism] sent:', res);
    return res;
  } catch (err) {
    console.error('[prism] send failed:', err);
  }
};
(window as unknown as { sendPrism: typeof _sendPrism }).sendPrism = _sendPrism;
(globalThis as unknown as { sendPrism: typeof _sendPrism }).sendPrism = _sendPrism;
console.log('[ski] sendPrism hook installed — sendPrism("alice.sui", { targetChain, recipient, amount, mint? }, textBody?, payload?)');

// ── Bronzong — Seal-gated SUIAMI upgrade (#157) ──
//
// Retroactive SUIAMI upgrade using Seal threshold encryption instead
// of plain AES. Bound to the on-chain access policy
// `suiami::seal_roster::seal_approve_roster_reader`, which enforces:
//
//   (1) caller has their own SUIAMI Roster entry
//   (2) caller's entry has a non-empty walrus_blob_id
//
// Mutual-membership model: to read anyone else's squids, you must
// have written your own. No key distribution ceremony, no keyring,
// no AES key in localStorage — Seal key servers hold decrypt shares
// under the policy, and the client just asks them.
//
// Sequence:
//   1. Pull btc/eth/sol from app state (rumbled squids).
//   2. `encryptSquidsToWalrus(squids, primaryBare)` — Seal encrypt
//      scoped to the suiami package, upload the encryptedObject
//      ciphertext to Walrus, return blobId + 40-byte seal identity.
//   3. Derive the same blob for any additional names (or reuse the
//      primary's blob — all of the user's owned names reference the
//      same encrypted payload since the content is identical per
//      identity).
//   4. Build one PTB via buildFullSuiamiWriteTx that chains
//      setTargetAddress(nft, sender) + set_identity for each name.
//      seal_nonce field stores the seal identity bytes so readers
//      can reconstruct them without round-tripping the Walrus blob.
//   5. Sign and execute.
//
// Idempotent: calling twice re-uploads and re-writes. Walrus dedupes
// identical ciphertexts so the second upload is a no-op.
const _upgradeSuiami = async (extraNames: string[] = []) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    showToast('Connect wallet first');
    return { error: 'not connected' };
  }
  try {
    const appSt = getAppState();
    const squids: Record<string, string> = {};
    if (appSt.btcAddress) squids.btc = appSt.btcAddress;
    if (appSt.ethAddress) squids.eth = appSt.ethAddress;
    if (appSt.solAddress) squids.sol = appSt.solAddress;
    if (Object.keys(squids).length === 0) {
      console.error('[upgradeSuiami] no squids in app state — run rumbleUltron() or finish DKG first');
      showToast('No squids to upgrade \u2014 rumble first');
      return { error: 'no-squids' };
    }

    const primaryBare = (appSt.suinsName || '').replace(/\.sui$/, '').toLowerCase();
    const nameSet = new Set<string>();
    if (primaryBare) nameSet.add(primaryBare);
    for (const n of extraNames) {
      const bare = (n || '').replace(/\.sui$/i, '').toLowerCase();
      if (bare) nameSet.add(bare);
    }
    const names = [...nameSet];
    if (names.length === 0) {
      console.error('[upgradeSuiami] no names to write — wallet has no primary and no extras provided');
      return { error: 'no-names' };
    }

    showToast('\u{1F300} Seal-encrypting squids to Walrus\u2026');
    const { encryptSquidsToWalrus } = await import('./client/suiami-seal.js');
    // Anchor the Seal identity to the primary name. All owned names
    // get their roster entries linked to the same blob; the 40-byte
    // seal id written on-chain is primary-scoped so `decryptSquidsForName`
    // can reconstruct it deterministically without an extra lookup.
    const anchorName = primaryBare || names[0];
    const { blobId, sealId } = await encryptSquidsToWalrus(squids, anchorName);
    console.log(`[upgradeSuiami] walrus blob: ${blobId}`);
    console.log(`[upgradeSuiami] seal id (40B): ${Array.from(sealId).map(b => b.toString(16).padStart(2, '0')).join('')}`);

    const { fetchOwnedDomains, buildFullSuiamiWriteTx } = await import('./suins.js');
    const owned = await fetchOwnedDomains(ws.address);
    const entries = names.map(bare => {
      const full = `${bare}.sui`;
      const match = owned.find(d => d.name === full && d.kind === 'nft');
      return { domain: full, nftId: match?.objectId };
    });
    const missingNftIds = entries.filter(e => !e.nftId).map(e => e.domain);
    if (missingNftIds.length > 0) {
      console.warn(`[upgradeSuiami] no NFT id found for: ${missingNftIds.join(', ')} — writing roster entries without setTargetAddress`);
    }

    // Gather DWalletCap object IDs so Roster's `verified` flips to true
    // on-chain for this batch of names. Non-fatal if the wallet hasn't
    // rumbled yet — caps array is just empty and verified stays false.
    let dwalletCaps: string[] = [];
    try {
      const { getCrossChainStatus } = await loadIka();
      const ccs = await getCrossChainStatus(ws.address);
      dwalletCaps = ccs.dwalletCaps ?? [];
      if (dwalletCaps.length) {
        console.log(`[upgradeSuiami] attaching ${dwalletCaps.length} dwallet cap(s) — roster will mark verified:true`);
      }
    } catch (ccsErr) {
      console.warn('[upgradeSuiami] getCrossChainStatus failed, writing unverified entries:', ccsErr);
    }

    showToast(`\u{1F300} Writing SUIAMI for ${names.length} name${names.length > 1 ? 's' : ''}\u2026`);
    const bytes = await buildFullSuiamiWriteTx({
      sender: ws.address,
      entries,
      walrusBlobId: blobId,
      // seal_nonce field now carries the 40-byte Seal identity that
      // decrypt callers need. Field name kept for Move ABI stability
      // but semantically it's a Seal id, not an AES IV.
      sealNonce: Array.from(sealId),
      setTargetForNfts: true,
      dwalletCaps,
    });
    const { digest } = await signAndExecuteTransaction(bytes);
    const summary = `\u2713 SUIAMI upgraded \u2014 ${names.length} name${names.length > 1 ? 's' : ''} Seal-gated on the roster policy`;
    showToast(summary);
    console.log(`[upgradeSuiami] digest: ${digest}`);
    console.log(`[upgradeSuiami] names: ${names.join(', ')}`);
    console.log(`[upgradeSuiami] anchor: ${anchorName}`);
    console.log(`[upgradeSuiami] run suiamiAudit() to verify, or fetchSquidsForName("<name>") to test decrypt`);
    return { ok: true, digest, names, walrusBlobId: blobId, anchorName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upgradeSuiami] failed:', err);
    if (!msg.toLowerCase().includes('reject') && !msg.toLowerCase().includes('cancel')) {
      showToast(`Upgrade failed: ${msg.slice(0, 100)}`);
    }
    return { error: msg };
  }
};
(window as unknown as { upgradeSuiami: typeof _upgradeSuiami }).upgradeSuiami = _upgradeSuiami;
(globalThis as unknown as { upgradeSuiami: typeof _upgradeSuiami }).upgradeSuiami = _upgradeSuiami;
console.log('[ski] upgradeSuiami hook installed — call upgradeSuiami(["great"]) to Seal-encrypt squids + write primary + extras roster entries');

// ── Bronzong Lv.30 Gyro Ball — cross-SUIAMI decrypt (#157) ──
//
// Fetch and decrypt the cross-chain squid addresses for any name in
// the SUIAMI Roster. Requires the CALLER to be a SUIAMI member with
// their own encrypted roster entry (enforced by the on-chain
// `seal_approve_roster_reader` policy during Seal's fetchKeys call).
//
// Prompts for one Seal SessionKey personal-message signature on the
// first call per 30-minute window. Cached across hard refreshes in
// localStorage.ski:suiami-seal-sk:v1:<addr>.
const _fetchSquidsForName = async (nameOrDomain: string) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    console.error('[fetchSquids] not connected');
    return { error: 'not connected' };
  }
  const bare = (nameOrDomain || '').replace(/\.sui$/i, '').toLowerCase();
  if (!bare) {
    console.error('[fetchSquids] empty name');
    return { error: 'empty-name' };
  }
  try {
    const { readRoster } = await import('./suins.js');
    const rosterChains = await readRoster(`${bare}.sui`);
    if (!rosterChains) {
      console.error(`[fetchSquids] ${bare}.sui has no SUIAMI roster entry`);
      showToast(`${bare}.sui \u2014 not in SUIAMI roster`);
      return { error: 'not-in-roster' };
    }
    // readRoster's simple shape doesn't return walrus_blob_id. Use
    // the richer byName GraphQL query for the blob metadata.
    const { keccak_256 } = await import('@noble/hashes/sha3.js');
    const nh = keccak_256(new TextEncoder().encode(bare));
    const nhB64 = btoa(String.fromCharCode(...nh));
    const gqlRes = await fetch('https://graphql.mainnet.sui.io/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ object(address: "0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d") { dynamicField(name: { type: "vector<u8>", bcs: "${nhB64}" }) { value { ... on MoveValue { json } } } } }`,
      }),
    });
    const gqlJson = await gqlRes.json() as any;
    const record = gqlJson?.data?.object?.dynamicField?.value?.json;
    let walrusBlobId: string = record?.walrus_blob_id ?? '';
    // Dual-key drift fallback: some roster entries wrote the blob only
    // to the address-keyed dynamic field, not the name-keyed one. If the
    // name lookup comes back empty, pivot to the connected address's
    // entry — the Seal identity is name-scoped so decrypt still works
    // as long as the caller owns the name (policy unchanged).
    if (!walrusBlobId) {
      try {
        const { readRosterByAddress } = await import('./suins.js');
        const byAddr = await readRosterByAddress(ws.address);
        if (byAddr?.walrus_blob_id && byAddr.name === bare) {
          walrusBlobId = byAddr.walrus_blob_id;
          console.log(`[fetchSquids] fell back to address-keyed blob: ${walrusBlobId}`);
        }
      } catch (fallbackErr) {
        console.warn('[fetchSquids] address-keyed fallback failed:', fallbackErr);
      }
    }
    if (!walrusBlobId) {
      console.error(`[fetchSquids] ${bare}.sui has no walrus_blob_id on-chain`);
      showToast(`${bare}.sui \u2014 no encrypted squids on-chain`);
      return { error: 'no-blob' };
    }
    showToast(`\u{1F513} Decrypting ${bare}.sui squids\u2026`);
    const { decryptSquidsForName } = await import('./client/suiami-seal.js');
    const squids = await decryptSquidsForName({
      name: bare,
      blobId: walrusBlobId,
      address: ws.address,
      signPersonalMessage: async (msg: Uint8Array) => {
        const { signPersonalMessage } = await import('./wallet.js');
        return await signPersonalMessage(msg);
      },
    });
    console.log(`[fetchSquids] ${bare}.sui decrypted:`, squids);
    showToast(`\u2713 ${bare}.sui squids: ${Object.keys(squids).join(', ')}`);
    return { ok: true, name: bare, squids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[fetchSquids] failed:', err);
    if (/NoAccess|NotRegistered|NoEncryptedData/i.test(msg)) {
      showToast(`${bare}.sui \u2014 decrypt denied (caller needs own SUIAMI)`);
    } else if (!msg.toLowerCase().includes('reject')) {
      showToast(`Decrypt failed: ${msg.slice(0, 100)}`);
    }
    return { error: msg };
  }
};
(window as unknown as { fetchSquidsForName: typeof _fetchSquidsForName }).fetchSquidsForName = _fetchSquidsForName;
(globalThis as unknown as { fetchSquidsForName: typeof _fetchSquidsForName }).fetchSquidsForName = _fetchSquidsForName;
console.log('[ski] fetchSquidsForName hook installed — call fetchSquidsForName("<name>") to decrypt cross-chain squids for any SUIAMI-registered name (requires own SUIAMI entry)');

// ── Beldum Take Down — ENS subname bind (#167) ──
//
// Bind `<label>.waap.eth` to the connected wallet's existing SUIAMI
// record. Writes an `ens_hash`-keyed dynamic field pointing at the
// same IdentityRecord the Sui side already knows about, so ENS-side
// resolvers (CCIP-read gateway, coming in Iron Defense) can serve
// the same chain addresses for either handle.
//
// v1 trust model: the caller already holds the SUIAMI record, so the
// Sui-wallet signature IS the ownership proof for the bind call.
// Metal Claw will add an ecdsa_k1_ecrecover check over a canonical
// EIP-191 bind message signed by the user's IKA-derived ETH key —
// harmless to land the write path first since only the record owner
// can invoke.
const _ensIssue = async (label: string) => {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) {
    console.error('[ensIssue] not connected'); return { error: 'not connected' };
  }
  const bare = (label || '').replace(/\.waap\.eth$/i, '').toLowerCase().trim();
  if (!bare || /[^a-z0-9-]/.test(bare)) {
    console.error('[ensIssue] invalid label; use a-z, 0-9, hyphens only'); return { error: 'bad-label' };
  }
  const ensName = `${bare}.waap.eth`;
  try {
    const { Transaction } = await import('@mysten/sui/transactions');
    const { keccak_256 } = await import('@noble/hashes/sha3.js');
    const { SUIAMI_PKG_LATEST, ROSTER_OBJ } = await import('./client/suiami-seal.js');
    const { signAndExecuteTransaction } = await import('./wallet.js');
    const { normalizeSuiAddress } = await import('@mysten/sui/utils');

    const ensHash = Array.from(keccak_256(new TextEncoder().encode(ensName)));

    // Pre-flight: reject if ens_hash is already bound (v5 on-chain
    // check would abort anyway with EEnsNameTaken; checking client-
    // side gives a clearer error before the user spends gas).
    const gqlQ = `{ object(address:"${ROSTER_OBJ}"){ dynamicField(name:{ type:"0x2c1d63b3b314f9b6e96c33e9a3bca4faaa79a69a5729e5d2e8ac09d70e1052fa::roster::EnsHashKey", bcs:"${btoa(String.fromCharCode(32, ...ensHash))}" }){ value{ ...on MoveValue{ json } } } } }`;
    const pre = await fetch('https://graphql.mainnet.sui.io/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: gqlQ }),
    }).then(r => r.json()).catch(() => null) as any;
    const taken = pre?.data?.object?.dynamicField?.value?.json;
    if (taken) {
      const owner = taken.sui_address ?? 'unknown';
      const err = `${ensName} already bound to ${owner} — owner must revoke_ens_identity first`;
      console.error('[ensIssue]', err);
      showToast(err);
      return { error: 'taken', owner };
    }

    const tx = new Transaction();
    tx.setSender(normalizeSuiAddress(ws.address));
    tx.moveCall({
      target: `${SUIAMI_PKG_LATEST}::roster::set_ens_identity`,
      arguments: [
        tx.object(ROSTER_OBJ),
        tx.pure.string(ensName),
        tx.pure.vector('u8', ensHash),
        // Placeholder ETH owner sig (v1 doesn't verify; Metal Claw will).
        tx.pure.vector('u8', []),
        tx.object('0x6'), // Clock
      ],
    });

    showToast(`\u26a1 Binding ${ensName} to SUIAMI\u2026`);
    const { digest } = await signAndExecuteTransaction(tx);
    console.log(`[ensIssue] bound ${ensName} — digest: ${digest}`);
    showToast(`\u2713 ${ensName} bound to SUIAMI`);
    return { ok: true, ensName, digest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ensIssue] failed:', err);
    if (!msg.toLowerCase().includes('reject')) showToast(`ENS bind failed: ${msg.slice(0, 100)}`);
    return { error: msg };
  }
};
(window as unknown as { ensIssue: typeof _ensIssue }).ensIssue = _ensIssue;
(globalThis as unknown as { ensIssue: typeof _ensIssue }).ensIssue = _ensIssue;
console.log('[ski] ensIssue hook installed — call ensIssue("alice") to bind alice.waap.eth to your SUIAMI record (Beldum #167)');

// ── Beldum Metal Claw prep — Phantom key → IKA dWallet parse/derive ──
//
// Accepts either a BIP-39 mnemonic (12/24 words) or a 32-byte hex
// private key, derives the secp256k1 public key + ETH address
// client-side via viem, and returns what's needed to feed into the
// IKA imported-key DKG flow. The private key never leaves the
// browser; the mnemonic is zero'd from memory after derivation.
//
// For mnemonics, default derivation path is Ethereum's
// `m/44'/60'/0'/0/0` (matches Phantom, MetaMask, Rainbow, Trust).
// Callers can pass a different path or index to hunt for the
// account that matches a specific ETH address.
//
// NOTE: this is the parse/verify step only. The actual IKA
// `requestImportedKeyDWalletVerification` ceremony hooks a separate
// (coming) entry in `src/client/ika.ts::importSecp256k1DWallet` —
// which calls `prepareImportedKeyDWalletVerification(ikaClient,
// Curve.SECP256K1, bytesToHash, senderAddress, userShareKeys,
// privateKey)` then builds the PTB. Landing parse first so you can
// validate that brando's seed derives to 0x9e825c8DB5758A7B888d281b83e28792233A3314
// before committing to the full MPC import.
const _importPhantomKey = async (
  input: string,
  opts?: { path?: string; index?: number; expectAddress?: string },
) => {
  if (!input || typeof input !== 'string') {
    console.error('[importPhantomKey] expected mnemonic or hex priv key as first arg');
    return { error: 'no-input' };
  }
  const trimmed = input.trim();
  try {
    const { privateKeyToAccount, mnemonicToAccount } = await import('viem/accounts');
    let priv: `0x${string}`;
    let address: `0x${string}`;
    let mode: 'mnemonic' | 'hex';

    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      mode = 'hex';
      priv = trimmed as `0x${string}`;
      address = privateKeyToAccount(priv).address;
    } else if (trimmed.split(/\s+/).length >= 12) {
      mode = 'mnemonic';
      const words = trimmed.split(/\s+/).length;
      if (words !== 12 && words !== 15 && words !== 18 && words !== 21 && words !== 24) {
        console.error(`[importPhantomKey] mnemonic must be 12/15/18/21/24 words, got ${words}`);
        return { error: 'bad-word-count' };
      }
      const index = opts?.index ?? 0;
      const path = opts?.path ?? `m/44'/60'/0'/0/${index}`;
      const acct = mnemonicToAccount(trimmed, { path: path as `m/${string}` });
      address = acct.address;
      // viem 2.x: account.getHdKey().privateKey gives the raw 32 bytes.
      const hd = (acct as any).getHdKey?.();
      if (!hd?.privateKey) {
        console.error('[importPhantomKey] could not extract private key from derived account');
        return { error: 'derivation-failed' };
      }
      priv = ('0x' + Array.from(hd.privateKey as Uint8Array)
        .map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
    } else {
      console.error('[importPhantomKey] input must be a BIP-39 mnemonic (12+ words) or a 0x-prefixed 32-byte hex private key');
      return { error: 'bad-input' };
    }

    console.log(`[importPhantomKey] mode=${mode}, derived address: ${address}`);
    if (opts?.expectAddress) {
      const expected = opts.expectAddress.toLowerCase();
      const actual = address.toLowerCase();
      if (expected !== actual) {
        console.error(`[importPhantomKey] ADDRESS MISMATCH — expected ${expected}, got ${actual}`);
        console.error('  For mnemonics, try a different index: importPhantomKey("<phrase>", { index: 1 })');
        // Zero the priv bytes before returning.
        (priv as unknown) = undefined;
        return { error: 'address-mismatch', expected, derived: address };
      }
      console.log(`[importPhantomKey] \u2713 matches expected address ${expected}`);
    }

    // TODO Beldum Metal Claw: wire to ika.ts
    //   const { importSecp256k1DWallet } = await import('./client/ika.js');
    //   const result = await importSecp256k1DWallet({
    //     privateKeyHex: priv,
    //     bytesToHash: new TextEncoder().encode(`SUIAMI import ${address} @ ${Date.now()}`),
    //   });
    //   Then assert result.ethAddress === address, write dwalletCap to roster.
    console.log('[importPhantomKey] IKA ceremony not yet wired — parse/derive verified only.');
    console.log(`  Ready to import: address=${address}, mode=${mode}`);
    console.log('  Next: confirm above, then run the ika.ts import flow (commit pending).');

    return { ok: true, mode, address, priv: '0x<redacted>' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[importPhantomKey] failed:', err);
    return { error: msg };
  }
};
(window as unknown as { importPhantomKey: typeof _importPhantomKey }).importPhantomKey = _importPhantomKey;
(globalThis as unknown as { importPhantomKey: typeof _importPhantomKey }).importPhantomKey = _importPhantomKey;
console.log('[ski] importPhantomKey hook installed — call importPhantomKey("<mnemonic|0xhex>", { expectAddress:"0x9e82..." }) to verify your waap.eth seed before the IKA import ceremony (Beldum Metal Claw, #167)');

// ── Beldum Relocate — transfer waap.eth to a SUIAMI-verified IKA dWallet ──
//
// Two-tx flow, both prompted through Phantom's ETH provider
// (`window.ethereum`). Reads the current ENS registry owner, prompts
// Phantom to connect, confirms the connected account == expected
// waap.eth owner, then fires:
//
//   tx1: value transfer — funds the IKA dWallet with ~0.002 ETH
//         for subsequent deploy + setResolver gas.
//   tx2: ENS.setOwner(namehash('waap.eth'), dwalletAddr) — transfers
//         the ENS registry ownership to the IKA dWallet.
//
// After tx2 confirms, every future waap.eth operation (resolver
// deploy, setResolver, subname issuance) is PTB-signed through
// IKA — the Phantom seed that currently controls `0x9e82…3314`
// goes dormant. No key import, no hot key migration.
//
// Defaults are tuned for the waap.eth → superteam.sui IKA dWallet
// transfer brando flagged; callers can override for any other
// SUIAMI-verified dWallet target.
const _moveWaapEthToDwallet = async (opts?: {
  fromAddress?: string;           // who currently owns waap.eth (default: 0x9e82...3314)
  dwalletAddress?: string;         // where to send it (default: superteam.sui's secp256k1 dWallet-derived ETH)
  ensName?: string;                // bare name, no .eth (default: "waap")
  ethAmountWei?: bigint;           // value to send along with ownership transfer (default: 0.002 ETH)
  skipTransfer?: boolean;          // dry-run mode — build + log both txs, don't prompt
}) => {
  const fromAddress = (opts?.fromAddress ?? '0x9e825c8DB5758A7B888d281b83e28792233A3314').toLowerCase();
  const dwalletAddress = opts?.dwalletAddress ?? '0xCE3e9733aB9e78aB6e9F13B7FC6aC5a45D711763';
  const ensName = opts?.ensName ?? 'waap';
  const ethWei = opts?.ethAmountWei ?? 2_000_000_000_000_000n; // 0.002 ETH

  const eth = (window as any).ethereum;
  if (!eth) {
    console.error('[moveWaapEth] no window.ethereum — is Phantom (or MetaMask) installed and unlocked?');
    return { error: 'no-provider' };
  }

  try {
    const { encodeFunctionData, namehash, toHex } = await import('viem');
    const node = namehash(`${ensName}.eth`);
    const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const;

    // setOwner(bytes32 node, address owner) — selector 0x5b0fc9c3
    const setOwnerData = encodeFunctionData({
      abi: [{ name: 'setOwner', type: 'function', inputs: [
        { name: 'node', type: 'bytes32' },
        { name: 'owner', type: 'address' },
      ], outputs: [] }],
      functionName: 'setOwner',
      args: [node, dwalletAddress as `0x${string}`],
    });

    console.log(`[moveWaapEth] plan:`);
    console.log(`  ens name:        ${ensName}.eth`);
    console.log(`  namehash:        ${node}`);
    console.log(`  from:            ${fromAddress}`);
    console.log(`  dwallet target:  ${dwalletAddress}`);
    console.log(`  value to send:   ${ethWei.toString()} wei (${Number(ethWei) / 1e18} ETH)`);
    console.log(`  tx1: value transfer to ${dwalletAddress}`);
    console.log(`  tx2: ENS.setOwner(${node.slice(0, 10)}…, ${dwalletAddress})`);
    console.log(`  tx2 calldata:    ${setOwnerData}`);

    if (opts?.skipTransfer) {
      console.log('[moveWaapEth] skipTransfer=true — stopping before prompts');
      return { ok: true, dryRun: true, setOwnerData };
    }

    // Connect + verify chain + verify sender
    const accounts = await eth.request({ method: 'eth_requestAccounts' }) as string[];
    const connected = (accounts[0] || '').toLowerCase();
    if (connected !== fromAddress) {
      const msg = `Phantom connected as ${connected}, need ${fromAddress}. Switch accounts in Phantom and retry.`;
      console.error('[moveWaapEth]', msg);
      showToast(msg);
      return { error: 'wrong-account', connected, expected: fromAddress };
    }
    const chainId = await eth.request({ method: 'eth_chainId' }) as string;
    if (chainId !== '0x1') {
      const msg = `Phantom on chain ${chainId}; need 0x1 (Ethereum mainnet). Switch network and retry.`;
      console.error('[moveWaapEth]', msg);
      showToast(msg);
      return { error: 'wrong-chain', chainId };
    }

    showToast(`\u26a1 Phantom: sign tx 1 of 2 — sending ${Number(ethWei) / 1e18} ETH to dWallet\u2026`);
    console.log('[moveWaapEth] submitting tx1 (value transfer)...');
    const tx1 = await eth.request({
      method: 'eth_sendTransaction',
      params: [{
        from: fromAddress,
        to: dwalletAddress,
        value: toHex(ethWei),
      }],
    }) as string;
    console.log(`[moveWaapEth] tx1 submitted: ${tx1}`);
    showToast(`\u2713 tx 1 submitted: ${tx1.slice(0, 10)}\u2026 — sign tx 2 (setOwner) next`);

    showToast(`\u26a1 Phantom: sign tx 2 of 2 — ENS.setOwner(${ensName}.eth, dWallet)\u2026`);
    console.log('[moveWaapEth] submitting tx2 (ENS setOwner)...');
    const tx2 = await eth.request({
      method: 'eth_sendTransaction',
      params: [{
        from: fromAddress,
        to: ENS_REGISTRY,
        data: setOwnerData,
      }],
    }) as string;
    console.log(`[moveWaapEth] tx2 submitted: ${tx2}`);
    showToast(`\u2713 ${ensName}.eth transfer submitted: ${tx2.slice(0, 10)}\u2026`);
    console.log(`[moveWaapEth] done. Once both mine, ${dwalletAddress} owns ${ensName}.eth.`);
    console.log(`  Verify: https://app.ens.domains/${ensName}.eth`);
    console.log(`  Etherscan: https://etherscan.io/tx/${tx2}`);
    return { ok: true, tx1, tx2, dwalletAddress };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[moveWaapEth] failed:', err);
    if (!msg.toLowerCase().includes('user reject') && !msg.toLowerCase().includes('user denied')) {
      showToast(`moveWaapEth failed: ${msg.slice(0, 120)}`);
    }
    return { error: msg };
  }
};
(window as unknown as { moveWaapEthToDwallet: typeof _moveWaapEthToDwallet }).moveWaapEthToDwallet = _moveWaapEthToDwallet;
(globalThis as unknown as { moveWaapEthToDwallet: typeof _moveWaapEthToDwallet }).moveWaapEthToDwallet = _moveWaapEthToDwallet;
console.log('[ski] moveWaapEthToDwallet hook installed — call moveWaapEthToDwallet() to transfer waap.eth to superteam.sui\'s IKA dWallet via Phantom ETH (Beldum Relocate, #167). Pass { skipTransfer:true } to dry-run.');

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

// clearSealRejection — when the user cancels a Seal sign prompt, we set
// a 5-min cooldown so subsequent storm opens don't re-prompt them in a
// loop. This hook lets them clear the cooldown and try again without
// reloading. Useful when the user cancels by accident or wants to retry
// after switching contexts.
const _clearSealRejection = async () => {
  try {
    const { clearSealRejection } = await import('./client/thunder.js');
    clearSealRejection();
    console.log('[clearSealRejection] cooldown cleared, next storm open will re-prompt');
  } catch (err) {
    console.error('[clearSealRejection] error:', err);
  }
};
(window as unknown as { clearSealRejection: typeof _clearSealRejection }).clearSealRejection = _clearSealRejection;
console.log('[ski] clearSealRejection hook installed — call clearSealRejection() after cancelling Seal sign');

// Minimal smoke test for the wallet's signPersonalMessage path. Takes
// a plain ASCII string, hands it straight to wallet.ts with nothing
// else in the loop — no Seal SDK, no IKA SDK, no canonicalization, no
// vector-intent wrapping. Isolates whether the wallet backend itself
// is accepting sign requests, independent of any SKI-specific wrapping.
//
// Usage: testWalletSign("hello world")
// Returns { bytes, signature } on success, { error } on failure.
const _testWalletSign = async (message: string = 'sui.ski smoke test') => {
  try {
    const { signPersonalMessage, getState } = await import('./wallet.js');
    const ws = getState();
    console.log('[testWalletSign] address:', ws.address, 'walletName:', ws.walletName);
    console.log('[testWalletSign] message:', JSON.stringify(message));
    const msgBytes = new TextEncoder().encode(message);
    console.log('[testWalletSign] msgBytes length:', msgBytes.length);
    const res = await signPersonalMessage(msgBytes);
    console.log('[testWalletSign] ok, signature length:', res.signature?.length);
    console.log('[testWalletSign] bytes:', res.bytes);
    console.log('[testWalletSign] signature:', res.signature);
    return res;
  } catch (err) {
    console.error('[testWalletSign] failed:', err);
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
};
(window as unknown as { testWalletSign: typeof _testWalletSign }).testWalletSign = _testWalletSign;
console.log('[ski] testWalletSign hook installed — call testWalletSign() to test raw wallet signing');

// Nuclear WaaP reset: nukes every WaaP/Silk/walletconnect key in
// localStorage + sessionStorage, removes any injected iframes, clears
// the dappkit "which wallet" marker, drops in-memory registration
// state, then reloads the page for a totally fresh connect flow.
//
// Use when WaaP stops opening (iframe stuck, INVALID_DEVICE_SESSION,
// signing hits Silk 400s repeatedly) and you've already tried
// disconnect/reconnect through the normal UI.
const _purgeWaaP = async () => {
  try {
    const { purgeWaaPState } = await import('./waap.js');
    await purgeWaaPState();
    console.log('[purgeWaaP] state purged, reloading in 1s...');
    setTimeout(() => location.reload(), 1000);
    return { ok: true };
  } catch (err) {
    console.error('[purgeWaaP] failed:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
};
(window as unknown as { purgeWaaP: typeof _purgeWaaP }).purgeWaaP = _purgeWaaP;
console.log('[ski] purgeWaaP hook installed — call purgeWaaP() if WaaP iframe is stuck');

// Auto-trigger if the URL query contains ?purge-waap so a stuck user
// can just visit https://sui.ski/?purge-waap without knowing the
// console command.
try {
  if (typeof location !== 'undefined' && location.search.includes('purge-waap')) {
    console.log('[purgeWaaP] URL flag detected, running purge...');
    _purgeWaaP();
  }
} catch { /* non-browser */ }

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
