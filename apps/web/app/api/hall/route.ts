import { currentCluster, publicRoundInfo } from "../../../lib/server/round-file";
import { json } from "../../../lib/server/guard";
import { fetchHall } from "../../../lib/server/hall";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Hall of Fame: every L1 Hall account, sorted by ELO. Public data. */
export async function GET() {
  const cluster = currentCluster();
  const base = publicRoundInfo(cluster, false).endpoints.base;
  try {
    return json(await fetchHall(cluster, base));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `getProgramAccounts on ${base} failed: ${msg.slice(0, 300)}` }, 502);
  }
}
