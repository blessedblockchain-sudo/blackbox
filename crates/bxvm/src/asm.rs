//! Assembler and disassembler (no allocation; write into caller buffers).

use crate::ops::Op;
use crate::BYTECODE_VERSION;

/// A decoded instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Instr {
    Nop,
    Halt,
    Push(i64),
    Dup,
    Swap,
    Pop,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Neg,
    Abs,
    Min,
    Max,
    Lt,
    Gt,
    Le,
    Ge,
    Eq,
    And,
    Or,
    Not,
    Jmp(u16),
    Jz(u16),
    Jnz(u16),
    Price(u8),
    Ema(u8, u8),
    Ret(u8, u8),
    Vol(u8),
    Pos(u8),
    Entry(u8),
    Equity,
    FreeMargin,
    Tick,
    Rand,
    Mld(u8),
    Mst(u8),
    Long(u8, u16),
    Short(u8, u16),
    Close(u8),
    CloseAll,
}

impl Instr {
    pub fn op(&self) -> Op {
        match self {
            Instr::Nop => Op::Nop,
            Instr::Halt => Op::Halt,
            Instr::Push(_) => Op::Push,
            Instr::Dup => Op::Dup,
            Instr::Swap => Op::Swap,
            Instr::Pop => Op::Pop,
            Instr::Add => Op::Add,
            Instr::Sub => Op::Sub,
            Instr::Mul => Op::Mul,
            Instr::Div => Op::Div,
            Instr::Mod => Op::Mod,
            Instr::Neg => Op::Neg,
            Instr::Abs => Op::Abs,
            Instr::Min => Op::Min,
            Instr::Max => Op::Max,
            Instr::Lt => Op::Lt,
            Instr::Gt => Op::Gt,
            Instr::Le => Op::Le,
            Instr::Ge => Op::Ge,
            Instr::Eq => Op::Eq,
            Instr::And => Op::And,
            Instr::Or => Op::Or,
            Instr::Not => Op::Not,
            Instr::Jmp(_) => Op::Jmp,
            Instr::Jz(_) => Op::Jz,
            Instr::Jnz(_) => Op::Jnz,
            Instr::Price(_) => Op::Price,
            Instr::Ema(_, _) => Op::Ema,
            Instr::Ret(_, _) => Op::Ret,
            Instr::Vol(_) => Op::Vol,
            Instr::Pos(_) => Op::Pos,
            Instr::Entry(_) => Op::Entry,
            Instr::Equity => Op::Equity,
            Instr::FreeMargin => Op::FreeMargin,
            Instr::Tick => Op::Tick,
            Instr::Rand => Op::Rand,
            Instr::Mld(_) => Op::Mld,
            Instr::Mst(_) => Op::Mst,
            Instr::Long(_, _) => Op::Long,
            Instr::Short(_, _) => Op::Short,
            Instr::Close(_) => Op::Close,
            Instr::CloseAll => Op::CloseAll,
        }
    }

    pub fn len(&self) -> usize {
        self.op().len()
    }

