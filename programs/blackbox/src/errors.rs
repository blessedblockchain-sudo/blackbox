use anchor_lang::prelude::*;

#[error_code]
pub enum BlackboxError {
    #[msg("protocol is paused")]
    Paused,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("round is not in the expected status")]
    BadRoundStatus,
    #[msg("round is full")]
    RoundFull,
    #[msg("market index out of range")]
    BadMarketIndex,
    #[msg("market already configured")]
    MarketExists,
    #[msg("invalid market config")]
    BadMarketConfig,
    #[msg("deposit outside [min_margin, max_margin]")]
    BadDeposit,
    #[msg("strategy bytecode failed validation")]
    BadBytecode,
    #[msg("strategy bytecode too long")]
    BytecodeTooLong,
    #[msg("price feed account is invalid, stale, or for another feed")]
    BadOracle,
    #[msg("bad ephemeral ATA or delegation PDA")]
    BadEata,
    #[msg("permission account already exists")]
    PermissionExists,
    #[msg("account is not delegated or not on the expected validator")]
    NotDelegated,
    #[msg("failed to serialize instruction")]
    SerializeFailed,
    #[msg("entrant already privatized")]
    AlreadyPrivatized,
    #[msg("round is not live")]
    NotLive,
    #[msg("wrong round for this account")]
    RoundMismatch,
    #[msg("wrong owner for this account")]
    OwnerMismatch,
    #[msg("batch index out of range")]
    BadBatch,
    #[msg("insufficient margin")]
    InsufficientMargin,
    #[msg("position would exceed max leverage")]
    LeverageExceeded,
    #[msg("open interest cap reached")]
    OiCap,
    #[msg("license limit reached for this author")]
    LicenseLimit,
    #[msg("license is not active")]
    LicenseInactive,
    #[msg("scoreboard is full")]
    ScoreboardFull,
    #[msg("entrant not found on scoreboard")]
    NotOnScoreboard,
    #[msg("round has not ended yet")]
    RoundNotEnded,
    #[msg("round already finalized")]
    AlreadyFinalized,
    #[msg("crank task guard: round not live")]
    CrankInactive,
    #[msg("VRF randomness not ready")]
    VrfNotReady,
}
