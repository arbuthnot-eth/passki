#[test_only]
module darkrai::inbox_tests;

use darkrai::inbox::{Self, Inbox};
use std::string;
use sui::clock;
use sui::test_scenario as ts;

const ALICE: address = @0xa11ce;
const BOB: address = @0xb0b;

const EK_BYTES: u64 = 576;

fun fake_bytes(n: u64, byte: u8): vector<u8> {
    let mut v = vector[];
    let mut i = 0;
    while (i < n) { v.push_back(byte); i = i + 1; };
    v
}

#[test]
fun open_inbox_emits_event_and_stores_ek() {
    let mut sc = ts::begin(ALICE);
    let ek = fake_bytes(EK_BYTES, 0x42);
    let committee_ref = b"committee:thunder-stack-2of3";
    let inbox = inbox::open(
        string::utf8(b"alice.sui"),
        ek,
        committee_ref,
        16, // ell_max
        0,  // no padding
        sc.ctx(),
    );
    assert!(inbox::owner(&inbox) == ALICE, 0);
    assert!(inbox::ell_max(&inbox) == 16, 1);
    assert!(inbox::epoch_padding(&inbox) == 0, 2);
    assert!(inbox::current_epoch_no(&inbox) == 0, 3);
    sui::transfer::public_share_object(inbox);
    sc.end();
}

#[test]
#[expected_failure(abort_code = inbox::EBadEkSize)]
fun open_inbox_rejects_wrong_ek_size() {
    let mut sc = ts::begin(ALICE);
    let inbox = inbox::open(
        string::utf8(b"alice.sui"),
        fake_bytes(64, 0), // wrong size
        b"",
        16,
        0,
        sc.ctx(),
    );
    sui::transfer::public_share_object(inbox);
    sc.end();
}

#[test]
#[expected_failure(abort_code = inbox::EEllNotPowerOfTwo)]
fun open_inbox_rejects_non_power_of_two_ell() {
    let mut sc = ts::begin(ALICE);
    let inbox = inbox::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        15, // not power of two
        0,
        sc.ctx(),
    );
    sui::transfer::public_share_object(inbox);
    sc.end();
}

#[test]
fun set_epoch_padding_owner_only() {
    let mut sc = ts::begin(ALICE);
    let mut inbox = inbox::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        16,
        0,
        sc.ctx(),
    );
    inbox::set_epoch_padding(&mut inbox, 8, sc.ctx());
    assert!(inbox::epoch_padding(&inbox) == 8, 0);
    sui::transfer::public_share_object(inbox);
    sc.end();
}

#[test]
#[expected_failure(abort_code = inbox::ENotOwner)]
fun set_epoch_padding_rejects_non_owner() {
    let mut sc = ts::begin(ALICE);
    let mut inbox = inbox::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        16,
        0,
        sc.ctx(),
    );
    sc.next_tx(BOB);
    // Bob is not owner
    inbox::set_epoch_padding(&mut inbox, 8, sc.ctx());
    sui::transfer::public_share_object(inbox);
    sc.end();
}
