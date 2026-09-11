//! Round-level delegation and lifecycle.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::privacy::{self, PermissionAccounts};
use crate::state::*;

// ------------------------------------------------------------ delegate round + scoreboard (L1)

#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u32)]
pub struct DelegateRoundAccounts<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: round PDA
    #[account(mut, del, seeds = [ROUND_SEED, &round_id.to_le_bytes()], bump)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: scoreboard PDA
    #[account(mut, del, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: UncheckedAccount<'info>,
    /// CHECK: validator identity
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_round(ctx: Context<DelegateRoundAccounts>, round_id: u32) -> Result<()> {
    {
        let data = ctx.accounts.round.try_borrow_data()?;
        let r = Round::try_deserialize(&mut &data[..])?;
        require_keys_eq!(r.admin, ctx.accounts.admin.key(), BlackboxError::Unauthorized);
        require!(r.status == RoundStatus::Open, BlackboxError::BadRoundStatus);
        require_keys_eq!(r.validator, ctx.accounts.validator.key(), BlackboxError::NotDelegated);
    }
    let validator = ctx.accounts.validator.key();
    let cfg = || DelegateConfig { commit_frequency_ms: NEVER_AUTO_COMMIT_MS, validator: Some(validator) };
    let round_key = ctx.accounts.round.key();
    ctx.accounts.delegate_round(&ctx.accounts.admin, &[ROUND_SEED, &round_id.to_le_bytes()], cfg())?;
    ctx.accounts.delegate_scoreboard(&ctx.accounts.admin, &[SCOREBOARD_SEED, round_key.as_ref()], cfg())?;
    Ok(())
}

// ------------------------------------------------------------ scoreboard privacy (ER)

#[derive(Accounts)]
pub struct ScoreboardPrivacy<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Account<'info, Round>,
    #[account(mut, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump = scoreboard.bump)]
    pub scoreboard: Account<'info, Scoreboard>,
    /// CHECK: permission PDA of the scoreboard
    #[account(mut, seeds = [PERMISSION_SEED, scoreboard.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Dark mode: make the scoreboard program-only (no members). Lit mode: public.
pub fn set_scoreboard_privacy(ctx: Context<ScoreboardPrivacy>, private: bool) -> Result<()> {
    let round_key = ctx.accounts.round.key();
    let bump = [ctx.accounts.scoreboard.bump];
    let seeds: &[&[u8]] = &[SCOREBOARD_SEED, round_key.as_ref(), &bump];
    let sb = ctx.accounts.scoreboard.to_account_info();
    let accs = PermissionAccounts {
        sponsor: &sb,
        target: &sb,
        permission: &ctx.accounts.permission.to_account_info(),
        ephemeral_vault: &ctx.accounts.ephemeral_vault.to_account_info(),
        magic_program: &ctx.accounts.magic_program.to_account_info(),
        permission_program: &ctx.accounts.permission_program.to_account_info(),
    };
    if ctx.accounts.permission.data_is_empty() {
        privacy::create_permission(&accs, private, vec![], &[seeds])?;
    } else {
        privacy::update_permission(&accs, private, vec![], &[seeds])?;
    }
    Ok(())
}

// ------------------------------------------------------------ start_round (ER)

#[derive(Accounts)]
pub struct StartRound<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Account<'info, Round>,
}

/// Flip the round live (runs on the ER after delegation). Crank scheduling
/// and the VRF request are attached in later phases.
pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.status == RoundStatus::Open, BlackboxError::BadRoundStatus);
    require!(r.entrant_count > 0, BlackboxError::BadRoundStatus);
    r.status = RoundStatus::Live;
    r.live = true;
    r.tick = 0;
    r.started_at = Clock::get()?.unix_timestamp;
    r.batch_count = ((r.entrant_count as usize + BATCH_SIZE - 1) / BATCH_SIZE) as u8;
    Ok(())
}
