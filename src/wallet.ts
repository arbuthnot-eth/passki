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

export async function connect(wallet: Wallet, opts?: { skipSilent?: boolean }): Promise<WalletAccount> {
  setState({ status: 'connecting' });

  try {
    const connectFeature = wallet.features['standard:connect'] as {
      connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
    };

    // Try silent first (already authorized) — unless caller explicitly requests UI
    let accounts: readonly WalletAccount[] = [];
    if (!opts?.skipSilent) {
      ({ accounts } = await connectFeature.connect({ silent: true }));
    }

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

// ─── Backpack + Uint8Array helpers ────────────────────────────────────

/**
 * Backpack routes signing through dapp-kit-core's internal keyring.
 * A silent reconnect primes the correct chain context; if the keyring
 * is locked a non-silent connect surfaces Backpack's unlock popup.
 */
async function withBackpackRetry<T>(fn: () => Promise<T>): Promise<T> {
  const { wallet } = currentState;
  if (!wallet || !/backpack/i.test(wallet.name)) return fn();
  const uiWallet = dappKit.stores.$wallets.get().find((w) => w.name === wallet.name);
  if (!uiWallet) return fn();

  await dappKit.connectWallet({ wallet: uiWallet, silent: true } as Parameters<typeof dappKit.connectWallet>[0]);
  try {
    return await fn();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : '';
    if (errMsg.includes('UserKeyring not found')) {
      try {
        await dappKit.connectWallet({ wallet: uiWallet } as Parameters<typeof dappKit.connectWallet>[0]);
      } catch { /* user cancelled */ }
      return fn();
    }
    throw e;
  }
}

/** Augment Uint8Array with serialize/toJSON so Phantom/WaaP accept it as a tx arg. */
function augmentBytes(transaction: unknown): unknown {
  if (!(transaction instanceof Uint8Array)) return transaction;
  let b64 = '';
  for (let i = 0; i < transaction.length; i++) b64 += String.fromCharCode(transaction[i]);
  b64 = btoa(b64);
  const aug = transaction as Uint8Array & { serialize?: () => string; toJSON?: () => string };
  aug.serialize = () => b64;
  aug.toJSON = () => b64;
  return aug;
}

// ─── Sign Personal Message ───────────────────────────────────────────

export async function signPersonalMessage(message: Uint8Array): Promise<{
  bytes: string;
  signature: string;
}> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  return withBackpackRetry(() => {
    if (/backpack/i.test(wallet.name)) return dappKit.signPersonalMessage({ message });
    if (!('sui:signPersonalMessage' in wallet.features)) {
      throw new Error(`${wallet.name} does not support personal message signing`);
    }
    const feat = wallet.features['sui:signPersonalMessage'] as {
      signPersonalMessage: (input: { message: Uint8Array; account: WalletAccount }) => Promise<{ bytes: string; signature: string }>;
    };
    return feat.signPersonalMessage({ message, account });
  });
}

// ─── Signature padding ──────────────────────────────────────────────

/**
 * Fix under-padded secp256k1/secp256r1 signatures from WaaP.
 *
 * Sui signature: flag(1) + r(32) + s(32) + pubkey(33) = 98 bytes.
 * WaaP occasionally produces 97-byte sigs when r or s is only 31 bytes
 * (leading zero stripped). We detect which component is short and zero-pad it.
 *
 * Heuristic: try padding r first (prepend 0x00 before r). If the resulting
 * s would start with a byte > 0x7F that's unlikely for a valid s value of
 * a 256-bit curve, swap and pad s instead. In practice both r and s are
 * uniformly random so either pad position produces a valid-length sig —
 * the RPC will reject if we guessed wrong, so we just try r-pad (most common).
 */
function _padSecp256k1Sig(sig: string): string {
  const raw = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
  // secp256k1 flag=0x01, secp256r1 flag=0x02 — both have 33-byte compressed pubkey
  if (raw.length !== 97 || (raw[0] !== 0x01 && raw[0] !== 0x02)) return sig;
  // raw layout: [flag(1)] [raw_sig(63)] [pubkey(33)]
  const flag = raw[0];
  const rawSig = raw.subarray(1, 64);   // 63 bytes
  const pubkey = raw.subarray(64);       // 33 bytes

  // Pad r (most common): r becomes 32 bytes, s stays 31→ no, total must be 64
  // If raw_sig is 63 bytes = r(31) + s(32) → pad r
  const fixed = new Uint8Array(98);
  fixed[0] = flag;
  // fixed[1] = 0x00 (pad byte for r, already zero)
  fixed.set(rawSig, 2);    // 63 bytes at offset 2 → fills [2..64]
  fixed.set(pubkey, 65);   // 33 bytes at offset 65 → fills [65..97]

  let b64 = '';
  for (let i = 0; i < fixed.length; i++) b64 += String.fromCharCode(fixed[i]);
  return btoa(b64);
}

// ─── Execute signed tx via gRPC → JSON-RPC fallback ─────────────────

const GRPC_URL = 'https://fullnode.mainnet.sui.io:443';

async function _executeSignedTx(bytesB64: string, signature: string): Promise<{ digest: string; effects?: unknown }> {
  // Attempt 1: gRPC
  try {
    const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });
    const txBytes = Uint8Array.from(atob(bytesB64), c => c.charCodeAt(0));
    const result = await grpc.executeTransaction({ transaction: txBytes, signatures: [signature] }) as Record<string, unknown>;
    const digest = (result.digest as string) ?? '';
    if (!digest) throw new Error('gRPC: no digest');
    return { digest, effects: result.effects };
  } catch { /* fall through to JSON-RPC */ }

  // Attempt 2: JSON-RPC across multiple endpoints
  const rpcUrls = [
    'https://fullnode.mainnet.sui.io:443',
    'https://sui-rpc.publicnode.com',
    'https://sui-mainnet-endpoint.blockvision.org',
  ];
  let lastErr: unknown;
  for (const url of rpcUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sui_executeTransactionBlock',
          params: [bytesB64, [signature], { showEffects: true }, 'WaitForLocalExecution'],
        }),
      });
      const json = await res.json() as { result?: { digest?: string; effects?: Record<string, unknown> }; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? 'RPC error');
      const effects = json.result?.effects;
      const status = effects?.status as { status?: string; error?: string } | undefined;
      if (status?.status === 'failure') throw new Error(status.error || 'Transaction failed on-chain');
      return { digest: json.result?.digest ?? '', effects };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
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

  return withBackpackRetry(async () => {
    if (/backpack/i.test(wallet.name)) {
      const r = await dappKit.signAndExecuteTransaction({ transaction } as Parameters<typeof dappKit.signAndExecuteTransaction>[0]);
      return normalizeTxResult(r);
    }

    // WaaP: signAndExecuteTransaction with augmented bytes.
    // WaaP's signTransaction produces invalid signatures (iframe re-serialization bug
    // in waap-sdk 1.2.2), so we rely on signAndExecuteTransaction and validate the result.
    if (/waap/i.test(wallet.name)) {
      const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';

      if ('sui:signAndExecuteTransaction' in wallet.features) {
        const execFeat = wallet.features['sui:signAndExecuteTransaction'] as {
          signAndExecuteTransaction: (input: { transaction: unknown; account: WalletAccount; chain: string; options?: { showEffects?: boolean } }) => Promise<{ digest: string; effects?: unknown }>;
        };
        const r = await execFeat.signAndExecuteTransaction({
          transaction: augmentBytes(transaction), account, chain, options: { showEffects: true },
        });
        if (r.digest) return r;
      }

      throw new Error('WaaP cannot execute this transaction. Use Phantom or another wallet to set primary name.');
    }

    if (!('sui:signAndExecuteTransaction' in wallet.features)) {
      throw new Error(`${wallet.name} does not support signAndExecuteTransaction`);
    }
    const feat = wallet.features['sui:signAndExecuteTransaction'] as {
      signAndExecuteTransaction: (input: { transaction: unknown; account: WalletAccount; chain: string; options?: { showEffects?: boolean } }) => Promise<{ digest: string; effects?: unknown }>;
    };
    const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';
    return feat.signAndExecuteTransaction({ transaction: augmentBytes(transaction), account, chain, options: { showEffects: true } });
  });
}

/**
 * Sign a transaction WITHOUT executing — returns raw bytes + signature.
 * Useful when we want to execute via our own transport (bypasses WaaP server-side execution bugs).
 */
export async function signTransaction(transaction: unknown): Promise<{ bytes: string; signature: string }> {
  const { wallet, account } = currentState;
  if (!wallet || !account) throw new Error('No wallet connected');

  return withBackpackRetry(async () => {
    if (/backpack/i.test(wallet.name)) {
      return dappKit.signTransaction({ transaction } as Parameters<typeof dappKit.signTransaction>[0]);
    }
    if (!('sui:signTransaction' in wallet.features)) {
      throw new Error(`${wallet.name} does not support signTransaction`);
    }
    const feat = wallet.features['sui:signTransaction'] as {
      signTransaction: (input: { transaction: unknown; account: WalletAccount; chain: string }) => Promise<{ bytes: string; signature: string }>;
    };
    const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';
    return feat.signTransaction({ transaction: augmentBytes(transaction), account, chain });
  });
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
