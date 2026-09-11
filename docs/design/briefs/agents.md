# Brief: LLM agent runner (`packages/agents`)

Own `packages/agents`. Build the runner that puts LLM traders into a BLACKBOX round through the MCP server (`packages/mcp-server`, spawned over stdio with `StdioClientTransport`; one server process per agent with its own `BLACKBOX_AGENT_NAME` / keypair).

Before writing any Anthropic code, load the `claude-api` skill and follow it (model IDs, tool use, SDK usage). Default Claude model: `claude-sonnet-5` (env `BLACKBOX_CLAUDE_MODEL` overrides). OpenAI (`openai` SDK, tool calling, default model from env `BLACKBOX_OPENAI_MODEL`) and Gemini (`@google/genai`, function calling, env `BLACKBOX_GEMINI_MODEL`) providers run only when their API keys are present (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).

## Behavior
- `src/runner.ts` CLI: `--providers claude,openai,gemini,scripted` (default: every provider with a key, plus `scripted`), `--round-file`, `--interval-secs` (default 45), `--max-steps`.
- Lifecycle per agent: during `registration` call `join_round`; when phase becomes `delegating` write an initial BXL strategy (the LLM authors it after reading `get_round` and `get_market_history`, validates with `compile_strategy` and `simulate_strategy`) and call `enter_round`; during `live`, every interval read `read_my_position`, `get_round`, `read_scoreboard`, decide whether to `hot_swap_strategy`, and explain the decision in one sentence; stop at `settling`.
- Bridge MCP tools to each provider's tool-calling format generically (convert the MCP tool list's JSON schemas).
- System prompt: the agent is a quant competing in a sealed league where strategies are private programs; it must write BXL (include the language reference from `packages/compiler/src/index.ts` and `docs/design/briefs/compiler.md`), keep risk sane, and never try to read other entrants' strategies.
- `scripted` provider: a deterministic agent that exercises the same tools without an LLM (momentum first, then a hot-swap to mean reversion after its position loses), so the demo works with no API keys.
- Transcripts: append JSON lines to `runs/<provider>-round<id>.jsonl` (tool calls, results summary, decisions, tx links). Print a compact live log.

## Tests
`test/bridge.test.ts` for the MCP-to-provider schema conversion. Run the `scripted` agent against the live local round for at least one loop if the round is in a phase that allows it; otherwise document the manual command.
