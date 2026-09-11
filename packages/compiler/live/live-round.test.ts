/**
 * Exercises @blackbox/compiler against the LIVE local round (.mb/round-local.json).
 * Needs the local stack running. Read-only by default; set BXL_LIVE_HOTSWAP=1 to
 * also hot-swap one bot to a behavior-identical BXL program and back.
 *
 *   npx ts-mocha -p packages/compiler/tsconfig.json packages/compiler/live/live-round.test.ts
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BlackboxClient, pda, validate } from "@blackbox/sdk/src";
import { compile, simulate, formatListing, EXAMPLES, execute, faultName, formatAction } from "../src";
import { SimHost, freeMargin } from "../src/sim";
import * as P from "../src/perps";
import { ports } from "../test/ports";

const STATE = path.resolve(__dirname, "../../../.mb/round-local.json");
const big = (v: { toString(): string } | number | bigint) => BigInt(v.toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Bot {
  name: string;
  kp: Keypair;
}

/** Which SDK builtin (and parameters) each bot of scripts/run-round.ts runs. */
function botPort(name: string, sym: (i: number) => string) {
  const p = ports(sym);
  const table: Record<string, () => { bxl: string; sdk: Uint8Array }> = {
    Momentum: () => p.momentum(0, 3000),
    Reverter: () => p.meanReversion(0, 2500),
    Breakout: () => p.breakout(1, 4000),
    Coinflip: () => p.randomWalk(0, 2000),
    HODL: () => p.alwaysLong(1, 5000),
    Degen: () => p.degen(0),
    PairsBot: () => p.pairs(0, 1, 2000),
    EthTrend: () => p.momentum(2, 4000),
    BtcFade: () => p.meanReversion(1, 3000),
    SolBreak: () => p.breakout(0, 3000),
  };
  return table[name]?.();
}

function toMarket(m: any): P.MarketState {
  return {
    mark: big(m.mark),
    ema8: big(m.ema8),
    ema21: big(m.ema21),
    ema55: big(m.ema55),
    vol: big(m.vol),
    ring: m.ring.map(big),
    ringPos: m.ringPos,
    ringLen: m.ringLen,
    oiCap: big(m.oiCap),
    oiLong: big(m.oiLong),
    oiShort: big(m.oiShort),
    fundingIndex: big(m.fundingIndex),
    fundingRateBps: m.fundingRateBps,
    lastFundingTick: Number(m.lastFundingTick.toString()),
    lastTick: Number(m.lastTick.toString()),
    maxLeverage: m.maxLeverage,
    maintenanceBps: m.maintenanceBps,
    baseSpreadBps: m.baseSpreadBps,
    skewSpreadBps: m.skewSpreadBps,
  };
}

const toLegs = (pos: any): P.LegState[] => pos.legs.map((l: any) => ({ size: big(l.size), entry: big(l.entry), fundingIndex: big(l.fundingIndex), side: l.side }));

/** Mirror of TickHost::derive_rand: sha256(vrf_seed || owner || tick_le)[..8] as u64 % SCALE. */
function deriveRand(seed: number[], owner: PublicKey, tick: number): bigint {
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(tick));
  const h = createHash("sha256").update(Buffer.from(seed)).update(owner.toBuffer()).update(t).digest();
  return h.readBigUInt64LE(0) % 1_000_000n;
}

/** The marks in each market's ring, oldest first, as a simulate() series. */
function ringSeries(markets: P.MarketState[]) {
  const len = Math.min(...markets.map((m) => m.ringLen));
  const out: { prices: number[] }[] = [];
  for (let k = len; k >= 1; k--) out.push({ prices: markets.map((m) => Number(P.markAgo(m, k)!) / 1e6) });
  return out;
}

