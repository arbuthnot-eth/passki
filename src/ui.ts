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
  reconnectWallet,
  autoReconnect,
  preloadStoredWallet,
  onWalletsChanged,
  type WalletState,
} from './wallet.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { SuiGrpcClient } from '@mysten/sui/grpc';
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
} from './sponsor.js';
import { fetchOwnedDomains, buildSubnameTx, buildRegisterSplashNsTx, fetchDomainPriceUsd, checkDomainStatus, buildSetDefaultNsTx, buildSetTargetAddressTx, buildSubnameTxBytes, lookupNftOwner, type OwnedDomain, type DomainStatusResult } from './suins.js';
import SKI_SVG_TEXT from '../public/assets/ski.svg';
import SUI_DROP_SVG_TEXT from '../public/assets/sui-drop.svg';
import SUI_SKI_QR_SVG_TEXT from '../public/assets/sui-ski-qr.svg';

export const grpcClient = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});

// ─── Assets ──────────────────────────────────────────────────────────

export const SUI_DROP_URI = `data:image/svg+xml,${encodeURIComponent(SUI_DROP_SVG_TEXT)}`;
const SKI_SVG_URI     = `data:image/svg+xml,${encodeURIComponent(SKI_SVG_TEXT)}`;
const SUI_SKI_QR_URI  = `data:image/svg+xml,${encodeURIComponent(SUI_SKI_QR_SVG_TEXT)}`;

