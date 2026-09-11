//! Blind licensing: back an author's sealed strategy with your own margin.
//!
//! The crank runs the AUTHOR's private bytecode against the BUYER's private
//! License book every tick. The buyer never sees the code (the License
//! permission lists buyer + author, the Strategy permission lists only the
//! author). A fee priced inside the TEE from the author's private Sharpe
//! ratio (`Entrant.fee_price_bps`, the only public output) accrues on every
//! traded notional and is paid to the author at settlement.
//!
//! Lifecycle:
//!   L1  open_license        create License + custody ATA/eATA (any phase before settling)
//!   L1  delegate_license    delegate the License PDA to the round's validator
//!   ER  activate_license    private permission [buyer, author], margin in, fee locked
//!   ER  schedule_license_tick / tick_license   crank loop
//!   ER  settle_license      close legs, PnL vs vault, fees to author, rest to buyer, scrub
//!   ER  undelegate_license

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::InstructionData;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralPermission, PERMISSION_SEED};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use super::tick::{load_markets, run_book, schedule, BookMut};
use crate::constants::*;
use crate::errors::BlackboxError;
use crate::espl::{self, EataAccounts};
use crate::perps;
use crate::privacy::{self, PermissionAccounts};
use crate::state::*;
use crate::vm_host::TickHost;

// ------------------------------------------------------------ open_license (L1)

#[derive(Accounts)]
pub struct OpenLicense<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: round (possibly delegated; its L1 copy is read for mint/validator)
    pub round: UncheckedAccount<'info>,
    /// CHECK: the author's Entrant (possibly delegated; L1 copy read for round/owner)
    pub author_entrant: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = License::SIZE,
        seeds = [LICENSE_SEED, round.key().as_ref(), buyer.key().as_ref(), author.key().as_ref()],
        bump
    )]
    pub license: AccountLoader<'info, License>,
    /// CHECK: author wallet (bound to author_entrant below)
    pub author: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = buyer, associated_token::mint = mint, associated_token::authority = license)]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: License PDA's ephemeral ATA
    #[account(mut, constraint = custody_eata.key() == espl::ephemeral_ata_pda(&license.key(), &mint.key()) @ BlackboxError::BadEata)]
    pub custody_eata: UncheckedAccount<'info>,
    /// CHECK: delegation buffer
    #[account(mut, constraint = eata_buffer.key() == espl::eata_buffer_pda(&custody_eata.key()) @ BlackboxError::BadEata)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation record
    #[account(mut, constraint = eata_record.key() == espl::delegation_record_pda(&custody_eata.key()) @ BlackboxError::BadEata)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK: delegation metadata
    #[account(mut, constraint = eata_metadata.key() == espl::delegation_metadata_pda(&custody_eata.key()) @ BlackboxError::BadEata)]
    pub eata_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = EPHEMERAL_SPL_TOKEN_PROGRAM_ID)]
    pub ephemeral_token_program: UncheckedAccount<'info>,
    /// CHECK: fixed
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn open_license(ctx: Context<OpenLicense>) -> Result<()> {
    let round = {
        let d = ctx.accounts.round.try_borrow_data()?;
        Round::try_deserialize(&mut &d[..])?
    };
    let (expected_round, _) = Pubkey::find_program_address(&[ROUND_SEED, &round.id.to_le_bytes()], &crate::ID);
    require_keys_eq!(expected_round, ctx.accounts.round.key(), BlackboxError::RoundMismatch);
    require!(!matches!(round.status, RoundStatus::Settling | RoundStatus::Settled), BlackboxError::BadRoundStatus);
    require_keys_eq!(round.mint, ctx.accounts.mint.key(), BlackboxError::BadDeposit);
    let author_entrant = {
        let d = ctx.accounts.author_entrant.try_borrow_data()?;
        Entrant::try_deserialize(&mut &d[..])?
    };
    let (expected_entrant, _) =
        Pubkey::find_program_address(&[ENTRANT_SEED, ctx.accounts.round.key().as_ref(), ctx.accounts.author.key().as_ref()], &crate::ID);
    require_keys_eq!(expected_entrant, ctx.accounts.author_entrant.key(), BlackboxError::OwnerMismatch);
    require_keys_eq!(author_entrant.round, ctx.accounts.round.key(), BlackboxError::RoundMismatch);
    require_keys_eq!(author_entrant.owner, ctx.accounts.author.key(), BlackboxError::OwnerMismatch);
    require_keys_neq!(ctx.accounts.author.key(), ctx.accounts.buyer.key(), BlackboxError::Unauthorized);

    {
        let mut l = ctx.accounts.license.load_init()?;
        l.round = ctx.accounts.round.key();
        l.buyer = ctx.accounts.buyer.key();
        l.author = ctx.accounts.author.key();
        l.bump = ctx.bumps.license;
    }
    // Pre-fund permission rent for a 2-member permission [buyer, author].
    let rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(2) as u32);
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::Transfer { from: ctx.accounts.buyer.to_account_info(), to: ctx.accounts.license.to_account_info() },
        ),
        rent,
    )?;
    let license_info = ctx.accounts.license.to_account_info();
    espl::init_and_delegate_eata(
        &EataAccounts {
            program: &ctx.accounts.ephemeral_token_program.to_account_info(),
            payer: &ctx.accounts.buyer.to_account_info(),
            owner: &license_info,
            mint: &ctx.accounts.mint.to_account_info(),
            eata: &ctx.accounts.custody_eata.to_account_info(),
            buffer: &ctx.accounts.eata_buffer.to_account_info(),
            record: &ctx.accounts.eata_record.to_account_info(),
            metadata: &ctx.accounts.eata_metadata.to_account_info(),
            delegation_program: &ctx.accounts.delegation_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        Some(round.validator),
    )?;
    Ok(())
}

