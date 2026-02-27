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
  signPersonalMessage,
  autoReconnect,
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
import { fetchOwnedDomains, buildSubnameTx, type OwnedDomain } from './suins.js';

export const grpcClient = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});

// ─── Assets ──────────────────────────────────────────────────────────

const ASSETS = {
  suiDrop: './assets/sui-drop.svg',
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
  suinsName: string;
  ikaWalletId: string;
  menuOpen: boolean;
  copied: boolean;
  splashSponsor: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
  stableUsd: 0,
  suinsName: '',
  ikaWalletId: '',
  menuOpen: false,
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
  widget: document.getElementById('wallet-widget'),
  wk: document.getElementById('wk-widget'),
  skiBtn: document.getElementById('wallet-ski-btn'),
  menuRoot: document.getElementById('wallet-menu-root'),
  modal: document.getElementById('ski-modal'),
  signStage: document.getElementById('sign-stage'),
};

// ─── Helpers ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncAddr(addr: string): string {
  if (!addr || addr.length <= 16) return addr;
  return addr.slice(0, 7) + '\u2026' + addr.slice(-5);
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

let _skiSvgText: string | null = null;
fetch('./assets/ski.svg').then((r) => r.text()).then((t) => { _skiSvgText = t; render(); }).catch(() => {});

type SkiDotVariant = 'green-circle' | 'blue-square' | 'black-diamond';

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
      .replace(`id="${idPrefix}-dot-square"`, `id="${idPrefix}-dot-square" fill="#3b82f6"`)
      .replace(new RegExp(`(<rect id="${idPrefix}-dot-square"[^>]*?) style="display:none"(/>)`), '$1$2');
  }
  // black-diamond: outer/inner visible by default in source; circle/square already hidden
  return s;
}

// Modal SVG — uses 'ski' prefix so IDs match what updateSkiDot() looks up
function getInlineSkiSvg(): string {
  const ws = getState();
  const variant: SkiDotVariant = ws.address
    ? (app.suinsName ? 'blue-square' : 'black-diamond')
    : 'green-circle';
  const svg = _buildSkiSvg('ski-modal-svg', 'ski-modal-logo', 'ski', variant, _skiLiftVisible);
  if (!svg) {
    return `<a href="https://sui.ski" target="_blank" rel="noopener" id="ski-modal-brand-link" class="ski-modal-brand-link">
      <img src="./assets/ski.svg" class="ski-modal-logo" id="ski-modal-svg-fallback">
    </a>`;
  }
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
    shape = `<rect x="0" y="0" width="100" height="100" rx="12" fill="#3b82f6" stroke="white" stroke-width="8"/><g transform="translate(22,14) scale(0.1875)" fill="white"><path fill-rule="evenodd" clip-rule="evenodd" d="${SUI_DROP_PATH}"/></g>`;
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
  if (square && variant === 'blue-square')  square.setAttribute('fill', '#3b82f6');

  if (fin) fin.style.display = _skiLiftVisible ? '' : 'none';

  if (link) {
    link.href = suinsName
      ? `https://${suinsName.replace(/\.sui$/, '')}.sui.ski`
      : 'https://sui.ski';
  }
}

// ─── Hydration guard (suppress disconnected flash on reload) ─────────

let _hydrating = false;

// ─── Wallet Modal ────────────────────────────────────────────────────

let modalOpen = false;
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
    return `<button type="button" class="ski-key-pfp ski-key-pfp--blue${splashClass}" data-splash-addr="${escaped}" title="${splashTitle} for ${esc(bare)}.sui"><img src="./assets/sui-drop.svg" class="ski-key-pfp-drop" alt=""></button>`;
  }
  const dropOverlay = splashOn ? `<img src="./assets/sui-drop.svg" class="ski-key-pfp-splash-drop" alt="" aria-hidden="true">` : '';
  return `<button type="button" class="ski-key-pfp ski-key-pfp--diamond${splashClass}" data-splash-addr="${escaped}" title="${splashTitle}"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#000000" stroke="#ffffff" stroke-width="4"/></svg>${dropOverlay}</button>`;
}

