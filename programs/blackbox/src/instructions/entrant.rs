//! Joining a round: create the entrant's accounts and custody on L1, delegate
//! them, then privatize and upload the strategy on the ER.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralPermission, PERMISSION_SEED};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::espl::{self, EataAccounts};
use crate::privacy::{self, PermissionAccounts};
use crate::state::*;

// ------------------------------------------------------------ join_round (L1)

#[derive(Accounts)]
pub struct JoinRound<'info> {
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Entrant::INIT_SPACE,
        seeds = [ENTRANT_SEED, round.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub entrant: Box<Account<'info, Entrant>>,
    #[account(
        init,
        payer = owner,
        space = Strategy::SIZE,
        seeds = [STRATEGY_SEED, round.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub strategy: AccountLoader<'info, Strategy>,
    #[account(
        init,
        payer = owner,
        space = Position::SIZE,
        seeds = [POSITION_SEED, round.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: AccountLoader<'info, Position>,
    #[account(address = round.mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// Custody token account owned by the Entrant PDA (margin lives here on the ER).
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = entrant
    )]
    pub custody_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: Entrant PDA's ephemeral ATA
    #[account(mut, constraint = custody_eata.key() == espl::ephemeral_ata_pda(&entrant.key(), &mint.key()) @ BlackboxError::BadEata)]
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
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn join_round(ctx: Context<JoinRound>) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.status == RoundStatus::Open, BlackboxError::BadRoundStatus);
    require!((r.entrant_count as usize) < MAX_ENTRANTS, BlackboxError::RoundFull);
    let index = r.entrant_count;
    r.entrant_count += 1;

    let e = &mut ctx.accounts.entrant;
    e.round = r.key();
    e.owner = ctx.accounts.owner.key();
    e.index = index;
    e.batch = (index as usize / BATCH_SIZE) as u8;
    e.slot = (index as usize % BATCH_SIZE) as u8;
    e.joined_at = Clock::get()?.unix_timestamp;
    e.alive = true;
    e.deposited = 0;
    e.strategy_hash = [0u8; 32];
    e.strategy_version = 0;
    e.fee_price_bps = r.license_fee_min_bps;
    e.license_count = 0;
    e.privatized = false;
    e.settled = false;
    e.hall_recorded = false;
    e.bump = ctx.bumps.entrant;

    let round_key = r.key();
    let step_limit = r.step_limit;
    {
        let mut s = ctx.accounts.strategy.load_init()?;
        s.round = round_key;
        s.owner = ctx.accounts.owner.key();
        s.step_limit = step_limit;
        s.bump = ctx.bumps.strategy;
    }
    {
        let mut p = ctx.accounts.position.load_init()?;
        p.round = round_key;
        p.owner = ctx.accounts.owner.key();
        p.bump = ctx.bumps.position;
    }

    // Pre-fund permission rent: Strategy and Position each get a 1-member
    // permission; the Entrant sponsors nothing yet but gets a small reserve.
    let rent1 = ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32);
    for (to, lamports) in [
        (ctx.accounts.strategy.to_account_info(), rent1),
        (ctx.accounts.position.to_account_info(), rent1),
        (ctx.accounts.entrant.to_account_info(), rent1),
    ] {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.owner.to_account_info(), to },
            ),
            lamports,
        )?;
    }

    // Custody: init + delegate the Entrant PDA's ephemeral ATA to the round's validator.
    let validator = ctx.accounts.round.validator;
    let entrant_info = ctx.accounts.entrant.to_account_info();
    espl::init_and_delegate_eata(
        &EataAccounts {
            program: &ctx.accounts.ephemeral_token_program.to_account_info(),
            payer: &ctx.accounts.owner.to_account_info(),
            owner: &entrant_info,
            mint: &ctx.accounts.mint.to_account_info(),
            eata: &ctx.accounts.custody_eata.to_account_info(),
            buffer: &ctx.accounts.eata_buffer.to_account_info(),
            record: &ctx.accounts.eata_record.to_account_info(),
            metadata: &ctx.accounts.eata_metadata.to_account_info(),
            delegation_program: &ctx.accounts.delegation_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        },
        Some(validator),
    )?;
    Ok(())
}

// ------------------------------------------------------------ delegate_entrant (L1)

