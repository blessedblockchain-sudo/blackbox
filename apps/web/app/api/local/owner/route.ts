import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { pda } from "@blackbox/sdk";
import { json, localGuard } from "../../../../lib/server/guard";
import { clientFor, errorMessage, ownerKeypair, roundFileOrThrow } from "../../../../lib/server/local";
import { toPositionView, toStrategyView } from "../../../../lib/chain";
import { b64encode, type OwnerReadResponse, type ReadRequest } from "../../../../lib/api-types";
import { redactToken } from "../../../../lib/tee-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Authenticated read as the owner: the server signs the TEE challenge with the
 * bot key from the round file, reads the private Strategy and Position, and
 * returns decoded views. The key and the token stay on the server.
 *
 * GET /api/local/owner?owner=<pubkey>&what=strategy,position
 */
export async function GET(req: Request) {
  const denied = localGuard(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") ?? "";
  const what = new Set((url.searchParams.get("what") ?? "strategy,position").split(","));
  try {
    const file = roundFileOrThrow();
    const kp = ownerKeypair(file, owner);
    if (!kp) return json({ error: `no local key for ${owner || "(missing owner)"}` }, 404);
    const round = new PublicKey(file.round!);
    const bx = clientFor(kp);
    const conn = await bx.tee(kp);
    const endpoint = redactToken(conn.rpcEndpoint);
    const requests: ReadRequest[] = [];
    const read = async (label: string, key: PublicKey) => {
      const t0 = performance.now();
      const info = await conn.getAccountInfo(key, "processed");
      requests.push({
        label,
        method: "getAccountInfo",
        endpoint,
        account: key.toBase58(),
        ms: Math.round(performance.now() - t0),
        found: !!info,
        bytes: info?.data.length ?? 0,
        owner: info?.owner.toBase58() ?? null,
      });
      return info;
    };
    const out: OwnerReadResponse = { owner, round: round.toBase58(), strategy: null, position: null, requests };
    if (what.has("strategy")) {
      const info = await read("Strategy (owner token)", pda.strategyPda(round, kp.publicKey));
      if (info) {
        const s = toStrategyView(bx.program.coder.accounts.decode("strategy", info.data));
        const { bytecode, ...rest } = s;
        out.strategy = { ...rest, bytecodeB64: b64encode(bytecode), sha256: createHash("sha256").update(bytecode).digest("hex") };
      }
    }
    if (what.has("position")) {
      const info = await read("Position (owner token)", pda.positionPda(round, kp.publicKey));
      if (info) out.position = toPositionView(bx.program.coder.accounts.decode("position", info.data));
    }
    return json(out);
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}
