use std::io::{self, BufReader, Read, Write};
use std::time::Duration;

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{
    read, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::style::Print;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, size, Clear, ClearType, EnterAlternateScreen,
    LeaveAlternateScreen,
};

struct TerminalGuard {
    stdout: io::Stdout,
    raw_enabled: bool,
}

const LIVE_EVENT_POLL_INTERVAL: Duration = Duration::from_millis(75);

struct LiveRunOutcome {
    code: i32,
    stdin_disconnected: bool,
}

enum LiveInputState {
    Idle,
    Event(RenderEvent),
    Disconnect,
}

enum LiveReadiness {
    Idle,
    Ready,
    Disconnect,
}

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut guard = Self {
            stdout: io::stdout(),
            raw_enabled: true,
        };
        execute!(guard.stdout, EnterAlternateScreen, EnableMouseCapture, Hide)?;
        Ok(guard)
    }

    fn show(&mut self, marker: &str, event: &str, cols: u16, rows: u16) -> io::Result<()> {
        emit_marker_and_render(&mut self.stdout, marker, event, cols, rows)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(self.stdout, Show, DisableMouseCapture, LeaveAlternateScreen);
        if self.raw_enabled {
            let _ = disable_raw_mode();
        }
        let _ = self.stdout.flush();
    }
}

#[derive(Debug, PartialEq, Eq)]
struct RenderEvent {
    marker: String,
    event_line: String,
    resize: Option<(u16, u16)>,
    exit: bool,
}

pub fn run(mut stdin: impl Read, stdout: &mut impl Write) -> io::Result<i32> {
    match TerminalGuard::enter() {
        Ok(mut terminal) => {
            let (mut cols, mut rows) = size().unwrap_or((80, 24));
            let outcome = run_live(&mut terminal, &mut cols, &mut rows)?;
            if let Err(error) = writeln!(stdout, "040 DAR_TUI_EXIT").and_then(|_| stdout.flush()) {
                if !outcome.stdin_disconnected {
                    return Err(error);
                }
            }
            Ok(outcome.code)
        }
        Err(_) => run_scripted(BufReader::new(&mut stdin), stdout),
    }
}

fn run_live(
    terminal: &mut TerminalGuard,
    cols: &mut u16,
    rows: &mut u16,
) -> io::Result<LiveRunOutcome> {
    let mut phase = 21_u16;
    let mut maybe_buffered_events = false;
    terminal.show("021 DAR_TUI_READY", "ready", *cols, *rows)?;

    loop {
        let event = match next_live_input(&mut maybe_buffered_events)? {
            LiveInputState::Idle => {
                let Some(event) = pending_live_resize(*cols, *rows) else {
                    continue;
                };
                event
            }
            LiveInputState::Event(event) => event,
            LiveInputState::Disconnect => {
                return Ok(LiveRunOutcome {
                    code: 0,
                    stdin_disconnected: true,
                })
            }
        };
        if event.exit {
            break;
        }
        phase += 1;
        if let Some((new_cols, new_rows)) = event.resize {
            *cols = new_cols;
            *rows = new_rows;
        }
        terminal.show(
            &format!("{phase:03} {}", event.marker),
            &event.event_line,
            *cols,
            *rows,
        )?;
    }

    Ok(LiveRunOutcome {
        code: 0,
        stdin_disconnected: false,
    })
}

fn run_scripted(mut stdin: BufReader<&mut impl Read>, stdout: &mut impl Write) -> io::Result<i32> {
    let mut cols = 80_u16;
    let mut rows = 24_u16;
    let mut phase = 21_u16;
    emit_marker_and_render(stdout, "021 DAR_TUI_READY", "ready", cols, rows)?;

    while let Some(event) = read_scripted_event(&mut stdin)? {
        if event.exit {
            break;
        }
        phase += 1;
        if let Some((new_cols, new_rows)) = event.resize {
            cols = new_cols;
            rows = new_rows;
        }
        emit_marker_and_render(
            stdout,
            &format!("{phase:03} {}", event.marker),
            &event.event_line,
            cols,
            rows,
        )?;
    }

    writeln!(stdout, "040 DAR_TUI_EXIT")?;
    stdout.flush()?;
    Ok(0)
}

