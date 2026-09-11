# Brief: MCP server (`packages/mcp-server`)

Own `packages/mcp-server`. Build the BLACKBOX MCP server with `@modelcontextprotocol/sdk` (`McpServer` + zod tool schemas). Stdio transport by default; `--http <port>` serves streamable HTTP. It lets an AI agent enter a BLACKBOX round, author strategies in BXL, and trade privately.

## Config (env)
- `BLACKBOX_CLUSTER` local|devnet (default local).
- `BLACKBOX_KEYPAIR` path to the agent's keypair JSON. If unset and `BLACKBOX_AGENT_NAME` is set, create or reuse `.mb/agents/<name>.json`.
- `BLACKBOX_ROUND_FILE` (default `.mb/round-<cluster>.json` at the repo root).
- `BLACKBOX_FAUCET_KEYPAIR` optional admin keypair used on local to send SOL and mint test USDC to the agent. The admin is `~/.config/solana/id.json` and is the mint authority of the round's mint.

## Tools
Each tool returns concise text plus structured JSON. Include explorer links (`client.explorerTx`) whenever a transaction is sent.
- `get_round`: phase, tick/duration, time left, markets with mark/ema8/ema21/vol, pot, mode, the caller's status (joined, funded, alive), scoreboard top N (public equity only).
- `get_market_history {market, n<=64}`: recent marks from the Market ring buffer.
- `compile_strategy {source}`: BXL compile via `@blackbox/compiler`; returns listing, errors, maxSteps, size.
- `simulate_strategy {source, market_history?}`: backtest on the markets' ring buffers (or supplied series) with `simulate()`.
- `join_round`: only while phase is `registration`. Uses the faucet on local if the agent lacks SOL/USDC. Calls `client.join` + `client.delegateEntrant`, then appends `{name, owner, bot:false}` to the round file's `external` array (read-modify-write).
- `enter_round {source, margin_usdc}`: after the round is delegated but before it is live: `depositToEr`, `waitErBalance`, `privatize`, `setStrategy`, `fund`.
- `hot_swap_strategy {source}`: compile and `setStrategy` while live. Return the new version and tx link.
- `read_my_position`: authenticated TEE read (legs, margin, realized PnL, equity estimate from current marks, last fault).
- `read_my_strategy`: authenticated read; version and disassembly listing.
- `read_scoreboard`: public scoreboard with ranks by equity.
- `privacy_check`: shows that a random wallet's TEE token cannot read the caller's strategy (returns null) while the caller can.

Add a README section in the package (`packages/mcp-server/README.md`) with a Claude Code `.mcp.json` snippet. Also write `.mcp.json.example` at the package root. Test by spawning the server over stdio with the SDK's `Client` + `StdioClientTransport` in `test/mcp.test.ts`, listing tools, and calling `get_round`, `compile_strategy`, `read_scoreboard` against the live local round.
