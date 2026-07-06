//! Atomic pointer file writer + versioned filename helpers for the Windows
//! binary lifecycle. The pointer (`climon.version` / `climon-server.version`)
//! is the commit signal of an update; written temp + rename so it is never
//! observed half-written. Unix does not use pointers.

use std::path::Path;

/// The versioned client DLL filename for `version` (e.g. "climon-3.2.1.dll").
pub fn client_dll_name(version: &str) -> String {
    format!("climon-{version}.dll")
}

/// The versioned server exe filename for `version` (e.g. "climon-server-3.2.1.exe").
pub fn server_exe_name(version: &str) -> String {
    format!("climon-server-{version}.exe")
}

/// Atomically writes `<dir>/<base>.version` containing `version` + newline.
pub fn write_pointer(dir: &Path, base: &str, version: &str) -> Result<(), String> {
    let final_path = dir.join(format!("{base}.version"));
    let pid = std::process::id();
    let now = crate::clock::now_ms();
    let tmp = dir.join(format!("{base}.version.tmp-{pid}-{now}"));
    std::fs::write(&tmp, format!("{version}\n"))
        .map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename to {} failed: {e}", final_path.display())
    })?;
    Ok(())
}

/// Reads and trims `<dir>/<base>.version`; `None` if missing/blank.
pub fn read_pointer(dir: &Path, base: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(format!("{base}.version"))).ok()?;
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versioned_names_match_spec() {
        assert_eq!(client_dll_name("3.2.1"), "climon-3.2.1.dll");
        assert_eq!(server_exe_name("3.2.1"), "climon-server-3.2.1.exe");
    }

    #[test]
    fn write_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        write_pointer(tmp.path(), "climon", "3.2.1").unwrap();
        assert_eq!(read_pointer(tmp.path(), "climon").as_deref(), Some("3.2.1"));
    }

    #[test]
    fn write_overwrites_existing() {
        let tmp = tempfile::tempdir().unwrap();
        write_pointer(tmp.path(), "climon", "1.0.0").unwrap();
        write_pointer(tmp.path(), "climon", "2.0.0").unwrap();
        assert_eq!(read_pointer(tmp.path(), "climon").as_deref(), Some("2.0.0"));
    }

    #[test]
    fn missing_pointer_reads_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_pointer(tmp.path(), "climon"), None);
    }
}
