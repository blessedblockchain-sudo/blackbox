//! BLACKBOX strategy VM (Phase 2 fills this in). Kept as a no_std-capable crate
//! so the on-chain program, the fuzz targets, the TS compiler (via wasm) and the
//! simulator all share one executor.
#![cfg_attr(not(feature = "std"), no_std)]

/// Bytecode format version.
pub const BYTECODE_VERSION: u8 = 1;

/// Maximum bytecode length accepted on-chain.
pub const MAX_BYTECODE_LEN: usize = 4096;

/// Default maximum number of VM steps per tick.
pub const DEFAULT_STEP_LIMIT: u32 = 512;

#[cfg(test)]
mod tests {
    #[test]
    fn constants_are_sane() {
        assert!(super::MAX_BYTECODE_LEN <= 4096);
        assert!(super::DEFAULT_STEP_LIMIT > 0);
    }
}
