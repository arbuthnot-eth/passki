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
    'https://publisher.mainnet.walrus.mirai.cloud',
    'https://publisher.walrus-mainnet.h2o-nodes.com',
    'https://publisher.walrus.space',
    'https://sm-walrus-mainnet-publisher.stakesquid.com',
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
 * Upload a blob via PUT. Routes through the Worker proxy FIRST
 * (/api/walrus/publish) — Worker edge has clean DNS + we control CORS,
 * so it works regardless of the client's ISP / DNS-over-HTTPS setup.
 * Falls back to direct publisher fetches only if the proxy fails.
 */
export async function putWalrusBlob(body: BodyInit, init?: RequestInit): Promise<Response> {
    const errors: string[] = [];
    // Aggron path first — ultron signs a Walrus SDK Quilt PTB server-side,
    // pays WAL from its own balance. Bypasses the HTTP publisher pool
    // entirely, which matters because the public publishers are broken.
    try {
        const res = await fetch('/api/aggron/publish', { method: 'PUT', body, ...init });
        if (res.ok) return res;
        errors.push(`aggron: HTTP ${res.status}`);
    } catch (e) {
        errors.push(`aggron: ${e instanceof Error ? e.message : String(e)}`);
    }
    // HTTP publisher proxy via Worker — secondary fallback.
    try {
        const res = await fetch('/api/walrus/publish', { method: 'PUT', body, ...init });
        if (res.ok) return res;
        errors.push(`proxy: HTTP ${res.status}`);
    } catch (e) {
        errors.push(`proxy: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Direct fallback (helps when the Worker itself is down or upstream is degraded).
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