fn render_frame(writer: &mut impl Write, event: &str, cols: u16, rows: u16) -> io::Result<()> {
    execute!(
        writer,
        MoveTo(0, 0),
        Clear(ClearType::All),
        Print(render_lines(event, cols, rows))
    )?;
    writer.flush()
}

fn emit_marker_and_render(
    writer: &mut impl Write,
    marker: &str,
    event: &str,
    cols: u16,
    rows: u16,
) -> io::Result<()> {
    writeln!(writer, "{marker}")?;
    writer.flush()?;
    render_frame(writer, event, cols, rows)
}

fn render_lines(event: &str, cols: u16, rows: u16) -> String {
    format!("DAR_TUI_READY\r\nsize={cols}x{rows}\r\nlast={event}\r\n")
}

fn pending_live_resize(cols: u16, rows: u16) -> Option<RenderEvent> {
    let (next_cols, next_rows) = size().ok()?;
    if next_cols == cols && next_rows == rows {
        return None;
    }
    Some(RenderEvent {
        marker: format!("DAR_TUI_RESIZE {next_cols} {next_rows}"),
        event_line: format!("resize:{next_cols}x{next_rows}"),
        resize: Some((next_cols, next_rows)),
        exit: false,
    })
}

fn next_live_input(maybe_buffered_events: &mut bool) -> io::Result<LiveInputState> {
    if *maybe_buffered_events {
        if let Some(event) = take_buffered_live_event()? {
            return Ok(event);
        }
        *maybe_buffered_events = false;
    }
    match wait_for_live_input()? {
        LiveReadiness::Idle => Ok(LiveInputState::Idle),
        LiveReadiness::Disconnect => Ok(LiveInputState::Disconnect),
        LiveReadiness::Ready => {
            *maybe_buffered_events = true;
            match read() {
                Ok(event) => Ok(classify_live_event(event)
                    .map(LiveInputState::Event)
                    .unwrap_or(LiveInputState::Idle)),
                Err(error) if is_live_disconnect_error(&error) => Ok(LiveInputState::Disconnect),
                Err(error) => Err(error),
            }
        }
    }
}

