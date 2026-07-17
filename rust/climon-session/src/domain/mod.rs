//! Pure actor-domain state: client registry and control-handoff transitions.
//!
//! These modules hold the actor engine's in-memory state and the pure
//! functions that transition it. They are consumed by the aggregate actor
//! state assembled in a later task, which is why some accessors here are
//! currently unused from within this crate.

pub(crate) mod attention;
pub(crate) mod clients;
pub(crate) mod control;
pub(crate) mod terminal;
