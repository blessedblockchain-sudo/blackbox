# Solana Blitz v8 — what to build to win

Compiled 2026-09-10. Inputs: research brief (event, primitives, past winners), 24 generated candidates (`docs/idea-pool.md`), 17 judge scorecards on the six highest-scoring candidates, and a final synthesis pass. Ranking of candidates 7+ is editorial (the judge panel was stopped early to save session budget).

## Final ranking

| # | Project | One-liner | Why it wins | Why it might not |
|---|---|---|---|---|
| 1 | **BLACKBOX** (Blackbox Arena, cut to the bone) | A trading league where every strategy is a tiny program executed *inside* the Private ER. Nobody can read it: not rivals, not spectators, not the operator. You can license a winning strategy for your own capital without ever seeing it. | The purest "only possible on a PER" thesis in the pool (the program executes secrets clients cannot query). It is official idea #2 taken three levels further, it is agents-native (MCP), it uses PER + Crank + Oracle + Ephemeral SPL + Magic Actions + session keys coherently, and the demo has a money shot (permission denied on camera, then a live hot-swap). Judges scored it highest (7.17) even before the scope cuts below. | Scope. The original design (Lever fork + VM + DSL + MCP + licensing) was a nine-day build. The spec below removes the real perps engine and the VRF, and makes the licensing path settle-at-end rather than per-trade. Two integration bets (oracle feeds and Native Crank on the TEE validator) must be verified on day 1. |
| 2 | **BACKSTAB** | The Traitors in your Telegram group with real USDC: VRF deals hidden roles, traitors get a private chat, votes are sealed, anyone can bribe anyone privately mid-game, and the finale reveals everything, including the bribes. One seat can be an AI. | Most viral demo in the pool and the deepest PER showcase that is not trading: four classes of secrets with different lifetimes. The per-player private inbox fan-out (instead of a public L1 permission group for the traitor room) is a pattern MagicBlock engineers will notice. Games have won Blitz before (BlitzMine, v7). | Not trading, and three of five official ideas are trading. Needs eight humans (or five plus scripted seats) for the demo. Telegram bot + mini app is a big frontend surface. |
| 3 | **PACK / KEYHOLE** (merged) | Social tap trading where your pack is literally a PER permission group, FOLLOW/FADE fills land in the same 10ms slot as the leader's, and strangers pay per minute to read a trader's book. | Official idea #1 executed at the ceiling, plus paid read-permissions as a market. Best 60-second pitch in the pool. | Most crowded lane this week (everyone builds #1). Needs a perps engine (Lever fork). The vault-as-counterparty "bucket shop" objection is real and must be answered in the pitch. |
| 4 | **FELT** | Real-money no-limit hold'em where the deck and hole cards live in the TEE. Zero rake, VRF shuffle, crank shot clock, pay-per-view rail seats. | The canonical "impossible onchain" game finally buildable without mental-poker crypto. Highest feasibility of the top five and instantly legible. | Obvious idea; other teams will try it. Gambling optics. Poker-engine correctness (side pots, all-ins) eats testing time. |
| 5 | **BACKCHANNEL** | Kafka on an ER: paid topics gated by the PER permission list, a crank meters prepaid USDC per second, every topic's hash chain is anchored to L1 by a Magic Action so private alpha can be proven later. | Real infrastructure with a Forge story: official ideas #1 and #4 are both skins on it. | Infra demos rarely take 1st at Blitz. The provable-timestamp beat is subtle on video. |
| 6 | Last Bag Standing / PAPERHANDS | Official idea #3 (game of chicken) with hidden bails and VRF intel drops. | Cheap to build, viral in group chats. | Judges found the hidden information is not strategically load-bearing without a survivor-rank payout; the easiest official idea, so the most crowded. |
| 7 | Sotto / Nightshift | Official idea #5 (private inference) as a streaming market with per-token USDC. | Deepest primitive count. Generated independently by two angles. | "Private" means hidden from the chain, not from the provider; provider daemon is a two-day slog; verification story is weak. |
| 8 | Mutiny, Sudden Death, Fogbank | Real-time hidden-info games with real money. | PER-native, fun. | Bigger client surfaces than BACKSTAB for the same privacy story. |
| 9 | Fathom, Undertow, Nightbook, Blind Trust | Dark perps / dark batch auction / private vaults. | Serious DeFi. | Tenor and Veil already own "private venue" in judges' minds; low demo wow. |
| 10 | Dead Drop | Private agent labor market (official #4). | Clever mechanisms (VRF surplus split, blind juries). | Demo is terminal logs; demand is unproven. |
| 11 | Candle, Placard, Turnstile, Ajo | Auction engine, ad exchange, ticketing, savings circles. | Fresh domains. | Off-narrative for a MagicBlock trading/games/agents jury. Ajo would be a strong Wizardio's Choice play if you want a human story. |

---

## #1 BLACKBOX — build spec

### One-line pitch
Trading strategies that nobody can read, not even the chain. Upload a strategy, it runs inside a Private Ephemeral Rollup against live Pyth Lazer prices four times a second, the leaderboard ticks live, and anyone can put capital behind a winning strategy without ever seeing it.

### Why it wins Blitz v8
- **Needs the PER.** The product is "a program executes code that no client can query". On L1 the strategy is public the moment it lands. Off-chain it is a trust-me bot. Only a TEE-backed rollup with per-account read permissions gives program-readable, client-unreadable state.
- **Uses the newest primitives correctly.** Permission groups (per Strategy and Position), Native Crank (per-strategy ticks in consensus), Price Oracle (Pyth Lazer accounts read directly), Ephemeral SPL (USDC entry pot), Magic Actions (atomic payout after commit), session keys (agents and one-click licensing), 64KB transactions (hot-swap a whole strategy in one tx).
- **Official idea #2, three levels further.** MagicBlock asked for "private trading competitions where positions stay hidden". This hides the positions *and the logic*, executes the logic inside the rollup, and adds blind licensing.
- **Agents-native.** Strategies are authored by LLM agents through an MCP server. MagicBlock ran an agentic Blitz (v4) and an agent MCP server won v7 (Oobe).
- **Explorer proof is built in.** Thousands of crank ticks scroll on the ER explorer during the demo.
- **Founders Camp story.** "Alpha as an unreadable, licensable asset" is a company, not a hackathon toy.

### The demo (90 seconds, shot by shot)
1. **0-10s.** Arena screen: twelve black boxes labelled Claude, Codex, and ten named bots. Each shows only an equity curve and ALIVE/LIQUIDATED. A live leaderboard ticks. Voice: "Twelve strategies are trading SOL and BTC right now, four times a second, inside a Private Ephemeral Rollup."
2. **10-25s.** Terminal on the right. Run an unauthenticated read of Claude's Strategy account against the TEE RPC: `permission denied`. Run it again with a random wallet's auth token: denied. Voice: "Not the other bots, not you, not the rollup operator."
3. **25-40s.** Same terminal, authenticated as the owner: the bytecode comes back and disassembles into readable rules. Claude (live in Claude Code, via the MCP server) says "I'm bleeding on BTC, cutting leverage" and hot-swaps its strategy. One 64KB ER transaction. Its equity curve bends within a tick.
4. **40-55s.** Cut to the ER explorer scrolling crank ticks with no wallet signer. Voice: "No server. The rollup itself runs every strategy on a schedule."
5. **55-75s.** A plain Phantom wallet clicks "Back Claude with 25 USDC". The wallet's own equity curve appears and starts mirroring Claude's trades within one tick. Voice: "You are trading Claude's strategy with your money. You cannot read it. Claude cannot touch your money."
6. **75-90s.** Round ends. The scoreboard freezes, every strategy's hash is published, one Magic Action pays the pot and license fees on L1. Solscan shows the USDC landing. Final card: "BLACKBOX. Alpha you can't read."

### Architecture

**Programs**
- `blackbox` (Anchor): rounds, strategies, positions, licenses, VM, tick, settlement.
- MagicBlock programs used: Delegation `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, Permission `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, Ephemeral SPL `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, Oracle `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`, Crank via `MAGIC_PROGRAM_ID` ScheduleTask.

**Accounts (all created on L1 first, then delegated to the TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`)**

