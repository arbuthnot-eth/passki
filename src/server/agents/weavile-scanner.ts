/**
 * Weavile Pursuit — multi-chain stealth announcement scanner (#198).
 *
 * WeavileScannerAgent is a Durable Object that refits SneaselWatcher
 * from a single-chain hot-address watcher into a curve-generic stealth
 * announcement consumer. It subscribes to per-chain Announcer event
 * sources (ERC-5564 on EVM, `suiami::stealth_announcer` on Sui, Solana
 * program TBD), runs the view-tag fast-path on every inbound event,
 * and on match enqueues a Metal Claw sweep ceremony against the
 * derived stealth address.
 *
 * Per the spec (`weavile-scanner.md`):
 *   - One DO instance per recipient (sharded by `hash(recipientSuiAddr)`).
 *   - View privs live in DO state — T3 subpoena trade-off accepted.
 *   - Spend pubkeys come from the recipient's per-chain IKA dWallets.
 *   - Sweep (Metal Claw) is blocked on Icy Wind; Pursuit-only scanning
 *     works today because we just log sightings into `pendingStealths`.
 *
 * Pipeline: subscribe() → tick()/webhook → onAnnouncementEvent() →
 * deriveStealthForEvent() → enqueue pendingStealths → tick() → (stub)
 * sweep ceremony → completedSweeps.
 *
 * Related files:
 *   - src/server/agents/weavile-stealth-derive.ts — pure ECDH + tweak
 *     derivation; curve-generic; unit-testable.
 *   - src/server/agents/weavile-scanner.md — architecture spec.
 *   - src/server/agents/sneasel-watcher.ts — prior single-chain watcher
 *     (~60% of the patterns here are refit from it: Agent subclass,
 *     alarm chaining, admin gate, history trim, state shape).
 *   - src/client/weavile-announcer.ts — StealthAnnouncementEvent shape.
 *   - src/client/weavile-meta.ts — parseMetaAddress, serializeMetaAddress.
 */

import { Agent, callable } from 'agents';
import { deriveStealthForEvent, type DeriveCurve } from './weavile-stealth-derive.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Default alarm cadence — tick every 5 minutes (matches Sneasel). */
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** How many completed sweeps we retain in rolling history. */
const COMPLETED_HISTORY_MAX = 100;

/** Max pending stealths processed per tick — keeps DO CPU bounded. */
const TICK_BATCH_MAX = 32;

/** Per-tick random-jitter upper bound (30 min). Same principle as
 *  Sneasel Ice Fang §4.2 — jitter beats block-level timing correlation. */
const SCAN_JITTER_MAX_MS = 30 * 60 * 1000;
const SCAN_JITTER_MIN_MS = 30 * 1000;

/** Chain → curve registry. Mirrors CHAIN_CURVES in weavile-meta.ts
 *  but re-declared locally so the server bundle doesn't import the
 *  browser-only weavile-meta module. */
const CHAIN_TO_CURVE: Record<string, DeriveCurve> = {
  eth: 'secp256k1',
  btc: 'secp256k1',
  tron: 'secp256k1',
  polygon: 'secp256k1',
  base: 'secp256k1',
  arbitrum: 'secp256k1',
  sui: 'ed25519',
  sol: 'ed25519',
};

export function pickScanJitterMs(random: () => number = Math.random): number {
  const span = SCAN_JITTER_MAX_MS - SCAN_JITTER_MIN_MS;
  return SCAN_JITTER_MIN_MS + Math.floor(random() * span);
}

// ─── Types ──────────────────────────────────────────────────────────

export interface ScannerSubscription {
  /** Canonical Sui address of the recipient we're scanning for. */
  recipientSuiAddr: string;
  /** chain → view priv hex. THIS IS THE SUBPOENABLE SECRET (T3). */
  viewKeyShares: Record<string, string>;
  /** chain → spend pubkey hex (from IKA dWallet DKG, per-chain). */
  spendPubkeys: Record<string, string>;
  /** ms epoch of last scan pass. */
  lastScanMs: number;
  /** Last processed block/checkpoint per chain (for pollSince cursors). */
  chainCursors: Record<string, number>;
}

/** Generic announcement event — shape-equivalent across ETH / Sui / Sol
 *  after each ChainEventSource normalizes its provider-specific feed. */
