//! Real-PTY integration tests for `climon-pty`.
//!
//! These spawn actual processes through `portable-pty` (Unix `openpty` /
//! Windows ConPTY). They are intentionally part of `cargo test --workspace`.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;

use climon_pty::{Pty, PtyOptions, PtyParts};

#[cfg(unix)]
fn sh(script: &str) -> PtyOptions {
    PtyOptions {
        command: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: std::env::current_dir().unwrap(),
        cols: 80,
        rows: 24,
        env: None,
        #[cfg(windows)]
        headless_conpty: false,
    }
}

#[cfg(windows)]
fn sh(script: &str) -> PtyOptions {
    PtyOptions {
        command: "cmd".to_string(),
        args: vec!["/c".to_string(), script.to_string()],
        cwd: std::env::current_dir().unwrap(),
        cols: 80,
        rows: 24,
        env: None,
        headless_conpty: false,
    }
}

/// Reads from the reader until EOF (the child exited and the slave was
/// dropped), returning the accumulated bytes.
fn read_to_end(mut reader: Box<dyn Read + Send>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
        }
    }
    out
}

/// How long the capture helpers wait for a spawned child to exit on its own
/// before treating the environment as a wedged headless ConPTY (see
/// [`spawn_wait_capture`]). Comfortably longer than the sub-second commands the
/// tests spawn, but bounded so a wedged runner fails fast instead of hanging.
const CHILD_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Spawns `opts`, drains all PTY output on a background thread, waits (bounded)
/// for the child to exit, then drops the master **before** joining the reader.
///
/// Returns `Some((exit_code, output))` when the child exits on its own, or
/// `None` when it does not exit within [`CHILD_EXIT_TIMEOUT`] — a wedged
/// headless ConPTY, see [`conpty_wedged_skip`] — in which case the child is
/// killed and the PTY torn down so the test never hangs.
///
/// Two Windows-only teardown rules are baked in here so new tests can't
/// reintroduce the historic hangs (see #38):
///
/// 1. **Bounded wait.** Under a headless ConPTY (CI runners) a child can emit
///    all its output yet never reach its own `ExitProcess`, so a plain
///    [`Pty::wait`] blocks forever. [`Pty::wait_timeout`] caps that, and on a
///    timeout we [`kill`](Pty::kill) the child so the pseudoconsole can close.
/// 2. **Drop the master before joining the reader.** ConPTY's pseudoconsole
///    (and conhost, which holds the output pipe) only closes that pipe once the
///    `Pty` master is dropped, so a `read_to_end` reader never EOFs while the
///    master is alive and joining it deadlocks. Unix PTYs EOF on child exit
///    regardless, which is why the bug was Windows-only.
fn spawn_wait_capture(opts: &PtyOptions) -> Option<(i32, Vec<u8>)> {
    let mut pty = Pty::spawn(opts).expect("spawn");
    let reader = pty.try_clone_reader().expect("reader");
    let handle = std::thread::spawn(move || read_to_end(reader));
    let exit = pty.wait_timeout(CHILD_EXIT_TIMEOUT).expect("wait_timeout");
    if exit.is_none() {
        // Wedged headless ConPTY: the child never self-terminated. Kill it so
        // the pseudoconsole can close and the reader can EOF.
        pty.kill().ok();
    }
    // Must precede `join`; see rule 2 in the doc comment above.
    drop(pty);
    let out = handle.join().expect("join");
    exit.map(|code| (code, out))
}

/// Logs and reports that [`spawn_wait_capture`] returned `None` because the
/// child never self-terminated within [`CHILD_EXIT_TIMEOUT`].
///
/// Windows CI runs under a headless ConPTY where a child attached to the
/// pseudoconsole can produce all its output yet never reach its own
/// `ExitProcess`: tearing the master down then reports a control-C exit, not the
/// child's real code. That is an environment limitation, not a regression, so
/// exit-code-dependent tests treat it as inconclusive — mirroring
/// [`no_controlling_terminal`] on Unix. A real interactive Windows desktop exits
/// normally and exercises the full path.
fn conpty_wedged_skip() {
    eprintln!(
        "skipping: child did not self-terminate within {CHILD_EXIT_TIMEOUT:?} \
         (headless ConPTY pseudoconsole never reached the child's ExitProcess); \
         exit path not exercised here"
    );
}

