/** Pure-function tests: math, ring order, market resolution, round-file writes, config, CLI args. */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { estimateEquity, faultName, fmtDuration, ringTail, toBig } from "../src/format";
import { appendExternal, isRecorded, marketSymbol, resolveMarket } from "../src/roundfile";
import { findRepoRoot, readConfig, sanitizeName } from "../src/config";
import { parseArgs } from "../src/index";
import { compileBxl, builtinBytecode, sdkListing } from "../src/bxl";
import { tmpDir } from "./helpers";

describe("mcp-server units", () => {
  it("ringTail returns the newest n marks oldest-first across the wrap", () => {
    const ring = Array.from({ length: 64 }, (_, i) => i); // slot i holds value i
    // ringPos = 3 means slot 2 is the newest; the 4 newest are slots 63, 0, 1, 2
    expect(ringTail(ring, 3, 64, 4)).to.deep.equal([63, 0, 1, 2]);
    // partially filled ring: only ringLen entries exist
    expect(ringTail(ring, 5, 5, 10)).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it("estimateEquity mirrors perps.rs equity() including funding", () => {
    const M = 1_000_000n;
    const legs = [
      { side: 1, size: 1000n * M, entry: 100n * M, fundingIndex: 0n }, // long 1000 notional @100
      { side: -1, size: 500n * M, entry: 200n * M, fundingIndex: 1000n }, // short 500 @200
      { side: 0, size: 0n, entry: 0n, fundingIndex: 0n },
    ];
    const marks = [110n * M, 180n * M, 5n * M];
    const findex = [2000n, 1000n, 0n]; // 0.2% funding accrued on market 0
    const r = estimateEquity(100n * M, -5n * M, legs, marks, findex);
    // long: 1000 * (110-100)/100 = +100 ; funding owed = 1000 * 0.002 = 2
    // short: -500 * (180-200)/200 = +50 ; funding owed 0
    expect(r.unrealized).to.deep.equal([100n * M, 50n * M, 0n]);
    expect(r.funding).to.deep.equal([2n * M, 0n, 0n]);
    expect(r.equity).to.equal(100n * M - 5n * M + 100n * M + 50n * M - 2n * M);
  });

  it("toBig and faultName handle BN-like values and fault codes", () => {
    expect(toBig({ toString: () => "123456789012345678" })).to.equal(123456789012345678n);
    expect(faultName(0)).to.equal(null);
    expect(faultName(10)).to.equal("StepLimit");
    expect(fmtDuration(3_725_000)).to.equal("1h 2m");
  });

  it("resolveMarket accepts symbols, full names and indices", () => {
    const mk = ["SOL-PERP", "BTC-PERP", "ETH-PERP"];
    expect(resolveMarket(mk, "sol")).to.equal(0);
    expect(resolveMarket(mk, "BTC-PERP")).to.equal(1);
    expect(resolveMarket(mk, "2")).to.equal(2);
    expect(() => resolveMarket(mk, "DOGE")).to.throw(/Unknown market "DOGE".*0=SOL-PERP/);
    expect(() => resolveMarket(mk, "7")).to.throw(/Unknown market/);
    expect(marketSymbol("eth-perp")).to.equal("ETH");
  });

  it("appendExternal is idempotent, keeps other fields, and never lists a bot twice", () => {
    const f = path.join(tmpDir("unit"), "round.json");
    fs.writeFileSync(f, JSON.stringify({ round: "R", phase: "registration", entrants: [{ name: "Bot", owner: "B1", bot: true }] }));
    expect(appendExternal(f, { name: "Agent A", owner: "A1" })).to.equal(true);
    expect(appendExternal(f, { name: "Agent A again", owner: "A1" })).to.equal(false);
    expect(appendExternal(f, { name: "Bot", owner: "B1" })).to.equal(false);
    expect(appendExternal(f, { name: "Agent B", owner: "A2" })).to.equal(true);
    const cur = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(cur.phase).to.equal("registration");
    expect(cur.external).to.deep.equal([
      { name: "Agent A", owner: "A1", bot: false },
      { name: "Agent B", owner: "A2", bot: false },
    ]);
    expect(isRecorded(f, "B1")).to.equal(true);
    expect(isRecorded(f, "nope")).to.equal(false);
    expect(fs.existsSync(`${f}.lock`)).to.equal(false);
    expect(fs.readdirSync(path.dirname(f)).filter((x) => x.endsWith(".tmp"))).to.deep.equal([]);
  });

  it("readConfig creates a named agent keypair once and resolves paths", () => {
    const dir = tmpDir("cfg");
    const env = { BLACKBOX_AGENT_NAME: "My Agent!", BLACKBOX_AGENTS_DIR: dir, BLACKBOX_CLUSTER: "local" };
    const a = readConfig(env);
    expect(a.agentName).to.equal("My-Agent");
    expect(a.keypairPath).to.equal(path.join(dir, "My-Agent.json"));
    expect(a.keypairCreated).to.equal(true);
    const b = readConfig(env);
    expect(b.keypairCreated).to.equal(false);
    expect(fs.readFileSync(a.keypairPath, "utf8")).to.equal(fs.readFileSync(b.keypairPath, "utf8"));
    expect(a.roundFile).to.equal(path.join(findRepoRoot(), ".mb/round-local.json"));
    expect(() => readConfig({ BLACKBOX_CLUSTER: "mainnet" })).to.throw(/local or devnet/);
    expect(() => readConfig({ BLACKBOX_KEYPAIR: path.join(dir, "missing.json") })).to.throw(/does not exist/);
    expect(sanitizeName("  ")).to.equal("agent");
  });

  it("parseArgs handles stdio default and --http", () => {
    expect(parseArgs([])).to.deep.equal({ http: null, host: "127.0.0.1" });
    expect(parseArgs(["--http", "8765"])).to.deep.equal({ http: 8765, host: "127.0.0.1" });
    expect(parseArgs(["--http=9000", "--host", "0.0.0.0"])).to.deep.equal({ http: 9000, host: "0.0.0.0" });
    expect(() => parseArgs(["--http", "x"])).to.throw(/port/);
    expect(() => parseArgs(["--nope"])).to.throw(/unknown argument/);
  });

  it("compileBxl never throws and builtins disassemble", () => {
    const bad = compileBxl("long(DOGE, 30%)\n", ["SOL", "BTC", "ETH"]);
    expect(bad.ok).to.equal(false);
    expect(bad.errors.length).to.be.greaterThan(0);
    const code = builtinBytecode("momentum", 0);
    expect(sdkListing(code)).to.match(/^0000  ema m0 w8/);
  });
});
