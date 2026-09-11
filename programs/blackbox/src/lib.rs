//! BLACKBOX — alpha you can't read.
//!
//! A trading league where every strategy is a small program executed by this
//! program inside a MagicBlock Private Ephemeral Rollup. Strategies and
//! positions live in private accounts (readable only by their owner through
//! the TEE), ticks run on the Native Crank against live Pyth Lazer prices,
//! and winners can be licensed blind.
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod errors;
pub mod espl;
pub mod instructions;
pub mod oracle;
pub mod perps;
pub mod privacy;
pub mod state;
pub mod vm_host;

use instructions::*;
use state::*;

declare_id!("BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27");

#[ephemeral]
#[program]
pub mod blackbox {
    use super::*;

    // ---- L1: protocol + round setup
    pub fn init_protocol(ctx: Context<InitProtocol>, protocol_fee_bps: u16) -> Result<()> {
        instructions::admin::init_protocol(ctx, protocol_fee_bps)
    }
    pub fn create_round(ctx: Context<CreateRound>, args: CreateRoundArgs) -> Result<()> {
        instructions::admin::create_round(ctx, args)
    }
    pub fn add_market(ctx: Context<AddMarket>, index: u8, cfg: MarketConfig) -> Result<()> {
        instructions::admin::add_market(ctx, index, cfg)
    }
    pub fn open_round(ctx: Context<OpenRound>) -> Result<()> {
        instructions::admin::open_round(ctx)
    }
    pub fn delegate_market(ctx: Context<DelegateMarket>, round_id: u32, index: u8) -> Result<()> {
        instructions::admin::delegate_market(ctx, round_id, index)
    }
    pub fn delegate_round(ctx: Context<DelegateRoundAccounts>, round_id: u32) -> Result<()> {
        instructions::round::delegate_round(ctx, round_id)
    }

    // ---- L1: joining
    pub fn join_round(ctx: Context<JoinRound>) -> Result<()> {
        instructions::entrant::join_round(ctx)
    }
    pub fn delegate_entrant(ctx: Context<DelegateEntrant>) -> Result<()> {
        instructions::entrant::delegate_entrant(ctx)
    }

