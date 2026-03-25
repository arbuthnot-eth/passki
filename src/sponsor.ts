/**
 * Gas Sponsorship — native Sui sponsored transactions, no Redis or backend.
 *
 * Flow:
 *   1. Sponsor connects their wallet and calls activateSponsor() →
 *      signs a personal message (proof of intent), persists auth to
 *      localStorage, holds the wallet reference in memory.
 *   2. Add beneficiaries (SuiNS names or raw addresses) to the sponsored list.
 *   3. For each sponsored transaction:
 *      a. Build kind bytes (transaction without gas data)
 *      b. Reconstruct as a full sponsored tx:
 *           sender  = user address
 *           gasOwner = sponsor address
 *           gasPayment = sponsor's SUI coins (fetched via GraphQL)
 *      c. Sponsor wallet signs first, then user wallet signs the same bytes
 *      d. Submit via gRPC with both signatures
 *   4. On page reload, restoreSponsor() silently reconnects the sponsor
 *      wallet using standard:connect { silent: true }.
 *
 * No server, no Redis — the sponsor's wallet is a browser extension that
 * stays registered in the wallet standard registry across page navigations.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuinsClient } from '@mysten/suins';
import { grpcClient, GQL_URL } from './rpc.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

// ─── Types ────────────────────────────────────────────────────────────

export interface SponsoredEntry {
  /** Resolved Sui address (0x…) */
  address: string;
  /** SuiNS name if added via name, e.g. "alice.sui" */
  suinsName?: string;
  /** ISO date — when this individual entry expires */
  expiresAt: string;
  /** ISO date — when this entry was added */
  addedAt: string;
}

export interface SponsorAuth {
  /** Sponsor's Sui address (pays the gas) */
  address: string;
  /** Wallet extension name (for silent reconnect on reload) */
  walletName: string;
  /** base64 personal-message signature — proof of sponsorship intent */
  authSig: string;
  /** base64 signed message bytes */
  authBytes: string;
  /** Plain-text auth message (used to register with SponsorAgent DO without re-signing) */
  authMessage?: string;
  /** ISO date — when the sponsorship authorization expires */
  expiresAt: string;
  /** When true, server-side keeper keypair handles gas signing (sponsor can close browser) */
  keeperMode?: boolean;
  /** Derived Sui address of the keeper keypair (gasOwner when keeper mode is active) */
  keeperAddress?: string;
  /**
   * List of sponsored beneficiaries.
   * Empty array = open sponsorship (any sender may use sponsored gas).
   * Non-empty = only addresses in the list with non-expired entries.
   */
  sponsoredList: SponsoredEntry[];
}

export interface SponsorState {
  auth: SponsorAuth | null;
  wallet: Wallet | null;
  account: WalletAccount | null;
}

type SponsorListener = (state: SponsorState) => void;

// ─── Persistence ──────────────────────────────────────────────────────

const STORAGE_KEY = 'ski:gas-sponsor';
const SPONSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ENTRY_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days default per entry

/** Migrate old format (sponsoredAddress?: string) → new (sponsoredList: SponsoredEntry[]) */
function migrateAuth(raw: Record<string, unknown>): SponsorAuth {
  const auth = raw as unknown as SponsorAuth & { sponsoredAddress?: string };
  if (!Array.isArray(auth.sponsoredList)) {
    auth.sponsoredList = auth.sponsoredAddress
      ? [{ address: auth.sponsoredAddress, expiresAt: auth.expiresAt, addedAt: auth.expiresAt }]
      : [];
    delete auth.sponsoredAddress;
  }
  return auth as SponsorAuth;
}

function loadAuth(): SponsorAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const auth = migrateAuth(parsed);
    if (new Date(auth.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return auth;
  } catch { return null; }
}

function saveAuth(auth: SponsorAuth): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(auth)); } catch {}
}

