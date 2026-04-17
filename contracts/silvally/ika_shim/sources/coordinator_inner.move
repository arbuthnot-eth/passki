// IKA shim — coordinator_inner module.
// Mirrors the public surface of the real on-chain IKA package so our
// Silvally policy module can compile. At publish time, bytecode must
// match the real IKA package or Sui will reject the deploy; if that
// happens we regenerate this shim from `sui client object` /
// `sui move disassemble` against the real package.

module ika_dwallet_2pc_mpc::coordinator_inner;

/// The capability that authorizes all signing operations on a dWallet.
/// Held by whoever controls the dWallet. For Silvally, it lives inside
/// a `SubnamePolicy` shared object.
public struct DWalletCap has key, store {
    id: UID,
    dwallet_id: address,
}
