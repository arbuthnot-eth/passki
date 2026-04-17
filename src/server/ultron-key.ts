// Single choke point for deriving the ultron.sui signing keypair.
//
// Raw-key today: reads SHADE_KEEPER_PRIVATE_KEY (bech32 `suiprivkey1…`)
// and derives an Ed25519 keypair. Tomorrow — once IKA imported-key
// ed25519 DKG ships — this helper swaps to a DWalletCap + IKA
// threshold signature without touching any of the 90+ server-side
// call sites.
//
// NEVER call `Ed25519Keypair.fromSecretKey(env.SHADE_KEEPER_PRIVATE_KEY)`
// directly. Always go through ultronKeypair(env) so the raw→IKA
// migration has exactly one line to change.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface UltronEnv {
    SHADE_KEEPER_PRIVATE_KEY?: string;
}

/**
 * Ultron.sui Ed25519 keypair. One call site away from IKA MPC.
 *
 * Throws if the secret isn't configured — call sites that tolerate an
 * unconfigured keeper should gate on `env.SHADE_KEEPER_PRIVATE_KEY`
 * before invoking, matching the existing pattern used across the
 * agents.
 */
export function ultronKeypair(env: UltronEnv): Ed25519Keypair {
    const secret = env.SHADE_KEEPER_PRIVATE_KEY;
    if (!secret) {
        throw new Error('ultronKeypair: SHADE_KEEPER_PRIVATE_KEY not configured');
    }
    return Ed25519Keypair.fromSecretKey(secret);
}

/** Ultron.sui public address. Cheaper than ultronKeypair when only the address is needed. */
export function ultronAddress(env: UltronEnv): string {
    return ultronKeypair(env).getPublicKey().toSuiAddress();
}
