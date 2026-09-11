/**
 * Loading and interpreting the round state file written by scripts/run-round.ts
 * (`.mb/round-<cluster>.json`).
 */
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Cluster } from "@blackbox/sdk";

export interface RoundEntrant {
  name: string;
  owner: string;
  secretKey?: number[];
  bot?: boolean;
}

export interface RoundFile {
  cluster: Cluster;
  roundId: number;
  round: string;
  mint: string;
  feeds: string[];
  markets: string[];
  tickMs: number;
  durationTicks: number;
  mode: "lit" | "dark";
  phase: string;
  entrants: RoundEntrant[];
  external?: RoundEntrant[];
  entrantOwners?: string[];
}

const ROOT = path.resolve(__dirname, "../../..");

export function defaultRoundFile(cluster: Cluster): string {
  return path.join(ROOT, `.mb/round-${cluster}.json`);
}

export function loadRoundFile(file: string): RoundFile {
  if (!fs.existsSync(file)) throw new Error(`round file not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RoundFile;
}

export function allEntrants(rf: RoundFile): RoundEntrant[] {
  return [...(rf.entrants ?? []), ...(rf.external ?? [])];
}

export function keypairFor(entrant: RoundEntrant): Keypair | undefined {
  if (!entrant.secretKey || entrant.secretKey.length === 0) return undefined;
  return Keypair.fromSecretKey(Uint8Array.from(entrant.secretKey));
}

export interface TargetSelection {
  target: PublicKey;
  targetName: string;
  ownerKp?: Keypair;
  rivalKp?: Keypair;
  rivalName?: string;
}

/** Resolve the target entrant (by owner pubkey or index) plus owner + rival keypairs. */
export function selectTarget(rf: RoundFile, opts: { target?: string; index?: number }): TargetSelection {
  const entrants = allEntrants(rf);
  if (entrants.length === 0) throw new Error("round file lists no entrants");

  let chosen: RoundEntrant | undefined;
  if (opts.target) {
    chosen = entrants.find((e) => e.owner === opts.target);
    if (!chosen) chosen = { name: opts.target.slice(0, 6), owner: opts.target };
  } else {
    const idx = opts.index ?? 0;
    if (idx < 0 || idx >= entrants.length) throw new Error(`index ${idx} out of range (0..${entrants.length - 1})`);
    chosen = entrants[idx];
  }

  const target = new PublicKey(chosen.owner);
  const ownerKp = keypairFor(chosen);
  const rival = entrants.find((e) => e.owner !== chosen!.owner && e.secretKey && e.secretKey.length > 0);
  return {
    target,
    targetName: chosen.name,
    ownerKp,
    rivalKp: rival ? keypairFor(rival) : undefined,
    rivalName: rival?.name,
  };
}
