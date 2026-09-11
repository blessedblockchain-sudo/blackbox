/**
 * Agent lifecycle for one brain in one round:
 *   registration -> join_round, then draft the initial strategy in the background
 *   delegating   -> enter_round with the drafted source
 *   live         -> every interval: read position, round and scoreboard, let the
 *                   brain decide whether to hot-swap, record a one-sentence reason
 *   settling     -> stop
 */
import { summarize } from "./bridge";
import { callerStatus, deepFind, num, positionView, roundTick, strategyVersion } from "./extract";
import { AgentServer } from "./mcp";
import { draftTask, liveTask, prefetchSummary } from "./prompt";
import { marketSymbol, phaseIndex, readRoundFileSafe, type RoundFile } from "./round";
import { momentumBxl } from "./strategies";
import { EpisodeToolbox } from "./toolbox";
import { Transcript, type LiveLog } from "./transcript";
import type { AgentMemory, Brain, EpisodeContext, Phase, SubmittedStrategy, ToolOutcome } from "./types";

export interface AgentOptions {
  brain: Brain;
  agentName: string;
  roundFile: string;
  systemPrompt: string;
  intervalSecs: number;
  /** Max lifecycle steps (join, enter, and each live loop count as one). */
  maxSteps: number;
  marginUsdc: number;
  marginRange: { min: number; max: number };
  keypair?: string;
  log: LiveLog;
  /** Serializes join_round across agents (the MCP server read-modify-writes the round file). */
  joinLock: Mutex;
  serverCommand?: string[];
  /** Round-file poll interval outside the live loop. */
  pollMs?: number;
  stop: { requested: boolean };
  maxRoundsDraft?: number;
  maxRoundsLive?: number;
  /** Once the round is delegating, how long to wait for the brain's draft before entering with the fallback. */
  draftWaitSecs?: number;
  /** Show MCP server stderr lines in the live log. */
  verboseServer?: boolean;
  /** Transcript directory (default packages/agents/runs, or BLACKBOX_AGENT_RUNS_DIR). */
  runsDir?: string;
}

