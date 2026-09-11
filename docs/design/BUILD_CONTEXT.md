# BLACKBOX build context (read this first)

BLACKBOX is a trading league on MagicBlock's Private Ephemeral Rollup (TEE) on Solana. Every strategy is bytecode for a tiny deterministic stack VM (`crates/bxvm`). The on-chain program (`programs/blackbox`, id `BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27`) executes each entrant's strategy on every Native Crank tick inside the TEE, against live Pyth Lazer prices, and trades a perps book with real (test) USDC. Strategy and Position accounts are private: only the owner's TEE auth token can read them. The Scoreboard is public in "lit" rounds and program-only in "dark" rounds. At the end, the program settles, publishes sha256 of each final strategy, scrubs private state, and commits to Solana L1.

Status: the full round works end to end on a local stack (27/27 checks, `tests/blackbox.e2e.ts`), and every MagicBlock integration was verified on devnet-tee (32/32, `tests/spike.ts`, `docs/design/verification.md`).

## Repository map (what exists)
- `programs/blackbox` Anchor 1.1.2 program. Instructions (see `packages/sdk/src/blackbox.idl.json`): init_protocol, create_round, add_market, open_round, join_round, delegate_entrant, delegate_market, delegate_round, privatize_entrant, set_strategy, fund_entrant, set_scoreboard_privacy, start_round, request_round_seed/round_seed_callback (VRF), schedule_clock, schedule_entrant_tick, tick_clock, tick_entrant, settle_entrant, undelegate_entrant, rank_round, pay_prizes, close_round, init_hall, record_hall, init/set/delegate_mock_feed (local only).
- `crates/bxvm` the VM (Rust, no_std). 42 opcodes, i64 fixed point with 6 decimals (1.0 = 1_000_000), stack 64, 16 persistent memory slots, step limit, faults discard all actions. `LONG m bps` / `SHORT m bps` target an exposure of bps/10_000 of buying power (equity x the market's max leverage). Actions only change the book when the target differs from the current leg.
- `packages/sdk` (import as `@blackbox/sdk`, or relative `../../packages/sdk/src`):
  - `BlackboxClient(adminKeypair, "local"|"devnet")` with `.tee(kp)` (auth token connection), `.teePublic()`, `.sendBase/.sendEr`, one method per protocol step (`createRound, addMarket, openRound, join, delegateEntrant, delegateMarkets, delegateRound, depositToEr, waitErBalance, privatize, setStrategy, fund, setScoreboardPrivacy, startRound, requestSeed, scheduleClock, scheduleEntrantTick, tickEntrant, settle, undelegateEntrant, rank, payPrizes, closeRound, recordHall, withdrawFromEr`), and reads `fetchRound, fetchScoreboard, fetchMarket, fetchPosition(round, ownerKp), fetchStrategy(round, ownerKp)` (decoded with the Anchor coder; BN fields).
  - `pda.*` PDA helpers (`roundPda, scoreboardPda, marketPda, entrantPda, strategyPda, positionPda, hallPda, permissionPda, ata, eataAccounts`).
  - `Asm` (label-aware assembler), `disassemble(bytes)`, `validate(bytes, nMarkets)`, `Op`, `fx(n)`.
  - `strategies.*` built-in bots: momentum, meanReversion, breakout, randomWalk, alwaysLong, degen, pairs.
  - `ENDPOINTS`, `DEVNET_FEEDS`, `TEE_VALIDATOR`, `BLACKBOX_PROGRAM_ID`.
- `packages/compiler` (import as `@blackbox/compiler`): API contract in `src/index.ts` (`compile`, `simulate`, `formatListing`, `EXAMPLES`). Currently stubs; being implemented in parallel. Code against the contract.
- `scripts/run-round.ts` round runner. A LIVE local round is running now: its state is in `.mb/round-local.json` (fields: cluster, roundId, round, mint, feeds[], markets[] names, tickMs, durationTicks, mode, phase ∈ registration|delegating|live|settling|settled, entrants[{name, owner, secretKey, bot}], external[], entrantOwners[]). Bot secret keys in that file let local tools read private accounts as their owners.
- `scripts/local-stack.sh up|down|status` local MagicBlock stack. It is RUNNING; do not restart it.

## Endpoints
- local: base `http://127.0.0.1:8899`, TEE (query-filtering service with token auth) `http://127.0.0.1:6699` (ws 6700), raw ER `http://127.0.0.1:7799` (internal, not exposed in production).
- devnet: base `https://api.devnet.solana.com`, TEE `https://devnet-tee.magicblock.app` (auth: `getAuthToken(teeUrl, pubkey, signFn)` from `@magicblock-labs/ephemeral-rollups-sdk`, then `?token=`), attestation `verifyTeeRpcIntegrity(teeUrl)`.
- Public (no-token) TEE reads return public accounts (Round, Market, Entrant, Scoreboard in lit mode) and null for private ones.

## Account notes for UIs
- Round: status enum (`{created:{}}`, `{open:{}}`, `{live:{}}`, `{settling:{}}`, `{settled:{}}`), tick, durationTicks, tickIntervalMs, nMarkets, markets[i].feed, pot, vaultBalance, totalEquity, vrfReady, mysteryMarket, mode, entrantCount.
- Scoreboard (zero-copy): n, finalized, entries[i] {owner, equity (USDC 6dp), deposited, trades, alive, rank, strategyHash}.
- Market (zero-copy): mark (USDC 6dp), ema8/21/55, vol (fraction, 1e6 = 100%), oiLong, oiShort, fundingRateBps, ring (last 64 marks), ringPos, ringLen, lastTick.
- Entrant: owner, index, alive, deposited, strategyVersion, strategyHash (after settlement), feePriceBps, settled.
- Position (private): margin, realizedPnl, legs[8] {side, size, entry, fundingIndex}, mem[16], tradeCount, lastSteps, lastFault, lastFaultPc, liquidated, lastEquity, peakEquity.
- Strategy (private): version, len, bytecode[4096], stepLimit.

## Conventions for parallel builders
- Only edit files inside the directory you own. Do not touch `programs/`, `crates/`, `packages/sdk/`, `scripts/local-stack.sh`, root `package.json`, `pnpm-lock.yaml`, `Cargo.*`, `Anchor.toml`.
- Do NOT run `pnpm install`, `anchor build`, `anchor deploy`, or anything that restarts validators. Dependencies are already installed for every package; if you truly need another dependency, write it in your final report instead of installing it.
- TypeScript, strict. Typecheck with `npx tsc --noEmit -p <your dir>` (web: `cd apps/web && npx tsc --noEmit`). Tests with `npx ts-mocha -p <dir>/tsconfig.json '<dir>/test/**/*.ts'`.
- Node 22, pnpm 10 workspace. `@solana/web3.js` 1.x and `@coral-xyz/anchor` 0.32 on the client.
- Numbers: USDC amounts and prices on chain are 6-decimal fixed point integers.
- Writing: no emoji in code or UI copy unless the brief asks. Precise, calm, technical tone.
