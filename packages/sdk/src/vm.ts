/**
 * TypeScript mirror of the `bxvm` crate: opcodes, encoding, a label-aware
 * assembler, a disassembler, and a static validator. Byte-for-byte identical
 * to crates/bxvm/src/{ops,asm}.rs; tests in packages/sdk/test pin the encoding.
 */

export const BYTECODE_VERSION = 1;
export const MAX_BYTECODE_LEN = 4096;
export const MEM_SLOTS = 16;
export const MAX_MARKETS = 8;
export const EMA_WINDOWS = [8, 21, 55] as const;
export const MAX_RET_LOOKBACK = 64;
export const SCALE = 1_000_000n;

export enum Op {
  Nop = 0,
  Halt = 1,
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
  Jmp = 20,
  Jz = 21,
  Jnz = 22,
  Price = 23,
  Ema = 24,
  Ret = 25,
  Vol = 26,
  Pos = 27,
  Entry = 28,
  Equity = 29,
  FreeMargin = 30,
  Tick = 31,
  Rand = 32,
  Mld = 33,
  Mst = 34,
  Long = 35,
  Short = 36,
  Close = 37,
  CloseAll = 38,
  Le = 39,
  Ge = 40,
  Mod = 41,
}

export function operandLen(op: Op): number {
  switch (op) {
    case Op.Push:
      return 8;
    case Op.Jmp:
    case Op.Jz:
    case Op.Jnz:
      return 2;
    case Op.Price:
    case Op.Vol:
    case Op.Pos:
    case Op.Entry:
    case Op.Close:
    case Op.Mld:
    case Op.Mst:
      return 1;
    case Op.Ema:
    case Op.Ret:
      return 2;
    case Op.Long:
    case Op.Short:
      return 3;
    default:
      return 0;
  }
}

export type Instr =
  | { op: Op.Push; value: bigint }
  | { op: Op.Jmp | Op.Jz | Op.Jnz; target: number | string }
  | { op: Op.Price | Op.Vol | Op.Pos | Op.Entry | Op.Close; market: number }
  | { op: Op.Ema; market: number; window: number }
  | { op: Op.Ret; market: number; lookback: number }
  | { op: Op.Mld | Op.Mst; slot: number }
  | { op: Op.Long | Op.Short; market: number; bps: number }
  | { op: Exclude<Op, Op.Push | Op.Jmp | Op.Jz | Op.Jnz | Op.Price | Op.Vol | Op.Pos | Op.Entry | Op.Close | Op.Ema | Op.Ret | Op.Mld | Op.Mst | Op.Long | Op.Short> };

/** Fixed-point helper: 1.5 -> 1_500_000n. */
export function fx(v: number): bigint {
  return BigInt(Math.round(v * 1_000_000));
}

/**
 * Label-aware assembler. Build a program with the fluent API, then `build()`
 * returns the bytecode blob (version byte + code).
 */
export class Asm {
  private items: (Instr | { label: string })[] = [];

