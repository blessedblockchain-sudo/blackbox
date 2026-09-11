/**
 * Thin, failure-tolerant wrappers around @blackbox/compiler (BXL) and the
 * SDK's built-in assembler strategies. Every call goes through the compiler's
 * exported signatures only, so the server keeps working (with clear errors)
 * if the compiler is unavailable or throws.
 */
import * as compiler from "@blackbox/compiler";
import type { CompileError, SimOptions, SimResult, SimTick } from "@blackbox/compiler";
import { disassemble, strategies, validate } from "@blackbox/sdk";
import { createHash } from "crypto";

export interface CompileOutcome {
  ok: boolean;
  bytecode: Uint8Array;
  errors: CompileError[];
  listing: string;
  maxSteps: number;
  size: number;
}

/** "0000  ema m0 w8" lines from the SDK disassembler. */
export function sdkListing(bytecode: Uint8Array): string {
  return disassemble(bytecode)
    .map((l) => `${String(l.offset).padStart(4, "0")}  ${l.text}`)
    .join("\n");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export function compileBxl(source: string, markets: string[]): CompileOutcome {
  let res: compiler.CompileResult;
  try {
    res = compiler.compile(source, { markets });
  } catch (e) {
    return { ok: false, bytecode: new Uint8Array(), errors: [{ line: 0, col: 0, message: `compiler failed: ${(e as Error)?.message ?? String(e)}` }], listing: "", maxSteps: 0, size: 0 };
  }
  const bytecode = res.bytecode instanceof Uint8Array ? res.bytecode : Uint8Array.from(res.bytecode ?? []);
  const errors = [...(res.errors ?? [])];
  let ok = !!res.ok && errors.length === 0 && bytecode.length > 0;
  if (ok) {
    // Belt and braces: the program rejects anything the VM validator rejects.
    const v = validate(bytecode, markets.length);
    if (v) {
      ok = false;
      errors.push({ line: 0, col: 0, message: `bytecode failed VM validation: ${v}` });
    }
  }
  let listing = res.listing ?? "";
  if (ok && !listing) listing = sdkListing(bytecode);
  return { ok, bytecode: ok ? bytecode : new Uint8Array(), errors, listing, maxSteps: res.maxSteps ?? 0, size: ok ? bytecode.length : 0 };
}

export function formatErrors(errors: CompileError[]): string {
  return errors.map((e) => (e.line ? `line ${e.line}:${e.col} ${e.message}` : e.message)).join("\n");
}

export function simulateBytecode(bytecode: Uint8Array, series: SimTick[], opts: SimOptions): SimResult {
  try {
    return compiler.simulate(bytecode, series, opts);
  } catch (e) {
    throw new Error(`simulator failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

export function examples(): Record<string, string> {
  try {
    const ex = compiler.EXAMPLES;
    return ex && typeof ex === "object" ? { ...ex } : {};
  } catch {
    return {};
  }
}

export const BUILTIN_NAMES = ["momentum", "meanReversion", "breakout", "randomWalk", "alwaysLong", "degen"] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/** Built-in assembler strategy from the SDK (same bots the round runner uses). */
export function builtinBytecode(name: BuiltinName, market: number): Uint8Array {
  const f = strategies.BUILTIN_STRATEGIES[name];
  if (!f) throw new Error(`Unknown builtin "${name}". Options: ${BUILTIN_NAMES.join(", ")}`);
  return f(market);
}

export const BXL_REFERENCE = `# BXL: the BLACKBOX strategy language

A BXL program runs once per round tick inside the TEE, for your entrant only.
It reads market data and your own position, then emits target exposures.
Everything is deterministic 6-decimal fixed point (1.0 = 1_000_000 internally).

## Syntax
- Line comments start with \`#\`. One statement per line. Blocks use braces.
- \`let NAME = EXPR\` declares a local (at most 8 distinct locals; they live in VM slots 8..15 and are recomputed each tick).
- \`mem[I] = EXPR\` and \`mem[I]\` (I in 0..7) are persistent across ticks (counters, cooldowns, peak equity).
- \`if COND { ... } elif COND { ... } else { ... }\`

## Actions
- \`long(M, P)\`, \`short(M, P)\`: target an exposure of P of buying power on market M.
  P is a percent literal 1%..100%. Buying power = equity x the market's max leverage,
  so \`long(SOL, 30%)\` on a 20x market targets 6x equity notional.
  Actions only trade when the target differs from the current leg.
- \`close(M)\`, \`close_all()\`, \`halt()\`.
- M is a market symbol of the round (e.g. SOL, BTC, ETH), case-insensitive.

## Expressions
- \`+ - * / %\`, unary \`-\`, comparisons \`< <= > >= == !=\`, \`and or not\`, parentheses.
- Numbers are decimals (1.5). A percent literal inside an expression is a fraction (0.05% == 0.0005).
- \`and\`/\`or\` do not short-circuit.

## Functions
- \`price(M)\` current mark (USD). \`ema(M, 8|21|55)\` EMA of the mark. \`ret(M, N)\` return over N ticks (N in 1..64) as a fraction.
- \`vol(M)\` realized volatility (fraction). \`pos(M)\` your signed notional on M in USDC (> 0 long, < 0 short, 0 flat). \`entry(M)\` your entry price.
- \`equity()\` your equity (USDC). \`free()\` free margin. \`tick()\` the round tick. \`rand()\` VRF-seeded pseudo-random in [0, 1).
- \`abs(x) min(a, b) max(a, b)\`.

## Runtime rules
- Step limit per tick (round.step_limit, usually 512). A fault (step limit, div by zero, bad market...) discards all actions of that tick.
- Leverage is checked only when exposure grows. Positions below maintenance margin are liquidated.
- Your Strategy and Position accounts are private: only your wallet's TEE token can read them.

## Example: EMA trend follower on SOL
\`\`\`
# long when the fast EMA is above the slow EMA, short otherwise
if ema(SOL, 8) > ema(SOL, 21) {
  if pos(SOL) <= 0 { long(SOL, 30%) }
} else {
  if pos(SOL) >= 0 { short(SOL, 30%) }
}
\`\`\`
`;

export function referenceWithExamples(): string {
  const ex = examples();
  const names = Object.keys(ex);
  if (!names.length) return BXL_REFERENCE;
  return `${BXL_REFERENCE}\n## More examples (from @blackbox/compiler)\n${names.map((n) => `\n### ${n}\n\`\`\`\n${ex[n].trim()}\n\`\`\``).join("\n")}\n`;
}
