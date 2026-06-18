//! Release manifest parsing/validation + semver compare. Port of
//! `src/update/manifest.ts`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::download::download_json_bytes;

/// One downloadable artifact: the zip URL and its detached signature URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestArtifact {
    pub url: String,
    pub sig: String,
}

/// The release manifest published alongside signed artifacts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    /// Envelope scheme id when artifacts are encrypted; `None` for plaintext.
    pub encryption: Option<String>,
    pub artifacts: BTreeMap<String, ManifestArtifact>,
}

fn parse(version: &str) -> [i64; 3] {
    let cleaned = version
        .trim()
        .strip_prefix('v')
        .unwrap_or_else(|| version.trim());
    let mut parts = cleaned.split('.');
    let maj = parts.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    let min = parts.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    let pat = parts.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    [maj, min, pat]
}

/// Returns >0 if a>b, 0 if equal, <0 if a<b (major, minor, patch order).
pub fn compare_semver(a: &str, b: &str) -> i64 {
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..3 {
        if pa[i] != pb[i] {
            return pa[i] - pb[i];
        }
    }
    0
}

/// True when the manifest's version is strictly newer than `current`.
pub fn is_newer(manifest: &Manifest, current: &str) -> bool {
    compare_semver(&manifest.version, current) > 0
}

/// Validates a parsed JSON value into a [`Manifest`], mirroring the field checks
/// in TS `fetchManifest`. Returns `Err("Malformed manifest")` on any violation.
pub fn manifest_from_value(data: &Value) -> Result<Manifest, String> {
    let obj = data.as_object().ok_or("Malformed manifest")?;
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .ok_or("Malformed manifest")?
        .to_string();

    let artifacts_val = obj.get("artifacts").ok_or("Malformed manifest")?;
    if !artifacts_val.is_object() {
        // Covers `null` and array forms, matching the TS guard.
        return Err("Malformed manifest".to_string());
    }

    let encryption = match obj.get("encryption") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("Malformed manifest".to_string()),
    };

    let mut artifacts = BTreeMap::new();
    for (key, av) in artifacts_val.as_object().unwrap() {
        let url = av
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let sig = av
            .get("sig")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        artifacts.insert(key.clone(), ManifestArtifact { url, sig });
    }

    Ok(Manifest {
        version,
        encryption,
        artifacts,
    })
}

/// Parses manifest JSON bytes, validating structure like TS `fetchManifest`.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let data: Value =
        serde_json::from_slice(bytes).map_err(|_| "Malformed manifest".to_string())?;
    manifest_from_value(&data)
}

/// Fetches and validates a release manifest from a URL.
pub fn fetch_manifest(url: &str) -> Result<Manifest, String> {
    let bytes = download_json_bytes(url)?;
    parse_manifest(&bytes)
}

/// Maps a node-style platform string to the OS segment of an artifact key.
fn os_segment(platform: &str) -> &'static str {
    match platform {
        "win32" => "windows",
        "darwin" => "darwin",
        _ => "linux",
    }
}

/// Maps a node-style arch string to the CPU segment of an artifact key.
fn cpu_segment(arch: &str) -> &'static str {
    if arch == "arm64" {
        "arm64"
    } else {
        "x64"
    }
}

/// Maps a (node platform, node arch) pair to its artifact key, e.g. `linux-x64`.
pub fn artifact_key(platform: &str, arch: &str) -> String {
    format!("{}-{}", os_segment(platform), cpu_segment(arch))
}

/// The current process's node-style platform string (`darwin`/`win32`/`linux`).
pub fn current_node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

/// The current process's node-style arch string (`arm64`/`x64`).
pub fn current_node_arch() -> &'static str {
    if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x64"
    }
}

/// Maps the current process to its artifact key, e.g. `linux-x64`.
pub fn current_artifact_key() -> String {
    artifact_key(current_node_platform(), current_node_arch())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(version: &str) -> Manifest {
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            "linux-x64".to_string(),
            ManifestArtifact {
                url: "u".to_string(),
                sig: "s".to_string(),
            },
        );
        Manifest {
            version: version.to_string(),
            encryption: None,
            artifacts,
        }
    }

    #[test]
    fn compare_semver_orders_by_major_minor_patch() {
        assert!(compare_semver("0.13.0", "0.12.9") > 0);
        assert_eq!(compare_semver("1.0.0", "1.0.0"), 0);
        assert!(compare_semver("0.12.1", "0.12.10") < 0);
    }

    #[test]
    fn compare_semver_tolerates_leading_v() {
        assert_eq!(compare_semver("v0.13.0", "0.13.0"), 0);
    }

    #[test]
    fn is_newer_when_manifest_version_exceeds_current() {
        let m = manifest("0.13.0");
        assert!(is_newer(&m, "0.12.1"));
        assert!(!is_newer(&m, "0.13.0"));
        assert!(!is_newer(&m, "0.14.0"));
    }

    #[test]
    fn parse_returns_well_formed_manifest() {
        let body = json!({
            "version": "0.13.0",
            "artifacts": { "linux-x64": { "url": "u", "sig": "s" } }
        });
        let m = parse_manifest(body.to_string().as_bytes()).unwrap();
        assert_eq!(m, manifest("0.13.0"));
    }

    #[test]
    fn parse_rejects_malformed_manifests() {
        let cases = vec![
            Value::Null,
            json!({ "version": "1.0.0", "artifacts": [] }),
            json!({ "version": "1.0.0", "artifacts": null }),
            json!({ "artifacts": {} }),
            json!({ "version": "1.0.0", "encryption": 5, "artifacts": {} }),
        ];
        for c in cases {
            let res = parse_manifest(c.to_string().as_bytes());
            assert_eq!(res, Err("Malformed manifest".to_string()), "case: {c}");
        }
    }

    #[test]
    fn parse_accepts_optional_string_encryption() {
        let body = json!({
            "version": "1.0.0",
            "encryption": "aes-256-gcm-scrypt-v1",
            "artifacts": { "linux-x64": { "url": "u", "sig": "s" } }
        });
        let m = parse_manifest(body.to_string().as_bytes()).unwrap();
        assert_eq!(m.encryption.as_deref(), Some("aes-256-gcm-scrypt-v1"));
    }

    #[test]
    fn artifact_key_maps_platform_and_arch() {
        assert_eq!(artifact_key("linux", "x64"), "linux-x64");
        assert_eq!(artifact_key("win32", "arm64"), "windows-arm64");
        assert_eq!(artifact_key("darwin", "arm64"), "darwin-arm64");
        assert_eq!(artifact_key("freebsd", "ppc"), "linux-x64");
    }
}
