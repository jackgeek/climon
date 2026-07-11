//! Dedicated climon installer, shipped as `install[.exe]`. Replaces the old
//! `install`->`climon` rename + `climon-alpha` sentinel. Embeds the two Windows
//! stubs (tiny, stable) and delegates to `climon_install::run_installer`, which
//! resolves the install dir, places binaries (versioned artifacts + stubs +
//! pointers on Windows; plain copy on Unix), sets PATH, runs onboarding, and
//! prints the changelog.

const VERSION: &str = env!("CLIMON_VERSION");

/// Embedded Windows client stub bytes (`climon.exe`). Empty on non-Windows/dev.
const CLIENT_STUB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/client_stub.bin"));
/// Embedded Windows server stub bytes (`climon-server.exe`). Empty on non-Windows/dev.
const SERVER_STUB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/server_stub.bin"));

fn main() {
    std::process::exit(climon_install::run_installer(
        VERSION,
        CLIENT_STUB,
        SERVER_STUB,
    ));
}
