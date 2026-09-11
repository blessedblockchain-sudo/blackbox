/**
 * Number conversion and formatting. On-chain amounts and prices are 6-decimal
 * fixed point integers (BN from the Anchor coder); tools report plain numbers.
 */

/** BN | bigint | number | string -> number, scaled down by 1e6. */
export function fx6(v: unknown): number {
  return toNum(v) / 1e6;
}

/** BN | bigint | number | string -> number (unscaled). */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return Number((v as { toString(): string }).toString());
}

export function toBig(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt((v as { toString(): string }).toString());
}

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Price with precision adapted to magnitude. */
export function fmtPrice(n: number): string {
  const a = Math.abs(n);
  return n.toFixed(a >= 1000 ? 2 : a >= 1 ? 4 : 6);
}

export function fmtUsd(n: number): string {
  return `${n.toFixed(2)} USDC`;
}

export function fmtPct(frac: number, dp = 2): string {
  return `${(frac * 100).toFixed(dp)}%`;
}

export function fmtSigned(n: number, dp = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

export function short(key: string): string {
  return key.length > 10 ? `${key.slice(0, 4)}..${key.slice(-4)}` : key;
}

/** Anchor enum `{ live: {} }` -> "live". */
export function enumName(v: unknown): string {
  if (v && typeof v === "object") return Object.keys(v as object)[0] ?? "unknown";
  return String(v);
}

/** Order-preserving ring read: last `n` entries, oldest first. */
export function ringTail(ring: unknown[], ringPos: number, ringLen: number, n: number): number[] {
  const len = ring.length;
  const k = Math.max(0, Math.min(n, ringLen, len));
  const out: number[] = [];
  for (let j = k; j >= 1; j--) out.push(toNum(ring[(ringPos + len - j) % len]));
  return out;
}

export const FAULTS = [
  "BadVersion",
  "BadOpcode",
  "Truncated",
  "StackUnderflow",
  "StackOverflow",
  "DivByZero",
  "BadJump",
  "BadMarket",
  "BadOperand",
  "StepLimit",
  "TooManyActions",
  "NoData",
] as const;

/** Position.last_fault is 0 for none, else Fault index + 1. */
export function faultName(code: number): string | null {
  if (!code) return null;
  return FAULTS[code - 1] ?? `Fault${code}`;
}

export interface LegView {
  market: string;
  index: number;
  side: "long" | "short";
  notional: number;
  entry: number;
  mark: number;
  unrealizedPnl: number;
  fundingOwed: number;
}

/**
 * Equity estimate mirroring programs/blackbox/src/perps.rs `equity()`:
 * margin + realized + sum(unrealized) - sum(funding owed), all in 6dp integers.
 */
export function estimateEquity(
  margin: bigint,
  realized: bigint,
  legs: { side: number; size: bigint; entry: bigint; fundingIndex: bigint }[],
  marks: bigint[],
  fundingIndex: bigint[],
): { equity: bigint; unrealized: bigint[]; funding: bigint[] } {
  let e = margin + realized;
  const unrealized: bigint[] = [];
  const funding: bigint[] = [];
  legs.forEach((leg, i) => {
    let u = 0n;
    let f = 0n;
    if (leg.side !== 0 && leg.size !== 0n) {
      if (leg.entry > 0n && marks[i] !== undefined) u = (leg.size * BigInt(leg.side) * (marks[i] - leg.entry)) / leg.entry;
      f = (leg.size * BigInt(leg.side) * ((fundingIndex[i] ?? 0n) - leg.fundingIndex)) / 1_000_000n;
      e += u - f;
    }
    unrealized.push(u);
    funding.push(f);
  });
  return { equity: e, unrealized, funding };
}
