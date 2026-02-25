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
  autoReconnect,
  onWalletsChanged,
  type WalletState,
} from './wallet.js';
import type { Wallet } from '@wallet-standard/base';

// ─── Assets ──────────────────────────────────────────────────────────

const ASSETS = {
  logoGreen: './assets/green_dotski.png',
  logoBlack: './assets/black_dotskitxt.png',
  logoBlue: './assets/blue_dotski.png',
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
  modal: document.getElementById('wk-modal'),
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

// ─── Wallet Modal ────────────────────────────────────────────────────

let modalOpen = false;

function renderModal() {
  if (!els.modal) return;
  const wallets = getSuiWallets();

  if (!modalOpen || !wallets.length) {
    els.modal.innerHTML = '';
    return;
  }

  els.modal.innerHTML = `
    <div class="wk-modal-overlay open" id="wk-modal-overlay">
      <div class="wk-modal" style="animation:wk-modal-in .2s ease">
        <div class="wk-modal-header">
          <div class="wk-modal-header-left">
            <h2 style="color:#e6ebf5;font-size:1rem;margin:0">Connect Wallet</h2>
            <p style="color:#9ca7bb;font-size:0.8rem;margin:4px 0 0">Select a wallet to connect to .SKI</p>
          </div>
          <button id="wk-modal-close" style="background:none;border:none;color:#9ca7bb;font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1">&times;</button>
        </div>
        <div style="padding:8px 16px 16px;display:flex;flex-direction:column;gap:6px">
          ${wallets.map((w, i) => `
            <button class="wk-dd-item" data-idx="${i}" style="display:flex;align-items:center;gap:10px">
              ${w.icon ? `<img src="${esc(w.icon)}" alt="" style="width:28px;height:28px;border-radius:6px">` : ''}
              <span>${esc(w.name)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  document.getElementById('wk-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('wk-modal-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'wk-modal-overlay') closeModal();
  });
  els.modal.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
      const wallet = wallets[idx];
      if (wallet) selectWallet(wallet);
    });
  });
}

export function openModal() {
  modalOpen = true;
  renderModal();
}

function closeModal() {
  modalOpen = false;
  if (els.modal) els.modal.innerHTML = '';
}

async function selectWallet(wallet: Wallet) {
  closeModal();
  try {
    await connect(wallet);
  } catch (err) {
    showToast('Failed to connect: ' + (err instanceof Error ? err.message : 'unknown error'));
  }
}

// ─── Portfolio (GraphQL balance fetch) ───────────────────────────────

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
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
        query: 'query($a:SuiAddress!){address(address:$a){balance(coinType:"0x2::sui::SUI"){totalBalance}}}',
        variables: { a: ws.address },
      }),
    });
    const json = await res.json();
    const mist = Number(json?.data?.address?.balance?.totalBalance || 0);
    app.sui = Number.isFinite(mist) ? mist / 1e9 : 0;
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
  if (app.suinsName) return 'https://' + encodeURIComponent(app.suinsName) + '.sui.ski';
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
  const label = hasSuins ? app.suinsName : truncAddr(ws.address);
  const labelClass = hasSuins ? 'wk-widget-title' : 'wk-widget-title is-address';

  // Wallet icon
  let iconHtml = '';
  if (ws.walletIcon) {
    iconHtml = `<span class="wk-widget-method-icon"><img src="${esc(ws.walletIcon)}" alt="${esc(ws.walletName)}"></span>`;
  }

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
    els.profileBtn.classList.remove('has-primary', 'no-primary');
    return;
  }

  const hasPrimary = !!app.suinsName;
  els.profileBtn.style.display = '';
  els.profileBtn.title = 'Open wallet menu';
  els.profileBtn.classList.toggle('has-primary', hasPrimary);
  els.profileBtn.classList.toggle('no-primary', !hasPrimary);

  const img = els.profileBtn.querySelector('.wallet-profile-logo') as HTMLImageElement | null;
  if (img) img.src = hasPrimary ? ASSETS.logoBlue : ASSETS.logoBlack;
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

  els.menuRoot.innerHTML = `
    <div class="wk-dropdown open">
      <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="Copy address">
        <span class="wk-dd-address-text">${esc(addrDisplay)}</span>
      </button>
      <button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>
      <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>
    </div>`;

  document.getElementById('wk-dd-copy')?.addEventListener('click', (e) => { e.stopPropagation(); copyAddress(); });
  document.getElementById('wk-dd-switch')?.addEventListener('click', () => handleDisconnect(true));
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
  els.widget?.classList.toggle('has-black-diamond', !getState().address);
  renderWidget();
  renderProfileButton();
  renderMenu();

  // Bind pill click
  const pill = document.getElementById('wallet-pill-btn');
  pill?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getState().address) { openModal(); return; }
    window.open(profileHref(), '_blank', 'noopener,noreferrer');
  });
}

// ─── Global event bindings ───────────────────────────────────────────

function bindEvents() {
  els.profileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!getState().address) return;
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
