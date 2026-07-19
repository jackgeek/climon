//! Windows regression coverage for raw-ConPTY EOF handling in the actor daemon.

#![cfg(windows)]

mod common;

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use climon_proto::meta::SessionStatus;
use climon_session::{run_session_host, SessionHostOptions};
use climon_store::meta::{read_scrollback, read_session_meta};
use climon_store::Env;

use common::{base_meta, scratch_home, serial};

#[test]
fn actor_treats_raw_conpty_pipe_closure_after_output_as_clean_eof() {
    let _guard = serial()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let home = scratch_home("actor-windows-eof");
    let id = "actor-windows-eof";
    let first_marker = "CLIMON-ACTOR-EOF-FIRST";
    let last_marker = "CLIMON-ACTOR-EOF-LAST";
    let command = format!("echo {first_marker} & ping -n 2 127.0.0.1 >NUL & echo {last_marker}");
    let meta = base_meta(
        id,
        &home,
        vec!["cmd.exe".into(), "/d".into(), "/c".into(), command],
    );

    std::env::set_var("CLIMON_HOME", &home);
    std::env::set_var("CLIMON_SESSION_ENGINE", "actor");
    let (done_tx, done_rx) = mpsc::channel();
    let id_for_host = id.to_string();
    let host = thread::spawn(move || {
        let result = run_session_host(&id_for_host, meta, SessionHostOptions { headless: true })
            .map_err(|error| error.to_string());
        let _ = done_tx.send(result);
    });

    let exit_code = done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("actor daemon must finish after the raw-ConPTY child exits")
        .expect("actor daemon must return the child exit code");
    host.join().expect("actor host thread joins");

    let env = Env::with_home(&home);
    let final_meta = read_session_meta(&env, id)
        .expect("read final metadata")
        .expect("final metadata exists");
    let scrollback = read_scrollback(&env, id)
        .expect("read final scrollback")
        .expect("final scrollback exists");
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(exit_code, 0, "normal pipe closure must preserve child exit");
    assert_eq!(
        final_meta.status,
        SessionStatus::Completed,
        "normal pipe closure must not mark actor metadata failed"
    );
    assert_eq!(final_meta.exit_code, Some(0));
    assert!(
        final_meta.completed_at.is_some(),
        "completed metadata is written"
    );
    assert!(
        final_meta.error.is_none(),
        "normal pipe closure must not persist PtyReadFailed: {:?}",
        final_meta.error
    );
    let output = String::from_utf8_lossy(&scrollback);
    assert!(
        output.contains(first_marker),
        "first output was persisted: {output:?}"
    );
    assert!(
        output.contains(last_marker),
        "last output was persisted: {output:?}"
    );
}
