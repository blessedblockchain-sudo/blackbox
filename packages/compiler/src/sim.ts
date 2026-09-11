/**
 * Off-chain backtester. Runs strategy bytecode through the TypeScript port of
 * the VM (`./interp`) on a price series, with a single-entrant perps book that
 * mirrors `tick_entrant` in `programs/blackbox/src/instructions/tick.rs`:
 *
 *   per tick: update indicators (ring, EMA 8/21/55, realized vol, funding every
 *   240 ticks) -> equity -> run the VM (if alive) -> apply actions in order,
 *   re-marking equity after each -> maintenance check and liquidation.
 *
 * Differences from the chain (by necessity): the book holds only this
 * entrant's open interest (no other entrants moving the skew), RAND comes from
 * a seeded splitmix64 instead of the round's VRF seed, and prices come from the
 * series rather than an oracle account.
 */
import type { SimOptions, SimResult, SimTick, SimTraceEntry } from "./index";
import { SCALE, fromFixed, sat, toFixed } from "./fixed";
import { execute, formatAction, VmHost, DEFAULT_STEP_LIMIT, Action } from "./interp";
import {
  BPS,
  FUNDING_PERIOD_TICKS,
  LegState,
  MarketState,
  PerpsError,
  accrueFunding,
  equity as bookEquity,
  maintenance,
  newLeg,
  newMarket,
  ret as marketRet,
  tradeToTarget,
  updateIndicators,
} from "./perps";
import { MAX_MARKETS, MEM_SLOTS } from "@blackbox/sdk/src/vm";

export const SIM_DEFAULTS = {
  margin: 100,
  maxLeverage: 20,
  maintenanceBps: 300,
  spreadBps: 2,
  skewSpreadBps: 25,
  oiCap: 5_000_000,
  stepLimit: DEFAULT_STEP_LIMIT,
  seed: 0,
};

