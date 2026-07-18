//! Shared harness for the real-PTY/socket session-host tests.
//!
//! Both the per-engine integration suite (`session_integration.rs`) and the
//! legacy/actor parity suite (`engine_parity.rs`) drive the *same* scenarios
//! through this module. Each scenario spins up the real daemon
//! ([`run_session_host`]) against a real `sh -c` command, binds a real socket,
//! connects a client, and records everything observable — the frames the
//! client receives, the persisted [`SessionMeta`], the host exit code, and any
//! status transitions polled from the store — into a [`ScenarioTrace`].
//!
//! The engine is selected per run through the `CLIMON_SESSION_ENGINE`
//! environment variable that [`run_session_host`] reads, so one scenario body
//! serves both engines. [`ScenarioTrace::normalized`] then strips the
//! nondeterministic identities (socket ports, home paths, pids, wall-clock
//! timestamps) and transport-level framing artefacts (pty-output chunking, the
//! replay-vs-live-output race) that legitimately vary run to run, while
//! preserving every semantic observation — frame types and order, dimensions,
//! controller ids, statuses, metadata, and the exact relayed terminal bytes —
//! so a parity assertion only fails on a real behavioural difference.
//!
//! # Unix-only
//!
//! Like `session_integration.rs`, every scenario joins the host thread, which
//! blocks in the daemon's `Pty::wait()` until the child exits. That never
//! returns under a headless ConPTY, so these scenarios run on Unix only. The
//! normalization/observation types are platform-agnostic and still compile on
//! Windows.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use climon_proto::frame::{
    encode_json_frame, parse_json_payload, AttentionPayload, ControlPayload, DecodedFrame,
    ExitPayload, FrameDecoder, FrameType, PtySizePayload, ResizePayload, TitlePayload,
};
use climon_proto::meta::{PriorityReason, SessionMeta, SessionStatus, TerminalProgress};
use climon_session::socket::{
    allocate_loopback_port, connect_session_socket, format_session_socket_ref, SessionStream,
};
use climon_session::{run_session_host, SessionHostOptions};
use climon_store::meta::read_session_meta;
use climon_store::Env;

/// The environment variable [`run_session_host`] reads to pick an engine.
const ENGINE_ENV: &str = "CLIMON_SESSION_ENGINE";

/// Which session engine a scenario drives. A single scenario body runs against
/// both by toggling [`ENGINE_ENV`].
#[derive(Clone, Copy, Debug)]
pub enum TestEngine {
    Legacy,
    Actor,
}

impl TestEngine {
    /// The `CLIMON_SESSION_ENGINE` value that selects this engine.
    pub fn env_value(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Actor => "actor",
        }
    }
}

/// Serializes scenarios that mutate the global `CLIMON_HOME` / engine env vars.
pub fn serial() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique scratch dir under `target/` (never the system temp dir).
pub fn scratch_home(tag: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let target = exe
        .ancestors()
        .find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("cwd"));
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let home = target
        .join("climon-session-test-tmp")
        .join(format!("{tag}-{}-{nanos}-{n}", std::process::id()));
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    home
}

/// Builds the initial session metadata the launcher would have written, pinned
/// to a fresh loopback socket so parallel homes never collide.
pub fn base_meta(id: &str, home: &PathBuf, command: Vec<String>) -> SessionMeta {
    let now = climon_store::paths::now_iso();
    // Use a TCP loopback ref: Unix-socket paths under target/ exceed macOS SUN_LEN.
    let port = allocate_loopback_port("127.0.0.1").unwrap();
    let socket = format_session_socket_ref("127.0.0.1", port);
    let meta = SessionMeta {
        id: id.to_string(),
        command: command.clone(),
        display_command: command.join(" "),
        cwd: home.to_string_lossy().into_owned(),
        status: SessionStatus::Running,
        priority_reason: PriorityReason::Running,
        daemon_pid: None,
        cols: 80,
        rows: 24,
        headless: Some(true),
        socket_path: socket,
        client_version: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_activity_at: now,
        attention_matched_at: None,
        attention_reason: None,
        completed_at: None,
        exit_code: None,
        error: None,
        origin: None,
        client_label: None,
        name: None,
        priority: None,
        color: None,
        theme: None,
        user_paused: None,
        terminal_title: None,
        attention_snippet: None,
        progress: None,
    };
    let env = Env::with_home(home);
    climon_store::meta::write_session_meta(&env, &meta).unwrap();
    meta
}

