// Canonical Prism manifest parser.
//
// Client side (`src/client/prism.ts`) builds a JSON object in a fixed
// SIGNED_FIELDS order, serializes with JSON.stringify, and signs the
// resulting UTF-8 bytes via IKA's Solana-key dWallet. The program
// receives those exact bytes as `manifest_json` and must extract
// the fields it needs for dispatch + nullifier derivation.
//
// We DO NOT use serde_json — it requires alloc. The canonicalization
// shape is known, so we use a tiny byte-scanning extractor targeted
// at the specific keys we care about. For v1, that's just
//   `schema`      (assert == 1)
//   `targetChain` (assert == "solana")
//   `prismId`     (UUID string → 16-byte nullifier seed)
//
// amount / recipient / mint / dwalletCapRef / note / stormId /
// thunderId / createdAt / senderAddress / senderSignature are
// ignored in this module; claim_* instructions (Z6 Thunderbolt,
// Z7 Drill Peck) extract them as they become relevant.

use quasar_lang::prelude::*;

#[derive(Debug, Copy, Clone)]
pub enum ManifestError {
    BadSchema,
    WrongTargetChain,
    MissingPrismId,
    BadPrismIdFormat,
}

impl From<ManifestError> for ProgramError {
    fn from(e: ManifestError) -> Self {
        ProgramError::Custom(match e {
            ManifestError::BadSchema => 2000,
            ManifestError::WrongTargetChain => 2001,
            ManifestError::MissingPrismId => 2002,
            ManifestError::BadPrismIdFormat => 2003,
        })
    }
}

pub struct ParsedManifest {
    /// UUID bytes — used as nullifier PDA seed (single-claim enforcement).
    pub prism_id: [u8; 16],
}

/// Validate a canonical Prism manifest and extract fields the
/// program needs. Rejects non-v1 schemas, non-Solana target chains,
/// and malformed prismIds. Does not verify the signature — that's
/// Signal Beam's job (src/ed25519.rs).
pub fn parse_manifest(bytes: &[u8]) -> Result<ParsedManifest, ManifestError> {
    // Schema: must be exactly 1. Client-side canonicalization puts
    // this first, so the needle `"schema":1` is present iff v1.
    if !contains(bytes, br#""schema":1"#) {
        return Err(ManifestError::BadSchema);
    }
    // Target chain: must be exactly "solana".
    if !contains(bytes, br#""targetChain":"solana""#) {
        return Err(ManifestError::WrongTargetChain);
    }
    // Extract prismId's string value. The shape is
    //   "prismId":"<36-char-uuid>"
    let needle = br#""prismId":""#;
    let start = find(bytes, needle).ok_or(ManifestError::MissingPrismId)? + needle.len();
    if start + 36 > bytes.len() || bytes[start + 36] != b'"' {
        return Err(ManifestError::BadPrismIdFormat);
    }
    let uuid_str = &bytes[start..start + 36];
    let prism_id = parse_uuid_hex(uuid_str).ok_or(ManifestError::BadPrismIdFormat)?;
    Ok(ParsedManifest { prism_id })
}

// ─── Internal byte helpers ──────────────────────────────────────────

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle).is_some()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let end = haystack.len() - needle.len();
    let mut i = 0;
    while i <= end {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn parse_uuid_hex(s: &[u8]) -> Option<[u8; 16]> {
    // UUID string: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" (36 chars)
    if s.len() != 36 {
        return None;
    }
    if s[8] != b'-' || s[13] != b'-' || s[18] != b'-' || s[23] != b'-' {
        return None;
    }
    let mut out = [0u8; 16];
    // Byte positions in the string where each hex byte begins.
    let positions = [0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34];
    let mut i = 0;
    while i < 16 {
        let p = positions[i];
        out[i] = hex_byte(s[p], s[p + 1])?;
        i += 1;
    }
    Some(out)
}

fn hex_byte(hi: u8, lo: u8) -> Option<u8> {
    Some((hex_nibble(hi)? << 4) | hex_nibble(lo)?)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;

    #[test]
    fn parses_valid_manifest() {
        let m = br#"{"schema":1,"prismId":"550e8400-e29b-41d4-a716-446655440000","targetChain":"solana","recipient":"abc","amount":"1000","createdAt":123}"#;
        let parsed = parse_manifest(m).unwrap();
        assert_eq!(
            parsed.prism_id,
            [
                0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4,
                0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00,
            ],
        );
    }

    #[test]
    fn rejects_bad_schema() {
        let m = br#"{"schema":2,"prismId":"550e8400-e29b-41d4-a716-446655440000","targetChain":"solana"}"#;
        matches!(parse_manifest(m), Err(ManifestError::BadSchema));
    }

    #[test]
    fn rejects_non_solana_target() {
        let m = br#"{"schema":1,"prismId":"550e8400-e29b-41d4-a716-446655440000","targetChain":"ethereum"}"#;
        matches!(parse_manifest(m), Err(ManifestError::WrongTargetChain));
    }

    #[test]
    fn rejects_short_prism_id() {
        let m = br#"{"schema":1,"prismId":"abc","targetChain":"solana"}"#;
        matches!(parse_manifest(m), Err(ManifestError::BadPrismIdFormat));
    }

    #[test]
    fn rejects_bad_hex_in_prism_id() {
        // dashes in right positions but a non-hex char
        let m = br#"{"schema":1,"prismId":"ZZZe8400-e29b-41d4-a716-446655440000","targetChain":"solana"}"#;
        matches!(parse_manifest(m), Err(ManifestError::BadPrismIdFormat));
    }

    #[test]
    fn accepts_uppercase_hex() {
        let m = br#"{"schema":1,"prismId":"550E8400-E29B-41D4-A716-446655440000","targetChain":"solana"}"#;
        let parsed = parse_manifest(m).unwrap();
        assert_eq!(parsed.prism_id[0], 0x55);
        assert_eq!(parsed.prism_id[1], 0x0e);
    }
}
