# Brief: BLACKBOX web app (`apps/web`)

Own `apps/web`. Next.js 16 App Router + React 19 + Tailwind v4 (`@tailwindcss/postcss`). Deps are installed (see `apps/web/package.json`). Before building UI, load and follow the `frontend-design-guidelines`, `number-formatting`, and `design-taste` skills.

## Design direction
- Name: BLACKBOX. One line: "Alpha you can't read."
- Dark, near-black ground (#09090b range), off-white text, one sharp signal accent (a restrained acid green for gains, a muted red for losses, amber for warnings). Workstation-dense, terminal-grade, no gradients-for-decoration, no emoji. Monospace with tabular numerals for every number. Strong typographic hierarchy.
- The signature element: each entrant is literally a black box, a dark tile with a faint noise/scanline texture and a lock glyph. It shows only what is public: name or short address, equity, return %, a sparkline of equity, trade count, alive or liquidated, rank. Hover reveals the sealed facts ("strategy v3 · sealed in TEE · 214 bytes hidden") without revealing content.
- Motion: subtle, purposeful (numbers roll on change, new ticks pulse once). Respect reduced motion.

## Pages
1. `/` Arena. Live round header: round #, phase, tick/duration progress bar, time left, mode (lit/dark), pot, VRF mystery market, solvency beacon (vault balance vs total equity). Market strip: SOL-PERP, BTC-PERP, ETH-PERP marks with a mini chart from the Market ring buffer, EMA(8)/EMA(21) state, vol. Grid of black boxes sorted by equity. In dark mode the grid shows sealed tiles with no equity. Footer strip: "Only the program can see inside" and explorer links.
2. `/studio` Strategy studio. Identity: connect a wallet (wallet-adapter, `signMessage` for `getAuthToken`) OR, on local only, "act as a bot" using identities served by a dev-only route handler that reads `.mb/round-local.json` (never expose secret keys to the browser: do the owner reads and hot-swaps server-side in `/api/local/*` routes, guarded so they only work when the cluster is local). Shows: authenticated read of your strategy (version, disassembly listing), your private position (legs, margin, PnL, last fault), a BXL editor (monospace textarea with line numbers is fine) with compile errors inline (`@blackbox/compiler`), a simulate button that backtests on the markets' ring history and plots the equity curve, and a "hot-swap" button that sends `set_strategy` and shows the ER tx link.
3. `/proof` Privacy proof. Picks an entrant and runs the read matrix live from the browser: no-token TEE read of the Strategy account (expect null), a freshly generated keypair's token (expect null), the owner's token via the local route (expect bytes), plus the public Scoreboard (expect data). Show each request, the raw response summary, and a pass/fail badge. Explain the TEE trust assumption plainly.
4. `/how` How it works: the round lifecycle (register on Solana, delegate to the TEE rollup, crank ticks run sealed strategies against Pyth prices, settle, scrub, commit), primitives used, and the disclosures. A diagram (inline SVG or mermaid-free SVG) of the flow.

## Data
- `/api/round` route: returns the public parts of `.mb/round-<cluster>.json` (no secret keys) for local/dev, or env `NEXT_PUBLIC_ROUND`/`NEXT_PUBLIC_CLUSTER` for devnet.
- Client polls the TEE public endpoint directly (Round, Scoreboard, Markets) every ~700ms using `@coral-xyz/anchor` coder with the IDL from `@blackbox/sdk` (`packages/sdk/src/blackbox.idl.json`). Local TEE is `http://127.0.0.1:6699` (CORS enabled).
- Equity history: use the indexer at `NEXT_PUBLIC_INDEXER_URL` (default `http://127.0.0.1:8787`, endpoints `GET /rounds/current`, `GET /rounds/:round/history`, SSE `GET /rounds/:round/stream`) with a graceful fallback to accumulating samples client-side.
- Browser polyfills: `buffer`. Keep `@solana/web3.js`, anchor and the MagicBlock SDK in client components only where needed.

## Done means
`cd apps/web && npx tsc --noEmit` passes, `npx next build` passes, and `npx next dev -p 3100` serves `/`, `/studio`, `/proof`, `/how` with live data from the running local round (verify with curl for the routes and the API endpoints).
