import { PublicKey } from "@solana/web3.js";
import { json, localGuard } from "../../../../lib/server/guard";
import { clientFor, errorMessage, roundFileOrThrow } from "../../../../lib/server/local";
import { BACKER_NAME, ensureSol, loadAdmin, loadOrCreateBacker } from "../../../../lib/server/backer";
import { chatTextError, toRoundView } from "../../../../lib/chain";
import { erTxExplorer } from "../../../../lib/explorer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Who posts from this page on a local round: the server-held web backer. */
export async function GET(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  try {
    return json({ author: loadOrCreateBacker().kp.publicKey.toBase58(), name: BACKER_NAME });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

/**
 * Post to the round chat as the local web backer: post_chat on the rollup (the
 * first post creates the ephemeral chat account, sponsored by the Round).
 * POST /api/local/chat { text }
 */
export async function POST(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected a JSON body { text }" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : "";
  const invalid = chatTextError(text);
  if (invalid) return json({ error: invalid }, 400);
  try {
    const file = roundFileOrThrow();
    const round = new PublicKey(file.round!);
    const { kp } = loadOrCreateBacker();
    const bx = clientFor(kp);
    const r = await bx.fetchRound(round);
    const status = r ? toRoundView(r).status : null;
    if (status !== "open" && status !== "live") return json({ error: `the chat takes posts while the round is open or live (it is ${status ?? "not visible"})` }, 409);
    await ensureSol(bx, kp.publicKey, loadAdmin(), 0.05);
    const sig = await bx.postChat(round, kp, text);
    return json({ sig, explorer: erTxExplorer(sig, "local", process.env.NEXT_PUBLIC_TEE_RPC), author: kp.publicKey.toBase58() });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}
