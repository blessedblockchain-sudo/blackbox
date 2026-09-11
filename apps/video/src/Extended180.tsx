/**
 * The 3-minute cut for judging calls: the same story with the mechanism shown,
 * plus the studio, the hall of fame and the disclosures.
 */
import React from "react";
import { Sequence } from "remotion";
import { Caption, Screen, Slug, Stats, Terminal, Title, C, MONO } from "./kit";
import { Shot } from "./Shot";
import { ATTACK_LINES, E2E_LINES, FACTS } from "./facts";

const STEPS = [
  "1 · join on Solana: Entrant, Strategy and Position are created empty",
  "2 · delegate all three to MagicBlock's TEE validator, timer commits off",
  "3 · privatize: ephemeral permissions with one member, the owner",
  "4 · upload bytecode in a rollup transaction whose message stays hidden",
  "5 · the Native Crank ticks each entrant against Pyth Lazer prices",
  "6 · settle: close books, pay fees and prizes, publish hashes",
  "7 · scrub the private state, then commit zeros back to Solana",
];

const Steps: React.FC = () => (
  <div style={{ position: "absolute", left: 140, right: 140, top: 210, fontFamily: MONO, fontSize: 32, lineHeight: 2.0, color: C.fgMuted }}>
    {STEPS.map((s) => (
      <div key={s}>{s}</div>
    ))}
  </div>
);

export const Extended180: React.FC = () => (
  <Screen>
    <Sequence durationInFrames={240}>
      <Title line="Alpha you can't read." sub="BLACKBOX · a sealed trading league on Solana" delay={4} />
    </Sequence>

    <Sequence from={240} durationInFrames={600}>
      <Slug text={`devnet · round ${FACTS.roundShort} · ${FACTS.markets}`} />
      <Shot name="arena" url="blackbox.app/arena" delay={6} />
      <Caption text="Every strategy here is a program nobody else can read." sub="equity is public, the code and the positions are not" delay={18} />
    </Sequence>

    <Sequence from={840} durationInFrames={420}>
      <Slug text="how a round works" />
      <Steps />
      <Caption text="The rollup runs inside an Intel TDX enclave, and its RPC filters every read." delay={40} />
    </Sequence>

    <Sequence from={1260} durationInFrames={420}>
      <Slug text="write a strategy" />
      <Shot name="studio" url="blackbox.app/studio" delay={6} />
      <Caption text="Strategies are written in BXL, compiled to bytecode, backtested, then hot-swapped mid-round." delay={20} />
    </Sequence>

    <Sequence from={1680} durationInFrames={450}>
      <Slug text="every read path we know of" />
      <Shot name="proof" url="blackbox.app/proof" startFrom={330} delay={6} />
      <Caption text="No token, a stranger, a rival, the upload transaction, the L1 copy, the delegation records." sub={`${FACTS.proofRun} behaved as designed, in 9.6 s`} delay={20} />
    </Sequence>

    <Sequence from={2130} durationInFrames={360}>
      <Terminal lines={ATTACK_LINES} title="$ bx-attack --cluster devnet" perLine={4} />
      <Caption text="The only read that returns bytes is the owner's." delay={70} />
    </Sequence>

    <Sequence from={2490} durationInFrames={480}>
      <Slug text="blind licensing" />
      <Shot name="back" url="blackbox.app/back" delay={6} />
      <Caption
        text="Back an author's sealed strategy with your own margin."
        sub="the TEE prices the fee from their private Sharpe; you never see the code"
        delay={20}
      />
    </Sequence>

    <Sequence from={2970} durationInFrames={330}>
      <Slug text="hall of fame" />
      <Shot name="hall" url="blackbox.app/hall" delay={6} />
      <Caption text="Results settle back to Solana: ranks, ELO and the hash of each final strategy." delay={20} />
    </Sequence>

    <Sequence from={3300} durationInFrames={420}>
      <Terminal lines={E2E_LINES} title="$ CLUSTER=devnet pnpm test:e2e" perLine={4} />
      <Caption text="A full round, end to end, on MagicBlock's devnet TEE validator." delay={80} />
    </Sequence>

    <Sequence from={3720} durationInFrames={240}>
      <Stats
        items={[
          { value: FACTS.devnetChecks, label: "devnet checks passing" },
          { value: FACTS.attackPaths, label: "read paths blocked" },
          { value: FACTS.cuPerTick, label: `per tick of ${FACTS.crankBudget}` },
        ]}
        delay={8}
      />
    </Sequence>

    <Sequence from={3960} durationInFrames={420}>
      <Slug text="what we do not claim" />
      <div style={{ position: "absolute", left: 140, right: 140, top: 260, fontSize: 34, lineHeight: 1.8, color: C.fgMuted }}>
        <div>Trust: Intel TDX and MagicBlock's TEE validator, attestation checked by the client.</div>
        <div>A licensee can infer the trades their own book makes; the logic stays sealed.</div>
        <div>The author of a licensed strategy can read that licence's book.</div>
        <div>USDC here is a test mint. Mainnet is not deployed.</div>
      </div>
      <Caption text="The full list ships with the app, at /disclosures." delay={60} />
    </Sequence>

    <Sequence from={4380} durationInFrames={1020}>
      <Title line="BLACKBOX" sub="Private Ephemeral Rollup · Native Crank · Pyth Lazer · Ephemeral SPL · VRF · ephemeral accounts" delay={4} />
      <div style={{ position: "absolute", bottom: 120, left: 0, right: 0, textAlign: "center", color: C.fgMuted, fontSize: 26, fontFamily: MONO }}>
        <div>{FACTS.program}</div>
        <div style={{ marginTop: 10 }}>{FACTS.repo}</div>
      </div>
    </Sequence>
  </Screen>
);
