/**
 * The three public reads the app needs, in whichever way this build can do them.
 *
 * | read   | server mode                | static mode                                   |
 * |--------|----------------------------|-----------------------------------------------|
 * | round  | GET /api/round             | build-time config + a Round PDA probe on L1    |
 * | hall   | GET /api/hall              | program.account.hall.all() from the browser    |
 * | proof  | POST /api/proof            | the read matrix, run in the tab (proof-matrix) |
 *
 * `STATIC` is inlined at build time, so only one branch survives in each bundle.
 */
import { PublicKey } from "@solana/web3.js";
import { BASE_PATH, STATIC } from "./config";
import type { Cluster, HallResponse, ProofResponse, PublicRoundInfo } from "./api-types";
import { fetchHallRows, type NameMap } from "./hall";
import { discoverRound, staticRoundInfo, withDiscovered } from "./round-static";
import { runBrowserProof, type WalletIdentity } from "./proof-matrix";

const api = (path: string) => `${BASE_PATH}${path}`;

// ------------------------------------------------------------------ round

/** Chain discovery is done once per page load and shared by every hook. */
let discovery: Promise<PublicRoundInfo> | null = null;

function staticRound(): Promise<PublicRoundInfo> {
  discovery ??= (async () => {
    const base = staticRoundInfo();
    if (base.roundId === null) return base;
    try {
      const found = await discoverRound(base.endpoints.base, base.roundId);
      return found ? withDiscovered(base, found) : base;
    } catch {
      return base; // RPC down or rate-limited: the baked round still renders
    }
  })();
  return discovery;
}

/** The round this page should show. In static mode the first value is synchronous. */
export function initialRoundInfo(): PublicRoundInfo | null {
  return STATIC ? staticRoundInfo() : null;
}

export async function loadRoundInfo(): Promise<PublicRoundInfo> {
  if (STATIC) return staticRound();
  const res = await fetch(api("/api/round"), { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/round ${res.status}`);
  return (await res.json()) as PublicRoundInfo;
}

// ------------------------------------------------------------------ hall

export async function loadHall(cluster: Cluster, base: string, names: NameMap): Promise<HallResponse> {
  if (STATIC) return fetchHallRows(cluster, base, names);
  const res = await fetch(api("/api/hall"), { cache: "no-store" });
  const body = (await res.json()) as HallResponse | { error: string };
  if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
  return body;
}

// ------------------------------------------------------------------ proof

export interface ProofArgs {
  info: PublicRoundInfo;
  target: string;
  targetName: string;
  wallet: WalletIdentity | null;
}

export async function runProof({ info, target, targetName, wallet }: ProofArgs): Promise<ProofResponse> {
  if (!info.round) throw new Error("no round is configured");
  if (STATIC) {
    return runBrowserProof({
      cluster: info.cluster,
      base: info.endpoints.base,
      tee: info.endpoints.tee,
      round: new PublicKey(info.round),
      target: new PublicKey(target),
      targetName,
      wallet,
    });
  }
  const res = await fetch(api("/api/proof"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: target }) });
  const body = (await res.json()) as ProofResponse | { error: string };
  if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
  return body;
}
