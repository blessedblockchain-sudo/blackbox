/**
 * The TS VM and perps ports, checked against the same cases as the Rust unit
 * tests in crates/bxvm/src/exec.rs and programs/blackbox/src/perps.rs.
 */
import { expect } from "chai";
import { Asm, Op } from "@blackbox/sdk/src/vm";
import { execute, faultName, FAULTS } from "../src/interp";
import { fdiv, fmul, I64_MAX, I64_MIN, frem, fneg, fabs } from "../src/fixed";
import * as P from "../src/perps";
import { S, host, prng } from "./helpers";

const mem16 = () => new Array<bigint>(16).fill(0n);

describe("interp (port of bxvm::exec)", () => {
  it("ema cross goes long", () => {
    const code = new Asm().ema(0, 8).ema(0, 21).gt().pos(0).push(0).eq().and().jz("end").long(0, 3000).label("end").halt().build();
    const r = execute(code, host(), mem16(), 512);
    expect(r.fault).to.equal(null);
    expect(r.actions).to.deep.equal([{ kind: "long", market: 0, bps: 3000 }]);
  });

  it("a fault discards actions", () => {
    const code = new Asm().long(0, 1000).pop().halt().build();
    const r = execute(code, host(), mem16(), 512);
    expect(r.fault).to.equal("StackUnderflow");
    expect(r.actions).to.deep.equal([]);
    expect(r.pc).to.equal(4);
  });

  it("the step limit stops loops", () => {
    const code = new Asm().label("top").jmp("top").build();
    const r = execute(code, host(), mem16(), 100);
    expect(r.fault).to.equal("StepLimit");
    expect(r.steps).to.equal(100);
  });

  it("memory persists across ticks", () => {
    const code = new Asm().mld(3).push(S).add().mst(3).halt().build();
    const mem = mem16();
    for (let i = 0; i < 5; i++) expect(execute(code, host(), mem, 512).fault).to.equal(null);
    expect(mem[3]).to.equal(5n * S);
  });

  it("fixed-point math saturates like i128 -> i64 clamps", () => {
    expect(fmul(2n * S, 3n * S)).to.equal(6n * S);
    expect(fdiv(6n * S, 3n * S)).to.equal(2n * S);
    expect(fdiv(1n, 0n)).to.equal(null);
    expect(fmul(I64_MAX, 2n * S)).to.equal(I64_MAX);
    expect(fmul(-7n, 1n)).to.equal(0n); // truncates toward zero
    expect(fdiv(-1n, 3n * S)).to.equal(0n);
    expect(frem(I64_MIN, -1n)).to.equal(0n);
    expect(frem(-7n, 3n)).to.equal(-1n);
    expect(fneg(I64_MIN)).to.equal(I64_MAX);
    expect(fabs(I64_MIN)).to.equal(I64_MAX);
  });

  it("faults: BadVersion, DivByZero, BadMarket, NoData, TooManyActions, StackOverflow, BadJump, Truncated, BadOpcode", () => {
    const f = (code: Uint8Array, h = host()) => execute(code, h, mem16(), 512).fault;
    expect(f(Uint8Array.from([2, 1]))).to.equal("BadVersion");
    expect(f(new Asm().push(1).push(0).div().build())).to.equal("DivByZero");
    expect(f(new Asm().push(1).push(0).op(Op.Mod).build())).to.equal("DivByZero");
    expect(f(new Asm().price(5).build())).to.equal("BadMarket");
    expect(f(new Asm().price(0).build(), host({ price: () => null }))).to.equal("NoData");
    const nine = new Asm();
    for (let i = 0; i < 9; i++) nine.close(0);
    expect(f(nine.build())).to.equal("TooManyActions");
    const deep = new Asm();
    for (let i = 0; i < 65; i++) deep.push(1);
    expect(f(deep.build())).to.equal("StackOverflow");
    expect(f(Uint8Array.from([1, Op.Jmp, 0xff, 0x00]))).to.equal("BadJump");
    expect(f(Uint8Array.from([1, Op.Push, 1, 2]))).to.equal("Truncated");
    expect(f(Uint8Array.from([1, 250]))).to.equal("BadOpcode");
    expect(f(Uint8Array.from([1, Op.Mld, 16]))).to.equal("BadOperand");
    expect(f(Uint8Array.from([1, Op.Ema, 0, 3]))).to.equal("BadOperand");
    expect(f(Uint8Array.from([1, Op.Long, 0, 0x11, 0x27]))).to.equal("BadOperand"); // 10001 bps
  });

  it("falling off the end is a normal halt; halt keeps earlier actions", () => {
    const r = execute(new Asm().close(1).halt().close(2).build(), host(), mem16(), 512);
    expect(r.fault).to.equal(null);
    expect(r.actions).to.deep.equal([{ kind: "close", market: 1 }]);
    const r2 = execute(new Asm().push(1).pop().build(), host(), mem16(), 512);
    expect(r2.fault).to.equal(null);
    expect(r2.pc).to.equal(10);
  });

  it("fault names match the on-chain last_fault encoding (index + 1)", () => {
    expect(faultName(0)).to.equal(null);
    expect(faultName(1)).to.equal("BadVersion");
    expect(faultName(10)).to.equal("StepLimit");
    expect(faultName(12)).to.equal("NoData");
    expect(FAULTS.length).to.equal(12);
  });

  it("random bytes never throw and respect the step limit", () => {
    const r = prng(0x9e3779b9);
    const mem = mem16();
    for (let i = 0; i < 3000; i++) {
      const buf = new Uint8Array(96);
      buf[0] = 1;
      for (let k = 1; k < buf.length; k++) buf[k] = Math.floor(r() * 256);
      const res = execute(buf, host(), mem, 512);
      expect(res.steps).to.be.lte(512);
      if (res.fault) expect(res.actions.length).to.equal(0);
    }
  });
});

