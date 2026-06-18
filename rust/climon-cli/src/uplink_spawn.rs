//! Detached `__uplink` spawning. Ports `src/remote/uplink-spawn.ts` /
//! `ensureUplink`'s detached spawn. Spawns this binary with `__uplink` detached
//! from the launcher so it survives and pushes local sessions to the host.

use std::process::{Command, Stdio};

use crate::self_spawn::self_spawn_args;

/// Spawns a detached `climon __uplink`. Best-effort; errors are ignored so a
/// failed spawn never blocks the launcher. Mirrors `spawnUplinkDetached` /
/// the `ensureUplink` detached spawn.
pub fn spawn_uplink_detached() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let argv1 = std::env::args().nth(1);
    let args = self_spawn_args(&["__uplink".to_string()], argv1.as_deref());

    let mut cmd = Command::new(exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    let _ = cmd.spawn();
}
