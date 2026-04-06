/**
 * .SKI Gas Sponsorship — client-side API.
 *
 * No Redis. No external API. Uses:
 *   - SponsorAgent Durable Object (WebSocket via AgentClient) for coordination
 *   - SuiGrpcClient for gas coin lookup + transaction submission
 *   - Native Sui sponsored-transaction protocol (Transaction.fromKind + dual signatures)
 *
 * Sponsor flow:
 *   1. buildSponsorAuthMessage(address)  — build the message to sign
 *   2. connectToSponsor(address)         — open WebSocket to this address's SponsorAgent
 *   3. registerAsSponsor(params)         — verify + store auth, push current gas coins
 *   4. processPendingRequests(signFn)    — call on every state update to sign queued requests
 *
 * User flow:
 *   1. connectToSponsor(sponsorAddress)  — open WebSocket to the sponsor's SponsorAgent
 *   2. requestSponsoredTransaction(...)  — builds sponsored tx, collects both sigs, submits
 */

import { AgentClient } from 'agents/client';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import type { SponsorState, SponsorRequest, GasCoin } from '../server/agents/sponsor.js';

// ─── Connection ───────────────────────────────────────────────────────

let client: AgentClient<SponsorState> | null = null;

export function connectToSponsor(
  sponsorAddress: string,
  onUpdate?: (state: SponsorState) => void,
): AgentClient<SponsorState> {
  client?.close();
  client = new AgentClient<SponsorState>({
    host: window.location.host,
    agent: 'sponsor-agent',
    name: sponsorAddress,
    onStateUpdate: (s) => onUpdate?.(s),
  });
  return client;
}

export function disconnectSponsor(): void {
  client?.close();
  client = null;
}

// ─── Authorization message ────────────────────────────────────────────

export function buildSponsorAuthMessage(sponsorAddress: string): {
  message: string;
  expiresAt: string;
} {
  const nonce     = crypto.randomUUID();
  const issuedAt  = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const message = [
    `.SKI Splash`,
    '',
    sponsorAddress,
    '',
    `URI: ${window.location.origin}`,
    `Version: 2`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    '',
    'This signature authorizes gas sponsorship for .SKI sessions. No gas is spent by signing.',
  ].join('\n');

  return { message, expiresAt };
}

// ─── Sponsor enrollment ───────────────────────────────────────────────

/**
 * Fetch the sponsor's current SUI coin objects via gRPC and push them to the DO.
 */
export async function refreshSponsorGasCoins(
  sponsorAddress: string,
  grpcClient: SuiGrpcClient,
): Promise<GasCoin[]> {
  if (!client) throw new Error('Not connected to sponsor agent');

  const listResult = await grpcClient.stateService.listOwnedObjects({
    owner: sponsorAddress,
    objectType: '0x2::coin::Coin<0x2::sui::SUI>',
  });

  const rawObjects = (listResult as unknown as { objects?: Array<{ objectId?: string; version?: string; digest?: string }> }).objects ?? [];
  const coins: GasCoin[] = rawObjects.map((obj) => ({
    objectId: obj.objectId ?? '',
    version:  obj.version  ?? '0',
    digest:   obj.digest   ?? '',
  })).filter((c) => c.objectId);

  await client.call('refreshGasCoins', [{ coins }]);
  return coins;
}

/**
 * Full sponsor enrollment:
 *   - Builds auth message
 *   - Calls back so the caller can sign with their wallet
 *   - Registers with the DO
 *   - Pushes current gas coins
 */
export async function registerAsSponsor(params: {
  sponsorAddress: string;
  /** Caller must sign buildSponsorAuthMessage().message with the sponsor's wallet */
  signMessage: (messageBytes: Uint8Array) => Promise<{ signature: string }>;
  grpcClient: SuiGrpcClient;
}): Promise<{ success: boolean; expiresAt?: number; error?: string }> {
  if (!client) throw new Error('Not connected to sponsor agent');

  const { message, expiresAt } = buildSponsorAuthMessage(params.sponsorAddress);
  const messageBytes = new TextEncoder().encode(message);
  const { signature } = await params.signMessage(messageBytes);

  const result = await client.call<{ success: boolean; expiresAt?: number; error?: string }>(
    'register',
    [{ sponsorAddress: params.sponsorAddress, authSignature: signature, authMessage: message }],
  );

  if (result.success) {
    await refreshSponsorGasCoins(params.sponsorAddress, params.grpcClient);
  }

  return result;
}

// ─── User: request a sponsored transaction ────────────────────────────

/**
 * Full user-side sponsorship flow:
 *
 *   1. Build kind-only tx bytes
 *   2. Fetch sponsor gas coins from DO
 *   3. Reconstruct as sponsored tx (fromKind + setSender/setGasOwner/setGasPayment)
 *   4. Build final tx bytes (the bytes both parties sign)
 *   5. Register request with DO
 *   6. User signs → submit user sig
 *   7. Poll DO for sponsor sig (sponsor client auto-signs on state update)
 *   8. Submit with both sigs via grpcClient.core.executeTransaction
 */
