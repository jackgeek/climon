//! In-process stress and fault-injection tests for the bounded actor engine.
//!
//! These tests drive the *real* [`Coordinator`], [`SessionState`], and (where a
//! scenario is about adapter behaviour) the real resource adapters, through the
//! [`StressFixture`] test harness. They prove the bounded-queue and
//! fault-isolation guarantees that are only observable from *inside* the crate
//! (internal lane/route depths, the payload-free applied-event sequence, and the
//! structured observability records) and therefore cannot live in the external
//! `tests/actor_stress.rs` integration binary, which can only reach the public
//! API.
//!
//! [`Coordinator`]: crate::engine::coordinator::Coordinator
//! [`SessionState`]: crate::engine::state::SessionState
//! [`StressFixture`]: crate::test_support::harness::StressFixture

use std::time::Duration;

use climon_proto::frame::SurfaceKind;
use serde_json::Value;

use crate::adapters::ipc::test_support::IpcFixture;
use crate::engine::effect::{Effect, OperationId};
use crate::test_support::harness::{ActorHarness, StressFixture};
use crate::test_support::trace::RecordingLogSink;

/// A pathological pty output flood must stay bounded by the pty event lane's
/// configured capacity (backpressure, not an unbounded buffer), and a shutdown
/// request queued behind the flood must still be applied promptly — within the
/// arbitration bound of sixteen pty applications — rather than being starved
/// behind the flood.
#[tokio::test]
async fn output_flood_is_bounded_and_control_is_not_starved() {
    let fixture = StressFixture::new()
        .pty_capacity(32)
        .control_capacity(8)
        .client_capacity(4)
        .start()
        .await;
    fixture.flood_pty_output(10_000, 1024).await;
    fixture.request_shutdown().await;
    fixture.wait_stopped(Duration::from_secs(5)).await.unwrap();
    assert!(fixture.max_pty_depth() <= 32);
    assert!(fixture.shutdown_applied_within_pty_events(16));
}

/// Under a flood that stresses several routes at once (attached local echo plus a
/// broadcast client), every bounded queue stays within its configured capacity —
/// backpressure, never an unbounded buffer.
#[tokio::test]
async fn all_queues_stay_within_configured_capacities() {
    let fixture = StressFixture::new()
        .pty_capacity(16)
        .control_capacity(8)
        .client_capacity(16)
        .attached()
        .with_client()
        .start()
        .await;
    fixture.flood_pty_output(5_000, 256).await;
    fixture.request_shutdown().await;
    fixture.wait_stopped(Duration::from_secs(5)).await.unwrap();
    assert!(
        fixture.queues_within_capacity(),
        "every lane and route must stay within its configured bound"
    );
    // Backpressure genuinely engaged on the flooded lane (it reached its bound).
    assert!(fixture.max_pty_depth() > 0);
}

/// A console peripheral wedged on its own I/O must degrade only local output: it
/// must never stall the coordinator, so pty relay and client broadcasts keep
/// flowing and the session can still shut down once the console is released.
#[tokio::test]
async fn blocked_console_degrades_local_output_without_stopping_pty_or_client() {
    let fixture = StressFixture::new()
        .attached()
        .with_client()
        .block_console()
        .start()
        .await;
    // The console adapter is wedged on its blocking writer; a pty flood far
    // larger than the console route's bound must still drain end to end.
    let flooded =
        tokio::time::timeout(Duration::from_secs(5), fixture.flood_pty_output(400, 64)).await;
    assert!(
        flooded.is_ok(),
        "a blocked console must not stall the pty flood"
    );
    // Client broadcasts kept flowing while the console was wedged.
    assert!(
        fixture.client_sends_received() >= 200,
        "client output continued despite the blocked console: {}",
        fixture.client_sends_received()
    );
    // Releasing the console lets the adapter drain and the session shut down.
    fixture.release_console();
    fixture.request_shutdown().await;
    fixture
        .wait_stopped(Duration::from_secs(5))
        .await
        .expect("session stops after the console is released");
}

