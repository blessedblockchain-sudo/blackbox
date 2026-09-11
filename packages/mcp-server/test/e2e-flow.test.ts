/**
 * Opt-in full entrant lifecycle through the MCP server, on a scratch round:
 * join_round -> (runner delegates) -> enter_round -> hot_swap_strategy ->
 * read_my_strategy / read_my_position / privacy_check.
 *
 * It creates a NEW round on the local validator with the admin keypair
 * (~/.config/solana/id.json), reusing the live round's mock feeds, and writes
 * its own round file in a temp dir. The live round and .mb/round-local.json are
 * never touched. The scratch round is left open (never started).
 *
 *   BLACKBOX_MCP_E2E=1 npx ts-mocha -p packages/mcp-server/tsconfig.json packages/mcp-server/test/e2e-flow.test.ts --timeout 600000
 */
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BlackboxClient, pda } from "@blackbox/sdk";
import { MOMENTUM_BXL, REVERSION_BXL, ROUND_FILE, Session, call, tmpDir } from "./helpers";

const USDC = 1_000_000n;
const enabled = process.env.BLACKBOX_MCP_E2E === "1";

(enabled ? describe : describe.skip)("blackbox MCP e2e: join, enter, hot-swap on a scratch round", function () {
  this.timeout(600_000);
  const adminPath = process.env.BLACKBOX_FAUCET_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8"))));
  const bx = new BlackboxClient(admin, "local");
  const dir = tmpDir("e2e");
  const roundFile = path.join(dir, "round-local.json");
  let roundId = 0;
  let round: PublicKey;
  let s: Session;
  let compiledHex = "";

  const setPhase = (phase: string) => {
    const cur = JSON.parse(fs.readFileSync(roundFile, "utf8"));
    fs.writeFileSync(roundFile, JSON.stringify({ ...cur, phase, updatedAt: Date.now() }, null, 2));
  };

  before(async () => {
    const live = JSON.parse(fs.readFileSync(ROUND_FILE, "utf8"));
    const feeds = (live.feeds as string[]).map((f) => new PublicKey(f));
    const mint = (await bx.program.account.protocolConfig.fetch(pda.configPda())).usdcMint;
    const r = await bx.createRound(mint, { mode: "lit", entryFee: 5n * USDC, minMargin: 50n * USDC, maxMargin: 1_000n * USDC, tickIntervalMs: 500, durationTicks: 120 });
    roundId = r.roundId;
    round = r.round;
    const cfgs = [
      { maxLeverage: 20, maintenanceBps: 300 },
      { maxLeverage: 20, maintenanceBps: 300 },
      { maxLeverage: 10, maintenanceBps: 500 },
    ];
    for (let i = 0; i < 3; i++) {
      await bx.addMarket(round, i, { feed: feeds[i], decimals: 8, ...cfgs[i], baseSpreadBps: 2, skewSpreadBps: 25, oiCap: 1_000_000n * USDC });
    }
    await bx.openRound(round);
    fs.writeFileSync(
      roundFile,
      JSON.stringify(
        {
          cluster: "local",
          roundId,
          round: round.toBase58(),
          mint: mint.toBase58(),
          feeds: feeds.map((f) => f.toBase58()),
          markets: live.markets,
          tickMs: 500,
          durationTicks: 120,
          mode: "lit",
          phase: "registration",
          registrationEndsAt: Date.now() + 600_000,
          entrants: [],
          external: [],
        },
        null,
        2,
      ),
    );
    console.log(`      scratch round #${roundId} ${round.toBase58()} (file ${roundFile})`);
    const { connectStdio } = await import("./helpers");
    s = await connectStdio({ BLACKBOX_ROUND_FILE: roundFile, BLACKBOX_AGENT_NAME: "e2e-agent", BLACKBOX_AGENTS_DIR: dir, BLACKBOX_FAUCET_KEYPAIR: adminPath });
  });
  after(async () => {
    await s?.close();
  });

  it("get_round in registration tells a new agent to join", async () => {
    const o = await call(s, "get_round");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.round.roundId).to.equal(roundId);
    expect(o.data.round.phase).to.equal("registration");
    expect(o.data.round.status).to.equal("open");
    expect(o.data.you.joined).to.equal(false);
    expect(o.data.next).to.match(/join_round/);
  });

  it("enter_round is refused during registration", async () => {
    const o = await call(s, "enter_round", { source: MOMENTUM_BXL, margin_usdc: 100 });
    expect(o.isError).to.equal(true);
    expect(o.text).to.match(/still in registration/);
  });

  it("join_round funds the wallet from the faucet, joins, delegates and records the agent", async () => {
    const o = await call(s, "join_round", { name: "E2E Agent" });
    expect(o.isError, o.text).to.equal(false);
    const steps = o.data.txs.map((t: any) => t.step);
    expect(steps).to.include("join_round");
    expect(steps).to.include("delegate_entrant");
    expect(steps.some((x: string) => x.startsWith("faucet"))).to.equal(true);
    for (const t of o.data.txs) expect(t.link).to.match(/^https:\/\/explorer\.solana\.com\/tx\//);
    const file = JSON.parse(fs.readFileSync(roundFile, "utf8"));
    expect(file.external).to.deep.equal([{ name: "E2E Agent", owner: o.data.wallet, bot: false }]);
    const info = await bx.base.getAccountInfo(pda.entrantPda(round, new PublicKey(o.data.wallet)));
    expect(info!.owner.toBase58()).to.match(/^DELeG/);
    console.log("      " + o.text.split("\n").join("\n      "));
    const again = await call(s, "join_round");
    expect(again.isError, again.text).to.equal(false);
    expect(again.data.alreadyJoined).to.equal(true);
  });

  it("(runner) delegates markets and round; phase -> delegating", async () => {
    await bx.delegateMarkets(roundId, 3);
    await bx.delegateRound(roundId);
    await bx.waitOnEr(admin, round);
    setPhase("delegating");
    const o = await call(s, "get_round");
    expect(o.data.round.phase).to.equal("delegating");
    expect(o.data.next).to.match(/enter_round/);
  });

  it("compile_strategy output matches what enter_round uploads", async () => {
    const c = await call(s, "compile_strategy", { source: MOMENTUM_BXL });
    expect(c.isError, c.text).to.equal(false);
    compiledHex = c.data.bytecodeHex;
  });

  it("enter_round deposits, privatizes, uploads the strategy and funds margin", async () => {
    const o = await call(s, "enter_round", { source: MOMENTUM_BXL, margin_usdc: 100 }, 300_000);
    expect(o.isError, o.text).to.equal(false);
    const steps = o.data.txs.map((t: any) => t.step);
    expect(steps.some((x: string) => x.startsWith("deposit"))).to.equal(true);
    expect(steps).to.include("privatize_entrant");
    expect(steps).to.include("set_strategy");
    expect(o.data.strategy.version).to.equal(1);
    expect(o.data.margin).to.equal(100);
    expect(o.data.entryFeePaid).to.equal(5);
    expect(o.data.strategy.sha256).to.equal(createHash("sha256").update(Buffer.from(compiledHex, "hex")).digest("hex"));
    console.log("      " + o.text.split("\n").join("\n      "));
  });

  it("read_my_strategy returns the uploaded bytecode (owner-only)", async () => {
    const o = await call(s, "read_my_strategy");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.version).to.equal(1);
    expect(o.data.size).to.equal(compiledHex.length / 2);
    expect(o.data.sha256).to.equal(createHash("sha256").update(Buffer.from(compiledHex, "hex")).digest("hex"));
  });

  it("hot_swap_strategy uploads BXL and builtin strategies and bumps the version", async () => {
    const a = await call(s, "hot_swap_strategy", { source: REVERSION_BXL });
    expect(a.isError, a.text).to.equal(false);
    expect(a.data.version).to.equal(2);
    expect(a.data.tx.link).to.match(/explorer\.solana\.com/);
    const b = await call(s, "hot_swap_strategy", { builtin: "breakout", market: "BTC" });
    expect(b.isError, b.text).to.equal(false);
    expect(b.data.version).to.equal(3);
    expect(b.data.origin).to.equal("builtin:breakout(BTC-PERP)");
    const bad = await call(s, "hot_swap_strategy", { source: "long(DOGE, 10%)\n" });
    expect(bad.isError).to.equal(true);
    expect(bad.text).to.match(/did not compile/);
    console.log(`      ${a.text.split("\n")[0]}\n      ${b.text.split("\n")[0]}`);
  });

  it("read_my_position shows the funded margin and a flat book", async () => {
    const o = await call(s, "read_my_position");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.found).to.equal(true);
    expect(o.data.margin).to.equal(100);
    expect(o.data.legs).to.deep.equal([]);
    expect(o.data.equityEstimate).to.equal(100);
  });

  it("privacy_check proves the strategy and position are private", async () => {
    const o = await call(s, "privacy_check");
    expect(o.isError, o.text).to.equal(false);
    expect(o.data.verdict).to.equal("private");
    console.log("      " + o.text.split("\n").join("\n      "));
  });

  it("get_round reflects the entrant state", async () => {
    const o = await call(s, "get_round");
    expect(o.data.you.joined).to.equal(true);
    expect(o.data.you.privatized).to.equal(true);
    expect(o.data.you.funded).to.equal(true);
    expect(o.data.you.strategyVersion).to.equal(3);
    expect(o.data.round.pot).to.equal(5);
    // Scoreboard rows are written on each entrant's first live tick; this round never starts.
    expect(o.data.scoreboard).to.deep.equal([]);
    expect(o.text).to.include("no rows yet");
    const file = JSON.parse(fs.readFileSync(roundFile, "utf8"));
    expect(file.external.map((e: any) => e.owner)).to.deep.equal([o.data.you.wallet]);
  });
});
