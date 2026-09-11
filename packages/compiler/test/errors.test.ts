import { expect } from "chai";
import { compile } from "../src";
import { errs } from "./helpers";

/** Assert exactly one error at (line, col) whose message matches. */
function one(src: string, line: number, col: number, msg: RegExp) {
  const e = errs(src);
  expect(e.length, JSON.stringify(e)).to.equal(1);
  expect({ line: e[0].line, col: e[0].col }, e[0].message).to.deep.equal({ line, col });
  expect(e[0].message).to.match(msg);
}

describe("BXL errors: semantic", () => {
  it("unknown market (with the round's markets listed and a suggestion)", () => {
    one("long(DOGE, 10%)", 1, 6, /^unknown market DOGE \(this round trades SOL, BTC, ETH\)$/);
    one("let x = 1\nlet p = price(SOLL)", 2, 15, /unknown market SOLL; did you mean SOL\?/);
    one("close(1)", 1, 7, /first argument of close\(\) must be a market symbol such as SOL/);
  });

  it("bad EMA window", () => {
    one("let a = ema(SOL, 10)", 1, 18, /^EMA window must be 8, 21 or 55, got 10$/);
    one("let a = ema(SOL, 8.5)", 1, 18, /^EMA window must be 8, 21 or 55$/);
    one("let a = ema(SOL, price(SOL))", 1, 18, /EMA window must be 8, 21 or 55/);
  });

  it("bad ret lookback", () => {
    one("let a = ret(SOL, 0)", 1, 18, /^ret lookback must be a whole number of ticks from 1 to 64, got 0$/);
    one("let a = ret(SOL, 65)", 1, 18, /got 65/);
    one("let a = ret(BTC, 1.5)", 1, 18, /ret lookback must be a whole number/);
    expect(compile("let a = ret(SOL, 64)\nlet b = ret(SOL, 1)", { markets: ["SOL"] }).ok).to.equal(true);
  });

  it("too many locals (the 9th distinct name)", () => {
    const src = Array.from({ length: 9 }, (_, i) => `let v${i} = ${i}`).join("\n");
    one(src, 9, 5, /^too many local variables: v8 would be the 9th, but BXL has 8 local slots/);
    // re-declaring an existing name does not use a new slot
    expect(compile(Array.from({ length: 8 }, (_, i) => `let v${i} = ${i}`).join("\n") + "\nlet v0 = 3", { markets: ["SOL"] }).ok).to.equal(true);
  });

  it("out-of-range or malformed position sizes", () => {
    one("long(SOL, 150%)", 1, 11, /^position size must be between 1% and 100%, got 150%$/);
    one("short(SOL, 0.5%)", 1, 12, /between 1% and 100%, got 0.5%/);
    one("long(SOL, 30)", 1, 11, /^position size must be a percent literal such as 30%/);
    one("long(SOL, 12.345%)", 1, 11, /finer than 1 bps/);
  });

  it("unknown function (with a suggestion)", () => {
    one("let a = foo(1)", 1, 9, /^unknown function foo$/);
    one("let a = emaa(SOL, 8)", 1, 9, /^unknown function emaa; did you mean ema\?$/);
    one("closeAll()", 1, 1, /did you mean close_all\?/);
  });

  it("bytecode longer than 4096 bytes", () => {
    const src = Array.from({ length: 400 }, (_, i) => `mem[${i % 8}] = price(SOL) + ${i}`).join("\n");
    const e = errs(src);
    expect(e.length).to.equal(1);
    expect(e[0].message).to.match(/^program compiles to \d+ bytes of bytecode; the limit is 4096/);
    expect(e[0].line).to.equal(293); // 14 bytes per line: line 293 crosses 4095 code bytes
    expect(e[0].col).to.equal(1);
  });

  it("more than 8 actions on one path", () => {
    const src = Array.from({ length: 9 }, () => "close(SOL)").join("\n");
    one(src, 9, 1, /one tick can emit at most 8 actions, but a path through this program emits 9/);
    // 8 on each of two exclusive branches is fine
    const branchy = `if price(SOL) > 1 {\n${"close(SOL)\n".repeat(8)}} else {\n${"close(BTC)\n".repeat(8)}}`;
    expect(compile(branchy, { markets: ["SOL", "BTC"] }).ok).to.equal(true);
  });

  it("unknown variables, misuse of markets and functions", () => {
    one("mem[0] = x + 1", 1, 10, /^unknown variable x \(declare it with let x = \.\.\.\)$/);
    one("let total = 1\nmem[0] = totl", 2, 10, /did you mean total\?/);
    one("y = 3", 1, 1, /^unknown variable y; declare it first with let y = \.\.\.$/);
    one("mem[0] = SOL * 2", 1, 10, /SOL is a market, not a value; use price\(SOL\)/);
    one("mem[0] = equity + 1", 1, 10, /equity is a function; call it as equity\(\)/);
    one("price(SOL)", 1, 1, /price\(\) returns a value and does nothing on its own/);
    one("mem[0] = long(SOL, 10%)", 1, 10, /long\(\) is an action and cannot be used inside an expression/);
    one("let a = ema(SOL)", 1, 16, /^ema\(market, 8\|21\|55\) takes 2 arguments, got 1$/);
    one("let a = price(SOL, BTC)", 1, 20, /takes 1 argument, got 2/);
  });

  it("mem index, division by zero, number precision", () => {
    one("mem[8] = 1", 1, 5, /^mem index must be a whole number from 0 to 7, got 8/);
    one("mem[0] = mem[1.5]", 1, 14, /mem index must be a whole number/);
    one("mem[0] = price(SOL) / 0", 1, 21, /^division by zero$/);
    one("mem[0] = price(SOL) % (1 - 1)", 1, 21, /^modulo by zero$/);
    one("mem[0] = 0.0000001", 1, 10, /more than 6 decimal places/);
    one("mem[0] = 99999999999999", 1, 10, /too large for the VM/);
  });

  it("reports every semantic error in one pass, sorted by position", () => {
    const e = errs("long(DOGE, 10%)\nlet a = ema(SOL, 9)\nshort(SOL, 200%)");
    expect(e.map((x) => [x.line, x.col])).to.deep.equal([[1, 6], [2, 18], [3, 12]]);
  });

  it("errors when no markets are given", () => {
    const r = compile("halt()", { markets: [] });
    expect(r.ok).to.equal(false);
    expect(r.errors[0].message).to.match(/no markets given/);
  });

  it("errors for a market beyond the VM's 8 addressable markets", () => {
    const markets = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const r = compile("close(I)", { markets });
    expect(r.errors[0]).to.deep.include({ line: 1, col: 7 });
    expect(r.errors[0].message).to.match(/at most 8 markets/);
  });
});