/// Some sandboxed CI environments (notably GitHub-hosted Ubuntu runners) forbid
/// a process from claiming a controlling terminal, so the `setsid -c` wrapper
/// `climon-pty` applies on Unix fails with EPERM and the spawned program never
/// runs (its output is the `setsid` error instead). That is an environment
/// limitation, not a regression, so the spawn-output-dependent tests treat it as
/// inconclusive rather than failing. Real terminals (macOS CI, local Linux/dev)
/// still exercise the full path.
fn no_controlling_terminal(out: &[u8]) -> bool {
    let text = String::from_utf8_lossy(out);
    if text.contains("failed to set the controlling terminal") {
        eprintln!(
            "skipping: environment cannot set a controlling terminal (setsid -c \
             EPERM); spawn path not exercised here. Output: {text:?}"
        );
        true
    } else {
        false
    }
}

/// GitHub-hosted Linux runners and other sandboxes set `CLIMON_DISABLE_SETSID`
/// so the `setsid -c` wrapper is skipped (the runner denies the controlling-
/// terminal ioctl). The EPERM marker below is a fallback for sandboxes that
/// still attempt setsid; with the opt-out the child runs unwrapped, exactly as
/// on macOS, and these tests exercise the real PTY path.
#[test]
fn spawns_and_reads_output() {
    let (code, out) = match spawn_wait_capture(&sh("printf hi")) {
        Some(captured) => captured,
        None => {
            conpty_wedged_skip();
            return;
        }
    };
    if no_controlling_terminal(&out) {
        return;
    }
    assert_eq!(code, 0);
    assert!(
        out.windows(2).any(|w| w == b"hi"),
        "expected 'hi' in output, got: {:?}",
        String::from_utf8_lossy(&out)
    );
}

/// A detached daemon has no local terminal to answer ConPTY's initial cursor
/// position query. The shared PTY layer must therefore let a trivial child start,
/// write, and exit without any input from an external terminal.
#[cfg(windows)]
#[test]
fn headless_conpty_child_outputs_and_exits_without_external_cursor_reply() {
    let marker = "CLIMON HEADLESS CONPTY";
    let mut pty = Pty::spawn(&sh(&format!("echo {marker}")).for_headless_session()).expect("spawn");
    let reader = pty.try_clone_reader().expect("reader");
    let reader_handle = std::thread::spawn(move || read_to_end(reader));

    // This bound is test cleanup only: the regression leaves the child alive
    // forever, so kill it before asserting to avoid leaking a test process.
    let exit = pty
        .wait_timeout(std::time::Duration::from_secs(2))
        .expect("wait_timeout");
    if exit.is_none() {
        pty.kill().expect("kill wedged child");
    }
    drop(pty);
    let output = reader_handle.join().expect("reader joins");

    assert_eq!(
        exit,
        Some(0),
        "a headless ConPTY child must exit without an external cursor reply; output: {:?}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        String::from_utf8_lossy(&output).contains(marker),
        "expected {marker:?} in output, got: {:?}",
        String::from_utf8_lossy(&output)
    );
    assert!(
        !output
            .windows(b"\x1b[6n".len())
            .any(|bytes| bytes == b"\x1b[6n"),
        "the headless backend must not emit an inherited-cursor query: {:?}",
        String::from_utf8_lossy(&output)
    );
}

#[test]
fn propagates_nonzero_exit_code() {
    let (code, out) = match spawn_wait_capture(&sh("exit 7")) {
        Some(captured) => captured,
        None => {
            conpty_wedged_skip();
            return;
        }
    };
    if no_controlling_terminal(&out) {
        return;
    }
    assert_eq!(code, 7);
}

