// Whelm Ultron — client-side flow for the fungible sweep phase.
//
// Triggered from the SKI menu settings panel (admin-gated). Flow:
//   1. Sign "whelm-ultron-fungibles:<target>:<YYYY-MM-DD>" with the
//      connected wallet via signPersonalMessage.
//   2. Dry-run the server endpoint to get the plan.
//   3. Show a confirm prompt with the plan.
//   4. On confirm, re-sign the same message and execute.
//
// Server endpoint: POST /api/cache/whelm-ultron-fungibles
// Gated by requireUltronAdmin (allowlist + signed-message + freeze-state).

import { signPersonalMessage } from '../wallet.js';
import { getState } from '../wallet.js';

const NEW_ULTRON = '0x9872c1f5edf4daffbdcf5f577567ce997a00db9d63a8a8fac4feb8b135b285f7';

export const ADMIN_ADDRESSES: ReadonlySet<string> = new Set([
    // plankton.sui
    '0x3db42086e9271787046859d60af7933fa7ea70148df37c9fd693195533eabb57',
    // brando.sui — WaaP
    '0x2b3524ebf158c4b01f482c6d687d8ba0d922deaec04c3b495926d73cb0a7ee28',
    // brando.sui — Phantom (new)
    '0xbec4fec9d1639fbe5e8ab93bf2475d6907f6534a78407912e618e94195afa057',
    // superteam.sui — brando's Phantom builder wallet
    '0x3ca0da71d19d9a1837ad3da155f03aab776aa33963864064eb81569f10e5222b',
]);

export function isAdminAddress(address: string | undefined | null): boolean {
    if (!address) return false;
    return ADMIN_ADDRESSES.has(address.toLowerCase());
}

interface WhelmPlan {
    label: string;
    count: number;
    total: string;
    transfer: string;
}

interface WhelmResult {
    ok?: boolean;
    dryRun?: boolean;
    oldUltron?: string;
    newUltron?: string;
    plans?: WhelmPlan[];
    digest?: string;
    execError?: string;
    error?: string;
}

async function callWhelm(dryRun: boolean, toast: (m: string) => void): Promise<WhelmResult> {
    const ws = getState();
    if (!ws.address) {
        toast('Connect a wallet first');
        return { error: 'not connected' };
    }
    if (!isAdminAddress(ws.address)) {
        toast('Not on admin allowlist');
        return { error: 'not admin' };
    }
    const today = new Date().toISOString().slice(0, 10);
    const message = `whelm-ultron-fungibles:${NEW_ULTRON.toLowerCase()}:${today}`;
    toast(`\ud83d\udd0f Sign the whelm message in your wallet\u2026`);
    const signed = await signPersonalMessage(new TextEncoder().encode(message));
    const signature = (signed as { signature?: string }).signature || (signed as unknown as string);
    if (!signature) {
        toast('Signature failed');
        return { error: 'signature' };
    }
    toast(dryRun ? 'Fetching plan\u2026' : 'Submitting whelm\u2026');
    const r = await fetch('/api/cache/whelm-ultron-fungibles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            adminAddress: ws.address,
            signature,
            message,
            targetAddress: NEW_ULTRON,
            dryRun,
        }),
    });
    const json = await r.json() as WhelmResult;
    return json;
}

export async function whelmUltronFlow(toast: (m: string, isHtml?: boolean, persistent?: boolean) => void): Promise<void> {
    const plan = await callWhelm(true, toast);
    if (plan.error) {
        toast(`Whelm preview failed: ${plan.error}`);
        return;
    }
    if (!plan.plans?.length) {
        const addrLine = plan.oldUltron ? `\n\nChecked: ${plan.oldUltron}` : '';
        const hint = (plan as { message?: string }).message ? `\n\n${(plan as { message?: string }).message}` : '';
        toast(`Nothing to whelm.${addrLine}${hint}`, false, true);
        return;
    }
    const rows = plan.plans.map(p => `${p.label}: ${p.transfer} (of ${p.total}, ${p.count} coin${p.count === 1 ? '' : 's'})`).join('\n');
    const ok = confirm(`Whelm Ultron \u2014 preview\n\nFrom: ${plan.oldUltron}\nTo:   ${plan.newUltron}\n\n${rows}\n\nExecute?`);
    if (!ok) {
        toast('Whelm cancelled');
        return;
    }
    const result = await callWhelm(false, toast);
    if (result.error) {
        toast(`Whelm failed: ${result.error}`, false, true);
        return;
    }
    if (result.execError) {
        toast(`Whelm tx reverted: ${result.execError}`, false, true);
        return;
    }
    if (result.digest) {
        const dest = result.newUltron ?? '';
        const destLabel = dest.toLowerCase() === NEW_ULTRON.toLowerCase()
            ? 'ultron.sui'
            : (dest ? `${dest.slice(0, 10)}\u2026${dest.slice(-4)}` : '');
        const destLine = destLabel ? ` \u2192 ${destLabel}` : '';
        toast(`\u{1F30A} Whelmed${destLine}\n${result.digest.slice(0, 10)}\u2026`, false, true);
    } else {
        toast('Whelm submitted; no digest returned', false, true);
    }
}

