//! Injects CLIMON_VERSION (same source of truth as climon-cli's build.rs) and,
//! for Windows targets, stages the embedded stub binaries into OUT_DIR so
//! `src/main.rs` can `include_bytes!` them. The stub paths are provided by the
//! build orchestrator (scripts/compile.ts / CI) via CLIMON_CLIENT_STUB and
//! CLIMON_SERVER_STUB env vars. When unset (host dev builds), zero-byte
//! placeholders are staged so the crate still compiles.

use std::path::{Path, PathBuf};

fn main() {
    // package.json lives at the repository root, two levels above this crate
    // (rust/climon-cli/ -> rust/ -> repo root).
    let pkg_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());
    // Allow CI to pin the version explicitly. The release matrix builds the
    // client *before* the bump commit lands, so it sets CLIMON_VERSION to the
    // bumped release version; locally/unset we fall back to package.json.
    println!("cargo:rerun-if-env-changed=CLIMON_VERSION");

    let version = if let Ok(version) = std::env::var("CLIMON_VERSION") {
        let version = version.trim();
        if !version.is_empty() {
            version.to_string()
        } else {
            package_version(&pkg_path)
        }
    } else {
        package_version(&pkg_path)
    };
    println!("cargo:rustc-env=CLIMON_VERSION={version}");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    stage_stub(
        "CLIMON_CLIENT_STUB",
        out_dir.join("client_stub.bin"),
        &target_os,
    );
    stage_stub(
        "CLIMON_SERVER_STUB",
        out_dir.join("server_stub.bin"),
        &target_os,
    );
    println!("cargo:rerun-if-env-changed=CLIMON_CLIENT_STUB");
    println!("cargo:rerun-if-env-changed=CLIMON_SERVER_STUB");
}

fn package_version(pkg_path: &Path) -> String {
    let contents = std::fs::read_to_string(pkg_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", pkg_path.display()));
    extract_version(&contents)
        .unwrap_or_else(|| panic!("no \"version\" field found in {}", pkg_path.display()))
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

/// Copies the file named by `env_var` into `dest`, or writes an empty file when
/// the env var is unset (host dev builds that never place stubs).
fn stage_stub(env_var: &str, dest: PathBuf, target_os: &str) {
    match std::env::var(env_var) {
        Ok(src) if !src.is_empty() => {
            std::fs::copy(&src, &dest)
                .unwrap_or_else(|e| panic!("copy {src} -> {}: {e}", dest.display()));
        }
        _ if target_os == "windows" => {
            panic!("{env_var} must point at a built stub when building the Windows installer")
        }
        _ => {
            std::fs::write(&dest, b"").expect("write empty stub placeholder");
        }
    }
}
