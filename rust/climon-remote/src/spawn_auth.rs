//! Signed, replay-protected envelope for server→devbox mux control messages.
//! Byte-for-byte counterpart of `src/remote/spawn-auth.ts`.
//!
//! The signed `payload` is the JSON string of an inner [`ControlMessage`] and is
//! transmitted verbatim; the signature covers the exact bytes that travel, so no
//! cross-language canonical JSON is needed — sign over what you send, verify over
//! what you receive, then parse.

use std::collections::HashMap;

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::mux::ControlMessage;

type HmacSha256 = Hmac<Sha256>;

/// Default acceptance window for timestamp freshness + replay tracking (ms).
pub const DEFAULT_FRESHNESS_WINDOW_MS: i64 = 30_000;

/// Why a signed control message was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// HMAC did not match the secret.
    BadSignature,
    /// `ts` is outside ±window of `now`.
    Stale,
    /// `nonce` was already seen within the window.
    Replay,
    /// `payload` was not valid JSON for a [`ControlMessage`].
    BadPayload,
    /// The control frame was not a [`ControlMessage::Signed`] envelope.
    NotSigned,
}

/// The canonical string the HMAC is computed over.
fn signing_input(payload: &str, nonce: &str, ts: i64) -> String {
    format!("{payload}\n{nonce}\n{ts}")
}

fn hmac_hex(secret: &str, message: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time HMAC verification: recompute over `message`, compare against the
/// received hex signature via `verify_slice` (constant time within the MAC).
fn verify_hmac(secret: &str, message: &str, sig_hex: &str) -> bool {
    let Ok(sig) = hex::decode(sig_hex) else {
        return false;
    };
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.verify_slice(&sig).is_ok()
}

/// A random 16-byte nonce, lowercase hex. Uses `getrandom` (already a dep).
pub fn new_nonce() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("getrandom fills the nonce buffer");
    hex::encode(bytes)
}

/// Wraps `message` in a [`ControlMessage::Signed`] envelope using the given
/// `nonce`/`ts` (injected for tests). Production callers use [`sign_now`].
pub fn sign_control(
    secret: &str,
    message: &ControlMessage,
    nonce: &str,
    ts: i64,
) -> ControlMessage {
    let payload = serde_json::to_string(message).expect("control message serializes to JSON");
    let sig = hmac_hex(secret, &signing_input(&payload, nonce, ts));
    ControlMessage::Signed {
        payload,
        nonce: nonce.to_string(),
        ts,
        sig,
    }
}

/// Convenience: sign with a fresh nonce and the supplied current time (ms).
pub fn sign_now(secret: &str, message: &ControlMessage, now_ms: i64) -> ControlMessage {
    sign_control(secret, message, &new_nonce(), now_ms)
}

/// Tracks recently-seen nonces within a freshness window to reject replays.
pub struct ReplayGuard {
    window_ms: i64,
    seen: HashMap<String, i64>,
}

impl ReplayGuard {
    pub fn new(window_ms: i64) -> Self {
        ReplayGuard {
            window_ms,
            seen: HashMap::new(),
        }
    }

    /// Returns `Ok(())` on first sight of a fresh nonce, recording it. Returns
    /// `Err(Stale)` if `ts` is outside the window, `Err(Replay)` if the nonce was
    /// already recorded.
    pub fn check(&mut self, nonce: &str, ts: i64, now_ms: i64) -> Result<(), RejectReason> {
        if (now_ms - ts).abs() > self.window_ms {
            return Err(RejectReason::Stale);
        }
        self.prune(now_ms);
        if self.seen.contains_key(nonce) {
            return Err(RejectReason::Replay);
        }
        self.seen.insert(nonce.to_string(), ts);
        Ok(())
    }

    fn prune(&mut self, now_ms: i64) {
        let window = self.window_ms;
        self.seen.retain(|_, &mut t| (now_ms - t).abs() <= window);
    }
}

