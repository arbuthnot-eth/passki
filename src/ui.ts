/**
 * .SKI UI — Renders the wallet widget matching the production design:
 *
 *  Disconnected:  [ ◆ SKI ] (green logo, connect button)
 *
 *  Connected:     [ 🟣 𝕏  brando.sui  424.4 💧 ]  [ ■ SKI ]
 *                   icons   name       balance       profile
 *
 * Profile button is blue when SuiNS name exists, black otherwise.
 */

import {
  subscribe,
  getState,
  getSuiWallets,
  connect,
  disconnect,
  deactivate,
  activateAccount,
  signPersonalMessage,
  signAndExecuteTransaction,
  signTransaction,
  autoReconnect,
  preloadStoredWallet,
  onWalletsChanged,
  type WalletState,
} from './wallet.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { grpcClient, grpcUrl, GQL_URL } from './rpc.js';
export { grpcClient };
import {
  getSponsorState,
  isSponsorActive,
  isSponsoredAddress,
  activateSponsor,
  deactivateSponsor,
  subscribeSponsor,
  addSponsoredEntry,
  removeSponsoredEntry,
  getActiveSponsoredList,
  resolveNameToAddress,
} from './sponsor.js';
import { fetchOwnedDomains, buildSubnameTx, buildRegisterSplashNsTx, buildConsolidateToUsdcTx, buildSendTx, buildSelfSwapTx, buildSwapTx, fetchDomainPriceUsd, checkDomainStatus, buildSetDefaultNsTx, buildSetTargetAddressTx, buildSubnameTxBytes, lookupNftOwner, buildCreateShadeOrderTx, buildExecuteShadeOrderTx, buildCancelShadeOrderTx, buildCancelRefundShadeOrderTx, buildKioskPurchaseTx, buildTradeportPurchaseTx, buildSwapAndPurchaseTx, findShadeOrder, addShadeOrder, removeShadeOrder, removeShadeOrderByDomain, pruneShadeOrders, findCreatedShadeOrderId, extractShadeOrderIdFromEffects, getShadeOrders, fetchOnChainShadeOrders, resolveSuiNSName, fetchTradeportListing, type OwnedDomain, type DomainStatusResult, type ShadeOrderInfo, type TradeportListing } from './suins.js';
import { connectShadeExecutor, scheduleShadeExecution, cancelShadeExecution, resetFailedShadeOrders, reapCancelledShadeOrder, disconnectShadeExecutor, type ShadeExecutorState, type ShadeExecutorOrder } from './client/shade.js';
import { buildSuiamiMessage, createSuiamiProof, type SuiamiProof } from './suiami.js';
import SKI_SVG_TEXT from '../public/assets/ski.svg';
import SUI_DROP_SVG_TEXT from '../public/assets/sui-drop.svg';
import SUI_SKI_QR_SVG_TEXT from '../public/assets/sui-ski-qr.svg';


/** Sign a sponsored transaction: user signs, then fetch sponsor sig, submit both. */
async function signAndExecuteSponsoredTx(txBytes: Uint8Array): Promise<{ digest: string }> {
  // 1. User signs
  const { signature: userSig } = await signTransaction(txBytes);

  // 2. Get sponsor signature from keeper
  const b64 = btoa(String.fromCharCode(...txBytes));
  const res = await fetch('/api/sponsor-gas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txBytes: b64, senderAddress: getState().address }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Sponsor signing failed' })) as { error?: string };
    throw new Error(err.error ?? 'Gas sponsorship failed');
  }
  const { sponsorSig } = await res.json() as { sponsorSig: string };

  // 3. Submit with both signatures
  const result = await (grpcClient as unknown as { core: { executeTransaction: (r: { transaction: Uint8Array; signatures: string[] }) => Promise<Record<string, unknown>> } }).core.executeTransaction({
    transaction: txBytes,
    signatures: [userSig, sponsorSig],
  });

  const digest = (result as any)?.digest ?? (result as any)?.Transaction?.digest ?? '';
  return { digest };
}

// ─── Assets ──────────────────────────────────────────────────────────

export const SUI_DROP_URI = `data:image/svg+xml,${encodeURIComponent(SUI_DROP_SVG_TEXT)}`;
const BTC_ICON_SVG = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17" fill="#f7931a" stroke="white" stroke-width="3"/><text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">\u20BF</text></svg>`;
const BTC_ICON_URI = `data:image/svg+xml,${encodeURIComponent(BTC_ICON_SVG)}`;
const SKI_SVG_URI     = `data:image/svg+xml,${encodeURIComponent(SKI_SVG_TEXT)}`;
const SUI_SKI_QR_URI  = `data:image/svg+xml,${encodeURIComponent(SUI_SKI_QR_SVG_TEXT)}`;
const NS_ICON_URI     = 'https://coin-images.coingecko.com/coins/images/40110/small/NS_coin.png';
const WAL_ICON_URI    = 'https://coin-images.coingecko.com/coins/images/54914/small/Walrus_Token_Full_Color_200x200.png';
const AU_ICON_URI     = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAABdFBMVEX//////5n//6r/zGb/zHf/3Xf/3Yj/7ojuzGbuu1Xu3Xf/7nfu7pnuu0TdqlXMqlW7mUSqiESqmUTdu2bu3Zn/7pm7iDN3VSJEMxEiIhEiIiIzMyJVVSKZiETdzHfu7rsRERERESJERCKZmVXu7oj//8zMmVVVMyIRIiIiIjMzMzNEMyKId0TuzHfuu2YiESJERDNVVTO7mWb/7qruzIhERERVVUR3ZkSZiFXdzGbdu1UzIiJmRDNmVTNVRDMzM0RVRES7iEQzIhFmVUT/3ZnMu4hEMzO7qlV3VTMiERGqiFXu3YiIZjPMqmZ3ZlVVRCJmRCLdu3e7mVWqmVXdzJm7qogzMxHMmUSZZjOqdzPuu4iIZkS7qneqiDOIZiLdqkRVMxEiEQDuu3eZd0SIdzOZdzPdu0RmRBHMqkTuzFVmVSLMu2Z3ZjPdzIjdu4h3ZiLdqneId1WqmWYREQDdzFURIhH/3WaIiES7qkR3d0Tu3WbMzIjjISF8AAAAAXRSTlMAQObYZgAAAo5JREFUOMt1k/tXEkEcxRdw37YDDoSzFM1SCbHsioYpQ1iN+SDEdYk084GmWBjZw6Kif75ZWBU9eX/Zc773M3f2nO8djhtWIOiJu0GhEd6TIPCi+B9bkmRZDoU8RFFUcfSaLfCSfEvWQDgyBqCiqqIYiA77Mc+/HR9HTHrizt0kA4L3hv2RkBZH2NB9pe4/CAQfXhDCiBSaSGNsZAb2o2zWzI0GA7GkD1i2PWFO6hnDJxiQn5p+LPLWwC/YNmC+7kVkfGDmyeycYhWJHwDjzC89Lc/rfYIBz2ae5+8WIfADXlBdzywUXi6WLn4im18ylwkIewEQrrBh5ZUlVFPGJZEtrWqARRSgBkw2ozVJ4lewPrm0Nq/r5sJaXncAYBEW1CKIAetuPSK8RgaebbwpVdbdxry+EQZgk0sS7S0D0BZcTb9z0wbedndKOA2ho6NdTQOcS7Q9Bjibzf2D+vtDhI+kWgnvE2KiSksjgIN9ALWOm/H9LVszcU4CJfxhAJA+0GyxBX08bluWLUs5fGTXEjhOYApXIgT2gTA1TgjZzeUOgfSJdmBt/CAOoYnpsg80TTxnaRRj3El+niqfuuGtCdcdxw4hMMJxhBx/odNft1EmYyztLH5LfD8tuHXXNc+OIIRe12Q5TClFbJmGgahu6PNlh6YcRAHsLwOyLu6dYWOg869ROWixAG8XnC3L5ISt2hjWZGUFwiL0C91u/yijn8MErnSKxaJ13ig+1FV+UXxpY5RLWpZQPC+lqPKq+ttB2Bdy6oqixKqXtQ4G1G63PdZJbVCacP4sK1Xmx66+SrXb6/WkYjJpKYKgVMXh84NreKUnKYIoilWlGotdf3qe2LXsYF9R7iZFo43G3yuTf1cDfbPrlphDAAAAAElFTkSuQmCC';

// ─── Social provider icons (inline SVG, ships in the bundle) ─────────
// Used in legend col-4 to replace wallet logos for social-login wallets.

const _fca = `style="forced-color-adjust:none;-webkit-forced-color-adjust:none"`;

/** X (Twitter) — black rounded-square, white X path */
const SOCIAL_ICON_X = `<svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" ${_fca} aria-label="X"><rect width="38" height="38" rx="8" fill="#000"/><svg x="7" y="7" width="24" height="24" viewBox="0 0 24 24"><path fill="#fff" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835-8.162-10.665h7.555l4.259 5.63 4.115-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></svg>`;

/** Google — white rounded-square, four-color G */
const SOCIAL_ICON_GOOGLE = `<svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" ${_fca} aria-label="Google"><rect width="38" height="38" rx="8" fill="#fff"/><svg x="7" y="7" width="24" height="24" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg></svg>`;

/** Discord — blurple rounded-square, white Clyde icon */
const SOCIAL_ICON_DISCORD = `<svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" ${_fca} aria-label="Discord"><rect width="38" height="38" rx="8" fill="#5865F2"/><svg x="4" y="8" width="30" height="22" viewBox="0 0 127.14 96.36"><path fill="#fff" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg></svg>`;

/** Email — dark rounded-square, white envelope */
const SOCIAL_ICON_EMAIL = `<svg width="38" height="38" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg" ${_fca} aria-label="Email"><rect width="38" height="38" rx="8" fill="#1e293b"/><svg x="7" y="10" width="24" height="18" viewBox="0 0 24 18"><rect x="0.75" y="0.75" width="22.5" height="16.5" rx="1.5" fill="none" stroke="#fff" stroke-width="1.5"/><polyline points="0.75,0.75 12,10 23.25,0.75" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg></svg>`;

/** Map a wallet name to its social provider inline SVG, or null for standard wallets. */
function socialIconSvg(walletName: string): string | null {
  if (/waap/i.test(walletName)) return SOCIAL_ICON_X;
  if (/google/i.test(walletName)) return SOCIAL_ICON_GOOGLE;
  if (/discord/i.test(walletName)) return SOCIAL_ICON_DISCORD;
  return null;
}

/** Detect which social provider a WaaP account used from its label string. */
function detectWaapProvider(label: string): 'google' | 'x' | 'email' | null {
  if (!label) return null;
  if (/google/i.test(label) || /@gmail\./i.test(label)) return 'google';
  if (/^@/.test(label.trim()) || /x\.com/i.test(label)) return 'x';
  if (/@/.test(label)) return 'email';
  return null;
}

/** Persist the detected WaaP social provider for a given address. */
function storeWaapProvider(address: string, provider: 'google' | 'x' | 'email' | null): void {
  if (!provider || !address) return;
  try { localStorage.setItem(`ski:waap-provider:${address}`, provider); } catch {}
}

/** Return the social provider icon SVG for a WaaP address; falls back to X. */
function waapProviderIcon(address: string | null): string {
  if (address) {
    try {
      const stored = localStorage.getItem(`ski:waap-provider:${address}`);
      if (stored === 'google') return SOCIAL_ICON_GOOGLE;
      if (stored === 'email') return SOCIAL_ICON_EMAIL;
    } catch {}
  }
  return SOCIAL_ICON_X;
}

// ─── App-level state (beyond wallet connection) ──────────────────────

export interface AppState {
  sui: number;
  usd: number | null;
  stableUsd: number;
  nsBalance: number;
  suinsName: string;
  ikaWalletId: string;
  btcAddress: string;
  ethAddress: string;
  skiMenuOpen: boolean;
  copied: boolean;
  splashSponsor: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
  stableUsd: 0,
  nsBalance: 0,
  suinsName: '',
  ikaWalletId: '',
  btcAddress: '',
  ethAddress: '',
  skiMenuOpen: (() => { try { return localStorage.getItem('ski:lift') === '1'; } catch { return false; } })(),
  copied: false,
  splashSponsor: false,
};

export function getAppState() { return app; }
export function updateAppState(patch: Partial<AppState>) {
  Object.assign(app, patch);
  render();
}

// ─── DOM ─────────────────────────────────────────────────────────────

const els = {
  widget:    document.getElementById('ski-wallet') || document.getElementById('wallet-widget'),
  profile:   document.getElementById('ski-profile') || document.getElementById('wk-widget'),
  skiDot:    document.getElementById('ski-dot') || document.getElementById('ski-dot-btn'),
  skiBtn:    document.getElementById('ski-btn') || document.getElementById('wallet-ski-btn'),
  skiMenu:   document.getElementById('ski-menu') || document.getElementById('ski-menu-root'),
  modal:     document.getElementById('ski-modal'),
  signStage: document.getElementById('ski-sign'),
};

// ─── Helpers ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncAddr(addr: string): string {
  if (!addr || addr.length <= 14) return addr;
  return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
}

function fmtSui(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 0.01) return '< 0.01';
  if (n < 100) return n.toFixed(2).replace(/\.?0+$/, '');
  if (n < 10_000) return n.toFixed(1);
  if (n < 1_000_000) return (n / 1_000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 0.01) return '< $0.01';
  if (n < 100) return '$' + n.toFixed(2);
  if (n < 10_000) return '$' + n.toFixed(0);
  if (n < 1_000_000) return '$' + (n / 1_000).toFixed(1) + 'k';
  return '$' + (n / 1_000_000).toFixed(1) + 'M';
}

/** 3-decimal HTML for the SKI menu balance — integer part full-size, decimals smaller. */
function fmtMenuBalHtml(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '--';
  let whole: string, frac: string, suffix = '';
  if (n < 1_000) {
    const s = n.toFixed(3);
    const dot = s.indexOf('.');
    whole = s.slice(0, dot); frac = s.slice(dot);
  } else if (n < 1_000_000) {
    const s = (n / 1_000).toFixed(3);
    const dot = s.indexOf('.');
    whole = s.slice(0, dot); frac = s.slice(dot); suffix = 'k';
  } else {
    const s = (n / 1_000_000).toFixed(3);
    const dot = s.indexOf('.');
    whole = s.slice(0, dot); frac = s.slice(dot); suffix = 'M';
  }
  return `<span class="wk-bal-whole">${esc(whole)}</span><span class="wk-bal-decimals">${esc(frac)}${esc(suffix)}</span>`;
}

function fmtStable(n: number): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '';
  if (n < 0.01) return '< $0.01';
  return '$' + n.toFixed(2);
}

// ─── Toast ───────────────────────────────────────────────────────────

let toastSeq = 0;

export function showToast(msg: string, isHtml = false) {
  const text = msg.trim();
  if (!text) return;

  // Error-like messages get the copyable treatment automatically
  const lc = text.toLowerCase();
  const isError = !isHtml && (
    lc.includes('error') || lc.includes('failed') || lc.includes('abort') ||
    lc.includes('insufficient') || lc.includes('rejected') || lc.includes('exception') ||
    lc.includes('timeout') || lc.includes('invalid') || text.length > 80
  );
  if (isError) {
    showCopyableToast(text, text);
    return;
  }

  let root = document.getElementById('app-toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-toast-root';
    root.className = 'app-toast-root';
    document.body.appendChild(root);
  }
  const toast = document.createElement('div');
  const id = 'app-toast-' + ++toastSeq;
  toast.className = 'app-toast';
  toast.id = id;
  toast.setAttribute('role', 'status');
  if (isHtml) toast.innerHTML = text; else toast.textContent = text;
  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); };
  setTimeout(remove, 3800);
  toast.addEventListener('click', remove);
}

function showCopyableToast(display: string, fullText: string, durationMs = 8000) {
  const text = display.trim();
  if (!text) return;
  let root = document.getElementById('app-toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-toast-root';
    root.className = 'app-toast-root';
    document.body.appendChild(root);
  }
  const toast = document.createElement('div');
  const id = 'app-toast-' + ++toastSeq;
  toast.className = 'app-toast app-toast--copyable';
  toast.id = id;
  toast.setAttribute('role', 'status');

  const msgEl = document.createElement('div');
  msgEl.className = 'app-toast-copy-msg';
  msgEl.textContent = text;
  toast.appendChild(msgEl);

  const hint = document.createElement('div');
  hint.className = 'app-toast-copy-hint';
  hint.textContent = 'click to copy error';
  toast.appendChild(hint);

  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));

  let copied = false;
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); };
  // Error toasts stay until dismissed — no auto-timeout
  toast.addEventListener('click', () => {
    if (copied) { remove(); return; }
    copied = true;
    navigator.clipboard.writeText(fullText).catch(() => {});
    hint.textContent = '\u2713 Copied — click again to dismiss';
    hint.style.color = '#4ade80';
  });
}

const BACKPACK_CHROME_URL  = 'https://chromewebstore.google.com/detail/backpack/aflkmfhebedbjioipglgcbcmnbpgliof';
const BACKPACK_IOS_URL     = 'https://apps.apple.com/us/app/backpack-buy-sol-btc-crypto/id6445964121';
const BACKPACK_ANDROID_URL = 'https://play.google.com/store/apps/details?id=app.backpack.mobile';

function getBackpackSmartUrl(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return BACKPACK_IOS_URL;
  if (/Android/i.test(ua)) return BACKPACK_ANDROID_URL;
  return BACKPACK_CHROME_URL;
}

export function showBackpackLockedToast() {
  const walletIcon = getState().walletIcon;
  const smartUrl = getBackpackSmartUrl();

  let root = document.getElementById('app-toast-root-top');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-toast-root-top';
    root.className = 'app-toast-root app-toast-root--top';
    document.body.appendChild(root);
  }

  const toast = document.createElement('div');
  const id = 'app-toast-' + ++toastSeq;
  toast.className = 'app-toast app-toast--action app-toast--backpack';
  toast.id = id;
  toast.setAttribute('role', 'status');

  // Logo — smart-routes to the right store for this device
  if (walletIcon) {
    const link = document.createElement('a');
    link.href = smartUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'app-toast-wallet-icon-link';
    link.title = 'Get Backpack';
    link.addEventListener('click', (e) => e.stopPropagation());
    const img = document.createElement('img');
    img.className = 'app-toast-wallet-icon';
    img.src = walletIcon;
    img.alt = 'Backpack';
    img.width = 47;
    img.height = 47;
    link.appendChild(img);
    toast.appendChild(link);
  }

  // Body: message + store links
  const body = document.createElement('div');
  body.className = 'app-toast-backpack-body';
  const msg = document.createElement('span');
  msg.textContent = 'Lockin to Backpack app or extension';
  body.appendChild(msg);
  const storeLinks = document.createElement('div');
  storeLinks.className = 'app-toast-store-links';
  const stores = [
    { label: 'Chrome', url: BACKPACK_CHROME_URL },
    { label: 'App Store', url: BACKPACK_IOS_URL },
    { label: 'Google Play', url: BACKPACK_ANDROID_URL },
  ];
  stores.forEach(({ label, url }) => {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'app-toast-store-link';
    a.textContent = label;
    a.addEventListener('click', (e) => e.stopPropagation());
    storeLinks.appendChild(a);
  });
  body.appendChild(storeLinks);
  toast.appendChild(body);

  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); };
  setTimeout(remove, 12000);
  toast.addEventListener('click', remove);
}

export function showToastWithRetry(msg: string, retryLabel: string, retryFn: () => void) {
  const text = msg.trim();
  if (!text) return;
  let root = document.getElementById('app-toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'app-toast-root';
    root.className = 'app-toast-root';
    document.body.appendChild(root);
  }
  const toast = document.createElement('div');
  const id = 'app-toast-' + ++toastSeq;
  toast.className = 'app-toast app-toast--action';
  toast.id = id;
  toast.setAttribute('role', 'status');
  const textSpan = document.createElement('span');
  textSpan.textContent = text;
  toast.appendChild(textSpan);
  const btn = document.createElement('button');
  btn.className = 'app-toast-retry';
  btn.textContent = retryLabel;
  toast.appendChild(btn);
  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); remove(); retryFn(); });
  setTimeout(remove, 10000); // longer window for action toasts
  toast.addEventListener('click', remove);
}

// ─── SKI SVG dot variant ─────────────────────────────────────────────

let _skiSvgText: string | null = SKI_SVG_TEXT;

type SkiDotVariant = 'green-circle' | 'blue-square' | 'black-diamond' | 'red-hexagon';

/**
 * Generic SVG string builder. Renames all internal IDs to `{idPrefix}-*` so
 * multiple instances of the same SVG can coexist in the DOM without conflicts.
 * Pre-applies dot variant and lift visibility via string substitution so the
 * rendered SVG is correct on frame 0 — no post-render DOM swap needed.
 */
function _buildSkiSvg(
  svgId: string,
  cssClass: string,
  idPrefix: string,
  variant: SkiDotVariant,
  showLift: boolean,
): string {
  if (!_skiSvgText) return '';

  let s = _skiSvgText
    .replace('<svg ', `<svg id="${svgId}" class="${cssClass}" `)
    .replace('id="ski-lift"',       showLift ? `id="${idPrefix}-lift"` : `id="${idPrefix}-lift" style="display:none"`)
    .replace('id="ski-text"',       `id="${idPrefix}-text"`)
    .replace('id="ski-dot-outer"',  `id="${idPrefix}-dot-outer"`)
    .replace('id="ski-dot-inner"',  `id="${idPrefix}-dot-inner"`)
    .replace('id="ski-dot-circle"', `id="${idPrefix}-dot-circle"`)
    .replace('id="ski-dot-square"', `id="${idPrefix}-dot-square"`);

  // Crop to the bottom half of the SVG (the lift/slope lives in the top half)
  if (!showLift) {
    s = s.replace('viewBox="0 0 1214 847"', 'viewBox="0 460 1214 387"');
  }

  if (variant === 'green-circle') {
    s = s
      .replace(`id="${idPrefix}-dot-outer" fill="#FFFFFF"`,
        `id="${idPrefix}-dot-outer" style="display:none" fill="#FFFFFF"`)
      .replace(`id="${idPrefix}-dot-inner" fill="#010101" opacity="1.000000" stroke="none"`,
        `id="${idPrefix}-dot-inner" style="display:none" fill="#010101" opacity="1.000000" stroke="none"`)
      .replace(`id="${idPrefix}-dot-circle"`, `id="${idPrefix}-dot-circle" fill="#22c55e"`)
      .replace(new RegExp(`(<circle id="${idPrefix}-dot-circle"[^>]*?) style="display:none"(/>)`), '$1$2');
  } else if (variant === 'blue-square') {
    s = s
      .replace(`id="${idPrefix}-dot-outer" fill="#FFFFFF"`,
        `id="${idPrefix}-dot-outer" style="display:none" fill="#FFFFFF"`)
      .replace(`id="${idPrefix}-dot-inner" fill="#010101" opacity="1.000000" stroke="none"`,
        `id="${idPrefix}-dot-inner" style="display:none" fill="#010101" opacity="1.000000" stroke="none"`)
      .replace(`id="${idPrefix}-dot-square"`, `id="${idPrefix}-dot-square" fill="#4da2ff"`)
      .replace(new RegExp(`(<rect id="${idPrefix}-dot-square"[^>]*?) style="display:none"(/>)`), '$1$2');
  }
  // black-diamond: outer/inner visible by default in source; circle/square already hidden
  return s;
}

// Modal SVG — uses 'ski' prefix so IDs match what updateSkiDot() looks up
function getInlineSkiSvg(): string {
  const ws = getState();
  let variant: SkiDotVariant;
  let dotOverlay = '';

  if (balView === 'sui') {
    variant = 'blue-square';
  } else {
    variant = 'green-circle';
    dotOverlay = `<text x="184" y="658" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="200" font-weight="700" fill="white" pointer-events="none">$</text>`;
  }

  let svg = _buildSkiSvg('ski-modal-svg', 'ski-modal-logo', 'ski', variant, _skiLiftVisible);
  if (!svg) {
    return `<a href="https://sui.ski" target="_blank" rel="noopener" id="ski-modal-brand-link" class="ski-modal-brand-link">
      <img src="${SKI_SVG_URI}" class="ski-modal-logo" id="ski-modal-svg-fallback">
    </a>`;
  }

  let extraOverlay = '';
  const _showSui = activeDetailAddr ? activeDetailSui : app.sui;
  const _showUsd = activeDetailAddr ? activeDetailUsd : app.usd;
  if (activeDetailAddr || (ws.address && app.suinsName)) {
    // Hide SKI letter paths and replace with live balance (left-justified from after the dot)
    svg = svg.replace('id="ski-text"', 'id="ski-text" style="display:none"');
    const rawBal = balView === 'usd'
      ? ((fmtUsd(_showUsd) || '').replace(/^\$/, '') || '--')
      : fmtSui(_showSui);
    // Balance text: starts right after the dot shape, extends to right edge
    const balX = 280; // tighter left start (closer to dot)
    const balW = 1180 - balX; // available width
    const fontSize = Math.max(200, Math.min(380, Math.floor(balW / (rawBal.length * 0.52))));
    const textY = Math.min(672, 840 - Math.round(fontSize / 2));
    extraOverlay = `<defs><filter id="ski-bal-glow" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="10" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><text x="${balX}" y="${textY}" textLength="${balW}" lengthAdjust="spacingAndGlyphs" text-anchor="start" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="${fontSize}" font-weight="800" fill="white" stroke="white" stroke-width="6" paint-order="stroke fill" filter="url(#ski-bal-glow)" pointer-events="none">${esc(rawBal)}</text>`;
  }

  const overlays = dotOverlay + extraOverlay;
  if (overlays) svg = svg.replace('</svg>', overlays + '</svg>');
  return `<a href="https://sui.ski" target="_blank" rel="noopener" id="ski-modal-brand-link" class="ski-modal-brand-link">${svg}</a>`;
}

// Pill button SVG — 'ski-pill' prefix, lift always hidden
function getPillSkiSvg(variant: SkiDotVariant): string {
  return _buildSkiSvg('ski-pill-svg', 'wk-pill-ski-logo', 'ski-pill', variant, false);
}

// SKI button SVG — 'ski-btn' prefix, lift always hidden
function getSkiBtnSvg(variant: SkiDotVariant): string {
  return _buildSkiSvg('ski-btn-svg', 'wk-ski-btn-logo', 'ski-btn', variant, false);
}

let _skiLiftVisible = true;

export function setSkiLift(show: boolean) {
  _skiLiftVisible = show;
  const fin = document.getElementById('ski-lift') as SVGElement | null;
  if (fin) fin.style.display = show ? '' : 'none';
}

// ─── Dynamic favicon ─────────────────────────────────────────────────

let _faviconVariant: SkiDotVariant | null = null;
let _diamondPng: string | null = null;

/** Render the black diamond shape to a canvas and return a PNG data URL.
 *  Cached after first call. Phantom ignores SVG favicons and caches hosted
 *  PNGs aggressively — a data-URL PNG bypasses both problems. */
function buildDiamondPng(): string {
  if (_diamondPng) return _diamondPng;
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const half = size / 2;
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.moveTo(half, 8);
  ctx.lineTo(size - 8, half);
  ctx.lineTo(half, size - 8);
  ctx.lineTo(8, half);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.stroke();
  _diamondPng = canvas.toDataURL('image/png');
  return _diamondPng;
}

const SUI_DROP_PATH = `M240.057 159.914C255.698 179.553 265.052 204.39 265.052 231.407C265.052 258.424 255.414 284.019 239.362 303.768L237.971 305.475L237.608 303.31C237.292 301.477 236.929 299.613 236.502 297.749C228.46 262.421 202.265 232.134 159.148 207.597C130.029 191.071 113.361 171.195 108.985 148.586C106.157 133.972 108.258 119.294 112.318 106.717C116.379 94.1569 122.414 83.6187 127.549 77.2831L144.328 56.7754C147.267 53.1731 152.781 53.1731 155.719 56.7754L240.073 159.914H240.057ZM266.584 139.422L154.155 1.96703C152.007 -0.655678 147.993 -0.655678 145.845 1.96703L33.4316 139.422L33.0683 139.881C12.3868 165.555 0 198.181 0 233.698C0 316.408 67.1635 383.461 150 383.461C232.837 383.461 300 316.408 300 233.698C300 198.181 287.613 165.555 266.932 139.896L266.568 139.438L266.584 139.422ZM60.3381 159.472L70.3866 147.164L70.6868 149.439C70.9237 151.24 71.2239 153.041 71.5715 154.858C78.0809 189.001 101.322 217.456 140.173 239.496C173.952 258.724 193.622 280.828 199.278 305.064C201.648 315.176 202.059 325.129 201.032 333.835L200.969 334.372L200.479 334.609C185.233 342.05 168.09 346.237 149.984 346.237C86.4546 346.237 34.9484 294.826 34.9484 231.391C34.9484 204.153 44.4439 179.142 60.3065 159.44L60.3381 159.472Z`;

function updateFavicon(variant: SkiDotVariant) {
  if (variant === _faviconVariant) return;
  _faviconVariant = variant;

  let shape: string;
  if (variant === 'green-circle') {
    shape = `<circle cx="50" cy="50" r="38" fill="#22c55e" stroke="white" stroke-width="10"/>`;
  } else if (variant === 'blue-square') {
    shape = `<rect x="6" y="6" width="88" height="88" rx="18" fill="#4da2ff" stroke="white" stroke-width="8"/><g transform="translate(24,16) scale(0.175)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
  } else {
    shape = `<polygon points="50,6 94,50 50,94 6,50" fill="#000000" stroke="white" stroke-width="10"/>`;
  }
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${shape}</svg>`;
  const url = 'data:image/svg+xml,' + encodeURIComponent(svgStr);
  const link = document.getElementById('ski-favicon') as HTMLLinkElement | null;
  if (link) { link.type = 'image/svg+xml'; link.href = url; }
}

window.addEventListener('ski:pre-sign', (e) => {
  const variant = (e as CustomEvent).detail?.variant as SkiDotVariant | undefined;
  if (variant) {
    _faviconVariant = null; // force update even if variant hasn't changed
    updateFavicon(variant);
  }
  // For wallets that read link tags at sign time (not just at page load),
  // ensure apple-touch-icon is the diamond PNG data URL to bypass any cache.
  const pngUrl = buildDiamondPng();
  if (pngUrl) {
    const touch = document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null;
    if (touch) touch.href = pngUrl;
  }
});

function updateSkiDot(variant: SkiDotVariant, suinsName?: string) {
  // In USD mode, a connected-with-SuiNS user still shows the green circle
  if (variant === 'blue-square' && balView === 'usd') variant = 'green-circle';

  const outer  = document.getElementById('ski-dot-outer')  as SVGElement | null;
  const inner  = document.getElementById('ski-dot-inner')  as SVGElement | null;
  const circle = document.getElementById('ski-dot-circle') as SVGElement | null;
  const square = document.getElementById('ski-dot-square') as SVGElement | null;
  const link   = document.getElementById('ski-modal-brand-link') as HTMLAnchorElement | null;
  const fin    = document.getElementById('ski-lift')         as SVGElement | null;

  if (outer)  outer.style.display  = variant === 'black-diamond' ? '' : 'none';
  if (inner)  inner.style.display  = variant === 'black-diamond' ? '' : 'none';
  if (circle) circle.style.display = variant === 'green-circle'  ? '' : 'none';
  if (square) square.style.display = variant === 'blue-square'   ? '' : 'none';

  if (circle && variant === 'green-circle') circle.setAttribute('fill', '#22c55e');
  if (square && variant === 'blue-square')  square.setAttribute('fill', '#4da2ff');

  if (fin) fin.style.display = _skiLiftVisible ? '' : 'none';

  if (link) {
    link.href = suinsName
      ? `https://${suinsName.replace(/\.sui$/, '')}.sui.ski`
      : 'https://sui.ski';
  }

  const titleEl = document.querySelector('.ski-modal-title') as HTMLElement | null;
  if (titleEl) titleEl.textContent = '.Sui Key-In';
}

// ─── Hydration guard (suppress disconnected flash on reload) ─────────

let _hydrating = false;

// ─── Wallet Modal ────────────────────────────────────────────────────

let modalOpen = (() => { try { return localStorage.getItem('ski:lift') === '2'; } catch { return false; } })();
let headerCyclerUnmount: (() => void) | null = null;
const suinsCache: Record<string, string> = {}; // address -> name
// Active detail slot: tracks which address + balance is shown in the modal detail
let activeDetailAddr = ''; // currently shown addr in detail slot
let activeDetailSui = 0; // SUI balance of that addr
let activeDetailUsd: number | null = null; // USD balance of that addr
// Per-element generation counter — ensures async DOM updates from showKeyDetail don't
// stomp each other when multiple detail elements (legend top + right pane) are live.
const elementGenerations = new WeakMap<HTMLElement, number>();

/** Format milliseconds remaining as "Xd", "Xh", or "< 1h". */
function fmtTimeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  return hrs > 0 ? `${hrs}h` : '< 1h';
}

// One-time QR cache clear — old white-bg SVGs cached under ski:qr:*
try {
  if (!localStorage.getItem('ski:qr:v8')) {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('ski:qr:'));
    keys.forEach(k => localStorage.removeItem(k));
    localStorage.setItem('ski:qr:v8', '1');
  }
} catch {}

/** Generate (or return cached) QR SVG for a URL. Stored in localStorage. */
async function getQrSvg(url: string, color?: string): Promise<string> {
  const dark = color ?? '#60a5fa';
  const key = `ski:qr:${dark}:${url}`;
  try { const cached = localStorage.getItem(key); if (cached) return cached; } catch {}
  const mod = await import('qrcode');
  const QRCode = (mod as unknown as { default: typeof mod }).default ?? mod;
  const svg = await (QRCode as { toString: (url: string, opts: object) => Promise<string> })
    .toString(url, { type: 'svg', margin: 1, color: { dark, light: '#ffffff' }, errorCorrectionLevel: 'M' });
  try { localStorage.setItem(key, svg); } catch {}
  return svg;
}

/** Generate a QR SVG for a Sui address with a center logo. Uses 'H' error correction to tolerate the overlay.
 *  mode='sui' → blue QR + Sui drop; mode='usd' → green QR + $ sign; mode='bw' → white QR + diamond */
async function _getAddrQrSvg(addr: string, mode: 'sui' | 'usd' | 'bw' | 'btc' = 'sui'): Promise<string> {
  const dark = mode === 'btc' ? '#f7931a' : mode === 'usd' ? '#4ade80' : mode === 'bw' ? '#ffffff' : '#60a5fa';
  const key = `ski:qr:addr:${mode}:${addr}`;
  try { const cached = localStorage.getItem(key); if (cached) return cached; } catch {}
  const mod = await import('qrcode');
  const QRCode = (mod as unknown as { default: typeof mod }).default ?? mod;
  let svg: string = await (QRCode as { toString: (url: string, opts: object) => Promise<string> })
    .toString(addr, { type: 'svg', margin: 1, color: { dark, light: '#ffffff' }, errorCorrectionLevel: 'H' });
  const vbMatch = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (vbMatch) {
    const vw = Number(vbMatch[1]), vh = Number(vbMatch[2]);
    const logoSize = Math.round(vw * 0.22);
    const cx = vw / 2, cy = vh / 2;
    const r = logoSize / 2;
    let logoSvg: string;
    const br = r * 1.15; // slightly bigger logo for presence
    if (mode === 'usd') {
      const fill = '#22c55e';
      logoSvg = `<circle cx="${cx}" cy="${cy}" r="${br + 1}" fill="white"/><circle cx="${cx}" cy="${cy}" r="${br}" fill="${fill}"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="${br * 1.3}" font-weight="700" fill="white">$</text>`;
    } else if (mode === 'btc') {
      const fill = '#f7931a';
      logoSvg = `<circle cx="${cx}" cy="${cy}" r="${br + 1}" fill="white"/><circle cx="${cx}" cy="${cy}" r="${br}" fill="${fill}"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="${br * 1.3}" font-weight="700" fill="white">\u20BF</text>`;
    } else if (mode === 'bw') {
      const d = br * 0.75;
      logoSvg = `<circle cx="${cx}" cy="${cy}" r="${br + 1}" fill="white"/><polygon points="${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}" fill="#1a1a2e" stroke="white" stroke-width="${d * 0.2}"/>`;
    } else {
      // SUI mode — Sui drop
      logoSvg = `<circle cx="${cx}" cy="${cy}" r="${br + 1}" fill="white"/><circle cx="${cx}" cy="${cy}" r="${br}" fill="#4da2ff"/><g transform="translate(${cx - br * 0.62},${cy - br * 0.72}) scale(${(br * 2 * 0.65) / 300})" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
    }
    svg = svg.replace('</svg>', `${logoSvg}</svg>`);
  }
  try { localStorage.setItem(key, svg); } catch {}
  return svg;
}

/** Profile-picture indicator for a key. Clicking toggles Splash gas sponsorship for that address.
 *  - Blue square (has SuiNS): amber glow ring when Splash is active for this address.
 *  - Black diamond (no SuiNS): white sui-drop appears inside when Splash is active.
 */
function keyPfpHtml(addr: string, suinsName: string | null): string {
  const splashOn = isSponsoredAddress(addr);
  const splashClass = splashOn ? ' ski-key-pfp--splash' : '';
  const splashTitle = splashOn ? `Splash active — click to remove` : `Splash — click to activate`;
  const escaped = esc(addr);
  if (suinsName) {
    const bare = suinsName.replace(/\.sui$/, '');
    return `<button type="button" class="ski-key-pfp ski-key-pfp--blue${splashClass}" data-splash-addr="${escaped}" title="${splashTitle} for ${esc(bare)}.sui"><img src="${SUI_DROP_URI}" class="ski-key-pfp-drop" alt=""></button>`;
  }
  const dropOverlay = splashOn ? `<img src="${SUI_DROP_URI}" class="ski-key-pfp-splash-drop" alt="" aria-hidden="true">` : '';
  return `<button type="button" class="ski-key-pfp ski-key-pfp--diamond${splashClass}" data-splash-addr="${escaped}" title="${splashTitle}"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#3a3a5e" stroke="#ffffff" stroke-width="4"/></svg>${dropOverlay}</button>`;
}

/** Subname creator column rendered inside each secondary key card. */
function subnameColHtml(addr: string): string {
  return `<div class="ski-subname-col" data-subname-target="${esc(addr)}">
    <input type="text" class="ski-subname-input" placeholder="sublabel" maxlength="50" spellcheck="false" autocomplete="off">
    <span class="ski-subname-dot">.</span>
    <select class="ski-subname-select" title="Parent domain"><option value="">\u2026</option></select>
    <button type="button" class="ski-subname-btn" title="Mint subname">
      <img src="${SKI_SVG_URI}" alt="" class="ski-subname-btn-icon" aria-hidden="true">
    </button>
  </div>`;
}

/** Copy the primary pfp shape from the connected-key header into the brand slot. */
function syncBrandPfp(connKeyEl: HTMLElement) {
  const slot = document.getElementById('ski-brand-pfp');
  if (!slot) return;
  const pfpCol = connKeyEl.querySelector<HTMLElement>('.ski-detail-active-pfp, .ski-detail-key-column, .ski-detail-key-column--in-wrap');
  if (pfpCol) slot.innerHTML = pfpCol.innerHTML;
}


function showKeyDetail(w: Wallet, detailEl: HTMLElement, connectedAddr: string) {
  const gen = (elementGenerations.get(detailEl) ?? 0) + 1;
  elementGenerations.set(detailEl, gen);
  // Persist live accounts to storage — merge so previously seen addresses are retained
  const liveAddrs = w.accounts.map((a: { address: string }) => normalizeSuiAddress(a.address));
  if (liveAddrs.length) {
    try {
      const existing: string[] = JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]');
      const merged = [...new Set([...existing, ...liveAddrs])];
      localStorage.setItem(`ski:wallet-keys:${w.name}`, JSON.stringify(merged));
    } catch {}
  }

  // Always show the full merged set — stored includes all previously seen addresses
  const storedAddrs: string[] = (() => {
    try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]'); } catch { return []; }
  })();
  let displayAddrs = storedAddrs.length ? storedAddrs : liveAddrs;

  // Prefer the explicitly selected legend-row address when it belongs to this wallet.
  // Otherwise fall back to the wallet's current live account, then the connected addr.
  const normalizedDisplayAddrs = new Set(displayAddrs.map((addr: string) => normalizeSuiAddress(addr)));
  const selectedAddr = connectedAddr ? normalizeSuiAddress(connectedAddr) : '';
  const liveAddr = liveAddrs[0] ? normalizeSuiAddress(liveAddrs[0]) : '';
  const activeAddr = selectedAddr && normalizedDisplayAddrs.has(selectedAddr)
    ? selectedAddr
    : liveAddr && normalizedDisplayAddrs.has(liveAddr)
      ? liveAddr
      : '';
  if (activeAddr) {
    displayAddrs = [
      activeAddr,
      ...displayAddrs.filter((a: string) => normalizeSuiAddress(a) !== activeAddr),
    ];
  }

  // Update active detail balance for the modal logo SVG
  // Use the addr that was passed in (the legend-clicked address or connected addr)
  // to determine which balance to show — this is the address the user selected.
  const _detailAddr0 = connectedAddr || displayAddrs[0] || '';
  if (_detailAddr0 && _detailAddr0 !== activeDetailAddr) {
    activeDetailAddr = _detailAddr0;
    // Use connected wallet's live balance if this is the connected wallet address
    const _wsAddr = getState().address || '';
    if (_detailAddr0.toLowerCase() === _wsAddr.toLowerCase()) {
      activeDetailSui = app.sui;
      activeDetailUsd = app.usd;
    } else {
      // Load from localStorage cache first for instant display
      try {
        const raw = localStorage.getItem(`ski:balances:${_detailAddr0}`);
        if (raw) {
          const c = JSON.parse(raw) as { sui?: number; usd?: number | null };
          activeDetailSui = c.sui ?? 0;
          activeDetailUsd = c.usd ?? null;
        } else { activeDetailSui = 0; activeDetailUsd = null; }
      } catch { activeDetailSui = 0; activeDetailUsd = null; }
      // Async fetch live balance for non-connected address
      const _fetchAddr = _detailAddr0;
      (async () => {
        try {
          const [suiRes, usdcRes, price] = await Promise.all([
            grpcClient.core.getBalance({ owner: _fetchAddr }).catch(() => null),
            grpcClient.core.getBalance({ owner: _fetchAddr, coinType: USDC_TYPE }).catch(() => null),
            fetchSuiPrice(),
          ]);
          if (activeDetailAddr !== _fetchAddr) return; // switched away
          const sui = Number(suiRes?.balance?.balance ?? 0) / 1e9;
          const stable = Number(usdcRes?.balance?.balance ?? 0) / 1e6;
          const usd = price != null ? sui * price + stable : (stable > 0 ? stable : null);
          activeDetailSui = sui;
          activeDetailUsd = usd;
          // Don't cache usd here — refreshPortfolio computes the full total including all tokens.
          // This detail fetch only knows SUI+USDC, so caching its usd would undercount.
          try { localStorage.setItem(`ski:balances:${_fetchAddr}`, JSON.stringify({ sui, stableUsd: stable, t: Date.now() })); } catch {}
          renderModalLogo();
        } catch {}
      })();
    }
    renderModalLogo();
  }

  // Update dot variant — check in-memory cache then localStorage so shape is correct on first render
  if (!displayAddrs.length) {
    updateSkiDot('green-circle');
  } else {
    const cachedName = displayAddrs.map((addr: string) =>
      suinsCache[addr] || (() => { try { return localStorage.getItem(`ski:suins:${addr}`) || ''; } catch { return ''; } })()
    ).find(Boolean);
    updateSkiDot(cachedName ? 'blue-square' : 'black-diamond', cachedName || undefined);
  }

  const DOCS = 'https://docs.sui.io/standards/wallet-standard';
  const LEGACY: Record<string, string> = {
    'signTransactionBlock': 'Legacy — use signTransaction',
    'signAndExecuteTransactionBlock': 'Legacy — use signAndExecuteTransaction',
  };

  const networks = w.chains.filter((c: string) => c.startsWith('sui:'));
  const suiFeatures = Object.keys(w.features)
    .filter((f: string) => f.startsWith('sui:'))
    .map((f: string) => f.replace(/^sui:/, ''));

  const accountChains = new Set(w.accounts.flatMap((a: { chains: readonly string[] }) => [...a.chains]));

  const networksHtml = networks.map((c: string) => {
    const label = c.replace(/^sui:/, '');
    const isActive = accountChains.has(c);
    return `<span class="ski-network-tag${isActive ? ' active' : ''}">${esc(label)}</span>`;
  }).join('');

  const current = suiFeatures.filter((f: string) => !LEGACY[f]);
  const legacy = suiFeatures.filter((f: string) => LEGACY[f]);

  const currentHtml = current.map((f: string) =>
    `<a href="${DOCS}#sui${f.toLowerCase()}" target="_blank" rel="noopener" class="ski-feature-tag">${esc(f)}</a>`
  ).join('');

  const legacyHtml = legacy.map((f: string) =>
    `<a href="${DOCS}#sui${f.toLowerCase()}" target="_blank" rel="noopener" class="ski-feature-tag legacy" title="${esc(LEGACY[f]!)}">${esc(f)}</a>`
  ).join('');

  const sectionHtml = (label: string, count: number, content: string) =>
    `<details class="ski-collapsible-section">
      <summary class="ski-section-summary">
        <span class="ski-section-label">${label}</span>
        <span class="ski-section-count">${count}</span>
        <span class="ski-section-line"></span>
      </summary>
      <div class="ski-feature-list">${content}</div>
    </details>`;

  const retiredSection = legacy.length ? sectionHtml('Legacy', legacy.length, legacyHtml) : '';

  // Build a key card (used for secondary keys; ai is always > 0 in practice)
  const keyCardHtml = (addr: string, ai: number): string => {
    const suinsName: string | null = suinsCache[addr] || (() => { try { return localStorage.getItem(`ski:suins:${addr}`); } catch { return null; } })() || null;
    const scanUrl = `https://suiscan.xyz/mainnet/account/${esc(addr)}`;
    const cls = ai === 0 ? 'ski-detail-active-key' : 'ski-detail-addr-wrap';
    return `<div class="${cls}" data-addr-idx="${ai}" data-full-addr="${esc(addr)}">
      <div class="ski-detail-addr-main">
        ${keyPfpHtml(addr, suinsName)}
        <div class="ski-detail-key-text">
          <span class="ski-detail-suins-slot"></span>
          <div class="ski-detail-addr-row">
            <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="ski-detail-addr-text" title="${esc(addr)}">${esc(truncAddr(addr))}</a>
            <button class="ski-copy-btn" title="Copy address">\u2398</button>
          </div>
        </div>
      </div>
      ${ai > 0 ? subnameColHtml(addr) : ''}
    </div>`;
  };

  const addr0 = displayAddrs[0] ?? '';
  const suinsName0: string | null = addr0 ? (suinsCache[addr0] || (() => { try { return localStorage.getItem(`ski:suins:${addr0}`); } catch { return null; } })() || null) : null;
  const scanUrl0 = addr0 ? `https://suiscan.xyz/mainnet/account/${addr0}` : '';
  const activePfpHtml = addr0
    ? keyPfpHtml(addr0, suinsName0)
    : '<div class="ski-key-pfp ski-key-pfp--green-circle"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg></div>';
  const nameInputHtml = `<input class="ski-create-waap-name-input" type="text" value="name" tabindex="0" onclick="event.stopPropagation()" onfocus="if(this.value==='name')this.value=''" onblur="if(!this.value)this.value='name'"><span class="ski-create-waap-tld">.sui</span>`;
  const activeQrHtml = addr0 ? `<div class="ski-detail-qr" id="ski-detail-qr" data-qr-addr="${esc(addr0)}" title="Receive on Sui: ${esc(addr0)}"></div>` : '';
  const activeTextHtml = addr0 ? `<div class="ski-detail-active-text-row">
        <div class="ski-detail-active-pfp">${activePfpHtml}</div>
        <div class="ski-detail-key-text">
          <span class="ski-detail-suins-slot">${suinsName0 ? '' : nameInputHtml}</span>
          <div class="ski-detail-addr-row">
            <a href="${esc(scanUrl0)}" target="_blank" rel="noopener" class="ski-detail-addr-text" title="${esc(addr0)}">${esc(truncAddr(addr0))}</a>
            <button class="ski-copy-btn" title="Copy address">\u2398</button>
          </div>
        </div>
      </div>` : `<div class="ski-detail-active-text-row">
        <div class="ski-detail-active-pfp">${activePfpHtml}</div>
        <div class="ski-detail-key-text">
          <span class="ski-detail-suins-slot">${nameInputHtml}</span>
          <div class="ski-detail-addr-row">
            <span class="ski-detail-addr-text ski-detail-addr-text--faux">0xHex\u2026Addr</span>
          </div>
        </div>
      </div>`;

  const otherKeysHtml = displayAddrs.slice(1).map((addr: string, i: number) => keyCardHtml(addr, i + 1)).join('');

  const isConnected = displayAddrs[0] === connectedAddr;
  void isConnected; // balance now shown in modal logo SVG
  const balanceCyclerHtml = '';

  detailEl.innerHTML = `
    <div class="ski-detail-header ski-detail-header--keyed" data-detail-wallet="${esc(w.name)}">
      <div class="ski-detail-icon-row"${addr0 ? ` data-addr-idx="0" data-full-addr="${esc(addr0)}"` : ''}>
        <div class="ski-detail-icons-top">
          ${w.icon ? (() => {
            const splashAuth = getSponsorState().auth;
            const activated = !!(splashAuth?.walletName === w.name && new Date(splashAuth.expiresAt).getTime() > Date.now());
            return `<div class="ski-detail-icon-wrap${activated ? ' ski-detail-icon-wrap--activated' : ''}"${!activated ? ` title="Splash all keys in ${esc(w.name)}"` : ''}>
              <img src="${esc(w.icon)}" alt="" class="ski-detail-icon">
              <div class="ski-detail-icon-overlay" aria-hidden="true">
                <img src="${SUI_DROP_URI}" class="ski-detail-icon-overlay-drop" alt="">
              </div>
              <div class="ski-detail-icon-revoke-overlay" aria-hidden="true">
                <svg width="34" height="34" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="3" x2="19" y2="19" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/><line x1="19" y1="3" x2="3" y2="19" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/></svg>
              </div>
              ${activated ? `<div class="ski-revoke-tooltip" aria-hidden="true">Withdraw <span class="ski-revoke-tooltip-name">${esc(w.name)}</span> Splash <img src="${SUI_DROP_URI}" class="ski-revoke-tooltip-drop" alt=""></div>` : ''}
            </div>`;
          })() : ''}
          ${balanceCyclerHtml}
        </div>
        ${activeTextHtml}
      </div>
      ${activeQrHtml}
    </div>
  `;

  // Render other keys (black diamonds) into the slot below the legend
  const otherKeysSlot = document.getElementById('ski-other-keys-slot');
  if (otherKeysSlot) {
    otherKeysSlot.innerHTML = otherKeysHtml ? `<div class="ski-detail-row">${otherKeysHtml}</div>` : '';
    // Collapsed by default
    otherKeysSlot.classList.remove('ski-other-keys--open');
    // Bind copy buttons in other keys
    otherKeysSlot.querySelectorAll('.ski-copy-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = (btn as HTMLElement).closest('[data-full-addr]');
        const addr = row?.getAttribute('data-full-addr') || '';
        if (addr) navigator.clipboard?.writeText(addr).then(() => {
          (btn as HTMLElement).textContent = '\u2713';
          setTimeout(() => { (btn as HTMLElement).textContent = '\u2398'; }, 1500);
        });
      });
    });
  }

  // Add/remove expand arrows on legend rows matching this wallet provider
  const hasOtherKeys = displayAddrs.length > 1;
  document.querySelectorAll<HTMLElement>('.ski-legend-keys-arrow').forEach(el => el.remove());
  if (hasOtherKeys) {
    document.querySelectorAll<HTMLElement>(`.ski-legend-row[data-legend-wallet="${CSS.escape(w.name)}"]`).forEach(row => {
      const iconEl = row.querySelector('.ski-legend-wallet-icon');
      if (!iconEl) return;
      const arrow = document.createElement('button');
      arrow.className = 'ski-legend-keys-arrow';
      arrow.type = 'button';
      arrow.setAttribute('aria-label', 'Toggle other keys');
      arrow.textContent = '\u25B8';
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const slot = document.getElementById('ski-other-keys-slot');
        if (!slot) return;
        slot.classList.toggle('ski-other-keys--open');
        const open = slot.classList.contains('ski-other-keys--open');
        document.querySelectorAll<HTMLElement>('.ski-legend-keys-arrow').forEach(a => {
          a.classList.toggle('ski-legend-keys-arrow--open', open);
        });
      });
      row.style.position = 'relative';
      row.appendChild(arrow);
    });
  }

  // Render gear sections into the dedicated slot above the settings strip
  const gearSlot = document.getElementById('ski-gear-slot');
  const gearRowStrip = document.getElementById('ski-gear-row-strip');
  if (gearSlot) {
    gearSlot.innerHTML = (networks.length || current.length || retiredSection)
      ? `<div class="ski-gear-sections" id="ski-gear-sections" hidden>
          ${networks.length ? sectionHtml('Networks', networks.length, networksHtml) : ''}
          ${current.length ? sectionHtml('Features', current.length, currentHtml) : ''}
          ${retiredSection}
        </div>`
      : '';
  }
  if (gearRowStrip) {
    gearRowStrip.innerHTML = (networks.length || current.length || retiredSection)
      ? `<button class="ski-gear-btn" id="ski-gear-btn" title="Wallet details" aria-expanded="false">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>`
      : '';
  }

  // Unified click handler — splash toggle AND subname mint.
  // Uses onclick (not addEventListener) so repeated showKeyDetail calls don't stack listeners.
  detailEl.onclick = async (e: MouseEvent) => {
    const el = e.target as HTMLElement;

    // ── Splash toggle ───────────────────────────────────────────────────
    const splashBtn = el.closest('[data-splash-addr]') as HTMLButtonElement | null;
    if (splashBtn) {
      e.preventDefault();
      const addr = splashBtn.getAttribute('data-splash-addr');
      if (!addr) return;
      const ws = getState();
      if (!ws.wallet || !ws.account) { showToast('Connect a wallet first'); return; }
      splashBtn.disabled = true;
      try {
        if (!isSponsorActive()) {
          await activateSponsor(ws.wallet, ws.account, addr);
          await addSponsoredEntry(addr);
          showToast('<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash active', true);
        } else if (isSponsoredAddress(addr)) {
          removeSponsoredEntry(addr);
          showToast('Splash removed for this address');
        } else {
          await addSponsoredEntry(addr);
          showToast('<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash added', true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        splashBtn.disabled = false;
      }
      // Refresh splash state on all key shape buttons in-place (detail + other keys)
      const splashRoot = detailEl.closest('.ski-modal') ?? detailEl;
      splashRoot.querySelectorAll<HTMLButtonElement>('[data-splash-addr]').forEach((btn) => {
        const a = btn.getAttribute('data-splash-addr')!;
        const on = isSponsoredAddress(a);
        btn.classList.toggle('ski-key-pfp--splash', on);
        btn.setAttribute('title', on ? 'Splash active — click to remove' : 'Splash — click to activate');
        if (btn.classList.contains('ski-key-pfp--diamond')) {
          const existing = btn.querySelector('.ski-key-pfp-splash-drop');
          if (on && !existing) {
            const img = document.createElement('img');
            img.src = SUI_DROP_URI;
            img.className = 'ski-key-pfp-splash-drop';
            img.setAttribute('aria-hidden', 'true');
            btn.appendChild(img);
          } else if (!on && existing) {
            existing.remove();
          }
        }
      });
      return;
    }

    // ── Subname mint ────────────────────────────────────────────────────
    const subnameBtn = el.closest('.ski-subname-btn') as HTMLButtonElement | null;
    if (subnameBtn) {
      e.preventDefault();
      const col = subnameBtn.closest<HTMLElement>('.ski-subname-col');
      const targetAddr = col?.dataset.subnameTarget ?? '';
      const sel = col?.querySelector<HTMLSelectElement>('.ski-subname-select');
      const inp = col?.querySelector<HTMLInputElement>('.ski-subname-input');
      const parentId = sel?.value ?? '';
      const label = (inp?.value ?? '').trim().toLowerCase();
      const selectedOpt = sel?.options[sel.selectedIndex];

      if (!parentId) { showToast('Select a parent domain'); return; }
      if (!label) { showToast('Enter a subdomain label'); return; }
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
        showToast('Label: lowercase letters, digits, hyphens only');
        return;
      }

      const ws = getState();
      if (!ws.wallet || !ws.account) { showToast('Connect a wallet first'); return; }

      const signAndExec = (ws.wallet.features['sui:signAndExecuteTransaction'] as {
        signAndExecuteTransaction: (args: {
          transaction: Uint8Array;
          account: WalletAccount;
          chain: string;
        }) => Promise<{ digest?: string }>;
      } | undefined)?.signAndExecuteTransaction;
      if (!signAndExec) { showToast('Wallet does not support signAndExecuteTransaction'); return; }

      const parentDomain: OwnedDomain = {
        objectId: parentId,
        name: selectedOpt?.dataset.domainName ?? selectedOpt?.text ?? '',
        kind: (selectedOpt?.dataset.kind ?? 'nft') as 'nft' | 'cap',
        allowLeaf: selectedOpt?.dataset.allowLeaf !== 'false',
        allowNode: selectedOpt?.dataset.allowNode === 'true',
      };
      const subnameType: 'leaf' | 'node' = parentDomain.allowLeaf ? 'leaf' : 'node';

      subnameBtn.disabled = true;
      try {
        // Crown fee: resolve parent domain target, always charge 1 SUI
        const parentName = parentDomain.name.endsWith('.sui') ? parentDomain.name : `${parentDomain.name}.sui`;
        const parentTarget = await resolveNameToAddress(parentName);
        const feeRecipient = parentTarget ?? ws.address;
        const tx = buildSubnameTx(parentDomain, label, targetAddr, subnameType, undefined, feeRecipient);
        const txBytes = await tx.build({ client: grpcClient });
        const chain = ws.account.chains.find((c: string) => c.startsWith('sui:')) ?? 'sui:mainnet';
        await signAndExec({ transaction: txBytes, account: ws.account, chain });
        const cleanParent = (selectedOpt?.dataset.domainName ?? '').replace(/\.sui$/, '');
        showToast(`Subname created — ${label}.${cleanParent}.sui`);
        if (inp) inp.value = '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        subnameBtn.disabled = false;
      }
      return;
    }
  };

  // Share the same click handler on the other-keys slot (splash toggle + subname mint)
  if (otherKeysSlot) otherKeysSlot.onclick = detailEl.onclick;

  // Bind gear toggle (button in settings strip, sections in gear slot)
  document.getElementById('ski-gear-btn')?.addEventListener('click', () => {
    const sections = document.getElementById('ski-gear-sections');
    const btn = document.getElementById('ski-gear-btn');
    if (!sections) return;
    const open = !sections.hidden;
    sections.hidden = open;
    btn?.setAttribute('aria-expanded', String(!open));
    btn?.classList.toggle('active', !open);
  });

  // Bind copy buttons
  detailEl.querySelectorAll('.ski-copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = (btn as HTMLElement).closest('[data-full-addr]');
      const addr = row?.getAttribute('data-full-addr') || '';
      if (addr) navigator.clipboard?.writeText(addr).then(() => {
        (btn as HTMLElement).textContent = '\u2713';
        setTimeout(() => { (btn as HTMLElement).textContent = '\u2398'; }, 1500);
      });
    });
  });

  // Populate QR code for the active key's receive address
  const qrEl = detailEl.querySelector('#ski-detail-qr') as HTMLElement | null;
  if (qrEl) {
    const qrAddr = qrEl.dataset.qrAddr;
    if (qrAddr) {
      const qrMode = suinsName0 ? 'sui' : 'bw';
      _getAddrQrSvg(qrAddr, qrMode as 'sui' | 'usd').then(svg => {
        qrEl.innerHTML = svg;
      }).catch(() => {});
    }
  }

  // Wallet icon wrap: sponsor the extension using the keyed-in wallet (or revoke if active)
  const walletIconWrapEl = detailEl.querySelector<HTMLElement>('.ski-detail-icon-wrap');
  if (walletIconWrapEl) {
    walletIconWrapEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Already activated → revoke
      if (walletIconWrapEl.classList.contains('ski-detail-icon-wrap--activated')) {
        deactivateSponsor();
        showToast('Splash revoked');
        render();
        if (modalOpen) renderModal();
        return;
      }

      // Use the currently keyed-in wallet as the gas sponsor — not the viewed extension
      const ws = getState();
      if (!ws.wallet || !ws.account) { showToast('Sign in first'); return; }

      // Silently enumerate accounts in the viewed extension (beneficiaries)
      let accounts: readonly WalletAccount[] = w.accounts;
      if (!accounts.length && 'standard:connect' in w.features) {
        try {
          const cf = w.features['standard:connect'] as {
            connect: (i?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
          };
          ({ accounts } = await cf.connect({ silent: true }));
        } catch {}
      }
      if (!accounts.length) { showToast('No accounts found'); return; }

      walletIconWrapEl.style.opacity = '0.5';
      const allEntries = accounts.map((a) => ({
        address: a.address,
        name: suinsCache[a.address] || (() => { try { return localStorage.getItem(`ski:suins:${a.address}`); } catch { return null; } })() || null,
      }));

      try {
        // Activate the keyed-in wallet as sponsor — skipped if auth is already in memory
        if (!isSponsorActive()) {
          await activateSponsor(ws.wallet, ws.account, undefined, allEntries);
        }
        // Enroll every known address across all wallet extensions as a beneficiary
        const n = enrollAllKnownAddresses();
        walletIconWrapEl.classList.add('ski-detail-icon-wrap--activated');
        showToast(`<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash \u00b7 ${n} key${n !== 1 ? 's' : ''} covered`, true);
        render();
        if (detailEl) showKeyDetail(w, detailEl, connectedAddr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        walletIconWrapEl.style.opacity = '';
      }
    });
  }

  // Resolve SuiNS names for all displayed addresses
  displayAddrs.forEach((addr: string, ai: number) => {
    const renderName = (name: string) => {
      const wrap = detailEl.querySelector(`[data-addr-idx="${ai}"]`);
      const slot = wrap?.querySelector('.ski-detail-suins-slot');
      if (slot) {
        const bare = name.replace(/\.sui$/, '');
        const suiSkiUrl = `https://${bare}.sui.ski`;
        slot.innerHTML = `<span class="ski-suins-qr-wrap"><a href="${esc(suiSkiUrl)}" target="_blank" rel="noopener" class="ski-detail-suins">${esc(bare)}</a><span class="ski-suins-qr-popup" hidden></span></span>`;
        const qrPopup = slot.querySelector<HTMLElement>('.ski-suins-qr-popup');
        if (qrPopup) {
          getQrSvg(suiSkiUrl).then((svg) => { qrPopup.innerHTML = svg; }).catch(() => {});
          const qrWrap = qrPopup.parentElement!;
          qrWrap.addEventListener('mouseenter', () => qrPopup.removeAttribute('hidden'));
          qrWrap.addEventListener('mouseleave', () => qrPopup.setAttribute('hidden', ''));
        }
      }
    };
    if (suinsCache[addr]) {
      renderName(suinsCache[addr]);
    } else {
      try {
        const stored = localStorage.getItem(`ski:suins:${addr}`);
        if (stored) { suinsCache[addr] = stored; renderName(stored); }
      } catch {}
    }
    lookupSuiNS(addr).then((name: string | null) => {
      if (name && elementGenerations.get(detailEl) === gen) {
        suinsCache[addr] = name;
        try { localStorage.setItem(`ski:suins:${addr}`, name); } catch {}
        renderName(name);
        // Upgrade pfp from diamond to blue-square now that we have a SuiNS name
        const wrap = detailEl.querySelector(`[data-addr-idx="${ai}"]`);
        const pfpEl = wrap?.querySelector('.ski-key-pfp');
        if (pfpEl && !pfpEl.classList.contains('ski-key-pfp--blue')) {
          const tmp = document.createElement('div');
          tmp.innerHTML = keyPfpHtml(addr, name);
          const newPfp = tmp.firstElementChild;
          if (newPfp) pfpEl.replaceWith(newPfp);
        }
        // Upgrade inline pfp next to name/address
        if (ai === 0) {
          const activePfpEl = detailEl.querySelector('.ski-detail-active-pfp .ski-key-pfp');
          if (activePfpEl && !activePfpEl.classList.contains('ski-key-pfp--blue')) {
            const tmp2 = document.createElement('div');
            tmp2.innerHTML = keyPfpHtml(addr, name);
            const newActivePfp = tmp2.firstElementChild;
            if (newActivePfp) activePfpEl.replaceWith(newActivePfp);
          }
        }
        updateSkiDot('blue-square', name);
      } else if (name) {
        suinsCache[addr] = name;
        try { localStorage.setItem(`ski:suins:${addr}`, name); } catch {}
      }
    });
  });

  // Populate subname domain dropdowns with domains owned by the connected address.
  // Only secondary key cards have .ski-subname-col elements.
  if (detailEl.querySelector('.ski-subname-col')) {
    const fetchGen = gen;
    fetchOwnedDomains(getState().address || normalizeSuiAddress(connectedAddr)).then((domains: OwnedDomain[]) => {
      if (fetchGen !== elementGenerations.get(detailEl)) return;
      detailEl.querySelectorAll<HTMLSelectElement>('.ski-subname-select').forEach((sel) => {
        if (domains.length) {
          sel.innerHTML = domains.map((d) => {
            const bare = d.name.replace(/\.sui$/, '');
            const suffix = d.kind === 'cap'
              ? (d.allowLeaf && d.allowNode ? ' [cap]' : d.allowLeaf ? ' [leaf cap]' : ' [node cap]')
              : '';
            return `<option value="${esc(d.objectId)}"
              data-domain-name="${esc(d.name)}"
              data-kind="${d.kind}"
              data-allow-leaf="${d.allowLeaf}"
              data-allow-node="${d.allowNode}"
            >${esc(bare)}${suffix}</option>`;
          }).join('');
        } else {
          sel.innerHTML = '<option value="" disabled>No domains</option>';
          sel.disabled = true;
          const btn = sel.closest('.ski-subname-col')?.querySelector<HTMLButtonElement>('.ski-subname-btn');
          if (btn) btn.disabled = true;
        }
      });
    });
  }
}

// ─── Layout preference ───────────────────────────────────────────────

export type ModalLayout = 'splash' | 'list' | 'layout2';

function getModalLayout(): ModalLayout {
  try { return (localStorage.getItem('ski:modal-layout') as ModalLayout) || 'splash'; } catch { return 'splash'; }
}

/**
 * Programmatically set the modal layout.
 *  'splash'  — Splash legend view with layout toggle (default)
 *  'list'    — Wallet list view with layout toggle
 *  'layout2' — Wallet list, no Splash settings strip (clean embed mode)
 */
export function setModalLayout(mode: ModalLayout): void {
  try { localStorage.setItem('ski:modal-layout', mode); } catch {}
  if (modalOpen) renderModal();
}

/** Shape badge for the wallet-list layout (right-side indicator per row). */
function walletListShape(w: Wallet): string {
  const liveAddrs = w.accounts.map((a: { address: string }) => a.address);
  const addrs = liveAddrs.length ? liveAddrs : (() => {
    try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return [] as string[]; }
  })();
  const hasSuins = addrs.some((addr) => suinsCache[addr] || !!localStorage.getItem(`ski:suins:${addr}`));
  const hasAddrs = addrs.length > 0;
  const splashState = getSponsorState();
  const isBeneficiary = addrs.some((addr) => isSponsoredAddress(addr) && splashState.auth?.address !== addr);
  const dropOverlay = isBeneficiary
    ? `<span class="splash-drop-badge"><img src="${SUI_DROP_URI}" class="splash-drop-img" alt=""></span>` : '';
  const isSponsor = !!(splashState.auth?.walletName === w.name && new Date(splashState.auth.expiresAt).getTime() > Date.now());
  const sponsorClass = isSponsor ? ' ski-list-shape--sponsor' : '';
  const deviceClass = app.splashSponsor ? ' ski-list-shape--device-sponsor' : '';
  const hoverDrop = (isSponsor || app.splashSponsor)
    ? `<img src="${SUI_DROP_URI}" alt="" class="ski-list-shape-hover-drop">` : '';
  if (hasSuins) {
    return `<span class="ski-list-shape ski-list-shape--blue${sponsorClass}${deviceClass}">${hoverDrop}${dropOverlay}</span>`;
  } else if (hasAddrs) {
    return `<span class="ski-list-shape ski-list-shape--diamond${sponsorClass}${deviceClass}"><svg width="23" height="23" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#3a3a5e" stroke="#ffffff" stroke-width="4"/></svg>${hoverDrop}${dropOverlay}</span>`;
  }
  // WaaP: always black diamond even before first connect
  if (/waap/i.test(w.name)) {
    return `<span class="ski-list-shape ski-list-shape--diamond${sponsorClass}${deviceClass}"><svg width="23" height="23" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#3a3a5e" stroke="#ffffff" stroke-width="4"/></svg>${hoverDrop}${dropOverlay}</span>`;
  }
  // Green circle — no known addresses. Google/Discord: wrap with social X badge.
  const greenSvg = `<svg width="23" height="23" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg>`;
  if (/google/i.test(w.name) || /discord/i.test(w.name)) {
    return `<span class="ski-list-shape-group"><span class="ski-waap-x ski-list-shape-x" aria-hidden="true">𝕏</span><span class="ski-list-shape ski-list-shape--green${deviceClass}">${greenSvg}${hoverDrop}</span></span>`;
  }
  return `<span class="ski-list-shape ski-list-shape--green${deviceClass}">${greenSvg}${hoverDrop}</span>`;
}

/** Legend shown at the bottom-left of the modal: sponsor → covered keys.
 *  When no Splash is active, shows unconnected wallet options for discovery. */
function buildSplashLegend(): string {
  const auth = getSponsorState().auth;
  const splashActive = !!(auth && new Date(auth.expiresAt).getTime() > Date.now());

  const DROP_G = `<g transform="translate(11,3) scale(0.088)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
  const LEGEND_DIAMOND = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_BLUE    = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><rect x="2" y="2" width="43" height="43" rx="6" fill="#4da2ff" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_GREEN   = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_DIAMOND_DROP = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="5"/>${DROP_G}</svg>`;
  const LEGEND_BLUE_DROP    = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><rect x="2" y="2" width="43" height="43" rx="6" fill="#4da2ff" stroke="#ffffff" stroke-width="5"/>${DROP_G}</svg>`;
  const LEGEND_GREEN_DROP   = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/>${DROP_G}</svg>`;
  const connectedAddr = getState().address;

  const allWallets = getSuiWallets();
  if (!allWallets.length) return '';

  const isGreen = (w: Wallet) => {
    const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
    return w.accounts.length === 0 && stored.length === 0;
  };

  let rowIdx = 0;

  const wrapScroll = (items: string) =>
    `<div class="ski-legend-scroll">${items}</div>`;

  // Build the dedicated WaaP "create new" row for the green tier.
  // Clicking it opens WaaP's UI to create or switch accounts.
  const buildWaapCreateRow = () => {
    const waapWallet = allWallets.find(w => /waap/i.test(w.name));
    if (!waapWallet) return '';
    const iconHtml = waapWallet.icon
      ? `<img class="ski-legend-wallet-icon" src="${esc(waapWallet.icon)}" alt="${esc(waapWallet.name)}">`
      : `<span></span>`;
    const html = `<div class="ski-legend-row ski-legend-row--create-waap" data-legend-idx="${rowIdx}" data-legend-wallet="${esc(waapWallet.name)}" data-legend-create-waap="true" tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${LEGEND_GREEN}</span><span class="ski-legend-row-mid"><span class="ski-legend-name ski-legend-name--create-waap">+ new WaaP</span></span>${iconHtml}</div>`;
    rowIdx++;
    return html;
  };

  // Without Splash: one row per stored address (with SuiNS + hex), green circle for unused wallets.
  // Sorted: diamond (addr, no SuiNS) → blue square (addr + SuiNS) → green circle (never used).
  // WaaP without address is omitted from regular entries; the dedicated
  // WaaP row below keeps it pinned as the first green-tier action.
  if (!splashActive) {
    type Entry = { walletName: string; icon: string; address: string | null; suinsName: string | null; tier: 0 | 1 | 2 };
    const entries: Entry[] = [];
    for (const w of allWallets) {
      const liveAddrs = (w.accounts as unknown as { address: string }[]).map((a) => a.address);
      const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
      const addrs = [...new Set([...liveAddrs, ...stored])];
      if (addrs.length === 0) {
        if (/waap/i.test(w.name)) continue;
        entries.push({ walletName: w.name, icon: w.icon || '', address: null, suinsName: null, tier: 2 });
      } else {
        for (const addr of addrs) {
          const suinsName = suinsCache[addr] || (() => { try { return localStorage.getItem(`ski:suins:${addr}`); } catch { return null; } })() || null;
          entries.push({ walletName: w.name, icon: w.icon || '', address: addr, suinsName, tier: suinsName ? 1 : 0 });
        }
      }
    }
    const lastKeyinAddr = (() => { try { return localStorage.getItem('ski:last-keyin-addr'); } catch { return null; } })();
    entries.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // Within the same tier, last-used address floats to top (becomes group head)
      if (lastKeyinAddr) {
        const aLast = a.address === lastKeyinAddr ? 0 : 1;
        const bLast = b.address === lastKeyinAddr ? 0 : 1;
        if (aLast !== bLast) return aLast - bLast;
      }
      const aW = /waap/i.test(a.walletName) ? 0 : 1;
      const bW = /waap/i.test(b.walletName) ? 0 : 1;
      if (aW !== bW) return aW - bW;
      return a.walletName.localeCompare(b.walletName);
    });
    const buildEntryRow = (e: Entry) => {
      const isConn = !!(e.address && e.address === connectedAddr);
      const shapeHtml = e.tier === 0
        ? (isConn ? LEGEND_DIAMOND_DROP : LEGEND_DIAMOND)
        : e.tier === 1
          ? (isConn ? LEGEND_BLUE_DROP : LEGEND_BLUE)
          : (isConn ? LEGEND_GREEN_DROP : LEGEND_GREEN);
      const social = socialIconSvg(e.walletName);
      const hasSuins = !!e.suinsName;
      const nameHtml = hasSuins
        ? (() => { const bare = e.suinsName!.replace(/\.sui$/, ''); return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-legend-name">${esc(bare)}</a>`; })()
        : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
      // Blue square (has SuiNS): show only name, no hex address
      // Black diamond (no SuiNS): show hex address
      const addrCell = hasSuins
        ? ''
        : e.address
          ? `<span class="ski-legend-addr" data-copy-addr="${esc(e.address)}" data-scan-addr="${esc(e.address)}" title="${esc(e.address)}">${esc(truncAddr(e.address))}</span>`
          : `<span class="ski-legend-name ski-legend-name--wallet">${esc(e.walletName)}</span>`;
      const iconCell = /waap/i.test(e.walletName) && e.address
        ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${waapProviderIcon(e.address)}</span>`
        : social
          ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
          : (e.icon ? `<img class="ski-legend-wallet-icon" src="${esc(e.icon)}" alt="${esc(e.walletName)}">` : `<span></span>`);
      const addrAttr = e.address ? ` data-legend-addr="${esc(e.address)}"` : '';
      return `<div class="ski-legend-row" data-legend-idx="${rowIdx++}" data-legend-wallet="${esc(e.walletName)}"${addrAttr} tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${shapeHtml}</span><span class="ski-legend-row-mid">${nameHtml}</span>${addrCell}${iconCell}</div>`;
    };

    // Group entries by tier with collapsible arrows
    const ARROW = `<button class="ski-legend-group-arrow" type="button" aria-label="Expand group">\u25B8</button>`;
    const tierGroups = new Map<number, Entry[]>();
    for (const e of entries) { const arr = tierGroups.get(e.tier) ?? []; arr.push(e); tierGroups.set(e.tier, arr); }
    let allHtml = '';
    for (const tier of [0, 1, 2]) {
      const group = tierGroups.get(tier);
      const extraBefore = tier === 2 ? buildWaapCreateRow() : '';
      if (!group || group.length === 0) {
        if (extraBefore) allHtml += extraBefore;
        continue;
      }
      const rowsHtml = group.map(buildEntryRow);
      if (extraBefore) rowsHtml.unshift(extraBefore);
      if (rowsHtml.length === 1) {
        allHtml += rowsHtml[0];
      } else {
        const hasBlueSquare = tierGroups.has(1) && (tierGroups.get(1)!.length > 0);
        const openClass = tier === 2 && !hasBlueSquare ? ' ski-legend-group--open' : '';
        allHtml += `<div class="ski-legend-group${openClass}"><div class="ski-legend-group-head">${ARROW}${rowsHtml[0]}</div><div class="ski-legend-group-body"><div class="ski-legend-group-inner">${rowsHtml.slice(1).join('')}</div></div></div>`;
      }
    }
    return `<div class="ski-splash-legend">
    <div class="ski-legend-targets">${wrapScroll(allHtml)}</div>
  </div>`;
  }

  // Splash active — green-circle rows appended at bottom of legend (unconnected wallets only)
  const greenWallets = allWallets.filter(w => isGreen(w)).sort((a, b) => {
    const aW = /waap/i.test(a.name) ? 0 : 1;
    const bW = /waap/i.test(b.name) ? 0 : 1;
    if (aW !== bW) return aW - bW;
    return a.name.localeCompare(b.name);
  });
  // Always include WaaP in green section even if it has stored keys
  const waapW = allWallets.find(w => /waap/i.test(w.name));
  if (waapW && !greenWallets.includes(waapW)) greenWallets.unshift(waapW);
  const walletRows = greenWallets.map((w) => {
    const social = socialIconSvg(w.name);
    const col2 = social
      ? `<span class="ski-waap-x ski-legend-social-badge" aria-hidden="true">𝕏</span>`
      : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
    const iconCell = social
      ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
      : (w.icon ? `<img class="ski-legend-wallet-icon" src="${esc(w.icon)}" alt="${esc(w.name)}">` : `<span></span>`);
    const html = `<div class="ski-legend-row" data-legend-idx="${rowIdx}" data-legend-wallet="${esc(w.name)}" tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${LEGEND_GREEN}</span><span class="ski-legend-row-mid">${col2}<span class="ski-legend-name ski-legend-name--wallet">${esc(w.name)}</span></span>${iconCell}</div>`;
    rowIdx++;
    return html;
  }).join('');

  // Splash is active — build full legend with sponsor header and covered addresses
  const name = suinsCache[auth!.address] || (() => { try { return localStorage.getItem(`ski:suins:${auth!.address}`); } catch { return null; } })();
  const sponsorDisplay = name ?? truncAddr(auth!.address);

  // Build address → wallet map for icon lookup
  const addrToWallet = new Map<string, Wallet>();
  for (const w of allWallets) {
    for (const acc of w.accounts) addrToWallet.set(acc.address, w);
    const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
    for (const addr of stored) { if (!addrToWallet.has(addr)) addrToWallet.set(addr, w); }
  }

  const list = (auth!.sponsoredList ?? []).filter((e) => new Date(e.expiresAt).getTime() > Date.now());

  type LegendEntry = { entry: typeof list[0]; primaryName: string | null; tier: 0 | 1 | 2 };
  const annotated: LegendEntry[] = list.map((e) => {
    const primaryName = e.suinsName
      || suinsCache[e.address]
      || (() => { try { return localStorage.getItem(`ski:suins:${e.address}`); } catch { return null; } })()
      || null;
    const tier: 0 | 1 | 2 = !e.address ? 2 : primaryName ? 1 : 0;
    return { entry: e, primaryName, tier };
  });
  annotated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // Within same tier: WaaP-associated entries first
    const aWallet = addrToWallet.get(a.entry.address);
    const bWallet = addrToWallet.get(b.entry.address);
    const aW = aWallet && /waap/i.test(aWallet.name) ? 0 : 1;
    const bW = bWallet && /waap/i.test(bWallet.name) ? 0 : 1;
    return aW - bW;
  });

  const buildSponsoredRow = ({ entry: e, primaryName, tier }: LegendEntry) => {
    const isConn2 = !!(e.address && e.address === connectedAddr);
    const shapeHtml = tier === 2
      ? (isConn2 ? LEGEND_GREEN_DROP : LEGEND_GREEN)
      : tier === 1
        ? (isConn2 ? LEGEND_BLUE_DROP : LEGEND_BLUE)
        : (isConn2 ? LEGEND_DIAMOND_DROP : LEGEND_DIAMOND);
    const nameHtml = primaryName
      ? (() => { const bare = primaryName.replace(/\.sui$/, ''); return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-legend-name">${esc(bare)}</a>`; })()
      : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
    const wIcon = addrToWallet.get(e.address);
    const addrCell = `<span class="ski-legend-addr" data-copy-addr="${esc(e.address)}" data-scan-addr="${esc(e.address)}" title="${esc(e.address)}">${esc(truncAddr(e.address))}</span>`;
    const social = wIcon ? socialIconSvg(wIcon.name) : null;
    const iconCell = social
      ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
      : (wIcon?.icon ? `<img class="ski-legend-wallet-icon" src="${esc(wIcon.icon)}" alt="${esc(wIcon.name)}">` : `<span></span>`);
    const walletAttr = wIcon ? ` data-legend-wallet="${esc(wIcon.name)}"` : '';
    const html = `<div class="ski-legend-row" data-legend-idx="${rowIdx}" data-legend-addr="${esc(e.address)}"${walletAttr} tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${shapeHtml}</span><span class="ski-legend-row-mid">${nameHtml}</span>${addrCell}${iconCell}</div>`;
    rowIdx++;
    return html;
  };

  // Group sponsored entries by tier with collapsible arrows
  const ARROW_S = `<button class="ski-legend-group-arrow" type="button" aria-label="Expand group">\u25B8</button>`;
  const sTierGroups = new Map<number, LegendEntry[]>();
  for (const le of annotated) { const arr = sTierGroups.get(le.tier) ?? []; arr.push(le); sTierGroups.set(le.tier, arr); }
  let sponsoredHtml = '';
  for (const tier of [0, 1, 2]) {
    const group = sTierGroups.get(tier);
    if (!group || group.length === 0) continue;
    const rowsHtml = group.map(buildSponsoredRow);
    if (rowsHtml.length === 1) {
      sponsoredHtml += rowsHtml[0];
    } else {
      const openClass = tier === 2 ? ' ski-legend-group--open' : '';
      sponsoredHtml += `<div class="ski-legend-group${openClass}"><div class="ski-legend-group-head">${ARROW_S}${rowsHtml[0]}</div><div class="ski-legend-group-body"><div class="ski-legend-group-inner">${rowsHtml.slice(1).join('')}</div></div></div>`;
    }
  }

  const targetsHtml = annotated.length === 0 && greenWallets.length === 0
    ? `<span class="ski-legend-target ski-legend-target--open">all keys</span>`
    : wrapScroll(sponsoredHtml + walletRows);

  return `<div class="ski-splash-legend">
    <div class="ski-legend-header">
      <img src="${SUI_DROP_URI}" alt="" class="ski-legend-drop">
      <span class="ski-legend-sponsor">${esc(sponsorDisplay)}</span>
      <span class="ski-legend-verb">covers</span>
    </div>
    <div class="ski-legend-targets">${targetsHtml}</div>
  </div>`;
}

let activeLegendIdx = -1;
// Long-press detail lock: when true, hover doesn't update the right pane
let detailLocked = false;
let lockedWallet: Wallet | null = null;

function activateLegendRow(idx: number, fromHover = false) {
  // Respect lock: on passive hover, highlight the row but leave right pane alone
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
  const row = rows.find(r => r.dataset.legendIdx === String(idx));
  if (fromHover && detailLocked) {
    rows.forEach((r) => { r.classList.remove('active'); r.setAttribute('aria-selected', 'false'); });
    row?.classList.add('active');
    row?.setAttribute('aria-selected', 'true');
    activeLegendIdx = idx;
    return;
  }
  rows.forEach((r) => { r.classList.remove('active'); r.setAttribute('aria-selected', 'false'); });
  if (!row) return;
  row.classList.add('active');
  row.setAttribute('aria-selected', 'true');
  activeLegendIdx = idx;
  const walletName = row.dataset.legendWallet;
  // Remember last key-in for next modal open
  if (walletName) try { localStorage.setItem('ski:last-keyin', walletName); } catch {}
  const legendAddr = row.dataset.legendAddr;
  if (legendAddr) try { localStorage.setItem('ski:last-keyin-addr', legendAddr); } catch {}
  const detailEl = document.getElementById('ski-modal-detail');

  // The hovered legend address (if any) is passed as connectedAddr so it floats to top
  const hoverAddr = row.dataset.legendAddr || getState().address;

  if (detailEl) detailEl.classList.remove('ski-detail--key-hover');
  // "+ new WaaP" row → show placeholder detail pane (input + faux address)
  if (row.dataset.legendCreateWaap && detailEl) {
    const wallet = walletName ? getSuiWallets().find((w) => w.name === walletName) : null;
    const iconSrc = wallet?.icon || '';
    detailEl.innerHTML = `
      <div class="ski-detail-header ski-detail-header--keyed" data-detail-wallet="${esc(walletName || '')}" data-detail-create-waap="true">
        <div class="ski-detail-icon-row">
          <div class="ski-detail-icons-top">
            ${iconSrc ? `<div class="ski-detail-icon-wrap"><img src="${esc(iconSrc)}" alt="" class="ski-detail-icon"></div>` : ''}
          </div>
          <div class="ski-detail-active-text-row">
            <div class="ski-detail-active-pfp"><div class="ski-key-pfp ski-key-pfp--green-circle"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg></div></div>
            <div class="ski-detail-key-text">
              <span class="ski-detail-suins-slot"><input class="ski-create-waap-name-input" type="text" value="name" tabindex="0" onclick="event.stopPropagation()" onfocus="if(this.value==='name')this.value=''" onblur="if(!this.value)this.value='name'"><span class="ski-create-waap-tld">.sui</span></span>
              <div class="ski-detail-addr-row">
                <span class="ski-detail-addr-text ski-detail-addr-text--faux">0xHex\u2026Addr</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    activeDetailAddr = '';
    activeDetailSui = 0;
    activeDetailUsd = null;
    updateSkiDot('green-circle');
    renderModalLogo();
    return;
  }
  if (walletName) {
    const wallet = getSuiWallets().find((w) => w.name === walletName);
    if (wallet && detailEl) showKeyDetail(wallet, detailEl, hoverAddr);
  }
}

// ─── Balance cycler ──────────────────────────────────────────────────
//
// buildBalanceCyclerRows() renders the inner HTML for the cycler.
// mountBalanceCycler(el) mounts it onto any external element and keeps
// it in sync with the live portfolio via the externalCyclers registry
// (updated on every render() call).

function buildBalanceCyclerRows(): string {
  if (balView === 'usd') {
    const usdText = fmtUsd(app.usd);
    return `<div class="ski-header-bal-primary ski-header-bal-usd">${esc(usdText || '--')}</div>`;
  }
  const suiText = fmtSui(app.sui);
  return `<div class="ski-header-bal-primary ski-header-bal-sui">${esc(suiText)}<img src="${SUI_DROP_URI}" class="ski-header-bal-sui-icon" alt="SUI" aria-label="SUI"></div>`;
}

function buildDetailBalanceCyclerHtml(): string {
  return `<button type="button" id="ski-detail-balance-cycler" class="ski-detail-balance-cycler ski-balance-cycler" title="Toggle SUI / USD">${buildBalanceCyclerRows()}</button>`;
}

/** Single source of truth: update every balance display in unison. */
function syncBalanceDisplays() {
  const detailEl = document.getElementById('ski-detail-balance-cycler');
  if (detailEl) detailEl.innerHTML = buildBalanceCyclerRows();
  externalCyclers.forEach((el) => {
    if (document.contains(el)) el.innerHTML = buildBalanceCyclerRows();
    else externalCyclers.delete(el);
  });
  renderSkiBtn();
  renderModalLogo();
  renderSkiMenu();
}

// Registry of externally mounted cycler elements
const externalCyclers = new Set<HTMLElement>();

/**
 * Mount a live SUI/USD balance cycler onto any element.
 * The element becomes a styled, clickable toggle that auto-updates
 * whenever the portfolio refreshes.
 *
 * @returns unmount function — call it to detach and clean up
 */
export function mountBalanceCycler(el: HTMLElement): () => void {
  el.classList.add('ski-balance-cycler');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('title', 'Toggle SUI / USD');
  el.innerHTML = buildBalanceCyclerRows();
  externalCyclers.add(el);

  function toggle(e: Event) {
    e.stopPropagation();
    balView = balView === 'sui' ? 'usd' : 'sui';
    try { localStorage.setItem('ski:bal-pref', balView); } catch {}
    syncBalanceDisplays();
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Enter' || e.key === ' ') toggle(e); }

  el.addEventListener('click', toggle);
  el.addEventListener('keydown', onKey as EventListener);

  return () => {
    externalCyclers.delete(el);
    el.removeEventListener('click', toggle);
    el.removeEventListener('keydown', onKey as EventListener);
    el.classList.remove('ski-balance-cycler');
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.removeAttribute('title');
  };
}

async function lockInIdentity(): Promise<void> {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) return;
  const issuedAt = new Date().toISOString();
  const name = app.suinsName
    ? app.suinsName.replace(/\.sui$/, '') + '.sui'
    : truncAddr(ws.address);
  const message = [
    `Lock in ${name}`,
    '',
    ws.address,
    '',
    `Nonce: ${crypto.randomUUID()}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
  try {
    const result = await signPersonalMessage(new TextEncoder().encode(message));
    // Detect WaaP auth method from account label
    const isWaap = /waap/i.test(ws.walletName || '');
    const waapProvider = isWaap && ws.account?.label
      ? detectWaapProvider(ws.account.label)
      : null;
    // Cache proof locally (7-day expiry)
    const proof = {
      address: ws.address,
      suinsName: app.suinsName || null,
      signature: result.signature,
      message,
      issuedAt,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      walletName: ws.walletName || null,
      waapProvider,
    };
    try { localStorage.setItem('ski:session', JSON.stringify(proof)); } catch {}
    if (waapProvider) storeWaapProvider(ws.address, waapProvider);
    showToast(`Locked in as ${esc(name)}`);
    render();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.toLowerCase().includes('reject')) showToast(msg || 'Signing failed');
  }
}

function renderModal(): void {
  if (!els.modal) return;
  const connectedName = getState().walletName;

  if (!modalOpen) {
    els.modal.innerHTML = '';
    return;
  }

  // Align modal right edge with the SKI button's right edge, top below the header
  const anchorEl = els.skiBtn || els.skiDot || els.widget;
  const anchorRect = anchorEl?.getBoundingClientRect();
  const modalRight = anchorRect
    ? Math.max(0, window.innerWidth - anchorRect.right)
    : 16;
  const modalTop = anchorRect
    ? Math.round(anchorRect.bottom + 8)
    : 61;
  // Match modal width to the SKI button bar width (left edge to right edge of bar)
  const barEl = els.widget || els.profile;
  const barWidth = barEl ? barEl.getBoundingClientRect().width : 0;
  const skiBtn = els.skiBtn || els.skiDot;
  const skiBtnRect = skiBtn?.getBoundingClientRect();
  // Width = from left edge of profile/widget to right edge of SKI button
  const totalBarWidth = (skiBtnRect && barEl)
    ? Math.round(skiBtnRect.right - barEl.getBoundingClientRect().left)
    : barWidth;
  const modalWidth = Math.max(totalBarWidth, 300);
  const widthStyle = modalWidth > 0 ? `width:${modalWidth}px;` : '';
  const modalPos = `right:${modalRight}px;top:${modalTop}px;${widthStyle}`;

  const wallets = getSuiWallets().sort((a, b) => {
    const aW = /waap/i.test(a.name) ? 0 : 1;
    const bW = /waap/i.test(b.name) ? 0 : 1;
    if (aW !== bW) return aW - bW;
    return a.name.localeCompare(b.name);
  });

  if (!wallets.length) {
    els.modal.innerHTML = `
      <div class="ski-modal-overlay open" id="ski-modal-overlay">
        <div class="ski-modal" style="animation:ski-modal-in .2s ease;${modalPos}">
          <div class="ski-modal-header">
            <div class="ski-modal-header-left">
              ${getInlineSkiSvg()}
              <div class="ski-modal-titles">
                <h2 class="ski-modal-title">.Sui Key-In</h2>
                <p class="ski-modal-tagline">once,<br>everywhere</p>
              </div>
            </div>
            <button id="ski-modal-close">&times;</button>
          </div>
          <div class="ski-no-wallets">
            <p class="ski-no-wallets-msg">No Sui wallets detected.</p>
            <p class="ski-no-wallets-sub">Install a Sui wallet extension to get started.</p>
          </div>
        </div>
      </div>`;
    document.getElementById('ski-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('ski-modal-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'ski-modal-overlay') closeModal();
    });
    return;
  }

  const layout = getModalLayout();
  const legendHtml = layout === 'splash' ? buildSplashLegend() : '';
  const leftColHtml = layout === 'splash'
    ? `<div class="ski-modal-legend-col${connectedName || legendHtml ? ' ski-modal-legend-col--live' : ''}">
          <div id="ski-legend-slot">${legendHtml}</div>
        </div>`
    : `<div class="ski-modal-legend-col ski-modal-legend-col--live">
          <div class="ski-modal-wallets">
            ${wallets.map((w) => {
              const social = socialIconSvg(w.name);
              const iconHtml = social
                ? `<span style="width:38px;height:38px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center">${social}</span>`
                : (w.icon ? `<img src="${esc(w.icon)}" alt="" style="width:38px;height:38px;border-radius:8px;flex-shrink:0">` : '<span style="width:38px;height:38px;flex-shrink:0"></span>');
              return `<button class="wk-dd-item${w.name === connectedName ? ' active' : ''}" data-wallet-name="${esc(w.name)}" type="button">
              ${iconHtml}
              <span class="ski-walletlist-name">${esc(w.name)}</span>
              ${walletListShape(w)}
            </button>`;
            }).join('')}
          </div>
        </div>`;

  // layout2 = clean embed mode — no settings strip
  const settingsStrip = layout !== 'layout2' ? `<div class="ski-modal-settings-strip">
      <div class="ski-gear-row" id="ski-gear-row-strip"></div>
      <label class="ski-layout-toggle" title="${layout === 'splash' ? 'Switch to wallet list' : 'Switch to splash view'}">
        <input type="checkbox" id="ski-layout-check"${layout === 'splash' ? ' checked' : ''}>
        <span class="ski-layout-track"><span class="ski-layout-thumb"></span></span>
        <span class="ski-layout-label">Splash</span>
      </label>
    </div>` : '';

  // Splash button for the brand column header (activate / deactivate)
  const ws = getState();
  const isWaapHeader = /waap/i.test(ws.walletName) && !!ws.walletIcon && !!ws.address;
  const sponsorAuth = getSponsorState().auth;
  const isActiveSponsor = isSponsorActive() && sponsorAuth?.address === ws.address;
  let headerSplashHtml = '';
  if (ws.walletName) {
    if (isActiveSponsor) {
      const msLeft = new Date(sponsorAuth!.expiresAt).getTime() - Date.now();
      const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
      headerSplashHtml = `<span class="ski-header-splash ski-header-splash--on">
          <button class="ski-header-splash-drop-btn" id="ski-header-splash-off" type="button" aria-label="Revoke Splash">
            <img src="${SUI_DROP_URI}" class="ski-header-splash-drop" aria-hidden="true">
          </button>
          <span class="ski-header-splash-days">${daysLeft}d</span>
        </span>`;
    } else if (!isSponsorActive()) {
      headerSplashHtml = `<span class="ski-header-splash">
          <button class="ski-header-splash-drop-btn" id="ski-header-splash-on" type="button" aria-label="Enable Splash">
            <img src="${SUI_DROP_URI}" class="ski-header-splash-drop" aria-hidden="true">
          </button>
        </span>`;
    }
  }

  els.modal.innerHTML = `
    <div class="ski-modal-overlay open" id="ski-modal-overlay">
      <div class="ski-modal" style="animation:ski-modal-in .2s ease;${modalPos}">
        <div class="ski-modal-header">
          <div class="ski-modal-header-brand">
            <div class="ski-modal-header-brand-top">
              <div class="ski-modal-header-left">
                <div class="ski-brand-logo-row">
                  <div class="ski-logo-btn-wrap">
                    <button type="button" id="ski-logo-btn" class="ski-logo-btn" title="Scan to open sui.ski" aria-label="Show QR code for sui.ski">
                      ${getInlineSkiSvg()}
                    </button>
                    <div id="ski-brand-pfp" class="ski-brand-pfp">${ws.address ? keyPfpHtml(ws.address, app.suinsName || null) : ''}</div>
                    <div id="ski-brand-balance" class="ski-brand-balance"></div>
                    <div id="ski-qr-popup" class="ski-qr-popup" hidden>
                      <img src="${SUI_SKI_QR_URI}" alt="sui.ski QR code" class="ski-qr-img">
                      <span class="ski-qr-url">sui.ski</span>
                    </div>
                  </div>
                </div>
                <div class="ski-modal-titles">
                  <h2 class="ski-modal-title">${app.suinsName ? '.Sui Key-In' : 'SKI'}</h2>
                  <p class="ski-modal-tagline">once,<br>everywhere${headerSplashHtml}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ski-modal-col ski-modal-detail" id="ski-modal-detail"></div>
        <div class="ski-modal-body">
          ${leftColHtml}
          <div id="ski-other-keys-slot"></div>
        </div>
        <div id="ski-gear-slot"></div>
        ${settingsStrip}
      </div>
    </div>
  `;

  document.getElementById('ski-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ski-modal-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'ski-modal-overlay') closeModal();
  });
  // Mount balance cycler on the brand balance slot
  headerCyclerUnmount?.();
  const headerBalEl = document.getElementById('ski-brand-balance');
  if (headerBalEl) headerCyclerUnmount = mountBalanceCycler(headerBalEl);

  // SKI logo → toggle USD/SUI balance view when connected with SuiNS; QR popup otherwise
  const logoBtn = document.getElementById('ski-logo-btn');
  const qrPopup = document.getElementById('ski-qr-popup');
  logoBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (getState().address && app.suinsName) {
      balView = balView === 'usd' ? 'sui' : 'usd';
      try { localStorage.setItem('ski:bal-pref', balView); } catch {}
      syncBalanceDisplays();
      return;
    }
    if (!qrPopup) return;
    const hidden = qrPopup.hasAttribute('hidden');
    qrPopup.toggleAttribute('hidden', !hidden);
  });
  // Close QR popup on outside click
  document.addEventListener('click', function closeQr(e) {
    if (!qrPopup || qrPopup.hasAttribute('hidden')) { document.removeEventListener('click', closeQr); return; }
    if (!qrPopup.contains(e.target as Node) && e.target !== logoBtn) {
      qrPopup.setAttribute('hidden', '');
      document.removeEventListener('click', closeQr);
    }
  });

  // Populate the detail pane immediately — no placeholder flash.
  // If connected, show that wallet; otherwise show the first blue-square
  // (has SuiNS name) wallet so the detail pane isn't empty.
  const connectedWallet = connectedName ? getSuiWallets().find((w) => w.name === connectedName) : null;
  const initialDetailEl = document.getElementById('ski-modal-detail');
  if (initialDetailEl && connectedWallet) {
    showKeyDetail(connectedWallet, initialDetailEl, getState().address);
  } else if (initialDetailEl && !connectedWallet) {
    // Find the first wallet+address that has a cached SuiNS name (blue square),
    // then fall back to first with any address (black diamond),
    // then fall back to WaaP (green circle).
    const allW = getSuiWallets();
    let defaultWallet: Wallet | null = null;
    let defaultAddr = '';
    let fallbackWallet: Wallet | null = null;
    let fallbackAddr = '';
    for (const w of allW) {
      const liveAddrs = (w.accounts as unknown as { address: string }[]).map((a) => a.address);
      const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
      for (const addr of [...new Set([...liveAddrs, ...stored])]) {
        if (!fallbackWallet) { fallbackWallet = w; fallbackAddr = addr; }
        const name = (() => { try { return localStorage.getItem(`ski:suins:${addr}`); } catch { return null; } })();
        if (name) { defaultWallet = w; defaultAddr = addr; break; }
      }
      if (defaultWallet) break;
    }
    const pick = defaultWallet || fallbackWallet || allW.find(w => /waap/i.test(w.name)) || null;
    const pickAddr = defaultWallet ? defaultAddr : fallbackWallet ? fallbackAddr : '';
    if (pick) showKeyDetail(pick, initialDetailEl, pickAddr);
  }

  // Layout toggle — persists preference and re-renders
  document.getElementById('ski-layout-check')?.addEventListener('change', (e) => {
    const splash = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem('ski:modal-layout', splash ? 'splash' : 'list'); } catch {}
    renderModal();
  });

  // Header Splash drop — activate
  document.getElementById('ski-header-splash-on')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const { wallet, account } = getState();
      if (!wallet || !account) throw new Error('No wallet connected');
      await activateSponsor(wallet, account);
      showToast('<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash active &middot; 7 days', true);
      render();
      renderModal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
      btn.disabled = false;
    }
  });

  // Header Splash button — revoke
  document.getElementById('ski-header-splash-off')?.addEventListener('click', () => {
    deactivateSponsor();
    showToast('Splash deactivated');
    render();
    renderModal();
  });

  if (layout === 'splash') {
    // Activate the legend row for the last key-in, connected wallet, or first row
    requestAnimationFrame(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
      if (!rows.length) return;
      // Find the target row by last-keyin or connected wallet, then read its data-legend-idx
      let targetRow = rows[0];
      const lastKeyin = (() => { try { return localStorage.getItem('ski:last-keyin'); } catch { return null; } })();
      const lastKeyinAddr = (() => { try { return localStorage.getItem('ski:last-keyin-addr'); } catch { return null; } })();
      if (lastKeyin) {
        // Prefer matching by address (more specific), fall back to wallet name
        const byAddr = lastKeyinAddr ? rows.find(r => r.dataset.legendAddr === lastKeyinAddr) : null;
        const byName = rows.find(r => r.dataset.legendWallet === lastKeyin);
        targetRow = byAddr || byName || targetRow;
      } else if (connectedName) {
        const found = rows.find(r => r.dataset.legendWallet === connectedName);
        if (found) targetRow = found;
      }
      const targetIdx = parseInt(targetRow.dataset.legendIdx || '0', 10);
      activateLegendRow(targetIdx);
      // Populate right pane immediately — no "Hover a key" on open
      const detailEl = document.getElementById('ski-modal-detail');
      if (detailEl) {
        const wName = targetRow.dataset.legendWallet;
        const w = wName ? getSuiWallets().find((w) => w.name === wName) : null;
        if (w && wName !== connectedName) showKeyDetail(w, detailEl, targetRow.dataset.legendAddr || getState().address);
        else if (connectedName) {
          const cw = getSuiWallets().find((w) => w.name === connectedName);
          if (cw) showKeyDetail(cw, detailEl, getState().address);
        }
      }
    });
  } else {
    // List / layout2: show the connected wallet's detail immediately
    requestAnimationFrame(() => {
      const detailEl = document.getElementById('ski-modal-detail');
      const first = connectedName
        ? getSuiWallets().find((w) => w.name === connectedName) ?? getSuiWallets()[0]
        : getSuiWallets()[0];
      if (first && detailEl) showKeyDetail(first, detailEl, getState().address);
      document.querySelector<HTMLElement>(`.wk-dd-item[data-wallet-name="${CSS.escape(first?.name ?? '')}"]`)?.focus();
    });
  }
}

export function openModal(focusFirst = false) {
  // Close the SKI menu if open — modal and menu are mutually exclusive
  if (app.skiMenuOpen) { app.skiMenuOpen = false; }
  modalOpen = true;
  try { localStorage.setItem('ski:lift', '2'); } catch {}
  els.widget?.classList.add('ski-modal-active');
  _renderDotBtn();
  renderModal();
  // Defer portfolio refresh so its render() callback doesn't double-render the modal
  if (getState().address) requestAnimationFrame(() => refreshPortfolio(true));
  if (focusFirst) {
    requestAnimationFrame(() => {
      const active = document.querySelector<HTMLElement>('.ski-legend-row.active')
        ?? document.querySelector<HTMLElement>('.ski-legend-row');
      active?.focus();
    });
  }
}

function closeModal() {
  modalOpen = false;
  try { localStorage.setItem('ski:lift', '0'); } catch {}
  detailLocked = false;
  lockedWallet = null;
  activeDetailAddr = '';
  activeDetailSui = 0;
  activeDetailUsd = null;
  headerCyclerUnmount?.();
  headerCyclerUnmount = null;
  els.widget?.classList.remove('ski-modal-active');
  if (els.modal) els.modal.innerHTML = '';
  _renderDotBtn();
}

/**
 * Soft-deactivate the current wallet without calling its standard:disconnect.
 * Used internally when we want to switch away while keeping that wallet dormant.
 */
function deactivateCurrent(): void {
  const { walletName } = getState();
  if (/waap/i.test(walletName)) {
    deactivate(); // keep WaaP OAuth session alive
  } else if (getState().wallet) {
    // fire-and-forget full disconnect for non-WaaP wallets
    disconnect().catch(() => {});
  }
}

/**
 * WaaP-specific connect path: check for a fingerprint-encrypted cached proof
 * first.  If the same device previously authenticated as a WaaP address:
 *   1. If WaaP still has the account in-memory (dormant session) → activate
 *      directly, zero modals.
 *   2. If in-memory is empty but we have an OAuth snapshot → restore those
 *      localStorage keys and try a silent connect (WaaP finds its own session).
 *   3. If both fail → fall back to normal selectWallet() (OAuth modal opens).
 */
async function tryWaapProofConnect(wallet: Wallet): Promise<void> {
  type RawAccount = { address: string; chains: readonly string[]; label?: string };

  // Fast path: WaaP already has accounts in-memory — activate directly, zero network calls.
  const liveAccounts = wallet.accounts as unknown as RawAccount[];
  if (liveAccounts.length > 0) {
    closeModal();
    deactivateCurrent();
    activateAccount(wallet, liveAccounts[0] as import('@wallet-standard/base').WalletAccount);
    return;
  }

  try {
    const [{ getDeviceId }, { getWaapProof, restoreWaapOAuth }] = await Promise.all([
      import('./fingerprint.js'),
      import('./waap-proof.js'),
    ]);
    const { visitorId } = await getDeviceId();
    const proof = await getWaapProof(visitorId);

    if (proof) {
      // Path 1: WaaP already has the account (session is dormant/alive in-memory).
      const cached = liveAccounts.find(
        (a) => normalizeSuiAddress(a.address) === normalizeSuiAddress(proof.address),
      );
      if (cached) {
        closeModal();
        deactivateCurrent();
        activateAccount(wallet, cached as import('@wallet-standard/base').WalletAccount);
        return;
      }

      // Path 2: Restore the OAuth snapshot so WaaP can find its own session,
      // then attempt a silent connect — should succeed without showing the modal.
      if (proof.oauthSnapshot) {
        restoreWaapOAuth(proof.oauthSnapshot);
      }
      closeModal();
      deactivateCurrent();
      try {
        await connect(wallet);
      } catch (err) {
        showToast('Failed to connect: ' + _errMsg(err));
      }
      return;
    }
  } catch { /* fingerprint or import failure — fall through */ }

  // No valid proof for this device — normal flow (WaaP OAuth modal will open).
  selectWallet(wallet);
}

/** Extract a human-readable error message from any thrown value. */
function _errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

async function selectWallet(wallet: Wallet) {
  // WaaP shortcut: if WaaP already has accounts in-memory, activate directly
  // instead of going through connect() which can throw in already-connected state.
  if (/waap/i.test(wallet.name) && wallet.accounts.length > 0) {
    closeModal();
    deactivateCurrent();
    activateAccount(wallet, wallet.accounts[0]);
    return;
  }

  closeModal();
  try {
    // When switching away from WaaP, use deactivate() (soft) rather than
    // disconnect() so WaaP's OAuth session stays alive for dormant reuse.
    // For all other wallets, do a full disconnect.
    const current = getState();
    if (current.wallet) {
      if (/waap/i.test(current.walletName)) {
        deactivate();
      } else {
        try { await disconnect(); } catch {}
      }
    }
    // Skip silent connect — this is always an explicit user action, so
    // go straight to the wallet's approval UI (Phantom popup, etc.).
    // autoReconnect() still uses silent for page-load restore.
    await connect(wallet, { skipSilent: true });
  } catch (err) {
    showToast('Failed to connect: ' + _errMsg(err));
  }
}

// ─── Portfolio (gRPC balance fetch + GraphQL SuiNS) ──────────────────

const USDC_TYPE   = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const NS_TYPE     = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
const WAL_TYPE    = '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL';

// Known stablecoin coinTypes (grouped under $ icon)
const STABLE_TYPES = new Set([
  USDC_TYPE,
  '0xcf72ec52c0f8ddead746252481fb44ff6e8485a39b803825bde6b00d77cdb0bb::fud::FUD', // not stable, placeholder
]);
// Extract short token name from coinType: "0xabc::module::NAME" → "NAME"
function coinShortName(coinType: string): string {
  const parts = coinType.split('::');
  return parts.length >= 3 ? parts[parts.length - 1] : coinType.slice(0, 8);
}
// Decimals per coinType — fetched on-chain and cached
// One-time purge of stale decimals cache (NS was incorrectly cached as 9)
try { if (!localStorage.getItem('ski:dec:v2')) { localStorage.removeItem('ski:decimals'); localStorage.setItem('ski:dec:v2', '1'); } } catch {}
const _decimalsCache: Record<string, number> = {
  ...(() => { try { const c = JSON.parse(localStorage.getItem('ski:decimals') ?? '{}'); return typeof c === 'object' ? c : {}; } catch { return {}; } })(),
  // Hardcoded values always win
  [USDC_TYPE]: 6,
  [NS_TYPE]: 6,
};
function coinDecimals(coinType: string): number {
  return _decimalsCache[coinType] ?? 9;
}
const _coinMetaCache: Record<string, { name?: string; symbol?: string; iconUrl?: string }> = (() => {
  try { return JSON.parse(localStorage.getItem('ski:coin-meta') ?? '{}'); } catch { return {}; }
})();

async function _fetchMissingDecimals(coinTypes: string[]) {
  const unknown = coinTypes.filter(ct => !(ct in _decimalsCache) || !(ct in _coinMetaCache));
  if (!unknown.length) return;
  await Promise.all(unknown.map(async ct => {
    try {
      const r = await fetch(grpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoinMetadata', params: [ct] }),
      });
      const d = await r.json() as { result?: { decimals?: number; name?: string; symbol?: string; iconUrl?: string } };
      if (d.result) {
        if (d.result.decimals != null) _decimalsCache[ct] = d.result.decimals;
        _coinMetaCache[ct] = { name: d.result.name, symbol: d.result.symbol, iconUrl: d.result.iconUrl };
      }
    } catch {}
  }));
  try { localStorage.setItem('ski:decimals', JSON.stringify(_decimalsCache)); } catch {}
  try { localStorage.setItem('ski:coin-meta', JSON.stringify(_coinMetaCache)); } catch {}
}
/** Wallet coin balances for display */
export interface WalletCoin { symbol: string; balance: number; coinType: string; isStable: boolean }
let walletCoins: WalletCoin[] = [];
type CoinChip = { icon: string; val: number; html: string; key: string; colorCls: string; tooltip?: string };
const _coinChipsCache: CoinChip[] = [];
let selectedCoinSymbol: string | null = (() => {
  try { return (localStorage.getItem('ski:bal-pref') as string) === 'sui' ? null : 'USD'; } catch { return 'USD'; }
})();
let _userManuallySelectedCoin = false;
let pendingSendAmount = '';

// ─── Swap output ────────────────────────────────────────────────────
const SWAP_OUT_OPTIONS = [
  { key: 'usd',  label: 'USD',  coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', decimals: 6 },
  { key: 'sui',  label: 'SUI',  coinType: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', decimals: 9 },
  { key: 'gold', label: 'Gold', coinType: '0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM', decimals: 9 },
] as const;
let swapOutputKey: string = (() => { try { return localStorage.getItem('ski:swap-out') || 'usd'; } catch { return 'usd'; } })();
function _persistSwapOutput() { try { localStorage.setItem('ski:swap-out', swapOutputKey); } catch {} }
let _swapQuotes: Record<string, { returnAmount: string; quote: unknown }> = {}; // key → quote
let _swapQuoteTimer: ReturnType<typeof setTimeout> | null = null;
let _swapSelectOpen = false;
const _BF_AGG = 'https://aggregator.api.sui-prod.bluefin.io';
const _BF_SOURCES = 'deepbook_v3,bluefin,momentum,cetus,aftermath,flowx,flowx_v3,kriya,kriya_v3,turbos';

function _getSwapInCoinType(): string {
  const sym = selectedCoinSymbol ?? 'SUI';
  if (sym === 'USD' || sym === 'USDC') return SWAP_OUT_OPTIONS[0].coinType;
  if (sym === 'SUI') return SWAP_OUT_OPTIONS[1].coinType;
  const wc = walletCoins.find(c => c.symbol === sym);
  return wc?.coinType ?? SWAP_OUT_OPTIONS[1].coinType;
}
function _getSwapInDecimals(): number {
  const ct = _getSwapInCoinType();
  if (ct.includes('::usdc::')) return 6;
  if (ct.includes('::ns::')) return 6;
  return 9;
}

async function _fetchSwapQuote(amountInDecimal: string, tokenIn: string, tokenOut: string) {
  const params = new URLSearchParams({ amount: amountInDecimal, from: tokenIn, to: tokenOut, sources: _BF_SOURCES });
  const res = await fetch(`${_BF_AGG}/v2/quote?${params}`);
  if (!res.ok) return null;
  const q = await res.json() as { returnAmount?: string; [k: string]: unknown };
  if (!q.returnAmount || Number(q.returnAmount) <= 0) return null;
  return { returnAmount: q.returnAmount!, quote: q };
}

function _fmtUsd(amt: number): string {
  if (amt <= 0) return '0';
  if (amt < 100) return amt.toFixed(2);
  if (amt < 10_000) return amt.toFixed(0);
  return (amt / 1_000).toFixed(1) + 'k';
}

const _SWAP_ICONS: Record<string, string> = {
  usd: '<svg viewBox="0 0 20 20" width="22" height="22"><circle cx="10" cy="10" r="9" fill="#22c55e" stroke="#fff" stroke-width="1.5"/><text x="10" y="10" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="#fff">$</text></svg>',
  sui: `<img src="${SUI_DROP_URI}" width="22" height="22" style="vertical-align:middle" alt="SUI">`,
  gold: `<img src="${AU_ICON_URI}" width="22" height="22" style="vertical-align:middle;border-radius:50%" alt="Au">`,
};

function _quoteToUsd(key: string, returnAmount: string): string {
  const amt = Number(returnAmount);
  if (amt <= 0) return '';
  if (key === 'usd') return `$${_fmtUsd(amt)}`;
  if (key === 'sui') {
    const p = suiPriceCache?.price ?? 0;
    return p > 0 ? `$${_fmtUsd(amt * p)}` : `${_fmtUsd(amt)} SUI`;
  }
  if (key === 'gold') {
    const p = getTokenPrice('XAUM') ?? 0;
    return p > 0 ? `$${_fmtUsd(amt * p)}` : `${_fmtUsd(amt)} XAUm`;
  }
  return _fmtUsd(amt);
}

function _renderSwapSelect() {
  const el = document.getElementById('wk-swap-select');
  if (!el) return;
  const inType = _getSwapInCoinType();
  const selected = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey)!;
  const selectedQuote = _swapQuotes[swapOutputKey];
  const selDisplay = selectedQuote ? _quoteToUsd(swapOutputKey, selectedQuote.returnAmount) : '';
  const isSame = selected.coinType === inType;
  let optionsHtml = '';
  const _outUsdTip = (key: string, label: string) => {
    const chip = _coinChipsCache.find(c => c.colorCls === `wk-coin-item--${key}`);
    if (chip && chip.val > 0) {
      const usd = chip.val < 100 ? chip.val.toFixed(2) : chip.val < 10_000 ? chip.val.toFixed(0) : (chip.val / 1_000).toFixed(1) + 'k';
      return `$${usd} ${label}`;
    }
    if (key === 'sui' && app.sui > 0) {
      const p = suiPriceCache?.price ?? 0;
      const usd = p > 0 ? app.sui * p : 0;
      return usd > 0 ? `$${usd < 100 ? usd.toFixed(2) : usd.toFixed(0)} ${label}` : label;
    }
    return label;
  };
  if (_swapSelectOpen) {
    optionsHtml = '<div class="wk-swap-options">';
    for (const o of SWAP_OUT_OPTIONS) {
      const activeCls = o.key === swapOutputKey ? ' wk-swap-opt--active' : '';
      optionsHtml += `<button class="wk-swap-opt wk-swap-opt--${o.key}${activeCls}" data-key="${esc(o.key)}" type="button" title="${esc(_outUsdTip(o.key, o.label))}">${_SWAP_ICONS[o.key] ?? ''}</button>`;
    }
    optionsHtml += '</div>';
  }

  el.innerHTML = `<button class="wk-swap-trigger wk-swap-trigger--${swapOutputKey}" type="button" id="wk-swap-trigger" title="${esc(_outUsdTip(swapOutputKey, selected.label))}">${_SWAP_ICONS[swapOutputKey] ?? ''}</button>${optionsHtml}`;
}

function _updateSwapEstimates() {
  // Update all option labels with latest quotes
  _renderSwapSelect();
}

function _usdToTokenAmount(usdVal: number): number {
  const sym = selectedCoinSymbol ?? 'SUI';
  if (sym === 'USD' || sym === 'USDC') return usdVal;
  if (sym === 'SUI') {
    const p = suiPriceCache?.price ?? 0;
    return p > 0 ? usdVal / p : 0;
  }
  const tp = getTokenPrice(sym);
  return tp && tp > 0 ? usdVal / tp : 0;
}

function _debounceSwapQuote() {
  if (_swapQuoteTimer) clearTimeout(_swapQuoteTimer);
  _swapQuotes = {};
  _updateSwapEstimates();
  const val = pendingSendAmount;
  if (!val || Number(val) <= 0) return;
  const usdVal = Number(val);
  const tokenAmount = _usdToTokenAmount(usdVal);
  if (tokenAmount <= 0) return;
  const inType = _getSwapInCoinType();
  const amtDec = String(BigInt(Math.floor(tokenAmount * Math.pow(10, _getSwapInDecimals()))));
  _swapQuoteTimer = setTimeout(async () => {
    const fetches = SWAP_OUT_OPTIONS.filter(o => o.coinType !== inType).map(async o => {
      try {
        const q = await _fetchSwapQuote(amtDec, inType, o.coinType);
        if (q) _swapQuotes[o.key] = q;
      } catch {}
    });
    await Promise.all(fetches);
    _updateSwapEstimates();
  }, 500);
}

function _isStableCoin(coinType: string): boolean {
  const name = coinShortName(coinType).toUpperCase();
  return name === 'USDC' || name === 'USDT' || name === 'DAI' || name === 'AUSD' || name === 'BUCK' || name === 'USDY';
}

function normalizeSuiAddress(addr: string): string {
  let hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  hex = hex.padStart(64, '0');
  return '0x' + hex;
}

async function lookupSuiNS(address: string): Promise<string | null> {
  try {
    const normalized = normalizeSuiAddress(address);
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){ address(address:$a){ defaultNameRecord{domain} } }`,
        variables: { a: normalized },
      }),
    });
    const json = await res.json();
    const name = json?.data?.address?.defaultNameRecord?.domain;
    return (name && typeof name === 'string') ? name : null;
  } catch {
    return null;
  }
}

/**
 * Enroll every known wallet address as a Splash gas beneficiary.
 * Sweeps live accounts and localStorage-remembered addresses across all
 * registered wallet extensions, skipping the active sponsor's own address.
 * Returns the number of unique addresses queued. No-op if no sponsor is active.
 */
export function enrollAllKnownAddresses(): number {
  if (!isSponsorActive()) return 0;
  const sponsorAddr = getSponsorState().auth!.address;
  const seen = new Set<string>();
  for (const w of getSuiWallets()) {
    const live = (w.accounts as unknown as { address: string }[]).map((a) => a.address);
    const remembered: string[] = (() => {
      try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]'); } catch { return []; }
    })();
    for (const addr of [...live, ...remembered]) {
      if (addr && addr !== sponsorAddr && !seen.has(addr)) {
        seen.add(addr);
        addSponsoredEntry(addr).catch(() => {});
      }
    }
  }
  return seen.size;
}

let lastPortfolioMs = 0;
let portfolioInFlight = false;
let _lastMutationMs = (() => { try { return Number(sessionStorage.getItem('ski:last-mutation') ?? 0); } catch { return 0; } })();
function _setMutationMs() { _lastMutationMs = Date.now(); try { sessionStorage.setItem('ski:last-mutation', String(_lastMutationMs)); } catch {} }

// SUI/USD price cache — refreshed at most once every 5 minutes; seeded from localStorage so mobile survives Binance failures
let suiPriceCache: { price: number; fetchedAt: number } | null = (() => {
  try {
    const raw = localStorage.getItem('ski:sui-price');
    if (raw) {
      const p = JSON.parse(raw) as { price: number; fetchedAt: number };
      if (p.price > 0) return p; // use regardless of age — better than nothing
    }
  } catch {}
  return null;
})();

// Balance display preference: 'sui' shows SUI primary, 'usd' shows USD primary
let balView: 'sui' | 'usd' = (() => {
  try { return (localStorage.getItem('ski:bal-pref') as 'sui' | 'usd') || 'usd'; } catch { return 'usd'; }
})();
let _dwalletCheckInFlight = false;
let networkView: 'sui' | 'btc' = (() => {
  try { return (localStorage.getItem('ski:network-pref') as 'sui' | 'btc') || 'sui'; } catch { return 'sui'; }
})();

let _networkSelectOpen = false;
const _NETWORK_ICON_SUI = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17" fill="#4da2ff" stroke="white" stroke-width="3"/><g transform="translate(20,20) scale(0.065)" fill="white"><path d="M-85-85C-50-130 0-100 0-70C0-40-50-50-50-20C-50 10 0 0 40-30" stroke="white" stroke-width="30" fill="none" stroke-linecap="round"/></g></svg>`;
const _NETWORK_ICON_BTC = BTC_ICON_SVG;
const _NETWORK_OPTIONS: Array<{ key: 'sui' | 'btc'; label: string; icon: string }> = [
  { key: 'sui', label: 'Sui', icon: `<img src="${SUI_DROP_URI}" class="wk-dd-address-network-icon" alt="Sui">` },
  { key: 'btc', label: 'Bitcoin', icon: `<img src="${BTC_ICON_URI}" class="wk-dd-address-network-icon" alt="BTC">` },
];

function _renderNetworkSelect() {
  const el = document.getElementById('wk-network-select');
  if (!el) return;
  const selected = _NETWORK_OPTIONS.find(o => o.key === networkView)!;
  let optionsHtml = '';
  if (_networkSelectOpen) {
    optionsHtml = '<div class="wk-dd-network-options">';
    for (const o of _NETWORK_OPTIONS) {
      const activeCls = o.key === networkView ? ' wk-dd-network-opt--active' : '';
      optionsHtml += `<button class="wk-dd-network-opt wk-dd-network-opt--${o.key}${activeCls}" data-network="${o.key}" type="button" title="${o.label}">${o.icon}</button>`;
    }
    optionsHtml += '</div>';
  }
  el.innerHTML = `<button class="wk-dd-network-trigger wk-dd-network-trigger--${networkView}" type="button" id="wk-network-trigger" title="${selected.label}">${selected.icon}</button>${optionsHtml}`;
}

// Token price cache — maps symbol → { price, fetchedAt }
// CoinGecko IDs for known Sui tokens
const _COINGECKO_IDS: Record<string, string> = { NS: 'suins-token', WAL: 'walrus-2', DEEP: 'deep', XAUM: 'matrixdock-gold', IKA: 'ika' };
// Conservative default prices so dust filtering works before live prices arrive.
// These are intentionally LOW — better to undervalue and filter dust than overvalue and show it.
const _DEFAULT_TOKEN_PRICES: Record<string, number> = { NS: 0.02, WAL: 0.08, DEEP: 0.03, XAUM: 4900, IKA: 0.01 };
let tokenPriceCache: Record<string, { price: number; fetchedAt: number }> = (() => {
  try {
    const raw = localStorage.getItem('ski:token-prices');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, { price: number; fetchedAt: number }>;
      // Filter out stale entries (> 1 hour)
      const now = Date.now();
      for (const k of Object.keys(parsed)) {
        if (!parsed[k]?.price || now - parsed[k].fetchedAt > 3600_000) delete parsed[k];
      }
      return parsed;
    }
  } catch {}
  return {};
})();

function getTokenPrice(symbol: string): number | null { return tokenPriceCache[symbol]?.price ?? _DEFAULT_TOKEN_PRICES[symbol] ?? null; }
function getNsTokenPrice(): number | null { return getTokenPrice('NS'); }

/** Fetch prices for all non-SUI, non-stable tokens via CoinGecko + DexScreener fallback. */
async function fetchTokenPrices(): Promise<void> {
  const now = Date.now();
  // Skip if all known tokens are fresh
  const stale = Object.keys(_COINGECKO_IDS).filter(s => !tokenPriceCache[s] || now - tokenPriceCache[s].fetchedAt > 5 * 60 * 1000);
  if (!stale.length) return;

  const cacheToken = (symbol: string, p: number) => {
    tokenPriceCache[symbol] = { price: p, fetchedAt: Date.now() };
  };
  const persist = () => {
    try { localStorage.setItem('ski:token-prices', JSON.stringify(tokenPriceCache)); } catch {}
  };

  // CoinGecko: fetch all known tokens in one call
  const cgIds = Object.entries(_COINGECKO_IDS).filter(([s]) => stale.includes(s));
  const cgIdStr = cgIds.map(([, id]) => id).join(',');
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=sui,${cgIdStr}&vs_currencies=usd`);
    if (r.ok) {
      const d = await r.json() as Record<string, { usd?: number }>;
      // Opportunistically update SUI price
      const suiP = d.sui?.usd;
      if (suiP && Number.isFinite(suiP) && suiP > 0 && (!suiPriceCache || Date.now() - suiPriceCache.fetchedAt > 60_000)) {
        suiPriceCache = { price: suiP, fetchedAt: Date.now() };
        try { localStorage.setItem('ski:sui-price', JSON.stringify(suiPriceCache)); } catch {}
      }
      for (const [symbol, cgId] of cgIds) {
        const p = d[cgId]?.usd;
        if (p && Number.isFinite(p) && p > 0) cacheToken(symbol, p);
      }
    }
  } catch {}

  // DexScreener fallback for any still-missing tokens
  const dexTargets: [string, string][] = [
    ['NS', NS_TYPE],
    ['WAL', WAL_TYPE],
  ];
  for (const [symbol, coinType] of dexTargets) {
    if (tokenPriceCache[symbol] && now - tokenPriceCache[symbol].fetchedAt < 5 * 60 * 1000) continue;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${coinType}`);
      if (r.ok) {
        const d = await r.json() as { pairs?: Array<{ priceUsd?: string }> };
        const p = parseFloat(d.pairs?.[0]?.priceUsd ?? '');
        if (Number.isFinite(p) && p > 0) cacheToken(symbol, p);
      }
    } catch {}
  }

  persist();
}

async function fetchSuiPrice(): Promise<number | null> {
  const now = Date.now();
  if (suiPriceCache && now - suiPriceCache.fetchedAt < 5 * 60 * 1000) return suiPriceCache.price;

  const persist = (p: number) => {
    suiPriceCache = { price: p, fetchedAt: now };
    try { localStorage.setItem('ski:sui-price', JSON.stringify(suiPriceCache)); } catch {}
    return p;
  };

  const valid = (p: unknown): number => {
    const n = typeof p === 'string' ? parseFloat(p) : Number(p);
    if (!Number.isFinite(n) || n <= 0) throw new Error('invalid');
    return n;
  };

  // Race all sources simultaneously — fastest valid response wins
  const sources: Promise<number>[] = [
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { price: string }) => valid(d.price)),
    fetch('https://api.coinbase.com/v2/prices/SUI-USD/spot')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { data?: { amount?: string } }) => valid(d.data?.amount)),
    fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=SUIUSDT')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { result?: { list?: Array<{ lastPrice: string }> } }) => valid(d.result?.list?.[0]?.lastPrice)),
  ];

  try {
    return persist(await Promise.any(sources));
  } catch { /* all failed — use stale cache */ }

  return suiPriceCache?.price ?? null;
}

/** Total portfolio value denominated in SUI. Falls back to raw SUI if no price. */
function getTotalSui(): number {
  const price = suiPriceCache?.price;
  if (!price || price <= 0) return app.sui;
  let totalUsd = app.sui * price + app.stableUsd;
  for (const c of walletCoins) {
    if (c.symbol === 'SUI' || c.isStable) continue;
    const tp = getTokenPrice(c.symbol);
    if (tp != null && tp > 0) totalUsd += c.balance * tp;
  }
  return totalUsd / price;
}

export async function refreshPortfolio(force = false) {
  const ws = getState();
  if (!ws.address) return;
  const now = Date.now();
  if (!force && portfolioInFlight) return;
  if (!force && now - lastPortfolioMs < 15_000) return;
  portfolioInFlight = true;
  lastPortfolioMs = now;
  const fetchedFor = ws.address; // capture before any await

  try {
    // gRPC for all balances + SUI price + token prices + SuiNS in parallel
    const [allBalResult, suinsName, suiPrice] = await Promise.all([
      grpcClient.core.listBalances({ owner: fetchedFor }).catch(() => null),
      lookupSuiNS(fetchedFor),
      fetchSuiPrice(),
      fetchTokenPrices(),
    ]);

    // Wallet switched while fetch was in-flight — discard stale result
    if (getState().address !== fetchedFor) return;

    // Preserve the last known-good portfolio when the balance call fails.
    // Treating a failed fetch as an empty balance set causes the open SKI menu
    // to redraw with incorrect totals a few seconds after initial render.
    if (!allBalResult?.balances) return;

    // Fetch decimals for any unknown coin types before parsing
    const balances = allBalResult?.balances ?? [];
    const coinTypes = balances.map(b => b.coinType).filter(Boolean);
    await _fetchMissingDecimals(coinTypes);

    let nextSui = 0;
    let nextNsBalance = 0;
    let stableTotal = 0;
    const newCoins: WalletCoin[] = [];
    for (const b of balances) {
      const raw = Number(b.balance ?? 0);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const dec = coinDecimals(b.coinType);
      const bal = raw / Math.pow(10, dec);
      const isStable = _isStableCoin(b.coinType);
      if (isStable) stableTotal += bal;
      const symbol = b.coinType === '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
        ? 'SUI' : coinShortName(b.coinType);
      newCoins.push({ symbol, balance: bal, coinType: b.coinType, isStable });
      // Populate known app fields
      if (symbol === 'SUI') nextSui = bal;
      else if (symbol === 'NS') nextNsBalance = bal;
    }
    app.sui = nextSui;
    app.nsBalance = nextNsBalance;
    app.stableUsd = stableTotal;
    walletCoins = newCoins;
    appBalanceFetched = true;

    // Total USD = SUI value + stablecoins + all token values
    const suiUsd = suiPrice != null ? app.sui * suiPrice : null;
    let tokensUsd = 0;
    for (const c of newCoins) {
      if (c.symbol === 'SUI' || c.isStable) continue;
      const tp = getTokenPrice(c.symbol);
      if (tp != null && tp > 0) tokensUsd += c.balance * tp;
    }
    if (suiUsd != null) {
      app.usd = suiUsd + app.stableUsd + tokensUsd;
    } else if (app.usd == null) {
      app.usd = app.stableUsd + tokensUsd > 0 ? app.stableUsd + tokensUsd : null;
    }

    // Keep active detail balance in sync if it's showing the connected wallet
    if (activeDetailAddr && activeDetailAddr.toLowerCase() === fetchedFor.toLowerCase()) {
      activeDetailSui = app.sui;
      activeDetailUsd = app.usd;
    }

    if (suinsName) {
      app.suinsName = suinsName;
      try { localStorage.setItem(`ski:suins:${fetchedFor}`, suinsName); } catch {}
    }

    // Cache summary totals for instant display on next page load
    // Do NOT cache walletCoins — individual token chips should always come from live data
    try {
      localStorage.setItem(`ski:balances:${fetchedFor}`, JSON.stringify({
        sui: app.sui,
        stableUsd: app.stableUsd,
        usd: app.usd,
        t: Date.now(),
      }));
    } catch {}
  } catch { /* keep existing */ }
  finally {
    portfolioInFlight = false;
    const nsInputActive = document.activeElement?.id === 'wk-ns-label-input';
    render();
    if (nsInputActive) {
      skipNextFocusClear = true;
      requestAnimationFrame(() => {
        const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      });
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshPortfolio();
  }, 120_000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Copy Address ────────────────────────────────────────────────────

let copiedTimer: ReturnType<typeof setTimeout> | null = null;

function copyAddress() {
  // Copy the address for the currently selected network
  const addr = networkView === 'btc'
    ? (app.btcAddress || app.ethAddress || getState().address)
    : getState().address;
  if (!addr) return;
  navigator.clipboard?.writeText(addr).then(() => {
    if (copiedTimer) clearTimeout(copiedTimer);
    app.copied = true;
    render();
    copiedTimer = setTimeout(() => { app.copied = false; copiedTimer = null; render(); }, 2200);
  }).catch(() => {});
}

// ─── Profile link ────────────────────────────────────────────────────

function skiHref(): string {
  if (app.suinsName) {
    const name = app.suinsName.replace(/\.sui$/, '');
    return 'https://' + encodeURIComponent(name) + '.sui.ski';
  }
  return 'https://sui.ski';
}

// ─── Render: Widget Pill ─────────────────────────────────────────────

// Registry of externally mounted profile widgets (same pattern as externalCyclers)
const externalProfiles = new Set<HTMLElement>();

function _renderProfileEl(el: HTMLElement) {
  const ws = getState();

  // Disconnected: hide profile — SKI button handles connect
  if (!ws.address) {
    el.innerHTML = '';
    return;
  }

  // Connected: [icon(s)] [name/addr] [balance]
  const hasSuins = !!app.suinsName;
  const label = hasSuins ? app.suinsName.replace(/\.sui$/, '') : truncAddr(ws.address);
  const labelClass = hasSuins ? 'wk-widget-title' : 'wk-widget-title is-address';

  // Wallet icon + optional social badge (badge is a sibling, not inside the clipped icon span)
  let iconHtml = '';
  if (ws.walletIcon) {
    const social = socialIconSvg(ws.walletName);
    const xBadge = social ? `<span class="ski-waap-x wk-widget-social-badge">𝕏</span>` : '';
    iconHtml = `<span class="wk-widget-method-icon${social ? ' wk-widget-method-icon--social' : ''}"><img src="${esc(ws.walletIcon)}" alt="${esc(ws.walletName)}"></span>${xBadge}`;
  }

  // Eagerly restore IKA cache so squid shows from the first render frame
  if (!app.ikaWalletId && ws.address) {
    try {
      const ikaCached = localStorage.getItem(`ski:ika:${ws.address}`);
      if (ikaCached) {
        const c = JSON.parse(ikaCached) as { btc: string; eth: string; id: string };
        if (c.id) { app.ikaWalletId = c.id; app.btcAddress = c.btc; app.ethAddress = c.eth; }
      }
    } catch {}
  }

  const skiUrl = hasSuins ? `https://${esc(label)}.sui.ski` : '';
  const innerHtml = `${iconHtml}
        <span class="wk-widget-label-wrap">
          <span class="${labelClass}">
            <span class="wk-widget-primary-name">${esc(label)}${app.ikaWalletId ? ' \ud83e\udd91' : ''}</span>
          </span>
        </span>`;

  el.innerHTML = hasSuins
    ? `<div class="wk-widget">
      <a class="wk-widget-btn connected" href="${skiUrl}" target="_blank" rel="noopener" title="${esc(label)}.sui.ski">
        ${innerHtml}
      </a>
    </div>`
    : `<div class="wk-widget">
      <button class="wk-widget-btn connected" type="button" title="Open profile">
        ${innerHtml}
      </button>
    </div>`;
}

function renderWidget() {
  if (els.profile) _renderProfileEl(els.profile);
  externalProfiles.forEach((el) => {
    if (document.contains(el)) _renderProfileEl(el);
    else externalProfiles.delete(el);
  });
}

/**
 * Mount a live profile widget onto any element.
 * Shows the wallet icon, SuiNS name (or truncated address), and Ika badge.
 * Empty when disconnected.
 *
 * @returns unmount function — call it to detach and clean up
 */
export function mountProfile(el: HTMLElement): () => void {
  _renderProfileEl(el);
  externalProfiles.add(el);
  return () => { externalProfiles.delete(el); };
}

// ─── Render: Profile .SKI button ─────────────────────────────────────

function hasValidSkiSession(address: string): boolean {
  try {
    const raw = localStorage.getItem('ski:session');
    if (!raw) return false;
    const s = JSON.parse(raw) as { address: string; expiresAt: string };
    return s.address === address && new Date(s.expiresAt).getTime() > Date.now();
  } catch { return false; }
}

// Registry of externally mounted ski buttons (same pattern as externalCyclers)
const externalSkiBtns = new Set<HTMLElement>();
const externalDotBtns = new Set<HTMLElement>();

function _renderSkiBtnEl(el: HTMLElement) {
  const ws = getState();

  if (!ws.address) {
    el.innerHTML = getSkiBtnSvg(_hydrating ? 'black-diamond' : 'green-circle');
    return;
  }

  const hasPrimary = !!app.suinsName;
  el.classList.toggle('ski-menu-open', app.skiMenuOpen);
  el.classList.toggle('ski-bal-usd', balView === 'usd');
  const showDrop = app.splashSponsor || hasValidSkiSession(ws.address);

  if (hasPrimary) {
    const dotSvg = balView === 'usd'
      ? `<svg class="ski-btn-price-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg>`
      : `<svg class="ski-btn-price-icon" viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38" rx="6" fill="#4da2ff" stroke="white" stroke-width="2"/><g transform="translate(10,7) scale(0.067)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g></svg>`;
    const rawUsd = fmtUsd(app.usd);
    const fmtBalSplit = (raw: string) => {
      const dot = raw.indexOf('.');
      if (dot < 0) return `<span class="ski-btn-bal-whole">${esc(raw)}</span>`;
      return `<span class="ski-btn-bal-whole">${esc(raw.slice(0, dot))}</span><span class="ski-btn-bal-dec">.${esc(raw.slice(dot + 1))}</span>`;
    };
    const balLabel = balView === 'usd'
      ? `<span class="ski-btn-price-label ski-btn-price-label--usd">${fmtBalSplit(rawUsd ? rawUsd.replace(/^\$/, '') : '--')}</span>`
      : `<span class="ski-btn-price-label">${fmtBalSplit(fmtSui(getTotalSui()))}</span>`;
    el.innerHTML = `<span class="ski-btn-dot" title="SKI Menu" aria-label="Switch USD/SUI">${dotSvg}</span>${balLabel}`;
    return;
  }

  const drop = showDrop
    ? `<img src="${SUI_DROP_URI}" class="ski-btn-session-drop" alt="" aria-hidden="true">`
    : '';
  el.innerHTML = getSkiBtnSvg('black-diamond') + drop;
}

function _shapeWithDropSvg(variant: SkiDotVariant, sizePx: number): string {
  const base = _shapeOnlySvg(variant, sizePx);
  // Insert a white sui-drop <g> before the closing </svg>
  const scale = sizePx * 0.0019;
  const tx = sizePx * 0.22;
  const ty = sizePx * 0.1;
  const dropG = `<g transform="translate(${tx},${ty}) scale(${scale})" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
  return base.replace('</svg>', `${dropG}</svg>`);
}

function _renderDotBtn() {
  const btn = els.skiDot;
  if (!btn) return;
  const ws = getState();
  if (!ws.address) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const variant: SkiDotVariant = app.suinsName ? 'blue-square' : 'black-diamond';
  btn.innerHTML = modalOpen ? _shapeWithDropSvg(variant, 31) : _shapeOnlySvg(variant, 31);
  btn.classList.toggle('ski-dot--modal-open', modalOpen);
  btn.title = modalOpen ? 'Close SKI modal' : 'Open SKI modal';
}

function _renderDotBtnEl(el: HTMLElement) {
  const ws = getState();
  if (!ws.address) { el.style.display = 'none'; return; }
  el.style.display = '';
  const variant: SkiDotVariant = app.suinsName ? 'blue-square' : 'black-diamond';
  el.innerHTML = modalOpen ? _shapeWithDropSvg(variant, 31) : _shapeOnlySvg(variant, 31);
}

function renderSkiBtn() {
  if (els.skiBtn) {
    els.skiBtn.style.display = '';
    _renderSkiBtnEl(els.skiBtn);
  }
  _renderDotBtn();
  externalSkiBtns.forEach((el) => {
    if (document.contains(el)) _renderSkiBtnEl(el);
    else externalSkiBtns.delete(el);
  });
  externalDotBtns.forEach((el) => {
    if (document.contains(el)) _renderDotBtnEl(el);
    else externalDotBtns.delete(el);
  });
}

/**
 * Mount a live SKI button onto any element.
 * The element gets the same styling and behaviour as the built-in SKI button:
 * it shows connection state, balance, and opens the SKI menu on click.
 *
 * @returns unmount function — call it to detach and clean up
 */
export function mountSkiButton(el: HTMLElement): () => void {
  el.classList.add('ski-btn');
  _renderSkiBtnEl(el);
  externalSkiBtns.add(el);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (!getState().address) {
      if (modalOpen) { closeModal(); return; }
      openModal();
      return;
    }
    // Connected: only toggle SKI menu — close modal first if open
    if (modalOpen) closeModal();
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:lift', '0'); } catch {} render(); return; }
    app.skiMenuOpen = true;
    try { localStorage.setItem('ski:lift', '1'); } catch {}
    render();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (modalOpen) { closeModal(); return; }
      openModal(true);
    }
  }

  el.addEventListener('click', handleClick);
  el.addEventListener('keydown', handleKeydown);

  return () => {
    externalSkiBtns.delete(el);
    el.removeEventListener('click', handleClick);
    el.removeEventListener('keydown', handleKeydown);
    el.classList.remove('ski-btn');
  };
}

/**
 * Mount a live dot status button onto any element.
 * Shows a blue square (SuiNS name set) or black diamond (connected, no name),
 * and is hidden while disconnected. Clicking opens the SKI modal.
 *
 * @returns unmount function — call it to detach and clean up
 */
export function mountDotButton(el: HTMLElement): () => void {
  el.classList.add('ski-btn', 'ski-dot');
  _renderDotBtnEl(el);
  externalDotBtns.add(el);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (modalOpen) { closeModal(); return; }
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:lift', '0'); } catch {} render(); }
    openModal();
  }

  el.addEventListener('click', handleClick);

  return () => {
    externalDotBtns.delete(el);
    el.removeEventListener('click', handleClick);
    el.classList.remove('ski-btn', 'ski-dot');
  };
}

// ─── NS registration row (SKI menu) ─────────────────────────────────

let appBalanceFetched = false; // true once live or cached balance is available
let skipNextFocusClear = false; // set before programmatic re-focus to avoid wiping user's typed value
let nsLabel = '';
let nsPriceUsd: number | null = null;
let nsPriceFetchFor = '';
let nsPriceDebounce: ReturnType<typeof setTimeout> | null = null;
let _nsValidityInterval: ReturnType<typeof setInterval> | null = null;
let nsAvail: null | 'available' | 'taken' | 'owned' | 'grace' = null;
let nsGraceEndMs = 0;
let nsTargetAddress: string | null = null; // resolved address for the current label (if registered)
let nsNftOwner: string | null = null; // NFT owner address (fallback when targetAddress is null)
let nsLastDigest = ''; // digest from last successful registration; shown in route area
let nsSubnameParent: OwnedDomain | null = null; // when set, we're in subname-creation mode
let nsShowTargetInput = false; // target-address inline editor open
let nsNewTargetAddr = ''; // value in the target-address input
let nsOwnedDomains: OwnedDomain[] = []; // all SuiNS objects owned by the wallet
let nsOwnedFetchedFor = ''; // wallet address we last fetched for (cache key)
let nsRealOwnerAddr = ''; // discovered on-chain owner address (WaaP wallets differ from wallet address)
let nsKioskListing: { kioskId: string; nftId: string; priceMist: string } | null = null; // on-chain kiosk listing for current label
let nsTradeportListing: TradeportListing | null = null; // Tradeport marketplace listing for current label
/** Get the active marketplace listing — prefer on-chain kiosk, fall back to Tradeport. */
function _nsListing(): { priceMist: string; seller?: string; source: 'kiosk' | 'tradeport' } | null {
  if (nsKioskListing) return { priceMist: nsKioskListing.priceMist, source: 'kiosk' };
  if (nsTradeportListing) return { priceMist: nsTradeportListing.priceMist, seller: nsTradeportListing.seller, source: 'tradeport' };
  return null;
}
let nsShadeOrder: ShadeOrderInfo | null = null; // active shade order for current domain
let nsShadeOrdersPruned = false; // true once we've validated orders against on-chain state
const _shadeCancelledIds = new Set<string>((() => { // cancelled order IDs — persisted to suppress on-chain re-discovery
  try { const v = localStorage.getItem('ski:shade-cancelled'); return v ? JSON.parse(v) as string[] : []; } catch { return []; }
})());
function _persistShadeCancelled() {
  try { localStorage.setItem('ski:shade-cancelled', JSON.stringify([..._shadeCancelledIds])); } catch {}
}
let nsRosterOpen = (() => { try { return sessionStorage.getItem('ski:roster-open') === '1'; } catch { return false; } })();
let nsRouteOpen = (() => {
  try {
    const stored = sessionStorage.getItem('ski:route-open');
    if (stored !== null) return stored === '1';
    // Default: open for black diamond (no SuiNS), closed for blue square (has SuiNS)
    const addr = JSON.parse(localStorage.getItem('ski:session') ?? '{}')?.address;
    const cachedName = addr ? localStorage.getItem(`ski:suins:${addr}`) : null;
    return !cachedName;
  } catch { return false; }
})();
function _persistRouteOpen() {
  const addr = (() => { try { return JSON.parse(localStorage.getItem('ski:session') ?? '{}')?.address; } catch { return null; } })();
  const hasName = addr ? !!localStorage.getItem(`ski:suins:${addr}`) : !!app.suinsName;
  if (hasName) { try { sessionStorage.removeItem('ski:route-open'); } catch {} return; }
  _persistRouteOpen();
}
let _suiamiVerifyHtml = ''; // persists SuiAMI result across re-renders
function _persistRosterOpen() { try { sessionStorage.setItem('ski:roster-open', nsRosterOpen ? '1' : '0'); } catch {} }
let nsSectionOpen = (() => {
  try {
    const stored = sessionStorage.getItem('ski:ns-section-open');
    if (stored !== null) return stored === '1';
    // Default: open for black diamond (no SuiNS name) so target address is visible
    const addr = JSON.parse(localStorage.getItem('ski:session') ?? '{}')?.address;
    const cachedName = addr ? localStorage.getItem(`ski:suins:${addr}`) : null;
    return !cachedName;
  } catch { return false; }
})();
function _persistNsSectionOpen() { try { sessionStorage.setItem('ski:ns-section-open', nsSectionOpen ? '1' : '0'); } catch {} }
let coinChipsOpen = (() => { try { return sessionStorage.getItem('ski:coins-open') !== '0'; } catch { return true; } })();
function _persistCoinChipsOpen() { try { sessionStorage.setItem('ski:coins-open', coinChipsOpen ? '1' : '0'); } catch {} }
let addrSectionOpen = (() => {
  try {
    const stored = sessionStorage.getItem('ski:addr-open');
    if (stored !== null) return stored === '1';
    // Default: open for black diamond (no SuiNS), closed for blue square (has SuiNS)
    const addr = JSON.parse(localStorage.getItem('ski:session') ?? '{}')?.address;
    const cachedName = addr ? localStorage.getItem(`ski:suins:${addr}`) : null;
    return !cachedName;
  } catch { return false; }
})();
function _persistAddrSectionOpen() {
  // For blue-square users (has SuiNS name), don't persist — always reset to closed on re-open
  const addr = (() => { try { return JSON.parse(localStorage.getItem('ski:session') ?? '{}')?.address; } catch { return null; } })();
  const hasName = addr ? !!localStorage.getItem(`ski:suins:${addr}`) : !!app.suinsName;
  if (hasName) { try { sessionStorage.removeItem('ski:addr-open'); } catch {} return; }
  try { sessionStorage.setItem('ski:addr-open', addrSectionOpen ? '1' : '0'); } catch {}
}
// Legacy alias — kept in sync with addrSectionOpen
let balSectionOpen = addrSectionOpen;
let skiSettingsOpen = false;
function _saveRosterScroll() { try { const g = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null; if (g) sessionStorage.setItem('ski:roster-scroll', String(g.scrollLeft)); } catch {} }
function _restoreRosterScroll() { try { const g = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null; const v = sessionStorage.getItem('ski:roster-scroll'); if (g && v) g.scrollLeft = Number(v); } catch {} }
let _shadeCountdownTimer: ReturnType<typeof setInterval> | null = null; // live ticking countdown
let _shadeChipTimer: ReturnType<typeof setInterval> | null = null; // roster chip countdown
let _shadeDoState: ShadeExecutorState | null = null; // live DO state from WebSocket
let _shadeFailedToastShown = new Set<string>(); // dedupe failed toasts per objectId
let nsShadeOrders: Array<ShadeOrderInfo & { orphaned?: boolean; sealedPayload?: string; commitment?: string }> = []; // merged localStorage + on-chain shade orders for roster

// ─── Wishlist (black-diamond names the user is watching) ─────────────
let nsWishlist: string[] = (() => {
  try { const v = localStorage.getItem('ski:ns-wishlist'); return v ? JSON.parse(v) : []; } catch { return []; }
})();

function _addToWishlist(label: string) {
  const bare = label.replace(/\.sui$/, '').toLowerCase();
  if (!bare || nsWishlist.includes(bare)) return;
  nsWishlist.push(bare);
  try { localStorage.setItem('ski:ns-wishlist', JSON.stringify(nsWishlist)); } catch {}
}

function _removeFromWishlist(label: string) {
  const bare = label.replace(/\.sui$/, '').toLowerCase();
  nsWishlist = nsWishlist.filter(n => n !== bare);
  try { localStorage.setItem('ski:ns-wishlist', JSON.stringify(nsWishlist)); } catch {}
}

// ─── Owned domains localStorage cache ────────────────────────────────
function _cacheOwnedDomains(addr: string, domains: OwnedDomain[]) {
  try {
    const data = { ts: Date.now(), domains };
    localStorage.setItem(`ski:ns-owned:${addr}`, JSON.stringify(data));
  } catch { /* quota exceeded — ignore */ }
}

function _loadCachedOwnedDomains(addr: string): OwnedDomain[] | null {
  try {
    const raw = localStorage.getItem(`ski:ns-owned:${addr}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { ts: number; domains: OwnedDomain[] };
    // Cache valid for 10 minutes
    if (Date.now() - data.ts > 10 * 60 * 1000) return null;
    return data.domains;
  } catch { return null; }
}
let ns5CharPriceUsd: number | null = (() => {
  try { const v = localStorage.getItem('ski:ns5-price'); return v ? parseFloat(v) : null; } catch { return null; }
})(); // loaded once, reused for all 5+ char names; persisted to localStorage

/**
 * If a checkDomainStatus result reveals an NFT owner for a self-target domain,
 * store it as the real on-chain owner address (for WaaP wallets where wallet ≠ owner).
 */
function _maybeDiscoverRealOwner(result: DomainStatusResult) {
  const walletAddr = getState().address;
  if (!walletAddr) return;
  const walletLower = walletAddr.toLowerCase();

  // Check if this domain belongs to us (via target address OR NFT owner)
  const isOurs = (result.targetAddress && result.targetAddress.toLowerCase() === walletLower) ||
    (result.nftOwner && result.nftOwner.toLowerCase() === walletLower);

  if (isOurs) {
    if (!nsRealOwnerAddr && result.nftOwner) {
      nsRealOwnerAddr = result.nftOwner;
      nsOwnedFetchedFor = '';
      _fetchOwnedDomains();
    }
    if (nsAvail === 'taken') nsAvail = 'owned';
  }
}

/** Discover the real on-chain owner address using a known SuiNS name. */
async function _discoverRealOwner() {
  if (nsRealOwnerAddr) return;
  const ws = getState();
  if (!ws.address) return;
  const name = app.suinsName || suinsCache[ws.address];
  if (!name) return;
  try {
    const owner = await lookupNftOwner(name);
    if (owner && owner.toLowerCase() !== ws.address.toLowerCase()) {
      nsRealOwnerAddr = owner;
      nsOwnedFetchedFor = '';
      _fetchOwnedDomains();
      // Re-check current domain if one is being viewed
      if (nsLabel.length >= 3 && isValidNsLabel(nsLabel)) {
        nsPriceFetchFor = '';
        fetchAndShowNsPrice(nsLabel);
      }
    }
  } catch {}
}

async function fetchAndShowNsPrice(label: string) {
  if (label.length < 3) {
    nsPriceUsd = null; nsPriceFetchFor = ''; nsAvail = null; nsGraceEndMs = 0;
    _patchNsPrice(); _patchNsStatus();
    return;
  }
  if (label === nsPriceFetchFor && nsPriceUsd != null) return;
  nsPriceFetchFor = label;
  if (nsAvail !== 'owned') { nsAvail = null; _patchNsStatus(); }

  /** Apply status + Tradeport listing results to module state and re-render. */
  const _applyStatusAndListing = (sr: DomainStatusResult | null, tp: TradeportListing | null) => {
    nsAvail = sr?.avail ?? null;
    nsGraceEndMs = sr?.graceEndMs ?? 0;
    nsTargetAddress = sr?.targetAddress ?? null;
    nsNftOwner = sr?.nftOwner ?? null;
    // If domain is in our owned roster, override 'taken' → 'owned'
    if (nsAvail === 'taken') {
      const bareLabel = (nsPriceFetchFor ?? '').toLowerCase();
      const inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel);
      if (inRoster) nsAvail = 'owned';
    }
    nsKioskListing = sr?.kioskId
      ? { kioskId: sr.kioskId, nftId: sr.kioskNftId!, priceMist: sr.kioskListingPriceMist! }
      : null;
    nsTradeportListing = tp;
    if (sr) _maybeDiscoverRealOwner(sr);
    // Clear stale amount if name isn't actionable (no mint, no listing to buy)
    const actionable = nsAvail === 'available' || nsAvail === 'grace' || nsKioskListing || nsTradeportListing;
    if (!actionable && pendingSendAmount) {
      pendingSendAmount = '';
      const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
      document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
      const _ac = document.getElementById('wk-send-clear');
      if (_ac) _ac.style.display = 'none';
      const _sb = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
      if (_sb) _sb.disabled = true;
    }
    _patchNsPrice();
    _patchNsStatus();
    _patchNsRoute();
  };

  if (label.length >= 5) {
    if (ns5CharPriceUsd != null) {
      // Already loaded — show instantly, only fetch availability + Tradeport listing
      nsPriceUsd = ns5CharPriceUsd;
      _patchNsPrice();
      const ws = getState();
      const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
      const [statusResult, tpResult] = await Promise.allSettled([
        checkDomainStatus(label, ws.address || undefined, _extra),
        fetchTradeportListing(label),
      ]);
      if (nsPriceFetchFor !== label) return;
      _applyStatusAndListing(
        statusResult.status === 'fulfilled' ? statusResult.value : null,
        tpResult.status === 'fulfilled' ? tpResult.value : null,
      );
      return;
    }
    // First 5+ char lookup — fetch price once, then cache it
    const ws = getState();
    const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
    const [priceResult, statusResult, tpResult] = await Promise.allSettled([
      fetchDomainPriceUsd(label),
      checkDomainStatus(label, ws.address || undefined, _extra),
      fetchTradeportListing(label),
    ]);
    if (nsPriceFetchFor !== label) return;
    if (priceResult.status === 'fulfilled') {
      ns5CharPriceUsd = priceResult.value;
      try { localStorage.setItem('ski:ns5-price', String(ns5CharPriceUsd)); } catch {}
    }
    nsPriceUsd = priceResult.status === 'fulfilled' ? priceResult.value : null;
    _applyStatusAndListing(
      statusResult.status === 'fulfilled' ? statusResult.value : null,
      tpResult.status === 'fulfilled' ? tpResult.value : null,
    );
    return;
  }

  // 3–4 char names have variable pricing — fetch all in parallel
  const ws = getState();
  const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
  const [priceResult, statusResult, tpResult] = await Promise.allSettled([
    fetchDomainPriceUsd(label),
    checkDomainStatus(label, ws.address || undefined, _extra),
    fetchTradeportListing(label),
  ]);
  if (nsPriceFetchFor !== label) return;
  nsPriceUsd = priceResult.status === 'fulfilled' ? priceResult.value : null;
  _applyStatusAndListing(
    statusResult.status === 'fulfilled' ? statusResult.value : null,
    tpResult.status === 'fulfilled' ? tpResult.value : null,
  );
}

function _patchNsPrice() {
  const chip = document.getElementById('wk-ns-price-chip');
  if (chip) chip.innerHTML = _nsPriceHtml();
  // Show clear button when price/listing populates the row
  const nsClearBtn = document.getElementById('wk-ns-clear-btn');
  if (nsClearBtn && nsLabel) nsClearBtn.style.display = '';
  _patchNsRoute();
}

function _nsRouteHtml(): string {
  // Subname mode: show parent badge + unpin
  if (nsSubnameParent) {
    const parentBare = nsSubnameParent.name.replace(/\.sui$/, '');
    return `<span class="wk-ns-route"><span class="wk-ns-subname-badge">${esc(parentBare)}.sui</span><button id="wk-ns-unpin-btn" class="wk-ns-unpin-btn" type="button" title="Exit subname mode">\u2715</button></span>`;
  }

  // After a successful registration, show the tx digest instead of the route indicator
  if (nsLastDigest) {
    const short = nsLastDigest.slice(0, 8) + '…' + nsLastDigest.slice(-4);
    return `<span class="wk-ns-route"><a class="wk-ns-digest" id="wk-ns-digest-link" href="https://suiscan.xyz/mainnet/tx/${nsLastDigest}" target="_blank" rel="noopener" title="View on SuiScan" style="cursor:pointer;color:inherit;text-decoration:none">${short} \u2197</a></span>`;
  }

  const walletAddr = getState().address?.toLowerCase() ?? '';
  const walletAddrRaw = getState().address ?? '';
  const resolvedAddr = nsTargetAddress ?? nsNftOwner;
  const isOwnerAddr = resolvedAddr
    ? resolvedAddr.toLowerCase() === walletAddr
    : false;

  // Check early if the current label is an owned NFT (used for display fallback + click logic)
  const bareLabel = nsLabel.toLowerCase();
  const isOwnedName = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel && d.kind === 'nft');

  // Resolve the display address: target → nft owner → wallet (for available/idle/owned)
  let displayAddr = nsTargetAddress ?? nsNftOwner;
  if (!displayAddr && walletAddrRaw) {
    // Fall back to wallet address for idle, available, or owned names (no target set yet)
    if (!nsLabel || nsLabel.length < 3 || nsAvail === 'available' || nsAvail === null || isOwnedName) {
      displayAddr = walletAddrRaw;
    }
  }

  // Always show the row — dim placeholder when no wallet connected
  if (!displayAddr) {
    return `<div class="wk-ns-target-row wk-ns-target-row--dim wk-ns-target-row--toggle" title="Show names"><span class="wk-ns-target-icon">\u25ce</span><span class="wk-ns-target-addr">\u2014</span></div>`;
  }

  // Show "resolving…" spinner when a valid label is typed but availability not yet known
  if (nsLabel && nsLabel.length >= 3 && nsAvail === null && !nsTargetAddress) {
    return `<div class="wk-ns-target-row wk-ns-target-row--loading"><span class="wk-ns-target-icon">\u25ce</span><span class="wk-ns-target-addr">resolving\u2026</span></div>`;
  }

  const shortAddr = `${displayAddr.slice(0, 6)}\u2026${displayAddr.slice(-6)}`;

  // Check if current name is listed in a kiosk (Tradeport)
  const isKioskName = nsOwnedDomains.some(d => d.inKiosk && d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel);

  // Color by color name — purple = self-target (address points to your wallet)
  // dim = no name typed yet (idle placeholder showing wallet address)
  let colorClass = 'wk-ns-target-row--blue'; // default: blue (taken by someone else)
  if (!nsLabel || nsLabel.length < 3 || nsAvail === null) colorClass = 'wk-ns-target-row--dim';
  else if (_nsListing()) colorClass = 'wk-ns-target-row--orange'; // marketplace listing (purchasable)
  else if (isKioskName) colorClass = 'wk-ns-target-row--orange';
  else if (nsAvail === 'grace') colorClass = 'wk-ns-target-row--red';
  else if (isOwnerAddr || isOwnedName) colorClass = 'wk-ns-target-row--purple';
  else if (nsAvail === 'available') colorClass = 'wk-ns-target-row--green';

  // Owned names: icon opens target editor; whole row is copyable
  const canEditTarget = isOwnerAddr || isOwnedName;
  const iconId = canEditTarget ? ' id="wk-ns-target-edit-btn"' : '';
  const iconTitle = canEditTarget ? ' title="Change target address"' : '';

  let extra = '';
  if (nsAvail === 'grace') extra = `<span class="wk-ns-target-grace">${nsShadeOrder ? _graceCountdownPrecise() : _graceEndDate()}</span>`;

  const isDim = colorClass === 'wk-ns-target-row--dim';
  const rowCls = isDim ? 'wk-ns-target-row--toggle' : 'wk-ns-target-row--copy';
  const rowTitle = isDim ? 'Show names' : `Copy Target ${shortAddr}`;
  return `<div class="wk-ns-target-row ${colorClass} ${rowCls}"${isDim ? '' : ` data-copy-target="${esc(displayAddr)}"`} title="${rowTitle}"><span class="wk-ns-target-icon${canEditTarget ? ' wk-ns-target-icon--editable' : ''}"${iconId}${iconTitle}>\u25ce</span><span class="wk-ns-target-addr">${shortAddr}</span>${extra}</div>`;
}

function _nsOwnedListHtml(): string {
  // Sort owned: kiosk first → expiration ascending → no-expiry last
  const sorted = [...nsOwnedDomains].sort((a, b) => {
    if (a.inKiosk !== b.inKiosk) return a.inKiosk ? -1 : 1;
    const ea = a.expirationMs ?? Infinity;
    const eb = b.expirationMs ?? Infinity;
    return ea - eb;
  });

  // Filter wishlist: exclude names already in owned list
  const ownedNames = new Set(sorted.map(d => d.name.replace(/\.sui$/, '').toLowerCase()));
  const wishItems = nsWishlist.filter(w => !ownedNames.has(w));

  const totalOwned = sorted.length;
  const totalAll = totalOwned + wishItems.length + nsShadeOrders.length;
  if (totalAll === 0) return '';

  const now = Date.now();

  // Filter query from current input — used to sort matches first + dim non-matches
  const filterQ = nsLabel.trim().toLowerCase();
  const hasFilter = filterQ.length > 0 && !nsSubnameParent;

  // Build chip data with match info
  type ChipEntry = { html: string; matches: boolean };
  const chipEntries: ChipEntry[] = sorted.map(d => {
    const bare = d.name.replace(/\.sui$/, '');
    const matches = !hasFilter || bare.toLowerCase().includes(filterQ);
    // Pick shape: kiosk → blue-square, cap → black-diamond, nft → blue-square
    const shape: SkiDotVariant = d.kind === 'cap' ? 'black-diamond' : 'blue-square';
    const shapeSvg = _shapeOnlySvg(shape, 12);
    let expiryHtml = '';
    if (d.expirationMs) {
      const daysLeft = Math.max(0, Math.ceil((d.expirationMs - now) / 86_400_000));
      let cls = 'wk-ns-owned-expiry';
      if (daysLeft <= 30) cls += ' wk-ns-owned-expiry--urgent';
      else if (daysLeft <= 90) cls += ' wk-ns-owned-expiry--warn';
      expiryHtml = `<span class="${cls}">${daysLeft}d</span>`;
    }
    let badge = '';
    if (d.inKiosk) badge = '<span class="wk-ns-owned-kiosk">listed</span>';
    else if (d.kind === 'cap') badge = '<span class="wk-ns-owned-cap">cap</span>';
    const kioskCls = d.inKiosk ? ' wk-ns-owned-chip--kiosk' : '';
    const dimCls = hasFilter && !matches ? ' wk-ns-owned-chip--dim' : '';
    return {
      html: `<button class="wk-ns-owned-chip${kioskCls}${dimCls}" data-domain="${esc(bare)}" type="button" title="${esc(d.name)}">${shapeSvg}${esc(bare)}${badge}${expiryHtml}</button>`,
      matches,
    };
  });

  // Shade order chips (red-hexagon) — sorted by executeAfterMs ascending
  // Always shown first and never dimmed by filter
  const shadeChips: string[] = [];
  const sortedShades = [...nsShadeOrders].sort((a, b) => (a.executeAfterMs || Infinity) - (b.executeAfterMs || Infinity));
  for (const shade of sortedShades) {
    const bare = shade.domain || '???';
    const shadeSvg = _shapeOnlySvg('red-hexagon', 12);
    // Countdown to executeAfterMs — live HH:MM:SS
    let countdownHtml = '';
    if (shade.executeAfterMs > 0) {
      const msLeft = shade.executeAfterMs - now;
      if (msLeft > 0) {
        const h = Math.floor(msLeft / 3_600_000);
        const m = Math.floor((msLeft % 3_600_000) / 60_000);
        const s = Math.floor((msLeft % 60_000) / 1000);
        const txt = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        countdownHtml = `<span class="wk-ns-owned-expiry wk-ns-owned-expiry--urgent wk-shade-chip-cd" data-shade-cd="${shade.executeAfterMs}">${txt}</span>`;
      } else {
        countdownHtml = `<span class="wk-ns-owned-expiry wk-ns-owned-expiry--urgent">ready</span>`;
      }
    }
    const depositSui = Number(shade.depositMist) / 1e9;
    // Check DO state for failure
    const doMatch = _shadeDoState?.orders.find(o => o.objectId === shade.objectId);
    const isFailed = doMatch?.status === 'failed';
    const failedBadge = isFailed ? '<span class="wk-ns-owned-expiry" style="color:#f44">failed</span>' : '';
    const title = bare === '???' ? `Orphaned shade order — ${depositSui.toFixed(2)} SUI escrowed` : `${bare}.sui shade — ${depositSui.toFixed(2)} SUI escrowed${isFailed ? ' (FAILED — click to retry)' : ''}`;
    const dataAttrs = `data-domain="${esc(bare === '???' ? '' : bare)}" data-shade-id="${esc(shade.objectId)}" data-shade="1"`;
    shadeChips.push(`<button class="wk-ns-owned-chip wk-ns-owned-chip--shade" ${dataAttrs} type="button" title="${esc(title)}">${shadeSvg}${esc(bare)}${countdownHtml || failedBadge}</button>`);
  }

  // Wishlist chips (black-diamond)
  for (const w of wishItems) {
    const matches = !hasFilter || w.includes(filterQ);
    const wishSvg = _shapeOnlySvg('black-diamond', 12);
    const dimCls = hasFilter && !matches ? ' wk-ns-owned-chip--dim' : '';
    chipEntries.push({
      html: `<button class="wk-ns-owned-chip wk-ns-owned-chip--wish${dimCls}" data-domain="${esc(w)}" data-wish="1" type="button" title="${esc(w)}.sui">${wishSvg}${esc(w)}<span class="wk-ns-wish-rm" data-wish-rm="${esc(w)}" title="Remove">\u2715</span></button>`,
      matches,
    });
  }

  // Stable sort: matches first, then non-matches (preserves order within each group)
  if (hasFilter) chipEntries.sort((a, b) => (a.matches === b.matches ? 0 : a.matches ? -1 : 1));

  // Shade chips always appear first, never filtered
  const chips = [...shadeChips, ...chipEntries.map(e => e.html)];

  // Estimate yearly renewal cost (SuiNS base pricing: 3ch=$500, 4ch=$100, 5+ch=$10)
  let yearlyUsd = 0;
  for (const d of sorted) {
    if (d.kind === 'cap') continue; // subname caps have no renewal
    const bare = d.name.replace(/\.sui$/, '');
    const len = bare.length;
    yearlyUsd += len === 3 ? 500 : len === 4 ? 100 : 10;
  }
  const savingsUsd = Math.round(yearlyUsd * 0.25);

  // Header: "SKI Keystore" headline left, stats stacked right
  const monthlyUsd = (yearlyUsd / 12);
  const monthlySavings = (savingsUsd / 12);
  let statsHtml = '';
  if (yearlyUsd > 0) {
    statsHtml = `<div class="wk-ns-owned-stats"><span class="wk-ns-owned-renewal">$${monthlyUsd.toFixed(2)}/mo</span><span class="wk-ns-owned-savings">-$${monthlySavings.toFixed(2)}/mo</span></div>`;
  }
  const header = `<div class="wk-ns-owned-header"><span class="wk-ns-owned-title">SKI Roster<span class="wk-ns-owned-tally">${totalOwned}</span></span>${statsHtml}</div>`;

  // QR code — render inline from cache when possible, async-load on miss
  // Shade-aware: red QR when shade order exists or domain is in grace with no shade
  const qrAddr = nsTargetAddress ?? nsNftOwner ?? getState().address ?? '';
  const isShaded = !!nsShadeOrder;
  const isGraceNoShade = nsAvail === 'grace' && !nsShadeOrder;
  const qrColor = (isShaded || isGraceNoShade) ? '#ef4444' : undefined;
  const isAvailableWithLabel = nsAvail === 'available' && !!nsLabel.trim();
  const qrAction = isShaded ? 'cancel' : isGraceNoShade ? 'shade' : isAvailableWithLabel ? 'shade-test' : '';
  let qrDiv = '';
  if (qrAddr) {
    const cacheKey = `${qrColor ?? 'blue'}:${qrAddr}`;
    const cached = _rosterQrCache.get(cacheKey);
    const actionAttr = qrAction ? ` data-qr-action="${qrAction}"` : '';
    const colorAttr = qrColor ? ` data-qr-color="${esc(qrColor)}"` : '';
    qrDiv = cached
      ? `<div id="wk-roster-qr"${actionAttr}${colorAttr}>${cached}</div>`
      : `<div id="wk-roster-qr" data-qr-addr="${esc(qrAddr)}"${actionAttr}${colorAttr}></div>`;
  }

  return `<div class="wk-ns-owned-inner">${header}<div class="wk-ns-owned-grid">${qrDiv}${chips.join('')}</div></div>`;
}

/** Clear the NS input and reset price/status when opening the roster. */
function _clearNsInput() {
  const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
  if (inp) inp.value = '';
  nsLabel = '';
  nsPriceUsd = null;
  nsAvail = null;
  nsGraceEndMs = 0;
  nsTargetAddress = null;
  nsNftOwner = null;
  nsLastDigest = '';
  nsKioskListing = null; nsTradeportListing = null;
  nsShadeOrder = null;
  nsPriceFetchFor = '';
  if (nsPriceDebounce) clearTimeout(nsPriceDebounce);
  // Clear amount + red styling when listing was populating it
  pendingSendAmount = '';
  const amtInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
  if (amtInput) { amtInput.value = ''; amtInput.classList.remove('wk-send-amount--over'); }
  document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
  document.querySelector('.wk-ns-dot-sui')?.classList.remove('wk-ns-dot-sui--insufficient');
  const clearBtn = document.getElementById('wk-send-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  _patchNsPrice();
  _patchNsStatus();
  _patchNsRoute();
  _patchNsOwnedList();
}

const _rosterQrCache = new Map<string, string>();

/** Populate #wk-roster-qr if it has a data-qr-addr (cache miss). Caches SVG in memory for sync inline on next render. */
function _loadRosterQr() {
  const qrSlot = document.getElementById('wk-roster-qr');
  if (!qrSlot) return;
  const addr = qrSlot.dataset.qrAddr; // only set on cache-miss divs
  if (!addr) return; // already rendered inline from cache
  const color = qrSlot.dataset.qrColor;
  const cacheKey = `${color ?? 'blue'}:${addr}`;
  getQrSvg(addr, color).then(svg => {
    _rosterQrCache.set(cacheKey, svg);
    if (document.getElementById('wk-roster-qr')) qrSlot.innerHTML = svg;
  }).catch(() => {});
}

function _patchNsOwnedList() {
  const el = document.getElementById('wk-ns-owned-list');
  if (!el) return;
  _saveRosterScroll();
  el.innerHTML = _nsOwnedListHtml();
  _attachOwnedGridWheel();
  _attachNftPopoverListeners();
  _restoreRosterScroll();
  _syncShadeChipTimer();
  _loadRosterQr();
}

/** Start/stop the 1s roster shade chip countdown timer based on whether chips exist. */
function _syncShadeChipTimer() {
  const hasChips = document.querySelector('.wk-shade-chip-cd') !== null;
  if (hasChips && !_shadeChipTimer) {
    _shadeChipTimer = setInterval(() => {
      const now = Date.now();
      const els = document.querySelectorAll<HTMLElement>('.wk-shade-chip-cd');
      if (els.length === 0) { clearInterval(_shadeChipTimer!); _shadeChipTimer = null; return; }
      els.forEach(el => {
        const target = Number(el.dataset.shadeCd);
        const ms = target - now;
        if (ms <= 0) { el.textContent = 'ready'; el.classList.remove('wk-shade-chip-cd'); return; }
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      });
    }, 1000);
  } else if (!hasChips && _shadeChipTimer) {
    clearInterval(_shadeChipTimer); _shadeChipTimer = null;
  }
}

/** Attach horizontal wheel-scroll to the owned names grid. */
function _attachOwnedGridWheel() {
  const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
  if (!grid) return;
  grid.addEventListener('wheel', (e) => {
    if (grid.scrollWidth > grid.clientWidth) {
      e.preventDefault();
      grid.scrollLeft += e.deltaY || e.deltaX;
    }
  }, { passive: false });
  grid.addEventListener('scroll', _saveRosterScroll, { passive: true });
}

// ─── NFT Card Popover (hover on roster chips) ────────────────────────

let _nftPopover: HTMLElement | null = null;
let _nftPopoverHideTimer: ReturnType<typeof setTimeout> | null = null;
let _nftPopoverPinned = false;

function _ensureNftPopover(): HTMLElement {
  if (_nftPopover) return _nftPopover;
  const el = document.createElement('div');
  el.id = 'ski-nft-popover';
  el.className = 'ski-nft-popover';
  el.setAttribute('hidden', '');
  el.addEventListener('mouseenter', () => {
    if (_nftPopoverHideTimer) { clearTimeout(_nftPopoverHideTimer); _nftPopoverHideTimer = null; }
  });
  el.addEventListener('mouseleave', () => { if (!_nftPopoverPinned) _hideNftPopover(); });
  el.addEventListener('click', (e) => {
    // Don't pin if clicking a link (let it navigate)
    if ((e.target as HTMLElement).closest('a')) return;
    _nftPopoverPinned = true;
    el.classList.add('ski-nft-popover--pinned');
  });
  document.addEventListener('click', (e) => {
    if (!_nftPopoverPinned) return;
    if ((e.target as HTMLElement).closest('#ski-nft-popover')) return;
    _nftPopoverPinned = false;
    _nftPopover?.classList.remove('ski-nft-popover--pinned');
    _hideNftPopover(true);
  });
  document.body.appendChild(el);
  _nftPopover = el;
  return el;
}

function _hideNftPopover(immediate = false) {
  if (_nftPopoverHideTimer) { clearTimeout(_nftPopoverHideTimer); _nftPopoverHideTimer = null; }
  if (_nftPopoverPinned && !immediate) return;
  if (immediate) { _nftPopoverPinned = false; _nftPopover?.classList.remove('ski-nft-popover--pinned'); _nftPopover?.setAttribute('hidden', ''); return; }
  _nftPopoverHideTimer = setTimeout(() => {
    _nftPopover?.setAttribute('hidden', '');
  }, 500);
}

function _showNftPopover(chip: HTMLElement, domainBare: string) {
  if (_nftPopoverHideTimer) { clearTimeout(_nftPopoverHideTimer); _nftPopoverHideTimer = null; }
  _nftPopoverPinned = false;
  const popover = _ensureNftPopover();
  popover.classList.remove('ski-nft-popover--pinned');
  const domain = `${domainBare}.sui`;
  const suiSkiUrl = `https://${domainBare}.sui.ski`;

  // Owner's primary SuiNS name (reverse resolution)
  const ownerAddr = nsRealOwnerAddr || getState().address || '';
  const ownerName = app.suinsName || suinsCache[ownerAddr] || (() => { try { return localStorage.getItem(`ski:suins:${ownerAddr}`); } catch { return null; } })() || null;
  const ownerBadge = ownerName
    ? `<span class="ski-nft-owner-badge">${esc(ownerName.replace(/\.sui$/, ''))}</span>`
    : `<span class="ski-nft-owner-addr">${ownerAddr.slice(0, 6)}\u2026${ownerAddr.slice(-4)}</span>`;

  // Expiry info from owned domains
  const ownedEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === domainBare.toLowerCase());
  let expiryHtml = '';
  if (ownedEntry?.expirationMs) {
    const daysLeft = Math.max(0, Math.ceil((ownedEntry.expirationMs - Date.now()) / 86_400_000));
    const expiryDate = new Date(ownedEntry.expirationMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const urgencyCls = daysLeft <= 30 ? ' ski-nft-expiry--urgent' : daysLeft <= 90 ? ' ski-nft-expiry--warn' : '';
    expiryHtml = `<span class="ski-nft-expiry${urgencyCls}">${expiryDate} \u00b7 ${daysLeft}d</span>`;
  }

  popover.innerHTML = `
    <div class="ski-nft-card">
      <a class="ski-nft-qr" id="ski-nft-qr-slot" href="${esc(suiSkiUrl)}" target="_blank" rel="noopener" title="${esc(domainBare)}.sui.ski"></a>
      <div class="ski-nft-info">
        <span class="ski-nft-domain">${esc(domainBare)}<span class="ski-nft-tld">.sui</span></span>
        <a class="ski-nft-link" href="${esc(suiSkiUrl)}" target="_blank" rel="noopener">${esc(domainBare)}.sui.ski \u2197</a>
        ${expiryHtml}
      </div>
      <div class="ski-nft-owner">${ownerBadge}</div>
    </div>`;

  // Position popover beside the chip: right for left-column chips, left for right-column chips
  const rect = chip.getBoundingClientRect();
  popover.removeAttribute('hidden');
  popover.style.left = '0'; popover.style.top = '0';
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  let top = rect.top + rect.height / 2 - ph / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  const grid = chip.closest('.wk-ns-owned-grid') as HTMLElement | null;
  const gridMid = grid ? grid.getBoundingClientRect().left + grid.clientWidth / 2 : window.innerWidth / 2;
  const inLeftCol = rect.left + rect.width / 2 < gridMid;
  let left: number;
  if (inLeftCol) {
    left = rect.right + 8;
  } else {
    left = rect.left - pw - 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  // Async load QR
  const qrSlot = popover.querySelector('#ski-nft-qr-slot');
  if (qrSlot) {
    getQrSvg(suiSkiUrl).then(svg => {
      if (!popover.hasAttribute('hidden')) qrSlot.innerHTML = svg;
    }).catch(() => {});
  }
}

function _attachNftPopoverListeners() {
  const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
  if (!grid) return;
  grid.addEventListener('mouseenter', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.wk-ns-owned-chip');
    if (!chip?.dataset.domain) return;
    // Don't show NFT popover for shade/wishlist chips or dimmed (filtered-out) chips
    if (chip.dataset.shade === '1' || chip.dataset.wish === '1') return;
    if (chip.classList.contains('wk-ns-owned-chip--dim')) return;
    _showNftPopover(chip, chip.dataset.domain);
  }, true);
  grid.addEventListener('mouseleave', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.wk-ns-owned-chip');
    if (!chip) return;
    _hideNftPopover();
  }, true);
  // Dimmed chips: show popover on click instead of hover
  grid.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.wk-ns-owned-chip');
    if (!chip?.dataset.domain) return;
    if (!chip.classList.contains('wk-ns-owned-chip--dim')) return;
    if (chip.dataset.shade === '1' || chip.dataset.wish === '1') return;
    e.stopPropagation();
    // Toggle: if popover is already showing for this chip, hide it
    if (_nftPopover && !_nftPopover.hasAttribute('hidden')) {
      _nftPopover.setAttribute('hidden', '');
      return;
    }
    _showNftPopover(chip, chip.dataset.domain);
  });
}

/** Fetch owned SuiNS domains for the connected wallet (cached per address). */
async function _fetchOwnedDomains() {
  const ws = getState();
  if (!ws.address) return;
  const fetchAddr = nsRealOwnerAddr || ws.address;
  if (nsOwnedFetchedFor === fetchAddr) return; // already fetched
  nsOwnedFetchedFor = fetchAddr;

  // Try localStorage cache first for instant render
  const cached = _loadCachedOwnedDomains(fetchAddr);
  if (cached) {
    nsOwnedDomains = cached;
    _patchNsOwnedList();
  }

  // Always fetch fresh in background and update
  try {
    const fresh = await fetchOwnedDomains(fetchAddr);
    nsOwnedDomains = fresh;
    _cacheOwnedDomains(fetchAddr, fresh);
    _patchNsOwnedList();
  } catch {
    // Silently fail — cached data (if any) still showing
  }

  // Fetch shade orders (localStorage + on-chain reconciliation)
  _fetchShadeOrdersForRoster(fetchAddr);
}

async function _fetchShadeOrdersForRoster(address: string) {
  try {
    const local = getShadeOrders(address);
    const onChain = await fetchOnChainShadeOrders(address);
    const localIds = new Set(local.map(o => o.objectId));

    // Merge: keep all localStorage orders, add orphaned on-chain orders not in localStorage
    // Also reconcile placeholder IDs with real on-chain IDs
    const merged: Array<ShadeOrderInfo & { orphaned?: boolean; sealedPayload?: string; commitment?: string }> = local
      .filter(o => !_shadeCancelledIds.has(o.objectId))
      .map(o => ({ ...o }));
    // Build set of on-chain IDs for stale-detection
    const onChainIds = new Set(onChain.map(o => o.objectId));
    // Track which merged entries have been matched to an on-chain order
    const matchedMergedIdx = new Set<number>();

    // Reconcile on-chain orders with local orders
    for (const oc of onChain) {
      if (_shadeCancelledIds.has(oc.objectId)) continue;
      // Direct ID match — already in merged
      if (localIds.has(oc.objectId)) continue;

      // Strategy 1: match a local order with a stale/placeholder objectId by deposit amount
      const staleIdx = merged.findIndex((m, i) =>
        !matchedMergedIdx.has(i)
        && m.domain
        && !onChainIds.has(m.objectId) // local objectId doesn't exist on-chain (stale)
        && String(m.depositMist) === String(oc.depositMist),
      );
      if (staleIdx >= 0) {
        matchedMergedIdx.add(staleIdx);
        const old = merged[staleIdx];
        removeShadeOrder(address, old.objectId);
        old.objectId = oc.objectId;
        addShadeOrder(address, old);
        continue;
      }

      // Strategy 2: use DO state to recover domain info
      const doMatch = _shadeDoState?.orders.find(o => o.objectId === oc.objectId);

      // Strategy 3: match a local order by domain (from DO) when local has wrong objectId
      if (doMatch) {
        const domainIdx = merged.findIndex((m, i) =>
          !matchedMergedIdx.has(i) && m.domain === doMatch.domain && !onChainIds.has(m.objectId),
        );
        if (domainIdx >= 0) {
          matchedMergedIdx.add(domainIdx);
          removeShadeOrder(address, merged[domainIdx].objectId);
          merged[domainIdx].objectId = oc.objectId;
          addShadeOrder(address, merged[domainIdx]);
          continue;
        }
      }

      // No match — add (orphaned if no DO info, recovered if DO knows the domain)
      const recovered: ShadeOrderInfo & { orphaned?: boolean; sealedPayload?: string; commitment?: string } = {
        objectId: oc.objectId,
        domain: doMatch?.domain ?? '',
        owner: address,
        depositMist: BigInt(oc.depositMist),
        executeAfterMs: doMatch?.executeAfterMs ?? 0,
        targetAddress: doMatch?.targetAddress ?? '',
        salt: doMatch?.salt ?? '',
        orphaned: !doMatch,
        sealedPayload: oc.sealedPayload,
        commitment: oc.commitment,
      };
      merged.push(recovered);
      // Persist DO-recovered orders to localStorage so findShadeOrder() works
      if (doMatch?.domain) {
        addShadeOrder(address, recovered);
      }
    }
    // Prune completed orders — on-chain ShadeOrder consumed (no longer exists)
    // An order is completed if: (a) DO says completed, OR (b) the domain is now owned
    const completedDomains: string[] = [];
    for (let i = merged.length - 1; i >= 0; i--) {
      const m = merged[i];
      if (onChainIds.has(m.objectId)) continue; // still exists on-chain, not consumed
      const doMatch = _shadeDoState?.orders.find(o =>
        (o.objectId === m.objectId || o.domain === m.domain) && o.status === 'completed',
      );
      const domainNowOwned = m.domain && nsOwnedDomains.some(d =>
        d.name.replace(/\.sui$/, '').toLowerCase() === m.domain.toLowerCase(),
      );
      if (doMatch || domainNowOwned) {
        completedDomains.push(m.domain || doMatch?.domain || '');
        removeShadeOrder(address, m.objectId);
        merged.splice(i, 1);
      }
    }
    if (completedDomains.length > 0) {
      for (const d of completedDomains) if (d) showToast(`${d}.sui shade completed \u2713`);
    }

    // Prune cancelled IDs that no longer exist on-chain (order was actually deleted)
    let pruned = false;
    for (const cid of _shadeCancelledIds) {
      if (!onChainIds.has(cid)) { _shadeCancelledIds.delete(cid); pruned = true; }
    }
    if (pruned) _persistShadeCancelled();

    nsShadeOrders = merged;
    _patchNsOwnedList();
  } catch {
    // Silently fail — roster still works without shade chips
  }
}

function _patchNsRoute() {
  const el = document.getElementById('wk-ns-route');
  if (!el) return;
  if (_suiamiVerifyHtml) { el.innerHTML = _suiamiVerifyHtml; return; }
  el.innerHTML = _nsRouteHtml();
}

// Standalone shape SVGs matching ski.svg dot variants exactly:
// - stroke-width = 10% of size (matches ski.svg proportions: sw30 on 310/304 elements)
// - blue square: #4da2ff, no rounded corners (ski.svg rect has no rx)
// - green circle: #22c55e
// - black diamond: white outer polygon + black inner polygon (replicates dot-outer/dot-inner layering)
function _shapeOnlySvg(variant: SkiDotVariant, sizePx = 22): string {
  const s = sizePx;
  const sw = Math.max(1.5, s * 0.10);
  const half = s / 2;
  const pad = sw / 2 + 0.5;
  const ns = `xmlns="http://www.w3.org/2000/svg"`;
  const base = `width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" ${ns} style="display:block"`;
  if (variant === 'green-circle') {
    const r = half - pad;
    return `<svg ${base}><circle cx="${half}" cy="${half}" r="${r}" fill="#22c55e" stroke="white" stroke-width="${sw}"/></svg>`;
  }
  if (variant === 'blue-square') {
    const inner = s - pad * 2;
    const rx = Math.max(2, Math.round(s * 0.16));
    const tsw = Math.max(1, Math.round(s * 0.07));
    return `<svg ${base}><rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${rx}" fill="#4da2ff" stroke="white" stroke-width="${tsw}"/></svg>`;
  }
  if (variant === 'red-hexagon') {
    const r = half - pad;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return `${half + r * Math.cos(a)},${half + r * Math.sin(a)}`;
    }).join(' ');
    return `<svg ${base}><polygon points="${pts}" fill="#ef4444" stroke="white" stroke-width="${sw}"/></svg>`;
  }
  // black-diamond: white outline with dark fill visible on both dark and light backgrounds
  const outerPad = pad;
  const innerPad = pad + sw * 1.1;
  const outerPath = `M${half},${outerPad} L${s - outerPad},${half} L${half},${s - outerPad} L${outerPad},${half}Z`;
  const innerPath = `M${half},${innerPad} L${s - innerPad},${half} L${half},${s - innerPad} L${innerPad},${half}Z`;
  return `<svg ${base}><path d="${outerPath}" fill="white"/><path d="${innerPath}" fill="#141424"/></svg>`;
}

function _nsStatusSvg(variant: SkiDotVariant): string {
  return _shapeOnlySvg(variant);
}

/** True if label is a syntactically valid SuiNS name (lowercase alphanum + hyphens, no leading/trailing hyphen). */
function isValidNsLabel(label: string): boolean {
  return label.length >= 3 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/** Derive the status icon variant from current nsLabel + nsAvail state. */
function _nsVariant(): SkiDotVariant {
  const label = nsLabel.trim();
  // Invalid or empty label → always black diamond
  if (!label || !isValidNsLabel(label)) return 'black-diamond';
  // Shade order overrides — show red hexagon if we have an active shade order for this domain
  if (nsShadeOrder && nsShadeOrder.domain === label) return 'red-hexagon';
  if (nsAvail === 'available') return 'green-circle';
  if (nsAvail === 'grace') return 'red-hexagon';
  if (nsAvail === 'taken' || nsAvail === 'owned') return 'blue-square';
  // Pending (nsAvail === null) — check owned roster first
  const bareLabel = label.toLowerCase();
  const inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel);
  if (inRoster) return 'blue-square';
  // Unknown — show black diamond until resolution completes (don't assume available)
  return 'black-diamond';
}

function _patchNsStatus() {
  const icon = document.getElementById('wk-ns-status');
  if (!icon) return;
  const variant = _nsVariant();
  icon.innerHTML = _nsStatusSvg(variant);
  const sec = document.getElementById('wk-dd-ns-section');
  const isOwned = nsAvail === 'owned';
  const hasActiveShade = !!nsShadeOrder && nsShadeOrder.domain === nsLabel.trim();
  const isGrace = nsAvail === 'grace' || hasActiveShade;
  // --available: only when confirmed available (not pending)
  const looksAvailable = nsAvail === 'available' && !hasActiveShade;
  const walletAddrLower = getState().address?.toLowerCase() ?? '';
  const isSelfTarget = walletAddrLower !== '' && (
    (!!nsTargetAddress && nsTargetAddress.toLowerCase() === walletAddrLower) ||
    (!!nsNftOwner && nsNftOwner.toLowerCase() === walletAddrLower) ||
    nsAvail === 'owned'
  );
  sec?.classList.toggle('wk-dd-ns-section--available',    looksAvailable);
  sec?.classList.toggle('wk-dd-ns-section--owned',        nsAvail === 'owned');
  sec?.classList.toggle('wk-dd-ns-section--taken',        nsAvail === 'taken');
  sec?.classList.toggle('wk-dd-ns-section--grace',        isGrace);
  sec?.classList.toggle('wk-dd-ns-section--self-target',  isSelfTarget);
  const graceClickable = isGrace && !!nsShadeOrder;
  icon.style.cursor = (isSelfTarget || isOwned || graceClickable) ? 'pointer' : 'default';
  icon.title = graceClickable ? `Cancel all Shade orders` : isSelfTarget ? `Set ${nsLabel.trim()}.sui as primary name` : isOwned ? `Manage ${nsLabel.trim()}.sui` : '';
  const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
  const sendBtnNs = document.getElementById('wk-send-btn') as HTMLElement | null;
  if (btn) {
    const isPurple = isOwned || isSelfTarget;

    // ── Shade: grace-period or shaded domains get special button states ──
    if (isGrace) {
      // Look up shade order for this domain — localStorage first, then roster, then DO
      const addr = getState().address;
      nsShadeOrder = addr ? findShadeOrder(addr, nsLabel.trim()) : null;
      if (!nsShadeOrder) {
        const rosterMatch = nsShadeOrders.find(o => o.domain === nsLabel.trim());
        if (rosterMatch) nsShadeOrder = rosterMatch;
      }
      if (!nsShadeOrder && _shadeDoState) {
        const doMatch = _shadeDoState.orders.find(
          o => o.domain === nsLabel.trim() && o.ownerAddress === addr && (o.status === 'pending' || o.status === 'executing' || o.status === 'failed'),
        );
        if (doMatch) {
          nsShadeOrder = {
            objectId: doMatch.objectId,
            domain: doMatch.domain,
            executeAfterMs: doMatch.executeAfterMs,
            targetAddress: doMatch.targetAddress,
            salt: doMatch.salt,
            depositMist: doMatch.depositMist,
          };
        }
      }
      const graceExpired = nsGraceEndMs > 0 && Date.now() >= nsGraceEndMs;

      // Remove old shade classes
      btn.classList.remove('wk-shade-ready', 'wk-shade-active', 'wk-shade-execute');

      // If localStorage has no order, check on-chain (async) — handles cases
      // where findCreatedShadeOrderId failed after tx submission.
      // Filter out recently cancelled IDs so GraphQL indexing lag doesn't re-add them.
      if (!nsShadeOrder && addr) {
        fetchOnChainShadeOrders(addr).then(onChain => {
          const live = onChain.filter(o => !_shadeCancelledIds.has(o.objectId));
          if (live.length > 0 && nsAvail === 'grace') {
            // Found on-chain order(s) — persist to localStorage so findShadeOrder
            // picks it up on the next _patchNsStatus() call (avoids overwrite loop)
            const recovered: ShadeOrderInfo = {
              objectId: live[0].objectId,
              domain: nsLabel.trim(),
              executeAfterMs: nsGraceEndMs,
              targetAddress: addr,
              salt: '',
              depositMist: live[0].depositMist,
            };
            addShadeOrder(addr, recovered);
            nsShadeOrder = recovered;
            // Re-render the button now that we know about the on-chain order
            _patchNsStatus();
          }
        }).catch(() => {});
      }

      // Also check DO state for an active order on this domain (covers cases
      // where localStorage was cleared but the DO still tracks the order)
      if (!nsShadeOrder && _shadeDoState) {
        const doMatch = _shadeDoState.orders.find(
          o => o.domain === nsLabel.trim() && o.ownerAddress === addr && (o.status === 'pending' || o.status === 'executing'),
        );
        if (doMatch) {
          nsShadeOrder = {
            objectId: doMatch.objectId,
            domain: doMatch.domain,
            executeAfterMs: doMatch.executeAfterMs,
            targetAddress: doMatch.targetAddress,
            salt: doMatch.salt,
            depositMist: doMatch.depositMist,
          };
        }
      }

      if (!nsShadeOrder) {
        // No order → amber pulsing crosshair — "Set up Shade"
        btn.disabled = false;
        btn.textContent = '\u2299'; // ⊙ crosshair
        btn.title = `Shade ${nsLabel.trim()}.sui — lock funds for grace expiry`;
        btn.classList.add('wk-shade-ready');
      } else if (graceExpired) {
        // Order exists + grace expired → green bright arrow — "Execute now"
        btn.disabled = false;
        btn.textContent = '\u2192'; // → arrow
        btn.title = `Execute Shade — register ${nsLabel.trim()}.sui now`;
        btn.classList.add('wk-shade-execute');
      } else {
        // Order exists + grace active → green check, red ✕ on hover — "Cancel Shade"
        btn.disabled = false;
        btn.textContent = ''; // content handled by CSS ::after (✓ → ✕ on hover)
        btn.title = `Cancel Shade \u2014 refund ${(Number(nsShadeOrder.depositMist) / 1e9).toFixed(2)} SUI`;
        btn.classList.add('wk-shade-active');
        _startShadeCountdown();
      }
      // Grace: show register, hide send
      btn.style.display = '';
      if (sendBtnNs) sendBtnNs.style.display = 'none';
    } else if (_nsListing()) {
      // Marketplace listing — let wk-send-btn handle BUY mode, hide register button
      btn.classList.remove('wk-shade-ready', 'wk-shade-active', 'wk-shade-execute');
      btn.disabled = true;
      btn.style.display = 'none';
      if (sendBtnNs) sendBtnNs.style.display = '';
    } else {
      // Non-grace states — standard behavior
      btn.classList.remove('wk-shade-ready', 'wk-shade-active', 'wk-shade-execute');
      // Always hide the old register button — MINT/SEND/SUIAMI buttons handle all actions
      btn.disabled = true;
      btn.textContent = '\u2192';
      btn.style.display = 'none';
      if (sendBtnNs) sendBtnNs.style.display = '';
      if (variant === 'black-diamond') btn.title = 'Invalid SuiNS name';
      else if (isPurple && !nsSubnameParent) btn.title = 'Already registered';
    }
  }
  _patchNsRoute();
  // Notify send button mode may need updating
  document.getElementById('wk-send-btn')?.dispatchEvent(new Event('ns-status-change'));
}

/** Format grace countdown: "12d" when ≥1 day, "5h 23m" when <1 day. */
function _graceCountdown(): string {
  const ms = nsGraceEndMs - Date.now();
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

/** Format grace end in EST compactly, e.g. "Mar5 3:42p". */
function _graceEndDate(): string {
  if (!nsGraceEndMs) return '';
  const tz = 'America/New_York';
  const d = new Date(nsGraceEndMs);
  const mo = d.toLocaleDateString('en-US', { month: 'short', timeZone: tz });
  const day = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: tz });
  const h = +d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
  const m = d.toLocaleString('en-US', { minute: '2-digit', timeZone: tz });
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const ap = h < 12 ? 'a' : 'p';
  return `${mo} ${day} ${h12}:${m}${ap}`;
}

/** Format precise countdown: "2d 14h 32m 07s" ticking every second. */
function _graceCountdownPrecise(): string {
  const ms = nsGraceEndMs - Date.now();
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days >= 1) return `${days}d ${hrs}h ${mins}m ${String(secs).padStart(2, '0')}s`;
  if (hrs >= 1) return `${hrs}h ${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

/** Start live countdown that ticks every second when Shade is active + grace running.
 *  Also connects to ShadeExecutorAgent DO for real-time state updates. */
function _startShadeCountdown() {
  _stopShadeCountdown();
  if (!nsShadeOrder || !nsGraceEndMs || nsGraceEndMs <= Date.now()) return;

  // Connect to DO for live state updates (order status, execution results)
  const addr = getState().address;
  if (addr) {
    try {
      connectShadeExecutor(addr, (state: ShadeExecutorState) => {
        _shadeDoState = state;

        // ── Roster-wide: prune completed shade orders from the roster + localStorage ──
        let rosterChanged = false;
        for (const doOrder of state.orders) {
          if (doOrder.status !== 'completed') continue;
          const idx = nsShadeOrders.findIndex(o => o.objectId === doOrder.objectId || o.domain === doOrder.domain);
          if (idx >= 0) {
            const removed = nsShadeOrders.splice(idx, 1)[0];
            removeShadeOrder(addr, removed.objectId);
            rosterChanged = true;
            const digest = doOrder.digest ? ` ${doOrder.digest.slice(0, 8)}\u2026` : '';
            showToast(`${removed.domain || doOrder.domain}.sui auto-registered \u2713${digest}`);
          }
        }
        if (rosterChanged) _patchNsOwnedList();

        // ── Focused domain: update status/price/route when the active shade completes ──
        if (nsShadeOrder) {
          const doOrder = state.orders.find(o => o.objectId === nsShadeOrder!.objectId);
          if (doOrder?.status === 'completed') {
            removeShadeOrder(addr, nsShadeOrder.objectId);
            nsShadeOrder = null;
            _stopShadeCountdown();
            nsAvail = 'owned';
            _patchNsStatus();
            _patchNsPrice();
            _patchNsRoute();
            if (!rosterChanged) _patchNsOwnedList(); // avoid double-patch
            return;
          }
          if (doOrder?.status === 'failed') {
            _patchNsStatus();
            if (!_shadeFailedToastShown.has(doOrder.objectId)) {
              _shadeFailedToastShown.add(doOrder.objectId);
              const errMsg = doOrder.error ? ` (${doOrder.error.slice(0, 50)})` : '';
              showToastWithRetry(`Shade failed${errMsg}`, 'Retry', async () => {
                _shadeFailedToastShown.delete(doOrder.objectId);
                const a = getState().address;
                if (!a) return;
                try {
                  await resetFailedShadeOrders(a, doOrder.objectId);
                  showToast('Retrying shade execution\u2026');
                } catch { showToast('Retry request failed'); }
              });
            }
            return;
          }
          // If DO doesn't know about this order yet, schedule it
          if (!doOrder && nsShadeOrder && nsShadeOrder.salt) {
            scheduleShadeExecution({
              objectId: nsShadeOrder.objectId,
              domain: nsShadeOrder.domain,
              executeAfterMs: nsShadeOrder.executeAfterMs,
              targetAddress: nsShadeOrder.targetAddress,
              salt: nsShadeOrder.salt,
              ownerAddress: addr,
              depositMist: String(nsShadeOrder.depositMist),
              preferredRoute: 'sui-ns',
            }).catch(() => {});
          }
        }
      });
    } catch { /* non-blocking */ }
  }

  _shadeCountdownTimer = setInterval(() => {
    const now = Date.now();
    // Update the pill text
    const pill = document.querySelector('.wk-shade-pill:not(.wk-shade-pill--ready)') as HTMLElement | null;
    if (pill) pill.textContent = _graceCountdownPrecise();
    // Update grace date in route row
    const graceSpan = document.querySelector('.wk-ns-target-grace') as HTMLElement | null;
    if (graceSpan) graceSpan.textContent = _graceCountdownPrecise();
    // Update button title
    const btn = document.getElementById('wk-dd-ns-register');
    if (btn?.classList.contains('wk-shade-active')) btn.title = `Shaded! ${_graceCountdownPrecise()} remaining`;
    // Show DO order status in title if available
    if (btn?.classList.contains('wk-shade-active') && _shadeDoState && nsShadeOrder) {
      const doOrder = _shadeDoState.orders.find(o => o.objectId === nsShadeOrder!.objectId);
      if (doOrder?.status === 'executing') btn.title = `Executing\u2026 ${_graceCountdownPrecise()}`;
    }
    // Auto-flip to "ready/execute" when countdown hits zero
    if (now >= nsGraceEndMs) {
      _stopShadeCountdown();
      _patchNsStatus();
      _patchNsPrice();
    }
  }, 1000);
}

function _stopShadeCountdown() {
  if (_shadeCountdownTimer) { clearInterval(_shadeCountdownTimer); _shadeCountdownTimer = null; }
  if (_shadeChipTimer) { clearInterval(_shadeChipTimer); _shadeChipTimer = null; }
  _shadeDoState = null;
}

function _nsPriceHtml(): string {
  if (nsLabel.length < 3) return '';
  const variant = _nsVariant();
  if (variant === 'black-diamond') return ''; // invalid label — no spinner
  // Marketplace listing — show price in USD
  const _activeListing = _nsListing();
  if (_activeListing && (nsAvail === 'taken' || nsAvail === 'grace')) {
    const sui = Number(BigInt(_activeListing.priceMist)) / 1e9;
    const fee = _activeListing.source === 'tradeport' ? sui * 0.03 : 0;
    const totalSui = sui + fee;
    const usdVal = suiPriceCache ? (totalSui * suiPriceCache.price) : null;
    const priceText = usdVal != null ? `$${usdVal.toFixed(2)}` : `${fmtSui(totalSui)} SUI`;
    return `<span class="wk-ns-price-val wk-ns-kiosk-pill">${priceText}</span>`;
  }
  // Grace period (no marketplace listing) — shade countdown or registration cost
  if (nsAvail === 'grace') {
    if (nsShadeOrder) {
      const graceExpired = nsGraceEndMs > 0 && Date.now() >= nsGraceEndMs;
      if (graceExpired) return `<span class="wk-ns-price-val wk-shade-pill wk-shade-pill--ready">ready</span>`;
      return `<span class="wk-ns-price-val wk-shade-pill">${_graceCountdownPrecise()}</span>`;
    }
    if (nsPriceUsd != null) {
      if (balView === 'sui' && suiPriceCache) {
        const sui = nsPriceUsd / suiPriceCache.price * 1.05;
        return `<span class="wk-ns-price-val wk-ns-grace-pill">${fmtSui(sui)}<img src="${SUI_DROP_URI}" class="wk-ns-price-drop" alt="SUI" aria-hidden="true"></span>`;
      }
      return `<span class="wk-ns-price-val wk-ns-grace-pill">$${nsPriceUsd.toFixed(2)}</span>`;
    }
    return `<span class="wk-ns-price-val wk-ns-grace-pill">${_graceCountdown()}</span>`;
  }
  // Don't show price for owned or self-target names — they can't be re-registered
  if (nsAvail === 'owned') return '';
  const _walletAddr = getState().address?.toLowerCase() ?? '';
  if (nsTargetAddress && nsTargetAddress.toLowerCase() === _walletAddr) return '';
  // Show price — defaults are NS-discounted (25% off base) while async fetch runs
  const len = nsLabel.replace(/\.sui$/, '').length;
  const displayPrice = nsPriceUsd ?? (len === 3 ? 375 : len === 4 ? 75 : 7.50);
  const priceStr = displayPrice < 10 ? `$${displayPrice.toFixed(2)}` : `$${displayPrice.toFixed(0)}`;
  if (balView === 'sui' && suiPriceCache && suiPriceCache.price > 0) {
    const sui = displayPrice / suiPriceCache.price;
    return `<span class="wk-ns-price-val">${fmtSui(sui)}<img src="${SUI_DROP_URI}" class="wk-ns-price-drop" alt="SUI" aria-hidden="true"></span>`;
  }
  return `<span class="wk-ns-price-val">${priceStr}</span>`;
}

// ─── Sign Message ───────────────────────────────────────────────────

const DEFAULT_MESSAGE = 'Hiroshima was an elegant implementation';
let signMessageText = DEFAULT_MESSAGE;
let lastSignResult: { signature: string; bytes: string } | null = null;

function renderSignStage() {
  if (!els.signStage) return;
  const ws = getState();
  const toggleBtn = document.getElementById('ski-tools-toggle');

  if (!ws.address) {
    els.signStage.style.display = 'none';
    els.signStage.innerHTML = '';
    lastSignResult = null;
    if (toggleBtn) toggleBtn.style.display = 'none';
    return;
  }

  if (toggleBtn) toggleBtn.style.display = '';
  // Respect collapsed state — still render content but keep hidden
  if (els.signStage.classList.contains('ski-sign--collapsed')) {
    // Content already rendered or will be on expand — skip display override
  } else {
    els.signStage.style.display = '';
  }

  // ─── Splash card ─────────────────────────────────────────────────────
  const sponsorState = getSponsorState();
  const isActiveSponsor = isSponsorActive() && sponsorState.auth?.address === ws.address;
  const hasOtherSponsor = isSponsorActive() && sponsorState.auth?.address !== ws.address;

  let sponsorCardHtml = '';
  if (isActiveSponsor) {
    const activeList = getActiveSponsoredList();

    const listRowsHtml = activeList.map((e) => {
      const primaryName = suinsCache[e.address]
        || (() => { try { return localStorage.getItem(`ski:suins:${e.address}`); } catch { return null; } })()
        || e.suinsName
        || null;
      const expiry = fmtTimeLeft(e.expiresAt);
      const addrLine = primaryName ? `<div class="splash-item-addr">${esc(truncAddr(e.address))}</div>` : '';
      return `<div class="splash-list-item" data-entry-addr="${esc(e.address)}">
        <div class="splash-item-name">${esc(primaryName ?? truncAddr(e.address))}</div>
        ${addrLine}
        <div class="splash-item-footer">
          <span class="splash-list-expiry">${esc(expiry)}</span>
          <button class="splash-list-remove" type="button" data-remove-addr="${esc(e.address)}">Remove</button>
        </div>
      </div>`;
    }).join('');

    const emptyHint = activeList.length === 0
      ? `<div class="splash-list-empty">No restrictions — any wallet may use Splash.</div>`
      : '';

    sponsorCardHtml = `
      <div class="splash-card splash-card--active">
        <div class="splash-header-row">
          <img src="${SUI_DROP_URI}" class="splash-icon-drop" aria-hidden="true">
          <span class="splash-title">Splash</span>
          <button class="splash-btn splash-btn--deactivate" id="splash-deactivate-btn" type="button">Deactivate</button>
        </div>
        <div class="splash-list">
          ${emptyHint}
          ${listRowsHtml}
        </div>
        <div class="splash-add-row">
          <input
            id="splash-add-input"
            class="splash-input"
            type="text"
            placeholder="add .sui name or address\u2026"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="splash-btn splash-btn--add" id="splash-add-btn" type="button">+ Add</button>
        </div>
      </div>`;
  } else if (hasOtherSponsor) {
    // Beneficiary view — omit the card entirely
    sponsorCardHtml = '';
  } else {
    // No active sponsor — offer to activate Splash.
    sponsorCardHtml = `
      <div class="splash-card splash-card--inactive">
        <img src="${SUI_DROP_URI}" class="splash-icon-drop" aria-hidden="true">
        <span class="splash-title">Splash</span>
        <button class="splash-btn splash-btn--activate" id="splash-activate-btn" type="button">Activate &middot; 7 days</button>
      </div>`;
  }

  // ─── Sign message card ───────────────────────────────────────────────
  const resultHtml = lastSignResult
    ? `<div class="sign-result">
        <div class="sign-result-label">Signature</div>
        <div class="sign-result-value">${esc(lastSignResult.signature)}</div>
      </div>`
    : '';

  els.signStage.innerHTML = `
    ${sponsorCardHtml}
    <div class="sign-card">
      <textarea class="sign-textarea" id="sign-msg-input" rows="2" spellcheck="false">${esc(signMessageText)}</textarea>
      <div class="sign-action-row">
        <button class="sign-btn" id="sign-msg-btn" type="button">Sign Message</button>
        ${resultHtml}
      </div>
    </div>`;

  // ─── Splash button bindings ───────────────────────────────────────────
  document.getElementById('splash-deactivate-btn')?.addEventListener('click', () => {
    deactivateSponsor();
    showToast('Splash deactivated');
    render();
    if (modalOpen) renderModal();
  });

  // Per-entry remove buttons
  els.signStage.querySelectorAll<HTMLButtonElement>('.splash-list-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const addr = btn.getAttribute('data-remove-addr') ?? '';
      if (addr) {
        removeSponsoredEntry(addr);
        showToast('Removed from Splash list');
      }
    });
  });

  document.getElementById('splash-add-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const input = document.getElementById('splash-add-input') as HTMLInputElement | null;
    const raw = input?.value.trim() ?? '';
    if (!raw) return;

    btn.disabled = true;
    btn.textContent = 'Resolving\u2026';
    try {
      const entry = await addSponsoredEntry(raw);
      const label = entry.suinsName ?? truncAddr(entry.address);
      showToast(`<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Added ${esc(label)} to Splash`, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
      btn.disabled = false;
      btn.textContent = '+ Add';
    }
  });

  document.getElementById('splash-activate-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Activating\u2026';
    try {
      const { wallet, account } = getState();
      if (!wallet || !account) throw new Error('No wallet connected');
      await activateSponsor(wallet, account);
      showToast('<img src="${SUI_DROP_URI}" class="toast-drop" aria-hidden="true"> Splash active &middot; 7 days', true);
      render();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
      btn.disabled = false;
      btn.textContent = 'Activate \u00b7 7 days';
      renderSignStage();
    }
  });

  // ─── Sign message bindings ───────────────────────────────────────────
  document.getElementById('sign-msg-input')?.addEventListener('input', (e) => {
    signMessageText = (e.target as HTMLTextAreaElement).value;
  });

  const doSign = async () => {
    const btn = document.getElementById('sign-msg-btn') as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = 'Signing\u2026'; }
    try {
      const bytes = new TextEncoder().encode(signMessageText);
      const result = await signPersonalMessage(bytes);
      lastSignResult = result;
      showToast('Message signed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signing failed';
      if (msg.includes('UserKeyring not found')) {
        showBackpackLockedToast();
      } else if (!msg.toLowerCase().includes('reject')) {
        showToast(msg);
      } else {
        showToast('Signing cancelled');
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign Message'; }
    renderSignStage();
  };

  document.getElementById('sign-msg-btn')?.addEventListener('click', doSign);

}

// ─── SKI Menu actions ─────────────────────────────────────────────────

function menuCopyAddress(e: Event) {
  e.stopPropagation();
  copyAddress();
}

function _skiSettingsHtml(): string {
  const ws = getState();
  const addrShort2 = ws.address ? `${ws.address.slice(0, 6)}\u2026${ws.address.slice(-4)}` : '\u2014';
  return `
    <div class="wk-settings-header">
      <button class="wk-settings-back" id="wk-settings-back" type="button" title="Back">\u2190</button>
      <span class="wk-settings-title">Settings</span>
    </div>
    <div class="wk-settings-body">
      <div class="wk-settings-group">
        <span class="wk-settings-group-label">Display</span>
        <div class="wk-settings-row">
          <span class="wk-settings-label">Balance</span>
          <span class="wk-settings-value">${balView === 'usd' ? 'USD' : 'SUI'}</span>
        </div>
      </div>
      <div class="wk-settings-group">
        <span class="wk-settings-group-label">Wallet</span>
        <div class="wk-settings-row">
          <span class="wk-settings-label">Address</span>
          <span class="wk-settings-value wk-settings-value--mono">${addrShort2}</span>
        </div>
        <div class="wk-settings-row">
          <span class="wk-settings-label">Provider</span>
          <span class="wk-settings-value">${ws.walletName || 'Unknown'}</span>
        </div>
      </div>
      <div class="wk-settings-group">
        <span class="wk-settings-group-label">About</span>
        <div class="wk-settings-row">
          <span class="wk-settings-label">SKI</span>
          <span class="wk-settings-value">v0.1.90</span>
        </div>
      </div>
    </div>`;
}

function menuLockin() {
  app.skiMenuOpen = false;
  try { localStorage.setItem('ski:lift', '0'); } catch {}
  render();
  openModal();
}

function menuDisconnect() {
  handleDisconnect(false);
}

function menuToggleBalance(e: Event) {
  e.stopPropagation();
  balView = (e.target as HTMLInputElement).checked ? 'usd' : 'sui';
  try { localStorage.setItem('ski:bal-pref', balView); } catch {}
  syncBalanceDisplays();
}

// ─── Render: SKI Menu ────────────────────────────────────────────────

function renderSkiMenu() {
  if (!els.skiMenu) return;
  const ws = getState();

  if (!ws.address || !app.skiMenuOpen) {
    _stopShadeCountdown();
    els.skiMenu.innerHTML = '';
    return;
  }

  // Restore cached dWallet addresses instantly (no RPC wait)
  if (!app.btcAddress && ws.address) {
    try {
      const cached = localStorage.getItem(`ski:ika:${ws.address}`);
      if (cached) {
        const c = JSON.parse(cached) as { btc: string; eth: string; id: string };
        if (c.btc) { app.btcAddress = c.btc; app.ethAddress = c.eth; app.ikaWalletId = c.id; }
      }
    } catch {}
  }

  // Auto-detect dWallet on menu render (non-blocking, updates cache)
  if (!app.btcAddress && ws.address && !_dwalletCheckInFlight) {
    _dwalletCheckInFlight = true;
    import('./client/ika.js').then(({ getCrossChainStatus }) =>
      getCrossChainStatus(ws.address)
    ).then((status) => {
      _dwalletCheckInFlight = false;
      if (status.btcAddress && status.btcAddress !== app.btcAddress) {
        app.btcAddress = status.btcAddress;
        app.ethAddress = status.ethAddress;
        app.ikaWalletId = status.dwalletId;
        try { localStorage.setItem(`ski:ika:${ws.address}`, JSON.stringify({ btc: status.btcAddress, eth: status.ethAddress, id: status.dwalletId })); } catch {}
        render();
      }
    }).catch(() => { _dwalletCheckInFlight = false; });
  }

  // Network-aware address: switches immediately on network selector change
  const _netAddr = (): { addr: string; scan: string; explorer: string; cls: string } => {
    if (networkView === 'btc' && app.btcAddress) return {
      addr: app.btcAddress,
      scan: `https://mempool.space/address/${app.btcAddress}`,
      explorer: 'View on Mempool',
      cls: 'wk-dd-address-banner--btc',
    };
    // BTC selected but no BTC address yet — show ETH if available (same dWallet key)
    if (networkView === 'btc' && app.ethAddress) return {
      addr: app.ethAddress,
      scan: `https://etherscan.io/address/${app.ethAddress}`,
      explorer: 'View on Etherscan',
      cls: 'wk-dd-address-banner--eth',
    };
    return {
      addr: ws.address,
      scan: `https://suiscan.xyz/mainnet/account/${ws.address}`,
      explorer: 'View on Suiscan',
      cls: '',
    };
  };
  const { addr: displayAddr, scan: scanUrl, explorer: explorerTitle, cls: addrBannerCls } = _netAddr();
  const needsDWallet = networkView === 'btc' && !app.btcAddress && !app.ethAddress;

  const addrShort = truncAddr(displayAddr);

  const dotSvg = balView === 'usd'
    ? `<button type="button" class="wk-popout-bal-icon-btn" id="wk-consolidate-btn" title="Consolidate tokens to USDC"><svg class="wk-popout-bal-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg></button>`
    : `<img src="${SUI_DROP_URI}" class="wk-popout-bal-icon" alt="SUI" aria-hidden="true">`;
  const balValHtml = balView === 'usd'
    ? `<span class="wk-popout-bal-val wk-popout-bal-val--usd">${fmtMenuBalHtml(app.usd)}</span>`
    : `<span class="wk-popout-bal-val wk-popout-bal-val--sui">${fmtMenuBalHtml(getTotalSui())}</span>`;
  const balToggleHtml = `<div class="wk-popout-balance">
        <span class="wk-popout-bal-display">${dotSvg}${balValHtml}</span>
        <label class="ski-layout-toggle wk-popout-bal-toggle" title="Toggle USD / SUI">
          <input type="checkbox" id="wk-bal-toggle"${balView === 'usd' ? ' checked' : ''}>
          <span class="ski-layout-track"><span class="ski-layout-thumb"></span></span>
        </label>
      </div>`;

  // Per-coin balances shown below the name badge — 2 decimal places
  const _fmtCoin2 = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'k';
    return n.toFixed(2);
  };
  const _fmtCoinHtml = (n: number, fracCls: string): string => {
    const s = _fmtCoin2(n);
    const dot = s.indexOf('.');
    if (dot < 0) return `<span class="wk-coin-whole">${esc(s)}</span>`;
    return `<span class="wk-coin-whole">${esc(s.slice(0, dot))}</span><span class="wk-coin-frac ${fracCls}">${esc(s.slice(dot))}</span>`;
  };
  const suiDropIcon = `<img src="${SUI_DROP_URI}" class="wk-popout-coin-icon" alt="SUI">`;
  const stableIcon = `<svg class="wk-popout-coin-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="20" font-weight="700" fill="white">$</text></svg>`;
  const defaultIcon = (letter: string) => `<svg class="wk-popout-coin-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#6366f1" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="16" font-weight="700" fill="white">${esc(letter)}</text></svg>`;
  const _usdMode = balView === 'usd';
  const _suiP = suiPriceCache?.price ?? 0;
  // Get USD value for a coin
  const _coinUsd = (symbol: string, bal: number, isStable: boolean): number => {
    if (isStable) return bal;
    if (symbol === 'SUI') return _suiP > 0 ? bal * _suiP : 0;
    const tp = getTokenPrice(symbol);
    return tp != null && tp > 0 ? bal * tp : 0;
  };
  const _fmtUsdChipHtml = (usd: number, showDollar = false, fracCls = 'wk-coin-frac--usd'): string => {
    const s = usd < 10_000 ? usd.toFixed(2) : (usd / 1_000).toFixed(1) + 'k';
    const prefix = showDollar ? '$' : '';
    const dot = s.indexOf('.');
    if (dot < 0) return `<span class="wk-coin-whole">${esc(prefix + s)}</span>`;
    return `<span class="wk-coin-whole">${esc(prefix + s.slice(0, dot))}</span><span class="wk-coin-frac ${fracCls}">${esc(s.slice(dot))}</span>`;
  };
  _coinChipsCache.length = 0;
  const _fallbackSuiUsd = (() => {
    if (!_usdMode || _suiP > 0 || app.usd == null || app.sui <= 0) return null;
    let otherUsd = 0;
    for (const c of walletCoins) {
      if (c.symbol === 'SUI') continue;
      otherUsd += _coinUsd(c.symbol, c.balance, c.isStable);
    }
    const residual = app.usd - otherUsd;
    return residual > 0 ? residual : null;
  })();
  let hasSuiChip = false;
  for (const c of walletCoins) {
    let usd = _coinUsd(c.symbol, c.balance, c.isStable);
    if (_usdMode && c.symbol === 'SUI' && usd <= 0 && _fallbackSuiUsd != null) {
      usd = _fallbackSuiUsd;
    }
    // In USD mode, filter out coins worth less than $0.10 (except SUI — always show gas token)
    if (_usdMode && usd < 0.01 && c.symbol !== 'SUI') continue;
    // Filter dust amounts regardless of mode
    if (!c.isStable && c.symbol !== 'SUI' && c.balance < 0.001 && usd < 0.01) continue;
    const isSui = c.symbol === 'SUI';
    if (isSui) hasSuiChip = true;
    // Use on-chain icon if available, else known icons, else default letter
    const meta = _coinMetaCache[c.coinType];
    const metaIcon = meta?.iconUrl ? `<img src="${esc(meta.iconUrl)}" class="wk-popout-coin-icon" alt="${esc(c.symbol)}">` : null;
    const ikaIcon = `<svg class="wk-popout-coin-icon" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#EE2B5B"/><g transform="translate(6,3) scale(0.29)" stroke="white" stroke-width="5.7" fill="none"><path d="M72.662 71.076V46.717C72.662 33.265 61.756 22.359 48.304 22.359C34.851 22.359 23.945 33.265 23.945 46.717V71.076"/><path d="M72.663 62.956V72.428C72.663 77.66 76.904 81.901 82.136 81.901C87.367 81.901 91.608 77.66 91.608 72.428V62.956"/><path d="M58.297 95.641V81.207C58.297 75.688 53.823 71.214 48.304 71.214C42.785 71.214 38.311 75.688 38.311 81.207V95.641"/><path d="M5 62.956V72.428C5 77.66 9.241 81.901 14.473 81.901C19.704 81.901 23.945 77.66 23.945 72.428V62.956"/><path d="M48.307 57.542C52.791 57.542 56.426 53.906 56.426 49.422C56.426 44.938 52.791 41.303 48.307 41.303C43.823 41.303 40.188 44.938 40.188 49.422C40.188 50.254 40.313 51.057 40.545 51.813C41.182 50.403 42.6 49.422 44.247 49.422C46.489 49.422 48.307 51.239 48.307 53.482C48.307 55.129 47.326 56.547 45.916 57.184C46.672 57.416 47.475 57.542 48.307 57.542Z" fill="white"/></g></svg>`;
    const icon = isSui ? suiDropIcon
      : c.symbol === 'NS' ? `<img src="${NS_ICON_URI}" class="wk-popout-coin-icon" alt="NS">`
      : c.symbol === 'WAL' ? `<img src="${WAL_ICON_URI}" class="wk-popout-coin-icon" alt="WAL">`
      : c.symbol === 'XAUM' ? `<img src="${AU_ICON_URI}" class="wk-popout-coin-icon" alt="Au">`
      : c.symbol === 'IKA' ? ikaIcon
      : c.isStable ? stableIcon
      : metaIcon ?? defaultIcon(c.symbol.charAt(0));
    const colorCls = isSui ? 'wk-coin-item--sui' : c.isStable ? 'wk-coin-item--usd' : c.symbol === 'XAUM' ? 'wk-coin-item--gold' : c.symbol === 'IKA' ? 'wk-coin-item--ika' : 'wk-coin-item--other';
    // Tooltip: amount, token name, (price per token)
    const tp = isSui ? _suiP : getTokenPrice(c.symbol);
    const tokenName = c.symbol;
    const balFmt = c.balance < 0.001 ? c.balance.toExponential(2) : c.balance < 1 ? c.balance.toFixed(6) : c.balance < 1000 ? c.balance.toFixed(4) : c.balance.toFixed(2);
    const priceFmt = !c.isStable && tp != null && tp > 0 ? ` ($${tp < 0.01 ? tp.toFixed(6) : tp < 1 ? tp.toFixed(4) : tp < 100 ? tp.toFixed(2) : _fmtUsd(tp)})` : '';
    const tooltip = `${balFmt} ${tokenName}${priceFmt}`;
    const fracCls = isSui ? 'wk-coin-frac--sui' : c.isStable ? 'wk-coin-frac--usd' : c.symbol === 'XAUM' ? 'wk-coin-frac--gold' : c.symbol === 'IKA' ? 'wk-coin-frac--ika' : 'wk-coin-frac--other';
    if (_usdMode) {
      _coinChipsCache.push({ icon, val: usd, html: _fmtUsdChipHtml(usd, !c.isStable, fracCls), key: c.symbol.toLowerCase(), colorCls, tooltip });
    } else {
      _coinChipsCache.push({ icon, val: c.balance, html: _fmtCoinHtml(c.balance, fracCls), key: c.symbol.toLowerCase(), colorCls, tooltip });
    }
  }
  // Preserve the SUI chip even if the live balance list or price fetch is temporarily incomplete.
  if (!hasSuiChip && app.sui > 0) {
    const suiBal = app.sui < 1 ? app.sui.toFixed(6) : app.sui < 1000 ? app.sui.toFixed(4) : app.sui.toFixed(2);
    const suiTip = `${suiBal} SUI ($${_suiP > 0 ? _suiP.toFixed(2) : '?'})`;
    if (_usdMode) {
      const suiUsd = _suiP > 0 ? app.sui * _suiP : _fallbackSuiUsd;
      if (suiUsd != null && suiUsd >= 0.10) {
        _coinChipsCache.push({ icon: suiDropIcon, val: suiUsd, html: _fmtUsdChipHtml(suiUsd, true, 'wk-coin-frac--sui'), key: 'sui', colorCls: 'wk-coin-item--sui', tooltip: suiTip });
      }
    } else {
      _coinChipsCache.push({ icon: suiDropIcon, val: app.sui, html: _fmtCoinHtml(app.sui, 'wk-coin-frac--sui'), key: 'sui', colorCls: 'wk-coin-item--sui', tooltip: suiTip });
    }
  }
  // Always show stable chip if user has stablecoins and no stable chip was added from walletCoins
  const hasStableChip = _coinChipsCache.some(c => c.colorCls === 'wk-coin-item--usd');
  if (!hasStableChip && app.stableUsd > 0) {
    const stableBal = app.stableUsd < 1 ? app.stableUsd.toFixed(4) : app.stableUsd.toFixed(2);
    _coinChipsCache.push({ icon: stableIcon, val: app.stableUsd, html: _usdMode ? _fmtUsdChipHtml(app.stableUsd) : _fmtCoinHtml(app.stableUsd, 'wk-coin-frac--usd'), key: 'usd', colorCls: 'wk-coin-item--usd', tooltip: `${stableBal} USDC` });
  }
  _coinChipsCache.sort((a, b) => b.val - a.val);
  // Auto-select: if 'USD' (balView default), match the first stablecoin chip; otherwise highest value
  if (selectedCoinSymbol === 'USD' && _coinChipsCache.length) {
    const stableChip = _coinChipsCache.find(c => c.colorCls === 'wk-coin-item--usd');
    if (stableChip) selectedCoinSymbol = stableChip.key.toUpperCase();
  }
  if (!selectedCoinSymbol && _coinChipsCache.length) {
    selectedCoinSymbol = _coinChipsCache[0].key.toUpperCase();
  }
  // Auto-select highest-value token if none selected
  if (!selectedCoinSymbol && _coinChipsCache.length) {
    selectedCoinSymbol = _coinChipsCache[0].key.toUpperCase();
  }
  let _selKey = selectedCoinSymbol?.toLowerCase() ?? '';
  let _selIdx = _coinChipsCache.findIndex(c => c.key === _selKey);
  if (_selIdx < 0 && _coinChipsCache.length) {
    // Selected coin no longer exists — reset to highest value
    _selIdx = 0;
    selectedCoinSymbol = _coinChipsCache[0].key.toUpperCase();
    _selKey = _coinChipsCache[0].key;
  } else if (_selIdx >= 0 && _coinChipsCache[_selIdx].val < 0.01 && _coinChipsCache.length) {
    // Selected coin value dropped below $0.01 — switch to highest value
    _selIdx = 0;
    selectedCoinSymbol = _coinChipsCache[0].key.toUpperCase();
    _selKey = _coinChipsCache[0].key;
  } else if (!_userManuallySelectedCoin && _coinChipsCache.length && _selIdx !== 0) {
    // User hasn't manually picked — keep selecting highest-value token as data loads
    _selIdx = 0;
    selectedCoinSymbol = _coinChipsCache[0].key.toUpperCase();
    _selKey = _coinChipsCache[0].key;
  }
  const _selChip = _selIdx >= 0 ? _coinChipsCache[_selIdx] : _coinChipsCache[0];
  const _canCycle = _coinChipsCache.length > 1;
  const _arrowDisabled = _canCycle ? '' : ' disabled';
  const _prevIdx = _canCycle ? ((_selIdx - 1 + _coinChipsCache.length) % _coinChipsCache.length) : _selIdx;
  const _nextIdx = _canCycle ? ((_selIdx + 1) % _coinChipsCache.length) : _selIdx;
  const _prevChip = _coinChipsCache[_prevIdx];
  const _nextChip = _coinChipsCache[_nextIdx];
  const _prevColor = _prevChip?.colorCls?.replace('wk-coin-item--', '') ?? '';
  const _nextColor = _nextChip?.colorCls?.replace('wk-coin-item--', '') ?? '';
  const _chipUsdTip = (c: typeof _prevChip) => {
    if (!c) return '';
    const sym = c.key.toUpperCase();
    const usd = _usdMode ? c.val : (() => {
      if (c.colorCls === 'wk-coin-item--usd') return c.val;
      if (c.colorCls === 'wk-coin-item--sui') return _suiP > 0 ? c.val * _suiP : 0;
      const tp = getTokenPrice(sym); return tp && tp > 0 ? c.val * tp : 0;
    })();
    return usd > 0 ? `$${usd < 100 ? usd.toFixed(2) : usd < 10_000 ? usd.toFixed(0) : (usd / 1_000).toFixed(1) + 'k'} ${sym}` : sym;
  };
  const _prevTip = _chipUsdTip(_prevChip);
  const _nextTip = _chipUsdTip(_nextChip);
  // Build coin picker grid (all coins except selected)
  const _coinGridItems = _coinChipsCache.map((c, i) => {
    if (i === _selIdx) return '';
    const color = c.colorCls?.replace('wk-coin-item--', '') ?? '';
    const usdTip = _chipUsdTip(c);
    return `<button class="wk-coin-grid-item wk-coin-grid-item--${color}" data-coin-pick="${esc(c.key)}" type="button" title="${esc(usdTip)}">${c.icon}<span class="wk-coin-grid-val">${c.html}</span></button>`;
  }).filter(Boolean).join('');
  const _coinGridHtml = _coinGridItems ? `<div id="wk-coin-grid" class="wk-coin-grid wk-coin-grid--hidden">${_coinGridItems}</div>` : '';

  const coinBreakdownHtml = _selChip ? `<div class="wk-coin-breakdown-wrap"><div class="wk-coin-breakdown"><button class="wk-coin-arrow wk-coin-arrow--left wk-coin-arrow--to-${_prevColor}" id="wk-coin-prev" type="button"${_arrowDisabled} title="${esc(_prevTip)}">\u2039</button><span class="wk-coin-item ${_selChip.colorCls} wk-coin-item--selected" data-coin="${esc(_selChip.key)}" id="wk-coin-selected" title="${esc(_selChip.tooltip ?? _selChip.key)}">${_selChip.icon}<span class="wk-coin-val">${_selChip.html}</span></span><button class="wk-coin-arrow wk-coin-arrow--right wk-coin-arrow--to-${_nextColor}" id="wk-coin-next" type="button"${_arrowDisabled} title="${esc(_nextTip)}">\u203A</button></div>${_coinGridHtml}</div>` : '';

  const _nsInitVariant = _nsVariant();
  const _nsInitLooksAvailable = nsAvail === 'available';
  const _nsInitWalletAddr = getState().address?.toLowerCase() ?? '';
  const _nsInitSelfTarget = _nsInitWalletAddr !== '' && (
    (!!nsTargetAddress && nsTargetAddress.toLowerCase() === _nsInitWalletAddr) ||
    (!!nsNftOwner && nsNftOwner.toLowerCase() === _nsInitWalletAddr) ||
    nsAvail === 'owned'
  );
  const _nsInitSectionClass = (nsAvail === 'grace' ? ' wk-dd-ns-section--grace'
    : nsAvail === 'taken' ? ' wk-dd-ns-section--taken'
    : nsAvail === 'owned' ? ' wk-dd-ns-section--owned'
    : _nsInitLooksAvailable ? ' wk-dd-ns-section--available'
    : '') + (_nsInitSelfTarget ? ' wk-dd-ns-section--self-target' : '');
  const _subnameMode = !!nsSubnameParent;
  const _parentBare = nsSubnameParent ? nsSubnameParent.name.replace(/\.sui$/, '') : '';
  const _dotSuiText = _subnameMode ? `.${_parentBare}.sui` : '.sui';
  const _inputPlaceholder = _subnameMode ? 'subname' : 'name';
  // Look up shade order for initial render state
  const _nsInitShadeOrder = (nsAvail === 'grace' && ws.address) ? findShadeOrder(ws.address, nsLabel.trim()) : null;
  const _nsInitGraceExpired = nsAvail === 'grace' && nsGraceEndMs > 0 && Date.now() >= nsGraceEndMs;
  const _registerTitle = _subnameMode
    ? (nsLabel ? `Create ${esc(nsLabel)}.${_parentBare}.sui` : 'Create subname')
    : (_nsListing() ? (() => { const _l = _nsListing()!; const _s = Number(BigInt(_l.priceMist)) / 1e9; const _f = _l.source === 'tradeport' ? _s * 0.03 : 0; const _t = _s + _f; const _u = suiPriceCache ? (_t * suiPriceCache.price) : null; return `Trade ${_u != null ? `$${_u.toFixed(2)}` : `${_t.toFixed(2)} SUI`} for ${esc(nsLabel)}.sui`; })()
      : nsAvail === 'grace' && _nsInitShadeOrder && _nsInitGraceExpired ? `Execute Shade \u2014 register ${esc(nsLabel)}.sui now`
      : nsAvail === 'grace' && _nsInitShadeOrder ? `Shaded! Execute after ${_graceEndDate()}`
      : nsAvail === 'grace' ? `Shade ${esc(nsLabel)}.sui \u2014 lock funds for grace expiry`
      : _nsInitVariant === 'black-diamond' && nsLabel ? 'Invalid SuiNS name'
      : nsLabel ? `Mint ${esc(nsLabel)}.sui` : 'Mint .sui');
  const _registerDisabled = _subnameMode ? false : _nsListing() ? false : _nsInitVariant === 'black-diamond';
  const _inputHtml = _subnameMode
    ? `<input id="wk-ns-label-input" class="wk-ns-label-input" type="text" value="${esc(nsLabel)}" maxlength="63" spellcheck="false" autocomplete="off" placeholder="${_inputPlaceholder}">`
    : `<div class="wk-ns-input-wrap"><input id="wk-ns-label-input" class="wk-ns-label-input" type="text" value="${esc(nsLabel)}" maxlength="63" spellcheck="false" autocomplete="off" placeholder="${_inputPlaceholder}"><button id="wk-ns-clear-btn" class="wk-ns-clear-btn" type="button" title="Clear" style="${nsLabel ? '' : 'display:none'}">\u2715</button><button id="wk-ns-pin-btn" class="wk-ns-pin-btn" type="button" title="Create subname">\u25b8</button></div>`;
  const _nsRouteInitHtml = _suiamiVerifyHtml || _nsRouteHtml();
  const nsRowHtml = `
      <div id="wk-dd-ns-section" class="wk-dd-ns-section${_nsInitSectionClass}${_subnameMode ? ' wk-dd-ns-section--subname' : ''}${nsSectionOpen ? '' : ' wk-dd-ns-section--collapsed'}">
        <div class="wk-dd-ns-domain-row">
          <span id="wk-ns-status" class="wk-ns-status">${_nsStatusSvg(_subnameMode ? 'blue-square' : _nsInitVariant)}</span>
          ${_inputHtml}
          <span class="wk-ns-dot-sui">${esc(_dotSuiText)}</span>
          <span id="wk-ns-price-chip" class="wk-ns-price-chip">${_subnameMode ? '' : _nsPriceHtml()}</span>
          <button id="wk-send-btn" class="wk-send-btn" type="button" title="Send"${pendingSendAmount && Number(pendingSendAmount) > 0 ? '' : ' disabled'}>\u2192</button>
          <button id="wk-dd-ns-register" class="wk-dd-ns-register-btn${nsAvail === 'grace' && !_nsInitShadeOrder ? ' wk-shade-ready' : nsAvail === 'grace' && _nsInitShadeOrder && _nsInitGraceExpired ? ' wk-shade-execute' : nsAvail === 'grace' && _nsInitShadeOrder ? ' wk-shade-active' : ''}" type="button"${_registerDisabled ? ' disabled' : ''} title="${_registerTitle}" style="display:none">${nsAvail === 'grace' && !_nsInitShadeOrder ? '\u2299' : nsAvail === 'grace' && _nsInitShadeOrder && !_nsInitGraceExpired ? '\u2713' : '\u2192'}</button>
        </div>
        <div id="wk-ns-route" class="wk-ns-route-wrap${nsRouteOpen ? '' : ' wk-ns-route-wrap--hidden'}">${_nsRouteInitHtml}</div>
        <div id="wk-ns-owned-list" class="wk-ns-owned-list${nsRosterOpen ? '' : ' wk-ns-owned-list--hidden'}">${_nsOwnedListHtml()}</div>
      </div>`;

  // Unified menu — same layout for both states; name badge only when SuiNS name exists
  const nameBadgeHtml = app.suinsName ? (() => {
    const bare = app.suinsName.replace(/\.sui$/, '');
    return `<div class="wk-popout-name-badge">
          <svg viewBox="0 0 100 100" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink:0"><rect x="6" y="6" width="88" height="88" rx="10" fill="#4da2ff" stroke="#ffffff" stroke-width="6"/></svg>
          <span class="wk-popout-name-text">${esc(bare)}<span class="wk-popout-name-tld">.sui</span></span>
          <a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="wk-popout-name-link" title="View .ski profile">\u2197</a>
        </div>`;
  })() : '';

  const settingsHtml = _skiSettingsHtml();
  els.skiMenu.innerHTML = `
      <div class="wk-dropdown wk-dropdown--large open">
        <div class="wk-dd-slider${skiSettingsOpen ? ' wk-dd-slider--settings' : ''}">
          <div class="wk-dd-panel wk-dd-panel--main">
            <div class="wk-popout-actions">
              <button class="wk-dd-item wk-dd-ski" id="wk-dd-switch">Lockin</button>
              <button class="wk-dd-item wk-dd-settings" id="wk-dd-settings" title="Settings">\u2699</button>
              <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Deactivate</button>
            </div>
            ${nameBadgeHtml}
            <div id="wk-bal-collapse" class="wk-badge-collapse${addrSectionOpen ? '' : ' wk-badge-collapse--hidden'}">
              <div class="wk-badge-collapse-inner">
                <div class="wk-dd-address-row">
                  <div id="wk-network-select" class="wk-dd-network-select"></div>
                  ${needsDWallet
                    ? `<button class="wk-dd-address-banner wk-dd-address-banner--btc wk-dd-dwallet-setup" id="wk-dd-dwallet-setup" type="button" title="Create a dWallet to get BTC + ETH addresses">
                        <span class="wk-dd-address-text">Create \u2192</span>
                      </button>`
                    : `<button class="wk-dd-address-banner${app.copied ? ' copied' : ''}${addrBannerCls ? ' ' + addrBannerCls : ''}" id="wk-dd-copy" type="button" title="${esc(displayAddr)}">
                        <span class="wk-dd-address-text">${esc(app.copied ? 'Copied! \u2713' : addrShort)}</span>
                      </button>
                      <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="${esc(explorerTitle)}">\u2197</a>`}
                </div>
              </div>
            </div>
            ${balToggleHtml}
            <div id="wk-coins-collapse" class="wk-qr-collapse-wrap${coinChipsOpen ? '' : ' wk-qr-collapse--hidden'}">
              <div class="wk-qr-content-left">
                <div class="wk-qr-content-qr" id="wk-addr-qr" title="${esc(displayAddr)}" data-qr-addr="${esc(displayAddr)}"></div>
              </div>
              <div class="wk-qr-content-main">
                ${coinBreakdownHtml}
                <div class="wk-send-row">
                  <span class="wk-send-dollar">$</span>
                  <div class="wk-send-amount-wrap">
                    <input id="wk-send-amount" class="wk-send-amount" type="text" inputmode="decimal" placeholder="0.00" spellcheck="false" autocomplete="off" value="${esc(pendingSendAmount)}">
                    <button id="wk-send-clear" class="wk-send-input-clear" type="button" title="Clear" style="${pendingSendAmount && Number(pendingSendAmount) > 0 ? '' : 'display:none'}">\u2715</button>
                  </div>
                </div>
                <div class="wk-send-row-below">
                  <button id="wk-send-all" class="wk-send-all wk-send-all--${balView}" type="button" title="Use full balance">All</button>
                  <button id="wk-send-min" class="wk-send-all wk-send-all--${balView}" type="button" title="Set 0.01">0.01</button>
                  <div id="wk-swap-select" class="wk-swap-select"></div>
                </div>
              </div>
            </div>
            ${nsRowHtml}
          </div>
          <div class="wk-dd-panel wk-dd-panel--settings">
            ${settingsHtml}
          </div>
        </div>
      </div>`;

  document.getElementById('wk-dd-copy')?.addEventListener('click', menuCopyAddress);
  document.getElementById('wk-dd-dwallet-setup')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.querySelector('.wk-dd-address-text')!.textContent = 'Creating\u2026';
    try {
      const { provisionDWallet } = await import('./client/ika.js');
      const wallet = await import('./wallet.js');
      const isWaap = /waap/i.test(getState().walletName);
      const status = await provisionDWallet(getState().address, {
        signTransaction: (txBytes: Uint8Array) => wallet.signTransaction(txBytes),
        signAndExecuteTransaction: (txBytes: Uint8Array) => wallet.signAndExecuteTransaction(txBytes),
        isWaap,
        onStatus: (msg: string) => {
          const txt = btn.querySelector('.wk-dd-address-text');
          if (txt) txt.textContent = msg;
        },
      });
      if (status.ika) {
        updateAppState({
          ikaWalletId: status.dwalletId,
          btcAddress: status.btcAddress,
          ethAddress: status.ethAddress,
        });
        showToast('dWallet active \u2014 BTC + ETH addresses ready');
      }
    } catch (err) {
      console.error('[ika:dkg] FAILED:', err);
      const msg = err instanceof Error ? err.message : 'Failed';
      showToast(msg);
      btn.disabled = false;
      const txt = btn.querySelector('.wk-dd-address-text');
      if (txt) txt.textContent = 'Create \u2192';
    }
  });
  document.getElementById('wk-dd-switch')?.addEventListener('click', menuLockin);
  document.getElementById('wk-dd-disconnect')?.addEventListener('click', menuDisconnect);
  document.getElementById('wk-bal-toggle')?.addEventListener('change', menuToggleBalance);
  _renderNetworkSelect();
  document.getElementById('wk-network-select')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const opt = t.closest<HTMLElement>('.wk-dd-network-opt');
    if (opt?.dataset.network) {
      networkView = opt.dataset.network as 'sui' | 'btc';
      try { localStorage.setItem('ski:network-pref', networkView); } catch {}
      _networkSelectOpen = false;
      _renderNetworkSelect();
      render(); // re-render to update address row for network switch
      return;
    }
    if (t.closest('#wk-network-trigger') || t.closest('.wk-dd-network-trigger')) {
      _networkSelectOpen = !_networkSelectOpen;
      _renderNetworkSelect();
    }
  });

  // Coin chip selection — independent of balView
  // Coin chip arrow navigation
  function _selectCoinByIndex(idx: number) {
    if (!_coinChipsCache.length) return;
    _userManuallySelectedCoin = true;
    const wrapped = ((idx % _coinChipsCache.length) + _coinChipsCache.length) % _coinChipsCache.length;
    const chip = _coinChipsCache[wrapped];
    selectedCoinSymbol = chip.key.toUpperCase();
    // Zero out amount on coin change — but NOT when a listing is active (price is fixed)
    const hasListing = !!(nsKioskListing || nsTradeportListing);
    if (!hasListing) {
      const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      if (amountInput) {
        pendingSendAmount = '';
        amountInput.value = '';
        const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
        if (sendBtn) sendBtn.disabled = true;
      }
    }
    _debounceSwapQuote();
    _updateSendBtnMode();
    _checkAmountOverBalance();
    renderSkiMenu();
  }
  document.getElementById('wk-coin-prev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = _coinChipsCache.findIndex(c => c.key === (selectedCoinSymbol?.toLowerCase() ?? ''));
    _selectCoinByIndex(cur - 1);
  });
  document.getElementById('wk-coin-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = _coinChipsCache.findIndex(c => c.key === (selectedCoinSymbol?.toLowerCase() ?? ''));
    _selectCoinByIndex(cur + 1);
  });

  // Toggle coin picker grid when clicking selected chip
  document.getElementById('wk-coin-selected')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const grid = document.getElementById('wk-coin-grid');
    if (grid) grid.classList.toggle('wk-coin-grid--hidden');
  });

  // Pick coin from grid
  document.getElementById('wk-coin-grid')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-coin-pick]');
    if (!btn) return;
    const key = btn.dataset.coinPick;
    if (!key) return;
    const idx = _coinChipsCache.findIndex(c => c.key === key);
    if (idx >= 0) _selectCoinByIndex(idx);
    const grid = document.getElementById('wk-coin-grid');
    if (grid) grid.classList.add('wk-coin-grid--hidden');
  });

  // Close coin grid when clicking elsewhere
  document.addEventListener('click', () => {
    const grid = document.getElementById('wk-coin-grid');
    if (grid && !grid.classList.contains('wk-coin-grid--hidden')) {
      grid.classList.add('wk-coin-grid--hidden');
    }
  });

  // Consolidate alt tokens → USDC
  document.getElementById('wk-consolidate-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ws2 = getState();
    if (!ws2.address) return;
    // Check for eligible non-stable, non-SUI tokens
    const eligible = walletCoins.filter(c => !c.isStable && c.symbol !== 'SUI' && c.balance > 0);
    if (!eligible.length) { showToast('No tokens to consolidate'); return; }

    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const USDC_CT = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
      const swappedSymbols: string[] = [];
      let swappedTotalUsd = 0;

      // 1. Try main consolidation (NS, WAL, XAUM, SUI)
      try {
        const result = await buildConsolidateToUsdcTx(ws2.address);
        if (result.swaps.length > 0) {
          if (result.sponsorAddress) {
            await signAndExecuteSponsoredTx(result.txBytes);
          } else {
            await signAndExecuteTransaction(result.txBytes);
          }
          for (const s of result.swaps) {
            const tp = s.symbol === 'SUI' ? (suiPriceCache?.price ?? 0) : (getTokenPrice(s.symbol) ?? 0);
            swappedTotalUsd += tp > 0 ? s.amount * tp : 0;
            swappedSymbols.push(s.symbol);
          }
        }
      } catch { /* main consolidation had nothing or failed — continue */ }

      // 2. Swap remaining tokens individually via buildSwapTx
      const SUI_CT = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      for (const c of eligible) {
        if (['NS', 'WAL', 'XAUM'].includes(c.symbol)) continue; // already handled above
        if (c.coinType === USDC_CT) continue;
        const decimals = coinDecimals(c.coinType);
        const amountMist = BigInt(Math.floor(c.balance * Math.pow(10, decimals)));
        if (amountMist <= 0n) continue;
        try {
          // Try direct to USDC
          const swap = await buildSwapTx(ws2.address, c.coinType, USDC_CT, amountMist);
          await signAndExecuteTransaction(swap.txBytes);
          const tp = c.symbol === 'SUI' ? (suiPriceCache?.price ?? 0) : (getTokenPrice(c.symbol) ?? 0);
          swappedTotalUsd += tp > 0 ? c.balance * tp : 0;
          swappedSymbols.push(c.symbol);
        } catch {
          try {
            // Fallback: route through SUI (token→SUI, then SUI→USDC)
            const swap1 = await buildSwapTx(ws2.address, c.coinType, SUI_CT, amountMist);
            await signAndExecuteTransaction(swap1.txBytes);
            // Now swap the received SUI to USDC
            const suiBal = await grpcClient.core.getBalance({ owner: ws2.address });
            const suiAvail = Number(suiBal?.balance?.balance ?? 0);
            const keepForGas = 500_000_000; // 0.5 SUI
            if (suiAvail > keepForGas) {
              const swapAmt = BigInt(suiAvail - keepForGas);
              if (swapAmt > 0n) {
                const swap2 = await buildSwapTx(ws2.address, SUI_CT, USDC_CT, swapAmt);
                await signAndExecuteTransaction(swap2.txBytes);
              }
            }
            const tp = c.symbol === 'SUI' ? (suiPriceCache?.price ?? 0) : (getTokenPrice(c.symbol) ?? 0);
          swappedTotalUsd += tp > 0 ? c.balance * tp : 0;
          swappedSymbols.push(c.symbol);
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            if (!msg2.includes('reject')) showToast(`Failed to swap ${c.symbol}: ${msg2}`);
          }
        }
      }

      if (swappedSymbols.length > 0) {
        const symbols = [...new Set(swappedSymbols)].join(' + ');
        showToast(`Consolidated ${symbols} \u2192 $${_fmtUsd(swappedTotalUsd)} USDC \u2713`);
      } else {
        showToast('No eligible tokens to consolidate');
      }
      // Clear stale cache + re-render immediately, then delayed refresh for indexer
      _setMutationMs();
      if (ws2.address) try { localStorage.removeItem(`ski:balances:${ws2.address}`); } catch {}
      walletCoins = [];
      app.nsBalance = 0;
      appBalanceFetched = false;
      renderSkiMenu();
      setTimeout(() => refreshPortfolio(true), 2000);
      setTimeout(() => refreshPortfolio(true), 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      btn.disabled = false;
    }
  });

  // Convert vertical scroll anywhere in the menu to horizontal scroll on coin breakdown
  const coinBreakdownEl = document.querySelector('.wk-coin-breakdown') as HTMLElement | null;
  if (coinBreakdownEl && coinBreakdownEl.scrollWidth > coinBreakdownEl.clientWidth) {
    els.skiMenu.addEventListener('wheel', (e) => {
      if (!coinBreakdownEl || coinBreakdownEl.scrollWidth <= coinBreakdownEl.clientWidth) return;
      e.preventDefault();
      coinBreakdownEl.scrollLeft += (e as WheelEvent).deltaY;
    }, { passive: false });
  }

  // Settings slide-in
  document.getElementById('wk-dd-settings')?.addEventListener('click', () => {
    skiSettingsOpen = true;
    document.querySelector('.wk-dd-slider')?.classList.add('wk-dd-slider--settings');
  });
  document.getElementById('wk-settings-back')?.addEventListener('click', () => {
    skiSettingsOpen = false;
    document.querySelector('.wk-dd-slider')?.classList.remove('wk-dd-slider--settings');
  });

  // Toggle send button between send/swap mode and SuiAMI mode
  function _updateSendBtnMode() {
    const btn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const sec = document.getElementById('wk-dd-ns-section');
    const isSelfTarget = sec?.classList.contains('wk-dd-ns-section--self-target') ?? false;
    const isOwned = sec?.classList.contains('wk-dd-ns-section--owned') ?? false;
    const hasLabel = nsLabel.trim().length > 0;
    const isAvailable = sec?.classList.contains('wk-dd-ns-section--available') ?? false;
    const isTaken = sec?.classList.contains('wk-dd-ns-section--taken') ?? false;
    const hasListing = !!(nsKioskListing || nsTradeportListing);

    // Determine mode priority
    const mintMode = isAvailable && hasLabel;
    const suiamiGreen = !hasLabel && !!app.suinsName; // empty input = sign own identity
    const suiamiPurple = (isSelfTarget || isOwned) && hasLabel; // owned name in input
    const suiamiMode = suiamiGreen || suiamiPurple;
    const inEqualsOut = _getSwapInCoinType() === (SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey)?.coinType ?? '');
    const selfTarget = isSelfTarget || isOwned || (!hasLabel && !!app.suinsName);
    const sendingToOther = hasLabel && !isSelfTarget && !isOwned && nsTargetAddress != null;
    // Market mode: listed names always show BUY regardless of coin chips state
    const marketMode = !suiamiMode && !mintMode && hasListing && hasLabel;
    const resolving = !suiamiMode && !mintMode && !marketMode && hasLabel && !nsAvail;
    // SWAP: input ≠ output AND target is self (or empty)
    const swapMode = coinChipsOpen && !mintMode && !marketMode && !resolving && !inEqualsOut && !sendingToOther;
    // SUIAMI: input = output AND target is self
    const suiamiSendMode = coinChipsOpen && !mintMode && !marketMode && !resolving && inEqualsOut && selfTarget && !sendingToOther;
    // SEND: sending to someone else (any token combo), colored by output
    const sendMode = coinChipsOpen && !mintMode && !marketMode && !resolving && !swapMode && !suiamiSendMode;

    btn.classList.remove('wk-send-btn--suiami', 'wk-send-btn--suiami-green', 'wk-send-btn--send', 'wk-send-btn--market', 'wk-send-btn--resolving', 'wk-send-btn--mint', 'wk-send-btn--swap-usd', 'wk-send-btn--swap-sui', 'wk-send-btn--swap-gold');
    if (mintMode) btn.classList.add('wk-send-btn--mint');
    else if (swapMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`);
    else if (suiamiSendMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`); // SUIAMI colored by output
    else if (sendMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`); // SEND colored by output
    else if (suiamiGreen) btn.classList.add('wk-send-btn--suiami-green');
    else if (suiamiPurple) btn.classList.add('wk-send-btn--suiami');
    else if (marketMode) btn.classList.add('wk-send-btn--market');
    else if (resolving) btn.classList.add('wk-send-btn--resolving');
    // Hide price chip when balance is expanded — except when name is available (show mint cost)
    const priceChip = document.getElementById('wk-ns-price-chip');
    if (priceChip) priceChip.style.display = (sendMode || swapMode) && !mintMode ? 'none' : '';

    // Auto-configure swap for minting: set amount to mint price (with NS discount)
    if (mintMode && coinChipsOpen) {
      const len = nsLabel.replace(/\.sui$/, '').length;
      const discountedPrice = nsPriceUsd ?? (len === 3 ? 375 : len === 4 ? 75 : 7.50);
      // Check affordability
      const totalUsd = app.usd ?? 0;
      const canAfford = totalUsd >= discountedPrice * 0.80;
      // Always auto-fill amount with mint price (even if can't afford — user sees the cost)
      const mintCost = _fmtUsd(discountedPrice);
      const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      if (amountInput && amountInput.value !== mintCost) {
        pendingSendAmount = mintCost;
        amountInput.value = mintCost;
        amountInput.classList.toggle('wk-send-amount--over', !canAfford);
        document.querySelector('.wk-send-dollar')?.classList.toggle('wk-send-dollar--over', !canAfford);
        const clr = document.getElementById('wk-send-clear');
        if (clr) clr.style.display = '';
      }
    }
    // Check if MINT should be red (can't afford)
    if (mintMode) {
      const len = nsLabel.replace(/\.sui$/, '').length;
      const discountedPrice = nsPriceUsd ?? (len === 3 ? 375 : len === 4 ? 75 : 7.50);
      const totalUsd = app.usd ?? 0;
      const canAfford = totalUsd >= discountedPrice * 0.80;
      btn.classList.toggle('wk-send-btn--cant-afford', !canAfford);
    } else {
      btn.classList.remove('wk-send-btn--cant-afford');
    }
    const dotSui = document.querySelector('.wk-ns-dot-sui') as HTMLElement | null;
    if (dotSui) {
      dotSui.classList.toggle('wk-ns-dot-sui--send', sendMode || swapMode);
      dotSui.classList.toggle('wk-ns-dot-sui--suiami', suiamiPurple);
      dotSui.classList.toggle('wk-ns-dot-sui--mint', mintMode);
    }
    if (mintMode) {
      btn.disabled = false;
      btn.textContent = 'MINT';
      btn.title = `Mint ${nsLabel.trim()}.sui`;
    } else if (swapMode) {
      btn.textContent = 'SWAP';
      const inSym = selectedCoinSymbol ?? 'SUI';
      const outOpt = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey);
      const outLabel = outOpt ? outOpt.label : swapOutputKey.toUpperCase();
      const val = pendingSendAmount;
      const amtStr = val && Number(val) > 0 ? `$${_fmtUsd(Number(val))} ` : '';
      const selKey = selectedCoinSymbol?.toLowerCase() ?? '';
      const selChip = _coinChipsCache.find(c => c.key === selKey) ?? _coinChipsCache[0];
      const selVal = selChip?.val ?? 0;
      const swapOver = Number(val) > 0 && selVal > 0 && Number(val) > selVal * 1.01;
      if (swapOver) {
        btn.title = `Insufficient ${inSym} \u2014 need $${_fmtUsd(Number(val))}`;
        btn.disabled = true;
        btn.classList.add('wk-send-btn--cant-afford');
      } else {
        btn.title = `Swap ${inSym} to ${amtStr}${outLabel}`;
        btn.disabled = !val || Number(val) <= 0;
        btn.classList.remove('wk-send-btn--cant-afford');
      }
    } else if (suiamiSendMode) {
      btn.disabled = false;
      btn.textContent = 'SUIAMI';
      btn.title = 'SuiAMI — SUI-Authenticated Message Identity';
    } else if (sendMode) {
      btn.textContent = 'SEND';
      const sendSym = selectedCoinSymbol ?? 'SUI';
      const val = pendingSendAmount;
      const sendAmtStr = val && Number(val) > 0 ? `$${_fmtUsd(Number(val))} ` : '';
      const sendTarget = nsLabel.trim() ? `${nsLabel.trim()}.sui` : '';
      const sendSelKey = selectedCoinSymbol?.toLowerCase() ?? '';
      const sendSelChip = _coinChipsCache.find(c => c.key === sendSelKey) ?? _coinChipsCache[0];
      const sendSelVal = sendSelChip?.val ?? 0;
      const sendOver = Number(val) > 0 && sendSelVal > 0 && Number(val) > sendSelVal * 1.01;
      if (sendOver) {
        btn.title = `Insufficient ${sendSym} \u2014 need $${_fmtUsd(Number(val))}`;
        btn.disabled = true;
        btn.classList.add('wk-send-btn--cant-afford');
      } else {
        btn.title = `Send ${sendAmtStr}${sendSym}${sendTarget ? ` to ${sendTarget}` : ''}`;
        btn.disabled = !val || Number(val) <= 0;
        btn.classList.remove('wk-send-btn--cant-afford');
      }
    } else if (suiamiMode) {
      btn.disabled = false;
      btn.textContent = 'SUIAMI';
      btn.title = 'SuiAMI — SUI-Authenticated Message Identity';
    } else if (marketMode) {
      const listing = _nsListing();
      if (listing) {
        const suiAmt = Number(BigInt(listing.priceMist)) / 1e9;
        const fee = listing.source === 'tradeport' ? suiAmt * 0.03 : 0;
        const totalSui = suiAmt + fee;
        const usdVal = suiPriceCache ? (totalSui * suiPriceCache.price) : null;
        const priceStr = usdVal != null ? `$${usdVal.toFixed(2)}` : `${totalSui.toFixed(2)} SUI`;
        // Check if selected balance + output token balance covers the listing price
        // The swap flow uses: selected token → SUI + output token → SUI
        const tradeSelKey = selectedCoinSymbol?.toLowerCase() ?? '';
        const tradeSelChip = _coinChipsCache.find(c => c.key === tradeSelKey) ?? _coinChipsCache[0];
        const tradeSelVal = tradeSelChip?.val ?? 0;
        const tradeOutOpt = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey);
        const tradeOutChip = tradeOutOpt ? _coinChipsCache.find(c => c.colorCls === `wk-coin-item--${tradeOutOpt.key}`) : null;
        const tradeOutVal = tradeOutChip?.val ?? (swapOutputKey === 'sui' ? (app.sui * (suiPriceCache?.price ?? 0)) : 0);
        const tradeAvailable = tradeSelVal + tradeOutVal;
        const canAfford = usdVal != null ? tradeAvailable >= usdVal * 0.95 : true;
        btn.disabled = !canAfford;
        btn.classList.toggle('wk-send-btn--cant-afford', !canAfford);
        document.querySelector('.wk-ns-dot-sui')?.classList.toggle('wk-ns-dot-sui--insufficient', !canAfford);
        document.getElementById('wk-ns-price-chip')?.classList.toggle('wk-ns-price-chip--insufficient', !canAfford);
        if (canAfford) {
          btn.textContent = 'TRADE';
          btn.title = `Trade ${priceStr} for ${nsLabel.trim()}.sui`;
        } else {
          btn.textContent = 'TRADE';
          btn.title = `Insufficient balance \u2014 need ${priceStr} for ${nsLabel.trim()}.sui`;
        }
        // Auto-fill amount with listing price
        const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
        if (amountInput && usdVal != null) {
          const listingAmt = Math.ceil(usdVal * 100) / 100;
          pendingSendAmount = listingAmt.toFixed(2);
          amountInput.value = pendingSendAmount;
          amountInput.classList.toggle('wk-send-amount--over', !canAfford);
          document.querySelector('.wk-send-dollar')?.classList.toggle('wk-send-dollar--over', !canAfford);
          const clr = document.getElementById('wk-send-clear');
          if (clr) clr.style.display = '';
        }
      } else {
        btn.disabled = false;
        btn.textContent = '\u2192';
        btn.title = 'Trade on marketplace';
      }
    } else if (resolving) {
      btn.disabled = true;
      btn.textContent = '\u2026';
      btn.title = 'Resolving\u2026';
    } else {
      // No specific mode — hide the button
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
  }
  function _checkAmountOverBalance() {
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!amountInput) return;
    const val = Number(pendingSendAmount);
    // In market/trade mode, use selected + output token balance
    const hasListing = !!(nsKioskListing || nsTradeportListing);
    const selKey = selectedCoinSymbol?.toLowerCase() ?? '';
    const selChip = _coinChipsCache.find(c => c.key === selKey) ?? _coinChipsCache[0];
    const selVal = selChip?.val ?? 0;
    const maxVal = hasListing ? (() => {
      const outOpt = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey);
      const outChip = outOpt ? _coinChipsCache.find(c => c.colorCls === `wk-coin-item--${outOpt.key}`) : null;
      const outVal = outChip?.val ?? (swapOutputKey === 'sui' ? (app.sui * (suiPriceCache?.price ?? 0)) : 0);
      return selVal + outVal;
    })() : selVal;
    const isOver = val > 0 && maxVal > 0 && val > maxVal * 1.01;
    amountInput.classList.toggle('wk-send-amount--over', isOver);
    document.querySelector('.wk-send-dollar')?.classList.toggle('wk-send-dollar--over', isOver);
  }

  _updateSendBtnMode();
  _checkAmountOverBalance();
  document.getElementById('wk-send-btn')?.addEventListener('ns-status-change', _updateSendBtnMode);

  // Marketplace purchase handler (kiosk or Tradeport) — single PTB, one signature
  async function _handleMarketplacePurchase(ws2: { address: string }, btn: HTMLButtonElement | null, label: string) {
    if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
    try {
      // Determine selected coin info
      const SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const inCoinType = _getSwapInCoinType();
      const outOpt = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey);
      const outCoinType = outOpt?.coinType ?? null;
      const suiP = suiPriceCache?.price ?? 0;

      // Get selected balance
      const selKey = selectedCoinSymbol?.toLowerCase() ?? '';
      const wc = walletCoins.find(c => c.symbol === (selectedCoinSymbol ?? '') || c.symbol.toLowerCase() === selKey);
      let selBal = wc?.balance ?? 0;
      if (selBal <= 0) {
        const selChip = _coinChipsCache.find(c => c.key === selKey);
        const selUsd = selChip?.val ?? 0;
        if (selUsd > 0 && suiP > 0) {
          if (selKey === 'usd' || selKey === 'usdc') selBal = selUsd;
          else if (selKey === 'sui') selBal = selUsd / suiP;
          else { const tp = getTokenPrice(selectedCoinSymbol ?? ''); selBal = tp && tp > 0 ? selUsd / tp : 0; }
        }
      }

      // Build purchase descriptor
      const purchase = nsKioskListing
        ? { type: 'kiosk' as const, kioskId: nsKioskListing.kioskId, nftId: nsKioskListing.nftId, priceMist: nsKioskListing.priceMist }
        : { type: 'tradeport' as const, nftTokenId: nsTradeportListing!.nftTokenId, priceMist: nsTradeportListing!.priceMist };

      if (btn) btn.textContent = 'TRADE';
      const selTokenPrice = getTokenPrice(selectedCoinSymbol ?? '') ?? undefined;
      const txBytes = await buildSwapAndPurchaseTx(
        ws2.address,
        purchase,
        inCoinType !== SUI_COIN_TYPE ? inCoinType : null,
        selBal,
        outCoinType !== SUI_COIN_TYPE ? outCoinType : null,
        suiP,
        selTokenPrice,
      );
      if (btn) btn.textContent = '\u270f';
      const { digest } = await signAndExecuteTransaction(txBytes);

      nsAvail = 'owned'; nsTargetAddress = ws2.address; nsLastDigest = digest ?? ''; nsKioskListing = null; nsTradeportListing = null;
      _patchNsStatus(); _patchNsRoute();
      const domain = `${label}.sui`;
      app.suinsName = app.suinsName || domain;
      suinsCache[ws2.address] = app.suinsName;
      try { localStorage.setItem(`ski:suins:${ws2.address}`, app.suinsName); } catch {}
      updateSkiDot('blue-square', app.suinsName);
      nsOwnedFetchedFor = ''; _fetchOwnedDomains();
      walletCoins = []; appBalanceFetched = false;
      renderSkiMenu();
      setTimeout(() => refreshPortfolio(true), 2000);
      showToast(`${label}.sui purchased \u2713`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.toLowerCase().includes('reject')) {
        const { display, full } = parseNsError(raw);
        showCopyableToast(display, full);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'TRADE'; }
    }
  }

  // Send / Swap / Mint / SuiAMI
  document.getElementById('wk-send-btn')?.addEventListener('click', async () => {
    const sec = document.getElementById('wk-dd-ns-section');

    // BUY/TRADE mode: marketplace listing — takes priority over mint
    if ((nsKioskListing || nsTradeportListing) && nsLabel.trim().length > 0) {
      // Fall through to the marketplace purchase handler below the swap/send block
      // by skipping suiami/swap/send checks
      const ws2 = getState();
      if (!ws2.address) return;
      const btn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
      const label = nsLabel.trim();
      const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      // Jump to marketplace purchase handler (defined later in this function)
      // We need to goto the handler — restructure: call it inline
      await _handleMarketplacePurchase(ws2, btn, label);
      return;
    }

    // MINT mode: available name — show loading state and trigger registration
    const isAvailable = sec?.classList.contains('wk-dd-ns-section--available') ?? false;
    if (isAvailable && nsLabel.trim().length > 0) {
      const mintBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
      if (mintBtn) { mintBtn.disabled = true; mintBtn.textContent = '\u2026'; }
      const regBtn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
      if (regBtn) {
        regBtn.disabled = false;
        regBtn.click();
        regBtn.disabled = true;
      }
      return;
    }

    // SuiAMI mode: only when button is actually showing SUIAMI (not SWAP/SEND)
    const isSelfTarget = sec?.classList.contains('wk-dd-ns-section--self-target') ?? false;
    const isOwned = sec?.classList.contains('wk-dd-ns-section--owned') ?? false;
    const suiamiName = nsLabel.trim().length > 0 ? nsLabel.trim() : (app.suinsName ?? '');
    const inEqualsOut = _getSwapInCoinType() === (SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey)?.coinType ?? '');
    const isSwapOrSend = coinChipsOpen && !inEqualsOut; // swap takes priority
    const isSendMode = coinChipsOpen && inEqualsOut && nsLabel.trim().length > 0 && !isSelfTarget && !isOwned; // sending to other
    const suiamiClick = !isSwapOrSend && !isSendMode && (((isSelfTarget || isOwned) && nsLabel.trim().length > 0) || (!nsLabel.trim() && !!app.suinsName));
    if (suiamiClick) {
      const ws2 = getState();
      if (!ws2.address) return;
      const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
      if (!sendBtn) return;
      const bare = suiamiName.replace(/\.sui$/, '');

      sendBtn.disabled = true;
      sendBtn.textContent = '\u2026';
      // Clear any previous verification result
      _suiamiVerifyHtml = '';
      const routeEl0 = document.getElementById('wk-ns-route');
      if (routeEl0) { routeEl0.innerHTML = ''; delete routeEl0.dataset.suiami; }
      try {
        // Resolve NFT ID: paginate through SuinsRegistration objects, match by domain_name
        let nftId = '';
        try {
          let cursor: string | null = null;
          const target = `${bare}.sui`;
          for (let page = 0; page < 10 && !nftId; page++) {
            const objRes = await fetch(grpcUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getOwnedObjects', params: [ws2.address, { filter: { StructType: '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration' }, options: { showContent: true } }, cursor, 50] }),
            });
            const objData = await objRes.json() as { result?: { data?: Array<{ data?: { objectId?: string; content?: { fields?: Record<string, unknown> } } }>; nextCursor?: string; hasNextPage?: boolean } };
            const match = objData.result?.data?.find(o => {
              const fields = o.data?.content?.fields ?? {};
              return fields.domain_name === target || fields.name === target || fields.domain_name === bare || fields.name === bare;
            });
            if (match?.data?.objectId) { nftId = match.data.objectId; break; }
            if (!objData.result?.hasNextPage) break;
            cursor = objData.result?.nextCursor ?? null;
          }
        } catch {}
        if (!nftId) { showToast(`No SuiNS NFT found for ${bare}.sui`); return; }

        // Build and sign
        const message = buildSuiamiMessage(bare, ws2.address, nftId);
        const msgBytes = new TextEncoder().encode(JSON.stringify(message, null, 2));
        const { bytes, signature } = await signPersonalMessage(msgBytes);
        const proof = createSuiamiProof(message, bytes, signature);

        // 1. Copy to clipboard (retry after focus returns from wallet popup)
        const _copyProof = async () => {
          try {
            await navigator.clipboard.writeText(proof.token);
            return true;
          } catch {
            // Fallback: textarea copy
            try {
              const ta = document.createElement('textarea');
              ta.value = proof.token;
              ta.style.cssText = 'position:fixed;left:-9999px';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              return true;
            } catch { return false; }
          }
        };
        await _copyProof();

        // 2. Emit custom event
        window.dispatchEvent(new CustomEvent('suiami:signed', {
          detail: { proof: proof.token, message: proof.message, signature: proof.signature, name: bare, address: ws2.address },
        }));

        // 3. POST to server and show verification result
        // 3. POST to server and show verification result
        const routeEl = document.getElementById('wk-ns-route');
        try {
          const verifyRes = await fetch('/api/suiami/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: proof.token }),
          });
          const v = await verifyRes.json() as { valid?: boolean; ownershipVerified?: boolean; nameVerified?: boolean; onChainError?: string };
          // Show result in route area
          if (v.valid) {
            _suiamiVerifyHtml = `<span class="wk-ns-route wk-suiami-verified">\u2713 verified ${esc(bare)}.sui</span>`;
          } else {
            const reason = v.onChainError || (!v.ownershipVerified ? 'NFT not owned by signer' : !v.nameVerified ? 'Name mismatch' : 'Verification failed');
            _suiamiVerifyHtml = `<span class="wk-ns-route wk-suiami-failed">\u2717 ${esc(reason)}</span>`;
          }
          if (routeEl) {
            nsRouteOpen = true;
            _persistRouteOpen();
            routeEl.classList.remove('wk-ns-route-wrap--hidden');
            routeEl.innerHTML = _suiamiVerifyHtml;
          }
          showToast(v.valid
            ? `\u2713 SuiAMI verified \u2014 ${bare}.sui (copied)`
            : `SuiAMI signed \u2014 ${bare}.sui (copied)`);
        } catch {
          showToast(`SuiAMI signed \u2014 ${bare}.sui (copied)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        _updateSendBtnMode();
      }
      return;
    }

    const ws2 = getState();
    if (!ws2.address) return;
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (!amountInput || !sendBtn) return;
    const amountStr = amountInput.value.trim();
    if (!amountStr || Number(amountStr) <= 0) { showToast('Enter an amount'); return; }

    // Amount is in USD — determine input token and convert
    const symbol = selectedCoinSymbol ?? 'SUI';
    const USDC_CT = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
    const SUI_CT = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
    const coin = symbol === 'USD' || symbol === 'USDC'
      ? (walletCoins.find(c => c.isStable && c.balance > 0) || (app.stableUsd > 0 ? { symbol: 'USDC', coinType: USDC_CT, balance: app.stableUsd, isStable: true } : null))
      : walletCoins.find(c => c.symbol === symbol)
        || (symbol === 'SUI' ? { symbol: 'SUI', coinType: SUI_CT, balance: app.sui, isStable: false } : null)
        || (symbol === 'XAUM' ? { symbol: 'XAUM', coinType: '0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM', balance: 0, isStable: false } : null);
    if (!coin) { showToast(`No ${symbol} in wallet`); return; }
    const coinType = (coin as { coinType: string }).coinType;
    const outOpt = SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey)!;
    const isSwap = coinType !== outOpt.coinType;

    // Get recipient from NS target address
    const recipientAddr = nsTargetAddress ?? nsNftOwner ?? ws2.address;
    if (!recipientAddr) { showToast('Set a recipient address first'); return; }
    const selfSend = normalizeSuiAddress(recipientAddr) === normalizeSuiAddress(ws2.address);

    // Convert USD target to token amount
    const usdAmount = Number(amountStr);
    const isStable = (coin as { isStable: boolean }).isStable;
    const decimals = coinType.includes('::usdc::') ? 6 : coinType.includes('::ns::') ? 6 : 9;
    const coinBal = (coin as { balance: number }).balance;

    // For non-SUI tokens: if the USD amount matches ~100% of the chip value, use the full balance
    // This avoids rounding errors that cause "insufficient balance"
    const chipVal = _coinChipsCache.find(c => c.key === symbol.toLowerCase())?.val ?? 0;
    const isFullBalance = symbol !== 'SUI' && chipVal > 0 && usdAmount >= chipVal * 0.99;

    let amountMist: bigint;
    if (isFullBalance && coinBal > 0) {
      // Use the actual token balance — no USD conversion rounding
      amountMist = BigInt(Math.floor(coinBal * Math.pow(10, decimals)));
    } else {
      let tokenAmount = _usdToTokenAmount(usdAmount);
      if (!isStable && symbol === 'SUI' && (suiPriceCache?.price ?? 0) <= 0) { showToast('SUI price unavailable'); return; }
      if (!isStable && symbol !== 'SUI' && !(getTokenPrice(symbol)! > 0)) { showToast(`${symbol} price unavailable`); return; }
      if (tokenAmount <= 0) { showToast('Cannot convert amount'); return; }

      // If swapping, use the cached quote ratio to adjust input so output ≥ target
      if (isSwap && _swapQuotes[swapOutputKey]) {
        const q = _swapQuotes[swapOutputKey];
        const qOutUsdStr = _quoteToUsd(swapOutputKey, q.returnAmount).replace(/[^0-9.]/g, '');
        const qOutUsd = Number(qOutUsdStr);
        if (qOutUsd > 0) {
          tokenAmount = tokenAmount * (usdAmount / qOutUsd);
        }
      }
      // Cap at actual balance to prevent insufficient balance errors
      const maxMist = coinBal > 0 ? BigInt(Math.floor(coinBal * Math.pow(10, decimals))) : BigInt(0);
      amountMist = BigInt(Math.ceil(tokenAmount * Math.pow(10, decimals)));
      if (maxMist > 0n && amountMist > maxMist) amountMist = maxMist;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = '\u2026';
    try {
      if (isSwap) {
        const swap = await buildSwapTx(ws2.address, coinType, outOpt.coinType, amountMist);
        await signAndExecuteTransaction(swap.txBytes);
        showToast(`Swapped ${swap.fromSymbol} \u2192 $${amountStr} ${swap.toSymbol} \u2713`);
      } else if (selfSend) {
        showToast('Input and output are the same token');
        return;
      } else {
        // Same token send to recipient
        const txBytes = await buildSendTx(ws2.address, recipientAddr, coinType, amountMist);
        await signAndExecuteTransaction(txBytes);
        const short = recipientAddr.slice(0, 6) + '\u2026' + recipientAddr.slice(-4);
        showToast(`Sent $${amountStr} to ${short} \u2713`);
      }
      amountInput.value = '';
      pendingSendAmount = '';
      _swapQuotes = {};
      _updateSwapEstimates();
      _setMutationMs();
      if (ws2.address) try { localStorage.removeItem(`ski:balances:${ws2.address}`); } catch {}
      walletCoins = [];
      appBalanceFetched = false;
      renderSkiMenu();
      setTimeout(() => refreshPortfolio(true), 2000);
      setTimeout(() => refreshPortfolio(true), 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      sendBtn.textContent = '\u2192';
      const curVal = amountInput.value.trim();
      sendBtn.disabled = !curVal || Number(curVal) <= 0;
    }
  });

  // Enable/disable send button based on amount input + fetch swap quote
  document.getElementById('wk-send-amount')?.addEventListener('input', () => {
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!sendBtn || !amountInput) return;
    const val = amountInput.value.trim();
    pendingSendAmount = val;
    sendBtn.disabled = !val || Number(val) <= 0;
    const clearBtn = document.getElementById('wk-send-clear');
    if (clearBtn) clearBtn.style.display = val && Number(val) > 0 ? '' : 'none';
    _updateSendBtnMode();
    _checkAmountOverBalance();
    _debounceSwapQuote();
  });

  // Select all on focus so typing replaces the value
  document.getElementById('wk-send-amount')?.addEventListener('focus', (e) => {
    (e.target as HTMLInputElement).select();
  });

  // ALL button — fill with selected chip's actual balance, floored to nearest cent
  document.getElementById('wk-send-all')?.addEventListener('click', () => {
    const selKey = selectedCoinSymbol?.toLowerCase() ?? '';
    const chip = _coinChipsCache.find(c => c.key === selKey) ?? _coinChipsCache[0];
    if (!chip) return;
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!amountInput) return;
    // Use actual token balance for stablecoins, chip.val (USD estimate) for others
    const sym = selectedCoinSymbol ?? '';
    const wc = walletCoins.find(c => c.symbol === sym || c.symbol.toLowerCase() === selKey)
      ?? (chip.colorCls === 'wk-coin-item--usd' ? walletCoins.find(c => c.isStable) : null);
    const isStable = wc?.isStable || chip.colorCls === 'wk-coin-item--usd';
    const rawVal = isStable ? (wc?.balance ?? app.stableUsd) : chip.val;
    // Floor to nearest cent
    const floored = Math.floor(rawVal * 100) / 100;
    pendingSendAmount = floored.toFixed(2);
    amountInput.value = pendingSendAmount;
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = false;
    _updateSendBtnMode();
    _debounceSwapQuote();
  });

  // 1 button — set $1
  document.getElementById('wk-send-one')?.addEventListener('click', () => {
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!amountInput) return;
    pendingSendAmount = '1.00';
    amountInput.value = '1.00';
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = false;
    const clearBtn = document.getElementById('wk-send-clear');
    if (clearBtn) clearBtn.style.display = '';
    _updateSendBtnMode();
    _debounceSwapQuote();
  });

  // 0.01 button — set minimum amount
  document.getElementById('wk-send-min')?.addEventListener('click', () => {
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!amountInput) return;
    pendingSendAmount = '0.01';
    amountInput.value = '0.01';
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = false;
    const clearBtn = document.getElementById('wk-send-clear');
    if (clearBtn) clearBtn.style.display = '';
    _updateSendBtnMode();
    _debounceSwapQuote();
  });

  // Clear button — zero out amount
  document.getElementById('wk-send-clear')?.addEventListener('click', () => {
    const amountInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (!amountInput) return;
    pendingSendAmount = '';
    amountInput.value = '';
    amountInput.classList.remove('wk-send-amount--over');
    const clearBtn = document.getElementById('wk-send-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    const sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = true;
    _updateSendBtnMode();
    _checkAmountOverBalance();
    _debounceSwapQuote();
    amountInput.focus();
  });

  // NS clear button — clear name input
  document.getElementById('wk-ns-clear-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _clearNsInput();
    const nsClearBtn = document.getElementById('wk-ns-clear-btn');
    if (nsClearBtn) nsClearBtn.style.display = 'none';
    _updateSendBtnMode();
  });

  // Custom swap output select
  _renderSwapSelect();
  _debounceSwapQuote();
  document.getElementById('wk-swap-select')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const opt = t.closest<HTMLElement>('.wk-swap-opt');
    if (opt?.dataset.key) {
      swapOutputKey = opt.dataset.key;
      _persistSwapOutput();
      _swapSelectOpen = false;
      _renderSwapSelect();
      _debounceSwapQuote();
      _updateSendBtnMode();
      return;
    }
    if (t.closest('#wk-swap-trigger') || t.closest('.wk-swap-trigger')) {
      _swapSelectOpen = !_swapSelectOpen;
      _renderSwapSelect();
    }
  });
  // Close swap/network selects when clicking outside
  document.addEventListener('click', () => {
    if (_swapSelectOpen) { _swapSelectOpen = false; _renderSwapSelect(); }
    if (_networkSelectOpen) { _networkSelectOpen = false; _renderNetworkSelect(); }
  });

  // Toggle token chips when clicking the balance row
  document.querySelector('.wk-popout-balance')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.wk-popout-bal-toggle')) return;
    if ((e.target as HTMLElement).closest('.wk-popout-bal-icon-btn')) return;
    coinChipsOpen = !coinChipsOpen;
    _persistCoinChipsOpen();
    document.getElementById('wk-coins-collapse')?.classList.toggle('wk-qr-collapse--hidden', !coinChipsOpen);
    _updateSendBtnMode();
  });

  // Toggle address section when clicking QR code or name badge
  const _toggleAddresses = () => {
    addrSectionOpen = !addrSectionOpen;
    _persistAddrSectionOpen();
    document.getElementById('wk-bal-collapse')?.classList.toggle('wk-badge-collapse--hidden', !addrSectionOpen);
  };

  document.getElementById('wk-addr-qr')?.addEventListener('click', _toggleAddresses);

  // Toggle addresses when clicking name badge
  document.querySelector('.wk-popout-name-badge')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.wk-popout-name-link')) return;
    e.preventDefault();
    _toggleAddresses();
  });

  // ─── Address QR code — network-aware ────────────────────────────────
  const addrQrSlot = document.getElementById('wk-addr-qr');
  if (addrQrSlot && ws.address) {
    const hasBtc = networkView === 'btc' && !!app.btcAddress;
    const qrAddr = hasBtc ? app.btcAddress : ws.address;
    const qrMode = hasBtc ? 'btc' : balView;
    _getAddrQrSvg(qrAddr, qrMode).then(svg => {
      if (document.getElementById('wk-addr-qr')) addrQrSlot.innerHTML = svg;
    }).catch(() => {});
  }

  // ─── NS domain row bindings ─────────────────────────────────────────
  _loadRosterQr(); // populate QR from initial _nsOwnedListHtml render
  _attachOwnedGridWheel();
  _attachNftPopoverListeners();
  const nsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
  nsInput?.addEventListener('click', (e) => e.stopPropagation());
  function _togglePasteBtn() {}
  nsInput?.addEventListener('focus', (e) => {
    e.stopPropagation();
    nsInput.value = '';
    nsInput.placeholder = 'name';
    nsLabel = '';
    nsAvail = null;
    nsTargetAddress = null;
    nsNftOwner = null;
    nsPriceUsd = null;
    nsPriceFetchFor = '';
    // Clear SuiAMI verification result
    _suiamiVerifyHtml = '';
    _patchNsStatus();
    _patchNsPrice();
    _patchNsRoute();
    _togglePasteBtn();
  });
  nsInput?.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text')?.trim();
    if (pasted && /^0x[0-9a-fA-F]{20,64}$/.test(pasted)) {
      e.preventDefault();
      nsTargetAddress = pasted;
      // Show full hex in the input with black diamond, no .sui/price/arrow
      nsLabel = pasted;
      nsInput.value = pasted;
      nsAvail = null;
      nsPriceUsd = null;
      nsPriceFetchFor = '';
      try { localStorage.setItem('ski:ns-label', ''); } catch {}
      _patchNsRoute();
      _patchNsStatus();
      _patchNsPrice();
      // Hide .sui and price chip for hex display
      const dotSui = document.querySelector('.wk-ns-dot-sui') as HTMLElement | null;
      const priceChip = document.getElementById('wk-ns-price-chip');
      const regBtn = document.getElementById('wk-dd-ns-register') as HTMLElement | null;
      const sendBtnNs = document.getElementById('wk-send-btn') as HTMLElement | null;
      if (dotSui) dotSui.style.display = 'none';
      if (priceChip) priceChip.style.display = 'none';
      if (regBtn) regBtn.style.display = 'none';
      if (sendBtnNs) sendBtnNs.style.display = '';
      // Reverse-resolve — if found, replace hex with the SuiNS name
      lookupSuiNS(pasted).then((name: string | null) => {
        if (name) {
          const bare = name.replace(/\.sui$/, '');
          nsLabel = bare;
          try { localStorage.setItem('ski:ns-label', bare); } catch {}
          const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (inp) inp.value = bare;
          // Restore .sui, price, arrow — _patchNsStatus will handle button visibility
          if (dotSui) dotSui.style.display = '';
          if (priceChip) priceChip.style.display = '';
          fetchAndShowNsPrice(bare);
        }
      });
    }
  });
  nsInput?.addEventListener('blur', () => {
    const val = nsInput.value.trim().toLowerCase().replace(/\.sui$/, '');
    // Don't clear hex addresses — they're valid targets shown in the input
    if (/^0x[0-9a-f]{20,64}$/i.test(val)) return;
    if (val && !isValidNsLabel(val)) {
      nsInput.value = '';
      nsLabel = '';
      nsAvail = null;
      nsTargetAddress = null;
      nsNftOwner = null;
      nsPriceUsd = null;
      nsPriceFetchFor = '';
      try { localStorage.setItem('ski:ns-label', ''); } catch {}
      _patchNsPrice();
      _patchNsStatus();
      // Restore hidden elements — _patchNsStatus handles register/send button visibility
      const dotSui = document.querySelector('.wk-ns-dot-sui') as HTMLElement | null;
      const priceChip = document.getElementById('wk-ns-price-chip');
      if (dotSui) dotSui.style.display = '';
      if (priceChip) priceChip.style.display = '';
    }
  });
  nsInput?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const regBtn = document.getElementById('wk-dd-ns-register') as HTMLElement | null;
      if (regBtn && regBtn.style.display !== 'none') {
        regBtn.click();
      } else {
        document.getElementById('wk-send-btn')?.click();
      }
    }
  });
  nsInput?.addEventListener('input', (e) => {
    _togglePasteBtn();
    const val = (e.target as HTMLInputElement).value.trim().toLowerCase();

    // Detect Sui hex address typed/pasted into the name input
    if (/^0x[0-9a-f]{20,64}$/i.test(val)) {
      // Handled by paste event — skip here to avoid double-processing
      return;
    }

    nsLabel = val;
    const nsClearBtn = document.getElementById('wk-ns-clear-btn');
    if (nsClearBtn) nsClearBtn.style.display = val ? '' : 'none';
    if (nsSubnameParent) {
      // Subname mode — no price fetch, just update register button title
      const parentBare = nsSubnameParent.name.replace(/\.sui$/, '');
      const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
      if (btn) btn.title = val ? `Create ${val}.${parentBare}.sui` : 'Create subname';
      return;
    }
    const validLabel = isValidNsLabel(val);
    try { if (validLabel) localStorage.setItem('ski:ns-label', val); } catch {}
    // Clear all price/availability state on name change
    // Don't show optimistic price if the name is in our owned roster
    const _inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === val);
    nsPriceUsd = (validLabel && val.length >= 5 && ns5CharPriceUsd != null && !_inRoster) ? ns5CharPriceUsd : null;
    nsAvail = _inRoster ? 'owned' : null;
    nsGraceEndMs = 0;
    nsTargetAddress = null;
    pendingSendAmount = '';
    const _amtInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (_amtInput) { _amtInput.value = ''; _amtInput.classList.remove('wk-send-amount--over'); }
    document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
    const _amtClear = document.getElementById('wk-send-clear');
    if (_amtClear) _amtClear.style.display = 'none';
    const _sendBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (_sendBtn) _sendBtn.disabled = true;
    nsNftOwner = null;
    nsLastDigest = '';
    nsKioskListing = null; nsTradeportListing = null;
    nsShadeOrder = null;
    _patchNsPrice();
    _patchNsStatus();
    _patchNsRoute();
    _patchNsOwnedList();
    const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
    if (btn) btn.title = !validLabel && val ? 'Invalid SuiNS name' : val ? `Mint ${val}.sui` : 'Mint .sui';
    if (nsPriceDebounce) clearTimeout(nsPriceDebounce);
    if (validLabel) nsPriceDebounce = setTimeout(() => fetchAndShowNsPrice(val), 400);
  });

  // Periodic validity recheck — refresh price/availability every 7 seconds for the active label
  if (_nsValidityInterval) clearInterval(_nsValidityInterval);
  _nsValidityInterval = setInterval(() => {
    const label = nsLabel.trim().toLowerCase();
    if (label && isValidNsLabel(label) && !nsSubnameParent) {
      fetchAndShowNsPrice(label);
    }
  }, 7000);

  // Toggle roster visibility when clicking domain-row outside the input/buttons
  document.querySelector('.wk-dd-ns-domain-row')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // Don't toggle if the user clicked the input, register button, pin button, or price chip
    if (t.closest('#wk-ns-label-input') || t.closest('#wk-dd-ns-register') || t.closest('#wk-ns-pin-btn') || t.closest('#wk-ns-price-chip') || t.closest('#wk-send-btn')) return;
    nsRosterOpen = !nsRosterOpen;
    _persistRosterOpen();
    if (!nsRosterOpen) _clearNsInput();
    const list = document.getElementById('wk-ns-owned-list');
    if (list) list.classList.toggle('wk-ns-owned-list--hidden', !nsRosterOpen);
  });

  document.getElementById('wk-ns-route')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.id === 'wk-ns-digest-link') {
      return;
    }
    // Target address text — click to copy
    if (target.closest('.wk-ns-target-addr')) {
      const addr = nsTargetAddress ?? nsNftOwner ?? getState().address;
      if (addr) {
        navigator.clipboard.writeText(addr).catch(() => {});
        const addrEl = target.closest('.wk-ns-target-row')?.querySelector('.wk-ns-target-addr') as HTMLElement | null;
        if (addrEl) {
          const orig = addrEl.textContent;
          addrEl.textContent = 'Copied! \u2713';
          setTimeout(() => { if (addrEl) addrEl.textContent = orig; }, 1500);
        }
      }
      return;
    }
    // Target icon — click to toggle roster
    if (target.closest('#wk-ns-target-edit-btn') || target.closest('.wk-ns-target-icon')) {
      nsRosterOpen = !nsRosterOpen;
      _persistRosterOpen();
      if (!nsRosterOpen) _clearNsInput();
      const list = document.getElementById('wk-ns-owned-list');
      if (list) list.classList.toggle('wk-ns-owned-list--hidden', !nsRosterOpen);
      return;
    }
    // Grace date span — click to toggle roster
    if (target.closest('.wk-ns-target-grace')) {
      nsRosterOpen = !nsRosterOpen;
      _persistRosterOpen();
      if (!nsRosterOpen) _clearNsInput();
      const list = document.getElementById('wk-ns-owned-list');
      if (list) list.classList.toggle('wk-ns-owned-list--hidden', !nsRosterOpen);
      return;
    }
    // Dim target row — click to toggle roster (names list) instead of copy
    const dimRow = target.closest<HTMLElement>('.wk-ns-target-row--dim');
    if (dimRow) {
      nsRosterOpen = !nsRosterOpen;
      _persistRosterOpen();
      if (!nsRosterOpen) _clearNsInput();
      const list = document.getElementById('wk-ns-owned-list');
      if (list) list.classList.toggle('wk-ns-owned-list--hidden', !nsRosterOpen);
      return;
    }
    // Whole target row — click to copy address
    const copyRow = target.closest<HTMLElement>('[data-copy-target]');
    if (copyRow?.dataset.copyTarget) {
      const addr = copyRow.dataset.copyTarget;
      navigator.clipboard.writeText(addr).catch(() => {});
      const addrSpan = copyRow.querySelector('.wk-ns-target-addr');
      if (addrSpan) {
        const orig = addrSpan.textContent || '';
        addrSpan.textContent = 'Copied \u2713';
        copyRow.classList.add('wk-ns-target-row--copied');
        setTimeout(() => { addrSpan.textContent = orig; copyRow.classList.remove('wk-ns-target-row--copied'); }, 1800);
      }
    }
    // Target cancel
    if (target.id === 'wk-ns-target-cancel') {
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
    }
    // Unpin subname mode
    if (target.id === 'wk-ns-unpin-btn') {
      const parentBare = nsSubnameParent?.name.replace(/\.sui$/, '') ?? '';
      nsSubnameParent = null;
      nsLabel = parentBare;
      nsAvail = null;
      nsPriceUsd = null;
      nsPriceFetchFor = '';
      nsLastDigest = '';
      renderSkiMenu();
      if (parentBare) fetchAndShowNsPrice(parentBare);
    }
  });

  // Target-address submit (inside route area)
  document.getElementById('wk-ns-route')?.addEventListener('input', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'wk-ns-target-input') {
      nsNewTargetAddr = (target as HTMLInputElement).value.trim();
    }
  });
  document.getElementById('wk-ns-route')?.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'wk-ns-target-input' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-ns-target-submit')?.click();
    }
    if (target.id === 'wk-ns-target-input' && (e as KeyboardEvent).key === 'Escape') {
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
    }
  });
  // Target-submit uses click delegation on route area (button is created dynamically by _patchNsRoute)
  let _targetSubmitBusy = false;
  document.getElementById('wk-ns-route')?.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id !== 'wk-ns-target-submit') return;
    ev.stopPropagation();
    if (_targetSubmitBusy) return;
    const ws2 = getState();
    if (!ws2.address) return;
    let addr = nsNewTargetAddr.trim();
    if (!addr) return;
    const submitBtn = document.getElementById('wk-ns-target-submit') as HTMLButtonElement | null;
    _targetSubmitBusy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u2026'; }
    try {
      // Resolve SuiNS name to address if input isn't a hex address
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) {
        const namePart = addr.replace(/\.sui$/i, '').toLowerCase();
        if (namePart.length < 3 || !/^[a-z0-9-]+$/.test(namePart)) {
          showToast('Enter a valid Sui address (0x…) or SuiNS name');
          return;
        }
        const resolved = await resolveSuiNSName(namePart);
        if (!resolved) {
          showToast(`${namePart}.sui doesn't resolve to an address`);
          return;
        }
        addr = resolved;
      }

      const label = nsLabel.trim();
      const isOwnedDomain = label && nsAvail === 'owned';

      // If editing an owned domain's target, submit on-chain tx
      if (isOwnedDomain) {
        const domain = label.endsWith('.sui') ? label : `${label}.sui`;
        const txBytes = await buildSetTargetAddressTx(ws2.address, domain, addr, nsRealOwnerAddr || undefined);
        await signAndExecuteTransaction(txBytes);
        showToast(`Target set to ${addr.slice(0, 6)}\u2026${addr.slice(-4)} \u2713`);
      }

      // Update target address state
      nsTargetAddress = addr;
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
      _patchNsStatus();

      // Reverse-resolve the address to find its primary SuiNS name
      if (addr.toLowerCase() !== ws2.address.toLowerCase()) {
        lookupSuiNS(addr).then((name: string | null) => {
          if (name) {
            const bare = name.replace(/\.sui$/, '');
            nsLabel = bare;
            try { localStorage.setItem('ski:ns-label', bare); } catch {}
            const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
            if (inp) inp.value = bare;
            // Trigger availability check for the resolved name
            fetchAndShowNsPrice(bare);
          }
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      _targetSubmitBusy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '\u2192'; }
    }
  });

  // Pin button — enter subname mode
  document.getElementById('wk-ns-pin-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ws2 = getState();
    if (!ws2.address) return;
    const label = nsLabel.trim();
    if (!label) return;
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    const pinBtn = document.getElementById('wk-ns-pin-btn');
    if (pinBtn) pinBtn.style.opacity = '0.4';
    try {
      const owned = await fetchOwnedDomains(nsRealOwnerAddr || ws2.address);
      const found = owned.find(d => d.name === domain && d.kind === 'nft');
      if (!found) { showToast(`No NFT found for ${domain}`); return; }
      nsSubnameParent = found;
      nsLabel = '';
      nsPriceUsd = null;
      nsAvail = null;
      nsGraceEndMs = 0;
      nsPriceFetchFor = '';
      nsLastDigest = '';
      renderSkiMenu();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      showToast(msg);
    } finally {
      if (pinBtn) pinBtn.style.opacity = '';
    }
  });

  document.getElementById('wk-ns-status')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ws2 = getState();
    if (!ws2.address) return;
    const label = nsLabel.trim();

    // Green circle (available) → toggle target address row
    if (nsAvail === 'available' && label) {
      nsRouteOpen = !nsRouteOpen;
      _persistRouteOpen();
      const route = document.getElementById('wk-ns-route');
      if (route) route.classList.toggle('wk-ns-route-wrap--hidden', !nsRouteOpen);
      return;
    }

    // Red hexagon (shade active) → cancel ALL on-chain shade orders for this wallet
    if (nsShadeOrder) {
      const icon = document.getElementById('wk-ns-status');
      if (icon) icon.style.opacity = '0.4';
      try {
        const isWaapWallet = /waap/i.test(ws2.walletName || '');
        const allOnChain = await fetchOnChainShadeOrders(ws2.address);
        if (allOnChain.length === 0) {
          showToast('No shade orders found on-chain');
          return;
        }
        let totalRefund = 0;
        let cancelled = 0;
        let firstErr = '';
        for (const o of allOnChain) {
          try {
            const tx = isWaapWallet
              ? await buildCancelRefundShadeOrderTx(ws2.address, o.objectId)
              : await buildCancelShadeOrderTx(ws2.address, o.objectId);
            if (icon) icon.style.opacity = `${0.2 + 0.6 * (cancelled / allOnChain.length)}`;
            await signAndExecuteTransaction(tx);
            if (isWaapWallet) {
              const cleanup = await reapCancelledShadeOrder(ws2.address, o.objectId);
              if (!cleanup.success) {
                const msg = (cleanup.error || 'Failed to delete cancelled shade object').toLowerCase();
                if (!msg.includes('not found') && !msg.includes('already')) {
                  throw new Error(cleanup.error || 'Failed to delete cancelled shade object');
                }
              }
            }
            _shadeCancelledIds.add(o.objectId); _persistShadeCancelled();
            removeShadeOrder(ws2.address, o.objectId);
            try { cancelShadeExecution(o.objectId); } catch { /* best-effort */ }
            totalRefund += Number(o.depositMist) / 1e9;
            cancelled++;
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            if (raw.toLowerCase().includes('reject')) break;
            if (!firstErr) firstErr = raw;
          }
        }
        const label = nsLabel.trim();
        nsShadeOrder = null;
        _stopShadeCountdown();
        if (cancelled > 0) {
          if (label) removeShadeOrderByDomain(ws2.address, label);
          nsShadeOrders = nsShadeOrders.filter(o => !_shadeCancelledIds.has(o.objectId) && o.domain !== label);
          _patchNsOwnedList();
        }
        _patchNsStatus();
        _patchNsPrice();
        _patchNsRoute();
        if (cancelled > 0) {
          showToast(`${cancelled} shade order${cancelled > 1 ? 's' : ''} cancelled \u2014 ${totalRefund.toFixed(2)} SUI refunded`);
        } else if (firstErr) {
          showToast(firstErr);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (!raw.toLowerCase().includes('reject')) showToast(raw);
      } finally {
        if (icon) icon.style.opacity = '1';
      }
      return;
    }

    // For non-owned, non-self-target names: toggle target address row
    const isSelfTarget = !!nsTargetAddress && nsTargetAddress.toLowerCase() === ws2.address.toLowerCase();
    if (!isSelfTarget && nsAvail !== 'owned') {
      nsRouteOpen = !nsRouteOpen;
      _persistRouteOpen();
      const route = document.getElementById('wk-ns-route');
      if (route) route.classList.toggle('wk-ns-route-wrap--hidden', !nsRouteOpen);
      return;
    }
    if (!label) return;
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    const icon = document.getElementById('wk-ns-status');
    if (icon) icon.style.opacity = '0.4';
    try {
      if (icon) icon.style.opacity = '0.1';
      const txBytes = await buildSetDefaultNsTx(ws2.address, domain);
      const result = await signAndExecuteTransaction(txBytes);
      // Verify the tx actually landed
      if (!result.digest) throw new Error('Transaction returned no digest');
      const eff = result.effects as Record<string, unknown> | undefined;
      const st = eff?.status as { status?: string; error?: string } | undefined;
      if (st?.status === 'failure') throw new Error(st.error || 'Transaction failed on-chain');
      app.suinsName = domain;
      suinsCache[ws2.address] = domain;
      try { localStorage.setItem(`ski:suins:${ws2.address}`, domain); } catch {}
      nsLastDigest = '';
      updateSkiDot('blue-square', domain);
      renderWidget();
      renderSkiBtn();
      renderSkiMenu();
      updateFavicon('blue-square');
      showToast(`${domain} set as primary \u2713 (${result.digest.slice(0, 8)})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      if (icon) icon.style.opacity = '';
    }
  });

  function parseNsError(raw: string): { display: string; full: string } {
    const lower = raw.toLowerCase();

    const isInsufficientBalance =
      lower.includes('insufficientcoinbalance') ||
      lower.includes('insufficient coin balance') ||
      lower.includes('insufficient_coin_balance');

    if (isInsufficientBalance) {
      return {
        display:
          'Insufficient balance — not enough funds to complete the registration.\n\n' +
          'You need SUI for gas fees plus ~$7.50 worth of one of:\n' +
          '  \u2022 NS (direct payment)\n' +
          '  \u2022 USDC (swapped via DeepBook)\n' +
          '  \u2022 SUI (swapped via DeepBook)\n\n' +
          'Add funds to your wallet and try again.',
        full: raw,
      };
    }

    if (lower.includes('transaction resolution failed')) {
      const inner = raw.replace(/transaction resolution failed[:\s]*/i, '').trim();
      if (inner.toLowerCase().includes('insufficient')) {
        return {
          display:
            'Insufficient balance — the wallet could not resolve enough funds for the transaction.\n\n' +
            'Make sure you have SUI for gas plus enough NS, USDC, or SUI (~$7.50) for the domain.\n\n' +
            `Detail: ${inner}`,
          full: raw,
        };
      }
      return {
        display:
          `Transaction failed during preparation: ${inner}\n\n` +
          'This may be a temporary network issue. Verify your wallet has sufficient SUI, USDC, or NS and try again.',
        full: raw,
      };
    }

    if (lower.includes('insufficientgas') || lower.includes('insufficient gas')) {
      const splashAuth = getSponsorState().auth;
      const splashActive = !!(splashAuth && new Date(splashAuth.expiresAt).getTime() > Date.now());
      const splashTip = splashActive ? '' : '\n\nTip: Activate Splash (below) for free gas sponsorship.';
      return {
        display: `Insufficient gas \u2014 not enough SUI to pay transaction fees. Add SUI to your wallet and try again.${splashTip}`,
        full: raw,
      };
    }

    if (lower.includes('objectnotfound') || lower.includes('object not found')) {
      return {
        display:
          'A required on-chain object was not found. The domain may already be registered, or there was a network issue. Refresh and try again.',
        full: raw,
      };
    }

    if (lower.includes('moveabort') || lower.includes('move_abort')) {
      return {
        display:
          `The SuiNS contract rejected this registration.\n\nThe domain may already be registered or the payment amount was incorrect.\n\nDetail: ${raw}`,
        full: raw,
      };
    }

    return { display: raw, full: raw };
  }

  /** Create a shade order. Optional executeAfterMs overrides nsGraceEndMs (for testing with available domains). */
  async function _shadeCreate(address: string, label: string, btn?: HTMLButtonElement | null, executeAfterMs?: number) {
    const price = suiPriceCache?.price;
    if (!price || price <= 0) { showToast('SUI price unavailable \u2014 try again'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
    const effectiveMs = executeAfterMs ?? nsGraceEndMs;
    try {
      const { txBytes, orderInfo } = await buildCreateShadeOrderTx(address, label, effectiveMs, price);
      if (btn) btn.textContent = '\u270f';
      const { digest, effects } = await signAndExecuteTransaction(txBytes);
      let orderId = extractShadeOrderIdFromEffects(effects);
      const placeholderId = orderId ?? `pending:${digest || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
      const fullOrder: ShadeOrderInfo = { ...orderInfo, objectId: placeholderId };
      addShadeOrder(address, fullOrder);
      nsShadeOrder = fullOrder;
      nsShadeOrders.push({ ...fullOrder });
      _patchNsStatus();
      _patchNsPrice();
      _patchNsRoute();
      _patchNsOwnedList();
      showToast(`${label}.sui shaded \u2713`);
      setTimeout(() => refreshPortfolio(true), 1200);
      const resolveAndSchedule = async () => {
        if (!orderId && digest) {
          orderId = await findCreatedShadeOrderId(digest);
          if (orderId && orderId !== placeholderId) {
            removeShadeOrder(address, placeholderId);
            fullOrder.objectId = orderId;
            addShadeOrder(address, fullOrder);
            if (nsShadeOrder?.objectId === placeholderId) nsShadeOrder = fullOrder;
            const idx = nsShadeOrders.findIndex(o => o.objectId === placeholderId);
            if (idx >= 0) nsShadeOrders[idx] = { ...fullOrder };
            else nsShadeOrders.push({ ...fullOrder });
            _patchNsOwnedList();
            try { cancelShadeExecution(placeholderId); } catch {}
          }
        }
        const resolvedId = orderId ?? placeholderId;
        // Connect WS for state updates (best-effort — don't block scheduling)
        try {
          connectShadeExecutor(address, (state: ShadeExecutorState) => {
            _shadeDoState = state;
            const doOrder = state.orders.find(o => o.objectId === resolvedId);
            if (doOrder?.status === 'completed') {
              nsShadeOrder = null;
              _stopShadeCountdown();
              removeShadeOrder(address, resolvedId);
              nsShadeOrders = nsShadeOrders.filter(o => o.objectId !== resolvedId);
              nsAvail = 'owned';
              _patchNsStatus();
              _patchNsPrice();
              _patchNsRoute();
              _patchNsOwnedList();
              showToast(`${fullOrder.domain}.sui auto-registered \u2713 ${doOrder.digest ? doOrder.digest.slice(0, 8) + '\u2026' : ''}`);
            }
          });
        } catch { /* WS optional — scheduling uses HTTP fallback */ }
        // Schedule with DO (tries WS RPC, falls back to HTTP POST)
        try {
          const schedResult = await scheduleShadeExecution({
            objectId: resolvedId,
            domain: fullOrder.domain,
            executeAfterMs: fullOrder.executeAfterMs,
            targetAddress: fullOrder.targetAddress,
            salt: fullOrder.salt,
            ownerAddress: address,
            depositMist: String(fullOrder.depositMist),
            preferredRoute: 'sui-ns',
          });
          if (!schedResult.success) {
            console.warn('[Shade] DO scheduling failed:', schedResult.error);
          }
        } catch (schedErr) {
          console.warn('[Shade] DO scheduling error:', schedErr);
        }
      };
      resolveAndSchedule();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.toLowerCase().includes('reject')) showToast(raw);
    } finally {
      if (btn) { btn.disabled = false; _patchNsStatus(); }
    }
  }

  /** Cancel all shade orders for the current address. Extracted so QR click can reuse. */
  async function _shadeCancel(address: string, label: string, btn?: HTMLButtonElement | null) {
    let existingOrder = nsShadeOrder ?? findShadeOrder(address, label);
    if (!existingOrder) {
      const onChain = await fetchOnChainShadeOrders(address);
      if (onChain.length > 0) {
        existingOrder = {
          objectId: onChain[0].objectId,
          domain: label,
          executeAfterMs: nsGraceEndMs,
          targetAddress: address,
          salt: '',
          depositMist: BigInt(onChain[0].depositMist),
          owner: address,
        };
      }
    }
    if (!existingOrder) { showToast('No shade order found'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
    try {
      const isWaapWallet = /waap/i.test(getState().walletName || '');
      const allOnChain = await fetchOnChainShadeOrders(address);
      const ordersToCxl = allOnChain.length > 0 ? allOnChain : [{ objectId: existingOrder.objectId, depositMist: String(existingOrder.depositMist) }];
      let totalRefund = 0;
      let cancelled = 0;
      let lastDigest = '';
      let firstErr = '';
      for (const o of ordersToCxl) {
        try {
          const tx = isWaapWallet
            ? await buildCancelRefundShadeOrderTx(address, o.objectId)
            : await buildCancelShadeOrderTx(address, o.objectId);
          if (btn) btn.textContent = `\u270f ${ordersToCxl.indexOf(o) + 1}/${ordersToCxl.length}`;
          const result = await signAndExecuteTransaction(tx);
          if (isWaapWallet) {
            const cleanup = await reapCancelledShadeOrder(address, o.objectId);
            if (!cleanup.success) {
              const msg = (cleanup.error || 'Failed to delete cancelled shade object').toLowerCase();
              if (!msg.includes('not found') && !msg.includes('already')) {
                throw new Error(cleanup.error || 'Failed to delete cancelled shade object');
              }
            }
            if (cleanup.digest) lastDigest = cleanup.digest;
          } else if (result.digest) {
            lastDigest = result.digest;
          }
          _shadeCancelledIds.add(o.objectId); _persistShadeCancelled();
          removeShadeOrder(address, o.objectId);
          try { cancelShadeExecution(o.objectId); } catch { /* best-effort */ }
          totalRefund += Number(o.depositMist) / 1e9;
          cancelled++;
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          if (raw.toLowerCase().includes('reject')) break;
          if (!firstErr) firstErr = raw;
        }
      }
      if (cancelled > 0) {
        nsShadeOrder = null;
        _stopShadeCountdown();
        removeShadeOrderByDomain(address, label);
        nsShadeOrders = nsShadeOrders.filter(o => !_shadeCancelledIds.has(o.objectId) && o.domain !== label);
        _patchNsOwnedList();
        _patchNsStatus();
        _patchNsPrice();
        _patchNsRoute();
        showToast(`${cancelled} shade order${cancelled > 1 ? 's' : ''} cancelled \u2014 ${totalRefund.toFixed(2)} SUI refunded ${lastDigest ? lastDigest.slice(0, 8) + '\u2026' : ''}`);
        setTimeout(() => refreshPortfolio(true), 1200);
      } else if (firstErr) {
        showToast(firstErr);
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.toLowerCase().includes('reject')) showToast(raw);
    } finally {
      if (btn) { btn.disabled = false; _patchNsStatus(); }
    }
  }

  document.getElementById('wk-dd-ns-register')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
    const ws2 = getState();
    if (!ws2.address) { showToast('Connect a wallet first'); return; }
    const label = nsLabel.trim();
    if (!label) { showToast(nsSubnameParent ? 'Enter a subname label' : 'Enter a domain label'); return; }

    // ── Subname mode: create leaf subname ──
    if (nsSubnameParent) {
      const parentBare = nsSubnameParent.name.replace(/\.sui$/, '');
      const fullName = `${label}.${parentBare}.sui`;
      if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
      try {
        // Resolve who the parent domain points to — crown fee always goes to them
        const parentTarget = await resolveNameToAddress(`${parentBare}.sui`);
        const feeRecipient = parentTarget ?? ws2.address;
        const tx = await buildSubnameTxBytes(ws2.address, nsSubnameParent, label, ws2.address, 'leaf', feeRecipient);
        if (btn) btn.textContent = '\u270f';
        await signAndExecuteTransaction(tx);
        showToast(`${fullName} created \u2713`);
        // Clear input for another subname
        nsLabel = '';
        const input = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (input) input.value = '';
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '\u2192'; }
      }
      return;
    }

    // ── Marketplace purchase (kiosk or Tradeport) — handled by early return above ──
    if (false) { // unreachable — kept for structure
      if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
      try {
        const listing = _nsListing()!;
        const priceMist = BigInt(listing.priceMist);
        const feeMist = listing.source === 'tradeport' ? priceMist * 300n / 10000n : 0n;
        const totalSuiMist = priceMist + feeMist;

        // Check if we need to swap from selected balance to SUI first
        const inCoinType = _getSwapInCoinType();
        const SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
        if (inCoinType !== SUI_COIN_TYPE) {
          // Swap selected token → SUI (enough to cover purchase + gas buffer)
          const gasBuf = 50_000_000n; // 0.05 SUI gas buffer
          const swapAmount = totalSuiMist + gasBuf;
          // Convert SUI amount needed to input token amount via price
          const suiP = suiPriceCache?.price ?? 0;
          if (suiP <= 0) throw new Error('SUI price unavailable — cannot estimate swap');
          const suiNeeded = Number(swapAmount) / 1e9;
          const inputDecimals = _getSwapInDecimals();
          let inputAmount: bigint;
          const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
          if (inCoinType === USDC_TYPE) {
            // USDC → SUI: use SUI price directly
            inputAmount = BigInt(Math.ceil(suiNeeded * suiP * 1.02 * (10 ** inputDecimals)));
          } else {
            // Other token → SUI: use token price
            const sym = selectedCoinSymbol ?? '';
            const tp = getTokenPrice(sym);
            if (!tp || tp <= 0) throw new Error(`${sym} price unavailable — cannot estimate swap`);
            const usdNeeded = suiNeeded * suiP;
            inputAmount = BigInt(Math.ceil((usdNeeded / tp) * 1.02 * (10 ** inputDecimals)));
          }
          if (btn) btn.textContent = 'SWAP';
          const swapResult = await buildSwapTx(ws2.address, inCoinType, SUI_COIN_TYPE, inputAmount);
          await signAndExecuteTransaction(swapResult.txBytes);
          showToast('Swapped to SUI \u2713');
          // Brief pause for chain state to propagate
          await new Promise(r => setTimeout(r, 1500));
        }

        // Build and execute purchase transaction
        if (btn) btn.textContent = 'TRADE';
        let purchaseTx: Uint8Array;
        if (nsKioskListing) {
          purchaseTx = await buildKioskPurchaseTx(ws2.address, nsKioskListing.kioskId, nsKioskListing.nftId, nsKioskListing.priceMist);
        } else {
          purchaseTx = await buildTradeportPurchaseTx(ws2.address, nsTradeportListing!.nftTokenId, nsTradeportListing!.priceMist);
        }
        if (btn) btn.textContent = '\u270f';
        const { digest } = await signAndExecuteTransaction(purchaseTx);

        // Post-purchase: update to owned state
        nsAvail = 'owned'; nsTargetAddress = ws2.address; nsLastDigest = digest ?? ''; nsKioskListing = null; nsTradeportListing = null;
        _patchNsStatus(); _patchNsRoute();
        const domain = `${label}.sui`;
        app.suinsName = app.suinsName || domain;
        suinsCache[ws2.address] = app.suinsName;
        try { localStorage.setItem(`ski:suins:${ws2.address}`, app.suinsName); } catch {}
        updateSkiDot('blue-square', app.suinsName);
        _userManuallySelectedCoin = false;
        nsOwnedFetchedFor = ''; _fetchOwnedDomains();
        walletCoins = []; appBalanceFetched = false;
        renderSkiMenu();
        setTimeout(() => refreshPortfolio(true), 2000);
        showToast(`${label}.sui purchased \u2713`);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (!raw.toLowerCase().includes('reject')) {
          const { display, full } = parseNsError(raw);
          showCopyableToast(display, full);
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'TRADE'; }
      }
      return;
    }

    // ── Shade mode: grace-period domain OR existing shade order ──
    // Auto-recover nsShadeOrder if the label matches a known shade order
    if (!nsShadeOrder) {
      const shadeMatch = findShadeOrder(ws2.address, label)
        ?? nsShadeOrders.find(o => o.domain === label)
        ?? (() => {
          const doMatch = _shadeDoState?.orders.find(o => o.domain === label && (o.status === 'pending' || o.status === 'executing'));
          return doMatch ? {
            objectId: doMatch.objectId,
            domain: doMatch.domain,
            executeAfterMs: doMatch.executeAfterMs,
            targetAddress: doMatch.targetAddress,
            salt: doMatch.salt,
            depositMist: BigInt(doMatch.depositMist),
            owner: ws2.address,
          } : null;
        })();
      if (shadeMatch) {
        nsShadeOrder = shadeMatch;
        nsGraceEndMs = nsGraceEndMs || shadeMatch.executeAfterMs || 0;
      }
    }
    if (nsAvail === 'grace' || nsShadeOrder) {
      const graceExpired = nsGraceEndMs > 0 && Date.now() >= nsGraceEndMs;
      // Use nsShadeOrder (populated by on-chain fallback) OR localStorage
      let existingOrder = nsShadeOrder ?? findShadeOrder(ws2.address, label);
      // Last resort: check on-chain before creating a new order
      if (!existingOrder) {
        if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
        const onChain = await fetchOnChainShadeOrders(ws2.address);
        if (onChain.length > 0) {
          existingOrder = {
            objectId: onChain[0].objectId,
            domain: label,
            executeAfterMs: nsGraceEndMs,
            targetAddress: ws2.address,
            salt: '',
            depositMist: BigInt(onChain[0].depositMist),
            owner: ws2.address,
          };
          nsShadeOrder = existingOrder;
        }
        if (btn) { btn.disabled = false; }
      }

      if (!existingOrder) {
        await _shadeCreate(ws2.address, label, btn);
        return;
      }

      if (graceExpired) {
        // Shade order + grace expired → execute registration
        if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
        try {
          const tx = await buildExecuteShadeOrderTx(ws2.address, existingOrder);
          if (btn) btn.textContent = '\u270f';
          const { digest } = await signAndExecuteTransaction(tx);
          // Remove shade order — it's consumed
          removeShadeOrder(ws2.address, existingOrder.objectId);
          nsShadeOrder = null;
          // Update state to owned
          nsAvail = 'owned';
          nsTargetAddress = ws2.address;
          nsLastDigest = digest ?? '';
          _patchNsStatus();
          _patchNsRoute();
          const domain = `${label}.sui`;
          app.suinsName = app.suinsName || domain;
          suinsCache[ws2.address] = app.suinsName;
          try { localStorage.setItem(`ski:suins:${ws2.address}`, app.suinsName); } catch {}
          updateSkiDot('blue-square', app.suinsName);
          nsOwnedFetchedFor = '';
          _fetchOwnedDomains();
          showToast(`${domain} registered ✓ ${digest ? digest.slice(0, 8) + '…' : ''}`);
          if (ws2.address) try { localStorage.removeItem(`ski:balances:${ws2.address}`); } catch {}
          refreshPortfolio(true);
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          if (!raw.toLowerCase().includes('reject')) {
            const { display, full } = parseNsError(raw);
            showCopyableToast(display, full);
          }
        } finally {
          if (btn) { btn.disabled = false; _patchNsStatus(); }
        }
        return;
      }

      // Shade order + grace still active → cancel
      await _shadeCancel(ws2.address, label, btn);
      return;
    }

    // ── Normal mode: register domain ──
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
    try {
      const result = await buildRegisterSplashNsTx(ws2.address, domain, suiPriceCache?.price, !app.suinsName, selectedCoinSymbol ?? undefined);
      if (btn) btn.textContent = '\u270f';
      let digest: string;
      if (result.sponsorAddress) {
        // Sponsored tx: user signs, then get sponsor sig, then submit both
        const { digest: d } = await signAndExecuteSponsoredTx(result.txBytes);
        digest = d;
      } else {
        const { digest: d } = await signAndExecuteTransaction(result.txBytes);
        digest = d;
      }
      // Update NS row: blue square status + show tx digest
      nsAvail = 'owned';
      nsTargetAddress = ws2.address;
      nsLastDigest = digest ?? '';
      _patchNsStatus();
      _patchNsRoute();
      // Immediately upgrade dot-btn and suins cache to blue square
      app.suinsName = app.suinsName || domain;
      suinsCache[ws2.address] = app.suinsName;
      try { localStorage.setItem(`ski:suins:${ws2.address}`, app.suinsName); } catch {}
      updateSkiDot('blue-square', app.suinsName);
      nsOwnedFetchedFor = ''; // force re-fetch of owned domains list
      _fetchOwnedDomains();
      showToast(`${domain} registered ✓ ${digest ? digest.slice(0, 8) + '…' : ''}`);
      if (ws2.address) try { localStorage.removeItem(`ski:balances:${ws2.address}`); } catch {}
      refreshPortfolio(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!raw.toLowerCase().includes('reject')) {
        const { display, full } = parseNsError(raw);
        showCopyableToast(display, full);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '\u2192'; }
    }
  });

  // Apply cached 5+ char price immediately so no spinner on menu open
  if (nsLabel.length >= 5 && ns5CharPriceUsd != null && nsPriceUsd == null) {
    nsPriceUsd = ns5CharPriceUsd;
    _patchNsPrice();
  }
  // Kick availability check (and price if not cached yet)
  if (nsLabel.length >= 3 && nsPriceFetchFor !== nsLabel) fetchAndShowNsPrice(nsLabel);

  // Discover real on-chain owner for WaaP wallets, then fetch owned SuiNS domains
  _discoverRealOwner();
  _fetchOwnedDomains();

  // Prune stale shade orders (consumed/cancelled) on first menu open
  // + auto-schedule any unscheduled orders with the ShadeExecutorAgent DO
  if (!nsShadeOrdersPruned && ws.address) {
    nsShadeOrdersPruned = true;
    pruneShadeOrders(ws.address).catch(() => {});
    nsShadeOrder = findShadeOrder(ws.address, nsLabel.trim());

    // Auto-schedule recovery — ensure all pending orders are registered with the DO
    const allOrders = getShadeOrders(ws.address);
    if (allOrders.length > 0) {
      (async () => {
        try {
          connectShadeExecutor(ws.address, (state: ShadeExecutorState) => {
            _shadeDoState = state;
            // If DO reports a completed order, refresh the UI
            for (const doOrder of state.orders) {
              if (doOrder.status === 'completed' && nsShadeOrder?.objectId === doOrder.objectId) {
                nsShadeOrder = null;
                _stopShadeCountdown();
                nsAvail = 'owned';
                _patchNsStatus();
                _patchNsPrice();
                showToast(`${doOrder.domain}.sui auto-registered \u2713 ${doOrder.digest ? doOrder.digest.slice(0, 8) + '\u2026' : ''}`);
              }
            }
          });
        } catch { /* WS optional */ }
        for (const o of allOrders) {
          try {
            await scheduleShadeExecution({
              objectId: o.objectId,
              domain: o.domain,
              executeAfterMs: o.executeAfterMs,
              targetAddress: o.targetAddress,
              salt: o.salt,
              ownerAddress: ws.address,
              depositMist: String(o.depositMist),
              preferredRoute: 'sui-ns',
            });
          } catch { /* idempotent — DO skips if already tracked */ }
        }
      })();
    }
  }

  // Owned domain list — click to populate input or remove wishlist
  document.getElementById('wk-ns-owned-list')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;

    // QR code shade action (red QR click)
    const qrEl = t.closest('#wk-roster-qr[data-qr-action]') as HTMLElement | null;
    if (qrEl) {
      const action = qrEl.dataset.qrAction;
      const ws2 = getState();
      const label = nsLabel.trim();
      if (!ws2.address || !label) return;
      if (action === 'cancel') { await _shadeCancel(ws2.address, label); return; }
      if (action === 'shade') { await _shadeCreate(ws2.address, label); return; }
      if (action === 'shade-test') { await _shadeCreate(ws2.address, label, null, Date.now() + 30_000); return; }
    }

    // Wishlist remove button
    const rmBtn = t.closest('.wk-ns-wish-rm') as HTMLElement | null;
    if (rmBtn) {
      e.preventDefault();
      const label = rmBtn.dataset.wishRm;
      if (label) { _removeFromWishlist(label); _patchNsOwnedList(); }
      return;
    }
    const btn = t.closest('.wk-ns-owned-chip') as HTMLElement | null;
    if (!btn) return;

    // Shade chip clicked
    if (btn.dataset.shade === '1') {
      const domain = btn.dataset.domain;
      const shadeId = btn.dataset.shadeId;
      // Orphaned shade order (no domain info in localStorage)
      if (!domain && shadeId) {
        showToast('Orphaned order — domain info was lost from localStorage');
        return;
      }
      // Failed shade order — offer retry
      if (shadeId && _shadeDoState?.orders.find(o => o.objectId === shadeId && o.status === 'failed')) {
        const addr = getState().address;
        if (addr) {
          resetFailedShadeOrders(addr, shadeId).then(() => {
            showToast('Retrying shade execution\u2026');
          }).catch(() => showToast('Retry request failed'));
        }
        return;
      }
      // Named shade order — populate input + pre-set shade state
      if (domain) {
        const ws2 = getState();
        // Match shade info by objectId OR domain (objectId may be stale pending: placeholder)
        const shadeInfo = nsShadeOrders.find(o => (o.objectId === shadeId || o.domain === domain) && o.domain === domain);
        nsLabel = domain;
        try { localStorage.setItem('ski:ns-label', domain); } catch {}
        nsPriceFetchFor = '';  // force fresh fetch
        if (shadeInfo) {
          nsShadeOrder = shadeInfo;
          nsAvail = 'grace';
          nsGraceEndMs = shadeInfo.executeAfterMs || 0;
          nsTargetAddress = shadeInfo.targetAddress || ws2.address || null;
        } else {
          // Even without roster match, set shade state from DO
          const doMatch = _shadeDoState?.orders.find(o => o.domain === domain);
          if (doMatch) {
            nsShadeOrder = {
              objectId: doMatch.objectId,
              domain: doMatch.domain,
              executeAfterMs: doMatch.executeAfterMs,
              targetAddress: doMatch.targetAddress,
              salt: doMatch.salt,
              depositMist: doMatch.depositMist,
            };
            nsAvail = 'grace';
            nsGraceEndMs = doMatch.executeAfterMs || 0;
            nsTargetAddress = doMatch.targetAddress || ws2.address || null;
          }
        }
        _patchNsPrice();
        _patchNsStatus();
        _patchNsRoute();
        skipNextFocusClear = true;
        const nsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (nsInput) {
          nsInput.value = domain;
          nsInput.focus();
        }
        // Still fetch fresh status in background
        fetchAndShowNsPrice(domain);
      }
      return;
    }

    const domain = btn.dataset.domain;
    if (!domain) return;
    // Set NS state directly — chip is from our roster so it's owned
    nsLabel = domain;
    try { localStorage.setItem('ski:ns-label', domain); } catch {}
    nsPriceUsd = null;
    nsPriceFetchFor = '';
    nsGraceEndMs = 0;
    const _chipInRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === domain.toLowerCase());
    nsAvail = _chipInRoster ? 'owned' : null;
    nsTargetAddress = null;
    nsNftOwner = null;
    nsLastDigest = '';
    nsKioskListing = null; nsTradeportListing = null;
    nsSubnameParent = null;
    // Clear stale amount from previous name
    if (_chipInRoster) {
      pendingSendAmount = '';
      const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
      document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
      const _ac = document.getElementById('wk-send-clear');
      if (_ac) _ac.style.display = 'none';
    }
    // Set input value and keep it set across re-renders
    skipNextFocusClear = true;
    const _setInput = () => {
      const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (inp && inp.value !== domain) inp.value = domain;
    };
    _setInput();
    _patchNsPrice();
    _patchNsStatus();
    _patchNsRoute();
    _patchNsOwnedList();
    _updateSendBtnMode();
    _setInput();
    // Re-set after microtask and animation frame in case of async re-renders
    Promise.resolve().then(_setInput);
    requestAnimationFrame(_setInput);
    setTimeout(_setInput, 50);
    setTimeout(_setInput, 200);
    fetchAndShowNsPrice(domain);
  });

  // Horizontal wheel scroll + NFT popover for owned names grid
  _attachOwnedGridWheel();
  _attachNftPopoverListeners();

}

// ─── Disconnect handler ──────────────────────────────────────────────

async function handleDisconnect(reopenModal = false) {
  _stopShadeCountdown();
  app.skiMenuOpen = false;
  try { localStorage.setItem('ski:lift', '0'); } catch {}
  app.copied = false;
  nsOwnedDomains = [];
  nsOwnedFetchedFor = '';
  nsRealOwnerAddr = '';
  nsSubnameParent = null;
  nsShowTargetInput = false;
  nsRosterOpen = false; _persistRosterOpen();
  try { sessionStorage.removeItem('ski:roster-scroll'); } catch {}
  closeModal();
  render();
  try { await disconnect(); } catch { /* already gone */ }
  if (reopenModal) setTimeout(() => openModal(true), 180);
}

// Update the SKI logo button's dot in the open modal without re-rendering the modal
function renderModalLogo() {
  const logoBtn = document.getElementById('ski-logo-btn');
  if (!logoBtn) return;
  logoBtn.innerHTML = getInlineSkiSvg();
}

// ─── Master render ───────────────────────────────────────────────────

function render() {
  renderWidget();
  renderSkiBtn();
  renderSignStage();
  renderSkiMenu();

  // Update favicon to match current wallet state
  const ws = getState();
  updateFavicon(!ws.address ? 'green-circle' : (app.suinsName ? 'blue-square' : 'black-diamond'));

  // Live-update all balance cycler instances and modal logo without full re-render
  const detailCyclerEl = document.getElementById('ski-detail-balance-cycler');
  if (detailCyclerEl) detailCyclerEl.innerHTML = buildBalanceCyclerRows();
  externalCyclers.forEach((el) => {
    if (document.contains(el)) { el.innerHTML = buildBalanceCyclerRows(); }
    else { externalCyclers.delete(el); }
  });
  renderModalLogo();

  // Scale the header to fit viewport width on mobile.
  // Measures the actual bounding box of first-to-last child to detect overflow.
  requestAnimationFrame(() => {
    const header = (slots.widget as HTMLElement | null)?.closest('.ski-header') as HTMLElement | null;
    if (!header) return;
    // Reset previous zoom
    header.style.zoom = '';
    const children = header.children;
    if (!children.length) return;
    const first = children[0].getBoundingClientRect();
    const last = children[children.length - 1].getBoundingClientRect();
    const contentWidth = last.right - first.left;
    const vw = window.innerWidth;
    if (contentWidth > vw - 8) { // 4px margin each side
      header.style.zoom = `${((vw - 8) / contentWidth).toFixed(4)}`;
    }
  });

  // NOTE: Do NOT call renderModal() here — it does a full innerHTML rebuild which
  // causes visible flash/jitter. The modal manages its own updates via targeted
  // DOM patches (balance cyclers, renderModalLogo, showKeyDetail, buildSplashLegend).
  // Only call renderModal() explicitly for structural changes (layout toggle,
  // wallet install, splash activate/deactivate).

  // Bind pill click
  const pill = document.getElementById('wallet-pill-btn');
  pill?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modalOpen) { closeModal(); return; }
    if (!getState().address) { openModal(); return; }
    const href = skiHref();
    if (app.suinsName) {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else if (window.location.hostname === 'sui.ski') {
      window.location.reload();
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });
}

// ─── Global event bindings ───────────────────────────────────────────

function bindEvents() {
  els.skiDot?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modalOpen) { closeModal(); return; }
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:lift', '0'); } catch {} render(); }
    openModal();
  });

  els.skiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();

    if (!getState().address) {
      if (modalOpen) { closeModal(); return; }
      openModal();
      return;
    }
    // Connected: only toggle SKI menu — close modal first if open
    if (modalOpen) closeModal();
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:lift', '0'); } catch {} render(); return; }
    app.skiMenuOpen = true;
    try { localStorage.setItem('ski:lift', '1'); } catch {}
    render();
  });

  els.skiBtn?.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown') {
      e.preventDefault();
      if (modalOpen) { closeModal(); return; }
      openModal(true);
    }
  });

  document.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'ArrowDown' && !modalOpen && document.activeElement !== els.skiBtn) {
      e.preventDefault();
      els.skiBtn?.focus();
      return;
    }
    if (key !== 'Escape') return;
    if (getState().address) {
      e.preventDefault();
      handleDisconnect(false);
    } else if (modalOpen) {
      e.preventDefault();
      closeModal();
      els.skiBtn?.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!app.skiMenuOpen) return;
    if (els.skiDot?.contains(e.target as Node)) return;
    if (els.skiBtn?.contains(e.target as Node)) return;
    if (els.skiMenu?.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest?.('#ski-nft-popover')) return;
    if ((e.target as HTMLElement).closest?.('.app-toast')) return;
    app.skiMenuOpen = false;
    try { localStorage.setItem('ski:lift', '0'); } catch {}
    render();
  });

  window.addEventListener('focus', () => { if (getState().address) refreshPortfolio(true); });
  document.addEventListener('visibilitychange', () => {
    if (getState().address && document.visibilityState === 'visible') refreshPortfolio(true);
  });
}

// ─── Init ────────────────────────────────────────────────────────────

export function initUI() {
  bindEvents();

  // Tools panel toggle (Splash + Sign Message)
  const _toolsToggle = document.getElementById('ski-tools-toggle');
  if (_toolsToggle) {
    // Restore collapsed state
    const collapsed = (() => { try { return localStorage.getItem('ski:tools-collapsed') !== '0'; } catch { return true; } })();
    if (collapsed && els.signStage) {
      els.signStage.classList.add('ski-sign--collapsed');
      els.signStage.style.display = 'none';
    }
    _toolsToggle.classList.toggle('ski-tools-toggle--active', !collapsed);
    _toolsToggle.addEventListener('click', () => {
      if (!els.signStage) return;
      const isCollapsed = els.signStage.classList.toggle('ski-sign--collapsed');
      _toolsToggle.classList.toggle('ski-tools-toggle--active', !isCollapsed);
      if (isCollapsed) {
        els.signStage.style.display = 'none';
      } else {
        els.signStage.style.display = '';
      }
      try { localStorage.setItem('ski:tools-collapsed', isCollapsed ? '1' : '0'); } catch {}
    });
  }

  // Subscribe to wallet state changes
  let _lastSubscribedAddr = '';
  let _lastSubscribedStatus = '';
  subscribe((ws: WalletState) => {
    // Only clear hydrating on terminal states
    if (ws.status === 'connected' || ws.status === 'disconnected') _hydrating = false;

    // Skip redundant updates — Phantom re-emits connected state periodically
    const sameState = ws.status === _lastSubscribedStatus && ws.address === _lastSubscribedAddr;
    _lastSubscribedStatus = ws.status ?? '';
    _lastSubscribedAddr = ws.address ?? '';
    if (sameState && ws.status === 'connected') return; // no-op re-emit

    if (ws.status === 'connected' && ws.address) {
      // Persist this address under the wallet name so it survives disconnect/switch
      if (ws.walletName) {
        try {
          const key = `ski:wallet-keys:${ws.walletName}`;
          const existing: string[] = JSON.parse(localStorage.getItem(key) || '[]');
          const normalized = normalizeSuiAddress(ws.address);
          if (!existing.includes(normalized)) {
            localStorage.setItem(key, JSON.stringify([...existing, normalized]));
          }
        } catch {}
        // Detect and store WaaP social provider from account label
        if (/waap/i.test(ws.walletName) && ws.account?.label) {
          storeWaapProvider(ws.address, detectWaapProvider(ws.account.label));
        }
      }
      // Always clear first so a previously connected wallet's name never bleeds through
      app.suinsName = '';
      // Restore this address's cached SuiNS name instantly (will refresh from network)
      try {
        const cached = localStorage.getItem(`ski:suins:${ws.address}`);
        if (cached) app.suinsName = cached;
      } catch {}
      // Restore cached IKA dWallet status instantly (squid emoji, BTC address)
      try {
        const ikaCached = localStorage.getItem(`ski:ika:${ws.address}`);
        if (ikaCached) {
          const c = JSON.parse(ikaCached) as { btc: string; eth: string; id: string };
          if (c.id) { app.ikaWalletId = c.id; app.btcAddress = c.btc; app.ethAddress = c.eth; }
        }
      } catch {}

      startPolling();
      refreshPortfolio(true);

      // Dispatch event for other modules (fingerprint, session agent)
      window.dispatchEvent(new CustomEvent('ski:wallet-connected', {
        detail: { address: ws.address, walletName: ws.walletName },
      }));
    }

    if (ws.status === 'disconnected') {
      stopPolling();
      app.sui = 0;
      app.usd = null;
      app.stableUsd = 0;
      app.nsBalance = 0;
      app.suinsName = '';
      app.ikaWalletId = '';
      app.btcAddress = '';
      app.ethAddress = '';
      app.skiMenuOpen = false;
      try { localStorage.setItem('ski:lift', '0'); } catch {}
      app.copied = false;
      // Keep ski:suins-name and ski:session so data persists through disconnect

      window.dispatchEvent(new CustomEvent('ski:wallet-disconnected'));
    }

    render();
  });

  // Re-render when sponsor state changes (badge, ski-sign card, legend)
  subscribeSponsor(() => {
    render();
    const slot = document.getElementById('ski-legend-slot');
    if (slot) {
      const next = buildSplashLegend();
      if (slot.innerHTML !== next) slot.innerHTML = next;
    }
    // Refresh active card (sponsor state affects splash toggle display)
    const detailEl = document.getElementById('ski-modal-detail');
    const ws = getState();
    if (detailEl && ws.walletName) {
      const wallet = getSuiWallets().find((w) => w.name === ws.walletName);
      if (wallet) showKeyDetail(wallet, detailEl, ws.address);
    }
  });

  // Delegated: legend row mouseover → highlight only (no detail update)
  els.modal?.addEventListener('mouseover', (e) => {
    if (!modalOpen) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-row');
    if (!row) return;
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
    rows.forEach((r) => r.classList.remove('active'));
    row.classList.add('active');
  });

  // Delegated: wallet-list row hover → highlight only (no detail update)
  els.modal?.addEventListener('mouseover', (e) => {
    if (!modalOpen) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.wk-dd-item[data-wallet-name]');
    if (!btn) return;
    document.querySelectorAll('.wk-dd-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Long-press (2200ms) on any row to lock/unlock the detail pane
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressX = 0;
  let longPressY = 0;
  let longPressFired = false; // suppresses the click that fires after pointerup

  els.modal?.addEventListener('pointerdown', (e) => {
    longPressFired = false;

    // Addr cell long-press → open suiscan (distinct from row long-press → lock detail)
    const addrTarget = (e.target as HTMLElement).closest<HTMLElement>('[data-scan-addr]');
    if (addrTarget?.dataset.scanAddr) {
      const addr = addrTarget.dataset.scanAddr;
      longPressX = e.clientX; longPressY = e.clientY;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        window.open(`https://suiscan.xyz/mainnet/account/${addr}`, '_blank', 'noopener');
      }, 2200);
      return;
    }

    const row = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-row, .wk-dd-item[data-wallet-name]');
    if (!row) return;
    longPressX = e.clientX; longPressY = e.clientY;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressFired = true;
      const wName = row.dataset.legendWallet ?? row.dataset.walletName ?? null;
      const wallet = wName ? (getSuiWallets().find((w) => w.name === wName) ?? null) : null;
      const clearLocked = () => {
        document.querySelectorAll<HTMLElement>('.ski-legend-row--locked, .wk-dd-item--locked').forEach((el) => {
          el.classList.remove('ski-legend-row--locked', 'wk-dd-item--locked');
        });
      };
      if (detailLocked && lockedWallet === wallet) {
        detailLocked = false; lockedWallet = null; clearLocked();
      } else {
        detailLocked = true; lockedWallet = wallet; clearLocked();
        row.classList.add(row.classList.contains('wk-dd-item') ? 'wk-dd-item--locked' : 'ski-legend-row--locked');
        if (wallet) {
          const detailEl = document.getElementById('ski-modal-detail');
          if (detailEl) showKeyDetail(wallet, detailEl, getState().address);
        }
      }
    }, 2200);
  });

  const cancelLongPress = (e: PointerEvent) => {
    if (!longPressTimer) return;
    if (e.type === 'pointermove') {
      const d = Math.sqrt((e.clientX - longPressX) ** 2 + (e.clientY - longPressY) ** 2);
      if (d < 5) return;
    }
    clearTimeout(longPressTimer); longPressTimer = null;
  };
  els.modal?.addEventListener('pointerup', cancelLongPress as EventListener);
  els.modal?.addEventListener('pointermove', cancelLongPress as EventListener);
  els.modal?.addEventListener('pointercancel', cancelLongPress as EventListener);

  // Delegated: legend row click → connect (skip anchor clicks)
  // Also handles wallet-list row clicks and balance toggle
  els.modal?.addEventListener('click', (e) => {
    if (longPressFired) { longPressFired = false; return; } // long-press consumed this click

    // Detail pane keyed header click → connect wallet + lock-in (BEFORE anchor check
    // so clicks on the address link inside the header trigger connection, not Suiscan)
    const clickedDetailHeader = (e.target as HTMLElement).closest<HTMLElement>('.ski-detail-header--keyed');
    const detailPane = document.getElementById('ski-modal-detail');
    if (clickedDetailHeader && detailPane?.contains(clickedDetailHeader)) {
      e.preventDefault(); // prevent anchor navigation inside header
      // Use lockedWallet if available, otherwise read wallet name from the detail header
      const wallet = lockedWallet
        ?? (() => {
          const wName = clickedDetailHeader.dataset.detailWallet;
          return wName ? getSuiWallets().find((w) => w.name === wName) ?? null : null;
        })();
      if (wallet) {
        // "+ new WaaP" detail pane → full disconnect to clear WaaP's in-memory
        // session, then connect with skipSilent to force the OAuth modal open.
        if (clickedDetailHeader.dataset.detailCreateWaap) {
          closeModal();
          void (async () => {
            // Full disconnect clears WaaP's accounts so connect() won't short-circuit
            try { await disconnect(); } catch {}
            // Purge WaaP's OAuth localStorage keys so the SDK doesn't silently
            // re-authenticate with the same social account on reconnect
            try {
              for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && !k.startsWith('ski:')) localStorage.removeItem(k);
              }
            } catch {}
            try {
              await connect(wallet, { skipSilent: true });
            } catch (err) {
              showToast('Failed to connect: ' + _errMsg(err));
            }
          })();
        } else if (/waap/i.test(wallet.name)) void tryWaapProofConnect(wallet);
        else {
          // Connect + lock-in: selectWallet triggers popup, then lockInIdentity signs
          void (async () => {
            await selectWallet(wallet);
            if (getState().status === 'connected') void lockInIdentity();
          })();
        }
      }
      return;
    }

    if ((e.target as HTMLElement).closest('a')) return;

    // Copy-on-click for address cells — short click copies, long-press opens suiscan
    const addrSpan = (e.target as HTMLElement).closest<HTMLElement>('[data-copy-addr]');
    if (addrSpan?.dataset.copyAddr) {
      const addr = addrSpan.dataset.copyAddr;
      navigator.clipboard.writeText(addr).catch(() => {});
      const orig = addrSpan.textContent || '';
      addrSpan.textContent = 'Copied';
      addrSpan.classList.add('ski-legend-addr--copied');
      setTimeout(() => { addrSpan.textContent = orig; addrSpan.classList.remove('ski-legend-addr--copied'); }, 1500);
      return;
    }

    // Balance cycler toggle: switch between SUI-primary and USD-primary
    if ((e.target as HTMLElement).closest('#ski-detail-balance-cycler')) {
      balView = balView === 'sui' ? 'usd' : 'sui';
      try { localStorage.setItem('ski:bal-pref', balView); } catch {}
      syncBalanceDisplays();
      return;
    }

    // Group toggle: arrow, area left of arrow, or first row's shape — all toggle the group
    const _toggleTarget = e.target as HTMLElement;
    const arrowBtn = _toggleTarget.closest<HTMLElement>('.ski-legend-group-arrow');
    const headEl = _toggleTarget.closest<HTMLElement>('.ski-legend-group-head');
    // Click on shape of the head row (first shape in group)
    const headShape = headEl && _toggleTarget.closest<HTMLElement>('.ski-legend-shape');
    // Click landed on the head element itself to the left of child content (padding area)
    const isHeadPadding = headEl && _toggleTarget === headEl;
    if (arrowBtn || headShape || isHeadPadding) {
      const group = (arrowBtn || headEl)?.closest('.ski-legend-group');
      if (group) group.classList.toggle('ski-legend-group--open');
      // Also activate the head row as the active wallet
      const headRow = (arrowBtn || headEl)?.closest('.ski-legend-group-head')?.querySelector<HTMLElement>('.ski-legend-row');
      if (headRow) {
        const idx = parseInt(headRow.dataset.legendIdx || '-1', 10);
        if (idx >= 0) activateLegendRow(idx);
      }
      return;
    }

    // "Create WaaP" row click → just activate it in the detail selector (don't open OAuth yet)
    const createWaapRow = (e.target as HTMLElement).closest<HTMLElement>('[data-legend-create-waap]');
    if (createWaapRow) {
      const idx = parseInt(createWaapRow.dataset.legendIdx || '-1', 10);
      if (idx >= 0) activateLegendRow(idx);
      return;
    }

    // Legend row click → show detail pane; if no keys stored, connect directly
    const legendRow = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-row');
    if (legendRow) {
      const idx = parseInt(legendRow.dataset.legendIdx || '-1', 10);
      if (idx >= 0) activateLegendRow(idx);
      return;
    }
    // Wallet-list row click → show wallet in detail pane (active card)
    const listBtn = (e.target as HTMLElement).closest<HTMLElement>('.wk-dd-item[data-wallet-name]');
    if (listBtn?.dataset.walletName) {
      const wallet = getSuiWallets().find((w) => w.name === listBtn.dataset.walletName);
      const detailEl = document.getElementById('ski-modal-detail');
      if (wallet && detailEl) showKeyDetail(wallet, detailEl, getState().address);
    }
  });

  // Delegated: keyboard navigation on legend rows
  els.modal?.addEventListener('keydown', (e) => {
    if (!modalOpen) return;
    const allRows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
    // Only include visible (uncollapsed) rows: exclude rows inside a collapsed group body
    const rows = allRows.filter(r => {
      const body = r.closest('.ski-legend-group-body');
      if (!body) return true; // not inside a group body → always visible
      return !!body.closest('.ski-legend-group--open');
    });
    if (!rows.length) return;
    const ke = e as KeyboardEvent;
    // Find current position in visible rows by data-legend-idx
    const curVisIdx = rows.findIndex(r => parseInt(r.dataset.legendIdx || '-1', 10) === activeLegendIdx);
    if (ke.key === 'ArrowDown') {
      e.preventDefault();
      const nextVis = (curVisIdx + 1) % rows.length;
      const nextIdx = parseInt(rows[nextVis]?.dataset.legendIdx || '-1', 10);
      if (nextIdx >= 0) activateLegendRow(nextIdx);
      rows[nextVis]?.focus();
    } else if (ke.key === 'ArrowUp') {
      e.preventDefault();
      const prevVis = (curVisIdx - 1 + rows.length) % rows.length;
      const prevIdx = parseInt(rows[prevVis]?.dataset.legendIdx || '-1', 10);
      if (prevIdx >= 0) activateLegendRow(prevIdx);
      rows[prevVis]?.focus();
    } else if (ke.key === 'Escape') {
      closeModal();
    } else if (ke.key === 'Enter') {
      const row = rows[activeLegendIdx];
      if (row?.dataset.legendWallet && row.dataset.legendAddr) {
        // Keyed row (has address) — connect directly
        const wallet = getSuiWallets().find((w) => w.name === row.dataset.legendWallet);
        if (wallet) {
          if (/waap/i.test(wallet.name)) void tryWaapProofConnect(wallet);
          else selectWallet(wallet);
        }
      } else if (row?.dataset.legendWallet) {
        // Green circle / no-address row — simulate detail header click to open wallet provider
        const header = document.querySelector<HTMLElement>('.ski-detail-header--keyed');
        header?.click();
      }
    }
  });

  // Patch legend when wallets change — debounced to avoid flash as accounts trickle in.
  // Never does a full renderModal() — only patches the legend slot in-place to avoid flash.
  let _walletChangeTimer: ReturnType<typeof setTimeout> | null = null;
  onWalletsChanged(() => {
    if (_walletChangeTimer) clearTimeout(_walletChangeTimer);
    _walletChangeTimer = setTimeout(() => {
      _walletChangeTimer = null;
      if (modalOpen) {
        const slot = document.getElementById('ski-legend-slot');
        if (slot) {
          const next = buildSplashLegend();
          if (slot.innerHTML !== next) slot.innerHTML = next;
        }
        const detailEl = document.getElementById('ski-modal-detail');
        const ws = getState();
        if (detailEl && ws.walletName) {
          const wallets = getSuiWallets();
          const wallet = wallets.find((w) => w.name === ws.walletName);
          if (wallet) showKeyDetail(wallet, detailEl, ws.address);
        }
      }
    }, 500);
  });

  // Pre-populate wallet state from localStorage for instant first render.
  // This lets the button show the connected state before autoReconnect() completes.
  const preloaded = preloadStoredWallet();
  if (preloaded) {
    _hydrating = true;
    try {
      const cachedName = localStorage.getItem(`ski:suins:${preloaded.address}`);
      if (cachedName) app.suinsName = cachedName;
    } catch {}
    try {
      const raw = localStorage.getItem(`ski:balances:${preloaded.address}`);
      // Skip stale cached balances if a mutation (swap/consolidation) happened recently
      const recentMutation = _lastMutationMs > 0 && Date.now() - _lastMutationMs < 30_000;
      if (raw && !recentMutation) {
        const b = JSON.parse(raw) as { sui?: number; stableUsd?: number; usd?: number | null; t?: number; ns?: number; nsBalance?: number };
        if (typeof b.sui === 'number') app.sui = b.sui;
        if (typeof b.stableUsd === 'number') app.stableUsd = b.stableUsd;
        if (b.usd !== undefined) app.usd = b.usd;
        // Don't load cached walletCoins — chips only show live data
        appBalanceFetched = true;
        // Purge legacy ns/nsBalance fields from cache
        if ('ns' in b || 'nsBalance' in b) {
          try { localStorage.setItem(`ski:balances:${preloaded.address}`, JSON.stringify({ sui: b.sui, stableUsd: b.stableUsd, usd: b.usd, t: b.t })); } catch {}
        }
      }
    } catch {}
  } else {
    // Fallback: suppress disconnected flash for dapp-kit wallets
    try {
      if (localStorage.getItem('mysten-dapp-kit:selected-wallet-and-address')) {
        _hydrating = true;
      }
    } catch {}
  }

  // Initial render — already shows connected state if preloaded
  render();

  // Restore modal if it was open before refresh
  if (modalOpen) {
    els.widget?.classList.add('ski-modal-active');
    renderModal();
  }

  // Auto-reconnect to last wallet (fills in real wallet object + icon)
  autoReconnect().catch(() => {});

  // Eagerly warm the 5+ char NS price cache so the menu never shows a spinner
  if (ns5CharPriceUsd == null) {
    fetchDomainPriceUsd('splash').then((p) => {
      ns5CharPriceUsd = p;
      try { localStorage.setItem('ski:ns5-price', String(p)); } catch {}
      // If the menu is already open with a 5+ char label, patch immediately
      if (app.skiMenuOpen && nsLabel.length >= 5 && nsPriceUsd == null) {
        nsPriceUsd = p;
        _patchNsPrice();
      }
    }).catch(() => {});
  }
  // Safety: clear hydrating after 1.5 s in case subscribe never fires
  setTimeout(() => { if (_hydrating) { _hydrating = false; render(); } }, 1500);
}