| Account | Seeds | Delegated | Private? | Contents |
|---|---|---|---|---|
| Round | `["round", id]` | yes | public | markets[], start/end tick, entry fee, pot, live flag, status |
| Scoreboard | `["board", round]` | yes | public | per-entrant equity (u64), alive flag, trade count; final strategy hashes written at end |
| Strategy | `["strat", round, owner]` | yes | **private, members=[owner]**, flags TX_LOGS/TX_MESSAGE/TX_BALANCES | bytecode (up to 4KB), version, step limit, params[16] |
| Position | `["pos", round, owner]` | yes | **private, members=[owner]** | margin, per-market size/entry/side, realized PnL, liquidated flag |
| License | `["lic", round, buyer, author]` | yes | public existence, **private body members=[buyer, author]** | buyer margin, fee bps, accrued fees |
| Custody eATA | Ephemeral SPL eATA owned by Round PDA | yes | public | USDC pot and buyer margins (real tokens sit in the Global Vault) |
| Market | `["mkt", round, feed]` | yes | public | feed id, max leverage, maintenance margin, last mark, OI |

Oracle price accounts (`["price_feed","pyth-lazer",feedId]` under the oracle program) are read directly by the tick; not owned by us.

**What lives where**
- L1: Round created and funded, all PDAs created empty (delegated accounts must pre-exist on L1). Bytecode is *never* written on L1: the Strategy account is created zeroed, delegated, and filled only by ER transactions, which are hidden by TX_MESSAGE on a private account.
- PER: everything above during the round. Ticks, hot-swaps, licensing, liquidations.
- Settlement: `end_round` zeroes every Strategy and Position body (anything undelegated becomes public), writes final equities and `sha256(bytecode)` per strategy to Scoreboard, then `commit_and_undelegate(Scoreboard, Custody eATA)` with a post-commit Magic Action `payout` that moves USDC from custody to the top-3 ATAs and accrued license fees to authors' ATAs atomically.

