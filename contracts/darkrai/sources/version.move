module darkrai::version;

use sui::package;

const EInvalidVersion: u64 = 0;

const PACKAGE_VERSION: u64 = 1;

public struct VERSION() has drop;

public struct Version has key {
    id: UID,
    version: u64,
}

fun init(otw: VERSION, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);
    transfer::share_object(Version {
        id: object::new(ctx),
        version: PACKAGE_VERSION,
    });
}

public fun current(v: &Version): u64 { v.version }

public fun assert_current(v: &Version) {
    assert!(v.version == PACKAGE_VERSION, EInvalidVersion);
}
