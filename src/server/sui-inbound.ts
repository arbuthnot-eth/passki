/**
 * Sui inbound watcher — Aggron Harden pt1 (Sui leg).
 *
 * Sibling to `eth-inbound.ts`. Parses Sui checkpoint / balance-change
 * payloads, keeps only transfers landing at sui@ultron, and decodes
 * sub-cent intent tags from the trailing decimal digits of the amount.
 *
 * No DO state — pure helpers, unit-test friendly. The inbound router
 * (AggronBatcher / UltronSigningAgent) consumes the output.
 *
 * ─── Intent-tag scheme (v1) ───────────────────────────────────────────
 *
 * For USDC (6 decimals), iUSD (9 decimals), SUI (9 decimals), WAL (9
 * decimals): the **last 5 decimal digits** of the raw coin amount
 * encode intent.
 *
 *   Digit index (from the right, 0-based):
 *     [4] — chain tag:   0=sui, 1=eth, 2=sol, 3=btc  (0–9)
 *     [3..0] — recipient registry index  (0000–9999)
 *
 * Total encodable states: 10 × 10_000 = 100_000. Zero tail
 * (all 5 digits == 0) means "no intent — funds stay at ultron".
 *
 * For 9-decimal coins the tag lives in the lowest 5 decimal places
 * (nanoscale dust — sub-cent for SUI at current prices). For USDC
 * (6 decimals) the tag occupies 5 of the 6 fractional digits; the
 * sender chooses amounts like `10.000042` (USDC = 10.000042, chain
 * tag 0=sui, recipient 0042).
 *
 * Rationale for picking this over the existing `subcent-tag.ts`
 * 6/8-digit scheme: Aggron's router only needs two pieces of info
 * per deposit — **which chain** and **which recipient**. Collapsing
 * route/action/nonce into a flat 5-digit (chain + recipient) keeps
 * the math trivial and matches the memory/project_aggron_batcher.md
 * direction. The richer scheme stays available for other producers.
 */

export const SUI_ULTRON_ADDRESS =
  '0x9872c1f5edf4daffbdcf5f577567ce997a00db9d63a8a8fac4feb8b135b285f7';

/** Canonical coin types we recognize for intent decoding. Other types
 *  are still surfaced by `extractInboundToUltron` but `decodeSubcentIntent`
 *  treats unknown types conservatively (9-decimal default). */
export const SUI_COIN_TYPE = '0x2::sui::SUI';
export const WAL_COIN_TYPE =
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL';
export const USDC_COIN_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const IUSD_COIN_TYPE =
  '0xf62ecf7f1a53b3e57a8f8e93b8cce7f68bcad3e5e0c7a9e00000000000000000::iusd::IUSD';

/** Chain tag top-digit values for the 5-digit intent scheme. */
export const CHAIN_TAG = {
  SUI: 0,
  ETH: 1,
  SOL: 2,
  BTC: 3,
} as const;
export type ChainTag = typeof CHAIN_TAG[keyof typeof CHAIN_TAG];

/** Intent tag width in decimal digits. */
export const INTENT_WIDTH = 5;
/** 10^INTENT_WIDTH — mod for extracting the tag. */
export const INTENT_MOD = 100_000n;
/** 10^(INTENT_WIDTH-1) — divisor to get the top (chain) digit. */
export const INTENT_CHAIN_DIV = 10_000n;

/**
 * Minimal, normalized shape of an inbound transfer to sui@ultron.
 *
 * `amountMist` is the raw on-chain coin amount at its native decimal
 * precision (so SUI/WAL/iUSD carry 9 decimals, USDC carries 6). The
 * name "mist" follows Sui conventions even for non-SUI coins — the
 * field is the coin's base-unit integer.
 */
export interface SuiInboundActivity {
  digest: string;
  fromAddress: string;
  toAddress: string;
  coinType: string;
  amountMist: bigint;
  timestampMs: number;
}

export interface DecodedIntent {
  rawAmount: bigint;
  /** 0-99999. Encodes chain tag (top digit) + recipient index (lower 4). */
  intentCode: number;
  /** Recipient registry index in 0000–9999. */
  recipientIndex: number;
  /** Chain tag in 0–9 (see CHAIN_TAG). */
  chainTag: number;
  /** Raw amount with the tag digits zeroed. */
  baseAmount: bigint;
  /** True iff the 5-digit tail is non-zero. */
  hasIntent: boolean;
}

// ─── Checkpoint parsing ───────────────────────────────────────────────

/**
 * Loose shape of the pieces of a Sui checkpoint we consume. We accept
 * either:
 *   - `{ balanceChanges: [...] }` — a single tx-effects-like object
 *   - `{ transactions: [{ balanceChanges: [...] }, ...] }` — a batch
 *   - `{ checkpoint: { transactions: [...] } }` — nested
 *
 * Unknown shapes yield an empty array rather than throwing; the watcher
 * can log and move on.
 */
interface RawBalanceChange {
  owner?: unknown;
  coinType?: string;
  amount?: string | number;
}

interface RawTx {
  digest?: string;
  timestampMs?: number | string;
  balanceChanges?: RawBalanceChange[];
  effects?: { balanceChanges?: RawBalanceChange[] };
  sender?: string;
}

