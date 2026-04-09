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

// @ts-ignore — bun resolves JSON imports at build time
import { version as SKI_VERSION } from '../package.json';

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
import { fetchOwnedDomains, buildSubnameTx, buildRegisterSplashNsTx, buildConsolidateToUsdcTx, buildSendTx, buildSelfSwapTx, buildSwapTx, buildTransferNftTx, fetchDomainPriceUsd, checkDomainStatus, buildSetDefaultNsTx, buildSetTargetAddressTx, buildSubnameTxBytes, lookupNftOwner, buildCreateShadeOrderTx, buildExecuteShadeOrderTx, buildCancelShadeOrderTx, buildCancelRefundShadeOrderTx, buildKioskPurchaseTx, buildTradeportPurchaseTx, buildSwapAndPurchaseTx, findShadeOrder, addShadeOrder, removeShadeOrder, removeShadeOrderByDomain, pruneShadeOrders, findCreatedShadeOrderId, extractShadeOrderIdFromEffects, getShadeOrders, fetchOnChainShadeOrders, resolveSuiNSName, fetchTradeportListing, type OwnedDomain, type DomainStatusResult, type ShadeOrderInfo, type TradeportListing } from './suins.js';
import { connectShadeExecutor, scheduleShadeExecution, cancelShadeExecution, resetFailedShadeOrders, reapCancelledShadeOrder, disconnectShadeExecutor, type ShadeExecutorState, type ShadeExecutorOrder } from './client/shade.js';
import { buildSuiamiMessage, createSuiamiProof, type SuiamiProof } from './suiami.js';
import { ethToTron } from './client/chains.js';
import SKI_SVG_TEXT from '../public/assets/ski.svg';
import SUI_DROP_SVG_TEXT from '../public/assets/sui-drop.svg';
import SUI_SKI_QR_SVG_TEXT from '../public/assets/sui-ski-qr.svg';


// ─── Storage helpers (safe localStorage access) ────────────────────
function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string): void { try { localStorage.setItem(key, value); } catch {} }
function lsRemove(key: string): void { try { localStorage.removeItem(key); } catch {} }
function ssGet(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
function ssSet(key: string, value: string): void { try { sessionStorage.setItem(key, value); } catch {} }
function ssRemove(key: string): void { try { sessionStorage.removeItem(key); } catch {} }

/** iUSD has 9 decimals. */
const IUSD_MIST_PER_USD = 1_000_000_000;

// ─── Timing config ──────────────────────────────────────────────────
// All debounce/polling/timeout durations in one place.
const TOAST_ANIMATION_MS        = 180;      // toast slide-out before DOM removal
const TOAST_DISMISS_MS          = 12_000;   // auto-dismiss after this long
const ACTION_TOAST_DISMISS_MS   = 10_000;   // retry-action toast dismiss
const COPY_FEEDBACK_MS          = 2_200;    // "Copied" label reset
const COPY_ADDR_FEEDBACK_MS     = 1_800;    // address copy toast
const SWAP_QUOTE_DEBOUNCE_MS    = 500;      // delay before fetching swap quote
const TX_INDEX_WAIT_MS          = 2_000;    // wait for on-chain tx indexing
const PORTFOLIO_REFRESH_SHORT_MS = 1_200;   // quick balance refresh after tx
const PORTFOLIO_REFRESH_MED_MS  = 2_000;    // medium balance refresh after tx
const PORTFOLIO_REFRESH_LONG_MS = 5_000;    // delayed balance refresh after tx
const TOKEN_PRICE_CACHE_TTL_MS  = 3_600_000; // 1 hour — token price localStorage cache
const TOKEN_PRICE_STALE_MS      = 5 * 60 * 1000; // 5 min — refetch threshold
const OWNED_DOMAINS_CACHE_MS    = 10 * 60 * 1000; // 10 min — nsOwnedDomains refresh
const THUNDER_POLL_MS           = 5_000;    // thunder signal count polling
const NFT_POPOVER_HIDE_MS       = 300;      // delay before hiding NFT popover
const SHADE_COUNTDOWN_MS        = 1_000;    // shade chip countdown tick
const DROPDOWN_DISMISS_MS       = 150;      // @ autocomplete dropdown blur dismiss
const HYDRATING_SAFETY_MS       = 1_500;    // max wait for hydration before proceeding
const LONG_PRESS_MS             = 2_200;    // long-press to open suiscan
const ADDR_RESTORE_MS           = 1_200;    // address restore after DOM update
const MODAL_REOPEN_MS           = 180;      // modal reopen after disconnect

/** Sign a sponsored transaction: user signs, then fetch sponsor sig, submit both.
 *  Falls back to signAndExecuteTransaction for WaaP (signTransaction is broken). */
async function signAndExecuteSponsoredTx(txBytes: Uint8Array): Promise<{ digest: string }> {
  // WaaP: signTransaction is broken (iframe re-serialization), skip sponsorship
  const ws = getState();
  if (/waap/i.test(ws.walletName || '')) {
    return signAndExecuteTransaction(txBytes);
  }
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
const BTC_ICON_SVG = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#f7931a" stroke="white" stroke-width="2.5"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">\u20BF</text></svg>`;
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
  if (/waap/i.test(walletName)) {
    const ws = getState();
    if (ws.address) return waapProviderIcon(ws.address);
    return null;
  }
  if (/google/i.test(walletName)) return SOCIAL_ICON_GOOGLE;
  if (/discord/i.test(walletName)) return SOCIAL_ICON_DISCORD;
  return null;
}

/** Detect which social provider a WaaP account used. Checks label first, then localStorage keys. */
function detectWaapProvider(label: string): 'google' | 'x' | 'email' | 'phone' | 'discord' | 'github' | null {
  // Check label first
  if (label) {
    if (/google/i.test(label) || /@gmail\./i.test(label)) return 'google';
    if (/^@/.test(label.trim()) || /x\.com|twitter/i.test(label)) return 'x';
    if (/discord/i.test(label)) return 'discord';
    if (/github/i.test(label)) return 'github';
    if (/^\+?\d[\d\s()-]{6,}$/.test(label.trim())) return 'phone';
    if (/@/.test(label)) return 'email';
  }
  // Fallback: scan localStorage for OAuth provider clues left by WaaP
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = (localStorage.key(i) || '').toLowerCase();
      if (key.startsWith('ski:')) continue;
      const val = (localStorage.getItem(localStorage.key(i)!) || '').toLowerCase();
      if (key.includes('google') || val.includes('google') || val.includes('accounts.google')) return 'google';
      if (key.includes('twitter') || val.includes('twitter') || val.includes('api.x.com')) return 'x';
      if (key.includes('discord') || val.includes('discord')) return 'discord';
      if (key.includes('github') || val.includes('github')) return 'github';
    }
  } catch {}
  return null;
}

/** Persist the detected WaaP social provider for a given address. */
function storeWaapProvider(address: string, provider: 'google' | 'x' | 'email' | 'phone' | null): void {
  if (!provider || !address) return;
  try { localStorage.setItem(`ski:waap-provider:${address}`, provider); } catch {}
}

/** Get a small inline SVG for the WaaP provider badge (14x14) */
function _waapProviderBadgeSvg(address: string | null): string {
  if (!address) return '';
  try {
    const stored = localStorage.getItem(`ski:waap-provider:${address}`);
    if (stored === 'google') return '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';
    if (stored === 'x') return '<svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
    if (stored === 'discord') return '<svg width="24" height="24" viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>';
    if (stored === 'email' || stored === 'phone') return '<svg width="24" height="18" viewBox="0 0 24 18" fill="none" stroke="white" stroke-width="2"><rect x="1" y="1" width="22" height="16" rx="2"/><polyline points="1,1 12,10 23,1"/></svg>';
  } catch {}
  return '';
}

/** Return the social provider icon SVG for a WaaP address. Falls back to WaaP icon (not X). */
function waapProviderIcon(address: string | null): string {
  if (address) {
    try {
      const stored = localStorage.getItem(`ski:waap-provider:${address}`);
      if (stored === 'google') return SOCIAL_ICON_GOOGLE;
      if (stored === 'x') return SOCIAL_ICON_X;
      if (stored === 'discord') return SOCIAL_ICON_DISCORD;
      if (stored === 'email' || stored === 'phone' || stored === 'github') return SOCIAL_ICON_EMAIL;
    } catch {}
    // No stored provider — try live detection from localStorage OAuth keys
    const detected = detectWaapProvider('');
    if (detected === 'google') return SOCIAL_ICON_GOOGLE;
    if (detected === 'x') return SOCIAL_ICON_X;
    if (detected === 'discord') return SOCIAL_ICON_DISCORD;
    if (detected) return SOCIAL_ICON_EMAIL;
  }
  // Unknown provider — return WaaP's own icon (don't assume X)
  return `<svg width="30" height="30" viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg"><rect width="38" height="38" rx="8" fill="#6366f1"/><text x="19" y="24" text-anchor="middle" fill="white" font-size="16" font-weight="700" font-family="system-ui">W</text></svg>`;
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
  solAddress: string;
  solBalance: number;
  skiMenuOpen: boolean;
  copied: boolean;
  splashSponsor: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
  stableUsd: 0,
  nsBalance: 0,
  suinsName: (() => { try { const a = getState().address || localStorage.getItem('ski:last-address') || ''; return a ? (localStorage.getItem(`ski:suins:${a}`) || '') : ''; } catch { return ''; } })(),
  ikaWalletId: (() => { try { const a = getState().address || localStorage.getItem('ski:last-address') || ''; return a ? (localStorage.getItem(`ski:has-ika:${a}`) || '') : ''; } catch { return ''; } })(),
  btcAddress: (() => { try { const a = getState().address || localStorage.getItem('ski:last-address') || ''; if (!a) return ''; const c = localStorage.getItem(`ski:ika-addrs:${a}`); return c ? (JSON.parse(c).btc || '') : ''; } catch { return ''; } })(),
  ethAddress: (() => { try { const a = getState().address || localStorage.getItem('ski:last-address') || ''; if (!a) return ''; const c = localStorage.getItem(`ski:ika-addrs:${a}`); return c ? (JSON.parse(c).eth || '') : ''; } catch { return ''; } })(),
  solAddress: (() => { try { const a = getState().address || localStorage.getItem('ski:last-address') || ''; if (!a) return ''; const c = localStorage.getItem(`ski:ika-addrs:${a}`); return c ? (JSON.parse(c).sol || '') : ''; } catch { return ''; } })(),
  solBalance: 0,
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
  // All toasts use copyable behavior: first click copies, second dismisses
  if (isHtml) {
    // HTML toasts (rare) — still use copyable with raw text extraction
    showCopyableToast(text, text.replace(/<[^>]*>/g, ''));
  } else {
    showCopyableToast(text, text);
  }
}

const _addrRestoreTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Toggle-select an address row: highlight with chain color, deselect others, copy + flash "Copied ✓". */
function toggleAddrRow(el: HTMLElement, fullAddr: string, color: string) {
  const isSelected = el.getAttribute('data-addr-selected') === '1';
  // Deselect all siblings — restore any stuck "Copied ✓" immediately
  const parent = el.parentElement;
  if (parent) {
    parent.querySelectorAll('[data-addr-selected="1"]').forEach(sib => {
      const s = sib as HTMLElement;
      s.style.removeProperty('--addr-sel-bg');
      s.style.removeProperty('--addr-sel-color');
      s.removeAttribute('data-addr-selected');
      // Restore original HTML if it was showing "Copied ✓"
      const orig = s.getAttribute('data-orig-html');
      if (orig) { s.innerHTML = orig; s.removeAttribute('data-orig-html'); }
      const timer = _addrRestoreTimers.get(s);
      if (timer) { clearTimeout(timer); _addrRestoreTimers.delete(s); }
    });
  }
  if (isSelected) return; // was selected → now deselected
  // Select this row
  el.setAttribute('data-addr-selected', '1');
  el.style.setProperty('--addr-sel-bg', `${color}25`);
  el.style.setProperty('--addr-sel-color', color);
  navigator.clipboard.writeText(fullAddr).catch(() => {});
  // Flash "Copied ✓" then restore
  const origHtml = el.getAttribute('data-orig-html') || el.innerHTML;
  el.setAttribute('data-orig-html', origHtml);
  const iconEl = el.querySelector('img, .ski-idle-addr-icon, .ski-idle-addr-icon--inline');
  if (iconEl) {
    el.innerHTML = `${(iconEl as HTMLElement).outerHTML} Copied <span style="color:${color}">\u2713</span>`;
  } else {
    const label = (el.textContent || '').split(' ')[0] || '';
    el.innerHTML = `${label} Copied <span style="color:${color}">\u2713</span>`;
  }
  _addrRestoreTimers.set(el, setTimeout(() => {
    el.innerHTML = origHtml;
    el.removeAttribute('data-orig-html');
    _addrRestoreTimers.delete(el);
  }, ADDR_RESTORE_MS));
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
  hint.textContent = 'click to copy';
  toast.appendChild(hint);

  root.appendChild(toast);
  requestAnimationFrame(() => document.getElementById(id)?.classList.add('show'));

  let copied = false;
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), TOAST_ANIMATION_MS); };
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
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), TOAST_ANIMATION_MS); };
  setTimeout(remove, TOAST_DISMISS_MS);
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
  const remove = () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), TOAST_ANIMATION_MS); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); remove(); retryFn(); });
  setTimeout(remove, ACTION_TOAST_DISMISS_MS); // longer window for action toasts
  toast.addEventListener('click', remove);
}

// ─── SKI SVG dot variant ─────────────────────────────────────────────

let _skiSvgText: string | null = SKI_SVG_TEXT;

type SkiDotVariant = 'green-circle' | 'blue-square' | 'black-diamond' | 'red-hexagon' | 'orange-triangle';

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
async function _getAddrQrSvg(addr: string, mode: 'sui' | 'usd' | 'bw' | 'btc' | 'sol' = 'sui'): Promise<string> {
  const dark = mode === 'btc' ? '#f7931a' : mode === 'sol' ? '#9945FF' : mode === 'usd' ? '#4ade80' : mode === 'bw' ? '#ffffff' : '#60a5fa';
  // Solana QR uses purple modules (#9945FF) with the gradient logo in center
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
    } else if (mode === 'sol') {
      // Solana official gradient #00FFA3 → #DC1FFF with real parallelogram paths
      const s = br * 2;
      const ox = cx - br;
      const oy = cy - br;
      logoSvg = `<defs><linearGradient id="qr-sol-g" x1="0.59" y1="0.18" x2="0.29" y2="0.74" gradientUnits="objectBoundingBox"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient></defs><circle cx="${cx}" cy="${cy}" r="${br + 1}" fill="#0B1022"/><g transform="translate(${ox},${oy}) scale(${s / 48})"><path d="M32.437 21.745a.47.47 0 00-.577-.245H11.909c-.364 0-.546.45-.289.714l3.943 4.041a.47.47 0 00.577.245H36.091c.364 0 .546-.451.289-.714l-3.943-4.041z" fill="url(#qr-sol-g)"/><path d="M15.563 29.268a.47.47 0 01.576-.244h19.952c.364 0 .546.449.289.711l-3.943 4.022a.47.47 0 01-.576.243H11.909c-.364 0-.546-.449-.289-.711l3.943-4.021z" fill="url(#qr-sol-g)"/><path d="M15.563 14.244A.47.47 0 0116.139 14h19.952c.364 0 .546.449.289.711l-3.943 4.021a.47.47 0 01-.576.244H11.909c-.364 0-.546-.449-.289-.711l3.943-4.021z" fill="url(#qr-sol-g)"/></g>`;
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

/** In-memory thunder encryption key — derived from lockin signature. Only the private key holder can produce this. */
let _thunderCryptoKey: CryptoKey | null = null;

/** Derive the thunder AES key from a lockin signature. */
async function _deriveThunderKeyFromSig(signature: string): Promise<CryptoKey> {
  const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', sigBytes);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The deterministic lockin message — no nonce, so the same wallet always produces the same signature → same thunder key. */
function _thunderLockinMessage(address: string): string {
  return [`Lock in`, '', address].join('\n');
}

async function lockInIdentity(): Promise<void> {
  const ws = getState();
  if (ws.status !== 'connected' || !ws.address) return;
  const name = app.suinsName
    ? app.suinsName.replace(/\.sui$/, '') + '.sui'
    : truncAddr(ws.address);
  // Deterministic message — no random nonce. The signature is the thunder
  // encryption key seed, so it must be reproducible across sessions.
  const message = _thunderLockinMessage(ws.address);
  try {
    const result = await signPersonalMessage(new TextEncoder().encode(message));
    // Derive thunder encryption key from signature — only this wallet can produce it
    _thunderCryptoKey = await _deriveThunderKeyFromSig(result.signature);
    // Detect WaaP auth method from account label
    const isWaap = /waap/i.test(ws.walletName || '');
    const waapProvider = isWaap && ws.account?.label
      ? detectWaapProvider(ws.account.label)
      : null;
    // Cache proof locally (7-day expiry)
    const issuedAt = new Date().toISOString();
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
    // Decrypt conversations now that we have the key (card stays closed until clicked)
    _refreshThunderLocalCounts();
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

      // Path 2: Restore OAuth snapshot so WaaP can find its session for signing
      if (proof.oauthSnapshot) {
        restoreWaapOAuth(proof.oauthSnapshot);
      }
      closeModal();
      deactivateCurrent();
      try {
        await connect(wallet);
        return;
      } catch (err) {
        showToast('Reconnecting: ' + _errMsg(err));
        // Silent connect failed — fall through to OAuth modal
      }
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
// One-time purge of stale coin caches (NS decimals/balance were incorrectly cached)
try {
  if (!localStorage.getItem('ski:dec:v4')) {
    localStorage.removeItem('ski:decimals');
    localStorage.removeItem('ski:coin-meta');
    localStorage.removeItem('ski:token-prices');
    // Also purge any per-address balance caches
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('ski:balances:')) localStorage.removeItem(k);
    }
    localStorage.setItem('ski:dec:v4', '1');
  }
} catch {}
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
  // Any stable coin (iUSD, AUSD, etc.) is 1:1 with USD
  const coin = walletCoins.find(c => c.symbol === sym);
  if (coin?.isStable) return usdVal;
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
  }, SWAP_QUOTE_DEBOUNCE_MS);
}

