//! End-to-end: an unauthenticated peer gets no PTY frames; an authenticated
//! session peer does. Uses the public handshake drivers + socket helpers.

use climon_proto::auth::Purpose;
use climon_proto::frame::{encode_frame, FrameDecoder, FrameType};
use climon_session::auth::client_handshake;
use climon_session::socket::{connect_session_socket, listen_on_session_socket};
use std::io::{Read, Write};
use std::time::Duration;

#[test]
fn unauthenticated_peer_receives_no_frames() {
    let cred = [42u8; 32];
    let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
    let dc = cred;
    let server = std::thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        if climon_session::auth::daemon_handshake(&mut *stream, &dc).is_ok() {
            let _ = stream.write_all(&encode_frame(
                FrameType::PtySize,
                b"{\"cols\":80,\"rows\":24}",
            ));
        }
    });
    let mut client = connect_session_socket(&resolved).unwrap();
    let err = client_handshake(&mut *client, &[0u8; 32], Purpose::Session);
    assert!(err.is_err());
    let mut buf = [0u8; 64];
    client
        .set_write_timeout(Some(Duration::from_millis(200)))
        .ok();
    let n = client.read(&mut buf).unwrap_or(0);
    assert_eq!(n, 0, "no PTY bytes should reach an unauthenticated peer");
    let _ = server.join();
}

#[test]
fn authenticated_session_peer_receives_frames() {
    let cred = [7u8; 32];
    let (listener, resolved) = listen_on_session_socket("tcp://127.0.0.1:0").unwrap();
    let dc = cred;
    let server = std::thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        if climon_session::auth::daemon_handshake(&mut *stream, &dc).unwrap() == Purpose::Session {
            let _ = stream.write_all(&encode_frame(
                FrameType::PtySize,
                b"{\"cols\":80,\"rows\":24}",
            ));
        }
    });
    let mut client = connect_session_socket(&resolved).unwrap();
    client_handshake(&mut *client, &cred, Purpose::Session).unwrap();
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 256];
    let n = client.read(&mut buf).unwrap();
    let frames = decoder.push(&buf[..n]);
    assert_eq!(frames[0].frame_type, FrameType::PtySize);
    let _ = server.join();
}
