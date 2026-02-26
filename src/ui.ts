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
import type { Wallet } from '@wallet-standard/base';

// ─── Assets ──────────────────────────────────────────────────────────

const ASSETS = {
  suiDrop: './assets/sui-drop.svg',
};

// ─── App-level state (beyond wallet connection) ──────────────────────

export interface AppState {
  sui: number;
  usd: number | null;
  stableUsd: number;
  suinsName: string;
  ikaWalletId: string;
  menuOpen: boolean;
  copied: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
  stableUsd: 0,
  suinsName: '',
  ikaWalletId: '',
  menuOpen: false,
  copied: false,
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

export function showToast(msg: string) {
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
  toast.textContent = text;
  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 180); };
  setTimeout(remove, 3800);
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

function updateFavicon(variant: SkiDotVariant) {
  if (variant === _faviconVariant) return;
  _faviconVariant = variant;

  let shape: string;
  if (variant === 'green-circle') {
    shape = `<circle cx="50" cy="50" r="38" fill="#22c55e" stroke="white" stroke-width="10"/>`;
  } else if (variant === 'blue-square') {
    shape = `<rect x="10" y="10" width="80" height="80" fill="#3b82f6" stroke="white" stroke-width="10"/>`;
  } else {
    shape = `<polygon points="50,6 94,50 50,94 6,50" fill="#111111" stroke="white" stroke-width="10"/>`;
  }
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${shape}</svg>`;
  const url = 'data:image/svg+xml,' + encodeURIComponent(svgStr);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = url;
}

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
let detailGeneration = 0; // incremented on each showWalletDetail call to cancel stale async lookups

/** Profile-picture indicator for a key: black diamond (no SuiNS) or blue square with sui-drop (has SuiNS). */
function keyPfpHtml(_ai: number, suinsName: string | null): string {
  if (suinsName) {
    const bare = suinsName.replace(/\.sui$/, '');
    return `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-key-pfp ski-key-pfp--blue" title="${esc(bare)}.sui.ski"><img src="./assets/sui-drop.svg" class="ski-key-pfp-drop" alt=""></a>`;
  }
  return `<a href="https://sui.ski" target="_blank" rel="noopener" class="ski-key-pfp ski-key-pfp--diamond" title="sui.ski"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon points="23.5,2.5 44.5,23.5 23.5,44.5 2.5,23.5" fill="#111827" stroke="#ffffff" stroke-width="4"/></svg></a>`;
}

