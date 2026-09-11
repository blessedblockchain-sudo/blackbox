import { expect } from "chai";
import {
  DASH,
  formatBps,
  formatDuration,
  formatInt,
  formatPercent,
  formatPrice,
  formatRatio,
  formatUsd,
  fromMicro,
  plainDecimal,
  returnPct,
  shortAddr,
  zeroSubscript,
} from "../lib/format";

describe("format: USD values", () => {
  it("follows the spec examples", () => {
    expect(formatUsd(0)).to.equal("$0.00");
    expect(formatUsd(0.004)).to.equal("<$0.01");
    expect(formatUsd(-0.004, { signed: true })).to.equal("-<$0.01");
    expect(formatUsd(1234.5, { compact: true })).to.equal("$1.2K");
    expect(formatUsd(1234.5)).to.equal("$1,234.50");
    expect(formatUsd(1.52e12, { compact: true })).to.equal("$1.5T");
    expect(formatUsd(1.52e12)).to.equal("$1,520,000,000,000.00");
  });
  it("signs PnL and never shows signed zero", () => {
    expect(formatUsd(3.1, { signed: true })).to.equal("+$3.10");
    expect(formatUsd(-3.1, { signed: true })).to.equal("-$3.10");
    expect(formatUsd(-0, { signed: true })).to.equal("$0.00");
    expect(formatUsd(-12.5)).to.equal("-$12.50");
  });
  it("promotes abbreviations that round up", () => {
    expect(formatUsd(999_950, { compact: true })).to.equal("$1M");
    expect(formatUsd(188.949368, { compact: true })).to.equal("$188.95");
  });
  it("renders missing values as --", () => {
    expect(formatUsd(null)).to.equal(DASH);
    expect(formatUsd(NaN)).to.equal(DASH);
    expect(formatUsd(Infinity)).to.equal(DASH);
  });
});

describe("format: prices", () => {
  it("follows the token_price table", () => {
    expect(formatPrice(84000, "compact")).to.equal("$84,000.00");
    expect(formatPrice(142.1234, "compact")).to.equal("$142");
    expect(formatPrice(142.1234, "detailed")).to.equal("$142.12");
    expect(formatPrice(12.3456, "compact")).to.equal("$12.3");
    expect(formatPrice(12.3456, "detailed")).to.equal("$12.346");
    expect(formatPrice(0.1235, "compact")).to.equal("$0.124");
    expect(formatPrice(0.1235, "detailed")).to.equal("$0.12350");
    expect(formatPrice(0.00005835, "compact")).to.equal("$0.0₄58");
    expect(formatPrice(0.00005835, "detailed")).to.equal("$0.0₄5835");
    expect(formatPrice(-0.00005835, "compact")).to.equal("-$0.0₄58");
    expect(formatPrice(0)).to.equal("$0.00");
    expect(formatPrice(undefined)).to.equal(DASH);
  });
  it("zero-subscript handles carries", () => {
    expect(zeroSubscript(0.00009999, 2)).to.equal("0.0₃1");
  });
  it("expands decimals without scientific notation", () => {
    expect(plainDecimal(0.00005835)).to.equal("0.00005835");
    expect(plainDecimal(1e21)).to.not.include("e");
  });
});

describe("format: percent, ratio, bps, ints", () => {
  it("percent", () => {
    expect(formatPercent(0)).to.equal("0.00%");
    expect(formatPercent(0.004)).to.equal("<0.01%");
    expect(formatPercent(-0.004, { signed: true })).to.equal("-<0.01%");
    expect(formatPercent(12.345)).to.equal("12.35%");
    expect(formatPercent(123.456)).to.equal("123.5%");
    expect(formatPercent(10250.4)).to.equal("10,250%");
    expect(formatPercent(5.5, { signed: true })).to.equal("+5.50%");
    expect(formatPercent(-5.5, { signed: true })).to.equal("-5.50%");
  });
  it("ratio", () => {
    expect(formatRatio(0)).to.equal("0x");
    expect(formatRatio(0.004)).to.equal("<0.01x");
    expect(formatRatio(2.567)).to.equal("2.57x");
    expect(formatRatio(1250)).to.equal("1,250x");
    expect(formatRatio(20)).to.equal("20x");
  });
  it("bps", () => {
    expect(formatBps(0)).to.equal("0 bps");
    expect(formatBps(1.24)).to.equal("1.2 bps");
    expect(formatBps(-3, { signed: true })).to.equal("-3.0 bps");
  });
  it("ints and durations", () => {
    expect(formatInt(7200)).to.equal("7,200");
    expect(formatInt(-0.2)).to.equal("0");
    expect(formatDuration(42_000)).to.equal("42s");
    expect(formatDuration(725_000)).to.equal("12m 05s");
    expect(formatDuration(3_720_000)).to.equal("1h 02m");
    expect(formatDuration(-1)).to.equal(DASH);
  });
});

describe("format: helpers", () => {
  it("fromMicro accepts BN-like, bigint, string", () => {
    expect(fromMicro(188_949_368)).to.equal(188.949368);
    expect(fromMicro(5_000_000n)).to.equal(5);
    expect(fromMicro("40000000")).to.equal(40);
    expect(fromMicro({ toString: () => "1500000" })).to.equal(1.5);
    expect(Number.isNaN(fromMicro(null))).to.equal(true);
  });
  it("returnPct and shortAddr", () => {
    expect(returnPct(188.95, 200)).to.be.closeTo(-5.525, 1e-9);
    expect(Number.isNaN(returnPct(10, 0))).to.equal(true);
    expect(shortAddr("9szZ2vRhqBJx3jPgsNfsQUDYyy6vD2z7bL26rqJAa33c")).to.equal("9szZ…a33c");
  });
});
