import { publicEntrants, readRoundFile } from "../../../../lib/server/round-file";
import { json, localGuard } from "../../../../lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Identities the local server can act as (names and public keys only). */
export async function GET(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  const file = readRoundFile("local");
  if (!file) return json({ error: "no local round file" }, 404);
  return json({ round: file.round ?? null, identities: publicEntrants(file).filter((e) => e.canActAs) });
}
