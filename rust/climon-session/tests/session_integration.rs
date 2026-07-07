//! Integration tests for the session host: spawn a real PTY session, connect via
//! the IPC socket, and assert frame round-trips, lifecycle metadata, and the
//! Phase 5 `Some(None)` attention-clear path.
//!
//! These tests touch the real filesystem (CLIMON_HOME) and bind real sockets, so
//! they serialize on a process-global lock and pin CLIMON_HOME under `target/`.
//!
//! # Unix-only
//!
//! Every case here drives the full daemon (`run_session_host`) against a real
//! `sh -c` command and then joins the host thread, which blocks in the daemon's
//! `Pty::wait()` until the child exits. Under a **headless ConPTY** — every
//! GitHub-hosted `windows-latest` runner and other windowless sandboxes — a
//! child attached to the pseudoconsole produces its output but never reaches its
//! own `ExitProcess`; it only dies once the master is torn down (reporting a
//! control-C exit, not its real code). So `wait()` never returns, the host
//! thread never joins, and these tests hang until the CI timeout. No command
//! self-terminates under that ConPTY, so the exit-code / `Completed` / `Failed`
//! assertions cannot be satisfied there by any means.
//!
//! The behaviour under test — IPC framing, lifecycle metadata, the attention
//! state machine — is platform-agnostic and fully exercised on the Linux and
//! macOS runners. The Windows PTY mechanics (spawn, read, resize, exit-code
//! derivation, master-drop teardown) are covered directly, with a graceful
//! headless-ConPTY skip, by `climon-pty`'s `pty_integration` tests. A real
//! interactive Windows desktop exits normally and would pass these too; only the
//! headless CI environment cannot, so the file is gated to Unix rather than left
//! to hang.
#![cfg(unix)]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use climon_proto::frame::{
    encode_json_frame, parse_json_payload, ExitPayload, FrameDecoder, FrameType, PtySizePayload,
    ResizePayload,
};
use climon_proto::meta::{PriorityReason, SessionMeta, SessionStatus};
use climon_session::socket::{
    allocate_loopback_port, connect_session_socket, format_session_socket_ref,
    wait_for_session_socket, SessionStream,
};
use climon_session::{run_session_host, SessionHostOptions};
use climon_store::meta::read_session_meta;
use climon_store::Env;

/// Serializes tests that mutate the global CLIMON_HOME env var.
fn serial() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique scratch dir under `target/` (never the system temp dir).
fn scratch_home(tag: &str) -> PathBuf {
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

fn base_meta(id: &str, home: &PathBuf, command: Vec<String>) -> SessionMeta {
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
    // The launcher writes the initial meta file before the host starts.
    let env = Env::with_home(home);
    climon_store::meta::write_session_meta(&env, &meta).unwrap();
    meta
}

/// Reads frames until `predicate` returns true for one, or the deadline passes.
fn read_until<F>(
    stream: &mut Box<dyn SessionStream>,
    decoder: &mut FrameDecoder,
    deadline: Instant,
    mut predicate: F,
) -> bool
where
    F: FnMut(FrameType, &[u8]) -> bool,
{
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        let n = match stream.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => n,
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => return false,
        };
        for frame in decoder.push(&buf[..n]) {
            if predicate(frame.frame_type, &frame.payload) {
                return true;
            }
        }
    }
    false
}

