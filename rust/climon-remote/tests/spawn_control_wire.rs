//! Cross-implementation wire-shape tests: the Rust loopback control socket must
//! speak the exact JSON the Bun dashboard server's `requestRemoteSpawn` writes
//! and parses (newline-delimited `{ "type": "spawn-result", ... }`).

use climon_remote::ingest::{SpawnControlRequest, SpawnControlResponse, SpawnResultTag};

#[test]
fn response_serializes_with_bun_compatible_shape() {
    let res = SpawnControlResponse {
        kind: SpawnResultTag::SpawnResult,
        request_id: "r1".into(),
        id: Some("s1".into()),
        warning: None,
        error: None,
    };
    let json = serde_json::to_string(&res).unwrap();
    assert!(json.contains(r#""type":"spawn-result""#));
    assert!(json.contains(r#""requestId":"r1""#));
    assert!(json.contains(r#""id":"s1""#));
    assert!(!json.contains("warning"));
    assert!(!json.contains("error"));
}

#[test]
fn request_deserializes_from_bun_shape() {
    let line = r#"{"type":"spawn","requestId":"r1","clientId":"c1","command":["bash"],"cwd":"/tmp","cols":80,"rows":24,"headless":false}"#;
    let req: SpawnControlRequest = serde_json::from_str(line).unwrap();
    assert_eq!(req.request_id, "r1");
    assert_eq!(req.client_id, "c1");
    assert_eq!(req.command, vec!["bash".to_string()]);
    assert!(!req.headless);
}
