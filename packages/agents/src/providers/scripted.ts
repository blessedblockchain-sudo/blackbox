/**
 * Scripted brain: a deterministic agent that exercises the same MCP tools as
 * the LLM brains, so the demo runs with no API keys. It enters with an EMA
 * trend follower, then hot-swaps once to mean reversion after its position
 * shows a loss.
 */
import { isLosing, positionView } from "../extract";
import { meanReversionBxl, momentumBxl } from "../strategies";
import type { Brain, EpisodeRequest, EpisodeResult, JsonSchema, Toolbox } from "../types";

/** Pick the right `market` argument for get_market_history from its schema: index, name, or symbol. */
export function marketArg(toolbox: Toolbox, tool: string, index: number, names: string[], symbols: string[]): string | number {
  const spec = toolbox.specs.find((s) => s.name === tool);
  const props = (spec?.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const m = props.market ?? {};
  const types = ([] as unknown[]).concat(m.type ?? []);
  if (types.includes("integer") || types.includes("number")) return index;
  const variants = (Array.isArray(m.anyOf) ? m.anyOf : Array.isArray(m.oneOf) ? m.oneOf : []) as JsonSchema[];
  if (!types.includes("string") && variants.some((v) => v.type === "integer" || v.type === "number")) return index;
  const en = Array.isArray(m.enum) ? (m.enum as unknown[]) : [];
  if (en.includes(names[index])) return names[index];
  if (en.includes(symbols[index])) return symbols[index];
  return symbols[index];
}

export class ScriptedBrain implements Brain {
  readonly provider = "scripted";
  readonly model = "deterministic";

  constructor(private readonly opts: { marketIndex?: number } = {}) {}

  async runEpisode(req: EpisodeRequest, toolbox: Toolbox): Promise<EpisodeResult> {
    return req.kind === "draft" ? this.draft(req, toolbox) : this.live(req, toolbox);
  }

  private async draft(req: EpisodeRequest, toolbox: Toolbox): Promise<EpisodeResult> {
    const { symbols, markets } = req.context;
    const i = Math.min(this.opts.marketIndex ?? 0, symbols.length - 1);
    const sym = symbols[i];
    let rounds = 0;
    const has = (n: string) => toolbox.specs.some((s) => s.name === n);

    if (has("get_round")) { rounds++; await toolbox.call("get_round", {}); }
    if (has("get_market_history")) { rounds++; await toolbox.call("get_market_history", { market: marketArg(toolbox, "get_market_history", i, markets, symbols), n: 64 }); }
    const source = momentumBxl(sym, 30);
    if (has("compile_strategy")) { rounds++; await toolbox.call("compile_strategy", { source }); }
    if (has("simulate_strategy")) { rounds++; await toolbox.call("simulate_strategy", { source }); }
    rounds++;
    const res = await toolbox.call("submit_strategy", {
      source,
      margin_usdc: req.context.marginUsdc,
      label: `${sym} momentum`,
      rationale: `An EMA(8)/EMA(21) trend follower on ${sym} at 30% of buying power is a simple, low-churn opening position.`,
    });
    return { rounds, finalText: res.text, ...(res.isError ? { error: res.text } : {}) };
  }

  private async live(req: EpisodeRequest, toolbox: Toolbox): Promise<EpisodeResult> {
    const { symbols, memory, prefetch } = req.context;
    const sym = symbols[Math.min(this.opts.marketIndex ?? 0, symbols.length - 1)];
    const pos = positionView(prefetch.read_my_position);
    const fmt = (n?: number) => (n === undefined ? "unknown" : Number.isInteger(n) && Math.abs(n) >= 1e5 ? (n / 1e6).toFixed(2) : n.toFixed(2));
    const losing = isLosing(pos, memory.startingEquity);
    let rounds = 0;

    if (memory.swaps === 0 && losing && toolbox.specs.some((s) => s.name === "hot_swap_strategy")) {
      const source = meanReversionBxl(sym, 25);
      if (toolbox.specs.some((s) => s.name === "compile_strategy")) { rounds++; await toolbox.call("compile_strategy", { source }); }
      if (toolbox.specs.some((s) => s.name === "simulate_strategy")) { rounds++; await toolbox.call("simulate_strategy", { source }); }
      rounds++;
      const swap = await toolbox.call("hot_swap_strategy", { source });
      if (!swap.isError) {
        rounds++;
        await toolbox.call("submit_decision", {
          action: "hot_swapped",
          label: `${sym} mean reversion`,
          explanation: `Equity ${fmt(pos.equity)} is below the starting margin ${fmt(pos.margin ?? memory.startingEquity ?? undefined)}, so ${memory.strategyLabel ?? "the installed program"} is replaced by an 8-tick mean-reversion program on ${sym}.`,
        });
        return { rounds, finalText: swap.text };
      }
      rounds++;
      await toolbox.call("submit_decision", { action: "hold", explanation: `The hot swap to mean reversion failed, so the current program stays installed for now.` });
      return { rounds, finalText: swap.text, error: swap.text };
    }

    rounds++;
    const current = memory.strategyLabel ?? "the installed program";
    const why = pos.equity === undefined
      ? "Position data is unavailable this loop, so the installed program stays unchanged."
      : memory.swaps > 0
        ? `Already swapped once and equity is ${fmt(pos.equity)}, so ${current} keeps running without further churn.`
        : `Equity ${fmt(pos.equity)} is at or above the starting margin ${fmt(pos.margin ?? memory.startingEquity ?? undefined)}, so ${current} keeps running.`;
    await toolbox.call("submit_decision", { action: "hold", explanation: why });
    return { rounds, finalText: why };
  }
}
