//! cwd-confined file read for the remote uplink. Mirrors
//! `src/server/file-read.ts`: resolve against the canonical cwd, canonicalize,
//! confine to the cwd subtree, require a regular file, size-cap, binary-screen.

use serde_json::json;

/// Reads a file confined to `cwd`, returning a JSON value matching the TS
/// `FileReadResult` discriminated union (`ok` / `binary` / `too-large` /
/// `refused` / `not-found`). All inputs are untrusted: the requested path is
/// resolved against the canonical cwd, fully canonicalized (so symlinks/`..`
/// that escape are rejected), required to be a regular file, size-capped, and
/// binary-screened. Never reads anything outside the cwd subtree.
pub fn read_confined_file(cwd: &str, requested: &str, max_bytes: u64) -> serde_json::Value {
    let base = match std::fs::canonicalize(cwd) {
        Ok(p) => p,
        Err(_) => return json!({ "status": "not-found", "path": requested }),
    };
    let resolved = base.join(requested);
    let real = match std::fs::canonicalize(&resolved) {
        Ok(p) => p,
        Err(_) => return json!({ "status": "not-found", "path": resolved.to_string_lossy() }),
    };
    if !is_contained(&base, &real) {
        return json!({ "status": "refused", "path": real.to_string_lossy() });
    }
    let meta = match std::fs::metadata(&real) {
        Ok(m) => m,
        Err(_) => return json!({ "status": "not-found", "path": real.to_string_lossy() }),
    };
    if !meta.is_file() {
        return json!({ "status": "refused", "path": real.to_string_lossy() });
    }
    if meta.len() > max_bytes {
        return json!({ "status": "too-large", "path": real.to_string_lossy(), "size": meta.len() });
    }
    let bytes = match std::fs::read(&real) {
        Ok(b) => b,
        Err(_) => return json!({ "status": "not-found", "path": real.to_string_lossy() }),
    };
    if bytes.contains(&0u8) {
        return json!({ "status": "binary", "path": real.to_string_lossy() });
    }
    match String::from_utf8(bytes) {
        Ok(content) => {
            json!({ "status": "ok", "path": real.to_string_lossy(), "content": content })
        }
        Err(_) => json!({ "status": "binary", "path": real.to_string_lossy() }),
    }
}

/// True when `target` is the base dir itself or strictly inside it. Mirrors the
/// TS `isContained`, comparing canonicalized paths component-wise.
fn is_contained(base: &std::path::Path, target: &std::path::Path) -> bool {
    target == base || target.starts_with(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_inside_cwd_and_refuses_escape() {
        let dir = std::env::temp_dir().join(format!("climon-rfr-{}", std::process::id()));
        let proj = dir.join("project");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("a.txt"), "hi\n").unwrap();
        fs::write(dir.join("secret.txt"), "x").unwrap();

        let ok = read_confined_file(proj.to_str().unwrap(), "a.txt", 1024);
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["content"], "hi\n");

        let escaped = read_confined_file(proj.to_str().unwrap(), "../secret.txt", 1024);
        assert_eq!(escaped["status"], "refused");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_oversize_and_binary_and_missing() {
        let dir = std::env::temp_dir().join(format!("climon-rfr2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("big.txt"), "0123456789").unwrap();
        fs::write(dir.join("bin.dat"), [1u8, 0u8, 2u8]).unwrap();
        let base = dir.to_str().unwrap();

        assert_eq!(
            read_confined_file(base, "big.txt", 4)["status"],
            "too-large"
        );
        assert_eq!(
            read_confined_file(base, "bin.dat", 1024)["status"],
            "binary"
        );
        assert_eq!(
            read_confined_file(base, "missing", 1024)["status"],
            "not-found"
        );
        assert_eq!(read_confined_file(base, ".", 1024)["status"], "refused");

        fs::remove_dir_all(&dir).ok();
    }
}
