//! Windows-only reaper for superseded, unlocked versioned artifacts. The real
//! implementation lands in Phase 3; this stub keeps `update_cmd` compiling until
//! then. On Unix it is a no-op.

use std::path::Path;

/// Deletes superseded, unlocked versioned artifacts from `dir`. Stub for now.
pub fn reap_superseded(_dir: &Path) {}