describe("BXL errors: syntax", () => {
  it("positions and messages", () => {
    one("if price(SOL) > 1 {\n  long(SOL, 10%)\n", 1, 19, /^unclosed '\{' \(the if block opened here is never closed\)$/);
    one("if price(SOL) > 1 long(SOL, 10%)", 1, 19, /expected '\{' to start the if block, found 'long'/);
    one("let = 5", 1, 5, /expected a variable name after 'let', found '='/);
    one("let if = 5", 1, 5, /'if' is a reserved word/);
    one("mem[0] = 1 < 2 < 3", 1, 16, /comparisons cannot be chained/);
    one("mem[0] = (1 + 2", 1, 16, /expected '\)' to close '\('/);
    one("mem[0] = 1 +", 1, 13, /expected an expression, found end of line/);
    one("long(SOL, 30 %)", 1, 14, /write percent literals without a space, e.g. 30%/);
    one("mem[0] = 1 $ 2", 1, 12, /unexpected character '\$'/);
    one("}", 1, 1, /unexpected '\}'/);
    one("else { halt() }", 1, 1, /'else' without a matching 'if'/);
    one("if { halt() }", 1, 4, /expected a condition after 'if'/);
    one("mem[0] = 1 2", 1, 12, /expected end of line after statement, found number 2/);
    one("if price(SOL) = 1 { halt() }", 1, 15, /use '==' to compare/);
    one("long(SOL 10%)", 1, 10, /expected ',' or '\)' in the arguments of long\(\)/);
    one("let x = 3abc", 1, 10, /unexpected 'a' after number 3/);
    one("foo", 1, 1, /expected '=' or '\(' after 'foo', found end of line/);
  });

  it("allows `}` and `else` on separate lines and one-line blocks", () => {
    const src = "if price(SOL) > 1 {\n  long(SOL, 10%)\n}\nelif price(SOL) < 1 { short(SOL, 10%) }\nelse\n{\n  close(SOL)\n}";
    expect(compile(src, { markets: ["SOL"] }).ok).to.equal(true);
  });
});