  label(name: string) { this.items.push({ label: name }); return this; }
  push(v: bigint | number) { this.items.push({ op: Op.Push, value: typeof v === "number" ? BigInt(v) : v }); return this; }
  pushFx(v: number) { return this.push(fx(v)); }
  op(op: Op) { this.items.push({ op } as Instr); return this; }
  jmp(t: string) { this.items.push({ op: Op.Jmp, target: t }); return this; }
  jz(t: string) { this.items.push({ op: Op.Jz, target: t }); return this; }
  jnz(t: string) { this.items.push({ op: Op.Jnz, target: t }); return this; }
  price(m: number) { this.items.push({ op: Op.Price, market: m }); return this; }
  ema(m: number, window: 8 | 21 | 55) { this.items.push({ op: Op.Ema, market: m, window: EMA_WINDOWS.indexOf(window) }); return this; }
  ret(m: number, lookback: number) { this.items.push({ op: Op.Ret, market: m, lookback }); return this; }
  vol(m: number) { this.items.push({ op: Op.Vol, market: m }); return this; }
  pos(m: number) { this.items.push({ op: Op.Pos, market: m }); return this; }
  entry(m: number) { this.items.push({ op: Op.Entry, market: m }); return this; }
  mld(s: number) { this.items.push({ op: Op.Mld, slot: s }); return this; }
  mst(s: number) { this.items.push({ op: Op.Mst, slot: s }); return this; }
  long(m: number, bps: number) { this.items.push({ op: Op.Long, market: m, bps }); return this; }
  short(m: number, bps: number) { this.items.push({ op: Op.Short, market: m, bps }); return this; }
  close(m: number) { this.items.push({ op: Op.Close, market: m }); return this; }
  closeAll() { return this.op(Op.CloseAll); }
  halt() { return this.op(Op.Halt); }
  add() { return this.op(Op.Add); }
  sub() { return this.op(Op.Sub); }
  mul() { return this.op(Op.Mul); }
  div() { return this.op(Op.Div); }
  lt() { return this.op(Op.Lt); }
  gt() { return this.op(Op.Gt); }
  le() { return this.op(Op.Le); }
  ge() { return this.op(Op.Ge); }
  eq() { return this.op(Op.Eq); }
  and() { return this.op(Op.And); }
  or() { return this.op(Op.Or); }
  not() { return this.op(Op.Not); }
  abs() { return this.op(Op.Abs); }
  neg() { return this.op(Op.Neg); }
  dup() { return this.op(Op.Dup); }
  swap() { return this.op(Op.Swap); }
  pop() { return this.op(Op.Pop); }
  rand() { return this.op(Op.Rand); }
  tick() { return this.op(Op.Tick); }
  equity() { return this.op(Op.Equity); }
  freeMargin() { return this.op(Op.FreeMargin); }

  instructions(): Instr[] {
    return this.items.filter((i): i is Instr => !("label" in i));
  }

  build(): Uint8Array {
    // pass 1: offsets
    const labels = new Map<string, number>();
    let off = 0;
    for (const it of this.items) {
      if ("label" in it) {
        if (labels.has(it.label)) throw new Error(`duplicate label ${it.label}`);
        labels.set(it.label, off);
      } else {
        off += 1 + operandLen(it.op);
      }
    }
    const out = new Uint8Array(1 + off);
    out[0] = BYTECODE_VERSION;
    const dv = new DataView(out.buffer);
    let p = 1;
    for (const it of this.items) {
      if ("label" in it) continue;
      out[p] = it.op;
      const o = p + 1;
      switch (it.op) {
        case Op.Push:
          dv.setBigInt64(o, (it as any).value, true);
          break;
        case Op.Jmp:
        case Op.Jz:
        case Op.Jnz: {
          const t = (it as any).target;
          const target = typeof t === "string" ? labels.get(t) : t;
          if (target === undefined) throw new Error(`unknown label ${t}`);
          dv.setUint16(o, target, true);
          break;
        }
        case Op.Price:
        case Op.Vol:
        case Op.Pos:
        case Op.Entry:
        case Op.Close:
          out[o] = (it as any).market;
          break;
        case Op.Ema:
          out[o] = (it as any).market;
          out[o + 1] = (it as any).window;
          break;
        case Op.Ret:
          out[o] = (it as any).market;
          out[o + 1] = (it as any).lookback;
          break;
        case Op.Mld:
        case Op.Mst:
          out[o] = (it as any).slot;
          break;
        case Op.Long:
        case Op.Short:
          out[o] = (it as any).market;
          dv.setUint16(o + 1, (it as any).bps, true);
          break;
      }
      p += 1 + operandLen(it.op);
    }
    if (out.length > MAX_BYTECODE_LEN) throw new Error(`bytecode too long: ${out.length}`);
    return out;
  }
}

