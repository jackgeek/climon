//! Cross-platform PTY spawn/resize built on [`portable_pty`].
//!
//! This is the production home for the PTY mechanics prototyped in
//! `rust/climon-rs/src/host.rs`, ported from `src/pty.ts`. It exposes a
//! pull-based [`Pty`] the session host (Phase 7) can build its relay, IPC, and
//! scrollback broadcast on top of: clone a reader, take a writer, resize the
//! master, wait for the child's exit code, and kill it.
//!
//! ## Deviation from `src/pty.ts`
//! `pty.ts` exposes a push-based `onData`/`onExit` listener model (a Bun
//! `Terminal`-ism) with explicit early-output/fast-exit buffering. Here the
//! kernel PTY buffer plus a blocking [`std::io::Read`] reader guarantee no
//! output is lost before the consumer starts reading, and [`Pty::wait`] yields
//! the exit code, so that buffering is unnecessary and intentionally dropped.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::command::{build_spawn_argv, find_setsid, next_size};
use crate::error::{PtyError, PtyResult};

/// Spawn parameters for a PTY-hosted command. Mirrors `PtyOptions` in
/// `src/pty.ts`.
#[derive(Debug, Clone)]
pub struct PtyOptions {
    /// The executable to run.
    pub command: String,
    /// Arguments passed to the executable.
    pub args: Vec<String>,
    /// Working directory for the child.
    pub cwd: PathBuf,
    /// Initial terminal columns.
    pub cols: u16,
    /// Initial terminal rows.
    pub rows: u16,
    /// Optional full environment. When `Some`, it replaces the inherited
    /// environment (matching the `{...options.env}` spread in `pty.ts`); when
    /// `None`, the parent environment is inherited. `TERM` defaults to
    /// `xterm-256color` when not already set either way.
    pub env: Option<HashMap<String, String>>,
}

type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type AppliedSize = Arc<Mutex<(u16, u16)>>;

/// A spawned PTY plus its child process.
///
/// Obtain the reader/writer once up front, then drive the session: [`resize`]
/// (or a cloned [`PtyResizer`]) from any thread, [`wait`] for the exit code on
/// the owning thread, and [`kill`] to terminate.
///
/// [`resize`]: Pty::resize
/// [`wait`]: Pty::wait
/// [`kill`]: Pty::kill
pub struct Pty {
    master: SharedMaster,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    applied_size: AppliedSize,
    pid: Option<u32>,
}

impl Pty {
    /// Spawns `options.command` attached to a freshly opened PTY.
    ///
    /// On Unix the command is wrapped in `setsid -c` when available so the PTY
    /// becomes the child's controlling terminal (restores job control); on
    /// Windows it runs unwrapped under ConPTY. `TERM` defaults to
    /// `xterm-256color` when unset.
    pub fn spawn(options: &PtyOptions) -> PtyResult<Pty> {
        if options.command.is_empty() {
            return Err(PtyError::EmptyCommand);
        }

        let cols = options.cols.max(1);
        let rows = options.rows.max(1);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(backend)?;

        let setsid = if cfg!(windows) { None } else { find_setsid() };
        let argv = build_spawn_argv(setsid, &options.command, &options.args);

        let mut cmd = CommandBuilder::new(&argv[0]);
        for arg in &argv[1..] {
            cmd.arg(arg);
        }
        cmd.cwd(&options.cwd);
        apply_env(&mut cmd, options.env.as_ref());

        let child = pair.slave.spawn_command(cmd).map_err(backend)?;
        // Drop the slave so the master read returns EOF once the child exits.
        drop(pair.slave);

        let pid = child.process_id();

        Ok(Pty {
            master: Arc::new(Mutex::new(pair.master)),
            child,
            applied_size: Arc::new(Mutex::new((cols, rows))),
            pid,
        })
    }

    /// The child process id, if known.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Clones a blocking reader over the PTY's output. Output produced before
    /// the first read is held in the kernel PTY buffer, so nothing is lost.
    pub fn try_clone_reader(&self) -> PtyResult<Box<dyn Read + Send>> {
        self.master
            .lock()
            .unwrap()
            .try_clone_reader()
            .map_err(backend)
    }

    /// Takes the PTY's writer. Each PTY yields a single writer; the caller
    /// typically wraps it in a mutex to share across threads.
    pub fn take_writer(&self) -> PtyResult<Box<dyn Write + Send>> {
        self.master.lock().unwrap().take_writer().map_err(backend)
    }

