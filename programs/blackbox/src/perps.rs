//! Perps engine math. Pure functions over `Market`, `Leg` and margin so the
//! same code runs on-chain, in tests, and (via the simulator) off-chain.
//!
//! Units: prices and USDC amounts are 6-decimal fixed point (`SCALE`);
//! fractions (spread, skew, returns) are also 6-decimal fixed point;
//! `*_bps` values are basis points.

use anchor_lang::prelude::*;

use crate::constants::{BPS, MAX_MARKETS, RING_LEN, USDC_SCALE as SCALE};
use crate::errors::BlackboxError;
use crate::state::{Leg, Market};

/// i128 helpers ------------------------------------------------------------

#[inline]
fn mul_div(a: i128, b: i128, d: i128) -> Result<i128> {
    require!(d != 0, BlackboxError::MathOverflow);
    Ok(a.checked_mul(b).ok_or(BlackboxError::MathOverflow)? / d)
}

#[inline]
fn to_i64(v: i128) -> Result<i64> {
    require!(v >= i64::MIN as i128 && v <= i64::MAX as i128, BlackboxError::MathOverflow);
    Ok(v as i64)
}

/// Integer square root (floor) for non-negative i128.
pub fn isqrt(v: i128) -> i128 {
    if v <= 0 {
        return 0;
    }
    let mut x = v;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + v / x) / 2;
    }
    x
}

/// Market indicators ---------------------------------------------------------

/// Push a new mark into the market's ring buffer and refresh EMAs and vol.
pub fn update_indicators(m: &mut Market, mark: i64, tick: u64, publish_time: i64) -> Result<()> {
    let pos = m.ring_pos as usize;
    m.ring[pos] = mark;
    m.ring_pos = ((pos + 1) % RING_LEN) as u8;
    if (m.ring_len as usize) < RING_LEN {
        m.ring_len += 1;
    }
    if m.ema8 == 0 {
        m.ema8 = mark;
        m.ema21 = mark;
        m.ema55 = mark;
    } else {
        m.ema8 = ema_step(m.ema8, mark, 8)?;
        m.ema21 = ema_step(m.ema21, mark, 21)?;
        m.ema55 = ema_step(m.ema55, mark, 55)?;
    }
    m.vol = realized_vol(m)?;
    m.mark = mark;
    m.last_tick = tick;
    m.last_publish_time = publish_time;
    Ok(())
}

/// ema += (mark - ema) * 2 / (n + 1)
#[inline]
fn ema_step(ema: i64, mark: i64, n: i64) -> Result<i64> {
    let diff = mark as i128 - ema as i128;
    let adj = diff * 2 / (n as i128 + 1);
    to_i64(ema as i128 + adj)
}

/// Mark `n` ticks ago (n >= 1). None if the ring does not have it yet.
pub fn mark_ago(m: &Market, n: usize) -> Option<i64> {
    if n == 0 || n > m.ring_len as usize || n > RING_LEN {
        return None;
    }
    let idx = (m.ring_pos as usize + RING_LEN - n) % RING_LEN;
    Some(m.ring[idx])
}

/// Return over the last n ticks as a scaled fraction: mark/mark_ago - 1.
pub fn ret(m: &Market, n: usize) -> Option<i64> {
    let then = mark_ago(m, n + 1)?; // the newest ring entry is the current mark
    if then <= 0 {
        return None;
    }
    let r = mul_div(m.mark as i128 - then as i128, SCALE as i128, then as i128).ok()?;
    to_i64(r).ok()
}

/// Realized volatility: sqrt(mean(r_i^2)) over consecutive ring returns, scaled.
fn realized_vol(m: &Market) -> Result<i64> {
    let n = m.ring_len as usize;
    if n < 3 {
        return Ok(0);
    }
    let mut sum_sq: i128 = 0;
    let mut count: i128 = 0;
    let newest = m.ring_pos as usize; // one past the newest
    for k in 1..n {
        let a_idx = (newest + RING_LEN - k) % RING_LEN; // newer
        let b_idx = (newest + RING_LEN - k - 1) % RING_LEN; // older
        let a = m.ring[a_idx] as i128;
        let b = m.ring[b_idx] as i128;
        if b <= 0 {
            continue;
        }
        let r = mul_div(a - b, SCALE as i128, b)?; // scaled fraction
        sum_sq = sum_sq.checked_add(r * r).ok_or(BlackboxError::MathOverflow)?;
        count += 1;
    }
    if count == 0 {
        return Ok(0);
    }
    to_i64(isqrt(sum_sq / count))
}

