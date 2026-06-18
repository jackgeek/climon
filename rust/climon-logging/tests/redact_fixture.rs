//! Cross-language redaction golden-fixture assertion.
//!
//! Reads `fixtures/logging/redact.json` (shared with the Bun suite,
//! `tests/logging-redact-fixture.test.ts`) and asserts `redact(input)` equals
//! `expected` for every case. The shared corpus is what actually guarantees the
//! Rust redaction matches pino's behaviour for the climon secret paths.

use std::path::PathBuf;

use climon_logging::redact::redact;
use serde_json::Value;

fn load_fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/logging/redact.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("valid fixture JSON")
}

#[test]
fn redact_matches_golden_corpus() {
    let fixture = load_fixture();
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "corpus must not be empty");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let mut input = case["input"].clone();
        let expected = &case["expected"];
        redact(&mut input);
        assert_eq!(&input, expected, "case: {name}");
    }
}
