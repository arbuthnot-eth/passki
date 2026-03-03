/**
 * .SKI Wallet — Built from first principles on the Sui Wallet Standard.
 * Reference: https://docs.sui.io/standards/wallet-standard
 *
 * Uses @wallet-standard/app for wallet discovery and the standard
 * features API for connect/disconnect/sign operations.
 */

import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// ─── DApp Kit (chain-aware signing for Backpack + hardware wallets) ───

const dappKit = createDAppKit({
  networks: ['sui:mainnet' as const],
  createClient: () => new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' }),
  autoConnect: false,
  slushWalletConfig: null,
  enableBurnerWallet: false,
});

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
      // Request user authorization — race connect() against the wallet's own
      // change event so OAuth-redirect flows (e.g. WaaP + X) that resolve
      // connect() with empty accounts but later fire change with real accounts
      // still complete successfully.  Times out after 5 minutes so the UI can
      // never get permanently stuck.
      accounts = await new Promise<readonly WalletAccount[]>((resolve, reject) => {
        let settled = false;
        let changeUnsub: (() => void) | null = null;

        const done = (accs: readonly WalletAccount[]) => {
          if (settled) return;
          settled = true;
          if (changeUnsub) { changeUnsub(); changeUnsub = null; }
          resolve(accs);
        };
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          if (changeUnsub) { changeUnsub(); changeUnsub = null; }
          reject(err);
        };

        // Watch for accounts via change event (async OAuth flows)
        if ('standard:events' in wallet.features) {
          const eventsFeature = wallet.features['standard:events'] as {
            on: (event: 'change', listener: (e: { accounts?: readonly WalletAccount[] }) => void) => () => void;
          };
          changeUnsub = eventsFeature.on('change', (event) => {
            if (event.accounts && event.accounts.length > 0) done(event.accounts);
          });
        }

        connectFeature.connect()
          .then(({ accounts: a }) => { if (a.length > 0) done(a); })
          .catch(fail);

        // 5-minute safety timeout — prevents permanent overlay lock
        setTimeout(() => fail(new Error('No accounts authorized')), 5 * 60 * 1000);
      });
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

    // Persist for auto-reconnect and instant preload
    try {
      localStorage.setItem('ski:last-wallet', wallet.name);
      localStorage.setItem('ski:last-address', account.address);
      if (wallet.icon) localStorage.setItem(`ski:wallet-icon:${wallet.name}`, wallet.icon);
    } catch { /* storage unavailable */ }

    return account;
  } catch (err) {
    // Tell the wallet to clean up its own UI (closes WaaP Lit overlay etc.)
    if ('standard:disconnect' in wallet.features) {
      try {
        (wallet.features['standard:disconnect'] as { disconnect: () => Promise<void> })
          .disconnect().catch(() => {});
      } catch { /* best effort */ }
    }
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

  // Remove last-wallet so autoReconnect won't fire after an intentional disconnect.
  // Keep last-address (display data) so it survives through disconnect.
  try { localStorage.removeItem('ski:last-wallet'); } catch { /* */ }

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

  // Backpack routes signing through its own internal keyring which requires a
  // chain identifier to resolve the correct entry.  dapp-kit-core calls
  // getAccountFeature({ account, chain }) which passes `chain` through to the
  // wallet feature — the missing chain is what causes "UserKeyring not found".
  if (/backpack/i.test(wallet.name)) {
    const uiWallet = dappKit.stores.$wallets.get().find((w) => w.name === wallet.name);
    if (uiWallet) {
      // silent:true re-acknowledges the already-connected wallet without any UI prompt
      await dappKit.connectWallet({ wallet: uiWallet, silent: true } as Parameters<typeof dappKit.connectWallet>[0]);
      try {
        return await dappKit.signPersonalMessage({ message });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : '';
        if (errMsg.includes('UserKeyring not found')) {
          // Backpack's keyring is locked. A non-silent Wallet Standard connect
          // targets the Sui context directly and should surface the Backpack
          // popup (unlock screen if locked, account picker otherwise).
          try {
            await dappKit.connectWallet({ wallet: uiWallet } as Parameters<typeof dappKit.connectWallet>[0]);
          } catch { /* user cancelled — sign retry will surface the error */ }
          return dappKit.signPersonalMessage({ message });
        }
        throw e;
      }
    }
  }

  // All other wallets: direct Wallet Standard feature call
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

// ─── Sign Transaction (without executing) ────────────────────────────

/**
 * Sign a transaction with the connected wallet but do NOT execute it.
 * Returns the base64 BCS bytes and the serialized signature.
 * Used by the sponsored-transaction flow where both wallets sign
 * the same bytes and the caller submits with both signatures.
 */
export async function signTransactionOnly(transaction: unknown): Promise<{
  bytes: string;
  signature: string;
}> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  if (!('sui:signTransaction' in wallet.features)) {
    throw new Error(`${wallet.name} does not support sui:signTransaction`);
  }

  const signFeat = wallet.features['sui:signTransaction'] as {
    signTransaction: (input: {
      transaction: unknown;
      account: WalletAccount;
      chain: string;
    }) => Promise<{ bytes: string; signature: string }>;
  };

  const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';
  return signFeat.signTransaction({ transaction, account, chain });
}

