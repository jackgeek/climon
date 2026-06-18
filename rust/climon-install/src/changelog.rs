//! Install changelog reading + "what's new since" formatting. 1:1 port of
//! `src/install/changelog.ts`. The changelog JSON is embedded at compile time
//! just like the Bun bundler inlines `CHANGELOG.json`.

use std::fs;
use std::path::Path;

use serde::Deserialize;

/// One changelog entry: a version and its bullet-point changes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChangelogEntry {
    pub version: String,
    pub changes: Vec<String>,
}

/// The embedded changelog, inlined at compile time.
const CHANGELOG_JSON: &str = include_str!("../../../CHANGELOG.json");

/// Reads the previously installed version from the `.version` file in the
/// install directory. Returns `None` if no previous install is detected.
pub fn read_installed_version(install_dir: &Path) -> Option<String> {
    let version_file = install_dir.join(".version");
    if !version_file.exists() {
        return None;
    }
    fs::read_to_string(version_file)
        .ok()
        .map(|s| s.trim().to_string())
}

/// Parses the embedded changelog.
pub fn load_changelog() -> Vec<ChangelogEntry> {
    serde_json::from_str(CHANGELOG_JSON).expect("embedded CHANGELOG.json is valid")
}

/// Compares two strict `X.Y.Z` semver strings: `-1`, `0`, or `1`.
fn compare_semver(a: &str, b: &str) -> i32 {
    let pa: Vec<i64> = a.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    for i in 0..3 {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va < vb {
            return -1;
        }
        if va > vb {
            return 1;
        }
    }
    0
}

/// Returns changelog entries newer than `from_version` (all entries for a fresh
/// install), newest-first.
pub fn get_changes_since(
    changelog: &[ChangelogEntry],
    from_version: Option<&str>,
) -> Vec<ChangelogEntry> {
    match from_version {
        None => changelog.to_vec(),
        Some(from) => changelog
            .iter()
            .filter(|entry| compare_semver(&entry.version, from) > 0)
            .cloned()
            .collect(),
    }
}

/// Formats changelog entries for terminal display (empty string for no entries).
pub fn format_changelog(entries: &[ChangelogEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(String::new());
    lines.push("What's new:".to_string());
    lines.push(String::new());
    for entry in entries {
        lines.push(format!("  v{}:", entry.version));
        for change in &entry.changes {
            lines.push(format!("    • {change}"));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(version: &str, changes: &[&str]) -> ChangelogEntry {
        ChangelogEntry {
            version: version.to_string(),
            changes: changes.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn embedded_changelog_parses() {
        let log = load_changelog();
        assert!(!log.is_empty());
    }

    #[test]
    fn read_installed_version_none_when_absent() {
        let dir = std::env::temp_dir().join(format!("climon-cl-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_installed_version(&dir), None);
        fs::write(dir.join(".version"), "1.2.3\n").unwrap();
        assert_eq!(read_installed_version(&dir).as_deref(), Some("1.2.3"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn changes_since_filters_and_fresh_returns_all() {
        let log = vec![entry("1.2.0", &["b"]), entry("1.0.0", &["a"])];
        assert_eq!(get_changes_since(&log, None), log);
        assert_eq!(
            get_changes_since(&log, Some("1.1.0")),
            vec![entry("1.2.0", &["b"])]
        );
        assert!(get_changes_since(&log, Some("2.0.0")).is_empty());
    }

    #[test]
    fn format_empty_and_nonempty() {
        assert_eq!(format_changelog(&[]), "");
        let out = format_changelog(&[entry("1.2.0", &["did a thing"])]);
        assert!(out.contains("What's new:"));
        assert!(out.contains("  v1.2.0:"));
        assert!(out.contains("    • did a thing"));
    }
}
