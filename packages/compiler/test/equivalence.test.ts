/**
 * BXL programs that re-implement the SDK's hand-assembled bots must behave
 * identically: same actions on every tick, same equity curve.
 */
import { expect } from "chai";
import { simulate, EXAMPLES } from "../src";
import { MARKETS, ok, SERIES } from "./helpers";
import { ports, Port } from "./ports";

const P = ports((i) => MARKETS[i]);
const PORTS: Record<string, Port> = {
  momentum: { bxl: EXAMPLES.momentum, sdk: P.momentum(0).sdk },
  momentumEth: P.momentum(2, 4000),
  meanReversion: P.meanReversion(0),
  meanReversionBtc: P.meanReversion(1, 3000),
  breakout: P.breakout(1),
  breakoutSol: P.breakout(0, 3000),
  randomWalk: P.randomWalk(2),
  alwaysLong: P.alwaysLong(0),
  degen: P.degen(1),
  pairs: P.pairs(0, 1),
  pairsReversed: P.pairs(1, 2, 1500),
};

const SETS = {
  randomWalk: SERIES.randomWalk(600, 42, 0.003),
  choppy: SERIES.randomWalk(600, 7, 0.006),
  sine: SERIES.sine(600, 30, 0.02),
  trendUp: SERIES.trend(300, 0.0015),
  trendDown: SERIES.trend(300, -0.0015),
  crash: SERIES.crash(300, 150, 0.15),
};

describe("BXL vs SDK hand-assembled bots (behavioral equivalence)", () => {
  for (const [name, { bxl, sdk }] of Object.entries(PORTS)) {
    it(`${name}: same actions on every tick and the same equity curve`, () => {
      const code = ok(bxl).bytecode;
      let acted = 0;
      for (const [setName, series] of Object.entries(SETS)) {
        for (const seed of [0, 9]) {
          const a = simulate(code, series, { markets: MARKETS, trace: true, seed });
          const b = simulate(sdk, series, { markets: MARKETS, trace: true, seed });
          expect(a.trace!.map((t) => t.actions), `${name}/${setName}`).to.deep.equal(b.trace!.map((t) => t.actions));
          expect(a.equity, `${name}/${setName}`).to.deep.equal(b.equity);
          expect(a.trades).to.equal(b.trades);
          expect(a.liquidated).to.equal(b.liquidated);
          acted += a.trace!.filter((t) => t.actions.length).length;
        }
      }
      expect(acted, "the series must actually exercise the strategy").to.be.greaterThan(2);
    });
  }

  it("momentum trades on both sides across the test series", () => {
    const a = simulate(ok(EXAMPLES.momentum).bytecode, SETS.sine, { markets: MARKETS, trace: true });
    const acts = a.trace!.flatMap((t) => t.actions);
    expect(acts.some((x) => x.startsWith("long"))).to.equal(true);
    expect(acts.some((x) => x.startsWith("short"))).to.equal(true);
  });
});
