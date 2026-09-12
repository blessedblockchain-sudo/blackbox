/**
 * Server-side Hall of Fame: the browser-safe reader in ../hall, plus the names
 * seen in any round file since the server started (round files are rewritten
 * every round, so a name learned earlier is still worth showing).
 */
import type { Cluster, HallResponse } from "../api-types";
import { fetchHallRows, type NameMap } from "../hall";
import { namesFrom, readRoundFile } from "./round-file";

export { sortHall, toHallRow } from "../hall";

const g = globalThis as unknown as { __bxNames?: NameMap };

function rememberedNames(cluster: Cluster): NameMap {
  g.__bxNames ??= new Map();
  for (const [k, v] of namesFrom(readRoundFile(cluster))) g.__bxNames.set(k, v);
  return g.__bxNames;
}

export async function fetchHall(cluster: Cluster, base: string): Promise<HallResponse> {
  return fetchHallRows(cluster, base, rememberedNames(cluster));
}
