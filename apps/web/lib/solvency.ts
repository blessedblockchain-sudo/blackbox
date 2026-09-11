/**
 * Solvency beacon. Margins sit in per-entrant custody accounts; entry fees and
 * realized losses sit in the round vault. What the protocol owes is every
 * entrant's equity plus the prize pot.
 *   held = Σ deposited (custody) + vault balance
 *   owed = total equity + pot
 */
export interface Solvency {
  held: number;
  owed: number;
  custody: number;
  vault: number;
  equity: number;
  pot: number;
  /** held / owed in percent units (100 = exactly covered). */
  coverage: number;
  state: "covered" | "thin" | "short" | "unknown";
}

export function solvency(args: { deposits: number[]; vaultBalance: number; totalEquity: number; pot: number }): Solvency {
  const custody = args.deposits.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const held = custody + args.vaultBalance;
  const owed = args.totalEquity + args.pot;
  const ok = [held, owed].every(Number.isFinite) && owed > 0;
  const coverage = ok ? (held / owed) * 100 : NaN;
  const state: Solvency["state"] = !ok ? "unknown" : coverage >= 100 ? "covered" : coverage >= 97 ? "thin" : "short";
  return { held, owed, custody, vault: args.vaultBalance, equity: args.totalEquity, pot: args.pot, coverage, state };
}
