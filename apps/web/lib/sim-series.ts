/** Build a simulator price series from the best history available. */
import type { SimTick } from "@blackbox/compiler";

export interface SeriesPick {
  series: SimTick[];
  source: "history" | "ring" | "none";
}

/**
 * Prefer the longer of: aligned history rows (indexer or client samples) and
 * the on-chain ring buffers (last <= 64 marks per market, oldest first).
 */
export function pickSeries(historyRows: number[][], rings: number[][]): SeriesPick {
  const ringLen = rings.length ? Math.min(...rings.map((r) => r.length)) : 0;
  const ringRows: number[][] = [];
  for (let i = 0; i < ringLen; i++) ringRows.push(rings.map((r) => r[r.length - ringLen + i]));
  const useHistory = historyRows.length >= ringRows.length && historyRows.length > 1;
  const rows = useHistory ? historyRows : ringRows;
  if (rows.length < 2) return { series: [], source: "none" };
  return { series: rows.map((prices) => ({ prices })), source: useHistory ? "history" : "ring" };
}
