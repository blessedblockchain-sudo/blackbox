/**
 * TypeScript port of the bxvm executor (`crates/bxvm/src/exec.rs`).
 *
 * Identical semantics: i64 stack values (BigInt here) with i128-style
 * saturation, fixed-point MUL/DIV, comparison results of 1.0 / 0, a step
 * counter checked before each instruction, at most 8 actions per run, and
 * every fault discarding all actions (memory writes made before the fault are
 * kept, like the Rust code).
 */
import { Op, operandLen, BYTECODE_VERSION, MEM_SLOTS, MAX_MARKETS, MAX_RET_LOOKBACK } from "@blackbox/sdk/src/vm";
import { SCALE, bool, fabs, fadd, fdiv, fmul, fneg, frem, fsub } from "./fixed";

export const STACK_DEPTH = 64;
export const ACTIONS_PER_TICK = 8;
export const DEFAULT_STEP_LIMIT = 512;

/** Same names and order as `bxvm::Fault` (on-chain `last_fault` = index + 1). */
export const FAULTS = [
  "BadVersion",
  "BadOpcode",
  "Truncated",
  "StackUnderflow",
  "StackOverflow",
  "DivByZero",
  "BadJump",
  "BadMarket",
  "BadOperand",
  "StepLimit",
  "TooManyActions",
  "NoData",
] as const;
export type Fault = (typeof FAULTS)[number];

/** Decode the on-chain `Position.last_fault` byte (0 = none). */
export function faultName(code: number): Fault | null {
  return code === 0 ? null : FAULTS[code - 1] ?? null;
}

export type Action =
  | { kind: "long"; market: number; bps: number }
  | { kind: "short"; market: number; bps: number }
  | { kind: "close"; market: number }
  | { kind: "closeAll" };

export function formatAction(a: Action): string {
  switch (a.kind) {
    case "long":
    case "short":
      return `${a.kind} m${a.market} ${a.bps}bps`;
    case "close":
      return `close m${a.market}`;
    case "closeAll":
      return "close_all";
  }
}

/** Market and account data the VM reads (mirror of `bxvm::Host`). null = no data (faults NoData). */
export interface VmHost {
  nMarkets(): number;
  price(m: number): bigint | null;
  ema(m: number, k: number): bigint | null;
  ret(m: number, n: number): bigint | null;
  vol(m: number): bigint | null;
  pos(m: number): bigint;
  entry(m: number): bigint;
  equity(): bigint;
  freeMargin(): bigint;
  tick(): bigint;
  rand(): bigint;
}

export interface ExecResult {
  actions: Action[];
  steps: number;
  fault: Fault | null;
  /** Program counter (code-relative) where execution stopped. */
  pc: number;
}

class VmFault {
  constructor(readonly fault: Fault) {}
}

/** Run one tick of `bytecode` (version byte + code). `mem` (16 slots) is mutated in place. */
export function execute(bytecode: Uint8Array, host: VmHost, mem: bigint[], stepLimit: number = DEFAULT_STEP_LIMIT): ExecResult {
  const res: ExecResult = { actions: [], steps: 0, fault: null, pc: 0 };
  try {
    run(bytecode, host, mem, stepLimit, res);
  } catch (e) {
    if (!(e instanceof VmFault)) throw e;
    res.fault = e.fault;
    res.actions = [];
  }
  return res;
}

