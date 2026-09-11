import { expect } from "chai";
import { compile } from "../src";
import type { CompileResult, SimTick } from "../src";
import { execute, VmHost, Action } from "../src/interp";

export const MARKETS = ["SOL", "BTC", "ETH"];
export const ROUND_MARKETS = ["SOL-PERP", "BTC-PERP", "ETH-PERP"];
export const S = 1_000_000n;

export function ok(src: string, markets = MARKETS): CompileResult {
  const r = compile(src, { markets });
  expect(r.errors, `unexpected errors for:\n${src}`).to.deep.equal([]);
  expect(r.ok).to.equal(true);
  return r;
}

export function errs(src: string, markets = MARKETS) {
  const r = compile(src, { markets });
  expect(r.ok, `expected a compile error for:\n${src}`).to.equal(false);
  expect(r.bytecode.length).to.equal(0);
  return r.errors;
}

/** Fixed host for single-tick runs. */
export function host(over: Partial<Record<keyof VmHost, unknown>> = {}): VmHost {
  const base: VmHost = {
    nMarkets: () => 3,
    price: (m) => [100n * S, 60_000n * S, 3_000n * S][m] ?? null,
    ema: (m, k) => [[101n * S, 99n * S, 95n * S], [60_000n * S, 60_100n * S, 60_200n * S], [3_000n * S, 3_000n * S, 3_000n * S]][m]?.[k] ?? null,
    ret: () => 5_000n,
    vol: () => 20_000n,
    pos: () => 0n,
    entry: () => 0n,
    equity: () => 1_000n * S,
    freeMargin: () => 900n * S,
    tick: () => 42n,
    rand: () => 123_456n,
  };
  return { ...base, ...(over as Partial<VmHost>) };
}

export function run(src: string, h: VmHost = host(), mem: bigint[] = new Array(16).fill(0n)): { actions: Action[]; mem: bigint[]; fault: string | null; steps: number } {
  const r = ok(src);
  const res = execute(r.bytecode, h, mem, 512);
  return { actions: res.actions, mem, fault: res.fault, steps: res.steps };
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Three-market series generators. */
export const SERIES = {
  randomWalk(n: number, seed: number, stepFrac = 0.002): SimTick[] {
    const r = prng(seed);
    const p = [150, 60_000, 3_000];
    const out: SimTick[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) p[k] *= 1 + (r() - 0.5) * 2 * stepFrac;
      out.push({ prices: [...p] });
    }
    return out;
  },
  sine(n: number, period = 40, amp = 0.03): SimTick[] {
    return Array.from({ length: n }, (_, i) => ({
      prices: [150 * (1 + amp * Math.sin((2 * Math.PI * i) / period)), 60_000 * (1 + amp * Math.cos((2 * Math.PI * i) / (period * 1.3))), 3_000 * (1 + amp * Math.sin((2 * Math.PI * i) / (period * 0.7)))],
    }));
  },
  trend(n: number, perTick: number): SimTick[] {
    return Array.from({ length: n }, (_, i) => ({ prices: [150 * (1 + perTick) ** i, 60_000 * (1 + perTick / 2) ** i, 3_000 * (1 - perTick / 3) ** i] }));
  },
  crash(n: number, at: number, drop: number): SimTick[] {
    return Array.from({ length: n }, (_, i) => {
      const f = i < at ? 1 + i * 0.0005 : (1 + at * 0.0005) * (1 - drop * Math.min(1, (i - at + 1) / 5));
      return { prices: [150 * f, 60_000 * f, 3_000 * f] };
    });
  },
};
