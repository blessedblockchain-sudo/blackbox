/**
 * Per-episode toolbox: the phase's allow-list of MCP tools plus the local
 * submit tools, with policy checks, transcript records and the live log.
 */
import { extractTxLinks, summarize, truncate } from "./bridge";
import { strategyVersion } from "./extract";
import type { AgentServer } from "./mcp";
import type { Transcript } from "./transcript";
import type { EpisodeKind, SubmittedDecision, SubmittedStrategy, ToolOutcome, ToolSpec, Toolbox } from "./types";

/** MCP tools a brain may call, by episode kind. join_round / enter_round are runner-driven. */
export const ALLOWED_TOOLS: Record<EpisodeKind, string[]> = {
  draft: ["get_round", "get_market_history", "get_bxl_reference", "compile_strategy", "simulate_strategy", "read_scoreboard"],
  live: [
    "get_round",
    "get_market_history",
    "get_bxl_reference",
    "compile_strategy",
    "simulate_strategy",
    "read_scoreboard",
    "read_my_position",
    "read_my_strategy",
    "hot_swap_strategy",
    "privacy_check",
    "list_authors",
    "back_strategy",
    "read_my_licenses",
    "read_chat",
    "post_chat",
  ],
};

export const SUBMIT_STRATEGY: ToolSpec = {
  name: "submit_strategy",
  description: "Submit your initial BXL strategy for this round. The source is compiled first; compile errors are returned so you can fix them. Ends the authoring episode.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Complete BXL program source." },
      margin_usdc: { type: "number", description: "Margin to fund, in USDC." },
      label: { type: "string", description: "Short name for the strategy, e.g. 'SOL trend with drawdown stop'." },
      rationale: { type: "string", description: "One sentence on why this strategy fits the current market." },
    },
    required: ["source", "margin_usdc", "rationale"],
    additionalProperties: false,
  },
};

export const SUBMIT_DECISION: ToolSpec = {
  name: "submit_decision",
  description: "Record this loop's decision. Call exactly once, after any hot swap. Ends the decision episode.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["hold", "hot_swapped", "backed"],
        description:
          "hold keeps the installed strategy; hot_swapped means you called hot_swap_strategy successfully in this loop; backed means you licensed another entrant's strategy with back_strategy in this loop.",
      },
      explanation: { type: "string", description: "Exactly one sentence explaining the decision." },
      label: { type: "string", description: "When hot_swapped: short name of the strategy now installed." },
    },
    required: ["action", "explanation"],
    additionalProperties: false,
  },
};

export interface ToolboxOptions {
  server: AgentServer;
  kind: EpisodeKind;
  transcript: Transcript;
  log: (msg: string) => void;
  marginRange: { min: number; max: number };
  /** Max characters of a tool result handed to the model. */
  maxResultChars?: number;
}

export interface SwapRecord {
  source: string;
  version?: number;
  label?: string;
}

const argSummary = (args: Record<string, unknown>) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "source" && typeof v === "string") parts.push(`source=${v.split("\n").length} lines`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else parts.push(`${k}=${summarize(JSON.stringify(v), 40)}`);
  }
  return parts.join(" ");
};

export class EpisodeToolbox implements Toolbox {
  readonly specs: ToolSpec[];
  readonly submitted: { strategy?: SubmittedStrategy; decision?: SubmittedDecision } = {};
  swap: SwapRecord | null = null;
  backed: { author: string; marginUsdc: number } | null = null;
  posted = false;
  calls = 0;
  private readonly allowed: Set<string>;

  constructor(private readonly o: ToolboxOptions) {
    const names = ALLOWED_TOOLS[o.kind];
    const mcp = o.server.tools.filter((t) => names.includes(t.name));
    this.allowed = new Set(mcp.map((t) => t.name));
    this.specs = [...mcp, o.kind === "draft" ? SUBMIT_STRATEGY : SUBMIT_DECISION];
  }

  /** Runner-side MCP call (not subject to the model allow-list). */
  async runnerCall(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    return this.invoke("runner", name, args);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls++;
    if (name === "submit_strategy" && this.o.kind === "draft") return this.submitStrategy(args);
    if (name === "submit_decision" && this.o.kind === "live") return this.submitDecision(args);
    if (!this.allowed.has(name)) {
      const text = `ERROR: tool ${name} is not available in this phase. Available: ${this.specs.map((s) => s.name).join(", ")}.`;
      this.o.transcript.write({ type: "tool_call", by: "model", tool: name, args });
      this.o.transcript.write({ type: "tool_result", tool: name, ok: false, summary: summarize(text), ms: 0 });
      return { text, isError: true };
    }
    if (name === "hot_swap_strategy" && this.swap) {
      return { text: "ERROR: you already hot-swapped in this loop; one swap per loop. Call submit_decision.", isError: true };
    }
    if (name === "post_chat" && this.posted) {
      return { text: "ERROR: one chat message per loop. Call submit_decision.", isError: true };
    }
    if (name === "back_strategy") {
      if (this.backed) return { text: "ERROR: you already backed a strategy in this loop; one license per loop. Call submit_decision.", isError: true };
      const margin = Number(args.margin_usdc);
      const { min, max } = this.o.marginRange;
      if (!Number.isFinite(margin) || margin < min || margin > max) return { text: `ERROR: margin_usdc must be between ${min} and ${max} USDC (risk limit).`, isError: true };
    }
    const res = await this.invoke("model", name, args);
    if (name === "hot_swap_strategy" && !res.isError && typeof args.source === "string") {
      this.swap = { source: args.source, version: strategyVersion(res) };
    }
    if (name === "back_strategy" && !res.isError) this.backed = { author: String(args.author ?? ""), marginUsdc: Number(args.margin_usdc) };
    if (name === "post_chat" && !res.isError) this.posted = true;
    return res;
  }

