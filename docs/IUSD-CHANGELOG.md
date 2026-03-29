# iUSD Changelog

## v1.0.0 — ⚡ Zapdos (Phase 1)
- iUSD Move module deployed to Sui mainnet: `0xf62e...5515`
- Treasury shared object: `0x7a96...6895`
- TreasuryCap: `0x868d...bc05`
- 6 decimals (matches USDC)
- mint() gated by authorized minter
- burn() permissionless
- deposit_revenue() permissionless

## v1.1.0 — ⚡ Raikou (Phase 1)
- Real IKA zero-trust collateral integration
- DWalletCap deposit: treasury holds IKA capability objects
- Senior/junior tranching with loss waterfall (cascade)
- 150% minimum collateral ratio enforced in mint()
- Senior tranche must cover 100% of supply (peg floor)
- Oracle-attested cross-chain collateral values
- burn_and_redeem() creates RedeemRequest objects

## v1.2.0 — ⚡ Thundurus (Phase 1)
- USD1 (World Liberty Financial) added as primary stable at 20% senior
- Full 20-asset roster across 6 chains
- BUIDL, VBILL, XAUM, PAXG, XAGM, TSLAx, NVDAx, SPYx, BTC, WTI, LITRO, WLFI RWA

## v1.3.0 — ⚡ Voltorb (Phase 1)
- Base chain added (Aerodrome LP + Moonwell lending)
- Same IKA secp256k1 dWallet controls Ethereum + Base + Arbitrum + Hyperliquid

## Revenue Primitives (Phase 1)
- ⚡ Jolteon: Thunder v3 signal fee ($0.009 per signal → treasury)
- ⚡ Luxray: Shade 10% escrow cut → treasury
- ⚡ Pikachu: Client-side Thunder fee wiring
- ⚡ Dragonite: 5% SuiNS registration cut → treasury

## TreasuryAgents (Phase 2)
- ⚡ Ampharos: TreasuryAgents DO (arb, sweep, rebalance, DKG)
- ⚡ Vikavolt: t2000 agent mission execution per deployed terminator

## Reserve Composition (current)

### Senior Tranche — 60%
| Asset | Chain | Weight |
|-------|-------|--------|
| USD1 | Solana + Ethereum | 20% |
| USDC | Sui + Solana | 10% |
| BUIDL | Ethereum | 10% |
| VBILL | Solana | 5% |
| Staked SUI | Sui | 8% |
| Staked SOL | Solana | 7% |

### Junior Tranche — 40%
| Asset | Chain | Weight |
|-------|-------|--------|
| XAUM gold | Sui | 6% |
| PAXG gold | Ethereum | 3% |
| XAGM silver | Ethereum | 3% |
| TSLAx | Solana | 5% |
| NVDAx | Solana | 5% |
| SPYx | Solana | 3% |
| BTC | Bitcoin | 5% |
| WTI crude perp | Hyperliquid | 2% |
| LITRO crude | Arbitrum | 2% |
| WLFI RWA Oil | ETH/SOL | 2% |
| WLFI RWA Gas | ETH/SOL | 2% |
| WLFI RWA Timber | ETH/SOL | 2% |
| AERO/USDC LP | Base | 2% |
| Moonwell USDC | Base | 1% |

## Mainnet Contracts
| Contract | Package ID |
|----------|-----------|
| iUSD | `0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515` |
| Thunder v3 | `0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782` |
| t2000 Ship | `0x3e708a6e1dfd6f96b54e0145613d505e508577df4a80aa5523caf380abba5e33` |

## Key Objects
| Object | ID |
|--------|---|
| iUSD Treasury | `0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895` |
| TreasuryCap | `0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05` |
| Storm (Thunder v3) | `0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6` |
| Armory (t2000 Ship) | `0xc78197ce97f89833e5da857cc4da41e7d71163c259128350c8c145a1ecfc67e5` |
