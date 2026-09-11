/**
 * Hall of Fame: every `Hall` account on Solana L1 (seeds ["hall", wallet]),
 * written by record_hall after each settled round.
 */
import { Program, type Provider } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import type { Blackbox } from "@blackbox/sdk/src/blackbox.types";
import { IDL } from "../chain";
import { fromMicro, toNum } from "../format";
import type { Cluster, HallResponse, HallRow } from "../api-types";
import { namesFrom, readRoundFile } from "./round-file";

// Names seen in any round file since the server started (round files are rewritten every round).
const g = globalThis as unknown as { __bxNames?: Map<string, { name: string; bot: boolean }> };

function rememberedNames(cluster: Cluster) {
  g.__bxNames ??= new Map();
  for (const [k, v] of namesFrom(readRoundFile(cluster))) g.__bxNames.set(k, v);
  return g.__bxNames;
}

/** Highest ELO first; ties by wins, then total PnL, then rounds played. */
export function sortHall(rows: HallRow[]): HallRow[] {
  return [...rows].sort((a, b) => b.elo - a.elo || b.wins - a.wins || b.totalPnl - a.totalPnl || b.rounds - a.rounds || a.wallet.localeCompare(b.wallet));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toHallRow(address: string, h: any, names: Map<string, { name: string; bot: boolean }>): HallRow {
  const wallet = typeof h.wallet?.toBase58 === "function" ? h.wallet.toBase58() : String(h.wallet);
  const best = toNum(h.bestRank);
  const known = names.get(wallet);
  return {
    wallet,
    name: known?.name ?? null,
    bot: !!known?.bot,
    rounds: toNum(h.rounds),
    wins: toNum(h.wins),
    podiums: toNum(h.podiums),
    totalPnl: fromMicro(h.totalPnl),
    elo: toNum(h.elo),
    bestRank: best > 0 ? best : null,
    hall: address,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchHall(cluster: Cluster, base: string): Promise<HallResponse> {
  const provider = { connection: new Connection(base, "confirmed") } as unknown as Provider;
  const program = new Program<Blackbox>(IDL as unknown as Blackbox, provider);
  // program.account.hall.all(): getProgramAccounts filtered on the Hall discriminator.
  const accounts = await program.account.hall.all();
  const names = rememberedNames(cluster);
  const rows = accounts.map((a) => toHallRow(a.publicKey.toBase58(), a.account, names));
  return { cluster, base, rows: sortHall(rows), at: Date.now() };
}