/// Pricing ---------------------------------------------------------------------

/// Skew in [-SCALE, SCALE]: (oi_long - oi_short) / oi_cap.
pub fn skew(m: &Market) -> i64 {
    if m.oi_cap == 0 {
        return 0;
    }
    let s = mul_div(m.oi_long as i128 - m.oi_short as i128, SCALE as i128, m.oi_cap as i128).unwrap_or(0);
    s.clamp(-(SCALE as i128), SCALE as i128) as i64
}

/// Spread in scaled fraction for a trade that buys (+1) or sells (-1) exposure.
/// Trading with the skew (making it larger) pays more.
pub fn spread_frac(m: &Market, buy_side: i8) -> i64 {
    let sk = skew(m) as i128; // scaled
    let with_skew = (sk * buy_side as i128) > 0;
    let base = m.base_spread_bps as i128 * SCALE as i128 / BPS as i128;
    let extra = if with_skew {
        (m.skew_spread_bps as i128 * sk.abs()) / BPS as i128
    } else {
        0
    };
    (base + extra).min(SCALE as i128 / 5) as i64 // cap spread at 20%
}

/// Fill price for buying (+1) or selling (-1) at `mark`.
pub fn fill_price(m: &Market, buy_side: i8) -> Result<i64> {
    let sp = spread_frac(m, buy_side) as i128;
    let px = if buy_side > 0 {
        mul_div(m.mark as i128, SCALE as i128 + sp, SCALE as i128)?
    } else {
        mul_div(m.mark as i128, SCALE as i128 - sp, SCALE as i128)?
    };
    to_i64(px)
}

/// PnL ----------------------------------------------------------------------------

/// Unrealized PnL of a leg at `mark`: side * size * (mark - entry) / entry.
pub fn unrealized(leg: &Leg, mark: i64) -> Result<i64> {
    if leg.side == 0 || leg.size == 0 || leg.entry <= 0 {
        return Ok(0);
    }
    let v = mul_div(leg.size as i128 * leg.side as i128, mark as i128 - leg.entry as i128, leg.entry as i128)?;
    to_i64(v)
}

/// Funding owed by a leg since its last index update (positive = pays).
pub fn funding_owed(leg: &Leg, market_index: i64) -> Result<i64> {
    if leg.side == 0 || leg.size == 0 {
        return Ok(0);
    }
    let delta = market_index as i128 - leg.funding_index as i128; // scaled fraction
    let v = mul_div(leg.size as i128 * leg.side as i128, delta, SCALE as i128)?;
    to_i64(v)
}

/// Equity = margin + realized + Σ unrealized - Σ funding owed.
pub fn equity(margin: u64, realized: i64, legs: &[Leg; MAX_MARKETS], marks: &[i64; MAX_MARKETS], findex: &[i64; MAX_MARKETS]) -> Result<i64> {
    let mut e = margin as i128 + realized as i128;
    for i in 0..MAX_MARKETS {
        if legs[i].side != 0 {
            e += unrealized(&legs[i], marks[i])? as i128;
            e -= funding_owed(&legs[i], findex[i])? as i128;
        }
    }
    to_i64(e)
}

/// Total notional and maintenance requirement.
pub fn notional_and_maintenance(legs: &[Leg; MAX_MARKETS], maint_bps: &[u16; MAX_MARKETS]) -> (i128, i128) {
    let mut notional: i128 = 0;
    let mut maint: i128 = 0;
    for i in 0..MAX_MARKETS {
        if legs[i].side != 0 {
            notional += legs[i].size as i128;
            maint += legs[i].size as i128 * maint_bps[i] as i128 / BPS as i128;
        }
    }
    (notional, maint)
}

/// Result of applying a trade to a leg.
pub struct TradeResult {
    pub realized_delta: i64,
    pub funding_paid: i64,
    pub oi_long_delta: i128,
    pub oi_short_delta: i128,
    pub traded: bool,
}