**The VM**
- Stack machine, ~24 opcodes: `PUSH imm`, `PRICE feed`, `EMA feed n` (program keeps rolling EMAs in Position scratch), `POS feed`, `EQUITY`, `ADD/SUB/MUL/DIV`, `LT/GT/EQ`, `JMP/JZ`, `LONG feed size_bps`, `SHORT feed size_bps`, `CLOSE feed`, `HALT`. Hard step limit (256) and a bytecode length cap so one tick is under 60k CU. Any fault = HALT with no trade, never a panic.
- Deterministic and side-effect-free apart from LONG/SHORT/CLOSE, which call the same paper-perps functions humans would.

**Paper perps (no Lever fork)**
- Mark = oracle price at tick. Open at mark, fixed max leverage per market (e.g. 10x), notional cap per position. Equity = margin + unrealized PnL. Liquidate at equity below maintenance; liquidation is checked inside the same tick, so no separate sweep. Funding: none for the hackathon. Counterparty: none; PnL is paper against the pot (positions are scored, not filled against a vault). Say this plainly: it is a competition ledger, not a venue.

**Native Crank**
- At `join_round`, the program schedules `tick(strategy)` with `execution_interval_millis = 250` (fallback 500 or 1000) and `iterations = round_duration / interval`. One task per strategy so a bad strategy cannot stall the arena. The tick instruction uses `AccountInfo` for every account (docs: avoids stale reserialization after CPI). `round.live` guard flag makes ticks no-ops after `end_round`.

**Licensing (blind alpha)**
- `license(author, margin)`: buyer deposits USDC margin into custody (Ephemeral SPL transfer, PDA-signed), License PDA binds buyer to author. On each tick, after executing the author's bytecode for the author's Position, the same trades are applied to the buyer's License margin at proportional size. Fees accrue in the License (e.g. 20 bps of notional per opened trade) and are paid at settlement via the Magic Action. No per-trade token transfers, which keeps program-side eSPL CPI to two documented paths (deposit-in, payout-out).
- Honesty line for the pitch: the licensee can read their own License body and infer trades. "Logic stays private, trades on your own capital do not."

**Session keys**
- Agents' MCP server signs `upload_strategy`, `hot_swap`, and reads with a scoped session key: no wallet popups mid-round. The licensing button uses a session key for one-click.

**Agents / MCP server**
- Tools: `get_markets`, `compile_strategy(dsl) -> bytecode`, `deploy_strategy`, `hot_swap`, `read_my_position`, `read_scoreboard`. DSL is a 10-line rule language (`if ema(SOL,20) > ema(SOL,60) and pos(SOL)==0: long SOL 3000bps`). Claude Code and Codex each run an agent; ten scripted bots (momentum, mean-reversion, random, "always long", etc.) fill the arena.

### Core loop data flow and latency budget
1. Oracle pusher updates the Pyth Lazer account (50-200ms cadence).
2. Crank fires `tick(strategy_i)` every 250ms inside PER consensus.
3. `tick`: read oracle mark(s) -> update EMAs -> run VM (<=256 steps) -> apply trades to Position (and any Licenses bound to this Strategy, passed as remaining accounts by the scheduled ix) -> mark equity -> liquidate if needed -> write equity to Scoreboard.
4. Clients poll/subscribe: public Scoreboard via the TEE RPC without a token; own Strategy/Position with an auth token. Target UI latency ~300ms tick-to-screen.
5. Hot-swap: agent sends a 64KB ER tx replacing Strategy bytecode; next tick uses it (<=250ms).

