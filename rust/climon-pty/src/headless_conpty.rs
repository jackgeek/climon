use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::error::{PtyError, PtyResult};
use crate::pty::PtyOptions;

pub(super) type ProcessHandle = Arc<Mutex<conpty::Process>>;

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
    Ok((Arc::new(Mutex::new(process)), pid))
}

pub(super) fn reader(process: &ProcessHandle) -> PtyResult<Box<dyn Read + Send>> {
    let mut process = process.lock().unwrap();
    process
        .output()
        .map(|reader| Box::new(reader) as Box<dyn Read + Send>)
        .map_err(|error| PtyError::Backend(error.to_string()))
}

pub(super) fn writer(process: &ProcessHandle) -> PtyResult<Box<dyn Write + Send>> {
    let mut process = process.lock().unwrap();
    process
        .input()
        .map(|writer| Box::new(writer) as Box<dyn Write + Send>)
        .map_err(|error| PtyError::Backend(error.to_string()))
}

pub(super) fn resize(process: &ProcessHandle, cols: u16, rows: u16) {
    let _ = process.lock().unwrap().resize(
        cols.min(i16::MAX as u16) as i16,
        rows.min(i16::MAX as u16) as i16,
    );
}

pub(super) fn try_wait(process: &ProcessHandle) -> PtyResult<Option<i32>> {
    let process = process.lock().unwrap();
    match process.wait(Some(0)) {
        Ok(code) => Ok(Some(code as i32)),
        Err(conpty::error::Error::Timeout(_)) => Ok(None),
        Err(error) => Err(PtyError::Backend(error.to_string())),
    }
}

pub(super) fn wait(process: &ProcessHandle) -> PtyResult<i32> {
    process
        .lock()
        .unwrap()
        .wait(None)
        .map(|code| code as i32)
        .map_err(|error| PtyError::Backend(error.to_string()))
}

pub(super) fn kill(process: &ProcessHandle) -> PtyResult<()> {
    process
        .lock()
        .unwrap()
        .exit(1)
        .map_err(|error| PtyError::Backend(error.to_string()))
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

        None if std::env::var_os("TERM").is_none() => {
            command.env("TERM", "xterm-256color");
        }
        None => {}
    }
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
