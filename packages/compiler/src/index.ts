/**
 * @blackbox/compiler — the BLACKBOX strategy language (BXL).
 *
 * PUBLIC API CONTRACT (other packages depend on these exact signatures):
 *   compile(source, opts)  -> CompileResult
 *   simulate(bytecode, series, opts) -> SimResult
 *   formatListing(bytecode) -> string
 *   EXAMPLES: Record<string, string>   (named example programs in BXL)
 *
 * The implementation lives in ./lexer, ./parser, ./codegen, ./sim (with the VM
 * port in ./interp and the perps engine port in ./perps).
 *
 * BXL LANGUAGE REFERENCE
 *   # comment                      line comments
 *   let x = EXPR                   local variable (VM memory slots 8..15; at most 8 distinct names)
 *   x = EXPR                       reassign a declared local
 *   mem[I] = EXPR / mem[I]         persistent memory, I in 0..7, survives across ticks (starts at 0)
 *   if C { ... } elif C { ... } else { ... }
 *   long(M, P) / short(M, P)       target a position of P of buying power on market M
 *                                  (P is a percent literal 1%..100%; buying power = equity x max leverage).
 *                                  Only changes the book when the target differs from the current leg.
 *   close(M) / close_all()         flatten one market / every market
 *   halt()                         stop this tick's run (actions already emitted still apply)
 *   Markets: symbols from opts.markets, case-insensitive; "SOL" also matches "SOL-PERP" / "SOL/USD".
 *   Numbers: decimals in 6-dp fixed point (1.5). A percent literal inside an expression is a
 *     fraction (0.05% == 0.0005). true == 1, false == 0; comparisons yield 1 or 0.
 *   Operators: + - * / % (fixed-point), unary -, < <= > >= == !=, and or not (also && || !).
 *     and/or evaluate both sides (no short circuit). Division by zero faults the tick (no trades).
 *   Functions: price(M) mark price in USD; ema(M, 8|21|55); ret(M, N) return over N ticks
 *     (N in 1..64, a fraction: 0.01 == 1%); vol(M) realized vol (fraction); pos(M) signed position
 *     notional in USD (+long, -short, 0 flat); entry(M) entry price (0 if flat); equity(); free()
 *     free margin; tick() tick number; rand() uniform in [0, 1); abs(x) min(a, b) max(a, b).
 *   A run faults (and emits nothing) on stack/step/data errors; at most 8 actions per tick.
 */
export interface CompileOptions {
  /** Market symbols in round order, e.g. ["SOL", "BTC", "ETH"]. Case-insensitive in source. */
  markets: string[];
}

export interface CompileError {
  line: number;
  col: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  /** Version byte + code, ready for `set_strategy`. Empty when !ok. */
  bytecode: Uint8Array;
  errors: CompileError[];
  /** Human-readable disassembly with offsets. */
  listing: string;
  /** Static worst-case VM step estimate (straight-line path upper bound). */
  maxSteps: number;
  /** Non-fatal notes (e.g. worst-case steps above the usual 512 step limit). */
  warnings?: CompileError[];
}

/** One tick of market data for simulation. Prices are plain numbers (USD). */
export interface SimTick {
  prices: number[];
}

export interface SimOptions {
  markets: string[];
  /** Starting margin in USD. Default 100. */
  margin?: number;
  /** Max leverage per market. Default 20. */
  maxLeverage?: number[];
  /** Maintenance margin in bps per market. Default 300. */
  maintenanceBps?: number[];
  /** Base spread in bps. Default 2. */
  spreadBps?: number;
  stepLimit?: number;
  /** Deterministic seed for RAND. */
  seed?: number;
  /** Extra spread in bps at full skew. Default 25 (the local round's setting). */
  skewSpreadBps?: number;
  /** Open-interest cap per side in USD. Default 5,000,000. */
  oiCap?: number;
  /** Record a per-tick trace (actions, steps, faults) in `SimResult.trace`. */
  trace?: boolean;
}

export interface SimTraceEntry {
  tick: number;
  /** Actions the VM emitted this tick, e.g. "long m0 3000bps" (empty on a fault). */
  actions: string[];
  steps: number;
  fault: string | null;
  equity: number;
  liquidated: boolean;
  /** True when the tick was skipped because a price was missing or non-positive. */
  skipped?: boolean;
}

export interface SimResult {
  equity: number[];
  trades: number;
  liquidated: boolean;
  faults: { tick: number; fault: string; pc: number }[];
  finalEquity: number;
  /** Largest peak-to-trough fall as a fraction of the peak (0.25 == 25%). */
  maxDrawdown: number;
  sharpe: number;
  /** Final persistent memory (16 slots) as plain numbers. */
  mem?: number[];
  /** Present when `SimOptions.trace` is set. */
  trace?: SimTraceEntry[];
}

export { compile, formatListing, analyze, resolveMarket } from "./codegen";
export type { Analysis } from "./codegen";
export { simulate, curveStats } from "./sim";
export { EXAMPLES } from "./examples";
export { execute, faultName, formatAction, FAULTS } from "./interp";
export type { Action, ExecResult, Fault, VmHost } from "./interp";
