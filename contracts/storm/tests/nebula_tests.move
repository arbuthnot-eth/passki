#[test_only]
module storm::nebula_tests;

use storm::nebula;
use std::string;
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
fun open_nebula_emits_event_and_stores_ek() {
    let mut sc = ts::begin(ALICE);
    let ek = fake_bytes(EK_BYTES, 0x42);
    let committee_ref = b"committee:thunder-stack-2of3";
    let nebula = nebula::open(
        string::utf8(b"alice.sui"),
        ek,
        committee_ref,
        16,
        0,
        sc.ctx(),
    );
    assert!(nebula::owner(&nebula) == ALICE, 0);
    assert!(nebula::ell_max(&nebula) == 16, 1);
    assert!(nebula::epoch_padding(&nebula) == 0, 2);
    assert!(nebula::current_epoch_no(&nebula) == 0, 3);
    sui::transfer::public_share_object(nebula);
    sc.end();
}

#[test]
#[expected_failure(abort_code = nebula::EBadEkSize)]
fun open_nebula_rejects_wrong_ek_size() {
    let mut sc = ts::begin(ALICE);
    let nebula = nebula::open(
        string::utf8(b"alice.sui"),
        fake_bytes(64, 0),
        b"",
        16,
        0,
        sc.ctx(),
    );
    sui::transfer::public_share_object(nebula);
    sc.end();
}

#[test]
#[expected_failure(abort_code = nebula::EEllNotPowerOfTwo)]
fun open_nebula_rejects_non_power_of_two_ell() {
    let mut sc = ts::begin(ALICE);
    let nebula = nebula::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        15,
        0,
        sc.ctx(),
    );
    sui::transfer::public_share_object(nebula);
    sc.end();
}

#[test]
fun set_epoch_padding_owner_only() {
    let mut sc = ts::begin(ALICE);
    let mut nebula = nebula::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        16,
        0,
        sc.ctx(),
    );
    nebula::set_epoch_padding(&mut nebula, 8, sc.ctx());
    assert!(nebula::epoch_padding(&nebula) == 8, 0);
    sui::transfer::public_share_object(nebula);
    sc.end();
}

#[test]
#[expected_failure(abort_code = nebula::ENotOwner)]
fun set_epoch_padding_rejects_non_owner() {
    let mut sc = ts::begin(ALICE);
    let mut nebula = nebula::open(
        string::utf8(b"alice.sui"),
        fake_bytes(EK_BYTES, 0),
        b"",
        16,
        0,
        sc.ctx(),
    );
    sc.next_tx(BOB);
    nebula::set_epoch_padding(&mut nebula, 8, sc.ctx());
    sui::transfer::public_share_object(nebula);
    sc.end();
}