export interface AnnouncementEvent {
  /** `eth` | `sui` | `sol` | `btc` | ... */
  chain: string;
  /** 33-byte secp256k1 compressed or 32-byte ed25519 pubkey, hex. */
  ephemeralPubHex: string;
  /** Derived stealth address the sender published (chain-native format). */
  stealthAddr: string;
  /** 1-byte fast-path hint. */
  viewTag: number;
  /** 0=secp256k1 eth-compat, 1=ed25519 sui, 2=ed25519 sol (per
   *  weavile-announcer.ts constants). */
  schemeId: number;
  /** Upstream digest — tx hash (ETH/Sui) or signature (Sol). */
  announcementDigest: string;
  /** ms epoch of on-chain announcement. */
  announcedMs: number;
  /** Optional encrypted memo / Walrus blob id, hex. */
  metadataHex?: string;
}

export interface PendingStealth {
  recipientSuiAddr: string;
  chain: string;
  /** Stealth address in chain-native format (from the announcement). */
  stealthAddr: string;
  ephemeralPubHex: string;
  /** s = hash(ECDH(view_priv, eph_pub)). Hex. */
  tweakHex: string;
  announcementDigest: string;
  detectedMs: number;
  schemeId: number;
}

export interface CompletedSweep {
  recipientSuiAddr: string;
  chain: string;
  /** Short-form stealth address (first 6 + last 4). */
  stealthAddrShort: string;
  /** Sweep tx digest returned by the signing ceremony. */
  digest: string;
  executedAtMs: number;
}

export interface WeavileScannerState {
  scanners: ScannerSubscription[];
  pendingStealths: PendingStealth[];
  completedSweeps: CompletedSweep[];
}

interface Env {
  SUI_NETWORK?: string;
  SHADE_KEEPER_PRIVATE_KEY?: string;
  /** Alchemy / Infura ETH mainnet JSON-RPC URL. When unset, eth poll is
   *  webhook-only (EthAnnouncerSource returns []). */
  ALCHEMY_ETH_URL?: string;
  /** Sui GraphQL URL. Defaults to mainnet Mysten endpoint. */
  SUI_GRAPHQL_URL?: string;
  /** Published suiami weavile package id — when set, SuiAnnouncerSource
   *  queries `{pkg}::stealth_announcer::StealthAnnouncement`. */
  SUIAMI_WEAVILE_PKG?: string;
}

interface AdminAuth {
  adminAddress: string;
  signature: string;
  message: string;
}

// ─── Chain event source abstraction (stub for Metal Claw) ────────────

/** Per-chain Announcer event source. Real Alchemy/Helius/gRPC wiring
 *  lands in Metal Claw — these stubs exist so the DO can be composed
 *  and tested today without blocking on webhook provisioning. */
export interface ChainEventSource {
  chain: string;
  /** Return events since `cursor` (block number, checkpoint, or slot).
   *  Stubs return `[]`; Metal Claw replaces each impl. */
  pollSince(cursor: number): Promise<AnnouncementEvent[]>;
}

/** ERC-5564 Announcer address on Ethereum mainnet (singleton, same on all
 *  EVM chains per the EIP's CREATE2 deterministic deploy). */
export const ERC5564_ANNOUNCER_ADDRESS = '0x55649e01b5df198d18d95b5cc5051630cfd45564';

/** keccak256("Announcement(uint256,address,address,bytes,bytes)").
 *  Indexed: schemeId (topic1), stealthAddress (topic2), caller (topic3).
 *  Non-indexed: ephemeralPubkey, metadata — both `bytes`, ABI-encoded in
 *  log.data as two offset pointers + length-prefixed payloads. */
export const ERC5564_ANNOUNCEMENT_TOPIC0 =
  '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';

/** Cap blocks per `eth_getLogs` call — Alchemy/Infura both reject ranges
 *  > ~1000 blocks with zero matches. 500 leaves headroom. */
const ETH_LOG_RANGE_CAP = 500;

/** Decode an ABI-encoded `bytes` value starting at `offset` bytes inside
 *  `data` (which is hex without 0x prefix). Returns the hex of the
 *  payload and its byte length. Used to peel `ephemeralPubkey` +
 *  `metadata` out of log.data per the Announcement layout:
 *
 *    [0x00..0x20] → offset of ephemeralPubkey (bytes32 big-endian)
 *    [0x20..0x40] → offset of metadata
 *    [offset..]   → 32-byte length + ceil(len/32)*32 padded payload
 */
