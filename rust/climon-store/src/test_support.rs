//! Test-only helpers: scratch directories on the real local filesystem under the
//! workspace `target/` dir (gitignored), never the system temp dir.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Returns (without creating) a unique scratch path under `target/`.
pub(crate) fn scratch_dir(tag: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let target = exe
        .ancestors()
        .find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("cwd"));
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    target
        .join("climon-store-test-tmp")
        .join(format!("{tag}-{}-{nanos}-{n}", std::process::id()))
}
