use std::io::{self, Write};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeProbeBaseline {
    command: Vec<String>,
    platform: &'static str,
    before: PlatformSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeProbeResult {
    command: Vec<String>,
    platform: &'static str,
    before: PlatformSnapshot,
    after: PlatformSnapshot,
    functional_restored: Option<bool>,
    pendin_changed: Option<bool>,
    child_exit_code: i32,
    spawn_error: Option<String>,
}

#[cfg_attr(unix, allow(dead_code))]
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum PlatformSnapshot {
    Unix(UnixSnapshot),
    Windows(WindowsSnapshot),
    Unsupported { error: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnixSnapshot {
    stdin: UnixConsoleState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnixConsoleState {
    echo: Option<bool>,
    icanon: Option<bool>,
    isig: Option<bool>,
    iexten: Option<bool>,
    pendin: Option<bool>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSnapshot {
    input: WindowsConsoleState,
    output: WindowsConsoleState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsConsoleState {
    valid_handle: bool,
    mode: Option<u32>,
    echo_input: Option<bool>,
    line_input: Option<bool>,
    processed_input: Option<bool>,
    extended_flags: Option<bool>,
    vt_input: Option<bool>,
    processed_output: Option<bool>,
    wrap_at_eol: Option<bool>,
    vt_output: Option<bool>,
    error: Option<String>,
}

pub fn run(command: Vec<String>, stdout: &mut impl Write) -> io::Result<i32> {
    let before = snapshot_platform();
    emit_line(
        stdout,
        &format!(
            "DAR_MODE_BASELINE {}",
            serde_json::to_string(&ModeProbeBaseline {
                command: command.clone(),
                platform: platform_name(),
                before: before.clone(),
            })?
        ),
    )?;

    let (spawn_error, child_exit_code) = run_child(&command);
    let after = snapshot_platform();
    emit_line(
        stdout,
        &format!(
            "DAR_MODE_RESULT {}",
            serde_json::to_string(&ModeProbeResult {
                command,
                platform: platform_name(),
                functional_restored: functional_restored(&before, &after),
                pendin_changed: pendin_changed(&before, &after),
                before,
                after,
                child_exit_code,
                spawn_error,
            })?
        ),
    )?;
    Ok(child_exit_code)
}

fn emit_line(stdout: &mut impl Write, line: &str) -> io::Result<()> {
    stdout.write_all(line.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run_child(command: &[String]) -> (Option<String>, i32) {
    let mut child = Command::new(&command[0]);
    child
        .args(&command[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    match child.status() {
        Ok(status) => (None, status.code().unwrap_or(1)),
        Err(error) => (Some(format!("spawn failed: {error}")), 1),
    }
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        "unsupported"
    }
}

fn functional_restored(before: &PlatformSnapshot, after: &PlatformSnapshot) -> Option<bool> {
    match (before, after) {
        (PlatformSnapshot::Unix(before), PlatformSnapshot::Unix(after)) => [
            before.stdin.echo.zip(after.stdin.echo),
            before.stdin.icanon.zip(after.stdin.icanon),
            before.stdin.isig.zip(after.stdin.isig),
            before.stdin.iexten.zip(after.stdin.iexten),
        ]
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .map(|pairs| pairs.into_iter().all(|(left, right)| left == right)),
        (PlatformSnapshot::Windows(before), PlatformSnapshot::Windows(after)) => {
            let input_modes = before
                .input
                .mode
                .zip(after.input.mode)
                .map(|(left, right)| left == right);
            let output_modes = before
                .output
                .mode
                .zip(after.output.mode)
                .map(|(left, right)| left == right);
            input_modes
                .zip(output_modes)
                .map(|(left, right)| left && right)
        }
        _ => None,
    }
}

fn pendin_changed(before: &PlatformSnapshot, after: &PlatformSnapshot) -> Option<bool> {
    match (before, after) {
        (PlatformSnapshot::Unix(before), PlatformSnapshot::Unix(after)) => before
            .stdin
            .pendin
            .zip(after.stdin.pendin)
            .map(|(left, right)| left != right),
        _ => None,
    }
}

#[cfg(unix)]
fn snapshot_platform() -> PlatformSnapshot {
    PlatformSnapshot::Unix(UnixSnapshot {
        stdin: unix_state(),
    })
}

#[cfg(windows)]
fn snapshot_platform() -> PlatformSnapshot {
    PlatformSnapshot::Windows(WindowsSnapshot {
        input: windows_state(windows_sys::Win32::System::Console::STD_INPUT_HANDLE, true),
        output: windows_state(
            windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE,
            false,
        ),
    })
}

#[cfg(not(any(unix, windows)))]
fn snapshot_platform() -> PlatformSnapshot {
    PlatformSnapshot::Unsupported {
        error: "Unsupported platform".to_string(),
    }
}

#[cfg(unix)]
fn unix_state() -> UnixConsoleState {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    let stdin = std::io::stdin();
    let fd = stdin.as_raw_fd();
    let mut termios = MaybeUninit::<libc::termios>::uninit();
    let rc = unsafe { libc::tcgetattr(fd, termios.as_mut_ptr()) };
    if rc != 0 {
        return UnixConsoleState {
            echo: None,
            icanon: None,
            isig: None,
            iexten: None,
            pendin: None,
            error: Some(format!(
                "tcgetattr(stdin) failed: {}",
                io::Error::last_os_error()
            )),
        };
    }
    let termios = unsafe { termios.assume_init() };
    UnixConsoleState {
        echo: Some(flag_enabled(termios.c_lflag, libc::ECHO)),
        icanon: Some(flag_enabled(termios.c_lflag, libc::ICANON)),
        isig: Some(flag_enabled(termios.c_lflag, libc::ISIG)),
        iexten: Some(flag_enabled(termios.c_lflag, libc::IEXTEN)),
        pendin: pendin_mask().map(|mask| flag_enabled(termios.c_lflag, mask)),
        error: None,
    }
}

#[cfg(unix)]
fn flag_enabled(flags: libc::tcflag_t, mask: libc::tcflag_t) -> bool {
    flags & mask != 0
}

#[cfg(unix)]
fn pendin_mask() -> Option<libc::tcflag_t> {
    #[cfg(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "android",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        Some(libc::PENDIN)
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "android",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_state(handle_id: u32, input: bool) -> WindowsConsoleState {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT,
        ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WRAP_AT_EOL_OUTPUT,
    };

    unsafe {
        let handle = GetStdHandle(handle_id);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return WindowsConsoleState {
                valid_handle: false,
                mode: None,
                echo_input: None,
                line_input: None,
                processed_input: None,
                extended_flags: None,
                vt_input: None,
                processed_output: None,
                wrap_at_eol: None,
                vt_output: None,
                error: Some("GetStdHandle returned an invalid handle".to_string()),
            };
        }
        let mut mode = 0;
        if GetConsoleMode(handle, &mut mode) == 0 {
            return WindowsConsoleState {
                valid_handle: true,
                mode: None,
                echo_input: None,
                line_input: None,
                processed_input: None,
                extended_flags: None,
                vt_input: None,
                processed_output: None,
                wrap_at_eol: None,
                vt_output: None,
                error: Some(format!(
                    "GetConsoleMode failed: {}",
                    io::Error::last_os_error()
                )),
            };
        }

        WindowsConsoleState {
            valid_handle: true,
            mode: Some(mode),
            echo_input: input.then_some(mode & ENABLE_ECHO_INPUT != 0),
            line_input: input.then_some(mode & ENABLE_LINE_INPUT != 0),
            processed_input: input.then_some(mode & ENABLE_PROCESSED_INPUT != 0),
            extended_flags: input.then_some(mode & ENABLE_EXTENDED_FLAGS != 0),
            vt_input: input.then_some(mode & ENABLE_VIRTUAL_TERMINAL_INPUT != 0),
            processed_output: (!input).then_some(mode & ENABLE_PROCESSED_OUTPUT != 0),
            wrap_at_eol: (!input).then_some(mode & ENABLE_WRAP_AT_EOL_OUTPUT != 0),
            vt_output: (!input).then_some(mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0),
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        functional_restored, pendin_changed, PlatformSnapshot, UnixConsoleState, UnixSnapshot,
        WindowsConsoleState, WindowsSnapshot,
    };

    #[test]
    fn compares_unix_functional_flags_and_pendin_separately() {
        let before = PlatformSnapshot::Unix(UnixSnapshot {
            stdin: UnixConsoleState {
                echo: Some(true),
                icanon: Some(true),
                isig: Some(true),
                iexten: Some(true),
                pendin: Some(false),
                error: None,
            },
        });
        let after = PlatformSnapshot::Unix(UnixSnapshot {
            stdin: UnixConsoleState {
                echo: Some(true),
                icanon: Some(true),
                isig: Some(true),
                iexten: Some(true),
                pendin: Some(true),
                error: None,
            },
        });

        assert_eq!(functional_restored(&before, &after), Some(true));
        assert_eq!(pendin_changed(&before, &after), Some(true));
    }

    #[test]
    fn compares_windows_modes_when_available() {
        let before = PlatformSnapshot::Windows(WindowsSnapshot {
            input: WindowsConsoleState {
                valid_handle: true,
                mode: Some(1),
                echo_input: Some(false),
                line_input: Some(false),
                processed_input: Some(false),
                extended_flags: Some(false),
                vt_input: Some(true),
                processed_output: None,
                wrap_at_eol: None,
                vt_output: None,
                error: None,
            },
            output: WindowsConsoleState {
                valid_handle: true,
                mode: Some(2),
                echo_input: None,
                line_input: None,
                processed_input: None,
                extended_flags: None,
                vt_input: None,
                processed_output: Some(true),
                wrap_at_eol: Some(true),
                vt_output: Some(true),
                error: None,
            },
        });

        assert_eq!(functional_restored(&before, &before), Some(true));
    }
}
