//! Account layouts. Sized for the full design so later phases never migrate.
//!
//! Large or hot accounts (Market, Strategy, Position, License, Scoreboard) are
//! zero-copy: read and written in place, never copied onto the 4 KB SBF
//! stack. Field order is chosen so `#[repr(C)]` has no implicit padding
//! (bytemuck `Pod` requires it); explicit `_pad` fields fill the gaps.

use anchor_lang::prelude::*;

use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundStatus {
    Created,
    Open,
    Live,
    Settling,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundMode {
    /// Equity leaderboard is public during the round; positions and code are dark.
    Lit,
    /// Even the leaderboard is private until the commit reveals it.
    Dark,
}

/// Global protocol config (L1 only).
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub protocol_fee_bps: u16,
    pub paused: bool,
    pub round_count: u32,
    pub bump: u8,
}

/// Static per-market config stored on the Round (public).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub struct MarketConfig {
    /// Oracle price account (Pyth Lazer PriceUpdateV2 pushed by MagicBlock).
    pub feed: Pubkey,
    /// Price decimals in the oracle account (8 for Pyth Lazer majors).
    pub decimals: u8,
    pub max_leverage: u8,
    pub maintenance_bps: u16,
    pub base_spread_bps: u16,
    /// Extra spread per 100% of skew, in bps.
    pub skew_spread_bps: u16,
    /// Open-interest cap per side, USDC notional (6dp).
    pub oi_cap: u64,
    pub enabled: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct CreateRoundArgs {
    pub mode: RoundMode,
    pub entry_fee: u64,
    pub min_margin: u64,
    pub max_margin: u64,
    pub tick_interval_ms: u32,
    pub duration_ticks: u64,
    pub step_limit: u32,
    pub checkpoint_every_ticks: u32,
    pub license_fee_min_bps: u16,
    pub license_fee_max_bps: u16,
}

/// A round of the league. Delegated to the TEE for its whole life; public.
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub id: u32,
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub status: RoundStatus,
    pub mode: RoundMode,
    pub n_markets: u8,
    pub markets: [MarketConfig; MAX_MARKETS],
    pub mystery_market: u8,
    pub entry_fee: u64,
    pub min_margin: u64,
    pub max_margin: u64,
    pub tick_interval_ms: u32,
    pub duration_ticks: u64,
    /// Tick counter advanced by `tick_clock`.
    pub tick: u64,
    pub step_limit: u32,
    pub entrant_count: u16,
    pub settled_count: u16,
    /// Activated licenses not yet settled; close_round and sweep_vault require 0.
    pub open_licenses: u16,
    pub batch_count: u8,
    pub prizes_paid: bool,
    /// Crank guard: scheduled instructions no-op when false.
    pub live: bool,
    pub vrf_seed: [u8; 32],
    pub vrf_ready: bool,
    /// Entry fees collected (USDC 6dp), paid out at settlement.
    pub pot: u64,
    /// Solvency beacon: what the vault holds vs what entrants are owed.
    pub vault_balance: u64,
    pub total_equity: i64,
    pub checkpoint_every_ticks: u32,
    pub created_at: i64,
    pub started_at: i64,
    pub ended_at: i64,
    pub protocol_fee_bps: u16,
    pub license_fee_min_bps: u16,
    pub license_fee_max_bps: u16,
    pub validator: Pubkey,
    pub bump: u8,
}

/// Live per-market state (delegated, public, zero-copy). Indicators are
/// maintained once per tick here so every strategy's reads are O(1).
#[account(zero_copy)]
pub struct Market {
    pub round: Pubkey,
    pub feed: Pubkey,
    pub oi_cap: u64,
    pub oi_long: u64,
    pub oi_short: u64,
    pub funding_index: i64,
    pub last_funding_tick: u64,
    /// Mark price, USDC 6dp.
    pub mark: i64,
    pub last_publish_time: i64,
    pub last_tick: u64,
    pub ring: [i64; RING_LEN],
    pub ema8: i64,
    pub ema21: i64,
    pub ema55: i64,
    /// Realized volatility over the ring, scaled fraction (1e6 = 100%).
    pub vol: i64,
    pub funding_rate_bps: i32,
    pub maintenance_bps: u16,
    pub base_spread_bps: u16,
    pub skew_spread_bps: u16,
    pub index: u8,
    pub decimals: u8,
    pub max_leverage: u8,
    pub ring_pos: u8,
    pub ring_len: u8,
    pub bump: u8,
    /// Running sum of squared per-tick returns over the ring (scaled 1e12),
    /// maintained incrementally so volatility costs O(1) per tick.
    pub ret_sq_sum: u64,
}

impl Market {
    pub const SIZE: usize = 8 + core::mem::size_of::<Market>();
}

