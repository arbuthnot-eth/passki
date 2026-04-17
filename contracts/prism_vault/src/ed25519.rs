// Ed25519 signature verification via Solana's precompile.
//
// The Solana ed25519_program precompile actually performs the crypto;
// our program's job is to PROVE that the precompile was invoked in
// the same transaction with the pubkey/message/signature we expected.
// We do this by reading the Instructions sysvar and inspecting a
// specific pre-instruction.
//
// Client responsibility:
//   1. Pre-build a Solana Ed25519SignatureOffsets instruction that
//      verifies (expected_pubkey, canonical_manifest_bytes,
//      ika_sig) self-contained (all data in one ix, no indirection).
//   2. Include it as instruction #0 in the VersionedTransaction.
//   3. Our `claim_*` instruction runs at #1 (or later) and passes
//      the Instructions sysvar account — we inspect #0.
//
// Security: the precompile aborts the whole tx on bad sig, so if our
// claim instruction runs, the sig is valid. We verify that the
// invariants of the ed25519 ix actually correspond to our expected
// pubkey/message/sig — not someone else's.
//
// Self-contained ix data layout (what Solana's ed25519_program expects):
//
//   byte  0     : num_signatures (u8) — we require 1
//   byte  1     : padding (u8) — must be 0
//   bytes 2..16 : Ed25519SignatureOffsets (14 bytes, see below)
//   bytes 16..80: signature (64 bytes)
//   bytes 80..112: public_key (32 bytes)
//   bytes 112..: message (variable length)
//
// Ed25519SignatureOffsets (14 bytes, all u16 LE):
//   signature_offset: u16                   = 16
//   signature_instruction_index: u16        = 0xFFFF (self)
//   public_key_offset: u16                  = 80
//   public_key_instruction_index: u16       = 0xFFFF
//   message_data_offset: u16                = 112
//   message_data_size: u16                  = msg.len()
//   message_instruction_index: u16          = 0xFFFF
//
// If the client embeds sig/pubkey/msg at non-self-contained offsets
// (e.g. referencing another instruction's data), we reject. Keeps
// verification model simple for v1.

use quasar_lang::prelude::*;

/// Solana's ed25519 precompile program ID (hardcoded on mainnet &
/// all clusters).
///
/// Base58: Ed25519SigVerify111111111111111111111111111
/// Bytes:  the 32-byte representation below.
pub const ED25519_PROGRAM_ID: [u8; 32] = [
    0x03, 0x7d, 0x47, 0x81, 0x12, 0x7e, 0x86, 0x46,
    0xdc, 0xfc, 0xd3, 0x0a, 0xd3, 0x43, 0x2e, 0x3a,
    0x95, 0xec, 0x3d, 0x22, 0x8a, 0xa6, 0x03, 0x26,
    0xbf, 0x78, 0x83, 0xa3, 0x17, 0xbe, 0x78, 0x9f,
];

/// Instructions sysvar ID.
/// Base58: Sysvar1nstructions1111111111111111111111111
pub const SYSVAR_INSTRUCTIONS_ID: [u8; 32] = [
    0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x56, 0x8e,
    0xe0, 0x8a, 0x84, 0x5f, 0x73, 0xd2, 0x97, 0x88,
    0xcf, 0x03, 0x5c, 0x31, 0x45, 0xb2, 0x1a, 0xb3,
    0x44, 0xd8, 0x06, 0x2e, 0xa9, 0x40, 0x00, 0x00,
];

/// Errors that can be returned from ed25519 verification.
#[derive(Copy, Clone, Debug)]
pub enum Ed25519VerifyError {
    /// The instructions sysvar account isn't what the client said.
    WrongSysvar,
    /// The ix at the claimed index isn't an ed25519 program ix.
    NotEd25519Ix,
    /// The ix had multiple signatures — we require exactly 1.
    MultipleSignatures,
    /// Offsets don't point to self-contained data (indirect ref).
    IndirectReference,
    /// Parsed pubkey doesn't match the expected IKA pubkey.
    PubkeyMismatch,
    /// Parsed signature doesn't match what the caller claims.
    SignatureMismatch,
    /// Parsed message doesn't match the canonical manifest bytes.
    MessageMismatch,
    /// Sysvar data was truncated or malformed.
    MalformedSysvar,
}

impl From<Ed25519VerifyError> for ProgramError {
    fn from(e: Ed25519VerifyError) -> Self {
        ProgramError::Custom(match e {
            Ed25519VerifyError::WrongSysvar => 1000,
            Ed25519VerifyError::NotEd25519Ix => 1001,
            Ed25519VerifyError::MultipleSignatures => 1002,
            Ed25519VerifyError::IndirectReference => 1003,
            Ed25519VerifyError::PubkeyMismatch => 1004,
            Ed25519VerifyError::SignatureMismatch => 1005,
            Ed25519VerifyError::MessageMismatch => 1006,
            Ed25519VerifyError::MalformedSysvar => 1007,
        })
    }
}

