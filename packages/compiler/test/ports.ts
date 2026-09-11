/**
 * BXL re-implementations of the SDK's hand-assembled bots
 * (packages/sdk/src/strategies.ts), parameterized the same way.
 * Markets are written by symbol; `sym` maps an index to the round's symbol.
 */
import { strategies } from "@blackbox/sdk/src";

const pct = (bps: number) => `${bps / 100}%`;

export interface Port {
  bxl: string;
  sdk: Uint8Array;
}

export function ports(sym: (i: number) => string) {
  return {
    momentum: (m = 0, bps = 3000): Port => ({
      bxl: `let up = ema(${sym(m)}, 8) > ema(${sym(m)}, 21)
if up {
  if pos(${sym(m)}) <= 0 { long(${sym(m)}, ${pct(bps)}) }
} else {
  if pos(${sym(m)}) >= 0 { short(${sym(m)}, ${pct(bps)}) }
}`,
      sdk: strategies.momentum(m, bps),
    }),
    meanReversion: (m = 0, bps = 2500): Port => ({
      bxl: `let r = ret(${sym(m)}, 8)
if r < -0.08% {
  if pos(${sym(m)}) <= 0 { long(${sym(m)}, ${pct(bps)}) }
} elif r > 0.08% {
  if pos(${sym(m)}) >= 0 { short(${sym(m)}, ${pct(bps)}) }
} elif abs(r) < 0.02% {
  if pos(${sym(m)}) != 0 { close(${sym(m)}) }
}`,
      sdk: strategies.meanReversion(m, bps),
    }),
    breakout: (m = 0, bps = 4000): Port => ({
      bxl: `let r = ret(${sym(m)}, 16)
let th = vol(${sym(m)}) * 2
if r > th {
  if pos(${sym(m)}) <= 0 { long(${sym(m)}, ${pct(bps)}) }
} elif -r > th {
  if pos(${sym(m)}) >= 0 { short(${sym(m)}, ${pct(bps)}) }
}`,
      sdk: strategies.breakout(m, bps),
    }),
    randomWalk: (m = 0, bps = 2000): Port => ({
      bxl: `if rand() < 5% {
  if rand() < 50% { long(${sym(m)}, ${pct(bps)}) } else { short(${sym(m)}, ${pct(bps)}) }
}`,
      sdk: strategies.randomWalk(m, bps),
    }),
    alwaysLong: (m = 0, bps = 5000): Port => ({ bxl: `if pos(${sym(m)}) <= 0 { long(${sym(m)}, ${pct(bps)}) }`, sdk: strategies.alwaysLong(m, bps) }),
    degen: (m = 0): Port => ({ bxl: `if pos(${sym(m)}) == 0 { long(${sym(m)}, 100%) }`, sdk: strategies.degen(m) }),
    pairs: (a = 0, b = 1, bps = 2000): Port => ({
      bxl: `let d = ret(${sym(a)}, 8) - ret(${sym(b)}, 8)
if d < -0.05% {
  if pos(${sym(a)}) <= 0 {
    long(${sym(a)}, ${pct(bps)})
    short(${sym(b)}, ${pct(bps)})
  }
} elif d > 0.05% {
  if pos(${sym(a)}) >= 0 {
    short(${sym(a)}, ${pct(bps)})
    long(${sym(b)}, ${pct(bps)})
  }
}`,
      sdk: strategies.pairs(a, b, bps),
    }),
  };
}
