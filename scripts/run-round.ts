/**
 * Round runner: create a round, let bots (and anyone else) register, run it on
 * the crank, settle, and publish the round's addresses for the UI, indexer,
 * MCP server and agents.
 *
 *   CLUSTER=local|devnet  BOTS=8  TICK_MS=400  DURATION_TICKS=900  REGISTER_SECS=20  MODE=lit|dark
 *   BACKERS=1  LICENSE_AT_TICK=<tick, default a fifth of the round>
 *   pnpm exec ts-node --transpile-only scripts/run-round.ts
 *
 * State file: .mb/round-<cluster>.json (bot keypairs included; .mb is gitignored).
 * On local it also mirrors real SOL/BTC/ETH prices from devnet-tee into mock feeds.
 *
 * Copycat backers license the strategy with the highest blind price (set inside
 * the TEE from each author's private Sharpe ratio; they never see code or PnL).
 * Every license listed in the state file's `licenses` (the runner's, the web
 * app's, the MCP server's) is settled before the round closes.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BlackboxClient, DEVNET_FEEDS, pda, strategies, Cluster } from "../packages/sdk/src";

/**
 * The test mint's authority. On devnet it is a throwaway faucet key that also
 * ships in the web app, so visitors can mint themselves test USDC; the admin
 * keypair (round authority, program upgrade authority) stays out of the client.
 */