// ── Whelm Ultron Squids — sweep owned DWalletCap objects ──

interface ObjectRow { objectId: string; type: string; }
interface ObjectsResult {
    ok?: boolean;
    dryRun?: boolean;
    oldUltron?: string;
    newUltron?: string;
    plans?: ObjectRow[];
    skipped?: ObjectRow[];
    digest?: string;
    execError?: string;
    error?: string;
    message?: string;
}

async function callWhelmObjects(dryRun: boolean, toast: (m: string) => void): Promise<ObjectsResult> {
    const ws = getState();
    if (!ws.address) {
        toast('Connect a wallet first');
        return { error: 'not connected' };
    }
    if (!isAdminAddress(ws.address)) {
        toast('Not on admin allowlist');
        return { error: 'not admin' };
    }
    const today = new Date().toISOString().slice(0, 10);
    const message = `whelm-ultron-objects:${NEW_ULTRON.toLowerCase()}:${today}`;
    toast(`\u{1F991} Sign the squid-whelm message in your wallet\u2026`);
    const signed = await signPersonalMessage(new TextEncoder().encode(message));
    const signature = (signed as { signature?: string }).signature || (signed as unknown as string);
    if (!signature) {
        toast('\u{1F991} Signature failed');
        return { error: 'signature' };
    }
    toast(dryRun ? '\u{1F991} Surveying the squids\u2026' : '\u{1F991} Whelming squids\u2026');
    const r = await fetch('/api/cache/whelm-ultron-objects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            adminAddress: ws.address,
            signature,
            message,
            targetAddress: NEW_ULTRON,
            dryRun,
        }),
    });
    return await r.json() as ObjectsResult;
}

function shortId(id: string): string { return `${id.slice(0, 10)}\u2026${id.slice(-4)}`; }
function shortType(t: string): string {
    const m = t.match(/::([^:]+)::([^<]+)(<.*)?$/);
    if (!m) return t.length > 40 ? `${t.slice(0, 20)}\u2026${t.slice(-16)}` : t;
    return `${m[1]}::${m[2]}${m[3] ? '<\u2026>' : ''}`;
}

export async function whelmUltronSquidsFlow(toast: (m: string, isHtml?: boolean, persistent?: boolean) => void): Promise<void> {
    const plan = await callWhelmObjects(true, toast);
    if (plan.error) {
        toast(`\u{1F991} Preview failed: ${plan.error}`);
        return;
    }
    if (!plan.plans?.length) {
        const addrLine = plan.oldUltron ? `\n\nChecked: ${plan.oldUltron}` : '';
        const hint = plan.message ? `\n\n${plan.message}` : '';
        const skippedLine = plan.skipped?.length
            ? `\n\nNon-coin objects left behind (${plan.skipped.length}):\n${plan.skipped.map((s) => `  ${shortType(s.type)}  ${shortId(s.objectId)}`).join('\n')}`
            : '';
        toast(`\u{1F991} No squids to whelm.${addrLine}${hint}${skippedLine}`, false, true);
        return;
    }
    const rows = plan.plans.map((p) => `  ${shortType(p.type)}  ${shortId(p.objectId)}`).join('\n');
    const skippedRows = plan.skipped?.length
        ? `\n\nSkipped (stay behind):\n${plan.skipped.map((s) => `  ${shortType(s.type)}  ${shortId(s.objectId)}`).join('\n')}`
        : '';
    const ok = confirm(`\u{1F991} Whelm Ultron Squids \u2014 preview\n\nFrom: ${plan.oldUltron}\nTo:   ${plan.newUltron}\n\nSweep (${plan.plans.length}):\n${rows}${skippedRows}\n\nExecute?`);
    if (!ok) {
        toast('\u{1F991} Whelm cancelled');
        return;
    }
    const result = await callWhelmObjects(false, toast);
    if (result.error) {
        toast(`\u{1F991} Whelm failed: ${result.error}`, false, true);
        return;
    }
    if (result.execError) {
        toast(`\u{1F991} Tx reverted: ${result.execError}`, false, true);
        return;
    }
    if (result.digest) {
        const count = result.plans?.length ?? 0;
        const swarm = '\u{1F991}'.repeat(Math.min(count, 5));
        const dest = result.newUltron ?? '';
        const destLabel = dest.toLowerCase() === NEW_ULTRON.toLowerCase()
            ? 'ultron.sui'
            : (dest ? `${dest.slice(0, 10)}\u2026${dest.slice(-4)}` : '');
        const destLine = destLabel ? ` \u2192 ${destLabel}` : '';
        const digestShort = `${result.digest.slice(0, 10)}\u2026`;
        toast(`${swarm} ${count} squid${count === 1 ? '' : 's'} whelmed${destLine}\n${digestShort}`, false, true);
    } else {
        toast('\u{1F991} Submitted; no digest returned', false, true);
    }
}
