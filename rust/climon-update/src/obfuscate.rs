//! Shared XOR + hex obfuscation for the embedded distribution password.
//!
//! This file is `include!`d by `build.rs` (to obfuscate the password at build
//! time) AND compiled into the crate as `mod obfuscate` (to de-obfuscate it at
//! runtime), so the two halves can never drift. It must stay dependency-free
//! (std only) because build scripts do not share the crate's dependencies.
//!
//! NOTE: XOR against a fixed, in-binary key is OBFUSCATION, not encryption. It
//! only keeps the password out of trivial `strings`/grep inspection. Security
//! comes from the plaintext binary shipping solely from the gated private repo.

/// Fixed XOR key. Obfuscation only — NOT a secret.
pub const XOR_KEY: &[u8] = b"climon-distribution-obfuscation-key-v1";

const HEX: &[u8; 16] = b"0123456789abcdef";

/// XOR `plaintext` against [`XOR_KEY`] (repeating) and lowercase-hex-encode it.
pub fn obfuscate(plaintext: &[u8]) -> String {
    let mut out = String::with_capacity(plaintext.len() * 2);
    for (i, b) in plaintext.iter().enumerate() {
        let x = b ^ XOR_KEY[i % XOR_KEY.len()];
        out.push(HEX[(x >> 4) as usize] as char);
        out.push(HEX[(x & 0x0f) as usize] as char);
    }
    out
}

/// Reverse of [`obfuscate`]: hex-decode then XOR. Returns `None` on malformed
/// hex (odd length / non-hex digit) or non-UTF-8 output. Never panics.
pub fn deobfuscate(hex: &str) -> Option<String> {
    let bytes = hex.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i])?;
        let lo = hex_val(bytes[i + 1])?;
        let x = (hi << 4) | lo;
        out.push(x ^ XOR_KEY[(i / 2) % XOR_KEY.len()]);
        i += 2;
    }
    String::from_utf8(out).ok()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_password() {
        let pw = "s3cret-shared-password";
        let obf = obfuscate(pw.as_bytes());
        assert_eq!(deobfuscate(&obf).as_deref(), Some(pw));
    }

    #[test]
    fn obfuscated_output_hides_plaintext() {
        // 'S', 'P', 'W', '!', '-' are not lowercase hex digits, so the
        // plaintext substring cannot appear in the hex output.
        let pw = "Secret-PW!";
        let obf = obfuscate(pw.as_bytes());
        assert!(!obf.contains(pw));
        assert_ne!(obf, pw);
    }

    #[test]
    fn deobfuscate_rejects_malformed_hex() {
        assert_eq!(deobfuscate("abc"), None); // odd length
        assert_eq!(deobfuscate("zz"), None); // non-hex digit
    }
}