// ------------------------------------------------------------ delegate_license (L1)

#[delegate]
#[derive(Accounts)]
pub struct DelegateLicense<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: round PDA (L1 copy read for the validator)
    pub round: UncheckedAccount<'info>,
    /// CHECK: author wallet
    pub author: UncheckedAccount<'info>,
    /// CHECK: license PDA
    #[account(mut, del, seeds = [LICENSE_SEED, round.key().as_ref(), buyer.key().as_ref(), author.key().as_ref()], bump)]
    pub license: UncheckedAccount<'info>,
    /// CHECK: validator identity (must equal the round's)
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_license(ctx: Context<DelegateLicense>) -> Result<()> {
    {
        let d = ctx.accounts.round.try_borrow_data()?;
        let r = Round::try_deserialize(&mut &d[..])?;
        require_keys_eq!(r.validator, ctx.accounts.validator.key(), BlackboxError::NotDelegated);
    }
    let round_key = ctx.accounts.round.key();
    let buyer_key = ctx.accounts.buyer.key();
    let author_key = ctx.accounts.author.key();
    ctx.accounts.delegate_license(
        &ctx.accounts.buyer,
        &[LICENSE_SEED, round_key.as_ref(), buyer_key.as_ref(), author_key.as_ref()],
        DelegateConfig { commit_frequency_ms: NEVER_AUTO_COMMIT_MS, validator: Some(ctx.accounts.validator.key()) },
    )?;
    Ok(())
}

// ------------------------------------------------------------ activate_license (ER)

#[derive(Accounts)]
pub struct ActivateLicense<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), author_entrant.owner.as_ref()], bump = author_entrant.bump)]
    pub author_entrant: Box<Account<'info, Entrant>>,
    #[account(mut, seeds = [LICENSE_SEED, round.key().as_ref(), buyer.key().as_ref(), author_entrant.owner.as_ref()], bump)]
    pub license: AccountLoader<'info, License>,
    /// CHECK: permission PDA of the license
    #[account(mut, seeds = [PERMISSION_SEED, license.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    #[account(mut, constraint = buyer_ata.owner == buyer.key() @ BlackboxError::OwnerMismatch, constraint = buyer_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = custody_ata.owner == license.key() @ BlackboxError::OwnerMismatch, constraint = custody_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
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
}