fn take_buffered_live_event() -> io::Result<Option<LiveInputState>> {
    match crossterm::event::poll(Duration::ZERO) {
        Ok(false) => Ok(None),
        Ok(true) => match read() {
            Ok(event) => Ok(Some(
                classify_live_event(event)
                    .map(LiveInputState::Event)
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

fn classify_live_event(event: Event) -> Option<RenderEvent> {
    match event {
        Event::Key(key) if matches!(key.kind, KeyEventKind::Press) => Some(classify_key(key)),
        Event::Mouse(mouse) => Some(classify_mouse_live(mouse)),
        Event::Resize(cols, rows) => Some(RenderEvent {
            marker: format!("DAR_TUI_RESIZE {cols} {rows}"),
            event_line: format!("resize:{cols}x{rows}"),
            resize: Some((cols, rows)),
            exit: false,
        }),
        Event::FocusGained | Event::FocusLost | Event::Paste(_) => None,
        _ => None,
    }
}

fn classify_key(key: KeyEvent) -> RenderEvent {
    if is_plain_exit(&key) {
        return RenderEvent {
            marker: "DAR_TUI_EXIT".to_string(),
            event_line: "exit".to_string(),
            resize: None,
            exit: true,
        };
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if let KeyCode::Char(character) = key.code {
            let label = control_name(character);
            return RenderEvent {
                marker: format!("DAR_TUI_CONTROL {label}"),
                event_line: format!("control:{label}"),
                resize: None,
                exit: false,
            };
        }
    }

    match key.code {
        KeyCode::Char(' ') => RenderEvent {
            marker: "DAR_TUI_TEXT space".to_string(),
            event_line: "text:space".to_string(),
            resize: None,
            exit: false,
        },
        KeyCode::Char(character) => RenderEvent {
            marker: format!("DAR_TUI_TEXT {character}"),
            event_line: format!("text:{character}"),
            resize: None,
            exit: false,
        },
        _ => {
            let name = named_key_name(&key.code).to_string();
            RenderEvent {
                marker: format!("DAR_TUI_KEY {name}"),
                event_line: format!("key:{name}"),
                resize: None,
                exit: false,
            }
        }
    }
}

fn classify_mouse_live(mouse: MouseEvent) -> RenderEvent {
    classify_mouse_parts(
        mouse.kind,
        logical_coord_live(mouse.column),
        logical_coord_live(mouse.row),
    )
}

fn classify_mouse_scripted(kind: MouseEventKind, col: u16, row: u16) -> RenderEvent {
    classify_mouse_parts(kind, col, row)
}

fn classify_mouse_parts(kind: MouseEventKind, col: u16, row: u16) -> RenderEvent {
    let (marker, event_line) = match kind {
        MouseEventKind::Down(button) => {
            let name = mouse_button_name(button);
            (
                format!("DAR_TUI_MOUSE_PRESS {name} {col} {row}"),
                format!("mouse:press:{name}:{col}:{row}"),
            )
        }
        MouseEventKind::Up(button) => {
            let name = mouse_button_name(button);
            (
                format!("DAR_TUI_MOUSE_RELEASE {name} {col} {row}"),
                format!("mouse:release:{name}:{col}:{row}"),
            )
        }
        MouseEventKind::Drag(button) => {
            let name = mouse_button_name(button);
            (
                format!("DAR_TUI_MOUSE_MOVE {name} {col} {row}"),
                format!("mouse:move:{name}:{col}:{row}"),
            )
        }
        MouseEventKind::Moved => (
            format!("DAR_TUI_MOUSE_MOVE None {col} {row}"),
            format!("mouse:move:None:{col}:{row}"),
        ),
        MouseEventKind::ScrollUp => (
            format!("DAR_TUI_MOUSE_WHEEL_UP {col} {row}"),
            format!("mouse:wheel-up:{col}:{row}"),
        ),
        MouseEventKind::ScrollDown => (
            format!("DAR_TUI_MOUSE_WHEEL_DOWN {col} {row}"),
            format!("mouse:wheel-down:{col}:{row}"),
        ),
        MouseEventKind::ScrollLeft => (
            format!("DAR_TUI_MOUSE_WHEEL_LEFT {col} {row}"),
            format!("mouse:wheel-left:{col}:{row}"),
        ),
        MouseEventKind::ScrollRight => (
            format!("DAR_TUI_MOUSE_WHEEL_RIGHT {col} {row}"),
            format!("mouse:wheel-right:{col}:{row}"),
        ),
    };

    RenderEvent {
        marker,
        event_line,
        resize: None,
        exit: false,
    }
}

fn read_scripted_event(reader: &mut impl Read) -> io::Result<Option<RenderEvent>> {
    let Some(first) = read_byte(reader)? else {
        return Ok(None);
    };
    let event = match first {
        b'\r' => classify_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::empty())),
        0x7f => classify_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::empty())),
        0x01..=0x1a => {
            let label = control_name((first + b'a' - 1) as char);
            RenderEvent {
                marker: format!("DAR_TUI_CONTROL {label}"),
                event_line: format!("control:{label}"),
                resize: None,
                exit: false,
            }
        }
        0x1b => parse_escape_sequence(reader)?,
        byte => {
            let character = read_char(reader, byte)?;
            classify_key(KeyEvent::new(
                KeyCode::Char(character),
                KeyModifiers::empty(),
            ))
        }
    };
    Ok(Some(event))
}

fn parse_escape_sequence(reader: &mut impl Read) -> io::Result<RenderEvent> {
    let Some(next) = read_byte(reader)? else {
        return Ok(classify_key(KeyEvent::new(
            KeyCode::Esc,
            KeyModifiers::empty(),
        )));
    };
    if next != b'[' {
        return Ok(classify_key(KeyEvent::new(
            KeyCode::Esc,
            KeyModifiers::empty(),
        )));
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

    parse_csi_payload(&payload)
}

fn parse_csi_payload(payload: &[u8]) -> io::Result<RenderEvent> {
    let text = std::str::from_utf8(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    match text {
        "A" => Ok(classify_key(KeyEvent::new(
            KeyCode::Up,
            KeyModifiers::empty(),
        ))),
        "B" => Ok(classify_key(KeyEvent::new(
            KeyCode::Down,
            KeyModifiers::empty(),
        ))),
        "C" => Ok(classify_key(KeyEvent::new(
            KeyCode::Right,
            KeyModifiers::empty(),
        ))),
        "D" => Ok(classify_key(KeyEvent::new(
            KeyCode::Left,
            KeyModifiers::empty(),
        ))),
        "H" => Ok(classify_key(KeyEvent::new(
            KeyCode::Home,
            KeyModifiers::empty(),
        ))),
        "F" => Ok(classify_key(KeyEvent::new(
            KeyCode::End,
            KeyModifiers::empty(),
        ))),
        "3~" => Ok(classify_key(KeyEvent::new(
            KeyCode::Delete,
            KeyModifiers::empty(),
        ))),
        _ if text.starts_with('<') && (text.ends_with('M') || text.ends_with('m')) => {
            parse_sgr_mouse(text)
        }
        _ if text.starts_with("8;") && text.ends_with('t') => parse_resize_sequence(text),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Unsupported escape sequence: {text}"),
        )),
    }
}

fn parse_sgr_mouse(text: &str) -> io::Result<RenderEvent> {
    let released = text.ends_with('m');
    let body = text
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix(if released { 'm' } else { 'M' }))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid SGR mouse payload"))?;
    let mut parts = body.split(';');
    let code = parse_u16(parts.next())?;
    let col = parse_u16(parts.next())?;
    let row = parse_u16(parts.next())?;
    if parts.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unexpected SGR mouse fields",
        ));
    }

    let kind = if released {
        MouseEventKind::Up(button_from_sgr(code)?)
    } else if code >= 64 {
        match code {
            64 => MouseEventKind::ScrollUp,
            65 => MouseEventKind::ScrollDown,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Unsupported SGR wheel code: {code}"),
                ))
            }
        }
    } else if code >= 32 {
        MouseEventKind::Drag(button_from_sgr(code - 32)?)
    } else {
        MouseEventKind::Down(button_from_sgr(code)?)
    };

    Ok(classify_mouse_scripted(kind, col, row))
}