function _isStableCoin(coinType: string): boolean {
  const name = coinShortName(coinType).toUpperCase();
  return name === 'USDC' || name === 'USDT' || name === 'DAI' || name === 'AUSD' || name === 'BUCK' || name === 'USDY' || name === 'IUSD';
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
let networkView: 'sui' | 'btc' | 'sol' = (() => {
  try { return (localStorage.getItem('ski:network-pref') as 'sui' | 'btc' | 'sol') || 'sui'; } catch { return 'sui'; }
})();

let _networkSelectOpen = false;
const _NETWORK_ICON_SUI = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17" fill="#4da2ff" stroke="white" stroke-width="3"/><g transform="translate(20,20) scale(0.065)" fill="white"><path d="M-85-85C-50-130 0-100 0-70C0-40-50-50-50-20C-50 10 0 0 40-30" stroke="white" stroke-width="30" fill="none" stroke-linecap="round"/></g></svg>`;
const _NETWORK_ICON_BTC = BTC_ICON_SVG;
const SOL_ICON_SVG = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#0B1022" stroke="white" stroke-width="2.5"/><g transform="translate(-0.5,0.5) scale(0.85)"><path d="M32.437 21.745a.47.47 0 00-.577-.245H11.909c-.364 0-.546.45-.289.714l3.943 4.041a.47.47 0 00.577.245H36.091c.364 0 .546-.451.289-.714l-3.943-4.041z" fill="url(#sol1)"/><path d="M15.563 29.268a.47.47 0 01.576-.244h19.952c.364 0 .546.449.289.711l-3.943 4.022a.47.47 0 01-.576.243H11.909c-.364 0-.546-.449-.289-.711l3.943-4.021z" fill="url(#sol2)"/><path d="M15.563 14.244A.47.47 0 0116.139 14h19.952c.364 0 .546.449.289.711l-3.943 4.021a.47.47 0 01-.576.244H11.909c-.364 0-.546-.449-.289-.711l3.943-4.021z" fill="url(#sol3)"/></g><defs><linearGradient id="sol1" x1="28.4" y1="8.49" x2="14.03" y2="35.32" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient><linearGradient id="sol2" x1="28.4" y1="8.51" x2="14.14" y2="35.27" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient><linearGradient id="sol3" x1="28.4" y1="8.51" x2="14.14" y2="35.27" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient></defs></svg>`;
const _NETWORK_OPTIONS: Array<{ key: 'sui' | 'btc' | 'sol'; label: string; icon: string }> = [
  { key: 'sui', label: 'Sui', icon: `<img src="${SUI_DROP_URI}" class="wk-dd-address-network-icon" alt="Sui">` },
  { key: 'btc', label: 'Bitcoin', icon: `<img src="${BTC_ICON_URI}" class="wk-dd-address-network-icon" alt="BTC">` },
  { key: 'sol', label: 'Solana', icon: `<span class="wk-dd-address-network-icon">${SOL_ICON_SVG}</span>` },
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
const _COINGECKO_IDS: Record<string, string> = { NS: 'suins-token', WAL: 'walrus-2', DEEP: 'deep', XAUM: 'matrixdock-gold', IKA: 'ika', SOL: 'solana' };
// Conservative default prices so dust filtering works before live prices arrive.
// These are intentionally LOW — better to undervalue and filter dust than overvalue and show it.
const _DEFAULT_TOKEN_PRICES: Record<string, number> = { NS: 0.018, WAL: 0.069, DEEP: 0.026, XAUM: 4492, IKA: 0.003, SOL: 82 };
let tokenPriceCache: Record<string, { price: number; fetchedAt: number }> = (() => {
  try {
    const raw = localStorage.getItem('ski:token-prices');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, { price: number; fetchedAt: number }>;
      // Filter out stale entries (> 1 hour)
      const now = Date.now();
      for (const k of Object.keys(parsed)) {
        if (!parsed[k]?.price || now - parsed[k].fetchedAt > TOKEN_PRICE_CACHE_TTL_MS) delete parsed[k];
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
  const stale = Object.keys(_COINGECKO_IDS).filter(s => !tokenPriceCache[s] || now - tokenPriceCache[s].fetchedAt > TOKEN_PRICE_STALE_MS);
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
    if (tokenPriceCache[symbol] && now - tokenPriceCache[symbol].fetchedAt < TOKEN_PRICE_STALE_MS) continue;
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
  if (suiPriceCache && now - suiPriceCache.fetchedAt < TOKEN_PRICE_STALE_MS) return suiPriceCache.price;

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

/** Fetch SOL balance for the IKA dWallet Solana address. Races multiple Solana RPCs. */
async function _fetchSolBalance(): Promise<void> {
  if (!app.solAddress) return;
  const endpoints = [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
  ];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [app.solAddress] });
  try {
    const result = await Promise.any(
      endpoints.map(url =>
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          .then(r => r.json())
          .then((data: any) => {
            const lamports = data?.result?.value;
            if (typeof lamports !== 'number') throw new Error('no balance');
            return lamports;
          })
      ),
    );
    app.solBalance = result / 1e9;
  } catch { /* non-blocking */ }
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
    // gRPC for all balances + SUI price + token prices + SuiNS + SOL balance in parallel
    const [allBalResult, suinsName, suiPrice] = await Promise.all([
      grpcClient.core.listBalances({ owner: fetchedFor }).catch(() => null),
      lookupSuiNS(fetchedFor),
      fetchSuiPrice(),
      fetchTokenPrices(),
      _fetchSolBalance(),
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
    // Include Solana balance in total
    const solPrice = getTokenPrice('SOL');
    const solUsd = (solPrice && app.solBalance > 0) ? app.solBalance * solPrice : 0;
    if (suiUsd != null) {
      app.usd = suiUsd + app.stableUsd + tokensUsd + solUsd;
    } else if (app.usd == null) {
      app.usd = app.stableUsd + tokensUsd + solUsd > 0 ? app.stableUsd + tokensUsd + solUsd : null;
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
    copiedTimer = setTimeout(() => { app.copied = false; copiedTimer = null; render(); }, COPY_FEEDBACK_MS);
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

  // During hydration the shell cache already shows the correct profile —
  // skip re-render to avoid a flash (icon reload, layout shift).
  if (_hydrating && el.innerHTML.length > 0) return;

  // Connected: [icon(s)] [name/addr] [balance]
  const hasSuins = !!app.suinsName;
  const label = hasSuins ? app.suinsName.replace(/\.sui$/, '') : truncAddr(ws.address);
  const labelClass = hasSuins ? 'wk-widget-title' : 'wk-widget-title is-address';

  // Wallet icon + optional social badge (badge is a sibling, not inside the clipped icon span)
  let iconHtml = '';
  if (ws.walletIcon) {
    const social = socialIconSvg(ws.walletName);
    const isWaap = /waap/i.test(ws.walletName || '');
    const badgeSvg = isWaap ? _waapProviderBadgeSvg(ws.address) : '';
    const badge = isWaap
      ? `<span class="ski-waap-x ski-waap-x--picker" data-provider-picker title="Change login method">${badgeSvg || '?'}</span>`
      : social ? `<span class="ski-waap-x">𝕏</span>` : '';
    iconHtml = `<span class="wk-widget-icon-wrap"><span class="wk-widget-method-icon${social || isWaap ? ' wk-widget-method-icon--social' : ''}"><img src="${esc(ws.walletIcon)}" alt="${esc(ws.walletName)}"></span>${badge}</span>`;
  }

  // IKA status populated from on-chain query, not localStorage

  const skiUrl = hasSuins ? `https://${esc(label)}.sui.ski` : '';
  const innerHtml = `${iconHtml}
        <span class="wk-widget-label-wrap">
          <span class="${labelClass}">
            <span class="wk-widget-primary-name">${esc(label)}<span style="display:inline-block;width:1.1em;text-align:center${app.ikaWalletId ? '' : ';visibility:hidden'}">\ud83e\udd91</span></span>
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

  // During hydration the shell cache is already correct — skip re-render
  if (_hydrating && el.innerHTML.length > 0) return;

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
  if (_hydrating && el.innerHTML.length > 0) return;
  el.style.display = '';
  const variant: SkiDotVariant = app.suinsName ? 'blue-square' : 'black-diamond';
  el.innerHTML = modalOpen ? _shapeWithDropSvg(variant, 31) : _shapeOnlySvg(variant, 31);
}

/**
 * Measure header buttons BEFORE compact is applied, decide once, latch.
 * Removes compact first so we measure at full size, then re-applies if needed.
 * Only re-measures on resize — never on render (avoids feedback loop).
 */
let _compactLatched: boolean | null = null;
function _measureCompact() {
  const header = document.querySelector('.ski-header') as HTMLElement | null;
  const wallet = document.getElementById('ski-wallet');
  if (!header || !wallet) return;
  // Remove compact to measure at full size
  header.classList.remove('ski-header--compact');
  requestAnimationFrame(() => {
    // Measure just the 3 buttons (dot + profile + balance) inside ski-wallet
    const btns = wallet.querySelectorAll('.ski-btn, .wk-widget');
    let totalW = 0;
    for (const btn of btns) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) totalW += r.width;
    }
    const gap = parseFloat(getComputedStyle(wallet).gap || '0');
    const visible = Array.from(btns).filter(b => b.getBoundingClientRect().width > 0).length;
    totalW += gap * Math.max(0, visible - 1);
    _compactLatched = window.innerWidth < totalW * 1.3;
    header.classList.toggle('ski-header--compact', _compactLatched);
  });
}
window.addEventListener('resize', _measureCompact);

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
  // Measure once on first render, then only on resize
  if (_compactLatched === null) _measureCompact();
  else {
    const header = document.querySelector('.ski-header');
    header?.classList.toggle('ski-header--compact', _compactLatched);
  }
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
let nsLabel = (() => {
  try {
    // Prefer user's primary SuiNS name
    const ws = getState();
    if (ws.address) {
      const cached = localStorage.getItem(`ski:suins:${ws.address}`);
      if (cached) return cached.replace(/\.sui$/, '');
    }
    // Fall back to saved label — but only if it was a taken/owned name, not a mintable one
    const saved = localStorage.getItem('ski:ns-label') || '';
    const savedAvail = sessionStorage.getItem('ski:ns-resolve');
    const wasAvailable = savedAvail ? JSON.parse(savedAvail)?.avail === 'available' : false;
    if (saved && !wasAvailable) return saved;
    // No primary name → default based on wallet type
    if (ws.walletName && /waap/i.test(ws.walletName)) return 'waap';
    return 'iusd';
  } catch { return 'iusd'; }
})();
const NS_LOOKUP_DEBOUNCE_MS = 450;   // delay after last keystroke before querying
const NS_LOOKUP_POLL_MS     = 15_000; // periodic recheck interval for active label

let nsPriceUsd: number | null = null;
let nsPriceFetchFor = '';
let nsPriceDebounce: ReturnType<typeof setTimeout> | null = null;
let _nsValidityInterval: ReturnType<typeof setInterval> | null = null;
let nsAvail: null | 'available' | 'taken' | 'owned' | 'grace' = null;
let nsGraceEndMs = 0;
let nsTargetAddress: string | null = null; // resolved address for the current label (if registered)
let nsNftOwner: string | null = null; // NFT owner address (fallback when targetAddress is null)
// Restore cached resolution state for instant overlay render on refresh
try {
  const _rc = sessionStorage.getItem('ski:ns-resolve');
  if (_rc) {
    const _cached = JSON.parse(_rc);
    if (_cached.label && _cached.avail) {
      nsPriceFetchFor = _cached.label;
      nsAvail = _cached.avail;
      nsTargetAddress = _cached.target ?? null;
    }
  }
} catch {}
let nsLastDigest = ''; // digest from last successful registration; shown in route area
let nsSubnameParent: OwnedDomain | null = null; // when set, we're in subname-creation mode
let nsShowTargetInput = false; // target-address inline editor open
let nsNewTargetAddr = ''; // value in the target-address input
let nsTransferInputOpen = false; // transfer-recipient inline editor open
let nsTransferRecipient = ''; // value in the transfer-recipient input
// Thunder counts disabled — pending v4 migration (#63). Always empty.
let _thunderCounts: Record<string, number> = {};
let _thunderLocalCounts: Record<string, number> = {}; // total signals per counterparty from local log
let _thunderPollTimer: ReturnType<typeof setInterval> | null = null;
let _thunderDecryptBusy = false;
let _thunderConvoTarget = ''; // current conversation counterparty (prevents re-render flicker)
let _thunderConvoOpen = (() => {
  // Default closed — only open when user explicitly clicks Thunder
  try {
    return localStorage.getItem('ski:thunder-card-open') === '1';
  } catch { return false; }
})();

const _selectedThunderTs = new Set<number>();

/** Aggregate pending (on-chain, not yet decrypted) signal count across ALL owned names */
function _totalThunderCount(): number {
  let total = 0;
  for (const d of nsOwnedDomains) {
    if (d.kind !== 'nft') continue;
    const bare = d.name.replace(/\.sui$/, '').toLowerCase();
    total += _thunderCounts[bare] ?? 0;
  }
  return total;
}

/** Update the idle overlay thunder send button badge */
function _updateIdleThunderBadge(): void {
  if (!_idleOverlay) return;
  const sendBtn = _idleOverlay.querySelector('#ski-idle-thunder-send') as HTMLButtonElement | null;
  if (!sendBtn) return;
  const total = _totalThunderCount();
  if (total > 0) {
    sendBtn.innerHTML = `\u26c8\ufe0f<span class="ski-idle-thunder-count">${total}</span>`;
    sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send ski-idle-thunder-send--quest';
    sendBtn.title = `Quest ${total} signal${total > 1 ? 's' : ''} across all names`;
    sendBtn.dataset.questMode = '1';
    sendBtn.dataset.questAll = '1';
    sendBtn.disabled = false;
  } else if (sendBtn.dataset.questAll === '1') {
    sendBtn.innerHTML = '\u26a1';
    sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send';
    sendBtn.title = 'Open Storm';
    delete sendBtn.dataset.questMode;
    delete sendBtn.dataset.questAll;
    sendBtn.disabled = false;
  }
}

/** Recompute _thunderLocalCounts from the encrypted log.
 *  Groups by address when available so conversations persist across SuiNS name changes.
 *  Falls back to name-based grouping for entries without an addr field. */
async function _refreshThunderLocalCounts() {
  const ws = getState();
  if (!ws.address) { _thunderLocalCounts = {}; return; }
  try {
    const all = await _readThunderLog();
    const counts: Record<string, number> = {};
    // Build addr→name mapping (most recent name wins)
    const addrToName: Record<string, string> = {};
    for (const e of all) {
      const peer = ((e.dir === 'out' || (!e.dir && !e.from)) ? (e.to || '') : (e.from || '')).replace(/\.sui$/, '').toLowerCase();
      if (peer && e.addr) addrToName[e.addr.toLowerCase()] = peer;
    }
    for (const e of all) {
      let peer = ((e.dir === 'out' || (!e.dir && !e.from)) ? (e.to || '') : (e.from || '')).replace(/\.sui$/, '').toLowerCase();
      // Normalize to most recent name for this address
      if (e.addr) {
        const canonical = addrToName[e.addr.toLowerCase()];
        if (canonical) peer = canonical;
      }
      if (peer) counts[peer] = (counts[peer] ?? 0) + 1;
    }
    _thunderLocalCounts = counts;
  } catch { _thunderLocalCounts = {}; }
}

/** Toggle card + conversation open/closed. */
function _toggleThunderConvo() {
  const convoEl = document.getElementById('wk-thunder-convo');
  const cardEl = document.getElementById('ski-nft-inline');
  const quickBtn = document.getElementById('wk-thunder-quick');
  if (!convoEl) return;
  _thunderConvoOpen = !_thunderConvoOpen;
  if (_thunderConvoOpen) {
    if (cardEl) cardEl.removeAttribute('hidden');
    convoEl.removeAttribute('hidden');
    quickBtn?.classList.add('wk-thunder-quick--active');
    const cardDomain = cardEl?.dataset.domain;
    if (cardDomain) _renderConversation(cardDomain);
  } else {
    convoEl.setAttribute('hidden', '');
    if (cardEl) cardEl.setAttribute('hidden', '');
    quickBtn?.classList.remove('wk-thunder-quick--active');
  }
  try { localStorage.setItem('ski:thunder-card-open', _thunderConvoOpen ? '1' : '0'); } catch {}
}

/** Render the conversation view for a counterparty in the thunder received area. */
async function _renderConversation(counterparty: string, force = false) {
  const bare = counterparty.replace(/\.sui$/, '').toLowerCase();
  if (!bare) return;

  const entries = await _getConversation(bare);

  // Re-query DOM after async — elements may have been rebuilt by renderSkiMenu
  const receivedEl = document.getElementById('wk-thunder-received');
  const thunderRowEl = document.getElementById('wk-thunder-convo');
  if (!receivedEl || !thunderRowEl) return;

  const rows = entries.map(e => {
    const isOut = e.dir === 'out' || (!e.dir && !e.from && !e.msg.startsWith('\u26a1 from'));
    const sender = isOut ? '' : (e.from || '').replace(/\.sui$/, '');
    const cls = isOut ? 'wk-thunder-bubble--out' : 'wk-thunder-bubble--in';
    const readCls = isOut && e.read ? ' wk-thunder-bubble--read' : '';
    const selCls = _selectedThunderTs.has(e.ts) ? ' wk-thunder-bubble--selected' : '';
    let msgText = e.msg;
    if (!isOut && !e.dir) {
      msgText = msgText.replace(/^\u26a1 from [^:]+:\s*/, '');
    }
    const label = isOut ? '' : (sender ? `<span class="wk-thunder-bubble-sender" data-sender="${esc(sender)}">${esc(sender)}</span> ` : '');
    // Render @mentions as clickable
    const msgHtml = esc(msgText).replace(/@([a-z0-9-]{3,63})(\.sui)?/gi, (_, name) => {
      const bare = name.toLowerCase();
      return `<span class="wk-thunder-mention" data-mention="${bare}">@${bare}</span>`;
    });
    return `<div class="wk-thunder-bubble ${cls}${readCls}${selCls}" data-ts="${e.ts}">${label}<span class="wk-thunder-bubble-msg">${msgHtml}</span><span class="wk-thunder-bubble-copy" data-copy="${esc(msgText)}" title="Copy">\u2398</span></div>`;
  }).join('');

  const deleteBtn = _selectedThunderTs.size > 0
    ? `<button class="wk-thunder-delete-btn" id="wk-thunder-delete" type="button">\u2715 ${_selectedThunderTs.size}</button>`
    : '';

  receivedEl.innerHTML = rows + deleteBtn;

  // Show decrypt bar OR reply input — never both
  const unquestedEl = document.getElementById('wk-thunder-unquested');
  const replyWrap = document.getElementById('wk-thunder-reply-wrap');
  const _questDomain = document.getElementById('ski-nft-inline')?.dataset.domain?.toLowerCase() || bare;
  const unquestedCount = _thunderCounts[_questDomain] ?? 0;
  // Strike is disabled pending Thunder v4 migration (#63) — always show reply input
  if (unquestedEl) unquestedEl.setAttribute('hidden', '');
  if (replyWrap) replyWrap.removeAttribute('hidden');

  _thunderConvoTarget = bare;
  try { localStorage.setItem('ski:thunder-card-open', '1'); } catch {}
  try { sessionStorage.setItem('ski:thunder-convo', bare); } catch {}
  receivedEl.scrollTop = receivedEl.scrollHeight;

  // Bind bubble click → toggle selection
  receivedEl.querySelectorAll('.wk-thunder-bubble').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const ts = Number((el as HTMLElement).dataset.ts);
      if (_selectedThunderTs.has(ts)) _selectedThunderTs.delete(ts);
      else _selectedThunderTs.add(ts);
      _renderConversation(bare, true);
    });
  });

  // Bind sender name click → populate input
  receivedEl.querySelectorAll('.wk-thunder-bubble-sender').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sender = (el as HTMLElement).dataset.sender;
      if (!sender) return;
      nsLabel = sender;
      const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (inp) inp.value = sender;
      skipNextFocusClear = true;
      fetchAndShowNsPrice(sender);
      _updateSendBtnMode();
    });
  });

  // Bind copy button on bubbles
  receivedEl.querySelectorAll('.wk-thunder-bubble-copy').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const text = (el as HTMLElement).dataset.copy || '';
      navigator.clipboard.writeText(text).then(() => showToast('Copied')).catch(() => {});
    });
  });

  // Bind @mention click → populate input + add as contact
  receivedEl.querySelectorAll('.wk-thunder-mention').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = (el as HTMLElement).dataset.mention;
      if (!name) return;
      nsLabel = name;
      const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (inp) inp.value = name;
      skipNextFocusClear = true;
      _addThunderContact(name);
      fetchAndShowNsPrice(name);
      _updateSendBtnMode();
    });
  });

  // Bind delete button
  document.getElementById('wk-thunder-delete')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (_selectedThunderTs.size === 0) return;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '\u2026';

    // Check if any selected entries are unquested incoming signals (still on-chain)
    // For now, all displayed entries are already quested (decrypted from Struck events)
    // or sent by us — so we just delete from local log

    const ws = getState();
    if (!ws.address) return;
    const key = await _deriveThunderKey(ws.address);
    const storageKey = `ski:thunder-log:${ws.address}`;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const { ct, iv } = JSON.parse(raw);
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
          key,
          Uint8Array.from(atob(ct), c => c.charCodeAt(0)),
        );
        let all: ThunderLogEntry[] = JSON.parse(new TextDecoder().decode(plaintext));
        all = all.filter(entry => !_selectedThunderTs.has(entry.ts));
        // Re-encrypt
        const updated = new TextEncoder().encode(JSON.stringify(all));
        const newIv = crypto.getRandomValues(new Uint8Array(12));
        const newCt = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, key, updated));
        localStorage.setItem(storageKey, JSON.stringify({ ct: btoa(String.fromCharCode(...newCt)), iv: btoa(String.fromCharCode(...newIv)) }));
      }
    } catch {}

    const count = _selectedThunderTs.size;
    _selectedThunderTs.clear();
    _thunderConvoTarget = '';
    await _refreshThunderLocalCounts();
    _renderConversation(bare, true);
    _syncNftCardToInput();
    showToast(`\u26a1 ${count} signal${count > 1 ? 's' : ''} deleted`);
  });

  // Bind Quest button — decrypt unquested on-chain signals for the CARD domain (our owned name)
  document.getElementById('wk-thunder-quest')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (_thunderDecryptBusy) return;
    _thunderDecryptBusy = true;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '\u2026';
    try {
      // Quest signals on the card's domain (our owned name), not the conversation counterparty
      const cardDomain = document.getElementById('ski-nft-inline')?.dataset.domain?.toLowerCase() || '';
      if (!cardDomain) { showToast('No card domain'); return; }
      // Receipt callback: send recipient's SUIAMI back to sender as proof of delivery
      const _sendReceiptCb = async (senderName: string, _senderSuiami: string) => {
        try {
          const myName = app.suinsName?.replace(/\.sui$/, '') || '';
          if (!myName) return;
          const { buildSuiamiMessage, createSuiamiProof } = await import('./suiami.js');
          const myNft = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === myName.toLowerCase() && d.kind === 'nft');
          if (!myNft) return;
          const raw = buildSuiamiMessage(myName, ws.address, myNft.objectId);
          const msgBytes = new TextEncoder().encode(JSON.stringify(raw));
          const { signature } = await signPersonalMessage(msgBytes);
          const proof = createSuiamiProof(raw, btoa(String.fromCharCode(...msgBytes)), signature);
          // Read receipt — send via new SDK (best-effort)
          const { sendThunder } = await import('./client/thunder.js');
          try {
            await sendThunder({

              groupRef: { uuid: `${myName}-${senderName}` },
              text: `\u2713 read by ${myName}.sui`,
            });
          } catch { /* receipt best-effort, may fail if no group exists yet */ }
        } catch { /* receipt is best-effort */ }
      };
      // Fetch and decrypt messages via SDK (replaces on-chain quest/strike)
      const { getThunders } = await import('./client/thunder.js');
      const ws = getState();
      if (!ws.address) return;
      const count = _thunderCounts[cardDomain] ?? 0;
      if (count === 0) return;

      const groupUuid = `thunder-${cardDomain}`;
      const { messages } = await getThunders({

        groupRef: { uuid: groupUuid },
      });
      const _myLog = app.suinsName || ws.address;
      for (const m of messages) {
        await _storeThunderLocal(_myLog, m.senderAddress.slice(0, 8), m.text, 'in', m.senderAddress.slice(0, 8), m.senderAddress);
      }
      _thunderCounts[cardDomain] = 0;
      try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
      _patchNsOwnedList();
      _thunderConvoTarget = '';
      await _refreshThunderLocalCounts();
      _renderConversation(cardDomain, true);
      _syncNftCardToInput();
      if (payloads.length > 0) {
        // Fill input with the sender's name or address for easy reply
        const first = payloads[0];
        const senderBare = (first.sender || '').replace(/\.sui$/, '');
        const replyTarget = senderBare || first.senderAddress;
        if (replyTarget) {
          nsLabel = replyTarget;
          const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (inp) inp.value = replyTarget;
          skipNextFocusClear = true;
          fetchAndShowNsPrice(replyTarget);
        }
        showToast(`\u26a1 ${payloads.length} signal${payloads.length > 1 ? 's' : ''} quested`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Quest failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      _thunderDecryptBusy = false;
    }
  });
}

/** Restore conversation on menu render — handled by _syncNftCardToInput now. */
function _restoreConversation() {
  // _syncNftCardToInput handles conversation restore based on card domain + unquested state
}

// ─── Encrypted local thunder log ─────────────────────────────────────
// Signals are AES-GCM encrypted in localStorage. The encryption key is
// derived from the lockin signature — only the private key holder can decrypt.
// On session restore, the cached signature re-derives the same key.

async function _deriveThunderKey(_seed: string): Promise<CryptoKey> {
  if (_thunderCryptoKey) return _thunderCryptoKey;
  // Try to restore from cached session signature
  try {
    const raw = localStorage.getItem('ski:session');
    if (raw) {
      const session = JSON.parse(raw);
      if (session.signature) {
        _thunderCryptoKey = await _deriveThunderKeyFromSig(session.signature);
        return _thunderCryptoKey;
      }
    }
  } catch {}
  // No session — conversations stay locked until lockin
  throw new Error('Thunder locked — lockin required');
}

interface ThunderLogEntry {
  to: string;
  from?: string;
  msg: string;
  ts: number;
  dir?: 'in' | 'out';
  addr?: string; // counterparty wallet address — groups conversations across names
  read?: boolean; // secret read receipt — outgoing message was quested by recipient
}

interface ThunderComposeDraft {
  raw: string;
  message: string;
  recipients: string[];
  source: 'mention' | 'context' | 'signal' | 'local' | 'none';
  sourceLabel: string;
  warning?: string;
  error?: string;
  /** Parsed dollar amount from @name$amount syntax (e.g. @storm$5 → 5) */
  amount?: number;
  /** Validation error for the amount (insufficient balance, invalid format) */
  amountError?: string;
}

function _dedupeThunderRecipients(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const bare = value.trim().toLowerCase();
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

function _resolveThunderFallbackRecipient(): { name: string; source: ThunderComposeDraft['source']; sourceLabel: string } | null {
  // Priority 1: the card name in the idle overlay — this is who the user is looking at
  const cardName = _idleOverlay?.querySelector('.ski-idle-card-name')?.textContent?.trim().replace(/\.sui$/, '').toLowerCase() || '';
  const ownName = (app.suinsName || '').replace(/\.sui$/, '').toLowerCase();
  if (cardName && cardName !== ownName) {
    return {
      name: cardName,
      source: 'context',
      sourceLabel: `card target @${cardName}.sui`,
    };
  }

  // Priority 2: the name input label (if it's a taken name, not owned by us)
  const currentLabel = nsLabel.trim().toLowerCase();
  const owned = currentLabel
    ? (nsAvail === 'owned' || nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === currentLabel))
    : false;
  if (currentLabel && currentLabel !== ownName && !owned) {
    return {
      name: currentLabel,
      source: 'context',
      sourceLabel: `current target @${currentLabel}.sui`,
    };
  }

  const topChain = Object.entries(_thunderCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || '';
  if (topChain) {
    return {
      name: topChain,
      source: 'signal',
      sourceLabel: `top active signal @${topChain}.sui`,
    };
  }

  const topLocal = Object.entries(_thunderLocalCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || '';
  if (topLocal) {
    return {
      name: topLocal,
      source: 'local',
      sourceLabel: `local conversation @${topLocal}.sui`,
    };
  }

  return null;
}

function _parseThunderCompose(raw: string): ThunderComposeDraft | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const mentions: string[] = [];
  let parsedAmount: number | undefined;
  // Match @name with optional $amount attached (e.g. @storm$5, @brando$10.50)
  const mentionPattern = /(^|[^a-z0-9_-])@([a-z0-9-]{3,63})(?:\$(\d+(?:\.\d{0,2})?))?(?![a-z0-9-])/gi;
  let cleaned = trimmed.replace(mentionPattern, (_match, prefix: string, name: string, amt: string | undefined) => {
    mentions.push(name.toLowerCase());
    if (amt !== undefined && amt !== '') {
      const val = parseFloat(amt);
      if (!isNaN(val) && val > 0) parsedAmount = val;
    }
    return prefix ?? ' ';
  });
  cleaned = cleaned
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  let recipients = _dedupeThunderRecipients(mentions);
  let source: ThunderComposeDraft['source'] = recipients.length > 0 ? 'mention' : 'none';
  let sourceLabel = recipients.length > 0 ? 'parsed locally from @mentions' : 'parsed locally before encryption';
  let warning: string | undefined;

  if (recipients.length === 0) {
    const fallback = _resolveThunderFallbackRecipient();
    if (fallback) {
      recipients = [fallback.name];
      source = fallback.source;
      sourceLabel = fallback.sourceLabel;
      warning = 'recipient inferred locally';
    }
  }

  if (recipients.length === 0) {
    return {
      raw: trimmed,
      message: cleaned,
      recipients,
      source,
      sourceLabel: 'no recipient detected',
      error: 'Add @name or open a target name first.',
      amount: parsedAmount,
    };
  }

  // Validate amount against available balance
  let amountError: string | undefined;
  if (parsedAmount !== undefined) {
    const suiPrice = suiPriceCache?.price ?? 0;
    const suiBalUsd = app.sui * suiPrice;
    const totalUsd = suiBalUsd + app.stableUsd;
    if (parsedAmount > totalUsd) {
      amountError = `Insufficient balance ($${Math.floor(totalUsd)} available)`;
    } else if (parsedAmount <= 0) {
      amountError = 'Amount must be positive';
    }
  }

  return {
    raw: trimmed,
    message: cleaned,
    recipients,
    source,
    sourceLabel,
    warning,
    amount: parsedAmount,
    amountError,
  };
}

async function _storeThunderLocal(_ownerName: string, recipientName: string, message: string, dir: 'in' | 'out' = 'out', fromName?: string, counterpartyAddr?: string): Promise<void> {
  const ws = getState();
  if (!ws.address) return;
  let key: CryptoKey;
  try { key = await _deriveThunderKey(ws.address); } catch { return; } // locked
  // Key by wallet address — stable across primary name changes
  const storageKey = `ski:thunder-log:${ws.address}`;

  // Decrypt existing log
  let entries: ThunderLogEntry[] = [];
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const { ct, iv } = JSON.parse(raw);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
        key,
        Uint8Array.from(atob(ct), c => c.charCodeAt(0)),
      );
      entries = JSON.parse(new TextDecoder().decode(plaintext));
    }
  } catch { /* corrupt or first entry */ }

  // Secret read receipt: if incoming message is a receipt (✓ read by ...),
  // mark all prior outgoing messages to that counterparty as read — don't store the receipt itself
  const isReceipt = dir === 'in' && /^\u2713 read by /i.test(message);
  if (isReceipt) {
    const senderBare = (fromName || '').replace(/\.sui$/i, '').toLowerCase();
    for (const e of entries) {
      if (e.dir === 'out' || (!e.dir && !e.from)) {
        const toBare = (e.to || '').replace(/\.sui$/i, '').toLowerCase();
        if (toBare === senderBare || (counterpartyAddr && e.addr === counterpartyAddr)) {
          e.read = true;
        }
      }
    }
  } else {
    // Append new entry (cap at 200 strikes)
    entries.push({ to: recipientName, from: fromName, msg: message, ts: Date.now(), dir, ...(counterpartyAddr ? { addr: counterpartyAddr } : {}) });
    if (entries.length > 200) entries = entries.slice(-200);
  }

  // Encrypt and store
  const plaintext = new TextEncoder().encode(JSON.stringify(entries));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const ct = btoa(String.fromCharCode(...ciphertext));
  const ivB64 = btoa(String.fromCharCode(...iv));
  localStorage.setItem(storageKey, JSON.stringify({ ct, iv: ivB64 }));
}

/** Read the full encrypted thunder log for the current user. */
async function _readThunderLog(): Promise<ThunderLogEntry[]> {
  const ws = getState();
  if (!ws.address) return [];
  let key: CryptoKey;
  try { key = await _deriveThunderKey(ws.address); } catch { return []; } // locked
  const storageKey = `ski:thunder-log:${ws.address}`;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const { ct, iv } = JSON.parse(raw);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
      key,
      Uint8Array.from(atob(ct), c => c.charCodeAt(0)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as ThunderLogEntry[];
  } catch { return []; }
}

/** Get conversation entries filtered by counterparty name OR address.
 *  Groups all names owned by the same address into one conversation. */
async function _getConversation(counterparty: string): Promise<ThunderLogEntry[]> {
  const all = await _readThunderLog();
  const bare = counterparty.replace(/\.sui$/, '').toLowerCase();

  // Build set of all names owned by this wallet (our side of conversations)
  const ownedNames = new Set<string>();
  for (const d of nsOwnedDomains) {
    ownedNames.add(d.name.replace(/\.sui$/, '').toLowerCase());
  }
  if (app.suinsName) ownedNames.add(app.suinsName.replace(/\.sui$/, '').toLowerCase());

  // Step 1: Collect all addresses associated with the counterparty name
  const addrs = new Set<string>();
  for (const e of all) {
    const to = (e.to || '').replace(/\.sui$/, '').toLowerCase();
    const from = (e.from || '').replace(/\.sui$/, '').toLowerCase();
    if ((to === bare || from === bare) && e.addr) addrs.add(e.addr.toLowerCase());
  }
  // Include the currently resolved target address
  if (nsTargetAddress) addrs.add(nsTargetAddress.toLowerCase());
  // Also resolve from nsNftOwner if available
  if (nsNftOwner) addrs.add(nsNftOwner.toLowerCase());

  // Step 2: Expand — find ALL names in the log that share any of those addresses
  // e.g., alice, whitney, summer all point to 0xabc → treat them as one identity
  const aliasNames = new Set<string>([bare]);
  if (addrs.size > 0) {
    for (const e of all) {
      if (e.addr && addrs.has(e.addr.toLowerCase())) {
        const to = (e.to || '').replace(/\.sui$/, '').toLowerCase();
        const from = (e.from || '').replace(/\.sui$/, '').toLowerCase();
        if (to && !ownedNames.has(to)) aliasNames.add(to);
        if (from && !ownedNames.has(from)) aliasNames.add(from);
      }
    }
  }

  return all.filter(e => {
    const to = (e.to || '').replace(/\.sui$/, '').toLowerCase();
    const from = (e.from || '').replace(/\.sui$/, '').toLowerCase();
    // Match by any alias name (alice, whitney, summer all resolve to same address)
    if (aliasNames.has(to) || aliasNames.has(from)) return true;
    // Match by address directly
    if (e.addr && addrs.has(e.addr.toLowerCase())) return true;
    // If the target IS one of our names, show all inbound to that name
    if (ownedNames.has(bare) && to === bare) return true;
    // Match by @tag in message body for any alias
    for (const alias of aliasNames) {
      if (e.msg && new RegExp(`(^|[^a-z0-9-])@${alias}(?![a-z0-9-])`, 'i').test(e.msg)) return true;
    }
    return false;
  });
}

/** Remove the last entry from the encrypted thunder log (undo a pre-stored signal on tx failure). */
async function _removeLastThunderLocal(_senderName: string): Promise<void> {
  const ws = getState();
  if (!ws.address) return;
  let key: CryptoKey;
  try { key = await _deriveThunderKey(ws.address); } catch { return; } // locked
  const storageKey = `ski:thunder-log:${ws.address}`;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const { ct, iv } = JSON.parse(raw);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
      key,
      Uint8Array.from(atob(ct), c => c.charCodeAt(0)),
    );
    const entries: ThunderLogEntry[] = JSON.parse(new TextDecoder().decode(plaintext));
    if (entries.length === 0) return;
    entries.pop();
    const updated = new TextEncoder().encode(JSON.stringify(entries));
    const newIv = crypto.getRandomValues(new Uint8Array(12));
    const newCt = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, key, updated));
    localStorage.setItem(storageKey, JSON.stringify({ ct: btoa(String.fromCharCode(...newCt)), iv: btoa(String.fromCharCode(...newIv)) }));
  } catch { /* corrupt — ignore */ }
}
let nsOwnedDomains: OwnedDomain[] = []; // all SuiNS objects owned by the wallet
const _preRumbledNames = new Set<string>(
  JSON.parse(localStorage.getItem('ski:pre-rumbled') || '[]'),
);
let nsOwnedFetchedFor = ''; // wallet address we last fetched for (cache key)
let nsRealOwnerAddr = ''; // discovered on-chain owner address (WaaP wallets differ from wallet address)
let nsKioskListing: { kioskId: string; nftId: string; priceMist: string } | null = null; // on-chain kiosk listing for current label
let nsTradeportListing: TradeportListing | null = null; // Tradeport marketplace listing for current label
let nsExpirationMs = 0; // expiration timestamp for current searched name (any name, not just owned)
// Restore cached listing data for instant overlay render on refresh
try {
  const _rc = sessionStorage.getItem('ski:ns-resolve');
  if (_rc) {
    const _cached = JSON.parse(_rc);
    if (_cached.kiosk) nsKioskListing = _cached.kiosk;
    if (_cached.tp) nsTradeportListing = _cached.tp;
  }
} catch {}
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
let nsRosterOpen = false; // always start collapsed
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
/** Toggle the NS roster; when opening, collapse the balance/coins section. */
function _toggleRoster() {
  nsRosterOpen = !nsRosterOpen;
  _persistRosterOpen();
  const list = document.getElementById('wk-ns-owned-list');
  if (list) list.classList.toggle('wk-ns-owned-list--hidden', !nsRosterOpen);
  // Close balance section when roster opens
  if (nsRosterOpen && coinChipsOpen) {
    coinChipsOpen = false;
    _persistCoinChipsOpen();
    document.getElementById('wk-coins-collapse')?.classList.toggle('wk-qr-collapse--hidden', true);
    _updateSendBtnMode();
  }
}
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
let skiTreasuryOpen = false;
function _saveRosterScroll() { try { const g = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null; if (g) localStorage.setItem('ski:roster-scroll', String(g.scrollLeft)); } catch {} }
function _restoreRosterScroll() { try { const g = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null; const v = localStorage.getItem('ski:roster-scroll'); if (g && v) g.scrollLeft = Number(v); } catch {} }
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

/** Auto-add a thunder recipient as a wishlist contact if not already in roster. */
function _addThunderContact(name: string) {
  const bare = name.replace(/\.sui$/, '').toLowerCase();
  const inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bare);
  if (inRoster) return;
  _addToWishlist(bare);
  _patchNsOwnedList();
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
    if (Date.now() - data.ts > OWNED_DOMAINS_CACHE_MS) return null;
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
  // Clear sessionStorage cache after first fetch — it was only for instant first render
  try { sessionStorage.removeItem('ski:ns-resolve'); } catch {}

  /** Apply status + Tradeport listing results to module state and re-render. */
  const _applyStatusAndListing = (sr: DomainStatusResult | null, tp: TradeportListing | null) => {
    nsAvail = sr?.avail ?? null;
    nsGraceEndMs = sr?.graceEndMs ?? 0;
    nsExpirationMs = sr?.expirationMs ?? 0;
    nsTargetAddress = sr?.targetAddress ?? null;
    nsNftOwner = sr?.nftOwner ?? null;
    // If domain is owned by connected wallet, override 'taken' → 'owned'
    if (nsAvail === 'taken') {
      const bareLabel = (nsPriceFetchFor ?? '').toLowerCase();
      const inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel);
      const ws = getState();
      const ownerMatch = sr?.nftOwner && ws.address && normalizeSuiAddress(sr.nftOwner) === normalizeSuiAddress(ws.address);
      if (inRoster || ownerMatch) nsAvail = 'owned';
    }
    nsKioskListing = sr?.kioskId
      ? { kioskId: sr.kioskId, nftId: sr.kioskNftId!, priceMist: sr.kioskListingPriceMist! }
      : null;
    nsTradeportListing = tp;
    // Cache resolution state for instant overlay render on refresh
    try {
      const _cache: any = { avail: nsAvail, target: nsTargetAddress, label: nsPriceFetchFor };
      if (nsKioskListing) _cache.kiosk = nsKioskListing;
      if (nsTradeportListing) _cache.tp = nsTradeportListing;
      sessionStorage.setItem('ski:ns-resolve', JSON.stringify(_cache));
    } catch {}
    // Save resolved label to localStorage (not on every keystroke — only after resolution)
    try { if (nsPriceFetchFor) localStorage.setItem('ski:ns-label', nsPriceFetchFor); } catch {}
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
    // Auto-expand target row when user owns the name
    if (nsAvail === 'owned' || nsAvail === 'taken') {
      const ws = getState();
      const isOwned = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === (nsLabel || '').toLowerCase()) ||
        (nsTargetAddress && ws.address && nsTargetAddress.toLowerCase() === ws.address.toLowerCase());
      if (isOwned) {
        const routeEl = document.getElementById('wk-ns-route');
        if (routeEl && routeEl.classList.contains('wk-ns-route-wrap--hidden')) {
          nsRouteOpen = true;
          _persistRouteOpen();
          routeEl.classList.remove('wk-ns-route-wrap--hidden');
        }
      }
    }
    _syncNftCardToInput();
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
  const isOwnedName = nsAvail === 'owned' || nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bareLabel && d.kind === 'nft');

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

  // Transfer input mode — replace target row with recipient input
  if (nsTransferInputOpen && canEditTarget) {
    return `<div class="wk-ns-target-row wk-ns-target-row--green wk-ns-target-row--transfer-input">
      <input id="wk-ns-transfer-input" class="wk-ns-transfer-input" type="text" value="${esc(nsTransferRecipient)}" placeholder="name.sui or 0x\u2026" spellcheck="false" autocomplete="off">
      <button id="wk-ns-transfer-submit" class="wk-ns-transfer-submit" type="button" title="Transfer NFT">\u2192</button>
      <button id="wk-ns-transfer-cancel" class="wk-ns-transfer-cancel" type="button" title="Cancel">\u2715</button>
    </div>`;
  }

  // Set target address input mode
  if (nsShowTargetInput && canEditTarget) {
    return `<div class="wk-ns-target-row wk-ns-target-row--yellow wk-ns-target-row--transfer-input">
      <input id="wk-ns-set-target-input" class="wk-ns-transfer-input" type="text" value="${esc(nsNewTargetAddr)}" placeholder="0x\u2026 target address" spellcheck="false" autocomplete="off">
      <button id="wk-ns-set-target-submit" class="wk-ns-set-target-submit" type="button" title="Set target address">\u2713</button>
      <button id="wk-ns-set-target-cancel" class="wk-ns-set-target-cancel" type="button" title="Cancel">\u2715</button>
    </div>`;
  }

  const isDim = colorClass === 'wk-ns-target-row--dim';
  const rowCls = isDim ? 'wk-ns-target-row--toggle' : 'wk-ns-target-row--copy';
  const rowTitle = isDim ? 'Show names' : `Copy Target ${shortAddr}`;
  const transferBtn = canEditTarget ? `<button id="wk-ns-transfer-btn" class="wk-ns-transfer-btn" type="button" title="Transfer ${esc(nsLabel)}.sui NFT">\u27a4</button>` : '';
  // When owned, the leading icon becomes the yellow set-target button (no separate setTargetBtn needed)
  const leadingIcon = canEditTarget
    ? `<button id="wk-ns-set-target-btn" class="wk-ns-set-target-btn" type="button" title="Change target address">\u25ce</button>`
    : `<span class="wk-ns-target-icon">\u25ce</span>`;
  return `<div class="wk-ns-target-row ${colorClass} ${rowCls}"${isDim ? '' : ` data-copy-target="${esc(displayAddr)}"`} title="${rowTitle}">${leadingIcon}<span class="wk-ns-target-addr">${shortAddr}</span>${extra}${transferBtn}</div>`;
}

function _nsOwnedListHtml(): string {
  // Sort owned: total signal count desc (on-chain + local) → kiosk first → expiration ascending → no-expiry last
  const sorted = [...nsOwnedDomains].sort((a, b) => {
    const aB = a.name.replace(/\.sui$/, '').toLowerCase();
    const bB = b.name.replace(/\.sui$/, '').toLowerCase();
    const ta = (_thunderCounts[aB] ?? 0) + (_thunderLocalCounts[aB] ?? 0);
    const tb = (_thunderCounts[bB] ?? 0) + (_thunderLocalCounts[bB] ?? 0);
    if (ta !== tb) return tb - ta; // most signals first
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
    let thunderHtml = '';
    const _tcOn = _thunderCounts[bare.toLowerCase()] ?? 0;
    const _tcLocal = _thunderLocalCounts[bare.toLowerCase()] ?? 0;
    const _tcTotal = _tcOn + _tcLocal;
    if (_tcTotal > 0) {
      const pulseCls = _tcOn > 0 ? ' wk-ns-thunder-badge--pulse' : '';
      thunderHtml = `<span class="wk-ns-thunder-badge${pulseCls}" data-thunder-count="${_tcOn}" data-domain="${esc(bare)}" title="${_tcTotal} signal${_tcTotal > 1 ? 's' : ''}${_tcOn > 0 ? ` (${_tcOn} pending)` : ''}">\u26c8\ufe0f${_tcTotal > 1 ? _tcTotal : ''}</span>`;
    }
    const kioskCls = d.inKiosk ? ' wk-ns-owned-chip--kiosk' : '';
    const dimCls = hasFilter && !matches && _tcTotal <= 0 ? ' wk-ns-owned-chip--dim' : '';
    return {
      html: `<button class="wk-ns-owned-chip${kioskCls}${dimCls}" data-domain="${esc(bare)}" type="button" title="${esc(d.name)}">${shapeSvg}${esc(bare)}${badge}${expiryHtml}${thunderHtml}</button>`,
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
  const _statsVisible = (() => { try { return localStorage.getItem('ski:roster-stats') !== '0'; } catch { return true; } })();
  let statsHtml = '';
  if (yearlyUsd > 0) {
    statsHtml = `<div class="wk-ns-owned-stats" id="wk-roster-stats"${_statsVisible ? '' : ' hidden'}><span class="wk-ns-owned-renewal">$${monthlyUsd.toFixed(2)}/mo</span><span class="wk-ns-owned-savings">-$${monthlySavings.toFixed(2)}/mo</span></div>`;
  }
  const header = `<div class="wk-ns-owned-header">
    <span class="wk-ns-owned-title"><svg class="wk-ns-owned-logo" viewBox="170 430 990 400" xmlns="http://www.w3.org/2000/svg">${SKI_SVG_TEXT.replace(/<svg[^>]*>/, '').replace(/<\/svg>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<circle[^/]*\/>|<rect[^/]*\/>/g, '')}</svg><span class="wk-ns-owned-label">Roster</span></span>
    ${statsHtml}<button class="wk-ns-owned-tally" id="wk-roster-tally" type="button" title="Toggle cost stats" onclick="event.stopPropagation();var s=document.getElementById('wk-roster-stats');if(s){var v=s.hasAttribute('hidden');if(v)s.removeAttribute('hidden');else s.setAttribute('hidden','');try{localStorage.setItem('ski:roster-stats',v?'1':'0')}catch(e){}}">${totalOwned}</button>
  </div>`;

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

  return `<div class="wk-ns-owned-inner">${header}<div class="wk-ns-owned-grid">${chips.join('')}</div></div>`;
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
  _syncNftCardToInput();
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
    }, SHADE_COUNTDOWN_MS);
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
let _lastNftCardDomain: string = (() => { try { return sessionStorage.getItem('ski:nft-card-domain') ?? ''; } catch { return ''; } })();

function _ensureNftPopover(): HTMLElement {
  // Use the inline slot inside the roster
  const inline = document.getElementById('ski-nft-inline');
  if (inline) { _nftPopover = inline; return inline; }
  if (_nftPopover) return _nftPopover;
  // Fallback — shouldn't happen, but create a hidden div
  const el = document.createElement('div');
  el.id = 'ski-nft-inline';
  el.className = 'ski-nft-inline';
  el.setAttribute('hidden', '');
  _nftPopover = el;
  return el;
}

function _hideNftPopover(immediate = false) {
  if (_nftPopoverHideTimer) { clearTimeout(_nftPopoverHideTimer); _nftPopoverHideTimer = null; }
  if (_nftPopoverPinned && !immediate) return;
  if (immediate) { _nftPopoverPinned = false; _nftPopover?.setAttribute('hidden', ''); return; }
  _nftPopoverHideTimer = setTimeout(() => {
    _nftPopover?.setAttribute('hidden', '');
  }, NFT_POPOVER_HIDE_MS);
}

function _showNftPopover(chip: HTMLElement, domainBare: string) {
  if (_nftPopoverHideTimer) { clearTimeout(_nftPopoverHideTimer); _nftPopoverHideTimer = null; }
  _nftPopoverPinned = false;
  const popover = _ensureNftPopover();
  popover.dataset.domain = domainBare;
  _lastNftCardDomain = domainBare;
  try { sessionStorage.setItem('ski:nft-card-domain', domainBare); } catch {}
  const suiSkiUrl = `https://${domainBare}.sui.ski`;

  // Owner's primary SuiNS name (reverse resolution)
  const ownerAddr = nsRealOwnerAddr || getState().address || '';
  const ownerName = app.suinsName || suinsCache[ownerAddr] || (() => { try { return localStorage.getItem(`ski:suins:${ownerAddr}`); } catch { return null; } })() || null;
  const ownerBadge = ownerName
    ? `<span class="ski-nft-owner-badge">${esc(ownerName.replace(/\.sui$/, ''))}</span>`
    : `<span class="ski-nft-owner-addr">${ownerAddr.slice(0, 6)}\u2026${ownerAddr.slice(-4)}</span>`;

  // Expiry info from owned domains — use placeholder if unavailable
  const ownedEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === domainBare.toLowerCase());
  let expiryHtml: string;
  if (ownedEntry?.expirationMs) {
    const daysLeft = Math.max(0, Math.ceil((ownedEntry.expirationMs - Date.now()) / 86_400_000));
    const expiryDate = new Date(ownedEntry.expirationMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const urgencyCls = daysLeft <= 30 ? ' ski-nft-expiry--urgent' : daysLeft <= 90 ? ' ski-nft-expiry--warn' : '';
    expiryHtml = `<span class="ski-nft-expiry${urgencyCls}">${expiryDate} \u00b7 ${daysLeft}d</span>`;
  } else {
    expiryHtml = `<span class="ski-nft-expiry">\u2014</span>`;
  }

  // Thunder badges: 🌩️N (total quested from local log) + ⚡N (unquested on-chain, pulsing)
  const unquestedCount = _thunderCounts[domainBare.toLowerCase()] ?? 0;
  const totalCount = _thunderLocalCounts[domainBare.toLowerCase()] ?? 0;
  const questedBadge = totalCount > 0
    ? `<span class="ski-nft-thunder" title="${totalCount} decrypt${totalCount > 1 ? 'ed' : 'ed'} signal${totalCount > 1 ? 's' : ''}">\u26c8\ufe0f${totalCount}</span>`
    : '';
  const unquestedBadge = unquestedCount > 0
    ? `<span class="ski-nft-thunder ski-nft-thunder--unquested" title="${unquestedCount} pending signal${unquestedCount > 1 ? 's' : ''} \u2014 tap to purge">\u26a1${unquestedCount}</span>`
    : '';
  const thunderBadgeHtml = questedBadge + unquestedBadge;
  const thunderCardCls = unquestedCount > 0 ? ' ski-nft-card--thunder' : '';

  popover.innerHTML = `
    <div class="ski-nft-card ski-nft-card--inline${thunderCardCls}">
      <a class="ski-nft-qr" id="ski-nft-qr-slot" href="${esc(suiSkiUrl)}" target="_blank" rel="noopener" title="${esc(domainBare)}.sui.ski"></a>
      <div class="ski-nft-info">
        ${thunderBadgeHtml ? (() => {
    const totalUnquested = Object.values(_thunderCounts).reduce((s, c) => s + c, 0);
    const sunHtml = `<span class="ski-nft-sun" id="ski-nft-sun" title="Purge">\u2600\ufe0f${totalUnquested > 0 ? totalUnquested : ''}</span>`;
    return `<div class="ski-nft-badges">${sunHtml}${thunderBadgeHtml}</div>`;
  })() : ''}
        <span class="ski-nft-domain">${esc(domainBare)}<span class="ski-nft-tld">.sui</span></span>
        <a class="ski-nft-link" href="${esc(suiSkiUrl)}" target="_blank" rel="noopener">${esc(domainBare)}.sui.ski \u2197</a>
        ${expiryHtml}
      </div>
      <div class="ski-nft-owner">${ownerBadge}</div>
      <button class="ski-nft-dismiss" id="ski-nft-dismiss" type="button" title="Clear">\u2715</button>
    </div>`;

  popover.removeAttribute('hidden');

  // Async load QR — thunder-yellow when domain has pending thunder
  const qrColor = unquestedCount > 0 ? '#facc15' : undefined;
  const qrSlot = popover.querySelector('#ski-nft-qr-slot');
  if (qrSlot) {
    getQrSvg(suiSkiUrl, qrColor).then(svg => {
      if (!popover.hasAttribute('hidden')) qrSlot.innerHTML = svg;
    }).catch(() => {});
  }
}

/** Sync NFT card to the input box value; fall back to most-thundered chip.
 *  Also manages conversation open/closed state on hard refresh. */
function _syncNftCardToInput(forceShow = false) {
  const inputBare = nsLabel.trim().replace(/\.sui$/, '').toLowerCase();
  let domain = '';
  if (inputBare) {
    // Show card for any resolved name (owned or taken) — not just owned
    const isResolved = nsAvail === 'owned' || nsAvail === 'taken' || nsAvail === 'grace';
    const isOwned = nsAvail === 'owned' || nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === inputBare);
    if (isResolved || isOwned) domain = inputBare;
  }
  // Don't auto-show card on background syncs — only on explicit user interaction
  if (!domain && !forceShow) { _hideNftPopover(true); return; }
  if (domain) {
    // Try to find the chip, but show card even without one
    const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
    const chip = grid?.querySelector<HTMLElement>(`.wk-ns-owned-chip[data-domain="${domain}"]`);
    _showNftPopover(chip || document.getElementById('ski-nft-inline')!, domain);
    _nftPopoverPinned = true;
  } else {
    _hideNftPopover(true);
  }

  // Manage conversation visibility
  const convoEl = document.getElementById('wk-thunder-convo');
  if (!convoEl || !domain) return;
  const quickBtn = document.getElementById('wk-thunder-quick');
  if (false) {
    // Auto-open disabled — Thunder defaults to closed (#63)
    _thunderConvoOpen = true;
    convoEl.removeAttribute('hidden');
    quickBtn?.classList.add('wk-thunder-quick--active');
    _renderConversation(domain);
  } else if (_thunderConvoOpen) {
    convoEl.removeAttribute('hidden');
    quickBtn?.classList.add('wk-thunder-quick--active');
    _renderConversation(domain);
  } else {
    convoEl.setAttribute('hidden', '');
    quickBtn?.classList.remove('wk-thunder-quick--active');
  }
}

function _attachNftPopoverListeners() {
  const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
  if (!grid) return;

  // Initial card — sync to input or most-thundered
  _syncNftCardToInput();

  // Click: thunderbolt decrypt OR pin/unpin inline card
  grid.addEventListener('click', async (e) => {
    // Thunderbolt click — decrypt next pending Thunder
    const thunderBadge = (e.target as HTMLElement).closest<HTMLElement>('.wk-ns-thunder-badge');
    const badgeDomain = thunderBadge?.dataset.domain?.toLowerCase();
    const badgeCount = badgeDomain ? (_thunderCounts[badgeDomain] ?? 0) : 0;
    if (thunderBadge && badgeDomain && badgeCount > 0) {
      e.stopPropagation();
      if (_thunderDecryptBusy) return;
      _thunderDecryptBusy = true;
      try {
        const { getThunders } = await import('./client/thunder.js');
        const ws = getState();
        if (!ws.address) return;

        const groupUuid = `thunder-${badgeDomain}`;
        const { messages } = await getThunders({
  
          groupRef: { uuid: groupUuid },
        });

        if (messages.length === 0) { showToast('No signals found'); _thunderCounts[badgeDomain] = 0; _patchNsOwnedList(); return; }

        const first = messages[0];
        const senderName = first.senderAddress.slice(0, 8) + '\u2026';
        const extra = messages.length > 1 ? ` (+${messages.length - 1} more)` : '';
        showToast(`\u26a1 ${senderName}: ${first.text}${extra}`);
        const _myLog = app.suinsName || ws.address;
        for (const m of messages) {
          await _storeThunderLocal(_myLog, m.senderAddress.slice(0, 8), m.text, 'in', m.senderAddress.slice(0, 8), m.senderAddress);
        }

        // Set input to sender's address for reply
        const senderBare = first.senderAddress.slice(0, 8);
        if (senderBare) {
          nsLabel = senderBare;
          const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (inp) inp.value = senderBare;
          skipNextFocusClear = true;
          fetchAndShowNsPrice(senderBare);
        }

        // Show conversation with the sender
        _thunderConvoTarget = ''; // force re-render
        _renderConversation(senderBare || nsLabel.trim());

        // All struck — clear count for this name
        _thunderCounts[badgeDomain] = 0;
        try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
        _patchNsOwnedList();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Decrypt failed';
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        _thunderDecryptBusy = false;
      }
      return;
    }

    // Chip clicks set the input (handled by outer listener) — card syncs via _syncNftCardToInput
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

    // Auto pre-rumble any owned names not yet provisioned (covers Tradeport buys, gifts, etc.)
    for (const d of fresh) {
      if (d.kind !== 'nft') continue;
      const bare = d.name.replace(/\.sui$/i, '').toLowerCase();
      if (_preRumbledNames.has(bare)) continue;
      _preRumbledNames.add(bare);
      try { localStorage.setItem('ski:pre-rumbled', JSON.stringify([..._preRumbledNames])); } catch {}
      window.dispatchEvent(new CustomEvent('ski:name-acquired', { detail: { name: bare } }));
    }
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
  if (variant === 'orange-triangle') {
    const top = pad + 1;
    const bot = s - pad;
    return `<svg ${base}><polygon points="${half},${top} ${s - pad},${bot} ${pad},${bot}" fill="#f97316" stroke="white" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
  }
  if (variant === 'red-hexagon') {
    const r = half - pad;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return `${half + r * Math.cos(a)},${half + r * Math.sin(a)}`;
    }).join(' ');
    return `<svg ${base}><polygon points="${pts}" fill="#ef4444" stroke="white" stroke-width="${sw}"/></svg>`;
  }
  // black-diamond: dark fill with white outline — visible on both dark and light backgrounds
  const dPath = `M${half},${pad} L${s - pad},${half} L${half},${s - pad} L${pad},${half}Z`;
  return `<svg ${base}><path d="${dPath}" fill="#1a1a2e" stroke="#ffffff" stroke-width="${sw}"/></svg>`;
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
  try { localStorage.setItem('ski:ns-variant', variant); } catch {}
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
  }, SHADE_COUNTDOWN_MS);
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
    const priceText = usdVal != null ? `<span class="wk-ns-price-minus">-$</span>${usdVal.toFixed(2)}` : `<span class="wk-ns-price-minus">-</span>${fmtSui(totalSui)} SUI`;
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
        return `<span class="wk-ns-price-val wk-ns-grace-pill"><span class="wk-ns-price-minus">-</span>${fmtSui(sui)}<img src="${SUI_DROP_URI}" class="wk-ns-price-drop" alt="SUI" aria-hidden="true"></span>`;
      }
      return `<span class="wk-ns-price-val wk-ns-grace-pill"><span class="wk-ns-price-minus">-$</span>${nsPriceUsd.toFixed(2)}</span>`;
    }
    return `<span class="wk-ns-price-val wk-ns-grace-pill">${_graceCountdown()}</span>`;
  }
  // Don't show price for owned or self-target names — they can't be re-registered
  if (nsAvail === 'owned') return '';
  const _walletAddr = getState().address?.toLowerCase() ?? '';
  if (nsTargetAddress && nsTargetAddress.toLowerCase() === _walletAddr) return '';
  // Show price as cost — red -$ prefix
  const len = nsLabel.replace(/\.sui$/, '').length;
  const displayPrice = nsPriceUsd ?? (len === 3 ? 375 : len === 4 ? 75 : 7.50);
  const priceNum = displayPrice < 10 ? displayPrice.toFixed(2) : displayPrice.toFixed(0);
  if (balView === 'sui' && suiPriceCache && suiPriceCache.price > 0) {
    const sui = displayPrice / suiPriceCache.price;
    return `<span class="wk-ns-price-val"><span class="wk-ns-price-minus">-</span>${fmtSui(sui)}<img src="${SUI_DROP_URI}" class="wk-ns-price-drop" alt="SUI" aria-hidden="true"></span>`;
  }
  return `<span class="wk-ns-price-val"><span class="wk-ns-price-minus">-$</span>${priceNum}</span>`;
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

function _treasuryPanelHtml(): string {
  const solPrice = getTokenPrice('SOL') ?? 82;
  const solUsd = app.solBalance > 0 ? (app.solBalance * solPrice).toFixed(2) : '0.00';
  const totalRevenue = app.usd != null ? (app.usd * 0.05).toFixed(2) : '0.00'; // 5% of portfolio as proxy

  return `
    <div class="wk-settings-header">
      <button class="wk-settings-back" id="wk-treasury-back" type="button">\u2190</button>
      <span class="wk-settings-title">Cache</span>
    </div>
    <div class="wk-treasury-body">
      <div class="wk-treasury-section">
        <div class="wk-treasury-label">Reserve Health</div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Senior (peg floor)</span>
          <span class="wk-treasury-val wk-treasury-val--green">60%</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Junior (growth)</span>
          <span class="wk-treasury-val wk-treasury-val--yellow">40%</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Collateral Ratio</span>
          <span class="wk-treasury-val">150%+</span>
        </div>
      </div>
      <div class="wk-treasury-section">
        <div class="wk-treasury-label">Yield Sources</div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">NAVI Lending</span>
          <span class="wk-treasury-val">SUI ~3.5%</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Kamino (Solana)</span>
          <span class="wk-treasury-val">xStocks collateral</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Scallop</span>
          <span class="wk-treasury-val">USDC ~4.5%</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">DeepBook Maker</span>
          <span class="wk-treasury-val">Rebates</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Full Sail LP</span>
          <span class="wk-treasury-val">oSAIL + fees</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Aftermath afSUI</span>
          <span class="wk-treasury-val">Staking + farms</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Flash Arb (NAVI)</span>
          <span class="wk-treasury-val">0% fee arb</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">USD1 (WL Markets)</span>
          <span class="wk-treasury-val">T-bills + lending</span>
        </div>
      </div>
      <div class="wk-treasury-section">
        <div class="wk-treasury-label">Cross-Chain (IKA dWallet)</div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">SOL Balance</span>
          <span class="wk-treasury-val">${app.solBalance > 0 ? app.solBalance.toFixed(4) : '—'} SOL ($${solUsd})</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Chains</span>
          <span class="wk-treasury-val">Sui · Sol · ETH · BTC · Base</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Assets</span>
          <span class="wk-treasury-val">20 across 6 chains</span>
        </div>
      </div>
      <div class="wk-treasury-section">
        <div class="wk-treasury-label">Revenue Streams</div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Thunder free signals</span>
          <span class="wk-treasury-val wk-treasury-val--yellow">\u26a1 live</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Registration 5%</span>
          <span class="wk-treasury-val wk-treasury-val--yellow">\u26a1 live</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Shade 10% escrow</span>
          <span class="wk-treasury-val wk-treasury-val--yellow">\u26a1 live</span>
        </div>
        <div class="wk-treasury-row">
          <span class="wk-treasury-key">Swap spread 0.1%</span>
          <span class="wk-treasury-val">pending</span>
        </div>
      </div>
    </div>`;
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
  // Show the idle overlay immediately instead of opening the modal
  window.dispatchEvent(new CustomEvent('ski:show-idle'));
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

  // dWallet addresses populated from on-chain query below — no localStorage cache

  // Auto-detect dWallet on menu render (non-blocking, updates cache)
  if ((!app.btcAddress || !app.solAddress) && ws.address && !_dwalletCheckInFlight) {
    _dwalletCheckInFlight = true;
    const _ikaQueryAddr = ws.address;
    import('./client/ika.js').then(({ getCrossChainStatus }) =>
      getCrossChainStatus(ws.address)
    ).then((status) => {
      _dwalletCheckInFlight = false;
      // Wallet switched during query — discard stale result
      if (getState().address !== _ikaQueryAddr) return;
      let changed = false;
      if (status.btcAddress && status.btcAddress !== app.btcAddress) {
        app.btcAddress = status.btcAddress;
        app.ethAddress = status.ethAddress;
        app.ikaWalletId = status.dwalletId;
        changed = true;
      }
      if (status.solAddress && status.solAddress !== app.solAddress) {
        app.solAddress = status.solAddress;
        changed = true;
      }
      // Explicit confirmation of no IKA → clear cached squid
      if (!status.ika && app.ikaWalletId) {
        app.ikaWalletId = '';
        try { localStorage.removeItem(`ski:has-ika:${ws.address}`); } catch {}
        changed = true;
      }
      if (changed) {
        // Cache IKA status for instant restore on next page load
        if (app.ikaWalletId && ws.address) {
          try { localStorage.setItem(`ski:has-ika:${ws.address}`, app.ikaWalletId); } catch {}
          try { localStorage.setItem(`ski:ika-addrs:${ws.address}`, JSON.stringify({ btc: app.btcAddress, eth: app.ethAddress, sol: app.solAddress })); } catch {}
        }
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
    if (networkView === 'btc' && app.ethAddress) return {
      addr: app.ethAddress,
      scan: `https://etherscan.io/address/${app.ethAddress}`,
      explorer: 'View on Etherscan',
      cls: 'wk-dd-address-banner--eth',
    };
    if (networkView === 'sol' && app.solAddress) return {
      addr: app.solAddress,
      scan: `https://solscan.io/account/${app.solAddress}`,
      explorer: 'View on Solscan',
      cls: 'wk-dd-address-banner--sol',
    };
    return {
      addr: ws.address,
      scan: `https://suiscan.xyz/mainnet/account/${ws.address}`,
      explorer: 'View on Suiscan',
      cls: '',
    };
  };
  const { addr: displayAddr, scan: scanUrl, explorer: explorerTitle, cls: addrBannerCls } = _netAddr();
  const needsDWallet = (networkView === 'btc' && !app.btcAddress && !app.ethAddress)
    || (networkView === 'sol' && !app.solAddress);

  const addrShort = truncAddr(displayAddr);

  const dotSvg = balView === 'usd'
    ? `<button type="button" class="wk-popout-bal-icon-btn" id="wk-consolidate-btn" title="Consolidate tokens to USDC"><svg class="wk-popout-bal-icon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="#22c55e" stroke="white" stroke-width="3"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg></button>`
    : `<img src="${SUI_DROP_URI}" class="wk-popout-bal-icon" alt="SUI" aria-hidden="true">`;
  const balValHtml = balView === 'usd'
    ? `<span class="wk-popout-bal-val wk-popout-bal-val--usd">${fmtMenuBalHtml(app.usd)}</span>`
    : `<span class="wk-popout-bal-val wk-popout-bal-val--sui">${fmtMenuBalHtml(getTotalSui())}</span>`;
  const _qrRight = (() => { try { return localStorage.getItem('ski:qr-right') === '1'; } catch { return false; } })();
  const balToggleHtml = `<div class="wk-popout-balance">
        <span class="wk-popout-bal-display">${dotSvg}${balValHtml}</span><span id="wk-ns-price-chip" class="wk-ns-price-chip">${_nsPriceHtml()}</span>
        <label class="ski-layout-toggle wk-qr-side-toggle" title="QR position">
          <input type="checkbox" id="wk-qr-side-toggle"${_qrRight ? ' checked' : ''}>
          <span class="ski-layout-track"><span class="ski-layout-thumb"></span></span>
        </label>
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
  // Build coin picker grid (ALL coins, selected one gets highlight)
  const _coinGridItems = _coinChipsCache.map((c, i) => {
    const color = c.colorCls?.replace('wk-coin-item--', '') ?? '';
    const isSelected = i === _selIdx;
    const selCls = isSelected ? ' wk-coin-grid-item--active' : '';
    const usdTip = _chipUsdTip(c);
    return `<button class="wk-coin-grid-item wk-coin-grid-item--${color}${selCls}" data-coin-pick="${esc(c.key)}" type="button" title="${esc(usdTip)}">${c.icon}<span class="wk-coin-grid-val">${c.html}</span></button>`;
  }).join('');
  const _coinGridHtml = _coinGridItems ? `<div id="wk-coin-grid" class="wk-coin-grid wk-coin-grid--hidden">${_coinGridItems}</div>` : '';

  const coinBreakdownHtml = _selChip ? `<div class="wk-coin-breakdown-wrap"><div class="wk-coin-breakdown"><button class="wk-coin-arrow wk-coin-arrow--left wk-coin-arrow--to-${_prevColor}" id="wk-coin-prev" type="button"${_arrowDisabled} title="${esc(_prevTip)}">\u2039</button><span class="wk-coin-item ${_selChip.colorCls} wk-coin-item--selected" data-coin="${esc(_selChip.key)}" id="wk-coin-selected" title="${esc(_selChip.tooltip ?? _selChip.key)}">${_selChip.icon}<span class="wk-coin-val">${_selChip.html}</span></span><button class="wk-coin-arrow wk-coin-arrow--right wk-coin-arrow--to-${_nextColor}" id="wk-coin-next" type="button"${_arrowDisabled} title="${esc(_nextTip)}">\u203A</button></div>${_coinGridHtml}</div>` : '';

  const _nsInitVariant = (() => {
    const live = _nsVariant();
    if (live !== 'black-diamond') return live;
    // On first render, roster hasn't loaded yet — use cached variant if label matches
    try { const cached = localStorage.getItem('ski:ns-variant'); if (cached && nsLabel) return cached as SkiDotVariant; } catch {}
    return live;
  })();
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
    : `<div class="wk-ns-input-wrap"><input id="wk-ns-label-input" class="wk-ns-label-input" type="text" value="${esc(nsLabel)}" maxlength="63" spellcheck="false" autocomplete="off" placeholder="${_inputPlaceholder}"><button id="wk-ns-clear-btn" class="wk-ns-clear-btn" type="button" title="Clear" style="${nsLabel ? '' : 'display:none'}">\u2715</button><button id="wk-ns-pin-btn" class="wk-ns-pin-btn" type="button" title="Show target address">\u25be</button></div>`;
  const _nsRouteInitHtml = _suiamiVerifyHtml || _nsRouteHtml();
  const nsRowHtml = `
      <div id="wk-dd-ns-section" class="wk-dd-ns-section${_nsInitSectionClass}${_subnameMode ? ' wk-dd-ns-section--subname' : ''}${nsSectionOpen ? '' : ' wk-dd-ns-section--collapsed'}">
        <div class="wk-dd-ns-domain-row">
          <span id="wk-ns-status" class="wk-ns-status">${_nsStatusSvg(_subnameMode ? 'blue-square' : _nsInitVariant)}</span>
          ${_inputHtml}
          <span class="wk-ns-dot-sui">${esc(_dotSuiText)}</span>
          <button id="wk-thunder-quick" class="wk-thunder-quick" type="button" title="Thunder" hidden>\u26a1</button><button id="wk-send-btn" class="wk-send-btn wk-send-btn--suiami" type="button" title="SUIAMI" disabled>SUIAMI</button>
          <button id="wk-dd-ns-register" class="wk-dd-ns-register-btn${nsAvail === 'grace' && !_nsInitShadeOrder ? ' wk-shade-ready' : nsAvail === 'grace' && _nsInitShadeOrder && _nsInitGraceExpired ? ' wk-shade-execute' : nsAvail === 'grace' && _nsInitShadeOrder ? ' wk-shade-active' : ''}" type="button"${_registerDisabled ? ' disabled' : ''} title="${_registerTitle}" style="display:none">${nsAvail === 'grace' && !_nsInitShadeOrder ? '\u2299' : nsAvail === 'grace' && _nsInitShadeOrder && !_nsInitGraceExpired ? '\u2713' : '\u2192'}</button>
        </div>
        <div id="wk-ns-route" class="wk-ns-route-wrap${nsRouteOpen ? '' : ' wk-ns-route-wrap--hidden'}">${_nsRouteInitHtml}</div>
        <div id="ski-nft-inline" class="ski-nft-inline" hidden></div>
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
              <button class="wk-dd-item wk-dd-treasury-btn" id="wk-dd-treasury-btn" title="Treasury">\ud83c\udfdb\ufe0f</button>
              <button class="wk-dd-item disconnect" id="wk-dd-disconnect">Deactivate</button>
            </div>
            ${nameBadgeHtml}
            <div id="wk-bal-collapse" class="wk-badge-collapse${addrSectionOpen ? '' : ' wk-badge-collapse--hidden'}">
              <div class="wk-badge-collapse-inner">
                <div class="wk-dd-address-row">
                  <div id="wk-network-select" class="wk-dd-network-select"></div>
                  ${needsDWallet
                    ? `<button class="wk-dd-address-banner wk-dd-address-banner--${networkView === 'sol' ? 'sol' : 'btc'} wk-dd-dwallet-setup" id="wk-dd-dwallet-setup" type="button" title="${networkView === 'sol' ? 'Create a dWallet to get a Solana address' : 'Create a dWallet to get BTC + ETH addresses'}">
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
            <div id="wk-coins-collapse" class="wk-qr-collapse-wrap${coinChipsOpen ? '' : ' wk-qr-collapse--hidden'}${_qrRight ? ' wk-qr-collapse--right' : ''}">
              <div class="wk-qr-content-left">
                <div class="wk-qr-content-qr" id="wk-addr-qr" title="${esc(displayAddr)}" data-qr-addr="${esc(displayAddr)}"></div>
              </div>
              <div class="wk-qr-content-main">
                ${coinBreakdownHtml}
                <div class="wk-send-row">
                  <span class="wk-send-dollar">$</span>
                  <div class="wk-send-amount-wrap">
                    <input id="wk-send-amount" class="wk-send-amount" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" placeholder="0.00" spellcheck="false" autocomplete="off" value="${esc(pendingSendAmount)}">
                    <button id="wk-send-clear" class="wk-send-input-clear" type="button" title="Clear" style="${pendingSendAmount && Number(pendingSendAmount) > 0 ? '' : 'display:none'}">\u2715</button>
                  </div>
                </div>
                <div class="wk-send-row-below">
                  <div class="wk-send-quick-stack">
                    <button id="wk-send-all" class="wk-send-all wk-send-all--${balView}" type="button" title="Use full balance">All</button>
                    <button id="wk-send-min" class="wk-send-all wk-send-all--${balView}" type="button" title="Set 0.01">0.01</button>
                  </div>
                  <div id="wk-swap-select" class="wk-swap-select"></div>
                </div>
              </div>
            </div>
            ${nsRowHtml}
            <!-- Thunder bar hidden pending v4 migration (#63) -->
          </div>
          <div class="wk-dd-panel wk-dd-panel--settings">
            ${settingsHtml}
          </div>
          <div class="wk-dd-panel wk-dd-panel--treasury">
            ${_treasuryPanelHtml()}
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
      const { provisionDWallet, Curve } = await import('./client/ika.js');
      const wallet = await import('./wallet.js');
      const isWaap = /waap/i.test(getState().walletName);
      const isSolana = networkView === 'sol';
      const status = await provisionDWallet(getState().address, {
        signTransaction: (txBytes: Uint8Array) => wallet.signTransaction(txBytes),
        signAndExecuteTransaction: (txBytes: Uint8Array) => wallet.signAndExecuteTransaction(txBytes),
        isWaap,
        requestedCurve: isSolana ? Curve.ED25519 : Curve.SECP256K1,
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
          solAddress: status.solAddress,
        });
        if (isSolana && status.solAddress) {
          showToast('dWallet active \u2014 Solana address ready');
        } else if (status.btcAddress) {
          showToast('dWallet active \u2014 BTC + ETH addresses ready');
        }
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
  document.getElementById('wk-dd-thunder')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_thunderConvoOpen) {
      // Close everything
      _toggleThunderConvo();
      return;
    }
    // Open — pick domain, show card, open convo, focus input
    let domain = nsLabel.trim().replace(/\.sui$/, '').toLowerCase();
    if (!domain) {
      const top = Object.entries(_thunderCounts).filter(([, c]) => c > 0).sort(([, a], [, b]) => b - a)[0];
      if (top) domain = top[0];
    }
    if (!domain) {
      const topLocal = Object.entries(_thunderLocalCounts).filter(([, c]) => c > 0).sort(([, a], [, b]) => b - a)[0];
      if (topLocal) domain = topLocal[0];
    }
    if (domain) {
      nsLabel = domain;
      const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (inp) inp.value = domain;
      skipNextFocusClear = true;
      const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
      const chip = grid?.querySelector<HTMLElement>(`.wk-ns-owned-chip[data-domain="${domain}"]`);
      _showNftPopover(chip || document.getElementById('ski-nft-inline')!, domain);
      _nftPopoverPinned = true;
    }
    _toggleThunderConvo();
    // Show reply input + focus
    const replyWrap = document.getElementById('wk-thunder-reply-wrap');
    if (replyWrap?.hasAttribute('hidden')) replyWrap.removeAttribute('hidden');
    const msgInput = document.getElementById('wk-thunder-msg') as HTMLInputElement | null;
    if (msgInput) { msgInput.value = ''; msgInput.focus(); }
  });
  document.getElementById('wk-dd-disconnect')?.addEventListener('click', menuDisconnect);
  document.getElementById('wk-qr-side-toggle')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem('ski:qr-right', checked ? '1' : '0'); } catch {}
    const collapse = document.getElementById('wk-coins-collapse');
    if (collapse) collapse.classList.toggle('wk-qr-collapse--right', checked);
  });
  document.getElementById('wk-bal-toggle')?.addEventListener('change', menuToggleBalance);
  _renderNetworkSelect();
  document.getElementById('wk-network-select')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const opt = t.closest<HTMLElement>('.wk-dd-network-opt');
    if (opt?.dataset.network) {
      networkView = opt.dataset.network as 'sui' | 'btc' | 'sol';
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
    const gridWasOpen = !document.getElementById('wk-coin-grid')?.classList.contains('wk-coin-grid--hidden');
    const cur = _coinChipsCache.findIndex(c => c.key === (selectedCoinSymbol?.toLowerCase() ?? ''));
    _selectCoinByIndex(cur - 1);
    if (gridWasOpen) {
      const grid = document.getElementById('wk-coin-grid');
      if (grid) grid.classList.remove('wk-coin-grid--hidden');
    }
  });
  document.getElementById('wk-coin-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const gridWasOpen = !document.getElementById('wk-coin-grid')?.classList.contains('wk-coin-grid--hidden');
    const cur = _coinChipsCache.findIndex(c => c.key === (selectedCoinSymbol?.toLowerCase() ?? ''));
    _selectCoinByIndex(cur + 1);
    if (gridWasOpen) {
      const grid = document.getElementById('wk-coin-grid');
      if (grid) grid.classList.remove('wk-coin-grid--hidden');
    }
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
    const btn = e.currentTarget as HTMLButtonElement;
    const ws2 = getState();
    if (!ws2.address) return;
    // Switch output selector to USDC and update all UI before the wallet popup
    if (balView === 'usd') {
      swapOutputKey = 'usd';
      _persistSwapOutput();
      _renderSwapSelect();
      _updateSendBtnMode();
    }
    // Let the UI repaint before the wallet popup blocks
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Check for eligible non-stable, non-SUI tokens
    const eligible = walletCoins.filter(c => !c.isStable && c.symbol !== 'SUI' && c.balance > 0);
    if (!eligible.length) { showToast('No tokens to consolidate'); return; }

    btn.disabled = true;
    try {
      const USDC_CT = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
      const swappedSymbols: string[] = [];
      let swappedTotalUsd = 0;

      // 1. Try main consolidation (NS, WAL, XAUM, SUI)
      try {
        const result = await buildConsolidateToUsdcTx(ws2.address, undefined, true);
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
        if (['NS', 'WAL', 'XAUM', 'IKA'].includes(c.symbol)) continue; // already handled above
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
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_LONG_MS);
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

  // Treasury slide-in
  document.getElementById('wk-dd-treasury-btn')?.addEventListener('click', () => {
    skiTreasuryOpen = true;
    skiSettingsOpen = false;
    const slider = document.querySelector('.wk-dd-slider');
    slider?.classList.remove('wk-dd-slider--settings');
    slider?.classList.add('wk-dd-slider--treasury');
  });
  document.getElementById('wk-treasury-back')?.addEventListener('click', () => {
    skiTreasuryOpen = false;
    document.querySelector('.wk-dd-slider')?.classList.remove('wk-dd-slider--treasury');
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
    const hasAmount = !!pendingSendAmount && Number(pendingSendAmount) > 0;
    // SWAP: input ≠ output AND target is self (or empty) AND has amount
    const swapMode = coinChipsOpen && !mintMode && !marketMode && !resolving && !inEqualsOut && !sendingToOther && hasAmount;
    // SUIAMI: input = output AND target is self
    const suiamiSendMode = coinChipsOpen && !mintMode && !marketMode && !resolving && inEqualsOut && selfTarget && !sendingToOther && hasAmount;
    // THUNDER: viewing someone else's taken name, no amount, coins NOT open
    const thunderMode = !coinChipsOpen && !mintMode && !marketMode && !resolving && !suiamiMode
      && hasLabel && isTaken && !isOwned && nsTargetAddress != null && !hasAmount;
    // SEND: sending to someone else (any token combo), colored by output
    // Also activates when coins are open with a recipient (even without amount — disabled send)
    const sendMode = !thunderMode && !mintMode && !marketMode && !resolving && sendingToOther && !(swapMode || suiamiSendMode);

    btn.classList.remove('wk-send-btn--suiami', 'wk-send-btn--suiami-active', 'wk-send-btn--suiami-green', 'wk-send-btn--send', 'wk-send-btn--market', 'wk-send-btn--resolving', 'wk-send-btn--mint', 'wk-send-btn--swap-usd', 'wk-send-btn--swap-sui', 'wk-send-btn--swap-gold', 'wk-send-btn--thunder');
    if (mintMode) btn.classList.add('wk-send-btn--mint');
    else if (swapMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`);
    else if (suiamiSendMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`); // SUIAMI colored by output
    else if (sendMode) btn.classList.add(`wk-send-btn--swap-${swapOutputKey}`); // SEND colored by output
    else if (thunderMode) btn.classList.add('wk-send-btn--thunder');
    else if (suiamiGreen) btn.classList.add('wk-send-btn--suiami-green');
    else if (suiamiPurple) btn.classList.add('wk-send-btn--suiami-active');
    else if (marketMode) btn.classList.add('wk-send-btn--market');
    else if (resolving) btn.classList.add('wk-send-btn--resolving');
    // Hide price chip when sending, swapping, or name is taken (not mintable)
    const priceChip = document.getElementById('wk-ns-price-chip');
    if (priceChip) priceChip.style.display = ((sendMode || swapMode) && !mintMode) || (isTaken && !isOwned && !hasListing) ? 'none' : '';
    // ⚡ mini button: show when unquested signals exist, conversation is open, or has history
    const quickBtn = document.getElementById('wk-thunder-quick') as HTMLButtonElement | null;
    if (quickBtn) {
      const hasUnquested = Object.values(_thunderCounts).some(c => c > 0);
      const hasHistory = Object.values(_thunderLocalCounts).some(c => c > 0);
      const showQuick = hasUnquested || hasHistory || _thunderConvoOpen;
      if (showQuick) { quickBtn.removeAttribute('hidden'); } else { quickBtn.setAttribute('hidden', ''); }
    }
    // Conversation is now controlled by card click (_toggleThunderConvo), not input mode

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
      // Only auto-fill if amount is empty (don't overwrite user edits or re-fill after clear)
      if (amountInput && !amountInput.value && !pendingSendAmount) {
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
    } else if (thunderMode) {
      btn.disabled = false;
      btn.textContent = 'Thunder';
      btn.title = `Thunder \u2014 encrypt a signal to ${nsLabel.trim()}.sui`;
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
      btn.textContent = 'SUIAMI';
      btn.classList.add('wk-send-btn--suiami');
      btn.title = 'Resolving\u2026';
    } else {
      // Default: blacked-out SUIAMI
      btn.disabled = true;
      btn.textContent = 'SUIAMI';
      btn.classList.add('wk-send-btn--suiami');
      btn.title = 'SuiAMI';
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
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
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

  // ⚡ quick button — toggle thunder card + conversation
  document.getElementById('wk-thunder-quick')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_thunderConvoOpen) {
      // Close — just toggle off
      _toggleThunderConvo();
      return;
    }
    // Opening — collapse balance, zero amount, set up domain, then open
    if (coinChipsOpen) {
      coinChipsOpen = false;
      _persistCoinChipsOpen();
      const coinsEl = document.getElementById('wk-coins-collapse');
      if (coinsEl) coinsEl.classList.add('wk-qr-collapse--hidden');
    }
    pendingSendAmount = '';
    const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
    document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
    const _ac = document.getElementById('wk-send-clear');
    if (_ac) _ac.style.display = 'none';
    // Use current input name if present, else most-thundered, else most-messaged
    let domain = nsLabel.trim().replace(/\.sui$/, '').toLowerCase();
    if (!domain) {
      const top = Object.entries(_thunderCounts)
        .filter(([, c]) => c > 0)
        .sort(([, a], [, b]) => b - a)[0];
      if (top) domain = top[0];
    }
    if (!domain) {
      // Fall back to name with most conversation history
      const topLocal = Object.entries(_thunderLocalCounts)
        .filter(([, c]) => c > 0)
        .sort(([, a], [, b]) => b - a)[0];
      if (topLocal) domain = topLocal[0];
    }
    if (!domain) return;
    nsLabel = domain;
    const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
    if (inp) inp.value = domain;
    skipNextFocusClear = true;
    // Show card directly (don't use _syncNftCardToInput which may fight the toggle)
    const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
    const chip = grid?.querySelector<HTMLElement>(`.wk-ns-owned-chip[data-domain="${domain}"]`);
    _showNftPopover(chip || document.getElementById('ski-nft-inline')!, domain);
    _nftPopoverPinned = true;
    fetchAndShowNsPrice(domain);
    _updateSendBtnMode();
    // Open
    _toggleThunderConvo();
    if (_thunderConvoOpen) {
      const cardDomain = document.getElementById('ski-nft-inline')?.dataset.domain?.toLowerCase() || '';
      const hasUnquested = (_thunderCounts[cardDomain] ?? 0) > 0;
      if (!hasUnquested) {
        const msgInput = document.getElementById('wk-thunder-msg') as HTMLInputElement | null;
        if (msgInput) msgInput.focus();
      }
    }
  });

  // Send / Swap / Mint / SuiAMI
  document.getElementById('wk-send-btn')?.addEventListener('click', async () => {
    const sec = document.getElementById('wk-dd-ns-section');

    // BUY/TRADE mode: marketplace listing OR button says TRADE — use /api/infer
    const _btnEl = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    const _isTrade = (nsKioskListing || nsTradeportListing || _btnEl?.textContent === 'TRADE') && nsLabel.trim().length > 0;
    if (_isTrade) {
      const ws2 = getState();
      if (!ws2.address) return;
      const btn = _btnEl;
      const label = nsLabel.trim();
      if (btn) { btn.disabled = true; btn.textContent = '\u2026'; }
      try {
        // Route through /api/infer — server reads real on-chain balances
        const inferRes = await fetch('/api/infer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label, address: ws2.address }),
        });
        const infer = await inferRes.json() as any;

        if (infer.error) { showToast(infer.error); return; }

        // Ultron already bought — no user signature needed
        if (infer.purchased?.digest) {
          nsAvail = 'owned'; nsKioskListing = null; nsTradeportListing = null;
          app.suinsName = app.suinsName || `${label}.sui`;
          showToast(`\u26a1 ${label}.sui acquired via cache`);
          _patchNsStatus(); renderSkiMenu();
          setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
          return;
        }

        if (infer.tx?.base64) {
          const bytes = Uint8Array.from(atob(infer.tx.base64), ch => ch.charCodeAt(0));
          if (btn) btn.textContent = '\u270f';
          const _isWaaP = /waap/i.test(getState().walletName || '');
            const { digest } = (!_isWaaP && isSponsorActive()) ? await signAndExecuteSponsoredTx(bytes) : await signAndExecuteTransaction(bytes);
          nsAvail = 'owned'; nsKioskListing = null; nsTradeportListing = null;
          app.suinsName = app.suinsName || `${label}.sui`;
          showToast(`${label}.sui purchased \u2713`);
          _patchNsStatus(); renderSkiMenu();
          setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
        } else {
          // Try local marketplace handler as fallback
          if (nsKioskListing || nsTradeportListing) {
            await _handleMarketplacePurchase(ws2, btn, label);
          } else {
            const reason = infer.recommended?.reason ?? 'No listing found';
            const bals = infer.balances;
            showToast(`${reason} (SUI: $${bals?.sui?.usd?.toFixed(2) ?? '?'}, USDC: $${bals?.usdc?.usd?.toFixed(2) ?? '?'}, iUSD: $${bals?.iusd?.usd?.toFixed(2) ?? '?'})`);
          }
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (!raw.toLowerCase().includes('reject')) showToast(raw.slice(0, 150));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'TRADE'; }
      }
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

    // SuiAMI mode: if the button literally says SUIAMI, it's a SUIAMI click
    const _btnEl2 = document.getElementById('wk-send-btn');
    const _btnText = _btnEl2?.textContent?.trim() ?? '';
    const isSelfTarget = sec?.classList.contains('wk-dd-ns-section--self-target') ?? false;
    const isOwned = sec?.classList.contains('wk-dd-ns-section--owned') ?? false;
    const suiamiName = nsLabel.trim().length > 0 ? nsLabel.trim() : (app.suinsName ?? '');
    const inEqualsOut = _getSwapInCoinType() === (SWAP_OUT_OPTIONS.find(o => o.key === swapOutputKey)?.coinType ?? '');
    const isSwapOrSend = coinChipsOpen && !inEqualsOut; // swap takes priority
    const isSendMode = coinChipsOpen && inEqualsOut && nsLabel.trim().length > 0 && !isSelfTarget && !isOwned; // sending to other
    const _hasListing = !!(nsKioskListing || nsTradeportListing);
    const suiamiClick = !_hasListing && (_btnText === 'SUIAMI' || (!isSwapOrSend && !isSendMode && (((isSelfTarget || isOwned) && nsLabel.trim().length > 0) || (!nsLabel.trim() && !!app.suinsName))));
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
        const message = buildSuiamiMessage(bare, ws2.address, nftId, {
          btc: app.btcAddress || undefined,
          sol: app.solAddress || undefined,
          eth: app.ethAddress || undefined,
        }, app.usd ?? undefined);
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
          const _skiNet = (() => { try { return localStorage.getItem('ski:network-pref') || 'sui'; } catch { return 'sui'; } })();
          showToast(`${_skiNet}@${bare} \u2014 SUIAMI proof copied \u2713`);
        } catch {
          const _skiNet2 = (() => { try { return localStorage.getItem('ski:network-pref') || 'sui'; } catch { return 'sui'; } })();
          showToast(`${_skiNet2}@${bare} \u2014 SUIAMI proof copied \u2713`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('reject')) showToast(msg);
      } finally {
        _updateSendBtnMode();
      }
      return;
    }

    // Thunder mode — signal to recipient (from main input box, not conversation reply)
    const _actionBtn = document.getElementById('wk-send-btn');
    const thunderBtn = _actionBtn?.classList.contains('wk-send-btn--thunder') || _actionBtn?.textContent?.trim() === 'Thunder';
    if (thunderBtn) {
      let recipientName = nsLabel.trim();
      // If input is empty, populate with most-thundered owned name
      if (!recipientName) {
        const top = Object.entries(_thunderCounts)
          .filter(([, c]) => c > 0)
          .sort(([, a], [, b]) => b - a)[0];
        if (top) {
          recipientName = top[0];
          nsLabel = recipientName;
          const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (inp) inp.value = recipientName;
          skipNextFocusClear = true;
          _syncNftCardToInput();
          fetchAndShowNsPrice(recipientName);
        }
        if (!recipientName) return;
      }
      const ws3 = getState();
      if (!ws3.address) return;
      // Show card + reply input only (no conversation history)
      if (!_thunderConvoOpen) {
        const grid = document.querySelector('.wk-ns-owned-grid') as HTMLElement | null;
        const chip = grid?.querySelector<HTMLElement>(`.wk-ns-owned-chip[data-domain="${recipientName}"]`);
        _showNftPopover(chip || document.getElementById('ski-nft-inline')!, recipientName);
        _nftPopoverPinned = true;
        // Open convo area but clear history bubbles
        _thunderConvoOpen = true;
        const convoEl = document.getElementById('wk-thunder-convo');
        const cardEl = document.getElementById('ski-nft-inline');
        const quickBtn = document.getElementById('wk-thunder-quick');
        if (cardEl) cardEl.removeAttribute('hidden');
        if (convoEl) convoEl.removeAttribute('hidden');
        quickBtn?.classList.add('wk-thunder-quick--active');
        try { localStorage.setItem('ski:thunder-card-open', '1'); } catch {}
      }
      // Clear conversation bubbles — just show reply input
      const received = document.getElementById('wk-thunder-received');
      if (received) received.innerHTML = '';
      const replyWrap = document.getElementById('wk-thunder-reply-wrap');
      if (replyWrap?.hasAttribute('hidden')) replyWrap.removeAttribute('hidden');
      const msgInput = document.getElementById('wk-thunder-msg') as HTMLInputElement | null;
      if (msgInput) { msgInput.value = ''; msgInput.focus(); }
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
      if (selfSend && isSwap) {
        // Self-swap: convert between tokens in your own wallet
        const swap = await buildSwapTx(ws2.address, coinType, outOpt.coinType, amountMist);
        await signAndExecuteTransaction(swap.txBytes);
        showToast(`Swapped ${swap.fromSymbol} \u2192 $${amountStr} ${swap.toSymbol} \u2713`);
      } else if (selfSend) {
        showToast('Input and output are the same token');
        return;
      } else {
        // Send selected token directly to recipient — no swap
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
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_LONG_MS);
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
    // Strip non-numeric characters (allow digits and one decimal point)
    const filtered = amountInput.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\./g, '$1');
    if (filtered !== amountInput.value) amountInput.value = filtered;
    const val = filtered.trim();
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
    _clearNsInput();
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
    // Clear name input first
    _clearNsInput();
    // Then clear amount
    pendingSendAmount = '';
    const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
    document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
    const _ac = document.getElementById('wk-send-clear');
    if (_ac) _ac.style.display = 'none';
    const _sb = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (_sb) _sb.disabled = true;
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
    const hasSol = networkView === 'sol' && !!app.solAddress;
    const qrAddr = hasBtc ? app.btcAddress : hasSol ? app.solAddress : ws.address;
    const qrMode: 'sui' | 'usd' | 'bw' | 'btc' | 'sol' = hasBtc ? 'btc' : hasSol ? 'sol' : balView;
    _getAddrQrSvg(qrAddr, qrMode).then(svg => {
      if (document.getElementById('wk-addr-qr')) addrQrSlot.innerHTML = svg;
    }).catch(() => {});
  }

  // ─── NS domain row bindings ─────────────────────────────────────────
  _loadRosterQr(); // populate QR from initial _nsOwnedListHtml render
  _attachOwnedGridWheel();
  _attachNftPopoverListeners();
  _restoreRosterScroll();
  _restoreConversation();
  const nsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
  nsInput?.addEventListener('click', (e) => e.stopPropagation());
  function _togglePasteBtn() {}
  nsInput?.addEventListener('focus', (e) => {
    e.stopPropagation();
    if (skipNextFocusClear) { skipNextFocusClear = false; return; }
    nsInput.value = '';
    nsInput.placeholder = 'name';
    nsLabel = '';
    nsAvail = null;
    nsTargetAddress = null;
    nsNftOwner = null;
    nsPriceUsd = null;
    nsPriceFetchFor = '';
    _suiamiVerifyHtml = '';
    // Clear amount
    pendingSendAmount = '';
    const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
    document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
    const _ac = document.getElementById('wk-send-clear');
    if (_ac) _ac.style.display = 'none';
    const _sb = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
    if (_sb) _sb.disabled = true;
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
  // Enter in conversation reply input or inline ⚡ button → send signal
  const _thunderSendFromConvo = async () => {
    const msgInput = document.getElementById('wk-thunder-msg') as HTMLInputElement | null;
    const msg = msgInput?.value.trim();
    if (!msg) return;
    // Determine recipient: card domain (for replies to owned names) or input box (for new conversations)
    const cardDomain = document.getElementById('ski-nft-inline')?.dataset.domain?.toLowerCase();
    const recipientName = cardDomain || nsLabel.trim().replace(/\.sui$/, '').toLowerCase();
    if (!recipientName) return;
    const ws = getState();
    if (!ws.address) return;
    const sendBtn = document.getElementById('wk-thunder-send') as HTMLButtonElement | null;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '\u2026'; }
    try {
      const { sendThunder } = await import('./client/thunder.js');
      const senderName = app.suinsName || '';
      const _logName = senderName || ws.address;
      let _txOk = false;
      try {
        const groupUuid = `thunder-${senderName}-${recipientName}`;
        await sendThunder({
  
          groupRef: { uuid: groupUuid },
          text: msg,
        });
        _txOk = true;
        await _storeThunderLocal(_logName, recipientName, msg, 'out', undefined, nsTargetAddress ?? undefined);
      } catch (txErr) {
        throw txErr;
      }
      if (_txOk) {
        showToast(`\u26a1 Signal sent to ${recipientName}.sui`);
        if (msgInput) msgInput.value = '';
        await _refreshThunderLocalCounts();
        _thunderConvoTarget = '';
        _renderConversation(recipientName);
        _syncNftCardToInput();
        // Auto-add recipient as wishlist chip if not in roster
        _addThunderContact(recipientName);
        // Auto-add @mentioned names as contacts
        const mentions = msg.match(/@([a-z0-9-]{3,63})(?:\.sui)?/gi);
        if (mentions) {
          for (const m of mentions) {
            const bare = m.slice(1).replace(/\.sui$/i, '').toLowerCase();
            if (bare) _addThunderContact(bare);
          }
        }
        // Refocus reply input for next message
        if (msgInput) msgInput.focus();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Signal failed';
      if (!errMsg.toLowerCase().includes('reject')) showToast(errMsg);
    } finally {
      if (sendBtn) { sendBtn.textContent = '\u26a1'; sendBtn.disabled = false; }
    }
  };
  document.getElementById('wk-thunder-msg')?.addEventListener('keydown', (e) => {
    // Backspace on @name tag — delete the whole name at once, leave just @
    if (e.key === 'Backspace') {
      const inp = e.target as HTMLInputElement;
      const val = inp.value;
      const pos = inp.selectionStart ?? val.length;
      const before = val.slice(0, pos);
      const tagMatch = before.match(/@([a-z0-9-]{1,63})(\s?)$/i);
      if (tagMatch) {
        e.preventDefault();
        const tagStart = pos - tagMatch[0].length;
        inp.value = val.slice(0, tagStart + 1) + val.slice(pos);
        inp.setSelectionRange(tagStart + 1, tagStart + 1);
        return;
      }
    }
    if (e.key === 'Enter') { e.preventDefault(); _thunderSendFromConvo(); }
  });
  document.getElementById('wk-thunder-send')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _thunderSendFromConvo();
  });

  nsInput?.addEventListener('input', (e) => {
    _togglePasteBtn();
    const val = (e.target as HTMLInputElement).value.trim().toLowerCase();

    // Detect Sui hex address typed/pasted into the name input
    if (/^0x[0-9a-f]+$/i.test(val)) {
      // Full 66-char Sui address — set as target, switch to SEND mode
      if (val.length === 66 && /^0x[0-9a-f]{64}$/i.test(val)) {
        nsTargetAddress = val;
        nsLabel = val;
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
        const _hexVal = val;
        lookupSuiNS(_hexVal).then((name: string | null) => {
          if (name && nsLabel === _hexVal) {
            const bare = name.replace(/\.sui$/, '');
            nsLabel = bare;
            try { localStorage.setItem('ski:ns-label', bare); } catch {}
            const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
            if (inp) inp.value = bare;
            if (dotSui) dotSui.style.display = '';
            if (priceChip) priceChip.style.display = '';
            fetchAndShowNsPrice(bare);
          }
        });
      }
      // Partial hex (< 66 chars) — skip, let paste handler or further typing complete it
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
    // Don't save partial typing to localStorage — wait for debounced resolution
    // try { if (validLabel) localStorage.setItem('ski:ns-label', val); } catch {}
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
    _syncNftCardToInput();
    const btn = document.getElementById('wk-dd-ns-register') as HTMLButtonElement | null;
    if (btn) btn.title = !validLabel && val ? 'Invalid SuiNS name' : val ? `Mint ${val}.sui` : 'Mint .sui';
    if (nsPriceDebounce) clearTimeout(nsPriceDebounce);
    if (validLabel) nsPriceDebounce = setTimeout(() => fetchAndShowNsPrice(val), NS_LOOKUP_DEBOUNCE_MS);
  });

  // Periodic validity recheck for the active label
  if (_nsValidityInterval) clearInterval(_nsValidityInterval);
  _nsValidityInterval = setInterval(() => {
    const label = nsLabel.trim().toLowerCase();
    if (label && isValidNsLabel(label) && !nsSubnameParent) {
      fetchAndShowNsPrice(label);
    }
  }, NS_LOOKUP_POLL_MS);

  // Toggle roster visibility when clicking domain-row outside the input/buttons
  document.querySelector('.wk-dd-ns-domain-row')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // Don't toggle if the user clicked the input, register button, pin button, or price chip
    if (t.closest('#wk-ns-label-input') || t.closest('#wk-dd-ns-register') || t.closest('#wk-ns-pin-btn') || t.closest('#wk-ns-price-chip') || t.closest('#wk-send-btn')) return;
    _toggleRoster();
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
      _toggleRoster();
      return;
    }
    // Grace date span — click to toggle roster
    if (target.closest('.wk-ns-target-grace')) {
      _toggleRoster();
      return;
    }
    // Dim target row — click to toggle roster (names list) instead of copy
    const dimRow = target.closest<HTMLElement>('.wk-ns-target-row--dim');
    if (dimRow) {
      _toggleRoster();
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
    // Transfer button — open recipient input
    if (target.id === 'wk-ns-transfer-btn') {
      e.stopPropagation();
      nsTransferInputOpen = true;
      nsTransferRecipient = '';
      _patchNsRoute();
      setTimeout(() => {
        const inp = document.getElementById('wk-ns-transfer-input') as HTMLInputElement | null;
        if (inp) inp.focus();
      }, 50);
      return;
    }
    // Transfer cancel
    if (target.id === 'wk-ns-transfer-cancel') {
      e.stopPropagation();
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      _patchNsRoute();
      return;
    }
    // Set target address button
    if (target.id === 'wk-ns-set-target-btn') {
      e.stopPropagation();
      nsShowTargetInput = true;
      nsNewTargetAddr = '';
      _patchNsRoute();
      setTimeout(() => {
        const inp = document.getElementById('wk-ns-set-target-input') as HTMLInputElement | null;
        if (inp) inp.focus();
      }, 50);
      return;
    }
    // Set target cancel
    if (target.id === 'wk-ns-set-target-cancel') {
      e.stopPropagation();
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
      return;
    }
    // Set target submit
    if (target.id === 'wk-ns-set-target-submit') {
      e.stopPropagation();
      const addr = nsNewTargetAddr.trim();
      if (!addr || (!addr.startsWith('0x') && !addr.includes('.sui'))) { showToast('Invalid address'); return; }
      const ws2 = getState();
      if (!ws2.address) return;
      const label = nsLabel.trim();
      if (!label) return;
      const btn = target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = '\u2026';
      (async () => {
        try {
          const resolvedAddr = addr.includes('.sui') ? await resolveNameToAddress(addr.replace(/\.sui$/, '')) : addr;
          if (!resolvedAddr) { showToast('Could not resolve address'); btn.disabled = false; btn.textContent = '\u2713'; return; }
          const txBytes = await buildSetTargetAddressTx(ws2.address, `${label}.sui`, resolvedAddr);
          await signAndExecuteTransaction(txBytes);
          nsTargetAddress = resolvedAddr;
          nsShowTargetInput = false;
          nsNewTargetAddr = '';
          _patchNsRoute();
          showToast(`Target set to ${resolvedAddr.slice(0, 8)}\u2026`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (!msg.toLowerCase().includes('reject')) showToast(msg || 'Failed');
          btn.disabled = false;
          btn.textContent = '\u2713';
        }
      })();
      return;
    }
    // Target cancel
    if (target.id === 'wk-ns-target-cancel') {
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
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
    if (target.id === 'wk-ns-transfer-input') {
      nsTransferRecipient = (target as HTMLInputElement).value.trim();
    }
    if (target.id === 'wk-ns-set-target-input') {
      nsNewTargetAddr = (target as HTMLInputElement).value.trim();
    }
  });
  document.getElementById('wk-ns-route')?.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'wk-ns-set-target-input' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-ns-set-target-submit')?.click();
    }
    if (target.id === 'wk-ns-set-target-input' && (e as KeyboardEvent).key === 'Escape') {
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      _patchNsRoute();
    }
    if (target.id === 'wk-ns-target-input' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-ns-target-submit')?.click();
    }
    if (target.id === 'wk-ns-target-input' && (e as KeyboardEvent).key === 'Escape') {
      nsShowTargetInput = false;
      nsNewTargetAddr = '';
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      _patchNsRoute();
    }
    if (target.id === 'wk-ns-transfer-input' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      document.getElementById('wk-ns-transfer-submit')?.click();
    }
    if (target.id === 'wk-ns-transfer-input' && (e as KeyboardEvent).key === 'Escape') {
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
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
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
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

  // Transfer-submit uses click delegation (button is created dynamically by _patchNsRoute)
  let _transferSubmitBusy = false;
  document.getElementById('wk-ns-route')?.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id !== 'wk-ns-transfer-submit') return;
    ev.stopPropagation();
    if (_transferSubmitBusy) return;
    const ws2 = getState();
    if (!ws2.address) return;
    let addr = nsTransferRecipient.trim();
    if (!addr) { showToast('Enter a recipient address or name'); return; }
    const submitBtn = document.getElementById('wk-ns-transfer-submit') as HTMLButtonElement | null;
    _transferSubmitBusy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u2026'; }
    try {
      // Resolve SuiNS name to address if input isn't a hex address
      if (!/^0x[0-9a-fA-F]{64}$/.test(addr)) {
        const namePart = addr.replace(/\.sui$/i, '').toLowerCase();
        if (namePart.length < 3 || !/^[a-z0-9-]+$/.test(namePart)) {
          showToast('Enter a valid Sui address (0x\u2026) or SuiNS name');
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
      const domain = label.endsWith('.sui') ? label : `${label}.sui`;
      const txBytes = await buildTransferNftTx(ws2.address, domain, addr);
      await signAndExecuteTransaction(txBytes);

      const short = addr.slice(0, 6) + '\u2026' + addr.slice(-4);
      showToast(`Transferred ${domain} to ${short} \u2713`);

      // Clean up state
      nsTransferInputOpen = false;
      nsTransferRecipient = '';
      nsOwnedFetchedFor = ''; // force re-fetch owned domains
      nsOwnedDomains = nsOwnedDomains.filter(d => d.name !== domain);
      _cacheOwnedDomains(ws2.address, nsOwnedDomains);
      nsAvail = null;
      nsTargetAddress = null;
      nsNftOwner = null;
      _patchNsRoute();
      _patchNsStatus();
      _patchNsOwnedList();

      // Background refresh
      fetchOwnedDomains(ws2.address).then(domains => {
        nsOwnedDomains = domains;
        nsOwnedFetchedFor = ws2.address;
        _cacheOwnedDomains(ws2.address, domains);
        _patchNsOwnedList();
      }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transfer failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      _transferSubmitBusy = false;
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
    const pinBtn = document.getElementById('wk-ns-pin-btn');

    // If route is already open (address showing) → second click does subname flow
    if (nsRouteOpen && pinBtn?.textContent === '\u25b8') {
      if (pinBtn) pinBtn.style.opacity = '0.4';
      try {
        const domain = label.endsWith('.sui') ? label : `${label}.sui`;
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
      return;
    }

    // First click → show the proper target address route row, flip arrow to right
    nsRouteOpen = true;
    _persistRouteOpen();
    if (pinBtn) pinBtn.textContent = '\u25b8';
    _patchNsRoute();
    const route = document.getElementById('wk-ns-route');
    if (route) route.classList.remove('wk-ns-route-wrap--hidden');
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
      setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_SHORT_MS);
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
        setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_SHORT_MS);
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

    // ── Marketplace purchase (kiosk or Tradeport) ──
    if (_nsListing()) {
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
        setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
        // Notify idle overlay to refresh status (TRADE → SUIAMI transition)
        _preRumbledNames.add(label.toLowerCase());
        try { localStorage.setItem('ski:pre-rumbled', JSON.stringify([..._preRumbledNames])); } catch {}
        window.dispatchEvent(new CustomEvent('ski:name-acquired', { detail: { name: label } }));
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
          // Notify idle overlay to refresh status (MINT → SUIAMI transition)
          _preRumbledNames.add(label.toLowerCase());
          try { localStorage.setItem('ski:pre-rumbled', JSON.stringify([..._preRumbledNames])); } catch {}
          window.dispatchEvent(new CustomEvent('ski:name-acquired', { detail: { name: label } }));
          showToast(`${domain} registered \u2713 ${digest ? digest.slice(0, 8) + '\u2026' : ''}`);
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
      // Force fresh price — stale localStorage price causes insufficient coin splits
      const freshPrice = await fetchSuiPrice() ?? suiPriceCache?.price;
      const result = await buildRegisterSplashNsTx(ws2.address, domain, freshPrice, !app.suinsName, selectedCoinSymbol ?? undefined);
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

  // Thunder polling disabled — pending v4 migration to Sui Stack Messaging SDK (#63)
  if (_thunderPollTimer) { clearInterval(_thunderPollTimer); _thunderPollTimer = null; }
  _thunderCounts = {};
  try { localStorage.removeItem('ski:thunder-counts'); } catch {}

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

    // Header click (except tally button) → toggle roster
    if (t.closest('.wk-ns-owned-header') && !t.closest('#wk-roster-tally')) {
      _toggleRoster();
      return;
    }

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
    // Don't re-render the roster — just update dim classes in-place to avoid re-sorting.
    // Never dim chips that have pending thunder — they need to stay prominent.
    const allChips = document.querySelectorAll('.wk-ns-owned-chip');
    allChips.forEach(c => {
      const cd = (c as HTMLElement).dataset.domain?.toLowerCase() ?? '';
      const hasThunder = (_thunderCounts[cd] ?? 0) > 0;
      c.classList.toggle('wk-ns-owned-chip--dim', !hasThunder && cd !== domain.toLowerCase() && domain.length > 0);
    });
    _updateSendBtnMode();
    _setInput();
    _syncNftCardToInput();
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

  // ☀️ sun button — fresh on-chain scan + decrypt all signals across all owned names
  document.getElementById('ski-nft-inline')?.addEventListener('click', async (e) => {
    const sunEl = (e.target as HTMLElement).closest('#ski-nft-sun');
    if (!sunEl) return; // not the sun — fall through to card click below
    e.stopPropagation();
    if (_thunderDecryptBusy) return;
    _thunderDecryptBusy = true;
    (sunEl as HTMLElement).style.opacity = '0.4';
    try {
      const { getThunders } = await import('./client/thunder.js');
      const ws = getState();
      if (!ws.address) return;
      const _myLog = app.suinsName || ws.address;
      let totalDecrypted = 0;
      let lastSender = '';
      const namesWithThunder = Object.entries(_thunderCounts).filter(([, c]) => c > 0);
      if (namesWithThunder.length === 0) {
        showToast('\u2600\ufe0f Nothing to purge');
      } else {
        for (const [name] of namesWithThunder) {
          const groupUuid = `thunder-${name}`;
          const { messages } = await getThunders({
    
            groupRef: { uuid: groupUuid },
          });
          for (const m of messages) {
            await _storeThunderLocal(_myLog, m.senderAddress.slice(0, 8), m.text, 'in', m.senderAddress.slice(0, 8), m.senderAddress);
            lastSender = m.senderAddress;
          }
          totalDecrypted += messages.length;
          _thunderCounts[name] = 0;
        }
        if (totalDecrypted > 0) showToast(`\u2600\ufe0f ${totalDecrypted} signal${totalDecrypted > 1 ? 's' : ''} purged`);
      }
      try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
      _patchNsOwnedList();
      await _refreshThunderLocalCounts();
      _syncNftCardToInput();
      if (lastSender) {
        nsLabel = lastSender;
        const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (inp) inp.value = lastSender;
        skipNextFocusClear = true;
        fetchAndShowNsPrice(lastSender);
      }
      if (_thunderConvoOpen) {
        _thunderConvoTarget = '';
        const cardDomain = document.getElementById('ski-nft-inline')?.dataset.domain;
        if (cardDomain) _renderConversation(cardDomain, true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Decrypt failed';
      if (!msg.toLowerCase().includes('reject')) showToast(msg);
    } finally {
      _thunderDecryptBusy = false;
      (sunEl as HTMLElement).style.opacity = '';
    }
  });

  // NFT card click → populate input with card domain + toggle conversation
  document.getElementById('ski-nft-inline')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) return;
    if ((e.target as HTMLElement).closest('#ski-nft-sun')) return; // handled above
    e.stopPropagation();
    const domain = document.getElementById('ski-nft-inline')?.dataset.domain?.toLowerCase();
    if (domain) {
      // Simulate chip click: set input, update all status immediately
      nsLabel = domain;
      const inp = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (inp) inp.value = domain;
      skipNextFocusClear = true;
      const isOwned = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === domain);
      nsAvail = isOwned ? 'owned' : null;
      nsPriceUsd = null;
      nsPriceFetchFor = '';
      nsGraceEndMs = 0;
      nsTargetAddress = null;
      nsNftOwner = null;
      nsLastDigest = '';
      nsKioskListing = null; nsTradeportListing = null;
      nsShadeOrder = null;
      pendingSendAmount = '';
      const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
      if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
      document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
      const _ac = document.getElementById('wk-send-clear');
      if (_ac) _ac.style.display = 'none';
      _patchNsPrice();
      _patchNsStatus();
      _patchNsRoute();
      _updateSendBtnMode();
      fetchAndShowNsPrice(domain);
    }
    _toggleThunderConvo();
  });

  // Dismiss button on NFT card — clears name, card, thunder input, amount
  document.getElementById('ski-nft-inline')?.addEventListener('click', (e) => {
    const dismiss = (e.target as HTMLElement).closest('#ski-nft-dismiss');
    if (!dismiss) return;
    e.stopPropagation();
    _clearNsInput();
    pendingSendAmount = '';
    const _ai = document.getElementById('wk-send-amount') as HTMLInputElement | null;
    if (_ai) { _ai.value = ''; _ai.classList.remove('wk-send-amount--over'); }
    document.querySelector('.wk-send-dollar')?.classList.remove('wk-send-dollar--over');
    const _ac = document.getElementById('wk-send-clear');
    if (_ac) _ac.style.display = 'none';
    const nsClearBtn = document.getElementById('wk-ns-clear-btn');
    if (nsClearBtn) nsClearBtn.style.display = 'none';
    // Clear thunder convo target + input
    _thunderConvoTarget = '';
    _thunderConvoOpen = false;
    const thunderInput = document.getElementById('wk-thunder-reply') as HTMLInputElement | null;
    if (thunderInput) thunderInput.value = '';
    _patchNsPrice();
    _patchNsStatus();
    _patchNsRoute();
    _updateSendBtnMode();
    _syncNftCardToInput();
    _toggleThunderConvo();
  });

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
  nsTransferInputOpen = false;
  nsTransferRecipient = '';
  _thunderCounts = {};
  _thunderLocalCounts = {};
  _thunderDecryptBusy = false;
  _thunderConvoOpen = false;
  _thunderCryptoKey = null;
  try { localStorage.removeItem('ski:thunder-card-open'); } catch {}
  try { localStorage.removeItem('ski:ns-variant'); } catch {}
  try { sessionStorage.removeItem('ski:thunder-convo'); } catch {}
  _thunderConvoTarget = '';
  if (_thunderPollTimer) { clearInterval(_thunderPollTimer); _thunderPollTimer = null; }
  nsRosterOpen = false; _persistRosterOpen();
  try { localStorage.removeItem('ski:roster-scroll'); } catch {}
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
    const header = (els.widget as HTMLElement | null)?.closest('.ski-header') as HTMLElement | null;
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

  // Cache rendered shell so the inline boot script can restore it on next load,
  // eliminating the FOUC between HTML parse and JS bundle execution.
  try {
    if (ws.address) {
      const shell: Record<string, string> = {};
      if (els.skiBtn) shell.btn = els.skiBtn.innerHTML;
      if (els.skiDot) shell.dot = els.skiDot.innerHTML;
      if (els.skiDot) shell.dotD = els.skiDot.style.display;
      if (els.profile) shell.pro = els.profile.innerHTML;
      if (els.skiMenu) shell.menu = els.skiMenu.innerHTML;
      localStorage.setItem('ski:shell:v2', JSON.stringify(shell));
    } else {
      localStorage.removeItem('ski:shell:v2');
    }
  } catch {}

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

let _idleOverlay: HTMLElement | null = null;
let _idleOverlayClickFn: ((e: Event) => void) | null = null;
let _idleDocClickFn: ((e: Event) => void) | null = null;
let _idleVideoBlobUrl: string | null = null;

function bindEvents() {
  els.skiDot?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_idleOverlay) { _idleOverlay.remove(); document.getElementById('ski-idle-card')?.remove(); _idleOverlay = null; document.querySelector<HTMLElement>('.ski-header')?.style.removeProperty('--ski-header-w'); document.getElementById('wk-dd-ns-section')?.classList.remove('wk-dd-ns-section--elevated'); try { localStorage.removeItem('ski:idle-open'); } catch {} return; }
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
    if (modalOpen) closeModal();

    // Three-state cycle: menu → overlay → menu(collapsed) → overlay → ...
    if (_idleOverlay) {
      // Overlay open → close it, open SKI menu collapsed
      _idleOverlay.remove(); document.getElementById('ski-idle-card')?.remove(); _idleOverlay = null; document.querySelector<HTMLElement>('.ski-header')?.style.removeProperty('--ski-header-w'); document.getElementById('wk-dd-ns-section')?.classList.remove('wk-dd-ns-section--elevated');
      try { localStorage.removeItem('ski:idle-open'); } catch {}
      // Collapse all sections
      addrSectionOpen = false; _persistAddrSectionOpen();
      coinChipsOpen = false; _persistCoinChipsOpen();
      nsRosterOpen = false; _persistRosterOpen();
      _thunderConvoOpen = false;
      _thunderConvoTarget = '';
      _nftPopoverPinned = false;
      try { localStorage.setItem('ski:thunder-card-open', '0'); } catch {}
      try { sessionStorage.removeItem('ski:thunder-convo'); } catch {}
      app.skiMenuOpen = true;
      try { localStorage.setItem('ski:lift', '1'); } catch {}
      render();
    } else if (app.skiMenuOpen) {
      // Menu open → close it, open overlay
      app.skiMenuOpen = false;
      try { localStorage.setItem('ski:lift', '0'); } catch {}
      render();
      _showIdleOverlay();
    } else {
      // Nothing open → open SKI menu
      app.skiMenuOpen = true;
      try { localStorage.setItem('ski:lift', '1'); } catch {}
      render();
    }
  });

  els.skiBtn?.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown') {
      e.preventDefault();
      if (getState().address) {
        if (!_idleOverlay) {
          _showIdleOverlay();
          setTimeout(() => {
            const ti = document.getElementById('ski-idle-thunder') as HTMLInputElement | null;
            if (ti) ti.focus();
          }, 100);
        }
        return;
      }
      if (modalOpen) { closeModal(); return; }
      openModal(true);
    }
  });

  // WaaP provider picker — click the badge to choose Google/X/Email/Discord
  document.addEventListener('click', (e) => {
    const badge = (e.target as HTMLElement).closest('[data-provider-picker]') as HTMLElement | null;
    if (!badge) {
      // Close any open picker
      document.querySelector('.ski-provider-picker')?.remove();
      return;
    }
    e.stopPropagation();
    // Toggle picker
    const existing = document.querySelector('.ski-provider-picker');
    if (existing) { existing.remove(); return; }
    const ws = getState();
    if (!ws.address) return;
    const rect = badge.getBoundingClientRect();
    const picker = document.createElement('div');
    picker.className = 'ski-provider-picker';
    picker.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;z-index:99999;display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:6px;background:rgba(10,14,28,0.95);border:1px solid rgba(255,255,255,0.15);border-radius:8px;backdrop-filter:blur(8px)`;
    const providers = [
      { id: 'google', label: 'Google', icon: SOCIAL_ICON_GOOGLE },
      { id: 'x', label: 'X', icon: SOCIAL_ICON_X },
      { id: 'discord', label: 'Discord', icon: SOCIAL_ICON_DISCORD },
      { id: 'email', label: 'Email', icon: SOCIAL_ICON_EMAIL },
    ];
    for (const p of providers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = p.label;
      btn.style.cssText = 'all:unset;cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px;transition:background 0.1s';
      btn.innerHTML = p.icon.replace(/width="\d+"/, 'width="24"').replace(/height="\d+"/, 'height="24"');
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try { localStorage.setItem(`ski:waap-provider:${ws.address}`, p.id); } catch {}
        picker.remove();
        renderWidget();
        renderSkiBtn();
      });
      picker.appendChild(btn);
    }
    document.body.appendChild(picker);
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

  // Track whether the page has focus — ignore the click that restores focus
  let _hadFocus = document.hasFocus();
  window.addEventListener('blur', () => { _hadFocus = false; });
  window.addEventListener('focus', () => {
    setTimeout(() => { _hadFocus = true; }, 200);
    if (getState().address) refreshPortfolio(true);
  });

  document.addEventListener('click', (e) => {
    if (!app.skiMenuOpen) return;
    if (!_hadFocus) return; // click was just to bring focus back to the window
    if (els.skiDot?.contains(e.target as Node)) return;
    if (els.skiBtn?.contains(e.target as Node)) return;
    if (els.skiMenu?.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest?.('#ski-nft-popover')) return;
    if ((e.target as HTMLElement).closest?.('.app-toast')) return;
    app.skiMenuOpen = false;
    try { localStorage.setItem('ski:lift', '0'); } catch {}
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (getState().address && document.visibilityState === 'visible') refreshPortfolio(true);
  });

  // Idle screensaver — show SKI pixel art over menu
  let _idleTimer: ReturnType<typeof setTimeout> | null = null;
  const IDLE_MS = 15_000; // 15 seconds

  const _showIdleOverlay = () => {
      if (!app.skiMenuOpen && !getState().address && !localStorage.getItem('ski:last-address')) return;
      if (_idleOverlay) { _idleOverlay.remove(); document.getElementById('ski-idle-card')?.remove(); _idleOverlay = null; document.querySelector<HTMLElement>('.ski-header')?.style.removeProperty('--ski-header-w'); document.getElementById('wk-dd-ns-section')?.classList.remove('wk-dd-ns-section--elevated'); }
      // Ensure menu is open
      if (!app.skiMenuOpen && getState().address) {
        app.skiMenuOpen = true;
        try { localStorage.setItem('ski:lift', '1'); } catch {}
        render();
      }
      // Position overlay to span from first to last visible header button
      const headerBtns = Array.from(document.querySelectorAll('.ski-header > *')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!headerBtns.length) return;
      let minL = Infinity, maxR = -Infinity, maxB = -Infinity;
      for (const btn of headerBtns) {
        const r = btn.getBoundingClientRect();
        if (r.left < minL) minL = r.left;
        if (r.right > maxR) maxR = r.right;
        if (r.bottom > maxB) maxB = r.bottom;
      }
      const headerRect = { left: minL, right: maxR, bottom: maxB, width: maxR - minL };

      _idleOverlay = document.createElement('div');
      _idleOverlay.className = 'ski-idle-overlay';
      const _headerEl = document.querySelector('.ski-header') as HTMLElement;
      const headerBox = _headerEl?.getBoundingClientRect();
      const width = headerRect.width;
      const rightOffset = headerBox ? headerBox.right - headerRect.right : 0;
      _idleOverlay.style.position = 'absolute';
      _idleOverlay.style.right = `${rightOffset}px`;
      _idleOverlay.style.left = 'auto';
      _idleOverlay.style.top = '100%';
      _idleOverlay.style.marginTop = '0';
      _idleOverlay.style.width = `${width}px`;
      // Build card + NS input for the idle overlay — mirrors full SKI menu NS row
      const _idleCardDomain = document.getElementById('ski-nft-inline')?.dataset.domain || _lastNftCardDomain || '';
      const _idleVariant: SkiDotVariant = (nsAvail === 'owned' || nsAvail === 'taken') ? 'blue-square' : nsAvail === 'available' ? 'green-circle' : 'black-diamond';
      // Auto-populate with highest-signal owned name if no active input
      let _idleInputVal = nsLabel.trim();
      if (!_idleInputVal && nsOwnedDomains.length > 0) {
        const topName = [...nsOwnedDomains]
          .map(d => {
            const b = d.name.replace(/\.sui$/, '').toLowerCase();
            return { bare: b, score: (_thunderCounts[b] ?? 0) + (_thunderLocalCounts[b] ?? 0) };
          })
          .sort((a, b) => b.score - a.score)[0];
        if (topName && topName.score > 0) _idleInputVal = topName.bare;
      }

      _idleOverlay.innerHTML = `
        <div class="ski-idle-media">
          <a class="ski-idle-version" href="https://www.npmjs.com/package/sui.ski" target="_blank" rel="noopener noreferrer">v${SKI_VERSION}</a>
          <video class="ski-idle-img" autoplay loop muted playsinline poster="/assets/ski-idle.gif"><source src="/assets/ski-idle.webm" type="video/webm"><source src="/assets/ski-idle.mp4" type="video/mp4"></video>
          <div class="ski-idle-iusd-btn" id="ski-idle-iusd" title="Swap 95% of wallet to iUSD"></div>
          <div class="ski-idle-ns-row">
            <span class="wk-ns-status" id="ski-idle-status" title="Set as default / show addresses" style="cursor:pointer">${_nsStatusSvg(_idleVariant)}</span>
            <div class="ski-idle-ns-input-wrap">
              <input class="ski-idle-ns-input" id="ski-idle-ns" type="text" value="${esc(_idleInputVal)}" placeholder="name" spellcheck="false" autocomplete="off" maxlength="63" title="Search SuiNS names">
              <button class="ski-idle-ns-clear" id="ski-idle-clear" type="button" style="${_idleInputVal ? '' : 'display:none'}" title="Clear">\u2715</button>
              <span class="wk-ns-dot-sui" title=".sui namespace">.sui</span>
            </div>
            <button class="ski-idle-ns-action" id="ski-idle-action" type="button" disabled title="SUIAMI? I AM ${esc(app.suinsName?.replace(/\.sui$/, '') || 'you')}">SUIAMI</button>
          </div>
          <div class="ski-idle-thunder-convo" id="ski-idle-thunder-convo" hidden></div>
          <div class="ski-idle-context" id="ski-idle-price" hidden>
            <svg class="ski-idle-context-icon" viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#4da2ff" stroke="#fff" stroke-width="1.2"/></svg>
            <span class="ski-idle-context-text" id="ski-idle-price-text"></span>
          </div>
          <div class="ski-idle-addr-row" id="ski-idle-addr" hidden></div>
          <div id="ski-idle-card" class="ski-idle-card"></div>
          <div id="ski-idle-sol-qr" class="ski-idle-sol-qr" hidden></div>
          <div class="ski-idle-iusd-panel" id="ski-idle-iusd-panel" hidden>
            <div class="ski-idle-iusd-stats" id="ski-idle-iusd-stats"></div>
            <div class="ski-idle-iusd-controls">
              <button class="ski-idle-iusd-action ski-idle-iusd-action--mint" id="ski-idle-iusd-mint" type="button" title="Swap USDC \u2192 iUSD">Buy</button>
              <button class="ski-idle-iusd-action ski-idle-iusd-action--burn" id="ski-idle-iusd-burn" type="button" title="Burn iUSD \u2014 reduce supply">Burn</button>
              <button class="ski-idle-iusd-action ski-idle-iusd-action--ignite" id="ski-idle-iusd-ignite" type="button" title="Ignite \u2014 gas on any chain">\u26a1 Ignite</button>
            </div>
          </div>
          <div class="ski-idle-thunder-row">
            <button class="ski-idle-thunder-at" id="ski-idle-thunder-at" type="button" title="Tag a name"><svg width="16" height="16" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="3" fill="#4da2ff" stroke="white" stroke-width="1.5"/></svg></button>
            <button class="ski-idle-thunder-at-iusd ski-idle-quick-btn ski-idle-quick-btn--iusd" id="ski-idle-thunder-at-iusd" type="button" title="Attach amount">$</button>
            <div class="ski-idle-thunder-input-wrap">
              <input class="ski-idle-thunder-input" id="ski-idle-thunder" type="text" placeholder="" spellcheck="false" autocomplete="off" title="Send an encrypt signal">
              <div class="ski-idle-quick-actions" id="ski-idle-quick-actions">
                <button class="ski-idle-quick-btn ski-idle-quick-btn--green" type="button" title="Green circle" data-action="green"><svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#22c55e" stroke="white" stroke-width="1.5"/></svg></button>
                <button class="ski-idle-quick-btn ski-idle-quick-btn--squid" type="button" title="Squids" data-action="rumble">\ud83e\udd91</button>
                <button class="ski-idle-quick-btn ski-idle-quick-btn--iusd" type="button" title="iUSD" data-action="iusd">$</button>
              </div>
              <div class="ski-idle-thunder-send-group">
                <button class="ski-idle-quick-btn ski-idle-quick-btn--storm" id="ski-idle-thunder-send" type="button" title="Open Storm">\u26a1</button>
              </div>
            </div>
          </div>
        </div>
        <div class="ski-idle-bottom-row">
          <a href="https://x.com/intent/follow?screen_name=brando_sui" target="_blank" rel="noopener" class="ski-idle-follow" title="Follow @brando_sui on X"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="flex-shrink:0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> Follow</a>
          <button class="ski-idle-rumble" id="ski-idle-rumble" type="button" title="Rumble Your Squids">\ud83e\udd91 Rumble</button>
          <button class="ski-idle-next" id="ski-idle-next" type="button" title="t2000 Ship">\u203a</button>
        </div>
      `;

      // Append immediately so video starts loading and overlay is visible
      // while we bind the ~2000 lines of event handlers below.
      const headerEl = document.querySelector('.ski-header') as HTMLElement;
      (headerEl || document.body).appendChild(_idleOverlay);

      // Name lookup fires after event binding (line ~10275) so _updateIdleStatus is in scope

      // NS input on idle — full SKI menu behavior
      const _idleNsInput = _idleOverlay.querySelector('#ski-idle-ns') as HTMLInputElement | null;
      const _idleStatusEl = _idleOverlay.querySelector('#ski-idle-status');
      const _idleClearBtn = _idleOverlay.querySelector('#ski-idle-clear') as HTMLButtonElement | null;
      const _idleActionBtn = _idleOverlay.querySelector('#ski-idle-action') as HTMLButtonElement | null;
      const _idleThunderSend = _idleOverlay.querySelector('#ski-idle-thunder-send') as HTMLButtonElement | null;
      let _idleDebounce: ReturnType<typeof setTimeout> | null = null;
      let _thunderComposeDraft: ThunderComposeDraft | null = null;
      let _thunderComposeConfirmedRaw = '';
      let _thunderComposeStage: 'idle' | 'preview' | 'confirmed' | 'sending' = 'idle';

      const _updateIdleStatus = () => {
        if (!_idleStatusEl || !_idleActionBtn) return;
        const label = nsLabel.trim();
        const validLabel = isValidNsLabel(label);
        const ws = getState();
        const inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === label);
        // Also detect ownership via resolved NFT owner matching connected wallet
        const ownerMatch = nsNftOwner && ws.address && normalizeSuiAddress(nsNftOwner) === normalizeSuiAddress(ws.address);
        const isOwned = validLabel && (inRoster || ownerMatch || nsAvail === 'owned');
        const hasListing = validLabel && !!(nsKioskListing || nsTradeportListing);
        // Invalid label → black diamond, no action
        const variant: SkiDotVariant = !validLabel ? 'black-diamond'
          : (hasListing && !isOwned) ? 'orange-triangle'
          : (nsAvail === 'owned' || nsAvail === 'taken') ? 'blue-square'
          : nsAvail === 'available' ? 'green-circle'
          : nsAvail === 'grace' ? 'red-hexagon'
          : 'black-diamond';
        _idleStatusEl.innerHTML = _nsStatusSvg(variant);

        const _iamName = label || app.suinsName?.replace(/\.sui$/, '') || 'you';
        if (!label || !validLabel) {
          _idleActionBtn.textContent = 'SUIAMI';
          _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--suiami';
          _idleActionBtn.title = `SUIAMI? I AM ${_iamName}`;
          _idleActionBtn.disabled = !app.suinsName;
        } else if (hasListing && !isOwned) {
          const listing = _nsListing();
          if (listing) {
            const suiAmt = Number(BigInt(listing.priceMist)) / 1e9;
            const fee = listing.source === 'tradeport' ? suiAmt * 0.03 : 0;
            const totalSui = suiAmt + fee;
            const usdVal = suiPriceCache ? (totalSui * suiPriceCache.price) : null;
            const priceStr = usdVal != null ? `$${usdVal.toFixed(2)}` : `${totalSui.toFixed(2)} SUI`;
            const _totalSpendable = (app.usd ?? 0);
            const canAfford = usdVal != null ? _totalSpendable >= usdVal : false;
            _idleActionBtn.textContent = 'TRADE';
            _idleActionBtn.className = canAfford
              ? 'ski-idle-ns-action ski-idle-ns-action--trade'
              : 'ski-idle-ns-action ski-idle-ns-action--trade-unaffordable';
            _idleActionBtn.title = canAfford
              ? `Trade ${priceStr} for ${label}.sui`
              : `Insufficient balance — ${priceStr}`;
            _idleActionBtn.disabled = !canAfford;
          }
        } else if (nsAvail === 'available') {
          // Check if user can actually afford it with spendable tokens (SUI + USDC + NS)
          const _suiVal = app.sui * (suiPriceCache?.price ?? 0);
          const _usdcVal = walletCoins.find(c => c.symbol === 'USDC')?.balance ?? 0;
          const _nsVal = (app.nsBalance ?? 0) * (nsPriceUsd ?? 0);
          const _spendable = _suiVal + _usdcVal + _nsVal;
          const _mintCost = nsPriceUsd ?? 7.50;
          if (_spendable >= _mintCost) {
            _idleActionBtn.textContent = 'MINT';
            _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--mint';
            _idleActionBtn.title = `Mint ${label}.sui`;
            _idleActionBtn.disabled = false;
  
          } else {
            _idleActionBtn.textContent = 'Quest';
            _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--quest-bounty';
            _idleActionBtn.title = `Need $${_mintCost.toFixed(2)} — post a Quest for Chronicoms to fill`;
            _idleActionBtn.disabled = false;
            // Show SOL deposit QR on the overlay
            _showSolQr(_mintCost);
          }
        } else if (nsAvail === 'grace') {
          _idleActionBtn.textContent = 'Shade';
          _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--shade';
          _idleActionBtn.title = `Shade ${label}.sui \u2014 lock funds for grace expiry`;
          _idleActionBtn.disabled = false;
        } else if (nsAvail === 'taken' && !isOwned) {
          _idleActionBtn.textContent = 'Thunder';
          _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--thunder';
          _idleActionBtn.title = `Thunder \u2014 encrypt a signal to ${label}.sui`;
          _idleActionBtn.disabled = false;
        } else if (isOwned) {
          _idleActionBtn.textContent = 'SUIAMI';
          _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--suiami-active';
          _idleActionBtn.title = `SUIAMI? I AM ${_iamName}`;

          _idleActionBtn.disabled = false;
        } else {
          _idleActionBtn.textContent = 'SUIAMI';
          _idleActionBtn.className = 'ski-idle-ns-action ski-idle-ns-action--suiami';
          _idleActionBtn.title = `SUIAMI? I AM ${_iamName}`;
          _idleActionBtn.disabled = true;
        }

        // Show QR only when Quest button is active — cap at $9.50 (no name costs more via Quest)
        if (_idleActionBtn.textContent === 'Quest') {
          const _qrAmt = Math.min(nsPriceUsd ?? 7.77, 9.50);
          _showSolQr(_qrAmt);
        } else {
          _hideSolQr();
        }

        // Update price row
        const priceRow = _idleOverlay?.querySelector('#ski-idle-price') as HTMLElement | null;
        const priceText = _idleOverlay?.querySelector('#ski-idle-price-text') as HTMLElement | null;
        if (priceRow && priceText) {
          if (!label || (!nsPriceUsd && !hasListing)) {
            priceRow.hidden = true;
          } else if (hasListing && !isOwned) {
            const listing = _nsListing();
            if (listing) {
              const suiAmt = Number(BigInt(listing.priceMist)) / 1e9;
              const fee = listing.source === 'tradeport' ? suiAmt * 0.03 : 0;
              const totalSui = suiAmt + fee;
              const usdVal = suiPriceCache ? (totalSui * suiPriceCache.price) : null;
              const _canAfford = usdVal != null ? (app.usd ?? 0) >= usdVal : false;
              if (_canAfford) {
                priceText.textContent = usdVal != null ? `$${Math.round(usdVal)}` : `${Math.round(totalSui)} SUI`;
                priceText.style.color = '';
              } else {
                priceText.innerHTML = usdVal != null
                  ? `<span style="color:#ef4444">$</span>${Math.round(usdVal)}`
                  : `${Math.round(totalSui)} SUI`;
                priceText.style.color = '';
              }
              priceRow.hidden = false;
            }
          } else if (nsAvail === 'available' && nsPriceUsd) {
            priceText.textContent = `$${Math.round(nsPriceUsd)}`;
            priceRow.hidden = false;
          } else if (isOwned) {
            priceText.textContent = 'Owned';
            priceRow.hidden = false;
          } else {
            priceRow.hidden = true;
          }
        }
      };

      const _renderThunderComposePreview = () => {
        const raw = _idleThunderInput?.value.trim() || '';
        const draft = _parseThunderCompose(raw);
        _thunderComposeDraft = draft;
        const isQuestMode = _idleThunderSend?.dataset.questMode === '1';

        if (!raw || !draft) {
          _thunderComposeConfirmedRaw = '';
          _thunderComposeStage = 'idle';
          if (_idleThunderSend && !isQuestMode) {
            _idleThunderSend.innerHTML = '\u26a1';
            _idleThunderSend.title = 'Open Storm';
            _idleThunderSend.disabled = false;
          }
          return;
        }

        if (draft.raw !== _thunderComposeConfirmedRaw && _thunderComposeStage !== 'sending') {
          _thunderComposeStage = 'preview';
        } else if (_thunderComposeStage !== 'sending') {
          _thunderComposeStage = 'confirmed';
        }

        if (_idleThunderSend && !isQuestMode && _thunderComposeStage !== 'sending') {
          const amtLabel = draft.amount !== undefined ? ` $${draft.amount}` : '';
          if (_thunderComposeStage === 'confirmed') {
            _idleThunderSend.innerHTML = draft.amount !== undefined
              ? `\u26a1 Send $${draft.amount}`
              : '\u26a1 Send';
            _idleThunderSend.title = draft.amountError || 'Encrypt and send Thunder';
          } else {
            _idleThunderSend.innerHTML = draft.amount !== undefined
              ? `\u26a1${amtLabel}`
              : '\u26a1';
            _idleThunderSend.title = draft.error ? 'Need a recipient (@name)' : draft.amountError || 'Open Storm';
          }
          _idleThunderSend.disabled = !!draft.error || !!draft.amountError;
          // Visual feedback: red border on amount error
          _idleThunderSend.classList.toggle('ski-idle-thunder-send--amt-error', !!draft.amountError);
        }
      };

      // Pause GIF while typing, resume on blur
      const _gifImg = _idleOverlay.querySelector('.ski-idle-img') as HTMLVideoElement | null;
      const _pauseGif = () => { if (_gifImg) try { _gifImg.pause(); } catch {} };
      const _resumeGif = () => { if (_gifImg) try { _gifImg.play(); } catch {} };
      const _freezeGif = () => {
        if (_gifImg) try { _gifImg.pause(); } catch {}
        _idleOverlay?.querySelector('#ski-idle-thunder-convo')?.classList.add('ski-idle-thunder-convo--frozen');
      };
      const _unfreezeGif = () => {
        if (_gifImg) try { _gifImg.play(); } catch {}
        _idleOverlay?.querySelector('#ski-idle-thunder-convo')?.classList.remove('ski-idle-thunder-convo--frozen');
      };

      const _updateIdleCard = (name: string) => {
        const card = _idleOverlay?.querySelector('#ski-idle-card') as HTMLElement | null;
        if (!card) return;
        if (!name && !app.suinsName) { card.innerHTML = ''; return; }
        // Show primary name card when: no active search, or name is available (unregistered)
        // Don't fall back to primary while fetching if user typed a different name
        const isOwnName = name.toLowerCase() === (app.suinsName?.replace(/\.sui$/, '') || '').toLowerCase();
        if (nsAvail === 'available' || (!nsAvail && (!name || isOwnName))) {
          const primaryName = app.suinsName?.replace(/\.sui$/, '') || '';
          if (!primaryName) { card.innerHTML = ''; return; }
          // Show primary name card with SUIAMI balance
          const primaryTotal = (_thunderCounts[primaryName.toLowerCase()] ?? 0) + (_thunderLocalCounts[primaryName.toLowerCase()] ?? 0);
          const badgeHtml = primaryTotal > 0 ? `\u26c8\ufe0f${primaryTotal}` : '';
          const primaryOwned = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === primaryName.toLowerCase());
          let primaryExpiryHtml = '';
          if (primaryOwned?.expirationMs) {
            const daysLeft = Math.max(0, Math.ceil((primaryOwned.expirationMs - Date.now()) / 86_400_000));
            let cls = 'wk-ns-owned-expiry';
            if (daysLeft <= 30) cls += ' wk-ns-owned-expiry--urgent';
            else if (daysLeft <= 90) cls += ' wk-ns-owned-expiry--warn';
            primaryExpiryHtml = ` <span class="${cls}">${daysLeft}D</span>`;
          }
          const totalUsd = app.usd ?? 0;
          const balHtml = totalUsd >= 0.50 ? `<span class="ski-idle-card-bal"><span class="ski-idle-card-bal-icon">$</span><span class="ski-idle-card-bal-whole">${Math.round(totalUsd).toLocaleString()}</span></span> ` : '';
          // iUSD badge — shows after SUIAMI is completed (identity verified)
          const iusdBadge = _suiamiVerifyHtml ? ' <img src="/assets/iusd.svg" class="ski-idle-card-iusd" width="16" height="16" alt="iUSD">' : '';
          card.innerHTML = `${balHtml}<span class="ski-idle-card-name" title="Populate input">${esc(primaryName)}</span>${iusdBadge}${primaryExpiryHtml}${badgeHtml ? ` <span class="ski-idle-card-badges">${badgeHtml}</span>` : ''}<button class="ski-idle-card-dismiss" type="button" title="Clear">\u2715</button>`;
          return;
        }
        // Persist as authoritative domain — drives NS input on refresh and menu open
        _lastNftCardDomain = name;
        try { sessionStorage.setItem('ski:nft-card-domain', name); } catch {}
        try { localStorage.setItem('ski:ns-label', name); } catch {}
        const _tcOn = _thunderCounts[name.toLowerCase()] ?? 0;
        const _tcLocal = _thunderLocalCounts[name.toLowerCase()] ?? 0;
        const _tcTotal = _tcOn + _tcLocal;
        const badgeHtml = _tcTotal > 0 ? `\u26c8\ufe0f${_tcTotal}` : '';
        // Expiration days — check owned domains first, then fall back to on-chain record
        const ownedEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === name.toLowerCase());
        const expMs = ownedEntry?.expirationMs ?? nsExpirationMs;
        let expiryHtml = '';
        if (expMs > 0 && expMs > Date.now()) {
          const daysLeft = Math.max(0, Math.ceil((expMs - Date.now()) / 86_400_000));
          let cls = 'wk-ns-owned-expiry';
          if (daysLeft <= 30) cls += ' wk-ns-owned-expiry--urgent';
          else if (daysLeft <= 90) cls += ' wk-ns-owned-expiry--warn';
          expiryHtml = ` <span class="${cls}">${daysLeft}D</span>`;
        } else if (nsGraceEndMs > 0) {
          expiryHtml = ` <span class="wk-ns-owned-expiry wk-ns-owned-expiry--urgent">EXPIRED</span>`;
        }
        card.innerHTML = `<span class="ski-idle-card-bal" id="ski-idle-card-bal"></span><span class="ski-idle-card-name" title="Populate input">${esc(name)}</span>${expiryHtml}${badgeHtml ? ` <span class="ski-idle-card-badges">${badgeHtml}</span>` : ''}<button class="ski-idle-card-dismiss" type="button" title="Clear">\u2715</button>`;
        // Fetch resolved address balance — for listings, use seller address
        (async () => {
          try {
            const _listing = _nsListing();
            let addr = _listing?.seller || nsTargetAddress || nsNftOwner;
            if (!addr) {
              const r = await fetch('https://graphql.mainnet.sui.io/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: `{ resolveSuinsAddress(domain: "${name}.sui") { address } }` }),
              });
              const gql = await r.json() as any;
              addr = gql?.data?.resolveSuinsAddress?.address ?? null;
            }
            if (!addr) return;
            const r2 = await fetch('https://graphql.mainnet.sui.io/graphql', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: `{ address(address: "${addr}") { balances { nodes { coinType { repr } totalBalance } } } }` }),
            });
            const gql2 = await r2.json() as any;
            const balEl = _idleOverlay?.querySelector('#ski-idle-card-bal');
            if (!balEl) return;
            let totalUsd = 0;
            const price = suiPriceCache?.price ?? 0.87;
            const SUI_CT = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
            const USDC_CT = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
            const IUSD_CT = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
            const IKA_CT = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
            const DEEP_CT = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
            for (const b of (gql2?.data?.address?.balances?.nodes ?? [])) {
              const ct = b.coinType?.repr ?? '';
              const raw = BigInt(b.totalBalance ?? '0');
              if (ct === SUI_CT) totalUsd += (Number(raw) / 1e9) * price;
              else if (ct === USDC_CT) totalUsd += Number(raw) / 1e6;
              else if (ct === IUSD_CT) totalUsd += Number(raw) / 1e9;
              else if (ct === IKA_CT) totalUsd += (Number(raw) / 1e9) * 0.003;
              else if (ct === DEEP_CT) totalUsd += (Number(raw) / 1e6) * 0.03;
            }
            // Add SOL balance if this is the connected wallet
            const ws = getState();
            if (ws.address && addr?.toLowerCase() === ws.address.toLowerCase() && app.solBalance > 0) {
              const solPrice = getTokenPrice('SOL') ?? 83;
              totalUsd += app.solBalance * solPrice;
            }
            if (totalUsd >= 0.50) {
              balEl.innerHTML = `<span class="ski-idle-card-bal-icon">$</span><span class="ski-idle-card-bal-whole">${Math.round(totalUsd).toLocaleString()}</span>`;
            }
            // Patch in expiration if it wasn't available at first render
            if (nsExpirationMs > 0 && !card.querySelector('.wk-ns-owned-expiry')) {
              const daysLeft = Math.max(0, Math.ceil((nsExpirationMs - Date.now()) / 86_400_000));
              if (daysLeft > 0) {
                let cls = 'wk-ns-owned-expiry';
                if (daysLeft <= 30) cls += ' wk-ns-owned-expiry--urgent';
                else if (daysLeft <= 90) cls += ' wk-ns-owned-expiry--warn';
                const nameEl = card.querySelector('.ski-idle-card-name');
                if (nameEl) nameEl.insertAdjacentHTML('afterend', ` <span class="${cls}">${daysLeft}D</span>`);
              }
            }
          } catch {}
        })();
      };

      // Click card → populate name input with the card's name
      _idleOverlay.querySelector('#ski-idle-card')?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Dismiss button — clear everything
        if ((e.target as HTMLElement).closest('.ski-idle-card-dismiss')) {
          if (_idleNsInput) { _idleNsInput.value = ''; _idleNsInput.dispatchEvent(new Event('input', { bubbles: true })); }
          nsLabel = '';
          const _clearBtn = _idleOverlay?.querySelector('#ski-idle-clear') as HTMLElement | null;
          if (_clearBtn) _clearBtn.style.display = 'none';
          const mainInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (mainInput) mainInput.value = '';
          const thunderInp = _idleOverlay?.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
          if (thunderInp) thunderInp.value = '';
          const card = _idleOverlay?.querySelector('#ski-idle-card') as HTMLElement | null;
          if (card) card.innerHTML = '';
          const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
          if (convoEl) convoEl.setAttribute('hidden', '');
          _updateIdleStatus();
          return;
        }
        const nameEl = _idleOverlay?.querySelector('.ski-idle-card-name') as HTMLElement | null;
        if (!nameEl || !_idleNsInput) return;
        const name = nameEl.textContent?.replace(/\.sui$/, '').trim() || '';
        if (!name) return;
        _idleNsInput.value = name;
        nsLabel = name;
        const _clearBtn = _idleOverlay?.querySelector('#ski-idle-clear') as HTMLElement | null;
        if (_clearBtn) _clearBtn.style.display = name ? '' : 'none';
        const mainInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (mainInput) mainInput.value = name;
        nsAvail = null;
        _updateIdleStatus();
        // Tag the name in thunder input for quick messaging
        const thunderInp = _idleOverlay?.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
        if (thunderInp && (!thunderInp.value || thunderInp.value.startsWith('@'))) thunderInp.value = `@${name} `;
        fetchAndShowNsPrice(name).then(() => { _updateIdleStatus(); _updateIdleCard(name); _expandIdleConvo(name); });
      });

      _idleNsInput?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_idleNsInput?.value) {
          const len = _idleNsInput.value.length;
          _idleNsInput.setSelectionRange(len, len);
        }
      });
      _idleNsInput?.addEventListener('keydown', (e) => e.stopPropagation());
      _idleNsInput?.addEventListener('focus', () => {
        if (_idleNsInput) {
          _idleNsInput.value = '';
          const clearBtn = _idleOverlay?.querySelector('#ski-idle-clear') as HTMLElement | null;
          if (clearBtn) clearBtn.style.display = 'none';
        }
      });
      _idleNsInput?.addEventListener('blur', _unfreezeGif);

      const _idleThunderInputEl = _idleOverlay.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
      const _thunderRow = _idleOverlay.querySelector('.ski-idle-thunder-row') as HTMLElement | null;
      const _updateThunderRowActive = () => {
        const active = _idleThunderInputEl === document.activeElement || !!_idleThunderInputEl?.value;
        _thunderRow?.classList.toggle('ski-idle-thunder-row--active', active);
      };
      _idleThunderInputEl?.addEventListener('focus', () => { _freezeGif(); _updateThunderRowActive(); });
      _idleThunderInputEl?.addEventListener('blur', () => { _unfreezeGif(); setTimeout(_updateThunderRowActive, 250); });
      _idleThunderInputEl?.addEventListener('input', _updateThunderRowActive);

      // @ button — insert @tag and focus thunder input for autocomplete
      // Reads from card name first (authoritative), then falls back to input
      _idleOverlay.querySelector('#ski-idle-thunder-at')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!_idleThunderInputEl) return;
        const cardName = _idleOverlay?.querySelector('.ski-idle-card-name')?.textContent?.replace(/\.sui$/, '').trim() || '';
        const resolvedName = cardName || nsLabel || _idleNsInput?.value || '';
        if (_idleThunderInputEl.value.startsWith('@')) {
          _idleThunderInputEl.focus();
          return;
        }
        _idleThunderInputEl.value = resolvedName ? `@${resolvedName} ` : '@';
        _idleThunderInputEl.focus();
        _idleThunderInputEl.setSelectionRange(_idleThunderInputEl.value.length, _idleThunderInputEl.value.length);
      });
      _idleNsInput?.addEventListener('input', () => {
        const val = (_idleNsInput!.value || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        _idleNsInput!.value = val;
        nsLabel = val;
        try { localStorage.setItem('ski:ns-label', val); } catch {}
        if (_idleClearBtn) _idleClearBtn.style.display = val ? '' : 'none';
        // Pause video when typing, resume when empty
        const _vid = _idleOverlay?.querySelector('.ski-idle-img') as HTMLVideoElement | null;
        if (_vid) { if (val) try { _vid.pause(); } catch {} else try { _vid.play(); } catch {} }
        const mainInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (mainInput) mainInput.value = val;
        // Reset state — mirror main input behavior
        const validLabel = isValidNsLabel(val);
        const _inRoster = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === val);
        nsPriceUsd = (validLabel && val.length >= 5 && ns5CharPriceUsd != null && !_inRoster) ? ns5CharPriceUsd : null;
        nsAvail = _inRoster ? 'owned' : null;
        nsGraceEndMs = 0;
        nsTargetAddress = null;
        nsKioskListing = null; nsTradeportListing = null;
        nsShadeOrder = null;
        nsExpirationMs = 0;
        nsNftOwner = null;
        _updateIdleStatus();
        // Invalid/short input → reset card to primary name
        _updateIdleCard(validLabel ? val : '');
        _renderThunderComposePreview();
        // Debounce fetch to avoid SuiNS rate limits
        if (_idleDebounce) clearTimeout(_idleDebounce);
        if (val.length >= 3 && validLabel) {
          _idleDebounce = setTimeout(() => {
            fetchAndShowNsPrice(val).then(() => { _updateIdleStatus(); _updateIdleCard(val); _renderThunderComposePreview(); _expandIdleConvo(val); });
          }, NS_LOOKUP_DEBOUNCE_MS);
        }
      });

      // Clear button
      _idleClearBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_idleNsInput) _idleNsInput.value = '';
        nsLabel = '';
        nsAvail = null;
        if (_idleClearBtn) _idleClearBtn.style.display = 'none';
        _updateIdleStatus();
        _renderThunderComposePreview();
        const _vid2 = _idleOverlay?.querySelector('.ski-idle-img') as HTMLVideoElement | null;
        if (_vid2) try { _vid2.play(); } catch {}
        _idleNsInput?.focus();
      });

      // Action button — handle directly from overlay, don't dismiss
      _idleActionBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const label = nsLabel.trim();
        const btnText = _idleActionBtn!.textContent || '';
        if (btnText === 'SUIAMI') {
          const name = label || (app.suinsName?.replace(/\.sui$/, '') || '');
          if (!name) return;
          window.dispatchEvent(new CustomEvent('ski:request-suiami', { detail: { name } }));
        } else if (btnText === 'TRADE') {
          // Marketplace purchase via /api/infer — server reads real on-chain balances
          e.stopPropagation();
          const ws = getState();
          if (!ws.address) { showToast('Connect wallet first'); return; }
          _idleActionBtn!.disabled = true;
          _idleActionBtn!.textContent = '\u2026';
          try {
            // Ask infer engine for the best action + pre-built TX
            const inferRes = await fetch('/api/infer', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ label, address: ws.address }),
            });
            const infer = await inferRes.json() as {
              recommended?: { action: string; confidence: number; reason: string; route?: string };
              tx?: { base64: string; description: string } | null;
              balances?: { sui?: { usd: number }; usdc?: { usd: number }; iusd?: { usd: number }; total_usd?: number };
              error?: string;
            };

            if (infer.error) { showToast(infer.error); return; }

            // Ultron already bought — no user signature needed
            if (infer.purchased?.digest) {
              nsAvail = 'owned'; nsKioskListing = null; nsTradeportListing = null;
              app.suinsName = app.suinsName || `${label}.sui`;
              showToast(`\u26a1 ${label}.sui acquired via cache`);
              _updateIdleStatus();
              setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
              return;
            }

            if (infer.tx?.base64) {
              _idleActionBtn!.textContent = '\u270f';
              const b64 = infer.tx.base64;
              const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              const _isWaaP = /waap/i.test(getState().walletName || '');
            const { digest } = (!_isWaaP && isSponsorActive()) ? await signAndExecuteSponsoredTx(bytes) : await signAndExecuteTransaction(bytes);
              nsAvail = 'owned'; nsKioskListing = null; nsTradeportListing = null;
              app.suinsName = app.suinsName || `${label}.sui`;
              showToast(`${label}.sui purchased \u2713`);
              _updateIdleStatus();
              setTimeout(() => refreshPortfolio(true), PORTFOLIO_REFRESH_MED_MS);
            } else {
              const reason = infer.recommended?.reason ?? 'Could not build transaction';
              const bals = infer.balances;
              showToast(`${reason}${bals ? ` (SUI: $${bals.sui?.usd?.toFixed(2)}, USDC: $${bals.usdc?.usd?.toFixed(2)}, iUSD: $${bals.iusd?.usd?.toFixed(2)})` : ''}`);
            }
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            if (!raw.toLowerCase().includes('reject')) showToast(raw.slice(0, 150));
          } finally {
            _idleActionBtn!.disabled = false;
            _idleActionBtn!.textContent = 'TRADE';
          }
        } else if (btnText === 'MINT') {
          // Open menu for mint flow
          if (!app.skiMenuOpen) { app.skiMenuOpen = true; try { localStorage.setItem('ski:lift', '1'); } catch {} render(); }
          setTimeout(() => {
            const mainBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
            if (mainBtn) { mainBtn.disabled = false; mainBtn.click(); }
          }, 500);
        } else if (btnText === 'Quest') {
          // Quest Prism — user signs registration PTB upfront.
          // When a t2000 fills (sends NS), ultron submits the pre-signed tx. One signature, walk away.
          e.stopPropagation();
          if (!label) return;
          const ws = getState();
          if (!ws.address) { showToast('Connect wallet first'); return; }
          _idleActionBtn!.disabled = true;
          _idleActionBtn!.textContent = 'Signing\u2026';
          try {
            // Step 1: Build the registration PTB and have user sign it NOW
            // This pre-signs the "register name with NS" transaction before NS arrives
            showToast(`\u26a1 Sign to Quest ${label}.sui — agents handle the rest`);
            let preSignedBytes: string | null = null;
            let preSignedSig: string | null = null;
            try {
              const freshPrice = await fetchSuiPrice() ?? suiPriceCache?.price;
              const regResult = await buildRegisterSplashNsTx(ws.address, `${label}.sui`, freshPrice, true, 'NS');
              if (regResult) {
                const bytes = regResult instanceof Uint8Array ? regResult : regResult;
                const { signature } = await signTransaction(bytes);
                preSignedBytes = btoa(String.fromCharCode(...bytes));
                preSignedSig = signature;
              }
            } catch (signErr) {
              const msg = signErr instanceof Error ? signErr.message : 'Sign failed';
              if (msg.toLowerCase().includes('reject')) {
                _idleActionBtn!.textContent = 'Quest';
                _idleActionBtn!.disabled = false;
                return;
              }
              // If sign fails (e.g. no NS yet), fall back to post-fill registration
              console.log('[SKI] Pre-sign skipped:', msg);
            }

            // Step 2: Post the Quest with optional pre-signed registration
            const commitment = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(`${label}.sui:${ws.address}`),
            );
            const commitHex = Array.from(new Uint8Array(commitment))
              .map(b => b.toString(16).padStart(2, '0')).join('');
            const mintCost = nsPriceUsd ?? 7.50;
            const res = await fetch('/api/cache/quest-bounty', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                commitment: commitHex,
                amount: mintCost,
                accepted: ['SOL', 'USDC', 'SUI', 'ETH', 'BTC'],
                recipient: ws.address,
                // Pre-signed registration tx — ultron submits after sending NS
                preSignedTx: preSignedBytes,
                preSignedSig: preSignedSig,
              }),
            });
            if (res.ok) {
              const { id: bountyId } = await res.json() as { id: string };

              // Get steganographic SOL deposit intent — Solana Pay QR
              let depositData: { solAddress?: string; solAmount?: number; qr?: string; solanaPayUri?: string; tag?: number } = {};
              try {
                const depRes = await fetch('/api/cache/deposit-intent', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ suiAddress: ws.address, amountUsd: mintCost }),
                });
                if (depRes.ok) depositData = await depRes.json() as typeof depositData;
              } catch {}

              // Show Solana Pay QR overlay
              if (depositData.qr && depositData.solAmount) {
                const qrOverlay = document.createElement('div');
                qrOverlay.className = 'ski-quest-qr-overlay';
                qrOverlay.innerHTML = `
                  <div class="ski-quest-qr-card">
                    <div class="ski-quest-qr-title">\u26a1 Quest Prism</div>
                    <div class="ski-quest-qr-subtitle">Scan with Phantom or Solflare</div>
                    <img class="ski-quest-qr-img" src="${esc(depositData.qr)}" alt="Solana Pay QR" width="200" height="200">
                    <div class="ski-quest-qr-amount">${depositData.solAmount.toFixed(9)} SOL</div>
                    <div class="ski-quest-qr-tag">${String(depositData.tag).padStart(6, '0')}</div>
                    <div class="ski-quest-qr-addr">${esc(depositData.solAddress?.slice(0, 12) || '')}…</div>
                    <div class="ski-quest-qr-status" id="ski-quest-qr-status">Waiting for deposit\u2026</div>
                    <button class="ski-quest-qr-close" id="ski-quest-qr-close">\u2715</button>
                  </div>
                `;
                document.body.appendChild(qrOverlay);
                qrOverlay.querySelector('#ski-quest-qr-close')?.addEventListener('click', () => qrOverlay.remove());
                qrOverlay.addEventListener('click', (ev) => { if (ev.target === qrOverlay) qrOverlay.remove(); });
              }

              _idleActionBtn!.textContent = 'Hunting\u2026';
              _idleActionBtn!.className = 'ski-idle-ns-action ski-idle-ns-action--quest-bounty';

              // Poll for fill — matches both direct Sui funding and SOL deposit routing
              const _pollFill = async () => {
                const statusEl = document.getElementById('ski-quest-qr-status');
                for (let i = 0; i < 90; i++) { // poll up to ~180s
                  await new Promise(r => setTimeout(r, TX_INDEX_WAIT_MS));
                  try {
                    // Check deposit status (SOL side)
                    if (statusEl) {
                      try {
                        const depStatus = await fetch(`/api/cache/deposit-status?suiAddress=${encodeURIComponent(ws.address!)}`);
                        if (depStatus.ok) {
                          const ds = await depStatus.json() as { status: string };
                          if (ds.status === 'matched') {
                            statusEl.textContent = '\u26a1 SOL received! Filling quest\u2026';
                            statusEl.style.color = '#4da2ff';
                          }
                        }
                      } catch {}
                    }

                    // Check bounty status (Sui side)
                    const pollRes = await fetch(`/api/cache/quest-bounties?recipient=${encodeURIComponent(ws.address!)}`);
                    if (!pollRes.ok) continue;
                    const { bounties } = await pollRes.json() as { bounties: Array<{ id: string; status: string; digest?: string; error?: string }> };
                    const mine = bounties.find(b => b.id === bountyId);
                    if (!mine) continue;
                    if (mine.status === 'filled') {
                      document.querySelector('.ski-quest-qr-overlay')?.remove();
                      showToast(`\u26a1 NS received — registering ${label}.sui\u2026`);
                      _idleActionBtn!.textContent = 'Minting\u2026';
                      try {
                        const regResult = await buildRegisterSplashNsTx(ws.address!, `${label}.sui`, undefined, true, 'NS');
                        if (regResult) {
                          await signAndExecuteTransaction(regResult instanceof Uint8Array ? regResult : regResult);
                          showToast(`\u2728 ${label}.sui minted!`);
                          _idleActionBtn!.textContent = 'Minted';
                          _idleActionBtn!.disabled = true;
                          nsAvail = 'owned';
                          _updateIdleStatus();
                          _updateIdleCard(label);
                          _preRumbledNames.add(label.toLowerCase());
                          try { localStorage.setItem('ski:pre-rumbled', JSON.stringify([..._preRumbledNames])); } catch {}
                          window.dispatchEvent(new CustomEvent('ski:name-acquired', { detail: { name: label } }));
                        }
                      } catch (regErr) {
                        const msg = regErr instanceof Error ? regErr.message : 'Registration failed';
                        showToast(`NS received but registration failed: ${msg}`);
                        _idleActionBtn!.textContent = 'MINT';
                        _idleActionBtn!.className = 'ski-idle-ns-action ski-idle-ns-action--mint';
                        _idleActionBtn!.disabled = false;
                      }
                      return;
                    }
                    if (mine.status === 'error') {
                      document.querySelector('.ski-quest-qr-overlay')?.remove();
                      showToast(mine.error || 'Hunt failed — retry');
                      _idleActionBtn!.textContent = 'Quest';
                      _idleActionBtn!.disabled = false;
                      return;
                    }
                  } catch { /* retry */ }
                }
                document.querySelector('.ski-quest-qr-overlay')?.remove();
                _idleActionBtn!.textContent = 'Quested';
                _idleActionBtn!.disabled = true;
                showToast('Quest posted — ultron will fill when funded');
              };
              _pollFill();
            } else {
              const err = await res.json().catch(() => ({ error: 'Failed' })) as { error?: string };
              showToast(err.error || 'Quest failed');
              _idleActionBtn!.textContent = 'Quest';
              _idleActionBtn!.disabled = false;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Quest failed';
            if (!msg.toLowerCase().includes('reject')) showToast(msg);
            _idleActionBtn!.textContent = 'Quest';
            _idleActionBtn!.disabled = false;
          }
        } else if (btnText === 'Shade') {
          // Shade: mint iUSD rounded up to cover registration + 10% buffer.
          // User holds the iUSD freely but spending below threshold liquidates the Shade.
          // Agents deliberate every 60s whether to keep or cancel underwater Shades.
          e.stopPropagation();
          if (!label) return;
          const ws = getState();
          if (!ws.address) { showToast('Connect wallet first'); return; }
          const shadeCost = Math.ceil((nsPriceUsd ?? 7.77) * 1.10 * 100) / 100;
          _idleActionBtn!.disabled = true;
          _idleActionBtn!.textContent = 'Shading\u2026';

          // Create Shade order on server — agents will deliberate on it
          (async () => {
            try {
              const commitment = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${label}.sui:${ws.address}`));
              const commitHex = Array.from(new Uint8Array(commitment)).map(b => b.toString(16).padStart(2, '0')).join('');
              await fetch('/api/cache/shade-create', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  domain: label,
                  holder: ws.address,
                  thresholdUsd: shadeCost,
                  graceEndMs: nsGraceEndMs || (Date.now() + 30 * 86_400_000),
                  commitment: commitHex,
                }),
              });
              showToast(`\u26a1 Shade ${label}.sui — hold $${shadeCost.toFixed(2)} iUSD until grace expires`);

              // Open menu with amount pre-filled for iUSD mint
              pendingSendAmount = String(shadeCost);
              if (!app.skiMenuOpen) { app.skiMenuOpen = true; try { localStorage.setItem('ski:lift', '1'); } catch {} render(); }
              setTimeout(() => {
                const amtInput = document.getElementById('wk-send-amount') as HTMLInputElement | null;
                if (amtInput) { amtInput.value = String(shadeCost); amtInput.dispatchEvent(new Event('input', { bubbles: true })); }
                const mainBtn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
                if (mainBtn) { mainBtn.disabled = false; mainBtn.click(); }
              }, 500);
            } catch (err) {
              showToast(err instanceof Error ? err.message : 'Shade failed');
            }
            _idleActionBtn!.textContent = 'Shade';
            _idleActionBtn!.disabled = false;
          })();
        } else if (btnText === 'Storm' || btnText === 'Thunder') {
          const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
          if (convoEl && !convoEl.hasAttribute('hidden')) {
            convoEl.setAttribute('hidden', '');
          } else if (label) {
            _expandIdleConvo(label);
            const thunderInput = _idleOverlay?.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
            if (thunderInput) {
              if (!thunderInput.value.includes(`@${label}`)) thunderInput.value = `@${label} `;
              thunderInput.focus();
              _renderThunderComposePreview();
            }
          }
        }
      });

      _updateIdleStatus();
      // Always update card + fetch availability + Tradeport listing when overlay opens with a name
      _updateIdleStatus(); // immediate render from cached state
      const _initLabel = nsLabel.trim();
      if (_initLabel.length >= 3 && isValidNsLabel(_initLabel)) {
        // Show card immediately from cached state
        if (nsAvail) _updateIdleCard(_initLabel);
        // Force re-fetch even if cached — ensures _updateIdleStatus sees fresh ownership
        nsPriceFetchFor = '';
        fetchAndShowNsPrice(_initLabel).then(() => { _updateIdleStatus(); _updateIdleCard(_initLabel); });
        // Auto-open conversation if there are pending signals or local history
        const _pendingCount = _thunderCounts[_initLabel.toLowerCase()] ?? 0;
        const _localCount = _thunderLocalCounts[_initLabel.toLowerCase()] ?? 0;
        if (_pendingCount > 0 || _localCount > 0) {
          _expandIdleConvo(_initLabel);
        }
        // Activate quest mode based on aggregate count across ALL owned names
        const _totalPending = _totalThunderCount();
        if (_totalPending > 0) {
          const sendBtn = _idleOverlay?.querySelector('#ski-idle-thunder-send') as HTMLButtonElement | null;
          if (sendBtn) {
            sendBtn.innerHTML = `\u26c8\ufe0f<span class="ski-idle-thunder-count">${_totalPending}</span>`;
            sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send ski-idle-thunder-send--quest';
            sendBtn.title = `Quest ${_totalPending} signal${_totalPending > 1 ? 's' : ''} across all names`;
            sendBtn.dataset.questMode = '1';
            sendBtn.dataset.questAll = '1';
          }
          const thunderInput = _idleOverlay?.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
          if (thunderInput && !thunderInput.value) thunderInput.placeholder = `${_totalPending} signal${_totalPending > 1 ? 's' : ''} waiting...`;
          // Auto-expand conversation for name with most signals
          if (!_pendingCount && !_localCount) {
            const topName = nsOwnedDomains
              .filter(d => d.kind === 'nft')
              .map(d => ({ bare: d.name.replace(/\.sui$/, '').toLowerCase(), count: _thunderCounts[d.name.replace(/\.sui$/, '').toLowerCase()] ?? 0 }))
              .sort((a, b) => b.count - a.count)[0];
            if (topName && topName.count > 0) _expandIdleConvo(topName.bare);
          }
        }
      }

      // iUSD coin click → swap 95% of wallet to iUSD
      _idleOverlay.querySelector('#ski-idle-iusd')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const ws = getState();
        if (!ws.address) { showToast('Connect wallet first'); return; }
        const btn = e.currentTarget as HTMLButtonElement;
        btn.style.opacity = '0.4';
        try {
          // Find all non-gas tokens to route to iUSD (keep SUI for gas)
          const nonGas = walletCoins.filter(c =>
            c.balance > 0 &&
            !c.coinType.includes('::sui::SUI') && // keep SUI gas
            !c.coinType.includes('::iusd::IUSD')  // already iUSD
          );
          const totalNonGasUsd = nonGas.reduce((s, c) => s + c.balance, 0);

          if (totalNonGasUsd < 0.01 && (app.sui || 0) < 1) {
            showToast('No tokens to route to iUSD');
            return;
          }

          // If user has NS, USDC, or other tokens — send to ultron for routing
          // Agents will debate and swap NS→USDC→iUSD, keeping the spread
          const nsCoins = nonGas.filter(c => c.coinType.includes('::ns::NS'));
          const usdcCoins = nonGas.filter(c => c.coinType.includes('::usdc::USDC'));
          const otherCoins = nonGas.filter(c => !c.coinType.includes('::ns::NS') && !c.coinType.includes('::usdc::USDC'));

          const routeDesc = [
            nsCoins.length > 0 ? `${nsCoins.reduce((s, c) => s + c.balance, 0).toFixed(0)} NS` : '',
            usdcCoins.length > 0 ? `$${usdcCoins.reduce((s, c) => s + c.balance, 0).toFixed(2)} USDC` : '',
            otherCoins.length > 0 ? `${otherCoins.length} other tokens` : '',
          ].filter(Boolean).join(' + ');

          showToast(`\u26a1 Routing ${routeDesc} \u2192 iUSD — agents competing for best rate`);

          // For NS: send to ultron (auto-sweeps NS→USDC every tick)
          // For USDC: send to ultron (will attest + mint iUSD)
          // For SUI: keep gas, route excess through collateral attestation
          const ULTRON = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';

          if (nsCoins.length > 0 || usdcCoins.length > 0) {
            // Build PTB: merge + transfer all NS and USDC to ultron
            const { Transaction } = await import('@mysten/sui/transactions');
            const { normalizeSuiAddress: norm } = await import('@mysten/sui/utils');
            const tx = new Transaction();
            tx.setSender(norm(ws.address));

            // Transfer NS coins to ultron
            const NS_TYPE = '0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS';
            const nsRpc = await fetch('https://sui-rpc.publicnode.com', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoins', params: [ws.address, NS_TYPE] }),
            });
            const nsData = await nsRpc.json() as any;
            const nsRefs = (nsData?.result?.data ?? []).filter((c: any) => BigInt(c.balance) > 0n);
            if (nsRefs.length > 0) {
              const nsCoin = tx.objectRef({ objectId: nsRefs[0].coinObjectId, version: String(nsRefs[0].version), digest: nsRefs[0].digest });
              if (nsRefs.length > 1) tx.mergeCoins(nsCoin, nsRefs.slice(1).map((c: any) => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
              tx.transferObjects([nsCoin], tx.pure.address(ULTRON));
            }

            // Transfer USDC coins to ultron
            const USDC_T = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
            const usdcRpc = await fetch('https://sui-rpc.publicnode.com', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoins', params: [ws.address, USDC_T] }),
            });
            const usdcData = await usdcRpc.json() as any;
            const usdcRefs = (usdcData?.result?.data ?? []).filter((c: any) => BigInt(c.balance) > 0n);
            if (usdcRefs.length > 0) {
              const usdcCoin = tx.objectRef({ objectId: usdcRefs[0].coinObjectId, version: String(usdcRefs[0].version), digest: usdcRefs[0].digest });
              if (usdcRefs.length > 1) tx.mergeCoins(usdcCoin, usdcRefs.slice(1).map((c: any) => tx.objectRef({ objectId: c.coinObjectId, version: String(c.version), digest: c.digest })));
              tx.transferObjects([usdcCoin], tx.pure.address(ULTRON));
            }

            const bytes = await tx.build({ client: grpcClient as never }) as Uint8Array & { tx?: unknown };
            bytes.tx = tx;
            await signAndExecuteTransaction(bytes);
            showToast('\u26a1 Tokens sent to cache — ultron sweeping NS\u2192USDC\u2026');
            // Initiate sweep + wait for it
            await fetch('/api/cache/initiate');
            // Brief pause for sweep to complete
            await new Promise(r => setTimeout(r, 3000));
          }

          // Attest + mint iUSD — auto-calculate max mintable from treasury state
          const { normalizeSuiAddress } = await import('@mysten/sui/utils');
          const walletAddr = normalizeSuiAddress(ws.address);

          // Fetch treasury state to calculate max mintable
          const treasuryGql = await fetch('https://graphql.mainnet.sui.io/graphql', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ object(address: "0x64435d5284ba3867c0065b9c97a8a86ee964601f0546df2caa5f772a68627beb") { asMoveObject { contents { json } } } }' }),
          });
          const treasuryData = await treasuryGql.json() as any;
          const tState = treasuryData?.data?.object?.asMoveObject?.contents?.json;

          // Also attest new collateral from SUI balance (80%, keep 20% gas)
          const suiPrice = suiPriceCache?.price ?? 0.87;
          const suiBalMist = BigInt(Math.floor((app.sui || 0) * 1e9));
          const suiCollateral = suiBalMist * 80n / 100n;
          const totalNewCollateral = suiCollateral > 50_000_000n ? suiCollateral : 0n;

          if (totalNewCollateral > 0n) {
            showToast('\ud83c\udf0d Attesting SUI collateral\u2026');
            const attestRes = await fetch('/api/iusd/attest', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ collateralValueMist: String(totalNewCollateral) }),
            });
            const attestResult = await attestRes.json() as { digest?: string; error?: string };
            if (!attestRes.ok || attestResult.error) console.warn('Attest:', attestResult.error);
          }

          // Re-fetch treasury after attest
          const tGql2 = await fetch('https://graphql.mainnet.sui.io/graphql', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ object(address: "0x64435d5284ba3867c0065b9c97a8a86ee964601f0546df2caa5f772a68627beb") { asMoveObject { contents { json } } } }' }),
          });
          const tData2 = await tGql2.json() as any;
          const t2 = tData2?.data?.object?.asMoveObject?.contents?.json ?? tState;

          const seniorMist = BigInt(t2?.senior_value_mist ?? '0');
          const juniorMist = BigInt(t2?.junior_value_mist ?? '0');
          const totalCollateral = seniorMist + juniorMist;
          const currentSupply = BigInt(t2?.total_minted ?? '0') - BigInt(t2?.total_burned ?? '0');
          // Max mint at 150% ratio: collateral * 10000 / 15000 - currentSupply
          const maxMint = totalCollateral * 10000n / 15000n - currentSupply;
          // Leave 5% buffer
          const mintAmount = maxMint * 95n / 100n;

          if (mintAmount <= 0n) {
            showToast('Collateral fully utilized — no iUSD to mint');
            refreshPortfolio(true);
            return;
          }

          showToast(`\ud83c\udf0d Minting ${(Number(mintAmount) / 1e9).toFixed(2)} iUSD\u2026`);
          const mintRes = await fetch('/api/iusd/mint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              recipient: walletAddr,
              collateralValueMist: String(totalCollateral),
              mintAmount: String(mintAmount),
            }),
          });
          const mintResult = await mintRes.json() as { digest2?: string; minted?: string; error?: string };
          if (mintRes.ok && !mintResult.error) {
            showToast(`\u2728 ${(Number(mintAmount) / 1e9).toFixed(2)} iUSD minted`);
          } else {
            showToast(mintResult.error || 'Mint failed');
          }
          refreshPortfolio(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Mint failed';
          if (msg.includes('abort code: 0') || msg.includes('NotAuthorized')) {
            showToast('Setting up treasury auth...');
            try {
              const { Transaction } = await import('@mysten/sui/transactions');
              const { normalizeSuiAddress: norm } = await import('@mysten/sui/utils');
              const IUSD_PKG = '0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515';
              const TREASURY = '0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895';
              const KEEPER = '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3';
              const sender = norm(ws.address);

              const tx1 = new Transaction();
              tx1.setSender(sender);
              tx1.moveCall({ target: `${IUSD_PKG}::iusd::set_oracle`, arguments: [tx1.object(TREASURY), tx1.pure.address(KEEPER)] });
              const b1 = await tx1.build({ client: grpcClient as never });
              await signAndExecuteTransaction(Object.assign(b1, { tx: tx1 }));
              showToast('Oracle set');

              const tx2 = new Transaction();
              tx2.setSender(sender);
              tx2.moveCall({ target: `${IUSD_PKG}::iusd::set_minter`, arguments: [tx2.object(TREASURY), tx2.pure.address(KEEPER)] });
              const b2 = await tx2.build({ client: grpcClient as never });
              await signAndExecuteTransaction(Object.assign(b2, { tx: tx2 }));
              showToast('Minter set — retrying mint...');

              const res2 = await fetch('/api/iusd/mint', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ recipient: norm(ws.address), collateralValueMist: String(collateralValueMist), mintAmount: String(mintAmount) }),
              });
              const result2 = await res2.json() as { minted?: string; error?: string };
              if (!res2.ok || result2.error) throw new Error(result2.error || 'Retry failed');
              showToast(`\ud83c\udf0d ${(Number(mintAmount) / 1e6).toFixed(2)} iUSD minted`);
              refreshPortfolio(true);
            } catch (setupErr) {
              const setupMsg = setupErr instanceof Error ? setupErr.message : 'Setup failed';
              if (!setupMsg.toLowerCase().includes('reject')) showToast(setupMsg);
            }
          } else {
            if (!msg.toLowerCase().includes('reject')) showToast(msg);
          }
        } finally {
          btn.style.opacity = '';
        }
      });

      // iUSD panel — $ quick button toggles panel, shows treasury stats + mint/burn/ignite
      _idleOverlay.querySelector('#ski-idle-quick-actions')?.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-action="iusd"]');
        if (!btn) return;
        e.stopPropagation();
        const panel = _idleOverlay?.querySelector('#ski-idle-iusd-panel') as HTMLElement | null;
        if (!panel) return;
        const iusdBtn = _idleOverlay?.querySelector('.ski-idle-quick-btn--iusd');
        const wasHidden = panel.hasAttribute('hidden');
        if (wasHidden) {
          panel.removeAttribute('hidden');
          iusdBtn?.classList.add('ski-idle-quick-btn--active');
          // Fetch treasury state
          const stats = panel.querySelector('#ski-idle-iusd-stats') as HTMLElement;
          if (stats) stats.innerHTML = '<span style="opacity:0.5">loading\u2026</span>';
          try {
            const gql = await fetch('https://graphql.mainnet.sui.io/graphql', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: '{ object(address: "0x64435d5284ba3867c0065b9c97a8a86ee964601f0546df2caa5f772a68627beb") { asMoveObject { contents { json } } } }' }),
            });
            const data = await gql.json() as any;
            const t = data?.data?.object?.asMoveObject?.contents?.json;
            if (t) {
              const supply = (Number(t.total_minted) - Number(t.total_burned)) / 1e9;
              const senior = Number(t.senior_value_mist) / 1e9;
              const ratio = supply > 0 ? Math.round(senior / supply * 100) : 0;
              const ratioColor = ratio >= 150 ? '#22c55e' : ratio >= 110 ? '#FFB800' : '#ef4444';
              stats.innerHTML = `<span style="color:#22c55e">$</span>${supply.toFixed(1)} supply <span style="color:${ratioColor}">${ratio}%</span>`;
            }
          } catch { if (stats) stats.innerHTML = '<span style="color:#ef4444">offline</span>'; }
        } else {
          panel.setAttribute('hidden', '');
          iusdBtn?.classList.remove('ski-idle-quick-btn--active');
        }
      });

      // Buy button — swap USDC → iUSD via DeepBook (1:1 stable pair)
      _idleOverlay.querySelector('#ski-idle-iusd-mint')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = getState();
        if (!ws.address) { showToast('Connect wallet first'); return; }
        const btn = e.currentTarget as HTMLButtonElement;
        btn.style.opacity = '0.4';
        try {
          const { normalizeSuiAddress } = await import('@mysten/sui/utils');
          const addr = normalizeSuiAddress(ws.address);
          // Find USDC balance
          const usdcType = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
          const rpc = await fetch('https://sui-rpc.publicnode.com', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoins', params: [addr, usdcType] }),
          });
          const rpcData = await rpc.json() as any;
          const coins = (rpcData?.result?.data ?? []).filter((c: any) => BigInt(c.balance) > 0n);
          if (!coins.length) { showToast('No USDC to swap for iUSD'); return; }
          const totalUsdc = coins.reduce((s: bigint, c: any) => s + BigInt(c.balance), 0n);
          showToast(`\ud83d\udcb5 Swapping ${(Number(totalUsdc) / 1e6).toFixed(2)} USDC \u2192 iUSD\u2026`);
          const { buildSwapTx } = await import('./suins.js');
          const iusdType = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
          const result = await buildSwapTx(ws.address, usdcType, iusdType, totalUsdc);
          await signAndExecuteTransaction(result.txBytes);
          showToast(`\u2728 ${(Number(totalUsdc) / 1e6).toFixed(2)} iUSD acquired`);
          refreshPortfolio(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Swap failed';
          if (msg.includes('not supported')) {
            showToast('iUSD/USDC pool needs liquidity — use Burn to improve ratio');
          } else if (!msg.toLowerCase().includes('reject')) {
            showToast(msg);
          }
        } finally { btn.style.opacity = ''; }
      });

      // Burn button — burn user's iUSD to improve collateral ratio
      _idleOverlay.querySelector('#ski-idle-iusd-burn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = getState();
        if (!ws.address) { showToast('Connect wallet first'); return; }
        const btn = e.currentTarget as HTMLButtonElement;
        btn.style.opacity = '0.4';
        try {
          // Find user's iUSD coins
          const iusdType = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
          const { normalizeSuiAddress } = await import('@mysten/sui/utils');
          const addr = normalizeSuiAddress(ws.address);
          const rpc = await fetch('https://sui-rpc.publicnode.com', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoins', params: [addr, iusdType] }),
          });
          const rpcData = await rpc.json() as any;
          const coins = (rpcData?.result?.data ?? []).filter((c: any) => BigInt(c.balance) > 0n);
          if (!coins.length) { showToast('No iUSD to burn'); return; }
          const totalBal = coins.reduce((s: bigint, c: any) => s + BigInt(c.balance), 0n);
          showToast(`\ud83d\udd25 Burning ${(Number(totalBal) / 1e9).toFixed(2)} iUSD\u2026`);
          const { Transaction } = await import('@mysten/sui/transactions');
          const tx = new Transaction();
          tx.setSender(addr);
          const IUSD_PKG = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9';
          const TREASURY_CAP = '0x0c7873b52c69f409f3c9772e85d927b509a133a42e9c134c826121bb6595e543';
          const TREASURY = '0x64435d5284ba3867c0065b9c97a8a86ee964601f0546df2caa5f772a68627beb';
          const primary = tx.object(coins[0].coinObjectId);
          if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map((c: any) => tx.object(c.coinObjectId)));
          tx.moveCall({
            package: IUSD_PKG, module: 'iusd', function: 'burn_and_redeem',
            arguments: [tx.object(TREASURY_CAP), tx.object(TREASURY), primary, tx.object('0x6')],
          });
          const bytes = await tx.build({ client: grpcClient as never }) as Uint8Array & { tx?: unknown };
          bytes.tx = tx;
          await signAndExecuteTransaction(bytes);
          showToast(`\ud83d\udd25 ${(Number(totalBal) / 1e9).toFixed(2)} iUSD burned — ratio improving`);
          refreshPortfolio(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Burn failed';
          if (!msg.toLowerCase().includes('reject')) showToast(msg);
        } finally { btn.style.opacity = ''; }
      });

      // Ignite button — placeholder for cross-chain gas
      _idleOverlay.querySelector('#ski-idle-iusd-ignite')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showToast('\u26a1 Ignite — coming soon. Burn iUSD, get gas on any chain.');
      });

      // Squid quick-action → toggle rumble panel or show cached squids rows
      _idleOverlay.querySelector('#ski-idle-quick-actions')?.addEventListener('click', (e) => {
        const squid = (e.target as HTMLElement).closest('[data-action="rumble"]');
        if (!squid) return;
        e.stopPropagation();
        const squidBtn = _idleOverlay?.querySelector('.ski-idle-quick-btn--squid');
        // If rumble panel is open, close it
        const convo = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
        const panel = _idleOverlay?.querySelector('#ski-idle-rumble-panel') as HTMLElement | null;
        if (panel && convo && !convo.hasAttribute('hidden')) {
          convo.setAttribute('hidden', ''); convo.innerHTML = '';
          squidBtn?.classList.remove('ski-idle-quick-btn--active');
          _unfreezeGif();
          return;
        }
        // If squids rows are open, close them
        const addrRow = _idleOverlay?.querySelector('#ski-idle-addr') as HTMLElement | null;
        if (addrRow && !addrRow.hasAttribute('hidden')) {
          addrRow.setAttribute('hidden', '');
          squidBtn?.classList.remove('ski-idle-quick-btn--active');
          _unfreezeGif();
          return;
        }
        squidBtn?.classList.toggle('ski-idle-quick-btn--active');
        (_idleOverlay?.querySelector('#ski-idle-rumble') as HTMLButtonElement | null)?.click();
      });

      // Storm-actions + send-group delegate same iusd/rumble handlers
      // $ button in storm mode — insert $ after last @name tag
      _idleOverlay.querySelector('#ski-idle-thunder-at-iusd')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!_idleThunderInputEl) return;
        const val = _idleThunderInputEl.value;
        // Find last @name tag and insert $ right after it
        const match = val.match(/^(.*@\S+)\s*/);
        if (match) {
          _idleThunderInputEl.value = match[1] + '$';
          _idleThunderInputEl.selectionStart = _idleThunderInputEl.selectionEnd = _idleThunderInputEl.value.length;
        } else {
          _idleThunderInputEl.value = val.trimEnd() + '$';
          _idleThunderInputEl.selectionStart = _idleThunderInputEl.selectionEnd = _idleThunderInputEl.value.length;
        }
        _idleThunderInputEl.focus();
        _idleThunderInputEl.dispatchEvent(new Event('input'));
      });

      // Diamond click → toggle target address row (own addresses or Roster lookup for others)
      _idleOverlay.querySelector('#ski-idle-status')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ws = getState();
        if (!ws.address) return;
        const viewingName = _idleNsInput?.value?.trim().toLowerCase() || '';
        if (!viewingName) return;
        const ownName = (app.suinsName || '').replace(/\.sui$/, '').toLowerCase();
        const isOwnName = nsAvail === 'owned' || nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === viewingName);
        if (!isOwnName) { showToast('You don\u2019t own this name'); return; }
        if (viewingName === ownName) { showToast(`${viewingName}.sui is already your default`); return; }

        // Set as default SuiNS name — same as SKI menu
        const domain = viewingName.endsWith('.sui') ? viewingName : `${viewingName}.sui`;
        const statusEl = _idleOverlay?.querySelector('#ski-idle-status') as HTMLElement | null;
        if (statusEl) statusEl.style.opacity = '0.3';
        try {
          const txBytes = await buildSetDefaultNsTx(ws.address, domain);
          const result = await signAndExecuteTransaction(txBytes);
          if (!result.digest) throw new Error('Transaction returned no digest');
          const eff = result.effects as Record<string, unknown> | undefined;
          const st = eff?.status as { status?: string; error?: string } | undefined;
          if (st?.status === 'failure') throw new Error(st.error || 'Transaction failed on-chain');
          app.suinsName = domain;
          suinsCache[ws.address] = domain;
          try { localStorage.setItem(`ski:suins:${ws.address}`, domain); } catch {}
          updateSkiDot('blue-square', domain);
          renderWidget();
          renderSkiBtn();
          showToast(`${domain} set as primary \u2713`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed';
          if (!msg.toLowerCase().includes('reject')) showToast(msg);
        } finally {
          if (statusEl) statusEl.style.opacity = '';
        }
      });

      // Address rows + QR are handled exclusively by the Rumble/squids button below

      // Rumble button → dispatch ski:rumble event
      _idleOverlay.querySelector('#ski-idle-rumble')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.add('ski-idle-quick-btn--active');
        const ws = getState();
        if (!ws.address) { showToast('Connect wallet first'); _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.remove('ski-idle-quick-btn--active'); return; }
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        btn.innerHTML = '\ud83e\udd91 ...';

        // Show rumble panel in the convo area
        const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
        if (convoEl) {
          convoEl.removeAttribute('hidden');
          convoEl.innerHTML = '<div class="ski-idle-rumble-panel" id="ski-idle-rumble-panel"></div>';
        }
        const panel = _idleOverlay?.querySelector('#ski-idle-rumble-panel') as HTMLElement | null;

        const addStep = (label: string, status: 'pending' | 'active' | 'done' | 'skip') => {
          if (!panel) return;
          const colors = { pending: 'rgba(255,255,255,0.3)', active: '#FFB800', done: '#22c55e', skip: '#ef4444' };
          const icons = { pending: '\u25cb', active: '\u26a1', done: '\u2713', skip: '\u2022' };
          const step = document.createElement('div');
          step.className = 'ski-idle-rumble-step';
          step.style.cssText = `color:${colors[status]};font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:0.7rem;font-weight:600;padding:3px 6px;display:flex;align-items:center;gap:6px`;
          step.innerHTML = `<span style="font-size:0.8rem">${icons[status]}</span> ${label}`;
          step.dataset.status = status;
          panel.appendChild(step);
          if (convoEl) convoEl.scrollTop = convoEl.scrollHeight;
          return step;
        };

        const updateStep = (step: HTMLElement | undefined, status: 'done' | 'skip' | 'active', newLabel?: string) => {
          if (!step) return;
          const colors = { active: '#FFB800', done: '#22c55e', skip: '#ef4444' };
          const icons = { active: '\u26a1', done: '\u2713', skip: '\u2022' };
          step.style.color = colors[status];
          step.dataset.status = status;
          const iconSpan = step.querySelector('span');
          if (iconSpan) iconSpan.textContent = icons[status];
          if (newLabel) {
            step.innerHTML = `<span style="font-size:0.8rem">${icons[status]}</span> ${newLabel}`;
          }
        };

        try {
          // Check cache first — instant if addresses already known
          const cachedBtc = app.btcAddress || '';
          const cachedEth = app.ethAddress || '';
          const cachedSol = app.solAddress || '';

          // All chains cached → show instantly, no RPC
          if (cachedBtc && cachedSol) {
            const status = { btcAddress: cachedBtc, ethAddress: cachedEth, solAddress: cachedSol };
            // Hide rumble panel, show address row instead
            if (convoEl) convoEl.setAttribute('hidden', '');
            const addrRow = _idleOverlay?.querySelector('#ski-idle-addr') as HTMLElement | null;
            if (addrRow) {
              if (!addrRow.hasAttribute('hidden')) {
                addrRow.setAttribute('hidden', '');
                _unfreezeGif();
              } else {
                const addr = nsTargetAddress || nsNftOwner || ws.address || '';
                const short = `${addr.slice(0, 6)}\u2026${addr.slice(-6)}`;
                const cachedBaseAddr = status.ethAddress; // same EVM address
                const cachedTronAddr = status.ethAddress ? ethToTron(status.ethAddress) : '';
                const suiIcon = `<span class="ski-idle-addr-icon ski-idle-addr-icon--inline"><svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#22c55e" stroke="white" stroke-width="2.5"/><text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="white">$</text></svg></span>`;
                const btcIcon = `<img src="${BTC_ICON_URI}" class="ski-idle-addr-icon" alt="BTC">`;
                const solIcon = `<span class="ski-idle-addr-icon ski-idle-addr-icon--inline">${SOL_ICON_SVG}</span>`;
                const ethIcon = `<span class="ski-idle-addr-icon ski-idle-addr-icon--inline"><svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#627eea" stroke="white" stroke-width="2.5"/><g transform="translate(10,3.5) scale(0.037)"><path d="M269.9 325.2L0 447.8l269.9 159.6 270-159.6z" fill="#fff" opacity="0.6"/><path d="M0.1 447.8l269.9 159.6V0z" fill="#fff" opacity="0.45"/><path d="M270 0v607.4l269.9-159.6z" fill="#fff" opacity="0.8"/><path d="M0 499l269.9 380.4V658.5z" fill="#fff" opacity="0.45"/><path d="M269.9 658.5v220.9L540 499z" fill="#fff" opacity="0.8"/></g></svg></span>`;
                const baseIcon = `<span class="ski-idle-addr-icon ski-idle-addr-icon--inline"><svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#0052FF" stroke="white" stroke-width="2.5"/><g transform="translate(11,10.5) scale(0.475)"><path d="M19.1 0C8.6 0 0 8.5 0 19s8.6 19 19.1 19c9 0 16.6-6.2 18.6-14.6H24.8c-1.7 3.4-5.2 5.7-9.2 5.7-5.7 0-10.3-4.7-10.3-10.4 0-5.7 4.6-10.4 10.3-10.4 3.8 0 7.1 2.1 8.9 5.2h13.1C35.5 6 27.9 0 19.1 0z" fill="white"/></g></svg></span>`;
                const tronIcon = `<span class="ski-idle-addr-icon ski-idle-addr-icon--inline"><svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="17.5" fill="#FF0013" stroke="white" stroke-width="2.5"/><g transform="translate(7.5,11) scale(0.046)"><path d="M378.8 0H4.5L167.1 340.7 505 121.1 378.8 0zM182.7 261.8L71.1 44.4h270.5L182.7 261.8zM204.1 294.5L454.4 147l-112.7 344.4L204.1 294.5z" fill="white"/></g></svg></span>`;

                // Per-row USD balances
                const _suiUsd2 = app.sui * (suiPriceCache?.price ?? 0) + app.stableUsd;
                const _solUsd2 = app.solBalance > 0 ? app.solBalance * (getTokenPrice('SOL') ?? 0) : 0;
                const _fmtBal2 = (v: number) => v >= 0.50 ? `<span class="ski-idle-addr-bal">$${Math.round(v).toLocaleString()}</span>` : '';

                const suiLine = `<span class="ski-idle-addr-line ski-idle-addr-line--sui" title="${addr}">${suiIcon} ${short}${_fmtBal2(_suiUsd2)}</span>`;
                const btcLine = `<span class="ski-idle-addr-line ski-idle-addr-line--btc" title="${status.btcAddress}">${btcIcon} ${status.btcAddress.slice(0, 6)}\u2026${status.btcAddress.slice(-6)}</span>`;
                const solLine = `<span class="ski-idle-addr-line ski-idle-addr-line--sol" title="${status.solAddress}">${solIcon} ${status.solAddress.slice(0, 6)}\u2026${status.solAddress.slice(-6)}${_fmtBal2(_solUsd2)}</span>`;
                const baseChip = cachedBaseAddr ? `<span class="ski-idle-addr-l2-chip" data-l2="base" title="Base L2">${baseIcon}</span>` : '';
                const ethLine = status.ethAddress ? `<span class="ski-idle-addr-line ski-idle-addr-line--eth" title="${status.ethAddress}">${ethIcon} ${status.ethAddress.slice(0, 6)}\u2026${status.ethAddress.slice(-6)}${baseChip}</span>` : '';
                const baseLine = cachedBaseAddr ? `<span class="ski-idle-addr-line ski-idle-addr-line--base" style="padding-left:1.2em;display:none" title="${cachedBaseAddr}">${baseIcon} ${cachedBaseAddr.slice(0, 6)}\u2026${cachedBaseAddr.slice(-6)}</span>` : '';
                const tronLine = cachedTronAddr ? `<span class="ski-idle-addr-line ski-idle-addr-line--tron" title="${cachedTronAddr}">${tronIcon} ${cachedTronAddr.slice(0, 5)}\u2026${cachedTronAddr.slice(-5)} <span style="opacity:0.5;font-size:0.75rem">USDT</span></span>` : '';
                addrRow.innerHTML = `${suiLine}${btcLine}${solLine}${ethLine}${baseLine}${tronLine}`;
                addrRow.removeAttribute('hidden');
                _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.add('ski-idle-quick-btn--active');
                _freezeGif();
                addrRow.querySelectorAll('.ski-idle-addr-line').forEach(el => {
                  el.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const h = el as HTMLElement;
                    const full = h.title || '';
                    const c = h.classList.contains('ski-idle-addr-line--btc') ? '#f7931a' : h.classList.contains('ski-idle-addr-line--sol') ? '#c084fc' : h.classList.contains('ski-idle-addr-line--eth') ? '#818cf8' : h.classList.contains('ski-idle-addr-line--base') ? '#0052FF' : h.classList.contains('ski-idle-addr-line--tron') ? '#FF0013' : '#22c55e';
                    toggleAddrRow(h, full, c);
                  });
                });
                // L2 chip → uncollapse Base row
                addrRow.querySelectorAll('.ski-idle-addr-l2-chip').forEach(chip => {
                  chip.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const baseRow = addrRow.querySelector('.ski-idle-addr-line--base') as HTMLElement | null;
                    if (!baseRow) return;
                    const visible = baseRow.style.display !== 'none';
                    baseRow.style.display = visible ? 'none' : '';
                    (chip as HTMLElement).style.opacity = visible ? '1' : '0.4';
                  });
                });
                const _closeAddr = (ev: Event) => {
                  if (addrRow.contains(ev.target as Node)) return;
                  addrRow.setAttribute('hidden', '');
                  _unfreezeGif();
                  _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.remove('ski-idle-quick-btn--active');
                  _idleOverlay?.removeEventListener('click', _closeAddr);
                  document.removeEventListener('click', _closeAddrDoc);
                };
                const _closeAddrDoc = (ev: Event) => {
                  if (_idleOverlay?.contains(ev.target as Node)) return;
                  addrRow.setAttribute('hidden', '');
                  _unfreezeGif();
                  _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.remove('ski-idle-quick-btn--active');
                  document.removeEventListener('click', _closeAddrDoc);
                  _idleOverlay?.removeEventListener('click', _closeAddr);
                };
                setTimeout(() => {
                  _idleOverlay?.addEventListener('click', _closeAddr);
                  document.addEventListener('click', _closeAddrDoc);
                }, 50);
              }
            }
            btn.disabled = false;
            btn.innerHTML = '\ud83e\udd91 Rumble';
            return;
          }

          // Not all chains cached — RPC check then provision
          const checkStep = addStep('Checking existing dWallets...', 'active');
          const { getCrossChainStatus } = await import('./client/ika.js');
          const status = await getCrossChainStatus(ws.address);
          updateStep(checkStep, 'done', 'dWallet status loaded');

          // Show what exists
          const secpStep = addStep(
            status.btcAddress ? `secp256k1 already active` : 'secp256k1 — needs provisioning',
            status.btcAddress ? 'skip' : 'pending',
          );
          const edStep = addStep(
            status.solAddress ? `ed25519 already active` : 'ed25519 — needs provisioning',
            status.solAddress ? 'skip' : 'pending',
          );

          // Step 2: Provision if needed
          if (!status.btcAddress || !status.solAddress) {
            // If card shows a different name, resolve its address and send DWalletCap there
            const _cardName = _idleOverlay?.querySelector('.ski-idle-card-name')?.textContent?.trim().replace(/\.sui$/, '') || '';
            const _ownName = (app.suinsName || '').replace(/\.sui$/, '');
            let targetRumble: string | undefined;
            if (_cardName && _cardName !== _ownName) {
              const _resolved = nsTargetAddress || nsNftOwner;
              if (_resolved) targetRumble = _resolved;
            }
            // Fast-fail: check SuiNS name before starting Rumble
            if (!app.suinsName) {
              addStep('\u2715 Rumble failed \u2014 SuiNS name/subname required', 'skip');
              btn.disabled = false;
              btn.innerHTML = '\ud83e\udd91 Rumble';
              return;
            }

            const provStep = addStep(targetRumble ? `Rumble → ${_cardName}.sui...` : 'Rumble starting...', 'active');

            // Register listeners BEFORE dispatching — ski:rumble may resolve synchronously
            await new Promise<void>((resolve) => {
              const onProgress = ((ev: CustomEvent) => {
                const stage = ev.detail as string;
                if (stage.includes('secp256k1')) updateStep(secpStep, stage.includes('fail') ? 'skip' : 'active', stage);
                else if (stage.includes('ed25519')) updateStep(edStep, stage.includes('fail') ? 'skip' : 'active', stage);
                else if (stage === 'Done!') {
                  updateStep(provStep, 'done', 'Rumble complete');
                } else if (stage.includes('Failed') || stage.includes('failed')) {
                  updateStep(provStep, 'skip', stage);
                }
              }) as EventListener;

              const onComplete = ((ev: CustomEvent) => {
                window.removeEventListener('ski:rumble-progress', onProgress);
                window.removeEventListener('ski:rumble-complete', onComplete as EventListener);
                const result = ev.detail;
                if (result?.error) {
                  updateStep(provStep, 'skip', result.error);
                } else {
                  if (result?.btcAddress) updateStep(secpStep, 'done', `secp256k1 \u2713 BTC + ETH`);
                  if (result?.solAddress) updateStep(edStep, 'done', `ed25519 \u2713 SOL`);
                  if (!result?.btcAddress && !result?.solAddress) updateStep(provStep, 'skip', 'Rumble failed \u2014 no chains provisioned');
                }
                resolve();
              }) as EventListener;

              window.addEventListener('ski:rumble-progress', onProgress);
              window.addEventListener('ski:rumble-complete', onComplete as EventListener);
              // Dispatch AFTER listeners are registered — ski:rumble may resolve synchronously
              window.dispatchEvent(new CustomEvent('ski:rumble', { detail: { targetRumble } }));
              setTimeout(() => resolve(), 300_000);
            });
          }

          // Step 3: Final summary — expandable chain addresses
          const final = await getCrossChainStatus(ws.address);
          const chains: string[] = [];
          if (final.btcAddress) { chains.push('BTC'); updateStep(secpStep, 'done', `secp256k1 \u2713 BTC + ETH`); }
          if (final.ethAddress) chains.push('ETH');
          if (final.solAddress) { chains.push('SOL'); updateStep(edStep, 'done', `ed25519 \u2713 SOL`); }

          const summaryStep = addStep(`Rumble complete \u2014 ${chains.join(' + ') || 'no chains'} ready`, 'done');
          if (summaryStep) {
            summaryStep.style.cursor = 'pointer';
            summaryStep.title = 'Tap to show addresses';
            summaryStep.addEventListener('click', () => {
              // Toggle address expansion
              let addrDiv = panel?.querySelector('.ski-idle-rumble-addrs') as HTMLElement | null;
              if (addrDiv) { addrDiv.remove(); return; }
              addrDiv = document.createElement('div');
              addrDiv.className = 'ski-idle-rumble-addrs';
              addrDiv.style.cssText = 'display:flex;flex-direction:column;gap:3px;padding:4px 0 2px 20px';
              // Detect native SOL wallet (Phantom, Backpack, Solflare)
              const nativeSol = localStorage.getItem('ski:sol-native') || '';
              const addrs: { chain: string; label: string; addr: string; color: string }[] = [
                { chain: 'btc', label: 'btc@', addr: final.btcAddress || '', color: '#f7931a' },
                { chain: 'eth', label: 'eth@', addr: final.ethAddress || '', color: '#818cf8' },
                { chain: 'sol', label: 'sol@ dWallet', addr: final.solAddress || '', color: '#c084fc' },
              ];
              if (nativeSol) {
                addrs.push({ chain: 'sol', label: 'sol@ native', addr: nativeSol, color: '#14f195' });
              }
              for (const a of addrs) {
                if (!a.addr) continue;
                const row = document.createElement('div');
                row.style.cssText = `font-family:ui-monospace,monospace;font-size:0.6rem;font-weight:600;color:${a.color};cursor:pointer;padding:2px 4px;border-radius:3px;border:1px solid ${a.color}33;background:${a.color}15`;
                row.textContent = `${a.label} ${a.addr.slice(0, 6)}\u2026${a.addr.slice(-6)}`;
                row.title = a.addr;
                row.addEventListener('click', (ev) => { ev.stopPropagation(); toggleAddrRow(row, a.addr, a.color); });
                addrDiv!.appendChild(row);
              }

              // "Link SOL wallet" button — connect Phantom/Backpack/Solflare
              if (!nativeSol) {
                const linkBtn = document.createElement('button');
                linkBtn.style.cssText = 'font-family:ui-monospace,monospace;font-size:0.6rem;font-weight:700;color:#14f195;cursor:pointer;padding:3px 8px;border-radius:4px;border:1px solid rgba(20,241,149,0.4);background:rgba(20,241,149,0.12);margin-top:2px;align-self:flex-start';
                linkBtn.textContent = '+ Link SOL wallet';
                linkBtn.title = 'Connect Phantom, Backpack, or Solflare';
                linkBtn.addEventListener('click', async (ev) => {
                  ev.stopPropagation();
                  try {
                    // Try Phantom → Backpack → Solflare
                    const provider = (window as any).phantom?.solana ?? (window as any).solana ?? (window as any).backpack ?? (window as any).solflare;
                    if (!provider) { showToast('No Solana wallet found \u2014 install Phantom or Backpack'); return; }
                    linkBtn.textContent = 'Connecting...';
                    const resp = await provider.connect();
                    const pubkey = resp?.publicKey?.toString?.() || resp?.publicKey?.toBase58?.() || '';
                    if (!pubkey) { showToast('Could not get SOL address'); linkBtn.textContent = '+ Link SOL wallet'; return; }
                    localStorage.setItem('ski:sol-native', pubkey);
                    showToast(`\u2713 SOL linked: ${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`);
                    // Add the row inline
                    const newRow = document.createElement('div');
                    newRow.style.cssText = 'font-family:ui-monospace,monospace;font-size:0.6rem;font-weight:600;color:#14f195;cursor:pointer;padding:2px 4px;border-radius:3px;border:1px solid rgba(20,241,149,0.2);background:rgba(20,241,149,0.08)';
                    newRow.textContent = `sol@ native ${pubkey.slice(0, 6)}\u2026${pubkey.slice(-6)}`;
                    newRow.title = pubkey;
                    newRow.addEventListener('click', (e2) => { e2.stopPropagation(); toggleAddrRow(newRow, pubkey, '#14f195'); });
                    linkBtn.replaceWith(newRow);
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : 'SOL connect failed');
                    linkBtn.textContent = '+ Link SOL wallet';
                  }
                });
                addrDiv.appendChild(linkBtn);
              }

              summaryStep.after(addrDiv);
              if (convoEl) convoEl.scrollTop = convoEl.scrollHeight;
            });
          }
        } catch (err) {
          addStep(`Error: ${err instanceof Error ? err.message : 'unknown'}`, 'skip');
        } finally {
          btn.disabled = false;
          btn.innerHTML = '\ud83e\udd91 Rumble';
        }
      });

      // Next page → t2000 page
      _idleOverlay.querySelector('#ski-idle-next')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!_idleOverlay) return;
        const t2000s = (self as any).__skiT2000s ?? [];
        const agentCount = t2000s.length;
        // Replace overlay content with t2000 page
        const mediaEl = _idleOverlay.querySelector('.ski-idle-media');
        const bottomRow = _idleOverlay.querySelector('.ski-idle-bottom-row');
        const thunderRow = _idleOverlay.querySelector('.ski-idle-thunder-row');
        const cardEl = _idleOverlay.querySelector('.ski-idle-card');
        if (mediaEl) mediaEl.innerHTML = `
          <div class="ski-idle-t2000">
            <div class="ski-idle-t2000-header">\ud83e\udd16 t2000 Ship</div>
            <div class="ski-idle-t2000-stat">
              <span>Agents deployed</span>
              <span>${agentCount}</span>
            </div>
            <div class="ski-idle-t2000-stat">
              <span>Deploy cost</span>
              <span>$4.50 iUSD</span>
            </div>
            <div class="ski-idle-t2000-missions">
              <div class="ski-idle-t2000-mission" data-mission="arb">\u26a1 arb</div>
              <div class="ski-idle-t2000-mission" data-mission="sweep">\ud83e\uddf9 sweep</div>
              <div class="ski-idle-t2000-mission" data-mission="farm">\ud83c\udf3e farm</div>
              <div class="ski-idle-t2000-mission" data-mission="watch">\ud83d\udc41 watch</div>
              <div class="ski-idle-t2000-mission" data-mission="route">\ud83d\udcca route</div>
              <div class="ski-idle-t2000-mission" data-mission="snipe">\ud83c\udfaf snipe</div>
              <div class="ski-idle-t2000-mission" data-mission="storm">\u26c8\ufe0f storm</div>
            </div>
            <div class="ski-idle-t2000-motto">destroys bridges and wormholes</div>
          </div>
        `;
        // Swap next arrow to back arrow
        if (bottomRow) {
          const nextBtn = bottomRow.querySelector('#ski-idle-next');
          if (nextBtn) {
            nextBtn.textContent = '\u2039';
            nextBtn.setAttribute('title', 'Back');
            (nextBtn as HTMLElement).id = 'ski-idle-back';
            nextBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              // Rebuild the overlay
              _idleOverlay?.remove(); _idleOverlay = null;
              _showIdleOverlay();
            });
          }
        }
      });

      const _dismissIdle = (keepOverlay = false) => {
        if (!keepOverlay) { _idleOverlay?.remove(); _idleOverlay = null; try { localStorage.removeItem('ski:idle-open'); } catch {} }
        _resetIdle();
      };
      const _triggerSuiami = () => {
        if (!getState().address) { _dismissIdle(); return; }
        if (!app.skiMenuOpen) {
          app.skiMenuOpen = true;
          try { localStorage.setItem('ski:lift', '1'); } catch {}
          render();
        }
        // Keep GIF visible — listen for SUIAMI completion to dismiss
        const _onSuiamiDone = () => {
          window.removeEventListener('suiami:signed', _onSuiamiDone);
          _dismissIdle();
        };
        window.addEventListener('suiami:signed', _onSuiamiDone);
        // Also dismiss after 30s timeout if signing is rejected/cancelled
        setTimeout(() => { window.removeEventListener('suiami:signed', _onSuiamiDone); _dismissIdle(); }, 30_000);

        // Click SUIAMI button once menu renders
        const _tryClickSuiami = (attempts = 0) => {
          if (attempts > 10) { _dismissIdle(); return; }
          const btn = document.getElementById('wk-send-btn') as HTMLButtonElement | null;
          if (btn && btn.textContent?.includes('SUIAMI')) {
            btn.disabled = false;
            btn.click();
          } else {
            setTimeout(() => _tryClickSuiami(attempts + 1), 200);
          }
        };
        setTimeout(_tryClickSuiami, 500);
      };
      // GIF click triggers SUIAMI (overlay stays), but not on iUSD button or focus-restore
      _idleOverlay.querySelector('.ski-idle-media')?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Media area clicks do nothing — no accidental SUIAMI triggers
      });
      // Thunder input — doesn't dismiss, Enter confirms then sends
      const _freshQuestTs = new Set<number>(); // timestamps of messages quested this session
      const _idleThunderInput = _idleOverlay.querySelector('#ski-idle-thunder') as HTMLInputElement | null;
      const _sendIdleThunder = async () => {
        // Quest mode: decrypt pending signals across all owned names
        const sendBtn = _idleThunderSend;
        if (sendBtn?.dataset.questMode === '1') {
          sendBtn.innerHTML = '\u2026';
          sendBtn.disabled = true;
          try {
            const ws = getState();
            if (!ws.address) return;
            const { getThunders } = await import('./client/thunder.js');

            // Build list of all names with pending signals
            const toQuest: { name: string; count: number }[] = [];
            if (sendBtn.dataset.questAll === '1') {
              for (const d of nsOwnedDomains) {
                if (d.kind !== 'nft') continue;
                const bare = d.name.replace(/\.sui$/, '').toLowerCase();
                const c = _thunderCounts[bare] ?? 0;
                if (c > 0) toQuest.push({ name: bare, count: c });
              }
            } else {
              const questName = sendBtn.dataset.questName || '';
              if (!questName) { sendBtn.innerHTML = '\u26a1'; sendBtn.disabled = false; return; }
              toQuest.push({ name: questName, count: _thunderCounts[questName.toLowerCase()] ?? 1 });
            }

            if (toQuest.length === 0) { showToast('No signals to quest'); sendBtn.innerHTML = '\u26a1'; sendBtn.disabled = false; return; }

            let totalDecrypted = 0;

            for (const { name } of toQuest) {
              try {
                const groupUuid = `thunder-${name}`;
                const { messages } = await getThunders({
    
                  groupRef: { uuid: groupUuid },
                });
                for (const m of messages) {
                  _freshQuestTs.add(Date.now());
                  await _storeThunderLocal(name, m.senderAddress.slice(0, 8), m.text, 'in', m.senderAddress.slice(0, 8), m.senderAddress);
                }
                totalDecrypted += messages.length;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.toLowerCase().includes('reject')) showToast(`${name}: ${msg}`);
              }
            }

            // Zero out counts for quested names
            for (const { name } of toQuest) {
              _thunderCounts[name] = 0;
            }
            try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}
            await _refreshThunderLocalCounts();
            if (toQuest.length > 0) _expandIdleConvo(toQuest[0].name);

            // Reset button via badge updater
            _updateIdleThunderBadge();
            sendBtn.disabled = false;
            _renderThunderComposePreview();
            if (totalDecrypted > 0) showToast(`\u26a1 ${totalDecrypted} signal${totalDecrypted > 1 ? 's' : ''} purged`);
          } catch (err) {
            sendBtn.innerHTML = '\u26c8\ufe0f';
            sendBtn.disabled = false;
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.toLowerCase().includes('reject')) showToast(msg);
          }
          return;
        }

        const raw = _idleThunderInput?.value.trim() || '';
        if (!raw) return;
        const ws = getState();
        if (!ws.address) return;
        try {
          const draft = _parseThunderCompose(raw);
          if (!draft || draft.error || draft.recipients.length === 0) {
            _thunderComposeConfirmedRaw = '';
            _thunderComposeStage = 'preview';
            _renderThunderComposePreview();
            showToast(draft?.error || 'No recipient — use @name');
            return;
          }
          // Auto-send when intent is clear: has $ (payment), or explicit @mention with message body
          // Two-tap only when ambiguous: inferred recipient, no message body, or unusual chars
          const _hasExplicitMention = /(?:^|[^a-z0-9_-])@[a-z0-9-]{3,63}/i.test(raw);
          const _hasClearIntent = /\$/.test(raw) || (_hasExplicitMention && draft.message.length > 0);
          const _isAmbiguous = draft.source !== 'mention' || draft.message.length === 0;
          const _needsConfirm = _isAmbiguous && !_hasClearIntent;

          if (_needsConfirm && (_thunderComposeConfirmedRaw !== draft.raw || _thunderComposeStage !== 'confirmed')) {
            _thunderComposeConfirmedRaw = draft.raw;
            _thunderComposeStage = 'confirmed';
            _renderThunderComposePreview();
            return;
          }

          const { sendThunder, lookupRecipientAddress } = await import('./client/thunder.js');
          const senderName = app.suinsName || '';
          const recipients = draft.recipients;
          const msgText = draft.message;
          const transferAmtUsd = (draft.amount && !draft.amountError) ? draft.amount : undefined;
          const origBtnHtml = sendBtn?.innerHTML || '\u26a1';

          // Show loading spinner on send button — hover reveals cancel
          let _cancelled = false;
          if (sendBtn) {
            _thunderComposeStage = 'sending';
            sendBtn.innerHTML = '<span class="ski-idle-thunder-spinner"></span>';
            sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send ski-idle-thunder-send--loading';
            sendBtn.title = 'Cancel';
            const _onCancel = (ev: Event) => { ev.stopPropagation(); _cancelled = true; sendBtn.innerHTML = origBtnHtml; sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send'; sendBtn.title = 'Open Storm'; sendBtn.removeEventListener('click', _onCancel); };
            sendBtn.addEventListener('click', _onCancel);
          }

          try {
            for (const recip of recipients) {
              if (_cancelled) break;
              // Resolve transfer if amount is set
              let transfer: { recipientAddress: string; amountMist: bigint } | undefined;
              if (transferAmtUsd) {
                const recipAddr = await lookupRecipientAddress(recip);
                if (!recipAddr) { showToast(`Cannot resolve address for ${recip}.sui`); continue; }
                const suiPrice = suiPriceCache?.price ?? 0;
                if (suiPrice <= 0) { showToast('Cannot determine SUI price'); continue; }
                const suiAmount = transferAmtUsd / suiPrice;
                const amountMist = BigInt(Math.floor(suiAmount * 1e9));
                transfer = { recipientAddress: recipAddr, amountMist };
              }
              if (_cancelled) break;
              const groupUuid = `thunder-${senderName}-${recip}`;
              await sendThunder({
  
                groupRef: { uuid: groupUuid },
                text: msgText,
                transfer,
                executeTransfer: transfer ? (bytes: Uint8Array) => signAndExecuteTransaction(bytes) : undefined,
              });
              const amtLabel = transferAmtUsd ? ` ($${transferAmtUsd})` : '';
              await _storeThunderLocal(senderName || ws.address, recip, msgText + amtLabel, 'out', undefined, nsTargetAddress ?? undefined);
              _addThunderContact(recip);
            }
            if (_cancelled) {
              if (sendBtn) {
                sendBtn.innerHTML = origBtnHtml;
                sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send';
                sendBtn.title = 'Open Storm';
              }
              _thunderComposeStage = 'confirmed';
              _renderThunderComposePreview();
              return;
            }
            // Success: show bubble, clear input, resume GIF
            if (_idleThunderInput) _idleThunderInput.value = '';
            _unfreezeGif();
            const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
            const bubble = document.createElement('div');
            bubble.className = 'ski-idle-bubble ski-idle-bubble--out';
            bubble.textContent = msgText;
            if (convoEl) { convoEl.appendChild(bubble); convoEl.removeAttribute('hidden'); convoEl.scrollTop = convoEl.scrollHeight; }
            const names = recipients.map(r => `${r}.sui`).join(', ');
            const amtToast = transferAmtUsd ? ` \u00b7 $${transferAmtUsd} sent` : '';
            showToast(`\u26a1 Signal sent to ${names}${amtToast}`);
            _expandIdleConvo(recipients[0]);
            _thunderComposeConfirmedRaw = '';
            _thunderComposeStage = 'idle';
            _renderThunderComposePreview();
          } catch (txErr) {
            const txMsg = txErr instanceof Error ? txErr.message : 'Signal failed';
            _thunderComposeStage = 'confirmed';
            _renderThunderComposePreview();
            if (!txMsg.toLowerCase().includes('reject')) {
              // Show failed bubble with retry
              const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
              const failBubble = document.createElement('div');
              failBubble.className = 'ski-idle-bubble ski-idle-bubble--out ski-idle-bubble--failed';
              failBubble.textContent = msgText;
              failBubble.title = txMsg;
              failBubble.style.cursor = 'pointer';
              if (convoEl) { convoEl.appendChild(failBubble); convoEl.removeAttribute('hidden'); convoEl.scrollTop = convoEl.scrollHeight; }
              failBubble.addEventListener('click', () => {
                failBubble.remove();
                if (_idleThunderInput) _idleThunderInput.value = raw;
                _thunderComposeConfirmedRaw = raw;
                _thunderComposeStage = 'confirmed';
                _renderThunderComposePreview();
                _sendIdleThunder();
              }, { once: true });
              showToast(txMsg);
            }
          } finally {
            if (sendBtn) { sendBtn.innerHTML = origBtnHtml; sendBtn.className = 'ski-idle-quick-btn ski-idle-quick-btn--storm ski-idle-thunder-send'; sendBtn.title = 'Open Storm'; }
            _renderThunderComposePreview();
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Signal failed';
          if (!errMsg.toLowerCase().includes('reject')) showToast(errMsg);
        }
      };
      // SOL deposit QR — shows on overlay when Quest mode is active
      let _solQrShown = '';
      async function _showSolQr(amountUsd: number) {
        const qrEl = _idleOverlay?.querySelector('#ski-idle-sol-qr') as HTMLElement | null;
        if (!qrEl) return;
        const ws = getState();
        if (!ws.address) { qrEl.setAttribute('hidden', ''); return; }
        // Don't re-fetch if already showing for same address
        if (_solQrShown === ws.address) { qrEl.removeAttribute('hidden'); return; }
        try {
          const r = await fetch('/api/cache/deposit-intent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ suiAddress: ws.address, amountUsd }),
          });
          if (!r.ok) return;
          const d = await r.json() as { qr?: string; prismUri?: string; usdcAmount?: string; iusdAmount?: string; tag?: number; solQr?: string; solAmount?: number; solanaPayUri?: string };
          if (!d.qr && !d.solQr) return;
          _solQrShown = ws.address;
          // Prefer Solana Pay QR (scannable by Phantom/Solflare) over Prism URI QR
          const qrUrl = d.solQr || d.qr;
          const qrLink = d.solanaPayUri || d.prismUri || '';
          const estUsd = d.amountUsd ?? (d.solAmount && d.solPrice ? d.solAmount * d.solPrice : 7.77);
          qrEl.innerHTML = `
            <div class="ski-idle-sol-qr-inner" style="position:relative;opacity:0.4;pointer-events:none">
              <img src="${esc(qrUrl)}" alt="Solana Pay" width="80" height="80" class="ski-idle-sol-qr-img">
              <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:48px;color:#ef4444;text-shadow:0 0 8px rgba(0,0,0,0.8)">\u2715</span>
              <span class="ski-idle-sol-qr-amt" style="color:#ef4444">TODO</span>
            </div>
          `;
          qrEl.removeAttribute('hidden');
        } catch {}
      }
      function _hideSolQr() {
        const qrEl = _idleOverlay?.querySelector('#ski-idle-sol-qr') as HTMLElement | null;
        if (qrEl) qrEl.setAttribute('hidden', '');
      }

      async function _expandIdleConvo(counterparty: string) {
        const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
        if (!convoEl) return;
        const entries = await _getConversation(counterparty);
        if (!entries.length) {
          convoEl.setAttribute('hidden', '');
          _idleThunderSend?.classList.remove('ski-idle-thunder-send--convo-open');
          return;
        }
        _idleThunderSend?.classList.add('ski-idle-thunder-send--convo-open');

        // Secret read receipt: check if counterparty has 0 pending signals on-chain.
        // If we sent them signals and they're gone → they purged them → mark as read.
        const cBare = counterparty.replace(/\.sui$/, '').toLowerCase();
        const cPending = _thunderCounts[cBare] ?? 0;
        const hasUnread = entries.some(e => (e.dir === 'out' || (!e.dir && !e.from)) && !e.read);
        if (hasUnread && cPending === 0) {
          // All signals were purged — mark outgoing as read
          let changed = false;
          for (const e of entries) {
            if ((e.dir === 'out' || (!e.dir && !e.from)) && !e.read) {
              e.read = true;
              changed = true;
            }
          }
          if (changed) {
            // Persist the read flags back to encrypted log
            try {
              const ws = getState();
              if (ws.address) {
                const key = await _deriveThunderKey(ws.address);
                const all = await _readThunderLog();
                const cAddr = entries[0]?.addr;
                for (const entry of all) {
                  if ((entry.dir === 'out' || (!entry.dir && !entry.from))) {
                    const toBare = (entry.to || '').replace(/\.sui$/i, '').toLowerCase();
                    if (toBare === cBare || (cAddr && entry.addr === cAddr)) {
                      entry.read = true;
                    }
                  }
                }
                const plaintext = new TextEncoder().encode(JSON.stringify(all));
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
                localStorage.setItem(`ski:thunder-log:${ws.address}`, JSON.stringify({
                  ct: btoa(String.fromCharCode(...ct)),
                  iv: btoa(String.fromCharCode(...iv)),
                }));
              }
            } catch { /* best effort */ }
          }
        }

        const bubbles = entries.slice(-20).map(e => {
          const isOut = e.dir === 'out' || (!e.dir && !e.from);
          let msgText = e.msg;
          if (!isOut && !e.dir) msgText = msgText.replace(/^\u26a1 from [^:]+:\s*/, '');
          const cls = isOut ? 'ski-idle-bubble--out' : 'ski-idle-bubble--in';
          const readCls = isOut && e.read ? ' ski-idle-bubble--read' : '';
          const freshCls = _freshQuestTs.has(e.ts) ? ' ski-idle-bubble--fresh' : '';
          // Show which SuiNS name sent/received — links to their SUIAMI
          const suiamiName = isOut ? (e.to || '').replace(/\.sui$/, '') : (e.from || '').replace(/\.sui$/, '');
          const suiamiUrl = suiamiName ? `https://sui.ski/?suiami=${encodeURIComponent(suiamiName)}` : '';
          const arrow = isOut ? '\u2192' : '\u2192';
          const nameLabel = isOut
            ? (suiamiName ? `${arrow} ${suiamiName}` : '')
            : (suiamiName ? `${suiamiName} ${arrow}` : '');
          const nameBadge = nameLabel && suiamiUrl
            ? `<a class="ski-idle-bubble-name" href="${suiamiUrl}" target="_blank" rel="noopener" title="SUIAMI? I AM ${esc(suiamiName)}">${esc(nameLabel)}</a>`
            : nameLabel ? `<span class="ski-idle-bubble-name">${esc(nameLabel)}</span>` : '';
          return `<div class="ski-idle-bubble ${cls}${readCls}${freshCls}" data-ts="${e.ts}">${nameBadge}${esc(msgText)}</div>`;
        }).join('');
        const bare = counterparty.replace(/\.sui$/, '').toLowerCase();
        const title = `<div class="ski-idle-convo-title"><a href="https://${esc(bare)}.sui.ski" target="_blank" rel="noopener" title="${esc(bare)}.sui.ski">\u26a1 <span class="ski-idle-convo-name">${esc(bare)}</span><span class="ski-idle-convo-tld">.sui</span></a></div>`;
        convoEl.innerHTML = title + bubbles;
        convoEl.removeAttribute('hidden');
        convoEl.scrollTop = convoEl.scrollHeight;

        // Click-to-delete: tap once = confirm (red), tap again = strike/delete
        // Incoming signals on owned names → on-chain strike (rebate → treasury)
        // Outgoing or local-only → local delete
        let _deleteBusy = false;
        const _deleteFromLocalLog = async (ts: number) => {
          const ws = getState();
          if (!ws.address) return;
          try {
            const key = await _deriveThunderKey(ws.address);
            const storageKey = `ski:thunder-log:${ws.address}`;
            const raw = localStorage.getItem(storageKey);
            if (raw) {
              const { ct, iv } = JSON.parse(raw);
              const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) },
                key, Uint8Array.from(atob(ct), c => c.charCodeAt(0)),
              );
              let all: any[] = JSON.parse(new TextDecoder().decode(plaintext));
              all = all.filter(entry => entry.ts !== ts);
              const updated = new TextEncoder().encode(JSON.stringify(all));
              const newIv = crypto.getRandomValues(new Uint8Array(12));
              const newCt = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, key, updated));
              localStorage.setItem(storageKey, JSON.stringify({ ct: btoa(String.fromCharCode(...newCt)), iv: btoa(String.fromCharCode(...newIv)) }));
            }
          } catch {}
        };

        convoEl.querySelectorAll('.ski-idle-bubble').forEach(bubble => {
          bubble.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (_deleteBusy) return;
            const ts = parseInt((bubble as HTMLElement).dataset.ts || '0', 10);
            if (!ts) return;
            const isIncoming = (bubble as HTMLElement).classList.contains('ski-idle-bubble--in');

            // First tap: confirm (red)
            if (!(bubble as HTMLElement).classList.contains('ski-idle-bubble--confirm-delete')) {
              (bubble as HTMLElement).classList.add('ski-idle-bubble--confirm-delete');
              setTimeout(() => (bubble as HTMLElement).classList.remove('ski-idle-bubble--confirm-delete'), 3000);
              return;
            }

            _deleteBusy = true;
            const bare = counterparty.replace(/\.sui$/, '').toLowerCase();
            const isOwned = nsOwnedDomains.some(d => d.name.replace(/\.sui$/, '').toLowerCase() === bare)
              || (app.suinsName?.replace(/\.sui$/, '').toLowerCase() === bare);

            try {
              if (isIncoming && isOwned) {
                // On-chain strike: delete all signals up to this one + route rebate to treasury
                const ws = getState();
                if (!ws.address) { _deleteBusy = false; return; }
                const nftEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === bare);
                if (!nftEntry) { _deleteBusy = false; return; }

                // Count how many incoming bubbles are at or before this one (FIFO order)
                const allBubbles = Array.from(convoEl.querySelectorAll('.ski-idle-bubble--in'));
                const idx = allBubbles.indexOf(bubble);
                const strikeCount = idx >= 0 ? idx + 1 : 1;

                (bubble as HTMLElement).textContent = '\u2026';
                // Delete signals locally (SDK handles off-chain message lifecycle)

                // Delete all struck bubbles from local log + DOM
                for (let i = 0; i <= idx; i++) {
                  const b = allBubbles[i] as HTMLElement;
                  const bTs = parseInt(b.dataset.ts || '0', 10);
                  if (bTs) await _deleteFromLocalLog(bTs);
                  _freshQuestTs.delete(bTs);
                  b.remove();
                }

                // Update counts
                _thunderCounts[bare] = 0;
                try { localStorage.setItem('ski:thunder-counts', JSON.stringify(_thunderCounts)); } catch {}

                showToast(`\u26a1 ${strikeCount} struck \u2014 rebate \u2192 treasury`);
              } else {
                // Local-only delete
                await _deleteFromLocalLog(ts);
                (bubble as HTMLElement).remove();
              }
              _freshQuestTs.delete(ts);
              await _refreshThunderLocalCounts();
            } catch (err) {
              const msg = err instanceof Error ? err.message : '';
              // Signal already gone on-chain (struck/expired) — just clean up locally
              if (msg.includes('dynamic_field') || msg.includes('borrow_child_object') || msg.includes('abort code: 1')) {
                await _deleteFromLocalLog(ts);
                (bubble as HTMLElement).remove();
                await _refreshThunderLocalCounts();
                showToast('Signal already cleared — removed locally');
              } else if (!msg.toLowerCase().includes('reject')) {
                showToast(msg || 'Strike failed');
                (bubble as HTMLElement).classList.remove('ski-idle-bubble--confirm-delete');
              }
            }
            _deleteBusy = false;
          });
        });
      }
      // @ autocomplete for thunder input
      let _atDropdown: HTMLElement | null = null;
      let _atSelectedIdx = 0;
      const _getAtCandidates = (): { contacts: string[]; owned: string[] } => {
        const ownedSet = new Set<string>();
        for (const d of nsOwnedDomains) {
          const bare = d.name.replace(/\.sui$/, '').toLowerCase();
          if (bare) ownedSet.add(bare);
        }
        if (app.suinsName) ownedSet.add(app.suinsName.replace(/\.sui$/, '').toLowerCase());

        const contactSet = new Set<string>();
        for (const n of Object.keys(_thunderLocalCounts)) {
          const bare = n.toLowerCase();
          if (!ownedSet.has(bare)) contactSet.add(bare);
        }
        for (const n of Object.keys(_thunderCounts)) {
          const bare = n.toLowerCase();
          if (!ownedSet.has(bare)) contactSet.add(bare);
        }

        return {
          contacts: [...contactSet].sort(),
          owned: [...ownedSet].sort(),
        };
      };
      const _showAtDropdown = (filter: string) => {
        _dismissAtDropdown();
        const { contacts, owned } = _getAtCandidates();
        const f = filter.toLowerCase();
        const filteredContacts = contacts.filter(n => n.startsWith(f)).slice(0, 6);
        const filteredOwned = owned.filter(n => n.startsWith(f)).slice(0, 4);
        if (!filteredContacts.length && !filteredOwned.length) return;
        _atDropdown = document.createElement('div');
        _atDropdown.className = 'ski-idle-at-dropdown';
        _atSelectedIdx = 0;

        const leftHtml = filteredContacts.map(n =>
          `<div class="ski-idle-at-option ski-idle-at-option--contact" data-name="${n}">@${n}</div>`
        ).join('');
        const rightHtml = filteredOwned.map(n =>
          `<div class="ski-idle-at-option ski-idle-at-option--owned" data-name="${n}">@${n}</div>`
        ).join('');

        _atDropdown.innerHTML = `<div class="ski-idle-at-cols">`
          + `<div class="ski-idle-at-col ski-idle-at-col--left">${leftHtml || '<div class="ski-idle-at-empty">no contacts</div>'}</div>`
          + `<div class="ski-idle-at-col ski-idle-at-col--right">${rightHtml || '<div class="ski-idle-at-empty">no names</div>'}</div>`
          + `</div>`;

        // Mark first option active
        const allOpts = _atDropdown.querySelectorAll('.ski-idle-at-option');
        if (allOpts[0]) allOpts[0].classList.add('ski-idle-at-option--active');

        _atDropdown.querySelectorAll('.ski-idle-at-option').forEach(el => {
          el.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            _insertAtName((el as HTMLElement).dataset.name || '');
          });
        });
        const thunderRow = _idleOverlay?.querySelector('.ski-idle-thunder-row');
        if (thunderRow) thunderRow.appendChild(_atDropdown);
      };
      const _dismissAtDropdown = () => { _atDropdown?.remove(); _atDropdown = null; };
      const _insertAtName = (name: string) => {
        if (!_idleThunderInput) return;
        const val = _idleThunderInput.value;
        const cursor = _idleThunderInput.selectionStart ?? val.length;
        const before = val.slice(0, cursor);
        const atIdx = before.lastIndexOf('@');
        if (atIdx === -1) return;
        const after = val.slice(cursor);
        _idleThunderInput.value = before.slice(0, atIdx) + '@' + name + ' ' + after;
        _idleThunderInput.selectionStart = _idleThunderInput.selectionEnd = atIdx + name.length + 2;
        _dismissAtDropdown();
        _idleThunderInput.focus();
        // Populate the NS name input with the tagged name
        const idleNsInput = _idleOverlay?.querySelector('#ski-idle-ns') as HTMLInputElement | null;
        if (idleNsInput) { idleNsInput.value = name; nsLabel = name; }
        const mainNsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
        if (mainNsInput) mainNsInput.value = name;
        // Freeze GIF and expand conversation history for tagged name
        _freezeGif();
        _expandIdleConvo(name);
        _renderThunderComposePreview();
      };

      _idleThunderInput?.addEventListener('click', (e) => e.stopPropagation());
      _idleThunderInput?.addEventListener('input', () => {
        const val = _idleThunderInput!.value;
        const cursor = _idleThunderInput!.selectionStart ?? val.length;
        const before = val.slice(0, cursor);
        const atIdx = before.lastIndexOf('@');
        if (atIdx !== -1 && !before.slice(atIdx).includes(' ')) {
          const partial = before.slice(atIdx + 1);
          _showAtDropdown(partial);
        } else {
          _dismissAtDropdown();
        }
        // Sync last completed @tag to NS name input + resolve
        const tags = [...val.matchAll(/@([a-z0-9-]{3,63})/gi)].map(m => m[1].toLowerCase());
        if (tags.length > 0) {
          const latest = tags[tags.length - 1];
          const idleNsInput = _idleOverlay?.querySelector('#ski-idle-ns') as HTMLInputElement | null;
          if (idleNsInput && idleNsInput.value !== latest) {
            idleNsInput.value = latest;
            nsLabel = latest;
            const clearBtn = _idleOverlay?.querySelector('#ski-idle-clear') as HTMLElement | null;
            if (clearBtn) clearBtn.style.display = latest ? '' : 'none';
            nsAvail = null;
            _updateIdleStatus();
            if (latest.length >= 3 && isValidNsLabel(latest)) {
              // Debounce to avoid SuiNS rate limits during @tag typing
              if (_idleDebounce) clearTimeout(_idleDebounce);
              _idleDebounce = setTimeout(() => {
                fetchAndShowNsPrice(latest).then(() => { _updateIdleStatus(); _updateIdleCard(latest); });
              }, NS_LOOKUP_DEBOUNCE_MS);
            }
          }
          const mainNsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
          if (mainNsInput && mainNsInput.value !== latest) mainNsInput.value = latest;
        }
        _renderThunderComposePreview();
      });
      _idleThunderInput?.addEventListener('blur', () => {
        setTimeout(_dismissAtDropdown, 150);
        // Clear input on blur if it only contains @tag(s) and/or whitespace — restore quick buttons
        setTimeout(() => {
          if (!_idleThunderInput) return;
          const v = _idleThunderInput.value.replace(/@\S*/g, '').trim();
          if (!v) { _idleThunderInput.value = ''; _renderThunderComposePreview(); }
        }, 200);
      });
      _idleThunderInput?.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (_atDropdown) {
          const opts = _atDropdown.querySelectorAll('.ski-idle-at-option');
          if (e.key === 'ArrowDown') { e.preventDefault(); _atSelectedIdx = Math.min(_atSelectedIdx + 1, opts.length - 1); opts.forEach((o, i) => o.classList.toggle('ski-idle-at-option--active', i === _atSelectedIdx)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); _atSelectedIdx = Math.max(_atSelectedIdx - 1, 0); opts.forEach((o, i) => o.classList.toggle('ski-idle-at-option--active', i === _atSelectedIdx)); }
          else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); const sel = opts[_atSelectedIdx] as HTMLElement; if (sel) _insertAtName(sel.dataset.name || ''); else if (e.key === 'Enter') _sendIdleThunder(); return; }
          else if (e.key === 'Escape') { _dismissAtDropdown(); return; }
        }
        // Backspace on @name tag — delete the whole name at once, leave just @
        if (e.key === 'Backspace' && _idleThunderInput) {
          const val = _idleThunderInput.value;
          const pos = _idleThunderInput.selectionStart ?? val.length;
          // Find the @tag the cursor is inside or at the end of
          const before = val.slice(0, pos);
          const tagMatch = before.match(/@([a-z0-9-]{1,63})(\s?)$/i);
          if (tagMatch) {
            e.preventDefault();
            const tagStart = pos - tagMatch[0].length;
            // Delete the name part, keep the @
            _idleThunderInput.value = val.slice(0, tagStart + 1) + val.slice(pos);
            _idleThunderInput.setSelectionRange(tagStart + 1, tagStart + 1);
            return;
          }
        }
        if (e.key === 'Enter') { e.preventDefault(); _sendIdleThunder(); }
      });
      _idleThunderSend?.addEventListener('click', (e) => {
        e.stopPropagation();
        const convoEl = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
        const hasText = _idleThunderInput?.value.trim();
        // If convo is open and no text being composed, toggle it closed
        if (convoEl && !convoEl.hasAttribute('hidden') && !hasText && !_idleThunderSend?.dataset.questMode) {
          convoEl.setAttribute('hidden', '');
          _idleThunderSend?.classList.remove('ski-idle-thunder-send--convo-open');
          return;
        }
        // If convo is closed and no text, open it — or pre-fill @tag if no history
        if (convoEl && convoEl.hasAttribute('hidden') && !hasText) {
          const cardName = _idleOverlay?.querySelector('.ski-idle-card-name')?.textContent?.trim().replace(/\.sui$/, '') || '';
          if (cardName) {
            _expandIdleConvo(cardName);
            _idleThunderSend?.classList.add('ski-idle-thunder-send--convo-open');
            // If no history existed, expandIdleConvo hid it again — show empty convo + pre-fill @tag
            if (convoEl.hasAttribute('hidden')) {
              convoEl.removeAttribute('hidden');
              convoEl.innerHTML = '';
              _idleThunderSend?.classList.add('ski-idle-thunder-send--convo-open');
            }
            // Pre-fill thunder input with @cardName if empty
            if (_idleThunderInput && !_idleThunderInput.value.trim()) {
              _idleThunderInput.value = `@${cardName} `;
              _idleThunderInput.focus();
              _idleThunderInput.setSelectionRange(_idleThunderInput.value.length, _idleThunderInput.value.length);
            }
          }
          return;
        }
        _sendIdleThunder();
      });
      // Clean up previous listeners (prevents accumulation on overlay recreate)
      if (_idleOverlayClickFn && _idleOverlay) _idleOverlay.removeEventListener('click', _idleOverlayClickFn);
      if (_idleDocClickFn) document.removeEventListener('click', _idleDocClickFn);
      // Nothing in the overlay dismisses it — only successful action or header button
      // Unfreeze GIF if click lands outside any input
      _idleOverlayClickFn = (e: Event) => {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        if (!t.closest('input') && !t.closest('button') && !t.closest('.ski-idle-at-dropdown')) {
          _unfreezeGif();
        }
        // Click outside rumble panel → collapse it + deactivate squid button
        if (!t.closest('#ski-idle-rumble-panel') && !t.closest('#ski-idle-rumble') && !t.closest('.ski-idle-rumble-addrs') && !t.closest('[data-action="rumble"]')) {
          const convo = _idleOverlay?.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
          const panel = _idleOverlay?.querySelector('#ski-idle-rumble-panel') as HTMLElement | null;
          if (panel && convo) {
            convo.setAttribute('hidden', ''); convo.innerHTML = '';
            _idleOverlay?.querySelector('.ski-idle-quick-btn--squid')?.classList.remove('ski-idle-quick-btn--active');
          }
        }
      };
      _idleOverlay.addEventListener('click', _idleOverlayClickFn);
      // Click outside the idle overlay entirely → collapse rumble section
      _idleDocClickFn = (e: Event) => {
        if (!_idleOverlay) return;
        if (_idleOverlay.contains(e.target as Node)) return;
        const convo = _idleOverlay.querySelector('#ski-idle-thunder-convo') as HTMLElement | null;
        const panel = _idleOverlay.querySelector('#ski-idle-rumble-panel') as HTMLElement | null;
        if (panel && convo) {
          convo.setAttribute('hidden', ''); convo.innerHTML = '';
          _idleOverlay.querySelector('.ski-idle-quick-btn--squid')?.classList.remove('ski-idle-quick-btn--active');
        }
      };
      document.addEventListener('click', _idleDocClickFn);
      // Global Enter key → trigger action button from anywhere while overlay is open
      const _idleGlobalEnter = (e: Event) => {
        if (!_idleOverlay) return; // overlay gone — no-op
        const ke = e as KeyboardEvent;
        if (ke.key !== 'Enter') return;
        // Don't hijack Enter from the thunder input (that sends a signal)
        if ((document.activeElement as HTMLElement)?.id === 'ski-idle-thunder') return;
        if (_idleActionBtn && !_idleActionBtn.disabled) {
          e.preventDefault();
          _idleActionBtn.click();
        }
      };
      document.addEventListener('keydown', _idleGlobalEnter);

      // Listen for name acquisition (trade/mint) → refresh overlay to SUIAMI
      const _onNameAcquired = (e: Event) => {
        const name = (e as CustomEvent).detail?.name;
        if (!name) return;
        // Update state
        nsAvail = 'owned';
        nsKioskListing = null;
        nsTradeportListing = null;
        // Full rebuild — colors, shapes, and registration state all change
        setTimeout(() => window.dispatchEvent(new Event('ski:show-idle')), 600);
      };
      window.addEventListener('ski:name-acquired', _onNameAcquired);

      _updateIdleThunderBadge();

      // Close the SKI menu so it doesn't show behind the overlay
      if (app.skiMenuOpen) {
        app.skiMenuOpen = false;
        try { localStorage.setItem('ski:lift', '0'); } catch {}
        render();
      }

      // Populate card inside the media (above thunder row)
      const _idleCardDomain2 = document.getElementById('ski-nft-inline')?.dataset.domain || _lastNftCardDomain || '';
      const cardDiv = _idleOverlay.querySelector('#ski-idle-card') as HTMLElement | null;
      if (_idleCardDomain2 && cardDiv) {
        const ownedEntry = nsOwnedDomains.find(d => d.name.replace(/\.sui$/, '').toLowerCase() === _idleCardDomain2.toLowerCase());
        let expiryText = '';
        if (ownedEntry?.expirationMs) {
          const daysLeft = Math.max(0, Math.ceil((ownedEntry.expirationMs - Date.now()) / 86_400_000));
          expiryText = `${daysLeft}d`;
        }
        const thunderCount = _thunderCounts[_idleCardDomain2.toLowerCase()] ?? 0;
        const badgeHtml = thunderCount > 0 ? `\u26a1${thunderCount}` : '';
        cardDiv.innerHTML = `<span class="ski-idle-card-name" title="Populate input">${esc(_idleCardDomain2)}</span>${badgeHtml ? ` <span class="ski-idle-card-badges">${badgeHtml}</span>` : ''}${expiryText ? ` <span class="ski-idle-card-expiry">${expiryText}</span>` : ''}`;
      }

      // Auto-clear the SKI menu name input
      const mainNsInput = document.getElementById('wk-ns-label-input') as HTMLInputElement | null;
      if (mainNsInput) mainNsInput.value = '';

      // Elevate the real SKI menu NS row above the overlay
      const nsSection = document.getElementById('wk-dd-ns-section');
      if (nsSection) nsSection.classList.add('wk-dd-ns-section--elevated');

      try { localStorage.setItem('ski:idle-open', '1'); } catch {}

      // Cache idle video via Cache API for instant playback on subsequent loads
      const _idleVideo = _idleOverlay.querySelector('video.ski-idle-img') as HTMLVideoElement | null;
      if (_idleVideo && 'caches' in self) {
        const vSrc = '/assets/ski-idle.webm';
        caches.open('ski-media-v1').then(async (cache) => {
          const cached = await cache.match(vSrc);
          if (cached) {
            // Serve from cache — instant
            const blob = await cached.blob();
            if (_idleVideoBlobUrl) URL.revokeObjectURL(_idleVideoBlobUrl);
            _idleVideoBlobUrl = URL.createObjectURL(blob);
            _idleVideo.src = _idleVideoBlobUrl;
            _idleVideo.load();
          } else {
            // First visit — fetch, cache, and let the video load normally
            try {
              const resp = await fetch(vSrc);
              if (resp.ok) cache.put(vSrc, resp.clone());
            } catch {}
          }
        }).catch(() => {});
      }

      // Auto-resolve pre-filled name on overlay open (e.g. restored from localStorage on refresh)
      if (_idleNsInput?.value && _idleNsInput.value.length >= 3 && isValidNsLabel(_idleNsInput.value)) {
        fetchAndShowNsPrice(_idleNsInput.value).catch(() => {});
      }

      // Match header width to overlay width
      requestAnimationFrame(() => {
        if (!_idleOverlay) return;
        const overlayW = _idleOverlay.offsetWidth;
        if (overlayW > 0) {
          const hdr = document.querySelector('.ski-header') as HTMLElement;
          if (hdr) hdr.style.setProperty('--ski-header-w', `${overlayW + 16}px`); // +16 for header padding
        }
      });
  };

  const _resetIdle = () => {
    if (_idleTimer) clearTimeout(_idleTimer);
    if (_idleOverlay) return;
    _idleTimer = setTimeout(_showIdleOverlay, IDLE_MS);
  };

  // Listen for manual trigger (Lockin button)
  window.addEventListener('ski:show-idle', () => {
    if (_idleOverlay) { _idleOverlay.remove(); document.getElementById('ski-idle-card')?.remove(); _idleOverlay = null; document.querySelector<HTMLElement>('.ski-header')?.style.removeProperty('--ski-header-w'); document.getElementById('wk-dd-ns-section')?.classList.remove('wk-dd-ns-section--elevated'); }
    _showIdleOverlay();
  });

  // On disconnect, kill the idle timer so overlay doesn't reappear
  window.addEventListener('ski:wallet-disconnected', () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    import('./client/thunder.js').then(({ resetThunderClient }) => resetThunderClient()).catch(() => {});
  });

  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(evt => {
    document.addEventListener(evt, _resetIdle, { passive: true });
  });
  // Restore overlay immediately if it was open before refresh — don't wait for wallet reconnect
  if (localStorage.getItem('ski:idle-open') === '1') {
    // Check both live state and cached address (preloadStoredWallet may not have run yet)
    const _hasAddr = getState().address || localStorage.getItem('ski:last-address');
    if (_hasAddr) {
      _showIdleOverlay();
    } else {
      const _restoreOnConnect = () => {
        window.removeEventListener('ski:wallet-connected', _restoreOnConnect);
        if (!_idleOverlay) _showIdleOverlay();
      };
      window.addEventListener('ski:wallet-connected', _restoreOnConnect);
    }
  } else {
    _resetIdle();
  }
}

