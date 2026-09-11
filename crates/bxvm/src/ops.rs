//! Opcode set, encoding, and static validation.
//!
//! Encoding: one opcode byte followed by fixed-size little-endian operands.
//! The first byte of a strategy blob is the format version ([`crate::BYTECODE_VERSION`]);
//! instructions start at offset 1.

use crate::BYTECODE_VERSION;

/// Maximum bytecode length accepted on-chain (including the version byte).
pub const MAX_BYTECODE_LEN: usize = 4096;
/// Operand stack depth.
pub const STACK_DEPTH: usize = 64;
/// Persistent memory slots per strategy (stored in the private Position account).
pub const MEM_SLOTS: usize = 16;
/// Maximum markets per round addressable by a strategy.
pub const MAX_MARKETS: usize = 8;
/// EMA windows selectable by the `Ema` opcode's `k` operand.
pub const EMA_WINDOWS: [u16; 3] = [8, 21, 55];
/// Maximum lookback for the `Ret` opcode (ring buffer length on-chain).
pub const MAX_RET_LOOKBACK: u8 = 64;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Nop = 0,
    Halt = 1,
    /// Push an i64 immediate (8 bytes).
    Push = 2,
    Dup = 3,
    Swap = 4,
    Pop = 5,
    Add = 6,
    Sub = 7,
    Mul = 8,
    Div = 9,
    Neg = 10,
    Abs = 11,
    Min = 12,
    Max = 13,
    Lt = 14,
    Gt = 15,
    Eq = 16,
    And = 17,
    Or = 18,
    Not = 19,
    /// Unconditional jump to absolute offset (u16).
    Jmp = 20,
    /// Jump if top == 0 (pops).
    Jz = 21,
    /// Jump if top != 0 (pops).
    Jnz = 22,
    /// Push mark price of market m (u8).
    Price = 23,
    /// Push EMA of market m (u8) with window index k (u8, 0..3).
    Ema = 24,
    /// Push return of market m (u8) over n ticks (u8, 1..=64), as a scaled fraction.
    Ret = 25,
    /// Push realized volatility of market m (u8).
    Vol = 26,
    /// Push signed position notional of market m (u8).
    Pos = 27,
    /// Push entry price of market m (u8), 0 if flat.
    Entry = 28,
    Equity = 29,
    FreeMargin = 30,
    Tick = 31,
    /// Push a per-tick pseudo-random value in [0, SCALE).
    Rand = 32,
    /// Load memory slot i (u8).
    Mld = 33,
    /// Store top into memory slot i (u8) (pops).
    Mst = 34,
    /// Target a long on market m (u8) of bps (u16) of buying power
    /// (10_000 = equity x the market's max leverage).
    Long = 35,
    /// Target a short on market m (u8), same sizing as `Long`.
    Short = 36,
    /// Close market m (u8).
    Close = 37,
    CloseAll = 38,
    Le = 39,
    Ge = 40,
    Mod = 41,
}

impl Op {
    pub const MAX: u8 = Op::Mod as u8;

    pub fn from_u8(b: u8) -> Option<Op> {
        if b > Self::MAX {
            return None;
        }
        // SAFETY-free conversion: the enum is dense from 0..=MAX.
        Some(match b {
            0 => Op::Nop,
            1 => Op::Halt,
            2 => Op::Push,
            3 => Op::Dup,
            4 => Op::Swap,
            5 => Op::Pop,
            6 => Op::Add,
            7 => Op::Sub,
            8 => Op::Mul,
            9 => Op::Div,
            10 => Op::Neg,
            11 => Op::Abs,
            12 => Op::Min,
            13 => Op::Max,
            14 => Op::Lt,
            15 => Op::Gt,
            16 => Op::Eq,
            17 => Op::And,
            18 => Op::Or,
            19 => Op::Not,
            20 => Op::Jmp,
            21 => Op::Jz,
            22 => Op::Jnz,
            23 => Op::Price,
            24 => Op::Ema,
            25 => Op::Ret,
            26 => Op::Vol,
            27 => Op::Pos,
            28 => Op::Entry,
            29 => Op::Equity,
            30 => Op::FreeMargin,
            31 => Op::Tick,
            32 => Op::Rand,
            33 => Op::Mld,
            34 => Op::Mst,
            35 => Op::Long,
            36 => Op::Short,
            37 => Op::Close,
            38 => Op::CloseAll,
            39 => Op::Le,
            40 => Op::Ge,
            41 => Op::Mod,
            _ => return None,
        })
    }

