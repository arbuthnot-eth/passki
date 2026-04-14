// Volcarodon PSM — 1:1 iUSD ↔ USDC client PTB builders.
//
// Contract: contracts/volcarodon/sources/psm.move
// Package:  0xe0e0113e44c38ef5cfbbac826cfff0cf0438109b0358b0039aca8d183065f5af
// Reserve:  0x62fcd184ef68d7267e4cf45f8af5ff7f23511c4741f26674875e691389ca264c
// Admin:    plankton.sui (0x3db4…bb57) — can set_fee (capped 10%) + withdraw_fees
//
// Structural properties verified against source:
//   - No DeepBook, no BalanceManager — burn path is a direct coin::burn +
//     balance::split inside a single Move call. Cannot hit the BM black-hole
//     pattern described in CLAUDE.md.
//   - Principal is protected: admin's withdraw_fees only touches
//     reserve.collected_fee, not reserve.s_balance.
//   - TreasuryCap<IUSD> is wrapped permanently in the shared Reserve — no
//     escape hatch for a compromised admin to rug-mint.
//
// Pricing: 1:1 minus `fee_bps` (currently 50 bps). Mint grows the reserve
// by the fee portion; burn drains the reserve at 1:1 net of fee.

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { grpcClient } from '../rpc.js';

export const PSM_PACKAGE = '0xe0e0113e44c38ef5cfbbac826cfff0cf0438109b0358b0039aca8d183065f5af';
export const PSM_RESERVE = '0x62fcd184ef68d7267e4cf45f8af5ff7f23511c4741f26674875e691389ca264c';
/** Initial shared version of the Reserve, verified on-chain via
 *  sui_getObject showOwner. Hardcoded so PTB builds don't need a
 *  network round-trip to resolve the shared object ref, which lets
 *  both browser and worker callers build offline (including ultron's
 *  keeper-signed round-trip smoke test). */
export const PSM_RESERVE_INITIAL_SHARED_VERSION = 843442664;
export const PSM_MODULE  = 'psm';

export const IUSD_TYPE = '0x2c5653668edefe2a782bf755e02bda56149e7b65b56f6245fb75b718941d2ec9::iusd::IUSD';
export const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

const PSM_TYPE_ARGS: [string, string] = [IUSD_TYPE, USDC_TYPE];

const IUSD_DECIMALS = 9;
const USDC_DECIMALS = 6;
const DECIMAL_SCALE = 10n ** BigInt(IUSD_DECIMALS - USDC_DECIMALS); // 1000

/** Snapshot of the Reserve object's on-chain state, fetched via JSON-RPC.
 *  Kept raw (mist units) so callers can do their own formatting. */
export interface ReserveState {
  sBalanceMist: bigint;      // USDC reserve (quote), 6 decimals
  collectedFeeMist: bigint;  // fees accrued in USDC, admin-withdrawable
  feeBps: number;            // 50 = 0.5%
  totalTBurned: bigint;      // iUSD burned through this reserve, 9 decimals
  totalTMinted: bigint;      // iUSD minted through this reserve, 9 decimals
  totalSIn: bigint;          // USDC deposited through mints, 6 decimals
  totalSOut: bigint;         // USDC paid out through burns, 6 decimals
  admin: string;
}

const RPC_URLS = [
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc.ankr.com/sui',
];

/** Fetch the Reserve's live state via JSON-RPC. Races across the fallback
 *  URL list so a single dead RPC doesn't block the pre-flight check. */
export async function queryReserveState(): Promise<ReserveState> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'sui_getObject',
    params: [PSM_RESERVE, { showContent: true }],
  });
  let lastErr: unknown;
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const j = await r.json() as any;
      const fields = j?.result?.data?.content?.fields;
      if (!fields) throw new Error('reserve fetch: empty fields');
      return {
        sBalanceMist:    BigInt(fields.s_balance ?? '0'),
        collectedFeeMist: BigInt(fields.collected_fee ?? '0'),
        feeBps:          Number(fields.fee_bps ?? '0'),
        totalTBurned:    BigInt(fields.total_t_burned ?? '0'),
        totalTMinted:    BigInt(fields.total_t_minted ?? '0'),
        totalSIn:        BigInt(fields.total_s_in ?? '0'),
        totalSOut:       BigInt(fields.total_s_out ?? '0'),
        admin:           String(fields.admin ?? ''),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`queryReserveState: all RPCs failed (${lastErr instanceof Error ? lastErr.message : lastErr})`);
}

