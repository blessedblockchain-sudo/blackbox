/**
 * Test double for packages/mcp-server: same tool names and argument shapes,
 * canned state, stdio transport. Phase comes from BLACKBOX_ROUND_FILE; every
 * call is appended to FAKE_MCP_LOG as a JSON line so tests can assert order.
 * Position equity drops below margin from the second read, which is what the
 * scripted agent's hot-swap rule reacts to.
 */
import * as fs from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROUND_FILE = process.env.BLACKBOX_ROUND_FILE!;
const LOG = process.env.FAKE_MCP_LOG;
const SCHEMA = "http://json-schema.org/draft-07/schema#";
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false, $schema: SCHEMA });

const TOOLS = [
  { name: "get_round", description: "Round phase, tick, markets, your status, top of the scoreboard.", inputSchema: obj({}) },
  { name: "get_market_history", description: "Recent marks for one market.", inputSchema: obj({ market: { type: "string", enum: ["SOL-PERP", "BTC-PERP", "ETH-PERP"] }, n: { type: "integer", minimum: 1, maximum: 64, default: 64 } }, ["market"]) },
  { name: "compile_strategy", description: "Compile BXL.", inputSchema: obj({ source: { type: "string" } }, ["source"]) },
  { name: "simulate_strategy", description: "Backtest BXL.", inputSchema: obj({ source: { type: "string" }, market_history: { type: "array", items: { type: "array", items: { type: "number" } } } }, ["source"]) },
  { name: "join_round", description: "Join during registration.", inputSchema: obj({}) },
  { name: "enter_round", description: "Deposit, privatize, upload, fund.", inputSchema: obj({ source: { type: "string" }, margin_usdc: { type: "number", exclusiveMinimum: 0 } }, ["source", "margin_usdc"]) },
  { name: "hot_swap_strategy", description: "Replace the live strategy.", inputSchema: obj({ source: { type: "string" } }, ["source"]) },
  { name: "read_my_position", description: "Your private position.", inputSchema: obj({}) },
  { name: "read_my_strategy", description: "Your private strategy.", inputSchema: obj({}) },
  { name: "read_scoreboard", description: "Public scoreboard.", inputSchema: obj({}) },
  { name: "privacy_check", description: "Show a stranger cannot read your strategy.", inputSchema: obj({}) },
];

const state = { joined: false, funded: false, margin: 0, version: 0, reads: 0, tick: 100, owner: "FakeOwner1111111111111111111111111111111111" };
let sigN = 0;
const tx = (label: string) => `https://explorer.solana.com/tx/${label}${++sigN}?cluster=custom`;
const phase = (): string => JSON.parse(fs.readFileSync(ROUND_FILE, "utf8")).phase;
const ok = (text: string, structured: Record<string, unknown>) => ({ content: [{ type: "text", text }], structuredContent: structured });
const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });

function handle(name: string, args: Record<string, unknown>) {
  const p = phase();
  state.tick += 7;
  switch (name) {
    case "get_round":
      return ok(`Round #7 ${p}, tick ${state.tick}/7200. You: joined ${state.joined}, funded ${state.funded}.`, { phase: p, tick: state.tick, durationTicks: 7200, markets: [{ name: "SOL-PERP", mark: 150.1 }], you: { joined: state.joined, funded: state.funded, alive: true, owner: state.owner }, top: [{ owner: "Other", equity: 210 }] });
    case "get_market_history":
      return ok(`${args.market}: 64 marks`, { market: args.market, marks: Array.from({ length: Number(args.n ?? 64) }, (_, i) => 150 + Math.sin(i / 5)) });
    case "compile_strategy": {
      const src = String(args.source ?? "");
      if (!/long\(|short\(|close\(/.test(src)) return ok("Compile failed: 1:1 no actions", { ok: false, errors: [{ line: 1, col: 1, message: "no actions" }] });
      return ok(`Compiled: ${src.length} chars, maxSteps 42`, { ok: true, errors: [], maxSteps: 42, size: 60, listing: "0000 ema 0 0" });
    }
    case "simulate_strategy":
      return ok("Backtest: final equity 101.2, drawdown 1.1%, sharpe 0.8, 3 trades", { finalEquity: 101.2, maxDrawdown: 0.011, sharpe: 0.8, trades: 3, liquidated: false, faults: [] });
    case "join_round":
      if (p !== "registration") return fail(`join_round is only possible during registration (phase ${p})`);
      state.joined = true;
      return ok(`Joined. join ${tx("join")}`, { joined: true, owner: state.owner, txs: [tx("delegate")] });
    case "enter_round":
      if (p !== "delegating") return fail(`enter_round needs phase delegating (phase ${p})`);
      if (!state.joined) return fail("not joined");
      state.funded = true;
      state.margin = Number(args.margin_usdc);
      state.version = 1;
      return ok(`Entered with version 1, margin ${state.margin} USDC. ${tx("fund")}`, { version: 1, margin: state.margin });
    case "hot_swap_strategy":
      if (p !== "live") return fail(`hot_swap_strategy needs phase live (phase ${p})`);
      state.version++;
      return ok(`Strategy replaced: version ${state.version}. ${tx("swap")}`, { version: state.version, tx: tx("swapx") });
    case "read_my_position": {
      state.reads++;
      const equity = state.reads <= 1 ? state.margin : state.margin * 0.95;
      return ok(`Margin ${state.margin} USDC, equity ${equity.toFixed(2)} USDC, 1 leg`, { position: { margin: state.margin, equity, realizedPnl: 0, legs: [{ market: "SOL-PERP", side: "long", size: 600 }], lastFault: null } });
    }
    case "read_my_strategy":
      return ok(`Version ${state.version}`, { version: state.version, listing: "..." });
    case "read_scoreboard":
      return ok("1. Other 210.00\n2. You 95.00", { entries: [{ rank: 1, owner: "Other", equity: 210 }, { rank: 2, owner: state.owner, equity: 95 }] });
    case "privacy_check":
      return ok("stranger read: null; owner read: ok", { strangerCanRead: false, ownerCanRead: true });
    default:
      return fail(`unknown tool ${name}`);
  }
}

async function main() {
  const server = new Server({ name: "fake-blackbox", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ tool: req.params.name, args, phase: phase() }) + "\n");
    return handle(req.params.name, args) as never;
  });
  process.stderr.write(`fake server for ${process.env.BLACKBOX_AGENT_NAME}\n`);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