function decodeAbiBytes(dataHex: string, offsetBytes: number): { hex: string; len: number } {
  const start = offsetBytes * 2;
  const lenHex = dataHex.slice(start, start + 64);
  const len = parseInt(lenHex, 16);
  const payload = dataHex.slice(start + 64, start + 64 + len * 2);
  return { hex: `0x${payload}`, len };
}

/** Parse a raw Alchemy / Infura `eth_getLogs` result entry into our
 *  normalized AnnouncementEvent. Exported for unit testing. */
export function parseEthAnnouncementLog(log: {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}): AnnouncementEvent | null {
  if (!log.topics || log.topics.length < 4) return null;
  if ((log.topics[0] || '').toLowerCase() !== ERC5564_ANNOUNCEMENT_TOPIC0) return null;
  // topic1 = schemeId (uint256) — first byte-of-last-byte is fine for 0/1/2.
  const schemeId = parseInt(log.topics[1].slice(-2), 16);
  // topic2 = stealthAddress (address, left-padded 12 zero bytes).
  const stealthAddr = `0x${log.topics[2].slice(-40)}`.toLowerCase();
  // data = ABI-encoded (bytes ephemeralPubkey, bytes metadata).
  const dataHex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (dataHex.length < 128) return null;
  const ephOffset = parseInt(dataHex.slice(0, 64), 16);
  const metaOffset = parseInt(dataHex.slice(64, 128), 16);
  const eph = decodeAbiBytes(dataHex, ephOffset);
  const meta = decodeAbiBytes(dataHex, metaOffset);
  // View tag is the first byte of metadata per EIP-5564 §Ext. When
  // metadata is empty (some senders omit it) we fall back to 0 — the
  // scanner just runs full ECDH for those events.
  const viewTag = meta.len > 0 ? parseInt(meta.hex.slice(2, 4), 16) : 0;
  return {
    chain: 'eth',
    ephemeralPubHex: eph.hex,
    stealthAddr,
    viewTag,
    schemeId,
    announcementDigest: log.transactionHash,
    announcedMs: 0, // block timestamp not carried in getLogs; left-filler
    metadataHex: meta.hex,
  };
}

/** ERC-5564 Announcer at `0x55649E01B5Df198D18D95b5cc5051630cfD45564`.
 *  Polls Alchemy / Infura via `eth_getLogs` in bounded block windows.
 *  Webhook push path lives in `/api/webhook/weavile/eth`; the poll is
 *  a belt-and-braces backfill for dropped webhooks. */
export class EthAnnouncerSource implements ChainEventSource {
  readonly chain = 'eth';
  private lastBlock = 0;
  constructor(private readonly rpcUrl?: string) {}
  getLastBlock(): number { return this.lastBlock; }
  async pollSince(cursor: number): Promise<AnnouncementEvent[]> {
    if (!this.rpcUrl) return []; // not configured — webhook-only mode
    const from = cursor > 0 ? cursor + 1 : 0;
    // Cap range; leave head-block discovery to the provider.
    const toTag = 'latest';
    const fromHex = '0x' + from.toString(16);
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{
        fromBlock: fromHex,
        toBlock: toTag,
        address: ERC5564_ANNOUNCER_ADDRESS,
        topics: [ERC5564_ANNOUNCEMENT_TOPIC0],
      }],
    };
    const r = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const resp = await r.json() as { result?: unknown[]; error?: { message: string } };
    if (resp.error) {
      // Range-too-large → split. Provider told us the max; caller re-calls
      // with a smaller window on next tick.
      throw new Error(`eth_getLogs: ${resp.error.message}`);
    }
    const logs = Array.isArray(resp.result) ? resp.result : [];
    const events: AnnouncementEvent[] = [];
    let maxBlock = cursor;
    for (const raw of logs as Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>) {
      const parsed = parseEthAnnouncementLog(raw);
      if (!parsed) continue;
      events.push(parsed);
      const bn = parseInt(raw.blockNumber, 16);
      if (bn > maxBlock) maxBlock = bn;
    }
    // Cap advance to ETH_LOG_RANGE_CAP so the next tick does a bounded range.
    this.lastBlock = Math.min(maxBlock, from + ETH_LOG_RANGE_CAP - 1);
    return events;
  }
}

