/** Shared indexer types. */

export interface EquityPoint {
  owner: string;
  /** Equity in USDC (human units, 6dp integer / 1e6). */
  equity: number;
  alive: boolean;
  trades: number;
}

/** One time-series sample, appended to .mb/indexer/<round>.jsonl per tick change. */
export interface Sample {
  /** Wall-clock timestamp (ms) the sample was taken. */
  t: number;
  /** On-chain tick counter. */
  tick: number;
  /** Round status: created | open | live | settling | settled. */
  phase: string;
  /** Mark price per market in round order, USD (6dp integer / 1e6). */
  marks: number[];
  /** Per-entrant equity snapshot from the (public, lit) scoreboard. */
  equities: EquityPoint[];
}

/** Public round metadata surfaced by /rounds/current. */
export interface RoundInfo {
  cluster: string;
  round: string;
  roundId: number | null;
  mode: string;
  phase: string;
  tick: number;
  durationTicks: number;
  tickIntervalMs: number;
  nMarkets: number;
  markets: string[];
  feeds: string[];
  entrantCount: number;
  pot: number;
  vaultBalance: number;
  totalEquity: number;
  updatedAt: number;
}
