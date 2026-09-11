# BLACKBOX demo script

Two cuts of the same scene: a 90-second video for the submission and a 3-minute extended version for judging calls. Everything on screen is produced by a command or page listed in [Set the scene](#set-the-scene). The demo runs on the local MagicBlock stack; the devnet-tee evidence comes from the Phase 0 spike (32/32). Say so on screen: a lower third reads **"Local MagicBlock stack · prices mirrored from devnet Pyth Lazer · test USDC"** for every live shot.

Only show what exists. Blind licensing is designed but not implemented, so it is not in the demo. Prizes are paid on the rollup and the round commits to L1; there is no separate L1 payout action.

## Screen layout

- **Left, 60%:** browser. `http://localhost:3100/` (Arena), `/studio`, `/proof`, `/how`.
- **Right top, 40%:** Claude Code with the BLACKBOX MCP server.
- **Right bottom, 40%:** terminal for `bx-attack` and the e2e settlement table.

Font size 16+ in terminals. Hide wallet balances and any keypair path.

## 90-second cut

| Time | On screen | Voiceover | Produced by |
|---|---|---|---|
| 0:00-0:08 | Title card over the live Arena: **BLACKBOX. Alpha you can't read.** | "Every trading strategy on Solana is public the moment it trades. BLACKBOX is a league where nobody can read yours." | Arena `/` |
| 0:08-0:20 | Arena: nine black boxes (eight bots and Claude), equity numbers and sparklines ticking, tick progress bar, SOL/BTC/ETH market strip. Hover one tile to show "sealed". | "Nine strategies are trading SOL, BTC and ETH perps every 400 milliseconds, inside a MagicBlock Private Ephemeral Rollup. You see equity. Nothing else." | Arena `/`, indexer on 8787 |
| 0:20-0:35 | Terminal: `bx-attack` against Claude's entrant. Rows fill in: no-token read `null`, fresh-wallet token `null`, rival bot's token `null`, L1 copy of the Strategy is all zeros, delegation records hold no bytecode. Exit code 0. Then Claude Code runs `privacy_check`: a random wallet's token reads `null`, Claude's own token reads its strategy. | "No token: null. A stranger's token: null. A rival in the same round: null. On Solana, the account is zeros. Only the owner gets bytes." | `bx-attack --target <Claude's wallet>`; MCP `privacy_check` |
| 0:35-0:55 | Claude Code. Claude calls `read_my_position` (its private book), then `compile_strategy` and `simulate_strategy` on a new BXL strategy, then `hot_swap_strategy`. The tool result shows version 2 and the rollup transaction link. Cut to the Arena: Claude's curve changes slope within a few ticks. | "Claude reads its own sealed book through our MCP server, writes a new strategy, and hot-swaps it in one rollup transaction. Its rivals see a version number change. Not the code." | Claude Code + `packages/mcp-server`; Arena `/` |
| 0:55-1:08 | `/studio`, acting as Claude's owner: the authenticated disassembly listing and the private position (legs, margin, PnL). Then `/proof` with its pass badges. | "Only the owner's token opens the box. The rollup's own crank runs every strategy against Pyth prices. No keeper, no server that sees the code." | `/studio`, `/proof` |
| 1:08-1:22 | Terminal: the end of an e2e run. Highlight three rows: "private accounts on L1 are all zeros after undelegation", "published strategy hash matches final bytecode", "prizes paid to top 3". | "At the end, the program closes every book, pays the pot in real tokens, publishes a hash of each final strategy, zeroes the private state, and only then commits to Solana." | `tests/blackbox.e2e.ts` output (pre-recorded) |
| 1:22-1:30 | End card: **BLACKBOX. Alpha you can't read.** Below: "Private Ephemeral Rollup · Native Crank · Pyth Lazer · Ephemeral SPL · VRF". Footer: "Primitives verified on devnet-tee, 32/32. Full round verified locally, 27/27." | "BLACKBOX. Alpha you can't read." | Static card |

## 3-minute extended cut

| Time | On screen | Voiceover | Produced by |
|---|---|---|---|
| 0:00-0:15 | Title card, then the Arena. | "Copy bots, front-runners and leaderboards all feed on one leak: on Solana, a strategy is public the moment it trades. BLACKBOX hides the positions and the logic." | Arena `/` |
| 0:15-0:40 | `/how` diagram, then the README architecture diagram. Point at L1, the TEE rollup, the crank, the oracle and VRF. | "Rounds start on Solana. Every account is delegated to MagicBlock's TEE rollup with timer commits disabled. Inside, the Native Crank runs one tick per strategy against Pyth Lazer prices. At the end, the program scrubs private state before anything is committed back." | `/how`, `README.md` |
| 0:40-1:00 | Arena close-up: round header (tick, pot, mode lit, VRF mystery market, solvency beacon: vault balance and total equity), market strip with EMA state and volatility, a liquidated tile if one exists. | "What is public: equity, trade counts, alive or liquidated, marks and open interest. What is not: every line of code and every position." | Arena `/` |
| 1:00-1:25 | `bx-attack` full table, then `/proof` running the same matrix from the browser. | "Every read path we know of: no token, a stranger, a rival, the upload transaction, the L1 copy, the delegation records. The only one that returns the code is the owner's." | `bx-attack`, `/proof` |
| 1:25-1:50 | `/studio`: BXL source on the left, compiled listing and size on the right, simulate button draws a backtest curve over the market ring history. | "Strategies are programs for a 42-opcode deterministic VM that runs inside the rollup. You write them in BXL, compile, backtest on the round's own price history, and deploy." | `/studio`, `@blackbox/compiler` |
| 1:50-2:15 | Claude Code hot-swap sequence, as in the 90-second cut, with the explorer link opened for the rollup transaction. Optionally the scripted agent's log in a second pane. | "Agents play too. Claude joined this round through our MCP server during registration, and trades a sealed strategy like everyone else." | Claude Code, `packages/agents` runner |
| 2:15-2:35 | `docs/design/verification.md` table, then the recorded spike output against devnet-tee (attestation, permission-denied reads, crank ticks, VRF). | "Every primitive was verified on MagicBlock's devnet TEE first: 32 of 32 checks, including attestation, permission-denied reads, crank ticks reading Pyth inside the enclave, private token transfers and VRF." | `docs/design/verification.md`, spike output |
| 2:35-2:50 | Settlement: e2e table rows (all zeros on L1, hash matches, prizes, Hall of Fame, round settled on L1). | "Settlement pays real tokens, publishes hashes so a disclosed strategy can be checked, and commits only zeros for the private state." | e2e output |
| 2:50-3:00 | Disclosures card: TEE and operator trust, public equity, vault as counterparty, test USDC, local stack. End card. | "The trust assumptions are written down in our disclosures. BLACKBOX. Alpha you can't read." | `docs/DISCLOSURES.md` |

## Set the scene

All commands run from the repository root unless noted. Allow about 15 minutes; rehearse the Claude segment once, since joining is only possible during registration.

**0. Environment.**

```bash
export ANCHOR_WALLET=~/.config/solana/id.json
scripts/local-stack.sh status      # 8899, 7799, 6699 must say ok
scripts/local-stack.sh up          # only if something is DOWN; this resets the local ledger
```

**1. Claude Code with the MCP server.** Put this in `.mcp.json` at the repository root (use absolute paths), then start `claude` in the repository. `/mcp` should list `blackbox`.

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "node",
      "args": ["/absolute/path/to/blackbox/packages/mcp-server/bin/blackbox-mcp.js"],
      "env": {
        "BLACKBOX_CLUSTER": "local",
        "BLACKBOX_AGENT_NAME": "claude",
        "BLACKBOX_FAUCET_KEYPAIR": "/home/you/.config/solana/id.json"
      }
    }
  }
}
```

**2. Start a round with 8 bots and a long registration window.** Registration must stay open long enough for Claude to join, and the grace period after the bots finish setting up must be long enough for Claude to enter (deposit, privatize, upload, fund) before the round goes live. `DURATION_TICKS=2400` at 400 ms is 16 minutes of trading.

```bash
CLUSTER=local BOTS=8 TICK_MS=400 DURATION_TICKS=2400 REGISTER_SECS=120 GRACE_SECS=90 MODE=lit \
  pnpm exec ts-node --transpile-only scripts/run-round.ts 2>&1 | tee .mb/demo-round.log
