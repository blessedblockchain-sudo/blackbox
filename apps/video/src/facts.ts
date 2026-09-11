/**
 * Every number and address shown in the video, with where it came from.
 * Nothing here is rounded up or invented: if a claim is not in this file with
 * a source, it does not go on screen.
 */
export const FACTS = {
  program: "BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27",
  programShort: "BXAbfrYj…dx27",
  /** tests/blackbox.e2e.ts, CLUSTER=devnet, 2026-09-11 */
  devnetChecks: "42/42",
  /** apps/attacker/test/matrix.test.ts against a live round */
  attackPaths: "12/12",
  /** the /proof run captured on camera: 14 paths, 13 blocked, owner rows skipped (no key on the server) */
  proofRun: "14 of 14 paths",
  /** scripts/measure-cu.ts, full tick path, opt-level 3 build */
  cuPerTick: "17k–25k CU",
  crankBudget: "200k",
  tickMs: 500,
  /** devnet round #2 used for the footage */
  round: "3x5BZba4Bu23sapVfcEVQoCeeGQS9sH3vUVhn3cQD8Ky",
  roundShort: "3x5BZba…D8Ky",
  markets: "SOL · BTC · ETH",
  repo: "gitlab.com/Bprime/blackbox",
  /** docs/SUBMISSION.md */
  explorerProof: "delegate_round · devnet",
} as const;

/** Lines lifted from the real devnet e2e output (.mb/e2e-devnet.log). */
export const E2E_LINES: { text: string; tone?: "pass" | "fail" | "dim" | "head" }[] = [
  { text: "==== BLACKBOX e2e (devnet) ====", tone: "head" },
  { text: "PASS  TEE attestation                         TDX quote verified", tone: "pass" },
  { text: "PASS  using live Pyth Lazer feeds             SOL, BTC, ETH", tone: "pass" },
  { text: "PASS  stranger cannot read strategy           null", tone: "pass" },
  { text: "PASS  rival entrant cannot read strategy      null", tone: "pass" },
  { text: "PASS  backer cannot read the strategy it runs null", tone: "pass" },
  { text: "PASS  license settled: author paid its fees   0.6 USDC at 5 bps", tone: "pass" },
  { text: "PASS  private accounts on L1 are all zeros    12/12 in 3s", tone: "pass" },
  { text: "PASS  published hash matches final bytecode   fa8e069e533823da", tone: "pass" },
  { text: "", tone: "dim" },
  { text: "42 pass, 0 fail", tone: "head" },
];

/** Lines from the bx-attack matrix against a live round. */
export const ATTACK_LINES: { text: string; tone?: "pass" | "fail" | "dim" | "head" }[] = [
  { text: "bx-attack · read matrix", tone: "head" },
  { text: "TEE owner token    → Strategy    4192 bytes readable   (control)", tone: "dim" },
  { text: "TEE no token       → Strategy    null", tone: "pass" },
  { text: "TEE fresh token    → Strategy    null", tone: "pass" },
  { text: "TEE rival token    → Strategy    null", tone: "pass" },
  { text: "TEE rival token    → getProgramAccounts   8 foreign, all zeroed", tone: "pass" },
  { text: "set_strategy tx    → stranger    redacted: 0 instr, 0 bytes", tone: "pass" },
  { text: "L1 getAccountInfo  → Strategy    region[96..] all zero", tone: "pass" },
  { text: "L1 delegation PDAs → Strategy    no private bytes", tone: "pass" },
  { text: "", tone: "dim" },
  { text: "12 passing · 0 leaks", tone: "head" },
];
