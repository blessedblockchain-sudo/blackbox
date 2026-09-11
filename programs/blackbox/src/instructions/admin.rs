//! Protocol + round administration (L1 unless noted).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use ephemeral_rollups_sdk::access_control::structs::EphemeralPermission;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::espl::{self, EataAccounts};
use crate::state::*;

// ------------------------------------------------------------ init_protocol

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_protocol(ctx: Context<InitProtocol>, protocol_fee_bps: u16) -> Result<()> {
    require!(protocol_fee_bps <= 2_000, BlackboxError::BadMarketConfig);
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.protocol_fee_bps = protocol_fee_bps;
    c.paused = false;
    c.round_count = 0;
    c.bump = ctx.bumps.config;
    Ok(())
}

// ------------------------------------------------------------ create_round

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, &config.round_count.to_le_bytes()],
        bump
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init,
        payer = admin,
        space = Scoreboard::SIZE,
        seeds = [SCOREBOARD_SEED, round.key().as_ref()],
        bump
    )]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// The round's custody token account (vault + pot), owned by the Round PDA.
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = round
    )]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: Round PDA's ephemeral ATA
    #[account(mut, constraint = vault_eata.key() == espl::ephemeral_ata_pda(&round.key(), &mint.key()) @ BlackboxError::BadEata)]
    pub vault_eata: UncheckedAccount<'info>,
    /// CHECK: delegation buffer
    #[account(mut, constraint = eata_buffer.key() == espl::eata_buffer_pda(&vault_eata.key()) @ BlackboxError::BadEata)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation record
    #[account(mut, constraint = eata_record.key() == espl::delegation_record_pda(&vault_eata.key()) @ BlackboxError::BadEata)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK: delegation metadata
    #[account(mut, constraint = eata_metadata.key() == espl::delegation_metadata_pda(&vault_eata.key()) @ BlackboxError::BadEata)]
    pub eata_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = EPHEMERAL_SPL_TOKEN_PROGRAM_ID)]
    pub ephemeral_token_program: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: validator identity the whole round is pinned to (TEE)
    pub validator: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_round(ctx: Context<CreateRound>, args: CreateRoundArgs) -> Result<()> {
    require!(!ctx.accounts.config.paused, BlackboxError::Paused);
    require!(args.min_margin > 0 && args.max_margin >= args.min_margin, BlackboxError::BadMarketConfig);
    require!(args.tick_interval_ms >= 100 && args.duration_ticks > 0, BlackboxError::BadMarketConfig);
    require!(args.step_limit > 0 && args.step_limit <= 4096, BlackboxError::BadMarketConfig);
    require!(args.license_fee_max_bps >= args.license_fee_min_bps && args.license_fee_max_bps <= 1_000, BlackboxError::BadMarketConfig);

    let id = ctx.accounts.config.round_count;
    let r = &mut ctx.accounts.round;
    r.id = id;
    r.admin = ctx.accounts.admin.key();
    r.mint = ctx.accounts.mint.key();
    r.status = RoundStatus::Created;
    r.mode = args.mode;
    r.n_markets = 0;
    r.markets = [MarketConfig::default(); MAX_MARKETS];
    r.mystery_market = u8::MAX;
    r.entry_fee = args.entry_fee;
    r.min_margin = args.min_margin;
    r.max_margin = args.max_margin;
    r.tick_interval_ms = args.tick_interval_ms;
    r.duration_ticks = args.duration_ticks;
    r.tick = 0;
    r.step_limit = args.step_limit;
    r.entrant_count = 0;
    r.settled_count = 0;
    r.batch_count = 0;
    r.prizes_paid = false;
    r.live = false;
    r.vrf_seed = [0u8; 32];
    r.vrf_ready = false;
    r.pot = 0;
    r.vault_balance = 0;
    r.total_equity = 0;
    r.checkpoint_every_ticks = args.checkpoint_every_ticks;
    r.created_at = Clock::get()?.unix_timestamp;
    r.started_at = 0;
    r.ended_at = 0;
    r.open_licenses = 0;
    r.protocol_fee_bps = ctx.accounts.config.protocol_fee_bps;
    r.license_fee_min_bps = args.license_fee_min_bps;
    r.license_fee_max_bps = args.license_fee_max_bps;
    r.validator = ctx.accounts.validator.key();
    r.bump = ctx.bumps.round;

    {
        let mut b = ctx.accounts.scoreboard.load_init()?;
        b.round = ctx.accounts.round.key();
        b.n = 0;
        b.finalized = 0;
        b.bump = ctx.bumps.scoreboard;
    }

    // Pre-fund the Round and Scoreboard PDAs with rent for their ephemeral
    // permissions (the Scoreboard is private in Dark mode; the Round keeps a
    // public permission so it can be flipped if ever needed). The Round also
    // sponsors the round chat, an ephemeral account that exists only on the ER.
    let rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32);
    let chat_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(CHAT_SIZE as u32);
    for (to, lamports) in [(ctx.accounts.round.to_account_info(), rent + chat_rent), (ctx.accounts.scoreboard.to_account_info(), rent)] {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to },
            ),
            lamports,
        )?;
    }

    // Custody: init + delegate the Round PDA's ephemeral ATA to the validator.
    let round_info = ctx.accounts.round.to_account_info();
    espl::init_and_delegate_eata(
        &EataAccounts {
            program: &ctx.accounts.ephemeral_token_program.to_account_info(),
            payer: &ctx.accounts.admin.to_account_info(),
            owner: &round_info,
            mint: &ctx.accounts.mint.to_account_info(),
            eata: &ctx.accounts.vault_eata.to_account_info(),
            buffer: &ctx.accounts.eata_buffer.to_account_info(),
            record: &ctx.accounts.eata_record.to_account_info(),
            metadata: &ctx.accounts.eata_metadata.to_account_info(),
            delegation_program: &ctx.accounts.delegation_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        Some(ctx.accounts.validator.key()),
    )?;

    ctx.accounts.config.round_count = id.checked_add(1).ok_or(BlackboxError::MathOverflow)?;
    Ok(())
}

