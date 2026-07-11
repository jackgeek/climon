//! Server stub -> `climon-server.exe`. Resolves `climon-server-<ver>.exe` via
//! the pointer and launches it as a child, forwarding args + exit code. On
//! Windows it also installs a console control handler so Ctrl-C is handled by
//! the child (which shares the console) while the stub waits. Zero deps.

fn main() {
    std::process::exit(real_main());
}

#[cfg(windows)]
fn real_main() -> i32 {
    use climon_stub::pointer::{resolve_artifact, SERVER};

    win::ignore_ctrl_c();

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("climon-server: cannot resolve own path: {e}");
            return 1;
        }
    };
    let dir = match exe.parent() {
        Some(d) => d,
        None => {
            eprintln!("climon-server: cannot resolve install directory");
            return 1;
        }
    };
    let target = match resolve_artifact(dir, SERVER) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("climon-server: {e}");
            return 1;
        }
    };
    launch_child(&target)
}

#[cfg(not(windows))]
fn real_main() -> i32 {
    eprintln!("climon-server: the launcher stub is a Windows-only artifact");
    1
}

/// Spawns the resolved versioned server exe with our args (minus argv[0]),
/// inherits stdio/console, waits, and forwards the exit code.
#[cfg(windows)]
fn launch_child(target: &std::path::Path) -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = std::process::Command::new(target).args(&args).status();
    match status {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("climon-server: failed to launch {}: {e}", target.display());
            1
        }
    }
}

#[cfg(windows)]
mod win {
    use std::os::raw::c_int;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<HandlerRoutine>, add: c_int) -> c_int;
    }

    type HandlerRoutine = extern "system" fn(ctrl_type: u32) -> c_int;

    // Returning TRUE (1) tells Windows we handled the event, so the stub does
    // not terminate; the child (sharing the console) receives and handles it.
    extern "system" fn handler(_ctrl_type: u32) -> c_int {
        1
    }

    pub fn ignore_ctrl_c() {
        unsafe {
            SetConsoleCtrlHandler(Some(handler), 1);
        }
    }
}