/// Spawns the daemon on its own thread for `engine`, returning a handle that
/// yields the child's exit code. The engine and home are pinned inside the
/// thread so the daemon reads them at startup regardless of what other
/// scenarios set on the shared process env.
fn spawn_host(engine: TestEngine, id: &str, meta: SessionMeta, home: &Path) -> JoinHandle<i32> {
    let id = id.to_string();
    let home = home.to_path_buf();
    let engine = engine.env_value();
    thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &home);
        std::env::set_var(ENGINE_ENV, engine);
        run_session_host(&id, meta, SessionHostOptions { headless: true }).unwrap()
    })
}

/// Connects a client to `socket_ref`, returning a non-blocking stream so reads
/// honor deadlines instead of blocking forever when a frame never arrives.
///
/// Retries the real connection directly rather than probing with
/// [`wait_for_session_socket`] (whose throwaway probe socket would consume the
/// daemon's first client id), so the returned stream is deterministically the
/// session's `client-0`.
fn connect_client(socket_ref: &str) -> Box<dyn SessionStream> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match connect_session_socket(socket_ref) {
            Ok(stream) => {
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream.set_nonblocking(true).unwrap();
                return stream;
            }
            Err(e) => {
                if Instant::now() >= deadline {
                    panic!("connect to session socket {socket_ref}: {e}");
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// Writes `bytes` to `stream`, retrying transient would-block/timeout errors up
/// to a short deadline. Frames sent here are tiny (resize/attention/replay), so
/// one write normally suffices.
fn send_frame(stream: &mut Box<dyn SessionStream>, bytes: &[u8]) {
    let mut written = 0;
    let deadline = Instant::now() + Duration::from_secs(2);
    while written < bytes.len() && Instant::now() < deadline {
        match stream.write(&bytes[written..]) {
            Ok(0) => break,
            Ok(n) => written += n,
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
}

/// Reads frames into `out` until `done` returns true for one (returning
/// `true`), the socket reports EOF, or `deadline` passes (returning `false`).
fn read_frames_until<F>(
    stream: &mut Box<dyn SessionStream>,
    decoder: &mut FrameDecoder,
    out: &mut Vec<DecodedFrame>,
    deadline: Instant,
    mut done: F,
) -> bool
where
    F: FnMut(&DecodedFrame) -> bool,
{
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        match stream.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => {
                for frame in decoder.push(&buf[..n]) {
                    let hit = done(&frame);
                    out.push(frame);
                    if hit {
                        return true;
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
    false
}

/// Polls the persisted session status until `predicate` matches or `deadline`
/// passes, returning the matching [`SessionMeta`].
fn wait_for_meta<F>(env: &Env, id: &str, deadline: Instant, mut predicate: F) -> Option<SessionMeta>
where
    F: FnMut(&SessionMeta) -> bool,
{
    while Instant::now() < deadline {
        if let Ok(Some(meta)) = read_session_meta(env, id) {
            if predicate(&meta) {
                return Some(meta);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    None
}

// ---- observable trace --------------------------------------------------

/// Everything a scenario observed about one real session run.
#[derive(Debug, Clone)]
pub struct ScenarioTrace {
    /// Every frame the client received, in wire order.
    frames: Vec<DecodedFrame>,
    /// The session metadata persisted after the run reached its captured state.
    final_meta: Option<SessionMeta>,
    /// The child's exit code, when the scenario joined the host.
    host_exit_code: Option<i32>,
    /// Distinct session statuses observed while driving the scenario, in order.
    statuses: Vec<SessionStatus>,
}

impl ScenarioTrace {
    /// Whether a `PtySize` frame with the given dimensions was received.
    pub fn saw_pty_size(&self, cols: u16, rows: u16) -> bool {
        self.frames.iter().any(|f| {
            f.frame_type == FrameType::PtySize
                && parse_json_payload::<PtySizePayload>(&f.payload)
                    .map(|p| (p.cols, p.rows) == (cols, rows))
                    .unwrap_or(false)
        })
    }

    /// Whether at least one `Replay` frame was received.
    pub fn saw_replay(&self) -> bool {
        self.frames
            .iter()
            .any(|f| f.frame_type == FrameType::Replay)
    }

    /// Whether an `Exit` frame carrying `exit_code` was received.
    pub fn saw_exit(&self, exit_code: i32) -> bool {
        self.frames.iter().any(|f| {
            f.frame_type == FrameType::Exit
                && parse_json_payload::<ExitPayload>(&f.payload)
                    .map(|p| p.exit_code == exit_code)
                    .unwrap_or(false)
        })
    }

    /// The relayed terminal bytes: every `Replay` and `Output` payload
    /// concatenated in wire order. Independent of how the daemon split output
    /// into frames and of the replay-vs-live-output race.
    pub fn terminal_output(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for f in &self.frames {
            if matches!(f.frame_type, FrameType::Replay | FrameType::Output) {
                out.extend_from_slice(&f.payload);
            }
        }
        out
    }

    /// The persisted metadata captured for the run, if any.
    pub fn final_meta(&self) -> Option<&SessionMeta> {
        self.final_meta.as_ref()
    }

    /// The joined host exit code, if the scenario joined the host.
    pub fn host_exit_code(&self) -> Option<i32> {
        self.host_exit_code
    }

    /// The observed distinct status transitions, in order.
    pub fn statuses(&self) -> &[SessionStatus] {
        &self.statuses
    }

    /// Projects the raw observations onto their engine-independent normal form
    /// so two runs can be compared for a real behavioural difference.
    pub fn normalized(&self) -> NormalizedTrace {
        let mut frames = Vec::new();
        let mut terminal_output = Vec::new();
        let mut saw_replay = false;
        for f in &self.frames {
            match f.frame_type {
                // Live output is transport-chunked and racy relative to the
                // replay snapshot; its *content* is compared via
                // `terminal_output`, not its framing, so it carries no
                // sequence marker.
                FrameType::Output => terminal_output.extend_from_slice(&f.payload),
                // The replay snapshot is a deterministic initial frame; keep its
                // marker for ordering, and fold its bytes into the terminal
                // content (the scrollback the client renders).
                FrameType::Replay => {
                    saw_replay = true;
                    terminal_output.extend_from_slice(&f.payload);
                    frames.push(NormFrame::Replay);
                }
                FrameType::PtySize => {
                    let p: PtySizePayload = parse_json_payload(&f.payload).unwrap();
                    frames.push(NormFrame::PtySize {
                        cols: p.cols,
                        rows: p.rows,
                    });
                }
                FrameType::Control => {
                    let p: ControlPayload = parse_json_payload(&f.payload).unwrap();
                    frames.push(NormFrame::Control {
                        controller_id: p.controller_id,
                        cols: p.cols,
                        rows: p.rows,
                    });
                }
                FrameType::Attention => {
                    let p: AttentionPayload = parse_json_payload(&f.payload).unwrap();
                    frames.push(NormFrame::Attention {
                        needs_attention: p.needs_attention,
                        reason: p.reason,
                        matched_present: p.attention_matched_at.is_some(),
                    });
                }
                FrameType::Title => {
                    let p: TitlePayload = parse_json_payload(&f.payload).unwrap();
                    frames.push(NormFrame::Title { name: p.name });
                }
                FrameType::Exit => {
                    let p: ExitPayload = parse_json_payload(&f.payload).unwrap();
                    frames.push(NormFrame::Exit {
                        exit_code: p.exit_code,
                    });
                }
                other => frames.push(NormFrame::Other(other as u8)),
            }
        }
        NormalizedTrace {
            frames,
            terminal_output: collapse_cr_runs(&terminal_output),
            saw_replay,
            meta: self.final_meta.as_ref().map(NormMeta::from_meta),
            host_exit_code: self.host_exit_code,
            statuses: self.statuses.clone(),
        }
    }
}

/// Collapses runs of carriage returns to a single `\r`.
///
/// A PTY under output backpressure (a fast child, a slow or wedged reader)
/// nondeterministically emits an extra `\r` before some `\r\n` line endings; the
/// count varies run to run and, for the same reason, between engines. Both hosts
/// relay raw PTY bytes verbatim — neither ever rewrites the output stream — so a
/// difference in `\r`-run length is always a terminal-timing artefact, never a
/// daemon behavioural difference. Collapsing the runs removes that artefact
/// while preserving every payload byte, line boundary, and control sequence, so
/// exact-content parity stays meaningful for large streamed output.
fn collapse_cr_runs(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut prev_cr = false;
    for &b in bytes {
        if b == b'\r' && prev_cr {
            continue;
        }
        prev_cr = b == b'\r';
        out.push(b);
    }
    out
}

/// A control-plane frame in engine-independent form. `Output` frames are
/// deliberately absent (their content lives in
/// [`NormalizedTrace::terminal_output`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormFrame {
    PtySize {
        cols: u16,
        rows: u16,
    },
    Replay,
    Control {
        controller_id: String,
        cols: u16,
        rows: u16,
    },
    Attention {
        needs_attention: bool,
        reason: Option<String>,
        matched_present: bool,
    },
    Title {
        name: String,
    },
    Exit {
        exit_code: i32,
    },
    Other(u8),
}

/// The semantic subset of [`SessionMeta`] compared across engines: identities,
/// paths, and wall-clock timestamps are dropped; timestamp *presence* is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormMeta {
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub completed_present: bool,
    pub attention_matched_present: bool,
    pub attention_reason: Option<String>,
    pub error: Option<String>,
    pub terminal_title: Option<String>,
    pub progress: Option<TerminalProgress>,
    pub cols: u16,
    pub rows: u16,
    pub priority_reason: PriorityReason,
}

impl NormMeta {
    fn from_meta(m: &SessionMeta) -> Self {
        NormMeta {
            status: m.status,
            exit_code: m.exit_code,
            completed_present: m.completed_at.is_some(),
            attention_matched_present: m.attention_matched_at.is_some(),
            attention_reason: m.attention_reason.clone(),
            error: m.error.clone(),
            terminal_title: m.terminal_title.clone(),
            progress: m.progress,
            cols: m.cols,
            rows: m.rows,
            priority_reason: m.priority_reason,
        }
    }
}

/// The engine-independent normal form of a [`ScenarioTrace`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTrace {
    pub frames: Vec<NormFrame>,
    pub terminal_output: Vec<u8>,
    pub saw_replay: bool,
    pub meta: Option<NormMeta>,
    pub host_exit_code: Option<i32>,
    pub statuses: Vec<SessionStatus>,
}

// ---- scenarios ---------------------------------------------------------

/// Streams the initial frames for a short-lived command that prints `hello`
/// then exits cleanly, capturing frames through `Exit`, the joined exit code,
/// and the final `Completed` metadata.
pub fn run_initial_frames_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("initial-frames");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "alpha-beta-gamma";
    let meta = base_meta(
        id,
        &home,
        vec!["sh".into(), "-c".into(), "printf hello; sleep 1.5".into()],
    );
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);

    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    read_frames_until(&mut stream, &mut decoder, &mut frames, deadline, |f| {
        f.frame_type == FrameType::Exit
    });

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(stream);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the initial-frames scenario.
pub fn assert_initial_frames(trace: &ScenarioTrace) {
    assert!(trace.saw_pty_size(80, 24), "received PtySize 80x24");
    assert!(trace.saw_replay(), "received Replay");
    assert!(
        trace.terminal_output().windows(5).any(|w| w == b"hello"),
        "received hello via Replay or Output"
    );
    assert!(trace.saw_exit(0), "received Exit 0");
    assert_eq!(trace.host_exit_code(), Some(0), "session exit code");
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.status, SessionStatus::Completed);
    assert_eq!(meta.exit_code, Some(0));
    assert!(meta.completed_at.is_some());
}

/// Runs a command that exits non-zero (no client attaches) and captures the
/// joined exit code plus the persisted `Failed` metadata.
pub fn run_failed_exit_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("failed-lifecycle");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "delta-echo-foxtrot";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "exit 3".into()]);

    let host = spawn_host(engine, id, meta, &home);
    let host_exit_code = host.join().ok();

    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames: Vec::new(),
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the failed-exit scenario.
pub fn assert_failed_exit(trace: &ScenarioTrace) {
    assert_eq!(trace.host_exit_code(), Some(3), "session exit code");
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.status, SessionStatus::Failed);
    assert_eq!(meta.exit_code, Some(3));
}

/// Connects a viewer, waits for its initial frames, then sends a `Resize`
/// larger than the host and captures the broadcast `PtySize`/`Control` growth
/// through the clean exit.
pub fn run_viewer_resize_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("viewer-resize");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "golf-hotel-india";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 2".into()]);
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);

    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    // Drain the deterministic initial prefix (PtySize, Replay) before resizing
    // so the post-resize frames follow in a fixed order for both engines.
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| f.frame_type == FrameType::Replay,
    );

    // A viewer resize larger than the host; the PTY grows to fit it. `viewer_id`
    // is omitted so the client keeps its default `client-0` identity.
    let resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 120,
            rows: 40,
            kind: None,
            viewer_id: None,
        },
    );
    send_frame(&mut stream, &resize);

    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(5),
        |f| f.frame_type == FrameType::Exit,
    );

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(stream);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the viewer-resize scenario.
pub fn assert_viewer_resize(trace: &ScenarioTrace) {
    assert!(trace.saw_pty_size(80, 24), "initial PtySize 80x24");
    assert!(
        trace.saw_pty_size(120, 40),
        "viewer Fill resize broadcast 120x40"
    );
    let control_120 = trace.normalized().frames.iter().any(|f| {
        matches!(
            f,
            NormFrame::Control { controller_id, cols, rows }
                if controller_id == "client-0" && *cols == 120 && *rows == 40
        )
    });
    assert!(control_120, "controller broadcast at 120x40");
    assert!(trace.saw_exit(0), "clean exit after resize");
}

