//! Shared demotion primitive (host -> client). Port of `src/remote/demotion.ts`.
//!
//! Run when this OS hands the host role to the peer: spawn an uplink so this
//! OS's still-running sessions push to the new host, stop the co-located
//! dashboard server, free the contested ingest listener, and remove this
//! daemon's own beacon(s). Each caller injects its own steps so the same
//! ordering is shared and unit-testable.

use std::future::Future;
use std::pin::Pin;

/// A boxed async step.
pub type DemotionStep = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Injected steps. Mirrors `DemotionDeps`.
pub struct DemotionDeps {
    /// Stop accepting connections on the contested ingest listener.
    pub close_listener: DemotionStep,
    /// Spawn a detached `__uplink` for this OS's local sessions.
    pub spawn_uplink: Box<dyn FnOnce() + Send>,
    /// Stop the co-located dashboard server (SIGTERM its pid; no network).
    pub stop_local_server: DemotionStep,
    /// Remove this daemon's own beacon file(s) and the consumed request file.
    pub remove_beacons: DemotionStep,
}

/// Runs the demotion steps in the fixed order. Mirrors `demote`.
///
/// The ingest listener is closed BEFORE spawning the uplink so the child does
/// not inherit the listening socket handle (Windows inherits inheritable
/// handles even with detached+stdio:ignore).
pub async fn demote(deps: DemotionDeps) {
    deps.close_listener.await;
    (deps.spawn_uplink)();
    deps.stop_local_server.await;
    deps.remove_beacons.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn runs_steps_in_the_documented_order() {
        let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let l1 = log.clone();
        let l2 = log.clone();
        let l3 = log.clone();
        let l4 = log.clone();
        demote(DemotionDeps {
            close_listener: Box::pin(async move {
                l1.lock().unwrap().push("close");
            }),
            spawn_uplink: Box::new(move || {
                l2.lock().unwrap().push("spawn");
            }),
            stop_local_server: Box::pin(async move {
                l3.lock().unwrap().push("stop");
            }),
            remove_beacons: Box::pin(async move {
                l4.lock().unwrap().push("beacons");
            }),
        })
        .await;
        assert_eq!(
            *log.lock().unwrap(),
            vec!["close", "spawn", "stop", "beacons"]
        );
    }
}
