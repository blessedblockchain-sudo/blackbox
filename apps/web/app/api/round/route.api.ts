import { currentCluster, publicRoundInfo } from "../../../lib/server/round-file";
import { json, localRoutesEnabled } from "../../../lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public round info: the round file minus every secret, or env config on devnet. */
export async function GET(req: Request) {
  return json(publicRoundInfo(currentCluster(), localRoutesEnabled(req)));
}
