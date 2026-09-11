//! Settlement. Once the clock flips the round to `Settling`:
//!
//! 1. `settle_entrant`     (ER, per entrant) close legs at final marks, move
//!                         real USDC between custody and vault, hand the rest
//!                         to the owner's ATA, publish the strategy hash, scrub
//!                         the private accounts and close their permissions.
//! 2. `undelegate_entrant` (ER) commit + undelegate the (scrubbed) accounts.
//! 3. `rank_round`         (ER) rank by return on deposit once everyone settled.
//! 4. `pay_prizes`         (ER) pot to the top three from the vault.
//! 5. `close_round`        (ER) commit + undelegate round, scoreboard, markets.
//! 6. `record_hall`        (L1) Hall of Fame + ELO from the committed scoreboard.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as SplTransfer};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use solana_sha256_hasher::hashv;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::perps;
use crate::privacy::{self, PermissionAccounts};
use crate::state::*;

/// Prize split of the pot after protocol fee, in bps: 1st, 2nd, 3rd.
pub const PRIZE_SPLIT_BPS: [u64; 3] = [5_000, 3_000, 2_000];

// ------------------------------------------------------------ settle_entrant (ER)

#[derive(Accounts)]
pub struct SettleEntrant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump = entrant.bump)]
    pub entrant: Box<Account<'info, Entrant>>,
    #[account(mut, seeds = [STRATEGY_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub strategy: AccountLoader<'info, Strategy>,
    #[account(mut, seeds = [POSITION_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub position: AccountLoader<'info, Position>,
    /// The owner's USDC on the ER (their ATA address).
    #[account(mut, constraint = owner_ata.owner == entrant.owner @ BlackboxError::OwnerMismatch, constraint = owner_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = custody_ata.owner == entrant.key() @ BlackboxError::OwnerMismatch, constraint = custody_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: permission PDA of the strategy
    #[account(mut, seeds = [PERMISSION_SEED, strategy.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub strategy_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of the position
    #[account(mut, seeds = [PERMISSION_SEED, position.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub position_permission: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: [market_0, market_1, ...] (n_markets, writable)
}

