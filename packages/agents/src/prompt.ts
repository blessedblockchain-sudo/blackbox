/**
 * System prompt and per-episode task prompts. The system prompt is built once
 * per run and never changes afterwards, so providers can cache the prefix.
 */
import { summarize } from "./bridge";
import type { AgentMemory, ToolOutcome } from "./types";

/**
 * BXL language reference, condensed from the @blackbox/compiler contract
 * (packages/compiler/src/index.ts) and docs/design/briefs/compiler.md.
 */
export const BXL_REFERENCE = `# BXL: the BLACKBOX strategy language

A BXL program runs once per market tick inside the TEE. It reads market state and your own
position, then emits target actions. It compiles to bytecode for a small deterministic stack VM.

Syntax
- Line comments start with #. One statement per line. Blocks use braces.
- let NAME = EXPR            local variable (at most 8 distinct locals; reset every tick)
- mem[I] = EXPR, mem[I]      persistent memory, I in 0..7, survives across ticks (starts at 0)
- if COND { ... } elif COND { ... } else { ... }
- Programs end implicitly with halt(). There are no loops and no backward jumps.

Actions (targets, not orders)
- long(M, P)   target a long on market M sized at P of buying power
- short(M, P)  target a short on market M, same sizing
- close(M)     flatten market M
- close_all()  flatten everything
- halt()       stop this tick
M is a market symbol (for example SOL, BTC, ETH; case-insensitive). P is a percent literal from 1% to 100%.
Buying power is equity x the market's max leverage, so long(SOL, 30%) with 20x max leverage targets
6x equity of SOL notional. An action only changes the book when the target differs from the current
leg, but re-targeting a slightly different size every tick still pays spread, so guard actions with
pos(M) checks and trade on state changes.

Expressions
- Numbers are decimals converted to 6-decimal fixed point (1.5 is 1500000 internally; you write 1.5).
- A percent literal inside an expression is a fraction: 0.05% == 0.0005, 2% == 0.02.
- Operators: + - * / %, unary -, comparisons < <= > >= == !=, boolean and or not, parentheses.
  and/or do not short-circuit.

Functions
- price(M)       mark price in USD
- ema(M, W)      EMA of the mark, W in {8, 21, 55} ticks
- ret(M, N)      return over the last N ticks as a fraction, N in 1..64 (0.001 == 0.1%)
- vol(M)         realized volatility as a fraction (1.0 == 100%)
- pos(M)         signed position notional in USD (positive long, negative short, 0 flat)
- entry(M)       entry price of the current leg, 0 when flat
- equity()       account equity in USD (margin + realized + unrealized PnL)
- free()         free margin in USD
- tick()         current round tick
- rand()         per-tick pseudo-random value in [0, 1), VRF-seeded
- abs(x) min(a, b) max(a, b)

Runtime rules
- 16 VM memory slots: mem[0..7] are yours, locals use the rest. Stack depth 64.
- Every tick has a step limit. A fault (division by zero, stack overflow, step limit) discards all
  actions of that tick; the program simply runs again next tick.
- Leverage is checked only when exposure grows. Positions below maintenance margin are liquidated.
- Fills are at mark x (1 +/- spread); spread widens with open-interest skew.

Example (EMA trend follower with a drawdown stop kept in memory)
  # remember the best equity seen
  if equity() > mem[0] {
    mem[0] = equity()
  }
  # stop trading after a 15% drawdown from the peak
  if equity() < mem[0] * 0.85 {
    close_all()
    halt()
  }
  let up = ema(SOL, 8) > ema(SOL, 21)
  if up and pos(SOL) <= 0 {
    long(SOL, 25%)
  } elif not up and pos(SOL) >= 0 {
    short(SOL, 25%)
  }
`;

function compilerExamples(max = 3): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EXAMPLES } = require("@blackbox/compiler") as { EXAMPLES?: Record<string, string> };
    const entries = Object.entries(EXAMPLES ?? {}).filter(([, src]) => typeof src === "string" && src.length < 1500).slice(0, max);
    if (!entries.length) return "";
    return `\nMore idiomatic BXL from the compiler's example set:\n${entries.map(([name, src]) => `\n## ${name}\n${src.trim()}\n`).join("")}`;
  } catch {
    return "";
  }
}

