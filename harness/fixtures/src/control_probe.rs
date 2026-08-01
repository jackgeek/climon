use std::io::{self, BufReader, Read, Write};
use std::time::Duration;

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{read, Event, KeyCode, KeyEvent, KeyEventKind};
use crossterm::execute;
use crossterm::style::Print;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, size, Clear, ClearType, EnterAlternateScreen,
    LeaveAlternateScreen,
};

const READY_LABEL: &str = "DAR_CONTROL_READY";
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const LIVE_EVENT_POLL_INTERVAL: Duration = Duration::from_millis(75);

struct TerminalGuard {
    stdout: io::Stdout,
    raw_enabled: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct ProbeState {
    cols: u16,
    rows: u16,
    last_token: String,
    resize_sequence: u64,
    previous_size: Option<(u16, u16)>,
}

enum LiveInputState {
    Idle,
    Step(LiveStep),
    Disconnect,
}

enum LiveStep {
    Token(String),
    Resize(u16, u16),
    Exit,
}

enum LiveReadiness {
    Idle,
    Ready,
    Disconnect,
}

#[derive(Debug, PartialEq, Eq)]
enum ScriptStep {
    Token(String),
    Resize(u16, u16),
    Exit,
}

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut guard = Self {
            stdout: io::stdout(),
            raw_enabled: true,
        };
        execute!(guard.stdout, EnterAlternateScreen, Hide)?;
        Ok(guard)
    }

    fn render(&mut self, marker: &str, state: &ProbeState) -> io::Result<()> {
        emit_marker_and_render(&mut self.stdout, marker, state)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(self.stdout, Show, LeaveAlternateScreen);
        if self.raw_enabled {
            let _ = disable_raw_mode();
        }
        let _ = self.stdout.flush();
    }
}

pub fn run(mut stdin: impl Read, stdout: &mut impl Write) -> io::Result<i32> {
    match TerminalGuard::enter() {
        Ok(mut terminal) => run_live(&mut terminal),
        Err(_) => run_scripted(BufReader::new(&mut stdin), stdout),
    }
}

fn run_live(terminal: &mut TerminalGuard) -> io::Result<i32> {
    let (cols, rows) = size().unwrap_or((DEFAULT_COLS, DEFAULT_ROWS));
    let mut state = ProbeState::new(cols, rows);
    let mut pending = String::new();
    terminal.render(&state.ready_marker(), &state)?;

    loop {
        let step = match next_live_input(&mut pending)? {
            LiveInputState::Idle => {
                let Some((cols, rows)) = pending_live_resize(&state) else {
                    continue;
                };
                LiveStep::Resize(cols, rows)
            }
            LiveInputState::Step(step) => step,
            LiveInputState::Disconnect => return Ok(0),
        };

        match step {
            LiveStep::Token(token) => {
                state.last_token = token.clone();
                terminal.render(&format!("DAR_CONTROL_INPUT {token}"), &state)?;
            }
            LiveStep::Resize(cols, rows) => {
                if state.cols == cols && state.rows == rows {
                    continue;
                }
                state.previous_size = Some((state.cols, state.rows));
                state.cols = cols;
                state.rows = rows;
                state.resize_sequence += 1;
                terminal.render(
                    &format!(
                        "DAR_CONTROL_RESIZE {} {} {}",
                        state.resize_sequence, state.cols, state.rows
                    ),
                    &state,
                )?;
            }
            LiveStep::Exit => return Ok(0),
        }
    }
}

fn run_scripted(mut stdin: BufReader<&mut impl Read>, stdout: &mut impl Write) -> io::Result<i32> {
    let mut state = ProbeState::new(DEFAULT_COLS, DEFAULT_ROWS);
    let mut pending = String::new();
    emit_marker_and_render(stdout, &state.ready_marker(), &state)?;

    while let Some(step) = read_scripted_step(&mut stdin, &mut pending)? {
        match step {
            ScriptStep::Token(token) => {
                state.last_token = token.clone();
                emit_marker_and_render(stdout, &format!("DAR_CONTROL_INPUT {token}"), &state)?;
            }
            ScriptStep::Resize(cols, rows) => {
                state.previous_size = Some((state.cols, state.rows));
                state.cols = cols;
                state.rows = rows;
                state.resize_sequence += 1;
                emit_marker_and_render(
                    stdout,
                    &format!(
                        "DAR_CONTROL_RESIZE {} {} {}",
                        state.resize_sequence, state.cols, state.rows
                    ),
                    &state,
                )?;
            }
            ScriptStep::Exit => return Ok(0),
        }
    }

    Ok(0)
}

impl ProbeState {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            last_token: "ready".to_string(),
            resize_sequence: 0,
            previous_size: None,
        }
    }

    fn ready_marker(&self) -> String {
        format!("{READY_LABEL} {} {}", self.cols, self.rows)
    }
}