### Frontend
- Next.js app, three screens: **Arena** (black boxes with equity sparklines, live leaderboard, round timer, explorer deep links per tick), **My Strategy** (authenticated TEE read, disassembly view, DSL editor, deploy/hot-swap, session key creation), **Back a Strategy** (list of authors with equity curves only, license button, my licensed PnL).
- Auth flow: `verifyTeeRpcIntegrity` (Phala PCCS) -> sign challenge -> token -> `https://devnet-tee.magicblock.app?token=...`.
- Attacker terminal is a small CLI in the repo (`bx read <strategy> [--token]`) used live in the demo.

### The extreme feature
The VM itself: strategies are *programs*, not parameters, and they run in the rollup. Second extreme beat: **blind licensing** with published strategy hashes at settlement, so a licensee can verify the strategy they backed did not change mid-round without ever reading it.

### Build plan (7 days, de-risk first)
- **Day 1: the spike.** One 200-line Anchor program: create PDA on devnet, delegate to the TEE validator with pre-funded lamports, `init_permission` + `set_privacy(members=[owner])`, schedule a Native Crank tick that reads a Pyth Lazer account and increments a private counter. Verify on camera: unauthenticated read denied, owner read works, crank ticks show on the explorer, oracle value is fresh inside the TEE. Post in the Builders Telegram: "Are Pyth Lazer accounts and Native Crank available on the TEE validator? Is program-side Ephemeral SPL transfer supported on devnet-tee?" This day decides the fallbacks.
- **Day 2:** VM + paper-perps + `tick`. Unit tests for every opcode and for liquidation. Bytecode fuzz test (random bytes must never panic).
- **Day 3:** Round lifecycle: `create_round`, `join_round` (eSPL entry fee into custody, schedule crank), `upload_strategy`, `hot_swap`, `end_round` with scrub-before-commit, `commit_and_undelegate`, Magic Action `payout`. Explicit test: after undelegation, Strategy bodies on L1 are zero.
- **Day 4:** DSL compiler (TypeScript), MCP server, Claude Code and Codex agents, ten scripted bots. Run a full 10-minute round on devnet-tee end to end.
- **Day 5:** Licensing: `license`, tick applies author trades to License margins, fee accrual, payout to authors. Attacker terminal CLI.
- **Day 6:** Arena UI, My Strategy, Back a Strategy, explorer deep links, disclosures page (TEE trust, paper PnL, devnet). Rehearse the 90-second demo three times.
- **Day 7:** Record video, README with architecture diagram and explorer links, submit at build.magicblock.app (tags: DeFi, AI/Agents, Privacy).

### Constraints and how the design respects them
- **Delegated accounts must exist on L1 first.** All PDAs are created on L1 in `join_round`, before delegation. Nothing is created inside the PER at match time.
- **Programs are cloned, not delegated.** `blackbox` is deployed on devnet L1 only.
- **200k CU per instruction.** VM step limit 256 and bytecode cap keep `tick` well under. Licenses per strategy capped (e.g. 8) per tick.
- **Commit fees and the 10-commit ceiling.** Only Scoreboard commits mid-round (every 60s as a checkpoint), everything else commits once at the end. Add a delegated fee payer if checkpoints exceed 10.
- **Private state becomes public on undelegation.** `end_round` zeroes Strategy and Position bodies before `commit_and_undelegate`. Tested explicitly.
- **Session keys do not cover SPL moves.** Deposits and licensing use a one-time wallet approval; everything else is session-keyed.
- **Slot time is not a clock.** Round timing counts crank ticks, not slots.
- **TEE trust.** Intel TDX plus the validator operator can in principle read state. Say it on the disclosures slide; link the attestation check.
- **PER availability.** Devnet-tee is documented; the PER quickstart lists the TEE validator on mainnet too. Ship on devnet, mention mainnet path.

### Risks and fallbacks (cut order if behind)
1. Oracle not available on the TEE validator -> run a tiny price relay crank of our own that writes Pyth Hermes prices into a delegated `PriceFeed` PDA; disclose it.
2. Native Crank not available on TEE -> a keeper script sends `tick` txs at 250ms with a session key; disclose it. The privacy story survives; the "no server" line goes.
3. Program-side eSPL transfer unsupported on PER -> keep the pot on L1 in a plain escrow PDA, pay via Magic Action only; entries are L1 deposits.
4. Cut licensing UI (keep CLI) -> cut Codex agent (keep Claude + bots) -> cut hot-swap (keep upload-once) -> cut BTC market (SOL only).

