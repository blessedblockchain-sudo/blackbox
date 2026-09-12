/**
 * Hall of Fame: every `Hall` account on Solana L1 (seeds ["hall", wallet]),
 * written by record_hall after each settled round.
 *
 * Browser-safe: the only thing it touches is an RPC connection, so the same
 * code runs in the /api/hall route handler (server mode) and in the page
 * itself (static mode). Names come from whatever the caller knows.
 */
import { Program, type Provider } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import type { Blackbox } from "@blackbox/sdk/src/blackbox.types";
import { IDL } from "./chain";
import { fromMicro, toNum } from "./format";
import type { Cluster, HallResponse, HallRow } from "./api-types";

export type NameMap = Map<string, { name: string; bot: boolean }>;

/** Highest ELO first; ties by wins, then total PnL, then rounds played. */
export function sortHall(rows: HallRow[]): HallRow[] {
  return [...rows].sort((a, b) => b.elo - a.elo || b.wins - a.wins || b.totalPnl - a.totalPnl || b.rounds - a.rounds || a.wallet.localeCompare(b.wallet));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toHallRow(address: string, h: any, names: NameMap): HallRow {
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

/** program.account.hall.all(): getProgramAccounts filtered on the Hall discriminator. */
export async function fetchHallRows(cluster: Cluster, base: string, names: NameMap): Promise<HallResponse> {
  const provider = { connection: new Connection(base, "confirmed") } as unknown as Provider;
  const program = new Program<Blackbox>(IDL as unknown as Blackbox, provider);
  const accounts = await program.account.hall.all();
  const rows = accounts.map((a) => toHallRow(a.publicKey.toBase58(), a.account, names));
  return { cluster, base, rows: sortHall(rows), at: Date.now() };
}
