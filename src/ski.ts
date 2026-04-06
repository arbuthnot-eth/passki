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

    // Get chain-specific address from app state
    const appState = getAppState();
    const chainAddr = network === 'btc' ? appState.btcAddress
      : network === 'sol' ? appState.solAddress
      : network === 'eth' ? appState.ethAddress
      : '';

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

    const raw = buildSuiamiMessage(name, ws.address, nftId);
    if (name === 'nobody') raw.suiami = 'I am nobody';
    // Reorder fields: suiami, datetime, chain, chainAddress, ski, network, address, ...rest
    const message: any = {
      suiami: raw.suiami,
      datetime: raw.datetime,
      chain: network || 'sui',
      ...(chainAddr ? { chainAddress: chainAddr } : {}),
      ski: raw.ski,
      network: raw.network,
      address: raw.address,
      nftId: nftId || '',
      ...(expiresInDays > 0 ? { expiresInDays } : {}),
      timestamp: raw.timestamp,
      version: raw.version,
    };

    const msgBytes = new TextEncoder().encode(JSON.stringify(message, null, 2));
    const { bytes, signature } = await signPersonalMessage(msgBytes);
    const proof = createSuiamiProof(message, bytes, signature);

    try {
      await navigator.clipboard.writeText(proof.token);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = proof.token;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    const netNames: Record<string, string> = { btc: 'bitcoin', sol: 'solana', sui: 'sui', eth: 'ethereum' };
    const netLabel = netNames[network] || network || 'sui';
    const label = name === 'nobody' ? 'nobody' : `${name}.sui`;
    showToast(`SUIAMI? I AM ${label}@${netLabel} \u2014 \u2713 copied`);

    window.dispatchEvent(new CustomEvent('suiami:signed', {
      detail: { proof: proof.token, message: proof.message, signature: proof.signature, name, address: ws.address, network },
    }));
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
import('./waap.js').then(({ registerWaaP }) => registerWaaP()).catch(() => {});

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