function clearStoredAuth(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ─── In-memory state ──────────────────────────────────────────────────

const listeners = new Set<SponsorListener>();
let _state: SponsorState = { auth: loadAuth(), wallet: null, account: null };

function setState(patch: Partial<SponsorState>): void {
  _state = { ..._state, ...patch };
  listeners.forEach((fn) => fn(_state));
  window.dispatchEvent(new CustomEvent('ski:sponsor-changed', { detail: _state }));
}

export function subscribeSponsor(fn: SponsorListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSponsorState(): SponsorState { return _state; }

export function isSponsorActive(): boolean {
  const { auth, wallet, account } = _state;
  return !!(auth && wallet && account && new Date(auth.expiresAt).getTime() > Date.now());
}

/**
 * Returns true if keeper-mode sponsorship is active — no browser wallet required.
 * The keeper keypair on the server handles the gas owner signature.
 */
export function isKeeperSponsorActive(): boolean {
  const { auth } = _state;
  return !!(auth && auth.keeperMode && auth.keeperAddress && new Date(auth.expiresAt).getTime() > Date.now());
}

/**
 * Enable keeper mode: calls the DO to activate server-side signing,
 * then updates localStorage auth with keeper state.
 */
export async function activateKeeperMode(): Promise<{ success: boolean; error?: string }> {
  if (!_state.auth) return { success: false, error: 'No active sponsorship' };

  try {
    const { enableKeeperMode: doEnable } = await import('./client/sponsor.js');
    const result = await doEnable();
    if (!result.success) return { success: false, error: result.error };

    const newAuth: SponsorAuth = {
      ..._state.auth,
      keeperMode: true,
      keeperAddress: result.keeperAddress,
    };
    saveAuth(newAuth);
    setState({ auth: newAuth });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to enable keeper mode' };
  }
}

/**
 * Disable keeper mode: reverts to browser-wallet sponsor signing.
 */
export async function deactivateKeeperMode(): Promise<void> {
  if (!_state.auth) return;

  try {
    const { disableKeeperMode: doDisable } = await import('./client/sponsor.js');
    await doDisable();
  } catch { /* best-effort */ }

  const newAuth: SponsorAuth = { ..._state.auth, keeperMode: false, keeperAddress: undefined };
  saveAuth(newAuth);
  setState({ auth: newAuth });
}

/** Active (non-expired) entries in the sponsored list. */
export function getActiveSponsoredList(): SponsoredEntry[] {
  const auth = _state.auth;
  if (!auth) return [];
  const now = Date.now();
  return auth.sponsoredList.filter((e) => new Date(e.expiresAt).getTime() > now);
}

/**
 * Returns true if the given address is eligible for sponsored gas:
 * - Sponsor is active AND
 * - Sponsored list is empty (open) OR the address is in the active list
 */
export function isSponsoredAddress(address: string): boolean {
  const active = isSponsorActive() || isKeeperSponsorActive();
  if (!active) return false;
  const list = getActiveSponsoredList();
  return list.length === 0 || list.some((e) => e.address === address);
}

// ─── Authorization message ────────────────────────────────────────────

/** A single account entry for the bulk-sign message listing. */
export interface AccountEntry {
  address: string;
  name?: string | null;
}

interface AuthMessageOpts {
  /** Primary SuiNS name of the sponsor (e.g. "atlas.sui"), if known */
  sponsorName?: string | null;
  /** Target/beneficiary address being sponsored, if known at activation time */
  targetAddress?: string | null;
  /** Primary SuiNS name of the target, if known */
  targetName?: string | null;
  /** Minted SuiNS subname for the target (used when target has no primary name) */
  targetSubname?: string | null;
  /**
   * All accounts to list in the message (bulk wallet-icon signing).
   * Diamonds (no name) are listed first as plain truncated addresses;
   * Blues (has name) follow as @name then truncated address.
   */
  allAccounts?: AccountEntry[];
}

function buildAuthMessage(
  sponsorAddress: string,
  expiresAt: string,
  nonce: string,
  opts: AuthMessageOpts = {},
): string {
  const TTL_DAYS = Math.round(SPONSOR_TTL_MS / 86_400_000); // 7

  const sponsorDisplay = opts.sponsorName ? opts.sponsorName.replace(/\.sui$/, '') : null;
  const titleLine = sponsorDisplay
    ? `.SKI ${TTL_DAYS}d Splash (0.05 \uD83D\uDCA7/tx) by: ${sponsorDisplay}`
    : `.SKI ${TTL_DAYS}d Splash (0.05 \uD83D\uDCA7/tx)`;
  const lines: string[] = [titleLine];

  if (opts.allAccounts && opts.allAccounts.length > 0) {
    // ── Bulk mode: diamonds (no name) first, then blues (@name + addr) ──
    const diamonds = opts.allAccounts.filter((a) => !a.name);
    const blues = opts.allAccounts.filter((a) => !!a.name);
    for (const a of diamonds) lines.push(truncAddr(a.address));
    for (const a of blues) {
      lines.push(`@${a.name!.replace(/\.sui$/, '')}`);
      lines.push(truncAddr(a.address));
    }
    // Separator + all full addresses
    lines.push('');
    lines.push('\u2500'.repeat(20));
    for (const a of opts.allAccounts) lines.push(a.address);
  } else {
    // ── Single-account mode (per-key button or Activate Splash) ──────
    lines.push(truncAddr(sponsorAddress));
    if (opts.targetAddress) {
      const targetHandle = (opts.targetName ?? opts.targetSubname)?.replace(/\.sui$/, '') ?? null;
      lines.push(targetHandle ? `@${targetHandle}` : '@ --');
      lines.push(truncAddr(opts.targetAddress));
    }
    // Separator + full hex addresses
    lines.push('');
    lines.push('\u2500'.repeat(20));
    lines.push(sponsorAddress);
    if (opts.targetAddress) lines.push(opts.targetAddress);
  }

  // ── Expiry / budget summary ───────────────────────────────────────
  lines.push('');
  lines.push(`${TTL_DAYS}d Splash (0.05 \uD83D\uDCA7/tx)`);
  lines.push(`Expires At: ${expiresAt}`);
  lines.push(`Nonce: ${nonce}`);

  return lines.join('\n');
}

// ─── Activate ─────────────────────────────────────────────────────────

/**
 * Prompt the given wallet to sign a sponsorship authorization message,
 * persist the auth to localStorage, and store the wallet reference in memory.
 * Any existing sponsored list is preserved when re-activating.
 *
 * @param targetAddr  Optional address being sponsored (pre-fills beneficiary in the message).
 */
export async function activateSponsor(
  wallet: Wallet,
  account: WalletAccount,
  targetAddr?: string,
  allAccounts?: AccountEntry[],
): Promise<SponsorAuth> {
  if (!('sui:signPersonalMessage' in wallet.features)) {
    throw new Error(`${wallet.name} does not support message signing`);
  }

  // Resolve display names concurrently (best-effort, 2s timeout each)
  const [sponsorName, targetName] = await Promise.all([
    resolveAddressToName(account.address),
    targetAddr ? resolveAddressToName(targetAddr) : Promise.resolve(null),
  ]);

  const expiresAt = new Date(Date.now() + SPONSOR_TTL_MS).toISOString();
  const nonce = crypto.randomUUID();
  const authMessageText = buildAuthMessage(account.address, expiresAt, nonce, {
    sponsorName,
    targetAddress: targetAddr ?? null,
    targetName,
    allAccounts,
  });
  const messageBytes = new TextEncoder().encode(authMessageText);

  const signFeat = wallet.features['sui:signPersonalMessage'] as {
    signPersonalMessage: (input: {
      message: Uint8Array;
      account: WalletAccount;
    }) => Promise<{ bytes: string; signature: string }>;
  };

  const { bytes: authBytes, signature: authSig } = await signFeat.signPersonalMessage({
    message: messageBytes,
    account,
  });

  // Preserve existing list when re-activating (e.g. after expiry)
  const existingList = _state.auth?.sponsoredList ?? [];

  const auth: SponsorAuth = {
    address: account.address,
    walletName: wallet.name,
    authSig,
    authBytes,
    authMessage: authMessageText,
    expiresAt,
    sponsoredList: existingList,
  };

  saveAuth(auth);
  setState({ auth, wallet, account });

  // Wire up cross-device DO sync in background (non-blocking, failure-tolerant)
  initSplashDO(wallet, account).catch(() => {});

  return auth;
}

// ─── Deactivate ───────────────────────────────────────────────────────

export function deactivateSponsor(): void {
  clearStoredAuth();
  setState({ auth: null, wallet: null, account: null });
}

// ─── Restore on page reload ───────────────────────────────────────────

/**
 * Silently reconnect the sponsor wallet after a page reload.
 * Uses standard:connect { silent: true } — no wallet UI shown.
 * Returns true if the sponsor was successfully restored.
 */
export async function restoreSponsor(registeredWallets: Wallet[]): Promise<boolean> {
  const auth = loadAuth();
  if (!auth) return false;

  const wallet = registeredWallets.find((w) => w.name === auth.walletName);
  if (!wallet || !('standard:connect' in wallet.features)) return false;

  const connectFeat = wallet.features['standard:connect'] as {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
  };

  try {
    const { accounts } = await connectFeat.connect({ silent: true });
    const account = accounts.find((a) => a.address === auth.address) ?? accounts[0];
    if (!account) return false;

    setState({ auth, wallet, account });
    return true;
  } catch { return false; }
}

// ─── SuiNS resolution ─────────────────────────────────────────────────

const _suinsClient = new SuinsClient({ client: grpcClient as never, network: 'mainnet' });

/** Truncate a Sui address for display: 0x3ca0...5222b */
function truncAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-5)}`;
}

/**
 * Reverse SuiNS lookup: address → primary name.
 * Checks localStorage cache first (populated by UI portfolio fetch), then
 * falls back to a GraphQL query with a 2-second timeout.
 */
async function resolveAddressToName(address: string): Promise<string | null> {
  try {
    const cached = localStorage.getItem(`ski:suins:${address}`);
    if (cached) return cached;
  } catch {}
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($a:SuiAddress!){ address(address:$a){ defaultNameRecord{domain} } }`,
        variables: { a: address },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json() as { data?: { address?: { defaultNameRecord?: { domain: string } | null } } };
    const name = json?.data?.address?.defaultNameRecord?.domain;
    if (name && typeof name === 'string') {
      try { localStorage.setItem(`ski:suins:${address}`, name); } catch {}
      return name;
    }
  } catch { /* timeout or network */ }
  return null;
}

