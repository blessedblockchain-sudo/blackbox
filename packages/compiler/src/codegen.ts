/**
 * BXL code generation: AST -> bxvm bytecode via the SDK's label-aware `Asm`.
 * Semantic checks run here so every error in a program is reported at once.
 */
import { Asm, Op, operandLen, disassemble, validate, EMA_WINDOWS, MAX_BYTECODE_LEN, MAX_MARKETS, MAX_RET_LOOKBACK } from "@blackbox/sdk/src/vm";
import type { CompileError, CompileOptions, CompileResult } from "./index";
import { BxlSyntaxError } from "./lexer";
import { parse, Expr, Pos, Stmt, BinOp } from "./parser";
import { I64_MAX, SCALE, bool, fadd, fdiv, fmul, fneg, frem, fsub, parseDecimal, formatFixed } from "./fixed";
import { ACTIONS_PER_TICK, DEFAULT_STEP_LIMIT, STACK_DEPTH } from "./interp";

const LOCAL_BASE = 8;
const MAX_LOCALS = 8;
const USER_MEM = 8;

// ------------------------------------------------------------------ markets

/** Resolve a market symbol against the round's markets (case-insensitive; "SOL" matches "SOL-PERP"). */
export function resolveMarket(name: string, markets: string[]): { index: number } | { error: string } {
  const want = name.toUpperCase();
  const full = markets.map((m) => m.toUpperCase());
  const exact = full.indexOf(want);
  if (exact >= 0) return { index: exact };
  const compact = full.map((m) => m.replace(/[^A-Z0-9]/g, ""));
  const c = compact.indexOf(want.replace(/[^A-Z0-9]/g, ""));
  if (c >= 0) return { index: c };
  const bases = full.map((m) => m.split(/[^A-Z0-9]/)[0]);
  const hits = bases.map((b, i) => (b === want ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return { index: hits[0] };
  if (hits.length > 1) return { error: `market ${name} is ambiguous (matches ${hits.map((i) => markets[i]).join(", ")})` };
  const shown = markets.map((m, i) => bases[i] || m).join(", ");
  const guess = suggest(want, bases);
  return { error: `unknown market ${name}${guess ? `; did you mean ${guess}?` : ""} (this round trades ${shown || "no markets"})` };
}

// ------------------------------------------------------------------ builtins

type ArgKind = "market" | "window" | "lookback" | "value" | "size";
interface Builtin {
  args: ArgKind[];
  action: boolean;
  sig: string;
}
const B = (sig: string, args: ArgKind[], action = false): Builtin => ({ sig, args, action });
const BUILTINS: Record<string, Builtin> = {
  price: B("price(market)", ["market"]),
  ema: B("ema(market, 8|21|55)", ["market", "window"]),
  ret: B("ret(market, ticks)", ["market", "lookback"]),
  vol: B("vol(market)", ["market"]),
  pos: B("pos(market)", ["market"]),
  entry: B("entry(market)", ["market"]),
  equity: B("equity()", []),
  free: B("free()", []),
  tick: B("tick()", []),
  rand: B("rand()", []),
  abs: B("abs(x)", ["value"]),
  min: B("min(a, b)", ["value", "value"]),
  max: B("max(a, b)", ["value", "value"]),
  long: B("long(market, percent)", ["market", "size"], true),
  short: B("short(market, percent)", ["market", "size"], true),
  close: B("close(market)", ["market"], true),
  close_all: B("close_all()", [], true),
  halt: B("halt()", [], true),
};

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(word: string, candidates: string[]): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(w, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

// ------------------------------------------------------------------ analysis

export interface Analysis {
  /** Longest path in executed instructions (halt counts as a step); -1 if the code has a backward jump. */
  maxSteps: number;
  /** Most actions emitted on any path; -1 if the code has a backward jump. */
  maxActions: number;
  /** Deepest operand stack on any path. */
  maxStack: number;
  /** Instruction offsets (code-relative) along the path that emits the most actions. */
  actionPath: number[];
}

interface DInstr {
  off: number;
  op: Op;
  len: number;
  target: number | null;
}

function decode(bytes: Uint8Array): DInstr[] | null {
  if (bytes.length === 0 || bytes[0] !== 1) return null;
  const code = bytes.subarray(1);
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const out: DInstr[] = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] as Op;
    if (op > Op.Mod) return null;
    const len = 1 + operandLen(op);
    if (pc + len > code.length) return null;
    const isJump = op === Op.Jmp || op === Op.Jz || op === Op.Jnz;
    out.push({ off: pc, op, len, target: isJump ? dv.getUint16(pc + 1, true) : null });
    pc += len;
  }
  return out;
}

const STACK_EFFECT: Partial<Record<Op, [number, number]>> = {
  [Op.Push]: [0, 1], [Op.Dup]: [1, 2], [Op.Swap]: [2, 2], [Op.Pop]: [1, 0],
  [Op.Add]: [2, 1], [Op.Sub]: [2, 1], [Op.Mul]: [2, 1], [Op.Div]: [2, 1], [Op.Mod]: [2, 1],
  [Op.Min]: [2, 1], [Op.Max]: [2, 1], [Op.Lt]: [2, 1], [Op.Gt]: [2, 1], [Op.Le]: [2, 1], [Op.Ge]: [2, 1],
  [Op.Eq]: [2, 1], [Op.And]: [2, 1], [Op.Or]: [2, 1], [Op.Neg]: [1, 1], [Op.Abs]: [1, 1], [Op.Not]: [1, 1],
  [Op.Jz]: [1, 0], [Op.Jnz]: [1, 0], [Op.Mst]: [1, 0],
  [Op.Price]: [0, 1], [Op.Ema]: [0, 1], [Op.Ret]: [0, 1], [Op.Vol]: [0, 1], [Op.Pos]: [0, 1], [Op.Entry]: [0, 1],
  [Op.Equity]: [0, 1], [Op.FreeMargin]: [0, 1], [Op.Tick]: [0, 1], [Op.Rand]: [0, 1], [Op.Mld]: [0, 1],
};
const isAction = (op: Op) => op === Op.Long || op === Op.Short || op === Op.Close || op === Op.CloseAll;

/**
 * Static analysis of a bytecode blob: worst-case steps, actions and stack depth
 * over every path. Exact for forward-only code (everything BXL emits).
 */
export function analyze(bytes: Uint8Array): Analysis {
  const ins = decode(bytes);
  if (!ins) return { maxSteps: -1, maxActions: -1, maxStack: -1, actionPath: [] };
  const codeLen = bytes.length - 1;
  const at = new Map<number, number>();
  ins.forEach((d, i) => at.set(d.off, i));
  const succ = (i: number): number[] => {
    const d = ins[i];
    const next = d.off + d.len;
    if (d.op === Op.Halt) return [];
    if (d.op === Op.Jmp) return [d.target as number];
    if (d.op === Op.Jz || d.op === Op.Jnz) return [next, d.target as number];
    return [next];
  };
  // Stack depth: forward propagation (predecessors precede successors in forward-only code).
  const height = new Array<number>(ins.length).fill(-1);
  let maxStack = 0;
  let backward = false;
  if (ins.length) height[0] = 0;
  for (let i = 0; i < ins.length; i++) {
    if (height[i] < 0) continue;
    const [pop, push] = STACK_EFFECT[ins[i].op] ?? [0, 0];
    const h = Math.max(0, height[i] - pop) + push;
    maxStack = Math.max(maxStack, h, height[i]);
    for (const s of succ(i)) {
      if (s <= ins[i].off) backward = true;
      const j = at.get(s);
      if (j !== undefined && j > i) height[j] = Math.max(height[j], h);
    }
  }
  if (backward) return { maxSteps: -1, maxActions: -1, maxStack, actionPath: [] };
  // Longest paths, computed from the end.
  const steps = new Array<number>(ins.length).fill(0);
  const acts = new Array<number>(ins.length).fill(0);
  const bestAct = new Array<number>(ins.length).fill(-1);
  const val = (arr: number[], off: number) => {
    if (off >= codeLen) return 0;
    const j = at.get(off);
    return j === undefined ? 0 : arr[j];
  };
  for (let i = ins.length - 1; i >= 0; i--) {
    let s = 0;
    let a = 0;
    let bj = -1;
    for (const o of succ(i)) {
      s = Math.max(s, val(steps, o));
      const av = val(acts, o);
      if (av > a || bj < 0) {
        a = Math.max(a, av);
        bj = at.get(o) ?? -1;
      }
    }
    steps[i] = 1 + s;
    acts[i] = (isAction(ins[i].op) ? 1 : 0) + a;
    bestAct[i] = bj;
  }
  const actionPath: number[] = [];
  for (let i = ins.length ? 0 : -1; i >= 0; i = bestAct[i]) {
    if (isAction(ins[i].op)) actionPath.push(ins[i].off);
    if (actionPath.length > 64) break;
  }
  return { maxSteps: ins.length ? steps[0] : 0, maxActions: ins.length ? acts[0] : 0, maxStack, actionPath };
}

// ------------------------------------------------------------------ listing

/** Offsets plus disassembly, one instruction per line (offsets are code-relative, like jump targets). */
export function formatListing(bytecode: Uint8Array, sourceLines?: Map<number, string>): string {
  if (bytecode.length === 0) return "";
  if (bytecode[0] !== 1) return `; not a bxvm v1 blob (version byte ${bytecode[0]})`;
  const dis = disassemble(bytecode);
  const lines: string[] = [];
  for (const d of dis) {
    const src = sourceLines?.get(d.offset);
    if (src !== undefined) lines.push(src);
    lines.push(`${String(d.offset).padStart(4, "0")}  ${d.text}`);
  }
  const last = dis[dis.length - 1];
  const decoded = last ? last.offset + 1 + operandLen(bytecode[1 + last.offset] as Op) : 0;
  const codeLen = bytecode.length - 1;
  if (decoded < codeLen) lines.push(`; ${codeLen - decoded} undecodable byte${codeLen - decoded === 1 ? "" : "s"} from offset ${decoded}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ compiler

interface Rec {
  op: Op;
  size: number;
  pos: Pos;
  /** Listing comment override (e.g. the jump that ends an if branch). */
  note?: string;
}

class Gen {
  readonly asm = new Asm();
  readonly recs: Rec[] = [];
  readonly errors: CompileError[] = [];
  readonly locals = new Map<string, number>();
  private labelN = 0;
  /** Position used for the source map (the statement being compiled). */
  at: Pos = { line: 1, col: 1 };

  constructor(readonly markets: string[]) {}

  error(pos: Pos, message: string) {
    if (!this.errors.some((e) => e.line === pos.line && e.col === pos.col && e.message === message)) this.errors.push({ line: pos.line, col: pos.col, message });
  }

  private rec(op: Op, note?: string) {
    this.recs.push({ op, size: 1 + operandLen(op), pos: this.at, note });
  }
  label() {
    return `L${this.labelN++}`;
  }
  place(l: string) {
    this.asm.label(l);
  }
  op(op: Op) {
    this.asm.op(op);
    this.rec(op);
  }
  push(v: bigint) {
    this.asm.push(v);
    this.rec(Op.Push);
  }
  jmp(l: string, note?: string) {
    this.asm.jmp(l);
    this.rec(Op.Jmp, note);
  }
  jz(l: string) {
    this.asm.jz(l);
    this.rec(Op.Jz);
  }
  jnz(l: string) {
    this.asm.jnz(l);
    this.rec(Op.Jnz);
  }
  mld(s: number) {
    this.asm.mld(s);
    this.rec(Op.Mld);
  }
  mst(s: number) {
    this.asm.mst(s);
    this.rec(Op.Mst);
  }
  marketOp(op: Op.Price | Op.Vol | Op.Pos | Op.Entry | Op.Close, m: number) {
    if (op === Op.Price) this.asm.price(m);
    else if (op === Op.Vol) this.asm.vol(m);
    else if (op === Op.Pos) this.asm.pos(m);
    else if (op === Op.Entry) this.asm.entry(m);
    else this.asm.close(m);
    this.rec(op);
  }
  ema(m: number, w: 8 | 21 | 55) {
    this.asm.ema(m, w);
    this.rec(Op.Ema);
  }
  ret(m: number, n: number) {
    this.asm.ret(m, n);
    this.rec(Op.Ret);
  }
  trade(op: Op.Long | Op.Short, m: number, bps: number) {
    if (op === Op.Long) this.asm.long(m, bps);
    else this.asm.short(m, bps);
    this.rec(op);
  }

  // ---------------------------------------------------------- values

  /** Numeric literal value in 6-dp fixed point, or null (error reported when `report`). */
  numValue(e: Extract<Expr, { k: "num" }>, report: boolean): bigint | null {
    const v = parseDecimal(e.text, e.pct ? 4 : 6);
    if (v === null) {
      if (report) this.error(e.pos, e.pct ? `${e.text}% is more precise than the VM's 6 decimals (at most 4 decimal places in a percent)` : `${e.text} has more than 6 decimal places (the VM uses 6-decimal fixed point)`);
      return null;
    }
    if (v > I64_MAX) {
      if (report) this.error(e.pos, `${e.text}${e.pct ? "%" : ""} is too large for the VM (limit about 9.2 trillion)`);
      return null;
    }
    return v;
  }

  /** Constant-fold with exact VM semantics. null when not a compile-time constant. */
  fold(e: Expr): bigint | null {
    switch (e.k) {
      case "num":
        return this.numValue(e, false);
      case "bool":
        return bool(e.value);
      case "neg": {
        const v = this.fold(e.e);
        return v === null ? null : fneg(v);
      }
      case "not": {
        const v = this.fold(e.e);
        return v === null ? null : bool(v === 0n);
      }
      case "bin": {
        const a = this.fold(e.a);
        if (a === null) return null;
        const b = this.fold(e.b);
        if (b === null) return null;
        return binConst(e.op, a, b);
      }
      default:
        return null;
    }
  }

  expr(e: Expr): void {
    const c = this.fold(e);
    if (c !== null) {
      this.push(c);
      return;
    }
    switch (e.k) {
      case "num":
        this.numValue(e, true);
        this.push(0n);
        return;
      case "bool":
        this.push(bool(e.value));
        return;
      case "var": {
        const slot = this.locals.get(e.name);
        if (slot !== undefined) {
          this.mld(slot);
          return;
        }
        const m = resolveMarket(e.name, this.markets);
        if (BUILTINS[e.name]) this.error(e.pos, `${e.name} is a function; call it as ${BUILTINS[e.name].sig}`);
        else if ("index" in m) this.error(e.pos, `${e.name} is a market, not a value; use price(${e.name}) for its mark price`);
        else {
          const guess = suggest(e.name, [...this.locals.keys()]);
          this.error(e.pos, `unknown variable ${e.name}${guess ? `; did you mean ${guess}?` : ""} (declare it with let ${e.name} = ...)`);
        }
        this.push(0n);
        return;
      }
      case "mem":
        this.mld(this.memIndex(e.index));
        return;
      case "neg":
        this.expr(e.e);
        this.op(Op.Neg);
        return;
      case "not":
        this.expr(e.e);
        this.op(Op.Not);
        return;
      case "bin":
        this.expr(e.a);
        this.expr(e.b);
        if ((e.op === "/" || e.op === "%") && this.fold(e.b) === 0n) this.error(e.pos, e.op === "/" ? "division by zero" : "modulo by zero");
        emitBin(this, e.op);
        return;
      case "call":
        this.call(e, false);
        return;
    }
  }

  memIndex(ix: Expr): number {
    const v = this.fold(ix);
    if (v === null || v % SCALE !== 0n || v < 0n || v >= BigInt(USER_MEM) * SCALE) {
      this.error(ix.pos, `mem index must be a whole number from 0 to ${USER_MEM - 1}${v !== null ? `, got ${formatFixed(v)}` : ""} (slots 8..15 hold let variables)`);
      return 0;
    }
    return Number(v / SCALE);
  }

  market(arg: Expr | undefined, fn: string): number {
    if (!arg) return 0;
    if (arg.k !== "var") {
      this.error(arg.pos, `the first argument of ${fn}() must be a market symbol such as ${this.marketHint()}`);
      return 0;
    }
    const r = resolveMarket(arg.name, this.markets);
    if ("error" in r) {
      this.error(arg.pos, r.error);
      return 0;
    }
    if (r.index >= MAX_MARKETS) {
      this.error(arg.pos, `market ${arg.name} is index ${r.index}; the VM addresses at most ${MAX_MARKETS} markets`);
      return 0;
    }
    return r.index;
  }

  marketHint(): string {
    const m = this.markets[0];
    return m ? m.toUpperCase().split(/[^A-Z0-9]/)[0] || m : "SOL";
  }

  intLiteral(arg: Expr): number | null {
    let v: bigint | null = null;
    if (arg.k === "num" && !arg.pct) v = this.numValue(arg, false);
    else if (arg.k !== "num") v = this.fold(arg);
    if (v === null || v % SCALE !== 0n) return null;
    const n = v / SCALE;
    return n >= -1_000_000n && n <= 1_000_000n ? Number(n) : null;
  }

  call(e: Extract<Expr, { k: "call" }>, statement: boolean): void {
    const b = BUILTINS[e.name];
    if (!b) {
      const lower = e.name.toLowerCase();
      const hit = BUILTINS[lower] ? lower : suggest(e.name, Object.keys(BUILTINS));
      this.error(e.pos, `unknown function ${e.name}${hit ? `; did you mean ${hit}?` : ""}`);
      if (!statement) this.push(0n);
      return;
    }
    if (b.action && !statement) {
      this.error(e.pos, `${e.name}() is an action and cannot be used inside an expression`);
      this.push(0n);
      return;
    }
    if (!b.action && statement) {
      this.error(e.pos, `${e.name}() returns a value and does nothing on its own; use it in an expression or let binding`);
      return;
    }
    if (e.args.length !== b.args.length) {
      const n = b.args.length;
      this.error(e.args.length > n ? e.args[n].pos : e.end, `${b.sig} takes ${n} argument${n === 1 ? "" : "s"}, got ${e.args.length}`);
      if (!statement) this.push(0n);
      return;
    }
    const a = e.args;
    switch (e.name) {
      case "price":
        return this.marketOp(Op.Price, this.market(a[0], e.name));
      case "vol":
        return this.marketOp(Op.Vol, this.market(a[0], e.name));
      case "pos":
        return this.marketOp(Op.Pos, this.market(a[0], e.name));
      case "entry":
        return this.marketOp(Op.Entry, this.market(a[0], e.name));
      case "ema": {
        const m = this.market(a[0], e.name);
        const w = this.intLiteral(a[1]);
        if (w === null || !(EMA_WINDOWS as readonly number[]).includes(w)) {
          this.error(a[1].pos, `EMA window must be 8, 21 or 55${w !== null ? `, got ${w}` : ""}`);
          return this.ema(m, 8);
        }
        return this.ema(m, w as 8 | 21 | 55);
      }
      case "ret": {
        const m = this.market(a[0], e.name);
        const n = this.intLiteral(a[1]);
        if (n === null || n < 1 || n > MAX_RET_LOOKBACK) {
          this.error(a[1].pos, `ret lookback must be a whole number of ticks from 1 to ${MAX_RET_LOOKBACK}${n !== null ? `, got ${n}` : ""}`);
          return this.ret(m, 1);
        }
        return this.ret(m, n);
      }
      case "equity":
        return this.op(Op.Equity);
      case "free":
        return this.op(Op.FreeMargin);
      case "tick":
        // The host reports the raw tick count; scale it so tick() is an ordinary number (tick() % 10 works).
        this.op(Op.Tick);
        this.push(1n);
        return this.op(Op.Div);
      case "rand":
        return this.op(Op.Rand);
      case "abs":
        this.expr(a[0]);
        return this.op(Op.Abs);
      case "min":
      case "max":
        this.expr(a[0]);
        this.expr(a[1]);
        return this.op(e.name === "min" ? Op.Min : Op.Max);
      case "long":
      case "short": {
        const m = this.market(a[0], e.name);
        const bps = this.size(a[1]);
        return this.trade(e.name === "long" ? Op.Long : Op.Short, m, bps);
      }
      case "close":
        return this.marketOp(Op.Close, this.market(a[0], e.name));
      case "close_all":
        return this.op(Op.CloseAll);
      case "halt":
        return this.op(Op.Halt);
    }
  }

  /** Position size: a percent literal 1%..100% -> bps. */
  size(arg: Expr): number {
    if (arg.k !== "num" || !arg.pct) {
      this.error(arg.pos, "position size must be a percent literal such as 30% (the share of buying power, 1% to 100%)");
      return 1;
    }
    const bps = parseDecimal(arg.text, 2);
    if (bps === null) {
      this.error(arg.pos, `position size ${arg.text}% is finer than 1 bps (use at most 2 decimal places)`);
      return 1;
    }
    if (bps < 100n || bps > 10_000n) {
      this.error(arg.pos, `position size must be between 1% and 100%, got ${arg.text}%`);
      return 1;
    }
    return Number(bps);
  }

  // ---------------------------------------------------------- statements

  jumpIfFalse(cond: Expr, target: string) {
    const c = this.fold(cond);
    if (c !== null) {
      if (c === 0n) this.jmp(target);
      return;
    }
    if (cond.k === "not") {
      this.expr(cond.e);
      this.jnz(target);
    } else if (cond.k === "bin" && cond.op === "!=") {
      this.expr(cond.a);
      this.expr(cond.b);
      this.op(Op.Eq);
      this.jnz(target);
    } else {
      this.expr(cond);
      this.jz(target);
    }
  }

  block(body: Stmt[]) {
    for (const s of body) this.stmt(s);
  }

  stmt(s: Stmt) {
    this.at = s.pos;
    switch (s.k) {
      case "let": {
        this.expr(s.e);
        let slot = this.locals.get(s.name);
        if (slot === undefined) {
          if (!s.decl) {
            this.error(s.namePos, `unknown variable ${s.name}; declare it first with let ${s.name} = ...`);
            slot = LOCAL_BASE;
          } else if (this.locals.size >= MAX_LOCALS) {
            this.error(s.namePos, `too many local variables: ${s.name} would be the ${this.locals.size + 1}th, but BXL has ${MAX_LOCALS} local slots (memory 8..15); reuse a name or use mem[0..7]`);
            slot = LOCAL_BASE;
          } else {
            slot = LOCAL_BASE + this.locals.size;
            this.locals.set(s.name, slot);
          }
        }
        this.mst(slot);
        return;
      }
      case "memset": {
        this.expr(s.e);
        this.mst(this.memIndex(s.index));
        return;
      }
      case "call":
        this.call(s.call, true);
        return;
      case "if": {
        const end = this.label();
        const last = s.arms.length - 1;
        s.arms.forEach((arm, i) => {
          this.at = arm.pos;
          const more = i < last || s.els !== null;
          const next = more ? this.label() : end;
          this.jumpIfFalse(arm.cond, next);
          this.block(arm.body);
          if (more) {
            if (!endsWithHalt(arm.body)) this.jmp(end, `; branch of line ${arm.pos.line} done: skip the rest of the if`);
            this.place(next);
          }
        });
        if (s.els) this.block(s.els);
        this.place(end);
        return;
      }
    }
  }
}

