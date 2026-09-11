//! BLACKBOX Phase 0 integration spike.
//!
//! One throwaway program that exercises every MagicBlock primitive the real
//! BLACKBOX program depends on, so each integration bet can be verified on
//! local `mb-stack` and on `devnet-tee` before the real build starts:
//!
//! 1. delegate a PDA to the TEE validator with `commit_frequency_ms = u32::MAX`
//! 2. create an ephemeral permission on the ER and make the PDA private
//! 3. write a secret into the private PDA via an ER tx (TX_MESSAGE privacy)
//! 4. schedule a Native Crank tick that reads a Pyth Lazer oracle account
//!    (or a mock feed on localnet) and mutates the private PDA
//! 5. PDA custody of Ephemeral SPL tokens + PDA-signed `token::transfer` on ER
//! 6. an ephemeral (ER-only) account sponsored by the PDA, with its own permission
//! 7. VRF request + callback inside the ER
//! 8. commit + undelegate
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::InstructionData;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral, ephemeral_accounts},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    anchor::{vrf, vrf_callback},
    vrf::{
        self as vrf_sdk,
        instructions::{create_request_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};

declare_id!("94gGoaBYDU4B9dmxEoJFVST8gszK5YbUqoh7HCxUAbhp");

pub const VAULT_SEED: &[u8] = b"vault";
pub const NOTE_SEED: &[u8] = b"note";
pub const MOCK_SEED: &[u8] = b"mock";

pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
pub const EPHEMERAL_SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const INIT_EPHEMERAL_ATA_DISCRIMINATOR: u8 = 0;
const DELEGATE_EPHEMERAL_ATA_DISCRIMINATOR: u8 = 4;

/// Never let the delegation program commit this account on a timer: private
/// state must only reach L1 after the program has scrubbed it.
pub const NEVER_AUTO_COMMIT_MS: u32 = u32::MAX;

#[ephemeral]
#[program]
pub mod spike {
    use super::*;

    // ------------------------------------------------------------------ L1

    /// Create the vault PDA and pre-fund it with rent for two ephemeral
    /// permissions (its own + the note's) plus lamports to sponsor ephemeral
    /// accounts on the ER.
    pub fn initialize(ctx: Context<Initialize>, sponsor_lamports: u64) -> Result<()> {
        let permission_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(2) as u32,
        );
        let total = permission_rent
            .checked_mul(2)
            .and_then(|v| v.checked_add(sponsor_lamports))
            .ok_or(SpikeError::MathOverflow)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            total,
        )?;
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.bump = ctx.bumps.vault;
        vault.count = 0;
        vault.last_price = 0;
        vault.last_expo = 0;
        vault.last_publish_time = 0;
        vault.last_source = 0;
        vault.secret = [0u8; 32];
        vault.randomness = [0u8; 32];
        vault.rnd_count = 0;
        Ok(())
    }

    /// Create a mock price feed PDA (used on localnet where no oracle pushes).
    pub fn init_mock(ctx: Context<InitMock>, price: i64, expo: i32) -> Result<()> {
        let mock = &mut ctx.accounts.mock;
        mock.authority = ctx.accounts.authority.key();
        mock.price = price;
        mock.expo = expo;
        mock.publish_time = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Delegate the vault to the (TEE) ER. Explicit `commit_frequency_ms = u32::MAX`.
    pub fn delegate(ctx: Context<DelegateVault>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_vault(
            &ctx.accounts.authority,
            &[VAULT_SEED, ctx.accounts.authority.key().as_ref()],
            DelegateConfig {
                commit_frequency_ms: NEVER_AUTO_COMMIT_MS,
                validator,
            },
        )?;
        Ok(())
    }

    /// Delegate the mock feed so it can be updated on the ER (localnet only).
    pub fn delegate_mock(ctx: Context<DelegateMock>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_mock(
            &ctx.accounts.authority,
            &[MOCK_SEED, ctx.accounts.authority.key().as_ref()],
            DelegateConfig {
                commit_frequency_ms: NEVER_AUTO_COMMIT_MS,
                validator,
            },
        )?;
        Ok(())
    }

    /// Create the vault's ATA on L1, then init + delegate the vault's ephemeral
    /// ATA so that the ATA address is usable as an SPL token account on the ER.
    pub fn init_vault_token(ctx: Context<InitVaultToken>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        init_ephemeral_ata(
            &ctx.accounts.ephemeral_token_program,
            &ctx.accounts.vault_eata,
            ctx.accounts.vault.to_account_info(),
            &ctx.accounts.mint,
            &ctx.accounts.authority,
            &ctx.accounts.system_program,
        )?;
        delegate_ephemeral_ata(
            &ctx.accounts.ephemeral_token_program,
            &ctx.accounts.authority,
            &ctx.accounts.vault_eata,
            &ctx.accounts.eata_buffer,
            &ctx.accounts.eata_record,
            &ctx.accounts.eata_metadata,
            &ctx.accounts.delegation_program,
            &ctx.accounts.system_program,
            validator,
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------ ER

    /// Create the vault's ephemeral permission (starts public).
    pub fn init_permission(ctx: Context<VaultPermission>) -> Result<()> {
        if !ctx.accounts.permission.data_is_empty() {
            msg!("permission exists");
            return Ok(());
        }
        let bump = [ctx.accounts.vault.bump];
        let signers: &[&[u8]] = &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &bump];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.vault.to_account_info(),
            permissioned_account: ctx.accounts.vault.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: false,
                members: vec![],
            },
        }
        .invoke_signed(&[signers])?;
        Ok(())
    }

    /// Flip the vault private (members = [authority]) or public.
    pub fn set_privacy(ctx: Context<VaultPermission>, is_private: bool) -> Result<()> {
        let bump = [ctx.accounts.vault.bump];
        let signers: &[&[u8]] = &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &bump];
        let members = if is_private {
            vec![Member {
                flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                pubkey: ctx.accounts.vault.authority,
            }]
        } else {
            vec![]
        };
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.vault.to_account_info(),
            permissioned_account: ctx.accounts.vault.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs { is_private, members },
        }
        .invoke_signed(&[signers])?;
        Ok(())
    }

    /// Close the vault's ephemeral permission (rent back to the vault PDA).
    /// The real program does this in end_round before undelegating.
    pub fn close_permission(ctx: Context<VaultPermission>) -> Result<()> {
        if ctx.accounts.permission.data_is_empty() {
            msg!("no permission to close");
            return Ok(());
        }
        let bump = [ctx.accounts.vault.bump];
        let signers: &[&[u8]] = &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &bump];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.vault.to_account_info(),
            permissioned_account: ctx.accounts.vault.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[signers])?;
        Ok(())
    }

    /// Write a 32-byte secret into the (private) vault. The bytes travel in the
    /// tx message, which TX_MESSAGE_FLAG hides from non-members.
    pub fn write_secret(ctx: Context<AuthorityVault>, secret: [u8; 32]) -> Result<()> {
        ctx.accounts.vault.secret = secret;
        Ok(())
    }

    /// Update the mock feed (localnet). Runs on whichever layer owns the account.
    pub fn set_mock_price(ctx: Context<SetMockPrice>, price: i64, expo: i32) -> Result<()> {
        let mock = &mut ctx.accounts.mock;
        mock.price = price;
        mock.expo = expo;
        mock.publish_time = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Crank-executed tick: read the price feed and mutate the private vault.
    /// Uses raw account data (crank pattern: no Anchor re-serialization).
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let vault_info = ctx.accounts.vault.to_account_info();
        let mut vault = {
            let data = vault_info.try_borrow_data()?;
            Vault::try_deserialize(&mut &data[..])?
        };
        let (price, expo, publish_time, source) = read_feed(&ctx.accounts.price_update)?;
        vault.count = vault.count.saturating_add(1);
        vault.last_price = price;
        vault.last_expo = expo;
        vault.last_publish_time = publish_time;
        vault.last_source = source;
        {
            let mut data = vault_info.try_borrow_mut_data()?;
            vault.try_serialize(&mut &mut data[..])?;
        }
        msg!("tick {} price {}e{} src {}", vault.count, price, expo, source);
        Ok(())
    }

    /// Schedule `tick` on the Native Crank.
    ///
    /// Built by hand (same wire format as `ScheduleCrankCpi`): the SDK helper
    /// requires `&'info AccountInfo<'info>` references, which Anchor account
    /// wrappers cannot provide.
    pub fn schedule_tick(
        ctx: Context<ScheduleTick>,
        task_id: i64,
        interval_ms: i64,
        iterations: i64,
    ) -> Result<()> {
        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.price_update.key(), false),
            ],
            data: crate::instruction::Tick {}.data(),
        };
        let args = ScheduleTaskArgs {
            task_id,
            execution_interval_millis: interval_ms,
            iterations,
            instructions: vec![tick_ix],
        };
        let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(args))
            .map_err(|_| error!(SpikeError::SerializeFailed))?;
        // Account layout mirrors ScheduleCrankCpi::build_accounts: payer first,
        // then the accounts the scheduled instruction touches (payer again, per
        // the crank-counter example, then the instruction accounts).
        let schedule_ix = Instruction {
            program_id: MAGIC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.price_update.key(), false),
            ],
            data,
        };
        invoke(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.price_update.to_account_info(),
                ctx.accounts.magic_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// PDA-signed SPL transfer from the vault's ATA to a recipient, on the ER.
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        require!(amount > 0, SpikeError::InvalidAmount);
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                SplTransfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Create an ER-only ephemeral account sponsored by the vault and write into it.
    pub fn create_note(ctx: Context<CreateNote>, len: u32, first_byte: u8) -> Result<()> {
        ctx.accounts.create_ephemeral_note(len)?;
        let mut data = ctx.accounts.note.try_borrow_mut_data()?;
        if !data.is_empty() {
            data[0] = first_byte;
        }
        Ok(())
    }

    /// Give the ephemeral note its own private permission (members = [authority]).
    pub fn init_note_permission(ctx: Context<NotePermission>) -> Result<()> {
        if !ctx.accounts.permission.data_is_empty() {
            msg!("note permission exists");
            return Ok(());
        }
        let vault_bump = [ctx.accounts.vault.bump];
        let vault_signers: &[&[u8]] =
            &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &vault_bump];
        let vault_key = ctx.accounts.vault.key();
        let note_bump = [ctx.bumps.note];
        let note_signers: &[&[u8]] = &[NOTE_SEED, vault_key.as_ref(), &note_bump];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.vault.to_account_info(),
            permissioned_account: ctx.accounts.note.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: ctx.accounts.vault.authority,
                }],
            },
        }
        .invoke_signed(&[vault_signers, note_signers])?;
        Ok(())
    }

    /// Request VRF randomness (works on L1 with the base queue, on the ER with
    /// the ephemeral queue). The callback writes into the vault.
    pub fn request_random(ctx: Context<RequestRandom>, client_seed: u8) -> Result<()> {
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRandom::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.vault.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(vec![client_seed]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback: only the VRF program identity can invoke this.
    pub fn consume_random(
        ctx: Context<ConsumeRandom>,
        randomness: [u8; 32],
        client_seed: u8,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.randomness = randomness;
        vault.rnd_count = vault.rnd_count.saturating_add(1);
        msg!("vrf client_seed={} rnd_count={} first={}", client_seed, vault.rnd_count, randomness[0]);
        Ok(())
    }

    /// Close the note's permission (rent back to the sponsor vault).
    pub fn close_note_permission(ctx: Context<NotePermission>) -> Result<()> {
        if ctx.accounts.permission.data_is_empty() {
            msg!("no note permission to close");
            return Ok(());
        }
        let vault_bump = [ctx.accounts.vault.bump];
        let vault_signers: &[&[u8]] =
            &[VAULT_SEED, ctx.accounts.vault.authority.as_ref(), &vault_bump];
        let vault_key = ctx.accounts.vault.key();
        let note_bump = [ctx.bumps.note];
        let note_signers: &[&[u8]] = &[NOTE_SEED, vault_key.as_ref(), &note_bump];
        CloseEphemeralPermissionCpi {
            payer: ctx.accounts.vault.to_account_info(),
            permissioned_account: ctx.accounts.note.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.note.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[vault_signers, note_signers])?;
        Ok(())
    }

    /// Close the ephemeral note (rent back to the sponsor vault).
    pub fn close_note(ctx: Context<CreateNote>) -> Result<()> {
        if ctx.accounts.note.data_is_empty() {
            msg!("no note to close");
            return Ok(());
        }
        ctx.accounts.close_ephemeral_note()?;
        Ok(())
    }

    /// Zero the secret (what the real program does before undelegating).
    pub fn scrub(ctx: Context<AuthorityVault>) -> Result<()> {
        ctx.accounts.vault.secret = [0u8; 32];
        Ok(())
    }

    /// Manual commit (state stays delegated).
    pub fn commit(ctx: Context<CommitVault>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.vault.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit and undelegate the mock feed (re-run hygiene).
    pub fn undelegate_mock(ctx: Context<CommitMock>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.mock.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commit and undelegate the vault.
    pub fn undelegate(ctx: Context<CommitVault>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.vault.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

/// Decode a price from either a Pyth Lazer `PriceUpdateV2` account pushed by
/// the MagicBlock oracle program, or from our own `MockFeed` (localnet).
/// Returns (price, exponent, publish_time, source) with source 1 = oracle, 2 = mock.
fn read_feed(info: &AccountInfo) -> Result<(i64, i32, i64, u8)> {
    let data = info.try_borrow_data()?;
    if *info.owner == ORACLE_PROGRAM_ID {
        // PriceUpdateV2 (borsh):
        //   8  discriminator
        //   32 write_authority
        //   1|2 verification_level (enum tag; Partial carries 1 extra byte)
        //   32 feed_id
        //   8  price i64
        //   8  conf u64
        //   4  exponent i32
        //   8  publish_time i64
        //   ...
        require!(data.len() >= 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8, SpikeError::BadFeed);
        let tag = data[40];
        let feed_off = if tag == 0 { 42 } else { 41 };
        let p = feed_off + 32;
        let price = i64::from_le_bytes(data[p..p + 8].try_into().unwrap());
        let expo = i32::from_le_bytes(data[p + 16..p + 20].try_into().unwrap());
        let publish_time = i64::from_le_bytes(data[p + 20..p + 28].try_into().unwrap());
        require!(price > 0, SpikeError::BadFeed);
        Ok((price, expo, publish_time, 1))
    } else if *info.owner == crate::ID {
        let mock = MockFeed::try_deserialize(&mut &data[..])?;
        Ok((mock.price, mock.expo, mock.publish_time, 2))
    } else {
        err!(SpikeError::BadFeed)
    }
}

fn init_ephemeral_ata<'info>(
    program: &UncheckedAccount<'info>,
    ephemeral_ata: &UncheckedAccount<'info>,
    owner: AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let instruction = Instruction {
        program_id: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(ephemeral_ata.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(owner.key(), false),
            AccountMeta::new_readonly(mint.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        data: vec![INIT_EPHEMERAL_ATA_DISCRIMINATOR],
    };
    invoke(
        &instruction,
        &[
            ephemeral_ata.to_account_info(),
            payer.to_account_info(),
            owner,
            mint.to_account_info(),
            system_program.to_account_info(),
            program.to_account_info(),
        ],
    )?;
    Ok(())
}

fn delegate_ephemeral_ata<'info>(
    program: &UncheckedAccount<'info>,
    payer: &Signer<'info>,
    ephemeral_ata: &UncheckedAccount<'info>,
    buffer: &UncheckedAccount<'info>,
    record: &UncheckedAccount<'info>,
    metadata: &UncheckedAccount<'info>,
    delegation_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    validator: Option<Pubkey>,
) -> Result<()> {
    let mut data = vec![DELEGATE_EPHEMERAL_ATA_DISCRIMINATOR];
    if let Some(validator) = validator {
        data.extend_from_slice(validator.as_ref());
    }
    let instruction = Instruction {
        program_id: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(payer.key(), true),
            AccountMeta::new(ephemeral_ata.key(), false),
            AccountMeta::new_readonly(EPHEMERAL_SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new(buffer.key(), false),
            AccountMeta::new(record.key(), false),
            AccountMeta::new(metadata.key(), false),
            AccountMeta::new_readonly(delegation_program.key(), false),
            AccountMeta::new_readonly(system_program.key(), false),
        ],
        data,
    };
    invoke(
        &instruction,
        &[
            payer.to_account_info(),
            ephemeral_ata.to_account_info(),
            program.to_account_info(),
            buffer.to_account_info(),
            record.to_account_info(),
            metadata.to_account_info(),
            delegation_program.to_account_info(),
            system_program.to_account_info(),
        ],
    )?;
    Ok(())
}

pub fn ephemeral_ata_pda(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), mint.as_ref()], &EPHEMERAL_SPL_TOKEN_PROGRAM_ID).0
}

pub fn eata_buffer_address(delegated_account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"buffer", delegated_account.as_ref()],
        &EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
    )
    .0
}

