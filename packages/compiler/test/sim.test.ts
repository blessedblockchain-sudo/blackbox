import { expect } from "chai";
import { simulate, compile, EXAMPLES } from "../src";
import { strategies } from "@blackbox/sdk/src";
import { MARKETS, ok, SERIES } from "./helpers";

const opts = { markets: MARKETS };

describe("simulate()", () => {
  it("is deterministic (including rand() for a fixed seed)", () => {
    for (const code of [ok(EXAMPLES.trend).bytecode, strategies.randomWalk(0), ok(EXAMPLES.rotation).bytecode]) {
      const series = SERIES.randomWalk(400, 11, 0.003);
      const a = simulate(code, series, { ...opts, seed: 5, trace: true });
      const b = simulate(code, series, { ...opts, seed: 5, trace: true });
      expect(a).to.deep.equal(b);
    }
    const series = SERIES.randomWalk(400, 11, 0.003);
    const s1 = simulate(strategies.randomWalk(0), series, { ...opts, seed: 1, trace: true });
    const s2 = simulate(strategies.randomWalk(0), series, { ...opts, seed: 2, trace: true });
    expect(s1.trace!.map((t) => t.actions.join())).to.not.deep.equal(s2.trace!.map((t) => t.actions.join()));
  });

  it("always-long on a rising series gains", () => {
    const code = ok("if pos(SOL) <= 0 { long(SOL, 50%) }").bytecode;
    const r = simulate(code, SERIES.trend(200, 0.001), opts);
    expect(r.trades).to.equal(1);
    expect(r.liquidated).to.equal(false);
    expect(r.finalEquity).to.be.greaterThan(100);
    // 50% of 20x = 10x exposure: ~ +22% move (1.001^199) -> roughly +220% on margin
    expect(r.finalEquity).to.be.within(280, 340);
    expect(r.equity.length).to.equal(200);
    expect(r.maxDrawdown).to.be.lessThan(0.01);
    expect(r.sharpe).to.be.greaterThan(0);
    // the SDK's alwaysLong bot does the same
    expect(simulate(strategies.alwaysLong(0), SERIES.trend(200, 0.001), opts).finalEquity).to.equal(r.finalEquity);
  });

  it("max-leverage long on a crash liquidates", () => {
    const code = ok("if pos(SOL) == 0 { long(SOL, 100%) }").bytecode;
    const r = simulate(code, SERIES.crash(120, 40, 0.1), { ...opts, trace: true });
    expect(r.liquidated).to.equal(true);
    const at = r.trace!.findIndex((t) => t.liquidated);
    expect(at).to.be.greaterThan(40);
    // flat and dead afterwards: equity frozen, no more trades
    const after = r.equity.slice(at);
    expect(new Set(after).size).to.equal(1);
    expect(r.trace!.slice(at + 1).every((t) => t.actions.length === 0 && t.steps === 0)).to.equal(true);
    expect(r.finalEquity).to.be.lessThan(60);
    expect(r.trades).to.equal(1); // the opening trade (liquidation closes are not strategy trades)
    expect(r.maxDrawdown).to.be.greaterThan(0.4);
    // the SDK's degen bot is the same program
    const d = simulate(strategies.degen(0), SERIES.crash(120, 40, 0.1), opts);
    expect(d.liquidated).to.equal(true);
    expect(d.equity).to.deep.equal(r.equity);
  });

  it("a 10x-leverage market caps exposure lower than a 20x one", () => {
    const code = ok("long(SOL, 100%)\nlong(ETH, 100%)").bytecode;
    // one tick: SOL goes to 20x equity; ETH then wants 10x equity on top, but its
    // check is |target| + other notional <= equity x 10, so it is rejected
    const r = simulate(code, SERIES.trend(1, 0), { markets: MARKETS, maxLeverage: [20, 20, 10], trace: true });
    expect(r.trace![0].actions).to.deep.equal(["long m0 10000bps", "long m2 10000bps"]);
    expect(r.trades).to.equal(1); // ETH rejected by the leverage check
  });

  it("faults discard the tick's actions and are reported with tick and pc", () => {
    const code = ok("long(SOL, 10%)\nmem[0] = 1 / (price(SOL) - price(SOL))").bytecode;
    const r = simulate(code, SERIES.sine(10), opts);
    expect(r.trades).to.equal(0);
    expect(r.faults.length).to.equal(10);
    expect(r.faults[0]).to.deep.equal({ tick: 0, fault: "DivByZero", pc: 18 }); // long(4) push(9) price(2) price(2) sub(1) -> div at 18
    expect(r.finalEquity).to.equal(100);
  });

  it("honors the step limit", () => {
    const r = simulate(strategies.momentum(0), SERIES.sine(20), { ...opts, stepLimit: 5 });
    expect(r.faults.length).to.equal(20);
    expect(r.faults.every((f) => f.fault === "StepLimit")).to.equal(true);
    expect(r.trades).to.equal(0);
  });

  it("ret() is 0 until the ring has history, and memory persists across ticks", () => {
    const code = ok("mem[0] = mem[0] + 1\nif ret(SOL, 10) == 0 { mem[1] = mem[1] + 1 }").bytecode;
    const r = simulate(code, SERIES.trend(30, 0.001), opts);
    expect(r.mem![0]).to.equal(30);
    expect(r.mem![1]).to.equal(10); // ticks 0..9 lack 11 marks of history
  });

  it("uses margin and cost defaults, and accepts overrides", () => {
    const code = ok("if pos(SOL) == 0 { long(SOL, 10%) }").bytecode;
    const flat = SERIES.trend(5, 0);
    const base = simulate(code, flat, opts);
    // 10% of 20x = 200 notional filled at mark x 1.0002: unrealized = 200 x (1/1.0002 - 1)
    expect(base.finalEquity).to.equal(99.960008);
    const wide = simulate(code, flat, { ...opts, margin: 1000, spreadBps: 10 });
    expect(wide.finalEquity).to.be.closeTo(1000 + 2000 * (1 / 1.001 - 1), 1e-5);
  });

  it("skips ticks with a missing price (the on-chain oracle check fails the whole tick)", () => {
    const series = SERIES.trend(6, 0.001);
    series[2] = { prices: [0, 60_000, 3_000] };
    const r = simulate(ok("mem[0] = mem[0] + 1").bytecode, series, { ...opts, trace: true });
    expect(r.mem![0]).to.equal(5);
    expect(r.trace![2].skipped).to.equal(true);
    expect(() => simulate(ok("halt()").bytecode, [{ prices: [1] }], opts)).to.throw(/expected 3/);
  });

  it("drawdownStop example stops out and stays flat", () => {
    const r = simulate(ok(EXAMPLES.drawdownStop).bytecode, SERIES.crash(200, 60, 0.12), { ...opts, trace: true });
    expect(r.mem![1]).to.equal(1); // stopped
    expect(r.liquidated).to.equal(false);
    const stop = r.trace!.findIndex((t) => t.actions.includes("close_all"));
    expect(stop).to.be.greaterThan(0);
    expect(r.trace!.slice(stop + 1).every((t) => t.actions.length === 0)).to.equal(true);
  });

  it("cooldown example trades at most once per 21 ticks", () => {
    const r = simulate(ok(EXAMPLES.cooldown).bytecode, SERIES.sine(400, 12, 0.02), { ...opts, trace: true });
    const tradeTicks = r.trace!.filter((t) => t.actions.length).map((t) => t.tick);
    expect(tradeTicks.length).to.be.greaterThan(3);
    for (let i = 1; i < tradeTicks.length; i++) expect(tradeTicks[i] - tradeTicks[i - 1]).to.be.gte(21);
  });

  it("returns the full SimResult shape", () => {
    const r = simulate(compile(EXAMPLES.pairs, opts).bytecode, SERIES.randomWalk(100, 3), opts);
    expect(r).to.have.keys(["equity", "trades", "liquidated", "faults", "finalEquity", "maxDrawdown", "sharpe", "mem"]);
    expect(r.equity.length).to.equal(100);
    expect(Number.isFinite(r.sharpe)).to.equal(true);
  });
});
