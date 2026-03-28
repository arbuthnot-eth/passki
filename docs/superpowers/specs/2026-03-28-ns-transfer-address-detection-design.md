# NS Transfer Button + Address Detection

## Summary

Two features for the SKI menu NS input:

1. **Address detection in NS input** — detect valid SuiNS names and full Sui hex addresses typed into the name input, switching to SEND mode when a valid recipient is identified
2. **Green transfer button** — for owned names, a green button on the target row that opens an inline recipient input; on submit, transfers the SuinsRegistration NFT to the recipient and creates a no-deposit Shade order for grace-period registration

## Feature 1: NS Input Address Detection

### Behavior

The `wk-ns-label-input` `input` event handler gains address detection logic:

- **SuiNS name**: If input matches `isValidNsLabel()` (3+ chars, `[a-z0-9-]`) — existing behavior, resolve via `fetchAndShowNsPrice`. Already works.
- **Full Sui hex address**: Only when input length === 66 and matches `/^0x[0-9a-fA-F]{64}$/` — set as `nsTargetAddress`, switch to SEND mode. Do NOT check partial hex (avoids false positives while user is still typing).
- **Under 66 chars, not a valid name**: Existing black-diamond behavior, no change.

### Implementation

In `src/ui.ts`, the `nsInput` `input` handler (~line 6137):

1. After the existing hex-paste guard (`/^0x[0-9a-f]{20,64}$/i`), add a check for exactly 66-char full address
2. When detected: set `nsTargetAddress = val`, clear `nsAvail`, hide `.sui` suffix and price chip, show SEND button
3. Attempt reverse-resolve via `lookupSuiNS()` — if found, replace hex with the name (same as paste handler)

This reuses the existing paste-handler pattern (~line 6063) but triggers on typed input at the 66-char threshold.

### Future extensibility

Other chain address formats (Solana base58, Bitcoin bech32, Ethereum 0x) can be added later behind length/prefix checks. Not in scope now.

## Feature 2: Green Transfer Button

### UI

- A green `>` button appears at the **right end** of the target row (`_nsTargetRowHtml()`) when the name is owned (`nsAvail === 'owned'` or `isOwnedName`)
- Button ID: `wk-ns-transfer-btn`
- Green background matching `wk-ns-target-row--green` palette

### Click flow

1. **Click green button** → target row transforms into an inline input (`wk-ns-transfer-input`) + submit button
2. Input accepts:
   - A SuiNS name (bare like `bob` or with `.sui` like `bob.sui`) — resolved via `resolveSuiNSName()`
   - A full Sui hex address (`0x` + 64 hex chars)
   - Empty / Escape → cancels, reverts to normal target row
3. **Submit** → two-step PTB:
   - Step 1: `transferObjects([nft], recipient)` — sends the SuinsRegistration NFT
   - Step 2: Create a Shade order (no deposit) for grace-period auto-registration
4. On success: toast confirmation, refresh owned domains, clear NS input state

### Transfer PTB builder

New function in `src/suins.ts`:

```ts
export async function buildTransferNftTx(
  sender: string,
  domain: string,
  recipientAddress: string,
): Promise<Uint8Array>
```

- Looks up the SuinsRegistration NFT object ID from `fetchOwnedDomains()`
- Builds a `Transaction` with `tx.transferObjects([nftRef], tx.pure.address(recipient))`
- Returns built bytes

### Shade order (phase 2, no deposit)

New function in `src/suins.ts`:

```ts
export async function buildGraceSaleShadeOrderTx(
  sender: string,
  domain: string,
): Promise<Uint8Array>
```

- Creates a Shade commitment-reveal order with no deposit
- Allows anyone to execute registration during the 30-day grace period by paying registration cost + gas
- Premium mechanism TBD — will be layered on iteratively

### State changes

- New module state: `nsTransferInputOpen: boolean`, `nsTransferRecipient: string`
- Reuses existing patterns from `nsShowTargetInput` / `nsNewTargetAddr`

## Files to modify

| File | Change |
|------|--------|
| `src/ui.ts` | Address detection in input handler; green transfer button in `_nsTargetRowHtml()`; transfer input UI + event wiring |
| `src/suins.ts` | `buildTransferNftTx()` builder; `buildGraceSaleShadeOrderTx()` stub |

## Out of scope

- Other chain address validation (Solana, BTC, ETH)
- Shade premium/profit mechanism (iterative follow-up)
- Marketplace listing integration
