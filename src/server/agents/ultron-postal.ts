/**
 * Ultron Postal Service — UltronEnvelope dispatcher DO (Apollo arc, Move 1).
 *
 * Receives decoded Sui-inbound intents from the SuiInboundWatcher, infers the
 * envelope `kind`, routes to the right handler, and tracks completion. This
 * scaffold ships the dispatch machinery + observability + retry — every
 * forward path is intentionally STUBBED with `TODO(icy-wind-pt2)` markers.
 *
 *   Dispatch → per-kind handler → stub returns { digest: null, stub: true }
 *
 * The live signing wiring drops in during Icy Wind pt2: handlers build the
 * PTB / cross-chain tx today (no state change on-chain), then hand bytes to
 * UltronSigningAgent.signForStealth. Until then, completedDispatches carries
 * `stub: true` so observability shows the queue is draining without minting
 * fake successes downstream.
 *
 * Shape + alarm cadence track AggronBatcher. One singleton DO (name:
 * "ultron-postal"). Sharding by kind comes later if a single alarm tick
 * can't keep up with inbound volume.
 *
 * Greek/roman gods only — no external gods in this file.
 *
 * Related:
 *   - memory/project_ultron_envelope.md                 — design direction
 *   - src/client/ultron-envelope.ts                     — envelope types
 *   - src/server/sui-inbound.ts                         — DecodedIntent
 *   - src/server/agents/ultron-signing-agent.ts         — signForStealth (hermes)
 *   - src/server/agents/aggron-batcher.ts               — alarm pattern reference
 */

import { Agent, callable } from 'agents';
import type { UltronEnv } from '../ultron-key.js';
import type { SuiInboundActivity, DecodedIntent } from '../sui-inbound.js';
import type { EnvelopeKind } from '../../client/ultron-envelope.js';
import { chainTagName } from '../sui-inbound.js';

// ─── IKA Ultron ed25519 dWallet ─────────────────────────────────────
//
// Mirrors `ULTRON_DWALLETS.ed25519.dwalletId` in ultron-signing-agent.ts.
// Duplicated here so this DO doesn't import the full signing agent
// module (circular-import risk + signing agent pulls heavy WASM).
export const ULTRON_ED25519_DWALLET_ID =
  '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9';

/** Env extension — UltronPostal needs the UltronSigningAgent DO namespace
 *  so it can call signForStealth via DO stub. */
export interface UltronPostalEnv extends UltronEnv {
  UltronSigningAgent?: DurableObjectNamespace;
}

/** Sui fullnode fallback chain. Mysten sunsets April 2026, so we default
 *  to the PublicNode / BlockVision / Ankr triplet. */
export const POSTAL_FULLNODE_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];

// ─── Constants ──────────────────────────────────────────────────────

/** Alarm cadence — 60s default drain tick. */
export const POSTAL_ALARM_MS = 60 * 1000;

/** Max tickets drained per alarm tick. */
export const POSTAL_DRAIN_PER_TICK = 10;

/** Retry ceiling — tickets past this stay in pendingDispatches with
 *  attempts === MAX + lastError, i.e. dead-lettered. Re-enqueue by a
 *  new dispatch call supersedes. */
export const POSTAL_MAX_ATTEMPTS = 3;

/** Rolling cap on completedDispatches history. */
export const POSTAL_HISTORY_MAX = 50;

// ─── Types ──────────────────────────────────────────────────────────

export interface DispatchTicket {
  /** 32-byte 0x-prefixed hex. Unique per ticket. */
  ticketId: string;
  kind: EnvelopeKind;
  activity: SuiInboundActivity;
  intent: DecodedIntent;
  recipientSuiamiName: string;
  /** Set once a handler resolves chainAt(recipient). */
  resolvedDestAddr?: string;
  queuedAtMs: number;
  attempts: number;
  lastError?: string;
  flushedAtMs?: number;
}

export interface CompletedDispatch {
  ticketId: string;
  kind: EnvelopeKind;
  recipientSuiamiName: string;
  chain: string;
  amountMist: string;
  /** null while stubbed; real tx digest after Icy Wind pt2. */
  digest: string | null;
  /** true while signing is stubbed. Flip to false/undefined when live. */
  stub?: boolean;
  flushedAtMs: number;
}

