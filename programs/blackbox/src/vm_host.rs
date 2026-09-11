//! The VM's view of the world during one tick: market indicators, the
//! entrant's position, and the round's randomness.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::constants::{MAX_MARKETS, USDC_SCALE};
use crate::perps;
use crate::state::{Leg, Market};

pub struct TickHost<'a> {
    pub markets: &'a [Option<Market>; MAX_MARKETS],
    pub n_markets: u8,
    pub legs: &'a [Leg; MAX_MARKETS],
    pub equity: i64,
    pub free_margin: i64,
    pub tick: u64,
    pub rand: i64,
}

impl<'a> TickHost<'a> {
    /// Deterministic per-(round seed, owner, tick) randomness in [0, SCALE).
    pub fn derive_rand(vrf_seed: &[u8; 32], owner: &Pubkey, tick: u64) -> i64 {
        let h = hashv(&[vrf_seed, owner.as_ref(), &tick.to_le_bytes()]);
        let v = u64::from_le_bytes(h.to_bytes()[..8].try_into().unwrap());
        (v % USDC_SCALE as u64) as i64
    }

    fn m(&self, i: u8) -> Option<&Market> {
        if i >= self.n_markets {
            return None;
        }
        self.markets[i as usize].as_ref()
    }
}

impl<'a> bxvm::Host for TickHost<'a> {
    fn n_markets(&self) -> u8 {
        self.n_markets
    }
    fn price(&self, market: u8) -> Option<i64> {
        self.m(market).map(|m| m.mark).filter(|p| *p > 0)
    }
    fn ema(&self, market: u8, k: u8) -> Option<i64> {
        let m = self.m(market)?;
        let v = match k {
            0 => m.ema8,
            1 => m.ema21,
            2 => m.ema55,
            _ => return None,
        };
        if v > 0 {
            Some(v)
        } else {
            None
        }
    }
    fn ret(&self, market: u8, n: u8) -> Option<i64> {
        let m = self.m(market)?;
        // Before the ring has enough history, report 0 rather than faulting.
        perps::ret(m, n as usize).or(Some(0))
    }
    fn vol(&self, market: u8) -> Option<i64> {
        self.m(market).map(|m| m.vol)
    }
    fn pos(&self, market: u8) -> i64 {
        if market as usize >= MAX_MARKETS {
            return 0;
        }
        let l = &self.legs[market as usize];
        l.size as i64 * l.side as i64
    }
    fn entry(&self, market: u8) -> i64 {
        if market as usize >= MAX_MARKETS {
            return 0;
        }
        self.legs[market as usize].entry
    }
    fn equity(&self) -> i64 {
        self.equity
    }
    fn free_margin(&self) -> i64 {
        self.free_margin
    }
    fn tick(&self) -> i64 {
        self.tick as i64
    }
    fn rand(&self) -> i64 {
        self.rand
    }
}
