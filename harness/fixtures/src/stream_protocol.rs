use std::io::{BufRead, Write};

use crate::cli::CliError;

const READY_MARKER: &str = "DAR_STREAM_READY";
const CONTINUE_EXPECTATION: &str = "CONTINUE <token>";
const EXIT_EXPECTATION: &str = "EXIT <0..125>";
const REPLAY_START: u16 = 1;
const REPLAY_END: u16 = 20;
const LIVE_START: u16 = 21;
const LIVE_END: u16 = 40;

pub fn run(
    stdin: &mut impl BufRead,
    stdout: &mut impl Write,
    _stderr: &mut impl Write,
) -> Result<i32, CliError> {
    for phase in REPLAY_START..=REPLAY_END {
        emit(stdout, &format!("DAR_STREAM_REPLAY {phase:03}"))?;
    }
    emit(stdout, READY_MARKER)?;

    let _token = parse_continue_line(read_required_line(stdin, CONTINUE_EXPECTATION)?)
        .map_err(|raw| CliError::Usage(format!("Malformed stream input: {raw}")))?;

    for phase in LIVE_START..=LIVE_END {
        emit(stdout, &format!("DAR_STREAM_LIVE {phase:03}"))?;
    }

    let exit_code = parse_exit_line(read_required_line(stdin, EXIT_EXPECTATION)?)
        .map_err(|raw| CliError::Usage(format!("Malformed stream input: {raw}")))?;
    emit(stdout, &format!("DAR_STREAM_EXIT {exit_code}"))?;
    Ok(exit_code)
}

fn emit(stdout: &mut impl Write, message: &str) -> Result<(), CliError> {
    writeln!(stdout, "{message}")
        .and_then(|_| stdout.flush())
        .map_err(|error| CliError::Io(error.to_string()))
}

fn read_required_line(stdin: &mut impl BufRead, expectation: &str) -> Result<String, CliError> {
    let mut line = String::new();
    let bytes = stdin
        .read_line(&mut line)
        .map_err(|error| CliError::Io(error.to_string()))?;
    if bytes == 0 {
        return Err(CliError::Usage(format!(
            "Malformed stream input: expected {expectation}"
        )));
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

fn parse_continue_line(line: String) -> Result<String, String> {
    let Some(token) = line.strip_prefix("CONTINUE ") else {
        return Err(line);
    };
    if token.is_empty() {
        return Err(line);
    }
    Ok(token.to_string())
}

fn parse_exit_line(line: String) -> Result<i32, String> {
    let Some(code) = line.strip_prefix("EXIT ") else {
        return Err(line);
    };
    let parsed = code.parse::<i32>().map_err(|_| line.clone())?;
    if !(0..=125).contains(&parsed) {
        return Err(line);
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use crate::cli::CliError;

    use super::{parse_continue_line, parse_exit_line, run};

    #[test]
    fn emits_the_approved_streaming_handshake_without_echoing_control_lines() {
        let mut stdin = Cursor::new("CONTINUE continue-token\nEXIT 7\n");
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let exit_code =
            run(&mut stdin, &mut stdout, &mut stderr).expect("streaming fixture should run");

        let expected = (1..=20)
            .map(|index| format!("DAR_STREAM_REPLAY {index:03}"))
            .chain(std::iter::once("DAR_STREAM_READY".to_string()))
            .chain((21..=40).map(|index| format!("DAR_STREAM_LIVE {index:03}")))
            .chain(std::iter::once("DAR_STREAM_EXIT 7".to_string()))
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(exit_code, 7);
        assert_eq!(String::from_utf8(stdout).unwrap(), format!("{expected}\n"));
        assert_eq!(String::from_utf8(stderr).unwrap(), "");
    }

    #[test]
    fn rejects_malformed_continue_handshakes_and_eof_before_continue() {
        let mut malformed_stdin = Cursor::new("CONTINUE\n");
        let mut malformed_stdout = Vec::new();
        let mut malformed_stderr = Vec::new();
        let malformed_error = run(
            &mut malformed_stdin,
            &mut malformed_stdout,
            &mut malformed_stderr,
        )
        .expect_err("missing continue token should fail");

        assert_eq!(
            malformed_error,
            CliError::Usage("Malformed stream input: CONTINUE".to_string())
        );

        let mut eof_stdin = Cursor::new(Vec::<u8>::new());
        let mut eof_stdout = Vec::new();
        let mut eof_stderr = Vec::new();
        let eof_error = run(&mut eof_stdin, &mut eof_stdout, &mut eof_stderr)
            .expect_err("EOF before continue should fail");

        assert_eq!(
            eof_error,
            CliError::Usage("Malformed stream input: expected CONTINUE <token>".to_string())
        );
    }

    #[test]
    fn parses_continue_and_exit_lines_exactly() {
        assert_eq!(
            parse_continue_line("CONTINUE continue-token".to_string()),
            Ok("continue-token".to_string())
        );
        assert_eq!(
            parse_continue_line("CONTINUE".to_string()),
            Err("CONTINUE".to_string())
        );
        assert_eq!(
            parse_continue_line("CONTINUE ".to_string()),
            Err("CONTINUE ".to_string())
        );
        assert_eq!(
            parse_continue_line("EXIT 0".to_string()),
            Err("EXIT 0".to_string())
        );

        assert_eq!(parse_exit_line("EXIT 0".to_string()), Ok(0));
        assert_eq!(parse_exit_line("EXIT 125".to_string()), Ok(125));
        assert_eq!(
            parse_exit_line("EXIT 126".to_string()),
            Err("EXIT 126".to_string())
        );
        assert_eq!(
            parse_exit_line("EXIT -1".to_string()),
            Err("EXIT -1".to_string())
        );
        assert_eq!(
            parse_exit_line("EXIT not-a-number".to_string()),
            Err("EXIT not-a-number".to_string())
        );
    }
}
