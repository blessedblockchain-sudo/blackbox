//! The executor.

use crate::ops::{Op, MAX_MARKETS, MEM_SLOTS, STACK_DEPTH};
use crate::{BYTECODE_VERSION, SCALE};

/// Maximum trade actions a strategy may emit per tick.
pub const ACTIONS_PER_TICK: usize = 8;

/// What the strategy asks the perps engine to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Target a long exposure of `size_bps` of equity on `market`.
    Long { market: u8, size_bps: u16 },
    /// Target a short exposure of `size_bps` of equity on `market`.
    Short { market: u8, size_bps: u16 },
    Close { market: u8 },
    CloseAll,
}

/// Why execution stopped abnormally. A faulted run emits no actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    BadVersion,
    BadOpcode,
    Truncated,
    StackUnderflow,
    StackOverflow,
    DivByZero,
    BadJump,
    BadMarket,
    BadOperand,
    StepLimit,
    TooManyActions,
    /// The host had no data for the requested market (e.g. stale oracle).
    NoData,
}

/// Market and account data the VM reads, plus the RNG. All prices/values are
/// fixed point with 6 decimals. `None` means "no data" and faults the run.
pub trait Host {
    fn n_markets(&self) -> u8;
    fn price(&self, market: u8) -> Option<i64>;
    /// EMA of the mark price for window index `k` (0 = 8 ticks, 1 = 21, 2 = 55).
    fn ema(&self, market: u8, k: u8) -> Option<i64>;
    /// Return over the last `n` ticks as a scaled fraction (0.01 == 10_000).
    fn ret(&self, market: u8, n: u8) -> Option<i64>;
    /// Realized volatility (scaled fraction) over the ring buffer.
    fn vol(&self, market: u8) -> Option<i64>;
    /// Signed position notional on `market` (positive long, negative short).
    fn pos(&self, market: u8) -> i64;
    /// Entry price on `market`, 0 when flat.
    fn entry(&self, market: u8) -> i64;
    fn equity(&self) -> i64;
    fn free_margin(&self) -> i64;
    fn tick(&self) -> i64;
    /// Pseudo-random value in [0, SCALE) derived from the round's VRF seed.
    fn rand(&self) -> i64;
}

/// Outcome of one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecResult {
    pub actions: [Option<Action>; ACTIONS_PER_TICK],
    pub n_actions: u8,
    pub steps: u32,
    pub fault: Option<Fault>,
    /// Program counter where execution stopped (for debugging faults).
    pub pc: u16,
}

impl ExecResult {
    pub fn actions(&self) -> impl Iterator<Item = Action> + '_ {
        self.actions.iter().take(self.n_actions as usize).flatten().copied()
    }
}

struct Stack {
    data: [i64; STACK_DEPTH],
    sp: usize,
}

impl Stack {
    #[inline]
    fn push(&mut self, v: i64) -> Result<(), Fault> {
        if self.sp >= STACK_DEPTH {
            return Err(Fault::StackOverflow);
        }
        self.data[self.sp] = v;
        self.sp += 1;
        Ok(())
    }
    #[inline]
    fn pop(&mut self) -> Result<i64, Fault> {
        if self.sp == 0 {
            return Err(Fault::StackUnderflow);
        }
        self.sp -= 1;
        Ok(self.data[self.sp])
    }
    #[inline]
    fn peek(&self) -> Result<i64, Fault> {
        if self.sp == 0 {
            return Err(Fault::StackUnderflow);
        }
        Ok(self.data[self.sp - 1])
    }
}