function showWalletDetail(w: Wallet, detailEl: HTMLElement, connectedAddr: string) {
  const gen = ++detailGeneration;
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

  // Build a key card (used for both the active key and secondary keys)
  const keyCardHtml = (addr: string, ai: number): string => {
    const suinsName: string | null = suinsCache[addr] || (() => { try { return localStorage.getItem(`ski:suins:${addr}`); } catch { return null; } })() || null;
    const scanUrl = `https://suiscan.xyz/mainnet/account/${esc(addr)}`;
    const cls = ai === 0 ? 'ski-detail-active-key' : 'ski-detail-addr-wrap';
    return `<div class="${cls}" data-addr-idx="${ai}" data-full-addr="${esc(addr)}">
      ${keyPfpHtml(ai, suinsName)}
      <div class="ski-detail-key-text">
        <span class="ski-detail-suins-slot"></span>
        <div class="ski-detail-addr-row">
          <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="ski-detail-addr-text" title="${esc(addr)}">${esc(truncAddr(addr))}</a>
          <button class="ski-copy-btn" title="Copy address">\u2398</button>
        </div>
      </div>
    </div>`;
  };

  const activeKeyHtml = displayAddrs.length
    ? keyCardHtml(displayAddrs[0], 0)
    : '<div class="ski-key-pfp ski-key-pfp--green-circle"><svg width="47" height="47" viewBox="0 0 47 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="23.5" cy="23.5" r="21" fill="#22c55e" stroke="#ffffff" stroke-width="5"/></svg></div>';

  const otherKeysHtml = displayAddrs.slice(1).map((addr: string, i: number) => keyCardHtml(addr, i + 1)).join('');

  const isConnected = displayAddrs[0] === connectedAddr;
  const stableBal = isConnected ? fmtStable(app.stableUsd) : '';

  detailEl.innerHTML = `
    <div class="ski-detail-header">
      <div class="ski-detail-icon-row">
        ${w.icon ? `<img src="${esc(w.icon)}" alt="" class="ski-detail-icon">` : ''}
        <div class="ski-detail-key-column">
          ${stableBal ? `<span class="ski-detail-stable-bal">${esc(stableBal)}</span>` : ''}
          ${activeKeyHtml}
        </div>
      </div>
      <div class="ski-detail-name">${esc(w.name)}</div>
    </div>
    ${otherKeysHtml ? `<div class="ski-detail-row"><span class="ski-detail-label">Other Keys</span>${otherKeysHtml}</div>` : ''}
    ${networks.length ? sectionHtml('Networks', networks.length, networksHtml) : ''}
    ${current.length ? sectionHtml('Features', current.length, currentHtml) : ''}
    ${retiredSection}
  `;

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
      if (name && detailGeneration === gen) {
        suinsCache[addr] = name;
        try { localStorage.setItem(`ski:suins:${addr}`, name); } catch {}
        renderName(name);
        // Upgrade pfp from diamond to blue-square now that we have a SuiNS name
        const wrap = detailEl.querySelector(`[data-addr-idx="${ai}"]`);
        const pfpEl = wrap?.querySelector('.ski-key-pfp');
        if (pfpEl && !pfpEl.classList.contains('ski-key-pfp--blue')) {
          const tmp = document.createElement('div');
          tmp.innerHTML = keyPfpHtml(ai, true);
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
}

function renderModal(): number | undefined {
  if (!els.modal) return;
  const connectedName = getState().walletName;
  const wallets = getSuiWallets().slice().sort((a, b) => {
    const score = (w: typeof a) => {
      if (w.name === connectedName) return 3;
      const addrs: string[] = (() => {
        try { return JSON.parse(localStorage.getItem(`ski:wallet-keys:${w.name}`) || '[]'); } catch { return []; }
      })();
      const hasSuins = addrs.some((addr) => suinsCache[addr] || !!localStorage.getItem(`ski:suins:${addr}`));
      if (hasSuins) return 2;
      if (w.accounts.length > 0) return 1;
      return 0;
    };
    return score(b) - score(a);
  });

  if (!modalOpen) {
    els.modal.innerHTML = '';
    return;
  }

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
        <div class="ski-modal-body">
          <div class="ski-modal-col ski-modal-wallets">
            ${wallets.map((w, i) => `
              <button class="wk-dd-item${w.name === connectedName ? ' active' : ''}" data-idx="${i}" style="display:flex;align-items:center;gap:10px">
                ${w.icon ? `<img src="${esc(w.icon)}" alt="" style="width:28px;height:28px;border-radius:6px">` : ''}
                <span>${esc(w.name)}</span>
              </button>
            `).join('')}
          </div>
          <div class="ski-modal-col ski-modal-detail" id="ski-modal-detail">
            <div class="ski-detail-empty">Hover a wallet<br>for details</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('ski-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ski-modal-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'ski-modal-overlay') closeModal();
  });
  const detailEl = document.getElementById('ski-modal-detail');

  const walletBtns = () => Array.from(els.modal?.querySelectorAll<HTMLElement>('[data-idx]') ?? []);

  const activateWallet = (idx: number) => {
    const btns = walletBtns();
    btns.forEach((b) => b.classList.remove('active'));
    const btn = btns[idx];
    if (!btn) return;
    btn.classList.add('active');
    btn.focus();
    const w = wallets[idx];
    if (w && detailEl) showWalletDetail(w, detailEl, getState().address);
  };

  els.modal.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      const wallet = wallets[idx];
      if (wallet) selectWallet(wallet);
    });

    btn.addEventListener('mouseenter', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      activateWallet(idx);
    });

    btn.addEventListener('keydown', (e) => {
      const btns = walletBtns();
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      if ((e as KeyboardEvent).key === 'ArrowDown') {
        e.preventDefault();
        activateWallet((idx + 1) % btns.length);
      } else if ((e as KeyboardEvent).key === 'ArrowUp') {
        e.preventDefault();
        activateWallet((idx - 1 + btns.length) % btns.length);
      }
    });
  });

  // Auto-show the connected wallet's detail immediately on open (fall back to first wallet)
  const defaultIdx = connectedName ? wallets.findIndex((w) => w.name === connectedName) : 0;
  const focusIdx = defaultIdx >= 0 ? defaultIdx : 0;
  const defaultWallet = wallets[focusIdx];
  if (defaultWallet && detailEl) showWalletDetail(defaultWallet, detailEl, getState().address);

  return focusIdx;
}