pub fn activate_license(ctx: Context<ActivateLicense>, margin: u64) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(matches!(r.status, RoundStatus::Open | RoundStatus::Live), BlackboxError::BadRoundStatus);
    require!(margin >= r.min_margin && margin <= r.max_margin, BlackboxError::BadDeposit);
    require!((ctx.accounts.author_entrant.license_count as usize) < MAX_LICENSES_PER_AUTHOR, BlackboxError::LicenseLimit);
    let round_key = r.key();
    let buyer = ctx.accounts.buyer.key();
    let author = ctx.accounts.author_entrant.owner;
    let (bump, already) = {
        let l = ctx.accounts.license.load()?;
        require_keys_eq!(l.buyer, buyer, BlackboxError::OwnerMismatch);
        require_keys_eq!(l.author, author, BlackboxError::OwnerMismatch);
        (l.bump, l.active == 1)
    };
    require!(!already, BlackboxError::AlreadyFinalized);

    // Private to buyer + author before any state goes in.
    let bumps = [bump];
    let seeds: &[&[u8]] = &[LICENSE_SEED, round_key.as_ref(), buyer.as_ref(), author.as_ref(), &bumps];
    let li = ctx.accounts.license.to_account_info();
    privacy::create_permission(
        &PermissionAccounts {
            sponsor: &li,
            target: &li,
            permission: &ctx.accounts.permission.to_account_info(),
            ephemeral_vault: &ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: &ctx.accounts.magic_program.to_account_info(),
            permission_program: &ctx.accounts.permission_program.to_account_info(),
        },
        true,
        vec![privacy::read_member(buyer), privacy::read_member(author)],
        &[seeds],
    )?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.buyer_ata.to_account_info(),
                to: ctx.accounts.custody_ata.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        margin,
    )?;

    let fee = ctx.accounts.author_entrant.fee_price_bps.max(r.license_fee_min_bps);
    let tick = r.tick;
    {
        let mut l = ctx.accounts.license.load_mut()?;
        l.margin = margin;
        l.fee_bps = fee;
        l.active = 1;
        l.opened_tick = tick;
        l.last_equity = margin as i64;
        l.peak_equity = margin as i64;
    }
    ctx.accounts.author_entrant.license_count = ctx.accounts.author_entrant.license_count.saturating_add(1);
    Ok(())
}

// ------------------------------------------------------------ tick_license (crank)

#[derive(Accounts)]
pub struct TickLicense<'info> {
    /// CHECK: raw-deserialized (crank pattern)
    #[account(owner = crate::ID)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: author's entrant (public)
    #[account(owner = crate::ID)]
    pub author_entrant: UncheckedAccount<'info>,
    /// The author's private strategy: read by the program, never by the buyer.
    pub strategy: AccountLoader<'info, Strategy>,
    #[account(mut)]
    pub license: AccountLoader<'info, License>,
    // remaining_accounts: [market_0, feed_0, market_1, feed_1, ...]
}

pub fn tick_license<'info>(ctx: Context<'info, TickLicense<'info>>) -> Result<()> {
    let round = {
        let d = ctx.accounts.round.try_borrow_data()?;
        Round::try_deserialize(&mut &d[..])?
    };
    if !round.live {
        return Ok(());
    }
    let round_key = ctx.accounts.round.key();
    let entrant = {
        let d = ctx.accounts.author_entrant.try_borrow_data()?;
        Entrant::try_deserialize(&mut &d[..])?
    };
    require_keys_eq!(entrant.round, round_key, BlackboxError::RoundMismatch);
    let strategy = ctx.accounts.strategy.load()?;
    require_keys_eq!(strategy.owner, entrant.owner, BlackboxError::OwnerMismatch);
    require_keys_eq!(strategy.round, round_key, BlackboxError::RoundMismatch);
    let mut lic_ref = ctx.accounts.license.load_mut()?;
    let lic: &mut License = &mut lic_ref;
    require_keys_eq!(lic.author, entrant.owner, BlackboxError::OwnerMismatch);
    require_keys_eq!(lic.round, round_key, BlackboxError::RoundMismatch);
    // Permissionless like tick_entrant: run at most once per tick.
    if lic.active == 0 || lic.liquidated == 1 || lic.ran_tick == round.tick + 1 {
        return Ok(());
    }
    lic.ran_tick = round.tick + 1;

    let n = round.n_markets as usize;
    let now = Clock::get()?.unix_timestamp;
    let loaders = load_markets(ctx.remaining_accounts, &round_key, n, round.tick, now, true)?;
    let mut ms: Vec<std::cell::RefMut<Market>> = Vec::with_capacity(n);
    for l in loaders.iter() {
        ms.push(l.load_mut()?);
    }
    let run = strategy.len > 0;
    let out = {
        let mut book = BookMut {
            legs: &mut lic.legs,
            mem: &mut lic.mem,
            realized: &mut lic.realized_pnl,
            trades: &mut lic.trade_count,
            fee_bps: lic.fee_bps,
            fees: &mut lic.accrued_fees,
            margin: lic.margin,
        };
        run_book(
            &mut ms,
            &mut book,
            if run { Some(&strategy.bytecode[..strategy.len as usize]) } else { None },
            strategy.step_limit.min(round.step_limit).max(1),
            round.tick,
            TickHost::derive_rand(&round.vrf_seed, &lic.buyer, round.tick),
            true,
        )?
    };
    lic.last_fault = out.fault;
    if out.liquidated {
        lic.liquidated = 1;
    }
    lic.last_equity = out.equity;
    if out.equity > lic.peak_equity {
        lic.peak_equity = out.equity;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ScheduleLicenseTick<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(seeds = [ENTRANT_SEED, round.key().as_ref(), author_entrant.owner.as_ref()], bump = author_entrant.bump)]
    pub author_entrant: Box<Account<'info, Entrant>>,
    /// CHECK: author's strategy PDA (key only)
    #[account(seeds = [STRATEGY_SEED, round.key().as_ref(), author_entrant.owner.as_ref()], bump)]
    pub strategy: UncheckedAccount<'info>,
    /// CHECK: license PDA (key only)
    #[account(mut, seeds = [LICENSE_SEED, round.key().as_ref(), buyer.key().as_ref(), author_entrant.owner.as_ref()], bump)]
    pub license: UncheckedAccount<'info>,
    /// CHECK: the buyer (key only)
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    // remaining_accounts: [market_0, feed_0, ...]
}