function extractOwnerAddress(owner: unknown): string | null {
  if (!owner) return null;
  if (typeof owner === 'string') return owner;
  if (typeof owner === 'object') {
    const o = owner as Record<string, unknown>;
    if (typeof o.AddressOwner === 'string') return o.AddressOwner;
    if (typeof o.ObjectOwner === 'string') return o.ObjectOwner;
    if (typeof o.address === 'string') return o.address;
  }
  return null;
}

function collectTxs(checkpoint: unknown): RawTx[] {
  if (!checkpoint || typeof checkpoint !== 'object') return [];
  const cp = checkpoint as Record<string, unknown>;
  if (Array.isArray(cp.transactions)) return cp.transactions as RawTx[];
  if (cp.checkpoint && typeof cp.checkpoint === 'object') {
    const inner = cp.checkpoint as Record<string, unknown>;
    if (Array.isArray(inner.transactions)) return inner.transactions as RawTx[];
  }
  // Single-tx shape — treat the whole thing as one tx.
  if (Array.isArray(cp.balanceChanges) || cp.effects) return [cp as RawTx];
  return [];
}

/**
 * Pull inbound transfers landing at sui@ultron from a Sui checkpoint
 * or tx-effects payload. Only positive balance changes (credits) to
 * ultron's address are kept. The shape of `checkpoint` is intentionally
 * loose so we can feed this from gRPC streams, GraphQL subscriptions,
 * or webhook payloads without coupling to one provider's schema.
 */
export function extractInboundToUltron(checkpoint: unknown): SuiInboundActivity[] {
  const txs = collectTxs(checkpoint);
  const ultron = SUI_ULTRON_ADDRESS.toLowerCase();
  const out: SuiInboundActivity[] = [];

  for (const tx of txs) {
    const changes =
      tx.balanceChanges ?? tx.effects?.balanceChanges ?? [];
    const digest = typeof tx.digest === 'string' ? tx.digest : '';
    const timestampMs =
      typeof tx.timestampMs === 'string'
        ? Number(tx.timestampMs)
        : typeof tx.timestampMs === 'number'
          ? tx.timestampMs
          : 0;
    const sender = typeof tx.sender === 'string' ? tx.sender : '';

    for (const ch of changes) {
      const ownerAddr = extractOwnerAddress(ch.owner);
      if (!ownerAddr || ownerAddr.toLowerCase() !== ultron) continue;
      const coinType = typeof ch.coinType === 'string' ? ch.coinType : '';
      if (!coinType) continue;
      let amt: bigint;
      try {
        amt = BigInt(ch.amount ?? 0);
      } catch {
        continue;
      }
      if (amt <= 0n) continue; // only inbound credits
      out.push({
        digest,
        fromAddress: sender,
        toAddress: ownerAddr,
        coinType,
        amountMist: amt,
        timestampMs,
      });
    }
  }

  return out;
}

// ─── Intent decode ────────────────────────────────────────────────────

/**
 * Decode a sub-cent intent from a raw coin amount. Works identically
 * for all supported coin types — the math is decimal-agnostic because
 * the tag lives in the lowest 5 decimal digits regardless of the
 * coin's native precision.
 *
 * `coinType` is accepted (and returned to callers via logs) but does
 * not change the decode: this keeps the helper pure and deterministic.
 */
export function decodeSubcentIntent(amountMist: bigint, _coinType: string): DecodedIntent {
  const tail = Number(amountMist % INTENT_MOD);
  const chainTag = Math.floor(tail / Number(INTENT_CHAIN_DIV));
  const recipientIndex = tail % Number(INTENT_CHAIN_DIV);
  const hasIntent = tail !== 0;
  const baseAmount = amountMist - BigInt(tail);
  return {
    rawAmount: amountMist,
    intentCode: tail,
    chainTag,
    recipientIndex,
    baseAmount,
    hasIntent,
  };
}

// ─── Recipient lookup ─────────────────────────────────────────────────

/**
 * Thin wrapper that resolves a decoded intent into a recipient SUIAMI
 * identity (e.g. `"athena.sui"` or a raw address). Kept deliberately
 * minimal so the network-side roster lookup lives in its own module
 * and this file stays unit-testable.
 *
 * In tests, inject `rosterLookup` to return fixed values. In prod,
 * the Worker resolves against the IntentRegistry DO via
 * `rosterLookupFromRegistry` (see `agents/intent-registry.ts`) — the
 * DO binding isn't reachable from this pure-helper module, so callers
 * pass the live lookup in. The no-arg path returns null (fail-closed).
 */
export async function lookupRecipientByIntent(
  intentCode: number,
  chainTag: string,
  rosterLookup?: (recipientIndex: number, chainTag: string) => Promise<string | null>,
): Promise<string | null> {
  if (intentCode <= 0) return null;
  const recipientIndex = intentCode % Number(INTENT_CHAIN_DIV);
  if (recipientIndex === 0) return null;
  if (!rosterLookup) return null;
  return rosterLookup(recipientIndex, chainTag);
}

/** Helper: map a ChainTag number back to its string name. */
export function chainTagName(tag: number): 'sui' | 'eth' | 'sol' | 'btc' | 'unknown' {
  switch (tag) {
    case CHAIN_TAG.SUI:
      return 'sui';
    case CHAIN_TAG.ETH:
      return 'eth';
    case CHAIN_TAG.SOL:
      return 'sol';
    case CHAIN_TAG.BTC:
      return 'btc';
    default:
      return 'unknown';
  }
}
