//! RAII guard that temporarily clears `HANDLE_FLAG_INHERIT` on the process's
//! stdout and stderr handles around a [`std::process::Command::spawn`] call on
//! Windows.
//!
//! # Problem
//!
//! Rust 1.81+ `Command::spawn` on Windows calls `CreateProcessW` with
//! `bInheritHandles = TRUE`. This means *every* inheritable handle in the
//! calling process is duplicated into the child — even when the child's own
//! stdout/stderr are redirected elsewhere (log file, `NUL`). If the parent's
//! stdout is an inheritable pipe write handle (the normal case when Node.js or
//! another launcher pipes the parent), a detached child holds that handle open,
//! preventing the pipe's read end from ever reaching EOF.
//!
//! # Solution
//!
//! Create a [`StdInheritGuard`] immediately before `cmd.spawn()`. The guard
//! clears `HANDLE_FLAG_INHERIT` on stdout and stderr, preventing the child
//! from inheriting those handles. On drop — including on spawn failure — the
//! guard restores each handle's exact prior inheritance bit.
//!
//! On non-Windows platforms, [`StdInheritGuard`] is a zero-sized no-op.
//!
//! # Concurrency
//!
//! `HANDLE_FLAG_INHERIT` is a process-global property. Without coordination,
//! two concurrent guards can interleave so that one restores `INHERIT` while
//! the other is mid-spawn, reproducing the handle-leak. To prevent this,
//! [`StdInheritGuard::new`] acquires a process-global [`std::sync::Mutex`]
//! before mutating any handle flags and holds it until drop. Flag restoration
//! therefore always completes before the next caller can proceed.

// ── Non-Windows stub ────────────────────────────────────────────────────────

#[cfg(not(windows))]
pub struct StdInheritGuard;

#[cfg(not(windows))]
impl StdInheritGuard {
    /// No-op on non-Windows platforms.
    #[inline]
    pub fn new() -> std::io::Result<Self> {
        Ok(Self)
    }
}

// ── Windows implementation ──────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::sync::{Mutex, MutexGuard};

    use windows_sys::Win32::Foundation::{
        GetHandleInformation, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};

    /// Serializes all [`StdInheritGuard`] lifetimes process-wide.
    ///
    /// Held from the moment flags are cleared until they are fully restored,
    /// so no two guards can overlap and corrupt each other's prior-flag
    /// snapshots.
    static INHERIT_LOCK: Mutex<()> = Mutex::new(());

    /// Returns `true` when `h` is a usable Win32 handle.
    fn is_valid(h: HANDLE) -> bool {
        !h.is_null() && h != INVALID_HANDLE_VALUE
    }

    /// Reads the `HANDLE_FLAG_INHERIT` portion of `h`'s flags.
    fn get_inherit(h: HANDLE) -> std::io::Result<u32> {
        let mut flags: u32 = 0;
        if unsafe { GetHandleInformation(h, &mut flags) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(flags & HANDLE_FLAG_INHERIT)
    }

    /// Sets the `HANDLE_FLAG_INHERIT` portion of `h`'s flags.
    fn set_inherit(h: HANDLE, value: u32) -> std::io::Result<()> {
        if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, value) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// RAII guard — clears `HANDLE_FLAG_INHERIT` on stdout and stderr on
    /// construction, restores each handle's exact prior bit on drop.
    ///
    /// Holds a process-global mutex for its entire lifetime, so concurrent
    /// `new()` calls are serialized: no two guards can be alive simultaneously.
    /// The mutex is released only after flag restoration completes (field drop
    /// order: `stdout` → `stderr` → `_lock`; the explicit [`Drop`] impl
    /// restores flags while `_lock` is still live in the struct).
    pub struct StdInheritGuard {
        /// `(handle, prior_inherit_flag)` — `None` when the handle was
        /// null or `INVALID_HANDLE_VALUE`.
        stdout: Option<(HANDLE, u32)>,
        stderr: Option<(HANDLE, u32)>,
        /// Kept alive until after [`Drop`] restores the handle flags; dropped
        /// last, releasing [`INHERIT_LOCK`].
        _lock: MutexGuard<'static, ()>,
    }

    impl StdInheritGuard {
        /// Acquires the process-global lock, then clears `HANDLE_FLAG_INHERIT`
        /// on the process's stdout and stderr.
        ///
        /// Returns an error if the mutex is poisoned or if
        /// `GetHandleInformation` / `SetHandleInformation` fails on a valid
        /// handle. Null and `INVALID_HANDLE_VALUE` handles are silently
        /// skipped.
        pub fn new() -> std::io::Result<Self> {
            let lock = INHERIT_LOCK.lock().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::Other, "StdInheritGuard: mutex poisoned")
            })?;
            let stdout = Self::clear_one(STD_OUTPUT_HANDLE)?;
            let stderr = match Self::clear_one(STD_ERROR_HANDLE) {
                Ok(s) => s,
                Err(e) => {
                    // Restore stdout before propagating the stderr error.
                    // `lock` is dropped at the end of this branch, releasing
                    // the mutex after restoration.
                    if let Some((h, prior)) = stdout {
                        if prior != 0 {
                            let _ = set_inherit(h, prior);
                        }
                    }
                    return Err(e);
                }
            };
            Ok(Self {
                stdout,
                stderr,
                _lock: lock,
            })
        }

        /// Snapshots and clears the inherit flag for one standard handle.
        fn clear_one(std_id: u32) -> std::io::Result<Option<(HANDLE, u32)>> {
            let h = unsafe { GetStdHandle(std_id) };
            if !is_valid(h) {
                return Ok(None);
            }
            let prior = get_inherit(h)?;
            if prior != 0 {
                set_inherit(h, 0)?;
            }
            Ok(Some((h, prior)))
        }
    }

    impl Drop for StdInheritGuard {
        fn drop(&mut self) {
            // Restore in reverse order of clearing.
            // `_lock` (the MutexGuard) is still live here and will be dropped
            // after this method returns, so the mutex remains held throughout
            // flag restoration.
            if let Some((h, prior)) = self.stderr {
                if prior != 0 {
                    let _ = set_inherit(h, prior);
                }
            }
            if let Some((h, prior)) = self.stdout {
                if prior != 0 {
                    let _ = set_inherit(h, prior);
                }
            }
        }
    }
}

