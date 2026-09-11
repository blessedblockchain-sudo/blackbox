//! Real USDC inside the rollup: entry fee to the round vault, margin to the
//! entrant's custody account. Runs on the ER after the user has delegated
//! USDC with `delegateSpl` (the TEE exposes it at the user's ATA address).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::state::*;

#[derive(Accounts)]
pub struct FundEntrant<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), owner.key().as_ref()], bump = entrant.bump, has_one = owner)]
    pub entrant: Box<Account<'info, Entrant>>,
    #[account(mut, seeds = [POSITION_SEED, round.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Box<Account<'info, Position>>,
    /// The user's delegated USDC (their ATA address on the ER).
    #[account(mut, constraint = owner_ata.owner == owner.key() @ BlackboxError::OwnerMismatch, constraint = owner_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    /// Entrant PDA custody (its ATA address on the ER).
    #[account(mut, constraint = custody_ata.owner == entrant.key() @ BlackboxError::OwnerMismatch, constraint = custody_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
    /// Round PDA vault (its ATA address on the ER).
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Pay the entry fee and deposit margin. First call pays the fee; later calls
/// (while Open) top up margin within [min_margin, max_margin].
pub fn fund_entrant(ctx: Context<FundEntrant>, margin: u64) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.status == RoundStatus::Open, BlackboxError::BadRoundStatus);
    let e = &mut ctx.accounts.entrant;
    let p = &mut ctx.accounts.position;
    let total_after = e.deposited.checked_add(margin).ok_or(BlackboxError::MathOverflow)?;
    require!(total_after >= r.min_margin && total_after <= r.max_margin, BlackboxError::BadDeposit);

    if e.deposited == 0 && r.entry_fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            r.entry_fee,
        )?;
        r.pot = r.pot.checked_add(r.entry_fee).ok_or(BlackboxError::MathOverflow)?;
        r.vault_balance = r.vault_balance.checked_add(r.entry_fee).ok_or(BlackboxError::MathOverflow)?;
    }
    if margin > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.custody_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            margin,
        )?;
    }
    e.deposited = total_after;
    p.margin = p.margin.checked_add(margin).ok_or(BlackboxError::MathOverflow)?;
    p.last_equity = p.margin as i64 + p.realized_pnl;
    p.peak_equity = p.last_equity.max(p.peak_equity);
    Ok(())
}
