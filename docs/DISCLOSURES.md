# BLACKBOX disclosures

Plain statements about what BLACKBOX hides, what it does not, whom you trust, and how the money works. They describe the code on 2026-09-11. If a statement here and the code disagree, the code is what runs; please report the difference.

## Status and money

1. **Nothing here is mainnet.** BLACKBOX runs on a local MagicBlock stack today. Every MagicBlock primitive it uses was verified on devnet and devnet-tee with a separate spike program (32/32 checks). The BLACKBOX program itself is not yet deployed to devnet.
2. **"USDC" is a test token.** On the local stack and in the devnet test path, the round's USDC is a 6-decimal SPL mint created by the round admin, who can mint any amount. It is not Circle's USDC and has no value. Entry fees, margin, PnL and prizes are real token transfers of that test mint.
3. **Local prices are mirrored, not live-pushed.** On the local stack there is no MagicBlock oracle pusher. `scripts/run-round.ts` (and the e2e test) read the real SOL, BTC and ETH Pyth Lazer accounts on devnet-tee every 2 seconds and write those prices into program-owned mock feed accounts on the local rollup every 500 ms. The mock accounts use the exact Pyth Lazer byte layout, and only a build with the `local-oracle` feature accepts them. Local marks can therefore lag the devnet feed by a few seconds and move in steps.
4. **Local privacy is emulated.** The local "TEE" is MagicBlock's query-filtering service in front of an ordinary ephemeral validator. It enforces the same auth tokens and permissions, but there is no enclave and no attestation (the SDK's `verifyAttestation()` returns `true` on local without checking). The raw local rollup RPC on port 7799 has no read filter at all; it exists only inside the development machine and is not part of a production deployment.

## Hardware and operator trust

5. **You trust Intel TDX and MagicBlock's TEE validator.** On devnet the rollup runs on MagicBlock's TEE validator (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) inside an Intel TDX trust domain. Clients check the enclave's attestation with `verifyTeeRpcIntegrity` from MagicBlock's SDK (verified in the spike; the PCCS fetch is occasionally flaky and is retried). Attestation shows that the RPC endpoint runs attested code inside TDX; it does not remove the trust in Intel's hardware and firmware or in the attested software.
6. **What the operator could see in principle.** The operator of the TEE host controls the machine around the enclave. Without breaking TDX, it can see network traffic metadata (who connects, when, and how much), transaction timing and ordering, and it can delay, reorder or censor transactions and crank execution. It cannot read enclave memory unless TDX, its firmware, or the attested validator software is compromised (for example by a side channel or a vulnerability). If that happens, every strategy and position in the round is readable. BLACKBOX has no second line of defense against a compromised enclave.
7. **You trust the program upgrade authority.** The BLACKBOX program is upgradeable. Its upgrade authority (the deployer key `3fMoA42W8MzvA86ZUFiRj5ayoEuwmDkz1qtZGiY5ooWR` on the local stack and for the devnet spike) could ship a version that adds a reader to a permission or copies bytecode into a public account. Freezing the upgrade authority or moving it to a multisig is required before real money.
8. **You trust the round admin for round parameters, not for your code.** The admin creates the round, chooses markets, fees, margins, tick interval and duration, starts the round, and chooses lit or dark. The admin is not a member of any Strategy or Position permission and cannot read them: the permission's authority is the gated PDA itself, which only the program can sign for.

## What is private

9. **Strategy bytecode** is readable only by its owner's TEE auth token while the round runs. It is never written to Solana L1 in plaintext: the account is created zeroed on L1, filled only by rollup transactions, and zeroed again before it is committed. The `set_strategy` transaction that carries the bytes is hidden from non-members by the permission's `TX_MESSAGE` flag (verified in the spike).
10. **Position** (legs, margin, realized PnL, VM memory, step counts, faults, liquidation flag) is readable only by its owner's token, and is zeroed before commit.
11. **Token balances** of custody and vault accounts on the TEE are shown only to the owning wallet's token (spike bet 3). The program publishes aggregates instead (below).
12. **After the round**, the private bodies on L1 are all zeros (checked by the e2e test for every entrant), and `undelegate_entrant` refuses to commit a private account that is not.

## What is public by design

