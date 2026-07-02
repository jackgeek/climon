//! `climon update` core: download, verify, and apply. Port of
//! `src/update/update-cmd.ts`.
//!
//! Never kills a process for the expected outcomes; returns a structured status.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use crate::download::{download_text, download_to_file, MAX_ARTIFACT_BYTES, MAX_TEXT_BYTES};
use crate::install_manifest::install_files_for_platform;
use crate::manifest::{artifact_key, is_newer, Manifest};
use crate::swap::{cleanup_old_files, remove_orphan_files, replace_file_atomic};
use crate::verify::verify_signature;

/// Outcome status of an update attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStatus {
    Updated,
    UpToDate,
    VerifyFailed,
    Deferred,
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
const MSG_DEFERRED: &str =
    "Update could not be applied right now (files in use). Will retry later.";

/// Files that earlier versions installed but newer releases no longer ship.
/// Deleted from the install dir on a successful update.
const REMOVED_FILES: &[&str] = &["climon-beta"];

/// Downloads, verifies, and applies an update without ever killing a process.
/// Returns a structured status; only unexpected I/O errors propagate as `Err`.
pub fn run_update_command(
    opts: &UpdateCommandOptions,
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
    let artifact = match opts.manifest.artifacts.get(&key) {
        Some(a) => a,
        None => {
            return Ok(UpdateResult {
                status: UpdateStatus::NoArtifact,
                version: None,
            })
        }
    };

    let work = tempfile::tempdir().map_err(|e| format!("temp dir failed: {e}"))?;
    let zip_path = work.path().join("artifact.zip");
    let downloaded = download_to_file(&artifact.url, &zip_path, MAX_ARTIFACT_BYTES)?;
    let sig_b64 = download_text(&artifact.sig, MAX_TEXT_BYTES)?;
    let zip_bytes = downloaded;

    if !verify_signature(&zip_bytes, &sig_b64, opts.public_key_b64) {
        print(&format!("{MSG_VERIFY_FAILED}\n"));
        return Ok(UpdateResult {
            status: UpdateStatus::VerifyFailed,
            version: None,
        });
    }

    let unzipped = unzip(&zip_bytes)?;
    let files = install_files_for_platform(opts.platform);
    let mut deferred = false;
    for f in &files {
        let data = match unzipped.get(&f.source) {
            Some(d) => d,
            None => continue, // optional files (e.g. future locale packs) may be absent
        };
        let result = replace_file_atomic(opts.install_dir, &f.dest, data)?;
        if result.deferred {
            deferred = true;
        }
    }
    let dests: Vec<String> = files.iter().map(|f| f.dest.clone()).collect();
    cleanup_old_files(opts.install_dir, &dests);

    if deferred {
        print(&format!("{MSG_DEFERRED}\n"));
        return Ok(UpdateResult {
            status: UpdateStatus::Deferred,
            version: Some(opts.manifest.version.clone()),
        });
    }
    remove_orphan_files(opts.install_dir, REMOVED_FILES);
    print(&format!(
        "Update applied. Start new sessions (or restart the server) to use {}.\n",
        opts.manifest.version
    ));
    Ok(UpdateResult {
        status: UpdateStatus::Updated,
        version: Some(opts.manifest.version.clone()),
    })
}

/// Extracts all entries from a ZIP archive into a name->bytes map.
fn unzip(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("unzip failed: {e}"))?;
    let mut out = HashMap::new();
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("unzip entry failed: {e}"))?;
        if !file.is_file() {
            continue;
        }
        let name = file.name().to_string();
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data)
            .map_err(|e| format!("unzip read failed: {e}"))?;
        out.insert(name, data);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ManifestArtifact;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::net::TcpListener;
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
            for (name, data) in [("install", "new-binary"), ("climon-server", "new-server")] {
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

    fn install_dir() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("climon"), "old-binary").unwrap();
        std::fs::write(d.path().join("climon-server"), "old-server").unwrap();
        std::fs::write(d.path().join("climon-beta"), "old-beta").unwrap();
        d
    }

    fn manifest(port: u16, zip_path: &str, encryption: Option<&str>) -> Manifest {
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
            version: "0.99.0".to_string(),
            encryption: encryption.map(|s| s.to_string()),
            artifacts,
        }
    }

    #[test]
    fn verified_update_replaces_install_files_on_unix() {
        let (signing, pub_b64) = keypair();
        let zip = make_zip();
        let sig = sign(&signing, &zip);
        let port = serve("/artifact.zip", zip, sig);
        let dir = install_dir();
        let m = manifest(port, "/artifact.zip", None);
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.12.1",
            manifest: &m,
            public_key_b64: &pub_b64,
            platform: "linux",
            arch: node_arch(),
        };
        let res = run_update_command(&opts, &mut |_| {}).unwrap();
        assert_eq!(res.status, UpdateStatus::Updated);
        assert_eq!(
            std::fs::read(dir.path().join("climon")).unwrap(),
            b"new-binary"
        );
        assert_eq!(
            std::fs::read(dir.path().join("climon-server")).unwrap(),
            b"new-server"
        );
        assert!(
            !dir.path().join("climon-beta").exists(),
            "orphaned climon-beta should be removed on update"
        );
    }

    #[test]
    fn tampered_artifact_is_rejected_and_files_are_unchanged() {
        let (signing, _pub) = keypair();
        let zip = make_zip();
        let sig = sign(&signing, &zip);
        let port = serve("/artifact.zip", zip, sig);
        let dir = install_dir();
        let m = manifest(port, "/artifact.zip", None);
        let opts = UpdateCommandOptions {
            install_dir: dir.path(),
            current_version: "0.12.1",
            manifest: &m,
            public_key_b64: "AAAA", // wrong key -> verification fails
            platform: "linux",
            arch: node_arch(),
        };
        let res = run_update_command(&opts, &mut |_| {}).unwrap();
        assert_eq!(res.status, UpdateStatus::VerifyFailed);
        assert_eq!(
            std::fs::read(dir.path().join("climon")).unwrap(),
            b"old-binary"
        );
    }

    #[test]
    fn already_up_to_date_is_a_no_op() {
        let dir = install_dir();
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
        let res = run_update_command(&opts, &mut |_| {}).unwrap();
        assert_eq!(res.status, UpdateStatus::UpToDate);
    }
}
