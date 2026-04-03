# HackenProof Submission: Permanent Fund Lock in Owned DeepBook v3 BalanceManager

## Title
Funds permanently locked in owned BalanceManager — no on-chain recovery path exists

## Severity
High — Permanent loss of funds. An owned BalanceManager with deposited tokens cannot be withdrawn from, shared, or destroyed. No rescue mechanism exists in the contract or the Sui framework.

## Description
DeepBook v3's `balance_manager::new()` function returns a `BalanceManager` object to the caller. If the caller stores it as an **owned object** (via `transfer::transfer` or `TransferObjects`) instead of sharing it (via `transfer::public_share_object`), the funds become permanently inaccessible:

1. **Cannot withdraw**: All DeepBook functions (`withdraw_all`, `generate_proof_as_owner`, `deposit`) reject the owned object with `CommandArgumentError::TypeMismatch` when submitted to validators
2. **Cannot share**: Sui protocol forbids sharing an already-existing owned object — `transfer::public_share_object` only works in the same transaction that creates the object
3. **Cannot destroy**: The `delete` function requires the Bag to be empty, but funds can't be withdrawn first
4. **Cannot transfer contents**: No function exists to extract Bag contents without `&mut BalanceManager`

The object is in a **zombie state** — it can be transferred between addresses (via `TransferObjects` PTB command) but never interacted with via Move functions.

## Steps to Reproduce

### Step 1: Create an owned BalanceManager with funds
```typescript
const tx = new Transaction();
tx.setSender(address);
const [bm] = tx.moveCall({
  package: '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497',
  module: 'balance_manager',
  function: 'new',
  arguments: [],
});
// Deposit tokens
tx.moveCall({
  package: '0x337f...',
  module: 'balance_manager',
  function: 'deposit',
  typeArguments: ['0x2::sui::SUI'],
  arguments: [bm, suiCoin],
});
// Store as OWNED (not shared) — this is the trigger
tx.transferObjects([bm], tx.pure.address(address));
```

### Step 2: Try to withdraw
```typescript
const tx2 = new Transaction();
const [coin] = tx2.moveCall({
  target: '0x337f...::balance_manager::withdraw_all',
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx2.object(balanceManagerId)],
});
tx2.transferObjects([coin], tx2.pure.address(address));
// FAILS: CommandArgumentError { arg_idx: 0, kind: TypeMismatch }
```

### Step 3: Try to share it
```typescript
const tx3 = new Transaction();
tx3.moveCall({
  target: '0x2::transfer::public_share_object',
  typeArguments: ['0x2c8d...::balance_manager::BalanceManager'],
  arguments: [tx3.object(balanceManagerId)],
});
// FAILS: MoveAbort in transfer::share_object_impl — cannot share existing owned object
```

### Step 4: Confirm funds are trapped
The object can only be transferred between addresses. No Move function can access its contents.

## Affected Objects on Mainnet
- **Object 1**: `0x2261d2bad4c716d2f542c9ef3db3a7f2cab9188439dc4d81d5aae402481c4f92`
  - Owner: `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3`
  - Locked funds: ~34.74 iUSD + ~28.99 USDC (~$63 USD)
- **Object 2**: `0x0049058a2d0753b0a6d9e1a6dafa9da5a80c69435c5ed382a59def5f04bc1bc8`
  - Owner: `0xeea42ea5a9b7b1a98d8e8bbd8d7cae7fd7a382403e513a48a8def887ee1df7ef`
  - 3 coin types deposited (amounts unknown)

Out of 50 sampled BalanceManagers on mainnet, 49 are shared and 1 is owned. Both owned BMs are potentially affected.

## Root Cause
The `balance_manager::new()` function returns a `BalanceManager` by value without enforcing that it must be shared. The DeepBook SDK (`@mysten/deepbook-v3`) always calls `transfer::public_share_object` after `new()`, but nothing in the Move contract prevents a caller from storing it as owned instead.

Once owned:
- Validators reject it as a `MoveCall` argument because DeepBook functions expect shared input references
- The Sui protocol doesn't allow converting owned → shared after creation
- No escape hatch exists in the contract

## Impact
- **$63+ permanently locked** across at least 2 owned BalanceManagers on mainnet
- Any developer who calls `balance_manager::new()` without using the SDK's share pattern will create a fund trap
- The `new()` function gives no warning that the returned object MUST be shared
- This is a design defect in the DeepBook v3 contract — the function should either auto-share or enforce sharing via the type system

## Recommended Fix

### Short-term: Add a rescue function to DeepBook v3
```move
/// Emergency withdrawal from an owned BalanceManager.
/// Only callable by the owner. Withdraws all balances and destroys the BM.
entry fun rescue_owned(bm: BalanceManager, ctx: &mut TxContext) {
    assert!(bm.owner == ctx.sender(), ENotOwner);
    // Withdraw all balances, transfer to owner, delete BM
}
```

### Long-term: Enforce sharing at creation
```move
/// New signature — auto-shares the BalanceManager
public fun new(ctx: &mut TxContext): BalanceManager {
    let bm = BalanceManager { ... };
    transfer::public_share_object(bm); // Cannot be stored as owned
}
```

### Protocol-level: Allow owned → shared conversion
Consider adding `transfer::public_share_existing_object<T>` that allows sharing an owned object after creation, gated by the owner's signature.

## Network
Sui Mainnet
