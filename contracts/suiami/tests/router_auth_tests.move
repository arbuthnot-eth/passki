// Copyright (c) 2026 Thunder Storm
// SPDX-License-Identifier: MIT

// Aggron Earthquake — IntentRegistryAnchor + seal_approve_intent_router tests.
//
// Covers:
//   - authorize_router owner-gating (recipient-only)
//   - revoke_router flips has_active_router → false
//   - seal_approve_intent_router aborts for unauthorized router
//   - seal_approve_intent_router passes for authorized router
//   - authorize → revoke → re-authorize round-trip
//
// Run: `sui move test` from contracts/suiami/.

#[test_only]
module suiami::router_auth_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use suiami::roster::{Self, Roster};
use suiami::seal_roster;

// Error codes (mirror roster.move / seal_roster.move)
const ENotRecipient: u64 = 14;
const ENoRouterAuthorization: u64 = 15;
const ENotAuthorizedRouter: u64 = 103;

// Greek/roman god fixtures — Hermes is the recipient, Athena is a
// secondary recipient, Apollo is the router (ultron analogue), Ares
// is an unauthorized third-party, Zeus is a stranger with no record.
const HERMES: address = @0x4E15E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1;
const ATHENA: address = @0xA1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1A1E1;
const APOLLO: address = @0xA9010A9010A9010A9010A9010A9010A9010A9010A9010A9010A9010A9010A901;
const ARES:   address = @0xA7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5A7E5;
const ZEUS:   address = @0x2E152E152E152E152E152E152E152E152E152E152E152E152E152E152E152E15;

const T0: u64 = 1_700_000_000_000;
const T1: u64 = 1_700_000_060_000; // T0 + 60s

fun hermes_name_hash(): vector<u8> {
    let mut h = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { h.push_back(0xE5u8); i = i + 1; };
    h
}

fun athena_name_hash(): vector<u8> {
    let mut h = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { h.push_back(0xA1u8); i = i + 1; };
    h
}

fun seal_id_for(name_hash: vector<u8>): vector<u8> {
    // 40-byte Seal id = 32-byte name_hash ‖ 8-byte version suffix (zeros).
    let mut id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) {
        id.push_back(*name_hash.borrow(i));
        i = i + 1;
    };
    let mut j = 0u64;
    while (j < 8) { id.push_back(0u8); j = j + 1; };
    id
}

fun fresh_clock(scenario: &mut ts::Scenario): clock::Clock {
    let mut clk = clock::create_for_testing(ts::ctx(scenario));
    clock::set_for_testing(&mut clk, T0);
    clk
}

/// Register a recipient under `name_hash` with a non-empty
/// walrus_blob_id so seal_approve_intent_router's ENoEncryptedData
/// check can't short-circuit authorization logic.
fun register_recipient(
    scenario: &mut ts::Scenario,
    recipient: address,
    name: vector<u8>,
    name_hash: vector<u8>,
    clk: &clock::Clock,
) {
    ts::next_tx(scenario, recipient);
    let mut r = ts::take_shared<Roster>(scenario);
    let keys = vector[string::utf8(b"eth")];
    let values = vector[string::utf8(b"0x0000000000000000000000000000000000000001")];
    roster::set_identity(
        &mut r,
        string::utf8(name),
        name_hash,
        keys,
        values,
        vector::empty<address>(),
        string::utf8(b"walrus-blob-placeholder"),
        vector::empty<u8>(),
        clk,
        ts::ctx(scenario),
    );
    ts::return_shared(r);
}

fun setup_hermes(scenario: &mut ts::Scenario, clk: &clock::Clock) {
    roster::init_for_testing(ts::ctx(scenario));
    register_recipient(scenario, HERMES, b"hermes", hermes_name_hash(), clk);
}

// ─── 1. authorize_router is recipient-only ─────────────────────────

#[test]
fun test_authorize_router_by_recipient_only_ok() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(
        &mut r,
        hermes_name_hash(),
        APOLLO,
        &clk,
        ts::ctx(&mut scenario),
    );
    assert!(roster::has_active_router(&r, hermes_name_hash(), APOLLO), 0);
    assert!(!roster::has_active_router(&r, hermes_name_hash(), ARES), 1);
    let authorized_at = roster::router_authorization_authorized_at_ms(&r, hermes_name_hash(), APOLLO);
    assert!(authorized_at == T0, 2);
    let revoked_at = roster::router_authorization_revoked_at_ms(&r, hermes_name_hash(), APOLLO);
    assert!(revoked_at == 0, 3);
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ENotRecipient, location = suiami::roster)]
fun test_authorize_router_by_non_recipient_aborts() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    // Zeus does NOT own the hermes record → should abort with ENotRecipient.
    ts::next_tx(&mut scenario, ZEUS);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(
        &mut r,
        hermes_name_hash(),
        APOLLO,
        &clk,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 2. revoke_router sets revoked_at_ms ───────────────────────────

#[test]
fun test_revoke_router_sets_revoked_at_ms() {
    let mut scenario = ts::begin(HERMES);
    let mut clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    assert!(roster::has_active_router(&r, hermes_name_hash(), APOLLO), 0);

    // Advance clock so revoke_at differs from authorize_at.
    clock::set_for_testing(&mut clk, T1);
    roster::revoke_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    assert!(!roster::has_active_router(&r, hermes_name_hash(), APOLLO), 1);
    let revoked_at = roster::router_authorization_revoked_at_ms(&r, hermes_name_hash(), APOLLO);
    assert!(revoked_at == T1, 2);

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ENoRouterAuthorization, location = suiami::roster)]
fun test_revoke_router_with_no_authorization_aborts() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    // Never authorized Apollo → revoke aborts.
    roster::revoke_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 3. seal_approve_intent_router requires active authorization ───

