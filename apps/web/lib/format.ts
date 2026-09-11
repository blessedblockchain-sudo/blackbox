/**
 * Display-only number formatting (en-US, half away from zero, no scientific
 * notation, no signed zero, "--" for missing values). Internal math keeps raw
 * precision; these functions only produce strings.
 */

export const DASH = "--";

type Numeric = number | bigint | string | null | undefined | { toString(): string };

const nf = new Map<string, Intl.NumberFormat>();
function fmt(v: number, decimals: number, grouping = true): string {
  const key = `${decimals}:${grouping}`;
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    });
    nf.set(key, f);
  }
  return f.format(v);
}

function valid(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 6-decimal fixed point (USDC, marks, fractions) to a plain number. */
export function fromMicro(x: Numeric): number {
  if (x === null || x === undefined) return NaN;
  if (typeof x === "number") return x / 1e6;
  if (typeof x === "bigint") return Number(x) / 1e6;
  const n = Number(String(x));
  return Number.isFinite(n) ? n / 1e6 : NaN;
}

/** Any numeric-ish value (BN, bigint, string) to a number. */
export function toNum(x: Numeric): number {
  if (x === null || x === undefined) return NaN;
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  const n = Number(String(x));
  return Number.isFinite(n) ? n : NaN;
}

function signOf(v: number, signed: boolean): string {
  if (v < 0) return "-";
  if (signed && v > 0) return "+";
  return "";
}

const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** 1234.5 -> "1.2K" (1 decimal, trailing .0 trimmed). `abs` must be >= 1000. */
function abbreviate(abs: number): string {
  for (let i = 0; i < UNITS.length; i++) {
    const [size, unit] = UNITS[i];
    if (abs >= size) {
      const scaled = Number(fmt(abs / size, 1, false));
      // 999,950 rounds to "1000.0K": promote to the next unit.
      if (scaled >= 1000 && i > 0) return `${fmt(abs / UNITS[i - 1][0], 1, false).replace(/\.0$/, "")}${UNITS[i - 1][1]}`;
      return `${fmt(scaled, 1, true).replace(/\.0$/, "")}${unit}`;
    }
  }
  return fmt(abs, 2);
}

export interface UsdOptions {
  /** Delta / PnL context: prefix "+" on gains. */
  signed?: boolean;
  /** Tables and tiles: abbreviate at or above 1K. */
  compact?: boolean;
}

/** USD value (fiat/stable): "$1,234.50", compact "$1.2K", PnL "+$3.10". */
export function formatUsd(v: number | null | undefined, opts: UsdOptions = {}): string {
  if (!valid(v)) return DASH;
  const { signed = false, compact = false } = opts;
  if (v === 0) return "$0.00";
  const abs = Math.abs(v);
  if (abs < 0.005) return signed ? `${signOf(v, true)}<$0.01` : "<$0.01";
  const body = compact && abs >= 1000 ? abbreviate(abs) : fmt(abs, 2);
  return `${signOf(v, signed)}$${body}`;
}

const SUB = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
const toSub = (n: number) => String(n).split("").map((d) => SUB[Number(d)]).join("");

/** Leading zeros after the decimal point before the first significant digit (abs < 1). */
function leadingZeros(abs: number): number {
  return abs <= 0 || abs >= 1 ? 0 : Math.max(0, Math.floor(-Math.log10(abs) + 1e-12));
}

/** 0.00005835 -> "0.0₄58" (sig = 2) or "0.0₄5835" (sig = 4). `abs` > 0, < 1. */
export function zeroSubscript(abs: number, sig: number): string {
  let z = leadingZeros(abs);
  let digits = Math.round(abs * 10 ** (z + sig));
  if (digits >= 10 ** sig) {
    // rounding carried into another digit (0.0000999 -> 0.0001)
    z -= 1;
    digits = Math.round(digits / 10);
  }
  const s = String(digits).padStart(sig, "0").replace(/0+$/, "") || "0";
  return `0.0${toSub(z)}${s}`;
}

/** Expanded decimal for aria-labels and copy. Never scientific notation. */
export function plainDecimal(v: number, maxDecimals = 12): string {
  if (!valid(v)) return DASH;
  return fmt(v, maxDecimals, false).replace(/\.?0+$/, "") || "0";
}

export type Context = "compact" | "detailed";

/** Price of one unit (token_price rules). Never abbreviated. */
export function formatPrice(v: number | null | undefined, ctx: Context = "detailed"): string {
  if (!valid(v)) return DASH;
  if (v === 0) return "$0.00";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const compact = ctx === "compact";
  if (abs >= 1000) return `${sign}$${fmt(abs, 2)}`;
  if (abs >= 100) return `${sign}$${fmt(abs, compact ? 0 : 2)}`;
  if (abs >= 1) return `${sign}$${fmt(abs, compact ? 1 : 3)}`;
  const z = leadingZeros(abs);
  if (z >= 3) return `${sign}$${zeroSubscript(abs, compact ? 2 : 4)}`;
  const decimals = Math.min(8, z + (compact ? 3 : 5));
  return `${sign}$${fmt(abs, decimals)}`;
}

/** Percent in percent units (12.345 -> "12.35%"). `signed` for changes. */
export function formatPercent(v: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (!valid(v)) return DASH;
  const signed = opts.signed ?? false;
  if (v === 0) return "0.00%";
  const abs = Math.abs(v);
  if (abs < 0.005) return signed ? `${signOf(v, true)}<0.01%` : "<0.01%";
  const decimals = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;
  return `${signOf(v, signed)}${fmt(abs, decimals)}%`;
}

/** Ratio with "x" suffix, up to 2 decimals, trailing zeros trimmed. */
export function formatRatio(v: number | null | undefined): string {
  if (!valid(v)) return DASH;
  if (v === 0) return "0x";
  const abs = Math.abs(v);
  if (abs < 0.005) return "<0.01x";
  const body = fmt(abs, 2).replace(/\.?0+$/, "");
  return `${v < 0 ? "-" : ""}${body}x`;
}

/**
 * Basis points with one decimal: 1.24 -> "1.2 bps". `decimals: 0` is for
 * integer on-chain bps (fees): 25 -> "25 bps".
 */
export function formatBps(v: number | null | undefined, opts: { signed?: boolean; decimals?: 0 | 1 } = {}): string {
  if (!valid(v)) return DASH;
  if (v === 0) return "0 bps";
  const abs = Math.abs(v);
  const whole = opts.decimals === 0;
  if (abs < (whole ? 0.5 : 0.05)) return `${opts.signed ? signOf(v, true) : ""}<${whole ? "1" : "0.1"} bps`;
  return `${signOf(v, opts.signed ?? false)}${fmt(abs, whole || abs >= 100 ? 0 : 1)} bps`;
}

/** Integer counts with separators. */
export function formatInt(v: number | null | undefined): string {
  if (!valid(v)) return DASH;
  const r = Math.round(v);
  return fmt(r === 0 ? 0 : r, 0);
}

/** Remaining time: "42s", "12m 05s", "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (!valid(ms) || ms < 0) return DASH;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Short elapsed times: "363 ms", "1.2 s", then formatDuration ("1m 05s"). */
export function formatMs(ms: number | null | undefined): string {
  if (!valid(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${fmt(Math.round(ms), 0)} ms`;
  if (ms < 60_000) return `${fmt(Math.floor(ms / 100) / 10, 1)} s`;
  return formatDuration(ms);
}

/** "9szZ2vRh…Aa33c" style short address. */
export function shortAddr(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return DASH;
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Return on deposit in percent units. */
export function returnPct(equity: number, deposited: number): number {
  if (!valid(equity) || !valid(deposited) || deposited <= 0) return NaN;
  return ((equity - deposited) / deposited) * 100;
}

/** "1 trade", "26 trades". */
export function plural(n: number | null | undefined, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}