export interface UltronPostalState {
  pendingDispatches: DispatchTicket[];
  completedDispatches: CompletedDispatch[];
  lastDispatchedAtMs: number;
}

/** Transient errors retry; permanent errors go straight to dead-letter. */
export class TransientDispatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TransientDispatchError';
  }
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

export function generateTicketId(random?: () => Uint8Array): string {
  const bytes = random ? random() : crypto.getRandomValues(new Uint8Array(32));
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Infer the envelope kind from an inbound activity + its decoded intent.
 * v1: every sub-cent inbound with a non-zero intent tag is a plain
 * `transfer`. Future moves fetch the Aggron-stored envelope blob from
 * Walrus and use its declared `kind`.
 */
export function inferEnvelopeKind(
  _activity: SuiInboundActivity,
  intent: DecodedIntent,
): EnvelopeKind | null {
  if (!intent.hasIntent) return null;
  return 'transfer';
}

// ─── Handlers (all stubbed for v1) ──────────────────────────────────
//
// Each handler receives the ticket + env and returns a Partial<CompletedDispatch>.
// Today they all return `{ digest: null, stub: true }`. The TODO markers
// below flag the exact lines where Icy Wind pt2 plugs signing in.

// ─── handleTransfer internals ───────────────────────────────────────

/** Lightweight interface over UltronSigningAgent.signForStealth. Lets
 *  tests inject a fake stub without wiring a full DO namespace. */
export interface SignForStealthFn {
  (params: {
    dwalletId: string;
    hash: string;
    curve: 'ed25519' | 'secp256k1';
  }): Promise<{ sig: string }>;
}

/** Resolve a signer implementation — DO stub in production, injectable
 *  in tests. Throws if the DO namespace is missing. */
export function resolveSignForStealth(env: UltronPostalEnv): SignForStealthFn {
  if (!env.UltronSigningAgent) {
    throw new Error('handleTransfer: UltronSigningAgent binding missing on env');
  }
  const ns = env.UltronSigningAgent;
  return async (params) => {
    const stub = ns.get(ns.idFromName('ultron-spike')) as unknown as {
      signForStealth: SignForStealthFn;
    };
    return stub.signForStealth(params);
  };
}

/** Look up a Sui address for `sui@<name>` via the SUIAMI roster. */
async function resolveRecipientSuiAddress(suiamiName: string): Promise<string> {
  const { chainAt } = await import('../../client/chain-at.js');
  return chainAt(`sui@${suiamiName}`);
}

/** Fetch ultron's dWallet ed25519 pubkey (32 bytes) via sui_getObject.
 *  Pubkey lives in `state.Active.public_output`, BCS-encoded as
 *  `Option<vector<u8>>` — header [1, 32] then 32 raw bytes. */
async function fetchUltronEd25519Pubkey(rpcUrl: string): Promise<Uint8Array> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getObject',
      params: [ULTRON_ED25519_DWALLET_ID, { showContent: true }],
    }),
  });
  if (!res.ok) throw new TransientDispatchError(`fetch dwallet failed: ${res.status}`);
  const j = await res.json() as {
    result?: { data?: { content?: { fields?: unknown } } };
  };
  const fields = j.result?.data?.content?.fields as {
    state?: { fields?: { public_output?: number[] } };
  } | undefined;
  const po = fields?.state?.fields?.public_output;
  if (!Array.isArray(po) || po.length < 34 || po[0] !== 1 || po[1] !== 32) {
    throw new Error('fetchUltronEd25519Pubkey: public_output missing or malformed');
  }
  return Uint8Array.from(po.slice(2, 34).map(Number));
}

/** Submit a base64-signed Sui tx via JSON-RPC, retrying once across
 *  fallback fullnodes on transport errors. */
