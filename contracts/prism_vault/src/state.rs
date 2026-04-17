// Prism Vault on-chain state.
//
// Two account types:
//   VaultConfig — singleton config holding admin + fee params.
//     Seeds: [b"config"] — one per program.
//   Nullifier  — per-claim marker, keyed on the 16-byte prismId.
//     Seeds: [b"nullifier", prism_id] — exists iff the Prism has
//     been claimed. Init-or-fail enforces single-claim semantics.

use quasar_lang::prelude::*;

#[account(discriminator = 1, set_inner)]
#[seeds(b"config")]
pub struct VaultConfig {
    /// Admin who can update fee params. Initialized to ultron.sui's
    /// Solana address.
    pub admin: Address,
    /// Fee in basis points (1 bp = 0.01%) skimmed from claim output
    /// into `fee_vault`. Default 10 = 0.1%.
    pub fee_bps: u16,
    /// ATA that receives the fee skim. Owned by ultron's Solana address.
    pub fee_vault: Address,
    /// PDA bump.
    pub bump: u8,
}

#[account(discriminator = 2, set_inner)]
#[seeds(b"nullifier", prism_id: [u8; 16])]
pub struct Nullifier {
    /// The 16-byte UUID of the Prism manifest this nullifier consumes.
    pub prism_id: [u8; 16],
    /// Unix timestamp of consumption (i64 to match Clock::unix_timestamp).
    pub claimed_at: i64,
    /// PDA bump.
    pub bump: u8,
}
