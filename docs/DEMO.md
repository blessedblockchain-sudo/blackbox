# BLACKBOX demo script

Two cuts of the same scene: a 90-second video for the submission and a 3-minute extended version for judging calls.

**The submission video is rendered from devnet footage.** The BLACKBOX program is deployed on devnet and a full round was verified there against MagicBlock's TEE validator (42/42 checks), so the round on screen runs on `devnet` + `devnet-tee` with live Pyth Lazer prices. A lower third reads **"Solana devnet · MagicBlock TEE rollup · live Pyth Lazer · test USDC"**. Anything recorded on the local stack instead (a long rehearsal round, the `/back` licensing flow with its server-held backer) carries **"Local MagicBlock stack · prices mirrored from devnet Pyth Lazer · test USDC · no enclave"** for the whole shot. Never mix the two lower thirds inside one shot.

Only show what exists. Blind licensing, the round chat, the house bankroll and the vault sweep are all in the running build and belong in the demo. There is no separate L1 payout action: prizes are paid on the rollup and the round commits to L1.

## Screen layout

- **Left, 60%:** browser. `http://localhost:3100/` (Arena), `/studio`, `/back`, `/proof`, `/hall`, `/disclosures`.
- **Right top, 40%:** Claude Code with the BLACKBOX MCP server.
- **Right bottom, 40%:** terminal for `bx-attack` and the e2e settlement table.

Font size 16+ in terminals. Hide wallet balances and any keypair path.

## 90-second cut

| Time | On screen | Voiceover | Produced by |
|---|---|---|---|
| 0:00-0:08 | Title card over the live Arena: **BLACKBOX. Alpha you can't read.** | "Every trading strategy on Solana is public the moment it trades. BLACKBOX is a league where nobody can read yours." | Arena `/` |
| 0:08-0:20 | Arena: black boxes (the bots and Claude), equity numbers and sparklines ticking, tick progress bar, SOL/BTC/ETH market strip, the round header's solvency beacon. Hover one tile to show "sealed", its blind price and its licence count. | "These strategies are trading SOL, BTC and ETH perps every tick, inside a MagicBlock Private Ephemeral Rollup. You see equity. Nothing else." | Arena `/`, indexer on 8787 |
| 0:20-0:34 | Terminal: `bx-attack` against Claude's entrant. Rows fill in: no-token read `null`, fresh-wallet token `null`, rival bot's token `null`, L1 copy of the Strategy is all zeros, delegation records hold no bytecode. Exit code 0. Then Claude Code runs `privacy_check`: a random wallet's token reads `null`, Claude's own token reads its strategy. | "No token: null. A stranger's token: null. A rival in the same round: null. On Solana, the account is zeros. Only the owner gets bytes." | `bx-attack --target <Claude's wallet>`; MCP `privacy_check` |
| 0:34-0:50 | Claude Code. Claude calls `read_my_position` (its private book), then `compile_strategy` and `simulate_strategy` on a new BXL strategy, then `hot_swap_strategy`. The tool result shows version 2 and the rollup transaction link. Cut to the Arena: Claude's curve changes slope within a few ticks. | "Claude reads its own sealed book through our MCP server, writes a new strategy, and hot-swaps it in one rollup transaction. Its rivals see a version number change. Not the code." | Claude Code + `packages/mcp-server`; Arena `/` |
| 0:50-1:06 | `/back`: authors ranked by blind price. Start a licence and let the step list run — `open_license`, `delegate_license`, deposit, `activate_license`, `schedule_license_tick` — then the licence card shows margin, fees accruing and trades. Cut to Claude Code: `read_my_licenses` shows the same book; `read_my_strategy` on the author returns nothing. | "You can back a strategy without reading it. The backer puts up margin, the rollup's crank runs the author's sealed code on the backer's own book, and the fee is priced inside the enclave from the author's private Sharpe ratio. The backer sees their fills. Never the logic." | `/back`, MCP `back_strategy` / `read_my_licenses` |
| 1:06-1:16 | Terminal: the end of the devnet e2e run. Highlight four rows: "backer cannot read the strategy it runs", "private accounts on L1 are all zeros after undelegation", "published strategy hash matches final bytecode", "prizes paid to top 3". | "At the end, the program closes every book and every licence, pays fees and the pot in real tokens, publishes a hash of each final strategy, zeroes the private state, and only then commits to Solana." | `CLUSTER=devnet` e2e output (pre-recorded) |
| 1:16-1:30 | End card: **BLACKBOX. Alpha you can't read.** Below: "Private Ephemeral Rollup · Native Crank · Pyth Lazer · Ephemeral SPL · Ephemeral accounts · VRF". Footer: "Full round on devnet-tee, 42/42. Primitives verified on devnet-tee, 32/32." | "BLACKBOX. Alpha you can't read." | Static card |

## 3-minute extended cut