export async function requestSponsoredTransaction(params: {
  tx: Transaction;
  senderAddress: string;
  sponsorAddress: string;
  /** Sign the raw transaction bytes (not a personal message — use sui:signTransaction feature) */
  signTransaction: (txBytes: Uint8Array) => Promise<string>;
  grpcClient: SuiGrpcClient;
  timeoutMs?: number;
}): Promise<{ digest: string }> {
  const {
    tx, senderAddress, sponsorAddress, signTransaction,
    grpcClient, timeoutMs = 90_000,
  } = params;

  if (!client) throw new Error('Not connected to sponsor agent');

  // 1. Get DO state to detect ultron mode
  const doState = await client.call<SponsorState>('getSponsorState', []);
  const gasOwner = doState.ultronMode && doState.ultronAddress
    ? doState.ultronAddress
    : sponsorAddress;

  // 2. Get sponsor gas coins from DO
  const gasData = await client.call<{ coins: GasCoin[]; refreshedAt: number } | null>(
    'getGasCoins', [],
  );
  if (!gasData || gasData.coins.length === 0) {
    throw new Error('Sponsor has no gas coins — ask them to refresh');
  }

  // 3. Build kind-only bytes (no gas, no sender)
  const kindBytes = await tx.build({ client: grpcClient, onlyTransactionKind: true });

  // 4. Reconstruct as sponsored transaction
  const sponsoredTx = Transaction.fromKind(kindBytes);
  sponsoredTx.setSender(senderAddress);
  sponsoredTx.setGasOwner(gasOwner);
  sponsoredTx.setGasPayment(gasData.coins);

  // 4. Build the final bytes — both parties sign exactly these
  const txBytes = await sponsoredTx.build({ client: grpcClient });
  const txBase64 = toBase64(txBytes);

  // 5. Register with DO — state update notifies sponsor's WebSocket client
  const requestResult = await client.call<{ requestId: string } | { error: string }>(
    'requestSponsorship',
    [{ senderAddress, txBytes: txBase64 }],
  );
  if ('error' in requestResult) throw new Error(requestResult.error);
  const { requestId } = requestResult;

  // 6. User signs
  const userSig = await signTransaction(txBytes);
  await client.call('submitUserSignature', [{ requestId, userSig }]);

  // 7. Wait for sponsor sig (sponsor's client signs on state update)
  const ready = await pollForReady(requestId, timeoutMs);
  if (!ready.sponsorSig) throw new Error('Sponsor signature not received');

  // 8. Submit with both signatures via gRPC
  const result = await grpcClient.core.executeTransaction({
    transaction: txBytes,
    signatures: [userSig, ready.sponsorSig],
  });

  const digest = (result as { digest?: string; Transaction?: { digest?: string } }).digest
    ?? (result as { Transaction?: { digest?: string } }).Transaction?.digest
    ?? '';

  await client.call('markSubmitted', [{ requestId, digest }]);
  return { digest };
}

// ─── Sponsor: sign pending requests ──────────────────────────────────

/**
 * Call this inside the sponsor's onUpdate handler (or on a button press) to
 * auto-sign all pending requests that are missing the sponsor signature.
 *
 * The sponsor's wallet signs the exact same tx bytes the user signed.
 */
export async function processPendingRequests(params: {
  signTransaction: (txBytes: Uint8Array) => Promise<string>;
}): Promise<void> {
  if (!client) return;

  const state = await client.call<SponsorState>('getSponsorState', []);
  const unsigned = state.pendingRequests.filter(
    r => !r.sponsorSig && r.status !== 'submitted' && r.status !== 'failed',
  );

  for (const req of unsigned) {
    try {
      const txBytes = fromBase64(req.txBytes);
      const sponsorSig = await params.signTransaction(txBytes);
      await client.call('submitSponsorSignature', [{ requestId: req.id, sponsorSig }]);
    } catch {
      // User can skip or retry — don't block the loop
    }
  }
}

// ─── Target list sync ─────────────────────────────────────────────────

export async function addSplashTarget(address: string, callerAddress: string): Promise<void> {
  if (!client) throw new Error('Not connected to sponsor agent');
  await client.call('addEntry', [{ address, callerAddress }]);
}

export async function removeSplashTarget(address: string, callerAddress: string): Promise<void> {
  if (!client) throw new Error('Not connected to sponsor agent');
  await client.call('removeEntry', [{ address, callerAddress }]);
}

/**
 * Ultron-mode sponsored transaction: user signs first, ultron signs the exact
 * same bytes on the server, then we submit with both signatures.
 *
 * Unlike requestSponsoredTransaction (where the DO gets bytes first and the
 * sponsor browser-wallet signs later), this flow guarantees byte-match by
 * letting the wallet produce the canonical bytes via sign, then forwarding
 * those to ultron.
 */
