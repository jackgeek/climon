//! Pointer resolution: read `<base>.version`, form the versioned artifact name,
//! and fall back to the highest-semver matching artifact on disk. No external
//! crates — hand-rolled semver compare on dotted numeric components.

use std::path::{Path, PathBuf};

/// Describes how a stub maps versions to artifact filenames.
#[derive(Debug, Clone, Copy)]
pub struct ArtifactKind {
    /// Base name of the pointer file, e.g. "climon" or "climon-server".
    pub base: &'static str,
    /// Prefix of a versioned artifact, e.g. "climon-" or "climon-server-".
    pub prefix: &'static str,
    /// Suffix of a versioned artifact, e.g. ".dll" or ".exe".
    pub suffix: &'static str,
}

/// The client artifact: `climon.version` -> `climon-<ver>.dll`.
pub const CLIENT: ArtifactKind = ArtifactKind {
    base: "climon",
    prefix: "climon-",
    suffix: ".dll",
};

/// The server artifact: `climon-server.version` -> `climon-server-<ver>.exe`.
pub const SERVER: ArtifactKind = ArtifactKind {
    base: "climon-server",
    prefix: "climon-server-",
    suffix: ".exe",
};

/// Resolves the versioned artifact path for `kind` inside `dir`.
///
/// 1. If `<dir>/<base>.version` exists and is non-blank, target =
///    `<dir>/<prefix><trimmed><suffix>`; return it if it exists.
/// 2. Otherwise fall back to the highest-semver artifact matching
///    `<prefix>*<suffix>` present in `dir`.
/// 3. If nothing resolves, return `Err` with a human-readable message.
pub fn resolve_artifact(dir: &Path, kind: ArtifactKind) -> Result<PathBuf, String> {
    if let Some(version) = read_pointer(dir, kind) {
        let candidate = dir.join(format!("{}{}{}", kind.prefix, version, kind.suffix));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Some(best) = highest_semver_artifact(dir, kind) {
        return Ok(best);
    }
    Err(format!(
        "no {}<ver>{} artifact found in {}",
        kind.prefix,
        kind.suffix,
        dir.display()
    ))
}

/// Reads and trims `<dir>/<base>.version`; returns `None` if missing or blank.
pub fn read_pointer(dir: &Path, kind: ArtifactKind) -> Option<String> {
    let path = dir.join(format!("{}.version", kind.base));
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Scans `dir` for `<prefix><ver><suffix>` and returns the highest-semver path.
fn highest_semver_artifact(dir: &Path, kind: ArtifactKind) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(rest) = name.strip_prefix(kind.prefix) {
            if let Some(ver) = rest.strip_suffix(kind.suffix) {
                let parsed = parse_semver(ver);
                if !parsed.is_empty() {
                    let is_better = match &best {
                        Some((best_ver, _)) => cmp_semver(&parsed, best_ver).is_gt(),
                        None => true,
                    };
                    if is_better {
                        best = Some((parsed, entry.path()));
                    }
                }
            }
        }
    }
    best.map(|(_, path)| path)
}

/// Parses a dotted-numeric version ("3.2.1") into components. Returns empty on
/// any non-numeric component so pre-release/garbage names are ignored.
fn parse_semver(s: &str) -> Vec<u64> {
    let mut out = Vec::new();
    for part in s.split('.') {
        match part.parse::<u64>() {
            Ok(n) => out.push(n),
            Err(_) => return Vec::new(),
        }
    }
    out
}

/// Compares two parsed versions component-wise (shorter is padded with zeros).
fn cmp_semver(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let len = a.len().max(b.len());
    for i in 0..len {
        let ai = a.get(i).copied().unwrap_or(0);
        let bi = b.get(i).copied().unwrap_or(0);
        match ai.cmp(&bi) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn resolves_pointer_target_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon.version"), "3.2.1\n").unwrap();
        touch(dir, "climon-3.2.1.dll");
        let got = resolve_artifact(dir, CLIENT).unwrap();
        assert_eq!(got, dir.join("climon-3.2.1.dll"));
    }

    #[test]
    fn falls_back_to_highest_semver_when_pointer_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        touch(dir, "climon-3.1.0.dll");
        touch(dir, "climon-3.2.1.dll");
        touch(dir, "climon-3.10.0.dll");
        let got = resolve_artifact(dir, CLIENT).unwrap();
        assert_eq!(got, dir.join("climon-3.10.0.dll"));
    }

    #[test]
    fn falls_back_when_pointer_target_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon.version"), "9.9.9").unwrap();
        touch(dir, "climon-3.2.1.dll");
        let got = resolve_artifact(dir, CLIENT).unwrap();
        assert_eq!(got, dir.join("climon-3.2.1.dll"));
    }

    #[test]
    fn blank_pointer_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon.version"), "   \n").unwrap();
        touch(dir, "climon-1.0.0.dll");
        assert_eq!(read_pointer(dir, CLIENT), None);
        assert_eq!(resolve_artifact(dir, CLIENT).unwrap(), dir.join("climon-1.0.0.dll"));
    }

    #[test]
    fn errors_when_nothing_present() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_artifact(tmp.path(), CLIENT).unwrap_err();
        assert!(err.contains("climon-"), "unexpected: {err}");
    }

    #[test]
    fn server_kind_uses_exe_suffix() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon-server.version"), "2.0.0").unwrap();
        touch(dir, "climon-server-2.0.0.exe");
        let got = resolve_artifact(dir, SERVER).unwrap();
        assert_eq!(got, dir.join("climon-server-2.0.0.exe"));
    }
}