fn parse_resize_sequence(text: &str) -> io::Result<RenderEvent> {
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
    Ok(RenderEvent {
        marker: format!("DAR_TUI_RESIZE {cols} {rows}"),
        event_line: format!("resize:{cols}x{rows}"),
        resize: Some((cols, rows)),
        exit: false,
    })
}

fn parse_u16(value: Option<&str>) -> io::Result<u16> {
    value
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing numeric field"))?
        .parse::<u16>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn button_from_sgr(code: u16) -> io::Result<MouseButton> {
    match code & 0b11 {
        0 => Ok(MouseButton::Left),
        1 => Ok(MouseButton::Middle),
        2 => Ok(MouseButton::Right),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Unsupported SGR mouse button: {other}"),
        )),
    }
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

fn is_plain_exit(key: &KeyEvent) -> bool {
    matches!(key.code, KeyCode::Char('q')) && key.modifiers.is_empty()
}

fn control_name(character: char) -> String {
    match character {
        'a'..='z' => format!("Ctrl+{}", character.to_ascii_uppercase()),
        'A'..='Z' => format!("Ctrl+{character}"),
        other => format!("Ctrl+{other}"),
    }
}

fn named_key_name(code: &KeyCode) -> &'static str {
    match code {
        KeyCode::Enter => "Enter",
        KeyCode::Left => "ArrowLeft",
        KeyCode::Right => "ArrowRight",
        KeyCode::Up => "ArrowUp",
        KeyCode::Down => "ArrowDown",
        KeyCode::Home => "Home",
        KeyCode::End => "End",
        KeyCode::PageUp => "PageUp",
        KeyCode::PageDown => "PageDown",
        KeyCode::Tab => "Tab",
        KeyCode::BackTab => "BackTab",
        KeyCode::Delete => "Delete",
        KeyCode::Insert => "Insert",
        KeyCode::Esc => "Escape",
        KeyCode::Backspace => "Backspace",
        _ => "Unknown",
    }
}