// ─── Sign & Execute Transaction ──────────────────────────────────────

// dapp-kit-core returns a discriminated union { $kind, Transaction } — normalise to a flat result.
function normalizeTxResult(r: unknown): { digest: string; effects?: unknown } {
  const obj = r as Record<string, unknown>;
  // Nested gRPC-style response
  if (obj.$kind === 'Transaction' && obj.Transaction) {
    const tx = obj.Transaction as Record<string, unknown>;
    return { digest: tx.digest as string, effects: tx.effects };
  }
  // Flat Wallet Standard response
  return { digest: obj.digest as string, effects: obj.effects };
}

export async function signAndExecuteTransaction(transaction: unknown): Promise<{
  digest: string;
  effects?: unknown;
}> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  // Backpack routes through its internal keyring — same workaround as signPersonalMessage
  if (/backpack/i.test(wallet.name)) {
    const uiWallet = dappKit.stores.$wallets.get().find((w) => w.name === wallet.name);
    if (uiWallet) {
      await dappKit.connectWallet({ wallet: uiWallet, silent: true } as Parameters<typeof dappKit.connectWallet>[0]);
      try {
        const r = await dappKit.signAndExecuteTransaction({ transaction } as Parameters<typeof dappKit.signAndExecuteTransaction>[0]);
        return normalizeTxResult(r);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : '';
        if (errMsg.includes('UserKeyring not found')) {
          try {
            await dappKit.connectWallet({ wallet: uiWallet } as Parameters<typeof dappKit.connectWallet>[0]);
          } catch { /* user cancelled */ }
          const r = await dappKit.signAndExecuteTransaction({ transaction } as Parameters<typeof dappKit.signAndExecuteTransaction>[0]);
          return normalizeTxResult(r);
        }
        throw e;
      }
    }
  }

  if (!('sui:signAndExecuteTransaction' in wallet.features)) {
    throw new Error(`${wallet.name} does not support signAndExecuteTransaction`);
  }

  const feature = wallet.features['sui:signAndExecuteTransaction'] as {
    signAndExecuteTransaction: (input: {
      transaction: unknown;
      account: WalletAccount;
      chain: string;
      options?: { showEffects?: boolean };
    }) => Promise<{ digest: string; effects?: unknown }>;
  };

  const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';

  // Wallets like Phantom check for serialize()/toJSON() on the transaction and
  // throw if not found. If we have pre-built bytes (Uint8Array), augment the
  // instance with those methods. The object remains instanceof Uint8Array so
  // WaaP's internal short-circuit (which checks instanceof first) still fires.
  let txArg: unknown = transaction;
  if (transaction instanceof Uint8Array) {
    let b64 = '';
    for (let i = 0; i < transaction.length; i++) b64 += String.fromCharCode(transaction[i]);
    b64 = btoa(b64);
    const aug = transaction as Uint8Array & { serialize?: () => string; toJSON?: () => string };
    aug.serialize = () => b64;
    aug.toJSON = () => b64;
    txArg = aug;
  }

  return feature.signAndExecuteTransaction({
    transaction: txArg,
    account,
    chain,
    options: { showEffects: true },
  });
}

/**
 * Sign a transaction WITHOUT executing — returns raw bytes + signature.
 * Useful when we want to execute via our own transport (bypasses WaaP server-side execution bugs).
 */
export async function signTransaction(transaction: unknown): Promise<{ bytes: string; signature: string }> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  if (!('sui:signTransaction' in wallet.features)) {
    throw new Error(`${wallet.name} does not support signTransaction`);
  }

  const feature = wallet.features['sui:signTransaction'] as {
    signTransaction: (input: {
      transaction: unknown;
      account: WalletAccount;
      chain: string;
    }) => Promise<{ bytes: string; signature: string }>;
  };

  const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';

  let txArg: unknown = transaction;
  if (transaction instanceof Uint8Array) {
    let b64 = '';
    for (let i = 0; i < transaction.length; i++) b64 += String.fromCharCode(transaction[i]);
    b64 = btoa(b64);
    const aug = transaction as Uint8Array & { serialize?: () => string; toJSON?: () => string };
    aug.serialize = () => b64;
    aug.toJSON = () => b64;
    txArg = aug;
  }

  return feature.signTransaction({ transaction: txArg, account, chain });
}

