/**
 * Idiomatic BXL programs. Each compiles for a round whose markets include
 * SOL, BTC and ETH (in any order; "SOL" also matches "SOL-PERP").
 */
export const EXAMPLES: Record<string, string> = {
  momentum: `# Momentum: EMA(8) vs EMA(21) on SOL, always in the market.
# Same behavior as the built-in momentum bot (strategies.momentum in the SDK).
let up = ema(SOL, 8) > ema(SOL, 21)
if up {
  if pos(SOL) <= 0 { long(SOL, 30%) }
} else {
  if pos(SOL) >= 0 { short(SOL, 30%) }
}
`,

  trend: `# Trend: EMA(8) vs EMA(21), confirmed by the slow EMA(55).
# Long in a confirmed uptrend, short in a confirmed downtrend, flat otherwise.
let fast = ema(SOL, 8)
let slow = ema(SOL, 21)
let base = ema(SOL, 55)
if fast > slow and slow > base {
  if pos(SOL) <= 0 { long(SOL, 40%) }
} elif fast < slow and slow < base {
  if pos(SOL) >= 0 { short(SOL, 40%) }
} elif pos(SOL) != 0 {
  close(SOL)
}
`,

  meanReversion: `# Mean reversion: fade sharp 8-tick moves on SOL, flatten once the move fades.
let r = ret(SOL, 8)
if r < -0.08% {
  if pos(SOL) <= 0 { long(SOL, 25%) }
} elif r > 0.08% {
  if pos(SOL) >= 0 { short(SOL, 25%) }
} elif abs(r) < 0.02% and pos(SOL) != 0 {
  close(SOL)
}
`,

  breakout: `# Breakout with a volatility filter on BTC: go with 16-tick moves larger than
# twice the realized (per-tick) volatility, but only while volatility is calm
# enough to trust the signal. vol() is 0 until the market has a few ticks.
let move = ret(BTC, 16)
let v = vol(BTC)
let calm = v > 0 and v < 0.5%
if calm and move > 2 * v {
  if pos(BTC) <= 0 { long(BTC, 40%) }
} elif calm and move < -2 * v {
  if pos(BTC) >= 0 { short(BTC, 40%) }
}
`,

  pairs: `# Pairs: SOL against BTC. When SOL's 8-tick return lags BTC's by more than
# 0.05%, buy SOL and sell BTC; reverse when it leads; flatten when they re-converge.
let spread = ret(SOL, 8) - ret(BTC, 8)
if spread < -0.05% {
  if pos(SOL) <= 0 {
    long(SOL, 20%)
    short(BTC, 20%)
  }
} elif spread > 0.05% {
  if pos(SOL) >= 0 {
    short(SOL, 20%)
    long(BTC, 20%)
  }
} elif abs(spread) < 0.01% and pos(SOL) != 0 {
  close(SOL)
  close(BTC)
}
`,

  cooldown: `# Cooldown: ETH momentum that waits 20 ticks after every trade.
# mem[0] counts the cooldown down, mem[1] remembers the side we hold (1 / -1).
if mem[0] > 0 {
  mem[0] = mem[0] - 1
  halt()
}
let up = ema(ETH, 8) > ema(ETH, 21)
if up and mem[1] != 1 {
  long(ETH, 30%)
  mem[1] = 1
  mem[0] = 20
} elif not up and mem[1] != -1 {
  short(ETH, 30%)
  mem[1] = -1
  mem[0] = 20
}
`,

  drawdownStop: `# Risk managed: SOL trend with a high-water mark kept in memory.
# mem[0] = peak equity; mem[1] = 1 once stopped out (flat for the rest of the round).
let eq = equity()
if eq > mem[0] { mem[0] = eq }
if mem[1] == 1 { halt() }
if eq < mem[0] * 0.9 {
  # 10% below the peak: flatten everything and stop trading.
  close_all()
  mem[1] = 1
  halt()
}
# Trade smaller once 5% below the peak.
let hurt = eq < mem[0] * 0.95
let up = ema(SOL, 8) > ema(SOL, 21)
if up and pos(SOL) <= 0 {
  if hurt { long(SOL, 10%) } else { long(SOL, 30%) }
} elif not up and pos(SOL) >= 0 {
  if hurt { short(SOL, 10%) } else { short(SOL, 30%) }
}
`,

  rotation: `# Rotation: hold whichever of SOL, BTC and ETH is strongest over 32 ticks,
# and nothing while all three are falling.
let s = ret(SOL, 32)
let b = ret(BTC, 32)
let e = ret(ETH, 32)
let best = max(s, max(b, e))
if best <= 0 {
  close_all()
} elif s == best and pos(SOL) <= 0 {
  close(BTC)
  close(ETH)
  long(SOL, 50%)
} elif b == best and s != best and pos(BTC) <= 0 {
  close(SOL)
  close(ETH)
  long(BTC, 50%)
} elif e == best and s != best and b != best and pos(ETH) <= 0 {
  close(SOL)
  close(BTC)
  long(ETH, 50%)
}
`,
};