/** Deterministic per-(seed, tick) value in [0, SCALE) (splitmix64). */
export function simRand(seed: number, tick: number): bigint {
  const M = (v: bigint) => BigInt.asUintN(64, v);
  let z = M(BigInt(Math.trunc(seed)) * 0x9e3779b97f4a7c15n + BigInt(tick + 1) * 0xbf58476d1ce4e5b9n);
  z = M((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = M((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  z = z ^ (z >> 31n);
  return z % SCALE;
}

/** The VM's view of one tick (mirror of `TickHost` in programs/blackbox/src/vm_host.rs). */
export class SimHost implements VmHost {
  constructor(
    readonly markets: MarketState[],
    readonly legs: LegState[],
    readonly equityNow: bigint,
    readonly free: bigint,
    readonly tickNow: number,
    readonly randNow: bigint,
  ) {}
  nMarkets() {
    return this.markets.length;
  }
  price(m: number) {
    const p = this.markets[m]?.mark ?? 0n;
    return p > 0n ? p : null;
  }
  ema(m: number, k: number) {
    const mk = this.markets[m];
    if (!mk) return null;
    const v = k === 0 ? mk.ema8 : k === 1 ? mk.ema21 : k === 2 ? mk.ema55 : null;
    return v !== null && v > 0n ? v : null;
  }
  ret(m: number, n: number) {
    const mk = this.markets[m];
    if (!mk) return null;
    // Before the ring has enough history the chain reports 0 rather than faulting.
    return marketRet(mk, n) ?? 0n;
  }
  vol(m: number) {
    return this.markets[m]?.vol ?? null;
  }
  pos(m: number) {
    if (m >= MAX_MARKETS) return 0n;
    const l = this.legs[m];
    return l ? l.size * BigInt(l.side) : 0n;
  }
  entry(m: number) {
    if (m >= MAX_MARKETS) return 0n;
    return this.legs[m]?.entry ?? 0n;
  }
  equity() {
    return this.equityNow;
  }
  freeMargin() {
    return this.free;
  }
  tick() {
    return BigInt(this.tickNow);
  }
  rand() {
    return this.randNow;
  }
}

/** Free margin = equity - sum(size_i / max_leverage_i), clamped at 0. */
export function freeMargin(eq: bigint, legs: LegState[], markets: MarketState[]): bigint {
  let used = 0n;
  for (let i = 0; i < markets.length; i++) {
    if (legs[i].side !== 0) used += legs[i].size / BigInt(Math.max(1, markets[i].maxLeverage));
  }
  const f = eq - used;
  return f < 0n ? 0n : sat(f);
}

export function simulate(bytecode: Uint8Array, series: SimTick[], opts: SimOptions): SimResult {
  const n = opts.markets.length;
  if (n === 0) throw new Error("simulate: opts.markets is empty");
  const d = SIM_DEFAULTS;
  const markets: MarketState[] = opts.markets.map((_, i) =>
    newMarket({
      maxLeverage: opts.maxLeverage?.[i] ?? d.maxLeverage,
      maintenanceBps: opts.maintenanceBps?.[i] ?? d.maintenanceBps,
      baseSpreadBps: opts.spreadBps ?? d.spreadBps,
      skewSpreadBps: opts.skewSpreadBps ?? d.skewSpreadBps,
      oiCap: toFixed(opts.oiCap ?? d.oiCap),
    }),
  );
  const legs: LegState[] = Array.from({ length: Math.max(n, MAX_MARKETS) }, newLeg);
  const mem: bigint[] = new Array<bigint>(MEM_SLOTS).fill(0n);
  const margin = toFixed(opts.margin ?? d.margin);
  if (margin <= 0n) throw new Error("simulate: margin must be positive");
  const stepLimit = Math.max(1, opts.stepLimit ?? d.stepLimit);
  const seed = opts.seed ?? d.seed;
  const maint = markets.map((m) => m.maintenanceBps);

  let realized = 0n;
  let alive = true;
  let liquidated = false;
  let trades = 0;
  const equityCurve: number[] = [];
  const faults: SimResult["faults"] = [];
  const trace: SimTraceEntry[] = [];

  const marks = () => markets.map((m) => m.mark);
  const findex = () => markets.map((m) => m.fundingIndex);
  const eqNow = () => bookEquity(margin, realized, legs.slice(0, n), marks(), findex());

  for (let t = 0; t < series.length; t++) {
    const prices = series[t]?.prices;
    if (!prices || prices.length < n) throw new Error(`simulate: tick ${t} has ${prices?.length ?? 0} prices; expected ${n}`);
    // An unreadable oracle price fails the whole tick on chain: nothing changes.
    const fx = prices.slice(0, n).map((p) => (Number.isFinite(p) && p > 0 ? toFixed(p) : 0n));
    if (fx.some((p) => p <= 0n)) {
      equityCurve.push(fromFixed(eqNow()));
      if (opts.trace) trace.push({ tick: t, actions: [], steps: 0, fault: null, equity: equityCurve[t], liquidated, skipped: true });
      continue;
    }
    for (let i = 0; i < n; i++) {
      updateIndicators(markets[i], fx[i], t);
      if (t > 0 && t % FUNDING_PERIOD_TICKS === 0 && markets[i].lastFundingTick < t) {
        accrueFunding(markets[i]);
        markets[i].lastFundingTick = t;
      }
    }

    let eq = eqNow();
    let steps = 0;
    let fault: string | null = null;
    let acted: Action[] = [];
    if (alive && !liquidated && bytecode.length > 0) {
      const host = new SimHost(markets, legs, eq, freeMargin(eq, legs, markets), t, simRand(seed, t));
      const res = execute(bytecode, host, mem, stepLimit);
      steps = res.steps;
      if (res.fault) {
        fault = res.fault;
        faults.push({ tick: t, fault: res.fault, pc: res.pc });
      } else {
        acted = res.actions;
        for (const a of res.actions) {
          trades += applyAction(a, markets, legs, eq, n, (delta) => (realized = sat(realized + delta)));
          eq = eqNow();
        }
      }
    }

    // Mark to market, maintenance check, liquidation.
    eq = eqNow();
    const req = maintenance(legs.slice(0, n), maint);
    if (!liquidated && eq < req) {
      for (let i = 0; i < n; i++) {
        if (legs[i].side !== 0) {
          try {
            const r = tradeToTarget(markets[i], legs[i], 0n, eq, 0n);
            realized = sat(realized + r.realizedDelta);
          } catch (e) {
            if (!(e instanceof PerpsError)) throw e;
          }
        }
      }
      eq = eqNow();
      liquidated = true;
      alive = false;
      if (eq < 0n) {
        realized = -margin;
        eq = 0n;
      }
    }
    equityCurve.push(fromFixed(eq));
    if (opts.trace) trace.push({ tick: t, actions: acted.map(formatAction), steps, fault, equity: fromFixed(eq), liquidated });
  }

  const stats = curveStats(fromFixed(margin), equityCurve);
  const out: SimResult = {
    equity: equityCurve,
    trades,
    liquidated,
    faults,
    finalEquity: equityCurve.length ? equityCurve[equityCurve.length - 1] : fromFixed(margin),
    maxDrawdown: stats.maxDrawdown,
    sharpe: stats.sharpe,
    mem: mem.map(fromFixed),
  };
  if (opts.trace) out.trace = trace;
  return out;
}

/** Apply one VM action (mirror of `apply_action`); returns 1 if it traded. Rejected trades are skipped. */
function applyAction(a: Action, markets: MarketState[], legs: LegState[], eq: bigint, n: number, addRealized: (d: bigint) => void): number {
  let traded = 0;
  const trade = (i: number, target: bigint) => {
    let other = 0n;
    for (let j = 0; j < legs.length; j++) if (j !== i && legs[j].side !== 0) other += legs[j].size;
    try {
      const r = tradeToTarget(markets[i], legs[i], target, eq, other);
      addRealized(r.realizedDelta);
      if (r.traded) traded++;
    } catch (e) {
      // Increases rejected for leverage or OI cap are skipped on chain. (A failing
      // close would abort the whole tick transaction there; it cannot fail here
      // short of arithmetic overflow.)
      if (!(e instanceof PerpsError)) throw e;
    }
  };
  switch (a.kind) {
    case "closeAll":
      for (let i = 0; i < n; i++) if (legs[i].side !== 0) trade(i, 0n);
      break;
    case "close":
      if (a.market < n && legs[a.market].side !== 0) trade(a.market, 0n);
      break;
    case "long":
    case "short": {
      if (a.market < n) {
        const lev = BigInt(Math.max(1, markets[a.market].maxLeverage));
        const sign = a.kind === "long" ? 1n : -1n;
        const target = (((eq > 0n ? eq : 0n) * lev * BigInt(a.bps)) / BPS) * sign;
        trade(a.market, target);
      }
      break;
    }
  }
  return traded;
}

/** Max drawdown (fraction of peak) and Sharpe (mean/std of per-tick returns x sqrt(n)). */
export function curveStats(start: number, curve: number[]): { maxDrawdown: number; sharpe: number } {
  let peak = start;
  let maxDd = 0;
  const rets: number[] = [];
  let prev = start;
  for (const e of curve) {
    if (e > peak) peak = e;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
    if (prev > 0) rets.push((e - prev) / prev);
    prev = e;
  }
  let sharpe = 0;
  if (rets.length >= 2) {
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
    const std = Math.sqrt(variance);
    if (std > 1e-12) sharpe = (mean / std) * Math.sqrt(rets.length);
  }
  return { maxDrawdown: maxDd, sharpe };
}
