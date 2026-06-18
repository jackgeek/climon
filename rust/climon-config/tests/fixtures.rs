//! Cross-language golden fixtures shared with the Bun suite
//! (`tests/config-fixtures.test.ts`). The corpus under `fixtures/config/` is the
//! single source of truth for Rust<->Bun config parity.

use std::path::PathBuf;

use climon_config::config_settings::{
    build_default_config_from_settings, render_config_settings_help, render_config_settings_table,
};
use climon_config::docs::render_config_docs_section;
use climon_config::jsonc::{parse_jsonc_config, render_jsonc_config};
use serde_json::Value;

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/rust/climon-config
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn fixture(name: &str) -> PathBuf {
    repo_root().join("fixtures/config").join(name)
}

fn read(name: &str) -> String {
    std::fs::read_to_string(fixture(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

fn read_json(name: &str) -> Value {
    serde_json::from_str(&read(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

#[test]
fn parse_cases_match_the_bun_corpus() {
    let cases = read_json("parse-cases.json");
    let arr = cases.as_array().unwrap();
    assert!(!arr.is_empty());
    for case in arr {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let expected = &case["expected"];
        let parsed =
            parse_jsonc_config(input, &format!("/fixtures/{name}.jsonc")).unwrap_or_else(|e| {
                panic!("parse case `{name}` failed: {e}");
            });
        assert_eq!(&parsed, expected, "parse case `{name}` mismatch");
    }
}

#[test]
fn parse_error_cases_reproduce_the_bun_messages() {
    let cases = read_json("parse-error-cases.json");
    let arr = cases.as_array().unwrap();
    assert!(!arr.is_empty());
    for case in arr {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let needle = case["errorContains"].as_str().unwrap();
        let err = parse_jsonc_config(input, &format!("/fixtures/{name}.jsonc"))
            .expect_err(&format!("parse case `{name}` should fail"));
        assert!(
            err.contains(needle),
            "parse case `{name}`: error `{err}` missing `{needle}`"
        );
    }
}

#[test]
fn render_cases_match_the_bun_corpus_byte_for_byte() {
    let cases = read_json("render-cases.json");
    let arr = cases.as_array().unwrap();
    assert!(!arr.is_empty());
    for case in arr {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let expected = case["expected"].as_str().unwrap();
        let rendered = render_jsonc_config(input);
        assert_eq!(rendered, expected, "render case `{name}` mismatch");
    }
}

#[test]
fn default_config_and_render_match_the_fixtures() {
    assert_eq!(
        build_default_config_from_settings(),
        read_json("default-config.json")
    );
    assert_eq!(
        render_jsonc_config(&build_default_config_from_settings()),
        read("default-rendered.jsonc")
    );
}

#[test]
fn settings_table_help_and_docs_section_match_the_fixtures() {
    assert_eq!(render_config_settings_table(), read("settings-table.md"));
    assert_eq!(render_config_settings_help(), read("settings-help.txt"));
    assert_eq!(render_config_docs_section(), read("docs-section.md"));
}
