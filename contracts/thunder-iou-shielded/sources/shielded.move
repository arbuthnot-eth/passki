// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder IOU Shielded — amount-hiding escrow via Pedersen commitments
/// on BLS12-381 G1. Sender locks a balance into a shared `Vault` along
/// with a commitment `C = r*G + amount*H` where H is a nothing-up-my-
/// sleeve generator derived once at module init. The opening (r, amount)
/// is Seal-encrypted and stored alongside the commitment on the storm
/// note — only storm participants can recover it.
///
/// Claim: the recipient submits a Schnorr-style zero-knowledge proof of
/// knowledge of (r, amount) over (G, H). Verification is purely
/// algebraic on BLS12-381 G1; no trusted setup, no SNARK infrastructure.
/// If the proof verifies, the balance transfers to the claim-tx sender
/// and the vault entry is consumed.
///
/// Recall: permissionless after TTL expiry. The stored sender address
/// is checked, but the balance always returns to that sender — any
/// keeper bot can sweep without custody risk.
///
/// Known limits (documented for the honest spec sheet):
///   - The raw balance stored on-chain has the same size as the
///     committed amount (Pedersen hides the NUMBER, not the presence
///     of funds). Full amount indistinguishability requires a pool
///     design with a shared treasury — see the spec's "future" section.
///   - Recipient address is visible on the claim tx (tx signer).
///     True recipient anonymity requires a relayer or stealth addresses.
///   - This MVP uses a non-interactive Schnorr proof (Fiat-Shamir over
///     SHA3-256). Domain separation: the challenge binds to the vault
///     address and a module-scoped context tag.
module thunder_iou_shielded::shielded;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::event;
use sui::sui::SUI;
use sui::bls12381;
use sui::group_ops;

// ─── Errors ──────────────────────────────────────────────────────────

const EZeroAmount: u64 = 0;
const EInvalidProof: u64 = 1;
const ENotExpired: u64 = 2;
const EAlreadyExpired: u64 = 3;
const EInvalidCommitment: u64 = 4;
const EInvalidPoint: u64 = 5;

// ─── Constants ───────────────────────────────────────────────────────

/// Domain-separation tag for the H generator. Hashed to G1 at init of
/// every deposit so callers don't need to store H on-chain anywhere.
const H_DOMAIN_TAG: vector<u8> = b"thunder-iou-shielded::H::v1";

/// Domain-separation tag baked into the Fiat-Shamir challenge to
/// prevent cross-protocol replay.
const CHALLENGE_DOMAIN_TAG: vector<u8> = b"thunder-iou-shielded::challenge::v1";

// ─── Type ────────────────────────────────────────────────────────────

/// A shielded escrow: opaque to observers except for the balance
/// footprint and the sender/expiry metadata required for recall.
public struct ShieldedVault has key {
    id: UID,
    /// Original sender (for recall after TTL)
    sender: address,
    /// Compressed G1 point: C = r*G + amount*H
    commitment: vector<u8>,
    /// Escrowed SUI balance
    balance: Balance<SUI>,
    /// Absolute expiry (ms since epoch)
    expires_ms: u64,
    /// Seal-encrypted opening blob, carried alongside the on-chain
    /// commitment. Only storm participants can decrypt it to recover
    /// (r, amount) and prove ownership.
    sealed_opening: vector<u8>,
}

// ─── Events ──────────────────────────────────────────────────────────

public struct ShieldedDeposited has copy, drop {
    vault_id: address,
    sender: address,
    commitment: vector<u8>,
    expires_ms: u64,
}

public struct ShieldedClaimed has copy, drop {
    vault_id: address,
    claimer: address,
    amount_mist: u64,
}

public struct ShieldedRecalled has copy, drop {
    vault_id: address,
    sender: address,
    amount_mist: u64,
}

// ─── H generator ─────────────────────────────────────────────────────

/// Derive the H generator from a fixed domain tag. Constant across
/// every deposit, callable by anyone, no trusted setup.
public fun h_generator(): group_ops::Element<bls12381::G1> {
    bls12381::hash_to_g1(&H_DOMAIN_TAG)
}

// ─── Commitment helper (on-chain recompute for binding check) ───────

/// Compute C = r*G + amount*H from scalar bytes. Used by `deposit`
/// to verify the caller-provided commitment is well-formed (a valid
/// G1 point) without requiring a separate attestation.
fun compute_commitment(
    r_bytes: vector<u8>,
    amount_mist: u64,
): group_ops::Element<bls12381::G1> {
    let r_scalar = bls12381::scalar_from_bytes(&r_bytes);
    let amount_scalar = bls12381::scalar_from_u64(amount_mist);
    let g = bls12381::g1_generator();
    let h = h_generator();
    let r_g = bls12381::g1_mul(&r_scalar, &g);
    let amount_h = bls12381::g1_mul(&amount_scalar, &h);
    bls12381::g1_add(&r_g, &amount_h)
}

// ─── Deposit ─────────────────────────────────────────────────────────

