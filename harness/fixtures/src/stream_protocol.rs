use std::io::{BufRead, Write};

use crate::cli::CliError;

#[derive(Debug, PartialEq, Eq)]
enum StreamCommand {
    Hello(String),
    Text(String),
    Key(String),
    Control(String),
    MousePress { button: String, col: u16, row: u16 },
    MouseRelease { button: String, col: u16, row: u16 },
    MouseWheelUp { col: u16, row: u16 },
    MouseWheelDown { col: u16, row: u16 },
    MouseMove { button: String, col: u16, row: u16 },
    Resize { cols: u16, rows: u16 },
    Status,
    Exit(i32),
}

pub fn run(
    stdin: &mut impl BufRead,
    stdout: &mut impl Write,
    _stderr: &mut impl Write,
) -> Result<i32, CliError> {
    emit(stdout, 1, "DAR_STREAM_READY")?;
    let mut phase = 2;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes = stdin
            .read_line(&mut line)
            .map_err(|error| CliError::Io(error.to_string()))?;
        if bytes == 0 {
            return Ok(0);
        }
        let raw = line.trim_end_matches(['\r', '\n']);
        let command = parse_line(raw)
            .map_err(|_| CliError::Usage(format!("Malformed stream input: {raw}")))?;
        let message = render_command(&command);
        emit(stdout, phase, &message)?;
        if let StreamCommand::Exit(code) = command {
            return Ok(code);
        }
        phase += 1;
    }
}

fn emit(stdout: &mut impl Write, phase: u16, message: &str) -> Result<(), CliError> {
    writeln!(stdout, "{phase:03} {message}")
        .and_then(|_| stdout.flush())
        .map_err(|error| CliError::Io(error.to_string()))
}

fn parse_line(line: &str) -> Result<StreamCommand, ()> {
    if let Some(rest) = line.strip_prefix("HELLO ") {
        return (!rest.is_empty())
            .then(|| StreamCommand::Hello(rest.to_string()))
            .ok_or(());
    }
    if let Some(rest) = line.strip_prefix("TEXT ") {
        return (!rest.is_empty())
            .then(|| StreamCommand::Text(rest.to_string()))
            .ok_or(());
    }
    if let Some(rest) = line.strip_prefix("KEY ") {
        return parse_key(rest);
    }
    if let Some(rest) = line.strip_prefix("CTRL ") {
        return parse_control(rest);
    }
    if let Some(rest) = line.strip_prefix("MOUSE ") {
        return parse_mouse(rest);
    }
    if let Some(rest) = line.strip_prefix("RESIZE ") {
        return parse_resize(rest);
    }
    if line == "STATUS" {
        return Ok(StreamCommand::Status);
    }
    if let Some(rest) = line.strip_prefix("EXIT ") {
        return rest.parse::<i32>().map(StreamCommand::Exit).map_err(|_| ());
    }
    Err(())
}

fn parse_key(value: &str) -> Result<StreamCommand, ()> {
    const ALLOWED: &[&str] = &[
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
        "Escape",
        "Backspace",
        "Delete",
    ];
    ALLOWED
        .contains(&value)
        .then(|| StreamCommand::Key(value.to_string()))
        .ok_or(())
}

fn parse_control(value: &str) -> Result<StreamCommand, ()> {
    const ALLOWED: &[(&str, &str)] = &[("C", "Ctrl+C"), ("Q", "Ctrl+Q")];
    ALLOWED
        .iter()
        .find_map(|(key, label)| {
            (*key == value).then(|| StreamCommand::Control((*label).to_string()))
        })
        .ok_or(())
}

