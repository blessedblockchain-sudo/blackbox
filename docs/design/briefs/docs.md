# Brief: project docs (README + docs)

Own `README.md` (repo root, create it), `docs/ARCHITECTURE.md`, `docs/DISCLOSURES.md`, `docs/DEMO.md`. Do not modify other files in `docs/`.

Read everything first: `docs/design/BUILD_CONTEXT.md`, `docs/design/verification.md`, `docs/BRAINSTORM.md` (the pitch and why it wins), `docs/SUBMISSION.md`, `programs/blackbox/src/**` (instruction flow and account layouts), `crates/bxvm/src/**`, `packages/sdk/src/**`, `tests/blackbox.e2e.ts`, `tests/spike.ts`, `scripts/run-round.ts`, `scripts/local-stack.sh`, and the briefs in `docs/design/briefs/` (the other surfaces being built in parallel: web app, compiler, MCP server, agents, attacker CLI, indexer).

## README.md
Written for MagicBlock judges and developers. Sections: one-line pitch ("Alpha you can't read.") and a 3-sentence explanation; why this needs a Private Ephemeral Rollup; how a round works (numbered lifecycle); the MagicBlock primitives table (primitive, what BLACKBOX uses it for, where in the code); verification results (32/32 spike on devnet-tee, 27/27 local e2e, what each proves); architecture diagram (mermaid); repo map; quickstart (local stack, run a round, open the web app, run the attacker, plug an agent in over MCP); devnet addresses (program `BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27`, spike `94gGoaBYDU4B9dmxEoJFVST8gszK5YbUqoh7HCxUAbhp`, TEE validator); security model and disclosures summary with a link; license (MIT).

## docs/ARCHITECTURE.md
Accounts table (seeds, delegated, visibility, layout), instruction reference grouped by L1 vs ER, the tick loop in detail, the VM (opcodes table, fixed point, faults, sizing semantics), perps engine math, privacy design (permissions, `commit_frequency_ms = u32::MAX`, scrub before commit, the undelegate guard), settlement and prizes, local vs devnet differences (mock oracle feature, committor program preload). Mermaid sequence diagram of a full round across L1, TEE ER, crank, oracle, VRF.

## docs/DISCLOSURES.md
Plain statements: TEE hardware trust (Intel TDX, attestation checked with `verifyTeeRpcIntegrity`), what the operator could see in principle, what is public by design (equity, trade counts, market OI and marks), metadata leakage (timing, tx existence), licensees can infer trades from their own fills, devnet test USDC, vault-as-counterparty economics, prizes, and that local mode uses mock feeds mirrored from devnet prices.

## docs/DEMO.md
A 90-second shot list for the demo video (what is on screen, what is said, which command or page produces it), plus a 3-minute extended version, and the exact commands to set up the scene (local stack, run-round with 8 bots, web app, attacker CLI, Claude Code with the MCP server hot-swapping live).

Be precise and factual. Only claim what the code and verification logs show; mark anything that is in progress as such.
