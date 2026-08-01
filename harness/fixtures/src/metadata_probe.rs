use std::io::{BufRead, Write};

use crate::cli::CliError;

#[derive(Debug, PartialEq, Eq)]
enum MetadataCommand {
    Static,
    Change(String),
    Osc { sequence: String, marker: String },
    Exit,
}

pub fn run(stdin: &mut impl BufRead, stdout: &mut impl Write) -> Result<i32, CliError> {
    emit_line(stdout, "DAR_METADATA_STATIC")?;

    loop {
        let command = parse_command(read_required_line(stdin, "metadata command or EXIT")?)
            .map_err(|raw| CliError::Usage(format!("Malformed metadata input: {raw}")))?;

        match command {
            MetadataCommand::Static => emit_line(stdout, "DAR_METADATA_STATIC")?,
            MetadataCommand::Change(token) => {
                emit_line(stdout, &format!("DAR_METADATA_BODY_CHANGED {token}"))?
            }
            MetadataCommand::Osc { sequence, marker } => {
                write!(stdout, "{sequence}{marker}\n")
                    .and_then(|_| stdout.flush())
                    .map_err(|error| CliError::Io(error.to_string()))?;
            }
            MetadataCommand::Exit => return Ok(0),
        }
    }
}

fn emit_line(stdout: &mut impl Write, line: &str) -> Result<(), CliError> {
    writeln!(stdout, "{line}")
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
            "Malformed metadata input: expected {expectation}"
        )));
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

fn parse_command(line: String) -> Result<MetadataCommand, String> {
    if line == "STATIC" {
        return Ok(MetadataCommand::Static);
    }
    if line == "CLEAR_PROGRESS" {
        return Ok(MetadataCommand::Osc {
            sequence: "\x1b]9;4;0;0\x07".to_string(),
            marker: "DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS".to_string(),
        });
    }
    if line == "EXIT" {
        return Ok(MetadataCommand::Exit);
    }
    if let Some(token) = non_empty_suffix(&line, "CHANGE ") {
        return Ok(MetadataCommand::Change(token.to_string()));
    }
    if let Some(value) = non_empty_suffix(&line, "TITLE0 ") {
        return Ok(MetadataCommand::Osc {
            sequence: format!("\x1b]0;{value}\x07"),
            marker: "DAR_METADATA_OSC_EMITTED TITLE0".to_string(),
        });
    }
    if let Some(value) = non_empty_suffix(&line, "TITLE2 ") {
        return Ok(MetadataCommand::Osc {
            sequence: format!("\x1b]2;{value}\x07"),
            marker: "DAR_METADATA_OSC_EMITTED TITLE2".to_string(),
        });
    }
    if let Some(body) = line.strip_prefix("PROGRESS ") {
        let mut parts = body.split_whitespace();
        let state = parse_u8(parts.next()).ok_or_else(|| line.clone())?;
        let percent = parse_u8(parts.next()).ok_or_else(|| line.clone())?;
        if parts.next().is_some() || state > 4 || percent > 100 {
            return Err(line);
        }
        return Ok(MetadataCommand::Osc {
            sequence: format!("\x1b]9;4;{state};{percent}\x07"),
            marker: format!("DAR_METADATA_OSC_EMITTED PROGRESS {state} {percent}"),
        });
    }

    Err(line)
}

fn non_empty_suffix<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.strip_prefix(prefix).filter(|value| !value.is_empty())
}

fn parse_u8(value: Option<&str>) -> Option<u8> {
    value?.parse::<u8>().ok()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use crate::cli::CliError;

    use super::{parse_command, run, MetadataCommand};

    #[test]
    fn parses_line_commands_exactly() {
        assert!(matches!(
            parse_command("STATIC".to_string()),
            Ok(MetadataCommand::Static)
        ));
        assert!(matches!(
            parse_command("CHANGE token-alpha".to_string()),
            Ok(MetadataCommand::Change(token)) if token == "token-alpha"
        ));
        assert!(matches!(
            parse_command("TITLE0 title-zero".to_string()),
            Ok(MetadataCommand::Osc { marker, .. }) if marker == "DAR_METADATA_OSC_EMITTED TITLE0"
        ));
        assert!(matches!(
            parse_command("TITLE2 title-two".to_string()),
            Ok(MetadataCommand::Osc { marker, .. }) if marker == "DAR_METADATA_OSC_EMITTED TITLE2"
        ));
        assert!(matches!(
            parse_command("PROGRESS 1 42".to_string()),
            Ok(MetadataCommand::Osc { marker, .. }) if marker == "DAR_METADATA_OSC_EMITTED PROGRESS 1 42"
        ));
        assert!(matches!(
            parse_command("CLEAR_PROGRESS".to_string()),
            Ok(MetadataCommand::Osc { marker, .. }) if marker == "DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS"
        ));
        assert!(matches!(
            parse_command("EXIT".to_string()),
            Ok(MetadataCommand::Exit)
        ));
        assert_eq!(
            parse_command("PROGRESS 9 101".to_string()),
            Err("PROGRESS 9 101".to_string())
        );
    }

    #[test]
    fn emits_markers_and_passthrough_sequences_in_order() {
        let mut stdin = Cursor::new(
            "STATIC\nCHANGE token-alpha\nTITLE0 title-zero\nTITLE2 title-two\nPROGRESS 1 42\nCLEAR_PROGRESS\nEXIT\n",
        );
        let mut stdout = Vec::new();

        let exit_code = run(&mut stdin, &mut stdout).expect("metadata probe should run");

        assert_eq!(exit_code, 0);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            concat!(
                "DAR_METADATA_STATIC\n",
                "DAR_METADATA_STATIC\n",
                "DAR_METADATA_BODY_CHANGED token-alpha\n",
                "\x1b]0;title-zero\x07DAR_METADATA_OSC_EMITTED TITLE0\n",
                "\x1b]2;title-two\x07DAR_METADATA_OSC_EMITTED TITLE2\n",
                "\x1b]9;4;1;42\x07DAR_METADATA_OSC_EMITTED PROGRESS 1 42\n",
                "\x1b]9;4;0;0\x07DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS\n",
            )
        );
    }

    #[test]
    fn rejects_malformed_commands_and_eof_before_exit() {
        let mut bad_stdin = Cursor::new("PROGRESS nope\n");
        let mut bad_stdout = Vec::new();
        let bad_error =
            run(&mut bad_stdin, &mut bad_stdout).expect_err("bad metadata command should fail");
        assert_eq!(
            bad_error,
            CliError::Usage("Malformed metadata input: PROGRESS nope".to_string())
        );

        let mut eof_stdin = Cursor::new(Vec::<u8>::new());
        let mut eof_stdout = Vec::new();
        let eof_error =
            run(&mut eof_stdin, &mut eof_stdout).expect_err("EOF before exit should fail");
        assert_eq!(
            eof_error,
            CliError::Usage(
                "Malformed metadata input: expected metadata command or EXIT".to_string()
            )
        );
    }
}
