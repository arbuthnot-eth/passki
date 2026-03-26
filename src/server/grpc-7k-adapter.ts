/**
 * gRPC → 7K Adapter
 *
 * Wraps SuiGrpcClient to satisfy @bluefin-exchange/bluefin7k-aggregator-sdk's
 * expected SuiClient interface. The SDK uses duck typing (no instanceof checks),
 * so we only need the 4 methods it actually calls:
 *   - getCoins()
 *   - getOwnedObjects()
 *   - dryRunTransactionBlock()
 *   - devInspectTransactionBlock()
 *
 * Plus resolveTransactionPlugin() for tx.build({ client }) compatibility.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';

/** Shape the 7K SDK expects from getCoins() response items. */
interface CoinStruct {
  coinObjectId: string;
  balance: string;
  coinType: string;
  digest: string;
  version: string;
}

/**
 * Create an adapter that wraps a SuiGrpcClient and exposes the methods
 * the Bluefin 7K aggregator SDK expects.
 */
export function createGrpc7kAdapter(grpc: SuiGrpcClient) {
  return {
    // ── getCoins ──────────────────────────────────────────────────
    // 7K calls:   client.getCoins({ owner, coinType, cursor, limit })
    // 7K expects: { data: CoinStruct[], nextCursor, hasNextPage }
    // gRPC has:   listCoins({ owner, coinType, cursor })
    // gRPC returns: { objects: Coin[], cursor, hasNextPage }
    async getCoins(params: {
      owner: string;
      coinType: string;
      cursor?: string;
      limit?: number;
    }) {
      const result = await grpc.listCoins({
        owner: params.owner,
        coinType: params.coinType,
        cursor: params.cursor ?? undefined,
      });
      return {
        data: result.objects.map((c): CoinStruct => ({
          coinObjectId: c.objectId,
          balance: c.balance,
          coinType: c.type,
          digest: c.digest,
          version: c.version,
        })),
        nextCursor: result.cursor,
        hasNextPage: result.hasNextPage,
      };
    },

    // ── getOwnedObjects ──────────────────────────────────────────
    // 7K calls:   client.getOwnedObjects({ owner, cursor, limit, filter, options })
    // 7K expects: { data: SuiObjectResponse[], nextCursor, hasNextPage }
    // gRPC has:   listOwnedObjects({ owner, type, cursor, limit, include })
    async getOwnedObjects(params: {
      owner: string;
      cursor?: string;
      limit?: number;
      filter?: { StructType?: string };
      options?: { showContent?: boolean; showType?: boolean };
    }) {
      const result = await grpc.listOwnedObjects({
        owner: params.owner,
        type: params.filter?.StructType,
        cursor: params.cursor ?? undefined,
        limit: params.limit ?? undefined,
        include: {
          content: params.options?.showContent,
        },
      });
      return {
        data: result.objects.map((o) => ({
          data: {
            objectId: o.objectId,
            version: o.version,
            digest: o.digest,
            type: o.type,
            content: o.content,
          },
        })),
        nextCursor: result.cursor,
        hasNextPage: result.hasNextPage,
      };
    },

    // ── dryRunTransactionBlock ────────────────────────────────────
    // 7K calls:   client.dryRunTransactionBlock({ transactionBlock: Uint8Array })
    // 7K expects: { effects: { status: { status }, gasUsed: { computationCost, storageCost, storageRebate } } }
    // gRPC has:   simulateTransaction({ transaction, include: { effects: true } })
    async dryRunTransactionBlock(params: { transactionBlock: Uint8Array }) {
      const result = await grpc.simulateTransaction({
        transaction: params.transactionBlock,
        include: { effects: true },
      });
      const tx = result.$kind === 'Transaction'
        ? result.Transaction
        : (result as any).FailedTransaction;
      const effects = tx?.effects;
      return {
        effects: {
          status: {
            status: effects?.status === 'success' ? 'success' : 'failure',
          },
          gasUsed: {
            computationCost: effects?.gasUsed?.computationCost ?? '0',
            storageCost: effects?.gasUsed?.storageCost ?? '0',
            storageRebate: effects?.gasUsed?.storageRebate ?? '0',
          },
        },
      };
    },

    // ── devInspectTransactionBlock ────────────────────────────────
    // 7K calls:   client.devInspectTransactionBlock({ sender, transactionBlock })
    // Same return shape as dryRunTransactionBlock.
    async devInspectTransactionBlock(params: {
      sender: string;
      transactionBlock: { build: (opts: any) => Promise<Uint8Array> } | Uint8Array;
    }) {
      let txBytes: Uint8Array;
      if (params.transactionBlock instanceof Uint8Array) {
        txBytes = params.transactionBlock;
      } else {
        txBytes = await params.transactionBlock.build({ client: grpc });
      }
      const result = await grpc.simulateTransaction({
        transaction: txBytes,
        include: { effects: true },
      });
      const tx = result.$kind === 'Transaction'
        ? result.Transaction
        : (result as any).FailedTransaction;
      const effects = tx?.effects;
      return {
        effects: {
          status: {
            status: effects?.status === 'success' ? 'success' : 'failure',
          },
          gasUsed: {
            computationCost: effects?.gasUsed?.computationCost ?? '0',
            storageCost: effects?.gasUsed?.storageCost ?? '0',
            storageRebate: effects?.gasUsed?.storageRebate ?? '0',
          },
        },
      };
    },

    // ── tx.build({ client }) compatibility ───────────────────────
    // Transaction.build() calls client.resolveTransactionPlugin() internally.
    resolveTransactionPlugin: () => grpc.resolveTransactionPlugin(),
  };
}
