// IKA shim — coordinator module.
// Declares the DWalletCoordinator shared object + approve_message with
// the REAL signature used by the on-chain IKA mainnet package.
//
// Pulled from @ika.xyz/sdk@0.3.1 generated bindings (ApproveMessageArguments):
//   self:                 &mut DWalletCoordinator  (shared singleton)
//   dwallet_cap:          &DWalletCap
//   signature_algorithm:  u8
//   hash_scheme:          u8
//   message:              vector<u8>
// Returns: MessageApproval (consumed by request_sign)

module ika_dwallet_2pc_mpc::coordinator;

use ika_dwallet_2pc_mpc::coordinator_inner::DWalletCap;

/// The shared coordinator singleton. Mainnet object id:
///   0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3
/// initial shared version: 595876492
///
/// Field layout mirrors @local-pkg/2pc-mpc::coordinator::DWalletCoordinator.
public struct DWalletCoordinator has key {
    id: UID,
    version: u64,
    package_id: ID,
    new_package_id: Option<ID>,
    migration_epoch: Option<u64>,
}

/// A Move-level proof that a specific message has been approved by the
/// holder of a given `DWalletCap`. The IKA network refuses to produce
/// a signature for `request_sign` without this object present in the PTB.
public struct MessageApproval has store, drop {
    dwallet_cap_id: ID,
    signature_algorithm: u8,
    hash_scheme: u8,
    message: vector<u8>,
}

/// Approve a message for signing by the dWallet referenced by `cap`.
/// Shim stub body — real IKA impl asserts network state + coordinator
/// invariants. Signature shape matches reality so downstream code links
/// against the real package at publish time.
public fun approve_message(
    _self: &mut DWalletCoordinator,
    cap: &DWalletCap,
    signature_algorithm: u8,
    hash_scheme: u8,
    message: vector<u8>,
): MessageApproval {
    MessageApproval {
        dwallet_cap_id: object::id(cap),
        signature_algorithm,
        hash_scheme,
        message,
    }
}

// ─── Views (real package has these too) ──────────────────────────────

public fun approval_dwallet_cap_id(a: &MessageApproval): ID { a.dwallet_cap_id }
public fun approval_message(a: &MessageApproval): &vector<u8> { &a.message }

// ─── Test-only constructors ──────────────────────────────────────────

#[test_only]
public fun new_coordinator_for_testing(ctx: &mut TxContext): DWalletCoordinator {
    DWalletCoordinator {
        id: object::new(ctx),
        version: 1,
        package_id: object::id_from_address(@0xDD24),
        new_package_id: option::none(),
        migration_epoch: option::none(),
    }
}

#[test_only]
public fun destroy_coordinator_for_testing(c: DWalletCoordinator) {
    let DWalletCoordinator { id, version: _, package_id: _, new_package_id: _, migration_epoch: _ } = c;
    id.delete();
}

#[test_only]
public fun destroy_approval_for_testing(a: MessageApproval) {
    let MessageApproval { dwallet_cap_id: _, signature_algorithm: _, hash_scheme: _, message: _ } = a;
}
