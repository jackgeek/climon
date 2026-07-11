//! Blocking handshake drivers over a `SessionStream`.
//!
//! Wire steps (spec 290-389):
//!   daemon → client: AuthChallenge{version, purpose, challenge_nonce}
//!   client → daemon: AuthResponse{response_nonce, client_proof}
//!   daemon → client: AuthOk{daemon_proof}  (session)
//!                 or AuthProbeOk{daemon_proof} (probe)
//!                 or AuthError{code}

use std::io;
use std::time::Duration;

use climon_proto::auth::{
    self, AuthErrorCode, Purpose, IPC_PROTOCOL_VERSION, NONCE_LEN, PRE_AUTH_MAX_PAYLOAD, PROOF_LEN,
};
use climon_proto::frame::{encode_frame, FrameType};

use crate::socket::SessionStream;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// A handshake failure. Never carries the credential or nonces.
#[derive(Debug)]
pub enum HandshakeError {
    Io(io::Error),
    /// Peer sent AuthError with this code.
    Rejected(AuthErrorCode),
    /// Protocol violation (wrong frame, oversize, bad proof, version mismatch).
    Protocol(String),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Io(e) => write!(f, "handshake io error: {e}"),
            HandshakeError::Rejected(c) => write!(f, "handshake rejected: {c:?}"),
            HandshakeError::Protocol(m) => write!(f, "handshake protocol error: {m}"),
        }
    }
}

impl std::error::Error for HandshakeError {}

impl From<io::Error> for HandshakeError {
    fn from(e: io::Error) -> Self {
        HandshakeError::Io(e)
    }
}

type Result<T> = std::result::Result<T, HandshakeError>;

/// Reads exactly one frame with a payload cap. Returns (frame_type, payload).
fn read_one_frame(stream: &mut dyn SessionStream, max_payload: usize) -> Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    stream.read_exact(&mut header)?;
    let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if len > max_payload {
        return Err(HandshakeError::Protocol(format!(
            "frame payload {len} exceeds pre-auth cap {max_payload}"
        )));
    }
    let type_byte = header[4];
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;
    Ok((type_byte, payload))
}

/// Daemon side: authenticate the peer and return its intended purpose.
pub fn daemon_handshake(stream: &mut dyn SessionStream, credential: &[u8]) -> Result<Purpose> {
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;

    // 1. Send AuthChallenge. Purpose byte here is informational; the client
    //    echoes its real purpose implicitly by which proof it can produce, but
    //    the daemon must learn the purpose to branch AuthOk vs AuthProbeOk. We
    //    carry the purpose the client declares in AuthResponse's first byte.
    let challenge_nonce = auth::random_nonce();
    let mut challenge = Vec::with_capacity(2 + NONCE_LEN);
    challenge.push(IPC_PROTOCOL_VERSION);
    challenge.push(0); // reserved; purpose is declared by the client
    challenge.extend_from_slice(&challenge_nonce);
    stream.write_all(&encode_frame(FrameType::AuthChallenge, &challenge))?;

    // 2. Read AuthResponse: purpose(1) || response_nonce(32) || client_proof(32).
    let (type_byte, payload) = read_one_frame(stream, PRE_AUTH_MAX_PAYLOAD)?;
    if FrameType::from_u8(type_byte) != Some(FrameType::AuthResponse) {
        send_error(stream, AuthErrorCode::Malformed);
        return Err(HandshakeError::Protocol("expected AuthResponse".into()));
    }
    if payload.len() != 1 + NONCE_LEN + PROOF_LEN {
        send_error(stream, AuthErrorCode::Malformed);
        return Err(HandshakeError::Protocol("bad AuthResponse length".into()));
    }
    let purpose = match Purpose::from_u8(payload[0]) {
        Some(p) => p,
        None => {
            send_error(stream, AuthErrorCode::Malformed);
            return Err(HandshakeError::Protocol("unknown purpose".into()));
        }
    };
    let response_nonce = &payload[1..1 + NONCE_LEN];
    let client_proof = &payload[1 + NONCE_LEN..];

    // 3. Verify the client proof (constant-time).
    if !auth::verify_client_proof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        &challenge_nonce,
        response_nonce,
        client_proof,
    ) {
        send_error(stream, AuthErrorCode::BadProof);
        return Err(HandshakeError::Protocol("bad client proof".into()));
    }

    // 4. Send our proof under the matching tag.
    let dproof = auth::daemon_proof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        &challenge_nonce,
        response_nonce,
        client_proof,
    );
    let ok_tag = match purpose {
        Purpose::Session => FrameType::AuthOk,
        Purpose::Probe => FrameType::AuthProbeOk,
    };
    stream.write_all(&encode_frame(ok_tag, &dproof))?;
    Ok(purpose)
}