pub fn settle_entrant<'info>(ctx: Context<'info, SettleEntrant<'info>>) -> Result<()> {
    let round_key = ctx.accounts.round.key();
    require!(!ctx.accounts.round.live && ctx.accounts.round.status == RoundStatus::Settling, BlackboxError::RoundNotEnded);
    require!(!ctx.accounts.entrant.settled, BlackboxError::AlreadyFinalized);
    let n = ctx.accounts.round.n_markets as usize;
    require!(ctx.remaining_accounts.len() >= n, BlackboxError::BadMarketIndex);
    let owner_key = ctx.accounts.entrant.owner;

    // 1) Close every leg at the final marks (with spread), realizing PnL.
    let (realized_pnl, margin, trades, hash) = {
        let mut pos = ctx.accounts.position.load_mut()?;
        require_keys_eq!(pos.owner, owner_key, BlackboxError::OwnerMismatch);
        for i in 0..n {
            if pos.legs[i].side == 0 {
                continue;
            }
            let loader = AccountLoader::<Market>::try_from(&ctx.remaining_accounts[i])?;
            let mut m = loader.load_mut()?;
            require_keys_eq!(m.round, round_key, BlackboxError::RoundMismatch);
            require!(m.index as usize == i, BlackboxError::BadMarketIndex);
            let r = perps::trade_to_target(&mut m, &mut pos.legs[i], 0, 0, 0)?;
            pos.realized_pnl = pos.realized_pnl.saturating_add(r.realized_delta);
        }
        let strategy = ctx.accounts.strategy.load()?;
        let hash = hashv(&[&strategy.bytecode[..strategy.len as usize]]).to_bytes();
        (pos.realized_pnl, pos.margin, pos.trade_count, hash)
    };
    let final_equity: i64 = (margin as i128 + realized_pnl as i128).max(0) as i64;

    // 2) Real USDC: PnL between custody and vault, then everything to the owner.
    let entrant_bump = [ctx.accounts.entrant.bump];
    let entrant_seeds: &[&[u8]] = &[ENTRANT_SEED, round_key.as_ref(), owner_key.as_ref(), &entrant_bump];
    let round_bump = [ctx.accounts.round.bump];
    let round_id = ctx.accounts.round.id.to_le_bytes();
    let round_seeds: &[&[u8]] = &[ROUND_SEED, &round_id, &round_bump];

    if realized_pnl < 0 {
        let loss = realized_pnl.unsigned_abs().min(ctx.accounts.custody_ata.amount);
        if loss > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    SplTransfer {
                        from: ctx.accounts.custody_ata.to_account_info(),
                        to: ctx.accounts.vault_ata.to_account_info(),
                        authority: ctx.accounts.entrant.to_account_info(),
                    },
                    &[entrant_seeds],
                ),
                loss,
            )?;
            ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_add(loss);
        }
    } else if realized_pnl > 0 {
        // The pot is reserved for prizes; profits come from what remains.
        let available = ctx.accounts.vault_ata.amount.saturating_sub(ctx.accounts.round.pot);
        let profit = (realized_pnl as u64).min(available);
        if profit > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    SplTransfer {
                        from: ctx.accounts.vault_ata.to_account_info(),
                        to: ctx.accounts.custody_ata.to_account_info(),
                        authority: ctx.accounts.round.to_account_info(),
                    },
                    &[round_seeds],
                ),
                profit,
            )?;
            ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_sub(profit);
        }
    }
    ctx.accounts.custody_ata.reload()?;
    let payout = ctx.accounts.custody_ata.amount;
    if payout > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.custody_ata.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.entrant.to_account_info(),
                },
                &[entrant_seeds],
            ),
            payout,
        )?;
    }

    // 3) Publish the strategy hash and the final equity.
    let e = &mut ctx.accounts.entrant;
    e.strategy_hash = hash;
    e.alive = false;
    e.settled = true;
    {
        let mut sb = ctx.accounts.scoreboard.load_mut()?;
        let idx = e.index as usize;
        require!(idx < MAX_ENTRANTS, BlackboxError::ScoreboardFull);
        if (sb.n as usize) <= idx {
            sb.n = (idx + 1) as u16;
        }
        let s = &mut sb.entries[idx];
        s.owner = e.owner;
        s.equity = final_equity;
        s.deposited = e.deposited;
        s.alive = 0;
        s.trades = trades;
        s.strategy_hash = hash;
    }
    ctx.accounts.round.settled_count = ctx.accounts.round.settled_count.saturating_add(1);

    // 4) Scrub private bodies, then close their permissions (rent back to the PDAs).
    let strat_info = ctx.accounts.strategy.to_account_info();
    let pos_info = ctx.accounts.position.to_account_info();
    privacy::scrub(&strat_info)?;
    privacy::scrub(&pos_info)?;
    let sperm = ctx.accounts.strategy_permission.to_account_info();
    let pperm = ctx.accounts.position_permission.to_account_info();
    let vault = ctx.accounts.ephemeral_vault.to_account_info();
    let magic = ctx.accounts.magic_program.to_account_info();
    let perm_prog = ctx.accounts.permission_program.to_account_info();
    let sbump = [ctx.bumps.strategy];
    let sseeds: &[&[u8]] = &[STRATEGY_SEED, round_key.as_ref(), owner_key.as_ref(), &sbump];
    privacy::close_permission(
        &PermissionAccounts {
            sponsor: &strat_info,
            target: &strat_info,
            permission: &sperm,
            ephemeral_vault: &vault,
            magic_program: &magic,
            permission_program: &perm_prog,
        },
        &[sseeds],
    )?;
    let pbump = [ctx.bumps.position];
    let pseeds: &[&[u8]] = &[POSITION_SEED, round_key.as_ref(), owner_key.as_ref(), &pbump];
    privacy::close_permission(
        &PermissionAccounts {
            sponsor: &pos_info,
            target: &pos_info,
            permission: &pperm,
            ephemeral_vault: &vault,
            magic_program: &magic,
            permission_program: &perm_prog,
        },
        &[pseeds],
    )?;
    Ok(())
}

// ------------------------------------------------------------ undelegate_entrant (ER)

#[commit]
#[derive(Accounts)]
pub struct UndelegateEntrant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump = entrant.bump)]
    pub entrant: Box<Account<'info, Entrant>>,
    /// CHECK: scrubbed strategy
    #[account(mut, seeds = [STRATEGY_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub strategy: UncheckedAccount<'info>,
    /// CHECK: scrubbed position
    #[account(mut, seeds = [POSITION_SEED, round.key().as_ref(), entrant.owner.as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
}

