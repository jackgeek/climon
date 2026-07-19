//! Shared legacy/actor characterization and parity tests.
//!
//! Each test runs one scenario from [`common`] against **both** engines and
//! asserts their [`common::ScenarioTrace::normalized`] forms are identical. The
//! normalization strips only nondeterministic identities (socket ports, home
//! paths, pids, wall-clock timestamps) and transport-level framing artefacts
//! (pty-output chunking, the replay-vs-live-output race); it preserves frame
//! types and order, dimensions, controller ids, statuses, exact relayed
//! terminal bytes, and the semantic metadata subset. A failure therefore marks
//! a real behavioural divergence between the legacy host and the actor engine.
//!
//! Like `session_integration.rs`, every scenario drives a real PTY/socket
//! session and joins the host thread, so these run on Unix only.
#![cfg(unix)]

mod common;

use common::{
    assert_acknowledged_sticky, assert_attention_clear, assert_exit_while_displaced,
    assert_failed_exit, assert_fast_exit, assert_initial_frames, assert_replay_request,
    assert_slow_client, assert_take_control, assert_title_progress, assert_viewer_resize,
    run_acknowledged_sticky_scenario, run_attention_clear_scenario,
    run_exit_while_displaced_scenario, run_failed_exit_scenario, run_fast_exit_scenario,
    run_initial_frames_scenario, run_replay_request_scenario, run_slow_client_scenario,
    run_take_control_scenario, run_title_progress_scenario, run_viewer_resize_scenario, TestEngine,
};

#[test]
fn actor_matches_legacy_initial_frames_and_completion() {
    let legacy = run_initial_frames_scenario(TestEngine::Legacy);
    let actor = run_initial_frames_scenario(TestEngine::Actor);
    assert_initial_frames(&legacy);
    assert_initial_frames(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_failed_exit_status() {
    let legacy = run_failed_exit_scenario(TestEngine::Legacy);
    let actor = run_failed_exit_scenario(TestEngine::Actor);
    assert_failed_exit(&legacy);
    assert_failed_exit(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_viewer_resize_and_pty_size() {
    let legacy = run_viewer_resize_scenario(TestEngine::Legacy);
    let actor = run_viewer_resize_scenario(TestEngine::Actor);
    assert_viewer_resize(&legacy);
    assert_viewer_resize(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_attention_flag_and_acknowledgement() {
    let legacy = run_attention_clear_scenario(TestEngine::Legacy);
    let actor = run_attention_clear_scenario(TestEngine::Actor);
    assert_attention_clear(&legacy);
    assert_attention_clear(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_acknowledged_state_surviving_resize_and_idle() {
    let legacy = run_acknowledged_sticky_scenario(TestEngine::Legacy);
    let actor = run_acknowledged_sticky_scenario(TestEngine::Actor);
    assert_acknowledged_sticky(&legacy);
    assert_acknowledged_sticky(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_replay_request() {
    let legacy = run_replay_request_scenario(TestEngine::Legacy);
    let actor = run_replay_request_scenario(TestEngine::Actor);
    assert_replay_request(&legacy);
    assert_replay_request(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_take_control_and_controller_fallback() {
    let legacy = run_take_control_scenario(TestEngine::Legacy);
    let actor = run_take_control_scenario(TestEngine::Actor);
    assert_take_control(&legacy);
    assert_take_control(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_slow_client_disconnect() {
    let legacy = run_slow_client_scenario(TestEngine::Legacy);
    let actor = run_slow_client_scenario(TestEngine::Actor);
    assert_slow_client(&legacy);
    assert_slow_client(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_title_and_progress_metadata() {
    let legacy = run_title_progress_scenario(TestEngine::Legacy);
    let actor = run_title_progress_scenario(TestEngine::Actor);
    assert_title_progress(&legacy);
    assert_title_progress(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_fast_exit_and_early_output() {
    let legacy = run_fast_exit_scenario(TestEngine::Legacy);
    let actor = run_fast_exit_scenario(TestEngine::Actor);
    assert_fast_exit(&legacy);
    assert_fast_exit(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}

#[test]
fn actor_matches_legacy_exit_while_local_terminal_is_displaced() {
    let legacy = run_exit_while_displaced_scenario(TestEngine::Legacy);
    let actor = run_exit_while_displaced_scenario(TestEngine::Actor);
    assert_exit_while_displaced(&legacy);
    assert_exit_while_displaced(&actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}
