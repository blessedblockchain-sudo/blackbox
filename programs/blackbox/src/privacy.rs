//! Ephemeral permission helpers. The delegated PDA is always the payer and the
//! authority of its own permission, so only this program can change who may
//! read an account.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::{
    instructions::{
        CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
    },
    structs::{EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
};

pub struct PermissionAccounts<'a, 'info> {
    /// The delegated PDA that pays rent and signs (via seeds).
    pub sponsor: &'a AccountInfo<'info>,
    /// The account being gated (may equal `sponsor`).
    pub target: &'a AccountInfo<'info>,
    pub permission: &'a AccountInfo<'info>,
    pub ephemeral_vault: &'a AccountInfo<'info>,
    pub magic_program: &'a AccountInfo<'info>,
    pub permission_program: &'a AccountInfo<'info>,
}

pub fn read_member(pubkey: Pubkey) -> Member {
    Member {
        flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
        pubkey,
    }
}

/// Create the permission for `target` with the given members. `is_private`
/// with an empty member list means program-only (nobody can read).
/// Idempotent: returns Ok if the permission already has data.
pub fn create_permission(
    a: &PermissionAccounts,
    is_private: bool,
    members: Vec<Member>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if !a.permission.data_is_empty() {
        msg!("permission exists");
        return Ok(());
    }
    CreateEphemeralPermissionCpi {
        payer: a.sponsor.clone(),
        permissioned_account: a.target.clone(),
        permission: a.permission.clone(),
        vault: a.ephemeral_vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        args: EphemeralMembersArgs { is_private, members },
    }
    .invoke_signed(signer_seeds)?;
    Ok(())
}

/// Rebuild the full member list of an existing permission.
pub fn update_permission(
    a: &PermissionAccounts,
    is_private: bool,
    members: Vec<Member>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    UpdateEphemeralPermissionCpi {
        payer: a.sponsor.clone(),
        permissioned_account: a.target.clone(),
        permission: a.permission.clone(),
        vault: a.ephemeral_vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        authority: a.target.clone(),
        authority_is_signer: false,
        args: EphemeralMembersArgs { is_private, members },
    }
    .invoke_signed(signer_seeds)?;
    Ok(())
}

/// Close the permission (rent back to the sponsor). Idempotent.
pub fn close_permission(a: &PermissionAccounts, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    if a.permission.data_is_empty() {
        return Ok(());
    }
    CloseEphemeralPermissionCpi {
        payer: a.sponsor.clone(),
        permissioned_account: a.target.clone(),
        permission: a.permission.clone(),
        vault: a.ephemeral_vault.clone(),
        magic_program: a.magic_program.clone(),
        permission_program: a.permission_program.clone(),
        authority: a.target.clone(),
        authority_is_signer: false,
    }
    .invoke_signed(signer_seeds)?;
    Ok(())
}

/// Zero an account's body (everything after the 8-byte discriminator).
/// Used before any commit/undelegation of a private account.
pub fn scrub(info: &AccountInfo) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    if data.len() > 8 {
        for b in data[8..].iter_mut() {
            *b = 0;
        }
    }
    Ok(())
}
