/// Module: storm::cumulo
///
/// Shared on-chain group-conversation cloud — the cumulonimbus that holds
/// a Storm. Group messaging dedupe path alongside per-recipient `nebula`.
///
/// ONE Walrus blob holds the encrypted content (Quilt-batched). Per-member
/// access tickets ("Bolts") live as `Table<RecipientId, Bolt>` entries on
/// this object, keyed by a *blinded* RecipientId so chain observers can't
/// reconstruct readership without knowing the per-Cumulo `storm_salt`.
///
/// ## Adaptive routing (client-side)
///
///   payload < 1KB && recipients ≤ 2  → direct Nebula encryption
///   payload > 1KB || recipients > 2  → Cumulo (this module)
///
/// Below the break-even threshold (~1KB plaintext per Aletheia's analysis),
/// per-recipient direct Nebula encryption beats the Walrus + dynamic-field
/// overhead. Above it, Cumulo wins by O(N).
///
/// ## Vocabulary
///
///   Cumulo  — the storm cloud (cumulonimbus). Holds the Quilt blob.
///   Bolt    — per-member access ticket. Lighting a bolt = adding a member;
///             going dark = revoking. Bolts are AES-key envelopes encrypted
///             to the recipient's `ek_user` (their Nebula's encryption key).
///   Salt    — the `storm_salt` rotates per epoch for forward secrecy +
///             cross-thunder unlinkability (Pistis + Dikaiosyne mitigations).
///
/// ## Privacy properties
///
///   - **RecipientId blinding.** Stored as `hash(dWallet_pubkey || storm_salt)`.
///     Chain observers see opaque 32-byte keys; without the salt they can't
///     match a key to a recipient or reconstruct group membership.
///   - **Forward secrecy via salt rotation.** `rotate_salt()` invalidates
///     all current RecipientId mappings. Creator must re-light bolts with
///     new IDs after rotation. Old keys become unmatched dust the creator
///     can sweep via `go_dark`.
///   - **Blob rotation.** `rotate_blob()` swaps the underlying Walrus
///     ciphertext — used to invalidate stored content for revoked members.
///
/// Move never decrypts. Pairing math + AES happen client-side.
module storm::cumulo;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// === Error Codes ===

const ENotCreator: u64 = 0;
const EBoltAlreadyLit: u64 = 1;
const EBoltNotFound: u64 = 2;
const EBadSaltSize: u64 = 3;
const EBadRecipientIdSize: u64 = 4;
const EBadBlobIdSize: u64 = 5;

// === Constants ===

const SALT_BYTES: u64 = 32;
const RECIPIENT_ID_BYTES: u64 = 32;
const MIN_BLOB_ID_BYTES: u64 = 1;
const MAX_BLOB_ID_BYTES: u64 = 64;

// === Structs ===

public struct Cumulo has key, store {
    id: UID,
    /// Address that opened the Cumulo. Holds bolt-management auth.
    creator: address,
    /// Display name (e.g. "weekend ski crew"). Informational.
    name: String,
    /// Walrus blob id of the encrypted content. Quilt-batched typically.
    walrus_blob_id: vector<u8>,
    /// 32 bytes. Mixed into RecipientId so chain observers can't dehash.
    storm_salt: vector<u8>,
    /// RecipientId → Bolt. Each Bolt is the recipient's AES-key envelope.
    bolts: Table<vector<u8>, Bolt>,
    /// Bumped on `rotate_salt` and `rotate_blob`.
    epoch: u64,
    version: u64,
}

public struct Bolt has store, drop {
    /// AES-256-GCM key for the Walrus blob, encrypted to the recipient's
    /// `ek_user` via batch-threshold encryption (BE_short / BLS12-381).
    /// 704 B compressed.
    encrypted_aes_key: vector<u8>,
    lit_at_ms: u64,
}

// === Events ===

public struct CumuloOpened has copy, drop {
    cumulo: ID,
    creator: address,
    name: String,
}

public struct BoltLit has copy, drop {
    cumulo: ID,
    /// Blinded — hash(dWallet_pubkey || storm_salt). Observers learn nothing
    /// about identity without the salt.
    recipient_id: vector<u8>,
    epoch: u64,
}

public struct BoltDarkened has copy, drop {
    cumulo: ID,
    recipient_id: vector<u8>,
    epoch: u64,
}

public struct StormSaltRotated has copy, drop {
    cumulo: ID,
    new_epoch: u64,
}

public struct WalrusBlobRotated has copy, drop {
    cumulo: ID,
    new_blob_id: vector<u8>,
    new_epoch: u64,
}

public struct ThunderPosted has copy, drop {
    cumulo: ID,
    sender: address,
    /// Slot index inside the Quilt blob (caller-determined).
    slot: u64,
    epoch: u64,
}

// === Open ===

