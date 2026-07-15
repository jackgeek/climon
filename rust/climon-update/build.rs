//! Build script: extracts `UPDATE_PUBLIC_KEY_B64` from the TypeScript source of
//! truth (`src/update/pubkey.ts`) and exposes it as the `CLIMON_UPDATE_PUBKEY_B64`
//! compile-time env so the Rust updater embeds the *exact same* base64 Ed25519
//! public key as the Bun client. Reading it at build time means the key can
//! never silently drift between the two implementations.

use std::path::Path;

fn main() {
    // pubkey.ts lives at the repository root, two levels above this crate
    // (rust/climon-update/ -> rust/ -> repo root).
    let pubkey_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/update/pubkey.ts");
    println!("cargo:rerun-if-changed={}", pubkey_path.display());

    // Dev/test override: the upgrade-test harness builds a scratch client that must
    // trust its throwaway signing key. When CLIMON_UPDATE_PUBKEY_B64 is set and
    // non-empty we embed it verbatim; otherwise we read the production key from
    // pubkey.ts exactly as before. Release CI never sets this var, so shipped
    // binaries always embed the real key. Mirrors the CLIMON_VERSION override in
    // climon-cli/build.rs.
    println!("cargo:rerun-if-env-changed=CLIMON_UPDATE_PUBKEY_B64");
    let key = match std::env::var("CLIMON_UPDATE_PUBKEY_B64") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            let contents = std::fs::read_to_string(&pubkey_path)
                .unwrap_or_else(|e| panic!("failed to read {}: {e}", pubkey_path.display()));
            extract_pubkey(&contents).unwrap_or_else(|| {
                panic!(
                    "no UPDATE_PUBLIC_KEY_B64 string literal found in {}",
                    pubkey_path.display()
                )
            })
        }
    };
    println!("cargo:rustc-env=CLIMON_UPDATE_PUBKEY_B64={key}");

    // Embed the climon version (from the repo-root package.json) so the updater
    // can compare the running version without depending on the CLI crate.
    let pkg_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());
    let pkg = std::fs::read_to_string(&pkg_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", pkg_path.display()));
    let version = extract_version(&pkg)
        .unwrap_or_else(|| panic!("no \"version\" field found in {}", pkg_path.display()));
    println!("cargo:rustc-env=CLIMON_VERSION={version}");
}

/// Extracts the first top-level `"version": "..."` string from package.json.
fn extract_version(json: &str) -> Option<String> {
    let key = "\"version\"";
    let idx = json.find(key)?;
    let after = &json[idx + key.len()..];
    let colon = after.find(':')?;
    let rest = &after[colon + 1..];
    let open = rest.find('"')?;
    let value_start = open + 1;
    let close = rest[value_start..].find('"')? + value_start;
    Some(rest[value_start..close].to_string())
}

/// Extracts the `UPDATE_PUBLIC_KEY_B64 = "..."` string literal from pubkey.ts
/// without pulling in a TS/JS parser. Tolerates whitespace/newlines between the
/// identifier, `=`, and the opening quote.
fn extract_pubkey(src: &str) -> Option<String> {
    let key = "UPDATE_PUBLIC_KEY_B64";
    let idx = src.find(key)?;
    let after = &src[idx + key.len()..];
    let eq = after.find('=')?;
    let rest = &after[eq + 1..];
    let open = rest.find('"')?;
    let value_start = open + 1;
    let close = rest[value_start..].find('"')? + value_start;
    Some(rest[value_start..close].to_string())
}
