//! I/O adapters: the async tasks that own the receiving end of each effect
//! route and translate [`Effect`]s into real pty/store/console operations,
//! feeding results back to the coordinator as [`SessionEvent`]s.
//!
//! Each adapter is a single owned task with no detached work: the supervisor
//! (a later task) holds every returned [`JoinHandle`]. The ordered metadata
//! adapter is the first; the pty/ipc/console/timer adapters land afterwards.
//!
//! [`Effect`]: crate::engine::effect::Effect
//! [`SessionEvent`]: crate::engine::event::SessionEvent
//! [`JoinHandle`]: tokio::task::JoinHandle

pub(crate) mod metadata;
