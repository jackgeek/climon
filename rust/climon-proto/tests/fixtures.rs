//! Cross-language golden fixtures shared with the Bun suite
//! (`tests/proto-fixtures.test.ts`). Frames are byte-exact; metadata is verified
//! by semantic round-trip + the color three-state.

use std::path::PathBuf;

use climon_proto::frame::{encode_frame, FrameType};
use climon_proto::meta::{AnsiColor, SessionMeta, SessionStatus};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/rust/climon-proto
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn frame_type(tag: u8) -> FrameType {
    FrameType::from_u8(tag).expect("known frame type in fixture")
}

#[test]
fn frame_encodings_match_the_bun_golden_corpus() {
    let path = repo_root().join("fixtures/proto/frames.json");
    let raw = std::fs::read_to_string(&path).expect("frames fixture exists");
    let entries: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for entry in entries.as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let tag = entry["type"].as_u64().unwrap() as u8;
        let payload_json = entry["payloadJson"].as_str().unwrap();
        let expected_hex = entry["hex"].as_str().unwrap();

        // Encode the canonical payload *string* via the codec, exactly as the Bun
        // side does (`encodeFrame(type, payloadJson)`). This asserts framing/codec
        // parity across languages without re-serializing through serde_json::Value
        // (whose Object is a BTreeMap and would reorder keys). Typed-struct
        // serialization byte-exactness is covered by the frame.rs unit tests.
        let frame = encode_frame(frame_type(tag), payload_json.as_bytes());
        let got_hex = frame.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(got_hex, expected_hex, "frame `{name}` hex mismatch");
    }
}

#[test]
fn metadata_fixtures_round_trip() {
    let dir = repo_root().join("fixtures/proto/session-meta");

    let minimal: SessionMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("minimal.json")).unwrap()).unwrap();
    assert_eq!(minimal.status, SessionStatus::Running);
    assert_eq!(minimal.color, None);
    assert!(!serde_json::to_string(&minimal).unwrap().contains("color"));

    let full: SessionMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("full.json")).unwrap()).unwrap();
    assert_eq!(full.status, SessionStatus::NeedsAttention);
    assert_eq!(full.color, Some(Some(AnsiColor::Cyan)));
    assert_eq!(full.priority, Some(250));
    assert_eq!(full.daemon_pid, Some(4242));

    let null_color: SessionMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("color-null.json")).unwrap())
            .unwrap();
    assert_eq!(null_color.color, Some(None));
    assert!(serde_json::to_string(&null_color)
        .unwrap()
        .contains("\"color\":null"));

    // Round-trip stability: deserialize(serialize(x)) == x for each fixture.
    for meta in [minimal, full, null_color] {
        let serialized = serde_json::to_string(&meta).unwrap();
        let reparsed: SessionMeta = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed, meta);
    }
}
