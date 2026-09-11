//! Ephemeral SPL custody helpers (raw CPIs into the Ephemeral SPL Token
//! program), verified on devnet-tee by the Phase 0 spike.
//!
//! Custody model: a program PDA (Round vault, Entrant, License) owns a normal
//! ATA on L1. Initializing and delegating the PDA's *ephemeral* ATA makes the
//! TEE expose an SPL token account at the ATA address, which the program moves
//! with PDA-signed SPL `transfer`s on the ER.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

use crate::constants::*;

pub fn ephemeral_ata_pda(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), mint.as_ref()], &EPHEMERAL_SPL_TOKEN_PROGRAM_ID).0
}

pub fn eata_buffer_pda(delegated: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"buffer", delegated.as_ref()], &EPHEMERAL_SPL_TOKEN_PROGRAM_ID).0
}

pub fn delegation_record_pda(delegated: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"delegation", delegated.as_ref()], &DELEGATION_PROGRAM_ID).0
}

pub fn delegation_metadata_pda(delegated: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"delegation-metadata", delegated.as_ref()], &DELEGATION_PROGRAM_ID).0
}

pub struct EataAccounts<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub eata: &'a AccountInfo<'info>,
    pub buffer: &'a AccountInfo<'info>,
    pub record: &'a AccountInfo<'info>,
    pub metadata: &'a AccountInfo<'info>,
    pub delegation_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Initialize (if needed) and delegate a PDA's ephemeral ATA to `validator`.
pub fn init_and_delegate_eata(a: &EataAccounts, validator: Option<Pubkey>) -> Result<()> {
    if a.eata.data_is_empty() {
        let ix = Instruction {
            program_id: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(a.eata.key(), false),
                AccountMeta::new(a.payer.key(), true),
                AccountMeta::new_readonly(a.owner.key(), false),
                AccountMeta::new_readonly(a.mint.key(), false),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ],
            data: vec![ESPL_INIT_EPHEMERAL_ATA],
        };
        invoke(
            &ix,
            &[
                a.eata.clone(),
                a.payer.clone(),
                a.owner.clone(),
                a.mint.clone(),
                a.system_program.clone(),
                a.program.clone(),
            ],
        )?;
    }
    if *a.eata.owner == DELEGATION_PROGRAM_ID {
        msg!("eata already delegated");
        return Ok(());
    }
    let mut data = vec![ESPL_DELEGATE_EPHEMERAL_ATA];
    if let Some(v) = validator {
        data.extend_from_slice(v.as_ref());
    }
    let ix = Instruction {
        program_id: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(a.payer.key(), true),
            AccountMeta::new(a.eata.key(), false),
            AccountMeta::new_readonly(EPHEMERAL_SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new(a.buffer.key(), false),
            AccountMeta::new(a.record.key(), false),
            AccountMeta::new(a.metadata.key(), false),
            AccountMeta::new_readonly(a.delegation_program.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
        ],
        data,
    };
    invoke(
        &ix,
        &[
            a.payer.clone(),
            a.eata.clone(),
            a.program.clone(),
            a.buffer.clone(),
            a.record.clone(),
            a.metadata.clone(),
            a.delegation_program.clone(),
            a.system_program.clone(),
        ],
    )?;
    Ok(())
}
