# BLACKBOX architecture

This document describes `programs/blackbox` and `crates/bxvm` as they stand on 2026-09-11: the build deployed on devnet (`BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27`) and exercised there by the 42/42 end-to-end run, and the same source the local stack runs with the `local-oracle` feature. Everything here was read from that source; items that are designed but not implemented are listed at the end under [Not implemented](#not-implemented).

Contents: [Layers](#layers) · [Accounts](#accounts) · [Instructions](#instructions) · [The tick loop](#the-tick-loop) · [The VM](#the-vm) · [Perps engine](#perps-engine) · [Privacy design](#privacy-design) · [Blind licensing](#blind-licensing) · [Round chat](#round-chat) · [House bankroll](#house-bankroll) · [Settlement and prizes](#settlement-and-prizes) · [Compute and program size](#compute-and-program-size) · [Local vs devnet](#local-vs-devnet) · [Full round sequence](#full-round-sequence) · [Not implemented](#not-implemented)

## Layers

- **Solana L1** holds the protocol config and Hall of Fame permanently, and every round account before delegation and after the final commit.
- **MagicBlock Private Ephemeral Rollup (TEE)** holds every round account while the round runs. The same `blackbox` program executes there (programs are cloned into the ER, not delegated). All reads go through the TEE RPC, which authenticates a wallet with an auth token and filters accounts by their ephemeral permission.
- **Native Crank** (the ER's `ScheduleTask`) invokes `tick_clock`, `tick_entrant` and `tick_license` on a timer inside the rollup.
- **Pyth Lazer price accounts**, pushed by MagicBlock into every ER, are read directly by the tick path (`load_markets`).
- **Ephemeral (ER-only) accounts** hold the public round chat, which never exists on L1.
- **MagicBlock VRF** answers `request_round_seed` with a callback inside the ER.
- **`bxvm`** is a Rust crate linked into the program. It executes strategy bytecode against a host view of markets and the entrant's position.

## Accounts

Sizes are the on-chain data lengths observed on the local stack (they include the 8-byte discriminator). Zero-copy accounts (`#[account(zero_copy)]`) are read and written in place through `AccountLoader`, never copied onto the 4 KB SBF stack.

| Account | Seeds (program `BXAb…dx27`) | Size | Delegated | Visibility during the round | Layout |
|---|---|---|---|---|---|
| `ProtocolConfig` | `["config"]` | 80 | no (L1 only) | public | admin, usdc_mint, protocol_fee_bps, paused, round_count, bump |
| `Round` | `["round", id as u32 LE]` | 653 | yes | public | status, mode, markets[8] config (feed, decimals, max_leverage, maintenance_bps, spreads, oi_cap), mystery_market, entry_fee, min/max margin, tick_interval_ms, duration_ticks, tick, step_limit, entrant/settled counts, `open_licenses`, live flag, vrf_seed, vrf_ready, pot, vault_balance, total_equity, timestamps, protocol and license fee bps, validator |
| `Scoreboard` (zero-copy) | `["board", round]` | 5680 | yes | public in lit rounds; program-only in dark rounds | n, finalized, entries[64] {owner, equity, deposited, trades, alive, rank, strategy_hash} |
| `Market` (zero-copy) | `["mkt", round, index as u8]` | 704 | yes | public | feed, oi_cap, oi_long, oi_short, funding_index, funding_rate_bps, mark, last_publish_time, last_tick, ring[64] of marks, ring_pos, ring_len, ema8, ema21, ema55, vol, maintenance/spread params, max_leverage, decimals |
| `Entrant` | `["ent", round, owner]` | 137 | yes | public | owner, index, batch/slot, joined_at, alive, deposited, strategy_hash (written at settlement), strategy_version, fee_price_bps, license_count, privatized, settled, hall_recorded |
| `Strategy` (zero-copy) | `["strat", round, owner]` | 4192 | yes | **private: owner only** | updated_tick, version, step_limit, len, bytecode[4096] |
| `Position` (zero-copy) | `["pos", round, owner]` | 528 | yes | **private: owner only** | margin, realized_pnl, legs[8] {size, entry, funding_index, side}, mem[16], Sharpe accumulators (`sum_ret`, `sum_ret_sq`, `ret_n`), last_equity, peak_equity, `ran_tick` (once-per-tick guard), trade_count, last_steps, last_fault, last_fault_pc, liquidated |
| `Hall` | `["hall", wallet]` | 66 | no (L1 only) | public | rounds, wins, podiums, total_pnl, elo (starts at 1000), best_rank |
| `License` (zero-copy) | `["lic", round, buyer, author]` | 560 | yes | **private: buyer + author** | round, buyer, author, margin, realized_pnl (net of fees), legs[8], mem[16] (the author's strategy memory, separate per licensee), accrued_fees, opened_tick, last_equity, peak_equity, `ran_tick`, trade_count, fee_bps (locked at activation), active, liquidated, settled, last_fault |
| Round chat | `["chat", round]` | 4104 | ER-only (ephemeral account, never on L1) | public | head u32, count u32, then 32 slots of 128 bytes: author 32, tick u64, unix ts i64, len u8, text 79 |
| Mock price feed (local only) | `["mockfeed", authority, feed_id as u32 LE]` | 134 | yes | public | Byte-identical to a Pyth Lazer price account; accepted as a market feed only by the `local-oracle` build. |

Accounts owned by other programs:

| Account | Owner | Purpose |
|---|---|---|
| Round vault ATA `ata(mint, round)` and its ephemeral ATA | SPL Token / Ephemeral SPL | Holds the entry-fee pot and absorbed losses. The ephemeral ATA is initialized and delegated to the round's validator in `create_round`, so the TEE exposes a spendable token account at the ATA address. |
| Entrant custody ATA `ata(mint, entrant)` and its ephemeral ATA | SPL Token / Ephemeral SPL | Holds the entrant's margin. Delegated in `join_round`. |
| License custody ATA `ata(mint, license)` and its ephemeral ATA | SPL Token / Ephemeral SPL | Holds a licensee's margin, separate from any book the buyer runs themselves (a backer does not have to be an entrant). Initialized and delegated in `open_license`. |
| Permission PDAs `permissionPdaFromAccount(strategy / position / license / scoreboard)` | Permission program `ACLseo…Qnp1` | Ephemeral permissions: one member (the owner) on Strategy and Position, two (buyer and author) on a License, none on a dark Scoreboard. Each is paid for and controlled by the account it gates (the program signs with that account's seeds), so only the BLACKBOX program can change who may read it. |
| Pyth Lazer price accounts | Oracle program `PriCems…jppd` | 134 bytes; `price` i64 at offset 73, `publish_time` i64 at offset 93, 8 decimals (verified on devnet-tee, see `docs/design/verification.md` bet 1b). |

Fixed capacities (`constants.rs`): 8 markets, 64 entrants, 64-entry mark ring, 16 VM memory slots, 4096-byte bytecode, 8 licenses per author, 32 chat messages of at most 79 printable bytes.

## Instructions

Signer names are the account names in the instruction's `Accounts` struct. "Anyone" means any wallet willing to pay the transaction fee.

### Solana L1

| Instruction | Signer | Requires | Effect |
|---|---|---|---|
| `init_protocol(protocol_fee_bps)` | admin | fee ≤ 2000 bps | Creates `ProtocolConfig` with the USDC mint. |
| `create_round(args)` | admin (config admin) | not paused; `min_margin > 0`, `max_margin ≥ min_margin`, `tick_interval_ms ≥ 100`, `duration_ticks > 0`, `1 ≤ step_limit ≤ 4096`, license fee bounds ≤ 1000 bps | Creates Round (`Created`), Scoreboard, the vault ATA; pre-funds the Scoreboard with permission rent and the Round with permission rent **plus the round chat's rent** (the Round sponsors the chat); initializes and delegates the vault's ephemeral ATA to `validator`; pins the round to `validator`. |
| `add_market(index, cfg)` | admin | status `Created`; `index == n_markets < 8`; `1 ≤ max_leverage ≤ 100`; `50 ≤ maintenance_bps ≤ 5000`; `oi_cap > 0`; `decimals ≤ 12` | Stores the market config on the Round and creates the Market account bound to the price feed. |
| `open_round` | admin | status `Created`, at least one market | Status `Open`. |
| `join_round` | owner | status `Open`, fewer than 64 entrants | Creates Entrant, zeroed Strategy and Position, and the custody ATA; pre-funds permission rent on Strategy, Position and Entrant; initializes and delegates the custody ephemeral ATA. |
| `delegate_entrant` | owner | round's validator matches | Delegates Entrant, Strategy, Position with `commit_frequency_ms = u32::MAX`. |
| `delegate_market(round_id, index)` | admin | | Delegates one Market with `commit_frequency_ms = u32::MAX`. |
| `delegate_round(round_id)` | admin | round admin, status `Open`, validator matches | Delegates Round and Scoreboard with `commit_frequency_ms = u32::MAX`. |
| `open_license` | buyer | round status not `Settling`/`Settled`; mint matches the round; `author_entrant` is the author's Entrant PDA for this round and belongs to `author`; buyer ≠ author | Creates the License and its custody ATA; pre-funds the rent of a two-member permission; initializes and delegates the License's ephemeral ATA to the round's validator. |
| `delegate_license` | buyer | validator matches the round's | Delegates the License with `commit_frequency_ms = u32::MAX`. |
| `init_hall` | payer | | Creates (idempotently) a wallet's Hall with ELO 1000. |
| `record_hall` | none | round `Settled` and committed, scoreboard finalized, not yet recorded | Folds one entrant's rank and PnL into their Hall. |

### Ephemeral Rollup (TEE)

| Instruction | Signer | Requires | Effect |
|---|---|---|---|
| `privatize_entrant` | owner | | Creates permissions on Strategy and Position: private, one member (the owner) with `TX_LOGS`, `TX_MESSAGE`, `TX_BALANCES`. Sets `entrant.privatized`. |
| `set_strategy(bytecode)` | owner | status `Open` or `Live`; entrant privatized; length ≤ 4096; `bxvm::validate(bytecode, n_markets)` passes | Writes the bytecode, bumps `version` (also mirrored to the public `Entrant.strategy_version`), records `updated_tick`. Used for the first upload and for hot-swaps. |
| `fund_entrant(margin)` | owner | status `Open`; total deposit within `[min_margin, max_margin]` | First call moves `entry_fee` from the owner's ER token account to the vault (pot and vault_balance grow); moves `margin` to custody; credits `Position.margin`. |
| `set_scoreboard_privacy(private)` | admin | | Creates or updates the Scoreboard permission with no members. `private = true` makes it program-only (dark round). |
| `start_round` | admin | status `Open`, at least one entrant | Status `Live`, `live = true`, `tick = 0`. |
| `request_round_seed(client_seed)` | payer | status `Live`, seed not set | Requests randomness from the VRF queue with a callback to `round_seed_callback`. |
| `round_seed_callback(randomness, client_seed)` | VRF program identity | | Stores `vrf_seed`, sets `vrf_ready`, `mystery_market = randomness[0] % n_markets`. |
| `schedule_clock(task_id)` | admin | status `Live` | Schedules `tick_clock` every `tick_interval_ms` for `duration_ticks + crank_slack` iterations, where `crank_slack = duration_ticks / 10 + 20`: a crank that lags wall time still reaches the last tick, and the extra iterations are no-ops. |
| `schedule_entrant_tick(task_id)` | anyone | status `Live`; remaining accounts are exactly `[market_i, feed_i]` for every market, checked against PDAs and the Round's feeds | Schedules `tick_entrant` for this entrant for the rest of the round (`duration_ticks - tick + crank_slack` iterations). |
| `tick_clock` | none (the crank; any caller is accepted) | `live`, and the new tick must not exceed `(now - started_at) + 1 s` divided by `tick_interval_ms` | Increments `tick`; at `duration_ticks` sets `live = false`, status `Settling`, `ended_at`. Returns without writing anything if the round is not live or the tick would run ahead of wall time. |
| `tick_entrant` | none (the crank; any caller is accepted, see `BlackboxClient.tickEntrant`) | `live`; `position.ran_tick != tick + 1` | The core loop, described below. Runs at most once per round tick; a replay returns early. |
| `activate_license(margin)` | buyer | status `Open` or `Live`; `min_margin ≤ margin ≤ max_margin`; the author has fewer than 8 licenses; not already active | Creates the License permission (private, members buyer and author), moves `margin` from the buyer's ER token account into the License's custody, locks `fee_bps` at `max(author.fee_price_bps, round.license_fee_min_bps)`, sets `opened_tick`, and increments `author.license_count` and `round.open_licenses`. |
| `schedule_license_tick(task_id)` | anyone (payer) | status `Live`; remaining accounts are exactly `[market_i, feed_i]` per market | Schedules `tick_license` for this license for the rest of the round, like an entrant tick. |
| `tick_license` | none (the crank; any caller is accepted) | `live`; the Strategy belongs to the author's Entrant and to this round; license active, not liquidated, `ran_tick != tick + 1` | Runs the **author's** private bytecode against the **buyer's** private License book. Same path as `tick_entrant` (`run_book`) with a fee on traded notional; `RAND` is derived from the buyer's key. Writes nothing public. |
| `settle_license` | anyone (payer) | round not live, status `Settling`; license not settled | Closes the license's legs at the final marks, settles trading PnL against the vault, pays the author the accrued fees, returns the rest to the buyer, decrements `open_licenses`, scrubs the License and closes its permission. |
| `undelegate_license` | anyone (payer) | the License body is all zeros | Commits and undelegates the License. |
| `post_chat(text)` | anyone | status `Open` or `Live`; 1-79 bytes, all printable | Writes one message into the round chat, an ephemeral account sponsored by the Round; the first post creates it. |
| `close_chat` | admin | round not live and not `Open` | Closes the chat account and refunds its rent to the Round, before `close_round` commits. |
| `seed_vault(amount)` | any funder | status `Open` or `Live`; `amount > 0` | Moves USDC from the funder's ER token account into the round vault and adds it to `vault_balance` (the public solvency beacon). |
| `sweep_vault` | admin | status `Settling`, prizes paid, every entrant settled, `open_licenses == 0` | Sends the whole remaining vault balance to a token account of the admin's choice; sets `vault_balance` and `pot` to 0. |
| `settle_entrant` | anyone | status `Settling`, entrant not settled | Final close, USDC flows, hash publication, scrub (permissions stay open). Described below. |
| `undelegate_entrant` | anyone | entrant settled; Strategy and Position bodies all zero | Commits and undelegates Entrant, Strategy, Position. |
| `rank_round` | anyone | status `Settling`, every entrant settled, not finalized | Ranks by return on deposit; sets `finalized`. |
| `pay_prizes` | anyone | scoreboard finalized, not yet paid; remaining accounts are the winners' token accounts in rank order | Pays the prize split from the vault. |
| `close_round` | anyone | prizes paid; `open_licenses == 0` (a license's custody can only settle while the round is on the ER) | Status `Settled`, then commits and undelegates Round, Scoreboard and the Markets passed as remaining accounts. |

### Injected by the MagicBlock SDK

`process_undelegation` is added to the program by the `#[ephemeral]` macro. The delegation program calls it on L1 when a delegated account is undelegated, to hand the account's committed data back to the BLACKBOX program. It is not called directly.

### Local development only

`init_mock_feed(feed_id, raw_price, decimals)` and `delegate_mock_feed(feed_id)` on L1, `set_mock_feed(raw_price, decimals)` on the ER. A mock feed is a program-owned account with the Pyth Lazer layout; its authority is stored in the `write_authority` bytes and checked on every update. Only a build with the `local-oracle` feature accepts program-owned feeds in `oracle::read_price`, so these instructions are inert on devnet.

## The tick loop

Three kinds of Native Crank task run for a live round, all at `tick_interval_ms` (400 ms in the e2e test, 500 ms in the running local round):

- **One clock task** (`schedule_clock`) runs `tick_clock`, the round's only clock. Round timing counts ticks, but the clock may not run ahead of wall time (below).
- **One task per entrant** (`schedule_entrant_tick`) runs `tick_entrant` with accounts `[round, scoreboard, entrant, strategy, position]` plus `[market_i, feed_i]` for every market. A strategy that faults or runs out of steps affects only its own task.
- **One task per license** (`schedule_license_tick`) runs `tick_license` with accounts `[round, author_entrant, strategy, license]` plus the same market and feed pairs. It runs the author's bytecode against the licensee's book and touches nothing public.

The tasks are independent schedules at the same interval, so an entrant or license tick runs against whatever `round.tick` is current when it lands. Every task no-ops once `round.live` is false. Each task is scheduled for the round's remaining ticks plus `crank_slack = duration_ticks / 10 + 20` iterations, so a crank that drifts behind wall time still reaches the last tick; iterations after the round ends do nothing. The scheduled instruction deserializes the Round and Entrant raw from `UncheckedAccount` (the crank pattern) and writes them back explicitly.

**Caller checks.** None of `tick_clock`, `tick_entrant` or `tick_license` requires a signer: any wallet can send them on the rollup, not only the crank. Two guards make that harmless.

- **The clock is bounded by wall time.** `tick_clock` refuses to advance if `round.tick` already covers the time elapsed since `start_round`: the tick may not exceed `((now - started_at) × 1000 + 1000) / tick_interval_ms`. A spammer cannot run a round to `duration_ticks` early and force settlement; the one-second allowance is there because `unix_timestamp` has one-second resolution.
- **One run per book per tick.** `Position.ran_tick` and `License.ran_tick` hold the tick of the last execution plus one. A second `tick_entrant` or `tick_license` for the same book in the same round tick returns immediately, so a rival cannot re-run someone's strategy against its own VM memory, make it trade more often, or push extra zero-return samples into the Sharpe accumulators the blind price is computed from.

See [DISCLOSURES](DISCLOSURES.md) items 34-35 for what remains after these guards.

`tick_entrant`, step by step (`programs/blackbox/src/instructions/tick.rs`):

1. **Markets.** For each market, check the Market belongs to this round and has the right index. If this is the first entrant to arrive for the current tick (`last_tick < tick`) or the market has no mark yet, read the oracle (`oracle::read_price`: key matches the configured feed, owner is the oracle program, price > 0, published at most 5 s ago, scaled from the feed's known decimals to 6 decimals) and update indicators: push the mark into the 64-entry ring, update EMA(8), EMA(21), EMA(55) (`ema += (mark - ema) * 2 / (n + 1)`, seeded with the first mark), recompute realized volatility over the ring. Every 240 ticks, accrue funding. A stale or invalid oracle fails the whole transaction, so that entrant skips the tick.
2. **Load private state.** Deserialize the Entrant; load the Strategy (read-only) and Position; check owners and round. If `position.ran_tick == tick + 1` this tick has already run for this entrant: return. Otherwise claim the tick by setting `ran_tick`.
3. **Equity.** `margin + realized_pnl + Σ unrealized - Σ funding owed` at the current marks.
4. **Run the strategy** if the entrant is alive, not liquidated, has margin, and has code. The host exposes marks, EMAs, returns, volatility, the entrant's legs, equity, free margin (`equity - Σ size_i / max_leverage_i`, floored at 0), the tick, and a per-tick random value. The step limit is `min(strategy.step_limit, round.step_limit)`. On a fault, record `last_fault = fault + 1` and `last_fault_pc` and apply nothing. Otherwise apply each emitted action in order through the perps engine, recomputing equity after each.
5. **Maintenance.** If equity is below `Σ size_i * maintenance_bps_i / 10_000`, close every leg at fill prices, set `liquidated`, mark the entrant not alive. If equity is still negative, the vault absorbs the shortfall: `realized_pnl = -margin`, equity 0.
6. **Accumulators and blind price.** Per-tick return `(equity - last_equity) / last_equity` into `sum_ret`, `sum_ret_sq`, `ret_n`; update `last_equity` and `peak_equity`. Then recompute `Entrant.fee_price_bps` from those private accumulators (see [Blind licensing](#blind-licensing)): the accumulators stay in the private Position, only the price is published.
7. **Publish.** Write the Entrant back; write `equity`, `deposited`, `alive`, `trades` into the entrant's Scoreboard entry; recompute `round.total_equity` as the sum of all Scoreboard equities; write the Round back.

Nothing about the strategy, its legs or its memory leaves the private accounts. The public outputs of a tick are the Scoreboard entry, the Round's total equity and the Markets (marks, indicators, open interest).

## The VM

`crates/bxvm` is `no_std` with no allocation: fixed stack, fixed action list, `#![deny(unsafe_code)]`.

- **Values.** Every value is an `i64` in fixed point with 6 decimals: `1.0 = 1_000_000` (the same scale as USDC). Booleans are `1.0` and `0`.
- **Encoding.** A blob is a version byte (`1`) followed by instructions: one opcode byte plus fixed little-endian operands. Jump targets are absolute byte offsets into the code after the version byte.
- **Machine.** Stack of 64 values; 16 persistent memory slots stored in the private `Position.mem`; at most 8 actions per tick; a hard step limit (default 512, the round sets it, maximum 4096).
- **Validation** (`bxvm::validate`, run by `set_strategy`): version byte, length ≤ 4096, every opcode known and complete, jump targets on an instruction boundary (or exactly the end of code), market operands `< n_markets`, EMA window index `< 3`, return lookback `1..=64`, memory slot `< 16`, size bps `1..=10_000`. The SDK ships a byte-identical TypeScript validator, assembler and disassembler (`packages/sdk/src/vm.ts`), pinned by a parity test against the Rust crate.
- **Halting.** `HALT` or falling off the end of the code is a normal stop; the emitted actions are applied.

### Opcodes

`a b` in the stack column means `b` is on top. Arithmetic saturates at the `i64` range; `MUL` and `DIV` use an `i128` intermediate.

| Code | Mnemonic | Operands | Stack | Semantics |
|---|---|---|---|---|
| 0 | `NOP` | | | Nothing. |
| 1 | `HALT` | | | Stop normally. |
| 2 | `PUSH` | i64 (8 bytes) | `-> v` | Push an immediate. |
| 3 | `DUP` | | `a -> a a` | |
| 4 | `SWAP` | | `a b -> b a` | |
| 5 | `POP` | | `a ->` | |
| 6 | `ADD` | | `a b -> a+b` | Saturating. |
| 7 | `SUB` | | `a b -> a-b` | Saturating. |
| 8 | `MUL` | | `a b -> a*b/1e6` | Fixed-point multiply. |
| 9 | `DIV` | | `a b -> a*1e6/b` | Fixed-point divide; `b = 0` faults `DivByZero`. |
| 10 | `NEG` | | `a -> -a` | Saturating. |
| 11 | `ABS` | | `a -> abs(a)` | Saturating. |
| 12 | `MIN` | | `a b -> min` | |
| 13 | `MAX` | | `a b -> max` | |
| 14 | `LT` | | `a b -> a<b` | `1.0` or `0`. |
| 15 | `GT` | | `a b -> a>b` | |
| 16 | `EQ` | | `a b -> a==b` | |
| 17 | `AND` | | `a b -> a&&b` | Non-zero is true. No short circuit. |
| 18 | `OR` | | `a b -> a\|\|b` | |
| 19 | `NOT` | | `a -> !a` | `1.0` if `a == 0`, else `0`. |
| 20 | `JMP` | u16 target | | Unconditional jump. |
| 21 | `JZ` | u16 target | `a ->` | Jump if `a == 0`. |
| 22 | `JNZ` | u16 target | `a ->` | Jump if `a != 0`. |
| 23 | `PRICE` | market u8 | `-> mark` | Mark price, USDC 6dp. `NoData` if the market has no mark. |
| 24 | `EMA` | market u8, window u8 | `-> ema` | Window index 0, 1, 2 selects EMA(8), EMA(21), EMA(55) of the mark. `NoData` before the first mark. |
| 25 | `RET` | market u8, lookback u8 | `-> r` | Return over the last `n` ticks (`1..=64`) as a fraction (`0.01 = 10_000`). `0` until the ring has enough history. |
| 26 | `VOL` | market u8 | `-> vol` | Realized volatility over the ring, fraction per tick. |
| 27 | `POS` | market u8 | `-> notional` | Signed notional of the entrant's leg (positive long, negative short, 0 flat). |
| 28 | `ENTRY` | market u8 | `-> px` | Entry price of the leg, 0 if flat. |
| 29 | `EQUITY` | | `-> equity` | Equity at current marks. |
| 30 | `FREEMARGIN` | | `-> free` | Free margin: equity minus initial margin in use, floored at 0. |
| 31 | `TICK` | | `-> tick` | Round tick (a plain integer). |
| 32 | `RAND` | | `-> r` | Per-tick value in `[0, 1.0)`: `sha256(vrf_seed, owner, tick)` mod 1e6. |
| 33 | `MLD` | slot u8 | `-> mem[i]` | Load a persistent memory slot. |
| 34 | `MST` | slot u8 | `a ->` | Store into a persistent memory slot. |
| 35 | `LONG` | market u8, bps u16 | | Emit: target a long of `bps` of buying power. |
| 36 | `SHORT` | market u8, bps u16 | | Emit: target a short of `bps` of buying power. |
| 37 | `CLOSE` | market u8 | | Emit: close the leg. |
| 38 | `CLOSEALL` | | | Emit: close every leg. |
| 39 | `LE` | | `a b -> a<=b` | |
| 40 | `GE` | | `a b -> a>=b` | |
| 41 | `MOD` | | `a b -> a rem b` | Remainder of the raw integers; `b = 0` faults `DivByZero`. |

The SDK disassembler prints mnemonics in lower case with operands decoded: `ema m0 w8` shows the window length, `long m0 3000bps` the size, `jz @34` the target offset.

### Faults

A fault stops execution and **discards every action** from that tick: a broken strategy never trades. Memory writes made before the fault are kept (useful for debugging). The code is stored in the private `Position.last_fault` as the fault's index plus one (0 means no fault), with `last_fault_pc`.

| `last_fault` | Fault | Cause |
|---|---|---|
| 1 | `BadVersion` | First byte is not `1`. |
| 2 | `BadOpcode` | Unknown opcode byte. |
| 3 | `Truncated` | Operands run past the end. |
| 4 | `StackUnderflow` | Pop from an empty stack. |
| 5 | `StackOverflow` | More than 64 values. |
| 6 | `DivByZero` | `DIV` or `MOD` by zero. |
| 7 | `BadJump` | Jump target beyond the code. |
| 8 | `BadMarket` | Market operand `≥ n_markets`. |
| 9 | `BadOperand` | EMA window, lookback, memory slot or size out of range. |
| 10 | `StepLimit` | Step limit reached. |
| 11 | `TooManyActions` | More than 8 actions in one tick. |
| 12 | `NoData` | The host had no value (market without a mark or EMA yet). |

Validated bytecode cannot produce faults 1-3 or 7-9; they exist because the executor never trusts its input (a pseudo-fuzz test runs 2,000 random programs).

### Sizing semantics

`LONG m bps` and `SHORT m bps` are **targets**, not orders. The target signed notional is

```
target = equity × max_leverage(m) × bps / 10_000        (negated for SHORT)
```

so `LONG 0 10000` asks for the maximum the market allows and `LONG 0 3000` on a 20x market asks for 6x equity. The engine then moves the leg from its current signed notional to the target (see below). An action changes the book only when the target differs from the current leg; because equity moves every tick, a strategy that re-emits `LONG` every tick will rebalance a little every tick and pay spread each time. The built-in strategies (`packages/sdk/src/strategies.ts`) act only on state changes (flat to in, side flips). `CLOSE` targets 0. A rejected increase (leverage or open-interest cap) is skipped silently; the tick continues.

## Perps engine

`programs/blackbox/src/perps.rs`: pure functions over `Market`, `Leg` and margin. Units: prices and USDC are 6-decimal integers; fractions (spread, skew, returns, volatility) are 6-decimal fractions; `*_bps` are basis points.

- **Legs are notional-denominated.** A leg stores `size` (USDC notional at entry), `entry` (fill price) and `side` (+1, -1, 0). Unrealized PnL is linear in the return: `side × size × (mark - entry) / entry`.
- **Skew** of a market: `(oi_long - oi_short) / oi_cap`, clamped to `[-1, 1]`.
- **Spread:** `base_spread_bps / 10_000`, plus `skew_spread_bps × |skew| / 10_000` when the trade increases the skew (buying into a long-heavy market or selling into a short-heavy one), capped at 20%.
- **Fill price:** `mark × (1 + spread)` when buying, `mark × (1 - spread)` when selling. Closing a long sells; closing a short buys.
- **`trade_to_target(target)`:**
  1. If `target` equals the current signed notional, do nothing.
  2. Settle funding accrued on the existing leg into realized PnL and reset its funding index.
  3. If `|target|` exceeds the current `|notional|`, require `|target| + notional of all other legs ≤ equity × this market's max_leverage`. Reducing or closing is always allowed, even for an underwater book.
  4. **Reduce** toward zero (a flip first reduces to zero): realize `closed × side × (fill - entry) / entry` at the closing side's fill price.
  5. **Increase** away from zero: require the side's open interest plus the added notional `≤ oi_cap`; a fresh leg takes the fill as entry, an existing one takes the notional-weighted average `(old × entry + added × fill) / (old + added)`.
  6. Apply the open-interest deltas to the Market. Count one trade if anything moved.
- **Funding:** every 240 ticks, `funding_index += skew × 10 bps` (a fully long-skewed market charges longs 10 bps of notional per period). A leg owes `side × size × (funding_index - leg.funding_index)`, which equity subtracts continuously and `trade_to_target` realizes. `funding_rate_bps` on the Market is the last period's rate, rounded to whole bps.
- **Equity:** `margin + realized_pnl + Σ unrealized - Σ funding owed`.
- **Maintenance requirement:** `Σ size × maintenance_bps / 10_000`. Liquidation is checked inside the same tick as the strategy (no separate sweep).
- **Realized volatility:** `sqrt(mean(r_i²))` over consecutive returns in the 64-mark ring (per tick, not annualized).
- **Counterparty:** there is no order book and no external liquidity. Every fill is against the round vault, which collects spread and the losses of losing entrants and pays the profits of winning ones at settlement. See [Settlement and prizes](#settlement-and-prizes) and [DISCLOSURES](DISCLOSURES.md).

## Privacy design

**Permissions.** `privatize_entrant` creates one ephemeral permission per private account through the permission program, with `is_private = true` and a single member (the owner) carrying `TX_LOGS`, `TX_MESSAGE` and `TX_BALANCES`. The gated PDA is both the rent payer and the permission's authority; the program signs with the PDA's seeds, so no wallet (including the admin) can add a reader. The TEE RPC then returns the account only to the owner's auth token, and returns `null` to requests with no token or with any other wallet's token. `TX_MESSAGE` hides the instruction data of transactions that touch the account from non-members, which covers the `set_strategy` transaction that carries the bytecode.

**Order of operations.** `set_strategy` is rejected until `entrant.privatized` is set, so bytecode can never be written to a Strategy that is still public.

**Nothing on L1 in plaintext.** The Strategy is created on L1 with a zeroed body and delegated before any bytecode exists; the bytecode arrives only in ER transactions. The e2e test checks that the L1 copy's bytecode region (offset 96 onward) is all zero after delegation.

**`commit_frequency_ms = u32::MAX`.** Every delegation in the program (`NEVER_AUTO_COMMIT_MS`) disables timer commits, so the ER never writes a private account back to L1 on its own. The spike verified that a secret written on the ER does not appear in the L1 copy.

**Scrub before commit.** `settle_entrant` zeroes every byte after the discriminator of Strategy and Position (`privacy::scrub`) and leaves both permissions open. The permission redacts more than the account: it also hides the message of every rollup transaction that touched it, so closing it at settlement would expose the `set_strategy` uploads in rollup history to anyone with a TEE token. Nothing needs to recreate these permissions, because Strategy and Position PDAs carry the round key in their seeds and are never re-delegated. The spike's finding still holds — a permission survives `commit_and_undelegate` and keeps enforcing privacy, but blocks creating a new one on the same account.

**The undelegate guard.** `undelegate_entrant` refuses to run unless the entrant is settled and both private bodies are all zeros. A bug elsewhere cannot commit a live strategy to L1 through this path.

**What stays verifiable.** Before scrubbing, `settle_entrant` writes `sha256(bytecode[..len])` into the public Entrant and the Scoreboard. Anyone who is later shown the code can check it against the hash; the e2e test checks the published hash against the final bytecode.

**Money.** Custody and vault token accounts on the TEE are synthesized SPL accounts at the ATA addresses; the TEE shows a token account only to its owner's token (spike bet 3). Balances therefore stay private by default, and the program exposes only aggregates: `Round.pot`, `Round.vault_balance`, `Round.total_equity`, and per-entrant `deposited` and `equity`.

**Licenses.** `activate_license` creates the License permission before any state goes in, with two members: the buyer and the author (`privacy::read_member` for each, same flags). The buyer therefore reads their own book and the author reads every book running on their strategy, while everyone else gets `null`. The Strategy permission is untouched — it still lists only the author — so the buyer's capital trades on code the buyer cannot read. The e2e test checks both directions: the backer reads its own License, the author reads it too, a stranger gets `null`, and the backer's token reading the author's Strategy gets `null`.

**The chat is deliberately public.** The round chat has no permission at all. It is an ephemeral account, so it exists only on the rollup and its contents never reach L1.

**Dark rounds.** `set_scoreboard_privacy(true)` gives the Scoreboard a permission with no members: only the program can read it until `close_round` commits it to L1. The Round (including `total_equity`), Markets and Entrants stay public.

## Blind licensing

A backer puts up margin and the crank runs an author's sealed bytecode against the backer's own book. The buyer never receives the code.

**Lifecycle** (`instructions/license.rs`): `open_license` (L1) creates the License and its custody accounts; `delegate_license` (L1) hands it to the round's validator with `commit_frequency_ms = u32::MAX`; `activate_license` (ER) creates the two-member permission, takes the margin and locks the fee; `schedule_license_tick` puts it on the crank; `tick_license` runs it every tick; `settle_license` closes and pays out; `undelegate_license` commits zeros to L1.

**Who reads what.** The License permission lists the buyer and the author. The Strategy permission still lists only the author. The author's Entrant, which carries the public price and license count, is public.

**The tick.** `tick_license` loads the author's Strategy read-only, checks that it belongs to the author's Entrant and to this round, then calls the same `run_book` as `tick_entrant` with the License's legs, memory, realized PnL and trade count. Differences from an entrant tick: the fee is non-zero, the per-tick `RAND` is derived from the buyer's key rather than the author's, and nothing is written to the Scoreboard or the Round.

**The fee.** `BookMut.fee_bps` is charged on the absolute change in a leg's signed notional whenever a trade actually moves the book: `fee = |after - before| × fee_bps / 10_000`. It is added to `License.accrued_fees` and subtracted from `License.realized_pnl`, so the licensee pays it out of their own performance and the vault never sees it.

**Blind pricing** (`tick::blind_price`, called at the end of every `tick_entrant`): from the private accumulators `sum_ret`, `sum_ret_sq` and `ret_n`,

```
mean   = sum_ret / n                       (1e6-scaled fraction)
var    = sum_ret_sq / n - mean² / 1e6
std    = sqrt(var × 1e6)
sharpe = mean × 100 × sqrt(n) / std        (Sharpe × 100)
score  = clamp(sharpe, 0, 300)
price  = license_fee_min_bps + (license_fee_max_bps - license_fee_min_bps) × score / 300
```

with `n < 20` (or `max ≤ min`) giving the minimum, and a zero variance giving the maximum if the mean is positive and the minimum otherwise. The result is written to the public `Entrant.fee_price_bps`; the series it came from stays in the private Position. `activate_license` locks `max(fee_price_bps, license_fee_min_bps)` into the License, so a later move in the author's price does not change an existing license.

**Settlement** (`settle_license`): close every leg at the final marks; `trading_pnl = realized_pnl + accrued_fees` (fees were already charged into `realized_pnl`) settles against the vault — a loss moves `min(|pnl|, custody balance)` from custody to the vault, a profit moves `min(pnl, vault balance - pot)` the other way; then `min(accrued_fees, custody balance)` goes to the author's token account and the remainder to the buyer's. The License is scrubbed, its permission closed, `open_licenses` decremented, and a `LicenseSettled` event emitted. `close_round` and `sweep_vault` both require `open_licenses == 0`, so no license custody can be stranded on the rollup.

**Caps.** At most 8 licenses per author (`MAX_LICENSES_PER_AUTHOR`, `LicenseLimit`), margin within the round's `[min_margin, max_margin]`, and a buyer may not license themselves.

## Round chat

`instructions/chat.rs` is BLACKBOX's use of MagicBlock **ephemeral accounts**: an account that is created on the rollup and never exists on L1. The chat PDA is `["chat", round]`, sponsored by the delegated Round PDA — `create_round` pre-funds the Round with exactly `rent(CHAT_SIZE)` for it — and created lazily by the first `post_chat`.

The layout is a ring buffer: `head u32`, `count u32`, then 32 slots of 128 bytes (`author 32 | tick u64 | unix ts i64 | len u8 | text 79`). `post_chat` requires the round to be `Open` or `Live` and the text to be 1-79 bytes, every byte printable (`>= 0x20` and not `0x7f`); it overwrites the slot at `head` and advances it. Any wallet can post, and reads are public — there is no permission on the account.

`close_chat` (admin, once the round is no longer live and no longer `Open`) closes the account and refunds its rent to the Round before `close_round` commits. The e2e test checks both that anyone can read the chat and that the account does not exist on L1.

## House bankroll

The round vault is the counterparty of every book, so what it holds decides whether a profitable entrant can be paid in full (see [Settlement and prizes](#settlement-and-prizes)).

`seed_vault` (`instructions/vault.rs`) lets **any** funder move USDC from their ER token account into the round vault while the round is `Open` or `Live`, and counts it in `Round.vault_balance` — the public solvency beacon that clients compare against `total_equity + pot`. `scripts/run-round.ts` seeds 2,000 test USDC per round from a fresh house wallet (a wallet's first ER deposit is the reliable path) and records it in the round file.

`sweep_vault` (admin) sends whatever is left — bankroll, net trading losses and the protocol fee — to a token account it chooses, and zeroes `vault_balance` and `pot`. It requires status `Settling`, prizes paid, every entrant settled and `open_licenses == 0`, so it cannot run while someone is still owed money on the rollup.

## Settlement and prizes

`tick_clock` flips the round to `Settling` at `duration_ticks`. Settlement instructions are permissionless, so the order is whatever order they are sent in; the runner uses licenses first, then entrants **losers-first** in lit rounds (by `equity - deposited` from the final scoreboard), so profits are paid out of losses that are already in the vault. Then, per entrant (`settle_entrant`):

1. Close every open leg at the final marks through `trade_to_target(0)` (closing fill, funding settled), accumulating realized PnL. Final equity is `max(0, margin + realized_pnl)`.
2. Move real USDC on the ER, PDA-signed:
   - loss: `min(|realized_pnl|, custody balance)` from custody to the vault;
   - profit: `min(realized_pnl, vault balance - pot)` from the vault to custody (the pot is reserved for prizes);
   - then the whole custody balance to the owner's token account.
3. Write `sha256(final bytecode)` and the final equity to the Entrant and Scoreboard; mark the entrant settled and not alive.
4. Scrub Strategy and Position; leave their permissions in place so the uploads stay redacted.

`undelegate_entrant` then commits and undelegates the Entrant and the scrubbed Strategy and Position.

**Ranking** (`rank_round`, once every entrant is settled): by return on deposit, `equity / deposited` (the entry fee is not part of the deposit). Entrants with no deposit rank last; ties go to the lower index.

**Prizes** (`pay_prizes`): `fee = pot × protocol_fee_bps / 10_000` (500 bps in the scripts), `distributable = pot - fee`, split 50% / 30% / 20% to ranks 1-3. With fewer than three entrants the unused shares go to first place. Prizes are SPL transfers from the vault to the winners' token accounts on the ER. Afterwards `Round.pot` holds the protocol fee, which stays in the vault until `sweep_vault` moves it out with the rest. In the e2e runs, 4 entrants × 5 USDC entry fee paid 9.5, 5.7 and 3.8 USDC, and the devnet sweep returned 503.399664 USDC of bankroll, net losses and protocol fee to the house wallet.

**Close** (`sweep_vault`, `close_chat`, `close_round`): the admin sweeps what is left in the vault and closes the chat (refunding its rent to the Round), then `close_round` sets status `Settled` and commits and undelegates Round, Scoreboard and Markets. `close_round` refuses while `open_licenses > 0`. Winners and everyone else withdraw their USDC from the ER to L1 with Ephemeral SPL (`BlackboxClient.withdrawFromEr`: undelegate the ephemeral ATA on the ER, then `withdrawSpl` on L1). This path is implemented in the SDK but not covered by the e2e test.

**Hall of Fame** (`record_hall`, L1): increments rounds, wins (rank 1), podiums (rank ≤ 3), adds `equity - deposited` to total PnL, keeps the best rank, and updates ELO with K = 32 against a mid-table expectation: `score = (n - rank) × 1000 / (n - 1)`, `elo += 32 × (score - 500) / 1000`. A 4-entrant winner gains 16 (1000 to 1016 in the e2e run).

## Compute and program size

**Compute.** A tick is scheduled work, so it has the crank's 200k CU per scheduled instruction to live in. `scripts/measure-cu.ts` simulates `tick_entrant` at random offsets inside a tick and reports the maximum: 16.8k-25.2k CU for the full path (oracle refresh, VM, perps, scoreboard) on an opt-level-3 build, 8-13% of the budget. Because of the once-per-tick guard a simulation usually lands on a tick that has already run and returns early at about 7.9k CU. The current release profile is `opt-level = "z"` and has not been re-measured.

**Size.** The release profile trades speed for size (`opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true`): 928,832 bytes for the devnet build, against 1,197,680 bytes at opt-level 3. On devnet that is 4.72 SOL of rent, and an upgrade needs a second full-size buffer while the program data stays funded. `scripts/build-program.sh` builds both variants (`local-oracle` and devnet) and refreshes the SDK's IDL and types.

## Local vs devnet

| | Local (`scripts/local-stack.sh`) | Devnet |
|---|---|---|
| Base layer | `mb-test-validator` on 8899 (preloads the delegation, permission, Ephemeral SPL, VRF and session-key programs), plus the committor program `ComtrB2KEaWgXsW1dhr1xYL4Ht4Bjj3gXnnL6KMdABq` dumped from devnet (needed to commit large accounts through buffers) and the BLACKBOX build preloaded at its program id | `https://api.devnet.solana.com` |
| Rollup | `ephemeral-validator` 0.14.10 in Docker (it needs `RLIMIT_NOFILE` 1e6, set with `--ulimit`), identity `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`; raw RPC on 7799 has no read filter and is not exposed in production | MagicBlock's TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` (Intel TDX) |
| Private reads | `query-filtering-service` on 6699: the same auth-token and permission filter, **no enclave and no attestation**; `BlackboxClient.verifyAttestation()` returns `true` without checking on local | `https://devnet-tee.magicblock.app`, TDX attestation via `verifyTeeRpcIntegrity` |
| Program build | `local-oracle` feature (`target/deploy/blackbox-local.so`) | default features |
| Prices | Mock feeds: program-owned PDAs with the exact Pyth Lazer layout, delegated to the ER. `scripts/run-round.ts` and the e2e test read real SOL, BTC, ETH prices from the devnet-tee Pyth Lazer accounts every 2 s and write them into the mock feeds every 500 ms. | Pyth Lazer accounts pushed by MagicBlock every 50-200 ms |
| VRF queue | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT`, served by two local `vrf-oracle` processes (base and ER) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| USDC | A 6-decimal test mint created by the admin | A 6-decimal test mint created by the admin (not Circle's devnet USDC) |
| Status | Full round verified, 42/42 on the same opt-level "z" build that is deployed on devnet | Program deployed (`BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27`); full round verified 42/42 on devnet + devnet-tee; primitives verified with the spike, 32/32 |

## Full round sequence

```mermaid
sequenceDiagram
  autonumber
  participant Ad as Admin
  participant En as Entrant
  participant Bk as Backer
  participant L1 as Solana L1
  participant ER as TEE rollup
  participant Cr as Native Crank
  participant Or as Pyth Lazer pusher
  participant Vr as VRF oracle
  Ad->>L1: init_protocol, create_round, add_market per market, open_round
  En->>L1: join_round, delegate_entrant
  Ad->>L1: delegate_market per market, delegate_round
  L1-->>ER: delegated accounts become writable in the rollup
  En->>L1: delegateSpl moves USDC into the rollup
  En->>ER: privatize_entrant, members = owner only
  En->>ER: set_strategy, message hidden from non-members
  En->>ER: fund_entrant, entry fee to vault, margin to custody
  Ad->>ER: seed_vault, house bankroll into the vault
  Ad->>ER: start_round
  Ad->>ER: request_round_seed
  Vr-->>ER: round_seed_callback writes vrf_seed and mystery market
  Ad->>ER: schedule_clock
  Ad->>ER: schedule_entrant_tick per entrant
  loop every tick_interval_ms until duration_ticks
    Or-->>ER: price accounts updated
    Cr->>ER: tick_clock, bounded by wall time
    Cr->>ER: tick_entrant per entrant, oracle then VM then perps then scoreboard then blind price
    Cr->>ER: tick_license per license, author's code on the buyer's book
    En->>ER: optional set_strategy hot-swap
    Bk->>ER: optional post_chat (ephemeral chat account)
  end
  Bk->>L1: open_license, delegate_license, deposit USDC
  Bk->>ER: activate_license, permission members buyer + author
  Bk->>ER: schedule_license_tick
  Note over ER: tick_clock sets status Settling
  Ad->>ER: settle_license per license, fees to author, rest to buyer, scrub
  Ad->>ER: undelegate_license, refused unless the body is zero
  ER-->>L1: commit scrubbed License
  Ad->>ER: settle_entrant per entrant (losers first), close legs, move USDC, publish hash, scrub, close permissions
  Ad->>ER: undelegate_entrant per entrant, refused unless bodies are zero
  ER-->>L1: commit Entrant and scrubbed Strategy and Position
  Ad->>ER: rank_round, pay_prizes
  Ad->>ER: sweep_vault, close_chat
  Ad->>ER: close_round, refused while open_licenses > 0
  ER-->>L1: commit Round, Scoreboard, Markets
  Ad->>L1: init_hall, record_hall per entrant
  En->>L1: withdraw USDC with Ephemeral SPL
```

## Not implemented

Designed, with account space reserved, but not in this build:

- **Mid-round checkpoints.** `Round.checkpoint_every_ticks` is stored but nothing commits on it.
- **Mystery market.** The VRF callback picks `mystery_market`; nothing reads it yet.
- **Batched ticks.** `batch`, `slot` and `batch_count` are computed; ticks run one task per entrant and one per license.
- **Custody undelegation.** The vault and custody ephemeral ATAs stay delegated after `close_round`; only the token balances are swept out, by `sweep_vault`.
- **Two-pass settlement.** Profits are still capped by the vault balance at the moment each book settles. The house bankroll and losers-first settlement keep that cap off in a normal round, but a two-pass settlement (collect every loss, then pay profits pro rata) is the real fix and is not implemented. See [DISCLOSURES](DISCLOSURES.md) item 29.
- **Chat moderation.** The round chat has no filter, rate limit or deletion; the 32-slot ring is the only bound.