/// Move a leg to a target signed notional (`target` > 0 long, < 0 short, 0 flat)
/// at the market's fill prices. Realizes PnL on the reduced part and settles
/// funding into realized. Enforces leverage (against `equity_now`) and OI caps.
pub fn trade_to_target(
    m: &mut Market,
    leg: &mut Leg,
    target: i128,
    equity_now: i64,
    other_notional: i128,
) -> Result<TradeResult> {
    let mut out = TradeResult { realized_delta: 0, funding_paid: 0, oi_long_delta: 0, oi_short_delta: 0, traded: false };
    let cur: i128 = leg.size as i128 * leg.side as i128;
    if target == cur {
        return Ok(out);
    }
    require!(m.mark > 0, BlackboxError::BadOracle);

    // Settle funding on the existing leg first.
    if leg.side != 0 {
        let f = funding_owed(leg, m.funding_index)?;
        out.funding_paid = f;
        out.realized_delta = out.realized_delta.saturating_sub(f);
        leg.funding_index = m.funding_index;
    }

    // Leverage check on the resulting book: |target| + others <= equity * max_lev.
    let max_notional = equity_now.max(0) as i128 * m.max_leverage as i128;
    require!(target.abs() + other_notional <= max_notional, BlackboxError::LeverageExceeded);

    // Split into reduce (towards zero / flip) and increase (away from zero).
    let same_sign = (cur > 0 && target > 0) || (cur < 0 && target < 0);
    let (reduce_to, increase_to) = if cur == 0 {
        (0i128, target)
    } else if same_sign {
        if target.abs() < cur.abs() {
            (target, target)
        } else {
            (cur, target)
        }
    } else {
        (0i128, target)
    };

    // 1) Reduce |cur| -> |reduce_to| on the same side, realizing PnL.
    if reduce_to.abs() < cur.abs() {
        let closed = cur.abs() - reduce_to.abs(); // notional closed
        let sell_side: i8 = if cur > 0 { -1 } else { 1 }; // closing a long sells
        let px = fill_price(m, sell_side)? as i128;
        let pnl = mul_div(closed * leg.side as i128, px - leg.entry as i128, leg.entry as i128)?;
        out.realized_delta = to_i64(out.realized_delta as i128 + pnl)?;
        if cur > 0 {
            out.oi_long_delta -= closed;
        } else {
            out.oi_short_delta -= closed;
        }
        leg.size = reduce_to.abs() as u64;
        if leg.size == 0 {
            leg.side = 0;
            leg.entry = 0;
        }
        out.traded = true;
    }

    // 2) Increase to |increase_to| (possibly on the flipped side).
    if increase_to.abs() > leg.size as i128 {
        let side: i8 = if increase_to > 0 { 1 } else { -1 };
        let added = increase_to.abs() - leg.size as i128;
        let px = fill_price(m, side)? as i128; // opening a long buys
        // OI cap per side
        let side_oi = if side > 0 { m.oi_long as i128 + out.oi_long_delta } else { m.oi_short as i128 + out.oi_short_delta };
        require!(side_oi + added <= m.oi_cap as i128, BlackboxError::OiCap);
        if leg.size == 0 {
            leg.side = side;
            leg.entry = to_i64(px)?;
            leg.funding_index = m.funding_index;
        } else {
            // weighted average entry
            let old = leg.size as i128;
            let new_entry = (old * leg.entry as i128 + added * px) / (old + added);
            leg.entry = to_i64(new_entry)?;
        }
        leg.size = increase_to.abs() as u64;
        if side > 0 {
            out.oi_long_delta += added;
        } else {
            out.oi_short_delta += added;
        }
        out.traded = true;
    }

    // Apply OI deltas to the market.
    m.oi_long = to_i64((m.oi_long as i128 + out.oi_long_delta).max(0))? as u64;
    m.oi_short = to_i64((m.oi_short as i128 + out.oi_short_delta).max(0))? as u64;
    Ok(out)
}

/// Close every leg at fill prices; returns realized delta (incl. funding) and OI deltas applied.
pub fn close_all(markets: &mut [Option<&mut Market>; MAX_MARKETS], legs: &mut [Leg; MAX_MARKETS]) -> Result<i64> {
    let mut realized: i128 = 0;
    for i in 0..MAX_MARKETS {
        if legs[i].side == 0 {
            continue;
        }
        if let Some(m) = markets[i].as_deref_mut() {
            let r = trade_to_target(m, &mut legs[i], 0, i64::MAX / 4, 0)?;
            realized += r.realized_delta as i128;
        }
    }
    to_i64(realized)
}

