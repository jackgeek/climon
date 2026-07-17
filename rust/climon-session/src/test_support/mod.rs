//! Test-only support code for the actor engine.
//!
//! This module is compiled only under `#[cfg(test)]` (see `lib.rs`) and is
//! never part of the crate's public API.

pub(crate) mod trace;