pub fn schedule_license_tick<'info>(ctx: Context<'info, ScheduleLicenseTick<'info>>, task_id: i64) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Live, BlackboxError::NotLive);
    let n = r.n_markets as usize;
    require!(ctx.remaining_accounts.len() == 2 * n, BlackboxError::BadMarketIndex);
    let round_key = r.key();
    for i in 0..n {
        let (m, _) = Pubkey::find_program_address(&[MARKET_SEED, round_key.as_ref(), &[i as u8]], &crate::ID);
        require_keys_eq!(ctx.remaining_accounts[2 * i].key(), m, BlackboxError::BadMarketIndex);
        require_keys_eq!(ctx.remaining_accounts[2 * i + 1].key(), r.markets[i].feed, BlackboxError::BadOracle);
    }
    let mut metas = vec![
        AccountMeta::new_readonly(round_key, false),
        AccountMeta::new_readonly(ctx.accounts.author_entrant.key(), false),
        AccountMeta::new_readonly(ctx.accounts.strategy.key(), false),
        AccountMeta::new(ctx.accounts.license.key(), false),
    ];
    let mut infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.round.to_account_info(),
        ctx.accounts.author_entrant.to_account_info(),
        ctx.accounts.strategy.to_account_info(),
        ctx.accounts.license.to_account_info(),
    ];
    for i in 0..n {
        metas.push(AccountMeta::new(ctx.remaining_accounts[2 * i].key(), false));
        metas.push(AccountMeta::new_readonly(ctx.remaining_accounts[2 * i + 1].key(), false));
        infos.push(ctx.remaining_accounts[2 * i].clone());
        infos.push(ctx.remaining_accounts[2 * i + 1].clone());
    }
    let inner = Instruction { program_id: crate::ID, accounts: metas, data: crate::instruction::TickLicense {}.data() };
    let remaining = r.duration_ticks.saturating_sub(r.tick) as i64 + 1;
    schedule(&ctx.accounts.payer.to_account_info(), &ctx.accounts.magic_program.to_account_info(), task_id, r.tick_interval_ms as i64, remaining.max(1), inner, &infos)
}

// ------------------------------------------------------------ settle_license (ER)

#[derive(Accounts)]
pub struct SettleLicense<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [LICENSE_SEED, round.key().as_ref(), buyer.key().as_ref(), author.key().as_ref()], bump)]
    pub license: AccountLoader<'info, License>,
    /// CHECK: buyer wallet
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: author wallet
    pub author: UncheckedAccount<'info>,
    #[account(mut, constraint = custody_ata.owner == license.key() @ BlackboxError::OwnerMismatch, constraint = custody_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = vault_ata.owner == round.key() @ BlackboxError::OwnerMismatch, constraint = vault_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub vault_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = buyer_ata.owner == buyer.key() @ BlackboxError::OwnerMismatch, constraint = buyer_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = author_ata.owner == author.key() @ BlackboxError::OwnerMismatch, constraint = author_ata.mint == round.mint @ BlackboxError::BadDeposit)]
    pub author_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: permission PDA of the license
    #[account(mut, seeds = [PERMISSION_SEED, license.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
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
    pub token_program: Program<'info, Token>,
    // remaining_accounts: markets (writable), n_markets of them
}