  private async invoke(by: "runner" | "model", name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.o.transcript.write({ type: "tool_call", by, tool: name, args });
    const t0 = Date.now();
    const res = await this.o.server.call(name, args);
    const ms = Date.now() - t0;
    const tx = extractTxLinks(res.text, res.structured);
    this.o.transcript.write({ type: "tool_result", tool: name, ok: !res.isError, summary: summarize(res.text, 300), ms, ...(tx.length ? { tx } : {}) });
    if (tx.length) this.o.transcript.write({ type: "tx", tool: name, links: tx });
    const who = by === "runner" ? "" : "* ";
    this.o.log(`${who}${name}${Object.keys(args).length ? ` (${argSummary(args)})` : ""} ${res.isError ? "FAILED" : "ok"} ${ms}ms: ${summarize(res.text.replace(/^ERROR: /, ""), 110)}`);
    for (const link of tx) this.o.log(`  tx ${link}`);
    return { ...res, text: truncate(res.text, this.o.maxResultChars ?? 6000) };
  }

  private async submitStrategy(args: Record<string, unknown>): Promise<ToolOutcome> {
    this.o.transcript.write({ type: "tool_call", by: "model", tool: "submit_strategy", args: { ...args, source: typeof args.source === "string" ? `${args.source.length} chars` : args.source } });
    const source = typeof args.source === "string" ? args.source : "";
    const margin = Number(args.margin_usdc);
    const { min, max } = this.o.marginRange;
    if (!source.trim()) return { text: "ERROR: source is empty.", isError: true };
    if (!Number.isFinite(margin) || margin < min || margin > max) return { text: `ERROR: margin_usdc must be between ${min} and ${max} USDC (risk limit).`, isError: true };
    const compiled = await this.invoke("runner", "compile_strategy", { source });
    if (compiled.isError || /\b(ok|success)\W{0,3}\s*false\b/i.test(compiled.text) || compiled.structured?.ok === false) {
      return { text: `ERROR: the source does not compile, fix it and submit again.\n${compiled.text.replace(/^ERROR: /, "")}`, isError: true };
    }
    const strategy: SubmittedStrategy = {
      source,
      marginUsdc: margin,
      rationale: typeof args.rationale === "string" ? args.rationale : "",
      label: typeof args.label === "string" && args.label.trim() ? args.label.trim() : "custom",
    };
    this.submitted.strategy = strategy;
    this.o.transcript.write({ type: "strategy", label: strategy.label, marginUsdc: margin, rationale: strategy.rationale, source });
    this.o.log(`* submit_strategy "${strategy.label}" margin ${margin} USDC: ${summarize(strategy.rationale, 100)}`);
    return { text: "Accepted. The runner will enter the round with this strategy as soon as it is delegated.", isError: false, final: true };
  }

  private async submitDecision(args: Record<string, unknown>): Promise<ToolOutcome> {
    const action = args.action === "hot_swapped" ? "hot_swapped" : args.action === "backed" ? "backed" : args.action === "hold" ? "hold" : null;
    const explanation = typeof args.explanation === "string" ? args.explanation.trim() : "";
    if (!action) return { text: 'ERROR: action must be "hold", "hot_swapped" or "backed".', isError: true };
    if (!explanation) return { text: "ERROR: explanation is required (one sentence).", isError: true };
    if (action === "hot_swapped" && !this.swap) return { text: "ERROR: no successful hot_swap_strategy call in this loop; use action hold, or swap first.", isError: true };
    if (action === "backed" && !this.backed) return { text: "ERROR: no successful back_strategy call in this loop; use action hold, or back a strategy first.", isError: true };
    if (action === "hold" && (this.swap || this.backed)) {
      return { text: `ERROR: you ${this.swap ? "hot-swapped" : "backed a strategy"} in this loop; use action ${this.swap ? "hot_swapped" : "backed"}.`, isError: true };
    }
    if (this.swap && typeof args.label === "string" && args.label.trim()) this.swap.label = args.label.trim();
    this.submitted.decision = { action, explanation };
    return { text: "Recorded.", isError: false, final: true };
  }
}
