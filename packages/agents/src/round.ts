/**
 * Round file access. The round runner (scripts/run-round.ts) publishes the
 * live round in `.mb/round-<cluster>.json`; its `phase` field drives each
 * agent's lifecycle.
 */
import * as fs from "fs";
import * as path from "path";
import type { Phase } from "./types";

export interface RoundFileEntrant {
  name: string;
  owner: string;
  secretKey?: number[];
  bot?: boolean;
}

export interface RoundFile {
  cluster: "local" | "devnet";
  roundId: number;
  round: string;
  mint: string;
  feeds: string[];
  markets: string[];
  tickMs: number;
  durationTicks: number;
  mode: "lit" | "dark";
  phase: Phase;
  registrationEndsAt?: number;
  startedAt?: number;
  entrants: RoundFileEntrant[];
  external?: RoundFileEntrant[];
  entrantOwners?: string[];
}

const PHASES: Phase[] = ["registration", "delegating", "live", "settling", "settled"];

/** Walk up from this file to the pnpm workspace root. */
export function repoRoot(start = __dirname): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(__dirname, "../../..");
    dir = up;
  }
}

export function defaultRoundFile(cluster = process.env.BLACKBOX_CLUSTER || "local"): string {
  return path.join(repoRoot(), ".mb", `round-${cluster}.json`);
}

export function readRoundFile(file: string): RoundFile {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof raw.roundId !== "number" || !Array.isArray(raw.markets)) throw new Error(`${file} is not a round file (no roundId/markets)`);
  if (!PHASES.includes(raw.phase)) throw new Error(`${file}: unknown phase ${JSON.stringify(raw.phase)}`);
  return raw as RoundFile;
}

/** Round-file reads can race the runner's writes; retry briefly on parse errors. */
export async function readRoundFileSafe(file: string, attempts = 5): Promise<RoundFile> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return readRoundFile(file);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw last;
}

/** "SOL-PERP" -> "SOL", "BTC/USD" -> "BTC". */
export function marketSymbol(name: string): string {
  return name.split(/[-/ ]/)[0].toUpperCase();
}

export const phaseIndex = (p: Phase) => PHASES.indexOf(p);
