//! Cross-language golden-fixture integration tests: the compiled `climon`
//! binary must emit `--help` and `--version` bytes identical to the shared
//! `fixtures/cli/*` corpus that the Bun client is pinned against.

use std::path::PathBuf;
use std::process::Command;

/// Resolves the repository root (two levels up from the crate manifest:
/// `rust/climon-cli` → `rust` → repo root).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn fixture(name: &str) -> String {
    let path = repo_root().join("fixtures").join("cli").join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()))
}

fn run_climon(args: &[&str]) -> String {
    // Isolate config so the fixtures capture the default, no-features output.
    // `--help` advertises experimental commands (e.g. `climon remotes`) only
    // when their backing feature flag is on; a developer's global
    // `~/.climon/config.jsonc` or a local `.climon` up the cwd tree could flip
    // those flags and change the output. Point CLIMON_HOME/HOME at a fresh temp
    // dir and run from it so neither source is visible.
    let temp = tempfile::tempdir().expect("temp dir");
    let bin = env!("CARGO_BIN_EXE_climon");
    let output = Command::new(bin)
        .args(args)
        .current_dir(temp.path())
        .env("CLIMON_HOME", temp.path())
        .env("HOME", temp.path())
        .env("USERPROFILE", temp.path())
        .output()
        .expect("run climon");
    assert!(output.status.success(), "climon {args:?} failed");
    String::from_utf8(output.stdout).expect("utf-8 stdout")
}

#[test]
fn help_output_matches_fixture() {
    assert_eq!(run_climon(&["--help"]), fixture("help.txt"));
}

#[test]
fn version_output_matches_fixture() {
    assert_eq!(run_climon(&["--version"]), fixture("version.txt"));
}