pub fn record_pda(delegated_account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"delegation", delegated_account.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0
}

pub fn metadata_pda(delegated_account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"delegation-metadata", delegated_account.as_ref()],
        &DELEGATION_PROGRAM_ID,
    )
    .0
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Vault::LEN,
        seeds = [VAULT_SEED, authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitMock<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MockFeed::LEN,
        seeds = [MOCK_SEED, authority.key().as_ref()],
        bump
    )]
    pub mock: Account<'info, MockFeed>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the vault PDA to delegate
    #[account(mut, del, seeds = [VAULT_SEED, authority.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validator identity, checked by the delegation program
    pub validator: Option<UncheckedAccount<'info>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateMock<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the mock feed PDA to delegate
    #[account(mut, del, seeds = [MOCK_SEED, authority.key().as_ref()], bump)]
    pub mock: UncheckedAccount<'info>,
    /// CHECK: validator identity
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct InitVaultToken<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, authority.key().as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    /// CHECK: vault's ephemeral ATA (eSPL program PDA [owner, mint])
    #[account(mut, constraint = vault_eata.key() == ephemeral_ata_pda(&vault.key(), &mint.key()) @ SpikeError::BadEata)]
    pub vault_eata: UncheckedAccount<'info>,
    /// CHECK: delegation buffer for the eATA
    #[account(mut, constraint = eata_buffer.key() == eata_buffer_address(&vault_eata.key()) @ SpikeError::BadEata)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK: delegation record for the eATA
    #[account(mut, constraint = eata_record.key() == record_pda(&vault_eata.key()) @ SpikeError::BadEata)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK: delegation metadata for the eATA
    #[account(mut, constraint = eata_metadata.key() == metadata_pda(&vault_eata.key()) @ SpikeError::BadEata)]
    pub eata_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed program id
    #[account(address = EPHEMERAL_SPL_TOKEN_PROGRAM_ID)]
    pub ephemeral_token_program: UncheckedAccount<'info>,
    /// CHECK: fixed program id
    #[account(address = DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
    /// CHECK: optional validator for the eATA delegation
    pub validator: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultPermission<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.authority.as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: permission PDA, verified by the permission program
    #[account(
        mut,
        seeds = [PERMISSION_SEED, vault.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AuthorityVault<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.authority.as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct SetMockPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [MOCK_SEED, authority.key().as_ref()], bump, has_one = authority)]
    pub mock: Account<'info, MockFeed>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    /// CHECK: raw-deserialized (crank pattern); owner checked at runtime
    #[account(mut, owner = crate::ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: oracle PriceUpdateV2 or MockFeed; validated in read_feed
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ScheduleTick<'info> {
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: passed to the scheduled ix (no Anchor re-serialization)
    #[account(mut, owner = crate::ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: passed to the scheduled ix
    pub price_update: UncheckedAccount<'info>,
    /// CHECK: this program, referenced by the scheduled ix
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, vault.authority.as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut, token::authority = vault)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(mut, constraint = recipient_ata.mint == vault_ata.mint @ SpikeError::MintMismatch)]
    pub recipient_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CreateNote<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// The sponsor PDA. NOTE: must not be named `vault`; the macro reserves the
    /// field name `vault` for MagicBlock's ephemeral vault and injects it.
    #[account(
        mut,
        sponsor,
        seeds = [VAULT_SEED, spike_vault.authority.as_ref()],
        bump = spike_vault.bump,
        has_one = authority
    )]
    pub spike_vault: Account<'info, Vault>,
    /// CHECK: ephemeral note PDA sponsored by the spike vault
    #[account(mut, eph, seeds = [NOTE_SEED, spike_vault.key().as_ref()], bump)]
    pub note: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct NotePermission<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.authority.as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: the ephemeral note
    #[account(mut, seeds = [NOTE_SEED, vault.key().as_ref()], bump)]
    pub note: UncheckedAccount<'info>,
    /// CHECK: permission PDA for the note
    #[account(
        mut,
        seeds = [PERMISSION_SEED, note.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed id
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRandom<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.authority.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: one of the known oracle queues (base/ephemeral, devnet/local)
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_TEST_QUEUE ||
            oracle_queue.key() == vrf_sdk::consts::DEFAULT_EPHEMERAL_TEST_QUEUE
            @ SpikeError::BadQueue
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRandom<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitMock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MOCK_SEED, mock.authority.as_ref()], bump)]
    pub mock: Account<'info, MockFeed>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, vault.authority.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

