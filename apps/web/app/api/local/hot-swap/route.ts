import { PublicKey } from "@solana/web3.js";
import { validate, MAX_BYTECODE_LEN } from "@blackbox/sdk";
import { json, localGuard } from "../../../../lib/server/guard";
import { clientFor, errorMessage, ownerKeypair, roundFileOrThrow } from "../../../../lib/server/local";
import { b64decode, type HotSwapResponse } from "../../../../lib/api-types";
import { erTxExplorer } from "../../../../lib/explorer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Hot-swap as a local identity: `set_strategy` on the ER, signed server-side.
 * POST /api/local/hot-swap  { owner, bytecode: base64 }
 */
export async function POST(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  let body: { owner?: string; bytecode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected a JSON body { owner, bytecode }" }, 400);
  }
  try {
    const file = roundFileOrThrow();
    const kp = ownerKeypair(file, body.owner ?? "");
    if (!kp) return json({ error: `no local key for ${body.owner || "(missing owner)"}` }, 404);
    const bytes = b64decode(body.bytecode ?? "");
    if (bytes.length === 0 || bytes.length > MAX_BYTECODE_LEN) return json({ error: `bytecode must be 1..${MAX_BYTECODE_LEN} bytes` }, 400);
    const nMarkets = file.markets?.length ?? file.feeds?.length ?? 3;
    const invalid = validate(bytes, nMarkets);
    if (invalid) return json({ error: `bytecode rejected by validator: ${invalid}` }, 400);
    const round = new PublicKey(file.round!);
    const bx = clientFor(kp);
    const sig = await bx.setStrategy(round, kp, bytes);
    let version: number | null = null;
    try {
      const s = await bx.fetchStrategy(round, kp);
      version = s ? Number(s.version) : null;
    } catch {
      /* the swap landed; the read-back is best effort */
    }
    const out: HotSwapResponse = { sig, explorer: erTxExplorer(sig, "local"), version, len: bytes.length };
    return json(out);
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}
