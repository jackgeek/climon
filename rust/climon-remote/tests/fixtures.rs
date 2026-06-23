//! Cross-language golden fixtures: the Rust mux encoder MUST produce byte-exact
//! frames matching the Bun encoder (`fixtures/remote/mux-frames.json`, generated
//! by `scripts/gen-remote-fixtures.ts`). This is the real interop guarantee that
//! a Rust uplink can talk to a Bun ingest and vice-versa.

use std::collections::HashMap;
use std::path::PathBuf;

use climon_proto::meta::SessionMeta;
use climon_remote::mux::{encode_control, encode_data, ControlMessage, MuxDecoder, MuxMessage};
use serde_json::json;

fn load_fixtures() -> HashMap<String, String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/remote/mux-frames.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// The canonical SessionMeta used by the fixture generator. Field order matches
// the Rust struct so serde_json output equals the Bun JSON.stringify output.
fn canonical_meta() -> SessionMeta {
    serde_json::from_value(json!({
        "id": "s1",
        "command": ["bash", "-lc", "echo hi"],
        "displayCommand": "bash -lc echo hi",
        "cwd": "/home/dev",
        "status": "running",
        "priorityReason": "running",
        "cols": 80,
        "rows": 24,
        "socketPath": "tcp://127.0.0.1:9000",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "lastActivityAt": "2026-01-01T00:00:00.000Z"
    }))
    .unwrap()
}

fn canonical_controls() -> Vec<(&'static str, ControlMessage)> {
    vec![
        (
            "control:hello",
            ControlMessage::Hello {
                client_id: "devbox-abc".into(),
                peer: false,
            },
        ),
        (
            "control:session-added",
            ControlMessage::SessionAdded {
                meta: Box::new(canonical_meta()),
            },
        ),
        (
            "control:session-updated",
            ControlMessage::SessionUpdated {
                id: "s1".into(),
                patch: Box::new(
                    serde_json::from_value(
                        json!({"status":"completed","priorityReason":"completed"}),
                    )
                    .unwrap(),
                ),
            },
        ),
        (
            "control:session-removed",
            ControlMessage::SessionRemoved { id: "a".into() },
        ),
        ("control:attach", ControlMessage::Attach { id: "s1".into() }),
        ("control:detach", ControlMessage::Detach { id: "s1".into() }),
        ("control:ping", ControlMessage::Ping),
        ("control:pong", ControlMessage::Pong),
    ]
}

#[test]
fn rust_encoder_matches_bun_fixtures() {
    let fixtures = load_fixtures();
    for (name, message) in canonical_controls() {
        let expected = fixtures
            .get(name)
            .unwrap_or_else(|| panic!("missing fixture {name}"));
        assert_eq!(hex(&encode_control(&message)), *expected, "frame {name}");
    }
    assert_eq!(
        hex(&encode_data("sess-1", &[1, 2, 3, 4]).unwrap()),
        fixtures["data:sess-1"],
        "data:sess-1"
    );
    assert_eq!(
        hex(&encode_data("x", &[]).unwrap()),
        fixtures["data:empty"],
        "data:empty"
    );
}

#[test]
fn rust_decoder_round_trips_bun_encoded_frames() {
    let fixtures = load_fixtures();
    // Decode the Bun-encoded session-added frame.
    let bytes = unhex(&fixtures["control:session-added"]);
    let mut decoder = MuxDecoder::new();
    let out = decoder.push(&bytes).unwrap();
    assert_eq!(
        out,
        vec![MuxMessage::Control(ControlMessage::SessionAdded {
            meta: Box::new(canonical_meta())
        })]
    );

    // Decode the Bun-encoded data frame.
    let bytes = unhex(&fixtures["data:sess-1"]);
    let out = MuxDecoder::new().push(&bytes).unwrap();
    assert_eq!(
        out,
        vec![MuxMessage::Data {
            session_id: "sess-1".into(),
            data: vec![1, 2, 3, 4]
        }]
    );

    // Concatenate every Bun frame and decode them all in one push, asserting the
    // decoder consumes the whole buffer and yields one message per fixture frame.
    let mut all = Vec::new();
    for value in fixtures.values() {
        all.extend_from_slice(&unhex(value));
    }
    let out = MuxDecoder::new().push(&all).unwrap();
    assert_eq!(out.len(), fixtures.len());
}
