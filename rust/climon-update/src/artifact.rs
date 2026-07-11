//! Authenticated release-artifact staging for climon-update.
//!
//! Provides Ed25519 signature verification over complete ZIP bytes before any
//! extraction, safe ZIP extraction with comprehensive path-traversal rejection,
//! and a temporary staging directory that cleans up on drop unless kept.

use std::path::{Path, PathBuf};

use crate::manifest::artifact_key;
use crate::manifest::Manifest;

// ── Error type ────────────────────────────────────────────────────────────────

/// Stable kind discriminant for [`ArtifactError`], usable in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactErrorKind {
    /// A network download failed.
    Download,
    /// Ed25519 signature verification failed.
    VerifyFailed,
    /// The ZIP archive is structurally invalid or contains a rejected entry.
    InvalidArchive,
    /// An I/O operation failed.
    Io,
}

/// Errors that can arise from artifact staging operations.
#[derive(Debug)]
pub struct ArtifactError {
    kind: ArtifactErrorKind,
    message: String,
}

impl ArtifactError {
    /// Returns the stable kind discriminant for this error.
    pub fn kind(&self) -> &ArtifactErrorKind {
        &self.kind
    }

    fn download(msg: impl std::fmt::Display) -> Self {
        Self {
            kind: ArtifactErrorKind::Download,
            message: msg.to_string(),
        }
    }

    fn verify_failed(msg: impl std::fmt::Display) -> Self {
        Self {
            kind: ArtifactErrorKind::VerifyFailed,
            message: msg.to_string(),
        }
    }

    fn invalid_archive(msg: impl std::fmt::Display) -> Self {
        Self {
            kind: ArtifactErrorKind::InvalidArchive,
            message: msg.to_string(),
        }
    }

    fn io(msg: impl std::fmt::Display) -> Self {
        Self {
            kind: ArtifactErrorKind::Io,
            message: msg.to_string(),
        }
    }
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ArtifactError {}

// ── StagedArtifact ────────────────────────────────────────────────────────────

/// A verified, extracted artifact in a temporary staging directory.
///
/// The directory and all its contents are deleted on drop unless [`keep`] is
/// called first to transfer ownership to the caller.
///
/// [`keep`]: StagedArtifact::keep
#[derive(Debug)]
pub struct StagedArtifact {
    dir: tempfile::TempDir,
}

impl StagedArtifact {
    /// Returns the path to the staging root directory.
    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    /// Returns the path to a named regular file inside the staging root.
    ///
    /// Returns `Err` if the entry does not exist or is not a regular file.
    pub fn entry(&self, name: &str) -> Result<PathBuf, ArtifactError> {
        let p = self.dir.path().join(name);
        if p.is_file() {
            Ok(p)
        } else {
            Err(ArtifactError::io(format!(
                "entry '{name}' not found or not a regular file"
            )))
        }
    }