public fun open(
    name: String,
    walrus_blob_id: vector<u8>,
    storm_salt: vector<u8>,
    ctx: &mut TxContext,
): Cumulo {
    assert!(storm_salt.length() == SALT_BYTES, EBadSaltSize);
    let blob_len = walrus_blob_id.length();
    assert!(blob_len >= MIN_BLOB_ID_BYTES && blob_len <= MAX_BLOB_ID_BYTES, EBadBlobIdSize);

    let creator = ctx.sender();
    let cumulo = Cumulo {
        id: object::new(ctx),
        creator,
        name,
        walrus_blob_id,
        storm_salt,
        bolts: table::new(ctx),
        epoch: 0,
        version: 1,
    };
    event::emit(CumuloOpened {
        cumulo: object::id(&cumulo),
        creator,
        name: cumulo.name,
    });
    cumulo
}

// === Bolt management (creator-only) ===

public fun light_bolt(
    cumulo: &mut Cumulo,
    recipient_id: vector<u8>,
    encrypted_aes_key: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == cumulo.creator, ENotCreator);
    assert!(recipient_id.length() == RECIPIENT_ID_BYTES, EBadRecipientIdSize);
    assert!(!cumulo.bolts.contains(recipient_id), EBoltAlreadyLit);
    let bolt = Bolt {
        encrypted_aes_key,
        lit_at_ms: clock.timestamp_ms(),
    };
    cumulo.bolts.add(recipient_id, bolt);
    event::emit(BoltLit {
        cumulo: object::id(cumulo),
        recipient_id,
        epoch: cumulo.epoch,
    });
}

public fun go_dark(
    cumulo: &mut Cumulo,
    recipient_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == cumulo.creator, ENotCreator);
    assert!(cumulo.bolts.contains(recipient_id), EBoltNotFound);
    let _bolt = cumulo.bolts.remove(recipient_id);
    event::emit(BoltDarkened {
        cumulo: object::id(cumulo),
        recipient_id,
        epoch: cumulo.epoch,
    });
}

// === Forward-secrecy rotations (creator-only) ===

/// Rotate the storm_salt. Existing RecipientIds were computed under the
/// old salt and no longer match recipients' canonical identities. Creator
/// is expected to `go_dark` stale entries and `light_bolt` re-keyed
/// entries after rotation. Bumps epoch.
public fun rotate_salt(
    cumulo: &mut Cumulo,
    new_salt: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == cumulo.creator, ENotCreator);
    assert!(new_salt.length() == SALT_BYTES, EBadSaltSize);
    cumulo.storm_salt = new_salt;
    cumulo.epoch = cumulo.epoch + 1;
    event::emit(StormSaltRotated {
        cumulo: object::id(cumulo),
        new_epoch: cumulo.epoch,
    });
}

/// Replace the underlying Walrus blob id. Use to invalidate prior
/// ciphertext for revoked members (combine with `go_dark` + new bolts
/// for the surviving membership). Bumps epoch.
public fun rotate_blob(
    cumulo: &mut Cumulo,
    new_blob_id: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == cumulo.creator, ENotCreator);
    let blob_len = new_blob_id.length();
    assert!(blob_len >= MIN_BLOB_ID_BYTES && blob_len <= MAX_BLOB_ID_BYTES, EBadBlobIdSize);
    cumulo.walrus_blob_id = new_blob_id;
    cumulo.epoch = cumulo.epoch + 1;
    event::emit(WalrusBlobRotated {
        cumulo: object::id(cumulo),
        new_blob_id: cumulo.walrus_blob_id,
        new_epoch: cumulo.epoch,
    });
}

// === Thunder posting ===

/// Emit-only — the actual thunder content lives in the Walrus blob (the
/// caller has rotated/extended it as needed). This event is the delivery
/// signal recipient watchers subscribe to. Sender is whoever signs the
/// tx — which can be anyone (Cumulo doesn't restrict posters; access
/// control is at the AES-key layer).
public fun post_thunder(
    cumulo: &Cumulo,
    slot: u64,
    ctx: &TxContext,
) {
    event::emit(ThunderPosted {
        cumulo: object::id(cumulo),
        sender: ctx.sender(),
        slot,
        epoch: cumulo.epoch,
    });
}

// === Read accessors ===

public fun creator(cumulo: &Cumulo): address { cumulo.creator }
public fun name(cumulo: &Cumulo): &String { &cumulo.name }
public fun walrus_blob_id(cumulo: &Cumulo): &vector<u8> { &cumulo.walrus_blob_id }
public fun storm_salt(cumulo: &Cumulo): &vector<u8> { &cumulo.storm_salt }
public fun n_bolts(cumulo: &Cumulo): u64 { cumulo.bolts.length() }
public fun epoch(cumulo: &Cumulo): u64 { cumulo.epoch }

public fun has_bolt(cumulo: &Cumulo, recipient_id: vector<u8>): bool {
    cumulo.bolts.contains(recipient_id)
}

public fun bolt_aes_key(cumulo: &Cumulo, recipient_id: vector<u8>): &vector<u8> {
    &cumulo.bolts.borrow(recipient_id).encrypted_aes_key
}

public fun bolt_lit_at_ms(cumulo: &Cumulo, recipient_id: vector<u8>): u64 {
    cumulo.bolts.borrow(recipient_id).lit_at_ms
}
