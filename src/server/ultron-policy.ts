// Ultron policy engine — single gate for all privileged Ultron actions.
//
// Every endpoint that signs with Ultron or mutates Ultron state must
// pass through `requireUltronAdmin`. It enforces:
//   1. signed-message authentication with an address on the allowlist,
//   2. message shape + today's-date freshness to prevent stale replays,
//   3. a freeze check (stubbed today, wired when ultron-freeze lands)
//      so any privileged action can be globally halted in incident
//      response without per-endpoint changes.
//
// Usage:
//     const denied = await requireUltronAdmin(c, body, {
//       context: 'whelm-ultron-fungibles',
//       messageFor: (b) => `whelm-ultron-fungibles:${b.targetAddress}:${today()}`,
//     });
//     if (denied) return denied;

export interface UltronAdminRequestBase {
    adminAddress: string;
    signature: string;
    message: string;
}

export const ADMIN_ADDRESSES: ReadonlySet<string> = new Set([
    // plankton.sui — active local keystore (publishes iUSD, holds UpgradeCap)
    '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57',
    // brando.sui — admin session (WaaP)
    '0x2b3524ebf158c4b01f482c6d687d8ba0d922deaec04c3b495926d73cb0a7ee28',
    // brando.sui — admin session (new wallet, 2026-04-13)
    '0xbec4fec9d1639fbe5e8ab93bf2475d6907f6534a78407912e618e94195afa057',
]);

/**
 * Today's UTC date as `YYYY-MM-DD`. Used in the signed message so a
 * captured signature can only replay within the same UTC day.
 */
export function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

export interface UltronAdminOptions<T extends UltronAdminRequestBase> {
    context: string;
    messageFor: (body: T) => string;
}

export interface UltronHonoContext {
    json(body: unknown, status?: number): Response;
}

/**
 * Frozen-state check. Stubbed for now. When ultron-freeze lands, this
 * reads the TreasuryAgents DO flag and returns `true` when Ultron is
 * frozen. Any call through requireUltronAdmin gets rejected with 503
 * until unfrozen.
 */
async function isUltronFrozen(_c: UltronHonoContext): Promise<boolean> {
    return false;
}

export async function requireUltronAdmin<T extends UltronAdminRequestBase>(
    c: UltronHonoContext,
    body: T,
    opts: UltronAdminOptions<T>,
): Promise<Response | null> {
    if (await isUltronFrozen(c)) {
        return c.json({ error: 'Ultron is frozen — privileged actions are halted' }, 503);
    }
    if (!body?.adminAddress || !body?.signature || !body?.message) {
        return c.json({ error: 'Missing adminAddress, signature, or message' }, 400);
    }
    const normalized = body.adminAddress.toLowerCase();
    if (!ADMIN_ADDRESSES.has(normalized)) {
        return c.json({ error: `${body.adminAddress} not in admin allowlist` }, 403);
    }
    const expected = opts.messageFor(body);
    if (body.message !== expected) {
        return c.json({ error: `message must be exactly "${expected}"` }, 400);
    }
    try {
        const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
        const messageBytes = new TextEncoder().encode(body.message);
        await verifyPersonalMessageSignature(messageBytes, body.signature, { address: normalized });
    } catch (err) {
        return c.json({ error: `Invalid signature: ${err instanceof Error ? err.message : String(err)}` }, 403);
    }
    return null;
}
