/**
 * Shared types for the agent runner. A "brain" (an LLM provider or the
 * scripted agent) runs short episodes against a Toolbox that fronts one MCP
 * server process; the runner owns the round lifecycle around those episodes.
 */

/** Minimal MCP tool descriptor (a structural subset of the MCP `Tool` type). */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

/** JSON Schema, loosely typed: MCP servers emit whatever their schema library produces. */
export type JsonSchema = { [key: string]: unknown };

/** Outcome of one tool call, already flattened to text for the model. */
export interface ToolOutcome {
  /** Text handed back to the model (truncated). */
  text: string;
  isError: boolean;
  /** Structured JSON from the MCP server, when it provided one. */
  structured?: Record<string, unknown>;
  /** True when a local submit tool accepted the call: the episode is over. */
  final?: boolean;
}

export type Phase = "registration" | "delegating" | "live" | "settling" | "settled";

export type EpisodeKind = "draft" | "live";

export interface EpisodeRequest {
  kind: EpisodeKind;
  /** The user-turn text for LLM brains. */
  task: string;
  /** Machine-readable context (the scripted brain reads this instead of `task`). */
  context: EpisodeContext;
  /** Upper bound on model round trips in this episode. */
  maxRounds: number;
  /** Sent once as a user turn if the model stops without calling the episode's submit tool. */
  nudge?: string;
}

export interface EpisodeContext {
  roundId: number;
  phase: Phase;
  /** Market names in round order, e.g. ["SOL-PERP", "BTC-PERP", "ETH-PERP"]. */
  markets: string[];
  /** BXL symbols in round order, e.g. ["SOL", "BTC", "ETH"]. */
  symbols: string[];
  memory: AgentMemory;
  /** Results of the runner's own reads made before the episode (live loop). */
  prefetch: Record<string, ToolOutcome>;
  marginUsdc: number;
}

export interface DecisionRecord {
  at: string;
  tick?: number;
  action: string;
  explanation: string;
}

export interface AgentMemory {
  /** BXL source currently believed to be installed (null when unknown, e.g. an adopted entrant). */
  currentSource: string | null;
  strategyLabel: string | null;
  strategyVersion: number | null;
  swaps: number;
  loops: number;
  decisions: DecisionRecord[];
  startingEquity: number | null;
  /** One-off note for the next live episode (e.g. a draft that arrived after entry). */
  note?: string;
}

export interface SubmittedStrategy {
  source: string;
  marginUsdc: number;
  rationale: string;
  label: string;
}

export interface SubmittedDecision {
  action: "hold" | "hot_swapped";
  explanation: string;
}

export interface EpisodeResult {
  rounds: number;
  finalText: string;
  strategy?: SubmittedStrategy;
  decision?: SubmittedDecision;
  error?: string;
}

/** The toolbox a brain sees for one episode. */
export interface Toolbox {
  /** Tools the brain may call in this episode (MCP tools allowed in the phase, plus local submit tools). */
  readonly specs: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Populated by the local submit tools. */
  readonly submitted: { strategy?: SubmittedStrategy; decision?: SubmittedDecision };
}

export interface Brain {
  /** Provider id: claude | openai | gemini | scripted. */
  readonly provider: string;
  /** Model id, or "deterministic" for the scripted brain. */
  readonly model: string;
  runEpisode(req: EpisodeRequest, toolbox: Toolbox, systemPrompt: string): Promise<EpisodeResult>;
  /** Brains that log model turns receive the agent's transcript once the round is known. */
  setTranscript?(t: import("./transcript").Transcript): void;
}
