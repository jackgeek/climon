//! Cross-language golden fixtures shared with the Bun suite
//! (`tests/session-fixtures.test.ts`). The session host produces these exact
//! bytes for the browser, so they must stay byte-identical to the Bun encoder.

use std::collections::HashMap;
use std::path::PathBuf;

use climon_proto::frame::{encode_frame, FrameType};
use climon_session::replay::{build_mouse_private_mode_replay_suffix, TRACKED_MOUSE_PRIVATE_MODES};

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/rust/climon-session
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn session_frame_encodings_match_the_bun_golden_corpus() {
    let path = repo_root().join("fixtures/session/frames.json");
    let raw = std::fs::read_to_string(&path).expect("session frames fixture exists");
    let entries: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let entries = entries.as_array().unwrap();
    assert!(!entries.is_empty());
    for entry in entries {
        let name = entry["name"].as_str().unwrap();
        let tag = entry["type"].as_u64().unwrap() as u8;
        let frame_type = FrameType::from_u8(tag).expect("known frame type in fixture");
        let expected_hex = entry["hex"].as_str().unwrap();

        // Encode the canonical payload exactly as the Bun side does: the raw
        // payloadJson *string* bytes for JSON frames (no serde re-serialization,
        // which would reorder keys), or the decoded payloadHex for binary frames.
        let frame = if let Some(payload_json) = entry.get("payloadJson").and_then(|v| v.as_str()) {
            encode_frame(frame_type, payload_json.as_bytes())
        } else {
            let payload_hex = entry["payloadHex"].as_str().unwrap();
            encode_frame(frame_type, &from_hex(payload_hex))
        };
        assert_eq!(hex(&frame), expected_hex, "frame `{name}` hex mismatch");
    }
}

#[test]
fn mouse_mode_replay_suffixes_match_the_bun_golden_corpus() {
    let path = repo_root().join("fixtures/session/replay-suffix.json");
    let raw = std::fs::read_to_string(&path).expect("replay-suffix fixture exists");
    let entries: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let entries = entries.as_array().unwrap();
    assert!(!entries.is_empty());
    for entry in entries {
        let name = entry["name"].as_str().unwrap();
        let expected_hex = entry["suffixHex"].as_str().unwrap();
        let mut state: HashMap<String, bool> = HashMap::new();
        for mode in entry["enabledModes"].as_array().unwrap() {
            state.insert(mode.as_str().unwrap().to_string(), true);
        }
        let suffix = build_mouse_private_mode_replay_suffix(&state, TRACKED_MOUSE_PRIVATE_MODES);
        assert_eq!(hex(&suffix), expected_hex, "suffix `{name}` hex mismatch");
    }
}