```

Watch `.mb/round-local.json`: `phase` goes `registration`, `delegating`, `live`, `settling`, `settled`.

**3. As soon as the phase is `registration`, prompt Claude:**

> Call get_round. You are entering this BLACKBOX round as "Claude". Call join_round now.

**4. A few seconds after the phase becomes `delegating` (the runner writes the phase, then delegates the round), prompt Claude:**

> Read get_market_history for SOL and BTC and get_bxl_reference. Write a BXL trend strategy on SOL with at most 30% of buying power, check it with compile_strategy and simulate_strategy, then call enter_round with it and a margin of 100 USDC.

**5. Indexer and web app** (separate terminals).

```bash
CLUSTER=local pnpm exec ts-node --transpile-only services/indexer/src/index.ts
cd apps/web && npx next dev -p 3100
```

Open `http://localhost:3100/`. Claude's tile appears once the round is live and its tick task is scheduled.

**6. The hot-swap** (record a few minutes into the live round, ideally after Claude's position has moved against it):

> Call read_my_position and read_scoreboard. If you are losing, write a more defensive strategy (smaller size, or mean reversion), simulate it, and hot_swap_strategy. Explain the change in one sentence.

**7. The attacker.** Target Claude by wallet. Its entry is in the `external` array of `.mb/round-local.json` (written by `join_round`, without a secret key); its index depends on when it joined relative to the bots. Because the attacker cannot load Claude's key, the owner-token control row and the `set_strategy` transaction row need the owner's token: run the attacker once against a bot (`--index 0`, whose key is in the round file) to show them, and use the MCP `privacy_check` tool for Claude's own control read. The rival row uses a bot's key from the round file.

```bash
CLAUDE=$(node -e 'const s=require("./.mb/round-local.json"); const e=(s.external||[]).find(x=>/claude/i.test(x.name)); console.log(e ? e.owner : "")')
pnpm exec ts-node --transpile-only apps/attacker/src/cli.ts --cluster local --round-file .mb/round-local.json --target "$CLAUDE"
pnpm exec ts-node --transpile-only apps/attacker/src/cli.ts --cluster local --round-file .mb/round-local.json --index 0
```

**8. The settlement shot.** Record separately so the main round can keep running. The e2e test creates its own round and prints the 27-row table in about a minute. Run it after the main round has settled, or accept the extra load on the local rollup while both run.

```bash
DURATION_TICKS=60 pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/blackbox.e2e.ts 2>&1 | tee .mb/demo-e2e.log
```

**9. No API key fallback.** The scripted agent exercises the same MCP tools (momentum first, a hot-swap to mean reversion after its position loses):

```bash
pnpm exec ts-node --transpile-only packages/agents/src/runner.ts --providers scripted --round-file .mb/round-local.json
```

Start it during registration, like Claude.

## Checks before recording

- `scripts/local-stack.sh status` shows 8899, 7799, 6699 ok.
- The Arena header's tick advances roughly every 400 ms, and marks move (the price mirror is running inside `run-round.ts`).
- `bx-attack` exits 0 for Claude's wallet and for bot index 0.
- Claude's hot-swap result shows a version above 1 and an ER transaction link.
- Nothing on screen shows a secret key, a keypair file's contents, or an auth token (explorer links for owner-only transactions carry the owner's token in the URL; show them only briefly or crop the address bar).
