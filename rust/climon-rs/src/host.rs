//! `run` command: host a command in a PTY, transparently relay the local
//! terminal, capture a scrollback shadow, and serve viewers over a Unix socket.

use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::frame::{encode_frame, FrameDecoder, FrameType};
use crate::json::{cols_rows_json, exit_code_json, parse_cols_rows};
use crate::meta::Session;
use crate::scrollback::Scrollback;
use crate::term::{terminal_size, RawMode};

const SCROLLBACK_CAP: usize = 256 * 1024;

/// Shared write-side handles for every connected viewer.
type Viewers = Arc<Mutex<Vec<UnixStream>>>;

/// Writes a frame to every viewer, dropping any whose socket has errored.
fn broadcast(viewers: &Viewers, frame: &[u8]) {
    let mut guard = viewers.lock().unwrap();
    guard.retain_mut(|stream| stream.write_all(frame).and_then(|_| stream.flush()).is_ok());
}

/// Hosts `command` in a PTY and serves the session at `socket_path`. When
/// `session` is provided, its metadata file is kept up to date so the climon
/// dashboard server discovers and bridges the session. Returns the exit code.
pub fn run(
    command: &[String],
    socket_path: &Path,
    session: Option<Arc<Session>>,
) -> io::Result<i32> {
    if command.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "run requires a command to host",
        ));
    }

    // Remove any stale socket before binding; ensure its directory exists.
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path)?;
    listener.set_nonblocking(true)?;

    let (init_cols, init_rows) = terminal_size(libc::STDIN_FILENO);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: init_rows,
            cols: init_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(to_io)?;

    let mut cmd = CommandBuilder::new(&command[0]);
    for arg in &command[1..] {
        cmd.arg(arg);
    }
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(to_io)?;
    // Drop the slave so the master read returns EOF once the child exits.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(to_io)?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(to_io)?));
    let master = Arc::new(Mutex::new(pair.master));

    let viewers: Viewers = Arc::new(Mutex::new(Vec::new()));
    let scrollback = Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_CAP)));
    let running = Arc::new(AtomicBool::new(true));
    let applied_size = Arc::new(Mutex::new((init_cols, init_rows)));

    // Put the local terminal into raw mode for the duration of the session.
    let _raw = RawMode::enable(libc::STDIN_FILENO)?;

    // --- PTY reader thread: stdout + scrollback + broadcast Output ---
    let reader_handle = {
        let viewers = Arc::clone(&viewers);
        let scrollback = Arc::clone(&scrollback);
        thread::spawn(move || pty_reader_loop(reader, viewers, scrollback))
    };

    // --- Local stdin thread: forward keystrokes to the PTY ---
    {
        let writer = Arc::clone(&writer);
        let running = Arc::clone(&running);
        thread::spawn(move || stdin_loop(writer, running));
    }

    // --- SIGWINCH thread: propagate local resizes to the PTY + viewers ---
    {
        let master = Arc::clone(&master);
        let viewers = Arc::clone(&viewers);
        let applied_size = Arc::clone(&applied_size);
        let session = session.clone();
        thread::spawn(move || winch_loop(master, viewers, applied_size, session));
    }

    // --- IPC accept thread ---
    {
        let viewers = Arc::clone(&viewers);
        let scrollback = Arc::clone(&scrollback);
        let writer = Arc::clone(&writer);
        let master = Arc::clone(&master);
        let applied_size = Arc::clone(&applied_size);
        let running = Arc::clone(&running);
        let session = session.clone();
        thread::spawn(move || {
            accept_loop(
                listener,
                viewers,
                scrollback,
                writer,
                master,
                applied_size,
                running,
                session,
            )
        });
    }

    // --- Wait for the child to exit ---
    let status = child.wait().map_err(to_io)?;
    let code = status.exit_code() as i32;
    running.store(false, Ordering::SeqCst);

    // Best-effort: let the reader thread drain the final output.
    let _ = reader_handle.join();

    if let Some(session) = &session {
        session.complete(code);
    }

    broadcast(
        &viewers,
        &encode_frame(FrameType::Exit, exit_code_json(code).as_bytes()),
    );
    {
        let mut guard = viewers.lock().unwrap();
        for stream in guard.drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
    let _ = std::fs::remove_file(socket_path);

    Ok(code)
}

fn pty_reader_loop(
    mut reader: Box<dyn Read + Send>,
    viewers: Viewers,
    scrollback: Arc<Mutex<Scrollback>>,
) {
    let mut buf = [0u8; 8192];
    let stdout = io::stdout();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let data = &buf[..n];
                {
                    let mut out = stdout.lock();
                    let _ = out.write_all(data);
                    let _ = out.flush();
                }
                scrollback.lock().unwrap().append(data);
                broadcast(&viewers, &encode_frame(FrameType::Output, data));
            }
        }
    }
}

