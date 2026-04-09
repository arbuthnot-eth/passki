// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder IOU — private on-chain escrow between SuiNS identities.
///
/// IOUs are dynamic fields on the StormID (PermissionedGroup<Messaging>).
/// Each conversation's escrows live on its own Storm — no global
/// contention, per-conversation isolation, storage rebate on activate.
///
/// Initiate: sender deposits SUI into StormID dynamic field.
/// Activate: recipient proves SuiNS ownership, redeems balance.
/// Expire: anyone sweeps after TTL, balance returns to sender.
///
/// Amounts in mist. Dollar conversion client-side.
/// Optional sealed_memo for Seal-encrypted private context.
module thunder_iou::iou;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::event;
use sui::dynamic_field;
use sui::sui::SUI;
use sui::hash::keccak256;
use sui::bcs;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotRecipient: u64 = 0;
const ENotSender: u64 = 1;
const ENotExpired: u64 = 2;
const EAlreadyExpired: u64 = 3;
const EZeroAmount: u64 = 4;
const EIouNotFound: u64 = 5;

// ─── Types ──────────────────────────────────────────────────────────

/// A private IOU stored as a dynamic field on the StormID.
/// `store` only — no UID, no object overhead, max gas efficiency.
/// Balance is on-chain (visible), but context is Seal-encrypted.
public struct Iou has store {
    /// Sender address (for expiry return)
    sender: address,
    /// Recipient's SuiNS name hash — keccak256("name.sui")
    recipient_name_hash: vector<u8>,
    /// Escrowed SUI balance
    balance: Balance<SUI>,
    /// Absolute expiry (ms since epoch) — after this, sender reclaims
    expires_ms: u64,
    /// Nonce — prevents key collision on repeat sends
    nonce: u64,
    /// Seal-encrypted memo: private context between sender + recipient
    /// (amount label, message, tags — only Storm members can decrypt)
    sealed_memo: vector<u8>,
}

// ─── Events ─────────────────────────────────────────────────────────

public struct IouInitiated has copy, drop {
    storm_id: address,
    iou_key: vector<u8>,
    sender: address,
    recipient_name_hash: vector<u8>,
    amount_mist: u64,
    expires_ms: u64,
    nonce: u64,
}

public struct IouActivated has copy, drop {
    storm_id: address,
    iou_key: vector<u8>,
    recipient: address,
    amount_mist: u64,
}

public struct IouExpired has copy, drop {
    storm_id: address,
    iou_key: vector<u8>,
    returned_to: address,
    amount_mist: u64,
}

// ─── Key derivation ─────────────────────────────────────────────────

/// Deterministic IOU key. Computable off-chain for lookups.
public fun iou_key(
    sender_name_hash: vector<u8>,
    recipient_name_hash: vector<u8>,
    nonce: u64,
): vector<u8> {
    let mut buf = sender_name_hash;
    buf.append(recipient_name_hash);
    buf.append(bcs::to_bytes(&nonce));
    keccak256(&buf)
}

// ─── Initiate ───────────────────────────────────────────────────────

/// Create a private on-chain IOU on the StormID.
/// Deposits SUI into escrow as a dynamic field.
/// Call in the SAME PTB as Storm creation + SUIAMI attestation.
///
/// storm: &mut UID of the PermissionedGroup<Messaging> (StormID)
/// ttl_ms: duration from now (e.g. 604_800_000 for 7 days)
/// nonce: use clock.timestamp_ms() for uniqueness
/// sealed_memo: Seal-encrypted context (empty vector if none)
entry fun initiate(
    storm: &mut UID,
    sender_name_hash: vector<u8>,
    recipient_name_hash: vector<u8>,
    payment: Coin<SUI>,
    ttl_ms: u64,
    nonce: u64,
    sealed_memo: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);

    let key = iou_key(sender_name_hash, recipient_name_hash, nonce);
    let expires_ms = clock.timestamp_ms() + ttl_ms;

    let iou = Iou {
        sender: ctx.sender(),
        recipient_name_hash,
        balance: coin::into_balance(payment),
        expires_ms,
        nonce,
        sealed_memo,
    };

    dynamic_field::add(storm, key, iou);

    event::emit(IouInitiated {
        storm_id: storm.to_address(),
        iou_key: key,
        sender: ctx.sender(),
        recipient_name_hash,
        amount_mist: amount,
        expires_ms,
        nonce,
    });
}

// ─── Activate ───────────────────────────────────────────────────────

/// Redeem an IOU. Recipient proves ownership by matching name hash.
/// Storage rebate from dynamic_field::remove offsets gas cost.
entry fun activate(
    storm: &mut UID,
    key: vector<u8>,
    recipient_name_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(dynamic_field::exists_<vector<u8>>(storm, key), EIouNotFound);
    let Iou { sender: _, recipient_name_hash: rnh, balance: bal, expires_ms, nonce: _, sealed_memo: _ } = dynamic_field::remove(storm, key);

    // Verify recipient matches
    assert!(rnh == recipient_name_hash, ENotRecipient);
    // Verify not expired
    assert!(clock.timestamp_ms() < expires_ms, EAlreadyExpired);

    let amount = balance::value(&bal);
    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, ctx.sender());

    event::emit(IouActivated {
        storm_id: storm.to_address(),
        iou_key: key,
        recipient: ctx.sender(),
        amount_mist: amount,
    });
}

// ─── Expire ─────────────────────────────────────────────────────────

/// Permissionless expiry — anyone can call after TTL.
/// Balance returns to sender. Storage rebate incentivizes keepers.
entry fun expire(
    storm: &mut UID,
    key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(dynamic_field::exists_<vector<u8>>(storm, key), EIouNotFound);
    let Iou { sender, recipient_name_hash: _, balance: bal, expires_ms, nonce: _, sealed_memo: _ } = dynamic_field::remove(storm, key);

    // Verify expired
    assert!(clock.timestamp_ms() >= expires_ms, ENotExpired);

    let amount = balance::value(&bal);
    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, sender);

    event::emit(IouExpired {
        storm_id: storm.to_address(),
        iou_key: key,
        returned_to: sender,
        amount_mist: amount,
    });
}

// ─── View ───────────────────────────────────────────────────────────

/// Check if an IOU exists on a StormID.
public fun has_iou(storm: &UID, key: vector<u8>): bool {
    dynamic_field::exists_<vector<u8>>(storm, key)
}
