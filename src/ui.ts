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
  logoGreen: './assets/green_dotski.png',
  suiDrop: './assets/sui-drop.svg',
};

// ─── App-level state (beyond wallet connection) ──────────────────────

export interface AppState {
  sui: number;
  usd: number | null;
  suinsName: string;
  ikaWalletId: string;
  menuOpen: boolean;
  copied: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
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
  profileBtn: document.getElementById('wallet-profile-btn'),
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
fetch('./assets/ski.svg').then((r) => r.text()).then((t) => { _skiSvgText = t; }).catch(() => {});

function getInlineSkiSvg(): string {
  if (!_skiSvgText) {
    return `<a href="https://sui.ski" target="_blank" rel="noopener" id="ski-modal-brand-link" class="ski-modal-brand-link">
      <img src="./assets/ski.svg" class="ski-modal-logo" id="ski-modal-svg-fallback">
    </a>`;
  }
  const svgHtml = _skiSvgText.replace('<svg ', '<svg id="ski-modal-svg" class="ski-modal-logo" ');
  return `<a href="https://sui.ski" target="_blank" rel="noopener" id="ski-modal-brand-link" class="ski-modal-brand-link">${svgHtml}</a>`;
}

type SkiDotVariant = 'green-circle' | 'blue-square' | 'black-diamond';

function updateSkiDot(variant: SkiDotVariant, suinsName?: string) {
  const outer  = document.getElementById('ski-dot-outer')  as SVGElement | null;
  const inner  = document.getElementById('ski-dot-inner')  as SVGElement | null;
  const circle = document.getElementById('ski-dot-circle') as SVGElement | null;
  const square = document.getElementById('ski-dot-square') as SVGElement | null;
  const link   = document.getElementById('ski-modal-brand-link') as HTMLAnchorElement | null;

  if (outer)  outer.style.display  = variant === 'black-diamond' ? '' : 'none';
  if (inner)  inner.style.display  = variant === 'black-diamond' ? '' : 'none';
  if (circle) circle.style.display = variant === 'green-circle'  ? '' : 'none';
  if (square) square.style.display = variant === 'blue-square'   ? '' : 'none';

  if (circle && variant === 'green-circle') circle.setAttribute('fill', '#22c55e');
  if (square && variant === 'blue-square')  square.setAttribute('fill', '#3b82f6');

  if (link) {
    link.href = suinsName
      ? `https://${suinsName.replace(/\.sui$/, '')}.sui.ski`
      : 'https://sui.ski';
  }
}

// ─── Wallet Modal ────────────────────────────────────────────────────

let modalOpen = false;
const suinsCache: Record<string, string> = {}; // address -> name

function renderModal() {
  if (!els.modal) return;
  const wallets = getSuiWallets().slice().sort((a, b) =>
    (b.accounts.length > 0 ? 1 : 0) - (a.accounts.length > 0 ? 1 : 0)
  );

  if (!modalOpen || !wallets.length) {
    els.modal.innerHTML = '';
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
              <button class="wk-dd-item" data-idx="${i}" style="display:flex;align-items:center;gap:10px">
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

  els.modal.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      const wallet = wallets[idx];
      if (wallet) selectWallet(wallet);
    });

    btn.addEventListener('mouseenter', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      const w = wallets[idx];
      if (!w || !detailEl) return;

      // Update dot: green = no accounts, blue = has SuiNS, black = connected but no SuiNS
      if (!w.accounts.length) {
        updateSkiDot('green-circle');
      } else {
        const cachedName = w.accounts.map((a) => suinsCache[normalizeSuiAddress(a.address)]).find(Boolean);
        updateSkiDot(cachedName ? 'blue-square' : 'black-diamond', cachedName);
      }

      const DOCS = 'https://docs.sui.io/standards/wallet-standard';
      const LEGACY: Record<string, string> = {
        'signTransactionBlock': 'Legacy — use signTransaction',
        'signAndExecuteTransactionBlock': 'Legacy — use signAndExecuteTransaction',
      };

      const networks = w.chains.filter((c) => c.startsWith('sui:'));
      const suiFeatures = Object.keys(w.features)
        .filter((f) => f.startsWith('sui:'))
        .map((f) => f.replace(/^sui:/, ''));

      const accountChains = new Set(w.accounts.flatMap((a) => [...a.chains]));

      const networksHtml = networks.map((c) => {
        const label = c.replace(/^sui:/, '');
        const isActive = accountChains.has(c);
        return `<span class="ski-network-tag${isActive ? ' active' : ''}">${esc(label)}</span>`;
      }).join('');

      const current = suiFeatures.filter((f) => !LEGACY[f]);
      const legacy = suiFeatures.filter((f) => LEGACY[f]);

      const currentHtml = current.map((f) =>
        `<a href="${DOCS}#sui${f.toLowerCase()}" target="_blank" rel="noopener" class="ski-feature-tag">${esc(f)}</a>`
      ).join('');

      const legacyHtml = legacy.map((f) =>
        `<a href="${DOCS}#sui${f.toLowerCase()}" target="_blank" rel="noopener" class="ski-feature-tag legacy" title="${esc(LEGACY[f]!)}">${esc(f)}</a>`
      ).join('');

      const retiredSection = legacy.length
        ? `<details class="ski-detail-retired"><summary class="ski-detail-label">Legacy</summary><div class="ski-feature-list">${legacyHtml}</div></details>`
        : '';

      const accountsHtml = w.accounts.length
        ? w.accounts.map((a, ai) => {
            const addr = normalizeSuiAddress(a.address);
            const scanUrl = `https://suiscan.xyz/mainnet/account/${addr}`;
            return `<div class="ski-detail-addr-wrap" data-addr-idx="${ai}" data-full-addr="${esc(addr)}">
              <span class="ski-detail-suins-slot"></span>
              <div class="ski-detail-addr-row">
                <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="ski-detail-addr-text" title="${esc(addr)}">${esc(truncAddr(addr))}</a>
                <button class="ski-copy-btn" title="Copy address">\u2398</button>
              </div>
            </div>`;
          }).join('')
        : '<div class="ski-detail-addr muted">Connect to reveal</div>';

      detailEl.innerHTML = `
        ${w.icon ? `<img src="${esc(w.icon)}" alt="" class="ski-detail-icon">` : ''}
        <div class="ski-detail-name">${esc(w.name)}</div>
        <div class="ski-detail-row"><span class="ski-detail-label">Address</span>${accountsHtml}</div>
        ${networks.length ? `<div class="ski-detail-row"><span class="ski-detail-label">Networks</span><div class="ski-feature-list">${networksHtml}</div></div>` : ''}
        ${current.length ? `<div class="ski-detail-row"><span class="ski-detail-label">Features</span><div class="ski-feature-list">${currentHtml}</div></div>` : ''}
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

      // Resolve SuiNS names: show cached immediately, then refresh
      w.accounts.forEach((a, ai) => {
        const addr = normalizeSuiAddress(a.address);
        const renderName = (name: string) => {
          const wrap = detailEl.querySelector(`[data-addr-idx="${ai}"]`);
          const slot = wrap?.querySelector('.ski-detail-suins-slot');
          if (slot) {
            const bare = name.replace(/\.sui$/, '');
            slot.innerHTML = `<a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" class="ski-detail-suins">${esc(bare)}</a>`;
          }
        };
        // Show cached name instantly
        if (suinsCache[addr]) renderName(suinsCache[addr]);
        // Always refresh from network
        lookupSuiNS(a.address).then((name: string | null) => {
          if (name) {
            suinsCache[addr] = name;
            renderName(name);
            // Upgrade dot to blue square now that SuiNS is confirmed
            updateSkiDot('blue-square', name);
          }
        });
      });

    });

  });
}

