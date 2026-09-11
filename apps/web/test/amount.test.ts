import { expect } from "chai";
import { checkRange, formatUsdcAmount, parseUsdcInput, toMicro } from "../lib/amount";
import { formatBps } from "../lib/format";

describe("amount: exact USDC parsing", () => {
  it("parses integers, decimals and thousands separators into 6-dp units", () => {
    const ok = (s: string) => {
      const r = parseUsdcInput(s);
      if (!r.ok) throw new Error(r.error);
      return r.micro;
    };
    expect(ok("200")).to.equal(200_000_000n);
    expect(ok("250.5")).to.equal(250_500_000n);
    expect(ok("1,250.000001")).to.equal(1_250_000_001n);
    expect(ok("0.000001")).to.equal(1n);
    expect(ok(" 50 ")).to.equal(50_000_000n);
    expect(ok(".5")).to.equal(500_000n);
    expect(ok("7.")).to.equal(7_000_000n);
  });
  it("never goes through floats", () => {
    const r = parseUsdcInput("4999.999999");
    expect(r.ok && r.micro).to.equal(4_999_999_999n);
    const big = parseUsdcInput("90071992547.409919");
    expect(big.ok && big.micro).to.equal(90_071_992_547_409_919n);
  });
  it("rejects what USDC cannot represent", () => {
    for (const bad of ["", ".", "-5", "+5", "1e3", "12.3456789", "1.2.3", "abc", "0", "0.000000"]) {
      expect(parseUsdcInput(bad).ok, bad).to.equal(false);
    }
    const r = parseUsdcInput("1.1234567");
    expect(!r.ok && r.error).to.match(/6 digits/);
  });
  it("checks the round's margin range in micro-units", () => {
    expect(checkRange(50_000_000n, 50, 5000)).to.equal(null);
    expect(checkRange(5_000_000_000n, 50, 5000)).to.equal(null);
    expect(checkRange(49_999_999n, 50, 5000)).to.match(/between 50 and 5,000 USDC/);
    expect(checkRange(5_000_000_001n, 50, 5000)).to.match(/between 50 and 5,000 USDC/);
    expect(toMicro(0.1 + 0.2)).to.equal(300_000n);
  });
  it("formats amounts for sentences", () => {
    expect(formatUsdcAmount(2000)).to.equal("2,000");
    expect(formatUsdcAmount(250.5)).to.equal("250.5");
    expect(formatUsdcAmount(0.000001)).to.equal("0.000001");
    expect(formatUsdcAmount(NaN)).to.equal("--");
  });
});

describe("format: integer bps", () => {
  it("formats fee prices without a fake decimal", () => {
    expect(formatBps(25, { decimals: 0 })).to.equal("25 bps");
    expect(formatBps(100, { decimals: 0 })).to.equal("100 bps");
    expect(formatBps(0, { decimals: 0 })).to.equal("0 bps");
    expect(formatBps(0.2, { decimals: 0 })).to.equal("<1 bps");
    expect(formatBps(null, { decimals: 0 })).to.equal("--");
    // the default keeps one decimal
    expect(formatBps(25)).to.equal("25.0 bps");
  });
});