// ─── Init ────────────────────────────────────────────────────────────

export function initUI() {
  // Purge stale keys from previous versions — prevents ghost UI (old cards, thunder badges)
  try {
    localStorage.removeItem('ski:shell');           // v1 shell cache — superseded by ski:shell:v2
    localStorage.removeItem('ski:thunder-card-open');
    localStorage.removeItem('ski:thunder-counts');  // thunder polling disabled (#63)
    // Clear cached addr QR SVGs (had white background, now transparent)
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('ski:qr:addr:')) keys.push(k); }
    for (const k of keys) localStorage.removeItem(k);
  } catch {}

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
        // Detect WaaP social provider from account label — only overwrite if detected
        // Never clear a user-set provider (from the picker) on failed auto-detection
        if (/waap/i.test(ws.walletName) && ws.address) {
          const label = ws.account?.label || '';
          const detected = label ? detectWaapProvider(label) : null;
          if (detected) {
            try { localStorage.setItem(`ski:waap-provider:${ws.address}`, detected); } catch {}
          }
        }
      }
      // Always clear first so a previously connected wallet's data never bleeds through
      app.suinsName = '';
      app.ikaWalletId = '';
      app.btcAddress = '';
      app.ethAddress = '';
      app.solAddress = '';
      // Restore cached IKA squid status instantly (avoids button width jump)
      try {
        const hasIka = localStorage.getItem(`ski:has-ika:${ws.address}`);
        if (hasIka) app.ikaWalletId = hasIka;
      } catch {}
      // Restore this address's cached SuiNS name instantly (will refresh from network)
      try {
        const cached = localStorage.getItem(`ski:suins:${ws.address}`);
        if (cached) app.suinsName = cached;
      } catch {}
      // Restore cached IKA dWallet addresses instantly
      try {
        const ikaAddrs = localStorage.getItem(`ski:ika-addrs:${ws.address}`);
        if (ikaAddrs) {
          const parsed = JSON.parse(ikaAddrs);
          if (parsed.btc) app.btcAddress = parsed.btc;
          if (parsed.eth) app.ethAddress = parsed.eth;
          if (parsed.sol) app.solAddress = parsed.sol;
        }
      } catch {}

      startPolling();
      refreshPortfolio(true);

      // Dispatch event for other modules (fingerprint, session agent)
      window.dispatchEvent(new CustomEvent('ski:wallet-connected', {
        detail: { address: ws.address, walletName: ws.walletName },
      }));

      // Initialize Thunder Timestream client
      import('./client/thunder.js').then(({ initThunderClient }) => {
        initThunderClient({
          address: ws.address,
          signPersonalMessage: (msg: Uint8Array) => signPersonalMessage(msg),
        });
      }).catch(() => {});

      // Execute Prism intent if one was stored from ?prism= URL
      (async () => {
        try {
          const prismIntent = sessionStorage.getItem('ski:prism-intent');
          if (!prismIntent) return;
          sessionStorage.removeItem('ski:prism-intent');
          const [coin, amountStr] = prismIntent.split(':');
          const amount = parseFloat(amountStr || '0');
          if (coin !== 'usdc' || amount <= 0 || !ws.address) return;
          showToast(`\u26a1 Prism: sending ${amount} USDC to cache\u2026`);
          const result = await buildSendTx(
            ws.address, '0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3',
            String(amount), 'USDC',
          );
          if (result) {
            await signAndExecuteTransaction(result instanceof Uint8Array ? result : result);
            showToast('\u26a1 USDC sent — poking cache\u2026');
            await fetch('/api/cache/initiate');
            showToast('\u2728 Cache initiated — quest filling!');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Prism failed';
          if (!msg.toLowerCase().includes('reject')) showToast(msg);
        }
      })();

      // Background Quest fulfillment disabled — too aggressive, fires on page load
      // for names the user didn't explicitly Quest. Registration should only happen
      // when the user clicks MINT or Quest and explicitly signs.
      // TODO: re-enable with explicit Quest session tracking (not localStorage label)

      // Restore idle overlay if it was open before refresh
      if (!_idleOverlay && localStorage.getItem('ski:idle-open') === '1') {
        window.dispatchEvent(new Event('ski:show-idle'));
      }
    }

    if (ws.status === 'disconnected') {
      stopPolling();
      // Remove idle overlay so it doesn't float over the closed menu
      if (_idleOverlay) { _idleOverlay.remove(); document.getElementById('ski-idle-card')?.remove(); _idleOverlay = null; document.querySelector<HTMLElement>('.ski-header')?.style.removeProperty('--ski-header-w'); document.getElementById('wk-dd-ns-section')?.classList.remove('wk-dd-ns-section--elevated'); }
      try { localStorage.setItem('ski:idle-open', '0'); } catch {}
      app.sui = 0;
      app.usd = null;
      app.stableUsd = 0;
      app.nsBalance = 0;
      app.suinsName = '';
      app.ikaWalletId = '';
      app.btcAddress = '';
      app.ethAddress = '';
      app.solAddress = '';
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
      }, LONG_PRESS_MS);
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
    }, LONG_PRESS_MS);
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
          // Connect only — lockin deferred to first Thunder send/decrypt
          void selectWallet(wallet);
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

// ── One-off cleanup utility (console) ─────────────────────────────────
// Usage: skiCleanupCaps(['0x3710...8491', '0x7b39...beee'])
(window as any).skiCleanupCaps = async (capIds: string[]) => {
  const { burnDWalletCaps } = await import('./client/ika.js');
  const wallet = await import('./wallet.js');
  const ws = getState();
  if (!ws.address) { console.error('Not connected'); return; }
  console.log('[cleanup] Burning caps:', capIds);
  const digest = await burnDWalletCaps(ws.address, capIds, {
    signAndExecuteTransaction: (txBytes: Uint8Array) => wallet.signAndExecuteTransaction(txBytes),
  });
  console.log('[cleanup] Done! Digest:', digest);
  return digest;
};
