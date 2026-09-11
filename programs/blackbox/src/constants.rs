use anchor_lang::prelude::*;

// PDA seeds
pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUND_SEED: &[u8] = b"round";
pub const MARKET_SEED: &[u8] = b"mkt";
pub const ENTRANT_SEED: &[u8] = b"ent";
pub const STRATEGY_SEED: &[u8] = b"strat";
pub const POSITION_SEED: &[u8] = b"pos";
pub const LICENSE_SEED: &[u8] = b"lic";
pub const SCOREBOARD_SEED: &[u8] = b"board";
pub const HALL_SEED: &[u8] = b"hall";

// Capacity limits (fixed so account layouts never change)
pub const MAX_MARKETS: usize = 8;
pub const MAX_ENTRANTS: usize = 64;
pub const BATCH_SIZE: usize = 8;
pub const RING_LEN: usize = 64;
pub const MEM_SLOTS: usize = 16;
pub const MAX_BYTECODE: usize = 4096;
pub const MAX_LICENSES_PER_AUTHOR: usize = 8;

/// USDC has 6 decimals, which equals the VM's fixed-point scale.
pub const USDC_SCALE: i64 = 1_000_000;
pub const BPS: i64 = 10_000;

// External programs
pub const ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
pub const EPHEMERAL_SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
pub const DELEGATION_PROGRAM_ID: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// Private accounts must never be committed on a timer: only explicit,
/// scrub-then-commit paths may write them to L1.
pub const NEVER_AUTO_COMMIT_MS: u32 = u32::MAX;

/// Oracle staleness bound for marks used by the tick (seconds).
pub const MAX_ORACLE_AGE_SECS: i64 = 5;

/// Ephemeral SPL instruction discriminators used via raw CPI.
pub const ESPL_INIT_EPHEMERAL_ATA: u8 = 0;
pub const ESPL_DELEGATE_EPHEMERAL_ATA: u8 = 4;
pub const ESPL_UNDELEGATE_EPHEMERAL_ATA: u8 = 5;
