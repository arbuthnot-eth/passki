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
import { grpcUrl, raceExecuteTransaction } from './rpc.js';

// ─── DApp Kit (chain-aware signing for Backpack + hardware wallets) ───

const dappKit = createDAppKit({
  networks: ['sui:mainnet' as const],
  createClient: () => new SuiGrpcClient({ network: 'mainnet', baseUrl: grpcUrl }),
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

// Static WaaP placeholder so the modal roster always shows WaaP rows
// even before the real SDK finishes loading.  Once the real WaaP wallet
// registers, getSuiWallets() returns the real one instead.
const WAAP_PLACEHOLDER_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNjM2NmYxIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjYTg1NWY3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIGZpbGw9InVybCgjZykiIHJ4PSIyNCIvPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0LDE0KSBzY2FsZSgxKSI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik02Mi4xOCAwQzY3LjYzIDAgNzEuNjUgMy4xIDc0LjQ4IDcuMDljMi41OCAzLjY0IDQuMzcgOC4yNiA1LjY0IDEyLjc3IDQuNTEgMS4yNiA5LjEzIDMuMDQgMTIuNzcgNS42MiAzLjk5IDIuODMgNy4xIDYuODUgNy4xIDEyLjMgMCA1LjAyLTIuNTUgOS4wNy02Ljg4IDEyLjIgNC4zMyAzLjEzIDYuODggNy4xOCA2Ljg5IDEyLjIgMCA1LjQ1LTMuMSA5LjQ3LTcuMDkgMTIuMy0zLjY0IDIuNTgtOC4yNiA0LjM3LTEyLjc3IDUuNjQtMS4yNiA0LjUyLTMuMDQgOS4xNC01LjYyIDEyLjc4LTIuODMgMy45OS02Ljg1IDcuMS0xMi4zIDcuMS01LjAyIDAtOS4wNy0yLjU1LTEyLjItNi44OC0zLjEzIDQuMzMtNy4xOCA2Ljg4LTEyLjIgNi44OS01LjQ1IDAtOS40Ny0zLjEtMTIuMy03LjA5LTIuNTgtMy42NC00LjM3LTguMjYtNS42NC0xMi43Ny00LjUxLTEuMjYtOS4xMy0zLjA1LTEyLjc3LTUuNjJDMy4xMiA3MS42OSAwIDY3LjY3IDAgNjIuMjJjMC01LjAyIDIuNTUtOS4wNyA2Ljg5LTEyLjJDMi41NiA0Ni44OSAwIDQyLjg0IDAgMzcuODIgMCAzMi4zNyAzLjEgMjguMzUgNy4wOSAyNS41MmMzLjY0LTIuNTggOC4yNi00LjM3IDEyLjc3LTUuNjQgMS4yNi00LjUyIDMuMDQtOS4xNCA1LjYyLTEyLjc4QzI4LjMxIDMuMTEgMzIuMzMgMC4wMSAzNy43OCAwLjAxYzUuMDIgMCA5LjA3IDIuNTUgMTIuMiA2Ljg4QzUzLjExIDIuNTYgNTcuMTYgMCA2Mi4xOCAwem0wIDUuNjJjLTMuMjcgMC02LjMyIDEuODQtOS4wMyA2Ljc2LTEuMzcgMi40OC00Ljk1IDIuNDgtNi4zMiAwLTIuNzItNC45Mi01Ljc4LTYuNzYtOS4wNC02Ljc2LTMuMDEgMC01LjUyIDEuNjMtNy43MiA0LjczLTIuMjMgMy4xNC0zLjg5IDcuNS01LjA0IDEyLjEtLjMzIDEuMjUtMS4zIDIuMjItMi41NCAyLjU1LTQuNiAxLjIxLTguOTUgMi44Ny0xMi4xIDUuMUM3LjI0IDMyLjMgNS42MiAzNC44MSA1LjYyIDM3LjgyYzAgMy4yNyAxLjg0IDYuMzIgNi43NiA5LjA0IDIuNDggMS4zNyAyLjQ4IDQuOTUgMCA2LjMyLTQuOTIgMi43Mi02Ljc2IDUuNzgtNi43NiA5LjA0IDAgMy4wMSAxLjYzIDUuNTIgNC43MyA3LjcyIDMuMTQgMi4yMyA3LjUgMy44OSAxMi4xIDUuMDggMS4xNy4zIDIuMSAxLjE4IDIuNDggMi4zMWwuMDcuMjMuMjMuODZjMS4xOSA0LjI4IDIuNzggOC4yOSA0Ljg3IDExLjI0IDIuMiAzLjEgNC43MSA0LjcyIDcuNzIgNC43MiAzLjI3IDAgNi4zMi0xLjg0IDkuMDQtNi43N2wuMTMtLjIyYzEuNDEtMi4xOCA0LjY0LTIuMTggNi4wNSAwbC4xMy4yMi4yNi40NWMyLjY1IDQuNTggNS42MiA2LjMxIDguNzggNi4zMSAzLjAxIDAgNS41Mi0xLjYzIDcuNzItNC43MiAyLjIzLTMuMTQgMy44OS03LjUgNS4wOC0xMi4xLjMzLTEuMjUgMS4zLTIuMjIgMi41NC0yLjU1IDQuNi0xLjIxIDguOTUtMi44NyAxMi4xLTUuMSAzLjEtMi4yIDQuNzItNC43MSA0LjcyLTcuNzIgMC0zLjI3LTEuODQtNi4zMi02Ljc3LTkuMDQtMi40OC0xLjM3LTIuNDgtNC45NSAwLTYuMzJsLjQ1LS4yNmM0LjU4LTIuNjUgNi4zMS01LjYyIDYuMzEtOC43OCAwLTMuMDEtMS42My01LjUyLTQuNzMtNy43Mi0zLjE0LTIuMjMtNy41LTMuODktMTIuMS01LjA0LTEuMjUtLjMyLTIuMjItMS4zLTIuNTQtMi41NC0xLjIxLTQuNi0yLjg3LTguOTUtNS4xLTEyLjEtMi4yLTMuMS00LjcxLTQuNzItNy43Mi00LjcyeiIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNNjIuNjcgNjMuMTVjLjk1LTEuMjMgMi43MS0xLjQ2IDMuOTQtLjUxIDEuMjMuOTUgMS40NiAyLjcxLjUxIDMuOTQtMy4xOSA0LjE1LTguOTggNi45Ni0xNS4xNSA3LjQ4LTYuMjcuNTMtMTMuMjYtMS4yNy0xOC44NS02Ljc5LTEuMS0xLjA5LTEuMTEtMi44Ny0uMDItMy45NyAxLjA5LTEuMSAyLjg3LTEuMTEgMy45Ny0uMDIgNC4yNyA0LjIxIDkuNTcgNS42IDE0LjQzIDUuMTkgNC45Ni0uNDIgOS4xNC0yLjY3IDExLjE3LTUuMzJ6IiBmaWxsPSJ3aGl0ZSIvPjxwYXRoIGQ9Ik0zOS42NiAzMC44NGMxLjQ0IDAgMi41NS43MyAzLjI4IDEuNDguNzIuNzQgMS4yNCAxLjY3IDEuNjIgMi41OS43NiAxLjg1IDEuMTcgNC4yMSAxLjE3IDYuNjcgMCAyLjQ2LS40IDQuODMtMS4xNiA2LjY4LS4zOC45Mi0uOSAxLjg1LTEuNjIgMi41OS0uNzMuNzUtMS44NCAxLjQ4LTMuMjggMS40OC0xLjQ0IDAtMi41NS0uNzItMy4yOC0xLjQ3LS43Mi0uNzQtMS4yNC0xLjY3LTEuNjItMi41OS0uNzYtMS44NS0xLjE3LTQuMjEtMS4xNy02LjY3IDAtMi40Ni40LTQuODMgMS4xNi02LjY4LjM4LS45Mi45LTEuODUgMS42Mi0yLjU5LjczLS43NSAxLjg0LTEuNDggMy4yOC0xLjQ4eiIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNNjAuMzMgMzAuODRsLjI3LjAxYzEuMzEuMDggMi4zMy43NiAzLjAxIDEuNDcuNzIuNzQgMS4yNCAxLjY3IDEuNjIgMi41OS43NiAxLjg1IDEuMTcgNC4yMSAxLjE3IDYuNjcgMCAyLjQ2LS40IDQuODMtMS4xNiA2LjY4LS4zOC45Mi0uOSAxLjg1LTEuNjIgMi41OS0uNzMuNzUtMS44NCAxLjQ4LTMuMjggMS40OC0xLjQ0IDAtMi41NS0uNzItMy4yOC0xLjQ3LS43Mi0uNzQtMS4yNC0xLjY3LTEuNjItMi41OS0uNzYtMS44NS0xLjE3LTQuMjEtMS4xNy02LjY3IDAtMi40Ni40LTQuODMgMS4xNi02LjY4LjM4LS45Mi45LTEuODUgMS42Mi0yLjU5LjczLS43NSAxLjg0LTEuNDggMy4yOC0xLjQ4eiIgZmlsbD0id2hpdGUiLz48L2c+PC9zdmc+Cg==';
const waapPlaceholder: Wallet = {
  name: 'WaaP',
  version: '1.0.0' as const,
  icon: WAAP_PLACEHOLDER_ICON as `data:image/svg+xml;base64,${string}`,
  chains: ['sui:mainnet' as const],
  accounts: [],
  features: {
    'standard:connect': {
      version: '1.0.0',
      async connect() {
        // Placeholder — the real WaaP SDK will replace this once loaded.
        // Trigger lazy load so the next click will hit the real wallet.
        import('./waap.js').then(({ registerWaaP }) => registerWaaP()).catch(() => {});
        return { accounts: [] };
      },
    },
  },
};

/** Get all Sui-compatible wallets currently registered */
export function getSuiWallets(): Wallet[] {
  const real = walletsApi.get().filter((w) => {
    const hasSuiChain = w.chains.some((c) => c.startsWith('sui:'));
    const hasConnect = 'standard:connect' in w.features;
    return hasSuiChain && hasConnect;
  });
  // Include static WaaP placeholder if the real WaaP SDK hasn't registered yet
  if (!real.some(w => /waap/i.test(w.name))) {
    real.push(waapPlaceholder);
  }
  return real;
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

async function _executeSignedTx(bytesB64: string, signature: string): Promise<{ digest: string; effects?: unknown }> {
  const txBytes = Uint8Array.from(atob(bytesB64), c => c.charCodeAt(0));
  return raceExecuteTransaction(txBytes, [signature]);
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

    // WaaP: use direct wallet features for signAndExecuteTransaction.
    // WaaP's signTransaction produces invalid signatures (iframe re-serialization bug),
    // so we must use signAndExecuteTransaction which executes server-side.
    // WaaP: signAndExecuteTransaction with augmented bytes.
    if (/waap/i.test(wallet.name)) {
      const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';

      if ('sui:signAndExecuteTransaction' in wallet.features) {
        const execFeat = wallet.features['sui:signAndExecuteTransaction'] as {
          signAndExecuteTransaction: (input: { transaction: unknown; account: WalletAccount; chain: string; options?: { showEffects?: boolean } }) => Promise<{ digest: string; effects?: unknown }>;
        };
        const r = await execFeat.signAndExecuteTransaction({
          transaction: augmentBytes(transaction), account, chain, options: { showEffects: true },
        });
        // WaaP may return empty digest even on success — treat as success
        return { digest: r.digest || '', effects: r.effects };
      }

      throw new Error('WaaP transaction failed');
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

  // If we got the WaaP placeholder (no standard:events), wait for real SDK to register
  if (/waap/i.test(match.name) && !('standard:events' in match.features)) {
    const real = await new Promise<Wallet | undefined>((resolve) => {
      const unsub = walletsApi.on('register', () => {
        const found = walletsApi.get().find(
          (w) => /waap/i.test(w.name) && 'standard:events' in w.features,
        );
        if (found) { unsub(); clearTimeout(t); resolve(found); }
      });
      const t = setTimeout(() => { unsub(); resolve(undefined); }, 5000);
    });
    if (!real) return false;
    match = real;
  }

  // For WaaP: restore OAuth snapshot so silent connect can find the session
  if (/waap/i.test(match.name)) {
    try {
      const [{ getDeviceId }, { getWaapProof, restoreWaapOAuth }] = await Promise.all([
        import('./fingerprint.js') as Promise<{ getDeviceId: () => Promise<{ visitorId: string }> }>,
        import('./waap-proof.js') as Promise<{ getWaapProof: (id: string) => Promise<{ oauthSnapshot?: Record<string, string> } | null>; restoreWaapOAuth: (snap: Record<string, string>) => void }>,
      ]);
      const { visitorId } = await getDeviceId();
      const proof = await getWaapProof(visitorId);
      if (proof?.oauthSnapshot) restoreWaapOAuth(proof.oauthSnapshot);
    } catch { /* non-fatal — proceed without snapshot */ }
  }

  try {
    await connect(match);
    return true;
  } catch {
    return false;
  }
}
