//! Detached Ed25519 signature verification. Port of `src/update/verify.ts`.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};

/// Verifies a detached Ed25519 signature over `data` using a base64 raw public
/// key (32 bytes) and a base64 signature (64 bytes). Returns `false` on any
/// error (bad key, bad signature, mismatch) rather than erroring, matching the
/// TypeScript `verifySignature` contract byte-for-byte.
pub fn verify_signature(data: &[u8], signature_b64: &str, public_key_b64: &str) -> bool {
    if public_key_b64.is_empty() {
        return false;
    }
    let raw_key = match STANDARD.decode(public_key_b64) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig = match STANDARD.decode(signature_b64) {
        Ok(s) => s,
        Err(_) => return false,
    };
    if raw_key.len() != 32 || sig.len() != 64 {
        return false;
    }
    let key_bytes: [u8; 32] = match raw_key.try_into() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig_bytes: [u8; 64] = match sig.try_into() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let key = match VerifyingKey::from_bytes(&key_bytes) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let signature = Signature::from_bytes(&sig_bytes);
    key.verify_strict(data, &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn make_keypair() -> (SigningKey, String) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let pub_b64 = STANDARD.encode(signing.verifying_key().to_bytes());
        (signing, pub_b64)
    }

    #[test]
    fn accepts_a_valid_signature() {
        let (signing, pub_b64) = make_keypair();
        let data = b"hello climon";
        let sig_b64 = STANDARD.encode(signing.sign(data).to_bytes());
        assert!(verify_signature(data, &sig_b64, &pub_b64));
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let (signing, pub_b64) = make_keypair();
        let data = b"hello climon";
        let sig_b64 = STANDARD.encode(signing.sign(data).to_bytes());
        assert!(!verify_signature(b"hello climoN", &sig_b64, &pub_b64));
    }

    #[test]
    fn returns_false_for_an_empty_public_key() {
        assert!(!verify_signature(b"x", "AAAA", ""));
    }

    #[test]
    fn returns_false_for_wrong_length_key_or_sig() {
        let (signing, _pub_b64) = make_keypair();
        let data = b"hello";
        let sig_b64 = STANDARD.encode(signing.sign(data).to_bytes());
        // 4-byte key decodes but is not 32 bytes.
        assert!(!verify_signature(data, &sig_b64, "AAAA"));
    }
}