const ASSETS = {
  suiDrop: SUI_DROP_URI,
};

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
  skiMenuOpen: (() => { try { return localStorage.getItem('ski:menu-open') === '1'; } catch { return false; } })(),
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
  if (!addr || addr.length <= 20) return addr;
  return addr.slice(0, 10) + '\u2026' + addr.slice(-8);
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
  const timer = setTimeout(remove, durationMs);

  toast.addEventListener('click', () => {
    if (copied) { remove(); return; }
    copied = true;
    clearTimeout(timer);
    navigator.clipboard.writeText(fullText).catch(() => {});
    hint.textContent = '\u2713 Copied';
    hint.style.color = '#4ade80';
    setTimeout(remove, 1400);
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
  if (ws.address && app.suinsName) {
    // Hide SKI letter paths and replace with live balance (left-justified from after the dot)
    svg = svg.replace('id="ski-text"', 'id="ski-text" style="display:none"');
    const rawBal = balView === 'usd'
      ? ((fmtUsd(app.usd) || '').replace(/^\$/, '') || '--')
      : fmtSui(app.sui);
    // Flexible: fill from dot-right-edge (x=365) to lift bottom-right (x=1180), ~815 units wide.
    // Font scales so character height fills the lower SVG zone (y=460..840).
    const fontSize = Math.max(200, Math.min(380, Math.floor(815 / (rawBal.length * 0.52))));
    // Push center up for large fonts so text stays within the 847-tall viewBox
    const textY = Math.min(672, 840 - Math.round(fontSize / 2));
    extraOverlay = `<defs><filter id="ski-bal-glow" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="10" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><text x="365" y="${textY}" textLength="815" lengthAdjust="spacingAndGlyphs" text-anchor="start" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="${fontSize}" font-weight="800" fill="white" stroke="white" stroke-width="6" paint-order="stroke fill" filter="url(#ski-bal-glow)" pointer-events="none">${esc(rawBal)}</text>`;
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
  ctx.fillStyle = '#000000';
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
    shape = `<rect x="0" y="0" width="100" height="100" rx="12" fill="#4da2ff" stroke="white" stroke-width="8"/><g transform="translate(22,14) scale(0.1875)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
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
  if (titleEl) titleEl.textContent = suinsName ? '.Sui Key-In' : 'SKI';
}

// ─── Hydration guard (suppress disconnected flash on reload) ─────────

let _hydrating = false;

// ─── Wallet Modal ────────────────────────────────────────────────────

let modalOpen = false;
let headerCyclerUnmount: (() => void) | null = null;
const suinsCache: Record<string, string> = {}; // address -> name
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

/** Generate (or return cached) QR SVG for a URL. Stored in localStorage. */
async function getQrSvg(url: string): Promise<string> {
  const key = `ski:qr:${url}`;
  try { const cached = localStorage.getItem(key); if (cached) return cached; } catch {}
  const mod = await import('qrcode');
  const QRCode = (mod as unknown as { default: typeof mod }).default ?? mod;
  const svg = await (QRCode as { toString: (url: string, opts: object) => Promise<string> })
    .toString(url, { type: 'svg', margin: 1, color: { dark: '#60a5fa', light: '#0d1117' }, errorCorrectionLevel: 'M' });
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
  return `<button type="button" class="ski-key-pfp ski-key-pfp--diamond${splashClass}" data-splash-addr="${escaped}" title="${splashTitle}"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="4"/></svg>${dropOverlay}</button>`;
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
  const pfpCol = connKeyEl.querySelector<HTMLElement>('.ski-detail-key-column, .ski-detail-key-column--in-wrap');
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

  // Float the wallet's active account to the top (the key it would use if clicked).
  // For the connected wallet liveAddrs[0] === connectedAddr; for others it's whatever
  // the extension has selected right now.
  const activeAddr = liveAddrs[0] ?? connectedAddr;
  if (activeAddr && displayAddrs.includes(activeAddr)) {
    displayAddrs = [activeAddr, ...displayAddrs.filter((a: string) => a !== activeAddr)];
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
  const activeTextHtml = addr0 ? `<div class="ski-detail-key-text">
        <span class="ski-detail-suins-slot"></span>
        <div class="ski-detail-addr-row">
          <a href="${esc(scanUrl0)}" target="_blank" rel="noopener" class="ski-detail-addr-text" title="${esc(addr0)}">${esc(truncAddr(addr0))}</a>
          <button class="ski-copy-btn" title="Copy address">\u2398</button>
        </div>
      </div>` : '';

  const otherKeysHtml = displayAddrs.slice(1).map((addr: string, i: number) => keyCardHtml(addr, i + 1)).join('');

  const isConnected = displayAddrs[0] === connectedAddr;
  void isConnected; // balance now shown in modal logo SVG
  const balanceCyclerHtml = '';

  detailEl.innerHTML = `
    <div class="ski-detail-header${addr0 ? ' ski-detail-header--keyed' : ''}">
      <div class="ski-detail-icon-row"${addr0 ? ` data-addr-idx="0" data-full-addr="${esc(addr0)}"` : ''}>
        <div class="ski-detail-icons-top">
          <div class="ski-detail-key-column">${activePfpHtml}</div>
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
              ${/waap/i.test(w.name) && addr0 ? `<span class="ski-detail-provider-badge" aria-hidden="true">${waapProviderIcon(addr0)}</span>` : ''}
              ${/waap/i.test(w.name) ? `<div class="ski-detail-key-column ski-detail-key-column--in-wrap">${activePfpHtml}</div>` : ''}
            </div>`;
          })() : ''}
          ${balanceCyclerHtml}
        </div>
        ${activeTextHtml}
      </div>
    </div>
  `;

  // Render other keys (black diamonds) into the slot below the legend
  const otherKeysSlot = document.getElementById('ski-other-keys-slot');
  if (otherKeysSlot) {
    otherKeysSlot.innerHTML = otherKeysHtml ? `<div class="ski-detail-row">${otherKeysHtml}</div>` : '';
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
        const tx = buildSubnameTx(parentDomain, label, targetAddr, subnameType);
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
        renderModal();
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
    return `<span class="ski-list-shape ski-list-shape--diamond${sponsorClass}${deviceClass}"><svg width="23" height="23" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="4"/></svg>${hoverDrop}${dropOverlay}</span>`;
  }
  // WaaP: always black diamond even before first connect
  if (/waap/i.test(w.name)) {
    return `<span class="ski-list-shape ski-list-shape--diamond${sponsorClass}${deviceClass}"><svg width="23" height="23" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="4"/></svg>${hoverDrop}${dropOverlay}</span>`;
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

  const LEGEND_DIAMOND = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_BLUE    = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><rect x="2" y="2" width="43" height="43" rx="6" fill="#4da2ff" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_GREEN   = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg>`;

  const allWallets = getSuiWallets();
  if (!allWallets.length) return '';

  const isGreen = (w: Wallet) => {
    const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
    return w.accounts.length === 0 && stored.length === 0;
  };

  let rowIdx = 0;

  const wrapScroll = (items: string) =>
    `<div class="ski-legend-scroll">${items}</div>`;

  // Build the WaaP "create new" row — always appended at the bottom.
  // Clicking it opens WaaP's UI to create or switch accounts.
  const buildWaapCreateRow = () => {
    const waapWallet = allWallets.find(w => /waap/i.test(w.name));
    if (!waapWallet) return '';
    const iconHtml = waapWallet.icon
      ? `<img class="ski-legend-wallet-icon" src="${esc(waapWallet.icon)}" alt="${esc(waapWallet.name)}">`
      : `<span></span>`;
    const html = `<div class="ski-legend-row ski-legend-row--create-waap" data-legend-idx="${rowIdx}" data-legend-wallet="${esc(waapWallet.name)}" data-legend-create-waap="true" tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${LEGEND_GREEN}</span><span class="ski-legend-row-mid"><span class="ski-legend-name ski-legend-name--create-waap">+ new WaaP key</span></span>${iconHtml}</div>`;
    rowIdx++;
    return html;
  };

  // Without Splash: one row per stored address (with SuiNS + hex), green circle for unused wallets.
  // Sorted: diamond (addr, no SuiNS) → blue square (addr + SuiNS) → green circle (never used).
  // WaaP without address is omitted from regular entries; dedicated WaaP create row handles it.
  if (!splashActive) {
    type Entry = { walletName: string; icon: string; address: string | null; suinsName: string | null; tier: 0 | 1 | 2 };
    const entries: Entry[] = [];
    for (const w of allWallets) {
      const liveAddrs = (w.accounts as unknown as { address: string }[]).map((a) => a.address);
      const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
      const addrs = [...new Set([...liveAddrs, ...stored])];
      if (addrs.length === 0) {
        if (/waap/i.test(w.name)) continue; // handled by dedicated WaaP create row
        entries.push({ walletName: w.name, icon: w.icon || '', address: null, suinsName: null, tier: 2 });
      } else {
        for (const addr of addrs) {
          const suinsName = suinsCache[addr] || (() => { try { return localStorage.getItem(`ski:suins:${addr}`); } catch { return null; } })() || null;
          entries.push({ walletName: w.name, icon: w.icon || '', address: addr, suinsName, tier: suinsName ? 1 : 0 });
        }
      }
    }
    entries.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aW = /waap/i.test(a.walletName) ? 0 : 1;
      const bW = /waap/i.test(b.walletName) ? 0 : 1;
      if (aW !== bW) return aW - bW;
      return a.walletName.localeCompare(b.walletName);
    });
    const buildEntryRow = (e: Entry) => {
      const shapeHtml = e.tier === 0 ? LEGEND_DIAMOND : e.tier === 1 ? LEGEND_BLUE : LEGEND_GREEN;
      const social = socialIconSvg(e.walletName);
      const nameHtml = e.suinsName
        ? (() => { const bare = e.suinsName.replace(/\.sui$/, ''); return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-legend-name">${esc(bare)}</a>`; })()
        : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
      const addrCell = e.address
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
      // For green (tier 2): prepend WaaP create row
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
        allHtml += `<div class="ski-legend-group"><div class="ski-legend-group-head">${ARROW}${rowsHtml[0]}</div><div class="ski-legend-group-body"><div class="ski-legend-group-inner">${rowsHtml.slice(1).join('')}</div></div></div>`;
      }
    }
    return `<div class="ski-splash-legend">
    <div class="ski-legend-targets">${wrapScroll(allHtml)}</div>
  </div>`;
  }

  // Splash active — green-circle rows appended at bottom of legend (unconnected wallets only)
  const greenWallets = allWallets.filter(w => isGreen(w) && !/waap/i.test(w.name)).sort((a, b) => a.name.localeCompare(b.name));
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
    const shapeHtml = tier === 2 ? LEGEND_GREEN : tier === 1 ? LEGEND_BLUE : LEGEND_DIAMOND;
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
      sponsoredHtml += `<div class="ski-legend-group"><div class="ski-legend-group-head">${ARROW_S}${rowsHtml[0]}</div><div class="ski-legend-group-body"><div class="ski-legend-group-inner">${rowsHtml.slice(1).join('')}</div></div></div>`;
    }
  }

  const targetsHtml = annotated.length === 0 && greenWallets.length === 0
    ? `<span class="ski-legend-target ski-legend-target--open">all keys</span>`
    : wrapScroll(sponsoredHtml + buildWaapCreateRow() + walletRows);

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
  if (fromHover && detailLocked) {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
    rows.forEach((r) => { r.classList.remove('active'); r.setAttribute('aria-selected', 'false'); });
    rows[idx]?.classList.add('active');
    rows[idx]?.setAttribute('aria-selected', 'true');
    activeLegendIdx = idx;
    return;
  }
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
  rows.forEach((r) => { r.classList.remove('active'); r.setAttribute('aria-selected', 'false'); });
  const row = rows[idx];
  if (!row) return;
  row.classList.add('active');
  row.setAttribute('aria-selected', 'true');
  activeLegendIdx = idx;
  const walletName = row.dataset.legendWallet;
  const detailEl = document.getElementById('ski-modal-detail');

  // The hovered legend address (if any) is passed as connectedAddr so it floats to top
  const hoverAddr = row.dataset.legendAddr || getState().address;

  if (detailEl) detailEl.classList.remove('ski-detail--key-hover');
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

  const wallets = getSuiWallets().sort((a, b) => {
    const aW = /waap/i.test(a.name) ? 0 : 1;
    const bW = /waap/i.test(b.name) ? 0 : 1;
    if (aW !== bW) return aW - bW;
    return a.name.localeCompare(b.name);
  });

  if (!wallets.length) {
    els.modal.innerHTML = `
      <div class="ski-modal-overlay open" id="ski-modal-overlay">
        <div class="ski-modal" style="animation:ski-modal-in .2s ease">
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
      headerSplashHtml = `<div class="ski-header-splash ski-header-splash--on">
          <button class="ski-header-splash-drop-btn" id="ski-header-splash-off" type="button" aria-label="Revoke Splash">
            <img src="${SUI_DROP_URI}" class="ski-header-splash-drop" aria-hidden="true">
          </button>
          <span class="ski-header-splash-days">${daysLeft}d</span>
        </div>`;
    } else if (!isSponsorActive()) {
      headerSplashHtml = `<div class="ski-header-splash">
          <button class="ski-header-splash-drop-btn" id="ski-header-splash-on" type="button" aria-label="Enable Splash">
            <img src="${SUI_DROP_URI}" class="ski-header-splash-drop" aria-hidden="true">
          </button>
        </div>`;
    }
  }

  els.modal.innerHTML = `
    <div class="ski-modal-overlay open" id="ski-modal-overlay">
      <div class="ski-modal" style="animation:ski-modal-in .2s ease">
        <button id="ski-modal-close">&times;</button>
        <div class="ski-modal-header">
          <div class="ski-modal-header-brand">
            <div class="ski-modal-header-brand-top">
              <div class="ski-modal-header-left">
                <div class="ski-brand-logo-row">
                  <div class="ski-logo-btn-wrap">
                    ${isWaapHeader ? `<div class="ski-header-waap-icon-wrap"><img src="${esc(ws.walletIcon)}" alt="" class="ski-header-waap-icon"><span class="ski-detail-provider-badge" aria-hidden="true">${waapProviderIcon(ws.address)}</span></div>` : ''}
                    ${headerSplashHtml}
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
                  <p class="ski-modal-tagline">once,<br>everywhere</p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ski-modal-body">
          <div class="ski-modal-col ski-modal-detail" id="ski-modal-detail"></div>
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

  // Populate the detail pane immediately — no placeholder flash
  const connectedWallet = connectedName ? getSuiWallets().find((w) => w.name === connectedName) : null;
  const initialDetailEl = document.getElementById('ski-modal-detail');
  if (initialDetailEl && connectedWallet) showKeyDetail(connectedWallet, initialDetailEl, getState().address);

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
    // Activate the legend row for the connected wallet (or first row) and show detail immediately
    requestAnimationFrame(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
      if (!rows.length) return;
      let targetIdx = 0;
      if (connectedName) {
        const found = rows.findIndex((r) => r.dataset.legendWallet === connectedName);
        if (found >= 0) targetIdx = found;
      }
      activateLegendRow(targetIdx);
      // Populate right pane immediately — no "Hover a key" on open
      const detailEl = document.getElementById('ski-modal-detail');
      if (detailEl) {
        const targetRow = rows[targetIdx];
        const wName = targetRow?.dataset.legendWallet;
        const w = wName ? getSuiWallets().find((w) => w.name === wName) : null;
        if (w && wName !== connectedName) showKeyDetail(w, detailEl, getState().address);
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
  modalOpen = true;
  els.widget?.classList.add('ski-modal-active');
  renderModal();
  if (getState().address) refreshPortfolio(true);
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
  detailLocked = false;
  lockedWallet = null;
  headerCyclerUnmount?.();
  headerCyclerUnmount = null;
  els.widget?.classList.remove('ski-modal-active');
  if (els.modal) els.modal.innerHTML = '';
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
  try {
    const [{ getDeviceId }, { getWaapProof, restoreWaapOAuth }] = await Promise.all([
      import('./fingerprint.js'),
      import('./waap-proof.js'),
    ]);
    const { visitorId } = await getDeviceId();
    const proof = await getWaapProof(visitorId);

    if (proof) {
      type RawAccount = { address: string; chains: readonly string[]; label?: string };

      // Path 1: WaaP already has the account (session is dormant/alive in-memory).
      const cached = (wallet.accounts as unknown as RawAccount[]).find(
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
        showToast('Failed to connect: ' + (err instanceof Error ? err.message : 'unknown error'));
      }
      return;
    }
  } catch { /* fingerprint or import failure — fall through */ }

  // No valid proof for this device — normal flow (WaaP OAuth modal will open).
  selectWallet(wallet);
}

async function selectWallet(wallet: Wallet) {
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
    await connect(wallet);
  } catch (err) {
    showToast('Failed to connect: ' + (err instanceof Error ? err.message : 'unknown error'));
  }
}

// ─── Portfolio (gRPC balance fetch + GraphQL SuiNS) ──────────────────

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const USDC_TYPE   = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const NS_TYPE     = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';

function normalizeSuiAddress(addr: string): string {
  let hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  hex = hex.padStart(64, '0');
  return '0x' + hex;
}

async function lookupSuiNS(address: string): Promise<string | null> {
  try {
    const normalized = normalizeSuiAddress(address);
    const res = await fetch(GRAPHQL_URL, {
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
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { sui?: { usd?: number } }) => valid(d.sui?.usd)),
  ];

  try {
    return persist(await Promise.any(sources));
  } catch { /* all failed — use stale cache */ }

  return suiPriceCache?.price ?? null;
}

export async function refreshPortfolio(force = false) {
  const ws = getState();
  if (!ws.address) return;
  const now = Date.now();
  if (!force && portfolioInFlight) return;
  if (!force && now - lastPortfolioMs < 25_000) return;
  portfolioInFlight = true;
  lastPortfolioMs = now;
  const fetchedFor = ws.address; // capture before any await

  try {
    // gRPC for balances + SUI price in parallel
    const [suiResult, usdcResult, nsResult, suinsName, suiPrice] = await Promise.all([
      grpcClient.core.getBalance({ owner: fetchedFor }).catch(() => null),
      grpcClient.core.getBalance({ owner: fetchedFor, coinType: USDC_TYPE }).catch(() => null),
      grpcClient.core.getBalance({ owner: fetchedFor, coinType: NS_TYPE }).catch(() => null),
      lookupSuiNS(fetchedFor),
      fetchSuiPrice(),
    ]);

    // Wallet switched while fetch was in-flight — discard stale result
    if (getState().address !== fetchedFor) return;

    const suiMist = Number(suiResult?.balance?.balance ?? 0);
    app.sui = Number.isFinite(suiMist) ? suiMist / 1e9 : 0;

    const usdcRaw = Number(usdcResult?.balance?.balance ?? 0);
    app.stableUsd = Number.isFinite(usdcRaw) ? usdcRaw / 1e6 : 0;
    appBalanceFetched = true;

    // NS balance stored in raw smallest units (9 decimals)
    const nsRaw = Number(nsResult?.balance?.balance ?? 0);
    app.nsBalance = Number.isFinite(nsRaw) ? nsRaw / 1e9 : 0;

    // Total USD = SUI value + USDC balance
    const suiUsd = suiPrice != null ? app.sui * suiPrice : null;
    app.usd = suiUsd != null ? suiUsd + app.stableUsd : (app.stableUsd > 0 ? app.stableUsd : null);

    if (suinsName) {
      app.suinsName = suinsName;
      try { localStorage.setItem(`ski:suins:${fetchedFor}`, suinsName); } catch {}
    }

    // Cache balances for instant display on next page load
    try {
      localStorage.setItem(`ski:balances:${fetchedFor}`, JSON.stringify({
        sui: app.sui,
        stableUsd: app.stableUsd,
        nsBalance: app.nsBalance,
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
  const addr = getState().address;
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

function renderWidget() {
  if (!els.profile) return;
  const ws = getState();

  // Disconnected: hide profile — SKI button handles connect
  if (!ws.address) {
    els.profile.innerHTML = '';
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

  // Ika cross-chain badge
  const ikaHtml = app.ikaWalletId
    ? '<span class="wk-widget-ika-badge" title="Ika dWallet active">ika</span>'
    : '';

  els.profile.innerHTML = `
    <div class="wk-widget">
      <button class="wk-widget-btn connected" id="wallet-pill-btn" type="button" title="Open profile">
        ${iconHtml}
        <span class="wk-widget-label-wrap">
          <span class="${labelClass}">
            <span class="wk-widget-primary-name">${esc(label)}</span>
          </span>
        </span>
        ${ikaHtml}
      </button>
    </div>`;
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
  const showDrop = app.splashSponsor || hasValidSkiSession(ws.address);

  if (hasPrimary) {
    const dotSvg = balView === 'usd'
      ? `<svg class="ski-btn-price-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg>`
      : `<svg class="ski-btn-price-icon" viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38" rx="6" fill="#4da2ff" stroke="white" stroke-width="2"/><g transform="translate(10,7) scale(0.067)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g></svg>`;
    const rawUsd = fmtUsd(app.usd);
    const balLabel = balView === 'usd'
      ? `<span class="ski-btn-price-label ski-btn-price-label--usd">${esc(rawUsd ? rawUsd.replace(/^\$/, '') : '--')}</span>`
      : `<span class="ski-btn-price-label">${esc(fmtSui(app.sui))}</span><img src="${SUI_DROP_URI}" class="ski-btn-inline-drop" alt="" aria-hidden="true">`;
    el.innerHTML = `<span class="ski-btn-dot" title="Switch currency" aria-label="Switch USD/SUI">${dotSvg}</span>${balLabel}`;
    return;
  }

  const drop = showDrop
    ? `<img src="${SUI_DROP_URI}" class="ski-btn-session-drop" alt="" aria-hidden="true">`
    : '';
  el.innerHTML = getSkiBtnSvg('black-diamond') + drop;
}

function _renderDotBtn() {
  const btn = els.skiDot;
  if (!btn) return;
  const ws = getState();
  if (!ws.address) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const variant: SkiDotVariant = app.suinsName ? 'blue-square' : 'black-diamond';
  btn.innerHTML = _shapeOnlySvg(variant, 31);
}

function _renderDotBtnEl(el: HTMLElement) {
  const ws = getState();
  if (!ws.address) { el.style.display = 'none'; return; }
  el.style.display = '';
  const variant: SkiDotVariant = app.suinsName ? 'blue-square' : 'black-diamond';
  el.innerHTML = _shapeOnlySvg(variant, 31);
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
    // Connected: only toggle SKI menu
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:menu-open', '0'); } catch {} render(); return; }
    app.skiMenuOpen = true;
    try { localStorage.setItem('ski:menu-open', '1'); } catch {}
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
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:menu-open', '0'); } catch {} render(); }
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
let nsLabel = (() => { try { return localStorage.getItem('ski:ns-label') || 'splash'; } catch { return 'splash'; } })();
let nsPriceUsd: number | null = null;
let nsPriceFetchFor = '';
let nsPriceDebounce: ReturnType<typeof setTimeout> | null = null;
let nsAvail: null | 'available' | 'taken' | 'owned' | 'grace' = null;
let nsGraceEndMs = 0;
let nsTargetAddress: string | null = null; // resolved address for the current label (if registered)
let nsLastDigest = ''; // digest from last successful registration; shown in route area
let nsSubnameParent: OwnedDomain | null = null; // when set, we're in subname-creation mode
let nsShowTargetInput = false; // target-address inline editor open
let nsNewTargetAddr = ''; // value in the target-address input
let nsOwnedDomains: OwnedDomain[] = []; // all SuiNS objects owned by the wallet
let nsOwnedFetchedFor = ''; // wallet address we last fetched for (cache key)
let nsRealOwnerAddr = ''; // discovered on-chain owner address (WaaP wallets differ from wallet address)

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
  if (nsRealOwnerAddr) return;
  if (!result.nftOwner || !result.targetAddress) return;
  const walletAddr = getState().address;
  if (!walletAddr) return;
  if (result.targetAddress.toLowerCase() !== walletAddr.toLowerCase()) return;
  nsRealOwnerAddr = result.nftOwner;
  nsOwnedFetchedFor = '';
  _fetchOwnedDomains();
  if (nsAvail === 'taken') nsAvail = 'owned';
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
  nsAvail = null;
  _patchNsStatus();

  if (label.length >= 5) {
    if (ns5CharPriceUsd != null) {
      // Already loaded — show instantly, only fetch availability
      nsPriceUsd = ns5CharPriceUsd;
      _patchNsPrice();
      const ws = getState();
      const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
      const result = await checkDomainStatus(label, ws.address || undefined, _extra);
      if (nsPriceFetchFor !== label) return;
      nsAvail = result.avail;
      nsGraceEndMs = result.graceEndMs ?? 0;
      nsTargetAddress = result.targetAddress;
      _maybeDiscoverRealOwner(result);
      _patchNsPrice();
      _patchNsStatus();
      return;
    }
    // First 5+ char lookup — fetch price once, then cache it
    const ws = getState();
    const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
    const [priceResult, statusResult] = await Promise.allSettled([
      fetchDomainPriceUsd(label),
      checkDomainStatus(label, ws.address || undefined, _extra),
    ]);
    if (nsPriceFetchFor !== label) return;
    if (priceResult.status === 'fulfilled') {
      ns5CharPriceUsd = priceResult.value;
      try { localStorage.setItem('ski:ns5-price', String(ns5CharPriceUsd)); } catch {}
    }
    nsPriceUsd = priceResult.status === 'fulfilled' ? priceResult.value : null;
    const sr5 = statusResult.status === 'fulfilled' ? statusResult.value : null;
    nsAvail = sr5?.avail ?? null;
    nsGraceEndMs = sr5?.graceEndMs ?? 0;
    nsTargetAddress = sr5?.targetAddress ?? null;
    if (sr5) _maybeDiscoverRealOwner(sr5);
    _patchNsPrice();
    _patchNsStatus();
    return;
  }

  // 3–4 char names have variable pricing — fetch both in parallel
  const ws = getState();
  const _extra = nsRealOwnerAddr ? [nsRealOwnerAddr] : undefined;
  const [priceResult, statusResult] = await Promise.allSettled([
    fetchDomainPriceUsd(label),
    checkDomainStatus(label, ws.address || undefined, _extra),
  ]);
  if (nsPriceFetchFor !== label) return;
  nsPriceUsd = priceResult.status === 'fulfilled' ? priceResult.value : null;
  const sr = statusResult.status === 'fulfilled' ? statusResult.value : null;
  nsAvail = sr?.avail ?? null;
  nsGraceEndMs = sr?.graceEndMs ?? 0;
  nsTargetAddress = sr?.targetAddress ?? null;
  if (sr) _maybeDiscoverRealOwner(sr);
  _patchNsPrice();
  _patchNsStatus();
}

function _patchNsPrice() {
  const chip = document.getElementById('wk-ns-price-chip');
  if (chip) chip.innerHTML = _nsPriceHtml();
  _patchNsRoute();
}

function _nsRouteHtml(): string {
  // Target-address inline editor
  if (nsShowTargetInput) {
    return `<span class="wk-ns-route wk-ns-route--target-edit"><input id="wk-ns-target-input" class="wk-ns-target-input" type="text" value="${esc(nsNewTargetAddr)}" placeholder="0x…" spellcheck="false" autocomplete="off"><button id="wk-ns-target-submit" class="wk-ns-target-submit" type="button" title="Set target address">\u2192</button><button id="wk-ns-target-cancel" class="wk-ns-unpin-btn" type="button" title="Cancel">\u2715</button></span>`;
  }

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
  const isOwnerAddr = nsTargetAddress
    ? nsTargetAddress.toLowerCase() === walletAddr
    : false;

  // Resolve the display address: use target if known, user's own for available names, or placeholder
  let displayAddr = nsTargetAddress;
  if (!displayAddr && nsAvail === 'available' && walletAddrRaw) displayAddr = walletAddrRaw;

  // Always show the row — dim placeholder while resolving
  if (!displayAddr) {
    if (!nsLabel || nsLabel.length < 3) return '';
    return `<div class="wk-ns-target-row wk-ns-target-row--loading"><span class="wk-ns-target-icon">\u25ce</span><span class="wk-ns-target-addr">resolving\u2026</span></div>`;
  }

  const shortAddr = `${displayAddr.slice(0, 7)}\u2026${displayAddr.slice(-5)}`;

  // Check if current name is listed in a kiosk (Tradeport)
  const bareLabel = nsLabel.toLowerCase();
  const isKioskName = nsOwnedDomains.some(d => d.inKiosk && d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel);

  // Color by color name — purple = self-target (address points to your wallet)
  let colorClass = 'wk-ns-target-row--blue'; // default: blue (taken by someone else)
  if (isKioskName) colorClass = 'wk-ns-target-row--orange';
  else if (nsAvail === 'grace') colorClass = 'wk-ns-target-row--red';
  else if (isOwnerAddr) colorClass = 'wk-ns-target-row--purple';
  else if (nsAvail === 'available') colorClass = 'wk-ns-target-row--green';

  // Self-target (purple) rows are clickable to edit target address
  const clickId = isOwnerAddr ? ' id="wk-ns-target-btn"' : '';
  const clickTitle = isOwnerAddr ? ' title="Change target address"' : ` title="${displayAddr}"`;

  let extra = '';
  if (nsAvail === 'grace') extra = `<span class="wk-ns-target-grace">${_graceEndDate()}</span>`;
  if (!nsPriceUsd || !appBalanceFetched) { /* no balance concern */ }
  else {
    const usdcOk = app.stableUsd >= nsPriceUsd * 1.05;
    const suiUsdPrice = suiPriceCache?.price ?? 0;
    if (!usdcOk && (suiUsdPrice === 0 || app.sui * suiUsdPrice < nsPriceUsd * 1.2)) {
      extra = `<span class="wk-ns-route-warn" style="margin-left:auto">low balance</span>`;
    }
  }

  return `<div class="wk-ns-target-row ${colorClass}"${clickId}${clickTitle}><span class="wk-ns-target-icon">\u25ce</span><span class="wk-ns-target-addr">${shortAddr}</span>${extra}</div>`;
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
  const totalAll = totalOwned + wishItems.length;
  if (totalAll === 0) return '';

  const now = Date.now();

  // Build chip HTML for each owned domain with shape SVG
  const chips: string[] = sorted.map(d => {
    const bare = d.name.replace(/\.sui$/, '');
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
    return `<button class="wk-ns-owned-chip${kioskCls}" data-domain="${esc(bare)}" type="button" title="${esc(d.name)}">${shapeSvg}${esc(bare)}${badge}${expiryHtml}</button>`;
  });

  // Wishlist chips (black-diamond)
  for (const w of wishItems) {
    const wishSvg = _shapeOnlySvg('black-diamond', 12);
    chips.push(`<button class="wk-ns-owned-chip wk-ns-owned-chip--wish" data-domain="${esc(w)}" data-wish="1" type="button" title="${esc(w)}.sui">${wishSvg}${esc(w)}<span class="wk-ns-wish-rm" data-wish-rm="${esc(w)}" title="Remove">\u2715</span></button>`);
  }

  // Estimate yearly renewal cost (SuiNS base pricing: 3ch=$500, 4ch=$100, 5+ch=$20)
  let yearlyUsd = 0;
  for (const d of sorted) {
    if (d.kind === 'cap') continue; // subname caps have no renewal
    const bare = d.name.replace(/\.sui$/, '');
    const len = bare.length;
    yearlyUsd += len === 3 ? 500 : len === 4 ? 100 : 20;
  }
  const savingsUsd = Math.round(yearlyUsd * 0.25);

  // Count header with renewal + savings pills
  const countLabel = totalOwned === 1 ? '1 name' : `${totalOwned} names`;
  let renewalHtml = '';
  if (yearlyUsd > 0) {
    renewalHtml = `<span class="wk-ns-owned-renewal">$${yearlyUsd}/yr</span><span class="wk-ns-owned-savings">-$${savingsUsd}/yr</span>`;
  }
  const header = `<div class="wk-ns-owned-header">${_shapeOnlySvg('blue-square', 10)}<span class="wk-ns-owned-count">${countLabel}</span>${renewalHtml}</div>`;

  return `${header}<div class="wk-ns-owned-grid">${chips.join('')}</div>`;
}

function _patchNsOwnedList() {
  const el = document.getElementById('wk-ns-owned-list');
  if (!el) return;
  el.innerHTML = _nsOwnedListHtml();
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
}

function _patchNsRoute() {
  const el = document.getElementById('wk-ns-route');
  if (!el) return;
  const html = _nsRouteHtml();
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
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
  // black-diamond: white diamond outline using evenodd fill-rule so the center is transparent
  // (avoids background-color dependency that broke on mobile/dark-mode environments)
  const outerPad = pad;
  const innerPad = pad + sw * 1.1;
  const outerPath = `M${half},${outerPad} L${s - outerPad},${half} L${half},${s - outerPad} L${outerPad},${half}Z`;
  const innerPath = `M${half},${innerPad} L${s - innerPad},${half} L${half},${s - innerPad} L${innerPad},${half}Z`;
  return `<svg ${base}><path d="${outerPath} ${innerPath}" fill="white" fill-rule="evenodd"/></svg>`;
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
  if (nsAvail === 'available') return 'green-circle';
  if (nsAvail === 'grace') return 'red-hexagon';
  if (nsAvail === 'taken' || nsAvail === 'owned') return 'blue-square';
  // Pending check — show green optimistically for valid names > 3 chars
  if (nsLabel.length > 3 && isValidNsLabel(nsLabel)) return 'green-circle';
  return 'black-diamond';
}

function _patchNsStatus() {
  const icon = document.getElementById('wk-ns-status');
  if (!icon) return;
  const variant = _nsVariant();
  icon.innerHTML = _nsStatusSvg(variant);
  const sec = document.getElementById('wk-dd-ns-section');
  // --available: confirmed available OR pending but likely available (valid > 3 chars)
  const looksAvailable = nsAvail === 'available' || (nsAvail === null && variant === 'green-circle');
  const walletAddrLower = getState().address?.toLowerCase() ?? '';
  const isSelfTarget = !!nsTargetAddress && nsTargetAddress.toLowerCase() === walletAddrLower;
  sec?.classList.toggle('wk-dd-ns-section--available',    looksAvailable);
  sec?.classList.toggle('wk-dd-ns-section--owned',        nsAvail === 'owned');
  sec?.classList.toggle('wk-dd-ns-section--taken',        nsAvail === 'taken');
  sec?.classList.toggle('wk-dd-ns-section--grace',        nsAvail === 'grace');
  sec?.classList.toggle('wk-dd-ns-section--self-target',  isSelfTarget);
  const isOwned = nsAvail === 'owned';
  icon.style.cursor = (isSelfTarget || isOwned) ? 'pointer' : 'default';
  icon.title = isSelfTarget ? `Set ${nsLabel.trim()}.sui as primary name` : isOwned ? `Manage ${nsLabel.trim()}.sui` : '';
  const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
  if (btn) {
    const isPurple = isOwned || isSelfTarget;
    const disabled = variant === 'black-diamond' || variant === 'red-hexagon' || (isPurple && !nsSubnameParent);
    btn.disabled = disabled;
    if (variant === 'black-diamond') btn.title = 'Invalid SuiNS name';
    else if (variant === 'red-hexagon') btn.title = `Grace period ends ${_graceEndDate()}`;
    else if (isPurple && !nsSubnameParent) btn.title = 'Already registered';
  }
  _patchNsRoute();
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

/** Format grace end in EST, e.g. "Mar 15, 3:42 PM EST". */
function _graceEndDate(): string {
  if (!nsGraceEndMs) return '';
  const tz = 'America/New_York';
  const d = new Date(nsGraceEndMs);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return `${date} ${time} EST`;
}

function _nsPriceHtml(): string {
  if (nsLabel.length < 3) return '';
  const variant = _nsVariant();
  if (variant === 'black-diamond') return ''; // invalid label — no spinner
  if (nsAvail === 'grace') return `<span class="wk-ns-price-val wk-ns-grace-pill">${_graceCountdown()}</span>`;
  // Don't show price for owned or self-target names — they can't be re-registered
  if (nsAvail === 'owned') return '';
  const _walletAddr = getState().address?.toLowerCase() ?? '';
  if (nsTargetAddress && nsTargetAddress.toLowerCase() === _walletAddr) return '';
  if (nsPriceUsd == null) return `<span class="wk-ns-price-loading"></span>`;
  if (balView === 'sui' && suiPriceCache) {
    const sui = nsPriceUsd / suiPriceCache.price;
    return `<span class="wk-ns-price-val">${fmtSui(sui)}<img src="${SUI_DROP_URI}" class="wk-ns-price-drop" alt="SUI" aria-hidden="true"></span>`;
  }
  return `<span class="wk-ns-price-val">$${nsPriceUsd % 1 === 0 ? nsPriceUsd.toFixed(0) : nsPriceUsd.toFixed(2)}</span>`;
}

// ─── Sign Message ───────────────────────────────────────────────────

const DEFAULT_MESSAGE = 'Hiroshima was an elegant implementation';
let signMessageText = DEFAULT_MESSAGE;
let lastSignResult: { signature: string; bytes: string } | null = null;

function renderSignStage() {
  if (!els.signStage) return;
  const ws = getState();

  if (!ws.address) {
    els.signStage.style.display = 'none';
    els.signStage.innerHTML = '';
    lastSignResult = null;
    return;
  }

  els.signStage.style.display = '';

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
    renderModal();
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

function menuLockin() {
  app.skiMenuOpen = false;
  try { localStorage.setItem('ski:menu-open', '0'); } catch {}
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
    els.skiMenu.innerHTML = '';
    return;
  }

  const scanUrl = `https://suiscan.xyz/mainnet/account/${ws.address}`;

  const addrShort = truncAddr(ws.address);

  const dotSvg = balView === 'usd'
    ? `<svg class="wk-popout-bal-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg>`
    : `<img src="${SUI_DROP_URI}" class="wk-popout-bal-icon" alt="SUI" aria-hidden="true">`;
  const balValHtml = balView === 'usd'
    ? `<span class="wk-popout-bal-val wk-popout-bal-val--usd">${fmtMenuBalHtml(app.usd)}</span>`
    : `<span class="wk-popout-bal-val wk-popout-bal-val--sui">${fmtMenuBalHtml(app.sui)}</span>`;
  const balToggleHtml = `<div class="wk-popout-balance">
        <span class="wk-popout-bal-display">${dotSvg}${balValHtml}</span>
        <label class="ski-layout-toggle wk-popout-bal-toggle" title="Toggle USD / SUI">
          <input type="checkbox" id="wk-bal-toggle"${balView === 'usd' ? ' checked' : ''}>
          <span class="ski-layout-track"><span class="ski-layout-thumb"></span></span>
        </label>
      </div>`;

  const _nsInitVariant = _nsVariant();
  const _nsInitLooksAvailable = nsAvail === 'available' || (nsAvail === null && _nsInitVariant === 'green-circle');
  const _nsInitWalletAddr = getState().address?.toLowerCase() ?? '';
  const _nsInitSelfTarget = !!nsTargetAddress && nsTargetAddress.toLowerCase() === _nsInitWalletAddr;
  const _nsInitSectionClass = (nsAvail === 'grace' ? ' wk-dd-ns-section--grace'
    : nsAvail === 'taken' ? ' wk-dd-ns-section--taken'
    : nsAvail === 'owned' ? ' wk-dd-ns-section--owned'
    : _nsInitLooksAvailable ? ' wk-dd-ns-section--available'
    : '') + (_nsInitSelfTarget ? ' wk-dd-ns-section--self-target' : '');
  const _subnameMode = !!nsSubnameParent;
  const _parentBare = nsSubnameParent ? nsSubnameParent.name.replace(/\.sui$/, '') : '';
  const _dotSuiText = _subnameMode ? `.${_parentBare}.sui` : '.sui';
  const _inputPlaceholder = _subnameMode ? 'subname' : 'name';
  const _registerTitle = _subnameMode
    ? (nsLabel ? `Create ${esc(nsLabel)}.${_parentBare}.sui` : 'Create subname')
    : (_nsInitVariant === 'black-diamond' && nsLabel ? 'Invalid SuiNS name' : _nsInitVariant === 'red-hexagon' ? `Grace period ends ${_graceEndDate()}` : nsLabel ? `Mint ${esc(nsLabel)}.sui` : 'Mint .sui');
  const _registerDisabled = _subnameMode ? false : (_nsInitVariant === 'black-diamond' || _nsInitVariant === 'red-hexagon');
  const _inputHtml = _subnameMode
    ? `<input id="wk-ns-label-input" class="wk-ns-label-input" type="text" value="${esc(nsLabel)}" maxlength="63" spellcheck="false" autocomplete="off" placeholder="${_inputPlaceholder}">`
    : `<div class="wk-ns-input-wrap"><input id="wk-ns-label-input" class="wk-ns-label-input" type="text" value="${esc(nsLabel)}" maxlength="63" spellcheck="false" autocomplete="off" placeholder="${_inputPlaceholder}"><button id="wk-ns-pin-btn" class="wk-ns-pin-btn" type="button" title="Create subname">\u25b8</button></div>`;
  const _nsRouteInitHtml = _nsRouteHtml();
  const nsRowHtml = `
      <div id="wk-dd-ns-section" class="wk-dd-ns-section${_nsInitSectionClass}${_subnameMode ? ' wk-dd-ns-section--subname' : ''}">
        <div id="wk-ns-route" class="wk-ns-route-wrap" style="${_nsRouteInitHtml ? '' : 'display:none'}">${_nsRouteInitHtml}</div>
        <div class="wk-dd-ns-domain-row">
          <span id="wk-ns-status" class="wk-ns-status">${_nsStatusSvg(_subnameMode ? 'blue-square' : _nsInitVariant)}</span>
          ${_inputHtml}
          <span class="wk-ns-dot-sui">${esc(_dotSuiText)}</span>
          <span id="wk-ns-price-chip" class="wk-ns-price-chip">${_subnameMode ? '' : _nsPriceHtml()}</span>
          <button id="wk-dd-ns-register" class="wk-dd-ns-register-btn" type="button"${_registerDisabled ? ' disabled' : ''} title="${_registerTitle}">\u2192</button>
        </div>
        <div id="wk-ns-owned-list" class="wk-ns-owned-list">${_nsOwnedListHtml()}</div>
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

  els.skiMenu.innerHTML = `
      <div class="wk-dropdown wk-dropdown--large open">
        <div class="wk-popout-actions">
          <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Deactivate</button>
          <button class="wk-dd-item wk-dd-ski" id="wk-dd-switch">Lockin</button>
        </div>
        ${nameBadgeHtml}
        ${balToggleHtml}
        <div class="wk-dd-address-row">
          <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="Copy address">
            <span class="wk-dd-address-text">${esc(app.copied ? 'Copied! \u2713' : addrShort)}</span>
          </button>
          <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="View on Suiscan">\u2197</a>
        </div>
        ${nsRowHtml}
      </div>`;

  document.getElementById('wk-dd-copy')?.addEventListener('click', menuCopyAddress);
  document.getElementById('wk-dd-switch')?.addEventListener('click', menuLockin);
  document.getElementById('wk-dd-disconnect')?.addEventListener('click', menuDisconnect);
  document.getElementById('wk-bal-toggle')?.addEventListener('change', menuToggleBalance);

  // ─── NS domain row bindings ─────────────────────────────────────────
  const nsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
  nsInput?.addEventListener('click', (e) => e.stopPropagation());
  nsInput?.addEventListener('focus', (e) => {
    e.stopPropagation();
    if (skipNextFocusClear) { skipNextFocusClear = false; return; }
    if (nsSubnameParent) return; // In subname mode, don't clear on focus
    const input = e.target as HTMLInputElement;
    input.value = '';
    nsLabel = '';
    nsPriceUsd = null;
    nsAvail = null;
    nsGraceEndMs = 0;
    nsTargetAddress = null;
    nsLastDigest = '';
    nsPriceFetchFor = '';
    if (nsPriceDebounce) clearTimeout(nsPriceDebounce);
    _patchNsPrice();
    _patchNsStatus();
  });
  nsInput?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-dd-ns-register')?.click();
    }
  });
  nsInput?.addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value.trim().toLowerCase();
    nsLabel = val;
    if (nsSubnameParent) {
      // Subname mode — no price fetch, just update register button title
      const parentBare = nsSubnameParent.name.replace(/\.sui$/, '');
      const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
      if (btn) btn.title = val ? `Create ${val}.${parentBare}.sui` : 'Create subname';
      return;
    }
    const validLabel = isValidNsLabel(val);
    try { if (validLabel) localStorage.setItem('ski:ns-label', val); } catch {}
    // For 5+ char names use cached price instantly — no spinner needed
    nsPriceUsd = (validLabel && val.length >= 5 && ns5CharPriceUsd != null) ? ns5CharPriceUsd : null;
    nsAvail = null;
    nsGraceEndMs = 0;
    nsTargetAddress = null;
    nsLastDigest = '';
    _patchNsPrice();
    _patchNsStatus();
    const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
    if (btn) btn.title = !validLabel && val ? 'Invalid SuiNS name' : val ? `Mint ${val}.sui` : 'Mint .sui';
    if (nsPriceDebounce) clearTimeout(nsPriceDebounce);
    if (validLabel) nsPriceDebounce = setTimeout(() => fetchAndShowNsPrice(val), 400);
  });

  document.getElementById('wk-ns-route')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (target.id === 'wk-ns-digest-link') {
      return;
    }
    // Target row — click to open inline address editor
    if (target.closest('#wk-ns-target-btn')) {
      nsShowTargetInput = true;
      nsNewTargetAddr = '';
      _patchNsRoute();
      setTimeout(() => document.getElementById('wk-ns-target-input')?.focus(), 30);
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
    const addr = nsNewTargetAddr.trim();
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) { showToast('Enter a valid Sui address (0x\u2026)'); return; }
    const label = nsLabel.trim();
    if (!label) return;
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    const submitBtn = document.getElementById('wk-ns-target-submit') as HTMLButtonElement | null;
    _targetSubmitBusy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u2026'; }
    try {
      const txBytes = await buildSetTargetAddressTx(ws2.address, domain, addr, nsRealOwnerAddr || undefined);
      let b64 = '';
      for (let i = 0; i < txBytes.length; i++) b64 += String.fromCharCode(txBytes[i]);
      b64 = btoa(b64);
      await signAndExecuteTransaction(b64);
      nsTargetAddress = addr;
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
      _patchNsStatus();
      showToast(`Target set to ${addr.slice(0, 6)}\u2026${addr.slice(-4)} \u2713`);
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

    // Green circle (available) → add to wishlist
    if (nsAvail === 'available' && label) {
      _addToWishlist(label);
      _patchNsOwnedList();
      showToast(`${label}.sui added to watchlist`);
      return;
    }

    // Allow click when owned OR when target matches wallet (self-target)
    const isSelfTarget = !!nsTargetAddress && nsTargetAddress.toLowerCase() === ws2.address.toLowerCase();
    if (!isSelfTarget && nsAvail !== 'owned') return;
    if (!label) return;
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    const icon = document.getElementById('wk-ns-status');
    if (icon) icon.style.opacity = '0.4';
    try {
      if (icon) icon.style.opacity = '0.1';
      // Try signing — if it fails with "Invalid user signature" (stale WaaP session),
      // force a non-silent reconnect to refresh the OAuth/MPC session and retry once.
      let signed = false;
      for (let attempt = 0; attempt < 2 && !signed; attempt++) {
        try {
          const txBytes = await buildSetDefaultNsTx(ws2.address, domain);
          await signAndExecuteTransaction(txBytes);
          signed = true;
        } catch (signErr) {
          const sm = signErr instanceof Error ? signErr.message : '';
          if (attempt === 0 && sm.toLowerCase().includes('invalid') && sm.toLowerCase().includes('signature')) {
            showToast('Refreshing wallet session\u2026');
            await reconnectWallet();
          } else {
            throw signErr;
          }
        }
      }
      app.suinsName = domain;
      suinsCache[ws2.address] = domain;
      try { localStorage.setItem(`ski:suins:${ws2.address}`, domain); } catch {}
      nsLastDigest = '';
      updateSkiDot('blue-square', domain);
      renderSkiBtn();
      renderSkiMenu();
      updateFavicon('blue-square');
      showToast(`${domain} set as primary \u2713`);
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
      return {
        display: 'Insufficient gas — not enough SUI to pay transaction fees. Add SUI to your wallet and try again.',
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
        const tx = await buildSubnameTxBytes(ws2.address, nsSubnameParent, label, ws2.address, 'leaf');
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

    // ── Normal mode: register domain ──
    const domain = label.endsWith('.sui') ? label : `${label}.sui`;
    if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
    try {
      const tx = await buildRegisterSplashNsTx(ws2.address, domain, suiPriceCache?.price, !app.suinsName);
      if (btn) btn.textContent = '\u270f';
      const { digest } = await signAndExecuteTransaction(tx);
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
      showToast(`${domain} registered \u2713 ${digest ? digest.slice(0, 8) + '\u2026' : ''}`);
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

  // Owned domain list — click to populate input or remove wishlist
  document.getElementById('wk-ns-owned-list')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
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
    const domain = btn.dataset.domain;
    if (!domain) return;
    nsLabel = domain;
    nsAvail = null;
    nsPriceUsd = null;
    nsPriceFetchFor = '';
    nsGraceEndMs = 0;
    nsTargetAddress = null;
    nsLastDigest = '';
    nsSubnameParent = null;
    nsShowTargetInput = false;
    skipNextFocusClear = true;
    const input = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
    if (input) { input.value = domain; input.focus(); }
    _patchNsPrice();
    _patchNsStatus();
    fetchAndShowNsPrice(domain);
  });

  // Horizontal wheel scroll for owned names grid
  const ownedGrid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
  if (ownedGrid) {
    ownedGrid.addEventListener('wheel', (e) => {
      if (ownedGrid.scrollWidth > ownedGrid.clientWidth) {
        e.preventDefault();
        ownedGrid.scrollLeft += e.deltaY || e.deltaX;
      }
    }, { passive: false });
  }

}

// ─── Disconnect handler ──────────────────────────────────────────────

async function handleDisconnect(reopenModal = false) {
  app.skiMenuOpen = false;
  try { localStorage.setItem('ski:menu-open', '0'); } catch {}
  app.copied = false;
  nsOwnedDomains = [];
  nsOwnedFetchedFor = '';
  nsRealOwnerAddr = '';
  nsSubnameParent = null;
  nsShowTargetInput = false;
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
  if (modalOpen) renderModal();

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
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:menu-open', '0'); } catch {} render(); }
    openModal();
  });

  els.skiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();

    if (!getState().address) {
      if (modalOpen) { closeModal(); return; }
      openModal();
      return;
    }
    // Connected: only toggle SKI menu
    if (app.skiMenuOpen) { app.skiMenuOpen = false; try { localStorage.setItem('ski:menu-open', '0'); } catch {} render(); return; }
    app.skiMenuOpen = true;
    try { localStorage.setItem('ski:menu-open', '1'); } catch {}
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
    if ((e as KeyboardEvent).key !== 'Escape') return;
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
    app.skiMenuOpen = false;
    try { localStorage.setItem('ski:menu-open', '0'); } catch {}
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

  // Subscribe to wallet state changes
  subscribe((ws: WalletState) => {
    // Only clear hydrating on terminal states
    if (ws.status === 'connected' || ws.status === 'disconnected') _hydrating = false;
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
      app.skiMenuOpen = false;
      try { localStorage.setItem('ski:menu-open', '0'); } catch {}
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
    if (slot) slot.innerHTML = buildSplashLegend();
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

    // Detail pane keyed header click → sign "Lock in {name/address}"
    const clickedDetailHeader = (e.target as HTMLElement).closest<HTMLElement>('.ski-detail-header--keyed');
    const detailPane = document.getElementById('ski-modal-detail');
    if (clickedDetailHeader && detailPane?.contains(clickedDetailHeader)) {
      void lockInIdentity();
      return;
    }

    // Balance cycler toggle: switch between SUI-primary and USD-primary
    if ((e.target as HTMLElement).closest('#ski-detail-balance-cycler')) {
      balView = balView === 'sui' ? 'usd' : 'sui';
      try { localStorage.setItem('ski:bal-pref', balView); } catch {}
      syncBalanceDisplays();
      return;
    }

    // Group arrow click → toggle collapsible group AND activate the head row
    const arrowBtn = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-group-arrow');
    if (arrowBtn) {
      const group = arrowBtn.closest('.ski-legend-group');
      if (group) group.classList.toggle('ski-legend-group--open');
      // Also activate the head row as the active wallet
      const headRow = arrowBtn.closest('.ski-legend-group-head')?.querySelector<HTMLElement>('.ski-legend-row');
      if (headRow) {
        const idx = parseInt(headRow.dataset.legendIdx || '-1', 10);
        if (idx >= 0) activateLegendRow(idx);
      }
      return;
    }

    // Legend row click → show wallet in detail pane (active card)
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
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ski-legend-row'));
    if (!rows.length) return;
    const ke = e as KeyboardEvent;
    if (ke.key === 'ArrowDown') {
      e.preventDefault();
      const next = (activeLegendIdx + 1) % rows.length;
      activateLegendRow(next);
      rows[next]?.focus();
    } else if (ke.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (activeLegendIdx - 1 + rows.length) % rows.length;
      activateLegendRow(prev);
      rows[prev]?.focus();
    } else if (ke.key === 'Escape') {
      closeModal();
    } else if (ke.key === 'Enter') {
      const row = rows[activeLegendIdx];
      if (row?.dataset.legendWallet) {
        const wallet = getSuiWallets().find((w) => w.name === row.dataset.legendWallet);
        if (wallet) {
          if (/waap/i.test(wallet.name)) void tryWaapProofConnect(wallet);
          else selectWallet(wallet);
        }
      }
    }
  });

  // Re-render when new wallets are installed
  onWalletsChanged(() => {
    if (modalOpen) renderModal();
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
      if (raw) {
        const b = JSON.parse(raw) as { sui?: number; stableUsd?: number; nsBalance?: number; usd?: number | null };
        if (typeof b.sui === 'number') app.sui = b.sui;
        if (typeof b.stableUsd === 'number') app.stableUsd = b.stableUsd;
        if (typeof b.nsBalance === 'number') app.nsBalance = b.nsBalance;
        if (b.usd !== undefined) app.usd = b.usd;
        appBalanceFetched = true;
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
