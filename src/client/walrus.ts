// Walrus mainnet aggregator/publisher helpers.
//
// Reads race across multiple independent mainnet operators (Promise.any).
// The first healthy response wins; slow or 5xx operators don't block the
// ceremony. Writes try each publisher in turn until one accepts the blob.
//
// Trust: H2O Nodes, Studio Mirai, and Overclock also run the Seal key
// servers used by SUIAMI / Thunder (see SEAL_SERVERS_MAINNET in
// suiami-seal.ts / thunder-stack.ts). Keeping Walrus reads on the same
// operators narrows the trust surface to one set of custodians.

/** Mainnet aggregators — order is preference for fastest-wins but all race. */
export const WALRUS_AGGREGATORS_MAINNET: readonly string[] = [
    'https://aggregator.walrus-mainnet.h2o-nodes.com',
    'https://aggregator.mainnet.walrus.mirai.cloud',
    'https://aggregator.walrus.space',
    'https://sm-walrus-mainnet-aggregator.stakesquid.com',
] as const;

/** Mainnet publishers — writes are sequential until one accepts. */
export const WALRUS_PUBLISHERS_MAINNET: readonly string[] = [
    'https://publisher.walrus-mainnet.h2o-nodes.com',
    'https://publisher.walrus.space',
] as const;

/** Legacy single-URL export for code paths still reading a single string. */
export const WALRUS_AGGREGATOR = WALRUS_AGGREGATORS_MAINNET[0];
export const WALRUS_PUBLISHER = WALRUS_PUBLISHERS_MAINNET[0];

/**
 * Fetch a blob by ID, racing all mainnet aggregators and returning the
 * first 2xx. Throws `AggregateError` (via Promise.any) if every
 * aggregator fails.
 */
export async function fetchWalrusBlob(blobId: string, init?: RequestInit): Promise<Response> {
    const attempts = WALRUS_AGGREGATORS_MAINNET.map(async (base) => {
        const res = await fetch(`${base}/v1/blobs/${blobId}`, init);
        if (!res.ok) throw new Error(`${base}: HTTP ${res.status}`);
        return res;
    });
    return Promise.any(attempts);
}

/**
 * Upload a blob via PUT. Tries each publisher in order; returns the
 * first 2xx response. Throws if every publisher fails.
 */
export async function putWalrusBlob(body: BodyInit, init?: RequestInit): Promise<Response> {
    const errors: string[] = [];
    for (const base of WALRUS_PUBLISHERS_MAINNET) {
        try {
            const res = await fetch(`${base}/v1/blobs`, { method: 'PUT', body, ...init });
            if (res.ok) return res;
            errors.push(`${base}: HTTP ${res.status}`);
        } catch (e) {
            errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    throw new Error(`all Walrus publishers failed: ${errors.join('; ')}`);
}
