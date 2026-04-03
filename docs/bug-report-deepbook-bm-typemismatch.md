# Sui Bug Report: Fullnode Dry-Run / Validator Execution Divergence on Owned BalanceManager

## Summary

A valid owned object on Sui mainnet passes type checking in fullnode dry-run (`sui_dryRunTransactionBlock`) but fails with `CommandArgumentError { arg_idx: 0, kind: TypeMismatch }` when the same transaction bytes are signed and submitted to validators. This makes the object's funds permanently inaccessible — ~$63 USD locked with no recovery path.

The dry-run/execution divergence is independently reproducible using the exact transaction bytes and object ID provided below.

## Severity: Critical (Fund Loss)

- **$63 USD permanently locked** (28.99 USDC + 34.74 iUSD) with no on-chain recovery path
- The owner cannot call ANY Move function on the object — not even `0x2::transfer::public_share_object`
- Only `TransferObjects` (PTB built-in, no Move type checking) works
- If this can happen to one object, it can happen to any object on mainnet
- DeepBook v3 BalanceManagers hold user funds — systemic risk to TVL

## Environment

- **Network**: Sui Mainnet
- **Object ID**: `0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92`
- **Object Type**: `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::balance_manager::BalanceManager`
- **Owner**: `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`
- **Object Version**: `833631670` (unchanged — no tx has ever successfully mutated it)
- **Creation Tx**: `7NskzMLCB8kokskVvVWfhJ8fDBsNqyDFnf75LeqVuPJU`
- **DeepBook v3 Package**: `0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497` (version 6)
- **Types Package**: `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809` (version 1)

## The Bug: Two Independent Proofs

### Proof 1: Dry-Run Passes, Execution Fails (Same Bytes)

```bash
# Step 1: Build tx bytes via unsafe_moveCall (fullnode validates and accepts)
TX_BYTES=$(curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
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
  }' | jq -r '.result.txBytes')
# Result: Successfully builds tx bytes (no error)

# Step 2: Dry-run the exact bytes
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_dryRunTransactionBlock\",\"params\":[\"$TX_BYTES\"]}" \
  | jq '.result.effects.status'
# Result: {"status":"failure","error":"UnusedValueWithoutDrop { result_idx: 0, secondary_idx: 0 }"}
# ^^^ TYPE CHECK PASSES. Fails LATER because return value isn't handled.

# Step 3: Sign and submit the SAME bytes to validators
# Result: CommandArgumentError { arg_idx: 0, kind: TypeMismatch } in command 0
# ^^^ TYPE CHECK FAILS at argument validation, BEFORE execution begins.
```

**The same transaction bytes produce different type-checking outcomes on fullnode vs validators.**

### Proof 2: TransferObjects Works, MoveCall Doesn't

```bash
# TransferObjects (PTB built-in, no Move type checking) — WORKS
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":1,
    "method":"unsafe_transferObject",
    "params":[
      "0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3",
      "0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92",
      null,"5000000",
      "0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3"
    ]
  }' | jq '.result.txBytes[0:20]'
# Result: Builds successfully — object is valid for PTB operations

# MoveCall to ANY function — FAILS
# Tested: withdraw_all, generate_proof_as_owner, delete (types package 0x2c8d)
# Tested: withdraw_all, generate_proof_as_owner (entry package 0x337f)
# Tested: 0x2::transfer::public_share_object<BalanceManager> (Sui framework!)
# ALL fail with: CommandArgumentError { arg_idx: 0, kind: TypeMismatch }
```

### Proof 3: Types Match Exactly

```bash
# Object type
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92",{"showType":true}]}' \
  | jq '.result.data.type'
# "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::balance_manager::BalanceManager"

# Function expected type
curl -s -X POST 'https://fullnode.mainnet.sui.io:443' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getNormalizedMoveFunction","params":["0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809","balance_manager","withdraw_all"]}' \
  | jq '.result.parameters[0].MutableReference.Struct.address'
# "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809"
# EXACT MATCH

# Struct layout — identical across both package versions
# Fields: id (UID), owner (address), balances (Bag), allow_listed (VecSet<ID>)
```

