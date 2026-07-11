//! Pointer-file reader used by the Windows superseded-binary reaper.

use std::path::Path;

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
    fn reads_and_trims_existing_pointer() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("climon.version"), "3.2.1\n").unwrap();
        assert_eq!(read_pointer(tmp.path(), "climon").as_deref(), Some("3.2.1"));
    }

    #[test]
    fn missing_pointer_reads_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_pointer(tmp.path(), "climon"), None);
    }
}
