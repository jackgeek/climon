//! Integration tests for the session host: spawn a real PTY session, connect via
//! the IPC socket, and assert frame round-trips, lifecycle metadata, and the
//! Phase 5 `Some(None)` attention-clear path — now run against **both** engines.
//!
//! Every scenario body lives in [`common`] and is parameterized by
//! [`common::TestEngine`], so each case runs once under the legacy thread-based
//! host and once under the actor engine (selected via `CLIMON_SESSION_ENGINE`).
//! The `_legacy` variants are the original characterization tests; the `_actor`
//! variants assert the actor engine reproduces the same observable behavior.
//! `engine_parity.rs` additionally compares their normalized traces directly.
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

mod common;

use common::{
    assert_acknowledged_sticky, assert_attention_clear, assert_failed_exit, assert_initial_frames,
    assert_viewer_resize, run_acknowledged_sticky_scenario, run_attention_clear_scenario,
    run_failed_exit_scenario, run_initial_frames_scenario, run_viewer_resize_scenario, TestEngine,
};

#[test]
fn streams_initial_frames_and_completes_legacy() {
    assert_initial_frames(&run_initial_frames_scenario(TestEngine::Legacy));
}

#[test]
fn streams_initial_frames_and_completes_actor() {
    assert_initial_frames(&run_initial_frames_scenario(TestEngine::Actor));
}

#[test]
fn failed_command_marks_session_failed_legacy() {
    assert_failed_exit(&run_failed_exit_scenario(TestEngine::Legacy));
}

#[test]
fn failed_command_marks_session_failed_actor() {
    assert_failed_exit(&run_failed_exit_scenario(TestEngine::Actor));
}

#[test]
fn viewer_resize_broadcasts_pty_size_legacy() {
    assert_viewer_resize(&run_viewer_resize_scenario(TestEngine::Legacy));
}

#[test]
fn viewer_resize_broadcasts_pty_size_actor() {
    assert_viewer_resize(&run_viewer_resize_scenario(TestEngine::Actor));
}

#[test]
fn input_clears_attention_via_three_state_patch_legacy() {
    assert_attention_clear(&run_attention_clear_scenario(TestEngine::Legacy));
}

#[test]
fn input_clears_attention_via_three_state_patch_actor() {
    assert_attention_clear(&run_attention_clear_scenario(TestEngine::Actor));
}

#[test]
fn acknowledged_session_stays_acknowledged_across_a_resize_and_idle_legacy() {
    assert_acknowledged_sticky(&run_acknowledged_sticky_scenario(TestEngine::Legacy));
}

#[test]
fn acknowledged_session_stays_acknowledged_across_a_resize_and_idle_actor() {
    assert_acknowledged_sticky(&run_acknowledged_sticky_scenario(TestEngine::Actor));
}