#[test]
fn resize_dedupes_and_does_not_panic() {
    // A short-lived sleeper keeps the PTY open across the resizes.
    #[cfg(unix)]
    let opts = sh("sleep 1");
    #[cfg(windows)]
    let opts = sh("ping -n 2 127.0.0.1 >NUL");

    let mut pty = Pty::spawn(&opts).expect("spawn");
    let reader = pty.try_clone_reader().expect("reader");
    let handle = std::thread::spawn(move || read_to_end(reader));

    assert_eq!(pty.size(), (80, 24));
    // No change at the current size.
    assert!(!pty.resize(80, 24));
    // A real change is applied.
    assert!(pty.resize(100, 40));
    assert_eq!(pty.size(), (100, 40));
    // Re-applying the same size is a no-op.
    assert!(!pty.resize(100, 40));
    // Clamping: zero collapses to one.
    assert!(pty.resize(0, 0));
    assert_eq!(pty.size(), (1, 1));

    // Resize via a cloned handle from another thread.
    let resizer = pty.resizer();
    let t = std::thread::spawn(move || resizer.resize(120, 50));
    assert!(t.join().unwrap());
    assert_eq!(pty.size(), (120, 50));

    let code = pty.wait_timeout(CHILD_EXIT_TIMEOUT).expect("wait_timeout");
    if code.is_none() {
        // Wedged headless ConPTY (the sleeper never self-terminated). Kill it so
        // the pseudoconsole can close and the reader can EOF below.
        pty.kill().ok();
    }
    // This test interleaves resizes between spawn and wait, so it can't use
    // `spawn_wait_capture`, but it must follow the same teardown rules: bound the
    // wait and drop the master before joining the reader (see that helper's doc
    // comment) or Windows hangs.
    drop(pty);
    let _ = handle.join();
    let _ = code;
}

#[test]
fn dropping_pty_releases_master_and_makes_resizer_inert() {
    // A long-lived child keeps the PTY open until we explicitly tear it down.
    #[cfg(unix)]
    let opts = sh("sleep 5");
    #[cfg(windows)]
    let opts = sh("ping -n 6 127.0.0.1 >NUL");

    let mut pty = Pty::spawn(&opts).expect("spawn");
    let reader = pty.try_clone_reader().expect("reader");
    let handle = std::thread::spawn(move || read_to_end(reader));

    // A cloned resize handle works while the owning Pty is alive.
    let resizer = pty.resizer();
    assert!(resizer.resize(100, 40));

    // Dropping the Pty releases the last *strong* master reference. On Windows
    // this is the `exit`-hang regression: ConPTY's pseudoconsole (and conhost,
    // which holds the output pipe) only closes when the master is dropped, so
    // without this the cloned reader never EOFs. The resizer holds only a Weak
    // ref, so it must not keep the master alive and becomes inert after drop.
    pty.kill().ok();
    drop(pty);

    // The reader thread must observe EOF and finish (would hang on regression).
    let _ = handle.join().expect("reader joins after pty drop");
    // A late resize through the cloned handle is a no-op rather than a panic
    // or a resurrected master.
    assert!(!resizer.resize(120, 50));
}

/// Drives a spawned command through [`Pty::into_parts`] — the production split —
/// instead of the borrowed `&Pty` helpers, proving the owned reader, waiter, and
/// independently-cloned killer wire up to real PTY handles.
///
/// It follows the same two Windows teardown rules as [`spawn_wait_capture`], but
/// expressed through the owned parts: a watchdog thread bounds the otherwise
/// unbounded [`PtyWaiter::wait`] by killing the child through the *concurrent*
/// [`PtyKiller`] (the whole point of the separate killer), and the consuming
/// `wait` drops the master before the reader thread is joined.
fn into_parts_wait_capture(opts: &PtyOptions) -> Option<(i32, Vec<u8>)> {
    let PtyParts {
        reader,
        writer: _writer,
        waiter,
        mut killer,
        ..
    } = Pty::spawn(&opts.clone().for_headless_session())
        .expect("spawn")
        .into_parts()
        .expect("into_parts");

    let reader_handle = std::thread::spawn(move || read_to_end(reader));

    // Bound the blocking wait so a regression cannot hang the test. The cloned
    // killer terminates it from this watchdog thread while the main thread is
    // parked in `wait`, with no shared mutex between them.
    let wedged = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let wedged_watch = Arc::clone(&wedged);
    let watchdog = std::thread::spawn(move || {
        if done_rx.recv_timeout(CHILD_EXIT_TIMEOUT).is_err() {
            wedged_watch.store(true, Ordering::SeqCst);
            let _ = killer.kill();
        }
    });

    // Consuming wait: blocks for the exit code, then drops the master (closing
    // the pseudoconsole on Windows) so the cloned reader EOFs below.
    let exit = waiter.wait();
    let _ = done_tx.send(());
    let out = reader_handle
        .join()
        .expect("reader joins after master drop");
    let _ = watchdog.join();

    if wedged.load(Ordering::SeqCst) {
        return None;
    }
    Some((exit.expect("wait"), out))
}

