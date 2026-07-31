use std::io::{self, BufReader, Read, Write};

use crate::mode_probe;
use crate::stream_protocol;
use crate::tui;

const STREAMING_COMMAND: &str = "streaming";
const INTERACTIVE_TUI_COMMAND: &str = "interactive-tui";
const MODE_PROBE_COMMAND: &str = "mode-probe";
const APPROVED_COMMANDS: &str =
    "Expected one of: streaming, interactive-tui, mode-probe -- <executable> [args...]";

#[derive(Debug, PartialEq, Eq)]
pub enum CliError {
    Usage(String),
    Io(String),
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) => 2,
            Self::Io(_) => 1,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Usage(message) | Self::Io(message) => message,
        }
    }
}

pub fn run<I, R, W, E>(args: I, stdin: R, stdout: &mut W, stderr: &mut E) -> Result<i32, CliError>
where
    I: IntoIterator<Item = String>,
    R: Read,
    W: Write,
    E: Write,
{
    let collected: Vec<String> = args.into_iter().collect();
    let Some(command) = collected.get(1).map(String::as_str) else {
        return Err(CliError::Usage(APPROVED_COMMANDS.to_string()));
    };

    match command {
        STREAMING_COMMAND => stream_protocol::run(&mut BufReader::new(stdin), stdout, stderr),
        INTERACTIVE_TUI_COMMAND => {
            tui::run(BufReader::new(stdin), stdout).map_err(|error| CliError::Io(error.to_string()))
        }
        MODE_PROBE_COMMAND => {
            let executable = parse_mode_probe_command(&collected[2..])?;
            mode_probe::run(executable, stdout).map_err(|error| CliError::Io(error.to_string()))
        }
        other => {
            let _ = stderr.write_all(format!("Unknown command: {other}\n").as_bytes());
            let _ = stderr.flush();
            Err(CliError::Usage(format!("Unknown command: {other}")))
        }
    }
}

fn parse_mode_probe_command(args: &[String]) -> Result<Vec<String>, CliError> {
    if args.first().map(String::as_str) != Some("--") || args.len() < 2 {
        return Err(CliError::Usage(
            "mode-probe requires: mode-probe -- <executable> [args...]".to_string(),
        ));
    }
    Ok(args[1..].to_vec())
}

pub fn write_error(error: &CliError, stderr: &mut impl Write) -> io::Result<()> {
    match error {
        CliError::Usage(message) if message.starts_with("Unknown command: ") => Ok(()),
        _ => {
            stderr.write_all(error.message().as_bytes())?;
            stderr.write_all(b"\n")?;
            stderr.flush()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mode_probe_command, run, CliError, APPROVED_COMMANDS};

    #[test]
    fn lists_only_approved_public_commands_in_usage() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = run(
            vec!["fixture".to_string()],
            &b""[..],
            &mut stdout,
            &mut stderr,
        );

        assert_eq!(result, Err(CliError::Usage(APPROVED_COMMANDS.to_string())));
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }

    #[test]
    fn rejects_missing_mode_probe_executable() {
        assert_eq!(
            parse_mode_probe_command(&[]),
            Err(CliError::Usage(
                "mode-probe requires: mode-probe -- <executable> [args...]".to_string()
            ))
        );
        assert_eq!(
            parse_mode_probe_command(&["--".to_string()]),
            Err(CliError::Usage(
                "mode-probe requires: mode-probe -- <executable> [args...]".to_string()
            ))
        );
    }

    #[test]
    fn rejects_unknown_subcommand_with_usage_exit_code() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = run(
            vec!["fixture".to_string(), "bogus".to_string()],
            &b""[..],
            &mut stdout,
            &mut stderr,
        );

        assert_eq!(
            result,
            Err(CliError::Usage("Unknown command: bogus".to_string()))
        );
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "Unknown command: bogus\n"
        );
        assert!(stdout.is_empty());
    }

    #[test]
    fn rejects_removed_public_aliases() {
        for alias in ["tui", "stream-protocol"] {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let result = run(
                vec!["fixture".to_string(), alias.to_string()],
                &b""[..],
                &mut stdout,
                &mut stderr,
            );

            assert_eq!(
                result,
                Err(CliError::Usage(format!("Unknown command: {alias}")))
            );
            assert_eq!(
                String::from_utf8(stderr).unwrap(),
                format!("Unknown command: {alias}\n")
            );
            assert!(stdout.is_empty());
        }
    }
}
