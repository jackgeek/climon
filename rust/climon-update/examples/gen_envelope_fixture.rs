//! One-off generator for the Rust-produced envelope fixture consumed by the
//! cross-language parity tests. Run with:
//!   cargo run -p climon-update --example gen_envelope_fixture
//! and redirect stdout to `fixtures/update/rust-envelope.json`.

use base64::{engine::general_purpose::STANDARD, Engine};
use climon_update::crypto_envelope::encrypt_envelope;

fn main() {
    let password = "fixture-shared-pw";
    let plaintext = b"lazy climon jumps the fence";
    let envelope = encrypt_envelope(plaintext, password);
    let envelope_hex: String = envelope.iter().map(|b| format!("{b:02x}")).collect();
    let json = serde_json::json!({
        "description": "Rust-produced aes-256-gcm-scrypt-v1 envelope; Bun must decrypt to plaintext.",
        "scheme": "aes-256-gcm-scrypt-v1",
        "password": password,
        "plaintextB64": STANDARD.encode(plaintext),
        "envelopeHex": envelope_hex,
    });
    println!("{}", serde_json::to_string_pretty(&json).unwrap());
}
