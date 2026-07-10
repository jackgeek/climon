//! Watches the ingest's OWN home for a `shutdown-request.json`. Port of
//! `src/remote/shutdown-watch.ts`.
//!
//! The TS implementation uses `fs.watch` for a fast path with a polling
//! backstop. This port uses the polling backstop only (a background thread on a
//! fixed cadence), which is behaviorally equivalent: a request is consumed
//! before `on_valid` runs, so it acts at most once and a leftover file can never
//! replay. See `docs/security.md` (untrusted same-user signal, no token).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::shutdown_request::{
    get_shutdown_request_path_in_dir, parse_shutdown_request, ShutdownRequest,
};

/// Default poll cadence backstop in milliseconds.
pub const DEFAULT_POLL_MS: u64 = 1000;

/// Handle that stops the watcher thread when [`ShutdownRequestWatcher::stop`] is
/// called or the value is dropped.
pub struct ShutdownRequestWatcher {
    stopped: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl ShutdownRequestWatcher {
    /// Stops the watcher and joins its thread.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ShutdownRequestWatcher {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

/// Starts a watcher over `dir` that calls `on_valid` once when a well-formed
/// request is observed (after the file is consumed). Mirrors
/// `createShutdownRequestWatcher`.
pub fn create_shutdown_request_watcher<F>(
    dir: PathBuf,
    poll_ms: u64,
    on_valid: F,
) -> ShutdownRequestWatcher
where
    F: Fn(ShutdownRequest) + Send + 'static,
{
    let request_path = get_shutdown_request_path_in_dir(&dir);
    // A request present at startup cannot be for this fresh instance: clear it.
    let _ = std::fs::remove_file(&request_path);

    let stopped = Arc::new(AtomicBool::new(false));
    let thread_stopped = stopped.clone();
    let interval = Duration::from_millis(poll_ms.max(1));

    let handle = std::thread::spawn(move || {
        let mut done = false;
        while !thread_stopped.load(Ordering::SeqCst) {
            std::thread::sleep(interval);
            if done || thread_stopped.load(Ordering::SeqCst) {
                continue;
            }
            let raw = match std::fs::read_to_string(&request_path) {
                Ok(raw) => raw,
                Err(_) => continue, // absent or unreadable
            };
            match parse_shutdown_request(&raw) {
                None => {
                    let _ = std::fs::remove_file(&request_path); // malformed: drop it
                }
                Some(request) => {
                    done = true;
                    let _ = std::fs::remove_file(&request_path); // consume before acting
                    on_valid(request);
                }
            }
        }
    });

    ShutdownRequestWatcher {
        stopped,
        handle: Some(handle),
    }
}

/// Guard returned by [`spawn_poll`]; stops the polling thread on drop.
pub struct PollGuard {
    stopped: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for PollGuard {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Spawns a thread that invokes `tick` every `poll_ms`, returning a [`PollGuard`]
/// that stops (and joins) the thread on drop. A minimal generic poller used by
/// the ingest's sessions-dir dismiss watcher.
pub fn spawn_poll<F>(poll_ms: u64, mut tick: F) -> PollGuard
where
    F: FnMut() + Send + 'static,
{
    let stopped = Arc::new(AtomicBool::new(false));
    let thread_stopped = stopped.clone();
    let interval = Duration::from_millis(poll_ms.max(1));
    let handle = std::thread::spawn(move || {
        while !thread_stopped.load(Ordering::SeqCst) {
            std::thread::sleep(interval);
            if thread_stopped.load(Ordering::SeqCst) {
                break;
            }
            tick();
        }
    });
    PollGuard {
        stopped,
        handle: Some(handle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shutdown_request::write_shutdown_request_to_dir;
    use std::sync::Mutex;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-shutdown-watch-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn req() -> ShutdownRequest {
        ShutdownRequest {
            requested_by: "Windows".to_string(),
            ts: 1_717_000_000_001,
        }
    }

    /// Polls `cond` on a short cadence until it holds or `timeout` elapses,
    /// returning whether it held. Replaces fixed sleeps so the watcher tests do
    /// not race the poll thread's scheduling on contended CI runners.
    fn wait_until<F: Fn() -> bool>(timeout: Duration, cond: F) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if cond() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn clears_a_pre_existing_request_on_start() {
        let dir = tmp("clear");
        write_shutdown_request_to_dir(&dir, &req()).unwrap();
        let watcher = create_shutdown_request_watcher(dir.clone(), 15, |_| {});
        assert!(!get_shutdown_request_path_in_dir(&dir).exists());
        watcher.stop();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fires_on_valid_and_consumes_the_file() {
        let dir = tmp("valid");
        let seen: Arc<Mutex<Option<ShutdownRequest>>> = Arc::new(Mutex::new(None));
        let seen2 = seen.clone();
        let watcher = create_shutdown_request_watcher(dir.clone(), 15, move |r| {
            *seen2.lock().unwrap() = Some(r);
        });
        write_shutdown_request_to_dir(&dir, &req()).unwrap();
        assert!(
            wait_until(WAIT, || seen.lock().unwrap().is_some()),
            "watcher never fired on the valid request"
        );
        assert_eq!(
            seen.lock()
                .unwrap()
                .as_ref()
                .map(|r| r.requested_by.clone()),
            Some("Windows".to_string())
        );
        assert!(!get_shutdown_request_path_in_dir(&dir).exists());
        watcher.stop();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ignores_and_drops_a_malformed_request() {
        let dir = tmp("malformed");
        let calls = Arc::new(AtomicBool::new(false));
        let calls2 = calls.clone();
        let watcher = create_shutdown_request_watcher(dir.clone(), 15, move |_| {
            calls2.store(true, Ordering::SeqCst);
        });
        std::fs::write(get_shutdown_request_path_in_dir(&dir), "not json").unwrap();
        // The watcher must consume (delete) the malformed file; wait for that
        // rather than a fixed sleep, then assert the callback never fired.
        assert!(
            wait_until(WAIT, || !get_shutdown_request_path_in_dir(&dir).exists()),
            "watcher never dropped the malformed request"
        );
        assert!(!calls.load(Ordering::SeqCst));
        watcher.stop();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn acts_at_most_once() {
        let dir = tmp("once");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = calls.clone();
        let watcher = create_shutdown_request_watcher(dir.clone(), 15, move |_| {
            calls2.fetch_add(1, Ordering::SeqCst);
        });
        write_shutdown_request_to_dir(&dir, &req()).unwrap();
        // Wait for the first request to fire before writing the second, so the
        // "at most once" guarantee is what is under test rather than scheduling.
        assert!(
            wait_until(WAIT, || calls.load(Ordering::SeqCst) >= 1),
            "watcher never fired on the first request"
        );
        write_shutdown_request_to_dir(&dir, &req()).unwrap();
        // The watcher latched `done` after the first fire, so a second request
        // can never re-fire; give it several poll cycles and confirm it stays 1.
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        watcher.stop();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spawn_poll_ticks_until_dropped() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = calls.clone();
        let guard = spawn_poll(15, move || {
            calls2.fetch_add(1, Ordering::SeqCst);
        });
        assert!(
            wait_until(WAIT, || calls.load(Ordering::SeqCst) >= 1),
            "expected at least one tick"
        );
        drop(guard);
        // drop() joins the poll thread, so no tick can occur after it returns.
        let after_drop = calls.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            after_drop,
            "no ticks after the guard is dropped"
        );
    }
}