fn parse_mouse(value: &str) -> Result<StreamCommand, ()> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    match parts.as_slice() {
        ["PRESS", button, col, row] => Ok(StreamCommand::MousePress {
            button: button.to_string(),
            col: parse_positive_u16(col)?,
            row: parse_positive_u16(row)?,
        }),
        ["RELEASE", button, col, row] => Ok(StreamCommand::MouseRelease {
            button: button.to_string(),
            col: parse_positive_u16(col)?,
            row: parse_positive_u16(row)?,
        }),
        ["WHEEL", "up", col, row] => Ok(StreamCommand::MouseWheelUp {
            col: parse_positive_u16(col)?,
            row: parse_positive_u16(row)?,
        }),
        ["WHEEL", "down", col, row] => Ok(StreamCommand::MouseWheelDown {
            col: parse_positive_u16(col)?,
            row: parse_positive_u16(row)?,
        }),
        ["MOVE", button, col, row] => Ok(StreamCommand::MouseMove {
            button: button.to_string(),
            col: parse_positive_u16(col)?,
            row: parse_positive_u16(row)?,
        }),
        _ => Err(()),
    }
}

fn parse_resize(value: &str) -> Result<StreamCommand, ()> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    match parts.as_slice() {
        [cols, rows] => Ok(StreamCommand::Resize {
            cols: parse_positive_u16(cols)?,
            rows: parse_positive_u16(rows)?,
        }),
        _ => Err(()),
    }
}

fn parse_positive_u16(value: &str) -> Result<u16, ()> {
    let parsed = value.parse::<u16>().map_err(|_| ())?;
    (parsed > 0).then_some(parsed).ok_or(())
}

fn render_command(command: &StreamCommand) -> String {
    match command {
        StreamCommand::Hello(value) => format!("DAR_STREAM_HELLO {value}"),
        StreamCommand::Text(value) => format!("DAR_STREAM_TEXT {value}"),
        StreamCommand::Key(value) => format!("DAR_STREAM_KEY {value}"),
        StreamCommand::Control(value) => format!("DAR_STREAM_CONTROL {value}"),
        StreamCommand::MousePress { button, col, row } => {
            format!("DAR_STREAM_MOUSE_PRESS {button} {col} {row}")
        }
        StreamCommand::MouseRelease { button, col, row } => {
            format!("DAR_STREAM_MOUSE_RELEASE {button} {col} {row}")
        }
        StreamCommand::MouseWheelUp { col, row } => {
            format!("DAR_STREAM_MOUSE_WHEEL_UP {col} {row}")
        }
        StreamCommand::MouseWheelDown { col, row } => {
            format!("DAR_STREAM_MOUSE_WHEEL_DOWN {col} {row}")
        }
        StreamCommand::MouseMove { button, col, row } => {
            format!("DAR_STREAM_MOUSE_MOVE {button} {col} {row}")
        }
        StreamCommand::Resize { cols, rows } => format!("DAR_STREAM_RESIZE {cols} {rows}"),
        StreamCommand::Status => "DAR_STREAM_STATUS ok".to_string(),
        StreamCommand::Exit(code) => format!("DAR_STREAM_EXIT {code}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_line, render_command, StreamCommand};

    #[test]
    fn parses_and_formats_supported_stream_commands() {
        assert_eq!(
            parse_line("HELLO handshake"),
            Ok(StreamCommand::Hello("handshake".to_string()))
        );
        assert_eq!(
            parse_line("CTRL C"),
            Ok(StreamCommand::Control("Ctrl+C".to_string()))
        );
        assert_eq!(
            parse_line("MOUSE MOVE left 4 5"),
            Ok(StreamCommand::MouseMove {
                button: "left".to_string(),
                col: 4,
                row: 5,
            })
        );
        assert_eq!(
            render_command(&StreamCommand::Resize {
                cols: 100,
                rows: 30
            }),
            "DAR_STREAM_RESIZE 100 30"
        );
    }

    #[test]
    fn rejects_malformed_stream_commands() {
        assert!(parse_line("HELLO").is_err());
        assert!(parse_line("KEY F1").is_err());
        assert!(parse_line("CTRL X").is_err());
        assert!(parse_line("MOUSE PRESS left 0 1").is_err());
        assert!(parse_line("RESIZE 100 nope").is_err());
    }
}