fn send_error(stream: &mut dyn SessionStream, code: AuthErrorCode) {
    let _ = stream.write_all(&encode_frame(FrameType::AuthError, &[code.as_u8()]));
}

/// Client side: prove possession of `credential` and verify the daemon's proof.
pub fn client_handshake(
    stream: &mut dyn SessionStream,
    credential: &[u8],
    purpose: Purpose,
) -> Result<()> {
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;

    // 1. Read AuthChallenge.
    let (type_byte, payload) = read_one_frame(stream, PRE_AUTH_MAX_PAYLOAD)?;
    if FrameType::from_u8(type_byte) != Some(FrameType::AuthChallenge) {
        return Err(HandshakeError::Protocol("expected AuthChallenge".into()));
    }
    if payload.len() != 2 + NONCE_LEN {
        return Err(HandshakeError::Protocol("bad AuthChallenge length".into()));
    }
    let version = payload[0];
    if version != IPC_PROTOCOL_VERSION {
        return Err(HandshakeError::Rejected(AuthErrorCode::UnsupportedVersion));
    }
    let challenge_nonce = payload[2..2 + NONCE_LEN].to_vec();

    // 2. Send AuthResponse.
    let response_nonce = auth::random_nonce();
    let cproof = auth::client_proof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        &challenge_nonce,
        &response_nonce,
    );
    let mut resp = Vec::with_capacity(1 + NONCE_LEN + PROOF_LEN);
    resp.push(purpose.as_u8());
    resp.extend_from_slice(&response_nonce);
    resp.extend_from_slice(&cproof);
    stream.write_all(&encode_frame(FrameType::AuthResponse, &resp))?;

    // 3. Read AuthOk / AuthProbeOk / AuthError.
    let (ok_type, ok_payload) = read_one_frame(stream, PRE_AUTH_MAX_PAYLOAD)?;
    match FrameType::from_u8(ok_type) {
        Some(FrameType::AuthOk) | Some(FrameType::AuthProbeOk) => {}
        Some(FrameType::AuthError) => {
            let code = ok_payload
                .first()
                .and_then(|b| AuthErrorCode::from_u8(*b))
                .unwrap_or(AuthErrorCode::Malformed);
            return Err(HandshakeError::Rejected(code));
        }
        _ => return Err(HandshakeError::Protocol("expected AuthOk".into())),
    }
    if ok_payload.len() != PROOF_LEN {
        return Err(HandshakeError::Protocol("bad AuthOk length".into()));
    }

    // 4. Verify the daemon proof.
    if !auth::verify_daemon_proof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        &challenge_nonce,
        &response_nonce,
        &cproof,
        &ok_payload,
    ) {
        return Err(HandshakeError::Protocol("bad daemon proof".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socket::{connect_session_socket, listen_on_session_socket};

    #[test]
    fn session_handshake_round_trips_over_tcp() {
        let cred = [9u8; 32];
        let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        let daemon_cred = cred;
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            daemon_handshake(&mut *stream, &daemon_cred).unwrap()
        });
        let mut client = connect_session_socket(&resolved).unwrap();
        client_handshake(&mut *client, &cred, Purpose::Session).unwrap();
        let purpose = server.join().unwrap();
        assert_eq!(purpose, Purpose::Session);
    }

    #[test]
    fn wrong_credential_is_rejected() {
        let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let _ = daemon_handshake(&mut *stream, &[1u8; 32]);
        });
        let mut client = connect_session_socket(&resolved).unwrap();
        let err = client_handshake(&mut *client, &[2u8; 32], Purpose::Session).unwrap_err();
        assert!(matches!(
            err,
            HandshakeError::Rejected(AuthErrorCode::BadProof)
        ));
        let _ = server.join();
    }

    #[test]
    fn probe_purpose_yields_probe_ok() {
        let cred = [3u8; 32];
        let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
        let dc = cred;
        let server = std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            daemon_handshake(&mut *stream, &dc).unwrap()
        });
        let mut client = connect_session_socket(&resolved).unwrap();
        client_handshake(&mut *client, &cred, Purpose::Probe).unwrap();
        assert_eq!(server.join().unwrap(), Purpose::Probe);
    }
}