/**
 * Resolve a SuiNS name to a Sui address via SuinsClient over gRPC.
 * Returns null if the name is not registered.
 * Throws a descriptive error on network/timeout failure.
 */
export async function resolveNameToAddress(name: string): Promise<string | null> {
  const n = name.endsWith('.sui') ? name : `${name}.sui`;
  try {
    const record = await _suinsClient.getNameRecord(n);
    return record?.targetAddress ?? null;
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes('does not exist') || msg.includes('not found')) return null;
      if (msg.includes('abort') || msg.includes('timeout')) {
        throw new Error(`SuiNS lookup timed out — check your connection and try again`);
      }
      throw new Error(`SuiNS lookup failed — ${msg}`);
    }
    throw new Error(`SuiNS lookup failed — network error`);
  }
}

/**
 * Given a raw input (SuiNS name or 0x address), resolve to a { address, suinsName? } pair.
 * Throws if the name cannot be resolved.
 */
export async function resolveEntry(
  input: string,
): Promise<{ address: string; suinsName?: string }> {
  const trimmed = input.trim();
  if (trimmed.startsWith('0x')) {
    return { address: trimmed };
  }
  const name = trimmed.endsWith('.sui') ? trimmed : `${trimmed}.sui`;
  const address = await resolveNameToAddress(name);
  if (!address) throw new Error(`"${name}" is not registered`);
  return { address, suinsName: name };
}

