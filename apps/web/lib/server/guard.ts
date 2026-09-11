/**
 * Guard for the dev-only /api/local/* routes: they serve only a local-cluster
 * round, only to loopback hosts, and can be switched off with
 * BLACKBOX_DISABLE_LOCAL_ROUTES=1.
 */
import { currentCluster, readRoundFile } from "./round-file";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function hostIsLoopback(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  return LOOPBACK.has(host.toLowerCase());
}

/** True when this request may use /api/local/*. */
export function localRoutesEnabled(req: Request): boolean {
  if (process.env.BLACKBOX_DISABLE_LOCAL_ROUTES === "1") return false;
  if (currentCluster() !== "local") return false;
  const file = readRoundFile("local");
  if (!file || (file.cluster && file.cluster !== "local")) return false;
  return hostIsLoopback(req.headers.get("host"));
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function localGuard(req: Request): Response | null {
  if (localRoutesEnabled(req)) return null;
  return json({ error: "local routes are available only for a local-cluster round on a loopback host" }, 403);
}
