/**
 * The 90-second submission cut. Every claim on screen comes from facts.ts,
 * and every page shot is real footage of the app reading a live devnet round.
 */
import React from "react";
import { Sequence } from "remotion";
import { Caption, Screen, Slug, Stats, Terminal, Title, C } from "./kit";
import { Shot } from "./Shot";
import { ATTACK_LINES, E2E_LINES, FACTS } from "./facts";

const SLUG = `devnet · MagicBlock Private Ephemeral Rollup · round ${FACTS.roundShort}`;

export const Submission90: React.FC = () => (
  <Screen>
    {/* 0:00 - 0:07 title */}
    <Sequence durationInFrames={210}>
      <Title line="Alpha you can't read." sub="BLACKBOX · a sealed trading league on Solana" delay={4} />
    </Sequence>

    {/* 0:07 - 0:25 the arena, live on devnet */}
    <Sequence from={210} durationInFrames={540}>
      <Slug text={SLUG} />
      <Shot name="arena" url="blackbox.app/arena" delay={6} />
      <Caption
        text="Eight strategies trade SOL, BTC and ETH perps every 500 ms inside a TEE."
        sub="public: equity, trades, marks — sealed: the code and every position"
        delay={18}
      />
    </Sequence>

    {/* 0:25 - 0:40 the privacy proof */}
    <Sequence from={750} durationInFrames={450}>
      <Slug text="every read path we know of" />
      <Shot name="proof" url="blackbox.app/proof" delay={6} />
      <Caption text="No token: null. A stranger's token: null. A rival in the same round: null." sub={`the read matrix, run live on devnet · ${FACTS.proofRun} as designed`} delay={20} />
    </Sequence>

    {/* 0:40 - 0:50 the attack matrix, typeset from the real run */}
    <Sequence from={1200} durationInFrames={300}>
      <Terminal lines={ATTACK_LINES} title="$ bx-attack --cluster devnet" perLine={4} />
      <Caption text="On Solana the account is zeros. Only the owner's token returns bytes." delay={60} />
    </Sequence>

    {/* 0:50 - 1:05 blind licensing */}
    <Sequence from={1500} durationInFrames={450}>
      <Slug text="blind licensing" />
      <Shot name="back" url="blackbox.app/back" delay={6} />
      <Caption
        text="Back a strategy you cannot read. The TEE runs the author's code on your margin."
        sub="the fee is priced inside the enclave from the author's private Sharpe"
        delay={20}
      />
    </Sequence>

    {/* 1:05 - 1:17 settlement, from the real devnet run */}
    <Sequence from={1950} durationInFrames={360}>
      <Terminal lines={E2E_LINES} title="$ CLUSTER=devnet pnpm test:e2e" perLine={4} />
      <Caption text="At the end: books closed, fees paid, hashes published, private state zeroed." delay={70} />
    </Sequence>

    {/* 1:17 - 1:24 the numbers */}
    <Sequence from={2310} durationInFrames={210}>
      <Stats
        items={[
          { value: FACTS.devnetChecks, label: "devnet checks passing" },
          { value: FACTS.attackPaths, label: "read paths blocked" },
          { value: FACTS.cuPerTick, label: `per tick of ${FACTS.crankBudget}` },
        ]}
        delay={8}
      />
    </Sequence>

    {/* 1:24 - 1:30 end card */}
    <Sequence from={2520} durationInFrames={180}>
      <Title line="BLACKBOX" sub="Private Ephemeral Rollup · Native Crank · Pyth Lazer · Ephemeral SPL · VRF" delay={4} />
      <div style={{ position: "absolute", bottom: 96, left: 0, right: 0, textAlign: "center", color: C.fgMuted, fontSize: 26 }}>
        {FACTS.program}
      </div>
    </Sequence>
  </Screen>
);
