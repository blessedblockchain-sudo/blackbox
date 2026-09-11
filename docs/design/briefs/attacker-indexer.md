# Brief: privacy attacker CLI (`apps/attacker`) + indexer (`services/indexer`)

Own `apps/attacker` and `services/indexer`.

## bx-attack (`apps/attacker`)
- `src/matrix.ts` exports `runMatrix({ cluster, round, target, ownerKp?, rivalKp? }) -> Row[]` where `Row = { path, request, result, expected, pass }`. Importable by other packages.
- Read paths to attempt against a target entrant's Strategy and Position accounts:
  1. TEE `getAccountInfo` with no token (expect null).
  2. TEE with a freshly generated keypair's auth token (expect null).
  3. TEE with a rival entrant's token (expect null) when a rival keypair is available.
  4. TEE with the owner's token (expect bytes; this is the control).
  5. `getSignaturesForAddress` on the Strategy PDA with the owner token to find the latest `set_strategy` tx, then `getTransaction` with a stranger token: the instruction data must not contain the bytecode.
  6. L1 `getAccountInfo` of the Strategy: owner is the delegation program and the bytecode region (offset 96..) is all zero.
  7. Delegation buffer and record PDAs on L1 (`delegate_buffer`/`delegation_record` helpers from the MagicBlock SDK): must not contain the bytecode.
  8. Raw ER RPC: on devnet use a regional ER (`https://devnet-eu.magicblock.app`) and expect no bytecode; on local the raw ER port 7799 is internal and has no query filter, so label the row "internal port, not exposed in production" and do not count it as a failure.
- `src/cli.ts`: `bx-attack --cluster local|devnet [--round-file path] [--target <owner>|--index N]`. Loads the round file, picks the target (bot secret keys provide owner and rival tokens), prints an aligned table, exits non-zero if any row fails.
- Test `test/matrix.test.ts` running against the live local round.

## Indexer (`services/indexer`)
- Polls the public TEE endpoint every 500ms for the Round, Scoreboard and Markets of the round named in `.mb/round-<cluster>.json` (re-reads the file to follow new rounds).
- Keeps per-round time series in memory and appends JSON lines to `.mb/indexer/<round>.jsonl`: `{t, tick, phase, marks[], equities[{owner, equity, alive, trades}]}` only when the tick changes.
- HTTP server on `INDEXER_PORT` (default 8787) with CORS: `GET /health`, `GET /rounds/current` (public round info + latest sample), `GET /rounds/:round/history?since=<tick>` (samples), `GET /rounds/:round/stream` (SSE pushing each new sample).
- No new dependencies: Node `http`, `fs`, and `@blackbox/sdk`.
- Verify by running it against the live local round and curling every endpoint.