// ─── Sponsored list management ────────────────────────────────────────

/**
 * Add a beneficiary to the sponsored list by address or SuiNS name.
 * Duplicates (same address) are replaced with the new entry.
 *
 * @param input  Raw address (0x…) or SuiNS name ("alice.sui" or "alice")
 * @param ttlMs  How long this entry is valid (default: 7 days, capped by auth expiry)
 */
export async function addSponsoredEntry(
  input: string,
  ttlMs: number = ENTRY_TTL_MS,
): Promise<SponsoredEntry> {
  if (!_state.auth) throw new Error('No active sponsorship — activate first');

  const { address, suinsName } = await resolveEntry(input);
  const now = Date.now();
  // Entry cannot outlive the overall auth
  const cap = new Date(_state.auth.expiresAt).getTime();
  const expiresAt = new Date(Math.min(now + ttlMs, cap)).toISOString();

  // De-duplicate: remove any existing entry for this address
  const filtered = _state.auth.sponsoredList.filter((e) => e.address !== address);
  const entry: SponsoredEntry = {
    address,
    ...(suinsName ? { suinsName } : {}),
    expiresAt,
    addedAt: new Date(now).toISOString(),
  };

  const newAuth: SponsorAuth = { ..._state.auth, sponsoredList: [...filtered, entry] };
  saveAuth(newAuth);
  setState({ auth: newAuth });

  // Best-effort DO sync
  void import('./client/sponsor.js').then(({ addSplashTarget }) => addSplashTarget(address)).catch(() => {});

  return entry;
}