/// Writes an idle-attention config, waits for the detector to flag
/// needs-attention, acknowledges with the matching token, and records the
/// resulting status timeline and the cleared `Acknowledged` metadata.
pub fn run_attention_clear_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("attention-clear");
    std::env::set_var("CLIMON_HOME", &home);
    std::fs::write(
        home.join("config.jsonc"),
        "{ \"attention\": { \"idleSeconds\": 1 } }\n",
    )
    .unwrap();

    let id = "juliet-kilo-lima";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 6".into()]);
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);
    let env = Env::with_home(&home);

    let mut statuses = Vec::new();

    let flagged = wait_for_meta(&env, id, Instant::now() + Duration::from_secs(8), |m| {
        m.status == SessionStatus::NeedsAttention
    });
    let token = flagged.and_then(|m| {
        statuses.push(SessionStatus::NeedsAttention);
        m.attention_matched_at
    });

    if let Some(token) = token {
        let ack = encode_json_frame(
            FrameType::Attention,
            &AttentionPayload {
                needs_attention: false,
                reason: None,
                attention_matched_at: Some(token),
            },
        );
        send_frame(&mut stream, &ack);
    }

    let cleared = wait_for_meta(&env, id, Instant::now() + Duration::from_secs(5), |m| {
        m.attention_matched_at.is_none()
            && m.attention_reason.is_none()
            && m.status == SessionStatus::Acknowledged
    });
    if cleared.is_some() {
        statuses.push(SessionStatus::Acknowledged);
    }
    let final_meta = cleared;

    drop(stream);
    let _ = host.join();
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames: Vec::new(),
        final_meta,
        host_exit_code: None,
        statuses,
    }
}

