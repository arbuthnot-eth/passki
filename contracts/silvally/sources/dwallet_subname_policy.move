// Silvally RKS — IKA dWallet policy module for SuiNS Crowds.
//
// A `SubnamePolicy` holds a `DWalletCap` inside a shared object. Only the
// module's typed entry functions can reach the cap to call IKA's
// `approve_message`, which gates all signing requests. Delegate path is
// quota + expiration bounded; owner path (via `OwnerCap`) is unrestricted.
//
// De-risking spike: if `approve_message(&policy.dwallet_cap, ...)` compiles
// and the returned `MessageApproval` is honored by `request_sign`, the
// entire Silvally pattern is viable.
//
// Machamp moves tracked in issue #193:
//   M1 Focus Punch    — scaffold + Move.toml                    (this commit)
//   M2 Bulk Up        — SubnamePolicy + OwnerCap + init_policy
//   M3 Cross Chop     — delegate_approve_spike entry fn          <-- the spike
//   M4 Close Combat   — unit tests
//   M5 Revenge        — testnet publish + real DKG signing
//   M6 Dynamic Punch  — signature verifies off-chain
//   M7 Seismic Toss   — mainnet publish

module ski::dwallet_subname_policy;

use ika_dwallet_2pc_mpc::coordinator::{Self, DWalletCoordinator, MessageApproval};
use ika_dwallet_2pc_mpc::coordinator_inner::DWalletCap;
use sui::clock::Clock;
use sui::event;

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

const E_QUOTA_EXCEEDED: u64 = 1;
const E_EXPIRED: u64 = 2;
const E_NOT_OWNER: u64 = 3;

#[test_only] public fun err_quota_exceeded(): u64 { E_QUOTA_EXCEEDED }
#[test_only] public fun err_expired(): u64 { E_EXPIRED }
#[test_only] public fun err_not_owner(): u64 { E_NOT_OWNER }

// ------------------------------------------------------------------
// IKA scheme constants
// Mirror SDK: SignatureAlgorithm.ECDSASecp256k1 / Hash.KECCAK256
// Curve is implied by the DWalletCap (set at DKG time).
// ------------------------------------------------------------------

const SIG_ALG_ECDSA_SECP256K1: u8 = 0;
const HASH_KECCAK256: u8 = 0;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

public struct SubnamePolicy has key {
    id: UID,
    dwallet_cap: DWalletCap,
    owner_cap_id: ID,
    max_subnames: u64,
    issued_count: u64,
    expiration_ms: u64,
}

public struct OwnerCap has key, store {
    id: UID,
    policy_id: ID,
}

// ------------------------------------------------------------------
// Events
// ------------------------------------------------------------------

public struct PolicyCreated has copy, drop {
    policy_id: ID,
    max_subnames: u64,
    expiration_ms: u64,
}

public struct DelegateApproved has copy, drop {
    policy_id: ID,
    digest_len: u64,
    issued: u64,
}

public struct OwnerApproved has copy, drop {
    policy_id: ID,
    digest_len: u64,
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

/// Attach a `DWalletCap` to a new shared `SubnamePolicy`.
/// Returns the `OwnerCap` so the caller can compose transfer/custody
/// decisions inside the same PTB (non-composable self-transfer avoided).
public fun init_policy(
    dwallet_cap: DWalletCap,
    max_subnames: u64,
    expiration_ms: u64,
    ctx: &mut TxContext,
): OwnerCap {
    let policy_uid = object::new(ctx);
    let policy_id = policy_uid.to_inner();

    let owner_cap = OwnerCap { id: object::new(ctx), policy_id };
    let owner_cap_id = object::id(&owner_cap);

    let policy = SubnamePolicy {
        id: policy_uid,
        dwallet_cap,
        owner_cap_id,
        max_subnames,
        issued_count: 0,
        expiration_ms,
    };

    event::emit(PolicyCreated {
        policy_id,
        max_subnames,
        expiration_ms,
    });

    transfer::share_object(policy);
    owner_cap
}

// ------------------------------------------------------------------
// Delegate path — quota + expiration bounded
// ------------------------------------------------------------------

/// Produce a `MessageApproval` for the delegate. Burns one quota slot.
/// This is THE spike entry — if IKA's `approve_message` accepts a borrowed
/// `DWalletCap` from inside a shared object, the pattern is proven.
///
/// Caller must also pass the IKA `DWalletCoordinator` shared singleton:
///   mainnet id: 0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3
public fun delegate_approve_spike(
    policy: &mut SubnamePolicy,
    coordinator: &mut DWalletCoordinator,
    message: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
): MessageApproval {
    assert!(clock.timestamp_ms() < policy.expiration_ms, E_EXPIRED);
    assert!(policy.issued_count < policy.max_subnames, E_QUOTA_EXCEEDED);

    policy.issued_count = policy.issued_count + 1;

    let digest_len = message.length();
    let approval = coordinator::approve_message(
        coordinator,
        &policy.dwallet_cap,
        SIG_ALG_ECDSA_SECP256K1,
        HASH_KECCAK256,
        message,
    );

    event::emit(DelegateApproved {
        policy_id: policy.id.to_inner(),
        digest_len,
        issued: policy.issued_count,
    });

    approval
}

// ------------------------------------------------------------------
// Owner path — unrestricted
// ------------------------------------------------------------------

/// Produce a `MessageApproval` for the owner. No quota, no expiration —
/// but requires the matching `OwnerCap` and the IKA coordinator singleton.
public fun owner_approve(
    policy: &SubnamePolicy,
    owner_cap: &OwnerCap,
    coordinator: &mut DWalletCoordinator,
    message: vector<u8>,
): MessageApproval {
    assert!(owner_cap.policy_id == policy.id.to_inner(), E_NOT_OWNER);

    let digest_len = message.length();
    let approval = coordinator::approve_message(
        coordinator,
        &policy.dwallet_cap,
        SIG_ALG_ECDSA_SECP256K1,
        HASH_KECCAK256,
        message,
    );

    event::emit(OwnerApproved {
        policy_id: policy.id.to_inner(),
        digest_len,
    });

    approval
}

// ------------------------------------------------------------------
// Views
// ------------------------------------------------------------------

public fun issued_count(policy: &SubnamePolicy): u64 { policy.issued_count }
public fun max_subnames(policy: &SubnamePolicy): u64 { policy.max_subnames }
public fun remaining(policy: &SubnamePolicy): u64 {
    policy.max_subnames - policy.issued_count
}
public fun expiration_ms(policy: &SubnamePolicy): u64 { policy.expiration_ms }
public fun owner_cap_id(policy: &SubnamePolicy): ID { policy.owner_cap_id }
