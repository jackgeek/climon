//! End-to-end: the ingest's loopback control socket signs a spawn to a connected
//! client channel and returns the correlated result.
use std::sync::Arc;
use std::time::Duration;

use climon_remote::ingest::{
    handle_spawn_control_request, run_ingest_connection, IngestConnOptions,
    IngestConnectionRegistry, SpawnControlRequest,
};

#[tokio::test]
async fn registry_spawn_roundtrip_via_public_api() {
    use climon_remote::mux::ControlMessage;
    let registry = Arc::new(IngestConnectionRegistry::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let teardown = Arc::new(tokio::sync::Notify::new());
    registry
        .evict_and_register("c1", shutdown, teardown, tx)
        .await;

    let req = SpawnControlRequest {
        request_id: "r1".into(),
        client_id: "c1".into(),
        command: vec!["sh".into()],
        cwd: "/".into(),
        cols: 80,
        rows: 24,
        name: None,
        priority: None,
        color: None,
        theme: None,
        headless: false,
    };
    let reg = registry.clone();
    let handle = tokio::spawn(async move {
        handle_spawn_control_request(req, &reg, Some("sek".into()), 5_000).await
    });
    let _signed = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("spawn frame within 2s")
        .expect("frame present");
    registry.resolve_pending_spawn(
        "r1",
        ControlMessage::SpawnResult {
            request_id: "r1".into(),
            id: Some("s1".into()),
            warning: None,
            error: None,
        },
    );
    let res = handle.await.unwrap();
    assert_eq!(res.id.as_deref(), Some("s1"));
    let _ = IngestConnOptions::new; // ensure exported
    let _ = run_ingest_connection; // ensure exported
}