#[test]
fn streams_initial_frames_and_completes() {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("initial-frames");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "alpha-beta-gamma";
    // A short-lived command so the session completes on its own.
    let meta = base_meta(
        id,
        &home,
        vec!["sh".into(), "-c".into(), "printf hello; sleep 1.5".into()],
    );
    let socket_ref = meta.socket_path.clone();

    let host_home = home.clone();
    let host = thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &host_home);
        run_session_host(id, meta, SessionHostOptions { headless: true }).unwrap()
    });

    wait_for_session_socket(&socket_ref, Duration::from_secs(3)).expect("socket up");
    let mut stream = connect_session_socket(&socket_ref).expect("connect");
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();

    let mut decoder = FrameDecoder::new();
    let deadline = Instant::now() + Duration::from_secs(3);

    // Expect PtySize as the first initial frame.
    let mut saw_pty_size = false;
    let mut saw_replay = false;
    let mut saw_output_hello = false;
    let mut saw_exit = false;
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline && !saw_exit {
        let n = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(_) => break,
        };
        for frame in decoder.push(&buf[..n]) {
            match frame.frame_type {
                FrameType::PtySize => {
                    let p: PtySizePayload = parse_json_payload(&frame.payload).unwrap();
                    assert_eq!((p.cols, p.rows), (80, 24));
                    saw_pty_size = true;
                }
                FrameType::Replay => {
                    saw_replay = true;
                    if String::from_utf8_lossy(&frame.payload).contains("hello") {
                        saw_output_hello = true;
                    }
                }
                FrameType::Output => {
                    if String::from_utf8_lossy(&frame.payload).contains("hello") {
                        saw_output_hello = true;
                    }
                }
                FrameType::Exit => {
                    let p: ExitPayload = parse_json_payload(&frame.payload).unwrap();
                    assert_eq!(p.exit_code, 0);
                    saw_exit = true;
                }
                _ => {}
            }
        }
    }

    let code = host.join().unwrap();
    assert_eq!(code, 0, "session exit code");
    assert!(saw_pty_size, "received PtySize");
    assert!(saw_replay, "received Replay");
    assert!(saw_output_hello, "received hello via Replay or Output");
    assert!(saw_exit, "received Exit");

    let env = Env::with_home(&home);
    let persisted = read_session_meta(&env, id).unwrap().unwrap();
    assert_eq!(persisted.status, SessionStatus::Completed);
    assert_eq!(persisted.exit_code, Some(0));
    assert!(persisted.completed_at.is_some());

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn failed_command_marks_session_failed() {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("failed-lifecycle");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "delta-echo-foxtrot";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "exit 3".into()]);

    let host_home = home.clone();
    let code = thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &host_home);
        run_session_host(id, meta, SessionHostOptions { headless: true }).unwrap()
    })
    .join()
    .unwrap();

    assert_eq!(code, 3);
    let env = Env::with_home(&home);
    let persisted = read_session_meta(&env, id).unwrap().unwrap();
    assert_eq!(persisted.status, SessionStatus::Failed);
    assert_eq!(persisted.exit_code, Some(3));

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn viewer_resize_broadcasts_pty_size() {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("viewer-resize");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "golf-hotel-india";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 2".into()]);
    let socket_ref = meta.socket_path.clone();

    let host_home = home.clone();
    let host = thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &host_home);
        run_session_host(id, meta, SessionHostOptions { headless: true }).unwrap()
    });

    wait_for_session_socket(&socket_ref, Duration::from_secs(3)).expect("socket up");
    let mut stream = connect_session_socket(&socket_ref).expect("connect");
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();

    // Send a viewer resize larger than the host; the PTY grows to fit it.
    let resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 120,
            rows: 40,
            kind: None,
            viewer_id: None,
        },
    );
    stream.write_all(&resize).unwrap();

    let mut decoder = FrameDecoder::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    let saw_resized = read_until(&mut stream, &mut decoder, deadline, |ty, payload| {
        if ty == FrameType::PtySize {
            let p: PtySizePayload = parse_json_payload(payload).unwrap();
            return (p.cols, p.rows) == (120, 40);
        }
        false
    });
    assert!(saw_resized, "viewer Fill resize broadcast 120x40");

    drop(stream);
    let _ = host.join();
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn input_clears_attention_via_three_state_patch() {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("attention-clear");
    std::env::set_var("CLIMON_HOME", &home);
    // Drive the idle detector quickly: flag attention after ~1s of a static screen.
    std::fs::write(
        home.join("config.jsonc"),
        "{ \"attention\": { \"idleSeconds\": 1 } }\n",
    )
    .unwrap();

    let id = "juliet-kilo-lima";
    // `sleep` produces no output, so the screen stays static and goes idle.
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 8".into()]);
    let socket_ref = meta.socket_path.clone();

    let host_home = home.clone();
    let host = thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &host_home);
        run_session_host(id, meta, SessionHostOptions { headless: true }).unwrap()
    });

    wait_for_session_socket(&socket_ref, Duration::from_secs(3)).expect("socket up");
    let mut stream = connect_session_socket(&socket_ref).expect("connect");
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();

    let env = Env::with_home(&home);

    // The detector flags attention; the host writes attentionMatchedAt + reason.
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut token: Option<String> = None;
    while Instant::now() < deadline {
        let m = read_session_meta(&env, id).unwrap().unwrap();
        if m.status == SessionStatus::NeedsAttention {
            assert!(m.attention_matched_at.is_some());
            assert_eq!(m.attention_reason.as_deref(), Some("Screen idle for 1s"));
            token = m.attention_matched_at.clone();
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let token = token.expect("detector flagged needs-attention");

    // Acknowledge with the matching token; screen is unchanged so it clears.
    let ack = encode_json_frame(
        FrameType::Attention,
        &climon_proto::frame::AttentionPayload {
            needs_attention: false,
            reason: None,
            attention_matched_at: Some(token),
        },
    );
    stream.write_all(&ack).unwrap();

    // Poll for the cleared state (attentionMatchedAt/reason removed -> Some(None)).
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut cleared = false;
    while Instant::now() < deadline {
        let m = read_session_meta(&env, id).unwrap().unwrap();
        if m.attention_matched_at.is_none()
            && m.attention_reason.is_none()
            && m.status == SessionStatus::Acknowledged
        {
            cleared = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        cleared,
        "attention cleared to None via Some(None) three-state patch"
    );

    drop(stream);
    let _ = host.join();
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn acknowledged_session_stays_acknowledged_across_a_resize_and_idle() {
    let _guard = serial().lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch_home("ack-sticky");
    std::env::set_var("CLIMON_HOME", &home);
    // Flag attention quickly so the test stays short.
    std::fs::write(
        home.join("config.jsonc"),
        "{ \"attention\": { \"idleSeconds\": 1 } }\n",
    )
    .unwrap();

    let id = "mike-november-oscar";
    let meta = base_meta(id, &home, vec!["sh".into(), "-c".into(), "sleep 10".into()]);
    let socket_ref = meta.socket_path.clone();

    let host_home = home.clone();
    let host = thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &host_home);
        run_session_host(id, meta, SessionHostOptions { headless: true }).unwrap()
    });

    wait_for_session_socket(&socket_ref, Duration::from_secs(3)).expect("socket up");
    let mut stream = connect_session_socket(&socket_ref).expect("connect");
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();

    let env = Env::with_home(&home);

    // Wait for the detector to flag needs-attention.
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut token: Option<String> = None;
    while Instant::now() < deadline {
        let m = read_session_meta(&env, id).unwrap().unwrap();
        if m.status == SessionStatus::NeedsAttention {
            token = m.attention_matched_at.clone();
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let token = token.expect("detector flagged needs-attention");

    // Acknowledge it (screen is unchanged, so it transitions to Acknowledged).
    let ack = encode_json_frame(
        FrameType::Attention,
        &climon_proto::frame::AttentionPayload {
            needs_attention: false,
            reason: None,
            attention_matched_at: Some(token),
        },
    );
    stream.write_all(&ack).unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut acknowledged = false;
    while Instant::now() < deadline {
        if read_session_meta(&env, id).unwrap().unwrap().status == SessionStatus::Acknowledged {
            acknowledged = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(acknowledged, "session reached Acknowledged");

    // A host resize changes the screen dimensions but not the (empty) body.
    let resize = encode_json_frame(
        FrameType::Resize,
        &ResizePayload {
            cols: 100,
            rows: 30,
            kind: None,
            viewer_id: None,
        },
    );
    stream.write_all(&resize).unwrap();

    // Across several idle windows the session must neither revert to Running nor
    // re-flag needs-attention while its screen stays idle.
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        let status = read_session_meta(&env, id).unwrap().unwrap().status;
        assert_eq!(
            status,
            SessionStatus::Acknowledged,
            "acknowledged session must stay acknowledged while idle"
        );
        thread::sleep(Duration::from_millis(200));
    }

    drop(stream);
    let _ = host.join();
    let _ = std::fs::remove_dir_all(&home);
}
