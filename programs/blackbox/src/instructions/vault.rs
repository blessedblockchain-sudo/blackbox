//! House bankroll for a round's vault, the counterparty of every book.
//!
//! `seed_vault`  (ER) the admin adds USDC so profits are paid in full whatever
//!               order entrants settle in; it counts toward the public solvency
//!               beacon (`Round.vault_balance`).
//! `sweep_vault` (ER) once prizes are paid and every entrant and license has
//!               settled, the admin takes what is left (bankroll, net trading
//!               losses, protocol fee), before `close_round`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::state::*;

#[derive(Accounts)]
pub struct VaultAdmin<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Box<Account<'info, Round>>,
    /// The admin's USDC on the ER (their ATA address).
    #[account(mut, constraint = admin_ata.owner == admin.key() @ BlackboxError::OwnerMismatch, constraint = admin_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub admin_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn seed_vault(ctx: Context<VaultAdmin>, amount: u64) -> Result<()> {
    require!(matches!(ctx.accounts.round.status, RoundStatus::Open | RoundStatus::Live), BlackboxError::BadRoundStatus);
    require!(amount > 0, BlackboxError::BadDeposit);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.admin_ata.to_account_info(),
                to: ctx.accounts.vault_ata.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount,
    )?;
    ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_add(amount);
    Ok(())
}

pub fn sweep_vault(ctx: Context<VaultAdmin>) -> Result<()> {
    let (bump, id) = {
        let r = &ctx.accounts.round;
        require!(r.status == RoundStatus::Settling && r.prizes_paid, BlackboxError::RoundNotEnded);
        require!(r.settled_count == r.entrant_count, BlackboxError::RoundNotEnded);
        require!(r.open_licenses == 0, BlackboxError::LicensesOpen);
        ([r.bump], r.id.to_le_bytes())
    };
    let amount = ctx.accounts.vault_ata.amount;
    if amount > 0 {
        let seeds: &[&[u8]] = &[ROUND_SEED, &id, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: ctx.accounts.admin_ata.to_account_info(),
                    authority: ctx.accounts.round.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    let r = &mut ctx.accounts.round;
    r.vault_balance = 0;
    r.pot = 0;
    Ok(())
}
