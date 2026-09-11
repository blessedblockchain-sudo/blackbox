//! Pyth Lazer price accounts pushed by MagicBlock's oracle program.
//!
//! Layout verified on devnet-tee (134 bytes):
//!   0..8   discriminator
//!   8..40  write_authority
//!   40     verification_level tag (1 = Full, 0 = Partial + 1 extra byte)
//!   41..73 feed_id
//!   73..81 price i64
//!   81..89 conf u64
//!   89..93 exponent i32 (stored as +decimals on these feeds)
//!   93..101 publish_time i64

use anchor_lang::prelude::*;

use crate::constants::{MAX_ORACLE_AGE_SECS, ORACLE_PROGRAM_ID, USDC_SCALE};
use crate::errors::BlackboxError;

pub struct OraclePrice {
    /// Price in USDC 6dp fixed point.
    pub price: i64,
    pub publish_time: i64,
}

/// Decode and validate a price account. `decimals` is the known decimals of
/// the feed (we do not trust the sign of the stored exponent).
pub fn read_price(info: &AccountInfo, expected: &Pubkey, decimals: u8, now: i64) -> Result<OraclePrice> {
    require_keys_eq!(info.key(), *expected, BlackboxError::BadOracle);
    #[cfg(not(feature = "local-oracle"))]
    require_keys_eq!(*info.owner, ORACLE_PROGRAM_ID, BlackboxError::BadOracle);
    #[cfg(feature = "local-oracle")]
    require!(*info.owner == ORACLE_PROGRAM_ID || *info.owner == crate::ID, BlackboxError::BadOracle);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 101, BlackboxError::BadOracle);
    let tag = data[40];
    let feed_off = if tag == 0 { 42 } else { 41 };
    let p = feed_off + 32;
    require!(data.len() >= p + 28, BlackboxError::BadOracle);
    let raw = i64::from_le_bytes(data[p..p + 8].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[p + 20..p + 28].try_into().unwrap());
    require!(raw > 0, BlackboxError::BadOracle);
    // Staleness: MagicBlock pushes every 50-200ms; allow a few seconds of slack.
    if now > 0 && publish_time > 0 {
        require!(now - publish_time <= MAX_ORACLE_AGE_SECS, BlackboxError::BadOracle);
    }
    let price = scale_price(raw, decimals)?;
    Ok(OraclePrice { price, publish_time })
}

/// Convert a raw integer price with `decimals` into USDC 6dp.
pub fn scale_price(raw: i64, decimals: u8) -> Result<i64> {
    let v = raw as i128;
    let out = if decimals >= 6 {
        v / 10i128.pow((decimals - 6) as u32)
    } else {
        v * 10i128.pow((6 - decimals) as u32)
    };
    require!(out > 0 && out <= i64::MAX as i128, BlackboxError::BadOracle);
    let _ = USDC_SCALE;
    Ok(out as i64)
}

/// Size of a Pyth Lazer PriceUpdateV2 account as pushed by MagicBlock.
pub const PRICE_ACCOUNT_LEN: usize = 134;
/// Offsets within the account (Full verification level).
pub const OFF_TAG: usize = 40;
pub const OFF_FEED_ID: usize = 41;
pub const OFF_PRICE: usize = 73;
pub const OFF_CONF: usize = 81;
pub const OFF_EXPO: usize = 89;
pub const OFF_PUBLISH: usize = 93;

/// Write a price into a mock feed account using the real layout.
pub fn write_mock(data: &mut [u8], feed_id: u32, raw_price: i64, decimals: u8, publish_time: i64) -> Result<()> {
    require!(data.len() >= PRICE_ACCOUNT_LEN, BlackboxError::BadOracle);
    data[OFF_TAG] = 1;
    data[OFF_FEED_ID..OFF_FEED_ID + 4].copy_from_slice(&feed_id.to_le_bytes());
    data[OFF_PRICE..OFF_PRICE + 8].copy_from_slice(&raw_price.to_le_bytes());
    data[OFF_CONF..OFF_CONF + 8].copy_from_slice(&0u64.to_le_bytes());
    data[OFF_EXPO..OFF_EXPO + 4].copy_from_slice(&(decimals as i32).to_le_bytes());
    data[OFF_PUBLISH..OFF_PUBLISH + 8].copy_from_slice(&publish_time.to_le_bytes());
    Ok(())
}
