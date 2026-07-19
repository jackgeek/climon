use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

use crate::error::{PtyError, PtyResult};
use crate::pty::PtyOptions;

pub(super) type ProcessHandle = Arc<HeadlessConpty>;

/// Owns the raw ConPTY plus a separately opened handle to its child process.
///
/// `conpty::Process` exposes `wait` with `&self`, but its resize/kill APIs take
/// `&mut self`, so the former implementation put every operation behind one
/// mutex. A blocking wait then prevented a dashboard resize or kill from ever
/// acquiring that mutex. The duplicated child handle gives wait and termination
/// independent Win32 handles while the mutex remains limited to the ConPTY
/// operations that truly require exclusive mutable access.
pub(super) struct HeadlessConpty {
    console: Mutex<conpty::Process>,
    child: ChildHandle,
    pid: u32,
}

struct ChildHandle(isize);

impl ChildHandle {
    fn open(pid: u32) -> PtyResult<Self> {
        // SAFETY: `pid` belongs to the process returned by `conpty`; this handle
        // is closed exactly once by `Drop`.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(win32_error("open raw ConPTY child process"));
        }
        Ok(Self(handle as isize))
    }
}

impl Drop for ChildHandle {
    fn drop(&mut self) {
        // SAFETY: `ChildHandle::open` only constructs instances from a successful
        // `OpenProcess` result, and this is its unique owner.
        unsafe {
            let _ = CloseHandle(self.0 as HANDLE);
        }
    }
}

#[cfg(test)]
static WAIT_ENTERED: std::sync::OnceLock<Mutex<Option<std::sync::mpsc::Sender<()>>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
pub(super) fn wait_entry_receiver() -> std::sync::mpsc::Receiver<()> {
    let (sender, receiver) = std::sync::mpsc::channel();
    *WAIT_ENTERED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(sender);
    receiver
}

#[cfg(test)]
fn notify_wait_entered() {
    if let Some(sender) = WAIT_ENTERED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .take()
    {
        let _ = sender.send(());
    }
}

pub(super) fn spawn(options: &PtyOptions, cols: u16, rows: u16) -> PtyResult<(ProcessHandle, u32)> {
    // `conpty` builds CreateProcessW's command line from these strings without
    // quoting. Preserve the vector semantics `portable-pty` provides for the
    // normal backend before handing the command to it.
    let mut command = std::process::Command::new(quote_windows_argument(&options.command));
    command.args(options.args.iter().map(|arg| quote_windows_argument(arg)));
    command.current_dir(PathBuf::from(&options.cwd));
    apply_env(&mut command, options.env.as_ref());

    let mut process_options = conpty::ProcessOptions::default();
    process_options.set_console_size(Some((
        cols.min(i16::MAX as u16) as i16,
        rows.min(i16::MAX as u16) as i16,
    )));
    let process = process_options
        .spawn(command)
        .map_err(|error| PtyError::Backend(error.to_string()))?;
    let pid = process.pid();
    let child = ChildHandle::open(pid)?;
    Ok((
        Arc::new(HeadlessConpty {
            console: Mutex::new(process),
            child,
            pid,
        }),
        pid,
    ))
}

pub(super) fn reader(process: &ProcessHandle) -> PtyResult<Box<dyn Read + Send>> {
    let mut console = process.console.lock().unwrap();
    console
        .output()
        .map(|reader| Box::new(reader) as Box<dyn Read + Send>)
        .map_err(|error| PtyError::Backend(error.to_string()))
}

pub(super) fn writer(process: &ProcessHandle) -> PtyResult<Box<dyn Write + Send>> {
    let mut console = process.console.lock().unwrap();
    console
        .input()
        .map(|writer| Box::new(writer) as Box<dyn Write + Send>)
        .map_err(|error| PtyError::Backend(error.to_string()))
}

pub(super) fn resize(process: &ProcessHandle, cols: u16, rows: u16) {
    let _ = process.console.lock().unwrap().resize(
        cols.min(i16::MAX as u16) as i16,
        rows.min(i16::MAX as u16) as i16,
    );
}

pub(super) fn try_wait(process: &ProcessHandle) -> PtyResult<Option<i32>> {
    wait_for_child(&process.child, 0)
}

pub(super) fn wait(process: &ProcessHandle) -> PtyResult<i32> {
    #[cfg(test)]
    notify_wait_entered();
    wait_for_child(&process.child, u32::MAX)?.ok_or_else(|| {
        PtyError::Backend("raw ConPTY child wait timed out unexpectedly".to_string())
    })
}

pub(super) fn kill(process: &ProcessHandle) -> PtyResult<()> {
    // SAFETY: `child` is a valid process handle retained by `HeadlessConpty`.
    if unsafe { TerminateProcess(process.child.0 as HANDLE, 1) } == 0 {
        return Err(win32_error("terminate raw ConPTY child process"));
    }
    Ok(())
}

fn apply_env(command: &mut std::process::Command, env: Option<&HashMap<String, String>>) {
    match env {
        Some(env) => {
            command.env_clear();
            command.envs(env);
            if !env.contains_key("TERM") {
                command.env("TERM", "xterm-256color");
            }
        }

        None => {
            // `conpty` serializes only `Command::get_envs()` into CreateProcessW's
            // environment block. Make the portable backend's inheritance contract
            // explicit before layering its TERM default.
            command.envs(std::env::vars_os());
            if std::env::var_os("TERM").is_none() {
                command.env("TERM", "xterm-256color");
            }
        }
    }
}

pub(super) fn pid(process: &ProcessHandle) -> u32 {
    process.pid
}

fn wait_for_child(child: &ChildHandle, timeout_ms: u32) -> PtyResult<Option<i32>> {
    // SAFETY: `child` owns a valid process handle until all raw-ConPTY owners
    // release it. Waiting on one process handle is independent of ConPTY I/O.
    match unsafe { WaitForSingleObject(child.0 as HANDLE, timeout_ms) } {
        WAIT_OBJECT_0 => exit_code(child).map(Some),
        WAIT_TIMEOUT => Ok(None),
        _ => Err(win32_error("wait for raw ConPTY child process")),
    }
}

fn exit_code(child: &ChildHandle) -> PtyResult<i32> {
    let mut code = 0;
    // SAFETY: `child` owns a valid process handle and `code` is writable.
    if unsafe { GetExitCodeProcess(child.0 as HANDLE, &mut code) } == 0 {
        return Err(win32_error("read raw ConPTY child exit code"));
    }
    Ok(code as i32)
}

fn win32_error(operation: &str) -> PtyError {
    PtyError::Backend(format!("{operation}: {}", std::io::Error::last_os_error()))
}

fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_string();
    }

    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::quote_windows_argument;

    #[test]
    fn quotes_windows_arguments_without_losing_backslashes_or_quotes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument("two words"), "\"two words\"");
        assert_eq!(quote_windows_argument(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(
            quote_windows_argument(r"C:\with space\\"),
            r#""C:\with space\\\\""#
        );
    }
}
