/**
 * Exact parsing of typed token amounts. USDC has 6 decimals; amounts are
 * converted to integer micro-units with string math, never through floats.
 */

export const USDC_DECIMALS = 6;

export type ParsedAmount = { ok: true; micro: bigint; value: number } | { ok: false; error: string };

/** "200", "1,250.5", "0.000001" -> micro-units. Rejects signs, exponents and extra decimals. */
export function parseUsdcInput(raw: string, decimals = USDC_DECIMALS): ParsedAmount {
  const s = raw.trim().replace(/,/g, "");
  if (!s) return { ok: false, error: "Enter an amount in USDC." };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, error: "Use digits and at most one decimal point, like 200 or 250.5." };
  const [int, frac = ""] = s.split(".");
  if (frac.length > decimals) return { ok: false, error: `USDC has ${decimals} decimals; use at most ${decimals} digits after the point.` };
  const scale = 10n ** BigInt(decimals);
  const micro = BigInt(int || "0") * scale + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (micro === 0n) return { ok: false, error: "Amount must be greater than zero." };
  return { ok: true, micro, value: Number(micro) / Number(scale) };
}

const plain = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: USDC_DECIMALS });

/** A USDC amount for sentences and bounds: "5,000", "250.5". */
export function formatUsdcAmount(v: number): string {
  return Number.isFinite(v) ? plain.format(v) : "--";
}

const sol = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

/** A SOL balance: "1.98", "0.0021". */
export function formatSol(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? sol.format(v) : "--";
}

/** USD (6-dp float from the chain) to exact micro-units. */
export const toMicro = (usd: number): bigint => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));

/** Null when `micro` is inside [min, max] (USD bounds from the Round), else an error sentence. */
export function checkRange(micro: bigint, minUsd: number, maxUsd: number): string | null {
  if (!Number.isFinite(minUsd) || !Number.isFinite(maxUsd)) return null;
  if (micro < toMicro(minUsd) || micro > toMicro(maxUsd)) {
    return `Margin must be between ${formatUsdcAmount(minUsd)} and ${formatUsdcAmount(maxUsd)} USDC.`;
  }
  return null;
}