/// Fixed-point multiply: (a * b) / SCALE with i128 intermediate and saturation.
#[inline]
pub fn fmul(a: i64, b: i64) -> i64 {
    let r = (a as i128 * b as i128) / SCALE as i128;
    r.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// Fixed-point divide: (a * SCALE) / b with i128 intermediate and saturation.
#[inline]
pub fn fdiv(a: i64, b: i64) -> Result<i64, Fault> {
    if b == 0 {
        return Err(Fault::DivByZero);
    }
    let r = (a as i128 * SCALE as i128) / b as i128;
    Ok(r.clamp(i64::MIN as i128, i64::MAX as i128) as i64)
}

/// Run one tick of `bytecode` (version byte + instructions) against `host`.
///
/// `mem` is the strategy's persistent memory (lives in the private Position
/// account). On a fault, `mem` writes made during the run are kept (they are
/// useful for debugging) but no actions are returned.
pub fn execute<H: Host>(
    bytecode: &[u8],
    host: &H,
    mem: &mut [i64; MEM_SLOTS],
    step_limit: u32,
) -> ExecResult {
    let mut res = ExecResult {
        actions: [None; ACTIONS_PER_TICK],
        n_actions: 0,
        steps: 0,
        fault: None,
        pc: 0,
    };
    let fault = run(bytecode, host, mem, step_limit, &mut res);
    if let Err(f) = fault {
        res.fault = Some(f);
        res.actions = [None; ACTIONS_PER_TICK];
        res.n_actions = 0;
    }
    res
}

fn run<H: Host>(
    bytecode: &[u8],
    host: &H,
    mem: &mut [i64; MEM_SLOTS],
    step_limit: u32,
    res: &mut ExecResult,
) -> Result<(), Fault> {
    if bytecode.is_empty() || bytecode[0] != BYTECODE_VERSION {
        return Err(Fault::BadVersion);
    }
    let code = &bytecode[1..];
    let n_markets = host.n_markets().min(MAX_MARKETS as u8);
    let mut st = Stack { data: [0; STACK_DEPTH], sp: 0 };
    let mut pc: usize = 0;

    macro_rules! market {
        ($m:expr) => {{
            let m = $m;
            if m >= n_markets {
                return Err(Fault::BadMarket);
            }
            m
        }};
    }
    macro_rules! binop {
        ($f:expr) => {{
            let b = st.pop()?;
            let a = st.pop()?;
            st.push($f(a, b))?;
        }};
    }
    macro_rules! cmp {
        ($f:expr) => {{
            let b = st.pop()?;
            let a = st.pop()?;
            st.push(if $f(a, b) { SCALE } else { 0 })?;
        }};
    }
    macro_rules! emit {
        ($a:expr) => {{
            if (res.n_actions as usize) >= ACTIONS_PER_TICK {
                return Err(Fault::TooManyActions);
            }
            res.actions[res.n_actions as usize] = Some($a);
            res.n_actions += 1;
        }};
    }

    loop {
        if pc >= code.len() {
            // Falling off the end is a normal halt.
            res.pc = pc as u16;
            return Ok(());
        }
        if res.steps >= step_limit {
            res.pc = pc as u16;
            return Err(Fault::StepLimit);
        }
        res.steps += 1;
        res.pc = pc as u16;
        let op = Op::from_u8(code[pc]).ok_or(Fault::BadOpcode)?;
        if pc + op.len() > code.len() {
            return Err(Fault::Truncated);
        }
        let o = &code[pc + 1..pc + op.len()];
        let mut next = pc + op.len();
        match op {
            Op::Nop => {}
            Op::Halt => {
                return Ok(());
            }
            Op::Push => {
                let v = i64::from_le_bytes([o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7]]);
                st.push(v)?;
            }
            Op::Dup => {
                let v = st.peek()?;
                st.push(v)?;
            }
            Op::Swap => {
                let b = st.pop()?;
                let a = st.pop()?;
                st.push(b)?;
                st.push(a)?;
            }
            Op::Pop => {
                st.pop()?;
            }
            Op::Add => binop!(|a: i64, b: i64| a.saturating_add(b)),
            Op::Sub => binop!(|a: i64, b: i64| a.saturating_sub(b)),
            Op::Mul => binop!(fmul),
            Op::Div => {
                let b = st.pop()?;
                let a = st.pop()?;
                st.push(fdiv(a, b)?)?;
            }
            Op::Mod => {
                let b = st.pop()?;
                let a = st.pop()?;
                if b == 0 {
                    return Err(Fault::DivByZero);
                }
                st.push(a.wrapping_rem(b))?;
            }
            Op::Neg => {
                let a = st.pop()?;
                st.push(a.saturating_neg())?;
            }
            Op::Abs => {
                let a = st.pop()?;
                st.push(a.saturating_abs())?;
            }
            Op::Min => binop!(|a: i64, b: i64| a.min(b)),
            Op::Max => binop!(|a: i64, b: i64| a.max(b)),
            Op::Lt => cmp!(|a, b| a < b),
            Op::Gt => cmp!(|a, b| a > b),
            Op::Le => cmp!(|a, b| a <= b),
            Op::Ge => cmp!(|a, b| a >= b),
            Op::Eq => cmp!(|a, b| a == b),
            Op::And => cmp!(|a, b| a != 0 && b != 0),
            Op::Or => cmp!(|a, b| a != 0 || b != 0),
            Op::Not => {
                let a = st.pop()?;
                st.push(if a == 0 { SCALE } else { 0 })?;
            }
            Op::Jmp | Op::Jz | Op::Jnz => {
                let t = u16::from_le_bytes([o[0], o[1]]) as usize;
                if t > code.len() {
                    return Err(Fault::BadJump);
                }
                let take = match op {
                    Op::Jmp => true,
                    Op::Jz => st.pop()? == 0,
                    _ => st.pop()? != 0,
                };
                if take {
                    next = t;
                }
            }
            Op::Price => {
                let m = market!(o[0]);
                st.push(host.price(m).ok_or(Fault::NoData)?)?;
            }
            Op::Ema => {
                let m = market!(o[0]);
                if o[1] > 2 {
                    return Err(Fault::BadOperand);
                }
                st.push(host.ema(m, o[1]).ok_or(Fault::NoData)?)?;
            }
            Op::Ret => {
                let m = market!(o[0]);
                if o[1] == 0 || o[1] > crate::ops::MAX_RET_LOOKBACK {
                    return Err(Fault::BadOperand);
                }
                st.push(host.ret(m, o[1]).ok_or(Fault::NoData)?)?;
            }
            Op::Vol => {
                let m = market!(o[0]);
                st.push(host.vol(m).ok_or(Fault::NoData)?)?;
            }
            Op::Pos => {
                let m = market!(o[0]);
                st.push(host.pos(m))?;
            }
            Op::Entry => {
                let m = market!(o[0]);
                st.push(host.entry(m))?;
            }
            Op::Equity => st.push(host.equity())?,
            Op::FreeMargin => st.push(host.free_margin())?,
            Op::Tick => st.push(host.tick())?,
            Op::Rand => st.push(host.rand())?,
            Op::Mld => {
                let i = o[0] as usize;
                if i >= MEM_SLOTS {
                    return Err(Fault::BadOperand);
                }
                st.push(mem[i])?;
            }
            Op::Mst => {
                let i = o[0] as usize;
                if i >= MEM_SLOTS {
                    return Err(Fault::BadOperand);
                }
                mem[i] = st.pop()?;
            }
            Op::Long | Op::Short => {
                let m = market!(o[0]);
                let bps = u16::from_le_bytes([o[1], o[2]]);
                if bps == 0 || bps > 10_000 {
                    return Err(Fault::BadOperand);
                }
                if op == Op::Long {
                    emit!(Action::Long { market: m, size_bps: bps });
                } else {
                    emit!(Action::Short { market: m, size_bps: bps });
                }
            }
            Op::Close => {
                let m = market!(o[0]);
                emit!(Action::Close { market: m });
            }
            Op::CloseAll => emit!(Action::CloseAll),
        }
        pc = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asm::{assemble, Instr};

    struct FakeHost {
        prices: [i64; 2],
        ema: [[i64; 3]; 2],
        pos: [i64; 2],
    }
    impl Host for FakeHost {
        fn n_markets(&self) -> u8 {
            2
        }
        fn price(&self, m: u8) -> Option<i64> {
            Some(self.prices[m as usize])
        }
        fn ema(&self, m: u8, k: u8) -> Option<i64> {
            Some(self.ema[m as usize][k as usize])
        }
        fn ret(&self, _m: u8, _n: u8) -> Option<i64> {
            Some(5_000)
        }
        fn vol(&self, _m: u8) -> Option<i64> {
            Some(20_000)
        }
        fn pos(&self, m: u8) -> i64 {
            self.pos[m as usize]
        }
        fn entry(&self, _m: u8) -> i64 {
            0
        }
        fn equity(&self) -> i64 {
            1_000 * SCALE
        }
        fn free_margin(&self) -> i64 {
            900 * SCALE
        }
        fn tick(&self) -> i64 {
            42
        }
        fn rand(&self) -> i64 {
            123_456
        }
    }

    fn host() -> FakeHost {
        FakeHost {
            prices: [100 * SCALE, 60_000 * SCALE],
            ema: [[101 * SCALE, 99 * SCALE, 95 * SCALE], [0, 0, 0]],
            pos: [0, 0],
        }
    }

    #[test]
    fn ema_cross_goes_long() {
        // if ema8 > ema21 and pos == 0: long SOL 30%
        let prog = [
            Instr::Ema(0, 0),
            Instr::Ema(0, 1),
            Instr::Gt,
            Instr::Pos(0),
            Instr::Push(0),
            Instr::Eq,
            Instr::And,
            Instr::Jz(0), // patched below
            Instr::Long(0, 3000),
            Instr::Halt,
        ];
        let mut bytes = [0u8; 256];
        let n = assemble(&prog, &mut bytes).unwrap();
        // patch the Jz target to the Halt instruction offset
        let halt_off = crate::asm::instr_offset(&prog, 9).unwrap();
        let jz_off = crate::asm::instr_offset(&prog, 7).unwrap();
        bytes[1 + jz_off + 1..1 + jz_off + 3].copy_from_slice(&(halt_off as u16).to_le_bytes());
        let mut mem = [0i64; MEM_SLOTS];
        let r = execute(&bytes[..n], &host(), &mut mem, 512);
        assert_eq!(r.fault, None, "{:?}", r);
        assert_eq!(r.n_actions, 1);
        assert_eq!(r.actions[0], Some(Action::Long { market: 0, size_bps: 3000 }));
    }

    #[test]
    fn fault_discards_actions() {
        let prog = [Instr::Long(0, 1000), Instr::Pop, Instr::Halt];
        let mut bytes = [0u8; 64];
        let n = assemble(&prog, &mut bytes).unwrap();
        let mut mem = [0i64; MEM_SLOTS];
        let r = execute(&bytes[..n], &host(), &mut mem, 512);
        assert_eq!(r.fault, Some(Fault::StackUnderflow));
        assert_eq!(r.n_actions, 0);
    }

    #[test]
    fn step_limit_stops_loops() {
        let prog = [Instr::Jmp(0)];
        let mut bytes = [0u8; 16];
        let n = assemble(&prog, &mut bytes).unwrap();
        let mut mem = [0i64; MEM_SLOTS];
        let r = execute(&bytes[..n], &host(), &mut mem, 100);
        assert_eq!(r.fault, Some(Fault::StepLimit));
        assert_eq!(r.steps, 100);
    }

    #[test]
    fn memory_persists_across_ticks() {
        let prog = [Instr::Mld(3), Instr::Push(SCALE), Instr::Add, Instr::Mst(3), Instr::Halt];
        let mut bytes = [0u8; 64];
        let n = assemble(&prog, &mut bytes).unwrap();
        let mut mem = [0i64; MEM_SLOTS];
        for _ in 0..5 {
            let r = execute(&bytes[..n], &host(), &mut mem, 512);
            assert_eq!(r.fault, None);
        }
        assert_eq!(mem[3], 5 * SCALE);
    }

    #[test]
    fn fixed_point_math() {
        assert_eq!(fmul(2 * SCALE, 3 * SCALE), 6 * SCALE);
        assert_eq!(fdiv(6 * SCALE, 3 * SCALE).unwrap(), 2 * SCALE);
        assert_eq!(fdiv(1, 0), Err(Fault::DivByZero));
        assert_eq!(fmul(i64::MAX, 2 * SCALE), i64::MAX);
    }

    #[test]
    fn random_bytes_never_panic() {
        // cheap deterministic pseudo-fuzz
        let mut seed: u64 = 0x9E3779B97F4A7C15;
        let mut mem = [0i64; MEM_SLOTS];
        for _ in 0..2000 {
            let mut buf = [0u8; 96];
            buf[0] = BYTECODE_VERSION;
            for b in buf.iter_mut().skip(1) {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                *b = (seed & 0xff) as u8;
            }
            let r = execute(&buf, &host(), &mut mem, 512);
            assert!(r.steps <= 512);
        }
    }
}
