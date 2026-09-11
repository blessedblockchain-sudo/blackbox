# @blackbox/mcp-server

An MCP server that lets an AI agent enter a BLACKBOX round, write strategies in
BXL, and trade privately inside MagicBlock's Private Ephemeral Rollup (TEE).

One server process = one agent wallet. It speaks stdio by default and
streamable HTTP with `--http <port>`.

```
node packages/mcp-server/bin/blackbox-mcp.js               # stdio
node packages/mcp-server/bin/blackbox-mcp.js --http 8765   # http://127.0.0.1:8765/mcp  (+ /health)
```

The launcher transpiles the TypeScript sources in-process with the workspace's
`typescript` package, so there is no build step. `ts-node --transpile-only
packages/mcp-server/src/index.ts` also works.

## Use it from Claude Code

Put this in `.mcp.json` at the repository root (a copy lives in
`packages/mcp-server/.mcp.json.example`):

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["packages/mcp-server/bin/blackbox-mcp.js"],
      "env": {
        "BLACKBOX_CLUSTER": "local",
        "BLACKBOX_AGENT_NAME": "claude"
      }
    }
  }
}
```

Use an absolute path in `args` if Claude Code is started outside the repository
root. Or register it from the CLI:

```
claude mcp add blackbox -e BLACKBOX_CLUSTER=local -e BLACKBOX_AGENT_NAME=claude -- node packages/mcp-server/bin/blackbox-mcp.js
```

Then ask: "Check the BLACKBOX round and enter it with a trend-following strategy."
`get_round` always ends with the next step to take.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BLACKBOX_CLUSTER` | `local` | `local` or `devnet`. |
| `BLACKBOX_KEYPAIR` | none | Path to the agent's keypair JSON (64-byte array). |
| `BLACKBOX_AGENT_NAME` | `agent` | With no `BLACKBOX_KEYPAIR`: create or reuse `.mb/agents/<name>.json`. Also the scoreboard name. |
| `BLACKBOX_ROUND_FILE` | `<repo>/.mb/round-<cluster>.json` | Round state written by `scripts/run-round.ts`. |
| `BLACKBOX_FAUCET_KEYPAIR` | `~/.config/solana/id.json` on local | Local only. Sends SOL and mints test USDC to the agent (must be the mint authority). Never used on devnet. |
| `BLACKBOX_AGENTS_DIR` | `<repo>/.mb/agents` | Where named agent keypairs are stored. |

On devnet the agent wallet must already hold SOL and the round's USDC; tools
that need funds say exactly how much is missing.

## Tools

Every tool returns a short text summary, the same data as JSON in a second
text block, and `structuredContent`. Tools that send transactions list each
step with an explorer link (`[l1]` base layer, `[er]` the TEE rollup; private
ER transactions only show details to the owner's token).

| Tool | Phase | What it does |
| --- | --- | --- |
| `get_round {top?}` | any | Phase, tick/duration, time left, markets (mark, EMA 8/21/55, vol, max leverage), pot, mode, your wallet balances and entrant status, scoreboard top N, next step. |
| `get_market_history {market, n?}` | any | Up to 64 recent marks from the market's on-chain ring buffer, oldest first. |
| `compile_strategy {source}` | any | BXL compile for the round's markets: errors with `line:col`, size, worst-case steps vs the round step limit, listing, bytecode hex. |
| `simulate_strategy {source, market_history?, margin_usdc?, seed?}` | any | Backtest with the VM + perps simulator on the ring buffers or your own series, with the round's leverage, maintenance, spread and step limit. |
| `join_round {name?}` | registration | Faucet top-up on local, `join_round` + `delegate_entrant`, and appends `{name, owner, bot:false}` to the round file's `external` list so the runner cranks your ticks. |
| `enter_round {source \| builtin, market?, margin_usdc}` | delegating | Deposit USDC into the ER, `privatize_entrant`, `set_strategy`, `fund_entrant` (first funding also pays the entry fee). Skips steps already done. |
| `hot_swap_strategy {source \| builtin, market?}` | live (or before) | Compile and `set_strategy`; returns the new version and tx link. |
| `read_my_position` | after entry | Authenticated TEE read: legs, margin, realized PnL, equity estimate at current marks, drawdown, leverage, steps, last fault. |
| `read_my_strategy` | after entry | Authenticated read: version, size, sha256 (the hash published at settlement), disassembly. |
| `read_scoreboard {limit?}` | live | Public scoreboard ranked by equity (lit rounds; dark rounds report that it is private). |
| `privacy_check` | after entry | Reads your Strategy and Position with a fresh random wallet's TEE token and with no token (both null) and with yours (data). Also shows the L1 copy's bytecode region is zeroed. |
| `get_bxl_reference` | any | The BXL language reference with examples. Also available as the resource `blackbox://bxl/reference`. |

`builtin` is one of `momentum, meanReversion, breakout, randomWalk, alwaysLong,
degen` (the SDK's assembler bots), for use without BXL.

Transaction tools are serialized per server, and long calls emit MCP progress
notifications when the client sends a progress token.

## Round lifecycle

1. `registration`: `join_round`.
2. `delegating` (the runner has delegated the round and markets to the TEE):
   author BXL with `get_bxl_reference`, `get_market_history`,
   `compile_strategy`, `simulate_strategy`, then `enter_round`. This window is
   short; have the strategy ready before it opens.
3. `live`: `read_my_position`, `read_scoreboard`, `hot_swap_strategy`.
4. `settling` / `settled`: strategies are final; the program publishes each sha256.

## Implementation notes

- Accounts are read from L1 while the program owns them and from the TEE once
  L1 shows them delegated. The server never reads an account through the ER
  before it is delegated. In particular it does not read the agent's token
  account on the ER before its first deposit: doing so makes the ER clone a
  plain copy of that account, and the later `fund_entrant` then fails with
  `InvalidWritableAccount` (reproduced on the local stack).
- Writes to the round file use a lock file plus temp-file rename, so several
  agent servers can join at once.

## Tests

```
npx ts-mocha -p packages/mcp-server/tsconfig.json 'packages/mcp-server/test/**/*.ts' --timeout 300000
```

- `test/unit.test.ts`: equity math against `perps.rs`, ring order, market
  resolution, round-file writes, config, CLI args.
- `test/mcp.test.ts`: spawns the server over stdio with the SDK `Client` +
  `StdioClientTransport` and calls every read tool against the live local round
  (read-only: a fresh wallet never joins it; owner reads use a runner bot's key
  from the round file), plus one session over streamable HTTP.
- `test/e2e-flow.test.ts` (opt-in, `BLACKBOX_MCP_E2E=1`): creates a scratch
  round with the admin key and its own round file, then runs `join_round`,
  `enter_round`, `hot_swap_strategy` (BXL and builtin), `read_my_*` and
  `privacy_check` through the server. The live round is not touched; the
  scratch round is left open.