/** Convert iUSD mist → USDC mist at 1:1 peg, then subtract the fee.
 *  Mirrors `convert_t_to_s` in psm.move line-for-line so the pre-flight
 *  check produces the same u64 arithmetic as the on-chain contract. */
export function quoteBurnOutUsdcMist(iusdMist: bigint, feeBps: number): bigint {
  const base = iusdMist / DECIMAL_SCALE;
  return (base * BigInt(10000 - feeBps)) / 10000n;
}

/** Convert USDC mist → iUSD mist at 1:1 peg, then subtract the fee.
 *  Mirrors `convert_s_to_t` in psm.move. */
export function quoteMintOutIusdMist(usdcMist: bigint, feeBps: number): bigint {
  const base = usdcMist * DECIMAL_SCALE;
  return (base * BigInt(10000 - feeBps)) / 10000n;
}

/** Returns the maximum iUSD (in mist) that the Reserve can currently serve
 *  for a burn. Caller divides by 10^9 for a user-facing display. */
export function maxBurnableIusdMist(state: ReserveState): bigint {
  // Given s_balance S and fee_bps f, solve for the largest iusdMist X such
  // that: (X / 1000) * (10000 - f) / 10000 <= S.
  // → X <= S * 10000 * 1000 / (10000 - f)
  const feeFactor = BigInt(10000 - state.feeBps);
  if (feeFactor <= 0n) return 0n;
  return (state.sBalanceMist * 10000n * DECIMAL_SCALE) / feeFactor;
}

/** Shared result shape — raw bytes for non-WaaP, unbuilt Transaction for
 *  WaaP (per feedback_waap_holy_grail.md — WaaP must build server-side
 *  with its own bundled v1 SDK, never consume pre-built v2 bytes). */
export interface PsmTxResult {
  bytes: Uint8Array & { tx?: Transaction; serialize?: () => Uint8Array; toJSON?: () => string };
  tx: Transaction;
}

/** Build a burn_for_usdc PTB. Caller supplies the exact iUSD mist they
 *  want to burn and the tolerated slippage floor on USDC out. The function
 *  merges every supplied iUSD coin into a single input, splits off the
 *  requested burn amount, and returns any remainder to the sender. */
export async function buildPsmBurnTx(opts: {
  sender: string;
  iusdCoinIds: string[];        // all caller-owned Coin<IUSD> object IDs
  iusdAmountMist: bigint;        // exact amount to burn
  minUsdcOutMist: bigint;        // slippage floor — receiver aborts below this
}): Promise<PsmTxResult> {
  if (opts.iusdAmountMist <= 0n) throw new Error('buildPsmBurnTx: amount must be > 0');
  if (opts.iusdCoinIds.length === 0) throw new Error('buildPsmBurnTx: no iUSD coins supplied');
  const addr = normalizeSuiAddress(opts.sender);

  const tx = new Transaction();
  tx.setSender(addr);

  const [primary, ...rest] = opts.iusdCoinIds;
  const primaryArg = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryArg, rest.map(id => tx.object(id)));
  }
  // Split off exactly the burn amount so the Move entry call takes a
  // Coin<IUSD> by value and the remainder stays with the sender.
  const [burnCoin] = tx.splitCoins(primaryArg, [tx.pure.u64(opts.iusdAmountMist)]);
  tx.moveCall({
    target: `${PSM_PACKAGE}::${PSM_MODULE}::burn_for_usdc`,
    typeArguments: PSM_TYPE_ARGS,
    arguments: [
      tx.sharedObjectRef({ objectId: PSM_RESERVE, initialSharedVersion: PSM_RESERVE_INITIAL_SHARED_VERSION, mutable: true }),
      burnCoin,
      tx.pure.u64(opts.minUsdcOutMist),
    ],
  });

  const bytes = await tx.build({ client: grpcClient as never }) as PsmTxResult['bytes'];
  bytes.tx = tx;
  bytes.serialize = () => bytes;
  bytes.toJSON = () => JSON.stringify(Array.from(bytes));
  return { bytes, tx };
}

