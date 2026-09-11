import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { lockedFeeBps, toEntrantView, toLicenseView } from "../lib/chain";
import { sortHall, toHallRow } from "../lib/server/hall";
import type { HallRow } from "../lib/api-types";

// Decoded Anchor accounts carry BN-like numbers; strings behave the same through toNum/fromMicro.
const leg = (side: number, size: string, entry: string) => ({ side, size, entry, fundingIndex: "0" });
const flatLeg = leg(0, "0", "0");

describe("chain: License view", () => {
  const base = {
    round: new PublicKey("EHfSy9AYJ6ZBrdSEEa7GUroyEAFVHch9m6fKATrEaPNZ"),
    buyer: new PublicKey("GbH8QqYPAyZGVw8j1uu4Cg4snxMHzyhNYuR3eH9eGhD1"),
    author: new PublicKey("gDKGDrgu1yd5nX7YJ1UFiLsG8P1duBcByAmKN9t6jMk"),
    margin: "200000000",
    realizedPnl: "-1250000",
    legs: [leg(1, "3000000000", "150250000"), flatLeg, leg(-1, "500000000", "3100000000"), ...Array(5).fill(flatLeg)],
    mem: Array(16).fill("0"),
    accruedFees: "750000",
    openedTick: "1200",
    lastEquity: "203400000",
    peakEquity: "205000000",
    ranTick: "1301",
    tradeCount: 4,
    feeBps: 25,
    active: 1,
    liquidated: 0,
    settled: 0,
    bump: 254,
    lastFault: 0,
  };

  it("decodes an active license (6-dp USDC, ran_tick is tick + 1)", () => {
    const v = toLicenseView(base);
    expect(v.margin).to.equal(200);
    expect(v.realizedPnl).to.equal(-1.25);
    expect(v.accruedFees).to.equal(0.75);
    expect(v.lastEquity).to.equal(203.4);
    expect(v.lastTick).to.equal(1300);
    expect(v.feeBps).to.equal(25);
    expect(v.active).to.equal(true);
    expect(v.scrubbed).to.equal(false);
    expect(v.legs).to.deep.equal([
      { market: 0, side: 1, size: 3000, entry: 150.25 },
      { market: 2, side: -1, size: 500, entry: 3100 },
    ]);
  });

  it("recognizes a scrubbed license (settle_license zeroes the body)", () => {
    const zero = new PublicKey(new Uint8Array(32));
    const v = toLicenseView({ ...base, round: zero, buyer: zero, author: zero, margin: "0", lastEquity: "0", ranTick: "0", active: 0, feeBps: 0, legs: Array(8).fill(flatLeg) });
    expect(v.scrubbed).to.equal(true);
    expect(v.lastTick).to.equal(null);
    expect(v.active).to.equal(false);
  });

  it("locks max(author price, round floor)", () => {
    expect(lockedFeeBps(25, 5)).to.equal(25);
    expect(lockedFeeBps(0, 5)).to.equal(5);
  });

  it("reads the public blind price and license count from an Entrant", () => {
    const e = toEntrantView({
      owner: base.author,
      index: 3,
      alive: true,
      deposited: "200000000",
      strategyVersion: 2,
      privatized: true,
      settled: false,
      strategyHash: Array(32).fill(0),
      feePriceBps: 37,
      licenseCount: 2,
    });
    expect(e.feePriceBps).to.equal(37);
    expect(e.licenseCount).to.equal(2);
    expect(e.strategyHash).to.equal("");
  });
});

describe("hall: rows and ordering", () => {
  it("maps a Hall account (6-dp PnL, best rank 0 = none)", () => {
    const names = new Map([["gDKGDrgu1yd5nX7YJ1UFiLsG8P1duBcByAmKN9t6jMk", { name: "Momentum", bot: true }]]);
    const r = toHallRow("HALL", { wallet: new PublicKey("gDKGDrgu1yd5nX7YJ1UFiLsG8P1duBcByAmKN9t6jMk"), rounds: 3, wins: 1, podiums: 2, totalPnl: "-12500000", elo: 1008, bestRank: 0 }, names);
    expect(r).to.deep.include({ name: "Momentum", bot: true, rounds: 3, wins: 1, podiums: 2, totalPnl: -12.5, elo: 1008, bestRank: null, hall: "HALL" });
  });

  it("sorts by ELO, then wins, PnL and rounds", () => {
    const mk = (wallet: string, elo: number, wins = 0, totalPnl = 0, rounds = 1): HallRow => ({ wallet, name: null, bot: false, rounds, wins, podiums: 0, totalPnl, elo, bestRank: null, hall: wallet });
    const out = sortHall([mk("a", 1000), mk("b", 1016, 1), mk("c", 1016, 2), mk("d", 984), mk("e", 1016, 2, 5)]);
    expect(out.map((r) => r.wallet)).to.deep.equal(["e", "c", "b", "a", "d"]);
  });
});
