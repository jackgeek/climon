use std::io::{BufRead, Write};
use std::thread;
use std::time::Duration;

use crate::cli::CliError;

const MAX_FLOOD_LINES: u32 = 10_000;
const LIFECYCLE_USAGE: &str =
    "lifecycle-probe requires: lifecycle-probe <fast-success [<gate-token>]|failed-exit [<gate-token>]|flood <count 1..=10000> <gate-token>|signal-hold|engine-echo>";

#[derive(Debug, PartialEq, Eq)]
enum LifecycleMode {
    FastSuccess { token: Option<String> },
    FailedExit { token: Option<String> },
    Flood { count: u32, token: String },
    SignalHold,
    EngineEcho,
}

pub fn run(
    args: &[String],
    stdin: &mut impl BufRead,
    stdout: &mut impl Write,
) -> Result<i32, CliError> {
    match parse_mode(args)? {
        LifecycleMode::FastSuccess { token: None } => {
            emit_line(stdout, "DAR_LIFECYCLE_EARLY success")?;
            Ok(0)
        }
        LifecycleMode::FastSuccess { token: Some(ref t) } => {
            run_gated("success", 0, t, stdin, stdout)
        }
        LifecycleMode::FailedExit { token: None } => {
            emit_line(stdout, "DAR_LIFECYCLE_EARLY failure")?;
            Ok(7)
        }
        LifecycleMode::FailedExit { token: Some(ref t) } => {
            run_gated("failure", 7, t, stdin, stdout)
        }
        LifecycleMode::Flood { count, token } => run_flood(count, &token, stdin, stdout),
        LifecycleMode::SignalHold => run_signal_hold(stdout),
        LifecycleMode::EngineEcho => {
            emit_line(stdout, "DAR_ENGINE_ECHO")?;
            Ok(0)
        }
    }
}

fn parse_mode(args: &[String]) -> Result<LifecycleMode, CliError> {
    let Some(mode) = args.first().map(String::as_str) else {
        return Err(CliError::Usage(LIFECYCLE_USAGE.to_string()));
    };
    match mode {
        "fast-success" => {
            if args.len() > 2 {
                return Err(CliError::Usage(LIFECYCLE_USAGE.to_string()));
            }
            let token = args.get(1).cloned().filter(|t| !t.is_empty());
            Ok(LifecycleMode::FastSuccess { token })
        }
        "failed-exit" => {
            if args.len() > 2 {
                return Err(CliError::Usage(LIFECYCLE_USAGE.to_string()));
            }
            let token = args.get(1).cloned().filter(|t| !t.is_empty());
            Ok(LifecycleMode::FailedExit { token })
        }
        "signal-hold" => Ok(LifecycleMode::SignalHold),
        "engine-echo" => Ok(LifecycleMode::EngineEcho),
        "flood" => parse_flood_mode(&args[1..]),
        _ => Err(CliError::Usage(LIFECYCLE_USAGE.to_string())),
    }
}

/// Run the gated protocol: emit the early marker and a durable gate marker,
/// then block until the correct `RELEASE <token>` line arrives on stdin.
///
/// EOF or a mismatched release line is a usage error.
fn run_gated(
    outcome: &str,
    exit_code: i32,
    token: &str,
    stdin: &mut impl BufRead,
    stdout: &mut impl Write,
) -> Result<i32, CliError> {
    emit_line(stdout, &format!("DAR_LIFECYCLE_EARLY {outcome}"))?;
    emit_line(stdout, &format!("DAR_LIFECYCLE_GATE {token}"))?;

    let expected = format!("RELEASE {token}");
    let line = read_required_line(stdin, &expected)?;
    if line != expected {
        return Err(CliError::Usage(format!(
            "Malformed lifecycle input: expected \"{expected}\", got \"{line}\""
        )));
    }

    Ok(exit_code)
}

fn parse_flood_mode(args: &[String]) -> Result<LifecycleMode, CliError> {
    if args.len() != 2 {
        return Err(CliError::Usage(LIFECYCLE_USAGE.to_string()));
    }
    let count = args[0]
        .parse::<u32>()
        .ok()
        .filter(|count| (1..=MAX_FLOOD_LINES).contains(count))
        .ok_or_else(|| CliError::Usage(LIFECYCLE_USAGE.to_string()))?;
    let token = args[1].clone();
    if token.is_empty() {
        return Err(CliError::Usage(LIFECYCLE_USAGE.to_string()));
    }
    Ok(LifecycleMode::Flood { count, token })
}

fn run_flood(
    count: u32,
    token: &str,
    stdin: &mut impl BufRead,
    stdout: &mut impl Write,
) -> Result<i32, CliError> {
    let split = count.div_ceil(2);
    for index in 1..=split {
        emit_line(stdout, &flood_line(index))?;
    }

    let line = read_required_line(stdin, "CONTINUE <token>")?;
    let expected = format!("CONTINUE {token}");
    if line != expected {
        return Err(CliError::Usage(format!(
            "Malformed lifecycle input: {line}"
        )));
    }

    for index in split + 1..=count {
        emit_line(stdout, &flood_line(index))?;
    }
    Ok(0)
}

