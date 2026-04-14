/// Volcarodon — Peg Stability Module for iUSD ↔ USDC at 1:1.
///
/// The module wraps a `TreasuryCap<T>` inside a shared `Reserve<T, S>`
/// object so any user can atomically burn T for S (or mint T from S)
/// in a single user-signed transaction. No DeepBook, no orderbook,
/// no liquidity provider — the reserve itself IS the liquidity.
///
/// Fusion lore: Volcarona (Fire/Bug, burns iUSD) × Groudon (Ground,
/// grounds the molten exit in a stable USDC reserve). Single-form
/// Volcarodon. No further evolutions.
///
/// Deployment flow:
///   1. Publish this package
///   2. Call `init` with the T TreasuryCap owned by admin — creates
///      the shared Reserve<T, S> holding cap + empty S balance
///   3. Call `top_up` with USDC to seed the reserve
///   4. Users can then call `burn_for_usdc` / `mint_from_usdc`
module volcarodon::psm {
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::balance::{Self, Balance};

    // ─── Errors ────────────────────────────────────────────────────
    const EZeroAmount: u64 = 0;
    const EInsufficientReserve: u64 = 1;
    const ESlippage: u64 = 2;
    const ENotAdmin: u64 = 3;
    const EFeeTooHigh: u64 = 4;

    // ─── Events ────────────────────────────────────────────────────
    public struct Burned<phantom T, phantom S> has copy, drop {
        burner: address,
        t_amount: u64,
        s_out: u64,
    }

    public struct Minted<phantom T, phantom S> has copy, drop {
        minter: address,
        s_in: u64,
        t_out: u64,
    }

    public struct ReserveInit<phantom T, phantom S> has copy, drop {
        reserve_id: address,
        admin: address,
        fee_bps: u64,
    }

    // ─── State ─────────────────────────────────────────────────────
    /// Shared reserve holding the wrapped TreasuryCap<T> + Balance<S>.
    ///
    /// T is the mint-controlled token (iUSD — we own the cap via upgrade
    /// owner `plankton.sui`). S is the reserve asset (USDC — held as
    /// balance; nobody mints it, users top up).
    ///
    /// The module is PARAMETRIC on T and S so we can deploy additional
    /// reserves for other pegged pairs later (e.g. iUSD ↔ USDT, iUSD ↔
    /// BASE USDC) without another package upgrade.
    public struct Reserve<phantom T, phantom S> has key {
        id: UID,
        treasury_cap: TreasuryCap<T>,
        s_balance: Balance<S>,
        /// Fee in basis points (50 = 0.50%). Applied on both directions.
        fee_bps: u64,
        /// Collected fees in S, withdrawable by admin.
        collected_fee: Balance<S>,
        /// Admin address — can set_fee + withdraw_fee.
        admin: address,
        /// Unit scaling: T has `t_decimals`, S has `s_decimals`.
        /// iUSD = 9, USDC = 6, so factor = 10^(9-6) = 1000.
        /// For peg math: `s_out_raw = t_in_raw / 10^(t_dec - s_dec)`.
        t_decimals: u8,
        s_decimals: u8,
        /// Accounting counters.
        total_t_burned: u64,
        total_t_minted: u64,
        total_s_in: u64,
        total_s_out: u64,
    }

    // ─── Reserve creation ─────────────────────────────────────────
    /// Initialize a new reserve by wrapping the caller's TreasuryCap<T>.
    /// After this, the cap is permanently owned by the shared reserve
    /// object and cannot be retrieved. Users call `burn_for_usdc` /
    /// `mint_from_usdc` permissionlessly.
    ///
    /// Not named `init` — Sui reserves that for module-level publish
    /// initializers with a strict signature. `create_reserve` serves
    /// the same purpose but runs after publish when the admin calls
    /// it with the TreasuryCap they own.
    public entry fun create_reserve<T, S>(
        treasury_cap: TreasuryCap<T>,
        fee_bps: u64,
        t_decimals: u8,
        s_decimals: u8,
        ctx: &mut TxContext,
    ) {
        assert!(fee_bps <= 1000, EFeeTooHigh); // cap at 10%
        let reserve = Reserve<T, S> {
            id: object::new(ctx),
            treasury_cap,
            s_balance: balance::zero<S>(),
            fee_bps,
            collected_fee: balance::zero<S>(),
            admin: tx_context::sender(ctx),
            t_decimals,
            s_decimals,
            total_t_burned: 0,
            total_t_minted: 0,
            total_s_in: 0,
            total_s_out: 0,
        };
        let reserve_id = object::id_to_address(&object::id(&reserve));
        sui::event::emit(ReserveInit<T, S> {
            reserve_id,
            admin: tx_context::sender(ctx),
            fee_bps,
        });
        transfer::share_object(reserve);
    }