/** Subname creator column rendered inside each secondary key card. */
function subnameColHtml(addr: string): string {
  return `<div class="ski-subname-col" data-subname-target="${esc(addr)}">
    <input type="text" class="ski-subname-input" placeholder="sublabel" maxlength="50" spellcheck="false" autocomplete="off">
    <span class="ski-subname-dot">.</span>
    <select class="ski-subname-select" title="Parent domain"><option value="">\u2026</option></select>
    <button type="button" class="ski-subname-btn" title="Mint subname">
      <img src="./assets/ski.svg" alt="" class="ski-subname-btn-icon" aria-hidden="true">
    </button>
  </div>`;
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

  // Update dot variant
  if (!displayAddrs.length) {
    updateSkiDot('green-circle');
  } else {
    const cachedName = displayAddrs.map((addr: string) => suinsCache[addr]).find(Boolean);
    updateSkiDot(cachedName ? 'blue-square' : 'black-diamond', cachedName);
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
  const stableBal = isConnected ? fmtStable(app.stableUsd) : '';

  detailEl.innerHTML = `
    <div class="ski-detail-header${addr0 ? ' ski-detail-header--keyed' : ''}">
      <div class="ski-detail-icon-row"${addr0 ? ` data-addr-idx="0" data-full-addr="${esc(addr0)}"` : ''}>
        <div class="ski-detail-icons-top">
          ${w.icon ? (() => {
            const splashAuth = getSponsorState().auth;
            const activated = !!(splashAuth?.walletName === w.name && new Date(splashAuth.expiresAt).getTime() > Date.now());
            return `<div class="ski-detail-icon-wrap${activated ? ' ski-detail-icon-wrap--activated' : ''}"${!activated ? ` title="Splash all keys in ${esc(w.name)}"` : ''}>
              <img src="${esc(w.icon)}" alt="" class="ski-detail-icon">
              <div class="ski-detail-icon-overlay" aria-hidden="true">
                <img src="./assets/sui-drop.svg" class="ski-detail-icon-overlay-drop" alt="">
              </div>
              <div class="ski-detail-icon-revoke-overlay" aria-hidden="true">
                <svg width="34" height="34" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="3" x2="19" y2="19" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/><line x1="19" y1="3" x2="3" y2="19" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/></svg>
              </div>
              ${activated ? `<div class="ski-revoke-tooltip" aria-hidden="true">Withdraw <span class="ski-revoke-tooltip-name">${esc(w.name)}</span> Splash <img src="./assets/sui-drop.svg" class="ski-revoke-tooltip-drop" alt=""></div>` : ''}
            </div>`;
          })() : ''}
          ${/waap/i.test(w.name) && addr0 ? `<span class="ski-detail-provider-badge">${waapProviderIcon(addr0)}</span>` : ''}
          <div class="ski-detail-key-column">
            ${activePfpHtml}
          </div>
          ${stableBal ? `<span class="ski-detail-stable-bal">${esc(stableBal)}</span>` : ''}
        </div>
        ${activeTextHtml}
      </div>
    </div>
    ${otherKeysHtml ? `<div class="ski-detail-row">${otherKeysHtml}</div>` : ''}
    ${(networks.length || current.length || retiredSection) ? `
      <div class="ski-gear-row">
        <button class="ski-gear-btn" id="ski-gear-btn" title="Wallet details" aria-expanded="false">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      <div class="ski-gear-sections" id="ski-gear-sections" hidden>
        ${networks.length ? sectionHtml('Networks', networks.length, networksHtml) : ''}
        ${current.length ? sectionHtml('Features', current.length, currentHtml) : ''}
        ${retiredSection}
      </div>
    ` : ''}
  `;

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
          showToast('<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Splash active', true);
        } else if (isSponsoredAddress(addr)) {
          removeSponsoredEntry(addr);
          showToast('Splash removed for this address');
        } else {
          await addSponsoredEntry(addr);
          showToast('<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Splash added', true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        splashBtn.disabled = false;
      }
      // Refresh splash state on all key shape buttons in-place
      detailEl.querySelectorAll<HTMLButtonElement>('[data-splash-addr]').forEach((btn) => {
        const a = btn.getAttribute('data-splash-addr')!;
        const on = isSponsoredAddress(a);
        btn.classList.toggle('ski-key-pfp--splash', on);
        btn.setAttribute('title', on ? 'Splash active — click to remove' : 'Splash — click to activate');
        if (btn.classList.contains('ski-key-pfp--diamond')) {
          const existing = btn.querySelector('.ski-key-pfp-splash-drop');
          if (on && !existing) {
            const img = document.createElement('img');
            img.src = './assets/sui-drop.svg';
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

  // Bind gear toggle
  detailEl.querySelector('#ski-gear-btn')?.addEventListener('click', () => {
    const sections = detailEl.querySelector('#ski-gear-sections') as HTMLElement | null;
    const btn = detailEl.querySelector('#ski-gear-btn') as HTMLElement | null;
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
        showToast(`<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Splash \u00b7 ${n} key${n !== 1 ? 's' : ''} covered`, true);
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
        slot.innerHTML = `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-detail-suins">${esc(bare)}</a>`;
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
    ? `<span class="splash-drop-badge"><img src="./assets/sui-drop.svg" class="splash-drop-img" alt=""></span>` : '';
  const isSponsor = !!(splashState.auth?.walletName === w.name && new Date(splashState.auth.expiresAt).getTime() > Date.now());
  const sponsorClass = isSponsor ? ' ski-list-shape--sponsor' : '';
  const deviceClass = app.splashSponsor ? ' ski-list-shape--device-sponsor' : '';
  const hoverDrop = (isSponsor || app.splashSponsor)
    ? `<img src="./assets/sui-drop.svg" alt="" class="ski-list-shape-hover-drop">` : '';
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
  const LEGEND_BLUE    = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><rect x="2" y="2" width="43" height="43" rx="6" fill="#3b82f6" stroke="#ffffff" stroke-width="5"/></svg>`;
  const LEGEND_GREEN   = `<svg width="38" height="38" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="forced-color-adjust:none;-webkit-forced-color-adjust:none"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg>`;

  const allWallets = getSuiWallets();
  if (!allWallets.length) return '';

  const isGreen = (w: Wallet) => {
    const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
    return w.accounts.length === 0 && stored.length === 0;
  };

  let rowIdx = 0;

  // Without Splash: one row per stored address (with SuiNS + hex), green circle for unused wallets.
  // Sorted: diamond (addr, no SuiNS) → blue square (addr + SuiNS) → green circle (never used).
  if (!splashActive) {
    type Entry = { walletName: string; icon: string; address: string | null; suinsName: string | null; tier: 0 | 1 | 2 };
    const entries: Entry[] = [];
    for (const w of allWallets) {
      const liveAddrs = (w.accounts as unknown as { address: string }[]).map((a) => a.address);
      const stored: string[] = (() => { try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]') as string[]; } catch { return []; } })();
      const addrs = [...new Set([...liveAddrs, ...stored])];
      if (addrs.length === 0) {
        const tier: 0 | 2 = /waap/i.test(w.name) ? 0 : 2;
        entries.push({ walletName: w.name, icon: w.icon || '', address: null, suinsName: null, tier });
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
    const rows = entries.map((e) => {
      const shapeHtml = e.tier === 0 ? LEGEND_DIAMOND : e.tier === 1 ? LEGEND_BLUE : LEGEND_GREEN;
      const social = socialIconSvg(e.walletName);
      // Col 2: SuiNS name link, or for non-WaaP social green circle put X badge, else empty
      const nameHtml = e.suinsName
        ? (() => { const bare = e.suinsName.replace(/\.sui$/, ''); return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-legend-name">${esc(bare)}</a>`; })()
        : (social && !e.address && !/waap/i.test(e.walletName))
          ? `<span class="ski-waap-x ski-legend-social-badge" aria-hidden="true">𝕏</span>`
          : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
      // Col 3: address link or wallet name
      const addrCell = e.address
        ? `<a href="https://suiscan.xyz/mainnet/account/${esc(e.address)}" target="_blank" rel="noopener" class="ski-legend-addr">${esc(truncAddr(e.address))}</a>`
        : `<span class="ski-legend-name ski-legend-name--wallet ski-legend-addr--right">${esc(e.walletName)}</span>`;
      // Col 4: WaaP with known address → per-address provider icon; other social → social SVG; else wallet logo
      const iconCell = /waap/i.test(e.walletName) && e.address
        ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${waapProviderIcon(e.address)}</span>`
        : social
          ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
          : (e.icon ? `<img class="ski-legend-wallet-icon" src="${esc(e.icon)}" alt="${esc(e.walletName)}">` : `<span></span>`);
      const addrAttr = e.address ? ` data-legend-addr="${esc(e.address)}"` : '';
      return `<div class="ski-legend-row" data-legend-idx="${rowIdx++}" data-legend-wallet="${esc(e.walletName)}"${addrAttr} tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${shapeHtml}</span>${nameHtml}${addrCell}${iconCell}</div>`;
    }).join('');
    return `<div class="ski-splash-legend">
    <div class="ski-legend-targets">${rows}</div>
  </div>`;
  }

  // Splash active — green-circle rows appended at bottom of legend (unconnected wallets only)
  const greenWallets = allWallets.filter(w => isGreen(w) && !/waap/i.test(w.name)).sort((a, b) => {
    const aW = /waap/i.test(a.name) ? 0 : 1;
    const bW = /waap/i.test(b.name) ? 0 : 1;
    if (aW !== bW) return aW - bW;
    return a.name.localeCompare(b.name);
  });
  const walletRows = greenWallets.map((w) => {
    const social = socialIconSvg(w.name);
    const col2 = social
      ? `<span class="ski-waap-x ski-legend-social-badge" aria-hidden="true">𝕏</span>`
      : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
    const iconCell = social
      ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
      : (w.icon ? `<img class="ski-legend-wallet-icon" src="${esc(w.icon)}" alt="${esc(w.name)}">` : `<span></span>`);
    const html = `<div class="ski-legend-row" data-legend-idx="${rowIdx}" data-legend-wallet="${esc(w.name)}" tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${LEGEND_GREEN}</span>${col2}<span class="ski-legend-name ski-legend-name--wallet ski-legend-addr--right">${esc(w.name)}</span>${iconCell}</div>`;
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

  const sponsoredRows = annotated.map(({ entry: e, primaryName, tier }) => {
    const shapeHtml = tier === 2 ? LEGEND_GREEN : tier === 1 ? LEGEND_BLUE : LEGEND_DIAMOND;
    const nameHtml = primaryName
      ? (() => { const bare = primaryName.replace(/\.sui$/, ''); return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-legend-name">${esc(bare)}</a>`; })()
      : `<span class="ski-legend-name ski-legend-name--empty"></span>`;
    const wIcon = addrToWallet.get(e.address);
    const addrCell = `<a href="https://suiscan.xyz/mainnet/account/${esc(e.address)}" target="_blank" rel="noopener" class="ski-legend-addr">${esc(truncAddr(e.address))}</a>`;
    const social = wIcon ? socialIconSvg(wIcon.name) : null;
    const iconCell = social
      ? `<span class="ski-legend-wallet-icon ski-legend-social-icon">${social}</span>`
      : (wIcon?.icon ? `<img class="ski-legend-wallet-icon" src="${esc(wIcon.icon)}" alt="${esc(wIcon.name)}">` : `<span></span>`);
    const walletAttr = wIcon ? ` data-legend-wallet="${esc(wIcon.name)}"` : '';
    const html = `<div class="ski-legend-row" data-legend-idx="${rowIdx}" data-legend-addr="${esc(e.address)}"${walletAttr} tabindex="0" role="option" aria-selected="false"><span class="ski-legend-shape">${shapeHtml}</span>${nameHtml}${addrCell}${iconCell}</div>`;
    rowIdx++;
    return html;
  }).join('');

  const targetsHtml = annotated.length === 0 && greenWallets.length === 0
    ? `<span class="ski-legend-target ski-legend-target--open">all keys</span>`
    : sponsoredRows + walletRows;

  return `<div class="ski-splash-legend">
    <div class="ski-legend-header">
      <img src="./assets/sui-drop.svg" alt="" class="ski-legend-drop">
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
  const connKey = document.getElementById('ski-connected-key');

  if (walletName === getState().walletName) {
    // Connected wallet row: hide right-pane header, highlight matching addr in connected key
    if (detailEl) detailEl.classList.add('ski-detail--key-hover');
    const addr = row.dataset.legendAddr;
    if (connKey) {
      connKey.querySelectorAll<HTMLElement>('[data-full-addr]').forEach((el) => {
        el.classList.toggle('ski-detail-addr--highlighted', !!addr && el.dataset.fullAddr === addr);
      });
    }
    return;
  }

  // Non-connected wallet: clear hover effects, update right pane
  if (detailEl) detailEl.classList.remove('ski-detail--key-hover');
  if (connKey) {
    connKey.querySelectorAll('.ski-detail-addr--highlighted').forEach((el) => el.classList.remove('ski-detail-addr--highlighted'));
  }
  if (walletName) {
    const wallet = getSuiWallets().find((w) => w.name === walletName);
    if (wallet && detailEl) showKeyDetail(wallet, detailEl, getState().address);
  }
}

/** Middle column of the modal header: current address balance. */
function buildHeaderBalanceHtml(): string {
  const ws = getState();
  if (!ws.address) return '';
  const suiText = fmtSui(app.sui);
  const usdText = fmtUsd(app.usd);
  const suiRow = `<div class="ski-header-bal-sui">${esc(suiText)}<img src="./assets/sui-drop.svg" class="ski-header-bal-sui-icon" alt="SUI" aria-label="SUI"></div>`;
  const usdRow = usdText ? `<div class="ski-header-bal-usd">${esc(usdText)}</div>` : '';
  const [primary, secondary] = balView === 'usd' && usdText
    ? [`<div class="ski-header-bal-primary ski-header-bal-usd">${esc(usdText)}</div>`, `<div class="ski-header-bal-secondary ski-header-bal-sui">${esc(suiText)}<img src="./assets/sui-drop.svg" class="ski-header-bal-sui-icon" alt="SUI" aria-label="SUI"></div>`]
    : [`<div class="ski-header-bal-primary ski-header-bal-sui">${esc(suiText)}<img src="./assets/sui-drop.svg" class="ski-header-bal-sui-icon" alt="SUI" aria-label="SUI"></div>`, usdRow ? `<div class="ski-header-bal-secondary ski-header-bal-usd">${esc(usdText)}</div>` : ''];
  void suiRow; // used above via destructure
  return `${primary}${secondary}`;
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
            <button id="ski-modal-close" style="background:none;border:none;color:#9ca7bb;font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1">&times;</button>
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
      <label class="ski-layout-toggle" title="${layout === 'splash' ? 'Switch to wallet list' : 'Switch to splash view'}">
        <input type="checkbox" id="ski-layout-check"${layout === 'splash' ? ' checked' : ''}>
        <span class="ski-layout-track"><span class="ski-layout-thumb"></span></span>
        <span class="ski-layout-label">Splash</span>
      </label>
    </div>` : '';

  // Splash button for the brand column header (activate / deactivate)
  const ws = getState();
  const sponsorAuth = getSponsorState().auth;
  const isActiveSponsor = isSponsorActive() && sponsorAuth?.address === ws.address;
  let headerSplashHtml = '';
  if (ws.walletName) {
    if (isActiveSponsor) {
      const msLeft = new Date(sponsorAuth!.expiresAt).getTime() - Date.now();
      const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
      headerSplashHtml = `<div class="ski-header-splash ski-header-splash--on">
          <img src="./assets/sui-drop.svg" class="ski-header-splash-drop" aria-hidden="true">
          <span class="ski-header-splash-days">${daysLeft}d left</span>
          <button class="ski-header-splash-btn" id="ski-header-splash-off" type="button">Revoke</button>
        </div>`;
    } else if (!isSponsorActive()) {
      headerSplashHtml = `<div class="ski-header-splash">
          <img src="./assets/sui-drop.svg" class="ski-header-splash-drop" aria-hidden="true">
          <button class="ski-header-splash-btn" id="ski-header-splash-on" type="button">Splash</button>
        </div>`;
    }
  }

  els.modal.innerHTML = `
    <div class="ski-modal-overlay open" id="ski-modal-overlay">
      <div class="ski-modal" style="animation:ski-modal-in .2s ease">
        <div class="ski-modal-header">
          <div id="ski-connected-key" class="ski-modal-connected-key ski-modal-header-key-col"></div>
          ${ws.address ? `<div class="ski-modal-header-balance" id="ski-modal-header-balance">${buildHeaderBalanceHtml()}</div>` : ''}
          <div class="ski-modal-header-brand">
            <div class="ski-modal-header-brand-top">
              <div class="ski-modal-header-left">
                ${getInlineSkiSvg()}
                <div class="ski-modal-titles">
                  <h2 class="ski-modal-title">.Sui Key-In</h2>
                  <p class="ski-modal-tagline">once,<br>everywhere</p>
                </div>
              </div>
              <button id="ski-modal-close" style="background:none;border:none;color:#9ca7bb;font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1">&times;</button>
            </div>
            ${headerSplashHtml}
          </div>
        </div>
        <div class="ski-modal-body">
          ${leftColHtml}
          <div class="ski-modal-right-col">
            <div class="ski-modal-col ski-modal-detail" id="ski-modal-detail">
              <div class="ski-detail-empty">Hover a key<br>for details</div>
            </div>
          </div>
        </div>
        ${settingsStrip}
      </div>
    </div>
  `;

  document.getElementById('ski-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ski-modal-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'ski-modal-overlay') closeModal();
  });

  // Populate the connected key slot at the top of the legend
  const connectedKeyEl = document.getElementById('ski-connected-key');
  if (connectedKeyEl && connectedName) {
    const wallet = getSuiWallets().find((w) => w.name === connectedName);
    if (wallet) showKeyDetail(wallet, connectedKeyEl, getState().address);
  }

  // Layout toggle — persists preference and re-renders
  document.getElementById('ski-layout-check')?.addEventListener('change', (e) => {
    const splash = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem('ski:modal-layout', splash ? 'splash' : 'list'); } catch {}
    renderModal();
  });

  // Header Splash button — activate
  document.getElementById('ski-header-splash-on')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = 'Activating\u2026';
    try {
      const { wallet, account } = getState();
      if (!wallet || !account) throw new Error('No wallet connected');
      await activateSponsor(wallet, account);
      showToast('<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Splash active &middot; 7 days', true);
      render();
      renderModal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
      btn.disabled = false; btn.textContent = 'Splash';
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
  els.widget?.classList.remove('ski-modal-active');
  if (els.modal) els.modal.innerHTML = '';
}