    /// Number of operand bytes following the opcode byte.
    pub const fn operand_len(self) -> usize {
        match self {
            Op::Push => 8,
            Op::Jmp | Op::Jz | Op::Jnz => 2,
            Op::Price | Op::Vol | Op::Pos | Op::Entry | Op::Close | Op::Mld | Op::Mst => 1,
            Op::Ema | Op::Ret => 2,
            Op::Long | Op::Short => 3,
            _ => 0,
        }
    }

    /// Total encoded length of an instruction with this opcode.
    pub const fn len(self) -> usize {
        1 + self.operand_len()
    }
}

/// Static validation error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationError {
    Empty,
    TooLong,
    BadVersion(u8),
    BadOpcode { at: usize, byte: u8 },
    Truncated { at: usize },
    BadJumpTarget { at: usize, target: u16 },
    BadMarket { at: usize, market: u8 },
    BadEmaWindow { at: usize, k: u8 },
    BadLookback { at: usize, n: u8 },
    BadMemSlot { at: usize, slot: u8 },
    BadSizeBps { at: usize, bps: u16 },
}

/// Validate a strategy blob (version byte + instructions).
///
/// Checks: version, length, every opcode known and fully present, jump
/// targets land on instruction boundaries, market/window/lookback/slot/size
/// operands in range. `n_markets` is the number of markets in the round.
pub fn validate(bytes: &[u8], n_markets: u8) -> Result<(), ValidationError> {
    if bytes.is_empty() {
        return Err(ValidationError::Empty);
    }
    if bytes.len() > MAX_BYTECODE_LEN {
        return Err(ValidationError::TooLong);
    }
    if bytes[0] != BYTECODE_VERSION {
        return Err(ValidationError::BadVersion(bytes[0]));
    }
    let code = &bytes[1..];
    // Pass 1: walk instructions, record boundaries in a bitmap.
    let mut boundaries = [0u64; (MAX_BYTECODE_LEN + 63) / 64];
    let mut pc = 0usize;
    while pc < code.len() {
        let op = Op::from_u8(code[pc]).ok_or(ValidationError::BadOpcode { at: pc, byte: code[pc] })?;
        if pc + op.len() > code.len() {
            return Err(ValidationError::Truncated { at: pc });
        }
        boundaries[pc / 64] |= 1u64 << (pc % 64);
        let o = &code[pc + 1..pc + op.len()];
        match op {
            Op::Price | Op::Vol | Op::Pos | Op::Entry | Op::Close => {
                if o[0] >= n_markets || (o[0] as usize) >= MAX_MARKETS {
                    return Err(ValidationError::BadMarket { at: pc, market: o[0] });
                }
            }
            Op::Ema => {
                if o[0] >= n_markets || (o[0] as usize) >= MAX_MARKETS {
                    return Err(ValidationError::BadMarket { at: pc, market: o[0] });
                }
                if (o[1] as usize) >= EMA_WINDOWS.len() {
                    return Err(ValidationError::BadEmaWindow { at: pc, k: o[1] });
                }
            }
            Op::Ret => {
                if o[0] >= n_markets || (o[0] as usize) >= MAX_MARKETS {
                    return Err(ValidationError::BadMarket { at: pc, market: o[0] });
                }
                if o[1] == 0 || o[1] > MAX_RET_LOOKBACK {
                    return Err(ValidationError::BadLookback { at: pc, n: o[1] });
                }
            }
            Op::Mld | Op::Mst => {
                if (o[0] as usize) >= MEM_SLOTS {
                    return Err(ValidationError::BadMemSlot { at: pc, slot: o[0] });
                }
            }
            Op::Long | Op::Short => {
                if o[0] >= n_markets || (o[0] as usize) >= MAX_MARKETS {
                    return Err(ValidationError::BadMarket { at: pc, market: o[0] });
                }
                let bps = u16::from_le_bytes([o[1], o[2]]);
                if bps == 0 || bps > 10_000 {
                    return Err(ValidationError::BadSizeBps { at: pc, bps });
                }
            }
            _ => {}
        }
        pc += op.len();
    }
    // Pass 2: jump targets must be boundaries (or exactly code.len(), meaning "end").
    pc = 0;
    while pc < code.len() {
        let op = Op::from_u8(code[pc]).expect("validated in pass 1");
        if matches!(op, Op::Jmp | Op::Jz | Op::Jnz) {
            let t = u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize;
            let ok = t == code.len() || (t < code.len() && boundaries[t / 64] & (1u64 << (t % 64)) != 0);
            if !ok {
                return Err(ValidationError::BadJumpTarget { at: pc, target: t as u16 });
            }
        }
        pc += op.len();
    }
    Ok(())
}