    /// Encode into `out`; returns bytes written.
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let n = self.len();
        if out.len() < n {
            return None;
        }
        out[0] = self.op() as u8;
        match *self {
            Instr::Push(v) => out[1..9].copy_from_slice(&v.to_le_bytes()),
            Instr::Jmp(t) | Instr::Jz(t) | Instr::Jnz(t) => out[1..3].copy_from_slice(&t.to_le_bytes()),
            Instr::Price(m) | Instr::Vol(m) | Instr::Pos(m) | Instr::Entry(m) | Instr::Close(m) => out[1] = m,
            Instr::Ema(m, k) | Instr::Ret(m, k) => {
                out[1] = m;
                out[2] = k;
            }
            Instr::Mld(i) | Instr::Mst(i) => out[1] = i,
            Instr::Long(m, bps) | Instr::Short(m, bps) => {
                out[1] = m;
                out[2..4].copy_from_slice(&bps.to_le_bytes());
            }
            _ => {}
        }
        Some(n)
    }

    /// Decode one instruction at the start of `code`.
    pub fn decode(code: &[u8]) -> Option<(Instr, usize)> {
        let op = Op::from_u8(*code.first()?)?;
        if code.len() < op.len() {
            return None;
        }
        let o = &code[1..op.len()];
        let i = match op {
            Op::Nop => Instr::Nop,
            Op::Halt => Instr::Halt,
            Op::Push => Instr::Push(i64::from_le_bytes([o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7]])),
            Op::Dup => Instr::Dup,
            Op::Swap => Instr::Swap,
            Op::Pop => Instr::Pop,
            Op::Add => Instr::Add,
            Op::Sub => Instr::Sub,
            Op::Mul => Instr::Mul,
            Op::Div => Instr::Div,
            Op::Mod => Instr::Mod,
            Op::Neg => Instr::Neg,
            Op::Abs => Instr::Abs,
            Op::Min => Instr::Min,
            Op::Max => Instr::Max,
            Op::Lt => Instr::Lt,
            Op::Gt => Instr::Gt,
            Op::Le => Instr::Le,
            Op::Ge => Instr::Ge,
            Op::Eq => Instr::Eq,
            Op::And => Instr::And,
            Op::Or => Instr::Or,
            Op::Not => Instr::Not,
            Op::Jmp => Instr::Jmp(u16::from_le_bytes([o[0], o[1]])),
            Op::Jz => Instr::Jz(u16::from_le_bytes([o[0], o[1]])),
            Op::Jnz => Instr::Jnz(u16::from_le_bytes([o[0], o[1]])),
            Op::Price => Instr::Price(o[0]),
            Op::Ema => Instr::Ema(o[0], o[1]),
            Op::Ret => Instr::Ret(o[0], o[1]),
            Op::Vol => Instr::Vol(o[0]),
            Op::Pos => Instr::Pos(o[0]),
            Op::Entry => Instr::Entry(o[0]),
            Op::Equity => Instr::Equity,
            Op::FreeMargin => Instr::FreeMargin,
            Op::Tick => Instr::Tick,
            Op::Rand => Instr::Rand,
            Op::Mld => Instr::Mld(o[0]),
            Op::Mst => Instr::Mst(o[0]),
            Op::Long => Instr::Long(o[0], u16::from_le_bytes([o[1], o[2]])),
            Op::Short => Instr::Short(o[0], u16::from_le_bytes([o[1], o[2]])),
            Op::Close => Instr::Close(o[0]),
            Op::CloseAll => Instr::CloseAll,
        };
        Some((i, op.len()))
    }
}

/// Assemble a program into `out` (version byte first). Returns total length.
pub fn assemble(prog: &[Instr], out: &mut [u8]) -> Option<usize> {
    if out.is_empty() {
        return None;
    }
    out[0] = BYTECODE_VERSION;
    let mut n = 1;
    for i in prog {
        n += i.encode(&mut out[n..])?;
    }
    Some(n)
}

/// Byte offset (relative to the first instruction, i.e. excluding the version
/// byte) of instruction `idx` in `prog`. Useful to compute jump targets.
pub fn instr_offset(prog: &[Instr], idx: usize) -> Option<usize> {
    if idx > prog.len() {
        return None;
    }
    Some(prog[..idx].iter().map(|i| i.len()).sum())
}

/// Iterate over instructions of a blob (version byte + code). Stops at the
/// first undecodable byte.
pub fn disassemble(bytecode: &[u8]) -> Disassembler<'_> {
    Disassembler {
        code: bytecode.get(1..).unwrap_or(&[]),
        pc: 0,
    }
}

pub struct Disassembler<'a> {
    code: &'a [u8],
    pc: usize,
}