/// Concrete per-engine expectations for the attention-clear scenario.
pub fn assert_attention_clear(trace: &ScenarioTrace) {
    assert_eq!(
        trace.statuses(),
        &[SessionStatus::NeedsAttention, SessionStatus::Acknowledged],
        "needs-attention then acknowledged"
    );
    let meta = trace.final_meta().expect("cleared meta persisted");
    assert!(meta.attention_matched_at.is_none());
    assert!(meta.attention_reason.is_none());
    assert_eq!(meta.status, SessionStatus::Acknowledged);
}

/// Flags attention, acknowledges it, then resizes and idles again, capturing
/// that the session stays `Acknowledged` (never reverts or re-flags).
pub fn run_acknowledged_sticky_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("ack-sticky");
    std::env::set_var("CLIMON_HOME", &home);
    std::fs::write(
        home.join("config.jsonc"),
        "{ \"attention\": { \"idleSeconds\": 1 } }\n",
    )
    .unwrap();

    let id = "mike-november-oscar";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 8".into()]);
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);
    let env = Env::with_home(&home);

    let mut statuses = Vec::new();

    let flagged = wait_for_meta(&env, id, Instant::now() + Duration::from_secs(8), |m| {
        m.status == SessionStatus::NeedsAttention
    });
    let token = flagged.and_then(|m| {
        statuses.push(SessionStatus::NeedsAttention);
        m.attention_matched_at
    });

    if let Some(token) = token {
        let ack = encode_json_frame(
            FrameType::Attention,
            &AttentionPayload {
                needs_attention: false,
                reason: None,
                attention_matched_at: Some(token),
            },
        );
        send_frame(&mut stream, &ack);
    }

    let acknowledged = wait_for_meta(&env, id, Instant::now() + Duration::from_secs(5), |m| {
        m.status == SessionStatus::Acknowledged
    });
    if acknowledged.is_some() {
        statuses.push(SessionStatus::Acknowledged);
    }

    // A host resize changes the grid dimensions but not the (empty) body.
    let resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 100,
            rows: 30,
            kind: None,
            viewer_id: None,
        },
    );
    send_frame(&mut stream, &resize);

    // Across several idle windows the session must neither revert to Running nor
    // re-flag needs-attention while its screen stays idle.
    let mut stayed_acknowledged = acknowledged.is_some();
    let mut final_meta = acknowledged;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(m)) = read_session_meta(&env, id) {
            if m.status != SessionStatus::Acknowledged {
                stayed_acknowledged = false;
            }
            final_meta = Some(m);
        }
        thread::sleep(Duration::from_millis(200));
    }
    if stayed_acknowledged {
        statuses.push(SessionStatus::Acknowledged);
    }

    drop(stream);
    let _ = host.join();
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames: Vec::new(),
        final_meta,
        host_exit_code: None,
        statuses,
    }
}