pub fn undelegate_entrant(ctx: Context<UndelegateEntrant>) -> Result<()> {
    require!(ctx.accounts.entrant.settled, BlackboxError::RoundNotEnded);
    // Defense in depth: never commit a private account that still has a body.
    for info in [ctx.accounts.strategy.to_account_info(), ctx.accounts.position.to_account_info()] {
        let d = info.try_borrow_data()?;
        require!(d.len() <= 8 || d[8..].iter().all(|b| *b == 0), BlackboxError::Unauthorized);
    }
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[
        ctx.accounts.entrant.to_account_info(),
        ctx.accounts.strategy.to_account_info(),
        ctx.accounts.position.to_account_info(),
    ])
    .build_and_invoke()?;
    Ok(())
}

// ------------------------------------------------------------ rank_round (ER)

#[derive(Accounts)]
pub struct RankRound<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
}

/// Rank by return on deposit (equity / deposited). Ties broken by index.
pub fn rank_round(ctx: Context<RankRound>) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Settling, BlackboxError::RoundNotEnded);
    require!(r.settled_count == r.entrant_count, BlackboxError::RoundNotEnded);
    let mut sb = ctx.accounts.scoreboard.load_mut()?;
    require!(sb.finalized == 0, BlackboxError::AlreadyFinalized);
    let n = sb.n as usize;
    let roi = |e: &ScoreEntry| -> i128 {
        if e.deposited == 0 {
            i128::MIN / 2
        } else {
            e.equity as i128 * USDC_SCALE as i128 / e.deposited as i128
        }
    };
    let mut ranks = [0u8; MAX_ENTRANTS];
    for i in 0..n {
        let mine = roi(&sb.entries[i]);
        let mut rank = 1u8;
        for j in 0..n {
            if j == i {
                continue;
            }
            let other = roi(&sb.entries[j]);
            if other > mine || (other == mine && j < i) {
                rank += 1;
            }
        }
        ranks[i] = rank;
    }
    for i in 0..n {
        sb.entries[i].rank = ranks[i];
    }
    sb.finalized = 1;
    Ok(())
}

// ------------------------------------------------------------ pay_prizes (ER)

#[derive(Accounts)]
pub struct PayPrizes<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: winners' USDC ATAs for ranks 1..=min(3, n), in rank order
}

pub fn pay_prizes<'info>(ctx: Context<'info, PayPrizes<'info>>) -> Result<()> {
    require!(!ctx.accounts.round.prizes_paid, BlackboxError::AlreadyFinalized);
    let (winners, owners) = {
        let sb = ctx.accounts.scoreboard.load()?;
        require!(sb.finalized == 1, BlackboxError::RoundNotEnded);
        let winners = (sb.n as usize).min(3);
        let mut owners = [Pubkey::default(); 3];
        for (k, o) in owners.iter_mut().enumerate().take(winners) {
            let w = sb.entries.iter().take(sb.n as usize).find(|e| e.rank == (k + 1) as u8).ok_or(BlackboxError::NotOnScoreboard)?;
            *o = w.owner;
        }
        (winners, owners)
    };
    require!(ctx.remaining_accounts.len() >= winners, BlackboxError::NotOnScoreboard);
    let pot = ctx.accounts.round.pot;
    let fee = pot * ctx.accounts.round.protocol_fee_bps as u64 / BPS as u64;
    let distributable = pot.saturating_sub(fee);
    let round_bump = [ctx.accounts.round.bump];
    let round_id = ctx.accounts.round.id.to_le_bytes();
    let round_seeds: &[&[u8]] = &[ROUND_SEED, &round_id, &round_bump];
    // Unused shares (fewer than 3 entrants) roll into first place.
    let mut shares = [0u64; 3];
    let mut unused = 0u64;
    for k in 0..3 {
        let s = distributable * PRIZE_SPLIT_BPS[k] / BPS as u64;
        if k < winners {
            shares[k] = s;
        } else {
            unused += s;
        }
    }
    shares[0] += unused;
    for k in 0..winners {
        let ata_info = &ctx.remaining_accounts[k];
        let ata = Account::<TokenAccount>::try_from(ata_info)?;
        require_keys_eq!(ata.owner, owners[k], BlackboxError::OwnerMismatch);
        require_keys_eq!(ata.mint, ctx.accounts.round.mint, BlackboxError::BadDeposit);
        if shares[k] > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    SplTransfer {
                        from: ctx.accounts.vault_ata.to_account_info(),
                        to: ata_info.clone(),
                        authority: ctx.accounts.round.to_account_info(),
                    },
                    &[round_seeds],
                ),
                shares[k],
            )?;
        }
    }
    let r = &mut ctx.accounts.round;
    r.vault_balance = r.vault_balance.saturating_sub(distributable);
    r.pot = fee; // what remains of the pot is the protocol's
    r.prizes_paid = true;
    Ok(())
}