// ------------------------------------------------------------ add_market

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct AddMarket<'info> {
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init,
        payer = admin,
        space = Market::SIZE,
        seeds = [MARKET_SEED, round.key().as_ref(), &[index]],
        bump
    )]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: oracle price account; validated on the ER at tick time (on L1 it
    /// is owned by the delegation program).
    pub feed: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn add_market(ctx: Context<AddMarket>, index: u8, cfg: MarketConfig) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.status == RoundStatus::Created, BlackboxError::BadRoundStatus);
    require!((index as usize) < MAX_MARKETS && index == r.n_markets, BlackboxError::BadMarketIndex);
    require!(cfg.max_leverage >= 1 && cfg.max_leverage <= 100, BlackboxError::BadMarketConfig);
    require!(cfg.maintenance_bps >= 50 && cfg.maintenance_bps <= 5_000, BlackboxError::BadMarketConfig);
    require!(cfg.oi_cap > 0 && cfg.decimals <= 12, BlackboxError::BadMarketConfig);
    let mut c = cfg;
    c.feed = ctx.accounts.feed.key();
    c.enabled = true;
    r.markets[index as usize] = c;
    r.n_markets += 1;

    let round_key = r.key();
    let mut m = ctx.accounts.market.load_init()?;
    m.round = round_key;
    m.index = index;
    m.feed = c.feed;
    m.decimals = c.decimals;
    m.max_leverage = c.max_leverage;
    m.maintenance_bps = c.maintenance_bps;
    m.base_spread_bps = c.base_spread_bps;
    m.skew_spread_bps = c.skew_spread_bps;
    m.oi_cap = c.oi_cap;
    m.oi_long = 0;
    m.oi_short = 0;
    m.funding_index = 0;
    m.funding_rate_bps = 0;
    m.last_funding_tick = 0;
    m.mark = 0;
    m.last_publish_time = 0;
    m.last_tick = 0;
    m.ring = [0i64; RING_LEN];
    m.ring_pos = 0;
    m.ring_len = 0;
    m.ema8 = 0;
    m.ema21 = 0;
    m.ema55 = 0;
    m.vol = 0;
    m.bump = ctx.bumps.market;
    Ok(())
}

// ------------------------------------------------------------ open_round

#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Account<'info, Round>,
    pub admin: Signer<'info>,
}

/// Freeze markets and open for joins (still on L1).
pub fn open_round(ctx: Context<OpenRound>) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.status == RoundStatus::Created, BlackboxError::BadRoundStatus);
    require!(r.n_markets > 0, BlackboxError::BadMarketConfig);
    r.status = RoundStatus::Open;
    Ok(())
}

// ------------------------------------------------------------ delegate round-level accounts

#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u32, index: u8)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: round PDA, read only to bind seeds
    #[account(seeds = [ROUND_SEED, &round_id.to_le_bytes()], bump)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: market PDA
    #[account(mut, del, seeds = [MARKET_SEED, round.key().as_ref(), &[index]], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: validator identity
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_market(ctx: Context<DelegateMarket>, round_id: u32, index: u8) -> Result<()> {
    let round_key = ctx.accounts.round.key();
    ctx.accounts.delegate_market(
        &ctx.accounts.admin,
        &[MARKET_SEED, round_key.as_ref(), &[index]],
        DelegateConfig {
            commit_frequency_ms: NEVER_AUTO_COMMIT_MS,
            validator: Some(ctx.accounts.validator.key()),
        },
    )?;
    let _ = round_id;
    Ok(())
}
