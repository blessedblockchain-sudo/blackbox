/**
 * Port of the perps engine (`programs/blackbox/src/perps.rs`) with BigInt
 * i128-style arithmetic: truncating division, checked conversions to i64.
 * Used by the simulator; exported so tools can recompute indicators from a
 * live Market account (ring buffer, EMAs, vol) and compare with the chain.
 */
import { SCALE, sat } from "./fixed";

export const BPS = 10_000n;
export const RING_LEN = 64;
/** Funding accrues every this many ticks (programs/blackbox/src/instructions/tick.rs). */
export const FUNDING_PERIOD_TICKS = 240;
export const FUNDING_RATE_BPS_AT_FULL_SKEW = 10n;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export class PerpsError extends Error {}

function toI64(v: bigint): bigint {
  if (v < I64_MIN || v > I64_MAX) throw new PerpsError("MathOverflow");
  return v;
}

function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new PerpsError("MathOverflow");
  return (a * b) / d;
}

const absB = (v: bigint) => (v < 0n ? -v : v);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);

export interface MarketState {
  mark: bigint;
  ema8: bigint;
  ema21: bigint;
  ema55: bigint;
  /** Realized vol, scaled fraction. */
  vol: bigint;
  ring: bigint[];
  /** One past the newest entry. */
  ringPos: number;
  ringLen: number;
  oiCap: bigint;
  oiLong: bigint;
  oiShort: bigint;
  fundingIndex: bigint;
  fundingRateBps: number;
  lastFundingTick: number;
  lastTick: number;
  maxLeverage: number;
  maintenanceBps: number;
  baseSpreadBps: number;
  skewSpreadBps: number;
}

export interface LegState {
  /** Notional, USDC 6dp (u64). */
  size: bigint;
  /** Entry price, 6dp. */
  entry: bigint;
  fundingIndex: bigint;
  /** 1 long, -1 short, 0 flat. */
  side: number;
}

export function newMarket(p: { maxLeverage: number; maintenanceBps: number; baseSpreadBps: number; skewSpreadBps: number; oiCap: bigint }): MarketState {
  return {
    mark: 0n,
    ema8: 0n,
    ema21: 0n,
    ema55: 0n,
    vol: 0n,
    ring: new Array<bigint>(RING_LEN).fill(0n),
    ringPos: 0,
    ringLen: 0,
    oiCap: p.oiCap,
    oiLong: 0n,
    oiShort: 0n,
    fundingIndex: 0n,
    fundingRateBps: 0,
    lastFundingTick: 0,
    lastTick: 0,
    maxLeverage: p.maxLeverage,
    maintenanceBps: p.maintenanceBps,
    baseSpreadBps: p.baseSpreadBps,
    skewSpreadBps: p.skewSpreadBps,
  };
}

export function newLeg(): LegState {
  return { size: 0n, entry: 0n, fundingIndex: 0n, side: 0 };
}

/** Integer square root (floor) for non-negative values. */
export function isqrt(v: bigint): bigint {
  if (v <= 0n) return 0n;
  let x = v;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + v / x) / 2n;
  }
  return x;
}

/** ema += (mark - ema) * 2 / (n + 1) */
function emaStep(ema: bigint, mark: bigint, n: bigint): bigint {
  const adj = ((mark - ema) * 2n) / (n + 1n);
  return toI64(ema + adj);
}

/** Push a new mark into the ring and refresh EMAs and vol (`update_indicators`). */
export function updateIndicators(m: MarketState, mark: bigint, tick: number): void {
  const pos = m.ringPos;
  m.ring[pos] = mark;
  m.ringPos = (pos + 1) % RING_LEN;
  if (m.ringLen < RING_LEN) m.ringLen += 1;
  if (m.ema8 === 0n) {
    m.ema8 = mark;
    m.ema21 = mark;
    m.ema55 = mark;
  } else {
    m.ema8 = emaStep(m.ema8, mark, 8n);
    m.ema21 = emaStep(m.ema21, mark, 21n);
    m.ema55 = emaStep(m.ema55, mark, 55n);
  }
  m.vol = realizedVol(m);
  m.mark = mark;
  m.lastTick = tick;
}