export async function requestUltronSponsoredTransaction(params: {
  tx: Transaction;
  senderAddress: string;
  sponsorAddress: string;
  /** Must return BOTH the base64 bytes the wallet signed AND the signature */
  signTransaction: (txBytes: Uint8Array) => Promise<{ bytes: string; signature: string }>;
  grpcClient: SuiGrpcClient;
}): Promise<{ digest: string }> {
  const { tx, senderAddress, sponsorAddress, signTransaction, grpcClient } = params;

  if (!client) throw new Error('Not connected to sponsor agent');

  // 1. Get DO state — need ultron address for gasOwner
  const doState = await client.call<SponsorState>('getSponsorState', []);
  if (!doState.ultronMode || !doState.ultronAddress) {
    throw new Error('Ultron mode not active on DO');
  }

  // 2. Get ultron gas coins
  const gasData = await client.call<{ coins: GasCoin[]; refreshedAt: number } | null>(
    'getGasCoins', [],
  );
  if (!gasData || gasData.coins.length === 0) {
    throw new Error('Ultron has no gas coins');
  }

  // 3. Build the sponsored transaction
  const kindBytes = await tx.build({ client: grpcClient, onlyTransactionKind: true });
  const sponsoredTx = Transaction.fromKind(kindBytes);
  sponsoredTx.setSender(senderAddress);
  sponsoredTx.setGasOwner(doState.ultronAddress);
  sponsoredTx.setGasPayment(gasData.coins);

  const txBytes = await sponsoredTx.build({ client: grpcClient });

  // 4. USER SIGNS FIRST — get the actual bytes the wallet signed
  const { bytes: walletBytesB64, signature: userSig } = await signTransaction(txBytes);
  const walletBytes = fromBase64(walletBytesB64);

  // 5. Send the wallet-signed bytes to DO → keeper signs the SAME bytes
  const walletBase64 = toBase64(walletBytes);
  const requestResult = await client.call<{ requestId: string } | { error: string }>(
    'requestSponsorship',
    [{ senderAddress, txBytes: walletBase64 }],
  );
  if ('error' in requestResult) throw new Error(requestResult.error);
  const { requestId } = requestResult;

  // Submit user sig (keeper already auto-signed in requestSponsorship)
  await client.call('submitUserSignature', [{ requestId, userSig }]);

  // 6. Poll for keeper sig (should be immediate since keeper auto-signs)
  const ready = await pollForReady(requestId, 30_000);
  if (!ready.sponsorSig) throw new Error('Keeper signature not received');

  // 7. Submit with both signatures — use walletBytes (what both parties signed)
  const result = await grpcClient.core.executeTransaction({
    transaction: walletBytes,
    signatures: [userSig, ready.sponsorSig],
  });

  const digest = (result as { digest?: string; Transaction?: { digest?: string } }).digest
    ?? (result as { Transaction?: { digest?: string } }).Transaction?.digest
    ?? '';

  await client.call('markSubmitted', [{ requestId, digest }]);
  return { digest };
}

export async function enableUltronMode(callerAddress: string): Promise<{ success: boolean; ultronAddress?: string; error?: string }> {
  if (!client) throw new Error('Not connected to sponsor agent');
  return client.call<{ success: boolean; ultronAddress?: string; error?: string }>('enableUltronMode', [{ callerAddress }]);
}

export async function disableUltronMode(callerAddress: string): Promise<{ success: boolean }> {
  if (!client) throw new Error('Not connected to sponsor agent');
  return client.call<{ success: boolean }>('disableUltronMode', [{ callerAddress }]);
}

let _autoSignInterval: ReturnType<typeof setInterval> | null = null;

/** Poll for pending requests and auto-sign them every 5 seconds. */
export function startAutoSigning(
  signFn: (txBytes: Uint8Array) => Promise<string>,
): void {
  if (_autoSignInterval) clearInterval(_autoSignInterval);
  _autoSignInterval = setInterval(async () => {
    if (!client) { clearInterval(_autoSignInterval!); _autoSignInterval = null; return; }
    try {
      // Skip browser-wallet auto-signing when keeper mode handles it server-side
      const state = await client.call<SponsorState>('getSponsorState', []);
      if (state.ultronMode) return;
      await processPendingRequests({ signTransaction: signFn });
    } catch { /* non-blocking */ }
  }, 5_000);
}

// ─── Timing constants ────────────────────────────────────────────────
const SPONSOR_POLL_RETRY_MS = 600;

// ─── Helpers ──────────────────────────────────────────────────────────

async function pollForReady(requestId: string, timeoutMs: number): Promise<SponsorRequest> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await client!.call<SponsorState>('getSponsorState', []);
    const req = state.pendingRequests.find(r => r.id === requestId);
    if (!req) throw new Error('Request disappeared from sponsor queue');
    if (req.status === 'ready' || (req.userSig && req.sponsorSig)) return req;
    if (req.status === 'failed') throw new Error(req.error ?? 'Sponsorship failed');
    await new Promise(r => setTimeout(r, SPONSOR_POLL_RETRY_MS));
  }

  throw new Error('Sponsorship request timed out waiting for sponsor signature');
}