/// The pty command route preserves the order effects are produced in, so a
/// client's input, a resize, and more input reach the pty as WritePty, ResizePty,
/// WritePty — never reordered. Exercised at the pure-state core, whose per-event
/// effect order is exactly what the coordinator dispatches FIFO to the pty route.
#[test]
fn pty_command_queue_preserves_input_resize_input_order() {
    #[derive(Debug, PartialEq, Eq)]
    enum PtyCmd {
        Write(Vec<u8>),
        Resize,
    }
    fn classify(effect: &Effect) -> Option<PtyCmd> {
        if let Some(bytes) = effect.pty_input() {
            Some(PtyCmd::Write(bytes.to_vec()))
        } else {
            effect.pty_resize().map(|_| PtyCmd::Resize)
        }
    }

    let mut harness = ActorHarness::headless();
    // A dashboard client on a headless session becomes the controller on its
    // first resize, so its input is forwarded to the pty.
    harness.connect_initialized_dashboard(1, "dash", 80, 24);

    let mut commands = Vec::new();
    commands.extend(
        harness
            .client_input(1, b"first")
            .iter()
            .filter_map(classify),
    );
    commands.extend(
        harness
            .resize(1, "dash", SurfaceKind::Dashboard, 100, 40)
            .iter()
            .filter_map(classify),
    );
    commands.extend(
        harness
            .client_input(1, b"second")
            .iter()
            .filter_map(classify),
    );

    assert_eq!(
        commands,
        vec![
            PtyCmd::Write(b"first".to_vec()),
            PtyCmd::Resize,
            PtyCmd::Write(b"second".to_vec()),
        ],
        "input/resize/input must reach the pty command queue in order"
    );
}

/// A pty exit racing a shutdown request finalizes the session exactly once: the
/// first exit wins, a shutdown arriving mid-finalization is a no-op (it emits no
/// second kill), and a later duplicate exit is ignored.
#[test]
fn concurrent_pty_exit_and_shutdown_finalize_once() {
    let mut harness = ActorHarness::headless();

    let mut completions = 0usize;
    let mut kills = 0usize;
    let mut exit_code = None;
    let mut count = |effects: &[Effect]| {
        for effect in effects {
            if let Some(code) = effect.complete_code() {
                completions += 1;
                exit_code = Some(code);
            }
            if effect.is_kill_pty() {
                kills += 1;
            }
        }
    };

    // The pty exits first: finalization begins.
    let exit_effects = harness.pty_exited(5);
    let barrier_op = exit_effects
        .iter()
        .find_map(|effect| match effect.metadata() {
            Some((_, true)) => effect.operation_id(),
            _ => None,
        })
        .expect("finalization emits the terminal status barrier patch");
    count(&exit_effects);

    // A shutdown arriving while finalizing must be a no-op (no second kill).
    count(&harness.shutdown());
    // The barrier completion drives finalization through to completion.
    count(&harness.metadata_completed(barrier_op));
    // A later, duplicate exit is ignored.
    count(&harness.pty_exited(99));

    assert_eq!(completions, 1, "the session finalizes exactly once");
    assert_eq!(exit_code, Some(5), "the first exit code wins");
    assert_eq!(
        kills, 0,
        "a shutdown during finalization emits no second kill"
    );
}

/// Stale console, timer, and metadata completions — a completion whose id or
/// generation no longer matches any in-flight work — are ignored, emitting no
/// effects, so a late adapter completion can never corrupt the state.
#[test]
fn stale_console_timer_and_metadata_completions_are_ignored() {
    let mut harness = ActorHarness::headless();

    // No metadata barrier is in flight: a metadata completion is a stale no-op.
    assert!(
        harness.metadata_completed(OperationId(9999)).is_empty(),
        "a stale metadata completion is ignored"
    );
    // No tracked console write is in flight: a console completion is a stale no-op.
    assert!(
        harness.console_completed(OperationId(9999)).is_empty(),
        "a stale console completion is ignored"
    );
    // The idle timer is live at a known generation; a firing carrying a
    // mismatched (superseded) generation is ignored.
    let (idle_timer, generation) = harness
        .live_timer(Duration::from_millis(1000))
        .expect("the idle sampler timer is scheduled at start");
    assert!(
        harness.fire_timer(idle_timer, generation + 1).is_empty(),
        "a timer firing with a superseded generation is ignored"
    );
}

