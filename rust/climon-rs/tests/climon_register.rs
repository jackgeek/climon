//! Verifies `run --climon` writes server-discoverable session metadata under
//! $CLIMON_HOME and transitions it to `completed` on exit.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_climon-rs");

fn read_only_session(sessions_dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(sessions_dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "json").unwrap_or(false) {
            return std::fs::read_to_string(&p).ok();
        }
    }
    None
}

#[test]
fn climon_mode_registers_and_completes_session() {
    let home = std::env::temp_dir().join(format!("climon-rs-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let sessions_dir = home.join("sessions");

    let mut host = Command::new(BIN)
        .args([
            "run",
            "--climon",
            "--",
            "sh",
            "-c",
            "printf REGISTERED; sleep 1",
        ])
        .env("CLIMON_HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn host");

    // Metadata file should appear with status "running" and a socketPath.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut running_json = None;
    while Instant::now() < deadline {
        if let Some(json) = read_only_session(&sessions_dir) {
            if json.contains("\"status\":\"running\"") {
                running_json = Some(json);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let running_json = running_json.unwrap_or_else(|| {
        let _ = host.kill();
        panic!("running session metadata never appeared");
    });
    assert!(
        running_json.contains("\"socketPath\""),
        "metadata must record a socketPath"
    );
    assert!(
        running_json.contains("\"daemonPid\""),
        "metadata must record a daemonPid"
    );
    assert!(
        running_json.contains("REGISTERED"),
        "metadata command should be present"
    );

    let status = host.wait().expect("host wait");
    assert!(status.success());

    // After exit, status should be "completed".
    let final_json = read_only_session(&sessions_dir).expect("final metadata");
    assert!(
        final_json.contains("\"status\":\"completed\""),
        "expected completed status, got: {}",
        final_json
    );
    assert!(final_json.contains("\"exitCode\":0"));

    let _ = std::fs::remove_dir_all(&home);
}
