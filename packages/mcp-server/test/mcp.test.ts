/**
 * Spawns the BLACKBOX MCP server over stdio (and once over streamable HTTP)
 * and exercises it against the live local round in .mb/round-local.json.
 * Read-only against that round: a fresh test wallet never joins it, and the
 * owner-read checks use a runner bot's key without sending transactions.
 *
 *   npx ts-mocha -p packages/mcp-server/tsconfig.json 'packages/mcp-server/test/**\/*.ts' --timeout 300000
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { MOMENTUM_BXL, Session, call, compilerMissing, connectHttp, connectStdio, readRound, tmpDir } from "./helpers";

const EXPECTED_TOOLS = [
  "get_round",
  "get_market_history",
  "compile_strategy",
  "simulate_strategy",
  "join_round",
  "enter_round",
  "hot_swap_strategy",
  "read_my_position",
  "read_my_strategy",
  "read_scoreboard",
  "privacy_check",
  "get_bxl_reference",
];

const rf = readRound();

describe("blackbox MCP server (stdio, live local round)", function () {
  this.timeout(300_000);
  let s: Session;
  const dir = tmpDir("fresh");

  before(async function () {
    if (!rf) this.skip();
    // A brand-new named agent: exercises keypair creation under BLACKBOX_AGENTS_DIR.
    s = await connectStdio({ BLACKBOX_AGENT_NAME: "mcp-test-fresh", BLACKBOX_AGENTS_DIR: dir });
  });
  after(async () => {
    await s?.close();
  });

  it("creates the named agent keypair and lists every tool with a JSON schema", async () => {
    expect(fs.existsSync(path.join(dir, "mcp-test-fresh.json"))).to.equal(true);
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of EXPECTED_TOOLS) expect(names, n).to.include(n);
    for (const t of tools) {
      expect(t.description, t.name).to.be.a("string").and.not.empty;
      expect(t.inputSchema.type, t.name).to.equal("object");
    }
    const enter = tools.find((t) => t.name === "enter_round")!;
    expect(enter.inputSchema.required).to.include("margin_usdc");
  });

  it("get_round reports the live round, markets, the caller and the scoreboard", async () => {
    const o = await call(s, "get_round", { top: 3 });
    expect(o.isError, o.text).to.equal(false);
    const d = o.data;
    expect(d.round.roundId).to.equal(rf.roundId);
    expect(d.round.address).to.equal(rf.round);
    expect(d.round.phase).to.equal(rf.phase);
    expect(d.round.mode).to.equal(rf.mode);
    expect(d.round.durationTicks).to.equal(rf.durationTicks);
    expect(d.markets).to.have.length(rf.markets.length);
    for (const m of d.markets) expect(m.mark, m.name).to.be.greaterThan(0);
    expect(d.you.wallet).to.be.a("string");
    expect(d.you.joined).to.equal(false);
    if (rf.mode === "lit") {
      expect(d.scoreboard).to.be.an("array").with.length.at.most(3);
      expect(d.scoreboard[0].equity).to.be.at.least(d.scoreboard[d.scoreboard.length - 1].equity);
    }
    expect(o.text).to.match(/^Round #\d+/);
    console.log("      " + o.text.split("\n").join("\n      "));
  });

  it("read_scoreboard ranks every entrant by equity", async () => {
    const o = await call(s, "read_scoreboard");
    expect(o.isError, o.text).to.equal(false);
    if (o.data.private) return;
    const e = o.data.entries;
    expect(e.length).to.be.at.least((rf.entrants ?? []).length);
    for (let i = 1; i < e.length; i++) expect(e[i - 1].equity).to.be.at.least(e[i].equity);
    expect(e.map((x: any) => x.place)).to.deep.equal(e.map((_: any, i: number) => i + 1));
    const botNames = new Set((rf.entrants ?? []).map((x: any) => x.name));
    expect(e.some((x: any) => botNames.has(x.name))).to.equal(true);
    expect(JSON.stringify(o.data)).to.not.include("secretKey");
    console.log("      " + o.text.split("\n").slice(0, 4).join("\n      "));
  });

  it("get_market_history returns ring-buffer marks, oldest first", async () => {
    const o = await call(s, "get_market_history", { market: "sol", n: 16 });
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.market).to.equal(rf.markets[0]);
    expect(o.data.marks.length).to.be.within(1, 16);
    for (const p of o.data.marks) expect(p).to.be.greaterThan(0);
    expect(o.data.lastTick - o.data.firstTick + 1).to.equal(o.data.marks.length);
    const bad = await call(s, "get_market_history", { market: "DOGE" });
    expect(bad.isError).to.equal(true);
    expect(bad.text).to.include("Unknown market");
  });

  it("compile_strategy compiles BXL and reports errors with positions", async function () {
    const o = await call(s, "compile_strategy", { source: MOMENTUM_BXL });
    if (compilerMissing(o)) {
      console.log(`      compiler unavailable: ${o.text.split("\n")[1] ?? o.text}`);
      return this.skip();
    }
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.ok).to.equal(true);
    expect(o.data.size).to.be.greaterThan(1);
    expect(o.data.maxSteps).to.be.greaterThan(0);
    expect(o.data.listing).to.match(/ema/);
    expect(o.data.bytecodeHex.slice(0, 2)).to.equal("01");
    const bad = await call(s, "compile_strategy", { source: "# bad market\nlong(DOGE, 30%)\n" });
    expect(bad.isError).to.equal(true);
    expect(bad.data.ok).to.equal(false);
    expect(bad.data.errors[0].line).to.equal(2);
    expect(bad.text).to.match(/DOGE|market/i);
  });

  it("simulate_strategy backtests on the ring buffers and on supplied history", async function () {
    const o = await call(s, "simulate_strategy", { source: MOMENTUM_BXL, margin_usdc: 100 });
    if (compilerMissing(o)) return this.skip();
    if (o.isError && /simulator failed/.test(o.text)) {
      console.log(`      simulator unavailable: ${o.text}`);
      return this.skip();
    }
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.ticks).to.be.greaterThan(1);
    expect(o.data.finalEquity).to.be.a("number");
    const rising = Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.002 * i));
    const o2 = await call(s, "simulate_strategy", { source: "long(SOL, 50%)\n", market_history: { SOL: rising }, margin_usdc: 100 });
    expect(o2.isError, o2.text).to.equal(false);
    expect(o2.data.ticks).to.equal(60);
    expect(o2.data.finalEquity).to.be.greaterThan(100);
    console.log(`      ${o.text.split("\n")[0]}\n      ${o2.text.split("\n")[0]}`);
  });

  it("a wallet that never joined gets clear answers, and cannot join a closed round", async () => {
    const pos = await call(s, "read_my_position");
    expect(pos.isError, pos.text).to.equal(false);
    expect(pos.data.found).to.equal(false);
    const strat = await call(s, "read_my_strategy");
    expect(strat.data.found).to.equal(false);
    const swap = await call(s, "hot_swap_strategy", { builtin: "momentum" });
    expect(swap.isError).to.equal(true);
    const enter = await call(s, "enter_round", { builtin: "momentum", margin_usdc: 100 });
    expect(enter.isError).to.equal(true);
    const priv = await call(s, "privacy_check");
    expect(priv.isError, priv.text).to.equal(false);
    expect(priv.data.verdict).to.equal("inconclusive");
    if (rf.phase !== "registration") {
      const join = await call(s, "join_round");
      expect(join.isError).to.equal(true);
      expect(join.text).to.match(/Registration is closed/);
    }
  });

  it("get_bxl_reference and the reference resource describe the language", async () => {
    const o = await call(s, "get_bxl_reference");
    expect(o.text).to.include("long(M, P)");
    expect(o.data.markets).to.deep.equal(rf.markets.map((m: string) => m.replace(/-PERP$/, "")));
    const res = await s.client.readResource({ uri: "blackbox://bxl/reference" });
    expect((res.contents[0] as any).text).to.include("# BXL");
  });
});

describe("blackbox MCP server as an entrant of the live round (owner reads)", function () {
  this.timeout(300_000);
  let s: Session;
  const bot = rf?.entrants?.find((e: any) => Array.isArray(e.secretKey));

  before(async function () {
    if (!rf || !bot || rf.phase === "registration") this.skip();
    const dir = tmpDir("owner");
    const kpFile = path.join(dir, "bot.json");
    fs.writeFileSync(kpFile, JSON.stringify(bot.secretKey));
    s = await connectStdio({ BLACKBOX_KEYPAIR: kpFile, BLACKBOX_AGENT_NAME: bot.name });
  });
  after(async () => {
    await s?.close();
  });

  it("get_round shows the caller joined, private and funded", async () => {
    const o = await call(s, "get_round");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.you.wallet).to.equal(bot.owner);
    expect(o.data.you.joined).to.equal(true);
    expect(o.data.you.privatized).to.equal(true);
    expect(o.data.you.funded).to.equal(true);
  });

  it("read_my_position decodes the private Position with an equity estimate", async () => {
    const o = await call(s, "read_my_position");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.found).to.equal(true);
    expect(o.data.margin).to.be.greaterThan(0);
    expect(o.data.equityEstimate).to.be.a("number");
    if (o.data.scoreboardEquity !== null) {
      // The scoreboard is refreshed on each of the entrant's ticks; the estimate uses current marks.
      expect(Math.abs(o.data.equityEstimate - o.data.scoreboardEquity) / o.data.scoreboardEquity).to.be.lessThan(0.05);
    }
    console.log("      " + o.text.split("\n").join("\n      "));
  });

  it("read_my_strategy returns the version, sha256 and disassembly", async () => {
    const o = await call(s, "read_my_strategy");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.found).to.equal(true);
    expect(o.data.version).to.be.at.least(1);
    expect(o.data.size).to.be.greaterThan(1);
    expect(o.data.sha256).to.match(/^[0-9a-f]{64}$/);
    expect(o.data.listing).to.match(/halt/);
  });

  it("privacy_check: a random wallet and no token read null; the owner reads data", async () => {
    const o = await call(s, "privacy_check");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.verdict).to.equal("private");
    expect(o.data.reads.strategy.owner).to.be.greaterThan(0);
    expect(o.data.reads.strategy.stranger).to.equal(null);
    expect(o.data.reads.strategy.public).to.equal(null);
    expect(o.data.reads.position.stranger).to.equal(null);
    expect(o.data.reads.position.public).to.equal(null);
    console.log("      " + o.text.split("\n").join("\n      "));
  });
});

describe("blackbox MCP server over streamable HTTP", function () {
  this.timeout(120_000);
  it("serves get_round and read_scoreboard on /mcp", async function () {
    if (!rf) this.skip();
    const port = 18000 + Math.floor(Math.random() * 2000);
    const s = await connectHttp({ BLACKBOX_AGENT_NAME: "mcp-test-http", BLACKBOX_AGENTS_DIR: tmpDir("http") }, port);
    try {
      const { tools } = await s.client.listTools();
      expect(tools.map((t) => t.name)).to.include("get_round");
      const o = await call(s, "get_round");
      expect(o.isError, o.text).to.equal(false);
      expect(o.data.round.roundId).to.equal(rf.roundId);
      const sb = await call(s, "read_scoreboard", { limit: 2 });
      expect(sb.isError, sb.text).to.equal(false);
      const health = (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json())) as { ok: boolean };
      expect(health.ok).to.equal(true);
    } finally {
      await s.close();
    }
  });
});
