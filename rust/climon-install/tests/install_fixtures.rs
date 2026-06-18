//! Cross-language install-manifest parity. The shared fixture in
//! `fixtures/install/manifest.json` pins the byte/shape of the install manifest
//! per platform. Both the Rust client (here) and the Bun client
//! (`tests/install-fixtures.test.ts`) assert their manifest equals this fixture,
//! guaranteeing the non-destructive updater swaps the same files regardless of
//! which installer produced the install.

use std::collections::HashMap;
use std::path::PathBuf;

use climon_install::manifest::{install_files_for_platform, InstallFile, Platform};

fn fixture() -> HashMap<String, Vec<InstallFile>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/install/manifest.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("parse install manifest fixture")
}

#[test]
fn manifest_matches_shared_fixture_for_each_platform() {
    let fixture = fixture();
    for platform in [Platform::Windows, Platform::Linux, Platform::Darwin] {
        let key = platform.as_node_platform();
        let expected = fixture
            .get(key)
            .unwrap_or_else(|| panic!("fixture missing platform {key}"));
        assert_eq!(
            &install_files_for_platform(platform),
            expected,
            "manifest mismatch for {key}"
        );
    }
}