/** `suiami::stealth_announcer::StealthAnnouncement` events on Sui mainnet.
 *  Queries GraphQL by event type with checkpoint-sequence cursor.
 *  gRPC would be preferred per CLAUDE.md, but Cloudflare Workers/DOs
 *  can't use HTTP/2 bidi streaming, so GraphQL is the only usable
 *  transport in this context (see MEMORY.md → Sui RPC for tx submission). */
export class SuiAnnouncerSource implements ChainEventSource {
  readonly chain = 'sui';
  constructor(
    private readonly pkgId: string | null,
    private readonly gqlUrl: string = 'https://graphql.mainnet.sui.io/graphql',
  ) {}
  async pollSince(cursor: number): Promise<AnnouncementEvent[]> {
    if (!this.pkgId) return []; // package not published yet
    const eventType = `${this.pkgId}::stealth_announcer::StealthAnnouncement`;
    const query = `query($type: String!, $after: String) {
      events(filter: { eventType: $type }, first: 50, after: $after) {
        nodes {
          sequenceNumber
          timestamp
          sendingModule { package { address } }
          contents { json }
          transactionBlock { digest }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const after = cursor > 0 ? String(cursor) : null;
    const r = await fetch(this.gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { type: eventType, after } }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json() as { data?: { events?: { nodes?: Array<{
      sequenceNumber?: string | number;
      timestamp?: string;
      contents?: { json?: Record<string, unknown> };
      transactionBlock?: { digest?: string };
    }> } }; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(`sui gql: ${body.errors.map(e => e.message).join('; ')}`);
    const nodes = body.data?.events?.nodes ?? [];
    const events: AnnouncementEvent[] = [];
    for (const n of nodes) {
      const j = n.contents?.json;
      if (!j) continue;
      const eph = j.ephemeral_pubkey;
      const ephHex = Array.isArray(eph)
        ? '0x' + (eph as number[]).map(b => b.toString(16).padStart(2, '0')).join('')
        : typeof eph === 'string'
          ? (eph.startsWith('0x') ? eph : `0x${eph}`)
          : '';
      const meta = j.metadata;
      const metaHex = Array.isArray(meta)
        ? '0x' + (meta as number[]).map(b => b.toString(16).padStart(2, '0')).join('')
        : typeof meta === 'string'
          ? (meta.startsWith('0x') ? meta : `0x${meta}`)
          : undefined;
      events.push({
        chain: 'sui',
        ephemeralPubHex: ephHex,
        stealthAddr: String(j.stealth_addr || ''),
        viewTag: Number(j.view_tag ?? 0),
        schemeId: Number(j.scheme_id ?? 1),
        announcementDigest: n.transactionBlock?.digest ?? '',
        announcedMs: Number(j.announced_ms ?? n.timestamp ?? 0),
        metadataHex: metaHex,
      });
    }
    return events;
  }
}

/** Solana program — NOT DEPLOYED yet. See
 *  `contracts/sol-stealth-announcer/README.md` (Quick Attack follow-up).
 *  Until the program id exists we have nothing to subscribe to. The
 *  webhook path at `/api/webhook/weavile/sol` is likewise stubbed. */
export class SolAnnouncerSource implements ChainEventSource {
  readonly chain = 'sol';
  async pollSince(_cursor: number): Promise<AnnouncementEvent[]> {
    // TODO(Quick Attack Sol): see contracts/sol-stealth-announcer/README.md —
    // program id pending; once deployed, switch to Helius program-log
    // webhook (push) and keep this poll as backfill via
    // `getSignaturesForAddress(programId)` paginated by `before`.
    console.log('[weavile-scanner] SolAnnouncerSource: not-live-yet; program pending Quick Attack Sol');
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function isMainnetEnv(env: Env): boolean {
  const network = (env.SUI_NETWORK || 'mainnet').toLowerCase();
  return network === 'mainnet';
}

function shortenAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr ?? '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function curveForChain(chain: string): DeriveCurve {
  const c = CHAIN_TO_CURVE[chain];
  if (!c) throw new Error(`[weavile-scanner] unknown chain "${chain}"`);
  return c;
}

// ─── Agent ──────────────────────────────────────────────────────────

export class WeavileScannerAgent extends Agent<Env, WeavileScannerState> {
  initialState: WeavileScannerState = {
    scanners: [],
    pendingStealths: [],
    completedSweeps: [],
  };

  /** Default event sources — overridable in tests via `setEventSources`.
   *  Wired from env:
   *    - EthAnnouncerSource uses `ALCHEMY_ETH_URL`; no URL ⇒ webhook-only
   *    - SuiAnnouncerSource uses `SUIAMI_WEAVILE_PKG` + `SUI_GRAPHQL_URL`
   *    - SolAnnouncerSource is a logging stub until Quick Attack Sol lands */
  private _sources: ChainEventSource[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._sources = [
      new EthAnnouncerSource(env.ALCHEMY_ETH_URL),
      new SuiAnnouncerSource(
        env.SUIAMI_WEAVILE_PKG ?? null,
        env.SUI_GRAPHQL_URL ?? 'https://graphql.mainnet.sui.io/graphql',
      ),
      new SolAnnouncerSource(),
    ];
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runScannerAlarm();
    };
  }

  /** Test-only hook — swap in fake sources. Not @callable. */
  setEventSources(sources: ChainEventSource[]): void {
    this._sources = sources;
  }

  // ─── Callables ─────────────────────────────────────────────────────

  /** Add a scanner subscription for `recipientSuiAddr`.
   *  Admin-gated; mainnet-only. Replaces any existing subscription for
   *  the same recipient (i.e. key rotation is an upsert, not append). */
  @callable()
  async subscribe(params: {
    recipientSuiAddr: string;
    viewKeyShares: Record<string, string>;
    spendPubkeys: Record<string, string>;
    auth: AdminAuth;
  }): Promise<{ success: boolean; error?: string }> {
    if (!isMainnetEnv(this.env)) {
      return { success: false, error: 'WeavileScanner is mainnet-only — this worker is on a non-mainnet network' };
    }
    const denial = await this._requireAdmin(params.auth, `subscribe:${params.recipientSuiAddr}`);
    if (denial) return { success: false, error: denial };

    // Validate chain coverage: every view key must have a matching
    // spend pub (and vice versa). A mismatched chain set would silently
    // skip events; fail loud instead.
    const viewChains = new Set(Object.keys(params.viewKeyShares));
    const spendChains = new Set(Object.keys(params.spendPubkeys));
    for (const ch of viewChains) {
      if (!spendChains.has(ch)) {
        return { success: false, error: `chain "${ch}" has view key but no spend pub` };
      }
      if (!CHAIN_TO_CURVE[ch]) {
        return { success: false, error: `unknown chain "${ch}" — not in CHAIN_TO_CURVE` };
      }
    }
    for (const ch of spendChains) {
      if (!viewChains.has(ch)) {
        return { success: false, error: `chain "${ch}" has spend pub but no view key` };
      }
    }

    const pruned = this.state.scanners.filter(
      s => s.recipientSuiAddr !== params.recipientSuiAddr,
    );
    const entry: ScannerSubscription = {
      recipientSuiAddr: params.recipientSuiAddr,
      viewKeyShares: { ...params.viewKeyShares },
      spendPubkeys: { ...params.spendPubkeys },
      lastScanMs: 0,
      chainCursors: {},
    };
    this.setState({ ...this.state, scanners: [...pruned, entry] });
    this._scheduleScannerAlarm();
    return { success: true };
  }

  /** Remove a subscription. Pending stealths for this recipient are
   *  left in place — they're already-detected sightings and the sweep
   *  is still valuable. Only the forward scan stops. */
  @callable()
  async unsubscribe(params: {
    recipientSuiAddr: string;
    auth: AdminAuth;
  }): Promise<{ success: boolean; error?: string }> {
    const denial = await this._requireAdmin(params.auth, `unsubscribe:${params.recipientSuiAddr}`);
    if (denial) return { success: false, error: denial };
    this.setState({
      ...this.state,
      scanners: this.state.scanners.filter(s => s.recipientSuiAddr !== params.recipientSuiAddr),
    });
    return { success: true };
  }

  /** Debug dump — admin-gated because view privs are in state. */
  @callable()
  async poke(params: { auth: AdminAuth }): Promise<{
    scanners: number;
    pending: number;
    completed: number;
    state: WeavileScannerState;
  } | { error: string }> {
    const denial = await this._requireAdmin(params.auth, 'poke');
    if (denial) return { error: denial };
    return {
      scanners: this.state.scanners.length,
      pending: this.state.pendingStealths.length,
      completed: this.state.completedSweeps.length,
      state: this.state,
    };
  }

  /** Public status — counts only, no addresses / no keys. */
  @callable()
  async status(): Promise<{
    scanners: number;
    pending: number;
    completed: number;
    lastSweepMs: number | null;
  }> {
    const lastSweepMs = this.state.completedSweeps.length > 0
      ? this.state.completedSweeps[this.state.completedSweeps.length - 1].executedAtMs
      : null;
    return {
      scanners: this.state.scanners.length,
      pending: this.state.pendingStealths.length,
      completed: this.state.completedSweeps.length,
      lastSweepMs,
    };
  }

  /** Feed a single announcement event through the scan loop.
   *  Called by:
   *    - `tick()` via ChainEventSource.pollSince batches (poll path)
   *    - webhook HTTP handler (Metal Claw — Alchemy/Helius push path)
   *
   *  For each subscribed recipient: view-tag fast-path → on hit,
   *  ECDH + tweak → compare derived stealth pub's chain-native address
   *  against the announced `stealthAddr`. Match → enqueue into
   *  `pendingStealths`.
   *
   *  Per-address encoding (keccak-tail / blake2b / base58) is left to
   *  the sweep (Metal Claw) — for Pursuit we trust the announcement's
   *  `stealthAddr` field as the match target. On view-tag hit we enqueue
   *  unconditionally; sweep-time verification rejects impostors
   *  (`derived_pub → addr must equal announcement.stealth_addr`). */
  @callable()
  async onAnnouncementEvent(params: {
    event: AnnouncementEvent;
    auth?: AdminAuth;
  }): Promise<{ matched: number; skipped: number }> {
    // Auth is optional here because this path is the webhook fan-in.
    // Metal Claw will add provider-HMAC verification at the HTTP
    // router layer; when auth is supplied we still verify it.
    if (params.auth) {
      const denial = await this._requireAdmin(params.auth, `onAnnouncementEvent:${params.event.chain}`);
      if (denial) return { matched: 0, skipped: 0 };
    }
    const { event } = params;
    if (!event || !event.chain || !event.ephemeralPubHex) {
      return { matched: 0, skipped: 0 };
    }
    let matched = 0;
    let skipped = 0;
    const curve = curveForChain(event.chain);
    const now = Date.now();
    const newPending: PendingStealth[] = [];
    for (const sub of this.state.scanners) {
      const viewPriv = sub.viewKeyShares[event.chain];
      const spendPub = sub.spendPubkeys[event.chain];
      if (!viewPriv || !spendPub) { skipped += 1; continue; }
      let result;
      try {
        result = deriveStealthForEvent({
          ephemeralPub: event.ephemeralPubHex,
          viewTag: event.viewTag,
          viewPriv,
          spendPub,
          curve,
        });
      } catch (err) {
        console.warn(`[WeavileScanner:${this.name}] derive error for ${sub.recipientSuiAddr}/${event.chain}:`, err);
        skipped += 1;
        continue;
      }
      if (!result.matched) { skipped += 1; continue; }
      matched += 1;
      newPending.push({
        recipientSuiAddr: sub.recipientSuiAddr,
        chain: event.chain,
        stealthAddr: event.stealthAddr,
        ephemeralPubHex: event.ephemeralPubHex,
        tweakHex: result.tweakHex,
        announcementDigest: event.announcementDigest,
        detectedMs: now,
        schemeId: event.schemeId,
      });
    }
    if (newPending.length) {
      this.setState({
        ...this.state,
        pendingStealths: [...this.state.pendingStealths, ...newPending],
      });
      this._scheduleScannerAlarm();
    }
    return { matched, skipped };
  }

  /** Alarm-driven batch processor. Two jobs:
   *    1. Poll each ChainEventSource for new announcements, fan through
   *       `onAnnouncementEvent` to build up pendingStealths.
   *    2. Drain pendingStealths in batches of `TICK_BATCH_MAX`, handing
   *       each off to Metal Claw's sweep ceremony (stubbed here).
   *
   *  Metal Claw will replace the stub sweep with real IKA signing +
   *  submit + append to `completedSweeps`. For Pursuit, we just count
   *  batch work and re-queue leftover. */
  @callable()
  async tick(): Promise<{
    polled: number;
    processed: number;
    batchSize: number;
    jitterMs: number;
  }> {
    // ─── Poll sources ──────────────────────────────────────────────
    let polled = 0;
    for (const source of this._sources) {
      // Use the max cursor across all subscriptions for this chain —
      // one DO serves multiple recipients but shares one feed per
      // chain. A lagging subscription just re-processes old events
      // through the fast-path; view-tag mismatch drops the cost.
      let cursor = 0;
      for (const sub of this.state.scanners) {
        cursor = Math.max(cursor, sub.chainCursors[source.chain] ?? 0);
      }
      let events: AnnouncementEvent[] = [];
      try {
        events = await source.pollSince(cursor);
      } catch (err) {
        console.warn(`[WeavileScanner:${this.name}] ${source.chain} pollSince error:`, err);
        continue;
      }
      polled += events.length;
      for (const ev of events) {
        try {
          await this.onAnnouncementEvent({ event: ev });
        } catch (err) {
          console.warn(`[WeavileScanner:${this.name}] onAnnouncementEvent error:`, err);
        }
      }
    }

    // ─── Drain pendingStealths ────────────────────────────────────
    const batch = this.state.pendingStealths.slice(0, TICK_BATCH_MAX);
    const rest = this.state.pendingStealths.slice(TICK_BATCH_MAX);
    const jitterMs = pickScanJitterMs();

    if (batch.length > 0) {
      // TODO(Metal Claw + Icy Wind): for each PendingStealth, kick off
      // an IKA sweep ceremony against `stealthAddr` using the dWallet
      // that owns `spendPub`. On success, append to completedSweeps
      // and drop from pending. Until then, we leave batch in-place so
      // Metal Claw can pick up where we left off.
      console.log(
        `[WeavileScanner:${this.name}] tick() — stub sweep for ${batch.length} pending stealth(s); jitter=${jitterMs}ms`,
      );
    }

    this.setState({ ...this.state, pendingStealths: rest.concat(batch) });
    this._scheduleScannerAlarm();
    return {
      polled,
      processed: batch.length,
      batchSize: batch.length,
      jitterMs,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────

  /** Admin auth — verifies personal-message signature against the ultron
   *  admin allowlist. Mirrors sneasel-watcher._requireAdmin verbatim. */
  private async _requireAdmin(auth: AdminAuth | undefined, op: string): Promise<string | null> {
    if (!auth?.adminAddress || !auth.signature || !auth.message) {
      return 'Missing adminAddress, signature, or message';
    }
    const { ADMIN_ADDRESSES, todayUtc } = await import('../ultron-policy.js');
    const normalized = auth.adminAddress.toLowerCase();
    if (!ADMIN_ADDRESSES.has(normalized)) {
      return `${auth.adminAddress} not in admin allowlist`;
    }
    const expected = `weavile-scanner:${op}:${todayUtc()}`;
    if (auth.message !== expected) {
      return `message must be exactly "${expected}"`;
    }
    try {
      const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
      const messageBytes = new TextEncoder().encode(auth.message);
      await verifyPersonalMessageSignature(messageBytes, auth.signature, { address: normalized });
    } catch (err) {
      return `Invalid signature: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }

  private async _runScannerAlarm(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      console.error(`[WeavileScanner:${this.name}] alarm error:`, err);
    } finally {
      this._scheduleScannerAlarm();
    }
  }

  private _trimCompleted() {
    if (this.state.completedSweeps.length <= COMPLETED_HISTORY_MAX) return;
    const trimmed = this.state.completedSweeps.slice(-COMPLETED_HISTORY_MAX);
    this.setState({ ...this.state, completedSweeps: trimmed });
  }

  private _scheduleScannerAlarm() {
    this._trimCompleted();
    const now = Date.now();
    const next = now + SCAN_INTERVAL_MS;
    this.ctx.storage.setAlarm(Math.max(next, now + 1_000));
  }

  // ─── Debug surface (pure, exported for tests) ─────────────────────

  static shortenAddr(addr: string): string {
    return shortenAddr(addr);
  }
}