async function selectWallet(wallet: Wallet) {
  closeModal();
  try {
    // Disconnect current wallet first if switching
    if (getState().wallet) {
      try { await disconnect(); } catch {}
    }
    await connect(wallet);
  } catch (err) {
    showToast('Failed to connect: ' + (err instanceof Error ? err.message : 'unknown error'));
  }
}

// ─── Portfolio (gRPC balance fetch + GraphQL SuiNS) ──────────────────

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const USDC_TYPE   = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

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

// SUI/USD price cache — refreshed at most once every 5 minutes
let suiPriceCache: { price: number; fetchedAt: number } | null = null;

// Balance display preference: 'sui' shows SUI primary, 'usd' shows USD primary
let balView: 'sui' | 'usd' = (() => {
  try { return (localStorage.getItem('ski:bal-pref') as 'sui' | 'usd') || 'sui'; } catch { return 'sui'; }
})();

async function fetchSuiPrice(): Promise<number | null> {
  const now = Date.now();
  if (suiPriceCache && now - suiPriceCache.fetchedAt < 5 * 60 * 1000) return suiPriceCache.price;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    if (!res.ok) return suiPriceCache?.price ?? null;
    const { price } = await res.json() as { price: string };
    const p = parseFloat(price);
    if (Number.isFinite(p) && p > 0) {
      suiPriceCache = { price: p, fetchedAt: now };
      return p;
    }
  } catch { /* keep cached */ }
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
    const [suiResult, usdcResult, suinsName, suiPrice] = await Promise.all([
      grpcClient.core.getBalance({ owner: fetchedFor }).catch(() => null),
      grpcClient.core.getBalance({ owner: fetchedFor, coinType: USDC_TYPE }).catch(() => null),
      lookupSuiNS(fetchedFor),
      fetchSuiPrice(),
    ]);

    // Wallet switched while fetch was in-flight — discard stale result
    if (getState().address !== fetchedFor) return;

    const suiMist = Number(suiResult?.balance?.balance ?? 0);
    app.sui = Number.isFinite(suiMist) ? suiMist / 1e9 : 0;

    const usdcRaw = Number(usdcResult?.balance?.balance ?? 0);
    app.stableUsd = Number.isFinite(usdcRaw) ? usdcRaw / 1e6 : 0;

    app.usd = suiPrice != null ? app.sui * suiPrice : null;

    if (suinsName) {
      app.suinsName = suinsName;
      try { localStorage.setItem(`ski:suins:${fetchedFor}`, suinsName); } catch {}
    }
  } catch { /* keep existing */ }
  finally {
    portfolioInFlight = false;
    render();
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
  if (!els.wk) return;
  const ws = getState();

  // Disconnected: hide wk-widget — profile button handles connect
  if (!ws.address) {
    els.wk.innerHTML = '';
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

  // Balance
  const tokenText = fmtSui(app.sui);
  const usdText = fmtUsd(app.usd);
  let balanceHtml = '';
  if (tokenText || usdText) {
    balanceHtml = '<span class="wk-widget-balance-wrap">';
    if (tokenText) balanceHtml += `<span class="wk-widget-token-row">${esc(tokenText)}<img class="sui-icon" src="${ASSETS.suiDrop}" alt="SUI"></span>`;
    if (usdText) balanceHtml += `<span class="wk-widget-usd-row">${esc(usdText)}</span>`;
    balanceHtml += '</span>';
  }

  els.wk.innerHTML = `
    <div class="wk-widget">
      <button class="wk-widget-btn connected" id="wallet-pill-btn" type="button" title="Open profile">
        ${iconHtml}
        <span class="wk-widget-label-wrap">
          <span class="${labelClass}">
            <span class="wk-widget-primary-name">${esc(label)}</span>
          </span>
        </span>
        ${ikaHtml}
        ${balanceHtml}
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

function renderSkiBtn() {
  if (!els.skiBtn) return;
  const ws = getState();

  if (!ws.address) {
    els.skiBtn.style.display = '';
    els.skiBtn.innerHTML = getSkiBtnSvg(_hydrating ? 'black-diamond' : 'green-circle');
    return;
  }

  const hasPrimary = !!app.suinsName;
  els.skiBtn.style.display = '';
  els.skiBtn.classList.toggle('menu-open', app.menuOpen);
  const showDrop = app.splashSponsor || hasValidSkiSession(ws.address);
  const drop = showDrop
    ? `<img src="./assets/sui-drop.svg" class="ski-btn-session-drop" alt="" aria-hidden="true">`
    : '';
  els.skiBtn.innerHTML = getSkiBtnSvg(hasPrimary ? 'blue-square' : 'black-diamond') + drop;
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
          <img src="./assets/sui-drop.svg" class="splash-icon-drop" aria-hidden="true">
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
        <img src="./assets/sui-drop.svg" class="splash-icon-drop" aria-hidden="true">
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
      showToast(`<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Added ${esc(label)} to Splash`, true);
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
      showToast('<img src="./assets/sui-drop.svg" class="toast-drop" aria-hidden="true"> Splash active &middot; 7 days', true);
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

// ─── Render: Dropdown Menu ───────────────────────────────────────────

function renderMenu() {
  if (!els.menuRoot) return;
  const ws = getState();

  if (!ws.address || !app.menuOpen) {
    els.menuRoot.innerHTML = '';
    return;
  }

  const scanUrl = `https://suiscan.xyz/mainnet/account/${ws.address}`;

  // Blue-square state (SuiNS name) — big profile popout
  if (app.suinsName) {
    const bare = app.suinsName.replace(/\.sui$/, '');
    const suiText = fmtSui(app.sui);
    const usdText = fmtUsd(app.usd);
    const addrShort = truncAddr(ws.address);

    els.menuRoot.innerHTML = `
      <div class="wk-dropdown wk-dropdown--large open">
        <div class="wk-popout-actions">
          <button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>
          <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>
        </div>
        <div class="wk-popout-name-badge">
          <svg viewBox="0 0 100 100" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="flex-shrink:0"><rect x="6" y="6" width="88" height="88" rx="10" fill="#3b82f6"/></svg>
          <span class="wk-popout-name-text">${esc(bare)}<span class="wk-popout-name-tld">.sui</span></span>
          <a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="wk-popout-name-link" title="View .ski profile">\u2197</a>
        </div>
        ${(suiText || usdText) ? `<div class="wk-popout-balance">
          ${suiText ? `<span class="wk-popout-balance-sui">${esc(suiText)}</span><img src="${ASSETS.suiDrop}" class="wk-popout-balance-icon" alt="SUI">` : ''}
          ${usdText ? `<span class="wk-popout-balance-usd">${esc(usdText)}</span>` : ''}
        </div>` : ''}
        <div class="wk-dd-address-row">
          <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="Copy address">
            <span class="wk-dd-address-text">${esc(app.copied ? 'Copied! \u2713' : addrShort)}</span>
          </button>
          <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="View on Suiscan">\u2197</a>
        </div>
      </div>`;
  } else {
    // Black-diamond state — compact dropdown
    const addrDisplay = app.copied ? 'Copied! \u2713' : ws.address;
    els.menuRoot.innerHTML = `
      <div class="wk-dropdown open">
        <div class="wk-popout-actions">
          <button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>
          <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>
        </div>
        <div class="wk-dd-address-row">
          <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="Copy address">
            <span class="wk-dd-address-text">${esc(addrDisplay)}</span>
          </button>
          <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="View on Suiscan">\u2197</a>
        </div>
      </div>`;
  }

  document.getElementById('wk-dd-copy')?.addEventListener('click', (e) => { e.stopPropagation(); copyAddress(); });
  document.getElementById('wk-dd-switch')?.addEventListener('click', () => {
    app.menuOpen = false;
    render();
    openModal();
  });
  document.getElementById('wk-dd-disconnect')?.addEventListener('click', () => handleDisconnect(false));
}

// ─── Disconnect handler ──────────────────────────────────────────────

async function handleDisconnect(reopenModal = false) {
  app.menuOpen = false;
  app.copied = false;
  closeModal();
  render();
  try { await disconnect(); } catch { /* already gone */ }
  if (reopenModal) setTimeout(() => openModal(true), 180);
}

// ─── Master render ───────────────────────────────────────────────────

function render() {
  renderWidget();
  renderSkiBtn();
  renderSignStage();
  renderMenu();

  // Update favicon to match current wallet state
  const ws = getState();
  updateFavicon(!ws.address ? 'green-circle' : (app.suinsName ? 'blue-square' : 'black-diamond'));

  // Live-update modal header balance without full re-render
  const modalBalEl = document.getElementById('ski-modal-header-balance');
  if (modalBalEl) modalBalEl.innerHTML = buildHeaderBalanceHtml();

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
  els.skiBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getState().address) {
      if (modalOpen) { closeModal(); return; }
      openModal();
      return;
    }
    if (modalOpen) { closeModal(); return; }
    if (app.menuOpen) { app.menuOpen = false; render(); openModal(); return; }
    app.menuOpen = true;
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
    if (!app.menuOpen) return;
    if (els.skiBtn?.contains(e.target as Node)) return;
    if (els.menuRoot?.contains(e.target as Node)) return;
    app.menuOpen = false;
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
      app.suinsName = '';
      app.ikaWalletId = '';
      app.menuOpen = false;
      app.copied = false;
      // Keep ski:suins-name and ski:session so data persists through disconnect

      window.dispatchEvent(new CustomEvent('ski:wallet-disconnected'));
    }

    render();
  });

  // Re-render when sponsor state changes (badge, sign-stage card, legend)
  subscribeSponsor(() => {
    render();
    const slot = document.getElementById('ski-legend-slot');
    if (slot) slot.innerHTML = buildSplashLegend();
    // Refresh connected key (sponsor state affects splash toggle display)
    const connKeyEl = document.getElementById('ski-connected-key');
    const ws = getState();
    if (connKeyEl && ws.walletName) {
      const wallet = getSuiWallets().find((w) => w.name === ws.walletName);
      if (wallet) showKeyDetail(wallet, connKeyEl, ws.address);
    }
  });

  // Delegated: legend row mouseover → highlight + show key detail (respects lock)
  els.modal?.addEventListener('mouseover', (e) => {
    if (!modalOpen) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-row');
    if (!row) return;
    const idx = parseInt(row.dataset.legendIdx || '-1', 10);
    if (idx >= 0) activateLegendRow(idx, true);
  });

  // Delegated: wallet-list row hover → show key detail (respects lock)
  els.modal?.addEventListener('mouseover', (e) => {
    if (!modalOpen) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.wk-dd-item[data-wallet-name]');
    if (!btn) return;
    document.querySelectorAll('.wk-dd-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (detailLocked) return;
    const wallet = getSuiWallets().find((w) => w.name === btn.dataset.walletName);
    const detailEl = document.getElementById('ski-modal-detail');
    if (wallet && detailEl) showKeyDetail(wallet, detailEl, getState().address);
  });

  // Long-press (2200ms) on any row to lock/unlock the detail pane
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressX = 0;
  let longPressY = 0;
  let longPressFired = false; // suppresses the click that fires after pointerup

  els.modal?.addEventListener('pointerdown', (e) => {
    longPressFired = false;
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

    // Balance column toggle: switch between SUI-primary and USD-primary
    if ((e.target as HTMLElement).closest('#ski-modal-header-balance')) {
      balView = balView === 'sui' ? 'usd' : 'sui';
      try { localStorage.setItem('ski:bal-pref', balView); } catch {}
      const balEl = document.getElementById('ski-modal-header-balance');
      if (balEl) balEl.innerHTML = buildHeaderBalanceHtml();
      return;
    }

    const legendRow = (e.target as HTMLElement).closest<HTMLElement>('.ski-legend-row');
    if (legendRow?.dataset.legendWallet) {
      const wallet = getSuiWallets().find((w) => w.name === legendRow.dataset.legendWallet);
      if (wallet) selectWallet(wallet);
      return;
    }
    const listBtn = (e.target as HTMLElement).closest<HTMLElement>('.wk-dd-item[data-wallet-name]');
    if (listBtn?.dataset.walletName) {
      const wallet = getSuiWallets().find((w) => w.name === listBtn.dataset.walletName);
      if (wallet) selectWallet(wallet);
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
        if (wallet) selectWallet(wallet);
      }
    }
  });

  // Re-render when new wallets are installed
  onWalletsChanged(() => {
    if (modalOpen) renderModal();
  });

  // Suppress disconnected flash if a wallet was previously connected
  try {
    if (localStorage.getItem('mysten-dapp-kit:selected-wallet-and-address')) {
      _hydrating = true;
    }
  } catch {}

  // Initial render
  render();

  // Auto-reconnect to last wallet
  autoReconnect().catch(() => {});
  // Safety: clear hydrating after 1.5 s in case subscribe never fires
  setTimeout(() => { if (_hydrating) { _hydrating = false; render(); } }, 1500);
}