export interface AgentOutcome {
  provider: string;
  agent: string;
  reason: string;
  steps: number;
  transcript?: string;
  memory: AgentMemory;
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Agent {
  readonly memory: AgentMemory = { currentSource: null, strategyLabel: null, strategyVersion: null, swaps: 0, loops: 0, decisions: [], startingEquity: null };
  private server: AgentServer | null = null;
  private transcript: Transcript | null = null;
  private steps = 0;
  private phase: Phase = "registration";
  private joined = false;
  private entered = false;
  private draft: Promise<SubmittedStrategy> | null = null;
  private roundId = -1;
  private rf!: RoundFile;
  private marginRange: { min: number; max: number };
  private marginUsdc: number;

  constructor(private readonly o: AgentOptions) {
    this.marginRange = { ...o.marginRange };
    this.marginUsdc = o.marginUsdc;
  }

  /** Narrow the runner's margin limits to the round's own [minMargin, maxMargin] from get_round. */
  private applyRoundLimits(r: ToolOutcome) {
    const lo = deepFind(r.structured, ["minMargin"], num, 2, ["round"]);
    const hi = deepFind(r.structured, ["maxMargin"], num, 2, ["round"]);
    const min = Math.max(this.marginRange.min, lo ?? -Infinity);
    const max = Math.min(this.marginRange.max, hi ?? Infinity);
    if (min <= max) this.marginRange = { min, max };
    else if (lo !== undefined && hi !== undefined) this.marginRange = { min: lo, max: hi };
    this.marginUsdc = Math.min(Math.max(this.marginUsdc, this.marginRange.min), this.marginRange.max);
  }

  private get provider() {
    return this.o.brain.provider;
  }

  private log(msg: string) {
    this.o.log(this.provider, this.phase, msg);
  }

  private get symbols() {
    return this.rf.markets.map(marketSymbol);
  }

  async run(): Promise<AgentOutcome> {
    this.rf = await readRoundFileSafe(this.o.roundFile);
    this.roundId = this.rf.roundId;
    this.phase = this.rf.phase;
    this.transcript = new Transcript(this.provider, this.roundId, this.o.agentName, this.o.runsDir ?? process.env.BLACKBOX_AGENT_RUNS_DIR ?? undefined);
    this.o.brain.setTranscript?.(this.transcript);
    let reason = "done";
    try {
      if (phaseIndex(this.rf.phase) >= phaseIndex("settling")) return this.finish(`round #${this.roundId} is already ${this.rf.phase}`);
      this.log(`starting ${this.o.agentName} (${this.o.brain.model}) on round #${this.roundId}, transcript ${this.transcript.file}`);
      this.server = await AgentServer.start({
        agentName: this.o.agentName,
        cluster: this.rf.cluster,
        roundFile: this.o.roundFile,
        keypair: this.o.keypair,
        command: this.o.serverCommand,
        onStderr: (line) => {
          if (this.o.verboseServer) this.log(`[server] ${line}`);
        },
      });
      this.transcript.write({ type: "start", model: this.o.brain.model, roundAddress: this.rf.round, cluster: this.rf.cluster, ...(this.o.keypair ? { keypair: this.o.keypair } : {}) });
      this.log(`MCP server up with ${this.server.tools.length} tools: ${this.server.tools.map((t) => t.name).join(", ")}`);
      const missing = ["get_round", "join_round", "enter_round", "read_my_position", "read_scoreboard", "hot_swap_strategy"].filter((t) => !this.server!.has(t));
      if (missing.length) this.log(`warning: server lacks ${missing.join(", ")}`);
      reason = await this.lifecycle();
    } catch (e) {
      reason = `error: ${e instanceof Error ? e.message : String(e)}`;
      this.transcript.write({ type: "error", where: "lifecycle", message: reason });
      this.log(reason);
    } finally {
      await this.server?.close();
    }
    return this.finish(reason);
  }

  private finish(reason: string): AgentOutcome {
    this.transcript?.write({ type: "stop", reason });
    this.log(`stopped: ${reason}`);
    return { provider: this.provider, agent: this.o.agentName, reason, steps: this.steps, transcript: this.transcript?.file, memory: this.memory };
  }

  private toolbox(kind: "draft" | "live") {
    return new EpisodeToolbox({ server: this.server!, kind, transcript: this.transcript!, log: (m) => this.log(m), marginRange: this.marginRange });
  }

  private async refresh(): Promise<RoundFile> {
    const rf = await readRoundFileSafe(this.o.roundFile);
    if (rf.roundId !== this.roundId) throw new Error(`round file moved to round #${rf.roundId}`);
    if (rf.phase !== this.phase) {
      this.transcript?.write({ type: "phase", phase: rf.phase });
      this.o.log(this.provider, rf.phase, `phase ${this.phase} -> ${rf.phase}`);
      this.phase = rf.phase;
    }
    this.rf = rf;
    return rf;
  }

  private stepBudgetLeft(): boolean {
    return this.steps < this.o.maxSteps;
  }

  private async lifecycle(): Promise<string> {
    const pollMs = this.o.pollMs ?? 2000;
    let statusChecked = false;
    for (;;) {
      if (this.o.stop.requested) return "interrupted";
      const rf = await this.refresh();
      if (phaseIndex(rf.phase) >= phaseIndex("settling")) {
        if (this.joined && this.server?.has("read_scoreboard")) await this.toolbox("live").runnerCall("read_scoreboard");
        return `round is ${rf.phase}`;
      }
      if (!this.stepBudgetLeft()) return `max steps (${this.o.maxSteps}) reached`;

      let checkedNow = false;
      if (!statusChecked) {
        statusChecked = true;
        checkedNow = true;
        const first = await this.toolbox("live").runnerCall("get_round");
        this.applyRoundLimits(first);
        const st = callerStatus(first);
        if (st.joined) {
          this.joined = true;
          this.log(`already an entrant${st.owner ? ` (${st.owner})` : ""}${st.funded ? ", funded" : ""}`);
          if (st.funded) this.entered = true;
        }
      }

      if (rf.phase === "registration") {
        if (!this.joined) await this.join();
        if (this.joined && !this.draft) this.draft = this.authorDraft();
        await sleep(pollMs);
        continue;
      }

      if (rf.phase === "delegating") {
        if (!this.joined) return "registration closed before this agent joined";
        if (!this.entered) {
          if (!this.draft) this.draft = this.authorDraft();
          await this.enter(await this.draftOrFallback(this.draft));
          if (!this.entered) return "could not enter the round";
        }
        await sleep(pollMs);
        continue;
      }

      // live
      if (this.draft && !this.entered) return "missed the entry window (joined but never entered)";
      if (!this.joined) {
        const st = checkedNow ? { joined: false } : callerStatus(await this.toolbox("live").runnerCall("get_round"));
        if (!st.joined) return "not an entrant in this round (joining is only possible during registration)";
        this.joined = true;
      }
      await this.liveLoop();
      await this.waitInterval();
    }
  }

  private async join(): Promise<void> {
    if (!this.server!.has("join_round")) throw new Error("server has no join_round tool");
    await this.o.joinLock.run(async () => {
      const res = await this.toolbox("live").runnerCall("join_round");
      this.steps++;
      if (res.isError && !/already (joined|registered|an entrant)/i.test(res.text)) {
        this.transcript!.write({ type: "error", where: "join_round", message: summarize(res.text, 400) });
        throw new Error(`join_round failed: ${summarize(res.text, 200)}`);
      }
      this.joined = true;
    });
  }

  private context(prefetch: Record<string, ToolOutcome> = {}): EpisodeContext {
    return { roundId: this.roundId, phase: this.phase, markets: this.rf.markets, symbols: this.symbols, memory: this.memory, prefetch, marginUsdc: this.marginUsdc };
  }

  /** Let the brain author the initial strategy; fall back to a momentum program if it cannot. */
  private async authorDraft(): Promise<SubmittedStrategy> {
    const tb = this.toolbox("draft");
    const task = draftTask({ roundId: this.roundId, phase: this.phase, markets: this.rf.markets, symbols: this.symbols, minMargin: this.marginRange.min, maxMargin: this.marginRange.max, defaultMargin: this.marginUsdc });
    this.log(`authoring initial strategy`);
    try {
      const res = await this.o.brain.runEpisode({ kind: "draft", task, context: this.context(), maxRounds: this.o.maxRoundsDraft ?? 16, nudge: "You have not submitted yet. Call submit_strategy now with a source that compiles." }, tb, this.o.systemPrompt);
      if (res.error) {
        this.transcript!.write({ type: "error", where: "draft", message: res.error });
        this.log(`draft episode: ${summarize(res.error, 160)}`);
      }
    } catch (e) {
      this.transcript!.write({ type: "error", where: "draft", message: String(e) });
      this.log(`draft episode threw: ${summarize(String(e), 160)}`);
    }
    if (tb.submitted.strategy) return tb.submitted.strategy;
    const fallback = this.fallbackStrategy();
    this.transcript!.write({ type: "strategy", label: fallback.label, marginUsdc: fallback.marginUsdc, rationale: fallback.rationale, source: fallback.source });
    this.log(`using fallback strategy: ${fallback.label}`);
    return fallback;
  }

  private fallbackStrategy(): SubmittedStrategy {
    const sym = this.symbols[0];
    return { source: momentumBxl(sym, 30), marginUsdc: this.marginUsdc, label: `${sym} momentum (fallback)`, rationale: "No compiling strategy was submitted in time, so the runner enters with a conservative trend follower." };
  }

  /**
   * The entry window is short. Wait up to draftWaitSecs for the brain's draft;
   * if it is late, enter with the fallback and hand the draft to the first live
   * episode as a hot-swap candidate.
   */
  private async draftOrFallback(draft: Promise<SubmittedStrategy>): Promise<SubmittedStrategy> {
    const waitMs = (this.o.draftWaitSecs ?? 45) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const ready = await Promise.race([draft, new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)))]);
    clearTimeout(timer);
    if (ready) return ready;
    const fb = this.fallbackStrategy();
    this.log(`draft not ready after ${waitMs / 1000}s of delegation; entering with ${fb.label}`);
    this.transcript!.write({ type: "strategy", label: fb.label, marginUsdc: fb.marginUsdc, rationale: fb.rationale, source: fb.source });
    draft.then((late) => {
      if (late.label.includes("(fallback)")) return;
      this.memory.note = `Your drafted strategy "${late.label}" arrived after entry, so the round started with the fallback. Consider hot-swapping to it:\n\`\`\`\n${late.source.trim()}\n\`\`\``;
    });
    return fb;
  }

  private async enter(s: SubmittedStrategy): Promise<void> {
    if (!this.server!.has("enter_round")) throw new Error("server has no enter_round tool");
    for (let attempt = 1; attempt <= 4; attempt++) {
      const rf = await this.refresh();
      if (rf.phase !== "delegating") {
        this.log(`entry window closed (phase ${rf.phase})`);
        return;
      }
      const res = await this.toolbox("live").runnerCall("enter_round", { source: s.source, margin_usdc: s.marginUsdc });
      if (!res.isError) {
        this.steps++;
        this.entered = true;
        this.memory.currentSource = s.source;
        this.memory.strategyLabel = s.label;
        this.memory.strategyVersion = strategyVersion(res) ?? 1;
        this.memory.startingEquity = s.marginUsdc;
        this.log(`entered with "${s.label}", margin ${s.marginUsdc} USDC`);
        return;
      }
      this.transcript!.write({ type: "error", where: `enter_round attempt ${attempt}`, message: summarize(res.text, 400) });
      await sleep(5000);
    }
  }

  private async liveLoop(): Promise<void> {
    this.steps++;
    this.memory.loops++;
    const tb = this.toolbox("live");
    const prefetch: Record<string, ToolOutcome> = {};
    for (const name of ["read_my_position", "get_round", "read_scoreboard"]) {
      if (this.server!.has(name)) prefetch[name] = await tb.runnerCall(name);
    }
    const { tick, duration } = roundTick(prefetch.get_round);
    const pos = positionView(prefetch.read_my_position);
    if (this.memory.startingEquity === null && pos.margin !== undefined) this.memory.startingEquity = pos.margin;

    const task = liveTask({ roundId: this.roundId, tick, duration, memory: this.memory, prefetch, loop: this.memory.loops, intervalSecs: this.o.intervalSecs });
    this.memory.note = undefined;
    let explanationFallback = "";
    try {
      const res = await this.o.brain.runEpisode({ kind: "live", task, context: this.context(prefetch), maxRounds: this.o.maxRoundsLive ?? 10, nudge: 'Call submit_decision now with action "hold", "hot_swapped" or "backed" and one sentence.' }, tb, this.o.systemPrompt);
      explanationFallback = res.finalText;
      if (res.error) {
        this.transcript!.write({ type: "error", where: `live loop ${this.memory.loops}`, message: res.error });
        this.log(`episode: ${summarize(res.error, 160)}`);
      }
    } catch (e) {
      this.transcript!.write({ type: "error", where: `live loop ${this.memory.loops}`, message: String(e) });
      this.log(`episode threw: ${summarize(String(e), 160)}`);
    }

    const swapped = tb.swap;
    const decision = tb.submitted.decision ?? {
      action: swapped ? ("hot_swapped" as const) : tb.backed ? ("backed" as const) : ("hold" as const),
      explanation: summarize(explanationFallback || "No decision was submitted this loop, so the installed strategy stays.", 240),
    };
    if (swapped) {
      this.memory.swaps++;
      this.memory.currentSource = swapped.source;
      this.memory.strategyVersion = swapped.version ?? (this.memory.strategyVersion ?? 1) + 1;
      this.memory.strategyLabel = swapped.label ?? `hot swap ${this.memory.swaps}`;
    }
    const at = new Date().toISOString().slice(11, 19);
    this.memory.decisions.push({ at, tick, action: decision.action, explanation: decision.explanation });
    if (this.memory.decisions.length > 20) this.memory.decisions.shift();
    this.transcript!.write({ type: "decision", loop: this.memory.loops, tick, action: decision.action, explanation: decision.explanation, version: this.memory.strategyVersion, context: prefetchSummary(prefetch) });
    this.log(`DECISION ${decision.action.toUpperCase()}${tick != null ? ` @tick ${tick}` : ""}: ${decision.explanation}`);
  }

  /** Sleep for the interval, waking early on a phase change or a stop request. */
  private async waitInterval(): Promise<void> {
    if (!this.stepBudgetLeft()) return;
    const until = Date.now() + this.o.intervalSecs * 1000;
    while (Date.now() < until) {
      if (this.o.stop.requested) return;
      await sleep(Math.min(2000, until - Date.now()));
      const rf = await readRoundFileSafe(this.o.roundFile).catch(() => null);
      if (rf && (rf.roundId !== this.roundId || rf.phase !== "live")) return;
    }
  }
}
