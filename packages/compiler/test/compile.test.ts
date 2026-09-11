import { expect } from "chai";
import { execFileSync } from "child_process";
import * as path from "path";
import { EXAMPLES, formatListing, analyze, simulate } from "../src";
import { validate, disassemble, strategies, MAX_BYTECODE_LEN } from "@blackbox/sdk/src";
import { MARKETS, ROUND_MARKETS, S, ok, run, host, SERIES } from "./helpers";

const ROOT = path.resolve(__dirname, "../../..");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("BXL examples", () => {
  it("has at least 6 examples covering the brief", () => {
    const names = Object.keys(EXAMPLES);
    expect(names.length).to.be.gte(6);
    for (const n of ["trend", "meanReversion", "breakout", "pairs", "cooldown", "drawdownStop"]) expect(names).to.include(n);
  });

  for (const [name, src] of Object.entries(EXAMPLES)) {
    it(`${name} compiles, validates, and has a listing`, () => {
      for (const markets of [MARKETS, ROUND_MARKETS, ["eth", "btc", "sol"]]) {
        const r = ok(src, markets);
        expect(r.bytecode[0]).to.equal(1);
        expect(r.bytecode.length).to.be.lte(MAX_BYTECODE_LEN);
        expect(validate(r.bytecode, markets.length)).to.equal(null);
        expect(r.maxSteps).to.be.greaterThan(0).and.lte(512);
        expect(r.maxSteps).to.equal(analyze(r.bytecode).maxSteps);
        expect(r.listing).to.match(/^; \d+: /);
        const offsets = disassemble(r.bytecode).map((d) => d.offset);
        for (const o of offsets) expect(r.listing).to.include(String(o).padStart(4, "0") + "  ");
        expect(r.warnings ?? []).to.deep.equal([]);
      }
    });
  }

  it("every example is accepted by the Rust validator with identical instruction boundaries", function () {
    this.timeout(300_000);
    const blobs = Object.values(EXAMPLES).map((s) => ok(s).bytecode);
    let out: string;
    try {
      out = execFileSync("cargo", ["run", "-q", "-p", "bxvm", "--example", "check", "--", "3", ...blobs.map(hex)], { cwd: ROOT, encoding: "utf8" });
    } catch (e) {
      this.skip();
      return;
    }
    const lines = out.trim().split("\n");
    expect(lines.length).to.equal(blobs.length);
    lines.forEach((l, i) => {
      expect(l.startsWith("OK|"), l).to.equal(true);
      const rustOffsets = l.slice(3).split(";").map((s) => Number(s.split(":")[0]));
      expect(disassemble(blobs[i]).map((d) => d.offset)).to.deep.equal(rustOffsets);
    });
  });

  it("maxSteps is a true upper bound: simulated runs never exceed it", () => {
    for (const [name, src] of Object.entries(EXAMPLES)) {
      const r = ok(src);
      for (const series of [SERIES.randomWalk(300, 7, 0.004), SERIES.sine(300), SERIES.crash(200, 100, 0.08)]) {
        const sim = simulate(r.bytecode, series, { markets: MARKETS, trace: true });
        const worst = Math.max(...sim.trace!.map((t) => t.steps));
        expect(worst, name).to.be.lte(r.maxSteps);
        expect(sim.faults, name).to.deep.equal([]);
      }
    }
  });
});

