//! I/O adapters: the async tasks that own the receiving end of each effect
//! route and translate [`Effect`]s into real pty/store/console/terminal
//! operations, feeding results back to the coordinator as [`SessionEvent`]s.
//!
//! Each adapter is a single owned task (or a small owned set of workers) with no
//! detached work: the supervisor (a later task) holds every returned
//! [`JoinHandle`]. The metadata, pty, ipc, local-terminal (console + input),
//! timer, and signals/resize adapters are all present; the supervisor wires
//! them to the coordinator's routes and event lanes.
//!
//! [`Effect`]: crate::engine::effect::Effect
//! [`SessionEvent`]: crate::engine::event::SessionEvent
//! [`JoinHandle`]: tokio::task::JoinHandle

pub(crate) mod ipc;
pub(crate) mod local_terminal;
pub(crate) mod metadata;
pub(crate) mod pty;
pub(crate) mod signals;
pub(crate) mod timers;

#[cfg(test)]
mod production_api_tests {
    use crate::engine::coordinator::ControlEventSender;

    #[cfg(unix)]
    #[test]
    fn unix_signal_spawner_is_reachable_by_sibling_modules() {
        let _spawn = super::signals::spawn_signal_adapter::<ControlEventSender>;
    }

    #[cfg(windows)]
    #[test]
    fn windows_resize_spawner_is_reachable_by_sibling_modules() {
        let _spawn = super::signals::spawn_resize_adapter::<ControlEventSender>;
    }
}
