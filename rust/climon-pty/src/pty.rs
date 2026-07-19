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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Uses the raw ConPTY backend for a detached session, avoiding the inherited
    /// cursor protocol that requires an attached terminal host.
    #[cfg(windows)]
    pub headless_conpty: bool,
}

impl PtyOptions {
    /// Configures a PTY for a session with no local terminal.
    #[cfg(windows)]
    pub fn for_headless_session(mut self) -> Self {
        self.headless_conpty = true;
        self
    }

    /// Configures a PTY for a session with no local terminal.
    #[cfg(not(windows))]
    pub fn for_headless_session(self) -> Self {
        self
    }
}

type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;
type AppliedSize = Arc<Mutex<(u16, u16)>>;

enum PtyBackend {
    Portable {
        master: SharedMaster,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    },
    #[cfg(windows)]
    HeadlessConpty {
        process: crate::headless_conpty::ProcessHandle,
    },
}

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
    backend: PtyBackend,
    writer_taken: AtomicBool,
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

        #[cfg(windows)]
        if options.headless_conpty {
            let (process, pid) = crate::headless_conpty::spawn(options, cols, rows)?;
            return Ok(Pty {
                backend: PtyBackend::HeadlessConpty { process },
                writer_taken: AtomicBool::new(false),
                applied_size: Arc::new(Mutex::new((cols, rows))),
                pid: Some(pid),
            });
        }

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
            backend: PtyBackend::Portable {
                master: Arc::new(Mutex::new(pair.master)),
                child,
            },
            writer_taken: AtomicBool::new(false),
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
        match &self.backend {
            PtyBackend::Portable { master, .. } => {
                master.lock().unwrap().try_clone_reader().map_err(backend)
            }
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => crate::headless_conpty::reader(process),
        }
    }

    /// Takes the PTY's writer. Each PTY yields a single writer; the caller
    /// typically wraps it in a mutex to share across threads.
    pub fn take_writer(&self) -> PtyResult<Box<dyn Write + Send>> {
        if self.writer_taken.swap(true, Ordering::AcqRel) {
            return Err(PtyError::WriterTaken);
        }
        let result = match &self.backend {
            PtyBackend::Portable { master, .. } => {
                master.lock().unwrap().take_writer().map_err(backend)
            }
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => crate::headless_conpty::writer(process),
        };
        if result.is_err() {
            self.writer_taken.store(false, Ordering::Release);
        }
        result
    }

    /// Applies a new terminal size. Clamps to `>= 1`, de-dupes against the last
    /// applied size, and on Unix delivers `SIGWINCH` to the child and every
    /// descendant so nested TUIs re-read the size. Returns whether the size
    /// changed (and was therefore applied).
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        apply_resize(&self.backend, &self.applied_size, self.pid, cols, rows)
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
        let backend = match &self.backend {
            PtyBackend::Portable { master, .. } => {
                PtyResizerBackend::Portable(Arc::downgrade(master))
            }
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => {
                PtyResizerBackend::HeadlessConpty(Arc::downgrade(process))
            }
        };
        PtyResizer {
            backend,
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
        match &mut self.backend {
            PtyBackend::Portable { child, .. } => {
                let status = child.wait().map_err(backend)?;
                Ok(status.exit_code() as i32)
            }
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => crate::headless_conpty::wait(process),
        }
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
            let exited = match &mut self.backend {
                PtyBackend::Portable { child, .. } => child
                    .try_wait()
                    .map_err(backend)?
                    .map(|status| status.exit_code() as i32),
                #[cfg(windows)]
                PtyBackend::HeadlessConpty { process } => {
                    crate::headless_conpty::try_wait(process)?
                }
            };
            if let Some(code) = exited {
                return Ok(Some(code));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            std::thread::sleep((deadline - now).min(Duration::from_millis(20)));
        }
    }

    /// Attempts to kill the child process through the original child handle.
    ///
    /// This is an authoritative kill *attempt*, not a guarantee: it can return an
    /// error (e.g. the platform kill call failed), so callers must handle `Err`
    /// rather than assume the child has terminated.
    pub fn kill(&mut self) -> PtyResult<()> {
        match &mut self.backend {
            PtyBackend::Portable { child, .. } => child.kill().map_err(backend),
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => crate::headless_conpty::kill(process),
        }
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
    /// [`writer`], and [`killer`] hold none. Releasing that master — either the
    /// early [`release_master`](PtyWaiter::release_master) or the consuming
    /// [`wait`](PtyWaiter::wait) that drops it before returning — closes the
    /// master; on Windows this closes the ConPTY pseudoconsole, so a cloned
    /// reader finally reaches EOF.
    ///
    /// ## Authoritative vs. best-effort termination
    /// Authoritative termination goes through the [`waiter`]'s
    /// [`kill`](PtyWaiter::kill), which uses the **original** child handle
    /// (Unix escalation to `SIGKILL`; Windows success reported as `Ok`). That is
    /// the strongest kill *attempt* available — but still an attempt, not a
    /// guarantee: it can return an error, so callers must handle `Err`. The
    /// separately cloned [`killer`] is weaker still: a best-effort independent
    /// signaller (Unix `SIGHUP`-only; Windows misreports a successful
    /// `TerminateProcess` as an error) usable from another thread without a
    /// shared mutex. Production callers that need to drive the child toward exit
    /// use [`PtyWaiter::kill`] and handle a failed attempt (e.g. retry).
    ///
    /// [`reader`]: PtyParts::reader
    /// [`writer`]: PtyParts::writer
    /// [`resizer`]: PtyParts::resizer
    /// [`waiter`]: PtyParts::waiter
    /// [`killer`]: PtyParts::killer
    /// [`wait`]: PtyWaiter::wait
    pub fn into_parts(self) -> PtyResult<PtyParts> {
        let Pty {
            backend: pty_backend,
            writer_taken,
            applied_size,
            pid,
        } = self;

        // Obtain the single reader and writer once, up front.
        if writer_taken.swap(true, Ordering::AcqRel) {
            return Err(PtyError::WriterTaken);
        }
        let (reader, writer, resizer, killer, waiter) = match pty_backend {
            PtyBackend::Portable { master, child } => {
                let reader = master.lock().unwrap().try_clone_reader().map_err(backend)?;
                let writer = master.lock().unwrap().take_writer().map_err(backend)?;
                let resizer = PtyResizer {
                    backend: PtyResizerBackend::Portable(Arc::downgrade(&master)),
                    applied_size: Arc::clone(&applied_size),
                    pid,
                };
                let killer = PtyKiller {
                    backend: PtyKillerBackend::Portable(child.clone_killer()),
                };
                let waiter = PtyWaiter {
                    backend: PtyWaiterBackend::Portable {
                        child,
                        master: Some(master),
                    },
                };
                (reader, writer, resizer, killer, waiter)
            }
            #[cfg(windows)]
            PtyBackend::HeadlessConpty { process } => {
                let reader = crate::headless_conpty::reader(&process)?;
                let writer = crate::headless_conpty::writer(&process)?;
                let resizer = PtyResizer {
                    backend: PtyResizerBackend::HeadlessConpty(Arc::downgrade(&process)),
                    applied_size: Arc::clone(&applied_size),
                    pid,
                };
                let killer = PtyKiller {
                    backend: PtyKillerBackend::HeadlessConpty(Arc::downgrade(&process)),
                };
                let waiter = PtyWaiter {
                    backend: PtyWaiterBackend::HeadlessConpty {
                        process: Some(process),
                    },
                };
                (reader, writer, resizer, killer, waiter)
            }
        };

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
    /// Owns the child and the last strong master reference; the authoritative
    /// child-control handle. Exposes non-blocking
    /// [`try_wait`](PtyWaiter::try_wait)/[`kill`](PtyWaiter::kill)/[`release_master`](PtyWaiter::release_master)
    /// for a responsive control loop, plus the consuming
    /// [`wait`](PtyWaiter::wait) that blocks for the exit code then drops the
    /// master.
    pub waiter: PtyWaiter,
    /// A best-effort, independently cloned signaller — **not** authoritative
    /// termination (Unix `SIGHUP`-only, no escalation; Windows misreports a
    /// successful `TerminateProcess`). Drive authoritative termination through
    /// [`PtyWaiter::kill`] (the strongest kill *attempt*, which can still fail);
    /// this handle is for advisory out-of-band signalling.
    pub killer: PtyKiller,
}

/// Owns a spawned child and the last strong reference to its PTY master.
///
/// This is the authoritative child-control handle. The portable backend drives
/// the original `portable-pty` [`Child`]/[`ChildKiller`], while the headless
/// Windows backend drives its owned raw-ConPTY process. That is deliberately
/// stronger than the best-effort [`PtyKiller`].
///
/// It exposes both a non-blocking control surface — [`try_wait`](PtyWaiter::try_wait),
/// [`kill`](PtyWaiter::kill), and [`release_master`](PtyWaiter::release_master) —
/// for an owned child-control loop that must stay responsive, and the original
/// consuming [`wait`](PtyWaiter::wait) for callers that can block for the exit
/// code.
///
/// [`wait`](PtyWaiter::wait) consumes the waiter: it blocks for the child's exit
/// code and then drops the master **before returning**, on both success and
/// failure. On Windows that master drop closes the ConPTY pseudoconsole, which
/// is the only thing that lets a previously cloned reader reach EOF; on Unix the
/// reader already EOFs when the child exits, so the drop is a harmless no-op
/// there. [`release_master`](PtyWaiter::release_master) performs that same master
/// drop early, without consuming the waiter, so a responsive control loop can
/// unblock a Windows reader while it keeps polling or killing the child.
///
/// [`Child`]: portable_pty::Child
/// [`ChildKiller`]: portable_pty::ChildKiller
pub struct PtyWaiter {
    backend: PtyWaiterBackend,
}

enum PtyWaiterBackend {
    Portable {
        child: Box<dyn Child + Send + Sync>,
        master: Option<SharedMaster>,
    },
    #[cfg(windows)]
    HeadlessConpty {
        process: Option<crate::headless_conpty::ProcessHandle>,
    },
}

impl PtyWaiter {
    /// The child process id, if known.
    pub fn pid(&self) -> Option<u32> {
        match &self.backend {
            PtyWaiterBackend::Portable { child, .. } => child.process_id(),
            #[cfg(windows)]
            PtyWaiterBackend::HeadlessConpty { process } => {
                process.as_ref().map(crate::headless_conpty::pid)
            }
        }
    }

    /// Polls the child without blocking, via the original [`Child::try_wait`].
    /// Returns `Ok(Some(code))` once it has exited, `Ok(None)` while it is still
    /// running, or `Err` if the wait itself failed.
    ///
    /// This is the responsive counterpart to [`wait`](PtyWaiter::wait) for an
    /// owned control loop that must also service kill requests and reader
    /// outcomes rather than block indefinitely in a single `wait`.
    ///
    /// [`Child::try_wait`]: portable_pty::Child::try_wait
    pub fn try_wait(&mut self) -> PtyResult<Option<i32>> {
        match &mut self.backend {
            PtyWaiterBackend::Portable { child, .. } => Ok(child
                .try_wait()
                .map_err(backend)?
                .map(|status| status.exit_code() as i32)),
            #[cfg(windows)]
            PtyWaiterBackend::HeadlessConpty { process } => match process {
                Some(process) => crate::headless_conpty::try_wait(process),
                None => Ok(None),
            },
        }
    }

    /// Attempts to terminate the child through the **original** child handle
    /// ([`ChildKiller::kill`] on the spawned [`Child`]), preserving
    /// [`Pty::kill`]'s semantics: on Unix a `SIGHUP` with a grace period and
    /// escalation to `SIGKILL`; on Windows a `TerminateProcess` reported as `Ok`.
    ///
    /// This is the authoritative kill *attempt* — the strongest available, and
    /// intentionally stronger than the cloned [`PtyKiller`] (which only sends
    /// `SIGHUP` on Unix, without escalation, and misreports a successful
    /// `TerminateProcess` as an error on Windows). It is **not** an unconditional
    /// guarantee: it can return `Err` if the underlying kill fails, so a caller
    /// that needs the child reaped must handle the error (e.g. retry, or keep
    /// owning and polling the child) rather than assume termination.
    ///
    /// [`ChildKiller::kill`]: portable_pty::ChildKiller::kill
    /// [`Child`]: portable_pty::Child
    pub fn kill(&mut self) -> PtyResult<()> {
        match &mut self.backend {
            PtyWaiterBackend::Portable { child, .. } => child.kill().map_err(backend),
            #[cfg(windows)]
            PtyWaiterBackend::HeadlessConpty { process } => match process {
                Some(process) => crate::headless_conpty::kill(process),
                None => Ok(()),
            },
        }
    }

    /// Releases the last strong master reference early — the same drop that the
    /// consuming [`wait`](PtyWaiter::wait) performs before returning — without
    /// consuming the waiter, so the child handle is retained for further
    /// [`try_wait`](PtyWaiter::try_wait)/[`kill`](PtyWaiter::kill) calls.
    ///
    /// On Windows this closes the ConPTY pseudoconsole so a previously cloned
    /// reader can reach EOF; on Unix it is a harmless no-op for the reader.
    /// Idempotent: dropping the master a second time does nothing.
    pub fn release_master(&mut self) {
        match &mut self.backend {
            PtyWaiterBackend::Portable { master, .. } => *master = None,
            #[cfg(windows)]
            PtyWaiterBackend::HeadlessConpty { process } => *process = None,
        }
    }

    /// Blocks until the child exits and returns its exit code, then releases the
    /// child and the last strong master reference.
    ///
    /// The master is dropped **before this returns**, on both the success and
    /// the error path, so a Windows ConPTY cloned reader can EOF as soon as the
    /// wait resolves regardless of outcome. If [`release_master`](PtyWaiter::release_master)
    /// already ran, the drop here is a no-op.
    pub fn wait(self) -> PtyResult<i32> {
        match self.backend {
            PtyWaiterBackend::Portable { mut child, master } => {
                let outcome = child.wait();
                drop(child);
                drop(master);
                outcome
                    .map(|status| status.exit_code() as i32)
                    .map_err(backend)
            }
            #[cfg(windows)]
            PtyWaiterBackend::HeadlessConpty { process } => match process {
                Some(process) => {
                    let outcome = crate::headless_conpty::wait(&process);
                    drop(process);
                    outcome
                }
                None => Err(PtyError::Backend("pty master already released".to_string())),
            },
        }
    }
}

/// An independent best-effort child killer obtained from [`Pty::into_parts`].
///
/// It is weaker than the authoritative [`PtyWaiter::kill`] and is only for
/// advisory, out-of-band signalling that can run on a different thread from the
/// waiter. Drive authoritative termination through [`PtyWaiter::kill`].
pub struct PtyKiller {
    backend: PtyKillerBackend,
}

enum PtyKillerBackend {
    Portable(Box<dyn ChildKiller + Send + Sync>),
    #[cfg(windows)]
    HeadlessConpty(Weak<crate::headless_conpty::HeadlessConpty>),
}

impl PtyKiller {
    /// Best-effort signal to terminate the child (see the type-level note on the
    /// platform caveats). For the strongest available kill attempt use
    /// [`PtyWaiter::kill`]; neither is an unconditional guarantee.
    pub fn kill(&mut self) -> PtyResult<()> {
        match &mut self.backend {
            PtyKillerBackend::Portable(killer) => killer.kill().map_err(backend),
            #[cfg(windows)]
            PtyKillerBackend::HeadlessConpty(process) => match process.upgrade() {
                Some(process) => crate::headless_conpty::kill(&process),
                None => Ok(()),
            },
        }
    }
}

/// A cloneable resize handle for a [`Pty`], usable from any thread.
///
/// Holds a [`Weak`] reference to the master so it does not extend the PTY's
/// lifetime; [`resize`](PtyResizer::resize) returns `false` once the owning
/// [`Pty`] has been dropped.
#[derive(Clone)]
pub struct PtyResizer {
    backend: PtyResizerBackend,
    applied_size: AppliedSize,
    pid: Option<u32>,
}

#[derive(Clone)]
enum PtyResizerBackend {
    Portable(Weak<Mutex<Box<dyn MasterPty + Send>>>),
    #[cfg(windows)]
    HeadlessConpty(Weak<crate::headless_conpty::HeadlessConpty>),
}

impl PtyResizer {
    /// See [`Pty::resize`]. Returns `false` if the size was unchanged or if the
    /// owning [`Pty`] has already been dropped.
    pub fn resize(&self, cols: u16, rows: u16) -> bool {
        match &self.backend {
            PtyResizerBackend::Portable(master) => match master.upgrade() {
                Some(master) => apply_resizer_resize(
                    PtyResizerTarget::Portable(master),
                    &self.applied_size,
                    self.pid,
                    cols,
                    rows,
                ),
                None => false,
            },
            #[cfg(windows)]
            PtyResizerBackend::HeadlessConpty(process) => match process.upgrade() {
                Some(process) => apply_resizer_resize(
                    PtyResizerTarget::HeadlessConpty(process),
                    &self.applied_size,
                    self.pid,
                    cols,
                    rows,
                ),
                None => false,
            },
        }
    }

    /// The currently applied (cols, rows).
    pub fn size(&self) -> (u16, u16) {
        *self.applied_size.lock().unwrap()
    }
}

/// Shared resize implementation: clamp + de-dupe, apply `TIOCSWINSZ` via the
/// master, then signal descendants on Unix.
fn apply_resize(
    backend: &PtyBackend,
    applied_size: &AppliedSize,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
) -> bool {
    let target = match backend {
        PtyBackend::Portable { master, .. } => PtyResizerTarget::Portable(Arc::clone(master)),
        #[cfg(windows)]
        PtyBackend::HeadlessConpty { process } => {
            PtyResizerTarget::HeadlessConpty(Arc::clone(process))
        }
    };
    apply_resizer_resize(target, applied_size, pid, cols, rows)
}

enum PtyResizerTarget {
    Portable(SharedMaster),
    #[cfg(windows)]
    HeadlessConpty(crate::headless_conpty::ProcessHandle),
}

fn apply_resizer_resize(
    target: PtyResizerTarget,
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

    match target {
        PtyResizerTarget::Portable(master) => {
            let _ = master.lock().unwrap().resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        #[cfg(windows)]
        PtyResizerTarget::HeadlessConpty(process) => {
            crate::headless_conpty::resize(&process, cols, rows);
        }
    }

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

    #[cfg(windows)]
    #[test]
    fn raw_conpty_wait_does_not_block_concurrent_resize_or_kill() {
        use std::sync::mpsc;
        use std::time::Duration;

        let options = PtyOptions {
            command: "cmd".to_string(),
            args: vec![
                "/c".to_string(),
                "echo CLIMON-RAW-CONPTY-LIVE & pause >NUL".to_string(),
            ],
            cwd: std::env::current_dir().expect("cwd"),
            cols: 80,
            rows: 24,
            env: None,
            headless_conpty: false,
        };
        let PtyParts {
            pid,
            reader,
            writer,
            resizer,
            waiter,
            mut killer,
        } = Pty::spawn(&options.for_headless_session())
            .expect("spawn raw ConPTY")
            .into_parts()
            .expect("split raw ConPTY");

        let (output_ready_tx, output_ready_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = reader;
            let mut output = Vec::new();
            let mut buf = [0u8; 1024];
            let mut reported_ready = false;
            while let Ok(read) = reader.read(&mut buf) {
                if read == 0 {
                    break;
                }
                output.extend_from_slice(&buf[..read]);
                if !reported_ready
                    && String::from_utf8_lossy(&output).contains("CLIMON-RAW-CONPTY-LIVE")
                {
                    let _ = output_ready_tx.send(());
                    reported_ready = true;
                }
            }
            output
        });
        output_ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the raw ConPTY child must write before concurrent operations");

        let wait_entered = crate::headless_conpty::wait_entry_receiver();
        let waiter = std::thread::spawn(move || waiter.wait());
        wait_entered
            .recv_timeout(Duration::from_secs(2))
            .expect("waiter must enter the live raw-ConPTY wait");

        let (resize_done_tx, resize_done_rx) = mpsc::channel();
        let resize = std::thread::spawn(move || {
            let _ = resizer.resize(100, 40);
            let _ = resize_done_tx.send(());
        });
        let (kill_done_tx, kill_done_rx) = mpsc::channel();
        let kill = std::thread::spawn(move || {
            let _ = killer.kill();
            let _ = kill_done_tx.send(());
        });

        let resize_completed = resize_done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let kill_completed = kill_done_rx.recv_timeout(Duration::from_secs(2)).is_ok();

        if !resize_completed || !kill_completed {
            let pid = pid.expect("raw ConPTY pid");
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }
        drop(writer);
        let _ = waiter.join().expect("waiter joins after test cleanup");
        resize.join().expect("resizer joins after test cleanup");
        kill.join().expect("killer joins after test cleanup");
        let output = reader.join().expect("reader joins after test cleanup");

        assert!(
            String::from_utf8_lossy(&output).contains("CLIMON-RAW-CONPTY-LIVE"),
            "the raw ConPTY child must be live before the concurrent operations"
        );
        assert!(
            resize_completed,
            "resize must not block behind a live raw-ConPTY waiter"
        );
        assert!(
            kill_completed,
            "kill must not block behind a live raw-ConPTY waiter"
        );
    }

    #[cfg(windows)]
    #[test]
    fn raw_conpty_with_no_environment_inherits_parent_environment() {
        let inherited_key = "CLIMON_RAW_CONPTY_INHERITANCE_TEST";
        let inherited_value = "dar-02-parent-environment";
        let old_inherited = std::env::var_os(inherited_key);
        let old_term = std::env::var_os("TERM");
        std::env::set_var(inherited_key, inherited_value);
        std::env::remove_var("TERM");

        let options = PtyOptions {
            command: "cmd".to_string(),
            args: vec!["/c".to_string(), format!("echo %{inherited_key}%")],
            cwd: std::env::current_dir().expect("cwd"),
            cols: 80,
            rows: 24,
            env: None,
            headless_conpty: false,
        };
        let mut pty = Pty::spawn(&options.for_headless_session()).expect("spawn raw ConPTY");
        let mut reader = pty.try_clone_reader().expect("reader");

        if let Some(value) = old_term {
            std::env::set_var("TERM", value);
        } else {
            std::env::remove_var("TERM");
        }
        if let Some(value) = old_inherited {
            std::env::set_var(inherited_key, value);
        } else {
            std::env::remove_var(inherited_key);
        }

        let exit = pty
            .wait_timeout(Duration::from_secs(2))
            .expect("wait for environment probe");
        if exit.is_none() {
            pty.kill().expect("kill wedged environment probe");
        }
        drop(pty);

        let mut output = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => output.extend_from_slice(&buffer[..read]),
            }
        }
        assert_eq!(exit, Some(0), "environment probe must exit");
        assert!(
            String::from_utf8_lossy(&output).contains(inherited_value),
            "env: None must inherit the parent environment; output: {:?}",
            String::from_utf8_lossy(&output)
        );
    }
}
