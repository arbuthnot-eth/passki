/**
 * What ultron will co-sign as gas sponsor on /api/sponsor-gas.
 *
 * A sponsor signature authorizes the whole transaction to spend the gas
 * coin, and if ultron were the sender, everything ultron owns. So before
 * signing we decode the bytes and require:
 *
 *   1. sender is set and is NOT ultron
 *   2. gas owner IS ultron (otherwise the signature has no business here)
 *   3. gas budget ≤ MAX_SPONSOR_BUDGET_MIST
 *   4. the gas coin is only ever used as the source of SplitCoins with
 *      literal amounts totalling ≤ MAX_GAS_SPLIT_MIST (Pyth oracle fees on
 *      sponsored SuiNS registration). Any other use (transfer, merge,
 *      move-call argument, vector) is refused.
 *   5. if the caller skipped the SuiNS gate (no senderAddress), the tx must
 *      be a single Thunder IOU claim/recall call; with a senderAddress, it
 *      must match the tx sender.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

export const MAX_SPONSOR_BUDGET_MIST = 500_000_000n; // 0.5 SUI
export const MAX_GAS_SPLIT_MIST = 1_000_000n; // 0.001 SUI

const THUNDER_IOU_PACKAGE = normalizeSuiAddress('0x5a80b9753d6ccce11dc1f9a5039d9430d3e43a216f82f957ef11df9cb5c4dc79');
const UNGATED_IOU_FUNCTIONS = new Set(['claim', 'recall']);

export type SponsorDecision =
  | { ok: true; sender: string; gated: boolean; budgetMist: bigint }
  | { ok: false; reason: string };

type Arg = { $kind: string; Input?: number; Result?: number; NestedResult?: [number, number] };

function isGas(a: Arg | undefined): boolean {
  return !!a && a.$kind === 'GasCoin';
}

export function evaluateSponsorTx(
  txBytes: Uint8Array,
  sponsorAddress: string,
  claimedSender?: string,
): SponsorDecision {
  let data: ReturnType<Transaction['getData']>;
  try {
    data = Transaction.from(txBytes).getData();
  } catch {
    return { ok: false, reason: 'Unparseable transaction' };
  }

  const sponsor = normalizeSuiAddress(sponsorAddress);
  if (!data.sender) return { ok: false, reason: 'Transaction has no sender' };
  const sender = normalizeSuiAddress(data.sender);
  if (sender === sponsor) return { ok: false, reason: 'Sponsor cannot be the sender' };

  const owner = data.gasData.owner ? normalizeSuiAddress(data.gasData.owner) : sender;
  if (owner !== sponsor) return { ok: false, reason: 'Gas owner is not the sponsor' };

  let budget: bigint;
  try { budget = BigInt(data.gasData.budget ?? -1); } catch { budget = -1n; }
  if (budget < 0n) return { ok: false, reason: 'Gas budget not set' };
  if (budget > MAX_SPONSOR_BUDGET_MIST) return { ok: false, reason: 'Gas budget exceeds sponsor limit' };

  const pureU64 = (a: Arg): bigint | null => {
    if (a.$kind !== 'Input' || a.Input === undefined) return null;
    const input = data.inputs[a.Input] as { $kind?: string; Pure?: { bytes: string } } | undefined;
    if (!input || input.$kind !== 'Pure' || !input.Pure) return null;
    try {
      const raw = fromBase64(input.Pure.bytes);
      if (raw.length !== 8) return null;
      return BigInt(bcs.u64().parse(raw));
    } catch { return null; }
  };

  let gasSplitTotal = 0n;
  for (const cmd of data.commands as Array<Record<string, any>>) {
    switch (cmd.$kind) {
      case 'SplitCoins': {
        const { coin, amounts } = cmd.SplitCoins as { coin: Arg; amounts: Arg[] };
        if (amounts.some(isGas)) return { ok: false, reason: 'Gas coin used as split amount' };
        if (isGas(coin)) {
          for (const amt of amounts) {
            const v = pureU64(amt);
            if (v === null) return { ok: false, reason: 'Gas coin split by a non-literal amount' };
            gasSplitTotal += v;
          }
          if (gasSplitTotal > MAX_GAS_SPLIT_MIST) return { ok: false, reason: 'Gas coin split exceeds sponsor limit' };
        }
        break;
      }
      case 'TransferObjects': {
        const { objects, address } = cmd.TransferObjects as { objects: Arg[]; address: Arg };
        if (objects.some(isGas) || isGas(address)) return { ok: false, reason: 'Gas coin cannot be transferred' };
        break;
      }
      case 'MergeCoins': {
        const { destination, sources } = cmd.MergeCoins as { destination: Arg; sources: Arg[] };
        if (isGas(destination) || sources.some(isGas)) return { ok: false, reason: 'Gas coin cannot be merged' };
        break;
      }
      case 'MoveCall': {
        const args = (cmd.MoveCall.arguments ?? []) as Arg[];
        if (args.some(isGas)) return { ok: false, reason: 'Gas coin cannot be passed to a Move call' };
        break;
      }
      case 'MakeMoveVec': {
        const els = (cmd.MakeMoveVec.elements ?? []) as Arg[];
        if (els.some(isGas)) return { ok: false, reason: 'Gas coin cannot be put in a vector' };
        break;
      }
      case 'Publish':
      case 'Upgrade':
        break;
      default:
        return { ok: false, reason: `Unsupported command ${String(cmd.$kind)}` };
    }
  }

  if (!claimedSender) {
    // Ungated path: permissionless Thunder IOU claim/recall only.
    const cmds = data.commands as Array<Record<string, any>>;
    const only = cmds.length === 1 && cmds[0].$kind === 'MoveCall' ? cmds[0].MoveCall : null;
    const allowed = !!only
      && normalizeSuiAddress(only.package) === THUNDER_IOU_PACKAGE
      && only.module === 'iou'
      && UNGATED_IOU_FUNCTIONS.has(only.function);
    if (!allowed) return { ok: false, reason: 'senderAddress required for this transaction' };
    return { ok: true, sender, gated: false, budgetMist: budget };
  }

  if (normalizeSuiAddress(claimedSender) !== sender) {
    return { ok: false, reason: 'senderAddress does not match transaction sender' };
  }
  return { ok: true, sender, gated: true, budgetMist: budget };
}
