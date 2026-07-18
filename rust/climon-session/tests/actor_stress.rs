//! End-to-end bounded-queue stress tests for the **actor** session engine.
//!
//! Unlike the in-crate `engine::stress` suite — which drives the coordinator,
//! state, and adapter cores directly through the crate-private `StressFixture`
//! to observe internal lane/route depths and the structured observability
//! records — these tests exercise the whole daemon through its *public* API
//! (`run_session_host` with `CLIMON_SESSION_ENGINE=actor`) against a real PTY and
//! a real socket. They prove the externally observable stress guarantees: a real
//! output flood stays bounded and finalizes, and a healthy client keeps
//! receiving relayed output under that flood.
//!
//! These are not parity scenarios (the shared `common` parity suite already
//! covers behavioural parity); they are actor-only stress checks.
//!
//! # Unix-only
//!
//! Like the rest of the daemon integration suite, each test joins the host
//! thread, which blocks in `Pty::wait()` until the child exits — which never
//! happens under a headless ConPTY — so these run on Unix only (see
//! `session_integration.rs` for the full rationale).
#![cfg(unix)]

mod common;

use std::io::Read;
use std::thread;
use std::time::{Duration, Instant};

use climon_proto::frame::{DecodedFrame, FrameDecoder, FrameType};
use climon_proto::meta::SessionStatus;
use climon_session::socket::{connect_session_socket, SessionStream};
use climon_session::{run_session_host, SessionHostOptions};
use climon_store::meta::read_session_meta;
use climon_store::Env;

use common::{base_meta, scratch_home, serial};

/// The environment variable `run_session_host` reads to pick the actor engine.
const ENGINE_ENV: &str = "CLIMON_SESSION_ENGINE";

/// Spawns the actor daemon on its own thread (mirroring the launcher), returning
/// its join handle. The child command self-terminates, so `Pty::wait()` returns
/// and the thread joins.
fn spawn_actor_host(
    id: &str,
    meta: climon_proto::meta::SessionMeta,
    home: &std::path::Path,
) -> thread::JoinHandle<i32> {
    let id = id.to_string();
    let home = home.to_path_buf();
    thread::spawn(move || {
        std::env::set_var("CLIMON_HOME", &home);
        std::env::set_var(ENGINE_ENV, "actor");
        run_session_host(&id, meta, SessionHostOptions { headless: true }).unwrap()
    })
}

/// Reads decoded frames from `stream` until `done` matches one (keeping *every*
/// frame decoded, including any that follow the matching frame in the same
/// batch), the socket reaches EOF, or `deadline` passes.
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
    let mut buf = [0u8; 8192];
    let mut hit = false;
    while Instant::now() < deadline {
        match stream.read(&mut buf) {
            Ok(0) => return hit,
            Ok(n) => {
                for frame in decoder.push(&buf[..n]) {
                    if done(&frame) {
                        hit = true;
                    }
                    out.push(frame);
                }
                if hit {
                    return true;
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return hit,
        }
    }
    hit
}

/// A real output flood through the actor daemon stays bounded and finalizes: the
/// child writes tens of thousands of lines, the bounded event/effect queues
/// backpressure the reader rather than growing without bound, and the session
/// exits cleanly and is persisted as `completed`.
#[test]
fn actor_daemon_handles_a_real_output_flood_and_completes() {
    let _guard = serial()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let home = scratch_home("actor-stress-flood");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "actor-stress-flood";
    let meta = base_meta(
        id,
        &home,
        vec!["sh".into(), "-c".into(), "seq 1 20000".into()],
    );

    let host = spawn_actor_host(id, meta, &home);
    let exit_code = host.join().expect("actor host thread joins");
    assert_eq!(exit_code, 0, "the flooding session exits cleanly");

    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id)
        .ok()
        .flatten()
        .expect("final session metadata is persisted");
    assert_eq!(
        final_meta.status,
        SessionStatus::Completed,
        "the session finalizes to completed despite the output flood"
    );

    let _ = std::fs::remove_dir_all(&home);
}

/// A healthy client keeps receiving relayed output while the actor daemon is
/// flooded: it connects, and reads output frames right through to the terminal
/// `Exit` frame — proving the client route and ipc adapter relay a real flood
/// end to end without stalling.
#[test]
fn actor_daemon_relays_a_flood_to_a_healthy_client() {
    let _guard = serial()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let home = scratch_home("actor-stress-client");
    std::env::set_var("CLIMON_HOME", &home);

    let id = "actor-stress-client";
    let meta = base_meta(
        id,
        &home,
        vec![
            "sh".into(),
            "-c".into(),
            // Delay the flood so the client is connected before output begins,
            // then relay a modest flood the client reads through to Exit.
            "sleep 1; seq 1 3000".into(),
        ],
    );
    let socket_ref = meta.socket_path.clone();

    let host = spawn_actor_host(id, meta, &home);

    // Connect a real client and read frames until the terminal Exit frame.
    let mut stream = connect_within(&socket_ref, Duration::from_secs(3));
    stream.set_nonblocking(true).unwrap();
    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    let saw_exit = read_frames_until(
        &mut stream,
        &mut decoder,
        &mut frames,
        Instant::now() + Duration::from_secs(15),
        |frame| frame.frame_type == FrameType::Exit,
    );

    let exit_code = host.join().expect("actor host thread joins");
    assert_eq!(exit_code, 0, "the session exits cleanly");
    assert!(saw_exit, "the client received the terminal Exit frame");
    let output_frames = frames
        .iter()
        .filter(|frame| frame.frame_type == FrameType::Output)
        .count();
    assert!(
        output_frames > 0,
        "the client received relayed output under the flood: {output_frames} frames"
    );

    let _ = std::fs::remove_dir_all(&home);
}

/// Connects to the session socket, retrying until the daemon has bound it or
/// `within` elapses.
fn connect_within(socket_ref: &str, within: Duration) -> Box<dyn SessionStream> {
    let deadline = Instant::now() + within;
    loop {
        match connect_session_socket(socket_ref) {
            Ok(stream) => return stream,
            Err(error) => {
                if Instant::now() >= deadline {
                    panic!("connect to session socket {socket_ref}: {error}");
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