export function openModal(focusFirst = false) {
  modalOpen = true;
  els.widget?.classList.add('ski-modal-active');
  const focusIdx = renderModal() ?? 0;
  if (focusFirst) {
    // Defer so the DOM is painted before we try to focus
    requestAnimationFrame(() => {
      const btns = Array.from(els.modal?.querySelectorAll<HTMLElement>('[data-idx]') ?? []);
      btns[focusIdx]?.focus();
    });
  }
}

function closeModal() {
  modalOpen = false;
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

// ─── Portfolio (GraphQL balance fetch) ───────────────────────────────

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

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

let lastPortfolioMs = 0;
let portfolioInFlight = false;

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
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            defaultNameRecord{domain}
            balance(coinType:"0x2::sui::SUI"){totalBalance}
            usdc:balance(coinType:"0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"){totalBalance}
          }
        }`,
        variables: { a: fetchedFor },
      }),
    });
    const json = await res.json();

    // Wallet switched while fetch was in-flight — discard stale result
    if (getState().address !== fetchedFor) return;

    const addr = json?.data?.address;
    const mist = Number(addr?.balance?.totalBalance || 0);
    app.sui = Number.isFinite(mist) ? mist / 1e9 : 0;
    const usdcRaw = Number(addr?.usdc?.totalBalance || 0);
    app.stableUsd = Number.isFinite(usdcRaw) ? usdcRaw / 1e6 : 0;

    // SuiNS reverse lookup
    const name = addr?.defaultNameRecord?.domain;
    if (name && typeof name === 'string') {
      app.suinsName = name;
      try { localStorage.setItem(`ski:suins:${fetchedFor}`, name); } catch {}
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

  // Wallet icon
  let iconHtml = '';
  if (ws.walletIcon) {
    iconHtml = `<span class="wk-widget-method-icon"><img src="${esc(ws.walletIcon)}" alt="${esc(ws.walletName)}"></span>`;
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
  els.skiBtn.innerHTML = getSkiBtnSvg(hasPrimary ? 'blue-square' : 'black-diamond');
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

  const resultHtml = lastSignResult
    ? `<div class="sign-result">
        <div class="sign-result-label">Signature</div>
        <div class="sign-result-value">${esc(lastSignResult.signature)}</div>
      </div>`
    : '';

  els.signStage.innerHTML = `
    <div class="sign-card">
      <textarea class="sign-textarea" id="sign-msg-input" rows="2" spellcheck="false">${esc(signMessageText)}</textarea>
      <div class="sign-action-row">
        <button class="sign-btn" id="sign-msg-btn" type="button">Sign Message</button>
        ${resultHtml}
      </div>
    </div>`;

  document.getElementById('sign-msg-input')?.addEventListener('input', (e) => {
    signMessageText = (e.target as HTMLTextAreaElement).value;
  });

  document.getElementById('sign-msg-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('sign-msg-btn') as HTMLButtonElement;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Signing\u2026';
    try {
      const bytes = new TextEncoder().encode(signMessageText);
      const result = await signPersonalMessage(bytes);
      lastSignResult = result;
      showToast('Message signed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signing failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
      else showToast('Signing cancelled');
    }
    btn.disabled = false;
    btn.textContent = 'Sign Message';
    renderSignStage();
  });
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
        <div class="wk-popout-actions">
          <button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>
          <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>
        </div>
      </div>`;
  } else {
    // Black-diamond state — compact dropdown
    const addrDisplay = app.copied ? 'Copied! \u2713' : ws.address;
    els.menuRoot.innerHTML = `
      <div class="wk-dropdown open">
        <div class="wk-dd-address-row">
          <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="Copy address">
            <span class="wk-dd-address-text">${esc(addrDisplay)}</span>
          </button>
          <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="View on Suiscan">\u2197</a>
        </div>
        <button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>
        <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>
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

  // Bind pill click
  const pill = document.getElementById('wallet-pill-btn');
  pill?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modalOpen) { closeModal(); return; }
    if (!getState().address) { openModal(); return; }
    window.open(skiHref(), '_blank', 'noopener,noreferrer');
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
    app.menuOpen = !app.menuOpen;
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