/** Build a mint_from_usdc PTB. USDC flows in and self-seeds the reserve;
 *  fresh iUSD is minted from the wrapped TreasuryCap and transferred to
 *  the sender. Works from a zero-state reserve. */
export async function buildPsmMintTx(opts: {
  sender: string;
  usdcCoinIds: string[];
  usdcAmountMist: bigint;
  minIusdOutMist: bigint;
}): Promise<PsmTxResult> {
  if (opts.usdcAmountMist <= 0n) throw new Error('buildPsmMintTx: amount must be > 0');
  if (opts.usdcCoinIds.length === 0) throw new Error('buildPsmMintTx: no USDC coins supplied');
  const addr = normalizeSuiAddress(opts.sender);

  const tx = new Transaction();
  tx.setSender(addr);

  const [primary, ...rest] = opts.usdcCoinIds;
  const primaryArg = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryArg, rest.map(id => tx.object(id)));
  }
  const [mintCoin] = tx.splitCoins(primaryArg, [tx.pure.u64(opts.usdcAmountMist)]);
  tx.moveCall({
    target: `${PSM_PACKAGE}::${PSM_MODULE}::mint_from_usdc`,
    typeArguments: PSM_TYPE_ARGS,
    arguments: [
      tx.sharedObjectRef({ objectId: PSM_RESERVE, initialSharedVersion: PSM_RESERVE_INITIAL_SHARED_VERSION, mutable: true }),
      mintCoin,
      tx.pure.u64(opts.minIusdOutMist),
    ],
  });

  const bytes = await tx.build({ client: grpcClient as never }) as PsmTxResult['bytes'];
  bytes.tx = tx;
  bytes.serialize = () => bytes;
  bytes.toJSON = () => JSON.stringify(Array.from(bytes));
  return { bytes, tx };
}

/** Permissionless USDC top-up of the Reserve. Grows s_balance without
 *  minting any iUSD — useful for seeding burn capacity without mint volume. */
export async function buildPsmTopUpTx(opts: {
  sender: string;
  usdcCoinIds: string[];
  usdcAmountMist: bigint;
}): Promise<PsmTxResult> {
  if (opts.usdcAmountMist <= 0n) throw new Error('buildPsmTopUpTx: amount must be > 0');
  if (opts.usdcCoinIds.length === 0) throw new Error('buildPsmTopUpTx: no USDC coins supplied');
  const addr = normalizeSuiAddress(opts.sender);

  const tx = new Transaction();
  tx.setSender(addr);

  const [primary, ...rest] = opts.usdcCoinIds;
  const primaryArg = tx.object(primary);
  if (rest.length > 0) {
    tx.mergeCoins(primaryArg, rest.map(id => tx.object(id)));
  }
  const [contribCoin] = tx.splitCoins(primaryArg, [tx.pure.u64(opts.usdcAmountMist)]);
  tx.moveCall({
    target: `${PSM_PACKAGE}::${PSM_MODULE}::top_up`,
    typeArguments: PSM_TYPE_ARGS,
    arguments: [
      tx.sharedObjectRef({ objectId: PSM_RESERVE, initialSharedVersion: PSM_RESERVE_INITIAL_SHARED_VERSION, mutable: true }),
      contribCoin,
    ],
  });

  const bytes = await tx.build({ client: grpcClient as never }) as PsmTxResult['bytes'];
  bytes.tx = tx;
  bytes.serialize = () => bytes;
  bytes.toJSON = () => JSON.stringify(Array.from(bytes));
  return { bytes, tx };
}