/** Decode a blob into `[offset, text]` lines (the "authenticated read" view). */
export function disassemble(bytes: Uint8Array): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  if (bytes.length === 0 || bytes[0] !== BYTECODE_VERSION) return out;
  const code = bytes.subarray(1);
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] as Op;
    if (Op[op] === undefined) break;
    const n = operandLen(op);
    if (pc + 1 + n > code.length) break;
    const o = pc + 1;
    let text = Op[op].toLowerCase();
    switch (op) {
      case Op.Push: {
        const v = dv.getBigInt64(o, true);
        const f = Number(v) / 1e6;
        text = `push ${v}${Math.abs(f) >= 0.000001 && v % 1000n === 0n ? `  ; ${f}` : ""}`;
        break;
      }
      case Op.Jmp:
      case Op.Jz:
      case Op.Jnz:
        text += ` @${dv.getUint16(o, true)}`;
        break;
      case Op.Price:
      case Op.Vol:
      case Op.Pos:
      case Op.Entry:
      case Op.Close:
        text += ` m${code[o]}`;
        break;
      case Op.Ema:
        text += ` m${code[o]} w${EMA_WINDOWS[code[o + 1]] ?? "?"}`;
        break;
      case Op.Ret:
        text += ` m${code[o]} n${code[o + 1]}`;
        break;
      case Op.Mld:
      case Op.Mst:
        text += ` ${code[o]}`;
        break;
      case Op.Long:
      case Op.Short:
        text += ` m${code[o]} ${dv.getUint16(o + 1, true)}bps`;
        break;
    }
    out.push({ offset: pc, text });
    pc += 1 + n;
  }
  return out;
}

/** Static validation mirroring `bxvm::validate`. Returns null when valid. */
export function validate(bytes: Uint8Array, nMarkets: number): string | null {
  if (bytes.length === 0) return "empty";
  if (bytes.length > MAX_BYTECODE_LEN) return "too long";
  if (bytes[0] !== BYTECODE_VERSION) return `bad version ${bytes[0]}`;
  const code = bytes.subarray(1);
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const boundaries = new Set<number>();
  const jumps: [number, number][] = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] as Op;
    if (Op[op] === undefined) return `bad opcode ${code[pc]} at ${pc}`;
    const n = operandLen(op);
    if (pc + 1 + n > code.length) return `truncated at ${pc}`;
    boundaries.add(pc);
    const o = pc + 1;
    const market = () => code[o];
    switch (op) {
      case Op.Price: case Op.Vol: case Op.Pos: case Op.Entry: case Op.Close:
        if (market() >= nMarkets) return `bad market ${market()} at ${pc}`;
        break;
      case Op.Ema:
        if (market() >= nMarkets) return `bad market ${market()} at ${pc}`;
        if (code[o + 1] >= EMA_WINDOWS.length) return `bad ema window at ${pc}`;
        break;
      case Op.Ret:
        if (market() >= nMarkets) return `bad market ${market()} at ${pc}`;
        if (code[o + 1] === 0 || code[o + 1] > MAX_RET_LOOKBACK) return `bad lookback at ${pc}`;
        break;
      case Op.Mld: case Op.Mst:
        if (code[o] >= MEM_SLOTS) return `bad mem slot at ${pc}`;
        break;
      case Op.Long: case Op.Short: {
        if (market() >= nMarkets) return `bad market ${market()} at ${pc}`;
        const bps = dv.getUint16(o + 1, true);
        if (bps === 0 || bps > 10_000) return `bad size ${bps} at ${pc}`;
        break;
      }
      case Op.Jmp: case Op.Jz: case Op.Jnz:
        jumps.push([pc, dv.getUint16(o, true)]);
        break;
    }
    pc += 1 + n;
  }
  for (const [at, t] of jumps) if (t !== code.length && !boundaries.has(t)) return `bad jump target ${t} at ${at}`;
  return null;
}