### Proof 4: Testnet Repro Does NOT Reproduce

We built a minimal reproduction on testnet:
- Package A defines `Vault` struct (analogous to BalanceManager)
- Package B depends on A, creates owned Vault objects
- Upgraded Package B from v1 to v6 (6 upgrades, matching DeepBook's upgrade count)
- Created owned Vault, deposited SUI, upgraded B, called withdraw — **works perfectly**

Testnet packages:
- pkg_a: `0x82f30de9a94a4cacf9d629228f99101c37d289ed6db05ad1d803961def00074c`
- pkg_b v1: `0x6512c04c694242cf3a56a4d08efddebd25744fbf3093d78b62a1a4d81b67dc51`
- pkg_b v6: `0x87e5f394ee4f8014c1f92c5a6f3a788163018aca039776d9af2db848472c1f1a`
- Vault: `0x8318413006ca2a5395833a9092c822bdea02b27f922b1a4465f5e0614192ff95`

This means the bug is specific to mainnet state — possibly a state inconsistency introduced during a specific DeepBook upgrade, or a validator-specific type resolution issue.

## Failed Transactions (All TypeMismatch)

| Digest | Function Called | Package |
|--------|---------------|---------|
| `6q5FVdg6RPTVQzFp...` | transfer::public_share_object | 0x2 (framework!) |
| `91zng2BaK8jX...` | balance_manager::withdraw_all | 0x2c8d (types) |
| `6BUVQrzi6DXu...` | balance_manager::withdraw_all | 0x337f (entry) |
| `9BTsCmjKP31v...` | balance_manager::generate_proof_as_owner | 0x2c8d |
| `31YzbT3Qh4mm...` | balance_manager::generate_proof_as_owner | 0x337f |
| Multiple others... | Various functions | Various packages |

**Note: Object version is STILL `833631670` (unchanged since creation).** All failed txs were rejected at input validation before execution, so the object was never mutated.

## Impact Assessment

### Direct
- $63 permanently locked in this BalanceManager
- Owner has no on-chain recovery mechanism

### Systemic Risk
- If fullnode and validator type-checking diverge, any dApp relying on dry-run for tx validation could submit transactions that unexpectedly fail
- Users could lose funds in any upgraded package if validators reject objects that fullnodes accept
- DeFi protocols (DeepBook, Cetus, etc.) that upgrade frequently are most at risk
- The `0x2::transfer::public_share_object` failure means even Sui framework functions are affected — this isn't package-specific

### Trust Impact
- Developers trust dry-run to predict execution outcomes
- This violates that trust — a passing dry-run doesn't guarantee the tx will execute
- Smart contract audits that rely on dry-run testing could miss real failures

## Root Cause Hypothesis

The most likely cause is a **state inconsistency** between fullnode and validator views of this specific object's type metadata. Possible mechanisms:

1. **Validator type cache corruption**: Validators may have cached a stale type tag for this object from an intermediate package version, while the fullnode resolved correctly
2. **Linkage table divergence**: The validators and fullnode may resolve the upgraded package's linkage table differently, producing different runtime type tags
3. **Epoch boundary issue**: If the BalanceManager was created near a package upgrade epoch boundary, the validators and fullnode may have different views of which package version was active

## Reproduction Instructions

1. Build tx bytes: `unsafe_moveCall` with params shown in Proof 1
2. Dry-run: `sui_dryRunTransactionBlock` — observe it passes type check (fails at UnusedValueWithoutDrop)
3. Sign and submit: observe `CommandArgumentError::TypeMismatch`
4. Compare: same bytes, different outcomes

## Requested Actions

1. **Investigate the type-checking divergence** between fullnode dry-run and validator execution for object `0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92`
2. **Recover the locked funds** — the owner should be able to withdraw their assets
3. **Ensure dry-run and execution produce identical type-checking results** — this is a core platform invariant
4. **Audit other BalanceManagers** on mainnet for the same issue