/// Concrete per-engine expectations for the acknowledged-sticky scenario.
pub fn assert_acknowledged_sticky(trace: &ScenarioTrace) {
    assert_eq!(
        trace.statuses(),
        &[
            SessionStatus::NeedsAttention,
            SessionStatus::Acknowledged,
            SessionStatus::Acknowledged,
        ],
        "acknowledged session stays acknowledged across a resize and idle"
    );
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.status, SessionStatus::Acknowledged);
}

/// Reads frames into `out` until the accumulated `Replay`/`Output` bytes
/// contain `needle`, `deadline` passes, or the socket closes. Returns whether
/// `needle` was found.
fn read_until_output_contains(
    stream: &mut Box<dyn SessionStream>,
    decoder: &mut FrameDecoder,
    out: &mut Vec<DecodedFrame>,
    deadline: Instant,
    needle: &[u8],
) -> bool {
    let mut acc: Vec<u8> = out
        .iter()
        .filter(|f| matches!(f.frame_type, FrameType::Replay | FrameType::Output))
        .flat_map(|f| f.payload.clone())
        .collect();
    if acc.windows(needle.len()).any(|w| w == needle) {
        return true;
    }
    let mut found = false;
    read_frames_until(stream, decoder, out, deadline, |f| {
        if matches!(f.frame_type, FrameType::Replay | FrameType::Output) {
            acc.extend_from_slice(&f.payload);
            if acc.windows(needle.len()).any(|w| w == needle) {
                found = true;
            }
        }
        found
    });
    found
}

