//! House bankroll for a round's vault, the counterparty of every book.
//!
//! `seed_vault`  (ER) anyone adds USDC to the vault (the house bankroll) so
//!               profits are paid in full whatever order entrants settle in; it
//!               counts toward the public solvency beacon (`Round.vault_balance`).
//! `sweep_vault` (ER) once prizes are paid and every entrant and license has
//!               settled, the admin sends what is left (bankroll, net trading
//!               losses, protocol fee) to a token account of its choice, before
//!               `close_round`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::state::*;

#[derive(Accounts)]
pub struct SeedVault<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// The funder's USDC on the ER (their ATA address).
    #[account(mut, constraint = funder_ata.owner == funder.key() @ BlackboxError::OwnerMismatch, constraint = funder_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub funder_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn seed_vault(ctx: Context<SeedVault>, amount: u64) -> Result<()> {
    require!(matches!(ctx.accounts.round.status, RoundStatus::Open | RoundStatus::Live), BlackboxError::BadRoundStatus);
    require!(amount > 0, BlackboxError::BadDeposit);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.funder_ata.to_account_info(),
                to: ctx.accounts.vault_ata.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
    )?;
    ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_add(amount);
    Ok(())
}

#[derive(Accounts)]
pub struct SweepVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Box<Account<'info, Round>>,
    /// Destination chosen by the admin (on the ER), e.g. the house wallet's ATA.
    #[account(mut, constraint = to_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub to_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn sweep_vault(ctx: Context<SweepVault>) -> Result<()> {
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
                    to: ctx.accounts.to_ata.to_account_info(),
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
