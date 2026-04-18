/**
 * OpenCLOB bundle builder — Sub-cent Phase 3b (Porygon-Z Lv. 80).
 *
 * Client-side PTB builders for the `thunder_openclob::bundle` module.
 * Groups CLOB limit orders under a shared sub-cent tag so they can be
 * settled atomically by the TreasuryAgents scanner.
 *
 * See:
 *   - docs/superpowers/specs/2026-04-11-openclob-bundle-tags.md
 *   - docs/superpowers/specs/2026-04-11-subcent-intents-production.md
 *   - contracts/thunder-openclob/sources/bundle.move
 *
 * Phase 3b scope: create_bundle + new_slot composition. Venue-native
 * `deepbook::pool::place_limit_order` wiring is a future phase and is
 * not tracked here — bundles are created with all slots in
 * SLOT_PENDING and advanced via a separate `record_order_placed` tx.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { encodeTag, deriveNonceFromAddress, ROUTES } from '../server/subcent-tag.js';

/** thunder_openclob mainnet package (deployed 2026-04-10). */
export const THUNDER_OPENCLOB_PACKAGE =
  '0xdcbabe3d80cd9b421113f66f2a1287daa8259f5c02861c33e7cc92fc542af0d7';

const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const CLOCK_ID = '0x6';

/** Venue discriminator matching the on-chain `OrderSlot.venue` field. */
const VENUE_DEEPBOOK = 0;

/** Phase 3b only supports DeepBook. Cetus / Bluefin land in Phase 3d. */
export interface BundleOrder {
  venue: 'deepbook';
  /** DeepBook pool object ID. */
  poolId: string;
  /** Side of the book. */
  side: 'buy' | 'sell';
  /** Quote units per base unit (raw integer, venue-specific scale). */
  price: bigint;
  /** Base asset raw amount. */
  quantity: bigint;
  /** Sui address that receives the slot's fill proceeds. */
  recipient: string;
}

export interface BuildBundleResult {
  /** Pre-built tx bytes ready for wallet signAndExecute (non-WaaP path). */
  txBytes: Uint8Array;
  /**
   * Unbuilt Transaction — WaaP signers must rebuild via the v1 SDK to
   * avoid v2 BCS mismatches. See `feedback_waap_holy_grail.md`.
   */
  tx: Transaction;
  /** The 6-digit sub-cent tag assigned to this bundle. */
  tag: number;
}

/** Attach the unbuilt Transaction to the pre-built bytes (WaaP escape hatch). */
async function buildWithTx(
  tx: Transaction,
  client: SuiGraphQLClient,
): Promise<Uint8Array> {
  const bytes = (await tx.build({ client: client as never })) as Uint8Array & {
    tx?: unknown;
  };
  bytes.tx = tx;
  return bytes;
}

/**
 * Build a `create_bundle` PTB with `orders.length` pre-declared slots.
 *
 * Pipeline:
 *   1. Derive a 6-digit sub-cent tag from the creator address + route.
 *   2. For each order, call `bundle::new_slot(venue=0, pool_id, recipient)`.
 *   3. Collect the slots into a `vector<OrderSlot>` via makeMoveVec.
 *   4. Call `bundle::create_bundle` to share the OrderBundle + mint a cap.
 *   5. Transfer the cap to the creator.
 *   6. Pre-build bytes via GraphQL transport + return { txBytes, tx, tag }.
 *
 * NOTE: Phase 3b does NOT wire the actual DeepBook `place_limit_order`
 * calls yet. The bundle is created with all slots in SLOT_PENDING
 * status; a follow-up tx calls `record_order_placed` once the venue
 * returns order IDs.
 */
