/**
 * Sub-cent intent tag schema — Phase 2 (Porygon2 Lv. 62).
 *
 * Routes metadata through the trailing decimal digits of a payment
 * amount. Two widths are supported:
 *
 *   6-digit (USDC, 6 decimals): `RAANNN`
 *     ┌── 1 digit route    (0-9)
 *     │┌─ 2 digits action  (00-99)
 *     ││ ┌ 3 digits nonce  (000-999)
 *     RAANNN                                  ← 1,000,000 total buckets
 *
 *   8-digit (iUSD / SOL, 9 decimals): `RRAANNNN`
 *     ┌── 2 digits route   (00-99)
 *     │ ┌ 2 digits action  (00-99)
 *     │ │┌ 4 digits nonce  (0000-9999)
 *     RRAANNNN                                ← 100,000,000 total buckets
 *
 * Why asymmetric: USDC's 6-decimal constraint caps its tag width.
 * iUSD / SOL at 9 decimals can carry a wider tag without polluting
 * the integer portion. The parser tries 8-digit first and falls
 * back to 6-digit if the high 2 digits are all zero — safe because
 * a legitimate 8-digit tag with route=00 and action=00 aliases to
 * a 6-digit tag with route=0, action=00, which is the default
 * iusd-cache path either way.
 *
 * Backward compatibility: every Phase-1 (6-digit) tag deserializes
 * cleanly under Phase 2 as `{route:0, action:0, nonce}` since the
 * upper bit-groups are zero. Existing clients don't need to change.
 */

// ─── Routes ──────────────────────────────────────────────────────────

/** Route = top-level action category. 1-digit on USDC, 2-digit on iUSD/SOL. */
export const ROUTES = {
  /** Mint iUSD against the deposit, hold in ultron cache. Default for
   *  every pre-Phase-2 tag. */
  IUSD_CACHE: 0,
  /** Run IKA DKG for the target address's squids. */
  RUMBLE: 1,
  /** Post / fill a Quest bounty for name registration. */
  QUEST: 2,
  /** Create a Shade grace-period order. */
  SHADE: 3,
  /** Place a DeepBook limit order (Phase 3 OpenCLOB hook). */
  DEEPBOOK: 4,
  /** Seal-encrypt + send a thunder to the target. */
  STORM: 5,
  /** Flash-borrow NS via Satellite → register → repay in deposit. */
  SATELLITE: 6,
  /** Straight transfer to the target Sui address. */
  PAY: 7,
  /** Deposit on one chain triggers iUSD SPL mint on another chain. */
  CROSS_CHAIN_MINT: 8,
  /** Reserved for future routes. Reject unknown on match. */
  RESERVED: 9,
} as const;

export type RouteCode = typeof ROUTES[keyof typeof ROUTES];

/** Human-readable names for logs + error messages. */
export const ROUTE_NAMES: Record<number, string> = {
  0: 'iusd-cache',
  1: 'rumble',
  2: 'quest',
  3: 'shade',
  4: 'deepbook',
  5: 'storm',
  6: 'satellite',
  7: 'pay',
  8: 'cross-chain-mint',
  9: 'reserved',
};

export function routeName(code: number): string {
  return ROUTE_NAMES[code] ?? `unknown(${code})`;
}

// ─── Tag width ────────────────────────────────────────────────────────

/** Tag widths in sub-cent digits (== number of trailing decimal digits). */
export type TagWidth = 6 | 8;

/** Max value at each width. */
const WIDTH_MOD: Record<TagWidth, number> = {
  6: 1_000_000,
  8: 100_000_000,
};

/** Per-width bit layout. See header diagram. */
interface TagLayout {
  routeDigits: number;
  actionDigits: number;
  nonceDigits: number;
}

const LAYOUT: Record<TagWidth, TagLayout> = {
  6: { routeDigits: 1, actionDigits: 2, nonceDigits: 3 },
  8: { routeDigits: 2, actionDigits: 2, nonceDigits: 4 },
};

// ─── Encode / decode ──────────────────────────────────────────────────

export interface DecodedTag {
  /** Numeric route code (0–9 at width 6, 0–99 at width 8). */
  route: number;
  /** Numeric action code (0–99 either width). */
  action: number;
  /** Nonce value (0–999 at width 6, 0–9999 at width 8). */
  nonce: number;
  /** Width the tag was encoded at. */
  width: TagWidth;
}

/** Compose a tag value from its parts. Throws on out-of-range inputs
 *  so a typo becomes visible rather than silently truncating. */
export function encodeTag(parts: {
  route: number;
  action: number;
  nonce: number;
  width: TagWidth;
}): number {
  const { route, action, nonce, width } = parts;
  const L = LAYOUT[width];
  const routeMax = 10 ** L.routeDigits;
  const actionMax = 10 ** L.actionDigits;
  const nonceMax = 10 ** L.nonceDigits;
  if (route < 0 || route >= routeMax) {
    throw new Error(`encodeTag: route ${route} out of range (0..${routeMax - 1})`);
  }
  if (action < 0 || action >= actionMax) {
    throw new Error(`encodeTag: action ${action} out of range (0..${actionMax - 1})`);
  }
  if (nonce < 0 || nonce >= nonceMax) {
    throw new Error(`encodeTag: nonce ${nonce} out of range (0..${nonceMax - 1})`);
  }
  return route * actionMax * nonceMax + action * nonceMax + nonce;
}

/** Parse a tag into its parts at a given width. Pure function — no
 *  I/O, no validation against ROUTES. The caller is responsible for
 *  checking whether the decoded route is recognized. */