#[cfg(windows)]
pub use imp::StdInheritGuard;

// ── Tests (Windows-only) ────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::StdInheritGuard;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        GetHandleInformation, SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};

    /// Unit test: the guard clears `HANDLE_FLAG_INHERIT` during its lifetime
    /// and restores the exact prior value on drop.
    #[test]
    fn guard_clears_and_restores_inherit_flag() {
        let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if stdout.is_null() || stdout == INVALID_HANDLE_VALUE {
            return; // cannot test without a valid stdout
        }

        // Save original flag so we restore it even if the test panics.
        let mut orig: u32 = 0;
        assert_ne!(unsafe { GetHandleInformation(stdout, &mut orig) }, 0);
        let orig_inherit = orig & HANDLE_FLAG_INHERIT;

        // Force the handle to inheritable for the test.
        assert_ne!(
            unsafe { SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) },
            0,
        );

        {
            let _guard = StdInheritGuard::new().expect("guard creation should succeed");

            let mut flags: u32 = 0;
            assert_ne!(unsafe { GetHandleInformation(stdout, &mut flags) }, 0);
            assert_eq!(
                flags & HANDLE_FLAG_INHERIT,
                0,
                "guard should clear HANDLE_FLAG_INHERIT during its lifetime"
            );
        }

        // After the guard drops, the inheritable flag must be restored.
        let mut flags: u32 = 0;
        assert_ne!(unsafe { GetHandleInformation(stdout, &mut flags) }, 0);
        assert_ne!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "guard should restore HANDLE_FLAG_INHERIT on drop"
        );

        // Restore original state.
        unsafe { SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, orig_inherit) };
    }

    /// Symmetrical test for stderr.
    #[test]
    fn guard_clears_and_restores_stderr_inherit_flag() {
        let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        if stderr.is_null() || stderr == INVALID_HANDLE_VALUE {
            return;
        }

        let mut orig: u32 = 0;
        assert_ne!(unsafe { GetHandleInformation(stderr, &mut orig) }, 0);
        let orig_inherit = orig & HANDLE_FLAG_INHERIT;

        assert_ne!(
            unsafe { SetHandleInformation(stderr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) },
            0,
        );

        {
            let _guard = StdInheritGuard::new().expect("guard creation should succeed");

            let mut flags: u32 = 0;
            assert_ne!(unsafe { GetHandleInformation(stderr, &mut flags) }, 0);
            assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        }

        let mut flags: u32 = 0;
        assert_ne!(unsafe { GetHandleInformation(stderr, &mut flags) }, 0);
        assert_ne!(flags & HANDLE_FLAG_INHERIT, 0);

        unsafe { SetHandleInformation(stderr, HANDLE_FLAG_INHERIT, orig_inherit) };
    }

    /// Integration test: spawning a detached child while the guard is active
    /// must not leak the parent's pipe write handle to the child.
    ///
    /// Three roles (selected by `__CLIMON_TEST_INHERIT_ROLE`):
    ///
    /// 1. **Test runner** — spawns the *launcher* with piped stdout, asserts
    ///    EOF arrives within 5 s.
    /// 2. **Launcher** — creates the guard, spawns a detached *sleeper*,
    ///    writes a marker to stdout, then exits.
    /// 3. **Sleeper** — `ping -n 11 127.0.0.1` (≈10 s), holding any leaked
    ///    handles.
    ///
    /// Without the guard, the sleeper inherits the launcher's stdout pipe
    /// write handle, so EOF cannot arrive until the sleeper exits (~10 s).
    /// With the guard, EOF arrives in <1 s.
    #[test]
    fn detached_child_does_not_leak_stdout_pipe() {
        use std::os::windows::process::CommandExt;

        const ROLE_VAR: &str = "__CLIMON_TEST_INHERIT_ROLE";

        if std::env::var(ROLE_VAR).as_deref() == Ok("launcher") {
            // ── Launcher mode ───────────────────────────────────────────
            let mut cmd = Command::new("ping.exe");
            cmd.args(["-n", "11", "127.0.0.1"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);

            let _guard = StdInheritGuard::new().unwrap();
            let _ = cmd.spawn();
            // Guard drops here, restoring inherit flags.

            println!("ok");
            return;
        }

        // ── Test runner ─────────────────────────────────────────────────
        let exe = std::env::current_exe().unwrap();
        let mut launcher = Command::new(&exe)
            .args([
                "--exact",
                "win_inherit_guard::tests::detached_child_does_not_leak_stdout_pipe",
                "--nocapture",
            ])
            .env(ROLE_VAR, "launcher")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn launcher");

        let start = Instant::now();
        let mut stdout = launcher.stdout.take().unwrap();
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).unwrap();
        let elapsed = start.elapsed();

        let _ = launcher.wait();

        assert!(
            elapsed < Duration::from_secs(5),
            "EOF took {elapsed:?}; the detached child likely inherited the stdout pipe handle"
        );
        assert!(
            !buf.is_empty(),
            "launcher should have written a marker to stdout"
        );
    }

    /// Regression: concurrent [`StdInheritGuard`]s must not interleave Win32
    /// flag mutations. Two threads race over 200 iterations each; while each
    /// guard is held `HANDLE_FLAG_INHERIT` must always be cleared.
    ///
    /// Without the process-global mutex, the following interleaving corrupts
    /// the flag:
    ///
    /// 1. Thread A: reads `prior = 1`, clears → 0
    /// 2. Thread B: reads `prior = 0` (A's cleared state) — prior recorded as 0
    /// 3. Thread A: drops guard, restores → 1   ← restore races with B's spawn
    /// 4. Thread B: checks flag while "holding guard" → sees 1  **BUG**
    ///
    /// With the mutex, Thread B cannot enter until Thread A has restored *and*
    /// released the lock, so B always reads the correct pre-clear state.
    ///
    /// Uses a [`std::sync::Barrier`] to synchronize thread starts; no sleeps.
    #[test]
    fn concurrent_guards_serialize_flag_mutations() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Barrier,
        };

        let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if stdout.is_null() || stdout == INVALID_HANDLE_VALUE {
            return;
        }

        // Save current state and force INHERIT on so the guard always mutates.
        let mut orig: u32 = 0;
        assert_ne!(unsafe { GetHandleInformation(stdout, &mut orig) }, 0);
        assert_ne!(
            unsafe { SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) },
            0,
        );

        const ITERS: usize = 200;
        let barrier = Arc::new(Barrier::new(2));
        let saw_inherit_while_guarded = Arc::new(AtomicBool::new(false));

        let b2 = Arc::clone(&barrier);
        let flag = Arc::clone(&saw_inherit_while_guarded);
        let t = std::thread::spawn(move || {
            b2.wait(); // race both threads from the same starting line
            for _ in 0..ITERS {
                let _g = StdInheritGuard::new().unwrap();
                // While the guard is held, HANDLE_FLAG_INHERIT must be 0.
                let mut f: u32 = 0;
                let h = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
                if unsafe { GetHandleInformation(h, &mut f) } != 0 && f & HANDLE_FLAG_INHERIT != 0 {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        });

        barrier.wait();
        for _ in 0..ITERS {
            let _g = StdInheritGuard::new().unwrap();
            let mut f: u32 = 0;
            if unsafe { GetHandleInformation(stdout, &mut f) } != 0 && f & HANDLE_FLAG_INHERIT != 0
            {
                saw_inherit_while_guarded.store(true, Ordering::SeqCst);
            }
        }

        t.join().unwrap();

        // Restore original state regardless of test outcome.
        unsafe { SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, orig & HANDLE_FLAG_INHERIT) };

        assert!(
            !saw_inherit_while_guarded.load(Ordering::SeqCst),
            "HANDLE_FLAG_INHERIT was set while a StdInheritGuard was held; \
             concurrent guards interleaved flag mutations"
        );
    }
}