    // ─── Peg math helper ───────────────────────────────────────────
    /// Convert a T amount (in its own mist units) to the equivalent
    /// S amount (in S mist units) at 1:1 peg, then subtract fee.
    /// Handles both decimal directions (T > S or T < S).
    fun convert_t_to_s<T, S>(reserve: &Reserve<T, S>, t_amount: u64): u64 {
        let t_dec = reserve.t_decimals;
        let s_dec = reserve.s_decimals;
        let base = if (t_dec >= s_dec) {
            let factor = pow10(t_dec - s_dec);
            t_amount / factor
        } else {
            let factor = pow10(s_dec - t_dec);
            t_amount * factor
        };
        base * (10000 - reserve.fee_bps) / 10000
    }

    /// Inverse of `convert_t_to_s` — S in, T out, minus fee.
    fun convert_s_to_t<T, S>(reserve: &Reserve<T, S>, s_amount: u64): u64 {
        let t_dec = reserve.t_decimals;
        let s_dec = reserve.s_decimals;
        let base = if (t_dec >= s_dec) {
            let factor = pow10(t_dec - s_dec);
            s_amount * factor
        } else {
            let factor = pow10(s_dec - t_dec);
            s_amount / factor
        };
        base * (10000 - reserve.fee_bps) / 10000
    }

    fun pow10(exp: u8): u64 {
        let mut i = 0;
        let mut r = 1u64;
        while (i < exp) {
            r = r * 10;
            i = i + 1;
        };
        r
    }

    // ─── Burn T for S ──────────────────────────────────────────────
    /// Permissionless. Caller burns Coin<T>, receives Coin<S> from the
    /// reserve at 1:1 minus fee. Aborts if reserve is short.
    /// PTB-composable variant: burns T for S at 1:1 minus fee and
    /// RETURNS the Coin<S> instead of transferring it. Lets callers
    /// chain the output into a later PTB command (e.g. DeepBook
    /// swap USDC→SUI → Tradeport purchase) in a single signature.
    public fun burn_for_usdc_coin<T, S>(
        reserve: &mut Reserve<T, S>,
        t_in: Coin<T>,
        min_s_out: u64,
        ctx: &mut TxContext,
    ): Coin<S> {
        let t_amount = coin::value(&t_in);
        assert!(t_amount > 0, EZeroAmount);

        let s_out_amount = convert_t_to_s(reserve, t_amount);
        assert!(s_out_amount >= min_s_out, ESlippage);
        assert!(balance::value(&reserve.s_balance) >= s_out_amount, EInsufficientReserve);

        // Burn T first so the tx atomically reduces supply.
        coin::burn(&mut reserve.treasury_cap, t_in);
        reserve.total_t_burned = reserve.total_t_burned + t_amount;
        reserve.total_s_out = reserve.total_s_out + s_out_amount;

        // Split fee from the outflow and retain it in `collected_fee`.
        let gross = if (reserve.t_decimals >= reserve.s_decimals) {
            t_amount / pow10(reserve.t_decimals - reserve.s_decimals)
        } else {
            t_amount * pow10(reserve.s_decimals - reserve.t_decimals)
        };
        let fee_amount = gross - s_out_amount;

        let fee_balance = balance::split(&mut reserve.s_balance, fee_amount);
        balance::join(&mut reserve.collected_fee, fee_balance);

        let s_coin = coin::take(&mut reserve.s_balance, s_out_amount, ctx);
        sui::event::emit(Burned<T, S> {
            burner: tx_context::sender(ctx),
            t_amount,
            s_out: s_out_amount,
        });
        s_coin
    }

