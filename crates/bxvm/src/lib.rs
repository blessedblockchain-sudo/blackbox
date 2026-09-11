//! BLACKBOX strategy VM.
//!
//! A tiny deterministic stack machine that the BLACKBOX program executes on
//! every crank tick inside a MagicBlock Private Ephemeral Rollup. Strategies
//! are bytecode stored in private accounts: the program can run them, nobody
//! else can read them.
//!
//! Design rules:
//! - `no_std`, no allocation: fixed-size stack, fixed-size action list.
//! - Every value is an `i64` in fixed point with 6 decimals (`SCALE`).
//! - Every fault halts the program and discards its actions (a broken
//!   strategy never trades). Faults are reported so the owner can debug.
//! - A hard step limit bounds compute per tick.
//! - The host (the on-chain program, the simulator, the fuzzer) supplies
//!   market data and position state through the [`Host`] trait.
#![cfg_attr(not(feature = "std"), no_std)]
#![deny(unsafe_code)]

pub mod asm;
pub mod exec;
pub mod ops;

pub use asm::{assemble, disassemble, Instr};
pub use exec::{execute, Action, ExecResult, Fault, Host, ACTIONS_PER_TICK};
pub use ops::{validate, Op, MAX_BYTECODE_LEN, MAX_MARKETS, MEM_SLOTS, STACK_DEPTH};

/// Bytecode format version (first byte of every strategy blob).
pub const BYTECODE_VERSION: u8 = 1;

/// Fixed-point scale: 1.0 == 1_000_000.
pub const SCALE: i64 = 1_000_000;

/// Default maximum number of VM steps per tick.
pub const DEFAULT_STEP_LIMIT: u32 = 512;

/// Basis points denominator for position sizing operands.
pub const BPS: i64 = 10_000;
