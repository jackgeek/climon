//! climon client protocol & metadata types.
//!
//! A 1:1 Rust port of the TypeScript client's wire/metadata surface so the Rust
//! client interoperates byte-for-byte with the unmodified Bun server. Modules
//! mirror their TS source files:
//!
//! - [`frame`]      <- `src/ipc/frame.ts`
//! - [`meta`]       <- `src/types.ts`
//! - [`priority`]   <- `src/priority.ts`
//! - [`session_meta`] <- `src/session-meta.ts`

pub mod frame;
pub mod meta;
pub mod priority;
pub mod session_meta;
