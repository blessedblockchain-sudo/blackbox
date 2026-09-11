/** Shared helpers: spawn the MCP server over stdio or HTTP and call tools. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ROOT = path.resolve(__dirname, "../../..");
export const BIN = path.resolve(__dirname, "../bin/blackbox-mcp.js");
export const ROUND_FILE = process.env.BLACKBOX_ROUND_FILE || path.join(ROOT, ".mb/round-local.json");

export function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `blackbox-mcp-${tag}-`));
}

function childEnv(env: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("TS_NODE_")) base[k] = v;
  return { ...base, BLACKBOX_CLUSTER: "local", BLACKBOX_ROUND_FILE: ROUND_FILE, ...env };
}

export interface Session {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

export async function connectStdio(env: Record<string, string>): Promise<Session> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: childEnv(env), stderr: "pipe", cwd: ROOT });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: "blackbox-mcp-test", version: "0.0.1" });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`connect failed: ${(e as Error).message}\nserver stderr:\n${err}`);
  }
  return { client, stderr: () => err, close: () => client.close() };
}

export async function connectHttp(env: Record<string, string>, port: number): Promise<Session & { proc: ChildProcess }> {
  const proc = spawn(process.execPath, [BIN, "--http", String(port)], { env: childEnv(env), cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HTTP server did not start:\n${err}`)), 30_000);
    proc.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.includes("streamable HTTP on")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`HTTP server exited ${code}:\n${err}`));
    });
  });
  const client = new Client({ name: "blackbox-mcp-http-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    proc,
    stderr: () => err,
    close: async () => {
      await client.close().catch(() => {});
      proc.kill("SIGTERM");
    },
  };
}

export interface ToolOut {
  isError: boolean;
  text: string;
  data: any;
}

export async function call(s: Session, name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<ToolOut> {
  const res: any = await s.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true });
  const texts = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text as string);
  return { isError: !!res.isError, text: texts[0] ?? "", data: res.structuredContent ?? null };
}

export function readRound(): any | null {
  try {
    return JSON.parse(fs.readFileSync(ROUND_FILE, "utf8"));
  } catch {
    return null;
  }
}

export const MOMENTUM_BXL = `# EMA trend follower on SOL
if ema(SOL, 8) > ema(SOL, 21) {
  if pos(SOL) <= 0 {
    long(SOL, 30%)
  }
} else {
  if pos(SOL) >= 0 {
    short(SOL, 30%)
  }
}
`;

export const REVERSION_BXL = `# fade 8-tick moves on SOL
let r = ret(SOL, 8)
if r < -0.08% {
  if pos(SOL) <= 0 {
    long(SOL, 20%)
  }
} elif r > 0.08% {
  if pos(SOL) >= 0 {
    short(SOL, 20%)
  }
}
`;

/** True when the compiler package is still the stub (or otherwise throws). */
export function compilerMissing(o: ToolOut): boolean {
  return o.isError && /compiler failed|not implemented/i.test(o.text);
}
