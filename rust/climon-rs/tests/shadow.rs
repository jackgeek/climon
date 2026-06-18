//! End-to-end shadow test: a host runs a command in a PTY; a viewer attaches
//! over the socket and must receive a replay of the output plus a clean exit.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_climon-rs");

#[test]
fn viewer_receives_shadowed_output_and_exit() {
    let dir = std::env::temp_dir();
    let sock = dir.join(format!("climon-rs-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&sock);

    // Host a command that prints a marker, then lingers so the viewer can attach.
    let mut host = Command::new(BIN)
        .args([
            "run",
            "--socket",
            sock.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            "printf HELLO_SHADOW; sleep 1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn host");

    // Wait for the host to bind its socket.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sock.exists() {
        if Instant::now() > deadline {
            let _ = host.kill();
            panic!("host socket never appeared");
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    // Attach a viewer and capture its rendered output.
    let mut viewer = Command::new(BIN)
        .args(["view", "--socket", sock.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn viewer");

    let mut output = String::new();
    viewer
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .expect("read viewer stdout");

    let viewer_status = viewer.wait().expect("viewer wait");
    let host_status = host.wait().expect("host wait");

    let _ = std::fs::remove_file(&sock);

    assert!(
        output.contains("HELLO_SHADOW"),
        "viewer should have shadowed the host output; got: {:?}",
        output
    );
    assert!(viewer_status.success(), "viewer should exit cleanly");
    assert!(host_status.success(), "host should exit cleanly");
}
