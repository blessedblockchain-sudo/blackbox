//! Mock price feeds for local development. The accounts use the exact Pyth
//! Lazer byte layout, but are owned by this program. Only a build with the
//! `local-oracle` feature accepts them as market feeds, so these instructions
//! are inert on devnet/mainnet.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::oracle;

pub const MOCK_FEED_SEED: &[u8] = b"mockfeed";

#[derive(Accounts)]
#[instruction(feed_id: u32)]
pub struct InitMockFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: raw PDA created here with the Pyth Lazer layout
    #[account(mut, seeds = [MOCK_FEED_SEED, authority.key().as_ref(), &feed_id.to_le_bytes()], bump)]
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_mock_feed(ctx: Context<InitMockFeed>, feed_id: u32, raw_price: i64, decimals: u8) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let id = feed_id.to_le_bytes();
    let bump = [ctx.bumps.feed];
    let seeds: &[&[u8]] = &[MOCK_FEED_SEED, authority.as_ref(), &id, &bump];
    if ctx.accounts.feed.data_is_empty() {
        let lamports = Rent::get()?.minimum_balance(oracle::PRICE_ACCOUNT_LEN);
        create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                CreateAccount { from: ctx.accounts.authority.to_account_info(), to: ctx.accounts.feed.to_account_info() },
                &[seeds],
            ),
            lamports,
            oracle::PRICE_ACCOUNT_LEN as u64,
            &crate::ID,
        )?;
    }
    let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
    // authority in the write_authority slot (bytes 8..40) so updates can be checked
    d[8..40].copy_from_slice(authority.as_ref());
    oracle::write_mock(&mut d, feed_id, raw_price, decimals, Clock::get()?.unix_timestamp)
}

#[derive(Accounts)]
pub struct SetMockFeed<'info> {
    pub authority: Signer<'info>,
    /// CHECK: mock feed owned by this program; authority checked from its data
    #[account(mut, owner = crate::ID)]
    pub feed: UncheckedAccount<'info>,
}

pub fn set_mock_feed(ctx: Context<SetMockFeed>, raw_price: i64, decimals: u8) -> Result<()> {
    let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
    require!(d.len() >= oracle::PRICE_ACCOUNT_LEN, BlackboxError::BadOracle);
    require!(d[8..40] == ctx.accounts.authority.key().to_bytes(), BlackboxError::Unauthorized);
    let feed_id = u32::from_le_bytes(d[oracle::OFF_FEED_ID..oracle::OFF_FEED_ID + 4].try_into().unwrap());
    oracle::write_mock(&mut d, feed_id, raw_price, decimals, Clock::get()?.unix_timestamp)
}

#[delegate]
#[derive(Accounts)]
#[instruction(feed_id: u32)]
pub struct DelegateMockFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: mock feed PDA
    #[account(mut, del, seeds = [MOCK_FEED_SEED, authority.key().as_ref(), &feed_id.to_le_bytes()], bump)]
    pub feed: UncheckedAccount<'info>,
    /// CHECK: validator identity
    pub validator: UncheckedAccount<'info>,
}

pub fn delegate_mock_feed(ctx: Context<DelegateMockFeed>, feed_id: u32) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    ctx.accounts.delegate_feed(
        &ctx.accounts.authority,
        &[MOCK_FEED_SEED, authority.as_ref(), &feed_id.to_le_bytes()],
        DelegateConfig { commit_frequency_ms: NEVER_AUTO_COMMIT_MS, validator: Some(ctx.accounts.validator.key()) },
    )?;
    Ok(())
}