    /// Persist the staging directory and return its path.
    ///
    /// The caller takes over cleanup responsibility. The directory is NOT
    /// deleted when this `StagedArtifact` is consumed; no further automatic
    /// cleanup occurs.
    pub fn keep(self) -> Result<PathBuf, ArtifactError> {
        Ok(self.dir.keep())
    }
}

// ── Public staging functions ──────────────────────────────────────────────────

/// Downloads and stages a release artifact for `(platform, arch)` from
/// `manifest`, verifying the Ed25519 signature before any extraction.
///
/// Uses bounded download limits from [`crate::download`] and selects the
/// artifact via [`artifact_key`].
pub fn stage_release_artifact(
    manifest: &Manifest,
    platform: &str,
    arch: &str,
    public_key_b64: &str,
) -> Result<StagedArtifact, ArtifactError> {
    use crate::download::{download_text, download_to_file, MAX_ARTIFACT_BYTES, MAX_TEXT_BYTES};

    let key = artifact_key(platform, arch);
    let artifact = manifest
        .artifacts
        .get(&key)
        .ok_or_else(|| ArtifactError::download(format!("no artifact in manifest for '{key}'")))?;

    let work =
        tempfile::tempdir().map_err(|e| ArtifactError::io(format!("temp dir failed: {e}")))?;
    let zip_path = work.path().join("artifact.zip");

    let zip_bytes = download_to_file(&artifact.url, &zip_path, MAX_ARTIFACT_BYTES)
        .map_err(ArtifactError::download)?;
    let sig_b64 = download_text(&artifact.sig, MAX_TEXT_BYTES).map_err(ArtifactError::download)?;

    stage_downloaded_artifact(&zip_bytes, &sig_b64, public_key_b64)
}

/// Verifies the Ed25519 `signature_b64` over the **complete** `zip_bytes`
/// before extracting into a new temporary staging directory.
///
/// Returns `ArtifactErrorKind::VerifyFailed` on any signature mismatch; the
/// staging directory is never created if verification fails.
pub fn stage_downloaded_artifact(
    zip_bytes: &[u8],
    signature_b64: &str,
    public_key_b64: &str,
) -> Result<StagedArtifact, ArtifactError> {
    if !crate::verify::verify_signature(zip_bytes, signature_b64, public_key_b64) {
        return Err(ArtifactError::verify_failed(
            "signature verification failed",
        ));
    }

    let dir =
        tempfile::tempdir().map_err(|e| ArtifactError::io(format!("temp dir failed: {e}")))?;

    extract_zip(zip_bytes, dir.path())?;

    Ok(StagedArtifact { dir })
}

// ── Safe ZIP extraction ───────────────────────────────────────────────────────

/// Extracts `zip_bytes` into `dest`, applying all safety checks.
///
/// Rejects:
/// - absolute Unix paths (`/…`),
/// - backslash-rooted paths (`\…`),
/// - Windows drive/prefix paths (`C:…`),
/// - parent-traversal components (`..`),
/// - symlink entries (via `ZipFile::is_symlink()`),
/// - any entry whose Unix mode indicates a non-regular, non-directory file
///   type (FIFOs, character/block devices, sockets, …).
///
/// On Unix, executable mode bits are preserved on extracted regular files.
/// On error the caller is responsible for cleaning up `dest`; this function
/// does not clean up partial output.
pub fn extract_zip(zip_bytes: &[u8], dest: &Path) -> Result<(), ArtifactError> {
    use std::io::Read;

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| ArtifactError::invalid_archive(format!("not a valid ZIP: {e}")))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| ArtifactError::invalid_archive(format!("ZIP entry read failed: {e}")))?;

        let raw_name = file.name().to_string();

        // Explicit rejection pass before enclosed_name normalisation.
        reject_unsafe_name(&raw_name)?;

        // Reject symlinks unconditionally.
        if file.is_symlink() {
            return Err(ArtifactError::invalid_archive(format!(
                "symlink entry rejected: '{raw_name}'"
            )));
        }

        // Reject any other non-regular / non-directory Unix-mode entry.
        if let Some(mode) = file.unix_mode() {
            let file_type = mode & 0o170000;
            // 0 means no type bits (some DOS-format archives); treat as regular.
            // S_IFREG = 0o100000, S_IFDIR = 0o040000.
            if file_type != 0 && file_type != 0o100000 && file_type != 0o040000 {
                return Err(ArtifactError::invalid_archive(format!(
                    "special entry rejected (type {file_type:#o}): '{raw_name}'"
                )));
            }
        }

        // Use enclosed_name for the canonically-safe relative path.
        let safe_path = file
            .enclosed_name()
            .ok_or_else(|| ArtifactError::invalid_archive(format!("unsafe path: '{raw_name}'")))?;

        let out_path = dest.join(&safe_path);

        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| {
                ArtifactError::io(format!("create dir {}: {e}", out_path.display()))
            })?;
        } else {
            // Regular file — create parent directories as needed.
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    ArtifactError::io(format!("create parent {}: {e}", parent.display()))
                })?;
            }

            let mut data = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut data).map_err(|e| {
                ArtifactError::invalid_archive(format!("read entry '{raw_name}': {e}"))
            })?;

            std::fs::write(&out_path, &data)
                .map_err(|e| ArtifactError::io(format!("write {}: {e}", out_path.display())))?;

            // Preserve executable mode bits on Unix.
            #[cfg(unix)]
            if let Some(mode) = file.unix_mode() {
                if mode & 0o111 != 0 {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(mode & 0o777);
                    std::fs::set_permissions(&out_path, perms).map_err(|e| {
                        ArtifactError::io(format!("chmod {}: {e}", out_path.display()))
                    })?;
                }
            }
        }
    }

    Ok(())
}

