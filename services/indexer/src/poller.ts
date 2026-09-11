/**
 * Polls the public TEE endpoint for the current round's Round, Scoreboard and
 * Markets, and records a Sample on every tick change. Re-reads the round state
 * file each cycle so it follows a new round when one starts.
 */
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BlackboxClient, Cluster, pda } from "@blackbox/sdk";
import { StoreRegistry } from "./store";
import { RoundInfo, Sample, EquityPoint } from "./types";

const ROOT = path.resolve(__dirname, "../../..");
const toNum = (v: any) => (v == null ? 0 : Number(v.toString()));
const usdc = (v: any) => toNum(v) / 1_000_000;

export interface PollerOptions {
  cluster: Cluster;
  intervalMs?: number;
  roundFile?: string;
  log?: (...a: unknown[]) => void;
}

interface RoundFileShape {
  cluster: Cluster;
  roundId: number;
  round: string;
  mode: string;
  markets: string[];
  feeds: string[];
  tickMs: number;
  durationTicks: number;
  phase: string;
}

export class Poller {
  readonly cluster: Cluster;
  readonly intervalMs: number;
  readonly roundFile: string;
  readonly registry = new StoreRegistry();
  private bx: BlackboxClient;
  private timer: NodeJS.Timeout | null = null;
  private log: (...a: unknown[]) => void;
  /** The round PDA named by the state file on the last read. */
  currentRound: string | null = null;

  constructor(opts: PollerOptions) {
    this.cluster = opts.cluster;
    this.intervalMs = opts.intervalMs ?? 500;
    this.roundFile = opts.roundFile ?? path.join(ROOT, `.mb/round-${opts.cluster}.json`);
    this.log = opts.log ?? (() => {});
    this.bx = new BlackboxClient(Keypair.generate(), opts.cluster);
  }

  private readRoundFile(): RoundFileShape | null {
    try {
      if (!fs.existsSync(this.roundFile)) return null;
      return JSON.parse(fs.readFileSync(this.roundFile, "utf8"));
    } catch {
      return null;
    }
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      this.pollOnce().catch((e) => this.log("poll error:", String(e).slice(0, 160)));
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    const rf = this.readRoundFile();
    if (!rf?.round) return;
    if (rf.round !== this.currentRound) {
      this.currentRound = rf.round;
      this.log(`following round ${rf.round} (#${rf.roundId}, ${rf.mode})`);
    }
    const roundPk = new PublicKey(rf.round);
    const store = this.registry.get(rf.round);

    const round: any = await this.bx.fetchRound(roundPk);
    if (!round) return;
    const phase = Object.keys(round.status)[0] ?? "unknown";
    const nMarkets = Number(round.nMarkets);
    const tick = toNum(round.tick);

    // Markets (public).
    const markets = await Promise.all(Array.from({ length: nMarkets }, (_, i) => this.bx.fetchMarket(roundPk, i)));
    const marks = markets.map((m: any) => (m ? usdc(m.mark) : 0));

    // Scoreboard (public in lit rounds; null in dark rounds).
    let equities: EquityPoint[] = [];
    const sb: any = await this.bx.fetchScoreboard(roundPk).catch(() => null);
    if (sb) {
      equities = sb.entries.slice(0, sb.n).map((e: any) => ({
        owner: (e.owner as PublicKey).toBase58(),
        equity: usdc(e.equity),
        alive: !!e.alive,
        trades: Number(e.trades),
      }));
    }

    // Round metadata (always refreshed for /rounds/current).
    store.info = {
      cluster: this.cluster,
      round: rf.round,
      roundId: rf.roundId ?? null,
      mode: rf.mode ?? Object.keys(round.mode)[0] ?? "lit",
      phase,
      tick,
      durationTicks: toNum(round.durationTicks),
      tickIntervalMs: Number(round.tickIntervalMs),
      nMarkets,
      markets: rf.markets ?? [],
      feeds: rf.feeds ?? markets.map((m: any) => (m ? m.feed.toBase58() : "")),
      entrantCount: Number(round.entrantCount),
      pot: usdc(round.pot),
      vaultBalance: usdc(round.vaultBalance),
      totalEquity: usdc(round.totalEquity),
      updatedAt: Date.now(),
    };

    // Sample only on tick change (store enforces uniqueness too).
    if (tick !== store.lastTick) {
      const sample: Sample = { t: Date.now(), tick, phase, marks, equities };
      if (store.append(sample)) this.log(`round ${rf.round.slice(0, 6)} tick ${tick} ${phase} marks=[${marks.map((x) => x.toFixed(2)).join(",")}] entrants=${equities.length}`);
    }
  }
}