// ------------------------------------------------------------ close_round (ER)

#[commit]
#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    // remaining_accounts: markets (writable)
}

pub fn close_round<'info>(ctx: Context<'info, CloseRound<'info>>) -> Result<()> {
    require!(ctx.accounts.round.prizes_paid, BlackboxError::RoundNotEnded);
    ctx.accounts.round.status = RoundStatus::Settled;
    // Persist the status change before the bundle snapshots the account data.
    ctx.accounts.round.exit(&crate::ID)?;
    let mut accs: Vec<AccountInfo<'info>> = vec![ctx.accounts.round.to_account_info(), ctx.accounts.scoreboard.to_account_info()];
    for m in ctx.remaining_accounts.iter() {
        require_keys_eq!(*m.owner, crate::ID, BlackboxError::BadMarketIndex);
        accs.push(m.clone());
    }
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&accs)
    .build_and_invoke()?;
    Ok(())
}

// ------------------------------------------------------------ hall (L1)

#[derive(Accounts)]
pub struct InitHall<'info> {
    #[account(init_if_needed, payer = payer, space = 8 + Hall::INIT_SPACE, seeds = [HALL_SEED, wallet.key().as_ref()], bump)]
    pub hall: Account<'info, Hall>,
    /// CHECK: any wallet
    pub wallet: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_hall(ctx: Context<InitHall>) -> Result<()> {
    let h = &mut ctx.accounts.hall;
    if h.wallet == Pubkey::default() {
        h.wallet = ctx.accounts.wallet.key();
        h.elo = 1_000;
        h.bump = ctx.bumps.hall;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct RecordHall<'info> {
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(seeds = [SCOREBOARD_SEED, round.key().as_ref()], bump)]
    pub scoreboard: AccountLoader<'info, Scoreboard>,
    #[account(mut, seeds = [HALL_SEED, hall.wallet.as_ref()], bump = hall.bump)]
    pub hall: Account<'info, Hall>,
    #[account(
        mut,
        seeds = [ENTRANT_SEED, round.key().as_ref(), hall.wallet.as_ref()],
        bump = entrant.bump,
        constraint = entrant.owner == hall.wallet @ BlackboxError::OwnerMismatch
    )]
    pub entrant: Box<Account<'info, Entrant>>,
}

/// After the round is undelegated, fold one entrant's result into their Hall.
/// ELO: K=32 against an expected mid-table finish.
pub fn record_hall(ctx: Context<RecordHall>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Settled, BlackboxError::RoundNotEnded);
    require!(!ctx.accounts.entrant.hall_recorded, BlackboxError::AlreadyFinalized);
    let (rank, equity, deposited, n) = {
        let sb = ctx.accounts.scoreboard.load()?;
        require!(sb.finalized == 1, BlackboxError::RoundNotEnded);
        let wallet = ctx.accounts.hall.wallet;
        let e = sb.entries.iter().take(sb.n as usize).find(|e| e.owner == wallet).ok_or(BlackboxError::NotOnScoreboard)?;
        (e.rank, e.equity, e.deposited, sb.n.max(1) as i64)
    };
    let h = &mut ctx.accounts.hall;
    h.rounds = h.rounds.saturating_add(1);
    if rank == 1 {
        h.wins = h.wins.saturating_add(1);
    }
    if rank <= 3 {
        h.podiums = h.podiums.saturating_add(1);
    }
    h.total_pnl = h.total_pnl.saturating_add(equity - deposited as i64);
    if h.best_rank == 0 || rank < h.best_rank {
        h.best_rank = rank;
    }
    // score in [0,1000]: 1st -> 1000, last -> 0
    let score = if n > 1 { (n - rank as i64) * 1000 / (n - 1) } else { 1000 };
    h.elo = h.elo.saturating_add((32 * (score - 500) / 1000) as i32);
    ctx.accounts.entrant.hall_recorded = true;
    Ok(())
}