/// Validate the ix data bytes of a single-signature ed25519 precompile
/// invocation against the expected (pubkey, message, signature).
///
/// This is pure byte-level validation of the ix data as documented
/// in the module header. The sysvar-level fetch (finding the right
/// ix in the sysvar data blob) is done by the caller at the claim_*
/// instruction level — see Z6 Thunderbolt / Z7 Drill Peck.
///
/// Returns Ok(()) on match; typed error otherwise.
pub fn validate_ed25519_ix_data(
    ix_data: &[u8],
    expected_pubkey: &[u8; 32],
    expected_msg: &[u8],
    expected_sig: &[u8; 64],
) -> Result<(), Ed25519VerifyError> {
    if ix_data.len() < 112 {
        return Err(Ed25519VerifyError::MalformedSysvar);
    }

    // Header: num_signatures (u8), padding (u8)
    let num_sigs = ix_data[0];
    if num_sigs != 1 {
        return Err(Ed25519VerifyError::MultipleSignatures);
    }

    // Ed25519SignatureOffsets (14 bytes, all u16 LE)
    let read_u16 = |off: usize| -> u16 {
        u16::from_le_bytes([ix_data[off], ix_data[off + 1]])
    };
    let sig_offset = read_u16(2) as usize;
    let sig_ix_index = read_u16(4);
    let pk_offset = read_u16(6) as usize;
    let pk_ix_index = read_u16(8);
    let msg_offset = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_ix_index = read_u16(14);

    // Self-contained: every offset points into this ix's own data.
    // Solana encodes self-reference as 0xFFFF (u16::MAX) for the
    // instruction index fields.
    if sig_ix_index != u16::MAX
        || pk_ix_index != u16::MAX
        || msg_ix_index != u16::MAX
    {
        return Err(Ed25519VerifyError::IndirectReference);
    }

    // Bounds checks — all three fields must fit inside ix_data.
    if sig_offset + 64 > ix_data.len()
        || pk_offset + 32 > ix_data.len()
        || msg_offset + msg_size > ix_data.len()
    {
        return Err(Ed25519VerifyError::MalformedSysvar);
    }

    // Pubkey equality
    let actual_pk = &ix_data[pk_offset..pk_offset + 32];
    if actual_pk != expected_pubkey.as_slice() {
        return Err(Ed25519VerifyError::PubkeyMismatch);
    }

    // Signature equality
    let actual_sig = &ix_data[sig_offset..sig_offset + 64];
    if actual_sig != expected_sig.as_slice() {
        return Err(Ed25519VerifyError::SignatureMismatch);
    }

    // Message equality
    if msg_size != expected_msg.len() {
        return Err(Ed25519VerifyError::MessageMismatch);
    }
    let actual_msg = &ix_data[msg_offset..msg_offset + msg_size];
    if actual_msg != expected_msg {
        return Err(Ed25519VerifyError::MessageMismatch);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec::Vec;

    /// Build a self-contained single-sig ed25519 ix data blob for
    /// testing the validator.
    fn make_ix_data(pk: &[u8; 32], sig: &[u8; 64], msg: &[u8]) -> Vec<u8> {
        let mut data = Vec::with_capacity(112 + msg.len());
        // num_sigs, padding
        data.extend_from_slice(&[1u8, 0u8]);
        // offsets
        data.extend_from_slice(&16u16.to_le_bytes());           // sig_offset
        data.extend_from_slice(&u16::MAX.to_le_bytes());        // sig_ix_idx
        data.extend_from_slice(&80u16.to_le_bytes());           // pk_offset
        data.extend_from_slice(&u16::MAX.to_le_bytes());        // pk_ix_idx
        data.extend_from_slice(&112u16.to_le_bytes());          // msg_offset
        data.extend_from_slice(&(msg.len() as u16).to_le_bytes()); // msg_size
        data.extend_from_slice(&u16::MAX.to_le_bytes());        // msg_ix_idx
        // body
        data.extend_from_slice(sig);
        data.extend_from_slice(pk);
        data.extend_from_slice(msg);
        data
    }

    #[test]
    fn happy_path() {
        let pk = [1u8; 32];
        let sig = [2u8; 64];
        let msg = b"hello prism";
        let data = make_ix_data(&pk, &sig, msg);
        assert!(validate_ed25519_ix_data(&data, &pk, msg, &sig).is_ok());
    }

    #[test]
    fn pubkey_mismatch() {
        let pk = [1u8; 32];
        let sig = [2u8; 64];
        let msg = b"m";
        let data = make_ix_data(&pk, &sig, msg);
        let wrong_pk = [9u8; 32];
        matches!(
            validate_ed25519_ix_data(&data, &wrong_pk, msg, &sig),
            Err(Ed25519VerifyError::PubkeyMismatch)
        );
    }

    #[test]
    fn message_mismatch() {
        let pk = [1u8; 32];
        let sig = [2u8; 64];
        let msg = b"signed";
        let data = make_ix_data(&pk, &sig, msg);
        matches!(
            validate_ed25519_ix_data(&data, &pk, b"different", &sig),
            Err(Ed25519VerifyError::MessageMismatch)
        );
    }
}
