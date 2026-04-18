// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

// Sneasel Meditate (#197) — Guest Stealth entry-fn tests.
//
// Exercises bind/revoke/reap/seal_approve + view helpers added in Ice Shard.
// Run: `sui move test` from contracts/suiami/.

#[test_only]
module suiami::guest_stealth_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use suiami::roster::{Self, Roster};

// Error codes (mirror roster.move)
const ENotOwner: u64 = 0;
const EGuestNotBound: u64 = 10;

const OWNER: address = @0xB0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0B0;
const STRANGER: address = @0x5757575757575757575757575757575757575757575757575757575757575757;
const DELEGATE: address = @0xDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDEDE;

const LABEL: vector<u8> = b"amazon";
const LABEL2: vector<u8> = b"venmo";
const HOT_ADDR_1: vector<u8> = b"0x1111111111111111111111111111111111111111";
const HOT_ADDR_2: vector<u8> = b"0x2222222222222222222222222222222222222222";
const SEALED_1: vector<u8> = b"sealed-ciphertext-v1";
const SEALED_2: vector<u8> = b"sealed-ciphertext-v2";
const ONE_DAY_MS: u64 = 86_400_000;
const T0: u64 = 1_700_000_000_000;

fun owner_name_hash(): vector<u8> {
    let mut h = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { h.push_back(0xBBu8); i = i + 1; };
    h
}

/// Init roster + register an OWNER identity so `assert_parent_owner`
/// finds a record under `owner_name_hash()`.
fun setup_owner(scenario: &mut ts::Scenario, clk: &clock::Clock) {
    roster::init_for_testing(ts::ctx(scenario));
    ts::next_tx(scenario, OWNER);

    let mut r = ts::take_shared<Roster>(scenario);
    let keys = vector[string::utf8(b"eth")];
    let values = vector[string::utf8(b"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")];
    roster::set_identity(
        &mut r,
        string::utf8(b"alice"),
        owner_name_hash(),
        keys,
        values,
        vector::empty<address>(),
        string::utf8(b""),
        vector::empty<u8>(),
        clk,
        ts::ctx(scenario),
    );
    ts::return_shared(r);
    ts::next_tx(scenario, OWNER);
}

fun fresh_clock(scenario: &mut ts::Scenario): clock::Clock {
    let mut clk = clock::create_for_testing(ts::ctx(scenario));
    clock::set_for_testing(&mut clk, T0);
    clk
}

// ─── 1. Bind happy path ─────────────────────────────────────────────

#[test]
fun bind_happy_path() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );

    assert!(roster::has_guest_stealth(&r, owner_name_hash(), LABEL), 0);
    let hot = roster::guest_stealth_hot_addr(&r, owner_name_hash(), LABEL, &clk);
    assert!(hot == string::utf8(HOT_ADDR_1), 1);
    let chain = roster::guest_stealth_chain(&r, owner_name_hash(), LABEL);
    assert!(chain == string::utf8(b"eth"), 2);
    let exp = roster::guest_stealth_expires_ms(&r, owner_name_hash(), LABEL);
    assert!(exp == T0 + ONE_DAY_MS, 3);
    let del = roster::guest_stealth_sweep_delegate(&r, owner_name_hash(), LABEL);
    assert!(del == DELEGATE, 4);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 2. Bind overwrite ──────────────────────────────────────────────

#[test]
fun bind_overwrites_existing() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    // First bind.
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    // Overwrite with different hot addr + chain + sealed blob + delegate.
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_2),
        string::utf8(b"sol"),
        SEALED_2,
        ONE_DAY_MS * 2,
        STRANGER, // new delegate
        &clk,
        ts::ctx(&mut scenario),
    );

    // Second bind won — no leak of first record.
    let hot = roster::guest_stealth_hot_addr(&r, owner_name_hash(), LABEL, &clk);
    assert!(hot == string::utf8(HOT_ADDR_2), 0);
    let chain = roster::guest_stealth_chain(&r, owner_name_hash(), LABEL);
    assert!(chain == string::utf8(b"sol"), 1);
    let del = roster::guest_stealth_sweep_delegate(&r, owner_name_hash(), LABEL);
    assert!(del == STRANGER, 2);
    let exp = roster::guest_stealth_expires_ms(&r, owner_name_hash(), LABEL);
    assert!(exp == T0 + ONE_DAY_MS * 2, 3);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 3. Bind from non-owner → ENotOwner ─────────────────────────────

#[test]
#[expected_failure(abort_code = ENotOwner, location = suiami::roster)]
fun bind_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    // Switch sender to STRANGER (does not own the parent record).
    ts::next_tx(&mut scenario, STRANGER);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 4. Revoke by parent owner ──────────────────────────────────────

