/**
 * BLACKBOX MCP server entry point.
 *
 *   node packages/mcp-server/bin/blackbox-mcp.js              # stdio (default)
 *   node packages/mcp-server/bin/blackbox-mcp.js --http 8765  # streamable HTTP on 127.0.0.1:8765/mcp
 *
 * See README.md for environment variables.
 */
import { randomUUID } from "crypto";
import * as http from "http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { readConfig } from "./config";
import { Ctx } from "./context";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

export { createServer } from "./server";
export { Ctx } from "./context";
export { readConfig } from "./config";

interface Args {
  http: number | null;
  host: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { http: null, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--http" || a.startsWith("--http=")) {
      out.http = Number(val());
      if (!Number.isInteger(out.http) || out.http <= 0 || out.http > 65535) throw new Error("--http needs a port number");
    } else if (a === "--host" || a.startsWith("--host=")) out.host = val();
    else if (a === "--help" || a === "-h") {
      process.stderr.write("usage: blackbox-mcp [--http <port>] [--host <addr>]\n");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const log = (...a: unknown[]) => process.stderr.write(`[blackbox-mcp] ${a.join(" ")}\n`);

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Streamable HTTP with one McpServer per session, all sharing the same wallet context. */
export async function serveHttp(ctx: Ctx, port: number, host: string): Promise<http.Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, wallet: ctx.me.toBase58() });
      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found; the MCP endpoint is /mcp" });
      // DNS-rebinding guard when bound to loopback.
      if (loopback) {
        const h = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!["127.0.0.1", "localhost", "[::1]"].includes(h)) return sendJson(res, 403, { error: "forbidden host" });
      }
      const sid = req.headers["mcp-session-id"] as string | undefined;
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid || req.method !== "POST" || !isInitializeRequest(body)) {
          return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad request: unknown session or not an initialize request" }, id: null });
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await createServer(ctx).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("http error:", String((e as Error)?.message ?? e));
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  await new Promise<void>((resolve) => srv.listen(port, host, resolve));
  return srv;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  // stdout carries the JSON-RPC stream in stdio mode: route stray logs to stderr.
  console.log = (...a: unknown[]) => console.error(...a);
  const cfg = readConfig();
  const ctx = new Ctx(cfg);
  log(`${SERVER_NAME} ${SERVER_VERSION} cluster=${cfg.cluster} wallet=${ctx.me.toBase58()}${cfg.keypairCreated ? " (new)" : ""} keypair=${cfg.keypairPath} round-file=${cfg.roundFile}${cfg.faucetPath ? ` faucet=${cfg.faucetPath}` : ""}`);
  if (args.http) {
    await serveHttp(ctx, args.http, args.host);
    log(`streamable HTTP on http://${args.host}:${args.http}/mcp`);
    return;
  }
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) {
  main().catch((e) => {
    log("fatal:", String((e as Error)?.stack ?? e));
    process.exit(1);
  });
}