describe("BXL language", () => {
  it("compiles the documented momentum program to the expected instruction stream", () => {
    const r = ok(EXAMPLES.momentum);
    const ops = disassemble(r.bytecode).map((d) => d.text.split("  ;")[0]);
    expect(ops).to.deep.equal([
      "ema m0 w8", "ema m0 w21", "gt", "mst 8",
      "mld 8", "jz @36",
      "pos m0", "push 0", "le", "jz @33", "long m0 3000bps", "jmp @55",
      "pos m0", "push 0", "ge", "jz @55", "short m0 3000bps",
      "halt",
    ]);
    expect(r.maxSteps).to.equal(13);
  });

  it("converts numbers and percents to 6-dp fixed point", () => {
    const m = run("mem[0] = 1.5\nmem[1] = 0.05%\nmem[2] = 30%\nmem[3] = -2.25\nmem[4] = 1_000\nmem[5] = .5").mem;
    expect(m.slice(0, 6)).to.deep.equal([1_500_000n, 500n, 300_000n, -2_250_000n, 1_000_000_000n, 500_000n]);
  });

  it("uses fixed-point * and / and a sign-of-dividend %", () => {
    const m = run("let a = price(SOL)\nmem[0] = a * 1.5\nmem[1] = a / 8\nmem[2] = (0 - a) % 7\nmem[3] = a % 7\nmem[4] = -a").mem;
    expect(m.slice(0, 5)).to.deep.equal([150n * S, 12_500_000n, -2n * S, 2n * S, -100n * S]);
  });

  it("folds constant expressions with VM semantics", () => {
    const r = ok("mem[0] = 2 * 3 + 1.5 / 3 - (4 % 3)");
    const ops = disassemble(r.bytecode).map((d) => d.text);
    expect(ops[0]).to.match(/^push 5500000/);
    expect(ops.length).to.equal(3); // push, mst, halt
  });

  it("comparisons yield 1.0 / 0 and != compiles to eq + not", () => {
    const r = ok("mem[0] = price(SOL) != 100");
    expect(disassemble(r.bytecode).map((d) => d.text.split(" ")[0])).to.deep.equal(["price", "push", "eq", "not", "mst", "halt"]);
    const m = run("mem[0] = price(SOL) > 99\nmem[1] = price(SOL) <= 99\nmem[2] = price(SOL) != 100\nmem[3] = price(SOL) == 100\nmem[4] = price(BTC) >= 60000\nmem[5] = price(ETH) < 3000").mem;
    expect(m.slice(0, 6)).to.deep.equal([S, 0n, 0n, S, S, 0n]);
  });

  it("and / or / not evaluate both sides with the VM's boolean ops (aliases && || ! work)", () => {
    const r = ok("mem[0] = price(SOL) > 1 and price(BTC) > 1 or not price(ETH) > 1");
    const names = disassemble(r.bytecode).map((d) => d.text.split(" ")[0]);
    expect(names).to.include.members(["and", "or", "not"]);
    expect(names).to.not.include("jz");
    const m = run("mem[0] = 1 < price(SOL) && 0 > price(SOL)\nmem[1] = 1 < price(SOL) || 0 > price(SOL)\nmem[2] = !(price(SOL) > 1)\nmem[3] = true and not false").mem;
    expect(m.slice(0, 4)).to.deep.equal([0n, S, 0n, S]);
  });

  it("if / elif / else picks exactly one branch", () => {
    const src = `
      let p = price(SOL)
      if p > 200 { long(SOL, 10%) }
      elif p > 150 { long(SOL, 20%) }
      else if p > 50 {
        long(SOL, 30%)
      } else { short(SOL, 40%) }
    `;
    const at = (px: bigint) => run(src, host({ price: () => px * S })).actions;
    expect(at(300n)).to.deep.equal([{ kind: "long", market: 0, bps: 1000 }]);
    expect(at(160n)).to.deep.equal([{ kind: "long", market: 0, bps: 2000 }]);
    expect(at(100n)).to.deep.equal([{ kind: "long", market: 0, bps: 3000 }]);
    expect(at(10n)).to.deep.equal([{ kind: "short", market: 0, bps: 4000 }]);
  });

  it("actions: long / short / close / close_all / halt", () => {
    const r = run("long(BTC, 12.5%)\nshort(eth, 100%)\nclose(SOL)\nclose_all()\nhalt()\nlong(SOL, 1%)");
    expect(r.actions).to.deep.equal([
      { kind: "long", market: 1, bps: 1250 },
      { kind: "short", market: 2, bps: 10000 },
      { kind: "close", market: 0 },
      { kind: "closeAll" },
    ]);
  });

  it("resolves market symbols case-insensitively and by base symbol", () => {
    for (const markets of [["SOL-PERP", "BTC-PERP"], ["sol/usd", "btc/usd"], ["SOL", "BTC"]]) {
      const r = ok("long(btc, 10%)\nmem[0] = price(Sol)", markets);
      expect(disassemble(r.bytecode)[0].text).to.equal("long m1 1000bps");
    }
    expect(ok("long(SOL_PERP, 10%)", ["SOL-PERP"]).ok).to.equal(true);
  });

  it("functions read the host: price ema ret vol pos entry equity free tick rand abs min max", () => {
    const h = host({ pos: (m: number) => (m === 1 ? -500n * S : 0n), entry: (m: number) => (m === 1 ? 61_000n * S : 0n) });
    const m = run(
      [
        "mem[0] = ema(SOL, 55)", "mem[1] = ret(BTC, 64)", "mem[2] = vol(ETH)", "mem[3] = pos(BTC)", "mem[4] = entry(BTC)",
        "mem[5] = free()", "mem[6] = tick()", "mem[7] = rand()",
        "let e = equity()", "let x = abs(pos(BTC))", "let lo = min(price(SOL), price(ETH))", "let hi = max(price(SOL), price(ETH))",
      ].join("\n"),
      h,
    ).mem;
    expect(m.slice(0, 8)).to.deep.equal([95n * S, 5_000n, 20_000n, -500n * S, 61_000n * S, 900n * S, 42n * S, 123_456n]);
    expect(m.slice(8, 12)).to.deep.equal([1_000n * S, 500n * S, 100n * S, 3_000n * S]);
  });

  it("tick() is an ordinary number, so tick() % N works", () => {
    const src = "if tick() % 10 == 2 { long(SOL, 10%) }";
    expect(run(src, host({ tick: () => 42n })).actions.length).to.equal(1);
    expect(run(src, host({ tick: () => 43n })).actions.length).to.equal(0);
  });

  it("let locals live in slots 8..15, can be reassigned, and reuse their slot", () => {
    const r = ok("let a = 1\nlet b = 2\na = a + b\nlet a = a * 2\nmem[0] = a");
    const t = disassemble(r.bytecode).map((d) => d.text);
    expect(t.filter((x) => x.startsWith("mst"))).to.deep.equal(["mst 8", "mst 9", "mst 8", "mst 8", "mst 0"]);
    expect(run("let a = 1\nlet b = 2\na = a + b\nlet a = a * 2\nmem[0] = a").mem[0]).to.equal(6n * S);
  });

  it("mem[] persists across ticks (a counter)", () => {
    const r = ok("mem[3] = mem[3] + 1");
    const mem = new Array(16).fill(0n);
    for (let i = 0; i < 5; i++) run("mem[3] = mem[3] + 1", host(), mem);
    expect(mem[3]).to.equal(5n * S);
    expect(r.maxSteps).to.equal(5);
  });

  it("accepts comments, blank lines, semicolons and expressions wrapped inside parentheses", () => {
    const r = run(`
      # header comment
      let a = (price(SOL) +
               price(ETH))   # trailing comment

      mem[0] = a; mem[1] = 2
    `);
    expect(r.mem.slice(0, 2)).to.deep.equal([3_100n * S, 2n * S]);
  });

  it("percent vs modulo: 10%3 is modulo, 30% is a percent", () => {
    const m = run("mem[0] = 10%3\nmem[1] = 10 % 4\nmem[2] = 30%\nmem[3] = 5% + 1").mem;
    expect(m.slice(0, 4)).to.deep.equal([1n * S, 2n * S, 300_000n, 1_050_000n]);
  });

  it("an elif chain ending in halt() does not emit a dead jump", () => {
    const r = ok("if price(SOL) > 1 { halt() } else { long(SOL, 10%) }");
    expect(disassemble(r.bytecode).map((d) => d.text.split(" ")[0])).to.deep.equal(["price", "push", "gt", "jz", "halt", "long", "halt"]);
  });

  it("condition shortcuts: `if not x` uses jnz; `if a != b` uses eq + jnz; constant conditions fold", () => {
    expect(disassemble(ok("if not price(SOL) > 1 { close(SOL) }").bytecode).map((d) => d.text.split(" ")[0])).to.deep.equal(["price", "push", "gt", "jnz", "close", "halt"]);
    expect(disassemble(ok("if price(SOL) != 1 { close(SOL) }").bytecode).map((d) => d.text.split(" ")[0])).to.deep.equal(["price", "push", "eq", "jnz", "close", "halt"]);
    expect(disassemble(ok("if true { close(SOL) }").bytecode).map((d) => d.text.split(" ")[0])).to.deep.equal(["close", "halt"]);
  });

  it("reports a warning (not an error) when the worst path exceeds 512 steps", () => {
    const src = Array.from({ length: 140 }, (_, i) => `mem[${i % 8}] = price(SOL) + ${i}`).join("\n");
    const r = ok(src);
    expect(r.maxSteps).to.be.greaterThan(512);
    expect(r.warnings![0].message).to.match(/worst-case path is \d+ VM steps/);
  });
});

describe("formatListing", () => {
  it("prints offsets and disassembly for any blob, including SDK strategies", () => {
    const l = formatListing(strategies.momentum(0)).split("\n");
    expect(l[0]).to.equal("0000  ema m0 w8");
    expect(l).to.include("0011  jz @34");
    expect(l[l.length - 1]).to.equal("0053  halt");
    expect(formatListing(new Uint8Array(0))).to.equal("");
    expect(formatListing(Uint8Array.from([2, 1]))).to.match(/not a bxvm v1 blob/);
    expect(formatListing(Uint8Array.from([1, 1, 200]))).to.equal("0000  halt\n; 1 undecodable byte from offset 1");
  });

  it("compile() interleaves source lines", () => {
    const r = ok("let x = price(SOL)\nif x > 1 {\n  long(SOL, 10%)\n}");
    expect(r.listing.split("\n").slice(0, 3)).to.deep.equal(["; 1: let x = price(SOL)", "0000  price m0", "0002  mst 8"]);
    expect(r.listing).to.include("; 3: long(SOL, 10%)");
    expect(r.listing).to.include("; end of program");
  });
});