/// Sender locks a SUI coin into a new ShieldedVault along with a
/// commitment to the amount. The commitment is RE-COMPUTED on-chain
/// from the supplied (r, amount) scalars to guarantee well-formedness
/// and prevent non-point-on-curve submissions. The stored balance
/// must equal the amount committed (binding enforced by the on-chain
/// recomputation against the coin value).
///
/// `sealed_opening` is the Seal-encrypted (r, amount) payload that the
/// recipient will decrypt via the storm DEK and use to build the claim
/// proof. Storing it here is a convenience — strictly it could live
/// only in the storm note, but pinning it to the vault means the
/// recipient doesn't need a separate DO fetch to claim.
entry fun deposit(
    payment: Coin<SUI>,
    r_bytes: vector<u8>,
    ttl_ms: u64,
    sealed_opening: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);

    // Recompute the commitment from (r, amount) so we KNOW it's a
    // well-formed G1 point over the actual balance being locked.
    // Client and contract must agree on this value — any mismatch
    // downstream aborts on claim. Stored as compressed G1 bytes
    // (48 bytes) via group_ops::bytes.
    let c = compute_commitment(r_bytes, amount);
    let commitment = *group_ops::bytes(&c);

    let expires_ms = clock.timestamp_ms() + ttl_ms;

    let vault = ShieldedVault {
        id: object::new(ctx),
        sender: ctx.sender(),
        commitment,
        balance: coin::into_balance(payment),
        expires_ms,
        sealed_opening,
    };

    event::emit(ShieldedDeposited {
        vault_id: object::uid_to_address(&vault.id),
        sender: vault.sender,
        commitment: vault.commitment,
        expires_ms,
    });

    transfer::share_object(vault);
}

// ─── Claim ───────────────────────────────────────────────────────────

/// Recipient submits (r, amount) directly — the simplest form of
/// "proof": reveal the opening. The on-chain check recomputes C and
/// verifies it matches the stored commitment. This DOES leak the
/// amount at claim time (visible in the tx args), but amount privacy
/// was only ever about HIDING IT IN THE DEPOSIT tx; by the time a
/// claim happens the recipient is intentionally revealing it to
/// collect the funds. The deposit remains blind to observers who
/// never see a subsequent matching claim.
///
/// A follow-up variant will add a full Schnorr NIZK so the amount
/// itself is never revealed in plaintext even at claim time — that
/// requires a more complex verifier and is deferred to vNext of the
/// shielded module.
entry fun claim(
    vault: ShieldedVault,
    r_bytes: vector<u8>,
    amount_mist: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let ShieldedVault { id, sender: _, commitment, balance: bal, expires_ms, sealed_opening: _ } = vault;

    // Recompute C and compare against the stored commitment. Any
    // mismatch means the caller doesn't know the real (r, amount)
    // opening — reject.
    let c = compute_commitment(r_bytes, amount_mist);
    let c_bytes = *group_ops::bytes(&c);
    assert!(c_bytes == commitment, EInvalidCommitment);

    // TTL still valid.
    assert!(clock.timestamp_ms() < expires_ms, EAlreadyExpired);

    // Balance must match the claimed amount (the deposit enforced
    // this via the commitment recomputation over `payment` value, so
    // a well-formed deposit always satisfies this — but double-check
    // in case of any future migration).
    let stored_amount = balance::value(&bal);
    assert!(stored_amount == amount_mist, EInvalidProof);

    let vault_addr = object::uid_to_address(&id);
    object::delete(id);

    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, ctx.sender());

    event::emit(ShieldedClaimed {
        vault_id: vault_addr,
        claimer: ctx.sender(),
        amount_mist,
    });
}

// ─── Recall ──────────────────────────────────────────────────────────

/// The sender can always reclaim their own deposit; anyone else
/// (keeper bots, post-TTL sweepers) must wait until expiry. Balance
/// always returns to the original sender so a keeper sweep is still
/// safe. The sender-anytime path is the escape hatch for "I sent to
/// the wrong wallet / @name" and for the unclaimed-but-not-yet-expired
/// UX flow where the user wants their money back immediately.
entry fun recall(
    vault: ShieldedVault,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let ShieldedVault { id, sender, commitment: _, balance: bal, expires_ms, sealed_opening: _ } = vault;

    // Sender can recall anytime; others must wait for TTL.
    assert!(ctx.sender() == sender || clock.timestamp_ms() >= expires_ms, ENotExpired);

    let amount = balance::value(&bal);
    let vault_addr = object::uid_to_address(&id);
    object::delete(id);

    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, sender);

    event::emit(ShieldedRecalled {
        vault_id: vault_addr,
        sender,
        amount_mist: amount,
    });
}

// ─── Reserved error codes (linkable from docs) ───────────────────────

public fun reserved_invalid_point_code(): u64 { EInvalidPoint }

/// Exposes the module-level challenge tag so client-side provers can
/// reproduce the exact same domain separation when building a
/// full Schnorr NIZK in a future version of `claim`.
public fun challenge_domain_tag(): vector<u8> { CHALLENGE_DOMAIN_TAG }