async function submitSuiTx(
  txBytesB64: string,
  signatureB64: string,
): Promise<string> {
  let lastErr: string | null = null;
  for (const url of POSTAL_FULLNODE_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_executeTransactionBlock',
            params: [
              txBytesB64,
              [signatureB64],
              { showEffects: true },
              'WaitForLocalExecution',
            ],
          }),
        });
        if (!res.ok) {
          lastErr = `HTTP ${res.status} from ${url}`;
          continue;
        }
        const j = await res.json() as {
          result?: {
            digest?: string;
            effects?: { status?: { status?: string; error?: string } };
          };
          error?: { message?: string };
        };
        if (j.error) {
          lastErr = j.error.message ?? 'rpc error';
          // `-32002` style errors are permanent — break the retry loop.
          throw new Error(`submitSuiTx permanent: ${lastErr}`);
        }
        const status = j.result?.effects?.status?.status;
        if (status && status !== 'success') {
          throw new Error(
            `tx status ${status}: ${j.result?.effects?.status?.error ?? ''}`,
          );
        }
        const digest = j.result?.digest;
        if (!digest) throw new Error('submitSuiTx: no digest in response');
        return digest;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (lastErr.startsWith('submitSuiTx permanent') || lastErr.startsWith('tx status')) {
          throw new Error(lastErr);
        }
      }
    }
  }
  throw new TransientDispatchError(
    `submitSuiTx: all fullnodes exhausted — last=${lastErr ?? 'unknown'}`,
  );
}

/**
 * Ultron Icy Wind pt2 — real ed25519 transfer handler.
 *
 * Flow:
 *   1. Resolve `sui@<recipient>` via the SUIAMI roster.
 *   2. Build a PTB: splitCoins(tx.gas or fetched coin) + transferObjects.
 *   3. Compute the Sui intent-message hash (blake2b of
 *      `[intent(0,0,0) || tx_bytes]`).
 *   4. Call UltronSigningAgent.signForStealth(curve=ed25519) with the
 *      hash — 2PC-MPC end-to-end.
 *   5. Assemble serialized signature (flag 0x00 || 64 sig || 32 pub) and
 *      submit via JSON-RPC executeTransactionBlock.
 *
 * Never materializes a private key. Sender is the Sui address derived
 * from ultron's ed25519 dWallet pubkey (NOT `ultronKeypair(env)`).
 */
