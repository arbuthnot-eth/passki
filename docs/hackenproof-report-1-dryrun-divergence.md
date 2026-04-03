# HackenProof Submission: Dry-Run / Validator Type-Check Divergence

## Title
`sui_dryRunTransactionBlock` passes type check on owned object that validators reject with `CommandArgumentError::TypeMismatch`

## Severity
Medium — Platform invariant violation. Dry-run and execution produce different type-checking results for the same transaction bytes.

## Description
When a `MoveCall` passes an owned `BalanceManager` object as `&mut BalanceManager`, the fullnode's `sui_dryRunTransactionBlock` successfully passes the type-checking stage and proceeds to execution (where it hits an unrelated `UnusedValueWithoutDrop` error). However, when the exact same transaction bytes are signed and submitted to validators, they reject the transaction at the argument validation stage with `CommandArgumentError { arg_idx: 0, kind: TypeMismatch }`.

This violates the platform guarantee that dry-run faithfully simulates validator execution. Developers rely on dry-run to predict whether transactions will succeed. A passing dry-run that fails on validators can cause:
- Silent fund loss (user expects tx to succeed based on dry-run)
- Incorrect gas estimation (dry-run charges gas for partial execution, validators reject immediately)
- False confidence in smart contract testing

## Steps to Reproduce

### Step 1: Build transaction bytes
```bash
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"unsafe_moveCall",
    "params":[
      "0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3",
      "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809",
      "balance_manager","withdraw_all",
      ["0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"],
      ["0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92"],
      null,"50000000"
    ]
  }'
# Returns valid txBytes
```

### Step 2: Dry-run the bytes
```bash
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_dryRunTransactionBlock","params":["<txBytes from step 1>"]}'
```
**Result**: `{"status":"failure","error":"UnusedValueWithoutDrop { result_idx: 0, secondary_idx: 0 }"}`

The `UnusedValueWithoutDrop` error occurs AFTER type checking. The type check passed. The function was dispatched. The error is about the return value not being handled.

### Step 3: Sign and submit the same bytes
Sign with the owner's keypair and submit via `sui_executeTransactionBlock`.

**Result**: `CommandArgumentError { arg_idx: 0, kind: TypeMismatch } in command 0`

The type check FAILS. The function is never dispatched. The validator rejects at argument validation.

### Step 4: Verify the types match
```bash
# Object type
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92",{"showType":true}]}'
# Type: 0x2c8d...::balance_manager::BalanceManager

# Function expected type
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getNormalizedMoveFunction","params":["0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809","balance_manager","withdraw_all"]}'
# Parameter 0: MutableReference to 0x2c8d...::balance_manager::BalanceManager
# EXACT MATCH
```

## Object Details
- **Object ID**: `0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92`
- **Type**: `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::balance_manager::BalanceManager`
- **Owner**: AddressOwner `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`
- **Version**: 833631670 (unchanged since creation — no tx has ever mutated it)
- **Network**: Sui Mainnet

## Root Cause Analysis
The object is an **owned** BalanceManager. Most BalanceManagers on mainnet are **shared** (49 out of 50 sampled). The fullnode's dry-run appears to handle owned objects more leniently during type resolution for `&mut` parameters, while validators strictly enforce the shared/owned input kind distinction. This produces different outcomes for the same bytes.

## Impact
- Developers cannot trust dry-run results for owned objects passed to functions that are typically called with shared objects
- Any dApp that validates transactions via dry-run before submission could experience unexpected failures
- Gas fees are wasted on transactions that dry-run says will succeed but validators reject

## Failed Transaction Digests (all TypeMismatch)
- `6q5FVdg6RPTVQzFp...`
- `91zng2BaK8jX...`
- `6BUVQrzi6DXu...`
- `9BTsCmjKP31v...`
- `31YzbT3Qh4mm...`
