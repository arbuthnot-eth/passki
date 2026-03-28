// Copyright (c) 2026 SKI
// SPDX-License-Identifier: MIT

/// Thunder — Seal-encrypt messaging between SuiNS identities.
///
/// Thunderbun is a shared object. Anyone can deposit a pointer
/// (permissionless send). Only the SuiNS name owner can pop/read
/// (Seal-gated decrypt + NFT ownership check).
///
/// On-chain, a deposit reveals only: name_hash + timestamp.
/// The actual sender, message, and content are inside a Seal-encrypt
/// blob stored on Walrus, decryptable only by the NFT owner.
module thunder::thunder;

use sui::dynamic_field;
use sui::hash::keccak256;
use sui::event;
use sui::clock::Clock;
use suins::suins_registration::SuinsRegistration;

// ─── Errors ──────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EEmptyInbox: u64 = 1;

// ─── Events ─────────────────────────────────────────────────────────

public struct ThunderDeposited has copy, drop {
    name_hash: vector<u8>,
    timestamp_ms: u64,
}

public struct ThunderPopped has copy, drop {
    name_hash: vector<u8>,
    blob_id: vector<u8>,
}

// ─── Types ──────────────────────────────────────────────────────────

public struct Thunderbun has key {
    id: UID,
}

public struct ThunderPointer has store, copy, drop {
    blob_id: vector<u8>,
    sealed_namespace: vector<u8>,
    timestamp_ms: u64,
}

public struct ThunderInbox has store {
    pointers: vector<ThunderPointer>,
}

// ─── Init ───────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    let mailbox = Thunderbun {
        id: object::new(ctx),
    };
    transfer::share_object(mailbox);
}

// ─── Public functions ───────────────────────────────────────────────

/// Deposit a Thunder pointer. Permissionless — anyone can send.
entry fun deposit(
    mailbox: &mut Thunderbun,
    name_hash: vector<u8>,
    blob_id: vector<u8>,
    sealed_namespace: vector<u8>,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    let timestamp_ms = clock.timestamp_ms();
    let pointer = ThunderPointer { blob_id, sealed_namespace, timestamp_ms };

    if (dynamic_field::exists_(&mailbox.id, name_hash)) {
        let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut mailbox.id, name_hash);
        inbox.pointers.push_back(pointer);
    } else {
        let inbox = ThunderInbox { pointers: vector[pointer] };
        dynamic_field::add(&mut mailbox.id, name_hash, inbox);
    };

    event::emit(ThunderDeposited { name_hash, timestamp_ms });
}

/// Pop the first Thunder pointer. Requires the SuinsRegistration NFT.
entry fun pop(
    mailbox: &mut Thunderbun,
    name_hash: vector<u8>,
    nft: &SuinsRegistration,
    _ctx: &TxContext,
) {
    // Verify the NFT's domain hashes to the requested name_hash
    let domain_bytes = nft.domain().to_string().into_bytes();
    let computed_hash = keccak256(&domain_bytes);
    assert!(computed_hash == name_hash, ENotOwner);

    let inbox: &mut ThunderInbox = dynamic_field::borrow_mut(&mut mailbox.id, name_hash);
    assert!(!inbox.pointers.is_empty(), EEmptyInbox);

    let pointer = inbox.pointers.remove(0);
    event::emit(ThunderPopped { name_hash, blob_id: pointer.blob_id });
}

/// Count pending Thunders. Permissionless read.
public fun count(mailbox: &Thunderbun, name_hash: vector<u8>): u64 {
    if (!dynamic_field::exists_(&mailbox.id, name_hash)) return 0;
    let inbox: &ThunderInbox = dynamic_field::borrow(&mailbox.id, name_hash);
    inbox.pointers.length()
}

/// Read the first pointer without popping. Permissionless (blob is encrypt anyway).
public fun peek(mailbox: &Thunderbun, name_hash: vector<u8>): (vector<u8>, vector<u8>, u64) {
    let inbox: &ThunderInbox = dynamic_field::borrow(&mailbox.id, name_hash);
    assert!(!inbox.pointers.is_empty(), EEmptyInbox);
    let p = &inbox.pointers[0];
    (p.blob_id, p.sealed_namespace, p.timestamp_ms)
}

// ─── Seal policy ────────────────────────────────────────────────────

/// Seal approval entry point. Key servers call this to verify the caller
/// owns the SuinsRegistration NFT for the name encrypt under `id`.
entry fun seal_approve(id: vector<u8>, nft: &SuinsRegistration, _ctx: &TxContext) {
    let domain_bytes = nft.domain().to_string().into_bytes();
    let ns = keccak256(&domain_bytes);
    assert!(is_prefix(ns, id), ENotOwner);
}

// ─── Helpers ────────────────────────────────────────────────────────

fun is_prefix(prefix: vector<u8>, data: vector<u8>): bool {
    if (prefix.length() > data.length()) return false;
    let mut i = 0;
    while (i < prefix.length()) {
        if (prefix[i] != data[i]) return false;
        i = i + 1;
    };
    true
}
