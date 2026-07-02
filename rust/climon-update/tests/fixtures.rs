//! Cross-language golden-fixture parity tests. These assert that the Rust
//! updater verifies artifacts produced by the Bun release tooling, guaranteeing
//! byte-for-byte signature interop.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use climon_update::manifest::parse_manifest;
use climon_update::verify::verify_signature;
use serde_json::Value;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/update")
}

fn load(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_slice(&bytes).unwrap()
}

fn from_b64(v: &Value, key: &str) -> Vec<u8> {
    STANDARD.decode(v[key].as_str().unwrap()).unwrap()
}

#[test]
fn rust_verifies_the_bun_signed_payload() {
    let f = load("signed-payload.json");
    let data = from_b64(&f, "dataB64");
    let sig = f["signatureB64"].as_str().unwrap();
    let pubkey = f["publicKeyB64"].as_str().unwrap();
    assert!(verify_signature(&data, sig, pubkey));
}

#[test]
fn rust_rejects_a_tampered_bun_payload() {
    let f = load("signed-payload.json");
    let mut data = from_b64(&f, "dataB64");
    data[0] ^= 0x01;
    let sig = f["signatureB64"].as_str().unwrap();
    let pubkey = f["publicKeyB64"].as_str().unwrap();
    assert!(!verify_signature(&data, sig, pubkey));
}

#[test]
fn rust_parses_the_shared_manifest_fixture() {
    let path = fixtures_dir().join("manifest.json");
    let bytes = std::fs::read(path).unwrap();
    let m = parse_manifest(&bytes).expect("valid manifest");
    assert_eq!(m.version, "0.99.0");
    assert!(m.encryption.is_some());
    assert!(m
        .artifacts
        .get("linux-x64")
        .unwrap()
        .url
        .contains("linux-x64"));
    assert!(m
        .artifacts
        .get("darwin-arm64")
        .unwrap()
        .sig
        .contains("darwin-arm64"));
}