// ─── Deactivate (soft — keeps wallet OAuth session alive) ────────────

/**
 * Clear SKI's active-wallet state WITHOUT calling the wallet's
 * standard:disconnect feature.  Use this when switching AWAY from a wallet
 * you want to keep dormant (e.g. WaaP), so its OAuth session stays intact and
 * re-activation via activateAccount() can skip the OAuth modal entirely.
 *
 * Use the regular disconnect() only for explicit user-initiated sign-out.
 */
export function deactivate(): void {
  if (walletChangeUnsub) { walletChangeUnsub(); walletChangeUnsub = null; }
  // Keep last-wallet so autoReconnect can restore on reload
  setState({
    status: 'disconnected',
    wallet: null,
    account: null,
    address: '',
    walletName: '',
    walletIcon: '',
  });
}

// ─── Activate from cache (no connect() call) ─────────────────────────

/**
 * Directly activate a wallet account that is already known (e.g. from a
 * cached WaaP proof) without triggering the wallet's connect/OAuth flow.
 * Sets up the change-event listener and fires the normal state update so
 * the ski:wallet-connected event fires exactly as if connect() had succeeded.
 */
export function activateAccount(wallet: Wallet, account: WalletAccount): void {
  if (walletChangeUnsub) walletChangeUnsub();
  if ('standard:events' in wallet.features) {
    const eventsFeature = wallet.features['standard:events'] as {
      on: (event: 'change', listener: (e: { accounts: readonly WalletAccount[] }) => void) => () => void;
    };
    walletChangeUnsub = eventsFeature.on('change', (event) => {
      if (event.accounts && currentState.wallet === wallet) {
        const updated = event.accounts[0];
        if (updated) setState({ account: updated, address: updated.address });
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

  try {
    localStorage.setItem('ski:last-wallet', wallet.name);
    localStorage.setItem('ski:last-address', account.address);
    if (wallet.icon) localStorage.setItem(`ski:wallet-icon:${wallet.name}`, wallet.icon);
  } catch {}
}

// ─── Reconnect (open wallet popup) ───────────────────────────────────

/**
 * Trigger a non-silent wallet connect for the currently-connected wallet.
 * For Backpack this opens the unlock / password popup when the keyring is locked.
 */
export async function reconnectWallet(): Promise<void> {
  const { wallet } = currentState;
  if (!wallet || !('standard:connect' in wallet.features)) return;

  const connectFeature = wallet.features['standard:connect'] as {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
  };

  // No silent flag → wallet shows its UI (unlock screen / account picker)
  await connectFeature.connect();
}

// ─── Preload from storage (instant UI before autoReconnect) ──────────

/**
 * Synchronously pre-populate wallet state from localStorage so the first
 * render can show the connected UI without waiting for autoReconnect().
 * Does NOT notify subscribers — this is a silent pre-hydration only.
 * autoReconnect() will overwrite with the real wallet object when ready.
 */
export function preloadStoredWallet(): { address: string; walletName: string } | null {
  try {
    const walletName = localStorage.getItem('ski:last-wallet') || '';
    const address = localStorage.getItem('ski:last-address') || '';
    if (!walletName || !address) return null;
    const walletIcon = localStorage.getItem(`ski:wallet-icon:${walletName}`) || '';
    currentState = { ...currentState, status: 'connecting', address, walletName, walletIcon };
    return { address, walletName };
  } catch {
    return null;
  }
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

  // Check immediately first
  let match = getSuiWallets().find((w) => w.name === savedWallet);

  // If not found, wait for wallet extensions to register (they inject async)
  if (!match) {
    match = await new Promise<Wallet | undefined>((resolve) => {
      const unsub = walletsApi.on('register', () => {
        const found = getSuiWallets().find((w) => w.name === savedWallet);
        if (found) { unsub(); clearTimeout(timeout); resolve(found); }
      });
      // Give up after 3 seconds
      const timeout = setTimeout(() => { unsub(); resolve(undefined); }, 3000);
    });
  }

  if (!match) return false;

  try {
    await connect(match);
    return true;
  } catch {
    return false;
  }
}
