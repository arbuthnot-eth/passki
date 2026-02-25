/**
 * .SKI Wallet — Built from first principles on the Sui Wallet Standard.
 * Reference: https://docs.sui.io/standards/wallet-standard
 *
 * Uses @wallet-standard/app for wallet discovery and the standard
 * features API for connect/disconnect/sign operations.
 */

import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

// ─── Types ───────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface WalletState {
  status: ConnectionStatus;
  wallet: Wallet | null;
  account: WalletAccount | null;
  address: string;
  walletName: string;
  walletIcon: string;
}

type StateListener = (state: WalletState) => void;

// ─── State ───────────────────────────────────────────────────────────

const listeners: Set<StateListener> = new Set();
let currentState: WalletState = {
  status: 'disconnected',
  wallet: null,
  account: null,
  address: '',
  walletName: '',
  walletIcon: '',
};

let walletChangeUnsub: (() => void) | null = null;

function setState(patch: Partial<WalletState>) {
  currentState = { ...currentState, ...patch };
  listeners.forEach((fn) => fn(currentState));
}

export function subscribe(fn: StateListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): WalletState {
  return currentState;
}

// ─── Wallet Discovery ────────────────────────────────────────────────

const walletsApi = getWallets();

/** Get all Sui-compatible wallets currently registered */
export function getSuiWallets(): Wallet[] {
  return walletsApi.get().filter((w) => {
    // Must support a Sui chain
    const hasSuiChain = w.chains.some((c) => c.startsWith('sui:'));
    // Must have standard:connect
    const hasConnect = 'standard:connect' in w.features;
    return hasSuiChain && hasConnect;
  });
}

/** Listen for new wallets being registered */
export function onWalletsChanged(fn: () => void): () => void {
  const unsub1 = walletsApi.on('register', fn);
  const unsub2 = walletsApi.on('unregister', fn);
  return () => { unsub1(); unsub2(); };
}

// ─── Connect ─────────────────────────────────────────────────────────

export async function connect(wallet: Wallet): Promise<WalletAccount> {
  setState({ status: 'connecting' });

  try {
    const connectFeature = wallet.features['standard:connect'] as {
      connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
    };

    // Try silent first (already authorized)
    let { accounts } = await connectFeature.connect({ silent: true });

    if (accounts.length === 0) {
      // Request user authorization
      ({ accounts } = await connectFeature.connect());
    }

    if (accounts.length === 0) {
      throw new Error('No accounts authorized');
    }

    const account = accounts[0];

    // Listen for wallet changes (account switch, disconnect, etc.)
    if (walletChangeUnsub) walletChangeUnsub();
    if ('standard:events' in wallet.features) {
      const eventsFeature = wallet.features['standard:events'] as {
        on: (event: 'change', listener: (e: { accounts: readonly WalletAccount[] }) => void) => () => void;
      };
      walletChangeUnsub = eventsFeature.on('change', (event) => {
        if (event.accounts && currentState.wallet === wallet) {
          const updated = event.accounts[0];
          if (updated) {
            setState({
              account: updated,
              address: updated.address,
            });
          }
        }
      });
    }

    setState({
      status: 'connected',
      wallet,
      account,
      address: account.address,
      walletName: wallet.name,
      walletIcon: wallet.icon || '',
    });

    // Persist for auto-reconnect
    try {
      localStorage.setItem('ski:last-wallet', wallet.name);
      localStorage.setItem('ski:last-address', account.address);
    } catch { /* storage unavailable */ }

    return account;
  } catch (err) {
    setState({
      status: 'disconnected',
      wallet: null,
      account: null,
      address: '',
      walletName: '',
      walletIcon: '',
    });
    throw err;
  }
}

// ─── Disconnect ──────────────────────────────────────────────────────

export async function disconnect(): Promise<void> {
  const { wallet } = currentState;

  if (wallet && 'standard:disconnect' in wallet.features) {
    const disconnectFeature = wallet.features['standard:disconnect'] as {
      disconnect: () => Promise<void>;
    };
    try {
      await disconnectFeature.disconnect();
    } catch { /* some wallets don't support disconnect cleanly */ }
  }

  if (walletChangeUnsub) {
    walletChangeUnsub();
    walletChangeUnsub = null;
  }

  try {
    localStorage.removeItem('ski:last-wallet');
    localStorage.removeItem('ski:last-address');
  } catch { /* */ }

  setState({
    status: 'disconnected',
    wallet: null,
    account: null,
    address: '',
    walletName: '',
    walletIcon: '',
  });
}

// ─── Sign Personal Message ───────────────────────────────────────────

export async function signPersonalMessage(message: Uint8Array): Promise<{
  bytes: string;
  signature: string;
}> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  if (!('sui:signPersonalMessage' in wallet.features)) {
    throw new Error(`${wallet.name} does not support personal message signing`);
  }

  const signFeature = wallet.features['sui:signPersonalMessage'] as {
    signPersonalMessage: (input: {
      message: Uint8Array;
      account: WalletAccount;
    }) => Promise<{ bytes: string; signature: string }>;
  };

  return signFeature.signPersonalMessage({ message, account });
}

// ─── Auto-Reconnect ──────────────────────────────────────────────────

export async function autoReconnect(): Promise<boolean> {
  let savedWallet: string;
  try {
    savedWallet = localStorage.getItem('ski:last-wallet') || '';
  } catch {
    return false;
  }
  if (!savedWallet) return false;

  const wallets = getSuiWallets();
  const match = wallets.find((w) => w.name === savedWallet);
  if (!match) return false;

  try {
    await connect(match);
    return true;
  } catch {
    return false;
  }
}
