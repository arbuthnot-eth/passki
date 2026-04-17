// Aegislash — iUSD compliance guardian (GENIUS Act + CLARITY Act).
//
// Pokemon arc: Honedge → Doublade → Aegislash Shield → Aegislash Blade → Mega.
// Currently at Honedge (skeleton only, no gating live).
//
// Sole focus, sole mission: every iUSD mint/redeem/transfer event is
// pre-flight gated here before TreasuryAgents / psm_v3 is allowed to
// touch supply. Separation of powers: TreasuryAgents issues, Aegislash
// regulates. No shared state. No cross-method leakage.
//
// See memory/project_aegislash_compliance.md + issue #171.

import { Agent } from 'agents';

interface Env {
    // Reserved for future OFAC digest rotation + admin endpoints.
    // Intentionally empty at Honedge stage — adding env surface as each
    // evolution lands, not before.
}

interface AegislashState {
    // Doublade will set `frozen: boolean` + `lastAttestationAt` here.
    // Keep empty until then so state mutations are intentional.
    _placeholder?: never;
}

export class Aegislash extends Agent<Env, AegislashState> {
    async onRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Honedge smoke: proves the DO binding + routing is live.
        if (url.pathname.endsWith('/smoke') || url.searchParams.has('smoke')) {
            return new Response(JSON.stringify({
                ok: true,
                agent: 'aegislash',
                stage: 'honedge',
                mission: 'iUSD GENIUS/CLARITY compliance',
                status: 'default-deny skeleton — no gating active yet',
            }), { headers: { 'content-type': 'application/json' } });
        }

        // Default-deny — Aegislash's unspecified path is refusal, not 404.
        // Every evolution adds specific allow paths; absence of allow = deny.
        return new Response(JSON.stringify({
            ok: false,
            error: 'aegislash: default-deny — unknown route',
            path: url.pathname,
        }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
        });
    }
}
