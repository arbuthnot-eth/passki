# HackenProof Submission: Sui Framework `transfer::public_share_object` Returns Misleading Error on Owned Objects

## Title
`0x2::transfer::public_share_object<T>` reports `CommandArgumentError::TypeMismatch` instead of a meaningful error when called on an existing owned object

## Severity
Low — Incorrect error classification. The framework function returns `TypeMismatch` when the actual issue is an ownership state violation. This misleads developers into debugging type issues instead of ownership issues.

## Description
When `0x2::transfer::public_share_object<BalanceManager>` is called on an existing owned `BalanceManager` object, validators return:

```
CommandArgumentError { arg_idx: 0, kind: TypeMismatch } in command 0
```

This is misleading because:
1. The type IS correct (`0x2c8d...::balance_manager::BalanceManager` matches exactly)
2. The actual issue is that Sui doesn't allow sharing an already-existing owned object
3. The error should be something like `CannotShareExistingOwnedObject` or `ObjectAlreadyOwned`, not `TypeMismatch`
4. The deep investigator's dry-run showed `MoveAbort in transfer::share_object_impl code 0` — the CORRECT error. But the signed submission shows `TypeMismatch` — the WRONG error.

This error misclassification caused our team to spend 10+ hours investigating a "type resolution bug" that turned out to be an ownership issue. The `TypeMismatch` error sent us down entirely wrong debugging paths.

## Steps to Reproduce

```bash
# Call public_share_object on an existing owned BalanceManager
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"unsafe_moveCall",
    "params":[
      "0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
      "transfer","public_share_object",
      ["0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::balance_manager::BalanceManager"],
      ["0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92"],
      null,"10000000"
    ]
  }'
# Builds successfully

# Sign and submit → CommandArgumentError { arg_idx: 0, kind: TypeMismatch }
# Expected: A clear error about ownership state, not type mismatch
```

## Impact
- Developers waste significant debugging time chasing phantom type issues
- The error message provides no actionable guidance
- Combined with the dry-run divergence (dry-run shows the correct error, validators show the wrong one), this creates a confusing debugging experience
- Documentation does not warn that `public_share_object` only works on freshly-created objects in the same PTB

## Object Details
- **Object**: `0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92`
- **Type**: `0x2c8d...::balance_manager::BalanceManager` (correct, verified)
- **Owner**: AddressOwner (not shared)
- **Network**: Sui Mainnet
- **Failed Tx**: `6q5FVdg6RPTVQzFp...`

## Recommended Fix
The validator's error path for `public_share_object` on an already-owned object should return a descriptive error like:
```
InvalidOwnershipState { object_id: "0x2261...", expected: "Freshly created (no prior owner)", actual: "AddressOwner" }
```

Instead of the generic `CommandArgumentError::TypeMismatch` which implies the Move type is wrong.

## Network
Sui Mainnet
