//! Zero-dependency stub launcher logic shared by the client and server stubs.
//!
//! Both Windows stubs resolve a plain-text `<base>.version` pointer to a
//! versioned artifact (`climon-<ver>.dll` for the client, `climon-server-<ver>.exe`
//! for the server). If the pointer is missing/blank or its target is absent,
//! they fall back to the highest-semver matching artifact present in the
//! install directory. See docs/superpowers/specs/2026-07-06-windows-binary-lifecycle-design.md.

pub mod pointer;
