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

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

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

    /// Consumes the PTY, splitting it into the exclusively-owned handles a
    /// single session adapter drives: the one cloned [`reader`], the one taken
    /// [`writer`], a [`Weak`] [`resizer`], the child [`waiter`] that owns the
    /// last strong master reference, and an independently cloned [`killer`].
    ///
    /// This is the idiomatic, move-based counterpart to cloning a reader,
    /// taking a writer, and sharing `&Pty`: after `into_parts` there is exactly
    /// one owner of each capability, so no `Arc<Mutex<Pty>>` is needed to drive
    /// the session.
    ///
    /// ## Ownership of the master (Windows load-bearing)
    /// The returned [`PtyWaiter`] owns the last strong reference to the PTY
    /// master; the [`PtyResizer`] holds only a [`Weak`], and the [`reader`],
    /// [`writer`], and [`killer`] hold none. Dropping the waiter (which its
    /// consuming [`wait`](PtyWaiter::wait) does immediately after the child
    /// exits) therefore closes the master — on Windows this closes the ConPTY
    /// pseudoconsole, so a cloned reader finally reaches EOF. The [`killer`] is
    /// cloned via [`ChildKiller::clone_killer`], so it can terminate the child
    /// from another thread while the waiter is blocked in `wait`, without a
    /// shared mutex.
    ///
    /// [`reader`]: PtyParts::reader
    /// [`writer`]: PtyParts::writer
    /// [`resizer`]: PtyParts::resizer
    /// [`waiter`]: PtyParts::waiter
    /// [`killer`]: PtyParts::killer
    /// [`wait`]: PtyWaiter::wait
    pub fn into_parts(self) -> PtyResult<PtyParts> {
        let Pty {
            master,
            child,
            applied_size,
            pid,
        } = self;

        // Obtain the single reader and writer once, up front.
        let reader = master.lock().unwrap().try_clone_reader().map_err(backend)?;
        let writer = master.lock().unwrap().take_writer().map_err(backend)?;

        // The resizer keeps only a `Weak` to the master, so it never extends the
        // pseudoconsole's lifetime.
        let resizer = PtyResizer {
            master: Arc::downgrade(&master),
            applied_size,
            pid,
        };

        // Clone an independent killer *before* moving the child into the waiter,
        // so kill and wait can run on separate threads without a shared mutex.
        let killer = PtyKiller {
            inner: child.clone_killer(),
        };

        // The waiter owns the child and the final strong master reference.
        let waiter = PtyWaiter { child, master };

        Ok(PtyParts {
            pid,
            reader,
            writer,
            resizer,
            waiter,
            killer,
        })
    }
}

/// The exclusively-owned handles produced by [`Pty::into_parts`].
///
/// One adapter owns the whole `PtyParts`; the split lets it drive input,
/// resize, wait, kill, and output on independent threads without wrapping the
/// PTY in a shared mutex. Every field is `Send`, so ownership can move onto a
/// blocking worker thread.
///
/// The [`waiter`](PtyParts::waiter) holds the last strong master reference; the
/// [`resizer`](PtyParts::resizer) holds a [`Weak`], and the
/// [`reader`](PtyParts::reader), [`writer`](PtyParts::writer), and
/// [`killer`](PtyParts::killer) hold none — see [`Pty::into_parts`].
pub struct PtyParts {
    /// The child process id, if known.
    pub pid: Option<u32>,
    /// The single blocking reader over the PTY's output. On Windows it only
    /// EOFs once the [`waiter`](PtyParts::waiter) drops the master.
    pub reader: Box<dyn Read + Send>,
    /// The single writer to the PTY's input.
    pub writer: Box<dyn Write + Send>,
    /// A cloneable [`Weak`] resize handle that never keeps the master alive.
    pub resizer: PtyResizer,
    /// Owns the child and the last strong master reference; its consuming
    /// [`wait`](PtyWaiter::wait) blocks for the exit code then drops the master.
    pub waiter: PtyWaiter,
    /// An independently cloned killer, usable concurrently with the waiter.
    pub killer: PtyKiller,
}

/// Owns a spawned child and the last strong reference to its PTY master.
///
/// [`wait`](PtyWaiter::wait) consumes the waiter: it blocks for the child's exit
/// code and then drops the master **before returning**, on both success and
/// failure. On Windows that master drop closes the ConPTY pseudoconsole, which
/// is the only thing that lets a previously cloned reader reach EOF; on Unix the
/// reader already EOFs from the slave drop at spawn, so the drop is a harmless
/// no-op there.
pub struct PtyWaiter {
    child: Box<dyn Child + Send + Sync>,
    master: SharedMaster,
}

impl PtyWaiter {
    /// The child process id, if known.
    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    /// Blocks until the child exits and returns its exit code, then releases the
    /// child and the last strong master reference.
    ///
    /// The master is dropped **before this returns**, on both the success and
    /// the error path, so a Windows ConPTY cloned reader can EOF as soon as the
    /// wait resolves regardless of outcome.
    pub fn wait(self) -> PtyResult<i32> {
        let PtyWaiter { mut child, master } = self;
        let outcome = child.wait();
        // Release the child and the final strong master reference now — before
        // returning and on both success and failure — so the pseudoconsole
        // closes and a cloned reader EOFs (Windows ConPTY; no-op on Unix).
        drop(child);
        drop(master);
        outcome
            .map(|status| status.exit_code() as i32)
            .map_err(backend)
    }
}

/// An independently cloned child killer obtained from [`Pty::into_parts`] via
/// [`ChildKiller::clone_killer`].
///
/// It holds no reference to the master, so killing never keeps the
/// pseudoconsole alive, and it can run on a different thread from the
/// [`PtyWaiter`] without a shared mutex.
pub struct PtyKiller {
    inner: Box<dyn ChildKiller + Send + Sync>,
}

impl PtyKiller {
    /// Terminates the child process.
    pub fn kill(&mut self) -> PtyResult<()> {
        self.inner.kill().map_err(backend)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// [`Pty::into_parts`] hands a single owner every handle it needs to drive
    /// the PTY, and each part is `Send` so one adapter task (or its scoped
    /// worker threads) can own them across threads. The ownership split is:
    ///
    /// - `reader`/`writer`: the one cloned reader and taken writer (independent
    ///   OS handles).
    /// - `resizer`: a `Weak` resize handle that never keeps the master alive.
    /// - `waiter`: owns the child *and* the last strong master; its consuming
    ///   `wait` drops that master, letting a Windows ConPTY cloned reader EOF.
    /// - `killer`: an independently cloned killer, so `wait` and `kill` run
    ///   concurrently without a shared mutex.
    #[test]
    fn into_parts_exposes_single_owner_handles() {
        fn assert_send<T: Send>() {}
        assert_send::<PtyParts>();
        assert_send::<PtyWaiter>();
        assert_send::<PtyKiller>();
    }
}