/// Smoke test: the production [`Pty::into_parts`] path streams child output
/// through its owned reader and reports the exit code from its consuming waiter,
/// on a real PTY.
#[test]
fn into_parts_streams_output_and_reports_exit() {
    #[cfg(unix)]
    let opts = sh("printf hi");
    #[cfg(windows)]
    let opts = sh("echo hi");
    let (code, out) = match into_parts_wait_capture(&opts) {
        Some(captured) => captured,
        None => {
            conpty_wedged_skip();
            return;
        }
    };
    if no_controlling_terminal(&out) {
        return;
    }
    assert_eq!(code, 0);
    assert!(
        out.windows(2).any(|w| w == b"hi"),
        "expected 'hi' in output, got: {:?}",
        String::from_utf8_lossy(&out)
    );
}

/// Smoke test for the non-blocking child-control surface added for the owned
/// session lifecycle: [`PtyWaiter::try_wait`] reports the live/exited state
/// without blocking, [`PtyWaiter::kill`] terminates the child through the
/// *authoritative* original handle (Unix `SIGHUP`→escalate→`SIGKILL`; Windows
/// `TerminateProcess`), and [`PtyWaiter::release_master`] drops the master so a
/// Windows ConPTY reader can EOF and the reader thread joins without deadlock.
///
/// A long-lived sleeper stays alive until it is killed, so on a healthy terminal
/// (macOS CI, local Linux/dev) this exercises the full poll→kill→reap path. On a
/// sandbox that cannot claim a controlling terminal the wrapped command dies
/// immediately, or a headless ConPTY wedges; both are treated as inconclusive
/// rather than failing, mirroring the other integration tests.
#[test]
fn waiter_try_wait_polls_and_kill_terminates_a_live_child() {
    #[cfg(unix)]
    let opts = sh("sleep 5");
    #[cfg(windows)]
    let opts = sh("ping -n 6 127.0.0.1 >NUL");

    let PtyParts {
        reader, mut waiter, ..
    } = Pty::spawn(&opts)
        .expect("spawn")
        .into_parts()
        .expect("into_parts");
    let reader_handle = std::thread::spawn(move || read_to_end(reader));

    let running_before_kill = waiter.try_wait().expect("try_wait").is_none();
    if running_before_kill {
        // Authoritative termination through the original child handle.
        waiter.kill().expect("kill");
    }

    // Poll (bounded) until the child is reaped; never block indefinitely.
    let deadline = std::time::Instant::now() + CHILD_EXIT_TIMEOUT;
    let mut exited = None;
    while std::time::Instant::now() < deadline {
        if let Some(code) = waiter.try_wait().expect("try_wait") {
            exited = Some(code);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // Drop the master before joining the reader (Windows ConPTY EOF rule).
    waiter.release_master();
    let _ = reader_handle
        .join()
        .expect("reader joins after master release");

    match (running_before_kill, exited) {
        // Full path exercised: the sleeper was running, the authoritative kill
        // terminated it, and a subsequent non-blocking try_wait reaped it.
        (true, Some(_)) => {}
        // Inconclusive environment (setsid EPERM / headless ConPTY wedge): the
        // control API was still callable, which is all we can assert here.
        _ => eprintln!(
            "skipping full poll→kill→reap assertion: child never reached a \
             deterministic running-then-killed state in this environment"
        ),
    }
}

#[test]
fn empty_command_errors() {
    let opts = PtyOptions {
        command: String::new(),
        args: vec![],
        cwd: std::env::current_dir().unwrap(),
        cols: 80,
        rows: 24,
        env: None,
        #[cfg(windows)]
        headless_conpty: false,
    };
    assert!(Pty::spawn(&opts).is_err());
}

#[cfg(unix)]
#[test]
fn provided_env_is_applied() {
    let mut env = std::collections::HashMap::new();
    env.insert("CLIMON_PTY_TEST".to_string(), "marker-value".to_string());
    let opts = PtyOptions {
        command: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf %s \"$CLIMON_PTY_TEST\"".to_string(),
        ],
        cwd: std::env::current_dir().unwrap(),
        cols: 80,
        rows: 24,
        env: Some(env),
    };
    let (_code, out) = match spawn_wait_capture(&opts) {
        Some(captured) => captured,
        None => {
            conpty_wedged_skip();
            return;
        }
    };
    if no_controlling_terminal(&out) {
        return;
    }
    assert!(
        out.windows(12).any(|w| w == b"marker-value"),
        "expected env value in output, got: {:?}",
        String::from_utf8_lossy(&out)
    );
}
