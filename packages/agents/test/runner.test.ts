import { expect } from "chai";
import { callerStatus, isLosing, positionView, roundTick, strategyVersion } from "../src/extract";
import { hasKey, parseArgs } from "../src/runner";
import { marketSymbol } from "../src/round";
import { marketArg } from "../src/providers/scripted";
import type { Toolbox } from "../src/types";

const out = (structured: Record<string, unknown> | undefined, text = "") => ({ text, isError: false, structured });

describe("runner CLI", () => {
  it("defaults to keyed providers plus scripted", () => {
    const a = parseArgs([], { OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv);
    expect(a).to.not.equal("help");
    if (a === "help") return;
    expect(a.providers).to.deep.equal(["openai", "scripted"]);
    expect(a.intervalSecs).to.equal(45);
    expect(a.maxSteps).to.equal(Infinity);
    expect(a.roundFile).to.match(/\.mb\/round-local\.json$/);
  });

  it("parses every option", () => {
    const a = parseArgs(["--providers", "scripted", "--round-file=/tmp/r.json", "--interval-secs", "5", "--max-steps", "3", "--margin", "80", "--adopt", "Momentum", "--quiet"], {} as NodeJS.ProcessEnv);
    if (a === "help") throw new Error("unexpected help");
    expect(a).to.deep.include({ providers: ["scripted"], roundFile: "/tmp/r.json", intervalSecs: 5, maxSteps: 3, margin: 80, adopt: "Momentum", quiet: true });
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--providers", "grok"], {} as NodeJS.ProcessEnv)).to.throw(/unknown provider/);
    expect(() => parseArgs(["--interval-secs", "-1"], {} as NodeJS.ProcessEnv)).to.throw(/positive/);
    expect(() => parseArgs(["--adopt", "Momentum"], { OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv)).to.throw(/exactly one provider/);
    expect(() => parseArgs(["--margin", "1000"], {} as NodeJS.ProcessEnv)).to.throw(/margin/);
    expect(() => parseArgs(["--wat"], {} as NodeJS.ProcessEnv)).to.throw(/unknown option/);
    expect(parseArgs(["--help"], {} as NodeJS.ProcessEnv)).to.equal("help");
  });

  it("detects provider keys", () => {
    expect(hasKey("claude", { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).to.equal(true);
    expect(hasKey("gemini", {} as NodeJS.ProcessEnv)).to.equal(false);
    expect(hasKey("scripted", {} as NodeJS.ProcessEnv)).to.equal(true);
  });

  it("derives BXL symbols from market names", () => {
    expect(["SOL-PERP", "BTC/USD", "eth"].map(marketSymbol)).to.deep.equal(["SOL", "BTC", "ETH"]);
  });
});

describe("structured result readers", () => {
  it("finds the caller status in several shapes", () => {
    expect(callerStatus(out({ you: { joined: true, funded: false, owner: "9szZ2vRhqBJx3jPgsNfsQUDYyy6vD2z7bL26rqJAa33c" } }))).to.deep.equal({ joined: true, funded: false, alive: undefined, owner: "9szZ2vRhqBJx3jPgsNfsQUDYyy6vD2z7bL26rqJAa33c" });
    expect(callerStatus(out({ caller: { status: { joined: false } } })).joined).to.equal(false);
    expect(callerStatus(out(undefined, "Round live. joined: yes, funded: yes")).joined).to.equal(true);
    expect(callerStatus(out(undefined, "You have not joined this round.")).joined).to.equal(false);
    expect(callerStatus({ text: "x", isError: true }).joined).to.equal(undefined);
  });

  it("reads tick, position and version", () => {
    expect(roundTick(out({ round: { tick: "838", durationTicks: 7200 } }))).to.deep.equal({ tick: 838, duration: 7200 });
    expect(roundTick(out(undefined, "tick 12 of 900"))).to.deep.equal({ tick: 12, duration: 900 });
    expect(positionView(out({ position: { margin: 200_000_000, equity: "190904459" } }))).to.include({ margin: 200_000_000, equity: 190904459 });
    expect(positionView(out(undefined, "Margin 100 USDC, equity 95.20 USDC"))).to.include({ margin: 100, equity: 95.2 });
    expect(strategyVersion(out({ version: 3 }))).to.equal(3);
    expect(strategyVersion(out(undefined, "Strategy replaced: version 4"))).to.equal(4);
  });

  it("does not take scoreboard rows for the caller's own fields", () => {
    const v = positionView(out({ entries: [{ equity: 1 }], position: { equity: 50, margin: 60 } }));
    expect(v).to.include({ equity: 50, margin: 60 });
  });

  it("decides losing from equity vs margin, then PnL", () => {
    expect(isLosing({ equity: 95, margin: 100 }, null)).to.equal(true);
    expect(isLosing({ equity: 101, margin: 100 }, null)).to.equal(false);
    expect(isLosing({ equity: 99 }, 100)).to.equal(true);
    expect(isLosing({ realizedPnl: -1, unrealizedPnl: 0.5 }, null)).to.equal(true);
    expect(isLosing({}, null)).to.equal(false);
  });

  it("chooses the market argument from the tool schema", () => {
    const tb = (market: Record<string, unknown>) => ({ specs: [{ name: "get_market_history", inputSchema: { type: "object", properties: { market } } }] }) as unknown as Toolbox;
    const names = ["SOL-PERP", "BTC-PERP"];
    const syms = ["SOL", "BTC"];
    expect(marketArg(tb({ type: "integer" }), "get_market_history", 1, names, syms)).to.equal(1);
    expect(marketArg(tb({ type: "string", enum: names }), "get_market_history", 1, names, syms)).to.equal("BTC-PERP");
    expect(marketArg(tb({ type: "string" }), "get_market_history", 1, names, syms)).to.equal("BTC");
    expect(marketArg(tb({ anyOf: [{ type: "integer" }, { type: "string" }] }), "get_market_history", 0, names, syms)).to.equal(0);
  });
});