pub fn settle_license<'info>(ctx: Context<'info, SettleLicense<'info>>) -> Result<()> {
    require!(!ctx.accounts.round.live && ctx.accounts.round.status == RoundStatus::Settling, BlackboxError::RoundNotEnded);
    let round_key = ctx.accounts.round.key();
    let n = ctx.accounts.round.n_markets as usize;
    let (realized, fees, bump) = {
        let mut l = ctx.accounts.license.load_mut()?;
        require!(l.settled == 0, BlackboxError::AlreadyFinalized);
        for i in 0..n {
            if l.legs[i].side == 0 {
                continue;
            }
            let loader = AccountLoader::<Market>::try_from(&ctx.remaining_accounts[i])?;
            let mut m = loader.load_mut()?;
            require_keys_eq!(m.round, round_key, BlackboxError::RoundMismatch);
            require!(m.index as usize == i, BlackboxError::BadMarketIndex);
            let r = perps::trade_to_target(&mut m, &mut l.legs[i], 0, 0, 0)?;
            l.realized_pnl = l.realized_pnl.saturating_add(r.realized_delta);
        }
        l.settled = 1;
        (l.realized_pnl, l.accrued_fees, l.bump)
    };
    let buyer = ctx.accounts.buyer.key();
    let author = ctx.accounts.author.key();
    let lbump = [bump];
    let lseeds: &[&[u8]] = &[LICENSE_SEED, round_key.as_ref(), buyer.as_ref(), author.as_ref(), &lbump];
    let rbump = [ctx.accounts.round.bump];
    let rid = ctx.accounts.round.id.to_le_bytes();
    let rseeds: &[&[u8]] = &[ROUND_SEED, &rid, &rbump];

    // Fees were charged into `realized`; trading PnL excluding fees settles against the vault.
    let trading_pnl = realized.saturating_add(fees as i64);
    let pay = |from: AccountInfo<'info>, to: AccountInfo<'info>, auth: AccountInfo<'info>, seeds: &[&[u8]], amount: u64| -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.key(), SplTransfer { from, to, authority: auth }, &[seeds]),
            amount,
        )
    };
    if trading_pnl < 0 {
        let loss = trading_pnl.unsigned_abs().min(ctx.accounts.custody_ata.amount);
        pay(ctx.accounts.custody_ata.to_account_info(), ctx.accounts.vault_ata.to_account_info(), ctx.accounts.license.to_account_info(), lseeds, loss)?;
        ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_add(loss);
    } else if trading_pnl > 0 {
        let available = ctx.accounts.vault_ata.amount.saturating_sub(ctx.accounts.round.pot);
        let profit = (trading_pnl as u64).min(available);
        pay(ctx.accounts.vault_ata.to_account_info(), ctx.accounts.custody_ata.to_account_info(), ctx.accounts.round.to_account_info(), rseeds, profit)?;
        ctx.accounts.round.vault_balance = ctx.accounts.round.vault_balance.saturating_sub(profit);
    }
    ctx.accounts.custody_ata.reload()?;
    let fee_paid = fees.min(ctx.accounts.custody_ata.amount);
    pay(ctx.accounts.custody_ata.to_account_info(), ctx.accounts.author_ata.to_account_info(), ctx.accounts.license.to_account_info(), lseeds, fee_paid)?;
    ctx.accounts.custody_ata.reload()?;
    let rest = ctx.accounts.custody_ata.amount;
    pay(ctx.accounts.custody_ata.to_account_info(), ctx.accounts.buyer_ata.to_account_info(), ctx.accounts.license.to_account_info(), lseeds, rest)?;

    // Scrub, then drop the permission.
    let li = ctx.accounts.license.to_account_info();
    privacy::scrub(&li)?;
    privacy::close_permission(
        &PermissionAccounts {
            sponsor: &li,
            target: &li,
            permission: &ctx.accounts.permission.to_account_info(),
            ephemeral_vault: &ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: &ctx.accounts.magic_program.to_account_info(),
            permission_program: &ctx.accounts.permission_program.to_account_info(),
        },
        &[lseeds],
    )?;
    emit!(LicenseSettled { round: round_key, buyer, author, fees_paid: fee_paid, returned: rest });
    Ok(())
}

#[event]
pub struct LicenseSettled {
    pub round: Pubkey,
    pub buyer: Pubkey,
    pub author: Pubkey,
    pub fees_paid: u64,
    pub returned: u64,
}

// ------------------------------------------------------------ undelegate_license (ER)

#[commit]
#[derive(Accounts)]
pub struct UndelegateLicense<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: scrubbed license
    #[account(mut, owner = crate::ID)]
    pub license: UncheckedAccount<'info>,
}

pub fn undelegate_license(ctx: Context<UndelegateLicense>) -> Result<()> {
    {
        let d = ctx.accounts.license.try_borrow_data()?;
        require!(d.len() <= 8 || d[8..].iter().all(|b| *b == 0), BlackboxError::Unauthorized);
    }
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.license.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}
