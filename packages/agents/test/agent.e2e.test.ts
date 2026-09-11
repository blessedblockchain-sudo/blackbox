/**
 * Full lifecycle of the scripted agent over a real stdio MCP connection to a
 * fake BLACKBOX server: registration -> join, draft; delegating -> enter;
 * live -> read, hold, then hot-swap to mean reversion after a loss; settling -> stop.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, Mutex } from "../src/agent";
import { AgentServer, findTsNode } from "../src/mcp";
import { buildSystemPrompt } from "../src/prompt";
import { ScriptedBrain } from "../src/providers/scripted";
import { toAnthropicTools, toGeminiTools, toOpenAITools } from "../src/bridge";
import type { Brain, EpisodeRequest, EpisodeResult, Toolbox } from "../src/types";

const FIXTURE = path.join(__dirname, "fixtures/fake-mcp-server.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scripted agent lifecycle over stdio MCP (fake server)", function () {
  this.timeout(120_000);
  const tsNode = findTsNode();
  let dir: string;
  let roundFile: string;
  let callLog: string;

  const setPhase = (phase: string) => {
    const rf = JSON.parse(fs.readFileSync(roundFile, "utf8"));
    fs.writeFileSync(roundFile, JSON.stringify({ ...rf, phase }));
  };
  const calls = (): { tool: string; args: any; phase: string }[] =>
    fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  before(function () {
    if (!tsNode) this.skip();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-agents-"));
    roundFile = path.join(dir, "round-local.json");
    callLog = path.join(dir, "calls.jsonl");
    fs.writeFileSync(roundFile, JSON.stringify({ cluster: "local", roundId: 7, round: "Round1111111111111111111111111111111111111", mint: "Mint", feeds: [], markets: ["SOL-PERP", "BTC-PERP", "ETH-PERP"], tickMs: 500, durationTicks: 7200, mode: "lit", phase: "registration", entrants: [] }));
    process.env.FAKE_MCP_LOG = callLog;
  });

  after(() => {
    delete process.env.FAKE_MCP_LOG;
  });

  it("bridges the server's real tools/list output for every provider", async () => {
    const server = await AgentServer.start({ agentName: "bridge-probe", cluster: "local", roundFile, command: [tsNode!, "--transpile-only", FIXTURE] });
    try {
      expect(server.tools.map((t) => t.name)).to.include.members(["get_round", "join_round", "enter_round", "hot_swap_strategy"]);
      const a = toAnthropicTools(server.tools);
      const o = toOpenAITools(server.tools);
      const g = toGeminiTools(server.tools);
      expect(a).to.have.length(server.tools.length);
      expect(o).to.have.length(server.tools.length);
      expect(g).to.have.length(server.tools.length);
      expect(JSON.stringify([a, o, g])).to.not.contain("$schema");
      const hist = g.find((d) => d.name === "get_market_history")!;
      expect((hist.parameters as any).properties.market.enum).to.deep.equal(["SOL-PERP", "BTC-PERP", "ETH-PERP"]);
      const r = await server.call("get_round", {});
      expect(r.isError).to.equal(false);
      expect(r.structured).to.have.property("phase", "registration");
      const bad = await server.call("no_such_tool", {});
      expect(bad.isError).to.equal(true);
    } finally {
      await server.close();
    }
  });

  it("joins, drafts, enters, holds, hot-swaps once, and stops at settling", async () => {
    fs.writeFileSync(callLog, "");
    const runsDir = path.join(dir, "runs");
    const lines: string[] = [];
    const stop = { requested: false };
    const agent = new Agent({
      brain: new ScriptedBrain(),
      agentName: "scripted-test",
      roundFile,
      systemPrompt: buildSystemPrompt(),
      intervalSecs: 1,
      maxSteps: 50,
      marginUsdc: 100,
      marginRange: { min: 50, max: 250 },
      log: (p, ph, m) => lines.push(`${p} ${ph} ${m}`),
      joinLock: new Mutex(),
      serverCommand: [tsNode!, "--transpile-only", FIXTURE],
      pollMs: 200,
      stop,
      runsDir,
    });

    // Round driver: advance phases as the agent makes progress.
    let driving = true;
    const driver = (async () => {
      const t0 = Date.now();
      while (driving && Date.now() - t0 < 100_000) {
        const c = calls();
        const phase = JSON.parse(fs.readFileSync(roundFile, "utf8")).phase;
        if (phase === "registration" && c.some((x) => x.tool === "simulate_strategy")) setPhase("delegating");
        else if (phase === "delegating" && c.some((x) => x.tool === "enter_round")) setPhase("live");
        else if (phase === "live" && c.filter((x) => x.tool === "read_my_position").length >= 3) setPhase("settling");
        await sleep(100);
      }
    })();

    const outcome = await agent.run();
    driving = false;
    await driver;

    const c = calls();
    const tools = c.map((x) => x.tool);
    expect(outcome.reason).to.equal("round is settling");

    // registration: status check, join, then the draft reads, compiles and simulates momentum
    const join = tools.indexOf("join_round");
    expect(join).to.be.greaterThan(-1);
    expect(c[join].phase).to.equal("registration");
    const hist = c.find((x) => x.tool === "get_market_history")!;
    expect(hist.args).to.deep.equal({ market: "SOL-PERP", n: 64 });
    const enter = c.find((x) => x.tool === "enter_round")!;
    expect(enter.phase).to.equal("delegating");
    expect(enter.args.margin_usdc).to.equal(100);
    expect(enter.args.source).to.contain("ema(SOL, 8) > ema(SOL, 21)");

    // live: each loop reads position, round and scoreboard; the second loop sees a loss and swaps
    const live = c.filter((x) => x.phase === "live");
    expect(live.slice(0, 3).map((x) => x.tool)).to.deep.equal(["read_my_position", "get_round", "read_scoreboard"]);
    const swaps = c.filter((x) => x.tool === "hot_swap_strategy");
    expect(swaps).to.have.length(1);
    expect(swaps[0].args.source).to.contain("ret(SOL, 8)");
    expect(tools.indexOf("hot_swap_strategy")).to.be.greaterThan(tools.lastIndexOf("enter_round"));

    expect(outcome.memory.swaps).to.equal(1);
    expect(outcome.memory.strategyVersion).to.equal(2);
    expect(outcome.memory.strategyLabel).to.equal("SOL mean reversion");
    expect(outcome.memory.decisions.map((d) => d.action)).to.deep.equal(["hold", "hot_swapped", "hold"]);
    for (const d of outcome.memory.decisions) expect(d.explanation).to.match(/^[^\n]+\.$/);

    // transcript
    const file = path.join(runsDir, "scripted-round7.jsonl");
    expect(outcome.transcript).to.equal(file);
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    for (const t of ["start", "phase", "tool_call", "tool_result", "strategy", "decision", "tx", "stop"]) expect(types.has(t), t).to.equal(true);
    expect(events.every((e) => e.round === 7 && e.provider === "scripted" && typeof e.t === "string")).to.equal(true);
    const decisions = events.filter((e) => e.type === "decision");
    expect(decisions.map((d) => d.action)).to.deep.equal(["hold", "hot_swapped", "hold"]);
    expect(decisions[1].version).to.equal(2);
    const txLinks = events.filter((e) => e.type === "tx").flatMap((e) => e.links);
    expect(txLinks.some((l: string) => l.includes("/tx/swap"))).to.equal(true);
    expect(lines.some((l) => l.includes("DECISION HOT_SWAPPED"))).to.equal(true);
  });

  it("enters with the fallback when the draft is late, then offers the late draft for a hot swap", async () => {
    fs.writeFileSync(callLog, "");
    setPhase("registration");
    const liveTasks: string[] = [];
    const slow: Brain = {
      provider: "slowpoke",
      model: "test",
      async runEpisode(req: EpisodeRequest, tb: Toolbox): Promise<EpisodeResult> {
        if (req.kind === "draft") {
          await sleep(2500);
          await tb.call("submit_strategy", { source: "long(SOL, 10%)", margin_usdc: 60, label: "late idea", rationale: "Late." });
          return { rounds: 1, finalText: "" };
        }
        liveTasks.push(req.task);
        await tb.call("submit_decision", { action: "hold", explanation: "Waiting." });
        return { rounds: 1, finalText: "" };
      },
    };
    const agent = new Agent({
      brain: slow,
      agentName: "slowpoke",
      roundFile,
      systemPrompt: "S",
      intervalSecs: 1,
      maxSteps: 50,
      marginUsdc: 100,
      marginRange: { min: 50, max: 250 },
      log: () => {},
      joinLock: new Mutex(),
      serverCommand: [tsNode!, "--transpile-only", FIXTURE],
      pollMs: 200,
      draftWaitSecs: 0.5,
      stop: { requested: false },
      runsDir: path.join(dir, "runs3"),
    });
    let driving = true;
    const driver = (async () => {
      while (driving) {
        const c = calls();
        const phase = JSON.parse(fs.readFileSync(roundFile, "utf8")).phase;
        if (phase === "registration" && c.some((x) => x.tool === "join_round")) setPhase("delegating");
        else if (phase === "delegating" && c.some((x) => x.tool === "enter_round")) setPhase("live");
        else if (phase === "live" && c.filter((x) => x.tool === "read_my_position").length >= 4) setPhase("settling");
        await sleep(100);
      }
    })();
    const outcome = await agent.run();
    driving = false;
    await driver;
    expect(outcome.reason).to.equal("round is settling");
    const enter = calls().find((x) => x.tool === "enter_round")!;
    expect(enter.args.source).to.contain("ema(SOL, 8)");
    expect(liveTasks.some((t) => t.includes('Your drafted strategy "late idea" arrived after entry') && t.includes("long(SOL, 10%)"))).to.equal(true);
    expect(liveTasks.filter((t) => t.includes("arrived after entry"))).to.have.length(1);
  });

  it("refuses to trade when it is not an entrant and the round is already live", async () => {
    setPhase("live");
    const agent = new Agent({
      brain: new ScriptedBrain(),
      agentName: "latecomer",
      roundFile,
      systemPrompt: "S",
      intervalSecs: 1,
      maxSteps: 5,
      marginUsdc: 100,
      marginRange: { min: 50, max: 250 },
      log: () => {},
      joinLock: new Mutex(),
      serverCommand: [tsNode!, "--transpile-only", FIXTURE],
      stop: { requested: false },
      runsDir: path.join(dir, "runs2"),
    });
    const outcome = await agent.run();
    expect(outcome.reason).to.match(/not an entrant/);
    expect(outcome.steps).to.equal(0);
  });
});
