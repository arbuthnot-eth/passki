# iUSD — Yield-Bearing Stable

Backed by gold, silver, equities, energy, and dollar instruments across Bitcoin, Ethereum, Solana, and Sui via IKA dWallet threshold signatures.

## Quick Start

### Mint iUSD

1. Go to [sui.ski](https://sui.ski)
2. Connect with WaaP (or any Sui wallet)
3. Wait for the idle overlay (or click **Lockin**)
4. Click the **iUSD globe** on the overlay
5. Sign the transaction — iUSD mints to your wallet

The button attests 95% of your SUI as collateral and mints iUSD at 150% collateral ratio automatically.

### Burn iUSD

Call `burn_and_redeem` on the iUSD contract. Burns your iUSD and creates a `RedeemRequest` that the TreasuryAgents fulfill.

## Network Status

| Network | Status | Package |
|---------|--------|---------|
| **Sui Mainnet** | ✅ Live | `0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515` |
| Sui Testnet | Not deployed | — |
| Sui Devnet | Not deployed | — |

iUSD is mainnet-first. No testnet deployment — we ship to production.

## Contract Addresses

| Contract | Package ID |
|----------|-----------|
| iUSD | `0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515` |
| Thunder v3 | `0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782` |
| t2000 Ship | `0x3e708a6e1dfd6f96b54e0145613d505e508577df4a80aa5523caf380abba5e33` |

| Object | ID |
|--------|---|
| Treasury | `0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895` |
| TreasuryCap | `0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05` |
| Storm | `0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6` |
| Armory | `0xc78197ce97f89833e5da857cc4da41e7d71163c259128350c8c145a1ecfc67e5` |

## Authority Setup

iUSD uses role-based access control. After deploy, authority must be transferred from the deployer CLI wallet to the operating wallet.

### Transfer Authority (one-time, from CLI)

```bash
# Set minter to brando.sui (WaaP wallet)
sui client call \
  --package 0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515 \
  --module iusd \
  --function set_minter \
  --args \
    0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895 \
    <WALLET_ADDRESS> \
  --gas-budget 10000000

# Set oracle to same address
sui client call \
  --package 0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515 \
  --module iusd \
  --function set_oracle \
  --args \
    0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895 \
    <WALLET_ADDRESS> \
  --gas-budget 10000000

# Transfer TreasuryCap to operating wallet
sui client transfer \
  --to <WALLET_ADDRESS> \
  --object-id 0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05 \
  --gas-budget 10000000
```

After these three commands, the operating wallet (e.g. WaaP) has full control:
- **Minter**: can call `mint` and `mint_and_transfer`
- **Oracle**: can call `update_collateral` to attest reserve values
- **TreasuryCap owner**: required for all mint/burn operations

### Resolve a SuiNS name to address

```bash
curl -s https://sui-rpc.publicnode.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"suix_resolveNameServiceAddress","params":["brando.sui"]}'
```

### Verify authority

```bash
curl -s https://sui-rpc.publicnode.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getObject","params":["0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895",{"showContent":true}]}'
```

Check `minter` and `oracle` fields in the response match your operating wallet.

## How It Works

### Collateral Attestation

The oracle calls `update_collateral` to attest the value of each reserve asset:

```
update_collateral(treasury, asset, chain, dwallet_cap_id, value_mist, tranche, clock)
```

- `asset`: human-readable name (e.g. "SUI", "XAUM", "TSLAx")
- `chain`: where the asset lives (e.g. "sui", "ethereum", "solana")
- `dwallet_cap_id`: IKA DWalletCap ID for cross-chain assets, `@0x0` for Sui-native
- `value_mist`: current value in MIST
- `tranche`: `0` = senior (peg floor), `1` = junior (growth)

### Minting

```
mint_and_transfer(treasury_cap, treasury, amount, recipient)
```

Enforces:
1. Total collateral ≥ 150% of total supply
2. Senior tranche alone ≥ 100% of total supply

### Tranching & Loss Waterfall

```
Market drawdown →
  1. Junior absorbs first (gold, silver, equities, BTC, oil)
  2. Senior absorbs second (USDC, T-bills, staked SUI/SOL)
  3. iUSD holder absorbs last

iUSD peg holds as long as senior ≥ 100% of supply.
```

### Zero-Trust Collateral (IKA)

Cross-chain assets are controlled by IKA dWallets. The `DWalletCap` is deposited into the Treasury contract via `deposit_dwallet_cap`. Nobody can move the cross-chain collateral without the 2PC-MPC ceremony — not the founder, not any single node, not any attacker.

## Revenue Streams

| Source | Rate | Destination |
|--------|------|-------------|
| Thunder signals | $0.009 per signal | Treasury (direct) |
| SuiNS registrations | 5% of full price | Treasury (via gas split) |
| Shade orders | 10% of escrow | Treasury (on execute) |
| Swap routing | 0.1% spread | Treasury (planned) |

## Token Info

| Property | Value |
|----------|-------|
| Name | iUSD |
| Symbol | iUSD |
| Decimals | 6 |
| Icon | [sui.ski/assets/iusd.svg](https://sui.ski/assets/iusd.svg) |
| Network | Sui Mainnet |

## Progressive Decentralization

1. **Now**: Minter/oracle = WaaP wallet (human in the loop)
2. **Next**: Transfer to IKA dWallet address (threshold consensus required)
3. **Future**: Governance token holders vote on parameters via Thunder Storm signals