/// Funding rate update: index += rate(skew) per funding period.
/// rate = skew * rate_scale where rate_scale is bps per period at full skew.
pub fn accrue_funding(m: &mut Market, rate_bps_at_full_skew: i32) -> Result<()> {
    let sk = skew(m) as i128; // scaled
    let rate = sk * rate_bps_at_full_skew as i128 / BPS as i128; // scaled fraction per period
    m.funding_rate_bps = (rate * BPS as i128 / SCALE as i128) as i32;
    m.funding_index = to_i64(m.funding_index as i128 + rate)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market(mark: i64) -> Market {
        Market {
            round: Pubkey::default(),
            index: 0,
            feed: Pubkey::default(),
            decimals: 8,
            max_leverage: 10,
            maintenance_bps: 500,
            base_spread_bps: 5,
            skew_spread_bps: 50,
            oi_cap: 1_000_000 * SCALE as u64,
            oi_long: 0,
            oi_short: 0,
            funding_index: 0,
            funding_rate_bps: 0,
            last_funding_tick: 0,
            mark,
            last_publish_time: 0,
            last_tick: 0,
            ring: [0; RING_LEN],
            ring_pos: 0,
            ring_len: 0,
            ema8: 0,
            ema21: 0,
            ema55: 0,
            vol: 0,
            bump: 0,
        }
    }

    #[test]
    fn open_and_close_long_realizes_pnl() {
        let mut m = market(100 * SCALE);
        let mut leg = Leg::default();
        let eq = 1_000 * SCALE;
        let r = trade_to_target(&mut m, &mut leg, 3_000 * SCALE as i128, eq, 0).unwrap();
        assert!(r.traded);
        assert_eq!(leg.side, 1);
        assert_eq!(leg.size, 3_000 * SCALE as u64);
        assert!(leg.entry > 100 * SCALE); // paid the spread
        assert_eq!(m.oi_long, 3_000 * SCALE as u64);
        m.mark = 110 * SCALE;
        let u = unrealized(&leg, m.mark).unwrap();
        assert!(u > 290 * SCALE && u < 300 * SCALE, "u={}", u);
        let r2 = trade_to_target(&mut m, &mut leg, 0, eq + u, 0).unwrap();
        assert_eq!(leg.side, 0);
        assert!(r2.realized_delta > 290 * SCALE && r2.realized_delta < 300 * SCALE, "{}", r2.realized_delta);
        assert_eq!(m.oi_long, 0);
    }

    #[test]
    fn leverage_and_oi_caps() {
        let mut m = market(100 * SCALE);
        let mut leg = Leg::default();
        let eq = 1_000 * SCALE;
        assert!(trade_to_target(&mut m, &mut leg, 20_000 * SCALE as i128, eq, 0).is_err());
        m.oi_cap = 100 * SCALE as u64;
        assert!(trade_to_target(&mut m, &mut leg, 200 * SCALE as i128, eq, 0).is_err());
    }

    #[test]
    fn flip_side() {
        let mut m = market(100 * SCALE);
        let mut leg = Leg::default();
        let eq = 1_000 * SCALE;
        trade_to_target(&mut m, &mut leg, 1_000 * SCALE as i128, eq, 0).unwrap();
        trade_to_target(&mut m, &mut leg, -500 * SCALE as i128, eq, 0).unwrap();
        assert_eq!(leg.side, -1);
        assert_eq!(leg.size, 500 * SCALE as u64);
        assert_eq!(m.oi_long, 0);
        assert_eq!(m.oi_short, 500 * SCALE as u64);
    }

    #[test]
    fn indicators_and_returns() {
        let mut m = market(0);
        for (t, px) in [100i64, 101, 102, 103, 104].iter().enumerate() {
            update_indicators(&mut m, px * SCALE, t as u64, 0).unwrap();
        }
        assert_eq!(m.mark, 104 * SCALE);
        assert_eq!(mark_ago(&m, 1), Some(104 * SCALE));
        assert_eq!(mark_ago(&m, 2), Some(103 * SCALE));
        let r1 = ret(&m, 1).unwrap(); // 104/103 - 1
        assert!(r1 > 9_000 && r1 < 10_000, "{}", r1);
        assert!(m.ema8 > 100 * SCALE && m.ema8 < 104 * SCALE);
        assert!(m.vol > 0);
    }

    #[test]
    fn spread_widens_with_skew() {
        let mut m = market(100 * SCALE);
        let flat = spread_frac(&m, 1);
        m.oi_long = 500_000 * SCALE as u64; // 50% skew long
        let with = spread_frac(&m, 1);
        let against = spread_frac(&m, -1);
        assert!(with > flat);
        assert_eq!(against, flat);
    }
}
