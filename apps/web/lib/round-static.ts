/**
 * The round a static build shows, without a server.
 *
 * Three layers, in order of precedence:
 *  1. `NEXT_PUBLIC_ROUND` — a round address (or a whole JSON object), inlined at
 *     build time. Set it in CI to point the site at a specific round.
 *  2. `lib/generated/round.json` — the public half of `.mb/round-<cluster>.json`,
 *     baked by `scripts/bake-round.mjs` (names and addresses, never a key).
 *  3. Chain discovery — the Round PDAs after the baked round id are probed on
 *     the base RPC at page load, so a round created after the site was built
 *     still shows up. See `discoverRound`.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ENDPOINTS } from "@blackbox/sdk/src/constants";
import type { Cluster, PublicBacker, PublicEntrant, PublicLicenseRecord, PublicRoundInfo } from "./api-types";
import { decodeAccount, roundPda, toRoundView, type RoundView } from "./chain";
import baked from "./generated/round.json";
import { rpcConnection } from "./rpc";

export interface BakedRound {
  cluster: string;
  roundId: number | null;
  round: string | null;
  mint: string | null;
  feeds: string[];
  markets: string[];
  tickMs: number | null;
  durationTicks: number | null;
  mode: string | null;
  phase: string | null;
  registrationEndsAt: number | null;
  startedAt: number | null;
  updatedAt: number | null;
  entrants: { name: string; owner: string; bot: boolean; external: boolean }[];
  entrantOwners: string[];
  backers: PublicBacker[];
  licenses: PublicLicenseRecord[];
  bakedAt: number;
}

const BAKED = baked as BakedRound;

function envCluster(): Cluster {
  return process.env.NEXT_PUBLIC_CLUSTER === "devnet" ? "devnet" : process.env.NEXT_PUBLIC_CLUSTER === "local" ? "local" : BAKED.cluster === "local" ? "local" : "devnet";
}

/** `NEXT_PUBLIC_ROUND`: either a base58 round address or a JSON object of the baked shape. */
function envRound(): Partial<BakedRound> | null {
  const v = process.env.NEXT_PUBLIC_ROUND;
  if (!v) return null;
  if (v.trim().startsWith("{")) {
    try {
      return JSON.parse(v) as BakedRound;
    } catch {
      return null;
    }
  }
  const id = Number(process.env.NEXT_PUBLIC_ROUND_ID);
  return { round: v.trim(), roundId: Number.isFinite(id) ? id : null };
}

/** The round info a static page starts from, before any chain read. */
export function staticRoundInfo(): PublicRoundInfo {
  const cluster = envCluster();
  const env = envRound();
  // An env round address replaces the baked round; its names only apply to the baked one.
  const sameRound = !env?.round || env.round === BAKED.round;
  const r: Partial<BakedRound> = sameRound ? { ...BAKED, ...env } : { ...env };
  const ep = ENDPOINTS[cluster];
  const entrants: PublicEntrant[] = (r.entrants ?? []).map((e) => ({ name: e.name, owner: e.owner, bot: e.bot, external: e.external, canActAs: false }));
  return {
    cluster,
    source: r.round ? (env?.round ? "env" : "file") : "none",
    roundId: r.roundId ?? null,
    round: r.round ?? null,
    mint: r.mint ?? null,
    feeds: r.feeds ?? [],
    markets: r.markets?.length ? r.markets : ["SOL-PERP", "BTC-PERP", "ETH-PERP"],
    tickMs: r.tickMs ?? null,
    durationTicks: r.durationTicks ?? null,
    mode: r.mode === "dark" ? "dark" : r.mode === "lit" ? "lit" : null,
    phase: r.phase ?? null,
    registrationEndsAt: r.registrationEndsAt ?? null,
    startedAt: r.startedAt ?? null,
    updatedAt: r.updatedAt ?? null,
    entrants,
    entrantOwners: r.entrantOwners ?? [],
    backers: r.backers ?? [],
    licenses: r.licenses ?? [],
    endpoints: {
      base: process.env.NEXT_PUBLIC_BASE_RPC ?? ep.base,
      tee: process.env.NEXT_PUBLIC_TEE_RPC ?? ep.tee,
    },
    // No indexer on a static site unless one is published: useHistory falls back
    // to sampling the chain itself when this is empty.
    indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? "",
    localRoutes: false,
  };
}

/** How many Round PDAs after the baked one to probe. One getMultipleAccounts call. */
const LOOKAHEAD = 8;

export interface Discovered {
  roundId: number;
  round: string;
  view: RoundView;
}

/**
 * Look for a round newer than the baked one. Round PDAs are seeds
 * ["round", u32 id], so the ids after the baked one can be derived and read in
 * a single batch. Returns the newest round that decodes, or null.
 */
export async function discoverRound(base: string, fromId: number, lookahead = LOOKAHEAD): Promise<Discovered | null> {
  const ids = Array.from({ length: lookahead }, (_, i) => fromId + 1 + i);
  const conn = rpcConnection(base, { commitment: "confirmed" });
  const infos = await conn.getMultipleAccountsInfo(ids.map(roundPda), "confirmed");
  for (let i = infos.length - 1; i >= 0; i--) {
    const acc = infos[i];
    if (!acc) continue;
    try {
      const view = toRoundView(decodeAccount("round", acc.data));
      return { roundId: ids[i], round: roundPda(ids[i]).toBase58(), view };
    } catch {
      // A round from another program build: keep looking at older ids.
    }
  }
  return null;
}

/** The baked info with a discovered round swapped in (names are dropped: they belong to the baked round). */
export function withDiscovered(info: PublicRoundInfo, found: Discovered): PublicRoundInfo {
  if (found.round === info.round) return info;
  return {
    ...info,
    source: "chain",
    roundId: found.roundId,
    round: found.round,
    mint: found.view.mint,
    phase: found.view.status,
    mode: found.view.mode,
    tickMs: found.view.tickIntervalMs || info.tickMs,
    durationTicks: found.view.durationTicks || info.durationTicks,
    registrationEndsAt: null,
    startedAt: found.view.startedAt ? found.view.startedAt * 1000 : null,
    updatedAt: Date.now(),
    entrants: [],
    entrantOwners: [],
    backers: [],
    licenses: [],
  };
}

export const bakedRound = BAKED;
export const PublicKeyOrNull = (v: string | null): PublicKey | null => {
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
};