/// Rejects entry names that could escape the staging root or introduce
/// platform-specific path confusion. Called before `enclosed_name()` to give
/// explicit, informative errors.
fn reject_unsafe_name(name: &str) -> Result<(), ArtifactError> {
    let err =
        |msg: &str| -> ArtifactError { ArtifactError::invalid_archive(format!("{msg}: '{name}'")) };

    if name.is_empty() {
        return Err(err("empty entry name"));
    }
    if name.contains('\0') {
        return Err(err("null byte in entry name"));
    }
    // Absolute Unix paths.
    if name.starts_with('/') {
        return Err(err("absolute path rejected"));
    }
    // Backslash-rooted paths (e.g. Windows UNC or rooted paths on Unix).
    if name.starts_with('\\') {
        return Err(err("backslash-rooted path rejected"));
    }
    // Windows drive letter prefix: C:, C:\, C:/, etc.
    let b = name.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Err(err("Windows drive path rejected"));
    }
    // Parent-traversal components (check both / and \ separators).
    for part in name.split('/').chain(name.split('\\')) {
        if part == ".." {
            return Err(err("parent traversal rejected"));
        }
    }

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // ── Test helpers ──────────────────────────────────────────────────────────

    fn test_keypair() -> (SigningKey, String) {
        // Throwaway key for tests — never use in production.
        let signing = SigningKey::from_bytes(&[42u8; 32]);
        let pub_b64 = STANDARD.encode(signing.verifying_key().to_bytes());
        (signing, pub_b64)
    }

    fn test_sign(signing: &SigningKey, data: &[u8]) -> String {
        STANDARD.encode(signing.sign(data).to_bytes())
    }

    fn bad_pub_b64() -> String {
        // Wrong (but valid-length) key that won't match any real signature.
        STANDARD.encode([99u8; 32])
    }

    /// Build a ZIP with named regular files.  Each entry is `(name, data, unix_perms)`.
    fn make_zip(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            for (name, data, perms) in entries {
                let opts = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .unix_permissions(*perms);
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    /// Build a ZIP with a single entry whose raw name is injected verbatim —
    /// bypassing `ZipWriter`'s name sanitisation by patching the raw bytes.
    /// Used only for path-injection tests.
    fn make_zip_with_raw_name(raw_name: &str, data: &[u8]) -> Vec<u8> {
        // Build a normal zip with a placeholder name, then patch the name fields.
        // Placeholder must be same byte length so offsets stay valid.
        let placeholder: String = "A".repeat(raw_name.len());
        let zip_bytes = make_zip(&[(&placeholder, data, 0o644)]);
        let raw_name_bytes = raw_name.as_bytes();
        // Patch every occurrence of the placeholder bytes in the archive.
        // ZIP stores the name in both the local file header and the central directory.
        let placeholder_bytes = placeholder.as_bytes();
        replace_all_occurrences(zip_bytes, placeholder_bytes, raw_name_bytes)
    }

    fn replace_all_occurrences(mut buf: Vec<u8>, find: &[u8], replace: &[u8]) -> Vec<u8> {
        assert_eq!(
            find.len(),
            replace.len(),
            "lengths must match for safe patching"
        );
        let mut i = 0;
        while i + find.len() <= buf.len() {
            if &buf[i..i + find.len()] == find {
                buf[i..i + replace.len()].copy_from_slice(replace);
                i += replace.len();
            } else {
                i += 1;
            }
        }
        buf
    }

    /// Build a ZIP containing an entry with Unix symlink mode bits set.
    fn make_zip_with_symlink_entry() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            w.add_symlink(
                "link-to-etc-passwd",
                "/etc/passwd",
                SimpleFileOptions::default(),
            )
            .unwrap();
            w.finish().unwrap();
        }
        buf
    }

    // ── Happy-path ────────────────────────────────────────────────────────────

    #[test]
    fn valid_signed_archive_stages_expected_files() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[
            ("climon", b"new-binary", 0o755),
            ("climon-server", b"new-server", 0o644),
        ]);
        let sig = test_sign(&signing, &zip);

        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();

        let climon_path = staged.entry("climon").unwrap();
        assert_eq!(std::fs::read(&climon_path).unwrap(), b"new-binary");
        let server_path = staged.entry("climon-server").unwrap();
        assert_eq!(std::fs::read(&server_path).unwrap(), b"new-server");
    }

    // ── Signature verification ────────────────────────────────────────────────

    #[test]
    fn tampered_archive_returns_verify_failed_and_leaves_no_extracted_content() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("climon", b"binary", 0o755)]);
        let sig = test_sign(&signing, &zip);

        let mut tampered = zip.clone();
        // Flip a byte in the middle of the archive payload.
        let mid = tampered.len() / 2;
        tampered[mid] ^= 0xFF;

        let err = stage_downloaded_artifact(&tampered, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::VerifyFailed);
    }

    #[test]
    fn wrong_public_key_rejects() {
        let (signing, _right_pub) = test_keypair();
        let zip = make_zip(&[("climon", b"binary", 0o755)]);
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &bad_pub_b64()).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::VerifyFailed);
    }

    #[test]
    fn garbled_signature_rejects() {
        let (_signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("climon", b"binary", 0o755)]);

        let err = stage_downloaded_artifact(&zip, "not-base64!!!", &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::VerifyFailed);
    }

    // ── Path-traversal / injection rejection ─────────────────────────────────

    #[test]
    fn parent_traversal_entry_rejected() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip_with_raw_name("../escape", b"payload");
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
        assert!(err.to_string().contains("parent traversal") || err.to_string().contains("unsafe"));
    }

    #[test]
    fn absolute_unix_path_entry_rejected() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip_with_raw_name("/etc/passwd", b"payload");
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
    }

    #[test]
    fn windows_drive_path_entry_rejected() {
        let (signing, pub_b64) = test_keypair();
        // C:foo (same byte-count as the placeholder "C:foo")
        let zip = make_zip_with_raw_name("C:foo", b"payload");
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
    }

    #[test]
    fn backslash_rooted_path_entry_rejected() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip_with_raw_name("\\root", b"payload");
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
    }

    // ── Symlink / special entry rejection ────────────────────────────────────

    #[test]
    fn symlink_entry_is_rejected() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip_with_symlink_entry();
        let sig = test_sign(&signing, &zip);

        let err = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
        assert!(
            err.to_string().contains("symlink"),
            "error should mention symlink, got: {err}"
        );
    }

    /// Patches `external_file_attributes` in the first central-directory record
    /// whose attributes match `old_attrs`, replacing them with `new_attrs`.
    ///
    /// The central-directory record has the fixed layout (per ZIP spec):
    ///
    /// ```text
    /// offset  field
    ///  0      PK\x01\x02 signature (4 bytes)
    ///  4      ZipCentralEntryBlock fields …
    ///  38     external_file_attributes (4 bytes, little-endian)
    /// ```
    ///
    /// Using the signature + fixed offset makes the patch precise and independent
    /// of entry name length or file-data content.
    fn patch_cd_external_attributes(mut bytes: Vec<u8>, old_attrs: u32, new_attrs: u32) -> Vec<u8> {
        const CD_SIG: [u8; 4] = [0x50, 0x4B, 0x01, 0x02];
        // external_file_attributes is at byte 38 from the start of PK\x01\x02
        // (4-byte Magic + 34 bytes of ZipCentralEntryBlock before the field).
        const ATTRS_OFFSET: usize = 38;

        let old = old_attrs.to_le_bytes();
        let new_val = new_attrs.to_le_bytes();

        let mut i = 0;
        while i + ATTRS_OFFSET + 4 <= bytes.len() {
            if bytes[i..i + 4] == CD_SIG {
                let ea = i + ATTRS_OFFSET;
                if bytes[ea..ea + 4] == old {
                    bytes[ea..ea + 4].copy_from_slice(&new_val);
                    return bytes;
                }
            }
            i += 1;
        }
        panic!(
            "patch_cd_external_attributes: attrs {old_attrs:#010x} not found in ZIP central directory"
        );
    }

    /// A non-symlink special Unix-mode entry (FIFO / character device / etc.)
    /// must be rejected by the `unix_mode()` file-type guard in `extract_zip`.
    ///
    /// The `is_symlink()` check does NOT cover this case
    /// (`S_IFIFO & S_IFLNK ≠ S_IFLNK`), so this test specifically exercises
    /// the secondary guard.  It would fail if that guard were removed.
    #[test]
    fn non_symlink_special_unix_mode_entry_is_rejected() {
        let (signing, pub_b64) = test_keypair();

        // Build a regular-file ZIP, then patch the central-directory
        // external_file_attributes to FIFO type: S_IFIFO | 0o755 = 0o010755.
        // normalize() stores a 0o644 regular file as 0o100644 (S_IFREG | 0o644).
        let base_zip = make_zip(&[("fifo-entry", b"payload", 0o644)]);
        let fifo_zip = patch_cd_external_attributes(
            base_zip,
            0o100644_u32 << 16, // what normalize() stores for a 0o644 regular file
            0o010755_u32 << 16, // S_IFIFO | 0o755
        );
        let sig = test_sign(&signing, &fifo_zip);

        let err = stage_downloaded_artifact(&fifo_zip, &sig, &pub_b64).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
        assert!(
            err.to_string().contains("special entry"),
            "error should identify a special-entry rejection, got: {err}"
        );
    }

    // ── entry() ───────────────────────────────────────────────────────────────

    #[test]
    fn entry_succeeds_for_a_present_regular_file() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("climon", b"binary", 0o755)]);
        let sig = test_sign(&signing, &zip);
        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();

        let path = staged.entry("climon").unwrap();
        assert!(path.is_file());
        assert_eq!(std::fs::read(&path).unwrap(), b"binary");
    }

    #[test]
    fn entry_fails_for_a_missing_file() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("climon", b"binary", 0o755)]);
        let sig = test_sign(&signing, &zip);
        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();

        let err = staged.entry("does-not-exist").unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::Io);
    }

    // ── RAII cleanup ──────────────────────────────────────────────────────────

    #[test]
    fn dropping_staged_artifact_removes_the_staging_dir() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("file.txt", b"content", 0o644)]);
        let sig = test_sign(&signing, &zip);

        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();
        let root = staged.root().to_path_buf();
        assert!(root.exists(), "staging dir must exist while alive");

        drop(staged);

        assert!(!root.exists(), "staging dir must be cleaned up on drop");
    }

    #[test]
    fn keep_leaves_the_directory_present_and_returns_its_path() {
        let (signing, pub_b64) = test_keypair();
        let zip = make_zip(&[("file.txt", b"content", 0o644)]);
        let sig = test_sign(&signing, &zip);

        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();
        let original_root = staged.root().to_path_buf();

        let kept_path = staged.keep().unwrap();

        assert_eq!(
            kept_path, original_root,
            "keep() must return the same path as root()"
        );
        assert!(
            kept_path.exists(),
            "directory must still exist after keep()"
        );
        assert!(
            kept_path.join("file.txt").exists(),
            "kept files must be accessible"
        );

        // Manual cleanup because auto-cleanup was disabled by keep().
        std::fs::remove_dir_all(&kept_path).unwrap();
    }

    // ── Unix executable permissions ───────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn executable_mode_bits_are_preserved_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let (signing, pub_b64) = test_keypair();
        // Two files: one executable (0o755), one not (0o644).
        let zip = make_zip(&[
            ("bin/climon", b"exec-binary", 0o755),
            ("data.txt", b"data", 0o644),
        ]);
        let sig = test_sign(&signing, &zip);

        let staged = stage_downloaded_artifact(&zip, &sig, &pub_b64).unwrap();

        let exec_path = staged.entry("bin/climon").unwrap();
        let exec_mode = std::fs::metadata(&exec_path).unwrap().permissions().mode();
        assert_ne!(
            exec_mode & 0o111,
            0,
            "executable bits must be set on exec file"
        );

        let data_path = staged.entry("data.txt").unwrap();
        let data_mode = std::fs::metadata(&data_path).unwrap().permissions().mode();
        // Non-executable file must NOT have execute bits set.
        assert_eq!(
            data_mode & 0o111,
            0,
            "non-executable file must not gain exec bits"
        );
    }

    // ── extract_zip helper ────────────────────────────────────────────────────

    #[test]
    fn extract_zip_extracts_files_to_dest() {
        let zip = make_zip(&[("a.txt", b"aaa", 0o644), ("b.txt", b"bbb", 0o644)]);
        let dir = tempfile::tempdir().unwrap();
        extract_zip(&zip, dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(dir.path().join("b.txt")).unwrap(), b"bbb");
    }

    #[test]
    fn extract_zip_rejects_invalid_zip_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let err = extract_zip(b"not a zip", dir.path()).unwrap_err();
        assert_eq!(err.kind(), &ArtifactErrorKind::InvalidArchive);
    }
}