/** Mark `n` ticks ago (n >= 1; n = 1 is the current mark). null if the ring lacks it. */
export function markAgo(m: Pick<MarketState, "ring" | "ringPos" | "ringLen">, n: number): bigint | null {
  if (n === 0 || n > m.ringLen || n > RING_LEN) return null;
  return m.ring[(m.ringPos + RING_LEN - n) % RING_LEN];
}

/** Return over the last n ticks as a scaled fraction (mark / mark_ago(n+1) - 1). */
export function ret(m: Pick<MarketState, "ring" | "ringPos" | "ringLen" | "mark">, n: number): bigint | null {
  const then = markAgo(m, n + 1);
  if (then === null || then <= 0n) return null;
  const r = ((m.mark - then) * SCALE) / then;
  return r < I64_MIN || r > I64_MAX ? null : r;
}

/** sqrt(mean(r_i^2)) over consecutive ring returns, scaled (`realized_vol`). */
export function realizedVol(m: Pick<MarketState, "ring" | "ringPos" | "ringLen">): bigint {
  const n = m.ringLen;
  if (n < 3) return 0n;
  let sumSq = 0n;
  let count = 0n;
  const newest = m.ringPos;
  for (let k = 1; k < n; k++) {
    const a = m.ring[(newest + RING_LEN - k) % RING_LEN];
    const b = m.ring[(newest + RING_LEN - k - 1) % RING_LEN];
    if (b <= 0n) continue;
    const r = mulDiv(a - b, SCALE, b);
    sumSq += r * r;
    count += 1n;
  }
  if (count === 0n) return 0n;
  return toI64(isqrt(sumSq / count));
}

/** Skew in [-SCALE, SCALE]. */
export function skew(m: MarketState): bigint {
  if (m.oiCap === 0n) return 0n;
  const s = ((m.oiLong - m.oiShort) * SCALE) / m.oiCap;
  return s < -SCALE ? -SCALE : s > SCALE ? SCALE : s;
}

export function spreadFrac(m: MarketState, buySide: 1 | -1): bigint {
  const sk = skew(m);
  const withSkew = sk * BigInt(buySide) > 0n;
  const base = (BigInt(m.baseSpreadBps) * SCALE) / BPS;
  const extra = withSkew ? (BigInt(m.skewSpreadBps) * absB(sk)) / BPS : 0n;
  return minB(base + extra, SCALE / 5n);
}

export function fillPrice(m: MarketState, buySide: 1 | -1): bigint {
  const sp = spreadFrac(m, buySide);
  return toI64(buySide > 0 ? mulDiv(m.mark, SCALE + sp, SCALE) : mulDiv(m.mark, SCALE - sp, SCALE));
}

export function unrealized(leg: LegState, mark: bigint): bigint {
  if (leg.side === 0 || leg.size === 0n || leg.entry <= 0n) return 0n;
  return toI64(mulDiv(leg.size * BigInt(leg.side), mark - leg.entry, leg.entry));
}

export function fundingOwed(leg: LegState, marketIndex: bigint): bigint {
  if (leg.side === 0 || leg.size === 0n) return 0n;
  return toI64(mulDiv(leg.size * BigInt(leg.side), marketIndex - leg.fundingIndex, SCALE));
}

/** Equity = margin + realized + sum(unrealized) - sum(funding owed). */
export function equity(margin: bigint, realized: bigint, legs: LegState[], marks: bigint[], findex: bigint[]): bigint {
  let e = margin + realized;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].side !== 0) {
      e += unrealized(legs[i], marks[i] ?? 0n);
      e -= fundingOwed(legs[i], findex[i] ?? 0n);
    }
  }
  return toI64(e);
}

/** Maintenance requirement: sum(size * maintenance_bps / BPS). */
export function maintenance(legs: LegState[], maintBps: number[]): bigint {
  let maint = 0n;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].side !== 0) maint += (legs[i].size * BigInt(maintBps[i] ?? 0)) / BPS;
  }
  return maint;
}

export interface TradeResult {
  realizedDelta: bigint;
  fundingPaid: bigint;
  traded: boolean;
}