function mintAuthority(admin: Keypair): Keypair {
  const p = path.join(ROOT, "packages/sdk/src/devnet-faucet.json");
  if (CLUSTER !== "devnet" || !fs.existsSync(p)) return admin;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const CLUSTER = (process.env.CLUSTER || "local") as Cluster;
const BOTS = Number(process.env.BOTS || 8);
const TICK_MS = Number(process.env.TICK_MS || 400);
const DURATION = Number(process.env.DURATION_TICKS || 900);
const REGISTER_SECS = Number(process.env.REGISTER_SECS || 20);
const MODE = (process.env.MODE || "lit") as "lit" | "dark";
const BACKERS = Number(process.env.BACKERS ?? 1);
const LICENSE_AT = Number(process.env.LICENSE_AT_TICK || 0);
const USDC = 1_000_000n;
const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, `.mb/round-${CLUSTER}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BOT_ROSTER: { name: string; code: () => Uint8Array }[] = [
  { name: "Momentum", code: () => strategies.momentum(0, 3000) },
  { name: "Reverter", code: () => strategies.meanReversion(0, 2500) },
  { name: "Breakout", code: () => strategies.breakout(1, 4000) },
  { name: "Coinflip", code: () => strategies.randomWalk(0, 2000) },
  { name: "HODL", code: () => strategies.alwaysLong(1, 5000) },
  { name: "Degen", code: () => strategies.degen(0) },
  { name: "PairsBot", code: () => strategies.pairs(0, 1, 2000) },
  { name: "EthTrend", code: () => strategies.momentum(2, 4000) },
  { name: "BtcFade", code: () => strategies.meanReversion(1, 3000) },
  { name: "SolBreak", code: () => strategies.breakout(0, 3000) },
];

/**
 * Read-modify-write of the state file under the lock-file protocol shared with
 * the MCP server and the web app (O_EXCL lock, temp file + rename).
 */
function update(fn: (cur: any) => any) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const lock = `${STATE}.lock`;
  const t0 = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 5_000 || Date.now() - t0 > 10_000) fs.rmSync(lock, { force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const cur = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fn(cur), null, 2));
    fs.renameSync(tmp, STATE);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function appendLicense(rec: { name: string; buyer: string; author: string; bot: boolean; scheduled: boolean }) {
  update((cur) => {
    const list: any[] = Array.isArray(cur.licenses) ? cur.licenses : [];
    if (!list.some((l) => l.buyer === rec.buyer && l.author === rec.author)) list.push(rec);
    return { ...cur, licenses: list, updatedAt: Date.now() };
  });
}

/** The author a copycat backs: highest public blind price, then Lit-scoreboard equity. */
async function pickAuthor(bx: BlackboxClient, round: PublicKey, owners: PublicKey[]): Promise<PublicKey> {
  const sb: any = await bx.fetchScoreboard(round).catch(() => null);
  const equity = new Map<string, number>();
  for (const e of sb ? sb.entries.slice(0, sb.n) : []) equity.set((e.owner as PublicKey).toBase58(), e.alive ? Number(e.equity) : -1);
  let best = owners[0];
  let bestKey = [-1, -Infinity];
  for (const o of owners) {
    const ent: any = await bx.fetchEntrant(round, o).catch(() => null);
    if (!ent?.alive) continue;
    const key = [Number(ent.feePriceBps), equity.get(o.toBase58()) ?? 0];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = o;
      bestKey = key;
    }
  }
  return best;
}

/** Full blind-licensing flow for one backer: L1 open + delegate, deposit, ER activate, crank. */
async function backStrategy(bx: BlackboxClient, round: PublicKey, mint: PublicKey, feeds: PublicKey[], kp: Keypair, author: PublicKey, taskId: number) {
  await bx.openLicense(round, mint, kp, author);
  await bx.delegateLicense(round, kp, author);
  await bx.depositToEr(kp, mint, 300n * USDC);
  await bx.waitErBalance(kp, mint, 300n * USDC);
  await bx.waitOnEr(kp, pda.licensePda(round, kp.publicKey, author));
  await bx.activateLicense(round, mint, kp, author, 200n * USDC);
  await bx.scheduleLicenseTick(round, kp.publicKey, author, feeds, taskId);
}

async function realPrices(): Promise<bigint[]> {
  const conn = new Connection("https://devnet-tee.magicblock.app", "processed");
  const out: bigint[] = [];
  for (const f of Object.values(DEVNET_FEEDS)) {
    const info = await conn.getAccountInfo(f.address, "processed");
    out.push(info ? info.data.readBigInt64LE(73) : 0n);
  }
  return out;
}

async function main() {
  const admin = anchor.Wallet.local().payer;
  const bx = new BlackboxClient(admin, CLUSTER);
  bx.log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const status = (phase: string, extra: any = {}) => {
    update((prev) => ({ ...prev, ...extra, phase, updatedAt: Date.now() }));
    console.log(`== ${phase}`);
  };

  // 1) protocol + mint
  let mint: PublicKey;
  if (await bx.base.getAccountInfo(pda.configPda())) {
    mint = (await bx.program.account.protocolConfig.fetch(pda.configPda())).usdcMint;
  } else {
    if (CLUSTER === "local") await bx.base.confirmTransaction(await bx.base.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
    mint = await createMint(bx.base, admin, admin.publicKey, null, 6);
    await bx.initProtocol(mint, 500);
  }

  // 2) feeds
  let feeds: PublicKey[];
  let pusher: NodeJS.Timeout | null = null;
  if (CLUSTER === "devnet") {
    feeds = Object.values(DEVNET_FEEDS).map((f) => f.address);
  } else {
    const px = await realPrices();
    const ids = [6, 1, 2];
    feeds = [];
    for (let i = 0; i < 3; i++) {
      const f = await bx.initMockFeed(ids[i], px[i], 8);
      const info = await bx.base.getAccountInfo(f);
      if (info && info.owner.equals(bx.program.programId)) await bx.delegateMockFeed(ids[i]);
      feeds.push(f);
    }
    for (const f of feeds) await bx.waitOnEr(admin, f);
    let cur = px;
    setInterval(async () => { try { cur = await realPrices(); } catch {} }, 2000);
    pusher = setInterval(() => { Promise.all(feeds.map((f, i) => bx.setMockFeed(f, cur[i], 8))).catch(() => {}); }, 500);
  }
  bx.log = () => {};

  // 3) round
  const { roundId, round } = await bx.createRound(mint, {
    mode: MODE,
    entryFee: 5n * USDC,
    minMargin: 50n * USDC,
    maxMargin: 5_000n * USDC,
    tickIntervalMs: TICK_MS,
    durationTicks: DURATION,
  });
  const markets = [
    { name: "SOL-PERP", maxLeverage: 20, maintenanceBps: 300 },
    { name: "BTC-PERP", maxLeverage: 20, maintenanceBps: 300 },
    { name: "ETH-PERP", maxLeverage: 10, maintenanceBps: 500 },
  ];
  for (let i = 0; i < 3; i++) {
    await bx.addMarket(round, i, { feed: feeds[i], decimals: 8, maxLeverage: markets[i].maxLeverage, maintenanceBps: markets[i].maintenanceBps, baseSpreadBps: 2, skewSpreadBps: 25, oiCap: 5_000_000n * USDC });
  }
  await bx.openRound(round);
  const bots = BOT_ROSTER.slice(0, BOTS).map((b) => ({ ...b, kp: Keypair.generate() }));
  const backers = Array.from({ length: BACKERS }, (_, i) => ({ name: `Copycat${BACKERS > 1 ? i + 1 : ""}`, kp: Keypair.generate() }));
  // A fresh round starts with fresh license and external-entrant lists.
  update(() => ({}));
  status("registration", {
    cluster: CLUSTER,
    roundId,
    round: round.toBase58(),
    mint: mint.toBase58(),
    feeds: feeds.map((f) => f.toBase58()),
    markets: markets.map((m) => m.name),
    tickMs: TICK_MS,
    durationTicks: DURATION,
    mode: MODE,
    registrationEndsAt: Date.now() + REGISTER_SECS * 1000,
    entrants: bots.map((b) => ({ name: b.name, owner: b.kp.publicKey.toBase58(), secretKey: Array.from(b.kp.secretKey), bot: true })),
    backers: backers.map((b) => ({ name: b.name, owner: b.kp.publicKey.toBase58(), secretKey: Array.from(b.kp.secretKey) })),
    licenses: [],
  });

  // 4) bots join; backers get SOL + USDC for later
  const wallets = [...bots.map((b) => ({ kp: b.kp, sol: 0.06 })), ...backers.map((b) => ({ kp: b.kp, sol: 0.1 }))];
  await bx.sendBase(wallets.map((w) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.kp.publicKey, lamports: w.sol * LAMPORTS_PER_SOL })), [admin], "fund bots");
  const faucet = mintAuthority(admin);
  for (const w of wallets) await bx.mintTestUsdc(mint, w.kp.publicKey, 2_000n * USDC, faucet);
  for (const b of bots) {
    await bx.join(round, mint, b.kp);
    await bx.delegateEntrant(round, b.kp);
  }
  const endReg = JSON.parse(fs.readFileSync(STATE, "utf8")).registrationEndsAt;
  while (Date.now() < endReg) await sleep(1000);

  // 5) delegate + ER setup
  status("delegating");
  await bx.delegateMarkets(roundId, 3);
  await bx.delegateRound(roundId);
  await bx.waitOnEr(admin, round);
  for (const [i, b] of bots.entries()) await bx.depositToEr(b.kp, mint, 500n * USDC, b.kp, i === 0);
  for (const b of bots) {
    await bx.waitErBalance(b.kp, mint, 500n * USDC);
    await bx.waitOnEr(b.kp, pda.entrantPda(round, b.kp.publicKey));
    await bx.privatize(round, b.kp);
    await bx.setStrategy(round, b.kp, b.code());
    await bx.fund(round, mint, b.kp, 200n * USDC);
  }
  // House bankroll, from a fresh wallet each round (a wallet's first ER deposit
  // is the reliable path): profits are paid in full whatever order entrants
  // settle in. What is left after the round is swept back to the house.
  const bankroll = BigInt(process.env.BANKROLL_USDC ?? 2000) * USDC;
  let house: Keypair | null = null;
  if (bankroll > 0n) {
    try {
      const kp = Keypair.generate();
      await bx.sendBase([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })], [admin], "fund house");
      await bx.mintTestUsdc(mint, kp.publicKey, bankroll, mintAuthority(admin));
      await bx.depositToEr(kp, mint, bankroll);
      await bx.waitErBalance(kp, mint, bankroll);
      await bx.seedVault(round, mint, bankroll, kp);
      house = kp;
      update((cur) => ({ ...cur, house: { owner: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey), bankrollUsdc: Number(bankroll) / 1e6 } }));
    } catch (e) {
      console.log("bankroll seeding failed:", String(e).slice(0, 200));
    }
  }
  if (MODE === "dark") await bx.setScoreboardPrivacy(round, true);

  // External entrants (agents) register via the MCP server during the window and
  // write themselves into .mb/round-<cluster>.json `external`; they privatize/fund
  // themselves. Give them a short grace period to finish.
  await sleep(Number(process.env.GRACE_SECS || 5) * 1000);

  // 6) go live
  status("live");
  await bx.startRound(round);
  await bx.requestSeed(round, 9).catch((e) => console.log("vrf request failed:", String(e).slice(0, 120)));
  const base = Math.floor(Math.random() * 1_000_000_000);
  await bx.scheduleClock(round, base);
  const all: any = await bx.fetchRound(round);
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  let entrantKeys: PublicKey[] = [...st.entrants, ...(st.external ?? [])].map((e: any) => new PublicKey(e.owner));
  if (entrantKeys.length !== Number(all.entrantCount)) entrantKeys = await allEntrants(bx, round, Number(all.entrantCount));
  for (const [i, owner] of entrantKeys.entries()) await bx.scheduleEntrantTick(round, owner, feeds, base + 1 + i);
  status("live", { startedAt: Date.now(), entrantOwners: entrantKeys.map((k) => k.toBase58()) });

  // 7) copycats license the highest blind price once the prices mean something
  const licenseAt = LICENSE_AT || Math.max(20, Math.floor(DURATION / 5));
  const copycat = (async () => {
    if (!backers.length) return;
    for (;;) {
      const r: any = await bx.fetchRound(round);
      if (!r || "settling" in r.status) return;
      if (Number(r.tick) >= licenseAt) break;
      await sleep(1000);
    }
    const author = await pickAuthor(bx, round, entrantKeys);
    for (const [i, b] of backers.entries()) {
      try {
        await backStrategy(bx, round, mint, feeds, b.kp, author, base + 500 + i);
        appendLicense({ name: b.name, buyer: b.kp.publicKey.toBase58(), author: author.toBase58(), bot: true, scheduled: true });
        console.log(`   ${b.name} licensed ${author.toBase58().slice(0, 6)}`);
        const ent: any = await bx.fetchEntrant(round, author).catch(() => null);
        const who = bots.find((x) => x.kp.publicKey.equals(author))?.name ?? author.toBase58().slice(0, 6);
        await bx.postChat(round, b.kp, `${b.name}: backing ${who} at ${ent?.feePriceBps ?? "?"} bps, sight unseen`).catch(() => {});
      } catch (e) {
        console.log(`   ${b.name} license failed: ${String(e).slice(0, 200)}`);
      }
    }
  })();

  // 8) wait for the clock to finish; crank licenses that others opened without a task (`scheduled: false`)
  const seen = new Set<string>();
  for (;;) {
    const r: any = await bx.fetchRound(round);
    if (r && "settling" in r.status) break;
    const pending = (JSON.parse(fs.readFileSync(STATE, "utf8")).licenses ?? []).filter((l: any) => l.scheduled === false && !seen.has(`${l.buyer}:${l.author}`));
    for (const l of pending) {
      seen.add(`${l.buyer}:${l.author}`);
      try {
        await bx.scheduleLicenseTick(round, new PublicKey(l.buyer), new PublicKey(l.author), feeds, base + 1000 + seen.size);
        update((cur) => ({ ...cur, licenses: (cur.licenses ?? []).map((x: any) => (x.buyer === l.buyer && x.author === l.author ? { ...x, scheduled: true } : x)) }));
        console.log(`   scheduled license ${l.buyer.slice(0, 6)} -> ${l.author.slice(0, 6)}`);
      } catch (e) {
        console.log(`   license schedule failed: ${String(e).slice(0, 160)}`);
      }
    }
    await sleep(2000);
  }
  await copycat.catch(() => {});

  // 9) settle: licenses first (fees to authors, the rest to backers), then entrants
  status("settling");
  const licenses: { name?: string; buyer: string; author: string }[] = JSON.parse(fs.readFileSync(STATE, "utf8")).licenses ?? [];
  for (const l of licenses) {
    const buyer = new PublicKey(l.buyer);
    const author = new PublicKey(l.author);
    try {
      await bx.settleLicense(round, mint, buyer, author, 3);
      await bx.undelegateLicense(round, buyer, author);
      console.log(`   license ${l.name ?? l.buyer.slice(0, 6)} -> ${l.author.slice(0, 6)} settled`);
    } catch (e) {
      console.log(`   license ${l.buyer.slice(0, 6)} settle failed: ${String(e).slice(0, 200)}`);
    }
  }
  // Losers first (lit rounds), so profits come out of their losses before the bankroll.
  const sbEnd: any = await bx.fetchScoreboard(round).catch(() => null);
  const pnl = new Map<string, number>();
  for (const e of sbEnd ? sbEnd.entries.slice(0, sbEnd.n) : []) pnl.set((e.owner as PublicKey).toBase58(), Number(e.equity) - Number(e.deposited));
  const settleOrder = [...entrantKeys].sort((a, b) => (pnl.get(a.toBase58()) ?? 0) - (pnl.get(b.toBase58()) ?? 0));
  for (const owner of settleOrder) await bx.settle(round, mint, owner, 3);
  for (const owner of entrantKeys) await bx.undelegateEntrant(round, owner);
  await bx.rank(round);
  const sb: any = await bx.fetchScoreboard(round);
  const ranked = sb.entries.slice(0, sb.n).filter((e: any) => e.rank > 0).sort((a: any, b: any) => a.rank - b.rank);
  await bx.payPrizes(round, mint, ranked.slice(0, 3).map((e: any) => e.owner));
  if (house) await bx.sweepVault(round, mint, house.publicKey).catch((e) => console.log("sweep_vault failed:", String(e).slice(0, 160)));
  await bx.closeChat(round).catch((e) => console.log("close_chat failed:", String(e).slice(0, 160)));
  await bx.closeRound(round, 3);
  await bx.waitRoundOnL1(round);
  for (const owner of entrantKeys) await bx.recordHall(round, owner).catch(() => {});
  status("settled", { settledAt: Date.now() });
  if (pusher) clearInterval(pusher);
  process.exit(0);
}

/** Entrant owners in index order, read from the public Entrant accounts. */
async function allEntrants(bx: BlackboxClient, round: PublicKey, n: number): Promise<PublicKey[]> {
  const conn = bx.teePublic();
  const accs = await bx.program.account.entrant.all([{ memcmp: { offset: 8, bytes: round.toBase58() } }]).catch(() => [] as any[]);
  let list = accs.map((a: any) => a.account);
  if (list.length < n) {
    // fall back to the ER view
    const raw = await conn.getProgramAccounts(bx.program.programId, { filters: [{ memcmp: { offset: 8, bytes: round.toBase58() } }] }).catch(() => []);
    list = raw.map((r) => { try { return bx.program.coder.accounts.decode("entrant", r.account.data); } catch { return null; } }).filter(Boolean);
  }
  return list.sort((a: any, b: any) => a.index - b.index).map((e: any) => e.owner as PublicKey);
}

main().catch((e) => { console.error(e); process.exit(1); });
