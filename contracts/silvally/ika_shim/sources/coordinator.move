// IKA shim — coordinator module.
// Exposes `approve_message` so Silvally can compile. Real IKA package
// has the full coordinator surface; we only need this one entry for
// the spike.

module ika_dwallet_2pc_mpc::coordinator;

use ika_dwallet_2pc_mpc::coordinator_inner::DWalletCap;

/// A Move-level proof that a specific message has been approved by the
/// holder of a given `DWalletCap`. The IKA network refuses to produce
/// a signature for `requestSign` without this object present in the PTB.
public struct MessageApproval has store, drop {
    dwallet_cap_id: ID,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    message: vector<u8>,
}

/// Stub body — the real IKA implementation asserts cap validity and
/// constructs the approval with IKA-network-side bookkeeping. For the
/// spike, we just return a plausibly-shaped approval. Bytecode will
/// NOT match the real package; this is intentional for local compile.
public fun approve_message(
    cap: &DWalletCap,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    message: vector<u8>,
    _ctx: &mut TxContext,
): MessageApproval {
    MessageApproval {
        dwallet_cap_id: object::id(cap),
        curve,
        signature_algorithm,
        hash_scheme,
        message,
    }
}
