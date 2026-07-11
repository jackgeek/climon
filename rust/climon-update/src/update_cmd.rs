//! `climon update` core: select, verify, stage, and delegate installation.
//!
//! Never kills a process for the expected outcomes; returns a structured status.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, ExitStatus};

use crate::artifact::{stage_release_artifact, ArtifactErrorKind};
use crate::manifest::{artifact_key, is_newer, Manifest};

/// Outcome status of an update attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStatus {
    Updated,
    UpToDate,
    VerifyFailed,
    NoArtifact,
}

/// Structured result of [`run_update_command`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateResult {
    pub status: UpdateStatus,
    pub version: Option<String>,
}

/// Inputs for [`run_update_command`]. `platform`/`arch` are node-style strings.
pub struct UpdateCommandOptions<'a> {
    pub install_dir: &'a Path,
    pub current_version: &'a str,
    pub manifest: &'a Manifest,
    pub public_key_b64: &'a str,
    pub platform: &'a str,
    pub arch: &'a str,
}

const MSG_UP_TO_DATE: &str = "climon is already up to date";
const MSG_VERIFY_FAILED: &str =
    "Update aborted: signature verification failed. No changes were made.";

/// Executes the verified installer entrypoint.
pub trait InstallerRunner {
    fn run(&mut self, program: &Path, args: &[OsString]) -> Result<ExitStatus, String>;
}

/// Runs the installer directly, without a shell.
pub struct CommandInstallerRunner;

impl InstallerRunner for CommandInstallerRunner {
    fn run(&mut self, program: &Path, args: &[OsString]) -> Result<ExitStatus, String> {
        Command::new(program)
            .args(args)
            .status()
            .map_err(|e| format!("run installer {} failed: {e}", program.display()))
    }
}

fn installer_name(platform: &str) -> &'static str {
    if platform == "win32" {
        "install.exe"
    } else {
        "install"
    }
}

fn format_installer_failure(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("installer exited with code {code}"),
        None => "installer terminated without an exit code".to_string(),
    }
}