// ---------------------------------------------------------------- state

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub bump: u8,
    pub count: u64,
    pub last_price: i64,
    pub last_expo: i32,
    pub last_publish_time: i64,
    pub last_source: u8,
    pub secret: [u8; 32],
    pub randomness: [u8; 32],
    pub rnd_count: u64,
}

impl Vault {
    pub const LEN: usize = 32 + 1 + 8 + 8 + 4 + 8 + 1 + 32 + 32 + 8;
}

#[account]
pub struct MockFeed {
    pub authority: Pubkey,
    pub price: i64,
    pub expo: i32,
    pub publish_time: i64,
}

impl MockFeed {
    pub const LEN: usize = 32 + 8 + 4 + 8;
}

#[error_code]
pub enum SpikeError {
    #[msg("math overflow")]
    MathOverflow,
    #[msg("price feed account is neither an oracle PriceUpdateV2 nor a MockFeed")]
    BadFeed,
    #[msg("invalid amount")]
    InvalidAmount,
    #[msg("mint mismatch")]
    MintMismatch,
    #[msg("bad ephemeral ATA / delegation PDA")]
    BadEata,
    #[msg("unknown VRF oracle queue")]
    BadQueue,
    #[msg("failed to serialize crank instruction")]
    SerializeFailed,
}
