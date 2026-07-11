//! Session-IPC authentication primitives (wire constants + proof math).
//!
//! The exact byte layout here is mirrored in `src/ipc/auth.ts`; keep both in sync.

use hmac::digest::KeyInit;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Current session-IPC protocol version. Bump only for breaking handshake changes.
pub const IPC_PROTOCOL_VERSION: u8 = 1;

/// Domain-separation label for the client's proof.
pub const CLIENT_PROOF_LABEL: &[u8] = b"climon-session-ipc-v1/client-proof\0";
/// Domain-separation label for the daemon's proof.
pub const DAEMON_PROOF_LABEL: &[u8] = b"climon-session-ipc-v1/daemon-proof\0";

/// Length in bytes of nonces, credential, and proofs.
pub const NONCE_LEN: usize = 32;
pub const CREDENTIAL_LEN: usize = 32;
pub const PROOF_LEN: usize = 32;

/// Maximum frame payload accepted before the session is authenticated.
pub const PRE_AUTH_MAX_PAYLOAD: usize = 4 * 1024;
/// Maximum frame payload accepted after AuthOk.
pub const POST_AUTH_MAX_PAYLOAD: usize = 8 * 1024 * 1024;
/// Maximum simultaneous un-authenticated connections a daemon will hold.
pub const MAX_PENDING_HANDSHAKES: usize = 32;

/// What a connecting peer intends to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Full interactive session (enters the client map).
    Session,
    /// Liveness/readiness probe (never enters the client map).
    Probe,
}

impl Purpose {
    pub fn as_u8(self) -> u8 {
        match self {
            Purpose::Session => 0x01,
            Purpose::Probe => 0x02,
        }
    }

    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0x01 => Some(Purpose::Session),
            0x02 => Some(Purpose::Probe),
            _ => None,
        }
    }
}

/// Reason a handshake was rejected. Sent as a single byte; never leaks secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorCode {
    UnsupportedVersion = 1,
    BadProof = 2,
    Malformed = 3,
    TooManyPending = 4,
}

impl AuthErrorCode {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(AuthErrorCode::UnsupportedVersion),
            2 => Some(AuthErrorCode::BadProof),
            3 => Some(AuthErrorCode::Malformed),
            4 => Some(AuthErrorCode::TooManyPending),
            _ => None,
        }
    }
}

fn mac(credential: &[u8]) -> HmacSha256 {
    HmacSha256::new_from_slice(credential).expect("HMAC accepts any key length")
}

/// Compute the client's proof of credential possession.
pub fn client_proof(
    credential: &[u8],
    version: u8,
    purpose: Purpose,
    challenge_nonce: &[u8],
    response_nonce: &[u8],
) -> [u8; PROOF_LEN] {
    let mut m = mac(credential);
    m.update(CLIENT_PROOF_LABEL);
    m.update(&[version, purpose.as_u8()]);
    m.update(challenge_nonce);
    m.update(response_nonce);
    let out = m.finalize().into_bytes();
    let mut proof = [0u8; PROOF_LEN];
    proof.copy_from_slice(&out);
    proof
}

/// Compute the daemon's proof (binds the client's proof to prevent reflection).
pub fn daemon_proof(
    credential: &[u8],
    version: u8,
    purpose: Purpose,
    challenge_nonce: &[u8],
    response_nonce: &[u8],
    client_proof: &[u8],
) -> [u8; PROOF_LEN] {
    let mut m = mac(credential);
    m.update(DAEMON_PROOF_LABEL);
    m.update(&[version, purpose.as_u8()]);
    m.update(challenge_nonce);
    m.update(response_nonce);
    m.update(client_proof);
    let out = m.finalize().into_bytes();
    let mut proof = [0u8; PROOF_LEN];
    proof.copy_from_slice(&out);
    proof
}

/// Constant-time verification of a client proof.
pub fn verify_client_proof(
    credential: &[u8],
    version: u8,
    purpose: Purpose,
    challenge_nonce: &[u8],
    response_nonce: &[u8],
    candidate: &[u8],
) -> bool {
    let mut m = mac(credential);
    m.update(CLIENT_PROOF_LABEL);
    m.update(&[version, purpose.as_u8()]);
    m.update(challenge_nonce);
    m.update(response_nonce);
    m.verify_slice(candidate).is_ok()
}

/// Constant-time verification of a daemon proof.
pub fn verify_daemon_proof(
    credential: &[u8],
    version: u8,
    purpose: Purpose,
    challenge_nonce: &[u8],
    response_nonce: &[u8],
    client_proof: &[u8],
    candidate: &[u8],
) -> bool {
    let mut m = mac(credential);
    m.update(DAEMON_PROOF_LABEL);
    m.update(&[version, purpose.as_u8()]);
    m.update(challenge_nonce);
    m.update(response_nonce);
    m.update(client_proof);
    m.verify_slice(candidate).is_ok()
}

/// Generate `NONCE_LEN` cryptographically-random bytes.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut buf = [0u8; NONCE_LEN];
    getrandom::fill(&mut buf).expect("getrandom");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed vector so the Rust and TS sides can be cross-checked.
    const CRED: [u8; 32] = [7u8; 32];
    const CHALLENGE: [u8; 32] = [1u8; 32];
    const RESPONSE: [u8; 32] = [2u8; 32];

    #[test]
    fn client_and_daemon_proofs_are_stable() {
        let cp = client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
        );
        let dp = daemon_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
            &cp,
        );
        // Recomputing yields identical output (deterministic).
        assert_eq!(
            cp,
            client_proof(
                &CRED,
                IPC_PROTOCOL_VERSION,
                Purpose::Session,
                &CHALLENGE,
                &RESPONSE
            )
        );
        assert_eq!(
            dp,
            daemon_proof(
                &CRED,
                IPC_PROTOCOL_VERSION,
                Purpose::Session,
                &CHALLENGE,
                &RESPONSE,
                &cp
            )
        );
        // Domain separation: client != daemon proof.
        assert_ne!(cp, dp);
    }

    #[test]
    fn purpose_changes_the_proof() {
        let session = client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
        );
        let probe = client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Probe,
            &CHALLENGE,
            &RESPONSE,
        );
        assert_ne!(session, probe);
    }

    #[test]
    fn verify_accepts_matching_and_rejects_tampered() {
        let cp = client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
        );
        assert!(verify_client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
            &cp
        ));
        let mut bad = cp;
        bad[0] ^= 0xff;
        assert!(!verify_client_proof(
            &CRED,
            IPC_PROTOCOL_VERSION,
            Purpose::Session,
            &CHALLENGE,
            &RESPONSE,
            &bad
        ));
    }

    #[test]
    fn purpose_roundtrips_through_u8() {
        assert_eq!(Purpose::from_u8(0x01), Some(Purpose::Session));
        assert_eq!(Purpose::from_u8(0x02), Some(Purpose::Probe));
        assert_eq!(Purpose::from_u8(0x00), None);
        assert_eq!(Purpose::Session.as_u8(), 0x01);
        assert_eq!(Purpose::Probe.as_u8(), 0x02);
    }
}