| Time | On screen | Voiceover | Produced by |
|---|---|---|---|
| 0:00-0:15 | Title card, then the Arena. | "Copy bots, front-runners and leaderboards all feed on one leak: on Solana, a strategy is public the moment it trades. BLACKBOX hides the positions and the logic." | Arena `/` |
| 0:15-0:38 | The README architecture diagram. Point at L1, the TEE rollup, the crank, the oracle and VRF, and at the private accounts. | "Rounds start on Solana. Every account is delegated to MagicBlock's TEE rollup with timer commits disabled. Inside, the Native Crank runs one tick per strategy against Pyth Lazer prices. At the end, the program scrubs private state before anything is committed back." | `README.md` |
| 0:38-1:00 | Arena close-up: round header (tick, pot, mode lit, VRF mystery market, solvency beacon showing vault balance and total equity), market strip with EMA state and volatility, a liquidated tile if one exists, the round chat panel with a couple of messages. | "What is public: equity, trade counts, alive or liquidated, marks and open interest, and a chat anyone can read. What is not: every line of code and every position." | Arena `/` |
| 1:00-1:22 | `bx-attack` full table, then `/proof` running the same matrix from the browser: path, who asked, result, expected, verdict. | "Every read path we know of: no token, a stranger, a rival, the upload transaction, the L1 copy, the delegation records. The only one that returns the code is the owner's." | `bx-attack`, `/proof` |
| 1:22-1:45 | `/studio`: BXL source on the left, compiled listing and size on the right, simulate draws a backtest curve over the market ring history; then the authenticated panels — the disassembly of the deployed bytecode and the private position. | "Strategies are programs for a 42-opcode deterministic VM that runs inside the rollup. You write them in BXL, compile, backtest on the round's own price history, deploy — and only your own token can read what you deployed." | `/studio`, `@blackbox/compiler` |
| 1:45-2:10 | `/back` end to end: the author table with blind prices, the ten-step licence run with an explorer link per step, then the licence card trading. Cut to the author's side in Claude Code: `read_my_licenses` shows "someone backs you", with their margin and the fees you have earned. | "The fee is the only public number the enclave publishes about an author's performance. Activate a licence and it locks; from there the crank trades the author's code on your margin, charges the fee on traded notional, and pays it to the author at settlement." | `/back`, MCP `list_authors` / `read_my_licenses` |
| 2:10-2:30 | Claude Code hot-swap sequence, as in the 90-second cut, with the explorer link opened for the rollup transaction. Optionally the scripted agent's log in a second pane, and an agent posting one line to the round chat. | "Agents play too. Claude joined this round through our MCP server during registration, trades a sealed strategy like everyone else, and can back someone else's." | Claude Code, `packages/agents` runner |
| 2:30-2:45 | `docs/design/verification.md` table, then the recorded spike output against devnet-tee (attestation, permission-denied reads, crank ticks, VRF). | "Every primitive was verified on MagicBlock's devnet TEE first: 32 of 32 checks, including attestation, permission-denied reads, crank ticks reading Pyth inside the enclave, private token transfers and VRF." | `docs/design/verification.md`, spike output |
| 2:45-2:55 | Settlement: the devnet e2e table (licence settled and back on L1 as zeros, all 12 entrant accounts zeroed on L1, hash matches, prizes, vault swept, chat closed, Hall of Fame, round settled with `vault_balance` 0). | "Settlement pays real tokens, publishes hashes so a disclosed strategy can be checked, sweeps the house bankroll back, and commits only zeros for the private state." | `CLUSTER=devnet` e2e output |
| 2:55-3:00 | `/disclosures` scrolling past the trust items, then the end card. | "The trust assumptions are written down, in the app and in the repo. BLACKBOX. Alpha you can't read." | `/disclosures`, static card |

## Set the scene

All commands run from the repository root unless noted. Allow about 15 minutes; rehearse the Claude segment once, since joining is only possible during registration.

**0. Environment.**

```bash
export ANCHOR_WALLET=~/.config/solana/id.json
scripts/local-stack.sh status      # 8899, 7799, 6699 must say ok  (local shots only)
scripts/local-stack.sh up          # only if something is DOWN; this resets the local ledger
```

For devnet shots set `CLUSTER=devnet` (and `BLACKBOX_CLUSTER=devnet`, `NEXT_PUBLIC_CLUSTER=devnet` for the web app) instead of starting the local stack. The devnet wallet needs SOL and the round's test USDC; there is no faucet in the UI.

**1. Claude Code with the MCP server.** Put this in `.mcp.json` at the repository root (use absolute paths; a copy of this file lives in `packages/mcp-server/.mcp.json.example`), then start `claude` in the repository. `/mcp` should list `blackbox`.

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

**2. Start a round with 8 bots and a long registration window.** Registration must stay open long enough for Claude to join, and the grace period after the bots finish setting up must be long enough for Claude to enter (deposit, privatize, upload, fund) before the round goes live. `DURATION_TICKS=2400` at 400 ms is 16 minutes of trading. `BACKERS=1` puts a copycat licence on the board by itself; set `BACKERS=0` if you would rather open the only licence by hand from `/back` on camera.

```bash
CLUSTER=local BOTS=8 TICK_MS=400 DURATION_TICKS=2400 REGISTER_SECS=120 GRACE_SECS=90 MODE=lit \
  BACKERS=1 BANKROLL_USDC=2000 \
  pnpm exec ts-node --transpile-only scripts/run-round.ts 2>&1 | tee .mb/demo-round.log
```