fn logical_coord_live(value: u16) -> u16 {
    value.saturating_add(1)
}

fn mouse_button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "Left",
        MouseButton::Right => "Right",
        MouseButton::Middle => "Middle",
    }
}

#[cfg(test)]
mod tests {
    use crossterm::event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };

    use super::{
        classify_key, classify_mouse_live, control_name, logical_coord_live, named_key_name,
        parse_csi_payload, parse_resize_sequence, parse_sgr_mouse, read_char, render_lines,
        RenderEvent,
    };

    #[test]
    fn formats_key_and_mouse_labels() {
        assert_eq!(control_name('c'), "Ctrl+C");
        assert_eq!(named_key_name(&KeyCode::Up), "ArrowUp");
        assert_eq!(logical_coord_live(0), 1);
        assert_eq!(logical_coord_live(4), 5);
        assert_eq!(
            classify_key(KeyEvent::new_with_kind(
                KeyCode::Char('c'),
                KeyModifiers::CONTROL,
                KeyEventKind::Press
            )),
            RenderEvent {
                marker: "DAR_TUI_CONTROL Ctrl+C".to_string(),
                event_line: "control:Ctrl+C".to_string(),
                resize: None,
                exit: false,
            }
        );
        assert_eq!(
            classify_mouse_live(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: KeyModifiers::empty(),
            }),
            RenderEvent {
                marker: "DAR_TUI_MOUSE_PRESS Left 1 1".to_string(),
                event_line: "mouse:press:Left:1:1".to_string(),
                resize: None,
                exit: false,
            }
        );
    }

    #[test]
    fn renders_stable_ready_size_last_frame() {
        assert_eq!(
            render_lines("mouse:wheel-up:10:6", 100, 30),
            "DAR_TUI_READY\r\nsize=100x30\r\nlast=mouse:wheel-up:10:6\r\n"
        );
    }

    #[test]
    fn parses_scripted_sequences() {
        assert_eq!(
            parse_sgr_mouse("<0;1;1M").unwrap(),
            RenderEvent {
                marker: "DAR_TUI_MOUSE_PRESS Left 1 1".to_string(),
                event_line: "mouse:press:Left:1:1".to_string(),
                resize: None,
                exit: false,
            }
        );
        assert_eq!(
            parse_resize_sequence("8;30;100t").unwrap(),
            RenderEvent {
                marker: "DAR_TUI_RESIZE 100 30".to_string(),
                event_line: "resize:100x30".to_string(),
                resize: Some((100, 30)),
                exit: false,
            }
        );
        assert_eq!(
            parse_csi_payload(b"A").unwrap(),
            RenderEvent {
                marker: "DAR_TUI_KEY ArrowUp".to_string(),
                event_line: "key:ArrowUp".to_string(),
                resize: None,
                exit: false,
            }
        );
        assert_eq!(read_char(&mut &b"\x9c"[..], 0xe2).is_err(), true);
    }
}