describe("BXL against the live local round", function () {
  this.timeout(600_000);
  let st: any;
  let bx: BlackboxClient;
  let round: PublicKey;
  let bots: Bot[] = [];
  let names: string[] = [];
  let nMarkets = 0;
  let roundAcc: any;
  let markets: P.MarketState[] = [];

  before(async function () {
    if (!fs.existsSync(STATE)) this.skip();
    st = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (st.cluster !== "local") this.skip();
    bx = new BlackboxClient(Keypair.generate(), "local");
    round = new PublicKey(st.round);
    roundAcc = await bx.fetchRound(round).catch(() => null);
    if (!roundAcc) this.skip();
    nMarkets = roundAcc.nMarkets;
    names = st.markets;
    bots = st.entrants.filter((e: any) => e.secretKey).map((e: any) => ({ name: e.name, kp: Keypair.fromSecretKey(Uint8Array.from(e.secretKey)) }));
    for (let i = 0; i < nMarkets; i++) markets.push(toMarket(await bx.fetchMarket(round, i)));
    console.log(`    round #${st.roundId} ${st.round} phase=${st.phase} tick=${roundAcc.tick}/${roundAcc.durationTicks} markets=${names.join(",")} bots=${bots.length}`);
  });

  it("every example compiles for the live round's markets and passes validate(nMarkets)", () => {
    for (const [name, src] of Object.entries(EXAMPLES)) {
      const r = compile(src, { markets: names });
      expect(r.errors, name).to.deep.equal([]);
      expect(validate(r.bytecode, nMarkets), name).to.equal(null);
      console.log(`    ${name.padEnd(14)} ${String(r.bytecode.length).padStart(4)} bytes, maxSteps ${r.maxSteps}`);
    }
  });

  it("indicators recomputed from each live Market ring match the chain (vol exactly)", () => {
    for (let i = 0; i < nMarkets; i++) {
      const m = markets[i];
      expect(P.realizedVol(m), names[i]).to.equal(m.vol);
      expect(P.markAgo(m, 1), names[i]).to.equal(m.mark);
      const r8 = P.ret(m, 8);
      console.log(`    ${names[i]} mark=${Number(m.mark) / 1e6} ema8=${Number(m.ema8) / 1e6} vol=${m.vol} (recomputed ${P.realizedVol(m)}) ret8=${r8} ringLen=${m.ringLen}`);
    }
  });

  it("BXL ports of the bots behave identically to the SDK builtins on the live price history; on-chain bytecode is read and disassembled", async () => {
    const series = ringSeries(markets);
    const simOpts = {
      markets: names,
      margin: 200,
      maxLeverage: markets.map((m) => m.maxLeverage),
      maintenanceBps: markets.map((m) => m.maintenanceBps),
      spreadBps: markets[0].baseSpreadBps,
      skewSpreadBps: markets[0].skewSpreadBps,
      oiCap: Number(markets[0].oiCap) / 1e6,
      trace: true,
    };
    const sym = (i: number) => names[i].split(/[^A-Za-z0-9]/)[0];
    let compared = 0;
    for (const b of bots) {
      const s: any = await bx.fetchStrategy(round, b.kp);
      expect(s, `${b.name}: owner-authenticated strategy read`).to.not.equal(null);
      const onchain = Uint8Array.from(s.bytecode.slice(0, s.len));
      expect(validate(onchain, nMarkets), `${b.name}: on-chain bytecode validates`).to.equal(null);
      const listing = formatListing(onchain);
      expect(listing.split("\n").length).to.be.greaterThan(1);
      const port = botPort(b.name, sym);
      if (!port) continue;
      const same = Buffer.from(onchain).equals(Buffer.from(port.sdk));
      const c = compile(port.bxl, { markets: names });
      expect(c.errors, b.name).to.deep.equal([]);
      const a = simulate(port.sdk, series, simOpts);
      const z = simulate(c.bytecode, series, simOpts);
      expect(z.trace!.map((t) => t.actions), b.name).to.deep.equal(a.trace!.map((t) => t.actions));
      expect(z.equity, b.name).to.deep.equal(a.equity);
      compared++;
      const acts = a.trace!.filter((t) => t.actions.length).length;
      const onchainNote = same ? "on-chain == SDK builtin" : `on-chain v${s.version} was hot-swapped (${onchain.length}B, not the builtin)`;
      console.log(`    ${b.name.padEnd(9)} BXL port ${String(c.bytecode.length).padStart(3)}B == builtin behavior on ${series.length} live ticks (${acts} acting ticks); ${onchainNote}`);
      if (!same && process.env.BXL_DEBUG) console.log(listing.split("\n").map((l) => "      " + l).join("\n"));
    }
    expect(compared).to.be.greaterThan(0);
  });

  it("re-executing each bot's on-chain bytecode on consistent live snapshots reproduces the chain's equity and VM step count", async () => {
    const SAMPLES = Number(process.env.BXL_LIVE_SAMPLES || 12);
    const stats = new Map<string, { samples: number; synced: number; stepsMatch: number; noop: number; faultsMatch: number; volOk: number }>();
    for (let s = 0; s < SAMPLES; s++) {
      for (const b of bots) {
        const conn = await bx.tee(b.kp);
        const keys = [round, pda.scoreboardPda(round), ...Array.from({ length: nMarkets }, (_, i) => pda.marketPda(round, i)), pda.positionPda(round, b.kp.publicKey), pda.strategyPda(round, b.kp.publicKey)];
        const infos = await conn.getMultipleAccountsInfo(keys, "processed");
        if (infos.some((x) => !x)) throw new Error(`${b.name}: snapshot missing an account`);
        const dec = (name: string, i: number) => bx.program.coder.accounts.decode(name, infos[i]!.data) as any;
        const r = dec("round", 0);
        const sb = dec("scoreboard", 1);
        const ms = Array.from({ length: nMarkets }, (_, i) => toMarket(dec("market", 2 + i)));
        const pos = dec("position", 2 + nMarkets);
        const strat = dec("strategy", 3 + nMarkets);
        const row = stats.get(b.name) ?? { samples: 0, synced: 0, stepsMatch: 0, noop: 0, faultsMatch: 0, volOk: 0 };
        stats.set(b.name, row);
        row.samples++;
        if (ms.every((m) => P.realizedVol(m) === m.vol)) row.volOk++;
        const legs = toLegs(pos);
        const eq = P.equity(big(pos.margin), big(pos.realizedPnl), legs.slice(0, nMarkets), ms.map((m) => m.mark), ms.map((m) => m.fundingIndex));
        const entry = sb.entries.slice(0, sb.n).find((e: any) => e.owner.equals(b.kp.publicKey));
        const synced = entry && big(entry.equity) === eq && big(pos.lastEquity) === eq;
        if (!synced || pos.liquidated) continue;
        row.synced++;
        // The chain ran this entrant after the markets' last refresh: rebuild its VM inputs.
        const tick = ms[0].lastTick;
        const host = new SimHost(ms, legs, eq, freeMargin(eq, legs, ms), tick, deriveRand(r.vrfSeed, b.kp.publicKey, tick));
        const code = Uint8Array.from(strat.bytecode.slice(0, strat.len));
        const res = execute(code, host, pos.mem.map(big), Math.max(1, Math.min(strat.stepLimit, r.stepLimit)));
        if (res.steps === pos.lastSteps) row.stepsMatch++;
        if ((res.fault ?? null) === faultName(pos.lastFault)) row.faultsMatch++;
        // Would the strategy's actions still move the book? (No: the chain already applied them.)
        const clone = ms.map((m) => ({ ...m, ring: [...m.ring] }));
        const cl = legs.map((l) => ({ ...l }));
        let moves = false;
        for (const a of res.actions) {
          const targets = a.kind === "closeAll" ? cl.map((_, i) => i).filter((i) => i < nMarkets && cl[i].side !== 0) : [a.market];
          for (const i of targets) {
            const lev = BigInt(clone[i].maxLeverage);
            const tgt = a.kind === "long" || a.kind === "short" ? ((eq * lev * BigInt(a.bps)) / 10_000n) * (a.kind === "long" ? 1n : -1n) : 0n;
            if (tgt !== cl[i].size * BigInt(cl[i].side)) moves = true;
          }
        }
        if (!moves || res.actions.length === 0) row.noop++;
        if (s === 0) console.log(`    ${b.name.padEnd(9)} tick ${tick}: equity ${Number(eq) / 1e6} == scoreboard; re-exec steps ${res.steps} vs chain ${pos.lastSteps}; actions [${res.actions.map(formatAction).join(", ")}]`);
      }
      await sleep(330);
    }
    let synced = 0;
    let stepsMatch = 0;
    let faultsMatch = 0;
    let samples = 0;
    for (const [name, r] of stats) {
      console.log(`    ${name.padEnd(9)} samples ${r.samples}  vol-exact ${r.volOk}  equity-exact ${r.synced}  steps-match ${r.stepsMatch}/${r.synced}  fault-match ${r.faultsMatch}/${r.synced}  settled-state ${r.noop}/${r.synced}`);
      synced += r.synced;
      stepsMatch += r.stepsMatch;
      faultsMatch += r.faultsMatch;
      samples += r.samples;
      expect(r.volOk, `${name}: vol recomputed from the ring`).to.equal(r.samples);
    }
    console.log(`    total: ${synced}/${samples} snapshots where TS equity == on-chain equity to the micro-dollar; steps ${stepsMatch}/${synced}; faults ${faultsMatch}/${synced}`);
    expect(synced, "some snapshots must catch an entrant right after its tick").to.be.greaterThan(samples * 0.2);
    expect(faultsMatch).to.equal(synced);
    expect(stepsMatch / synced).to.be.gte(0.9);
  });

  it("simulate() backtests every example on the live ring history", () => {
    const series = ringSeries(markets);
    for (const [name, src] of Object.entries(EXAMPLES)) {
      const c = compile(src, { markets: names });
      const r = simulate(c.bytecode, series, { markets: names, margin: 200, maxLeverage: markets.map((m) => m.maxLeverage), maintenanceBps: markets.map((m) => m.maintenanceBps) });
      expect(r.faults, name).to.deep.equal([]);
      expect(r.equity.length).to.equal(series.length);
      console.log(`    ${name.padEnd(14)} final ${r.finalEquity.toFixed(4).padStart(10)}  trades ${String(r.trades).padStart(3)}  maxDD ${(r.maxDrawdown * 100).toFixed(3)}%  sharpe ${r.sharpe.toFixed(2)}`);
    }
  });

  it("hot-swap: the chain executes BXL bytecode (opt-in: BXL_LIVE_HOTSWAP=1)", async function () {
    if (!process.env.BXL_LIVE_HOTSWAP) this.skip();
    if (st.phase !== "live") this.skip();
    const bot = bots.find((b) => b.name === "EthTrend") ?? bots[0];
    const sym = (i: number) => names[i].split(/[^A-Za-z0-9]/)[0];
    const port = botPort(bot.name, sym)!;
    // Behavior-identical to the bot's builtin, plus a marker: mem[7] records the tick it ran on.
    const src = `mem[7] = tick()\n${port.bxl}`;
    const c = compile(src, { markets: names });
    expect(c.errors).to.deep.equal([]);
    const before: any = await bx.fetchStrategy(round, bot.kp);
    const original = Uint8Array.from(before.bytecode.slice(0, before.len));
    const sig = await bx.setStrategy(round, bot.kp, c.bytecode);
    console.log(`    ${bot.name}: set_strategy (BXL, ${c.bytecode.length}B) ${sig}`);
    try {
      let s: any;
      for (let i = 0; i < 20; i++) {
        s = await bx.fetchStrategy(round, bot.kp);
        if (s.version === before.version + 1) break;
        await sleep(300);
      }
      expect(s.version).to.equal(before.version + 1);
      expect(Buffer.from(s.bytecode.slice(0, s.len)).equals(Buffer.from(c.bytecode))).to.equal(true);
      const seen: number[] = [];
      for (let i = 0; i < 30 && seen.length < 5; i++) {
        await sleep(400);
        const p: any = await bx.fetchPosition(round, bot.kp);
        const t = Number(big(p.mem[7]) / 1_000_000n);
        if (t > 0 && !seen.includes(t)) seen.push(t);
        expect(faultName(p.lastFault)).to.equal(null);
      }
      console.log(`    ${bot.name}: mem[7] written by the on-chain BXL run at ticks ${seen.join(", ")}`);
      expect(seen.length).to.be.gte(3);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).to.be.greaterThan(seen[i - 1]);
    } finally {
      const back = await bx.setStrategy(round, bot.kp, original);
      let s: any;
      for (let i = 0; i < 20; i++) {
        s = await bx.fetchStrategy(round, bot.kp);
        if (s.version === before.version + 2) break;
        await sleep(300);
      }
      expect(Buffer.from(s.bytecode.slice(0, s.len)).equals(Buffer.from(original)), "original bytecode restored").to.equal(true);
      console.log(`    ${bot.name}: restored original bytecode (v${s.version}) ${back}`);
    }
  });
});