#[test]
#[expected_failure(abort_code = ENotAuthorizedRouter, location = suiami::seal_roster)]
fun test_seal_approve_intent_router_requires_active_authorization() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    // No authorize_router call — Apollo tries to decrypt → abort.
    ts::next_tx(&mut scenario, APOLLO);
    let r = ts::take_shared<Roster>(&mut scenario);
    seal_roster::seal_approve_intent_router(
        seal_id_for(hermes_name_hash()),
        &r,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 4. seal_approve_intent_router permits authorized router ──────

#[test]
fun test_seal_approve_intent_router_permits_authorized_router() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    ts::next_tx(&mut scenario, APOLLO);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    // Must not abort.
    seal_roster::seal_approve_intent_router(
        seal_id_for(hermes_name_hash()),
        &r2,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ENotAuthorizedRouter, location = suiami::seal_roster)]
fun test_seal_approve_intent_router_rejects_revoked_router() {
    let mut scenario = ts::begin(HERMES);
    let mut clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, T1);
    roster::revoke_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    ts::next_tx(&mut scenario, APOLLO);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    seal_roster::seal_approve_intent_router(
        seal_id_for(hermes_name_hash()),
        &r2,
        ts::ctx(&mut scenario),
    );
    ts::return_shared(r2);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 5. authorize → revoke → re-authorize round-trip ──────────────

#[test]
fun test_authorize_then_revoke_then_reauthorize() {
    let mut scenario = ts::begin(HERMES);
    let mut clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);

    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);

    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    assert!(roster::has_active_router(&r, hermes_name_hash(), APOLLO), 0);

    clock::set_for_testing(&mut clk, T1);
    roster::revoke_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    assert!(!roster::has_active_router(&r, hermes_name_hash(), APOLLO), 1);
    assert!(
        roster::router_authorization_revoked_at_ms(&r, hermes_name_hash(), APOLLO) == T1,
        2,
    );

    // Re-authorize: overwrites stale entry with fresh authorized_at_ms
    // and revoked_at_ms=0.
    let t2: u64 = T1 + 60_000;
    clock::set_for_testing(&mut clk, t2);
    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    assert!(roster::has_active_router(&r, hermes_name_hash(), APOLLO), 3);
    assert!(
        roster::router_authorization_authorized_at_ms(&r, hermes_name_hash(), APOLLO) == t2,
        4,
    );
    assert!(
        roster::router_authorization_revoked_at_ms(&r, hermes_name_hash(), APOLLO) == 0,
        5,
    );

    ts::return_shared(r);
    clock::destroy_for_testing(clk);
    ts::end(scenario);
}

// ─── 6. Authorizations are scoped per (recipient, router) pair ─────

#[test]
fun test_authorizations_are_scoped_per_recipient_and_router() {
    let mut scenario = ts::begin(HERMES);
    let clk = fresh_clock(&mut scenario);
    setup_hermes(&mut scenario, &clk);
    register_recipient(&mut scenario, ATHENA, b"athena", athena_name_hash(), &clk);

    // Hermes authorizes Apollo for hermes' record.
    ts::next_tx(&mut scenario, HERMES);
    let mut r = ts::take_shared<Roster>(&mut scenario);
    roster::authorize_router(&mut r, hermes_name_hash(), APOLLO, &clk, ts::ctx(&mut scenario));
    ts::return_shared(r);

    // Athena has NOT authorized anyone → Apollo can't decrypt athena's blob.
    ts::next_tx(&mut scenario, APOLLO);
    let r2 = ts::take_shared<Roster>(&mut scenario);
    assert!(!roster::has_active_router(&r2, athena_name_hash(), APOLLO), 0);
    // And Ares is not authorized for hermes.
    assert!(!roster::has_active_router(&r2, hermes_name_hash(), ARES), 1);
    // But Apollo is active for hermes.
    assert!(roster::has_active_router(&r2, hermes_name_hash(), APOLLO), 2);
    ts::return_shared(r2);

    clock::destroy_for_testing(clk);
    ts::end(scenario);
}
