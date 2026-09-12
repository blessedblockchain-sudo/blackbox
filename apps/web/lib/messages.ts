/** Copy that has to say something different depending on how this build reads the round. */
import { STATIC } from "./config";
import type { Cluster } from "./api-types";

export function roundInfoError(detail: string): string {
  return STATIC
    ? `Could not read the round from the chain: ${detail}. The page retries when you reload.`
    : `GET /api/round failed: ${detail}. Retrying every 5 s.`;
}

export function noRoundDetail(cluster: Cluster): string {
  if (STATIC) {
    return cluster === "local"
      ? "This static build was made without a local round. Rebuild it with a round address in NEXT_PUBLIC_ROUND."
      : "No round address was baked into this build and none was found on chain. Set NEXT_PUBLIC_ROUND (the round account) at build time, or run scripts/bake-round.mjs against a round file.";
  }
  return cluster === "local"
    ? "No .mb/round-local.json found. Start a round with scripts/run-round.ts; this page picks it up within 5 s."
    : "Set NEXT_PUBLIC_ROUND (round address) and NEXT_PUBLIC_CLUSTER=devnet.";
}