function endsWithHalt(body: Stmt[]): boolean {
  const s = body[body.length - 1];
  return !!s && s.k === "call" && s.call.name === "halt";
}

function binConst(op: BinOp, a: bigint, b: bigint): bigint | null {
  switch (op) {
    case "+":
      return fadd(a, b);
    case "-":
      return fsub(a, b);
    case "*":
      return fmul(a, b);
    case "/":
      return fdiv(a, b);
    case "%":
      return frem(a, b);
    case "<":
      return bool(a < b);
    case "<=":
      return bool(a <= b);
    case ">":
      return bool(a > b);
    case ">=":
      return bool(a >= b);
    case "==":
      return bool(a === b);
    case "!=":
      return bool(a !== b);
    case "and":
      return bool(a !== 0n && b !== 0n);
    case "or":
      return bool(a !== 0n || b !== 0n);
  }
}

function emitBin(g: Gen, op: BinOp) {
  const map: Record<Exclude<BinOp, "!=">, Op> = {
    "+": Op.Add,
    "-": Op.Sub,
    "*": Op.Mul,
    "/": Op.Div,
    "%": Op.Mod,
    "<": Op.Lt,
    "<=": Op.Le,
    ">": Op.Gt,
    ">=": Op.Ge,
    "==": Op.Eq,
    and: Op.And,
    or: Op.Or,
  };
  if (op === "!=") {
    g.op(Op.Eq);
    g.op(Op.Not);
  } else g.op(map[op]);
}