/// Connects a viewer, waits until the printed scrollback (`ready`) is present,
/// then sends a `Replay` request and captures the on-demand `PtySize`/`Replay`
/// re-send through the clean exit.
pub fn run_replay_request_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("replay-request");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "papa-quebec-romeo";
    let meta = base_meta(
        id,
        &home,
        vec!["sh".into(), "-c".into(), "printf ready; sleep 1".into()],
    );
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);

    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    // Ensure the scrollback holds `ready` before requesting a replay, so the
    // on-demand snapshot is identical for both engines.
    read_until_output_contains(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        b"ready",
    );

    let replay = climon_proto::frame::encode_frame(FrameType::Replay, &[]);
    send_frame(&mut stream, &replay);

    // The on-demand response is `PtySize` then a second `Replay`.
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| f.frame_type == FrameType::Replay,
    );
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(5),
        |f| f.frame_type == FrameType::Exit,
    );

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(stream);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the replay-request scenario.
pub fn assert_replay_request(trace: &ScenarioTrace) {
    let replays = trace
        .normalized()
        .frames
        .iter()
        .filter(|f| matches!(f, NormFrame::Replay))
        .count();
    assert!(replays >= 2, "initial plus on-demand Replay ({replays})");
    assert!(trace.saw_pty_size(80, 24), "PtySize on the replay response");
    assert!(
        trace.terminal_output().windows(5).any(|w| w == b"ready"),
        "replay snapshot carries scrollback"
    );
    assert!(trace.saw_exit(0), "clean exit");
}

/// Whether `frame` is a `Control` naming `controller_id` at `cols`x`rows`.
fn is_control(frame: &DecodedFrame, controller_id: &str, cols: u16, rows: u16) -> bool {
    frame.frame_type == FrameType::Control
        && parse_json_payload::<ControlPayload>(&frame.payload)
            .map(|p| p.controller_id == controller_id && p.cols == cols && p.rows == rows)
            .unwrap_or(false)
}