fn run_signal_hold(stdout: &mut impl Write) -> Result<i32, CliError> {
    emit_line(stdout, "DAR_LIFECYCLE_HOLD_READY")?;
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn emit_line(stdout: &mut impl Write, line: &str) -> Result<(), CliError> {
    writeln!(stdout, "{line}")
        .and_then(|_| stdout.flush())
        .map_err(|error| CliError::Io(error.to_string()))
}

fn flood_line(index: u32) -> String {
    format!("DAR_LIFECYCLE_FLOOD {index:06}")
}

fn read_required_line(stdin: &mut impl BufRead, expectation: &str) -> Result<String, CliError> {
    let mut line = String::new();
    let bytes = stdin
        .read_line(&mut line)
        .map_err(|error| CliError::Io(error.to_string()))?;
    if bytes == 0 {
        return Err(CliError::Usage(format!(
            "Malformed lifecycle input: expected {expectation}"
        )));
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use crate::cli::CliError;

    use super::{flood_line, parse_mode, run, LifecycleMode, LIFECYCLE_USAGE};

    #[test]
    fn parses_lifecycle_modes_and_bounds_flood_counts() {
        assert_eq!(
            parse_mode(&["fast-success".to_string()]).unwrap(),
            LifecycleMode::FastSuccess { token: None }
        );
        assert_eq!(
            parse_mode(&["failed-exit".to_string()]).unwrap(),
            LifecycleMode::FailedExit { token: None }
        );
        assert_eq!(
            parse_mode(&["signal-hold".to_string()]).unwrap(),
            LifecycleMode::SignalHold
        );
        assert_eq!(
            parse_mode(&["engine-echo".to_string()]).unwrap(),
            LifecycleMode::EngineEcho
        );
        assert_eq!(
            parse_mode(&[
                "flood".to_string(),
                "6".to_string(),
                "gate-token".to_string()
            ])
            .unwrap(),
            LifecycleMode::Flood {
                count: 6,
                token: "gate-token".to_string()
            }
        );
        assert_eq!(
            parse_mode(&[
                "flood".to_string(),
                "0".to_string(),
                "gate-token".to_string()
            ]),
            Err(CliError::Usage(LIFECYCLE_USAGE.to_string()))
        );
    }

    #[test]
    fn rejects_extra_args_for_fast_success_and_failed_exit() {
        // More than one optional arg is a usage error.
        assert_eq!(
            parse_mode(&[
                "fast-success".to_string(),
                "my-token".to_string(),
                "unexpected-extra".to_string()
            ]),
            Err(CliError::Usage(LIFECYCLE_USAGE.to_string()))
        );
        assert_eq!(
            parse_mode(&[
                "failed-exit".to_string(),
                "my-token".to_string(),
                "unexpected-extra".to_string()
            ]),
            Err(CliError::Usage(LIFECYCLE_USAGE.to_string()))
        );
    }

    #[test]
    fn empty_token_arg_is_treated_as_no_token_for_fast_success_and_failed_exit() {
        // An explicit empty string behaves the same as omitting the token.
        assert_eq!(
            parse_mode(&["fast-success".to_string(), String::new()]).unwrap(),
            LifecycleMode::FastSuccess { token: None }
        );
        assert_eq!(
            parse_mode(&["failed-exit".to_string(), String::new()]).unwrap(),
            LifecycleMode::FailedExit { token: None }
        );
    }

    #[test]
    fn parses_optional_gate_token_for_fast_success_and_failed_exit() {
        // With token — both variants parse to Some(token).
        assert_eq!(
            parse_mode(&["fast-success".to_string(), "my-gate-token".to_string()]).unwrap(),
            LifecycleMode::FastSuccess {
                token: Some("my-gate-token".to_string())
            }
        );
        assert_eq!(
            parse_mode(&["failed-exit".to_string(), "dar07-gate-failure-abc123ef".to_string()])
                .unwrap(),
            LifecycleMode::FailedExit {
                token: Some("dar07-gate-failure-abc123ef".to_string())
            }
        );
        // Empty string is treated as no token (same as omitted).
        assert_eq!(
            parse_mode(&["fast-success".to_string(), String::new()]).unwrap(),
            LifecycleMode::FastSuccess { token: None }
        );
    }

    #[test]
    fn emits_early_exit_lines_and_engine_echo_unchanged_without_token() {
        // Ungated (no token): behavior is identical to the original.
        for (args, expected_code, expected_stdout) in [
            (
                vec![
                    "fixture".to_string(),
                    "lifecycle-probe".to_string(),
                    "fast-success".to_string(),
                ],
                0,
                "DAR_LIFECYCLE_EARLY success\n",
            ),
            (
                vec![
                    "fixture".to_string(),
                    "lifecycle-probe".to_string(),
                    "failed-exit".to_string(),
                ],
                7,
                "DAR_LIFECYCLE_EARLY failure\n",
            ),
            (
                vec![
                    "fixture".to_string(),
                    "lifecycle-probe".to_string(),
                    "engine-echo".to_string(),
                ],
                0,
                "DAR_ENGINE_ECHO\n",
            ),
        ] {
            let mut stdout = Vec::new();
            let mut stdin = Cursor::new(Vec::<u8>::new());
            let exit_code = run(&args[2..], &mut stdin, &mut stdout).unwrap();
            assert_eq!(exit_code, expected_code);
            assert_eq!(String::from_utf8(stdout).unwrap(), expected_stdout);
        }
    }

    #[test]
    fn gated_fast_success_emits_early_gate_then_awaits_release() {
        let token = "dar07-gate-success-abc12345";
        let stdin_data = format!("RELEASE {token}\n");
        let mut stdin = Cursor::new(stdin_data.into_bytes());
        let mut stdout = Vec::new();

        let exit_code = run(
            &["fast-success".to_string(), token.to_string()],
            &mut stdin,
            &mut stdout,
        )
        .unwrap();

        assert_eq!(exit_code, 0);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            format!("DAR_LIFECYCLE_EARLY success\nDAR_LIFECYCLE_GATE {token}\n")
        );
    }

    #[test]
    fn gated_failed_exit_emits_early_gate_then_awaits_release() {
        let token = "dar07-gate-failure-abc12345";
        let stdin_data = format!("RELEASE {token}\n");
        let mut stdin = Cursor::new(stdin_data.into_bytes());
        let mut stdout = Vec::new();

        let exit_code = run(
            &["failed-exit".to_string(), token.to_string()],
            &mut stdin,
            &mut stdout,
        )
        .unwrap();

        assert_eq!(exit_code, 7);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            format!("DAR_LIFECYCLE_EARLY failure\nDAR_LIFECYCLE_GATE {token}\n")
        );
    }

    #[test]
    fn malformed_release_token_returns_usage_error() {
        let token = "dar07-gate-success-abc12345";
        let mut stdin = Cursor::new(b"RELEASE wrong-token\n".to_vec());
        let mut stdout = Vec::new();

        let error = run(
            &["fast-success".to_string(), token.to_string()],
            &mut stdin,
            &mut stdout,
        )
        .expect_err("mismatched release token should be a usage error");

        assert!(
            matches!(error, CliError::Usage(ref msg) if msg.contains("wrong-token")),
            "error should mention the received token: {error:?}"
        );
    }

    #[test]
    fn eof_on_release_returns_usage_error() {
        let token = "dar07-gate-success-abc12345";
        // Empty stdin → immediate EOF
        let mut stdin = Cursor::new(Vec::<u8>::new());
        let mut stdout = Vec::new();

        let error = run(
            &["fast-success".to_string(), token.to_string()],
            &mut stdin,
            &mut stdout,
        )
        .expect_err("EOF before RELEASE should be a usage error");

        assert!(
            matches!(error, CliError::Usage(_)),
            "EOF should produce a Usage error: {error:?}"
        );
    }

    #[test]
    fn floods_in_two_phases_and_requires_the_matching_gate_token() {
        let mut stdout = Vec::new();
        let mut stdin = Cursor::new("CONTINUE gate-token\n");
        let exit_code = run(
            &[
                "flood".to_string(),
                "6".to_string(),
                "gate-token".to_string(),
            ],
            &mut stdin,
            &mut stdout,
        )
        .unwrap();

        assert_eq!(exit_code, 0);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            concat!(
                "DAR_LIFECYCLE_FLOOD 000001\n",
                "DAR_LIFECYCLE_FLOOD 000002\n",
                "DAR_LIFECYCLE_FLOOD 000003\n",
                "DAR_LIFECYCLE_FLOOD 000004\n",
                "DAR_LIFECYCLE_FLOOD 000005\n",
                "DAR_LIFECYCLE_FLOOD 000006\n",
            )
        );
        assert_eq!(flood_line(42), "DAR_LIFECYCLE_FLOOD 000042");

        let mut bad_stdout = Vec::new();
        let mut bad_stdin = Cursor::new("CONTINUE wrong\n");
        let error = run(
            &[
                "flood".to_string(),
                "6".to_string(),
                "gate-token".to_string(),
            ],
            &mut bad_stdin,
            &mut bad_stdout,
        )
        .expect_err("mismatched gate token should fail");
        assert_eq!(
            error,
            CliError::Usage("Malformed lifecycle input: CONTINUE wrong".to_string())
        );
    }
}