#[test]
fun revoke_by_parent_owner() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    roster::revoke_guest_stealth(&mut r, owner_name_hash(), LABEL, ts::ctx(&mut scenario));
    assert!(!roster::has_guest_stealth(&r, owner_name_hash(), LABEL), 0);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 5. Revoke by sweep_delegate ────────────────────────────────────

#[test]
fun revoke_by_sweep_delegate() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    // Switch sender to DELEGATE.
    ts::next_tx(&mut scenario, DELEGATE);
    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::revoke_guest_stealth(&mut r2, owner_name_hash(), LABEL, ts::ctx(&mut scenario));
    assert!(!roster::has_guest_stealth(&r2, owner_name_hash(), LABEL), 0);

    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 6. Revoke by random sender → ENotOwner ─────────────────────────

#[test]
#[expected_failure(abort_code = ENotOwner, location = suiami::roster)]
fun revoke_by_random_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    ts::next_tx(&mut scenario, STRANGER);
    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::revoke_guest_stealth(&mut r2, owner_name_hash(), LABEL, ts::ctx(&mut scenario));
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 7. Reap before expiry → EGuestNotBound (used as "not ready") ──

#[test]
#[expected_failure(abort_code = EGuestNotBound, location = suiami::roster)]
fun reap_before_expiry_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    // Clock still at T0 → not expired.
    roster::reap_guest_stealth(&mut r, owner_name_hash(), LABEL, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 8. Reap after expiry — permissionless ─────────────────────────

#[test]
fun reap_after_expiry_permissionless() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    // Fast-forward past expiry, switch to STRANGER (permissionless reap).
    clock::set_for_testing(&mut clk, T0 + ONE_DAY_MS + 1);
    ts::next_tx(&mut scenario, STRANGER);
    let mut r2 = ts::take_shared<Roster>(&mut scenario);
    roster::reap_guest_stealth(&mut r2, owner_name_hash(), LABEL, &clk, ts::ctx(&mut scenario));
    assert!(!roster::has_guest_stealth(&r2, owner_name_hash(), LABEL), 0);

    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 9. seal_approve by delegate, not expired — passes ─────────────

#[test]
fun seal_approve_by_delegate_ok() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    ts::next_tx(&mut scenario, DELEGATE);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    // Must not abort.
    roster::seal_approve_guest_stealth(
        &r2,
        owner_name_hash(),
        LABEL,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 10. seal_approve by non-delegate → ENotOwner ──────────────────

#[test]
#[expected_failure(abort_code = ENotOwner, location = suiami::roster)]
fun seal_approve_by_non_delegate_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    // Even the parent owner is NOT the sweep delegate → should abort.
    // (OWNER != DELEGATE.)
    ts::next_tx(&mut scenario, OWNER);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    roster::seal_approve_guest_stealth(
        &r2,
        owner_name_hash(),
        LABEL,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 11. seal_approve after expiry by delegate → EGuestNotBound ────

#[test]
#[expected_failure(abort_code = EGuestNotBound, location = suiami::roster)]
fun seal_approve_after_expiry_aborts() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);

    // Fast-forward past expiry. Delegate itself can't decrypt anymore
    // (auto-lockdown enforced at read time as well as bind time).
    clock::set_for_testing(&mut clk, T0 + ONE_DAY_MS + 1);
    ts::next_tx(&mut scenario, DELEGATE);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    roster::seal_approve_guest_stealth(
        &r2,
        owner_name_hash(),
        LABEL,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 12. View helper on missing key → EGuestNotBound ───────────────

#[test]
#[expected_failure(abort_code = EGuestNotBound, location = suiami::roster)]
fun view_helper_missing_key_aborts() {
    let mut scenario = ts::begin(OWNER);
    let clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let r = ts::take_shared<Roster>(&mut scenario);
    // Never bound LABEL2 — chain helper should abort EGuestNotBound.
    let _ = roster::guest_stealth_chain(&r, owner_name_hash(), LABEL2);
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 13. guest_stealth_hot_addr after expiry → EGuestNotBound ──────

#[test]
#[expected_failure(abort_code = EGuestNotBound, location = suiami::roster)]
fun hot_addr_after_expiry_aborts() {
    let mut scenario = ts::begin(OWNER);
    let mut clk = fresh_clock(&mut scenario);
    setup_owner(&mut scenario, &clk);

    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::bind_guest_stealth(
        &mut r,
        owner_name_hash(),
        LABEL,
        string::utf8(HOT_ADDR_1),
        string::utf8(b"eth"),
        SEALED_1,
        ONE_DAY_MS,
        DELEGATE,
        &clk,
        ts::ctx(&mut scenario),
    );

    // Fast-forward past expiry; read-side lockdown must kick in.
    clock::set_for_testing(&mut clk, T0 + ONE_DAY_MS + 1);
    let _ = roster::guest_stealth_hot_addr(&r, owner_name_hash(), LABEL, &clk);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}
