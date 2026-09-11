/**
 * Built-in bot strategies, written with the assembler. Each returns bytecode
 * for a round whose market 0 is the primary market. Sizing operands are bps
 * of buying power (10_000 = equity x the market's max leverage).
 *
 * All strategies only trade on state changes (flat -> in, side flips) so they
 * do not churn spread every tick.
 */
import { Asm } from "./vm";

/** EMA(8) vs EMA(21) trend follower on market m. */
export function momentum(m = 0, bps = 3000): Uint8Array {
  return new Asm()
    // up = ema8 > ema21
    .ema(m, 8).ema(m, 21).gt().mst(0)
    // if up and pos <= 0 -> long ; if !up and pos >= 0 -> short
    .mld(0).jz("down")
    .pos(m).push(0).gt().jnz("end")
    .long(m, bps).halt()
    .label("down")
    .pos(m).push(0).lt().jnz("end")
    .short(m, bps)
    .label("end").halt()
    .build();
}

/** Fade 8-tick moves beyond +/- threshold on market m; flatten near zero. */
export function meanReversion(m = 0, bps = 2500, thresholdFrac = 0.0008): Uint8Array {
  const th = Math.round(thresholdFrac * 1e6);
  return new Asm()
    .ret(m, 8).mst(1)
    // r < -th -> long
    .mld(1).push(-th).lt().jz("chk_short")
    .pos(m).push(0).gt().jnz("end")
    .long(m, bps).halt()
    .label("chk_short")
    .mld(1).push(th).gt().jz("chk_flat")
    .pos(m).push(0).lt().jnz("end")
    .short(m, bps).halt()
    // |r| < th/4 -> close
    .label("chk_flat")
    .mld(1).abs().push(Math.round(th / 4)).lt().jz("end")
    .pos(m).push(0).eq().jnz("end")
    .close(m)
    .label("end").halt()
    .build();
}

/** Breakout: go with the move when |ret(16)| exceeds 2x realized vol. */
export function breakout(m = 0, bps = 4000): Uint8Array {
  return new Asm()
    .ret(m, 16).mst(2)
    .vol(m).push(2_000_000).mul().mst(3) // 2 * vol (fixed-point mul)
    .mld(2).mld(3).gt().jz("chk_down")
    .pos(m).push(0).gt().jnz("end")
    .long(m, bps).halt()
    .label("chk_down")
    .mld(2).neg().mld(3).gt().jz("end")
    .pos(m).push(0).lt().jnz("end")
    .short(m, bps)
    .label("end").halt()
    .build();
}

/** Coin flip every ~20 ticks, VRF-seeded. */
export function randomWalk(m = 0, bps = 2000): Uint8Array {
  return new Asm()
    .rand().push(50_000).lt().jz("end") // 5% chance per tick to act
    .rand().push(500_000).lt().jz("go_short")
    .long(m, bps).halt()
    .label("go_short").short(m, bps)
    .label("end").halt()
    .build();
}

/** Buy and hold market m. */
export function alwaysLong(m = 0, bps = 5000): Uint8Array {
  return new Asm().pos(m).push(0).gt().jnz("end").long(m, bps).label("end").halt().build();
}

/** Max-leverage long with no stop: liquidation bait for demos. */
export function degen(m = 0): Uint8Array {
  return new Asm().pos(m).push(0).eq().jz("end").long(m, 10_000).label("end").halt().build();
}

/** Pairs: long market a, short market b when a's 8-tick return lags b's. */
export function pairs(a = 0, b = 1, bps = 2000): Uint8Array {
  return new Asm()
    .ret(a, 8).ret(b, 8).sub().mst(4)
    .mld(4).push(-500).lt().jz("chk")
    .pos(a).push(0).gt().jnz("end")
    .long(a, bps).short(b, bps).halt()
    .label("chk")
    .mld(4).push(500).gt().jz("end")
    .pos(a).push(0).lt().jnz("end")
    .short(a, bps).long(b, bps)
    .label("end").halt()
    .build();
}

export const BUILTIN_STRATEGIES: Record<string, (m?: number) => Uint8Array> = {
  momentum: (m = 0) => momentum(m),
  meanReversion: (m = 0) => meanReversion(m),
  breakout: (m = 0) => breakout(m),
  randomWalk: (m = 0) => randomWalk(m),
  alwaysLong: (m = 0) => alwaysLong(m),
  degen: (m = 0) => degen(m),
};
