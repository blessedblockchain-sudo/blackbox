import { PublicKey } from "@solana/web3.js";
import { json, localRoutesEnabled } from "../../../lib/server/guard";
import { currentCluster, readRoundFile } from "../../../lib/server/round-file";
import { errorMessage } from "../../../lib/server/local";
import { ProofBusyError, runProof } from "../../../lib/server/proof";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Run the privacy matrix live against one entrant of the current round.
 * POST /api/proof { owner }
 * Owner and rival keys come from the local round file only when /api/local/* is
 * allowed (local cluster, loopback host); otherwise the control rows are skipped.
 */
export async function POST(req: Request) {
  let body: { owner?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected a JSON body { owner }" }, 400);
  }
  const cluster = currentCluster();
  const file = readRoundFile(cluster) ?? (process.env.NEXT_PUBLIC_ROUND ? { round: process.env.NEXT_PUBLIC_ROUND } : null);
  if (!file?.round) return json({ error: "no round is configured" }, 404);
  let target: PublicKey;
  try {
    target = new PublicKey(String(body.owner ?? ""));
  } catch {
    return json({ error: "owner is not a public key" }, 400);
  }
  const known = [...(file.entrants ?? []), ...(file.external ?? [])].map((e) => e.owner).concat(file.entrantOwners ?? []);
  if (known.length && !known.includes(target.toBase58())) return json({ error: "owner is not an entrant of the current round" }, 404);
  try {
    return json(await runProof(cluster, file, target, localRoutesEnabled(req)));
  } catch (e) {
    return json({ error: errorMessage(e) }, e instanceof ProofBusyError ? 429 : 502);
  }
}
