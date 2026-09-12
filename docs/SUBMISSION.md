# Solana Blitz v8 submission — BLACKBOX

Copy-paste values for build.magicblock.app → Submit → Proof of Work.

## Project name
Black Box

## Description (what it does, how it uses MagicBlock)

BLACKBOX is a trading league where every strategy is a small program nobody can read. Traders (humans or AI agents over MCP) upload bytecode for a deterministic on-chain VM. The BLACKBOX program runs it inside a MagicBlock Private Ephemeral Rollup on every Native Crank tick, against live Pyth Lazer prices, and trades a perps book with test USDC. Only the owner can read the strategy, the positions, and even the transaction that uploaded the code. Rivals, spectators and the rollup operator see a public equity leaderboard and nothing else.

Winning strategies can be licensed blind: a backer puts up margin, and the TEE runs the author's sealed code against the backer's own private book every tick. The fee is a price the program computes inside the TEE from the author's private Sharpe ratio; that price is the only public trace of the author's performance. At the end of the round the program closes every book, pays the author's fees and the prize pot, publishes a hash of each final strategy, zeroes the private state, and only then commits back to Solana.

Verified end to end on devnet against MagicBlock's TEE validator: 43/43 checks, including TDX attestation, owner-only reads, blind licensing, every private account returning to L1 as zeros, and the upload transaction staying redacted to a stranger after the round settles.