describe("perps (port of programs/blackbox/src/perps.rs)", () => {
  const market = (mark: bigint) => {
    const m = P.newMarket({ maxLeverage: 10, maintenanceBps: 500, baseSpreadBps: 5, skewSpreadBps: 50, oiCap: 1_000_000n * S });
    m.mark = mark;
    return m;
  };

  it("open and close a long realizes PnL", () => {
    const m = market(100n * S);
    const leg = P.newLeg();
    const eq = 1_000n * S;
    const r = P.tradeToTarget(m, leg, 3_000n * S, eq, 0n);
    expect(r.traded).to.equal(true);
    expect(leg.side).to.equal(1);
    expect(leg.size).to.equal(3_000n * S);
    expect(leg.entry > 100n * S).to.equal(true);
    expect(m.oiLong).to.equal(3_000n * S);
    m.mark = 110n * S;
    const u = P.unrealized(leg, m.mark);
    expect(u > 290n * S && u < 300n * S, String(u)).to.equal(true);
    const r2 = P.tradeToTarget(m, leg, 0n, eq + u, 0n);
    expect(leg.side).to.equal(0);
    expect(r2.realizedDelta > 290n * S && r2.realizedDelta < 300n * S).to.equal(true);
    expect(m.oiLong).to.equal(0n);
  });

  it("leverage and OI caps reject increases", () => {
    const m = market(100n * S);
    const leg = P.newLeg();
    expect(() => P.tradeToTarget(m, leg, 20_000n * S, 1_000n * S, 0n)).to.throw("LeverageExceeded");
    m.oiCap = 100n * S;
    expect(() => P.tradeToTarget(m, leg, 200n * S, 1_000n * S, 0n)).to.throw("OiCap");
  });

  it("flip side", () => {
    const m = market(100n * S);
    const leg = P.newLeg();
    P.tradeToTarget(m, leg, 1_000n * S, 1_000n * S, 0n);
    P.tradeToTarget(m, leg, -500n * S, 1_000n * S, 0n);
    expect(leg.side).to.equal(-1);
    expect(leg.size).to.equal(500n * S);
    expect(m.oiLong).to.equal(0n);
    expect(m.oiShort).to.equal(500n * S);
  });

  it("indicators and returns", () => {
    const m = market(0n);
    [100n, 101n, 102n, 103n, 104n].forEach((px, t) => P.updateIndicators(m, px * S, t));
    expect(m.mark).to.equal(104n * S);
    expect(P.markAgo(m, 1)).to.equal(104n * S);
    expect(P.markAgo(m, 2)).to.equal(103n * S);
    const r1 = P.ret(m, 1)!;
    expect(r1 > 9_000n && r1 < 10_000n, String(r1)).to.equal(true);
    expect(m.ema8 > 100n * S && m.ema8 < 104n * S).to.equal(true);
    expect(m.vol > 0n).to.equal(true);
    expect(P.ret(m, 4)).to.equal(40_000n); // 104/100 - 1
    expect(P.ret(m, 5)).to.equal(null); // not enough history
  });

  it("ret(64) never has history (the ring holds 64 marks, ret needs 65)", () => {
    const m = market(0n);
    for (let t = 0; t < 200; t++) P.updateIndicators(m, (100n + BigInt(t)) * S, t);
    expect(P.ret(m, 63)).to.not.equal(null);
    expect(P.ret(m, 64)).to.equal(null);
  });

  it("spread widens with skew", () => {
    const m = market(100n * S);
    const flat = P.spreadFrac(m, 1);
    m.oiLong = 500_000n * S;
    expect(P.spreadFrac(m, 1) > flat).to.equal(true);
    expect(P.spreadFrac(m, -1)).to.equal(flat);
  });

  it("isqrt", () => {
    expect(P.isqrt(0n)).to.equal(0n);
    expect(P.isqrt(15n)).to.equal(3n);
    expect(P.isqrt(16n)).to.equal(4n);
    expect(P.isqrt(10n ** 30n)).to.equal(10n ** 15n);
  });
});