fn render_lines(state: &ProbeState) -> String {
    let previous = state
        .previous_size
        .map(|(cols, rows)| format!("{cols}x{rows}"))
        .unwrap_or_else(|| "none".to_string());
    format!(
        "{READY_LABEL}\r\nsize={}x{}\r\nprevious={previous}\r\nlast={}\r\nresizes={}\r\n",
        state.cols, state.rows, state.last_token, state.resize_sequence
    )
}

fn emit_marker_and_render(
    writer: &mut impl Write,
    marker: &str,
    state: &ProbeState,
) -> io::Result<()> {
    writeln!(writer, "{marker}")?;
    writer.flush()?;
    execute!(
        writer,
        MoveTo(0, 0),
        Clear(ClearType::All),
        Print(render_lines(state))
    )?;
    writer.flush()
}

fn pending_live_resize(state: &ProbeState) -> Option<(u16, u16)> {
    let (cols, rows) = size().ok()?;
    if cols == state.cols && rows == state.rows {
        return None;
    }
    Some((cols, rows))
}

fn next_live_input(
    pending: &mut String,
) -> io::Result<LiveInputState> {
    if let Some(step) = take_buffered_live_step(pending)? {
        return Ok(step);
    }

    match wait_for_live_input()? {
        LiveReadiness::Idle => Ok(LiveInputState::Idle),
        LiveReadiness::Disconnect => Ok(LiveInputState::Disconnect),
        LiveReadiness::Ready => {
            match read() {
                Ok(event) => Ok(classify_live_event(event, pending)
                    .map(LiveInputState::Step)
                    .unwrap_or(LiveInputState::Idle)),
                Err(error) if is_live_disconnect_error(&error) => Ok(LiveInputState::Disconnect),
                Err(error) => Err(error),
            }
        }
    }
}

fn take_buffered_live_step(pending: &mut String) -> io::Result<Option<LiveInputState>> {
    match crossterm::event::poll(Duration::ZERO) {
        Ok(false) => Ok(None),
        Ok(true) => match read() {
            Ok(event) => Ok(Some(
                classify_live_event(event, pending)
                    .map(LiveInputState::Step)
                    .unwrap_or(LiveInputState::Idle),
            )),
            Err(error) if is_live_disconnect_error(&error) => Ok(Some(LiveInputState::Disconnect)),
            Err(error) => Err(error),
        },
        Err(error) if is_live_disconnect_error(&error) => Ok(Some(LiveInputState::Disconnect)),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn wait_for_live_input() -> io::Result<LiveReadiness> {
    loop {
        let mut pfd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout_ms = LIVE_EVENT_POLL_INTERVAL.as_millis().min(i32::MAX as u128) as i32;
        let rc = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if rc < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if rc == 0 {
            return Ok(LiveReadiness::Idle);
        }
        let disconnect_flags = libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
        if (pfd.revents & disconnect_flags) != 0 {
            return Ok(LiveReadiness::Disconnect);
        }
        if (pfd.revents & libc::POLLIN) != 0 {
            return Ok(LiveReadiness::Ready);
        }
        return Ok(LiveReadiness::Idle);
    }
}

#[cfg(not(unix))]
fn wait_for_live_input() -> io::Result<LiveReadiness> {
    match crossterm::event::poll(LIVE_EVENT_POLL_INTERVAL) {
        Ok(false) => Ok(LiveReadiness::Idle),
        Ok(true) => Ok(LiveReadiness::Ready),
        Err(error) if is_live_disconnect_error(&error) => Ok(LiveReadiness::Disconnect),
        Err(error) => Err(error),
    }
}

fn is_live_disconnect_error(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
    ) {
        return true;
    }

    #[cfg(unix)]
    {
        return matches!(error.raw_os_error(), Some(code) if code == libc::EIO);
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            ERROR_BROKEN_PIPE, ERROR_INVALID_HANDLE, ERROR_OPERATION_ABORTED,
        };

        return matches!(
            error.raw_os_error(),
            Some(code)
                if code == ERROR_BROKEN_PIPE as i32
                    || code == ERROR_INVALID_HANDLE as i32
                    || code == ERROR_OPERATION_ABORTED as i32
        );
    }

    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

fn classify_live_event(event: Event, pending: &mut String) -> Option<LiveStep> {
    match event {
        Event::Key(key) if !matches!(key.kind, KeyEventKind::Release) => {
            classify_key_event(key, pending)
        }
        Event::Resize(cols, rows) => Some(LiveStep::Resize(cols, rows)),
        Event::FocusGained | Event::FocusLost | Event::Mouse(_) | Event::Paste(_) => None,
        _ => None,
    }
}

fn classify_key_event(key: KeyEvent, pending: &mut String) -> Option<LiveStep> {
    match key.code {
        KeyCode::Char('q') if pending.is_empty() => Some(LiveStep::Exit),
        KeyCode::Char(character) => {
            pending.push(character);
            None
        }
        KeyCode::Backspace => {
            pending.pop();
            None
        }
        KeyCode::Enter => {
            if pending.is_empty() {
                None
            } else {
                Some(LiveStep::Token(std::mem::take(pending)))
            }
        }
        _ => None,
    }
}

fn read_scripted_step(
    reader: &mut impl Read,
    pending: &mut String,
) -> io::Result<Option<ScriptStep>> {
    loop {
        let Some(first) = read_byte(reader)? else {
            return Ok(None);
        };
        match first {
            b'\r' | b'\n' => {
                if pending.is_empty() {
                    continue;
                }
                return Ok(Some(ScriptStep::Token(std::mem::take(pending))));
            }
            b'\x08' | 0x7f => {
                pending.pop();
            }
            0x1b => return Ok(Some(parse_escape_sequence(reader)?)),
            byte => {
                let character = read_char(reader, byte)?;
                if character == 'q' && pending.is_empty() {
                    return Ok(Some(ScriptStep::Exit));
                }
                pending.push(character);
            }
        }
    }
}

fn parse_escape_sequence(reader: &mut impl Read) -> io::Result<ScriptStep> {
    let Some(next) = read_byte(reader)? else {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete escape sequence",
        ));
    };
    if next != b'[' {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unsupported escape sequence",
        ));
    }

    let mut payload = Vec::new();
    loop {
        let Some(byte) = read_byte(reader)? else {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete escape sequence",
            ));
        };
        payload.push(byte);
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'~') {
            break;
        }
    }

    parse_resize_sequence(&payload)
}