Watch `.mb/round-local.json`: `phase` goes `registration`, `delegating`, `live`, `settling`, `settled`. The file also holds `backers`, `licenses` and the `house` wallet the bankroll came from.

**3. As soon as the phase is `registration`, prompt Claude:**

> Call get_round. You are entering this BLACKBOX round as "Claude". Call join_round now.

**4. A few seconds after the phase becomes `delegating` (the runner writes the phase, then delegates the round), prompt Claude:**

> Read get_market_history for SOL and BTC and get_bxl_reference. Write a BXL trend strategy on SOL with at most 30% of buying power, check it with compile_strategy and simulate_strategy, then call enter_round with it and a margin of 100 USDC.

**5. Indexer and web app** (separate terminals).

```bash
CLUSTER=local pnpm exec ts-node --transpile-only services/indexer/src/index.ts
pnpm --filter @blackbox/web dev
```

Open `http://localhost:3100/`. Claude's tile appears once the round is live and its tick task is scheduled. Stop the dev server before any `next build`.

**6. The hot-swap** (record a few minutes into the live round, ideally after Claude's position has moved against it):

> Call read_my_position and read_scoreboard. If you are losing, write a more defensive strategy (smaller size, or mean reversion), simulate it, and hot_swap_strategy. Explain the change in one sentence.

**7. The licence.** On `/back`, the authors are ranked by their public blind price. Pick one and start the run: on a local round the page drives a server-held backer key (`.mb/web/backer-local.json`) through all ten steps — fund with SOL, mint test USDC, `open_license`, list it in the round file, `delegate_license`, deposit into the rollup, wait for the deposit, wait for the License on the rollup, `activate_license`, `schedule_license_tick` — with an explorer link per step, then reads its own License back with the backer's TEE token. It takes a couple of seconds; let it finish on camera. On devnet the same nine on-chain steps are signed by the connected browser wallet (untested at the time of writing; the page detects a missing program on a cluster and says so).

An agent can do the same from Claude Code:

> Call list_authors, then back_strategy on the highest blind price with a margin of 100 USDC, then read_my_licenses.

**8. The chat.** From `/back` or the Arena panel, post one line as the local backer, and have Claude call `post_chat`. Both appear in the Arena chat panel within a few seconds, with the poster's key and the tick. Keep it to something a spectator would say; the chat is public and permanent for the life of the round.

**9. The attacker.** Target Claude by wallet. Its entry is in the `external` array of `.mb/round-local.json` (written by `join_round`, without a secret key); its index depends on when it joined relative to the bots. Because the attacker cannot load Claude's key, the owner-token control row and the `set_strategy` transaction row need the owner's token: run the attacker once against a bot (`--index 0`, whose key is in the round file) to show them, and use the MCP `privacy_check` tool for Claude's own control read. The rival row uses a bot's key from the round file.

```bash
CLAUDE=$(node -e 'const s=require("./.mb/round-local.json"); const e=(s.external||[]).find(x=>/claude/i.test(x.name)); console.log(e ? e.owner : "")')
pnpm exec ts-node --transpile-only apps/attacker/src/cli.ts --cluster local --round-file .mb/round-local.json --target "$CLAUDE"
pnpm exec ts-node --transpile-only apps/attacker/src/cli.ts --cluster local --round-file .mb/round-local.json --index 0
```

`/proof` runs the same matrix from the browser against any entrant of the current round.

**10. The settlement shot.** Record separately so the main round can keep running. The e2e test creates its own round and prints the full table; the devnet run is the one to show (42 rows, a few minutes), the local run is the fast rehearsal (about a minute at 90 ticks).

```bash
CLUSTER=devnet pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/blackbox.e2e.ts 2>&1 | tee .mb/demo-e2e.log
DURATION_TICKS=90 pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/blackbox.e2e.ts 2>&1 | tee .mb/demo-e2e-local.log
```

**11. No API key fallback.** The scripted agent exercises the same MCP tools (momentum first, a hot-swap to mean reversion after its position loses, and a licence if a rival's blind price is high enough):

```bash
pnpm exec ts-node --transpile-only packages/agents/src/runner.ts --providers scripted --round-file .mb/round-local.json
```

Start it during registration, like Claude.

## Checks before recording

- For local shots, `scripts/local-stack.sh status` shows 8899, 7799, 6699 ok.
- The Arena header's tick advances at the round's tick interval, marks move, and the solvency beacon reads "covered" (the bankroll was seeded).
- At least one author shows a blind price above the round's minimum, so `/back` has something worth licensing on camera.
- `bx-attack` exits 0 for Claude's wallet and for bot index 0.
- Claude's hot-swap result shows a version above 1 and an ER transaction link.
- The lower third matches the cluster the shot was recorded on.
- Nothing on screen shows a secret key, a keypair file's contents, or an auth token (explorer links for owner-only transactions carry the owner's token in the URL; show them only briefly or crop the address bar).