/**
 * Remove a single beneficiary from the sponsored list by address.
 */
export function removeSponsoredEntry(address: string): void {
  if (!_state.auth) return;
  const newAuth: SponsorAuth = {
    ..._state.auth,
    sponsoredList: _state.auth.sponsoredList.filter((e) => e.address !== address),
  };
  saveAuth(newAuth);
  setState({ auth: newAuth });

  // Best-effort DO sync
  void import('./client/sponsor.js').then(({ removeSplashTarget }) => removeSplashTarget(address)).catch(() => {});
}

// ─── Gas coin discovery (GraphQL) ────────────────────────────────────

type CoinRef = { objectId: string; version: string; digest: string };

async function fetchSponsorCoins(address: string): Promise<CoinRef[]> {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($a:SuiAddress!){
        address(address:$a){
          coins(type:"0x2::sui::SUI",first:3){
            nodes{ address version digest }
          }
        }
      }`,
      variables: { a: address },
    }),
  });
  const json = await res.json() as {
    data?: {
      address?: {
        coins?: {
          nodes?: Array<{ address: string; version: number; digest: string }>;
        };
      };
    };
  };
  const nodes = json?.data?.address?.coins?.nodes ?? [];
  if (!nodes.length) {
    throw new Error('Sponsor wallet has no SUI coins available for gas');
  }
  return nodes.map((c) => ({
    objectId: c.address,
    version: String(c.version),
    digest: c.digest,
  }));
}

// ─── Sign a transaction with a wallet (without executing) ─────────────

async function signTxWithWallet(
  wallet: Wallet,
  account: WalletAccount,
  transaction: Transaction,
): Promise<string> {
  if (!('sui:signTransaction' in wallet.features)) {
    throw new Error(`${wallet.name} does not support sui:signTransaction`);
  }

  const signFeat = wallet.features['sui:signTransaction'] as {
    signTransaction: (input: {
      transaction: Transaction;
      account: WalletAccount;
      chain: string;
    }) => Promise<{ bytes: string; signature: string }>;
  };

  const chain = account.chains.find((c) => c.startsWith('sui:')) ?? 'sui:mainnet';
  const result = await signFeat.signTransaction({ transaction, account, chain });
  return result.signature;
}

// ─── Build and execute a sponsored transaction ────────────────────────

/**
 * Given the transaction kind bytes (built with onlyTransactionKind: true),
 * this function:
 *   1. Checks that the sender is eligible (in the sponsored list or list is open)
 *   2. Fetches the sponsor's SUI coins via GraphQL
 *   3. Reconstructs a full sponsored transaction (sender=user, gasOwner=sponsor)
 *   4. Builds the final BCS bytes so both parties sign the same thing
 *   5. Sponsor signs → user signs → both signatures submitted via gRPC
 *
 * The sponsor wallet must be active (isSponsorActive() === true).
 * The gas budget defaults to 0.05 SUI (50_000_000 MIST).
 */
export async function executeSponsored(
  kindBytes: Uint8Array,
  senderAddress: string,
  senderWallet: Wallet,
  senderAccount: WalletAccount,
  grpcClient: SuiGrpcClient,
  gasBudgetMist = 50_000_000n,
): Promise<{ digest: string; effects?: unknown }> {
  if (!isSponsorActive()) throw new Error('No active gas sponsor');

  const { wallet: sponsorWallet, account: sponsorAccount, auth } = _state;
  if (!sponsorWallet || !sponsorAccount || !auth) throw new Error('Sponsor state inconsistent');

  // Check beneficiary restriction
  const list = getActiveSponsoredList();
  if (list.length > 0) {
    const allowed = list.some((e) => e.address === senderAddress);
    if (!allowed) {
      throw new Error(
        `Your address is not on the sponsor's allowed list. ` +
        `Ask the sponsor to add you at sui.ski.`,
      );
    }
  }

  // 1. Fetch the sponsor's gas coins via GraphQL
  const gasCoins = await fetchSponsorCoins(auth.address);

  // 2. Reconstruct as a full sponsored transaction
  //    sender     = the user (pays no gas)
  //    gasOwner   = the sponsor (owns the gas coins)
  //    gasPayment = sponsor's SUI coin objects
  const sponsoredTx = Transaction.fromKind(kindBytes);
  sponsoredTx.setSender(senderAddress);
  sponsoredTx.setGasOwner(auth.address);
  sponsoredTx.setGasPayment(gasCoins);
  sponsoredTx.setGasBudget(gasBudgetMist);

  // 3. Build to final BCS bytes — deterministic, same regardless of who builds
  const txBytes = await sponsoredTx.build({ client: grpcClient });

  // 4. Wrap bytes back into a Transaction so wallets can sign via the standard
  //    feature. Transaction.from() deserializes the BCS — both wallets get the
  //    same object and will sign identical bytes.
  const txForSigning = Transaction.from(txBytes);

  // 5. Sponsor signs first (pays gas), then user signs (the interactive approval).
  //    Sequential ensures clearer UX than two simultaneous popups.
  const sponsorSig = await signTxWithWallet(sponsorWallet, sponsorAccount, txForSigning);
  const userSig = await signTxWithWallet(senderWallet, senderAccount, txForSigning);

  // 6. Submit with both signatures via gRPC
  type ExecInput = { transaction: Transaction; signatures: string[] };
  type ExecResult = Record<string, unknown>;
  const coreClient = (grpcClient as unknown as { core: { executeTransaction: (r: ExecInput) => Promise<ExecResult> } }).core;

  const resp = await coreClient.executeTransaction({
    transaction: txForSigning,
    signatures: [userSig, sponsorSig],
  });

  // Normalize gRPC discriminated-union response to { digest, effects }
  if (resp['$kind'] === 'Transaction' && resp['Transaction']) {
    const tx = resp['Transaction'] as Record<string, unknown>;
    return { digest: tx['digest'] as string, effects: tx['effects'] };
  }
  return { digest: resp['digest'] as string, effects: resp['effects'] };
}

// ─── Splash DO initialization ─────────────────────────────────────────

/**
 * Connect to this sponsor's SponsorAgent Durable Object and start auto-signing.
 * Called after activateSponsor() succeeds and after restoreSponsor() on page reload.
 * Non-blocking and failure-tolerant — never throws.
 */
export async function initSplashDO(
  wallet: Wallet,
  account: WalletAccount,
): Promise<void> {
  const auth = _state.auth;
  if (!auth?.authMessage) return;

  try {
    const { connectToSponsor, startAutoSigning } = await import('./client/sponsor.js');

    // Connect to this address's DO instance
    const doClient = connectToSponsor(account.address);

    // Register using the existing local auth (no re-signing required)
    await doClient.call('register', [{
      sponsorAddress: account.address,
      authSignature: auth.authSig,
      authMessage: auth.authMessage,
    }]);

    // Auto-sign pending cross-device requests every 5 seconds
    startAutoSigning(async (txBytes: Uint8Array) => {
      const tx = Transaction.from(txBytes);
      return await signTxWithWallet(wallet, account, tx);
    });
  } catch { /* non-blocking */ }
}
