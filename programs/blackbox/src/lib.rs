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
pub mod privacy;
pub mod state;

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
}