function run(bytecode: Uint8Array, host: VmHost, mem: bigint[], stepLimit: number, res: ExecResult): void {
  const fail = (f: Fault): never => {
    throw new VmFault(f);
  };
  if (bytecode.length === 0 || bytecode[0] !== BYTECODE_VERSION) fail("BadVersion");
  const code = bytecode.subarray(1);
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const nMarkets = Math.min(host.nMarkets(), MAX_MARKETS);
  const stack: bigint[] = [];
  const push = (v: bigint) => {
    if (stack.length >= STACK_DEPTH) fail("StackOverflow");
    stack.push(v);
  };
  const pop = (): bigint => {
    if (stack.length === 0) fail("StackUnderflow");
    return stack.pop() as bigint;
  };
  const market = (m: number) => (m >= nMarkets ? fail("BadMarket") : m);
  const data = (v: bigint | null): bigint => (v === null ? fail("NoData") : v);
  const emit = (a: Action) => {
    if (res.actions.length >= ACTIONS_PER_TICK) fail("TooManyActions");
    res.actions.push(a);
  };
  const bin = (f: (a: bigint, b: bigint) => bigint) => {
    const b = pop();
    const a = pop();
    push(f(a, b));
  };
  const cmp = (f: (a: bigint, b: bigint) => boolean) => {
    const b = pop();
    const a = pop();
    push(bool(f(a, b)));
  };

  let pc = 0;
  for (;;) {
    if (pc >= code.length) {
      res.pc = pc;
      return;
    }
    if (res.steps >= stepLimit) {
      res.pc = pc;
      fail("StepLimit");
    }
    res.steps++;
    res.pc = pc;
    const op = code[pc] as Op;
    if (op > Op.Mod) fail("BadOpcode");
    const len = 1 + operandLen(op);
    if (pc + len > code.length) fail("Truncated");
    const o = pc + 1;
    let next = pc + len;
    switch (op) {
      case Op.Nop:
        break;
      case Op.Halt:
        return;
      case Op.Push:
        push(dv.getBigInt64(o, true));
        break;
      case Op.Dup: {
        if (stack.length === 0) fail("StackUnderflow");
        push(stack[stack.length - 1]);
        break;
      }
      case Op.Swap: {
        const b = pop();
        const a = pop();
        push(b);
        push(a);
        break;
      }
      case Op.Pop:
        pop();
        break;
      case Op.Add:
        bin(fadd);
        break;
      case Op.Sub:
        bin(fsub);
        break;
      case Op.Mul:
        bin(fmul);
        break;
      case Op.Div: {
        const b = pop();
        const a = pop();
        const r = fdiv(a, b);
        push(r === null ? fail("DivByZero") : r);
        break;
      }
      case Op.Mod: {
        const b = pop();
        const a = pop();
        const r = frem(a, b);
        push(r === null ? fail("DivByZero") : r);
        break;
      }
      case Op.Neg:
        push(fneg(pop()));
        break;
      case Op.Abs:
        push(fabs(pop()));
        break;
      case Op.Min:
        bin((a, b) => (a < b ? a : b));
        break;
      case Op.Max:
        bin((a, b) => (a > b ? a : b));
        break;
      case Op.Lt:
        cmp((a, b) => a < b);
        break;
      case Op.Gt:
        cmp((a, b) => a > b);
        break;
      case Op.Le:
        cmp((a, b) => a <= b);
        break;
      case Op.Ge:
        cmp((a, b) => a >= b);
        break;
      case Op.Eq:
        cmp((a, b) => a === b);
        break;
      case Op.And:
        cmp((a, b) => a !== 0n && b !== 0n);
        break;
      case Op.Or:
        cmp((a, b) => a !== 0n || b !== 0n);
        break;
      case Op.Not:
        push(pop() === 0n ? SCALE : 0n);
        break;
      case Op.Jmp:
      case Op.Jz:
      case Op.Jnz: {
        const t = dv.getUint16(o, true);
        if (t > code.length) fail("BadJump");
        const take = op === Op.Jmp ? true : op === Op.Jz ? pop() === 0n : pop() !== 0n;
        if (take) next = t;
        break;
      }
      case Op.Price:
        push(data(host.price(market(code[o]))));
        break;
      case Op.Ema: {
        const m = market(code[o]);
        if (code[o + 1] > 2) fail("BadOperand");
        push(data(host.ema(m, code[o + 1])));
        break;
      }
      case Op.Ret: {
        const m = market(code[o]);
        const n = code[o + 1];
        if (n === 0 || n > MAX_RET_LOOKBACK) fail("BadOperand");
        push(data(host.ret(m, n)));
        break;
      }
      case Op.Vol:
        push(data(host.vol(market(code[o]))));
        break;
      case Op.Pos:
        push(host.pos(market(code[o])));
        break;
      case Op.Entry:
        push(host.entry(market(code[o])));
        break;
      case Op.Equity:
        push(host.equity());
        break;
      case Op.FreeMargin:
        push(host.freeMargin());
        break;
      case Op.Tick:
        push(host.tick());
        break;
      case Op.Rand:
        push(host.rand());
        break;
      case Op.Mld: {
        const i = code[o];
        if (i >= MEM_SLOTS) fail("BadOperand");
        push(mem[i] ?? 0n);
        break;
      }
      case Op.Mst: {
        const i = code[o];
        if (i >= MEM_SLOTS) fail("BadOperand");
        mem[i] = pop();
        break;
      }
      case Op.Long:
      case Op.Short: {
        const m = market(code[o]);
        const bps = dv.getUint16(o + 1, true);
        if (bps === 0 || bps > 10_000) fail("BadOperand");
        emit({ kind: op === Op.Long ? "long" : "short", market: m, bps });
        break;
      }
      case Op.Close:
        emit({ kind: "close", market: market(code[o]) });
        break;
      case Op.CloseAll:
        emit({ kind: "closeAll" });
        break;
      default:
        fail("BadOpcode");
    }
    pc = next;
  }
}