    /// Entry wrapper — preserves the original transfer-to-sender
    /// behaviour for standalone PSM burns. Delegates to the
    /// composable `burn_for_usdc_coin` variant.
    public entry fun burn_for_usdc<T, S>(
        reserve: &mut Reserve<T, S>,
        t_in: Coin<T>,
        min_s_out: u64,
        ctx: &mut TxContext,
    ) {
        let s_coin = burn_for_usdc_coin<T, S>(reserve, t_in, min_s_out, ctx);
        transfer::public_transfer(s_coin, tx_context::sender(ctx));
    }

    // ─── Mint T from S ─────────────────────────────────────────────
    /// Permissionless reverse. Caller deposits Coin<S>, receives
    /// freshly-minted Coin<T> at 1:1 minus fee. Grows the reserve.
    public entry fun mint_from_usdc<T, S>(
        reserve: &mut Reserve<T, S>,
        s_in: Coin<S>,
        min_t_out: u64,
        ctx: &mut TxContext,
    ) {
        let s_amount = coin::value(&s_in);
        assert!(s_amount > 0, EZeroAmount);

        let t_out_amount = convert_s_to_t(reserve, s_amount);
        assert!(t_out_amount >= min_t_out, ESlippage);

        // Compute fee from the S side.
        let gross_t = if (reserve.t_decimals >= reserve.s_decimals) {
            s_amount * pow10(reserve.t_decimals - reserve.s_decimals)
        } else {
            s_amount / pow10(reserve.s_decimals - reserve.t_decimals)
        };
        let _fee_amount_t = gross_t - t_out_amount;
        // Fee on mint is retained in the reserve (S side) as profit —
        // we take all S but mint fewer T, so the reserve grows.

        balance::join(&mut reserve.s_balance, coin::into_balance(s_in));
        reserve.total_t_minted = reserve.total_t_minted + t_out_amount;
        reserve.total_s_in = reserve.total_s_in + s_amount;

        let t_coin = coin::mint(&mut reserve.treasury_cap, t_out_amount, ctx);
        sui::event::emit(Minted<T, S> {
            minter: tx_context::sender(ctx),
            s_in: s_amount,
            t_out: t_out_amount,
        });
        transfer::public_transfer(t_coin, tx_context::sender(ctx));
    }

    // ─── Top-up (permissionless) ───────────────────────────────────
    /// Anyone can add S to the reserve — useful for treasury seeding,
    /// yield harvest, ultron refills, etc. No fee, no T minted.
    public entry fun top_up<T, S>(
        reserve: &mut Reserve<T, S>,
        s_in: Coin<S>,
    ) {
        balance::join(&mut reserve.s_balance, coin::into_balance(s_in));
    }

    // ─── Admin ─────────────────────────────────────────────────────
    /// Admin withdraws collected fees.
    public entry fun withdraw_fees<T, S>(
        reserve: &mut Reserve<T, S>,
        recipient: address,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == reserve.admin, ENotAdmin);
        let amt = balance::value(&reserve.collected_fee);
        if (amt > 0) {
            let fee_balance = balance::split(&mut reserve.collected_fee, amt);
            let fee_coin = coin::from_balance(fee_balance, ctx);
            transfer::public_transfer(fee_coin, recipient);
        }
    }

    /// Admin updates fee bps (capped at 10%).
    public entry fun set_fee<T, S>(
        reserve: &mut Reserve<T, S>,
        fee_bps: u64,
        ctx: &TxContext,
    ) {
        assert!(tx_context::sender(ctx) == reserve.admin, ENotAdmin);
        assert!(fee_bps <= 1000, EFeeTooHigh);
        reserve.fee_bps = fee_bps;
    }

    /// Admin transfers adminship to a new address (multisig migration).
    public entry fun transfer_admin<T, S>(
        reserve: &mut Reserve<T, S>,
        new_admin: address,
        ctx: &TxContext,
    ) {
        assert!(tx_context::sender(ctx) == reserve.admin, ENotAdmin);
        reserve.admin = new_admin;
    }

    // ─── Views ─────────────────────────────────────────────────────
    public fun s_reserve_balance<T, S>(reserve: &Reserve<T, S>): u64 {
        balance::value(&reserve.s_balance)
    }

    public fun collected_fees<T, S>(reserve: &Reserve<T, S>): u64 {
        balance::value(&reserve.collected_fee)
    }

    public fun fee_bps<T, S>(reserve: &Reserve<T, S>): u64 {
        reserve.fee_bps
    }

    public fun admin<T, S>(reserve: &Reserve<T, S>): address {
        reserve.admin
    }
}
