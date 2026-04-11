// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

/// Thunder IOU — on-chain escrow between SuiNS identities.
///
/// Each IOU is a self-contained SHARED object: sender locks SUI,
/// recipient claims with their own signature, sender (or any keeper)
/// recalls after TTL expiry. No cross-conversation parent; each send
/// lives on its own derived address for zero contention.
///
/// Claim is gated on `tx_context.sender() == iou.recipient`, so the
/// recipient's address must be known at create time. The sealed_memo
/// field carries the Seal-encrypted storm-visible context so only
/// participants can read amounts, tags, or message text.
module thunder_iou::iou;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::clock::Clock;
use sui::event;
use sui::sui::SUI;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotRecipient: u64 = 0;
const ENotSender: u64 = 1;
const ENotExpired: u64 = 2;
const EAlreadyExpired: u64 = 3;
const EZeroAmount: u64 = 4;

// ─── Type ───────────────────────────────────────────────────────────

/// Shared escrow object. One per send.
public struct Iou has key {
    id: UID,
    /// Who locked the funds
    sender: address,
    /// Who can claim before expiry
    recipient: address,
    /// Locked SUI balance
    balance: Balance<SUI>,
    /// Absolute expiry (ms since epoch)
    expires_ms: u64,
    /// Seal-encrypted private context (amount label, tags, memo)
    sealed_memo: vector<u8>,
}

// ─── Events ─────────────────────────────────────────────────────────

public struct IouCreated has copy, drop {
    iou_id: address,
    sender: address,
    recipient: address,
    amount_mist: u64,
    expires_ms: u64,
}

public struct IouClaimed has copy, drop {
    iou_id: address,
    recipient: address,
    amount_mist: u64,
}

public struct IouRecalled has copy, drop {
    iou_id: address,
    sender: address,
    amount_mist: u64,
}

// ─── Create ─────────────────────────────────────────────────────────

/// Sender locks a SUI coin into a new shared Iou object.
/// Call in the same PTB as Storm creation + SUIAMI attestation.
///
/// payment: the Coin<SUI> to escrow (typically a splitCoins result)
/// recipient: the address that can claim before expiry
/// ttl_ms: duration in ms from now (e.g. 604_800_000 for 7 days)
/// sealed_memo: Seal-encrypted context (empty vector if none)
entry fun create(
    payment: Coin<SUI>,
    recipient: address,
    ttl_ms: u64,
    sealed_memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);

    let expires_ms = clock.timestamp_ms() + ttl_ms;
    let iou = Iou {
        id: object::new(ctx),
        sender: ctx.sender(),
        recipient,
        balance: coin::into_balance(payment),
        expires_ms,
        sealed_memo,
    };

    event::emit(IouCreated {
        iou_id: object::uid_to_address(&iou.id),
        sender: iou.sender,
        recipient,
        amount_mist: amount,
        expires_ms,
    });

    transfer::share_object(iou);
}

// ─── Claim ──────────────────────────────────────────────────────────

/// Recipient consumes the Iou and receives the locked SUI.
/// Fails if the caller is not the recipient or if the TTL has lapsed.
entry fun claim(
    iou: Iou,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let Iou { id, sender: _, recipient, balance: bal, expires_ms, sealed_memo: _ } = iou;
    assert!(ctx.sender() == recipient, ENotRecipient);
    assert!(clock.timestamp_ms() < expires_ms, EAlreadyExpired);

    let amount = balance::value(&bal);
    let iou_addr = object::uid_to_address(&id);
    object::delete(id);

    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, recipient);

    event::emit(IouClaimed {
        iou_id: iou_addr,
        recipient,
        amount_mist: amount,
    });
}

// ─── Recall ─────────────────────────────────────────────────────────

/// The sender can always reclaim their own deposit; anyone else must
/// wait until expiry. Balance always returns to the original sender so
/// post-TTL keeper sweeps remain safe. Sender-anytime is the escape
/// hatch for "sent to the wrong wallet" and for UX-initiated recalls.
entry fun recall(
    iou: Iou,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let Iou { id, sender, recipient: _, balance: bal, expires_ms, sealed_memo: _ } = iou;
    assert!(ctx.sender() == sender || clock.timestamp_ms() >= expires_ms, ENotExpired);

    let amount = balance::value(&bal);
    let iou_addr = object::uid_to_address(&id);
    object::delete(id);

    let coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(coin, sender);

    event::emit(IouRecalled {
        iou_id: iou_addr,
        sender,
        amount_mist: amount,
    });
}

// Reserved error code for a future restricted-recall variant.
public fun reserved_not_sender_code(): u64 { ENotSender }