export function openModal() {
  modalOpen = true;
  renderModal();
  requestAnimationFrame(() => updateSkiDot('green-circle'));
}

function closeModal() {
  modalOpen = false;
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

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){
          address(address:$a){
            defaultNameRecord{domain}
            balance(coinType:"0x2::sui::SUI"){totalBalance}
          }
        }`,
        variables: { a: ws.address },
      }),
    });
    const json = await res.json();
    const addr = json?.data?.address;
    const mist = Number(addr?.balance?.totalBalance || 0);
    app.sui = Number.isFinite(mist) ? mist / 1e9 : 0;

    // SuiNS reverse lookup
    const name = addr?.defaultNameRecord?.domain;
    if (name && typeof name === 'string') {
      app.suinsName = name;
      try { localStorage.setItem('ski:suins-name', name); } catch {}
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

function profileHref(): string {
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

  // Disconnected: green .SKI connect button
  if (!ws.address) {
    els.wk.innerHTML = `
      <div class="wk-widget">
        <button class="wk-widget-btn" id="wallet-pill-btn" type="button" title="Connect .SKI">
          <img src="${ASSETS.logoGreen}" class="wk-widget-brand-logo" alt=".SKI" draggable="false">
        </button>
      </div>`;
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

function renderProfileButton() {
  if (!els.profileBtn) return;
  const ws = getState();

  if (!ws.address) {
    els.profileBtn.style.display = 'none';
    return;
  }

  const hasPrimary = !!app.suinsName;
  els.profileBtn.style.display = '';
  const img = els.profileBtn.querySelector('img');
  if (img) {
    img.src = hasPrimary ? './assets/blue_dotski.png' : './assets/black_dotskitxt.png';
  }
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

  const addrDisplay = app.copied ? 'Copied! \u2713' : ws.address;
  const scanUrl = `https://suiscan.xyz/mainnet/account/${ws.address}`;

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
  render();
  try { await disconnect(); } catch { /* already gone */ }
  if (reopenModal) setTimeout(openModal, 180);
}

// ─── Master render ───────────────────────────────────────────────────

function render() {
  // no-op: profile button now uses img swap
  renderWidget();
  renderProfileButton();
  renderSignStage();
  renderMenu();

  // Bind pill click
  const pill = document.getElementById('wallet-pill-btn');
  pill?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getState().address) { if (modalOpen) closeModal(); else openModal(); return; }
    window.open(profileHref(), '_blank', 'noopener,noreferrer');
  });
}

// ─── Global event bindings ───────────────────────────────────────────

function bindEvents() {
  els.profileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getState().address) return;
    if (modalOpen) { closeModal(); return; }
    app.menuOpen = !app.menuOpen;
    render();
  });

  document.addEventListener('click', (e) => {
    if (!app.menuOpen) return;
    if (els.profileBtn?.contains(e.target as Node)) return;
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
    if (ws.status === 'connected' && ws.address) {
      // Restore cached SuiNS name instantly (will refresh from network)
      try {
        const cached = localStorage.getItem('ski:suins-name');
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
      app.suinsName = '';
      app.ikaWalletId = '';
      app.menuOpen = false;
      app.copied = false;
      try { localStorage.removeItem('ski:suins-name'); localStorage.removeItem('ski:session'); } catch {}

      window.dispatchEvent(new CustomEvent('ski:wallet-disconnected'));
    }

    render();
  });

  // Re-render when new wallets are installed
  onWalletsChanged(() => {
    if (modalOpen) renderModal();
  });

  // Initial render
  render();

  // Auto-reconnect to last wallet
  autoReconnect().catch(() => {});
}