fn stdin_loop(writer: Arc<Mutex<Box<dyn Write + Send>>>, running: Arc<AtomicBool>) {
    let mut buf = [0u8; 4096];
    while running.load(Ordering::SeqCst) {
        let n = unsafe {
            libc::read(
                libc::STDIN_FILENO,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len(),
            )
        };
        if n <= 0 {
            break;
        }
        let data = &buf[..n as usize];
        let mut w = writer.lock().unwrap();
        if w.write_all(data).is_err() || w.flush().is_err() {
            break;
        }
    }
}

fn winch_loop(
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    viewers: Viewers,
    applied_size: Arc<Mutex<(u16, u16)>>,
    session: Option<Arc<Session>>,
) {
    use signal_hook::consts::SIGWINCH;
    use signal_hook::iterator::Signals;
    let mut signals = match Signals::new([SIGWINCH]) {
        Ok(s) => s,
        Err(_) => return,
    };
    for _ in signals.forever() {
        let (cols, rows) = terminal_size(libc::STDIN_FILENO);
        apply_resize(&master, &viewers, &applied_size, cols, rows, &session);
    }
}

/// Applies a new PTY size and notifies viewers if it changed.
fn apply_resize(
    master: &Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    viewers: &Viewers,
    applied_size: &Arc<Mutex<(u16, u16)>>,
    cols: u16,
    rows: u16,
    session: &Option<Arc<Session>>,
) {
    let cols = cols.max(1);
    let rows = rows.max(1);
    {
        let mut size = applied_size.lock().unwrap();
        if *size == (cols, rows) {
            return;
        }
        *size = (cols, rows);
    }
    let _ = master.lock().unwrap().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    if let Some(session) = session {
        session.update_size(cols, rows);
    }
    broadcast(
        viewers,
        &encode_frame(FrameType::PtySize, cols_rows_json(cols, rows).as_bytes()),
    );
}

#[allow(clippy::too_many_arguments)]
fn accept_loop(
    listener: UnixListener,
    viewers: Viewers,
    scrollback: Arc<Mutex<Scrollback>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    applied_size: Arc<Mutex<(u16, u16)>>,
    running: Arc<AtomicBool>,
    session: Option<Arc<Session>>,
) {
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let _ = stream.set_nonblocking(false);
                on_viewer_connect(
                    stream,
                    &viewers,
                    &scrollback,
                    &writer,
                    &master,
                    &applied_size,
                    &running,
                    &session,
                );
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn on_viewer_connect(
    stream: UnixStream,
    viewers: &Viewers,
    scrollback: &Arc<Mutex<Scrollback>>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    master: &Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    applied_size: &Arc<Mutex<(u16, u16)>>,
    running: &Arc<AtomicBool>,
    session: &Option<Arc<Session>>,
) {
    let mut write_handle = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };

    // Send the current size and a replay of the scrollback shadow.
    let (cols, rows) = *applied_size.lock().unwrap();
    let snapshot = scrollback.lock().unwrap().snapshot();
    let _ = write_handle.write_all(&encode_frame(
        FrameType::PtySize,
        cols_rows_json(cols, rows).as_bytes(),
    ));
    let _ = write_handle.write_all(&encode_frame(FrameType::Replay, &snapshot));
    let _ = write_handle.flush();

    viewers.lock().unwrap().push(write_handle);

    // Per-connection reader: forward Input to the PTY, apply Resize.
    let writer = Arc::clone(writer);
    let master = Arc::clone(master);
    let viewers = Arc::clone(viewers);
    let applied_size = Arc::clone(applied_size);
    let running = Arc::clone(running);
    let session = session.clone();
    thread::spawn(move || {
        viewer_reader_loop(
            stream,
            writer,
            master,
            viewers,
            applied_size,
            running,
            session,
        )
    });
}

#[allow(clippy::too_many_arguments)]
fn viewer_reader_loop(
    mut stream: UnixStream,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    viewers: Viewers,
    applied_size: Arc<Mutex<(u16, u16)>>,
    running: Arc<AtomicBool>,
    session: Option<Arc<Session>>,
) {
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 4096];
    while running.load(Ordering::SeqCst) {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for frame in decoder.push(&buf[..n]) {
                    match frame.frame_type {
                        FrameType::Input => {
                            let mut w = writer.lock().unwrap();
                            let _ = w.write_all(&frame.payload);
                            let _ = w.flush();
                        }
                        FrameType::Resize => {
                            if let Some((cols, rows)) = parse_cols_rows(&frame.payload) {
                                apply_resize(
                                    &master,
                                    &viewers,
                                    &applied_size,
                                    cols,
                                    rows,
                                    &session,
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

/// Default per-session socket path under the system temp dir.
pub fn default_socket_path(session: &str) -> PathBuf {
    std::env::temp_dir().join(format!("climon-rs-{}.sock", session))
}