export function decodeTag(tag: number, width: TagWidth): DecodedTag {
  const L = LAYOUT[width];
  const actionMax = 10 ** L.actionDigits;
  const nonceMax = 10 ** L.nonceDigits;
  const route = Math.floor(tag / (actionMax * nonceMax));
  const action = Math.floor(tag / nonceMax) % actionMax;
  const nonce = tag % nonceMax;
  return { route, action, nonce, width };
}

/**
 * Extract the tag from a raw coin balance (units at the coin's
 * decimal precision) at a given width. For 6-digit tags on 6-decimal
 * USDC: `balance % 1_000_000`. For 8-digit on 9-decimal iUSD: the
 * lower 8 digits are the tag and the 9th (ones place) is rounding
 * slack ignored by the match — so `Math.floor(balance / 10) % 1e8`.
 *
 * `decimals` is the coin's decimal count (6 for USDC, 9 for iUSD/SOL).
 */
export function extractTagFromBalance(balance: bigint, decimals: number, width: TagWidth): number {
  // Shift away the slack digits between the tag width and the coin's
  // decimal count. For USDC (6 decimals, 6-digit tag) we shift 0.
  // For iUSD (9 decimals, 8-digit tag) we shift 1 — the 9th decimal
  // is a "jitter" slot that absorbs FX-style rounding.
  const slack = BigInt(decimals - width);
  const shift = slack > 0n ? 10n ** slack : 1n;
  const mod = BigInt(WIDTH_MOD[width]);
  return Number((balance / shift) % mod);
}

/** Format a tag as a fixed-width zero-padded string for display /
 *  URL composition. */
export function formatTag(tag: number, width: TagWidth): string {
  return String(tag).padStart(width, '0');
}

// ─── Amount composition ───────────────────────────────────────────────

/**
 * Given a user's target USD amount, a tag value, and a coin's decimal
 * count + tag width, return the raw coin balance the user must send.
 *
 * Example: $10 payment in USDC (6 decimals, 6-digit tag 006296) →
 *   returns `10_006_296` (i.e. 10.006296 USDC).
 *
 * Example: $7.77 payment in iUSD (9 decimals, 8-digit tag 00620045) →
 *   returns `7_770_062_0045` with the 9th decimal `0` as slack
 *   rendering as `7.770062004` iUSD.
 */
export function composeAmount(
  amountUsd: number,
  tag: number,
  decimals: number,
  width: TagWidth,
): bigint {
  // Base: USD rounded to the nearest whole unit of the tag carrier
  // (e.g. for USDC at width 6, "whole unit" = 1 USDC = 10^6 raw).
  // Floor the USD to the carrier's integer precision, then add the
  // tag value at the decimal offset.
  const slack = BigInt(decimals - width);
  const shift = slack > 0n ? 10n ** slack : 1n;
  const wholeUnits = BigInt(Math.floor(amountUsd));
  const whole = wholeUnits * 10n ** BigInt(decimals);
  const tagBig = BigInt(tag) * shift;
  return whole + tagBig;
}

/** Render a raw coin balance at a given decimal count as a
 *  human-readable decimal string. No trailing-zero trimming so the
 *  tag digits stay visible. */
export function formatAmount(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

// ─── Address → nonce derivation ───────────────────────────────────────

/**
 * Derive a reproducible nonce from a Sui address hash so re-requesting
 * a tag for the same address returns the same number (as long as no
 * collision forces a perturbation). The caller decides the width.
 *
 * For width 6 → takes 3 digits (0-999).
 * For width 8 → takes 4 digits (0-9999).
 */
export async function deriveNonceFromAddress(address: string, width: TagWidth): Promise<number> {
  const nonceDigits = LAYOUT[width].nonceDigits;
  const nonceMax = 10 ** nonceDigits;
  const bytes = new TextEncoder().encode(address);
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const hashArr = new Uint8Array(hashBuf);
  // Interpret the first 4 bytes as a big-endian uint32 and mod into
  // the nonce range — uniform distribution.
  const u32 = (hashArr[0] << 24) | (hashArr[1] << 16) | (hashArr[2] << 8) | hashArr[3];
  return Math.abs(u32) % nonceMax;
}

// ─── Parse incoming deposit tag ───────────────────────────────────────

/**
 * Try to interpret an incoming deposit balance as a tagged intent.
 * Returns the decoded tag at whichever width matches a recognized
 * route, or null if the balance carries no valid tag.
 *
 * Strategy: try 8-digit first (wider scheme takes precedence); if
 * its decoded route isn't recognized, fall back to 6-digit (the
 * Phase 1 format). This makes upgrades seamless — new clients can
 * mint 8-digit tags, old clients keep using 6-digit, both paths
 * match against the same intent table.
 */
export function parseIncomingTag(
  balance: bigint,
  decimals: number,
  recognizedRoutes: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]),
): DecodedTag | null {
  // 8-digit attempt — only meaningful if the coin has at least 8
  // decimal digits of tag room (i.e. decimals >= 8).
  if (decimals >= 8) {
    const tag8 = extractTagFromBalance(balance, decimals, 8);
    const dec8 = decodeTag(tag8, 8);
    if (recognizedRoutes.has(dec8.route)) return dec8;
  }
  // 6-digit fallback — all coins with >= 6 decimals carry this.
  if (decimals >= 6) {
    const tag6 = extractTagFromBalance(balance, decimals, 6);
    const dec6 = decodeTag(tag6, 6);
    if (recognizedRoutes.has(dec6.route)) return dec6;
  }
  return null;
}
