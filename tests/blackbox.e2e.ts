/**
 * BLACKBOX end-to-end round.
 *
 *   CLUSTER=local  (default)  base 8899, ER in docker 7799, QFS 6699, mock feeds mirrored from devnet-tee
 *   CLUSTER=devnet            devnet + devnet-tee, real Pyth Lazer feeds
 *
 * Env: ENTRANTS (4), TICK_MS (400), DURATION_TICKS (90), KEEP_STATE=1 to reuse mint/protocol.
 */
import { expect } from "chai";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BlackboxClient, DEVNET_FEEDS, pda, strategies, disassemble, Cluster } from "../packages/sdk/src";

const CLUSTER = (process.env.CLUSTER || "local") as Cluster;
const N = Number(process.env.ENTRANTS || 4);
const TICK_MS = Number(process.env.TICK_MS || 400);
const DURATION = Number(process.env.DURATION_TICKS || 90);
const USDC = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { step: string; status: "PASS" | "FAIL" | "INFO"; detail: string };
const rows: Row[] = [];
const rec = (step: string, ok: boolean | null, detail = "") => {
  const status = ok === null ? "INFO" : ok ? "PASS" : "FAIL";
  rows.push({ step, status, detail });
  console.log(`  [${status}] ${step}${detail ? " — " + detail : ""}`);
};

async function realPrices(): Promise<Record<string, { raw: bigint; decimals: number }>> {
  const conn = new Connection("https://devnet-tee.magicblock.app", "processed");
  const out: Record<string, { raw: bigint; decimals: number }> = {};
  for (const [name, f] of Object.entries(DEVNET_FEEDS)) {
    const info = await conn.getAccountInfo(f.address, "processed");
    if (!info) throw new Error(`no feed ${name}`);
    out[name] = { raw: info.data.readBigInt64LE(73), decimals: f.decimals };
  }
  return out;
}

