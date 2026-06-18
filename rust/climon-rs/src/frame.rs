//! The frame codec now lives in `climon-proto`. This module re-exports it so the
//! PoC's `crate::frame::*` references keep resolving during the migration.
pub use climon_proto::frame::*;
