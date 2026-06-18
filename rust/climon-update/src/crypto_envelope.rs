//! AES-256-GCM + scrypt encryption envelope. Port of
//! `src/update/crypto-envelope.ts`.
//!
//! Envelope layout (byte-exact with the Bun side):
//! `[MAGIC "CLMENV1" (7)][salt(16)][iv(12)][tag(16)][ciphertext...]`.
//! Key = scrypt(password, salt, dkLen=32) with N=32768, r=8, p=1.
//! Cipher = AES-256-GCM (12-byte nonce, 16-byte tag).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};

/// Envelope scheme identifier, stored in `manifest.encryption`.
pub const ENVELOPE_SCHEME: &str = "aes-256-gcm-scrypt-v1";

/// 7-byte magic prefix identifying a climon encryption envelope.
const MAGIC: &[u8; 7] = b"CLMENV1";
const SALT_LEN: usize = 16;
const IV_LEN: usize = 12; // GCM standard nonce length
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32; // AES-256

// scrypt cost: N=2^15, r=8, p=1. log2_n = 15.
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

/// Reason a decrypt attempt failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptError {
    /// Buffer too short or wrong magic prefix.
    Malformed,
    /// GCM authentication failed (wrong/rotated password or tampering).
    WrongPassword,
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .expect("valid scrypt params");
    let mut out = [0u8; KEY_LEN];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut out)
        .expect("scrypt derivation succeeds for valid params");
    out
}

/// Encrypts plaintext into a self-describing envelope:
/// `[MAGIC(7)][salt(16)][iv(12)][tag(16)][ciphertext...]`.
pub fn encrypt_envelope(plaintext: &[u8], password: &str) -> Vec<u8> {
    let mut salt = [0u8; SALT_LEN];
    let mut iv = [0u8; IV_LEN];
    fill_random(&mut salt);
    fill_random(&mut iv);

    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(&iv);
    // aes-gcm appends the 16-byte tag to the ciphertext.
    let mut sealed = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &[],
            },
        )
        .expect("AES-256-GCM encryption succeeds");

    let body_len = sealed.len() - TAG_LEN;
    let tag = sealed.split_off(body_len);
    let body = sealed;

    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + IV_LEN + TAG_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&tag);
    out.extend_from_slice(&body);
    out
}

/// Decrypts an envelope produced by [`encrypt_envelope`]. Never panics. A
/// wrong/rotated password or any tampering fails GCM authentication and is
/// reported as [`DecryptError::WrongPassword`]; a short or mis-magic buffer is
/// [`DecryptError::Malformed`].
pub fn decrypt_envelope(envelope: &[u8], password: &str) -> Result<Vec<u8>, DecryptError> {
    let header_len = MAGIC.len() + SALT_LEN + IV_LEN + TAG_LEN;
    if envelope.len() < header_len || &envelope[..MAGIC.len()] != MAGIC {
        return Err(DecryptError::Malformed);
    }
    let mut off = MAGIC.len();
    let salt = &envelope[off..off + SALT_LEN];
    off += SALT_LEN;
    let iv = &envelope[off..off + IV_LEN];
    off += IV_LEN;
    let tag = &envelope[off..off + TAG_LEN];
    off += TAG_LEN;
    let body = &envelope[off..];

    let key = derive_key(password, salt);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(iv);

    // aes-gcm expects ciphertext||tag concatenated.
    let mut combined = Vec::with_capacity(body.len() + TAG_LEN);
    combined.extend_from_slice(body);
    combined.extend_from_slice(tag);

    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &combined,
                aad: &[],
            },
        )
        .map_err(|_| DecryptError::WrongPassword)
}

fn fill_random(buf: &mut [u8]) {
    use aes_gcm::aead::rand_core::RngCore;
    aes_gcm::aead::OsRng.fill_bytes(buf);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_plaintext_with_correct_password() {
        let env = encrypt_envelope(b"hello climon", "s3cret");
        let out = decrypt_envelope(&env, "s3cret").unwrap();
        assert_eq!(out, b"hello climon");
    }

    #[test]
    fn round_trips_empty_plaintext() {
        let env = encrypt_envelope(&[], "pw");
        let out = decrypt_envelope(&env, "pw").unwrap();
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn wrong_password_fails_with_wrong_password_reason() {
        let env = encrypt_envelope(b"x", "right");
        assert_eq!(
            decrypt_envelope(&env, "wrong"),
            Err(DecryptError::WrongPassword)
        );
    }

    #[test]
    fn malformed_envelope_fails_with_malformed_reason() {
        assert_eq!(
            decrypt_envelope(&[1, 2, 3], "x"),
            Err(DecryptError::Malformed)
        );
    }

    #[test]
    fn each_encryption_uses_a_fresh_salt_and_nonce() {
        let a = encrypt_envelope(b"same", "pw");
        let b = encrypt_envelope(b"same", "pw");
        assert_ne!(a, b);
    }

    #[test]
    fn scheme_id_is_stable() {
        assert_eq!(ENVELOPE_SCHEME, "aes-256-gcm-scrypt-v1");
    }

    #[test]
    fn header_layout_matches_spec() {
        let env = encrypt_envelope(b"abc", "pw");
        assert_eq!(&env[..7], b"CLMENV1");
        // MAGIC(7)+salt(16)+iv(12)+tag(16) = 51 byte header, then ciphertext.
        assert_eq!(env.len(), 51 + 3);
    }
}
