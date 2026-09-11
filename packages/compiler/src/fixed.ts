/**
 * 6-decimal fixed-point arithmetic with the exact semantics of the Rust VM
 * (`crates/bxvm/src/exec.rs`): i64 values, i128 intermediates, truncating
 * division, saturation to the i64 range. Shared by constant folding in the
 * compiler and by the simulator so both agree with the chain bit for bit.
 */

export const SCALE = 1_000_000n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

/** Clamp to the i64 range (Rust `clamp(i64::MIN, i64::MAX)` / saturating ops). */
export function sat(v: bigint): bigint {
  return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

export const fadd = (a: bigint, b: bigint) => sat(a + b);
export const fsub = (a: bigint, b: bigint) => sat(a - b);
/** (a * b) / SCALE, truncating toward zero, saturating. */
export const fmul = (a: bigint, b: bigint) => sat((a * b) / SCALE);
/** (a * SCALE) / b, truncating toward zero, saturating. Returns null on b == 0 (DivByZero). */
export function fdiv(a: bigint, b: bigint): bigint | null {
  if (b === 0n) return null;
  return sat((a * SCALE) / b);
}
/** Rust `wrapping_rem`: sign follows the dividend. Returns null on b == 0. */
export function frem(a: bigint, b: bigint): bigint | null {
  if (b === 0n) return null;
  if (a === I64_MIN && b === -1n) return 0n;
  return a % b;
}
export const fneg = (a: bigint) => sat(-a);
export const fabs = (a: bigint) => sat(a < 0n ? -a : a);
export const bool = (b: boolean) => (b ? SCALE : 0n);

/** Convert a plain number (e.g. a USD price) to 6-dp fixed point, rounding to nearest. */
export function toFixed(v: number): bigint {
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  return BigInt(Math.round(v * 1e6));
}

/** Convert 6-dp fixed point to a plain number. */
export function fromFixed(v: bigint): number {
  return Number(v) / 1e6;
}

/**
 * Parse a decimal literal exactly (no float rounding) into an integer scaled by
 * 10^decimals. Underscores are digit separators. Returns null when the literal
 * has non-zero digits beyond `decimals` places.
 */
export function parseDecimal(text: string, decimals: number): bigint | null {
  const t = text.replace(/_/g, "");
  const [intPart, fracPart = ""] = t.split(".");
  const frac = fracPart.replace(/0+$/, "");
  if (frac.length > decimals) return null;
  const i = BigInt(intPart === "" ? "0" : intPart);
  const f = frac === "" ? 0n : BigInt(frac.padEnd(decimals, "0"));
  return i * 10n ** BigInt(decimals) + f;
}

/** Format 6-dp fixed point as a short decimal string (for messages and listings). */
export function formatFixed(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / SCALE;
  const f = (a % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}