    /// Applies a new terminal size. Clamps to `>= 1`, de-dupes against the last
    /// applied size, and on Unix delivers `SIGWINCH` to the child and every
    /// descendant so nested TUIs re-read the size. Returns whether the size
    /// changed (and was therefore applied).
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        apply_resize(&self.master, &self.applied_size, self.pid, cols, rows)
    }

    /// Returns a cheap, cloneable, `Send + Sync` handle that can [`resize`] the
    /// same PTY from another thread (e.g. a `SIGWINCH` listener owned by the
    /// session host) without sharing the whole [`Pty`].
    ///
    /// The handle holds only a [`Weak`] reference to the PTY master, so it never
    /// keeps the master (and, on Windows, the underlying ConPTY pseudoconsole)
    /// alive. Once the owning [`Pty`] is dropped at session teardown, the
    /// pseudoconsole closes, the cloned reader EOFs, and any late
    /// [`resize`](PtyResizer::resize) call simply returns `false`.
    ///
    /// [`resize`]: PtyResizer::resize
    pub fn resizer(&self) -> PtyResizer {
        PtyResizer {
            master: Arc::downgrade(&self.master),
            applied_size: Arc::clone(&self.applied_size),
            pid: self.pid,
        }
    }

    /// The currently applied (cols, rows).
    pub fn size(&self) -> (u16, u16) {
        *self.applied_size.lock().unwrap()
    }

    /// Blocks until the child exits and returns its exit code, derived via
    /// `portable-pty`'s `ExitStatus::exit_code()` (matching Bun's
    /// number-or-signal exit semantics).
    pub fn wait(&mut self) -> PtyResult<i32> {
        let status = self.child.wait().map_err(backend)?;
        Ok(status.exit_code() as i32)
    }

    /// Waits up to `timeout` for the child to exit, polling `try_wait`
    /// periodically. Returns `Ok(Some(code))` if the child exits in time, or
    /// `Ok(None)` if it is still running when the timeout elapses.
    ///
    /// Unlike [`wait`](Pty::wait), this never blocks indefinitely. It exists for
    /// callers that must stay responsive when a child may not self-terminate —
    /// notably on Windows, where a process attached to a headless ConPTY
    /// pseudoconsole (e.g. a CI runner) can produce all its output yet never
    /// reach its own `ExitProcess`, so a plain `wait` blocks until the master is
    /// torn down. On `Ok(None)` the caller can [`kill`](Pty::kill) the child and
    /// drop the PTY.
    pub fn wait_timeout(&mut self, timeout: Duration) -> PtyResult<Option<i32>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().map_err(backend)? {
                return Ok(Some(status.exit_code() as i32));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            std::thread::sleep((deadline - now).min(Duration::from_millis(20)));
        }
    }

    /// Kills the child process.
    pub fn kill(&mut self) -> PtyResult<()> {
        self.child.kill().map_err(backend)
    }
}

/// A cloneable resize handle for a [`Pty`], usable from any thread.
///
/// Holds a [`Weak`] reference to the master so it does not extend the PTY's
/// lifetime; [`resize`](PtyResizer::resize) returns `false` once the owning
/// [`Pty`] has been dropped.
#[derive(Clone)]
pub struct PtyResizer {
    master: Weak<Mutex<Box<dyn MasterPty + Send>>>,
    applied_size: AppliedSize,
    pid: Option<u32>,
}

impl PtyResizer {
    /// See [`Pty::resize`]. Returns `false` if the size was unchanged or if the
    /// owning [`Pty`] has already been dropped.
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        let Some(master) = self.master.upgrade() else {
            return false;
        };
        apply_resize(&master, &self.applied_size, self.pid, cols, rows)
    }

    /// The currently applied (cols, rows).
    pub fn size(&self) -> (u16, u16) {
        *self.applied_size.lock().unwrap()
    }
}

/// Shared resize implementation: clamp + de-dupe, apply `TIOCSWINSZ` via the
/// master, then signal descendants on Unix.
fn apply_resize(
    master: &SharedMaster,
    applied_size: &AppliedSize,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
) -> bool {
    let (cols, rows) = {
        let mut guard = applied_size.lock().unwrap();
        let (cols, rows, changed) = next_size(cols, rows, *guard);
        if !changed {
            return false;
        }
        *guard = (cols, rows);
        (cols, rows)
    };

    let _ = master.lock().unwrap().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });

    #[cfg(unix)]
    deliver_sigwinch(pid);
    #[cfg(not(unix))]
    let _ = pid;

    true
}

/// Delivers `SIGWINCH` to the direct child and every descendant so nested
/// foreground programs (a shell wrapping a grandchild TUI) re-read the size.
#[cfg(unix)]
fn deliver_sigwinch(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGWINCH);
    }
    for descendant in crate::descendants::descendant_pids(pid) {
        unsafe {
            libc::kill(descendant as libc::pid_t, libc::SIGWINCH);
        }
    }
}

/// Applies the environment to the command, replicating the `pty.ts` rules:
/// a provided env replaces the inherited one; `TERM` defaults to
/// `xterm-256color` when unset.
fn apply_env(cmd: &mut CommandBuilder, env: Option<&HashMap<String, String>>) {
    match env {
        Some(env) => {
            cmd.env_clear();
            for (key, value) in env {
                cmd.env(key, value);
            }
            if !env.contains_key("TERM") {
                cmd.env("TERM", "xterm-256color");
            }
        }
        None => {
            if std::env::var_os("TERM").is_none() {
                cmd.env("TERM", "xterm-256color");
            }
        }
    }
}

fn backend<E: std::fmt::Display>(e: E) -> PtyError {
    PtyError::Backend(e.to_string())
}
