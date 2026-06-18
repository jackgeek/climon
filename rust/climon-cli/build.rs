//! Build script: extracts the `version` from the repo-root `package.json` and
//! exposes it as `CLIMON_VERSION` so the compiled `climon` binary reports the
//! exact same version string as the TypeScript client (whose `VERSION` is also
//! sourced from `package.json`). This keeps `climon --version` and the help text
//! byte-identical across the two implementations.

use std::path::Path;

fn main() {
    // package.json lives at the repository root, two levels above this crate
    // (rust/climon-cli/ -> rust/ -> repo root).
    let pkg_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());
    // Allow CI to pin the version explicitly. The release matrix builds the
    // client *before* the bump commit lands, so it sets CLIMON_VERSION to the
    // bumped release version; locally/unset we fall back to package.json.
    println!("cargo:rerun-if-env-changed=CLIMON_VERSION");

    if let Ok(version) = std::env::var("CLIMON_VERSION") {
        let version = version.trim();
        if !version.is_empty() {
            println!("cargo:rustc-env=CLIMON_VERSION={version}");
            return;
        }
    }

    let contents = std::fs::read_to_string(&pkg_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", pkg_path.display()));
    let version = extract_version(&contents)
        .unwrap_or_else(|| panic!("no \"version\" field found in {}", pkg_path.display()));
    println!("cargo:rustc-env=CLIMON_VERSION={version}");
}

/// Extracts the first top-level `"version": "..."` string from package.json JSON
/// text without pulling in a JSON parser at build time.
fn extract_version(json: &str) -> Option<String> {
    let key = "\"version\"";
    let key_idx = json.find(key)?;
    let after = &json[key_idx + key.len()..];
    let colon = after.find(':')?;
    let rest = &after[colon + 1..];
    let open = rest.find('"')?;
    let value_start = open + 1;
    let close = rest[value_start..].find('"')? + value_start;
    Some(rest[value_start..close].to_string())
}
