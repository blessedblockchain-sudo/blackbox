# Brief: BXL compiler + simulator (`packages/compiler`)

Own `packages/compiler`. Implement BXL, the BLACKBOX strategy language, keeping the exact public API in `src/index.ts` (`compile`, `simulate`, `formatListing`, `EXAMPLES`). Replace the stubs `codegen.ts`, `sim.ts`, `examples.ts`; add `lexer.ts`, `parser.ts` as needed.

## Language
- Line comments with `#`. Statements separated by newlines. Blocks use braces.
- `let NAME = EXPR` locals, allocated to VM memory slots 8..15. Error if more than 8 distinct locals.
- `mem[I] = EXPR` and `mem[I]` in expressions, `I` in 0..7, persistent across ticks.
- `if COND { ... } elif COND { ... } else { ... }`
- Actions: `long(M, P)`, `short(M, P)`, `close(M)`, `close_all()`, `halt()`. `M` is a market symbol from `opts.markets` (case-insensitive). `P` is a percent literal 1%..100% meaning bps of buying power (30% becomes 3000 bps). Buying power is equity times the market's max leverage.
- Expressions: `+ - * / %`, unary `-`, comparisons `< <= > >= == !=`, `and or not`, parentheses. Numbers are decimals converted to 6-dp fixed point (1.5 becomes 1500000). A percent literal inside an expression is a fraction (0.05% becomes 500).
- Functions: `price(M) ema(M, 8|21|55) ret(M, N)` with N in 1..64, `vol(M) pos(M) entry(M) equity() free() tick() rand() abs(x) min(a,b) max(a,b)`.
- Codegen via the `Asm` class from `@blackbox/sdk` (labels for jumps). `!=` compiles to `eq` then `not`. `and`/`or` are the VM's boolean ops (no short circuit). Programs end with `halt`.
- Errors carry line, col, and a clear message: unknown market, bad ema window, bad lookback, too many locals, out-of-range percent, unknown function, bytecode longer than 4096.
- `compile()` also runs `validate()` from the SDK on the output, and reports `maxSteps` (instruction count of the longest path; BXL has no backward jumps).
- `formatListing(bytecode)`: offsets plus disassembly text via the SDK's `disassemble()`.

## Simulator
`simulate(bytecode, series, opts)` is a TypeScript port of `crates/bxvm/src/exec.rs` (read it: BigInt fixed point with i128-style saturation, identical op semantics, faults discard actions) plus a perps host mirroring `programs/blackbox/src/perps.rs`: fill at mark x (1 ± spread), notional legs, realized PnL on reduce or flip, leverage check (equity x maxLev) only when exposure grows, maintenance liquidation, EMAs 8/21/55, returns over a 64-long ring, realized vol like the Rust code. Return the equity curve, trades, liquidated, faults, finalEquity, maxDrawdown, and sharpe (mean/std of per-tick returns x sqrt(n)).

## Examples
`EXAMPLES`: at least 6 idiomatic BXL programs: trend, mean reversion, breakout with a vol filter, SOL/BTC pairs, memory use (e.g. a cooldown counter), and a risk-managed strategy with a drawdown stop kept in `mem`.

## Tests (`test/*.test.ts`, mocha + chai)
- Every example compiles and validates.
- Error cases produce the right messages and positions.
- BXL momentum compiles to bytecode equivalent in behavior to `strategies.momentum` from the SDK (same actions on the same simulated series).
- `simulate()` is deterministic; always-long on a rising series gains; max-leverage long on a crash liquidates.

Read `crates/bxvm/src/ops.rs`, `crates/bxvm/src/exec.rs`, and `programs/blackbox/src/perps.rs` for exact semantics.