13. **Per entrant, every tick, in lit rounds:** equity, amount deposited, number of trades, alive or liquidated (the Scoreboard).
14. **Per entrant, always:** the Entrant record, including `strategy_version`. The version counter reveals that, and when, an owner hot-swapped, but not what changed.
15. **Per market, always:** mark price, EMA(8/21/55), realized volatility, the last 64 marks, open interest long and short, funding index and rate.
16. **Per round, always:** status, tick, parameters, pot, vault balance, total equity (the sum of all entrants' equity, public even in dark rounds), the VRF seed and the mystery market.
17. **After settlement:** each entrant's final equity, rank, and the sha256 of their final bytecode. The hash lets anyone verify a strategy that is later disclosed; it does not reveal the strategy.
18. **Dark rounds** hide the Scoreboard (program-only) until `close_round` commits it to L1. Round totals, Markets and Entrants stay public.

## Metadata and inference

19. **Timing and existence of transactions.** Hiding a transaction's message does not hide that it happened. Observers can see that an entrant's accounts were touched, and when; a hot-swap also bumps the public `strategy_version`. On the local stack, a stranger's `getTransaction` for a `set_strategy` signature returns the transaction with its instructions redacted (0 instructions, 0 bytes of data), as observed by `bx-attack`.
20. **Crank activity is regular by construction.** Every entrant's tick runs on the same schedule whether or not the strategy trades, so tick timing alone does not reveal trading. Its effects do (next items).
21. **Open interest is public and updated inside each entrant's tick.** In a market where few entrants trade, a change in `oi_long` or `oi_short` can reveal one entrant's trade size and direction, and an observer sampling Market accounts between individual tick transactions may attribute a change to a specific entrant. Aggregating open-interest updates per clock tick would close this; it is not implemented.
22. **A lit equity curve leaks exposure.** Each entrant's equity is published every tick next to public marks. Regressing equity changes on mark changes estimates that entrant's net exposure per market over time. The logic stays sealed; its positions can be approximately inferred. Dark rounds remove the per-entrant curve.
23. **`RAND` is reproducible after the seed lands.** The VRF seed is stored in the public Round, and `RAND = sha256(seed, owner, tick) mod 1e6`. Anyone can compute any entrant's random draws once the seed is set. Before the VRF callback lands the seed is all zeros, so early-tick draws are predictable.
24. **Licensees would infer trades from their own fills.** Blind licensing (backing a strategy with your own capital without reading it) is not in the running build; work on it is in progress. When it ships, a licensee's mirrored position is private to them, so the licensee can read their own fills and infer what the strategy does. The code stays private; the trades it makes on your capital do not.

## Economics

25. **The round vault is the counterparty.** There is no order book and no outside liquidity. Every fill is at the oracle mark plus or minus a spread (a base spread, plus a skew component when the trade adds to the long/short imbalance). The vault receives spread and the losses of losing entrants; it pays the profits of winning entrants at settlement. This is a competition ledger with real token movements, not a venue.
26. **Profits are capped by what the vault holds.** At settlement, a profitable entrant is paid `min(PnL, vault balance - pot)`: the entry-fee pot is reserved for prizes, so profits come only from what losers have left in the vault. Settlement runs entrant by entrant, in index order in the provided scripts, but `settle_entrant` can be sent by anyone for any entrant, so the order is decided by whoever sends first. A profitable entrant settled before the losing entrants can be paid less than its PnL, and the shortfall is not paid later. A two-pass settlement (collect all losses, then pay profits pro rata) is the fix; it is not implemented.
27. **Losses are capped at margin.** A liquidated entrant whose book goes below zero loses its whole margin and no more; the vault absorbs the rest.
28. **Scores and ranking.** The public equity is the program's mark-to-market value. Ranking is by final equity divided by amount deposited (return on deposit); the entry fee is not part of the deposit. Ties go to the earlier entrant.
29. **Prizes.** The prize pot is the sum of entry fees. A protocol fee (`protocol_fee_bps`, 500 bps = 5% in the provided scripts) is kept; the rest is split 50% / 30% / 20% to ranks 1-3 (with fewer than three entrants, unused shares go to first place). Prizes are paid on the rollup into the winners' token accounts; winners withdraw to L1 with Ephemeral SPL. The protocol fee and any residual vault balance stay in the round vault; there is no sweep instruction yet.
30. **Funding** accrues every 240 ticks at up to 10 bps of notional at full skew, charged to the crowded side and absorbed by the vault like any other PnL.

## Known limitations in this build

31. **Anyone can advance the round clock.** `tick_clock` has no signer check and no rate limit: the Native Crank calls it every `tick_interval_ms`, but any wallet can also send it on the rollup. Each call adds one tick, so a spammer could run a round to `duration_ticks` early and force settlement. The fix is to rate-limit the clock (for example, reject a tick until enough slots or milliseconds have passed since the last one) or to accept it only from the scheduled task. It has not been exploited in any test, and it is not fixed at the time of writing.
32. **Anyone can run extra ticks for an entrant.** `tick_entrant` has no signer check, and `schedule_entrant_tick` accepts any payer, so a third party can execute a rival's strategy more than once per round tick. Market data only refreshes once per tick, so a strategy that acts only on state changes (all built-in bots) does nothing on the extra runs; a strategy that re-targets on every run, or counts runs in its memory, can be made to trade or count more often, and each extra run adds a zero-return sample to its private Sharpe accumulators. A once-per-tick guard per entrant would close this.
33. **Settlement order is open** (see item 26).

## Not claimed

34. BLACKBOX does not claim that trading performance on the leaderboard is achievable on a real venue: fills are at an oracle mark with a modeled spread, with no slippage beyond the spread formula and no counterparty other than the vault.
35. BLACKBOX does not use session keys or the Magic Router in this build. Wallet approvals are per transaction.
36. The web app, compiler, MCP server, agents, attacker CLI and indexer were being built at the time of writing; their privacy properties are those of the program and the TEE RPC described above. The MCP server and the web app's local mode hold keypairs on the machine that runs them.