    // ---- ER: privacy + strategy
    pub fn privatize_entrant(ctx: Context<PrivatizeEntrant>) -> Result<()> {
        instructions::entrant::privatize_entrant(ctx)
    }
    pub fn set_strategy(ctx: Context<SetStrategy>, bytecode: Vec<u8>) -> Result<()> {
        instructions::entrant::set_strategy(ctx, bytecode)
    }
    pub fn set_scoreboard_privacy(ctx: Context<ScoreboardPrivacy>, private: bool) -> Result<()> {
        instructions::round::set_scoreboard_privacy(ctx, private)
    }
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        instructions::round::start_round(ctx)
    }

    // ---- ER: money
    pub fn fund_entrant(ctx: Context<FundEntrant>, margin: u64) -> Result<()> {
        instructions::fund::fund_entrant(ctx, margin)
    }

    // ---- ER: crank loop
    pub fn schedule_clock(ctx: Context<ScheduleClock>, task_id: i64) -> Result<()> {
        instructions::tick::schedule_clock(ctx, task_id)
    }
    pub fn schedule_entrant_tick<'info>(ctx: Context<'info, ScheduleEntrantTick<'info>>, task_id: i64) -> Result<()> {
        instructions::tick::schedule_entrant_tick(ctx, task_id)
    }
    pub fn tick_clock(ctx: Context<TickClock>) -> Result<()> {
        instructions::tick::tick_clock(ctx)
    }
    pub fn tick_entrant<'info>(ctx: Context<'info, TickEntrant<'info>>) -> Result<()> {
        instructions::tick::tick_entrant(ctx)
    }

    // ---- blind licensing
    pub fn open_license(ctx: Context<OpenLicense>) -> Result<()> {
        instructions::license::open_license(ctx)
    }
    pub fn delegate_license(ctx: Context<DelegateLicense>) -> Result<()> {
        instructions::license::delegate_license(ctx)
    }
    pub fn activate_license(ctx: Context<ActivateLicense>, margin: u64) -> Result<()> {
        instructions::license::activate_license(ctx, margin)
    }
    pub fn schedule_license_tick<'info>(ctx: Context<'info, ScheduleLicenseTick<'info>>, task_id: i64) -> Result<()> {
        instructions::license::schedule_license_tick(ctx, task_id)
    }
    pub fn tick_license<'info>(ctx: Context<'info, TickLicense<'info>>) -> Result<()> {
        instructions::license::tick_license(ctx)
    }
    pub fn settle_license<'info>(ctx: Context<'info, SettleLicense<'info>>) -> Result<()> {
        instructions::license::settle_license(ctx)
    }
    pub fn undelegate_license(ctx: Context<UndelegateLicense>) -> Result<()> {
        instructions::license::undelegate_license(ctx)
    }

    // ---- ER: round chat (an ephemeral account sponsored by the round)
    pub fn post_chat(ctx: Context<PostChat>, text: String) -> Result<()> {
        instructions::chat::post_chat(ctx, text)
    }
    pub fn close_chat(ctx: Context<CloseChat>) -> Result<()> {
        instructions::chat::close_chat(ctx)
    }

    // ---- ER: house bankroll
    pub fn seed_vault(ctx: Context<VaultAdmin>, amount: u64) -> Result<()> {
        instructions::vault::seed_vault(ctx, amount)
    }
    pub fn sweep_vault(ctx: Context<VaultAdmin>) -> Result<()> {
        instructions::vault::sweep_vault(ctx)
    }

    // ---- ER: randomness
    pub fn request_round_seed(ctx: Context<RequestRoundSeed>, client_seed: u8) -> Result<()> {
        instructions::vrf::request_round_seed(ctx, client_seed)
    }
    pub fn round_seed_callback(ctx: Context<RoundSeedCallback>, randomness: [u8; 32], client_seed: u8) -> Result<()> {
        instructions::vrf::round_seed_callback(ctx, randomness, client_seed)
    }

    // ---- ER: settlement
    pub fn settle_entrant<'info>(ctx: Context<'info, SettleEntrant<'info>>) -> Result<()> {
        instructions::settle::settle_entrant(ctx)
    }
    pub fn undelegate_entrant(ctx: Context<UndelegateEntrant>) -> Result<()> {
        instructions::settle::undelegate_entrant(ctx)
    }
    pub fn rank_round(ctx: Context<RankRound>) -> Result<()> {
        instructions::settle::rank_round(ctx)
    }
    pub fn pay_prizes<'info>(ctx: Context<'info, PayPrizes<'info>>) -> Result<()> {
        instructions::settle::pay_prizes(ctx)
    }
    pub fn close_round<'info>(ctx: Context<'info, CloseRound<'info>>) -> Result<()> {
        instructions::settle::close_round(ctx)
    }

    // ---- local development: mock price feeds (accepted only with `local-oracle`)
    pub fn init_mock_feed(ctx: Context<InitMockFeed>, feed_id: u32, raw_price: i64, decimals: u8) -> Result<()> {
        instructions::mock::init_mock_feed(ctx, feed_id, raw_price, decimals)
    }
    pub fn set_mock_feed(ctx: Context<SetMockFeed>, raw_price: i64, decimals: u8) -> Result<()> {
        instructions::mock::set_mock_feed(ctx, raw_price, decimals)
    }
    pub fn delegate_mock_feed(ctx: Context<DelegateMockFeed>, feed_id: u32) -> Result<()> {
        instructions::mock::delegate_mock_feed(ctx, feed_id)
    }

    // ---- L1: hall of fame
    pub fn init_hall(ctx: Context<InitHall>) -> Result<()> {
        instructions::settle::init_hall(ctx)
    }
    pub fn record_hall(ctx: Context<RecordHall>) -> Result<()> {
        instructions::settle::record_hall(ctx)
    }
}
