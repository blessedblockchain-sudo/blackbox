//! Round chat: a public, ER-only ring buffer for spectators, entrants and agents.
//!
//! The chat is an ephemeral account: created on the ER, never on L1, and
//! sponsored by the delegated Round PDA. `create_ephemeral_chat` debits the
//! Round once; `close_ephemeral_chat` refunds it before the round is committed.
//!
//! Layout (CHAT_SIZE bytes): head u32 | count u32 | CHAT_SLOTS x
//! [author 32 | tick u64 | unix ts i64 | len u8 | text 79].

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral_accounts;

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::state::*;

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct PostChat<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    /// Sponsor of the chat account (debited once, refunded by close_chat).
    #[account(mut, sponsor, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: ephemeral chat PDA sponsored by the round
    #[account(mut, eph, seeds = [CHAT_SEED, round.key().as_ref()], bump)]
    pub chat: UncheckedAccount<'info>,
}

pub fn post_chat(ctx: Context<PostChat>, text: String) -> Result<()> {
    let tick = ctx.accounts.round.tick;
    require!(matches!(ctx.accounts.round.status, RoundStatus::Open | RoundStatus::Live), BlackboxError::BadRoundStatus);
    let bytes = text.as_bytes();
    require!(!bytes.is_empty() && bytes.len() <= CHAT_TEXT_MAX, BlackboxError::BadChat);
    require!(bytes.iter().all(|b| *b >= 0x20 && *b != 0x7f), BlackboxError::BadChat);
    if ctx.accounts.chat.data_is_empty() {
        ctx.accounts.create_ephemeral_chat(CHAT_SIZE as u32)?;
    }
    let author = ctx.accounts.author.key();
    let now = Clock::get()?.unix_timestamp;
    let mut d = ctx.accounts.chat.try_borrow_mut_data()?;
    require!(d.len() >= CHAT_SIZE, BlackboxError::BadChat);
    let head = u32::from_le_bytes([d[0], d[1], d[2], d[3]]) as usize % CHAT_SLOTS;
    let count = u32::from_le_bytes([d[4], d[5], d[6], d[7]]);
    let off = CHAT_HEADER + head * CHAT_SLOT_SIZE;
    let slot = &mut d[off..off + CHAT_SLOT_SIZE];
    slot.fill(0);
    slot[0..32].copy_from_slice(author.as_ref());
    slot[32..40].copy_from_slice(&tick.to_le_bytes());
    slot[40..48].copy_from_slice(&now.to_le_bytes());
    slot[48] = bytes.len() as u8;
    slot[49..49 + bytes.len()].copy_from_slice(bytes);
    d[0..4].copy_from_slice(&(((head + 1) % CHAT_SLOTS) as u32).to_le_bytes());
    d[4..8].copy_from_slice(&count.saturating_add(1).to_le_bytes());
    Ok(())
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CloseChat<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, sponsor, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump, has_one = admin)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: ephemeral chat PDA sponsored by the round
    #[account(mut, eph, seeds = [CHAT_SEED, round.key().as_ref()], bump)]
    pub chat: UncheckedAccount<'info>,
}

/// Refund the chat's rent to the Round once trading is over, before close_round commits it.
pub fn close_chat(ctx: Context<CloseChat>) -> Result<()> {
    require!(!ctx.accounts.round.live && ctx.accounts.round.status != RoundStatus::Open, BlackboxError::RoundNotEnded);
    if ctx.accounts.chat.data_is_empty() {
        return Ok(());
    }
    ctx.accounts.close_ephemeral_chat()?;
    Ok(())
}