fn parse_resize_sequence(payload: &[u8]) -> io::Result<ScriptStep> {
    let text = std::str::from_utf8(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let body = text
        .strip_suffix('t')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid resize payload"))?;
    let mut parts = body.split(';');
    let Some("8") = parts.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid resize prefix",
        ));
    };
    let rows = parse_u16(parts.next())?;
    let cols = parse_u16(parts.next())?;
    if parts.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unexpected resize fields",
        ));
    }
    Ok(ScriptStep::Resize(cols, rows))
}

fn parse_u16(value: Option<&str>) -> io::Result<u16> {
    value
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing numeric field"))?
        .parse::<u16>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn read_byte(reader: &mut impl Read) -> io::Result<Option<u8>> {
    let mut byte = [0_u8; 1];
    match reader.read(&mut byte) {
        Ok(0) => Ok(None),
        Ok(_) => Ok(Some(byte[0])),
        Err(error) => Err(error),
    }
}

fn read_char(reader: &mut impl Read, first: u8) -> io::Result<char> {
    let width = utf8_width(first).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Invalid UTF-8 lead byte: {first}"),
        )
    })?;
    let mut bytes = vec![first];
    for _ in 1..width {
        let Some(byte) = read_byte(reader)? else {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete UTF-8 character",
            ));
        };
        bytes.push(byte);
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(text.chars().next().unwrap())
}

fn utf8_width(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7f => Some(1),
        0xc0..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf7 => Some(4),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;

    use super::{parse_resize_sequence, read_scripted_step, render_lines, ProbeState, ScriptStep};

    #[test]
    fn renders_a_full_frame_with_dimensions_last_token_and_resize_sequence() {
        let state = ProbeState {
            cols: 100,
            rows: 30,
            last_token: "browser-token".to_string(),
            resize_sequence: 2,
            previous_size: Some((99, 29)),
        };

        assert_eq!(
            render_lines(&state),
            "DAR_CONTROL_READY\r\nsize=100x30\r\nprevious=99x29\r\nlast=browser-token\r\nresizes=2\r\n"
        );
    }

    #[test]
    fn parses_scripted_tokens_resizes_and_q_exit() {
        let mut pending = String::new();
        let mut input = &b"surface-alpha\r\x1b[8;30;100tbrowser-token\rq"[..];

        assert_eq!(
            read_scripted_step(&mut input, &mut pending).unwrap(),
            Some(ScriptStep::Token("surface-alpha".to_string()))
        );
        assert_eq!(
            read_scripted_step(&mut input, &mut pending).unwrap(),
            Some(ScriptStep::Resize(100, 30))
        );
        assert_eq!(
            read_scripted_step(&mut input, &mut pending).unwrap(),
            Some(ScriptStep::Token("browser-token".to_string()))
        );
        assert!(matches!(
            read_scripted_step(&mut input, &mut pending).unwrap(),
            Some(ScriptStep::Exit)
        ));
    }

    #[test]
    fn rejects_non_resize_escape_sequences() {
        let error = parse_resize_sequence(b"A").unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }
}
