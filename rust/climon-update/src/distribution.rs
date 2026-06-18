//! The distribution password embedded into gated builds by `build.rs`.
//!
//! `build.rs` always emits `CLIMON_DISTRIBUTION_PASSWORD_OBF` (empty in local,
//! dev, and public builds; XOR+hex obfuscated in gated builds), so `env!` is
//! always satisfied at compile time.

use crate::obfuscate::deobfuscate;

/// Hex-encoded, XOR-obfuscated distribution password baked in by `build.rs`.
/// Empty when no password was embedded.
const EMBEDDED_OBF_HEX: &str = env!("CLIMON_DISTRIBUTION_PASSWORD_OBF");

/// Returns the embedded distribution password, de-obfuscated, or `None` when no
/// password was baked into this binary (or the marker is malformed). Never
/// panics.
pub fn embedded_distribution_password() -> Option<String> {
    if EMBEDDED_OBF_HEX.is_empty() {
        return None;
    }
    deobfuscate(EMBEDDED_OBF_HEX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_matches_build_configuration() {
        // The test binary is normally built WITHOUT CLIMON_DISTRIBUTION_PASSWORD
        // (local/CI), so the marker is empty and no password is present. If a
        // gated build runs the tests, the marker must de-obfuscate to a value.
        if EMBEDDED_OBF_HEX.is_empty() {
            assert_eq!(embedded_distribution_password(), None);
        } else {
            assert!(embedded_distribution_password().is_some());
        }
    }
}