/// Two dashboards contend for control: the first (`client-0`) resizes and takes
/// the grid, the second (`client-1`) takes control, then disconnects so control
/// falls back to the first. Records the first client's view of the transitions.
pub fn run_take_control_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("take-control");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "sierra-tango-uniform";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 3".into()]);
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);

    // The observer stays connected; its frames are the recorded trace.
    let mut a = connect_client(&socket_ref);
    let mut a_dec = FrameDecoder::new();
    let mut frames = Vec::new();
    read_frames_until(
        &mut a,
        &mut a_dec,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| f.frame_type == FrameType::Replay,
    );

    // The observer resizes and thereby becomes the controller at 100x30.
    let a_resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 100,
            rows: 30,
            kind: None,
            viewer_id: None,
        },
    );
    send_frame(&mut a, &a_resize);
    read_frames_until(
        &mut a,
        &mut a_dec,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| is_control(f, "client-0", 100, 30),
    );

    // A second dashboard connects and reports a larger size.
    let mut b = connect_client(&socket_ref);
    let b_resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 110,
            rows: 40,
            kind: None,
            viewer_id: None,
        },
    );
    send_frame(&mut b, &b_resize);

    // The second dashboard takes control; the observer sees the handoff to
    // client-1 at 110x40.
    let take = climon_proto::frame::encode_frame(FrameType::TakeControl, &[]);
    send_frame(&mut b, &take);
    read_frames_until(
        &mut a,
        &mut a_dec,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| is_control(f, "client-1", 110, 40),
    );

    // The controller disconnects; control falls back to the observer at 100x30.
    drop(b);
    read_frames_until(
        &mut a,
        &mut a_dec,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| is_control(f, "client-0", 100, 30),
    );

    read_frames_until(
        &mut a,
        &mut a_dec,
        &mut frames,
        Instant::now() + Duration::from_secs(5),
        |f| f.frame_type == FrameType::Exit,
    );

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(a);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// The distinct controller ids the observer saw, collapsing the idempotent
/// repeat broadcasts into the semantic handoff sequence.
fn controller_transitions(trace: &ScenarioTrace) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in &trace.normalized().frames {
        if let NormFrame::Control { controller_id, .. } = f {
            if out.last() != Some(controller_id) {
                out.push(controller_id.clone());
            }
        }
    }
    out
}

/// Concrete per-engine expectations for the take-control scenario.
pub fn assert_take_control(trace: &ScenarioTrace) {
    assert_eq!(
        controller_transitions(trace),
        vec![
            "client-0".to_string(),
            "client-1".to_string(),
            "client-0".to_string()
        ],
        "observer -> controller handoff -> fallback to observer"
    );
    assert!(trace.saw_exit(0), "clean exit");
}

/// A healthy client and a wedged client (never reads) share the session while a
/// large output burst streams. The healthy client must receive the whole
/// stream and the exit even though the wedged client's socket buffer fills and
/// it then disconnects — proving per-client writers are isolated.
pub fn run_slow_client_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("slow-client");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "uniform-victor-whiskey";
    // Delay the burst so both clients are connected before output starts (so the
    // healthy client receives it all as live `Output`, never a capped replay),
    // then emit well over one socket buffer and exit.
    let meta = base_meta(
        id,
        &home,
        vec![
            "sh".into(),
            "-c".into(),
            "sleep 1; yes slow-client-payload | head -n 20000; sleep 1".into(),
        ],
    );
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);

    let mut healthy = connect_client(&socket_ref);
    let mut dec = FrameDecoder::new();
    let mut frames = Vec::new();
    read_frames_until(
        &mut healthy,
        &mut dec,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| f.frame_type == FrameType::Replay,
    );

    // The wedged client connects and never reads a single byte.
    let slow = connect_client(&socket_ref);

    // The healthy client drains the whole burst through the exit.
    read_frames_until(
        &mut healthy,
        &mut dec,
        &mut frames,
        Instant::now() + Duration::from_secs(8),
        |f| f.frame_type == FrameType::Exit,
    );

    // The wedged client goes away without ever having read.
    drop(slow);

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(healthy);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the slow-client scenario.
pub fn assert_slow_client(trace: &ScenarioTrace) {
    // The full burst is ~440 KB; a stalled/serialized daemon would truncate the
    // healthy client well below one socket buffer.
    assert!(
        trace.terminal_output().len() >= 300_000,
        "healthy client received the whole burst ({} bytes)",
        trace.terminal_output().len()
    );
    assert!(
        trace
            .terminal_output()
            .windows(19)
            .any(|w| w == b"slow-client-payload"),
        "healthy client received the payload"
    );
    assert!(
        trace.saw_exit(0),
        "healthy client received Exit despite the wedged peer"
    );
}