#[delegate]
#[derive(Accounts)]
pub struct DelegateEntrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: round PDA (bound by the entrant's seeds)
    pub round: UncheckedAccount<'info>,
    /// CHECK: entrant PDA
    #[account(mut, del, seeds = [ENTRANT_SEED, round.key().as_ref(), owner.key().as_ref()], bump)]
    pub entrant: UncheckedAccount<'info>,
    /// CHECK: strategy PDA
    #[account(mut, del, seeds = [STRATEGY_SEED, round.key().as_ref(), owner.key().as_ref()], bump)]
    pub strategy: UncheckedAccount<'info>,
    /// CHECK: position PDA
    #[account(mut, del, seeds = [POSITION_SEED, round.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: validator identity (must equal the round's)
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_entrant(ctx: Context<DelegateEntrant>) -> Result<()> {
    {
        let data = ctx.accounts.round.try_borrow_data()?;
        // The round may already be delegated (owned by the delegation program);
        // its data is still readable on L1 as the last committed state.
        let r = Round::try_deserialize(&mut &data[..])?;
        require_keys_eq!(r.validator, ctx.accounts.validator.key(), BlackboxError::NotDelegated);
    }
    let validator = ctx.accounts.validator.key();
    let cfg = || DelegateConfig { commit_frequency_ms: NEVER_AUTO_COMMIT_MS, validator: Some(validator) };
    let round_key = ctx.accounts.round.key();
    let owner_key = ctx.accounts.owner.key();
    ctx.accounts.delegate_entrant(&ctx.accounts.owner, &[ENTRANT_SEED, round_key.as_ref(), owner_key.as_ref()], cfg())?;
    ctx.accounts.delegate_strategy(&ctx.accounts.owner, &[STRATEGY_SEED, round_key.as_ref(), owner_key.as_ref()], cfg())?;
    ctx.accounts.delegate_position(&ctx.accounts.owner, &[POSITION_SEED, round_key.as_ref(), owner_key.as_ref()], cfg())?;
    Ok(())
}

// ------------------------------------------------------------ privatize_entrant (ER)

#[derive(Accounts)]
pub struct PrivatizeEntrant<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), owner.key().as_ref()], bump = entrant.bump, has_one = owner)]
    pub entrant: Box<Account<'info, Entrant>>,
    #[account(mut, seeds = [STRATEGY_SEED, round.key().as_ref(), owner.key().as_ref()], bump = strategy.load()?.bump, constraint = strategy.load()?.owner == owner.key() @ BlackboxError::OwnerMismatch)]
    pub strategy: AccountLoader<'info, Strategy>,
    #[account(mut, seeds = [POSITION_SEED, round.key().as_ref(), owner.key().as_ref()], bump = position.load()?.bump, constraint = position.load()?.owner == owner.key() @ BlackboxError::OwnerMismatch)]
    pub position: AccountLoader<'info, Position>,
    /// CHECK: permission PDA for the strategy
    #[account(mut, seeds = [PERMISSION_SEED, strategy.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub strategy_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA for the position
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
}

/// Make Strategy and Position readable only by the owner. Must run before
/// any bytecode is uploaded.
pub fn privatize_entrant(ctx: Context<PrivatizeEntrant>) -> Result<()> {
    let round_key = ctx.accounts.round.key();
    let owner = ctx.accounts.owner.key();
    let members = vec![privacy::read_member(owner)];

    let sbump = [ctx.accounts.strategy.load()?.bump];
    let sseeds: &[&[u8]] = &[STRATEGY_SEED, round_key.as_ref(), owner.as_ref(), &sbump];
    let sinfo = ctx.accounts.strategy.to_account_info();
    privacy::create_permission(
        &PermissionAccounts {
            sponsor: &sinfo,
            target: &sinfo,
            permission: &ctx.accounts.strategy_permission.to_account_info(),
            ephemeral_vault: &ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: &ctx.accounts.magic_program.to_account_info(),
            permission_program: &ctx.accounts.permission_program.to_account_info(),
        },
        true,
        members.clone(),
        &[sseeds],
    )?;

    let pbump = [ctx.accounts.position.load()?.bump];
    let pseeds: &[&[u8]] = &[POSITION_SEED, round_key.as_ref(), owner.as_ref(), &pbump];
    let pinfo = ctx.accounts.position.to_account_info();
    privacy::create_permission(
        &PermissionAccounts {
            sponsor: &pinfo,
            target: &pinfo,
            permission: &ctx.accounts.position_permission.to_account_info(),
            ephemeral_vault: &ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: &ctx.accounts.magic_program.to_account_info(),
            permission_program: &ctx.accounts.permission_program.to_account_info(),
        },
        true,
        members,
        &[pseeds],
    )?;

    ctx.accounts.entrant.privatized = true;
    Ok(())
}

// ------------------------------------------------------------ set_strategy (ER)

#[derive(Accounts)]
pub struct SetStrategy<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [ENTRANT_SEED, round.key().as_ref(), owner.key().as_ref()], bump = entrant.bump, has_one = owner)]
    pub entrant: Box<Account<'info, Entrant>>,
    #[account(mut, seeds = [STRATEGY_SEED, round.key().as_ref(), owner.key().as_ref()], bump = strategy.load()?.bump, constraint = strategy.load()?.owner == owner.key() @ BlackboxError::OwnerMismatch)]
    pub strategy: AccountLoader<'info, Strategy>,
}

/// Upload or hot-swap the strategy bytecode. Only accepted on a privatized
/// entrant, and only while the round is Open or Live. The bytes ride in the
/// tx message, which the private permission hides from non-members.
pub fn set_strategy(ctx: Context<SetStrategy>, bytecode: Vec<u8>) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(matches!(r.status, RoundStatus::Open | RoundStatus::Live), BlackboxError::BadRoundStatus);
    require!(ctx.accounts.entrant.privatized, BlackboxError::Unauthorized);
    require!(bytecode.len() <= MAX_BYTECODE, BlackboxError::BytecodeTooLong);
    bxvm::validate(&bytecode, r.n_markets).map_err(|e| {
        msg!("bytecode invalid: {:?}", e);
        error!(BlackboxError::BadBytecode)
    })?;
    let tick = r.tick;
    let mut s = ctx.accounts.strategy.load_mut()?;
    s.bytecode = [0u8; MAX_BYTECODE];
    s.bytecode[..bytecode.len()].copy_from_slice(&bytecode);
    s.len = bytecode.len() as u16;
    s.version = s.version.saturating_add(1);
    s.updated_tick = tick;
    ctx.accounts.entrant.strategy_version = s.version;
    Ok(())
}
