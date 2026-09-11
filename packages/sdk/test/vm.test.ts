import { expect } from "chai";
import { execFileSync } from "child_process";
import * as path from "path";
import { Asm, validate, disassemble } from "../src/vm";
import * as S from "../src/strategies";

const ROOT = path.resolve(__dirname, "../../..");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function rustCheck(nMarkets: number, blobs: Uint8Array[]): string[] {
  const out = execFileSync("cargo", ["run", "-q", "-p", "bxvm", "--example", "check", "--", String(nMarkets), ...blobs.map(hex)], { cwd: ROOT, encoding: "utf8" });
  return out.trim().split("\n");
}

describe("bxvm TS <-> Rust parity", function () {
  this.timeout(300_000);
  const programs: Record<string, Uint8Array> = {
    momentum: S.momentum(0),
    meanReversion: S.meanReversion(0),
    breakout: S.breakout(1),
    randomWalk: S.randomWalk(2),
    alwaysLong: S.alwaysLong(0),
    degen: S.degen(1),
    pairs: S.pairs(0, 1),
  };

  it("every built-in strategy validates in TS and in Rust, with the same instruction boundaries", () => {
    const names = Object.keys(programs);
    const rust = rustCheck(3, names.map((n) => programs[n]));
    names.forEach((n, i) => {
      expect(validate(programs[n], 3), `${n} (ts)`).to.equal(null);
      expect(rust[i].startsWith("OK|"), `${n} (rust): ${rust[i]}`).to.equal(true);
      const rustOffsets = rust[i].slice(3).split(";").map((s) => Number(s.split(":")[0]));
      const tsOffsets = disassemble(programs[n]).map((d) => d.offset);
      expect(tsOffsets, n).to.deep.equal(rustOffsets);
    });
  });

  it("rejects the same malformed programs in both implementations", () => {
    const bad = [
      new Asm().long(5, 100).build(), // market out of range for 3 markets
      new Asm().long(0, 0).build(), // zero size
      new Asm().mld(16).build(), // bad memory slot
      Uint8Array.from([1, 20, 1, 0]), // jmp into the middle of itself
      Uint8Array.from([2]), // bad version
      Uint8Array.from([1, 99]), // unknown opcode
    ];
    const rust = rustCheck(3, bad);
    bad.forEach((b, i) => {
      expect(validate(b, 3), `ts ${i}`).to.not.equal(null);
      expect(rust[i].startsWith("ERR|"), `rust ${i}: ${rust[i]}`).to.equal(true);
    });
  });

  it("labels resolve to instruction boundaries", () => {
    const b = new Asm().push(1).jz("x").long(0, 10).label("x").halt().build();
    expect(hex(b)).to.equal("01" + "020100000000000000" + "151000" + "23000a00" + "01");
  });
});
