/**
 * One BLACKBOX MCP server process per agent, spawned over stdio with its own
 * BLACKBOX_AGENT_NAME / keypair.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpResultToText, type McpCallResult } from "./bridge";
import { repoRoot } from "./round";
import type { ToolOutcome, ToolSpec } from "./types";

export interface ServerOptions {
  agentName: string;
  cluster: string;
  roundFile: string;
  /** Explicit keypair path for the agent (BLACKBOX_KEYPAIR). */
  keypair?: string;
  /** Override the server command, e.g. ["node", "dist/index.js"]. Defaults to ts-node on packages/mcp-server. */
  command?: string[];
  /** Called with each stderr line of the server process. */
  onStderr?: (line: string) => void;
  /** Per-call timeout; enter_round waits on ER deposits, so the default is generous. */
  callTimeoutMs?: number;
}

const LLM_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** A ts-node binary: the workspace's, else the one on PATH. */
export function findTsNode(): string | null {
  const root = repoRoot();
  const candidates = [
    path.join(root, "node_modules/.bin/ts-node"),
    path.join(root, "packages/mcp-server/node_modules/.bin/ts-node"),
    onPath("ts-node"),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  return candidates[0] ?? null;
}

export const MCP_SERVER_ENTRY = path.join(repoRoot(), "packages/mcp-server/src/index.ts");
/** The server's own launcher (in-process TypeScript transpile, no ts-node needed). */
export const MCP_SERVER_LAUNCHER = path.join(repoRoot(), "packages/mcp-server/bin/blackbox-mcp.js");

/**
 * Resolve how to launch the MCP server: explicit override, BLACKBOX_MCP_COMMAND,
 * the server's node launcher, else ts-node on its TypeScript entry.
 */
export function resolveServerCommand(override?: string[]): string[] {
  if (override && override.length) return override;
  const env = process.env.BLACKBOX_MCP_COMMAND;
  if (env && env.trim()) return env.trim().split(/\s+/);
  if (fs.existsSync(MCP_SERVER_LAUNCHER)) return [process.execPath, MCP_SERVER_LAUNCHER];
  const tsNode = findTsNode();
  if (!tsNode) throw new Error("ts-node not found; set BLACKBOX_MCP_COMMAND to the MCP server launch command");
  if (!fs.existsSync(MCP_SERVER_ENTRY)) throw new Error(`MCP server entry not found at ${MCP_SERVER_ENTRY}`);
  return [tsNode, "--transpile-only", MCP_SERVER_ENTRY];
}

export class AgentServer {
  readonly client: Client;
  private transport: StdioClientTransport;
  tools: ToolSpec[] = [];
  private closed = false;

  private constructor(client: Client, transport: StdioClientTransport, private readonly callTimeoutMs: number) {
    this.client = client;
    this.transport = transport;
  }

  static async start(o: ServerOptions): Promise<AgentServer> {
    const [command, ...args] = resolveServerCommand(o.command);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !LLM_KEYS.includes(k)) env[k] = v;
    env.BLACKBOX_CLUSTER = o.cluster;
    env.BLACKBOX_ROUND_FILE = path.resolve(o.roundFile);
    env.BLACKBOX_AGENT_NAME = o.agentName;
    if (o.keypair) env.BLACKBOX_KEYPAIR = path.resolve(o.keypair);
    else delete env.BLACKBOX_KEYPAIR;
    if (!env.BLACKBOX_FAUCET_KEYPAIR && o.cluster === "local") {
      const admin = path.join(os.homedir(), ".config/solana/id.json");
      if (fs.existsSync(admin)) env.BLACKBOX_FAUCET_KEYPAIR = admin;
    }
    const transport = new StdioClientTransport({ command, args, env, cwd: repoRoot(), stderr: "pipe" });
    const err = transport.stderr;
    if (err) {
      let buf = "";
      err.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line) o.onStderr?.(line);
        }
      });
    }
    const client = new Client({ name: `blackbox-agent-${o.agentName}`, version: "0.1.0" });
    await client.connect(transport, { timeout: 90_000 });
    const server = new AgentServer(client, transport, o.callTimeoutMs ?? 300_000);
    await server.refreshTools();
    return server;
  }

  async refreshTools(): Promise<ToolSpec[]> {
    const out: ToolSpec[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as ToolSpec["inputSchema"] });
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = out;
    return out;
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  /** Call an MCP tool; protocol errors come back as an error outcome instead of throwing. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      const res = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.callTimeoutMs, resetTimeoutOnProgress: true })) as McpCallResult;
      const structured = res.structuredContent && typeof res.structuredContent === "object" ? (res.structuredContent as Record<string, unknown>) : undefined;
      return { text: mcpResultToText(res), isError: !!res.isError, structured };
    } catch (e) {
      return { text: `ERROR: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => {});
  }
}