/// Public per-entrant record (delegated).
#[account]
#[derive(InitSpace)]
pub struct Entrant {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub index: u16,
    pub batch: u8,
    pub slot: u8,
    pub joined_at: i64,
    pub alive: bool,
    pub deposited: u64,
    /// sha256 of the final bytecode, written only at settlement.
    pub strategy_hash: [u8; 32],
    pub strategy_version: u32,
    /// Blind-priced license fee (bps of notional per mirrored trade); public.
    pub fee_price_bps: u16,
    pub license_count: u16,
    pub privatized: bool,
    pub settled: bool,
    pub hall_recorded: bool,
    pub bump: u8,
}

/// The strategy. Delegated, PRIVATE to the owner, zero-copy. Bytecode never
/// touches L1 in plaintext: created zeroed, filled on the ER, scrubbed before
/// undelegation.
#[account(zero_copy)]
pub struct Strategy {
    pub round: Pubkey,
    pub owner: Pubkey,
    pub updated_tick: u64,
    pub version: u32,
    pub step_limit: u32,
    pub len: u16,
    pub bump: u8,
    pub _pad: [u8; 5],
    pub bytecode: [u8; MAX_BYTECODE],
}

impl Strategy {
    pub const SIZE: usize = 8 + core::mem::size_of::<Strategy>();
}

#[zero_copy]
#[derive(Default, PartialEq, Eq, Debug)]
pub struct Leg {
    /// Notional, USDC 6dp.
    pub size: u64,
    /// Entry mark, USDC 6dp.
    pub entry: i64,
    pub funding_index: i64,
    /// +1 long, -1 short, 0 flat.
    pub side: i8,
    pub _pad: [u8; 7],
}

/// Trading state. Delegated, PRIVATE to the owner, zero-copy.
#[account(zero_copy)]
pub struct Position {
    pub round: Pubkey,
    pub owner: Pubkey,
    /// Margin held in the entrant's custody token account, USDC 6dp.
    pub margin: u64,
    pub realized_pnl: i64,
    pub legs: [Leg; MAX_MARKETS],
    /// VM persistent memory.
    pub mem: [i64; MEM_SLOTS],
    /// Rolling Sharpe accumulators (per-tick equity returns, scaled).
    pub sum_ret: i64,
    pub sum_ret_sq: i64,
    pub last_equity: i64,
    pub peak_equity: i64,
    /// Round tick + 1 of the last executed tick (0 = never): one run per tick.
    pub ran_tick: u64,
    pub trade_count: u32,
    pub last_steps: u32,
    pub ret_n: u32,
    pub last_fault_pc: u16,
    pub last_fault: u8,
    pub liquidated: u8,
    pub bump: u8,
    pub _pad: [u8; 7],
}

impl Position {
    pub const SIZE: usize = 8 + core::mem::size_of::<Position>();
}

/// A licensee's mirror of an author's strategy. Delegated, PRIVATE to
/// buyer + author, zero-copy. The crank runs the author's bytecode against
/// these legs; neither the buyer nor anyone else can read the bytecode.
#[account(zero_copy)]
pub struct License {
    pub round: Pubkey,
    pub buyer: Pubkey,
    pub author: Pubkey,
    /// Margin held in the license's custody token account, USDC 6dp.
    pub margin: u64,
    /// Realized PnL net of license fees.
    pub realized_pnl: i64,
    pub legs: [Leg; MAX_MARKETS],
    /// The author's strategy memory, separate per licensee.
    pub mem: [i64; MEM_SLOTS],
    /// Fees owed to the author, paid at settlement.
    pub accrued_fees: u64,
    pub opened_tick: u64,
    pub last_equity: i64,
    pub peak_equity: i64,
    /// Round tick + 1 of the last executed tick (0 = never): one run per tick.
    pub ran_tick: u64,
    pub trade_count: u32,
    pub fee_bps: u16,
    pub active: u8,
    pub liquidated: u8,
    pub settled: u8,
    pub bump: u8,
    pub last_fault: u8,
    pub _pad: [u8; 5],
}

impl License {
    pub const SIZE: usize = 8 + core::mem::size_of::<License>();
}

#[zero_copy]
#[derive(Default, PartialEq, Eq, Debug)]
pub struct ScoreEntry {
    pub owner: Pubkey,
    pub equity: i64,
    pub deposited: u64,
    pub trades: u32,
    pub alive: u8,
    pub rank: u8,
    pub _pad: [u8; 2],
    pub strategy_hash: [u8; 32],
}

/// Leaderboard (zero-copy). Delegated; public in Lit mode, private
/// (program-only) in Dark mode.
#[account(zero_copy)]
pub struct Scoreboard {
    pub round: Pubkey,
    pub n: u16,
    pub finalized: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
    pub entries: [ScoreEntry; MAX_ENTRANTS],
}

impl Scoreboard {
    pub const SIZE: usize = 8 + core::mem::size_of::<Scoreboard>();
}

/// Hall of Fame (L1 only).
#[account]
#[derive(InitSpace)]
pub struct Hall {
    pub wallet: Pubkey,
    pub rounds: u32,
    pub wins: u32,
    pub podiums: u32,
    pub total_pnl: i64,
    pub elo: i32,
    pub best_rank: u8,
    pub bump: u8,
}