/**
 * Move a leg to a signed target notional at the market's fill prices
 * (`trade_to_target`). Throws PerpsError("LeverageExceeded" | "OiCap" | ...)
 * exactly where the Rust code returns an error.
 */
export function tradeToTarget(m: MarketState, leg: LegState, target: bigint, equityNow: bigint, otherNotional: bigint): TradeResult {
  const out: TradeResult = { realizedDelta: 0n, fundingPaid: 0n, traded: false };
  const cur = leg.size * BigInt(leg.side);
  if (target === cur) return out;
  if (m.mark <= 0n) throw new PerpsError("BadOracle");

  // Mirrors the Rust exactly, including its partial-mutation behavior on
  // error: the leg's funding index is reset before the leverage check, and a
  // flip rejected by the OI cap has already closed the old leg (its PnL is not
  // realized because the caller drops the error). Market OI is only written on
  // success.
  let oiLongDelta = 0n;
  let oiShortDelta = 0n;
  {
    if (leg.side !== 0) {
      const f = fundingOwed(leg, m.fundingIndex);
      out.fundingPaid = f;
      out.realizedDelta = sat(out.realizedDelta - f);
      leg.fundingIndex = m.fundingIndex;
    }

    if (absB(target) > absB(cur)) {
      const maxNotional = maxB(equityNow, 0n) * BigInt(m.maxLeverage);
      if (absB(target) + otherNotional > maxNotional) throw new PerpsError("LeverageExceeded");
    }

    const sameSign = (cur > 0n && target > 0n) || (cur < 0n && target < 0n);
    let reduceTo: bigint;
    let increaseTo: bigint;
    if (cur === 0n) {
      reduceTo = 0n;
      increaseTo = target;
    } else if (sameSign) {
      if (absB(target) < absB(cur)) {
        reduceTo = target;
        increaseTo = target;
      } else {
        reduceTo = cur;
        increaseTo = target;
      }
    } else {
      reduceTo = 0n;
      increaseTo = target;
    }

    if (absB(reduceTo) < absB(cur)) {
      const closed = absB(cur) - absB(reduceTo);
      const sellSide: 1 | -1 = cur > 0n ? -1 : 1;
      const px = fillPrice(m, sellSide);
      const pnl = mulDiv(closed * BigInt(leg.side), px - leg.entry, leg.entry);
      out.realizedDelta = toI64(out.realizedDelta + pnl);
      if (cur > 0n) oiLongDelta -= closed;
      else oiShortDelta -= closed;
      leg.size = absB(reduceTo);
      if (leg.size === 0n) {
        leg.side = 0;
        leg.entry = 0n;
      }
      out.traded = true;
    }

    if (absB(increaseTo) > leg.size) {
      const side: 1 | -1 = increaseTo > 0n ? 1 : -1;
      const added = absB(increaseTo) - leg.size;
      const px = fillPrice(m, side);
      const sideOi = side > 0 ? m.oiLong + oiLongDelta : m.oiShort + oiShortDelta;
      if (sideOi + added > m.oiCap) throw new PerpsError("OiCap");
      if (leg.size === 0n) {
        leg.side = side;
        leg.entry = toI64(px);
        leg.fundingIndex = m.fundingIndex;
      } else {
        const old = leg.size;
        leg.entry = toI64((old * leg.entry + added * px) / (old + added));
      }
      leg.size = absB(increaseTo);
      if (side > 0) oiLongDelta += added;
      else oiShortDelta += added;
      out.traded = true;
    }

    m.oiLong = toI64(maxB(m.oiLong + oiLongDelta, 0n));
    m.oiShort = toI64(maxB(m.oiShort + oiShortDelta, 0n));
    return out;
  }
}

/** Funding index update (`accrue_funding`). */
export function accrueFunding(m: MarketState, rateBpsAtFullSkew: bigint = FUNDING_RATE_BPS_AT_FULL_SKEW): void {
  const rate = (skew(m) * rateBpsAtFullSkew) / BPS;
  m.fundingRateBps = Number((rate * BPS) / SCALE);
  m.fundingIndex = toI64(m.fundingIndex + rate);
}
