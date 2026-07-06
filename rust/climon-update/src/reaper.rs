//! Windows-only reaper for superseded versioned binaries. Deletes
//! `climon-<ver>.dll` / `climon-server-<ver>.exe` that are neither the current
//! pointer target nor currently locked (held by a running process / loaded
//! DLL). Never force-kills a holder. No-op on Unix.

use std::path::Path;

/// A reap outcome for reporting (used by `climon cleanup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapResult {
    /// Filenames deleted.
    pub removed: Vec<String>,
    /// Filenames skipped because they were locked (a process still holds them).
    pub skipped_locked: Vec<String>,
}

/// Reaps superseded versioned artifacts in `dir`. Best-effort; returns what it
/// did for optional reporting.
pub fn reap_superseded(dir: &Path) -> ReapResult {
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    reap_kind(dir, "climon-", ".dll", "climon", &mut removed, &mut skipped);
    reap_kind(
        dir,
        "climon-server-",
        ".exe",
        "climon-server",
        &mut removed,
        &mut skipped,
    );
    ReapResult {
        removed,
        skipped_locked: skipped,
    }
}

fn reap_kind(
    dir: &Path,
    prefix: &str,
    suffix: &str,
    pointer_base: &str,
    removed: &mut Vec<String>,
    skipped: &mut Vec<String>,
) {
    let keep_version = crate::pointer::read_pointer(dir, pointer_base);
    let keep_name = keep_version.map(|v| format!("{prefix}{v}{suffix}"));
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        // Must match the versioned pattern (prefix + non-empty + suffix), and
        // NOT be the "climon-server-" family when scanning the "climon-" family.
        if !name.starts_with(prefix) || !name.ends_with(suffix) {
            continue;
        }
        // Guard: "climon-" also prefixes "climon-server-..."; skip those here.
        if prefix == "climon-" && name.starts_with("climon-server-") {
            continue;
        }
        if Some(&name) == keep_name.as_ref() {
            continue; // current target
        }
        let path = entry.path();
        if try_delete_if_unlocked(&path) {
            removed.push(name);
        } else {
            skipped.push(name);
        }
    }
}

/// Attempts to delete `path`; returns true if removed, false if it appears
/// locked (a running process/loaded DLL holds it). Never kills a holder.
fn try_delete_if_unlocked(path: &Path) -> bool {
    // On Windows, removing a file with an open handle (loaded DLL / running exe)
    // fails with a sharing violation, which is exactly the signal we want.
    std::fs::remove_file(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn keeps_pointer_target_and_reaps_others() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon.version"), "3.2.1\n").unwrap();
        touch(dir, "climon-3.2.1.dll"); // keep
        touch(dir, "climon-3.1.0.dll"); // reap
        let result = reap_superseded(dir);
        assert!(result.removed.contains(&"climon-3.1.0.dll".to_string()));
        assert!(dir.join("climon-3.2.1.dll").exists());
        assert!(!dir.join("climon-3.1.0.dll").exists());
    }

    #[test]
    fn does_not_reap_server_family_when_scanning_client() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("climon.version"), "3.2.1\n").unwrap();
        fs::write(dir.join("climon-server.version"), "3.2.1\n").unwrap();
        touch(dir, "climon-3.2.1.dll"); // keep
        touch(dir, "climon-server-3.2.1.exe"); // keep (server target)
        touch(dir, "climon-server-3.1.0.exe"); // reap (server superseded)
        let result = reap_superseded(dir);
        assert!(dir.join("climon-3.2.1.dll").exists());
        assert!(dir.join("climon-server-3.2.1.exe").exists());
        assert!(result
            .removed
            .contains(&"climon-server-3.1.0.exe".to_string()));
    }

    #[test]
    fn no_pointer_keeps_nothing_special_but_reaps_all_unlocked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        touch(dir, "climon-1.0.0.dll");
        let result = reap_superseded(dir);
        // With no pointer, the file is superseded-by-nothing but not "current",
        // so it is reaped. (Post-install a pointer always exists.)
        assert!(result.removed.contains(&"climon-1.0.0.dll".to_string()));
    }
}
