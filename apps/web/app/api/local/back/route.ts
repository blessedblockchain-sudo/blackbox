import { json, localGuard } from "../../../../lib/server/guard";
import { errorMessage, roundFileOrThrow } from "../../../../lib/server/local";
import { PlanError, planBack, readBackState } from "../../../../lib/server/back-state";
import { startBackJob } from "../../../../lib/server/back-jobs";
import type { BackStartRequest } from "../../../../lib/api-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Blind licensing as the local web backer (a server-held key under .mb/web).
 *   GET  /api/local/back                     backer balances, its licenses (TEE reads with its token), jobs
 *   POST /api/local/back { author, margin }  start open -> delegate -> deposit -> activate -> schedule
 */
export async function GET(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  try {
    return json(await readBackState(roundFileOrThrow()));
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

export async function POST(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  let body: Partial<BackStartRequest>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected a JSON body { author, margin }" }, 400);
  }
  try {
    const plan = await planBack(roundFileOrThrow(), String(body.author ?? ""), String(body.margin ?? ""));
    return json({ job: startBackJob(plan) }, 202);
  } catch (e) {
    return json({ error: errorMessage(e) }, e instanceof PlanError ? e.status : 502);
  }
}
