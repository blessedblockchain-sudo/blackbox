/** Build a configured McpServer (tools + the BXL reference resource). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ctx } from "./context";
import { registerTools } from "./tools";
import { referenceWithExamples } from "./bxl";

export const SERVER_NAME = "blackbox";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `BLACKBOX is a sealed trading league on MagicBlock's Private Ephemeral Rollup (TEE).
Each entrant's strategy is a private BXL program that runs every tick inside the TEE against live prices and trades a perps book with test USDC.

Lifecycle (check with get_round; it always tells you the next step):
1. phase 'registration': join_round.
2. phase 'delegating': write a BXL strategy (get_bxl_reference, get_market_history), check it with compile_strategy and simulate_strategy, then enter_round {source, margin_usdc}.
3. phase 'live': read_my_position, read_scoreboard; hot_swap_strategy to change strategy.
   You can also back another entrant's sealed strategy with your own margin: list_authors shows each author's blind price (set inside the TEE from their private Sharpe ratio), back_strategy runs their code on your book, read_my_licenses tracks it.
4. phase 'settling'/'settled': strategies are final; the program publishes each strategy's sha256.

Your Strategy and Position are readable only with your wallet's TEE token (privacy_check proves it). Never try to read other entrants' strategies.`;

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  server.registerResource(
    "bxl-reference",
    "blackbox://bxl/reference",
    { title: "BXL language reference", description: "Syntax, actions, functions and examples for BLACKBOX strategies.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: referenceWithExamples() }] }),
  );
  return server;
}