### 60-second verbal pitch
"Every trading strategy on Solana is public the moment it trades. Copy bots, front-runners, and leaderboards are all built on that leak. BLACKBOX is a trading league where the strategy is a small program that runs inside a Private Ephemeral Rollup. The rollup executes it against Pyth prices four times a second. Nobody can read it. Not rivals, not spectators, not the operator. The leaderboard is live, the positions and the logic are dark. And because the rollup executes the code, you can back a winning strategy with your own capital without ever seeing it, and the author gets paid without ever touching your money. Twelve strategies are trading right now, two of them written by Claude and Codex through our MCP server. Here is a wallet trying to read one of them: permission denied. Here is the owner hot-swapping it mid-round in one transaction. Here is the payout landing on L1. Alpha you can't read."

### Submission checklist
- Wallet connected for prize distribution.
- Name, description (lead with "only possible on a Private ER"), tags DeFi / AI-Agents / Privacy.
- Public GitHub repo: program, MCP server, DSL compiler, attacker CLI, frontend, README with architecture diagram and the disclosures.
- Demo video (<=3 min) following the 90-second shot list plus a 60-second architecture walk.
- Explorer integration proof: links to crank tick txs, a hot-swap tx, the commit, and the Magic Action payout.
- Program addresses (blackbox program id on devnet, round PDA, TEE validator used).
- Team members and roles.

---

## #2 BACKSTAB — fallback spec

**Pitch.** The Traitors in your group chat with real USDC. Eight friends stake in, VRF inside a Private ER secretly deals two traitors, the traitors get a private chat nobody else can read, every vote is sealed, and anyone can secretly bribe anyone with a private USDC transfer mid-game. At the end everything is revealed at once: roles, votes, the traitors' chat log, every bribe with timestamp and memo. One seat can be an AI agent that whispers, votes, and bribes real people to survive.

**Why it wins.** The most "send this to the group chat" product in the pool; four classes of secrets enforced by a program instead of a host; private payments used as a game mechanic rather than a payment feature; games have won Blitz before. Categories: Games, Privacy, AI/Agents.

**Architecture.** Game PDA (public: phase, round, alive bitmap, tallies). Seat PDA per player (private to that player: role, vote, night target, bribe cap). Inbox PDA per player (private to that player: traitor chat fan-out, system whispers, decoy writes for faithful so write patterns do not leak). PublicChat as an Ephemeral Account. BribeLedger PDA (program-only until reveal). Reveal PDA (public, written at end). Ephemeral SPL USDC eATAs per player plus a pot eATA; bribes are program-CPI'd private eATA-to-eATA transfers. Native Crank runs night/day/resolve timers. VRF deals roles at start. Magic Action writes a public Hall-of-Fame PDA on L1 and emits the reveal the bot renders. Key pattern: the traitor room is never an L1 permission group (membership would be public); the TEE fans messages out to per-player private inboxes.

**Demo.** A real Telegram group of eight. Night: split-screen to the two traitors' phones and their private chat. Day: a toast on Alex's phone, "Ben sent you 15 USDC (private): vote Maya". Sealed vote, Maya banished, she was faithful. Finale card animates roles, chat log, and "Ben -> Alex, 15 USDC, 20:14:07, memo: vote Maya". Explorer shows the VRF request, crank ticks, the commit and the payout.

**7-day plan.** D1 game state machine on the public ER with crank timers and VRF roles. D2 PER migration: private Seats/Inboxes/BribeLedger, auth-token client, fan-out plus decoys. D3 Ephemeral SPL stake, bribe and payout paths. D4 Telegram bot + mini app (session keys, join, both chats, vote/bribe). D5 reveal card, Hall Magic Action, AI traitor seat via MCP. D6 full playtest in a real group, explorer proof. D7 video, README, submit. Cut order: Hall, decoy writes, AI seat.

---

## Day-1 questions for the MagicBlock Builders Telegram (either project)
1. Are Pyth Lazer oracle accounts pushed to / readable on the TEE validator (`MTEW...`)?
2. Does Native Crank (ScheduleTask) run on the TEE validator?
3. Is program-side Ephemeral SPL transfer (PDA-signed) supported on devnet-tee, as in the sealed-auction example?
4. Can Ephemeral Accounts carry EphemeralPermission members, or must private accounts be delegated L1 PDAs?
5. Is delegated VRF callable from inside the PER? (BACKSTAB only)
6. Any cap on member-list size per permission account?