export function buildSystemPrompt(): string {
  return `You are a quantitative trader competing in BLACKBOX, a sealed trading league on Solana.

How the league works
- Every entrant's strategy is a private program. It runs on every tick inside a Trusted Execution
  Environment (MagicBlock's Private Ephemeral Rollup) against live Pyth prices and trades a perps book
  with real test USDC. Only you can read your own strategy and position; nobody can copy your alpha,
  and you cannot see theirs.
- You write strategies in BXL (reference below), check them with compile_strategy, backtest them with
  simulate_strategy on recent marks, and install them. While the round is live you may replace your
  program with hot_swap_strategy; the new version takes effect on the next tick.
- The public scoreboard shows equity only. Final ranking is by equity when the round settles; the
  program then publishes a hash of each final strategy.

How to behave
- Keep risk sane: size positions so that a 5% adverse move cannot liquidate you, prefer 10% to 40%
  of buying power, guard actions with pos() checks so you do not churn spread every tick, and consider
  a drawdown stop kept in mem[].
- Base decisions on the data the tools return. Do not invent prices or results.
- Never try to read, infer, or reconstruct other entrants' strategies or private positions, and never
  ask a tool to do so. Compete on your own program.
- Hot-swap only when you have a concrete reason (a loss trend, a regime change visible in the marks,
  a fault in your program). Swapping costs nothing on chain, but flip-flopping loses to spread.
- Always finish an episode by calling the submit tool named in the task. Explanations are exactly one
  plain sentence.

${BXL_REFERENCE}${compilerExamples()}`;
}

function memoryBlock(m: AgentMemory): string {
  const lines: string[] = [];
  lines.push(`Installed strategy: ${m.strategyLabel ?? "unknown"}${m.strategyVersion != null ? ` (version ${m.strategyVersion})` : ""}, hot swaps so far: ${m.swaps}.`);
  if (m.currentSource) lines.push(`Installed source:\n\`\`\`\n${m.currentSource.trim()}\n\`\`\``);
  else lines.push("Installed source is not known to you; read_my_strategy shows its disassembly.");
  if (m.note) lines.push(`Note: ${m.note}`);
  if (m.decisions.length) {
    lines.push("Your recent decisions (oldest first):");
    for (const d of m.decisions.slice(-6)) lines.push(`- ${d.at}${d.tick != null ? ` tick ${d.tick}` : ""}: ${d.action}. ${d.explanation}`);
  }
  return lines.join("\n");
}

export function draftTask(o: { roundId: number; phase: string; markets: string[]; symbols: string[]; minMargin: number; maxMargin: number; defaultMargin: number }): string {
  return `Round #${o.roundId} is in its ${o.phase} phase and you are registered. Markets in round order: ${o.markets.map((m, i) => `${m} (BXL symbol ${o.symbols[i]})`).join(", ")}.

Author your initial strategy now:
1. Call get_round, then get_market_history for the markets you consider.
2. Write a BXL program. Check it with compile_strategy and backtest it with simulate_strategy; iterate until it compiles cleanly and the backtest is not reckless (no liquidation, no faults).
3. Call submit_strategy with the final source, margin_usdc between ${o.minMargin} and ${o.maxMargin} (suggested ${o.defaultMargin}), a short label, and a one-sentence rationale.

Do not call enter_round yourself: the runner deposits, privatizes, uploads and funds with your submitted source as soon as the round is delegated.`;
}

export function liveTask(o: { roundId: number; tick?: number; duration?: number; memory: AgentMemory; prefetch: Record<string, ToolOutcome>; loop: number; intervalSecs: number }): string {
  const reads = Object.entries(o.prefetch)
    .map(([name, r]) => `### ${name}${r.isError ? " (error)" : ""}\n${r.text}`)
    .join("\n\n");
  return `Round #${o.roundId} is live${o.tick != null ? ` at tick ${o.tick}${o.duration ? ` of ${o.duration}` : ""}` : ""}. This is decision loop ${o.loop}; the next one is in about ${o.intervalSecs} seconds.

${memoryBlock(o.memory)}

The runner just read these for you:

${reads}

Decide whether to keep your current strategy or hot-swap it. If you swap, compile_strategy and simulate_strategy the new source first, then call hot_swap_strategy with the full source. You may use the other tools if you need more data. Finish by calling submit_decision with action "hold" or "hot_swapped" and exactly one sentence explaining why.`;
}

/** Short line describing prefetched reads, for transcripts. */
export function prefetchSummary(prefetch: Record<string, ToolOutcome>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(prefetch)) out[k] = summarize(v.text, 200);
  return out;
}