/// The coordinator's structured observability records carry the lifecycle phase,
/// the saturated route with its effect kind and payload *length* (never the
/// bytes), and a failure class — and no record ever contains pty/replay/user
/// payload bytes. Asserted on parsed fields, not formatted NDJSON text.
#[tokio::test]
async fn structured_logs_carry_phase_saturation_failure_class_and_never_payload_bytes() {
    let sink = RecordingLogSink::install();
    {
        let fixture = StressFixture::new()
            .attached()
            .with_client()
            .block_console()
            .start()
            .await;
        let _ =
            tokio::time::timeout(Duration::from_secs(5), fixture.flood_pty_output(200, 37)).await;
        fixture.release_console();
        fixture.request_shutdown().await;
        fixture
            .wait_stopped(Duration::from_secs(5))
            .await
            .expect("session stops");
    }

    let records = sink.records();
    // Lifecycle phase transitions.
    assert!(
        records.iter().any(|record| record["phase"] == "running"),
        "a running-phase record is emitted"
    );
    assert!(
        records.iter().any(|record| record["phase"] == "stopped"),
        "a stopped-phase record is emitted"
    );
    // A saturation record naming the route, effect kind, failure class, and the
    // payload *length* only. (Other coordinators/adapters may log concurrently
    // through the shared sink, so match this fixture's console-route record.)
    let saturation = records
        .iter()
        .find(|record| record["saturation"] == Value::Bool(true) && record["route"] == "console")
        .expect("a console route-saturation record is emitted");
    assert_eq!(saturation["route"], "console");
    assert_eq!(saturation["effect_kind"], "WriteConsole");
    assert_eq!(saturation["failure_class"], "route_saturated");
    assert!(
        saturation["bytes_len"].is_number(),
        "payloads are represented only by length: {saturation}"
    );
    // No payload bytes ever reach a log line: the flood wrote 37-byte 'x' chunks.
    assert!(
        !sink.raw().contains("xxxxx"),
        "payload bytes must never be logged"
    );
}

/// A slow client that stops draining its socket overflows its own bounded
/// outbound queue and is isolated, while a healthy client keeps receiving
/// without delay. Exercises the real ipc adapter's per-client fan-out.
#[tokio::test]
async fn slow_client_does_not_delay_healthy_client() {
    let mut fixture = IpcFixture::with_client_capacity(1);
    let slow = fixture.connect_client().await;
    let healthy = fixture.connect_client().await;
    fixture.pause_writer(slow).await;

    // The slow client fills its capacity-one queue, then the next send overflows
    // and isolates only that client.
    fixture.send(slow, b"one").await.unwrap();
    let overflow = fixture.send(slow, b"two").await.unwrap_err();
    assert_eq!(
        overflow.client_id, slow,
        "the slow client overflows and is isolated"
    );

    // The healthy client keeps receiving immediately, undelayed by the slow one.
    fixture.send(healthy, b"live").await.unwrap();
    assert_eq!(fixture.read(healthy).await, b"live");

    // The isolation surfaced as ClientSendFailed for only the slow client.
    let failed = fixture.events().send_failed();
    assert!(
        failed.iter().any(|(id, _)| *id == slow),
        "the slow client was isolated"
    );
    assert!(
        failed.iter().all(|(id, _)| *id != healthy),
        "the healthy client was never isolated"
    );
}

/// An adapter that overflows a client's bounded outbound queue emits a
/// structured, classified, payload-safe failure record: it carries the ids, the
/// payload *length* only, the saturation flag, and the failure class — never the
/// frame bytes. Asserted on parsed fields.
#[tokio::test]
async fn adapter_logs_classified_client_overflow_failure() {
    let sink = RecordingLogSink::install();
    {
        let mut fixture = IpcFixture::with_client_capacity(1);
        let slow = fixture.connect_client().await;
        fixture.pause_writer(slow).await;
        fixture.send(slow, b"queued").await.unwrap();
        // This send overflows the capacity-one queue and is logged + isolated.
        let _ = fixture.send(slow, b"secret-overflow-payload").await;
    }

    let records = sink.records();
    let overflow = records
        .iter()
        .find(|record| record["failure_class"] == "client_send_overflow")
        .expect("an adapter overflow failure record is emitted");
    assert_eq!(overflow["saturation"], Value::Bool(true));
    assert!(
        overflow["client_id"].is_number(),
        "the isolated client id is recorded"
    );
    assert!(
        overflow["bytes_len"].is_number(),
        "the payload is represented only by its length: {overflow}"
    );
    assert!(
        !sink.raw().contains("secret-overflow-payload"),
        "adapter logs never carry payload bytes"
    );
}

/// Every metadata patch failing all its retries — including the finalization
/// status barrier — must not stop the live pty: the flood still drains and the
/// session still finalizes (the exhausted barrier drives finalization via
/// MetadataFailed instead of hanging).
#[tokio::test]
async fn metadata_retry_exhaustion_does_not_stop_live_pty() {
    let fixture = StressFixture::new().failing_metadata().start().await;
    fixture.flood_pty_output(500, 128).await;
    fixture.request_shutdown().await;
    fixture
        .wait_stopped(Duration::from_secs(20))
        .await
        .expect("the session finalizes despite metadata retry exhaustion");
}
