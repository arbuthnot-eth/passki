#[test_only]
module storm::cumulo_tests;

use storm::cumulo;
use std::string;
use sui::clock;
use sui::test_scenario as ts;

const ALICE: address = @0xa11ce;
const BOB: address = @0xb0b;

fun fake_bytes(n: u64, byte: u8): vector<u8> {
    let mut v = vector[];
    let mut i = 0;
    while (i < n) { v.push_back(byte); i = i + 1; };
    v
}

#[test]
fun open_emits_event_and_initializes_state() {
    let mut sc = ts::begin(ALICE);
    let cumulo = cumulo::open(
        string::utf8(b"weekend ski crew"),
        b"walrus_blob_id_xyz",
        fake_bytes(32, 0x41),
        sc.ctx(),
    );
    assert!(cumulo::creator(&cumulo) == ALICE, 0);
    assert!(cumulo::n_bolts(&cumulo) == 0, 1);
    assert!(cumulo::epoch(&cumulo) == 0, 2);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::EBadSaltSize)]
fun open_rejects_short_salt() {
    let mut sc = ts::begin(ALICE);
    let cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(16, 0), // wrong size
        sc.ctx(),
    );
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::EBadBlobIdSize)]
fun open_rejects_oversized_blob_id() {
    let mut sc = ts::begin(ALICE);
    let cumulo = cumulo::open(
        string::utf8(b"x"),
        fake_bytes(128, 0), // exceeds MAX_BLOB_ID_BYTES (64)
        fake_bytes(32, 0),
        sc.ctx(),
    );
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
fun light_bolt_adds_member_and_increments_count() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_700_000_000_000);

    let recipient_id = fake_bytes(32, 0xab);
    let encrypted_aes_key = fake_bytes(704, 0xcd);
    cumulo::light_bolt(&mut cumulo, recipient_id, encrypted_aes_key, &clk, sc.ctx());

    assert!(cumulo::n_bolts(&cumulo) == 1, 0);
    assert!(cumulo::has_bolt(&cumulo, fake_bytes(32, 0xab)), 1);
    assert!(cumulo::bolt_lit_at_ms(&cumulo, fake_bytes(32, 0xab)) == 1_700_000_000_000, 2);

    clock::destroy_for_testing(clk);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::ENotCreator)]
fun light_bolt_rejects_non_creator() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    let clk = clock::create_for_testing(sc.ctx());

    sc.next_tx(BOB);
    cumulo::light_bolt(
        &mut cumulo,
        fake_bytes(32, 1),
        fake_bytes(704, 0),
        &clk,
        sc.ctx(),
    );

    clock::destroy_for_testing(clk);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::EBoltAlreadyLit)]
fun light_bolt_rejects_duplicate_recipient() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    let clk = clock::create_for_testing(sc.ctx());

    cumulo::light_bolt(&mut cumulo, fake_bytes(32, 0xab), fake_bytes(704, 0), &clk, sc.ctx());
    cumulo::light_bolt(&mut cumulo, fake_bytes(32, 0xab), fake_bytes(704, 0), &clk, sc.ctx());

    clock::destroy_for_testing(clk);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::EBadRecipientIdSize)]
fun light_bolt_rejects_short_recipient_id() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    let clk = clock::create_for_testing(sc.ctx());

    cumulo::light_bolt(&mut cumulo, fake_bytes(16, 1), fake_bytes(704, 0), &clk, sc.ctx());

    clock::destroy_for_testing(clk);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
fun go_dark_removes_bolt() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    let clk = clock::create_for_testing(sc.ctx());

    let rid = fake_bytes(32, 7);
    cumulo::light_bolt(&mut cumulo, rid, fake_bytes(704, 0), &clk, sc.ctx());
    assert!(cumulo::n_bolts(&cumulo) == 1, 0);

    cumulo::go_dark(&mut cumulo, fake_bytes(32, 7), sc.ctx());
    assert!(cumulo::n_bolts(&cumulo) == 0, 1);
    assert!(!cumulo::has_bolt(&cumulo, fake_bytes(32, 7)), 2);

    clock::destroy_for_testing(clk);
    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
#[expected_failure(abort_code = cumulo::EBoltNotFound)]
fun go_dark_rejects_unknown_recipient() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );

    cumulo::go_dark(&mut cumulo, fake_bytes(32, 99), sc.ctx());

    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
fun rotate_salt_bumps_epoch() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );
    assert!(cumulo::epoch(&cumulo) == 0, 0);

    cumulo::rotate_salt(&mut cumulo, fake_bytes(32, 0xff), sc.ctx());
    assert!(cumulo::epoch(&cumulo) == 1, 1);
    assert!(*cumulo::storm_salt(&cumulo) == fake_bytes(32, 0xff), 2);

    sui::transfer::public_share_object(cumulo);
    sc.end();
}

#[test]
fun rotate_blob_bumps_epoch_and_replaces_id() {
    let mut sc = ts::begin(ALICE);
    let mut cumulo = cumulo::open(
        string::utf8(b"x"),
        b"old_blob",
        fake_bytes(32, 0),
        sc.ctx(),
    );

    cumulo::rotate_blob(&mut cumulo, b"new_walrus_blob", sc.ctx());
    assert!(cumulo::epoch(&cumulo) == 1, 0);
    assert!(*cumulo::walrus_blob_id(&cumulo) == b"new_walrus_blob", 1);

    sui::transfer::public_share_object(cumulo);
    sc.end();
}
