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
        toast('Nothing to whelm \u2014 old Ultron is empty.');
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
        toast(`Whelm failed: ${result.error}`);
        return;
    }
    if (result.execError) {
        toast(`Whelm tx reverted: ${result.execError}`, false, true);
        return;
    }
    if (result.digest) {
        const link = `<a href="https://suiscan.xyz/mainnet/tx/${result.digest}" target="_blank" rel="noopener">${result.digest.slice(0, 10)}\u2026</a>`;
        toast(`Whelmed \u2014 ${link}`, true, true);
    } else {
        toast('Whelm submitted; no digest returned');
    }
}