export async function buildBundleTx(opts: {
  creator: string;
  orders: BundleOrder[];
  settleDeadlineMs: number;
  /** Default: orders.length (all must fill). */
  targetCount?: number;
  /** Default: ROUTES.DEEPBOOK (4). */
  route?: number;
  /** Default: 0. Per-bundle action discriminator. */
  action?: number;
}): Promise<BuildBundleResult> {
  const { creator, orders, settleDeadlineMs } = opts;
  if (orders.length === 0) {
    throw new Error('buildBundleTx: orders must be non-empty');
  }
  if (orders.length > 16) {
    throw new Error('buildBundleTx: max bundle size is 16');
  }
  const targetCount = opts.targetCount ?? orders.length;
  if (targetCount <= 0 || targetCount > orders.length) {
    throw new Error(
      `buildBundleTx: targetCount ${targetCount} must be in 1..${orders.length}`,
    );
  }
  if (settleDeadlineMs <= Date.now()) {
    throw new Error('buildBundleTx: settleDeadlineMs must be in the future');
  }

  const route = opts.route ?? ROUTES.DEEPBOOK;
  const action = opts.action ?? 0;
  const normalizedCreator = normalizeSuiAddress(creator);
  const nonce = await deriveNonceFromAddress(normalizedCreator, 6);
  const tag = encodeTag({ route, action, nonce, width: 6 });

  const tx = new Transaction();
  tx.setSender(normalizedCreator);

  // 1. Construct OrderSlot values for every order.
  const slotHandles = orders.map((order) => {
    const recipient = normalizeSuiAddress(order.recipient);
    const [slot] = [
      tx.moveCall({
        target: `${THUNDER_OPENCLOB_PACKAGE}::bundle::new_slot`,
        arguments: [
          tx.pure.u8(VENUE_DEEPBOOK),
          tx.pure.address(order.poolId),
          tx.pure.address(recipient),
        ],
      }),
    ];
    return slot;
  });

  // 2. Wrap slots into a Move vector<OrderSlot>.
  const slotsVec = tx.makeMoveVec({
    type: `${THUNDER_OPENCLOB_PACKAGE}::bundle::OrderSlot`,
    elements: slotHandles,
  });

  // 3. create_bundle(tag, target_count, deadline_ms, slots, clock) -> cap
  const [cap] = [
    tx.moveCall({
      target: `${THUNDER_OPENCLOB_PACKAGE}::bundle::create_bundle`,
      arguments: [
        tx.pure.u32(tag),
        tx.pure.u8(targetCount),
        tx.pure.u64(BigInt(settleDeadlineMs)),
        slotsVec,
        tx.object(CLOCK_ID),
      ],
    }),
  ];

  // 4. Transfer the bundle cap back to the creator.
  tx.transferObjects([cap], tx.pure.address(normalizedCreator));

  const gql = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
  const txBytes = await buildWithTx(tx, gql);
  return { txBytes, tx, tag };
}

/**
 * Diagnostic helper — create a bundle with a single dummy slot
 * (`new_slot(0, @0x1, creator)`, `targetCount=1`). Mirrors
 * `scripts/bundle-dryrun.ts` but exposed as a reusable TS helper so
 * tests + UI smoke harnesses don't duplicate the PTB plumbing.
 *
 * Useful for validating the `create_bundle` / `force_refund_bundle`
 * lifecycle end-to-end without standing up DeepBook pool state.
 */
export async function buildEmptyBundleTx(opts: {
  creator: string;
  /** Default: 1. */
  targetCount?: number;
  /** Default: now + 10 minutes. */
  settleDeadlineMs?: number;
}): Promise<BuildBundleResult> {
  const settleDeadlineMs = opts.settleDeadlineMs ?? Date.now() + 10 * 60 * 1000;
  const targetCount = opts.targetCount ?? 1;
  const dummyPool =
    '0x0000000000000000000000000000000000000000000000000000000000000001';
  return buildBundleTx({
    creator: opts.creator,
    settleDeadlineMs,
    targetCount,
    orders: [
      {
        venue: 'deepbook',
        poolId: dummyPool,
        side: 'buy',
        price: 0n,
        quantity: 0n,
        recipient: opts.creator,
      },
    ],
  });
}
