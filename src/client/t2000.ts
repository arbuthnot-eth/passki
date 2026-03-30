/**
 * t2000 — Client for deploying and managing IKA terminator agents.
 *
 * Space pirate ship. Destroys bridges and wormholes.
 * Each t2000 signs natively on every chain via IKA dWallet.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { gqlClient } from '../rpc.js';

let T2000_PACKAGE = '0x3e708a6e1dfd6f96b54e0145613d505e508577df4a80aa5523caf380abba5e33';
let SHIP_ID = '0xc78197ce97f89833e5da857cc4da41e7d71163c259128350c8c145a1ecfc67e5'; // on-chain: Armory

/** Available missions — each maps to a TreasuryAgents strategy */
export const MISSIONS = {
  arb: { name: 'arb', description: 'Flash loan arbitrage — hunts price gaps across DEXes' },
  sweep: { name: 'sweep', description: 'Fee sweeper — collects and deposits treasury revenue' },
  snipe: { name: 'snipe', description: 'Shade sniper — executes grace-period name registrations' },
  farm: { name: 'farm', description: 'Yield farmer — rotates capital to highest APY' },
  watch: { name: 'watch', description: 'Liquidation monitor — watches health factors, strikes when positions go underwater' },
  route: { name: 'route', description: 'Maker bot — places resting limit orders on DeepBook for rebates' },
  storm: { name: 'storm', description: 'Thunder Storm agent — signals, quests, and sweeps storms' },
} as const;

export type MissionType = keyof typeof MISSIONS;

/** Build a deploy PTB — mints a t2000 agent */
export async function buildDeployT2000Tx(
  operatorAddress: string,
  designation: string,
  mission: MissionType,
  dwalletId: string,
): Promise<Uint8Array> {
  const walletAddress = normalizeSuiAddress(operatorAddress);

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Split deployment cost from gas (1.5 SUI ≈ $4.50)
  const DEPLOY_COST_MIST = 1_500_000_000n;
  const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(DEPLOY_COST_MIST)]);

  tx.moveCall({
    package: T2000_PACKAGE,
    module: 't2000',
    function: 'deploy',
    arguments: [
      tx.object(SHIP_ID),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(designation))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(MISSIONS[mission].description))),
      tx.pure.address(normalizeSuiAddress(dwalletId)),
      paymentCoin,
      tx.object('0x6'), // clock
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Report a mission completion on-chain */
export async function buildReportMissionTx(
  operatorAddress: string,
  agentObjectId: string,
  missionDescription: string,
  profitMist: bigint,
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(normalizeSuiAddress(operatorAddress));

  tx.moveCall({
    package: T2000_PACKAGE,
    module: 't2000',
    function: 'report_mission',
    arguments: [
      tx.object(agentObjectId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(missionDescription))),
      tx.pure.u64(profitMist),
      tx.object('0x6'), // clock
    ],
  });

  const bytes = await tx.build({ client: gqlClient as never }) as Uint8Array & { tx?: unknown };
  bytes.tx = tx;
  return bytes;
}

/** Set package and armory IDs after deploy */
export function setT2000Config(packageId: string, shipId: string) {
  T2000_PACKAGE = packageId;
  SHIP_ID = shipId;
}

/** Query armory stats via GraphQL */
export async function getShipStats(): Promise<{
  count: number;
  totalCollected: string;
  deployCost: string;
} | null> {
  try {
    const result = await gqlClient.query({
      query: `query { object(address: "${SHIP_ID}") { asMoveObject { contents { json } } } }`,
    });
    const json = (result.data as any)?.object?.asMoveObject?.contents?.json;
    if (!json) return null;
    return {
      count: Number(json.count ?? 0),
      totalCollected: json.total_collected_mist ?? '0',
      deployCost: json.deploy_cost_mist ?? '0',
    };
  } catch {
    return null;
  }
}