/// Verifies a [`ControlMessage::Signed`] envelope against `secret` and the
/// replay guard, returning the decoded inner control message on success.
/// Signature is checked first so forged messages never touch the replay guard.
pub fn verify_signed_control(
    secret: &str,
    envelope: &ControlMessage,
    guard: &mut ReplayGuard,
    now_ms: i64,
) -> Result<ControlMessage, RejectReason> {
    let ControlMessage::Signed {
        payload,
        nonce,
        ts,
        sig,
    } = envelope
    else {
        return Err(RejectReason::NotSigned);
    };
    if !verify_hmac(secret, &signing_input(payload, nonce, *ts), sig) {
        return Err(RejectReason::BadSignature);
    }
    guard.check(nonce, *ts, now_ms)?;
    serde_json::from_str::<ControlMessage>(payload).map_err(|_| RejectReason::BadPayload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ping() -> ControlMessage {
        ControlMessage::Ping
    }

    #[test]
    fn round_trips_a_valid_signed_control() {
        let mut guard = ReplayGuard::new(DEFAULT_FRESHNESS_WINDOW_MS);
        let env = sign_control("sekret", &ping(), "nonce-1", 1_000);
        let inner = verify_signed_control("sekret", &env, &mut guard, 1_000).unwrap();
        assert_eq!(inner, ControlMessage::Ping);
    }

    #[test]
    fn rejects_a_forged_signature() {
        let mut guard = ReplayGuard::new(DEFAULT_FRESHNESS_WINDOW_MS);
        let env = sign_control("sekret", &ping(), "nonce-1", 1_000);
        assert_eq!(
            verify_signed_control("wrong-secret", &env, &mut guard, 1_000),
            Err(RejectReason::BadSignature)
        );
    }

    #[test]
    fn rejects_a_stale_timestamp() {
        let mut guard = ReplayGuard::new(30_000);
        let env = sign_control("sekret", &ping(), "nonce-1", 1_000);
        assert_eq!(
            verify_signed_control("sekret", &env, &mut guard, 1_000 + 30_001),
            Err(RejectReason::Stale)
        );
    }

    #[test]
    fn rejects_a_replayed_nonce() {
        let mut guard = ReplayGuard::new(30_000);
        let env = sign_control("sekret", &ping(), "nonce-1", 1_000);
        assert!(verify_signed_control("sekret", &env, &mut guard, 1_000).is_ok());
        assert_eq!(
            verify_signed_control("sekret", &env, &mut guard, 1_001),
            Err(RejectReason::Replay)
        );
    }

    #[test]
    fn rejects_a_non_signed_envelope() {
        let mut guard = ReplayGuard::new(30_000);
        assert_eq!(
            verify_signed_control("sekret", &ping(), &mut guard, 0),
            Err(RejectReason::NotSigned)
        );
    }

    #[test]
    fn new_nonce_is_32_hex_chars_and_unique() {
        let a = new_nonce();
        let b = new_nonce();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn prune_evicts_future_dated_nonces_symmetrically() {
        // A nonce recorded with a far-future timestamp (sender clock fast).
        // The old `now - t <= window` test was always true for future `t`,
        // retaining it indefinitely (~2x effective window). The symmetric
        // `(now - t).abs() <= window` evicts it once it is out of window.
        let mut guard = ReplayGuard::new(30_000);
        guard.seen.insert("future".to_string(), 100_000);
        guard.prune(1_000);
        assert!(!guard.seen.contains_key("future"));
    }

    #[test]
    fn signature_matches_pinned_cross_impl_vector() {
        // Must equal the Bun-computed value in tests/spawn-auth.test.ts.
        let env = sign_control("sekret", &ControlMessage::Ping, "nonce-1", 1_000);
        let ControlMessage::Signed { payload, sig, .. } = env else {
            panic!("expected signed envelope");
        };
        assert_eq!(payload, "{\"kind\":\"ping\"}");
        assert_eq!(
            sig,
            "cf7054af7f0345dcb46571ec4cce6174c1411a68261e8d523ff2bac185f37aa7"
        );
    }
}