MagicBlock primitives, all load-bearing:
- **Private Ephemeral Rollup (TEE)**: Strategy, Position and License accounts carry ephemeral permissions (owner only; buyer + author for a License). No-token, stranger and rival reads return null; the hot-swap transaction's message is hidden from non-members. Clients verify the enclave with TDX attestation.
- **Native Crank**: one scheduled task per round clock, per entrant and per license runs the ticks inside the rollup, with no off-chain keeper.
- **Price oracle**: ticks read Pyth Lazer accounts (SOL, BTC, ETH) inside the TEE and maintain EMAs, returns and realized volatility per market.
- **Ephemeral SPL**: entry fees, margin, PnL, license fees, the house bankroll and prizes move as real token transfers on the rollup, signed by program PDAs.
- **VRF**: a delegated VRF request seeds the round (the strategies' RAND opcode and a VRF-chosen mystery market).
- **Ephemeral accounts**: the public round chat exists only on the rollup, sponsored by the round, and is closed before the round commits.
- **Delegation with commit_frequency_ms = u32::MAX + scrub before commit**: private bytecode never reaches L1 in plaintext; the program refuses to commit a private account that still has a body.

## Categories (3)
DeFi · AI / Agents · Privacy

## Project website
https://bprime.gitlab.io/blackbox/

The web app itself, built as a static site and published by the `pages` job in
`.gitlab-ci.yml` on every push to `main`. It reads Solana devnet from the
browser: the arena, hall of fame, BXL studio and the privacy proof all work for
a visitor, and a connected wallet can enter a round, hot-swap a strategy and
back a sealed one. Two things it needs: GitLab Pages enabled on the project,
and the project set to public (Pages on a private project serves members only).

## Repo
https://gitlab.com/Bprime/blackbox — **must be public before submitting** (GitLab → Settings → General → Visibility → Public).

## Pitch & Demo
(video URL — upload one of the rendered cuts, then paste the link here)

Rendered locally by `apps/video` from footage of the app reading devnet round #2 while it was live:
- `apps/video/out/blackbox-90s.mp4` — the 90-second submission cut (1920x1080, captions, no narration)
- `apps/video/out/blackbox-3min.mp4` — the 3-minute cut for judging calls

Rebuild either with `pnpm --filter @blackbox/video render:90` / `render:extended`; re-film with
`node apps/video/scripts/capture.mjs --base <web app url>` while a round is live.

## Explorer link (integration proof)
`delegate_round` on devnet: the BLACKBOX program hands the round to MagicBlock's TEE validator through the Delegation program.
https://explorer.solana.com/tx/5b44mnJhjLrLgNoJBPxchTatrQ2RPeg23FC4RwR5TWvr19WaFAmY9K9BL4a2iZheDP5XE2tkQwAvHUEDF8JSaSo2?cluster=devnet

More devnet evidence, from the first full devnet run (round #1 `EHfSy9AYJ6ZBrdSEEa7GUroyEAFVHch9m6fKATrEaPNZ`):

| Step | Layer | Transaction |
|---|---|---|
| Program deploy | L1 | https://explorer.solana.com/tx/3juU6d7ktbdE5Wmc4XdN5boqfZCFf2y7oRF4PqVkbA4PncU5NGLEp1GvUYCfz8wsdjohSuhG9oNmJbNq7PKiYGtq?cluster=devnet |
| `create_round` | L1 | https://explorer.solana.com/tx/2WazSt1zTomnWDdywugJrS2FnPMdYXRpaGhNP2nRhbyfm2miubZMRBGF9Zhom3Vg5DmheyMpMdzok5DLH3wRUYCp?cluster=devnet |
| `delegate_entrant` (Entrant, Strategy, Position to the TEE) | L1 | https://explorer.solana.com/tx/4gUH4Fnnp8wWVT8QU62Ltm9ex2AB6nmQQ7xmyJU2HMyHyt6XtQj6ybfKerstvUf6JYyfK9ob785xZ4SYyJgh8a1g?cluster=devnet |
| `delegate_spl` (USDC into the rollup) | L1 | https://explorer.solana.com/tx/gCDguoN6RVHVFWhKFK6W9wiADrGr76ei4WtdNB3bp7PaWE88oEJNTQYadwYuKVum3WRho6yEzM4JoTPm49MarP4?cluster=devnet |
| `open_license` (blind licensing) | L1 | https://explorer.solana.com/tx/5e9HdWq7Vbvyxg4JkX3arJrfPLepUTXSn5QVB5ALfpaTkUPjwEDQbnW7yCCda4uzrEeJps64xnMnFKASgGaDRcd?cluster=devnet |
| `delegate_license` | L1 | https://explorer.solana.com/tx/3ydSfyaA868cWHokPfVv2oR5CMgV3vZvDdo9utxReRvJDVdgz1FR4wsj2CdLP4pYDpxeGhSApK1rjqk9qrnv4fCA?cluster=devnet |
| `record_hall` (after the round committed back to L1) | L1 | https://explorer.solana.com/tx/2diHSrqAGD2yiPwEUnzifbr3rPsXjFtU1WnD4BfnqkkUG1sPdpFMZ8JmRRDWYb66oynJYLX1JQzRgevACJKTskxV?cluster=devnet |

Rollup transactions (`set_strategy`, `activate_license`, `schedule_clock`, `post_chat`, `close_round`, …) ran on `https://devnet-tee.magicblock.app`. Opening them needs a TEE auth token for a member of the accounts involved; that gating is the privacy guarantee. Example (owner token required): `close_round` `ikCspFk38cxqed3szcqiXeP6R1mNkYgGAtDADrbxQfWHoYdh8vGhUCZ94CfS7NCF5ukcWAqEWAre4AYX9SKJCTq`.

## Program addresses (the form takes several; add both)
1. `BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27` — BLACKBOX, the program every round runs on (devnet) — https://explorer.solana.com/address/BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27?cluster=devnet
2. `94gGoaBYDU4B9dmxEoJFVST8gszK5YbUqoh7HCxUAbhp` — Phase 0 verification program behind the 32/32 devnet-tee checks (optional, evidence only) — https://explorer.solana.com/address/94gGoaBYDU4B9dmxEoJFVST8gszK5YbUqoh7HCxUAbhp?cluster=devnet

Everything else BLACKBOX calls is MagicBlock's or Solana's, not ours: delegation `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, permissions `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, Ephemeral SPL `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, oracle `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`, VRF `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`.
