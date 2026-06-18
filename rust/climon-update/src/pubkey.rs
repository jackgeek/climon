//! Embedded Ed25519 update public key. Port of `src/update/pubkey.ts`.
//!
//! The base64 value is injected at build time from `src/update/pubkey.ts` by
//! `build.rs` so the Rust updater verifies against the *exact same* key as the
//! Bun client. An empty value disables verification-backed updates.

/// Base64 of the 32-byte raw Ed25519 public key used to verify update artifacts.
/// Synced from `src/update/pubkey.ts` at build time (see `build.rs`).
pub const UPDATE_PUBLIC_KEY_B64: &str = env!("CLIMON_UPDATE_PUBKEY_B64");

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn is_a_string() {
        // Mirrors the TS "is a string (may be empty until provisioned)" test.
        let _: &str = UPDATE_PUBLIC_KEY_B64;
    }

    #[test]
    fn when_set_decodes_to_32_raw_bytes() {
        if UPDATE_PUBLIC_KEY_B64.is_empty() {
            return;
        }
        let bytes = STANDARD.decode(UPDATE_PUBLIC_KEY_B64).unwrap();
        assert_eq!(bytes.len(), 32);
    }
}
