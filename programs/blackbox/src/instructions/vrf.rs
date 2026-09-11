//! Round randomness from MagicBlock VRF (delegated queue, inside the ER):
//! seeds the `RAND` opcode and picks the mystery market.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self as vrf_sdk,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

use crate::constants::*;
use crate::errors::BlackboxError;
use crate::state::*;

#[vrf]
#[derive(Accounts)]
pub struct RequestRoundSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: one of the known oracle queues
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_TEST_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_TEST_QUEUE
            @ BlackboxError::VrfNotReady
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

pub fn request_round_seed(ctx: Context<RequestRoundSeed>, client_seed: u8) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Live, BlackboxError::NotLive);
    require!(!ctx.accounts.round.vrf_ready, BlackboxError::AlreadyFinalized);
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::RoundSeedCallback::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: ctx.accounts.round.key(),
            is_signer: false,
            is_writable: true,
        }]),
        callback_args: Some(vec![client_seed]),
        ..Default::default()
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

#[vrf_callback]
#[derive(Accounts)]
pub struct RoundSeedCallback<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

pub fn round_seed_callback(ctx: Context<RoundSeedCallback>, randomness: [u8; 32], client_seed: u8) -> Result<()> {
    let r = &mut ctx.accounts.round;
    if r.vrf_ready {
        return Ok(());
    }
    r.vrf_seed = randomness;
    r.vrf_ready = true;
    if r.n_markets > 0 {
        r.mystery_market = randomness[0] % r.n_markets;
    }
    msg!("round seed set (client_seed={}), mystery market {}", client_seed, r.mystery_market);
    Ok(())
}