export async function handleTransfer(
  ticket: DispatchTicket,
  env: UltronPostalEnv,
  injectedSigner?: SignForStealthFn,
): Promise<Partial<CompletedDispatch>> {
  // 1. Resolve recipient Sui address via SUIAMI roster.
  let recipient: string;
  try {
    recipient = await resolveRecipientSuiAddress(ticket.recipientSuiamiName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Missing roster record is permanent — do not retry.
    throw new Error(`handleTransfer: roster lookup failed: ${msg}`);
  }

  // 2. Lazy-load heavy Sui / crypto deps.
  const { Transaction } = await import('@mysten/sui/transactions');
  const { SuiJsonRpcClient } = await import('@mysten/sui/jsonRpc');
  const { toBase64, fromBase64 } = await import('@mysten/sui/utils');
  const { messageWithIntent } = await import('@mysten/sui/cryptography');
  const { blake2b } = await import('@noble/hashes/blake2.js');
  const { Ed25519PublicKey } = await import('@mysten/sui/keypairs/ed25519');

  const rpcUrl = POSTAL_FULLNODE_URLS[0];
  const sui = new SuiJsonRpcClient({ url: rpcUrl, network: 'mainnet' });

  // 3. Resolve ultron's ed25519 dWallet pubkey → Sui sender address.
  const pubkey = await fetchUltronEd25519Pubkey(rpcUrl);
  if (pubkey.length !== 32) {
    throw new Error(`handleTransfer: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const senderAddr = new Ed25519PublicKey(pubkey).toSuiAddress();

  // 4. Fetch reference gas price + a SUI coin for gas payment, so we
  // can fully pre-fill gasData and skip the v2 resolver's simulate /
  // listCoins / systemState round trip (which is flaky across fullnodes
  // and hard to test). Build with `client` so object-ref resolution for
  // our PTB inputs still works.
  const gasPriceStr = await fetchReferenceGasPrice(rpcUrl);
  const suiCoins = await sui.getCoins({ owner: senderAddr, coinType: '0x2::sui::SUI' });
  if (suiCoins.data.length === 0) {
    throw new Error(`handleTransfer: no SUI coins at ${senderAddr} for gas`);
  }
  const gasPayment = suiCoins.data.map(c => ({
    objectId: c.coinObjectId,
    version: c.version as string | number,
    digest: c.digest,
  }));
  const tx = new Transaction();
  tx.setSender(senderAddr);
  tx.setGasBudget(50_000_000n);
  tx.setGasPrice(BigInt(gasPriceStr));
  tx.setGasPayment(gasPayment);
  const amount = ticket.activity.amountMist;
  const coinType = ticket.activity.coinType;

  if (coinType === '0x2::sui::SUI') {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    // Fetch enough of `coinType` to cover amount.
    const coins = await sui.getCoins({ owner: senderAddr, coinType });
    const picks: { objectId: string; version: string | number; digest: string }[] = [];
    let picked = 0n;
    for (const c of coins.data) {
      picks.push({
        objectId: c.coinObjectId,
        version: c.version,
        digest: c.digest,
      });
      picked += BigInt(c.balance);
      if (picked >= amount) break;
    }
    if (picked < amount) {
      throw new Error(
        `handleTransfer: insufficient ${coinType} — have ${picked}, need ${amount}`,
      );
    }
    const refs = picks.map(p => tx.objectRef(p));
    const primary = refs[0];
    if (refs.length > 1) tx.mergeCoins(primary, refs.slice(1));
    if (picked === amount) {
      tx.transferObjects([primary], tx.pure.address(recipient));
    } else {
      const [toSend] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
      tx.transferObjects([toSend], tx.pure.address(recipient));
    }
  }

  // 5. Serialize + compute Sui intent-message hash.
  const txBytes = await tx.build({ client: sui });
  const intentMsg = messageWithIntent('TransactionData', txBytes);
  const digestBytes = blake2b(intentMsg, { dkLen: 32 });
  const hashHex = '0x' + Array.from(digestBytes)
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // 6. IKA sign — 2PC-MPC ceremony end-to-end.
  const signer = injectedSigner ?? resolveSignForStealth(env);
  const { sig } = await signer({
    dwalletId: ULTRON_ED25519_DWALLET_ID,
    hash: hashHex,
    curve: 'ed25519',
  });

  // 7. Assemble serialized Sui signature: [flag 0x00 || raw(64) || pub(32)].
  const rawSig = parseHexSig(sig);
  if (rawSig.length !== 64) {
    throw new Error(`handleTransfer: expected 64-byte ed25519 sig, got ${rawSig.length}`);
  }
  const serialized = new Uint8Array(1 + 64 + 32);
  serialized[0] = 0x00; // ed25519 flag
  serialized.set(rawSig, 1);
  serialized.set(pubkey, 1 + 64);
  const signatureB64 = toBase64(serialized);

  // 8. Submit. _ = fromBase64 imported for symmetry / future verify path.
  void fromBase64;
  const digest = await submitSuiTx(toBase64(txBytes), signatureB64);
  return { digest, stub: false };
}

async function fetchReferenceGasPrice(rpcUrl: string): Promise<string> {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'suix_getReferenceGasPrice', params: [],
    }),
  });
  if (!r.ok) throw new TransientDispatchError(`gas-price fetch ${r.status}`);
  const j = await r.json() as { result?: string; error?: { message?: string } };
  if (j.error) throw new TransientDispatchError(`gas-price: ${j.error.message}`);
  if (!j.result) throw new TransientDispatchError('gas-price: no result');
  return String(j.result);
}

function parseHexSig(sig: string): Uint8Array {
  const body = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (body.length % 2 !== 0) throw new Error('parseHexSig: odd length');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function handlePrism(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): build Quasar cross-chain route, sign via IKA
  // per source chain (secp256k1 for ETH/BTC, ed25519 for SOL), submit.
  return { digest: null, stub: true };
}

export async function handleDwalletTransfer(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): build DWalletCap transfer PTB (recipient = resolved
  // chainAt for sui@), sign via signForStealth ed25519, submit.
  return { digest: null, stub: true };
}

export async function handleStealthSweep(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): derive next stealth destination, build sweep PTB
  // (multi-coin aggregation), sign ed25519, submit. Sneasel arc consumer.
  return { digest: null, stub: true };
}

export async function handleGuestBind(
  _ticket: DispatchTicket,
  _env: UltronEnv,
): Promise<Partial<CompletedDispatch>> {
  // TODO(icy-wind-pt2): bind a fresh guest IKA dWallet to the recipient's
  // roster entry (Seal-encrypt cold dest, enqueue to Aggron, sign bind PTB).
  return { digest: null, stub: true };
}

/** Pick the right handler for a ticket kind. */
export function handlerFor(
  kind: EnvelopeKind,
): (t: DispatchTicket, env: UltronEnv) => Promise<Partial<CompletedDispatch>> {
  switch (kind) {
    case 'transfer':
      return handleTransfer;
    case 'prism':
      return handlePrism;
    case 'dwallet-transfer':
      return handleDwalletTransfer;
    case 'stealth-sweep':
      return handleStealthSweep;
    case 'guest-bind':
      return handleGuestBind;
  }
}

// ─── Agent ──────────────────────────────────────────────────────────

export class UltronPostal extends Agent<UltronPostalEnv, UltronPostalState> {
  initialState: UltronPostalState = {
    pendingDispatches: [],
    completedDispatches: [],
    lastDispatchedAtMs: 0,
  };

  constructor(ctx: DurableObjectState, env: UltronEnv) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runDispatchAlarm();
    };
  }

  /** Queue a decoded intent for dispatch. SuiInboundWatcher calls this
   *  once it's decoded + looked up the recipient SUIAMI name. */
  @callable({
    description:
      'Queue an UltronEnvelope dispatch. Caller supplies the inbound ' +
      'activity, decoded intent, and resolved recipient SUIAMI name. ' +
      'UltronPostal infers the envelope kind and routes to the handler.',
  })
  async dispatch(params: {
    activity: SuiInboundActivity;
    intent: DecodedIntent;
    recipientSuiamiName: string;
  }): Promise<{
    ticketId: string;
    kind: EnvelopeKind | null;
    action: 'queued' | 'skipped';
    reason?: string;
  }> {
    const { activity, intent, recipientSuiamiName } = params;
    if (!activity || !intent) {
      throw new Error('ultronPostal.dispatch: activity + intent required');
    }
    if (!recipientSuiamiName) {
      return {
        ticketId: '',
        kind: null,
        action: 'skipped',
        reason: 'no-recipient',
      };
    }
    const kind = inferEnvelopeKind(activity, intent);
    if (!kind) {
      return {
        ticketId: '',
        kind: null,
        action: 'skipped',
        reason: 'no-intent-tag',
      };
    }
    const ticket: DispatchTicket = {
      ticketId: generateTicketId(),
      kind,
      activity,
      intent,
      recipientSuiamiName,
      queuedAtMs: Date.now(),
      attempts: 0,
    };
    const next = [...this.state.pendingDispatches, ticket];
    this.setState({ ...this.state, pendingDispatches: next });
    await this._scheduleAlarm();
    return { ticketId: ticket.ticketId, kind, action: 'queued' };
  }

  /** State snapshot — queue depth + recent completions. */
  @callable({ description: 'UltronPostal state snapshot.' })
  async status(): Promise<{
    pendingCount: number;
    recentCompletions: CompletedDispatch[];
    nextAlarmMs: number | null;
  }> {
    const pending = this.state.pendingDispatches.filter(
      t => t.attempts < POSTAL_MAX_ATTEMPTS || t.flushedAtMs == null,
    );
    const nextAlarm = (await this.ctx.storage.getAlarm?.()) ?? null;
    return {
      pendingCount: pending.length,
      recentCompletions: this.state.completedDispatches.slice(-10),
      nextAlarmMs: typeof nextAlarm === 'number' ? nextAlarm : null,
    };
  }

  /** Force an immediate drain — admin/debug. */
  @callable({ description: 'Run the dispatch alarm immediately.' })
  async poke(): Promise<{ triggered: boolean }> {
    await this._runDispatchAlarm();
    return { triggered: true };
  }

  /**
   * Icy Wind pt2 — admin-only live transfer smoke test.
   *
   * Fabricates a dispatch ticket and invokes `handleTransfer` synchronously
   * (no queue, no alarm). Returns the real tx digest on success or a
   * structured error so the caller can see which stage failed (roster
   * lookup, PTB build, IKA sign, or submit).
   *
   * Gated at the Worker route level via `requireUltronAdmin` — the DO
   * callable itself is raw.
   */
  @callable({
    description:
      'Synchronously run handleTransfer for an arbitrary recipient+amount. ' +
      'Admin-only — the Worker endpoint enforces requireUltronAdmin.',
  })
  async testLiveTransfer(params: {
    recipientSuiamiName: string;
    amountMist: string;
    coinType?: string;
  }): Promise<{ ok: boolean; digest?: string; error?: string }> {
    const { recipientSuiamiName, amountMist } = params;
    const coinType = params.coinType ?? '0x2::sui::SUI';
    if (!recipientSuiamiName) {
      return { ok: false, error: 'recipientSuiamiName required' };
    }
    let amount: bigint;
    try {
      amount = BigInt(amountMist);
    } catch {
      return { ok: false, error: 'amountMist must be a bigint-parsable string' };
    }
    const fakeActivity: SuiInboundActivity = {
      digest: '0x' + '00'.repeat(32),
      fromAddress: '0x' + '00'.repeat(32),
      toAddress: '0x' + '00'.repeat(32),
      coinType,
      amountMist: amount,
      timestampMs: Date.now(),
    };
    const fakeIntent: DecodedIntent = {
      rawAmount: amount,
      intentCode: 1,
      recipientIndex: 0,
      chainTag: 0,
      baseAmount: amount,
      hasIntent: true,
    };
    const ticket: DispatchTicket = {
      ticketId: generateTicketId(),
      kind: 'transfer',
      activity: fakeActivity,
      intent: fakeIntent,
      recipientSuiamiName,
      queuedAtMs: Date.now(),
      attempts: 0,
    };
    try {
      const res = await handleTransfer(ticket, this.env);
      return { ok: true, digest: res.digest ?? undefined };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  async _runDispatchAlarm(): Promise<void> {
    const ready = this.state.pendingDispatches
      .filter(t => !t.flushedAtMs && t.attempts < POSTAL_MAX_ATTEMPTS)
      .slice(0, POSTAL_DRAIN_PER_TICK);

    if (ready.length === 0) {
      await this._scheduleAlarm();
      return;
    }

    let working = this.state.pendingDispatches.slice();
    const completions: CompletedDispatch[] = [];

    for (const ticket of ready) {
      const handler = this._resolveHandler(ticket.kind);
      try {
        const res = await handler(ticket, this.env);
        const completion: CompletedDispatch = {
          ticketId: ticket.ticketId,
          kind: ticket.kind,
          recipientSuiamiName: ticket.recipientSuiamiName,
          chain: chainTagName(ticket.intent.chainTag),
          amountMist: ticket.activity.amountMist.toString(),
          digest: res.digest ?? null,
          ...(res.stub != null ? { stub: res.stub } : {}),
          flushedAtMs: Date.now(),
        };
        completions.push(completion);
        working = working.map(t =>
          t.ticketId === ticket.ticketId
            ? { ...t, attempts: t.attempts + 1, flushedAtMs: completion.flushedAtMs }
            : t,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = err instanceof TransientDispatchError;
        working = working.map(t => {
          if (t.ticketId !== ticket.ticketId) return t;
          const attempts = t.attempts + 1;
          // Permanent errors also bump to MAX so they dead-letter immediately.
          const finalAttempts = isTransient ? attempts : POSTAL_MAX_ATTEMPTS;
          return { ...t, attempts: finalAttempts, lastError: msg };
        });
      }
    }

    // Drop tickets that completed successfully (have flushedAtMs) from
    // pending — completions are the source of truth for them. Tickets at
    // the retry cap without a flushedAtMs stay in pending as dead-letter.
    const prunedPending = working.filter(t => !t.flushedAtMs);
    const history = [...this.state.completedDispatches, ...completions].slice(
      -POSTAL_HISTORY_MAX,
    );

    this.setState({
      ...this.state,
      pendingDispatches: prunedPending,
      completedDispatches: history,
      lastDispatchedAtMs: Date.now(),
    });

    await this._scheduleAlarm();
  }

  /** Test hook — override in subclasses to swap handlers. Defaults to the
   *  module-level `handlerFor`. Keeping this as a method (not a frozen
   *  export binding) makes the scaffold unit-testable. */
  protected _resolveHandler(
    kind: EnvelopeKind,
  ): (t: DispatchTicket, env: UltronEnv) => Promise<Partial<CompletedDispatch>> {
    return handlerFor(kind);
  }

  private async _scheduleAlarm(overrideMs?: number): Promise<void> {
    const at = Date.now() + (overrideMs ?? POSTAL_ALARM_MS);
    await this.ctx.storage.setAlarm(at);
  }
}
