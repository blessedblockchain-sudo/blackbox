/**
 * BXL sources used by the scripted agent (and as the fallback when an LLM
 * fails to produce a compiling program). `sym` is a BXL market symbol.
 */

/** EMA(8) vs EMA(21) trend follower; mirrors strategies.momentum(m, 3000) in the SDK. */
export function momentumBxl(sym: string, pct = 30): string {
  return `# Trend follower on ${sym}: EMA(8) vs EMA(21), trades only on side changes
let up = ema(${sym}, 8) > ema(${sym}, 21)
if up and pos(${sym}) <= 0 {
  long(${sym}, ${pct}%)
} elif not up and pos(${sym}) >= 0 {
  short(${sym}, ${pct}%)
}
`;
}

/** Fade 8-tick moves beyond +/- 0.08%, flatten near zero; mirrors strategies.meanReversion(m, 2500, 0.0008). */
export function meanReversionBxl(sym: string, pct = 25): string {
  return `# Mean reversion on ${sym}: fade 8-tick moves beyond 0.08%, flatten when the move fades
let r = ret(${sym}, 8)
if r < -0.08% and pos(${sym}) <= 0 {
  long(${sym}, ${pct}%)
} elif r > 0.08% and pos(${sym}) >= 0 {
  short(${sym}, ${pct}%)
} elif abs(r) < 0.02% and pos(${sym}) != 0 {
  close(${sym})
}
`;
}