/// Downloads and verifies a complete release ZIP, stages it safely, and delegates
/// validation and placement to the release's stable installer entrypoint.
pub fn run_update_command(
    opts: &UpdateCommandOptions,
    runner: &mut dyn InstallerRunner,
    print: &mut dyn FnMut(&str),
) -> Result<UpdateResult, String> {
    if !is_newer(opts.manifest, opts.current_version) {
        print(&format!("{MSG_UP_TO_DATE} ({}).\n", opts.current_version));
        return Ok(UpdateResult {
            status: UpdateStatus::UpToDate,
            version: None,
        });
    }

    let key = artifact_key(opts.platform, opts.arch);
    if !opts.manifest.artifacts.contains_key(&key) {
        return Ok(UpdateResult {
            status: UpdateStatus::NoArtifact,
            version: None,
        });
    }

    let staged = match stage_release_artifact(
        opts.manifest,
        opts.platform,
        opts.arch,
        opts.public_key_b64,
    ) {
        Ok(staged) => staged,
        Err(error) if error.kind() == &ArtifactErrorKind::VerifyFailed => {
            print(&format!("{MSG_VERIFY_FAILED}\n"));
            return Ok(UpdateResult {
                status: UpdateStatus::VerifyFailed,
                version: None,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let installer = staged
        .entry(installer_name(opts.platform))
        .map_err(|e| e.to_string())?;
    let args = vec![
        OsString::from("--apply-update-v1"),
        OsString::from("--dir"),
        opts.install_dir.as_os_str().to_owned(),
        OsString::from("--source"),
        staged.root().as_os_str().to_owned(),
        OsString::from("--version"),
        OsString::from(&opts.manifest.version),
    ];
    let status = runner.run(&installer, &args)?;
    if !status.success() {
        return Err(format_installer_failure(status));
    }

    print(&format!(
        "Update applied. Start new sessions (or restart the server) to use {}.\n",
        opts.manifest.version
    ));
    Ok(UpdateResult {
        status: UpdateStatus::Updated,
        version: Some(opts.manifest.version.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ManifestArtifact;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::BTreeMap;
    use std::ffi::{OsStr, OsString};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::ExitStatus;
    use zip::write::SimpleFileOptions;

    fn node_arch() -> &'static str {
        crate::manifest::current_node_arch()
    }

    fn make_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in [
                ("install", "verified-installer"),
                ("climon", "new-binary"),
                ("climon-server", "new-server"),
            ] {
                w.start_file(name, opts).unwrap();
                w.write_all(data.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    /// Serves the zip at /artifact.zip and the sig at /artifact.zip.sig
    /// until both have been fetched once. Returns the bound port.
    fn serve(zip_path: &'static str, zip_body: Vec<u8>, sig_body: String) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..2 {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 2048];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.split_whitespace().nth(1).unwrap_or("");
                    let body: Vec<u8> = if path == zip_path {
                        zip_body.clone()
                    } else if path == "/artifact.zip.sig" {
                        sig_body.clone().into_bytes()
                    } else {
                        b"nope".to_vec()
                    };
                    let mut resp =
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len())
                            .into_bytes();
                    resp.extend_from_slice(&body);
                    let _ = stream.write_all(&resp);
                    let _ = stream.flush();
                }
            }
        });
        port
    }

    fn keypair() -> (SigningKey, String) {
        let signing = SigningKey::from_bytes(&[11u8; 32]);
        let pub_b64 = STANDARD.encode(signing.verifying_key().to_bytes());
        (signing, pub_b64)
    }

    fn sign(signing: &SigningKey, bytes: &[u8]) -> String {
        STANDARD.encode(signing.sign(bytes).to_bytes())
    }

    fn manifest(port: u16, zip_path: &str) -> Manifest {
        let base = format!("http://127.0.0.1:{port}");
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            format!("linux-{}", node_arch()),
            ManifestArtifact {
                url: format!("{base}{zip_path}"),
                sig: format!("{base}/artifact.zip.sig"),
            },
        );
        Manifest {
            version: "9.9.0".to_string(),
            encryption: None,
            artifacts,
        }
    }

    struct RecordingRunner {
        calls: Vec<(PathBuf, Vec<OsString>)>,
        status: Option<ExitStatus>,
        source_contained_program: bool,
    }

    impl RecordingRunner {
        fn returning(status: ExitStatus) -> Self {
            Self {
                calls: Vec::new(),
                status: Some(status),
                source_contained_program: false,
            }
        }
    }

    impl InstallerRunner for RecordingRunner {
        fn run(&mut self, program: &Path, args: &[OsString]) -> Result<ExitStatus, String> {
            let source = PathBuf::from(&args[4]);
            self.source_contained_program =
                program == source.join(installer_name("linux")).canonicalize().unwrap();
            self.calls.push((program.to_path_buf(), args.to_vec()));
            Ok(self.status.take().unwrap())
        }
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: u32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code)
    }

    #[test]
    fn verified_update_invokes_stable_installer_with_exact_protocol_args() {
        let (signing, pub_b64) = keypair();
        let zip = make_zip();
        let sig = sign(&signing, &zip);
        let port = serve("/artifact.zip", zip, sig);
        let dir = tempfile::tempdir().unwrap();
        let m = manifest(port, "/artifact.zip");
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.12.1",
            manifest: &m,
            public_key_b64: &pub_b64,
            platform: "linux",
            arch: node_arch(),
        };
        let mut runner = RecordingRunner::returning(exit_status(0));

        let res = run_update_command(&opts, &mut runner, &mut |_| {}).unwrap();

        assert_eq!(res.status, UpdateStatus::Updated);
        assert_eq!(runner.calls.len(), 1);
        assert!(runner.source_contained_program);
        let (program, args) = &runner.calls[0];
        assert_eq!(program.file_name(), Some(OsStr::new("install")));
        assert_eq!(
            args,
            &vec![
                OsString::from("--apply-update-v1"),
                OsString::from("--dir"),
                dir.path().as_os_str().to_owned(),
                OsString::from("--source"),
                args[4].clone(),
                OsString::from("--version"),
                OsString::from("9.9.0"),
            ]
        );
    }

    #[test]
    fn signature_failure_never_launches_installer() {
        let (signing, _pub) = keypair();
        let zip = make_zip();
        let sig = sign(&signing, &zip);
        let port = serve("/artifact.zip", zip, sig);
        let dir = tempfile::tempdir().unwrap();
        let m = manifest(port, "/artifact.zip");
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.12.1",
            manifest: &m,
            public_key_b64: "AAAA", // wrong key -> verification fails
            platform: "linux",
            arch: node_arch(),
        };
        let mut runner = RecordingRunner::returning(exit_status(0));

        let res = run_update_command(&opts, &mut runner, &mut |_| {}).unwrap();

        assert_eq!(res.status, UpdateStatus::VerifyFailed);
        assert!(runner.calls.is_empty());
    }

    #[test]
    fn installer_exit_code_is_reported_as_update_failure() {
        let (signing, pub_b64) = keypair();
        let zip = make_zip();
        let sig = sign(&signing, &zip);
        let port = serve("/artifact.zip", zip, sig);
        let dir = tempfile::tempdir().unwrap();
        let m = manifest(port, "/artifact.zip");
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.12.1",
            manifest: &m,
            public_key_b64: &pub_b64,
            platform: "linux",
            arch: node_arch(),
        };
        let mut runner = RecordingRunner::returning(exit_status(17));

        let error = run_update_command(&opts, &mut runner, &mut |_| {}).unwrap_err();

        assert!(error.contains("installer exited with code 17"), "{error}");
        assert_eq!(runner.calls.len(), 1);
    }

    #[test]
    fn already_up_to_date_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manifest {
            version: "0.99.0".to_string(),
            encryption: None,
            artifacts: BTreeMap::new(),
        };
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.99.0",
            manifest: &m,
            public_key_b64: "",
            platform: "linux",
            arch: node_arch(),
        };
        let mut runner = RecordingRunner::returning(exit_status(0));
        let res = run_update_command(&opts, &mut runner, &mut |_| {}).unwrap();
        assert_eq!(res.status, UpdateStatus::UpToDate);
        assert!(runner.calls.is_empty());
    }
}