impl<'a> Iterator for Disassembler<'a> {
    /// (offset, instruction)
    type Item = (usize, Instr);
    fn next(&mut self) -> Option<Self::Item> {
        if self.pc >= self.code.len() {
            return None;
        }
        let (i, n) = Instr::decode(&self.code[self.pc..])?;
        let at = self.pc;
        self.pc += n;
        Some((at, i))
    }
}

#[cfg(feature = "std")]
impl core::fmt::Display for Instr {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Instr::Push(v) => write!(f, "push {}", v),
            Instr::Jmp(t) => write!(f, "jmp @{}", t),
            Instr::Jz(t) => write!(f, "jz @{}", t),
            Instr::Jnz(t) => write!(f, "jnz @{}", t),
            Instr::Price(m) => write!(f, "price m{}", m),
            Instr::Ema(m, k) => write!(f, "ema m{} w{}", m, crate::ops::EMA_WINDOWS.get(*k as usize).copied().unwrap_or(0)),
            Instr::Ret(m, n) => write!(f, "ret m{} n{}", m, n),
            Instr::Vol(m) => write!(f, "vol m{}", m),
            Instr::Pos(m) => write!(f, "pos m{}", m),
            Instr::Entry(m) => write!(f, "entry m{}", m),
            Instr::Mld(i) => write!(f, "mld {}", i),
            Instr::Mst(i) => write!(f, "mst {}", i),
            Instr::Long(m, b) => write!(f, "long m{} {}bps", m, b),
            Instr::Short(m, b) => write!(f, "short m{} {}bps", m, b),
            Instr::Close(m) => write!(f, "close m{}", m),
            other => {
                let s = format!("{:?}", other).to_lowercase();
                write!(f, "{}", s)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::validate;

    #[test]
    fn roundtrip_all_ops() {
        let prog = [
            Instr::Nop,
            Instr::Push(-7),
            Instr::Dup,
            Instr::Swap,
            Instr::Pop,
            Instr::Add,
            Instr::Sub,
            Instr::Mul,
            Instr::Div,
            Instr::Mod,
            Instr::Neg,
            Instr::Abs,
            Instr::Min,
            Instr::Max,
            Instr::Lt,
            Instr::Gt,
            Instr::Le,
            Instr::Ge,
            Instr::Eq,
            Instr::And,
            Instr::Or,
            Instr::Not,
            Instr::Jmp(3),
            Instr::Jz(3),
            Instr::Jnz(3),
            Instr::Price(1),
            Instr::Ema(1, 2),
            Instr::Ret(0, 12),
            Instr::Vol(1),
            Instr::Pos(0),
            Instr::Entry(1),
            Instr::Equity,
            Instr::FreeMargin,
            Instr::Tick,
            Instr::Rand,
            Instr::Mld(15),
            Instr::Mst(0),
            Instr::Long(0, 2500),
            Instr::Short(1, 10_000),
            Instr::Close(0),
            Instr::CloseAll,
            Instr::Halt,
        ];
        let mut buf = [0u8; 512];
        let n = assemble(&prog, &mut buf).unwrap();
        let decoded: Vec<Instr> = disassemble(&buf[..n]).map(|(_, i)| i).collect();
        assert_eq!(decoded, prog);
        // jump targets 3 in this program land mid-instruction (push is 9 bytes) -> invalid
        assert!(validate(&buf[..n], 2).is_err());
    }

    #[test]
    fn validate_accepts_boundary_jumps() {
        let prog = [Instr::Push(1), Instr::Jz(12), Instr::Long(0, 100), Instr::Halt];
        // offsets: push@0 (9), jz@9 (3), long@12 (4), halt@16
        let mut buf = [0u8; 64];
        let n = assemble(&prog, &mut buf).unwrap();
        assert_eq!(validate(&buf[..n], 1), Ok(()));
        assert!(validate(&buf[..n], 0).is_err()); // market 0 out of range
    }
}