/// Emits an OSC title and an OSC 9;4 progress sequence, then idles briefly so the
/// daemon persists both to metadata, then exits — capturing the title/progress
/// metadata carried through to completion.
pub fn run_title_progress_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("title-progress");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "whiskey-xray-yankee";
    // OSC 0 sets the title; OSC 9;4;1;42 sets progress (Normal, 42%). The trailing
    // idle lets both engines' capture/debounce persist before the clean exit.
    let meta = base_meta(
        id,
        &home,
        vec![
            "sh".into(),
            "-c".into(),
            "printf '\\033]0;climon-parity\\007\\033]9;4;1;42\\007'; sleep 2".into(),
        ],
    );

    let host = spawn_host(engine, id, meta, &home);
    let env = Env::with_home(&home);

    // Wait until both fields are captured (well before the 2s exit).
    let _ = wait_for_meta(&env, id, Instant::now() + Duration::from_secs(4), |m| {
        m.terminal_title.is_some() && m.progress.is_some()
    });

    let host_exit_code = host.join().ok();
    let final_meta = read_session_meta(&env, id).ok().flatten();

    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames: Vec::new(),
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the title/progress scenario.
pub fn assert_title_progress(trace: &ScenarioTrace) {
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.terminal_title.as_deref(), Some("climon-parity"));
    assert_eq!(
        meta.progress,
        Some(TerminalProgress {
            state: climon_proto::meta::ProgressState::Normal,
            value: Some(42),
        })
    );
    assert_eq!(meta.status, SessionStatus::Completed);
}

/// Emits output immediately and exits promptly. A viewer attaches, and both the
/// early output (carried in the replay snapshot) and the exit must reach it —
/// the short-lived-session path.
pub fn run_fast_exit_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("fast-exit");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "yankee-zulu-alpha";
    let meta = base_meta(
        id,
        &home,
        vec![
            "sh".into(),
            "-c".into(),
            "printf early-output; sleep 1".into(),
        ],
    );
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);

    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(5),
        |f| f.frame_type == FrameType::Exit,
    );

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(stream);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the fast-exit scenario.
pub fn assert_fast_exit(trace: &ScenarioTrace) {
    assert!(trace.saw_pty_size(80, 24), "PtySize on connect");
    assert!(trace.saw_replay(), "replay delivered");
    assert!(
        trace
            .terminal_output()
            .windows(12)
            .any(|w| w == b"early-output"),
        "early output captured and delivered"
    );
    assert!(trace.saw_exit(0), "exit delivered");
    assert_eq!(trace.host_exit_code(), Some(0));
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.status, SessionStatus::Completed);
    assert_eq!(meta.exit_code, Some(0));
}

/// A viewer grows the grid well beyond the host default and holds control, then
/// the command exits — the socket-observable projection of "exit while the local
/// terminal is displaced".
///
/// A headless harness cannot attach a real local terminal (that needs an
/// interactive tty), so the local-console restore written on a displaced exit is
/// characterized directly against the shared `local_exit_restore_bytes` by the
/// actor unit test `attached_displaced_exit_writes_shared_local_restore_to_console`.
/// This scenario covers the socket/metadata/exit finalization while a surface
/// holds an over-host grid, which both engines must handle identically.
pub fn run_exit_while_displaced_scenario(engine: TestEngine) -> ScenarioTrace {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("exit-displaced");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "zulu-alpha-bravo";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 1".into()]);
    let socket_ref = meta.socket_path.clone();

    let host = spawn_host(engine, id, meta, &home);
    let mut stream = connect_client(&socket_ref);

    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| f.frame_type == FrameType::Replay,
    );

    // Grow the grid far past the host default and hold control.
    let resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 200,
            rows: 50,
            kind: None,
            viewer_id: None,
        },
    );
    send_frame(&mut stream, &resize);
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(3),
        |f| is_control(f, "client-0", 200, 50),
    );

    // The command exits while the surface still holds the over-host grid.
    read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(5),
        |f| f.frame_type == FrameType::Exit,
    );

    let host_exit_code = host.join().ok();
    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id).ok().flatten();

    drop(stream);
    let _ = std::fs::remove_dir_all(&home);
    ScenarioTrace {
        frames,
        final_meta,
        host_exit_code,
        statuses: Vec::new(),
    }
}

/// Concrete per-engine expectations for the exit-while-displaced scenario.
pub fn assert_exit_while_displaced(trace: &ScenarioTrace) {
    assert!(trace.saw_pty_size(200, 50), "grid grew to 200x50");
    let control = trace.normalized().frames.iter().any(|f| {
        matches!(f, NormFrame::Control { controller_id, cols, rows }
            if controller_id == "client-0" && *cols == 200 && *rows == 50)
    });
    assert!(control, "surface holds control at 200x50");
    assert!(trace.saw_exit(0), "exit delivered under the grown grid");
    let meta = trace.final_meta().expect("final meta persisted");
    assert_eq!(meta.status, SessionStatus::Completed);
    assert_eq!((meta.cols, meta.rows), (200, 50));
}