const fail = (errors: CompileError[], warnings: CompileError[] = []): CompileResult => ({
  ok: false,
  bytecode: new Uint8Array(0),
  errors: errors.sort((a, b) => a.line - b.line || a.col - b.col),
  listing: "",
  maxSteps: 0,
  warnings,
});

/** Compile BXL source to bxvm bytecode for a round with `opts.markets`. */
export function compile(source: string, opts: CompileOptions): CompileResult {
  const markets = opts?.markets ?? [];
  let program;
  try {
    program = parse(source);
  } catch (e) {
    if (e instanceof BxlSyntaxError) return fail([{ line: e.line, col: e.col, message: e.message }]);
    throw e;
  }
  const g = new Gen(markets);
  if (markets.length === 0) g.error({ line: 1, col: 1 }, "no markets given (CompileOptions.markets is empty)");
  for (const s of program.body) g.stmt(s);
  g.at = { line: source.split("\n").length + 1, col: 1 };
  g.op(Op.Halt);
  if (g.errors.length) return fail(g.errors);

  // Size check before assembling (Asm.build throws past the limit).
  let off = 0;
  for (const r of g.recs) {
    if (1 + off + r.size > MAX_BYTECODE_LEN) {
      const total = 1 + g.recs.reduce((s, x) => s + x.size, 0);
      return fail([{ line: r.pos.line, col: r.pos.col, message: `program compiles to ${total} bytes of bytecode; the limit is ${MAX_BYTECODE_LEN} (it passes the limit at this statement)` }]);
    }
    off += r.size;
  }
  const bytecode = g.asm.build();
  const bad = validate(bytecode, Math.min(markets.length, MAX_MARKETS));
  if (bad) return fail([{ line: 1, col: 1, message: `internal compiler error: generated bytecode failed validation (${bad})` }]);

  // Source map: code offset -> statement position.
  const posAt = new Map<number, Pos>();
  const notes = new Map<number, string>();
  off = 0;
  for (const r of g.recs) {
    posAt.set(off, r.pos);
    if (r.note) notes.set(off, r.note);
    off += r.size;
  }

  const an = analyze(bytecode);
  const errors: CompileError[] = [];
  if (an.maxActions > ACTIONS_PER_TICK) {
    const p = posAt.get(an.actionPath[ACTIONS_PER_TICK]) ?? { line: 1, col: 1 };
    errors.push({ line: p.line, col: p.col, message: `one tick can emit at most ${ACTIONS_PER_TICK} actions, but a path through this program emits ${an.maxActions} (the VM would fault with TooManyActions and trade nothing)` });
  }
  if (an.maxStack > STACK_DEPTH) errors.push({ line: 1, col: 1, message: `an expression needs ${an.maxStack} stack entries; the VM has ${STACK_DEPTH}` });
  if (errors.length) return fail(errors);

  const warnings: CompileError[] = [];
  if (an.maxSteps > DEFAULT_STEP_LIMIT) {
    warnings.push({ line: 1, col: 1, message: `worst-case path is ${an.maxSteps} VM steps; rounds typically allow ${DEFAULT_STEP_LIMIT} per tick, and a run that hits the limit faults (no trades that tick)` });
  }

  const srcLines = source.split("\n");
  const comments = new Map<number, string>();
  let lastLine = -1;
  for (const [o, p] of posAt) {
    const note = notes.get(o);
    if (note) {
      comments.set(o, note);
      continue;
    }
    if (p.line !== lastLine) {
      comments.set(o, p.line > srcLines.length ? "; end of program" : `; ${p.line}: ${srcLines[p.line - 1].trim()}`);
      lastLine = p.line;
    }
  }
  return { ok: true, bytecode, errors: [], listing: formatListing(bytecode, comments), maxSteps: an.maxSteps, warnings };
}