describe(`BLACKBOX e2e round on ${CLUSTER}`, function () {
  this.timeout(1_800_000);
  const admin = anchor.Wallet.local().payer;
  const bx = new BlackboxClient(admin, CLUSTER);
  bx.log = (...a) => console.log("   ", ...a);
  const users = Array.from({ length: N }, () => Keypair.generate());
  const stranger = Keypair.generate();
  const backer = Keypair.generate();
  let taskBase = 0;
  const names =["momentum", "meanReversion", "breakout", "randomWalk", "alwaysLong", "degen"];
  const codes = users.map((_, i) => strategies.BUILTIN_STRATEGIES[names[i % names.length]](0));
  let mint: PublicKey;
  let roundId: number;
  let round: PublicKey;
  let feeds: PublicKey[] = [];
  let pusher: NodeJS.Timeout | null = null;
  let pusherErrors = 0;
  const statePath = path.join(__dirname, `../.mb/e2e-state-${CLUSTER}.json`);

  before(async () => {
    console.log(`cluster=${CLUSTER} admin=${admin.publicKey.toBase58()} entrants=${N} tick=${TICK_MS}ms duration=${DURATION} ticks`);
    if (CLUSTER === "local") {
      const bal = await bx.base.getBalance(admin.publicKey);
      if (bal < 50 * LAMPORTS_PER_SOL) await bx.base.confirmTransaction(await bx.base.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
    }
    rec("TEE attestation", await bx.verifyAttestation(), CLUSTER === "local" ? "local QFS (no attestation)" : "TDX quote verified");
  });

  it("1. protocol + test USDC mint", async () => {
    let state: any = {};
    if (process.env.KEEP_STATE && fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const cfg = await bx.base.getAccountInfo(pda.configPda());
    if (cfg) {
      const c = await bx.program.account.protocolConfig.fetch(pda.configPda());
      mint = c.usdcMint;
    } else {
      mint = state.mint ? new PublicKey(state.mint) : await createMint(bx.base, admin, admin.publicKey, null, 6);
      await bx.initProtocol(mint, 500);
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ mint: mint.toBase58() }));
    rec("protocol initialized", true, `USDC mint ${mint.toBase58()}`);
  });

  it("2. price feeds", async () => {
    if (CLUSTER === "devnet") {
      feeds = [DEVNET_FEEDS["SOL/USD"].address, DEVNET_FEEDS["BTC/USD"].address, DEVNET_FEEDS["ETH/USD"].address];
      rec("using live Pyth Lazer feeds", true, "SOL, BTC, ETH");
      return;
    }
    const px = await realPrices();
    const ids = [6, 1, 2];
    const keys = ["SOL/USD", "BTC/USD", "ETH/USD"];
    for (let i = 0; i < 3; i++) {
      const f = await bx.initMockFeed(ids[i], px[keys[i]].raw, 8);
      const info = await bx.base.getAccountInfo(f);
      if (info && info.owner.equals(bx.program.programId)) await bx.delegateMockFeed(ids[i]);
      feeds.push(f);
    }
    for (const f of feeds) await bx.waitOnEr(admin, f);
    // mirror real prices into the local ER every ~500ms
    let cur = await realPrices();
    const refresh = setInterval(async () => { try { cur = await realPrices(); } catch {} }, 2000);
    pusher = setInterval(async () => {
      try {
        await Promise.all(feeds.map((f, i) => bx.setMockFeed(f, cur[keys[i]].raw, 8)));
      } catch (e) {
        pusherErrors++;
        if (pusherErrors < 3) console.log("pusher error", String(e).slice(0, 200));
      }
    }, 500);
    (pusher as any).refresh = refresh;
    await sleep(1500);
    rec("mock feeds mirrored from devnet-tee", true, feeds.map((f) => f.toBase58().slice(0, 6)).join(","));
  });

  it("3. create round + markets (L1)", async () => {
    const r = await bx.createRound(mint, {
      mode: "lit",
      entryFee: 5n * USDC,
      minMargin: 50n * USDC,
      maxMargin: 1_000n * USDC,
      tickIntervalMs: TICK_MS,
      durationTicks: DURATION,
      stepLimit: 512,
    });
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
    rec("round created with 3 markets", true, `round #${roundId} ${round.toBase58()}`);
  });

  it("4. entrants join and delegate (L1)", async () => {
    // fund entrants with SOL + USDC
    const fund = new Transaction();
    for (const u of [...users, stranger, backer]) fund.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: u.publicKey, lamports: 0.08 * LAMPORTS_PER_SOL }));
    await bx.sendBase(fund.instructions, [admin], "fund entrants SOL");
    for (const u of [...users, backer]) {
      const a = await getOrCreateAssociatedTokenAccount(bx.base, admin, mint, u.publicKey);
      await mintTo(bx.base, admin, mint, a.address, admin, 1_000n * USDC);
    }
    for (const u of users) {
      await bx.join(round, mint, u);
      await bx.delegateEntrant(round, u);
    }
    const rd = await bx.program.account.round.fetch(round);
    rec("entrants joined", rd.entrantCount === N, `${rd.entrantCount} entrants`);
    // Strategy layout: 8 disc + round 32 + owner 32 + updated_tick 8 + version 4 + step_limit 4 + len 2 + bump 1 + pad 5 = 96
    const l1Strat = await bx.base.getAccountInfo(pda.strategyPda(round, users[0].publicKey));
    rec(
      "strategy delegated, bytecode region empty on L1",
      !!l1Strat && l1Strat.owner.toBase58().startsWith("DELeG") && l1Strat.data.subarray(96).every((b) => b === 0),
      `${l1Strat?.data.length} bytes, owner ${l1Strat?.owner.toBase58().slice(0, 8)}`,
    );
  });

  it("5. delegate markets + round (L1)", async () => {
    await bx.delegateMarkets(roundId, 3);
    await bx.delegateRound(roundId);
    await bx.waitOnEr(admin, round);
    rec("round, scoreboard, markets delegated", true);
  });

  it("6. entrants deposit, privatize, upload strategies, fund (ER)", async () => {
    for (const [i, u] of users.entries()) {
      await bx.depositToEr(u, mint, 300n * USDC, u, i === 0);
    }
    for (const u of users) {
      await bx.waitErBalance(u, mint, 300n * USDC);
      await bx.waitOnEr(u, pda.entrantPda(round, u.publicKey));
      await bx.privatize(round, u);
      await bx.setStrategy(round, u, codes[users.indexOf(u)]);
      await bx.fund(round, mint, u, 100n * USDC);
    }
    const pos = await bx.fetchPosition(round, users[0]);
    rec("entrant 0 margin funded", pos?.margin.toString() === (100n * USDC).toString(), `margin ${pos?.margin}`);
    const r = await bx.fetchRound(round);
    rec("pot collected", r?.pot.toString() === (5n * USDC * BigInt(N)).toString(), `pot ${r?.pot}`);
  });

  it("7. privacy matrix before trading", async () => {
    const strat = pda.strategyPda(round, users[0].publicKey);
    const pos = pda.positionPda(round, users[0].publicKey);
    const ownerConn = await bx.tee(users[0]);
    const strangerConn = await bx.tee(stranger);
    const pub = bx.teePublic();
    const owner = await ownerConn.getAccountInfo(strat, "processed");
    const s1 = await strangerConn.getAccountInfo(strat, "processed").catch(() => null);
    const s2 = await pub.getAccountInfo(strat, "processed").catch(() => null);
    const p1 = await strangerConn.getAccountInfo(pos, "processed").catch(() => null);
    const other = await (await bx.tee(users[1])).getAccountInfo(strat, "processed").catch(() => null);
    rec("owner reads own strategy", !!owner, owner ? `${owner.data.length} bytes` : "null");
    rec("stranger cannot read strategy", !s1, s1 ? "LEAK" : "null");
    rec("no-token cannot read strategy", !s2, s2 ? "LEAK" : "null");
    rec("rival entrant cannot read strategy", !other, other ? "LEAK" : "null");
    rec("stranger cannot read position", !p1, p1 ? "LEAK" : "null");
    const sb = await bx.fetchScoreboard(round);
    rec("public can read Lit scoreboard", !!sb, sb ? `${sb.n} entries` : "null");
    if (owner) {
      const s = bx.program.coder.accounts.decode("strategy", owner.data);
      const lines = disassemble(Uint8Array.from(s.bytecode.slice(0, s.len)));
      rec("owner disassembles own strategy", lines.length > 0, lines.slice(0, 4).map((l) => l.text).join(" | "));
    }
  });

  it("8. start: live, VRF seed, crank clock + per-entrant ticks (ER)", async () => {
    await bx.startRound(round);
    try {
      await bx.requestSeed(round, 42);
    } catch (e) {
      rec("VRF request", false, String(e).slice(0, 160));
    }
    taskBase = Math.floor(Math.random() * 1_000_000_000);
    const base = taskBase;
    await bx.scheduleClock(round, base);
    for (const [i, u] of users.entries()) await bx.scheduleEntrantTick(round, u.publicKey, feeds, base + 1 + i);
    const t0 = Date.now();
    let r: any = null;
    while (Date.now() - t0 < 20_000) {
      r = await bx.fetchRound(round);
      if (r && Number(r.tick) >= 5) break;
      await sleep(500);
    }
    rec("crank clock ticking", !!r && Number(r.tick) >= 5, `tick ${r?.tick} after ${Date.now() - t0}ms`);
    rec("VRF seed landed", !!r?.vrfReady, r?.vrfReady ? `mystery market ${r.mysteryMarket}` : "not yet");
  });

  it("8b. blind licensing: a backer runs entrant 0's sealed strategy on its own margin", async () => {
    const author = users[0].publicKey;
    const ent = await bx.fetchEntrant(round, author);
    rec("blind price published for entrant 0", !!ent, `fee ${ent?.feePriceBps} bps (only the price is public)`);
    await bx.openLicense(round, mint, backer, author);
    await bx.delegateLicense(round, backer, author);
    await bx.depositToEr(backer, mint, 200n * USDC);
    await bx.waitErBalance(backer, mint, 200n * USDC);
    const lic = pda.licensePda(round, backer.publicKey, author);
    await bx.waitOnEr(backer, lic);
    await bx.activateLicense(round, mint, backer, author, 100n * USDC);
    await bx.scheduleLicenseTick(round, backer.publicKey, author, feeds, taskBase + 100);
    const own = await bx.fetchLicense(round, backer, backer.publicKey, author);
    rec("backer reads own license", !!own && own.active === 1, own ? `margin ${Number(own.margin) / 1e6} USDC, fee ${own.feeBps} bps` : "null");
    const au = await bx.fetchLicense(round, users[0], backer.publicKey, author);
    rec("author reads the license (member)", !!au);
    const st = await bx.fetchLicense(round, stranger, backer.publicKey, author).catch(() => null);
    rec("stranger cannot read the license", !st, st ? "LEAK" : "null");
    const peek = await (await bx.tee(backer)).getAccountInfo(pda.strategyPda(round, author), "processed").catch(() => null);
    rec("backer cannot read the strategy it runs", !peek, peek ? "LEAK" : "null");
    const e2 = await bx.fetchEntrant(round, author);
    rec("author license count incremented", Number(e2?.licenseCount) === 1, `${e2?.licenseCount}`);
  });

  it("9. round runs; mid-round hot-swap; watch the scoreboard", async () => {
    let swapped = false;
    let last = -1;
    const t0 = Date.now();
    while (Date.now() - t0 < (DURATION * TICK_MS + 60_000)) {
      const r = await bx.fetchRound(round);
      const sb = await bx.fetchScoreboard(round);
      if (!r || !sb) { await sleep(1000); continue; }
      const tick = Number(r.tick);
      if (tick !== last && tick % 10 === 0) {
        const eq = sb.entries.slice(0, sb.n).map((e: any, i: number) => `${names[i % names.length].slice(0, 6)}=${(Number(e.equity) / 1e6).toFixed(2)}${e.alive ? "" : "†"}/${e.trades}t`);
        console.log(`    tick ${tick}/${DURATION} ${Object.keys(r.status)[0]} | ${eq.join("  ")}`);
        last = tick;
      }
      if (!swapped && tick >= DURATION / 3) {
        // entrant 0 hot-swaps from momentum to mean reversion mid-round
        const sig = await bx.setStrategy(round, users[0], strategies.meanReversion(0, 1500));
        codes[0] = strategies.meanReversion(0, 1500);
        swapped = true;
        rec("hot-swap mid-round (entrant 0)", true, `tick ${tick} ${sig.slice(0, 16)}`);
      }
      if ("settling" in r.status) break;
      await sleep(1000);
    }
    const r = await bx.fetchRound(round);
    rec("round reached settling", !!r && "settling" in r.status, `tick ${r?.tick}`);
    const sb = await bx.fetchScoreboard(round);
    const trades = sb.entries.slice(0, sb.n).reduce((a: number, e: any) => a + Number(e.trades), 0);
    rec("strategies traded", trades > 0, `${trades} trades total`);
    for (const [i, u] of users.entries()) {
      const p = await bx.fetchPosition(round, u);
      console.log(`    entrant ${i} ${names[i % names.length]}: margin=${Number(p.margin) / 1e6} realized=${Number(p.realizedPnl) / 1e6} trades=${p.tradeCount} steps=${p.lastSteps} fault=${p.lastFault} liq=${p.liquidated}`);
    }
    const l = await bx.fetchLicense(round, backer, backer.publicKey, users[0].publicKey);
    if (l) {
      console.log(`    license backer->entrant 0: margin=${Number(l.margin) / 1e6} realized=${Number(l.realizedPnl) / 1e6} fees=${Number(l.accruedFees) / 1e6} trades=${l.tradeCount} fee=${l.feeBps}bps liq=${l.liquidated} fault=${l.lastFault}`);
      rec("license ticked by the crank", Number(l.ranTick) > 0, `last tick ${Number(l.ranTick) - 1}, ${l.tradeCount} trades`);
    } else {
      rec("license ticked by the crank", false, "license unreadable by its buyer");
    }
    if (pusher) console.log(`    price pusher errors: ${pusherErrors}`);
  });

  it("10. settle every entrant, undelegate scrubbed accounts (ER)", async () => {
    // The license settles first: fees to the author, the rest back to the backer, on the ER.
    const author = users[0];
    const lic = await bx.fetchLicense(round, backer, backer.publicKey, author.publicKey);
    const authorBefore = await bx.erTokenBalance(author, mint);
    const backerBefore = await bx.erTokenBalance(backer, mint);
    await bx.settleLicense(round, mint, backer.publicKey, author.publicKey, 3);
    const authorAfter = await bx.erTokenBalance(author, mint);
    const backerAfter = await bx.erTokenBalance(backer, mint);
    const fees = BigInt(lic?.accruedFees?.toString() ?? "0");
    rec(
      "license settled: author paid its accrued fees",
      lic?.liquidated ? authorAfter >= authorBefore : authorAfter - authorBefore === fees,
      `${Number(authorAfter - authorBefore) / 1e6} USDC at ${lic?.feeBps} bps`,
    );
    rec("license settled: backer got the rest back", backerAfter > backerBefore, `+${Number(backerAfter - backerBefore) / 1e6} USDC`);
    await bx.undelegateLicense(round, backer.publicKey, author.publicKey);
    const licKey = pda.licensePda(round, backer.publicKey, author.publicKey);
    let licOnL1: any = null;
    for (let k = 0; k < 60 && !licOnL1; k++) {
      const info = await bx.base.getAccountInfo(licKey);
      if (info && info.owner.equals(bx.program.programId)) licOnL1 = info;
      else await sleep(1000);
    }
    rec("license back on L1 as zeros", !!licOnL1 && licOnL1.data.subarray(8).every((b: number) => b === 0), licOnL1 ? `${licOnL1.data.length} bytes` : "not returned");

    for (const u of users) await bx.settle(round, mint, u.publicKey, 3);
    for (const u of users) await bx.undelegateEntrant(round, u.publicKey);
    // verify on L1: bodies are zero, hashes published
    await sleep(3000);
    let allZero = true;
    let returned = 0;
    for (const u of users) {
      for (const key of [pda.entrantPda(round, u.publicKey), pda.strategyPda(round, u.publicKey), pda.positionPda(round, u.publicKey)]) {
        for (let k = 0; k < 60; k++) {
          const info = await bx.base.getAccountInfo(key);
          if (info && info.owner.equals(bx.program.programId)) {
            returned++;
            const isEntrant = key.equals(pda.entrantPda(round, u.publicKey));
            if (!isEntrant && !info.data.subarray(8).every((b) => b === 0)) allZero = false;
            break;
          }
          await sleep(1000);
        }
      }
    }
    rec("entrant accounts undelegated back to L1", returned === users.length * 3, `${returned}/${users.length * 3}`);
    rec("private accounts on L1 are all zeros after undelegation", allZero && returned === users.length * 3);
    const e0 = await bx.program.account.entrant.fetch(pda.entrantPda(round, users[0].publicKey));
    const expected = createHash("sha256").update(Buffer.from(codes[0])).digest();
    rec("published strategy hash matches final bytecode", Buffer.from(e0.strategyHash).equals(expected), Buffer.from(e0.strategyHash).toString("hex").slice(0, 16));
  });

  it("11. rank, pay prizes, close round, hall of fame", async () => {
    await bx.rank(round);
    const sb = await bx.fetchScoreboard(round);
    const ranked = sb.entries.slice(0, sb.n).map((e: any) => ({ owner: e.owner as PublicKey, rank: e.rank, equity: Number(e.equity) / 1e6 })).sort((a: any, b: any) => a.rank - b.rank);
    console.log("    final:", ranked.map((r: any) => `#${r.rank} ${r.owner.toBase58().slice(0, 4)} ${r.equity.toFixed(2)}`).join("  "));
    const winners = ranked.slice(0, Math.min(3, ranked.length)).map((r: any) => r.owner);
    const before = await Promise.all(winners.map((w: PublicKey) => bx.erTokenBalance(users.find((u) => u.publicKey.equals(w))!, mint)));
    await bx.payPrizes(round, mint, winners);
    const after = await Promise.all(winners.map((w: PublicKey) => bx.erTokenBalance(users.find((u) => u.publicKey.equals(w))!, mint)));
    rec("prizes paid to top 3", after.every((a, i) => a > before[i]), after.map((a, i) => `+${Number(a - before[i]) / 1e6}`).join(" "));
    await bx.closeRound(round, 3);
    await bx.waitRoundOnL1(round);
    for (const u of users) await bx.recordHall(round, u.publicKey);
    const h = await bx.program.account.hall.fetch(pda.hallPda(winners[0]));
    rec("hall of fame updated", h.wins >= 1, `winner elo ${h.elo}, rounds ${h.rounds}`);
    const rd = await bx.program.account.round.fetch(round);
    rec("round settled on L1", "settled" in rd.status, `vault_balance ${rd.vaultBalance}`);
  });

  after(async () => {
    if (pusher) { clearInterval(pusher); clearInterval((pusher as any).refresh); }
    console.log(`\n==== BLACKBOX e2e (${CLUSTER}) ====`);
    for (const r of rows) console.log(`${r.status.padEnd(4)} ${r.step}${r.detail ? "  (" + r.detail + ")" : ""}`);
    const fails = rows.filter((r) => r.status === "FAIL").length;
    console.log(`\n${rows.filter((r) => r.status === "PASS").length} pass, ${fails} fail`);
    setTimeout(() => process.exit(fails ? 1 : 0), 300);
  });
});
