//! Cross-language golden fixtures: the same JSON corpus under `fixtures/store/`
//! is asserted here and by `tests/store-fixtures.test.ts` so the Rust port and
//! the Bun server agree on metadata merge and server-state parsing.

use std::path::PathBuf;

use climon_proto::meta::{AnsiColor, PriorityReason, SessionMeta, SessionMetaPatch, SessionStatus};
use climon_store::meta::merge_patch;
use climon_store::server_state::parse_server_state;

fn fixture(rel: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
        .join("store")
        .join(rel);
    std::fs::read_to_string(&root).unwrap_or_else(|e| panic!("read {}: {e}", root.display()))
}

#[test]
fn merge_fixture_matches_expected() {
    let base: SessionMeta = serde_json::from_str(&fixture("merge/base.json")).unwrap();
    let patch: SessionMetaPatch = serde_json::from_str(&fixture("merge/patch.json")).unwrap();
    let expected: SessionMeta = serde_json::from_str(&fixture("merge/expected.json")).unwrap();

    let merged = merge_patch(&base, &patch);
    assert_eq!(merged, expected);

    // Spot-check the interesting transitions the fixture exercises.
    assert_eq!(merged.status, SessionStatus::Completed);
    assert_eq!(merged.priority_reason, PriorityReason::Completed);
    assert_eq!(merged.exit_code, Some(0));
    // Explicit null color overrides the base `cyan` (three-state).
    assert_eq!(merged.color, Some(None));
    // Untouched base fields survive.
    assert_eq!(merged.name.as_deref(), Some("build"));
    assert_eq!(merged.priority, Some(250));

    // Base used cyan; sanity that the type imported is exercised.
    let base_color = base.color.flatten();
    assert_eq!(base_color, Some(AnsiColor::Cyan));
}

#[test]
fn server_state_fixtures_parse() {
    let minimal = parse_server_state(&fixture("server-state/minimal.json")).unwrap();
    assert_eq!(minimal.pid, 1234);
    assert_eq!(minimal.port, 7421);
    assert_eq!(minimal.ingest, None);
    assert_eq!(minimal.started_at, None);

    let full = parse_server_state(&fixture("server-state/full.json")).unwrap();
    assert_eq!(full.pid, 9);
    assert_eq!(full.ingest, Some(7500));
    assert_eq!(full.started_at, Some(1_700_000_000_000));
}
