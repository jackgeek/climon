# Windows Bootstrap Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first Windows stub release safe for every legacy installation by turning a mistakenly renamed `install.exe` into a signed recovery bootstrap, then move all stub-generation file placement behind a stable installer-owned update contract.

**Architecture:** `climon-update` will expose one shared verified-artifact staging API used by both the normal updater and `climon-setup`. On Windows, the client downloads and verifies a release but delegates placement to staged `install.exe --update`; if an already-shipped updater instead copies `install.exe` to `climon.exe`, `climon-setup` detects that basename, redownloads and verifies the release, spawns a staged recovery installer, exits to release its lock, and requires the user to rerun `climon`. Failed bootstrap recovery executes the preserved `climon.exe.old` for non-update commands.

**Tech Stack:** Rust workspace (`climon-update`, `climon-install`, `climon-setup`), `windows-sys`, Bun/TypeScript packaging and Windows harness, Ed25519 release signatures, existing `bun:test` and Cargo test suites.

---

## File Structure

| Path | Responsibility |
|---|---|
| `rust/climon-update/src/artifact.rs` | Download, signature verification, safe ZIP validation, and staging of a release artifact |
| `rust/climon-update/src/update_cmd.rs` | Version decision and delegation to the staged installer; Unix swap remains here |
| `rust/climon-update/src/update_cli.rs` | Public production/test manifest URL resolution shared with bootstrap |
| `rust/climon-install/src/installer.rs` | Stable `--migrate`, `--update`, and `--recover-bootstrap` installer operation parsing and execution |
| `rust/climon-install/src/wait.rs` | Cross-platform wait-for-process helper; real Windows handle wait and testable polling fallback |
| `rust/climon-setup/src/bootstrap.rs` | Executable-name mode selection, recovery download/spawn, and `.old` fallback orchestration |
| `rust/climon-setup/src/main.rs` | Thin runtime composition for installer mode versus recovery-bootstrap mode |
| `rust/climon-setup/Cargo.toml` | Shared updater dependency and test-endpoint feature forwarding |
| `rust/climon-install/Cargo.toml` | Windows process-wait dependency |
| `rust/climon-update/src/lib.rs` | Export the shared artifact module |
| `scripts/compile.ts` | Forward the test endpoint feature into `climon-setup` harness builds |
| `scripts/upgrade-test-harness.ts` | Direct legacy-to-bootstrap-to-stub, offline fallback, and installer-owned C-to-C+1 scenarios |
| `scripts/upgrade-harness/pack.ts` | Assertions for bootstrap and stub layouts |
| `tests/upgrade-harness.test.ts` | Pure packaging/layout helper tests |
| `docs/architecture.md` | Installer-owned update protocol and bootstrap migration flow |
| `docs/security.md` | Bootstrap signature, staging, process, and fallback trust boundaries |
| `docs/manual-tests/windows-binary-lifecycle.md` | Direct migration and offline fallback manual cases |
| `docs/features.md` | Correct the existing Windows lifecycle description |
| `CHANGELOG.json` | Replace bridge-adoption wording with direct skip-safe migration |

---

### Task 1: Shared Verified Artifact Staging

**Files:**
- Create: `rust/climon-update/src/artifact.rs`
- Modify: `rust/climon-update/src/lib.rs`
- Modify: `rust/climon-update/src/update_cmd.rs`
- Test: `rust/climon-update/src/artifact.rs`

- [ ] **Step 1: Write failing artifact validation tests**

Add tests defining the public staging contract:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    fn signed_zip(entries: &[(&str, &[u8])]) -> (Vec<u8>, String, String) {
        let mut bytes = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            for (name, body) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(body).unwrap();
            }
            zip.finish().unwrap();
        }
        let key = SigningKey::from_bytes(&[29; 32]);
        let signature = STANDARD.encode(key.sign(&bytes).to_bytes());
        let public_key = STANDARD.encode(key.verifying_key().to_bytes());
        (bytes, signature, public_key)
    }

    #[test]
    fn stage_verified_zip_writes_only_safe_relative_files() {
        let (zip, sig, key) =
            signed_zip(&[("install.exe", b"setup"), ("nested/file.txt", b"ok")]);
        let root = tempfile::tempdir().unwrap();
        let staged = stage_verified_zip(&zip, &sig, &key, root.path()).unwrap();
        assert_eq!(
            std::fs::read(staged.path().join("install.exe")).unwrap(),
            b"setup"
        );
        assert_eq!(
            std::fs::read(staged.path().join("nested/file.txt")).unwrap(),
            b"ok"
        );
    }

    #[test]
    fn stage_verified_zip_rejects_bad_signature_without_writing_files() {
        let (zip, _, key) = signed_zip(&[("install.exe", b"setup")]);
        let root = tempfile::tempdir().unwrap();
        let err = stage_verified_zip(&zip, "AAAA", &key, root.path()).unwrap_err();
        assert!(err.contains("signature verification failed"));
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[test]
    fn stage_verified_zip_rejects_parent_and_absolute_paths() {
        for name in ["../escape.exe", "/absolute.exe", r"C:\escape.exe"] {
            let (zip, sig, key) = signed_zip(&[(name, b"bad")]);
            let root = tempfile::tempdir().unwrap();
            let err = stage_verified_zip(&zip, &sig, &key, root.path()).unwrap_err();
            assert!(err.contains("unsafe ZIP entry"));
        }
    }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
cd rust
cargo test -p climon-update artifact
```

Expected: compilation fails because `stage_verified_zip` and `artifact` do not exist.

- [ ] **Step 3: Implement the safe staging module**

Create `rust/climon-update/src/artifact.rs` with these public types and functions:

```rust
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::download::{download_text, download_to_file, MAX_ARTIFACT_BYTES, MAX_TEXT_BYTES};
use crate::manifest::{artifact_key, Manifest};
use crate::verify::verify_signature;

#[derive(Debug)]
pub struct StagedArtifact {
    root: tempfile::TempDir,
    pub version: String,
}

impl StagedArtifact {
    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub fn keep(self) -> PathBuf {
        self.root.keep()
    }
}

pub fn download_and_stage_artifact(
    manifest: &Manifest,
    platform: &str,
    arch: &str,
    public_key_b64: &str,
    staging_parent: &Path,
) -> Result<Option<StagedArtifact>, String> {
    let Some(artifact) = manifest.artifacts.get(&artifact_key(platform, arch)) else {
        return Ok(None);
    };
    std::fs::create_dir_all(staging_parent)
        .map_err(|e| format!("create staging parent {} failed: {e}", staging_parent.display()))?;
    let download_dir = tempfile::Builder::new()
        .prefix(".climon-download-")
        .tempdir_in(staging_parent)
        .map_err(|e| format!("create download staging failed: {e}"))?;
    let zip_path = download_dir.path().join("artifact.zip");
    let zip_bytes = download_to_file(&artifact.url, &zip_path, MAX_ARTIFACT_BYTES)?;
    let signature = download_text(&artifact.sig, MAX_TEXT_BYTES)?;
    let staged_path = stage_verified_zip(
        &zip_bytes,
        &signature,
        public_key_b64,
        staging_parent,
    )?;
    Ok(Some(StagedArtifact {
        root: staged_path,
        version: manifest.version.clone(),
    }))
}

pub fn stage_verified_zip(
    zip_bytes: &[u8],
    signature_b64: &str,
    public_key_b64: &str,
    staging_parent: &Path,
) -> Result<tempfile::TempDir, String> {
    if !verify_signature(zip_bytes, signature_b64, public_key_b64) {
        return Err("signature verification failed; no files were staged".to_string());
    }
    let stage = tempfile::Builder::new()
        .prefix(".climon-stage-")
        .tempdir_in(staging_parent)
        .map_err(|e| format!("create artifact staging failed: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("unzip failed: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("unzip entry failed: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let relative = PathBuf::from(entry.name());
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("unsafe ZIP entry: {}", entry.name()));
        }
        let destination = stage.path().join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {} failed: {e}", parent.display()))?;
        }
        let mut output = std::fs::File::create(&destination)
            .map_err(|e| format!("create {} failed: {e}", destination.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("write {} failed: {e}", destination.display()))?;
    }
    Ok(stage)
}
```

Export it from `rust/climon-update/src/lib.rs`:

```rust
pub mod artifact;
```

Replace `update_cmd.rs`'s private ZIP extraction/download block with `download_and_stage_artifact`; keep the existing Windows and Unix application behavior unchanged in this task.

- [ ] **Step 4: Run focused and existing updater tests**

Run:

```bash
cd rust
cargo test -p climon-update artifact
cargo test -p climon-update update_cmd
```

Expected: all artifact and updater tests pass.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-update/src/artifact.rs rust/climon-update/src/lib.rs rust/climon-update/src/update_cmd.rs
git commit -m "refactor(update): share verified artifact staging"
```

---

### Task 2: Stable Installer Operation Contract

**Files:**
- Create: `rust/climon-install/src/wait.rs`
- Modify: `rust/climon-install/src/lib.rs`
- Modify: `rust/climon-install/src/installer.rs`
- Modify: `rust/climon-install/Cargo.toml`
- Test: `rust/climon-install/src/installer.rs`
- Test: `rust/climon-install/src/wait.rs`

- [ ] **Step 1: Write failing argument parsing tests**

Add these tests beside the existing migrate parser tests:

```rust
#[test]
fn parses_update_operation() {
    assert_eq!(
        parse_installer_operation(&strings(&[
            "--update",
            "--dir",
            r"C:\climon",
            "--source",
            r"C:\stage",
            "--version",
            "3.2.0",
        ])),
        Some(InstallerOperation::Update(ApplyArgs {
            dir: PathBuf::from(r"C:\climon"),
            source: PathBuf::from(r"C:\stage"),
            version: "3.2.0".to_string(),
        }))
    );
}

#[test]
fn parses_recovery_operation_with_parent_pid() {
    assert_eq!(
        parse_installer_operation(&strings(&[
            "--recover-bootstrap",
            "--dir",
            r"C:\climon",
            "--source",
            r"C:\stage",
            "--version",
            "3.2.0",
            "--wait-pid",
            "42",
        ])),
        Some(InstallerOperation::RecoverBootstrap {
            apply: ApplyArgs {
                dir: PathBuf::from(r"C:\climon"),
                source: PathBuf::from(r"C:\stage"),
                version: "3.2.0".to_string(),
            },
            wait_pid: 42,
        })
    );
}

#[test]
fn rejects_partial_headless_operations() {
    assert_eq!(
        parse_installer_operation(&strings(&["--update", "--dir", r"C:\climon"])),
        None
    );
}
```

- [ ] **Step 2: Run the parser tests and verify they fail**

Run:

```bash
cd rust
cargo test -p climon-install installer::tests::parses_
```

Expected: compilation fails because `InstallerOperation`, `ApplyArgs`, and `parse_installer_operation` do not exist.

- [ ] **Step 3: Add installer operation types and parsing**

Replace the migrate-only parser with:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyArgs {
    pub dir: PathBuf,
    pub source: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallerOperation {
    Migrate(ApplyArgs),
    Update(ApplyArgs),
    RecoverBootstrap { apply: ApplyArgs, wait_pid: u32 },
}

pub fn parse_installer_operation(argv: &[String]) -> Option<InstallerOperation> {
    let mode = if argv.iter().any(|arg| arg == "--recover-bootstrap") {
        "recover"
    } else if argv.iter().any(|arg| arg == "--update") {
        "update"
    } else if argv.iter().any(|arg| arg == "--migrate") {
        "migrate"
    } else {
        return None;
    };
    let mut dir = None;
    let mut source = None;
    let mut version = None;
    let mut wait_pid = None;
    let mut args = argv.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dir" => dir = args.next().map(PathBuf::from),
            "--source" => source = args.next().map(PathBuf::from),
            "--version" => version = args.next().cloned(),
            "--wait-pid" => wait_pid = args.next().and_then(|value| value.parse().ok()),
            _ => {}
        }
    }
    let apply = ApplyArgs {
        dir: dir?,
        source: source?,
        version: version?,
    };
    match mode {
        "recover" => Some(InstallerOperation::RecoverBootstrap {
            apply,
            wait_pid: wait_pid?,
        }),
        "update" => Some(InstallerOperation::Update(apply)),
        "migrate" => Some(InstallerOperation::Migrate(apply)),
        _ => unreachable!(),
    }
}
```

Keep backward compatibility for the existing harness by allowing `--migrate` without `--version` to use the installer's embedded `VERSION`; pass that version into the parser as a default rather than changing the existing public command.

- [ ] **Step 4: Write failing wait-helper tests**

Create `rust/climon-install/src/wait.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn polling_wait_stops_when_process_exits() {
        let checks = Cell::new(0);
        let result = wait_for_process_with(
            42,
            std::time::Duration::from_millis(50),
            || {
                let next = checks.get() + 1;
                checks.set(next);
                next < 3
            },
            |_| {},
        );
        assert!(result.is_ok());
        assert_eq!(checks.get(), 3);
    }

    #[test]
    fn polling_wait_times_out() {
        let error = wait_for_process_with(
            42,
            std::time::Duration::from_millis(1),
            || true,
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
    }
}
```

- [ ] **Step 5: Implement the process wait**

Add a pure `wait_for_process_with` loop for tests and this Windows implementation:

```rust
use std::time::Duration;

#[cfg(windows)]
pub fn wait_for_process_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, SYNCHRONIZE,
    };

    let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: OpenProcess is called with only SYNCHRONIZE access; every non-null
    // handle is closed exactly once below.
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // The parent may have exited before the child opened it.
            return Ok(());
        }
        let result = WaitForSingleObject(handle, timeout_ms);
        CloseHandle(handle);
        match result {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!("timed out waiting for process {pid} to exit")),
            WAIT_FAILED => Err(format!("failed waiting for process {pid} to exit")),
            other => Err(format!(
                "unexpected wait result {other} for process {pid}"
            )),
        }
    }
}

#[cfg(not(windows))]
pub fn wait_for_process_exit(_pid: u32, _timeout: Duration) -> Result<(), String> {
    Ok(())
}
```

Add to `rust/climon-install/Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { workspace = true, features = [
  "Win32_Foundation",
  "Win32_System_Threading",
] }
```

Export the module from `lib.rs`:

```rust
pub mod wait;
```

- [ ] **Step 6: Generalize installer application**

Extract the existing Windows `run_migrate` body into:

```rust
fn run_apply(
    embedded_version: &str,
    client_stub: &[u8],
    server_stub: &[u8],
    args: &ApplyArgs,
) -> Result<(), String>
```

It reads `climon.dll` and `climon-server.exe` from `args.source`, calls `place_windows_layout_with_options`, and uses `args.version` (or the embedded version for legacy `--migrate` calls). Dispatch in `run_installer`:

```rust
if let Some(operation) = parse_installer_operation_with_default(&argv, version) {
    let result = match operation {
        InstallerOperation::Migrate(args) | InstallerOperation::Update(args) => {
            run_apply(version, client_stub, server_stub, &args)
        }
        InstallerOperation::RecoverBootstrap { apply, wait_pid } => {
            wait::wait_for_process_exit(wait_pid, Duration::from_secs(30))
                .and_then(|_| run_apply(version, client_stub, server_stub, &apply))
                .map(|_| {
                    println!(
                        "A critical climon update was applied successfully.\n\
                         Please rerun your climon command."
                    );
                })
        }
    };
    return match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("install: {error}");
            1
        }
    };
}
```

- [ ] **Step 7: Run installer tests**

Run:

```bash
cd rust
cargo test -p climon-install installer
cargo test -p climon-install wait
```

Expected: all parser, apply, idempotency, and wait tests pass.

- [ ] **Step 8: Commit**

```bash
git add rust/climon-install/Cargo.toml rust/climon-install/src/lib.rs rust/climon-install/src/installer.rs rust/climon-install/src/wait.rs rust/Cargo.lock
git commit -m "feat(install): add stable update and recovery operations"
```

---

### Task 3: Recovery Bootstrap Orchestration

**Files:**
- Create: `rust/climon-setup/src/bootstrap.rs`
- Modify: `rust/climon-setup/src/main.rs`
- Modify: `rust/climon-setup/Cargo.toml`
- Test: `rust/climon-setup/src/bootstrap.rs`

- [ ] **Step 1: Write failing mode-selection tests**

Create the module with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_exe_selects_installer_mode() {
        assert_eq!(
            mode_for_executable(Path::new(r"C:\stage\install.exe")).unwrap(),
            SetupMode::Installer
        );
    }

    #[test]
    fn climon_exe_selects_recovery_mode() {
        assert_eq!(
            mode_for_executable(Path::new(r"C:\climon\climon.exe")).unwrap(),
            SetupMode::RecoveryBootstrap
        );
    }

    #[test]
    fn unknown_name_is_rejected() {
        assert!(mode_for_executable(Path::new(r"C:\stage\renamed.exe")).is_err());
    }
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
cd rust
cargo test -p climon-setup bootstrap
```

Expected: compilation fails because the bootstrap module and mode types do not exist.

- [ ] **Step 3: Implement explicit executable modes**

Add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    Installer,
    RecoveryBootstrap,
}

pub fn mode_for_executable(path: &Path) -> Result<SetupMode, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "setup executable has no valid filename".to_string())?;
    if name.eq_ignore_ascii_case("install.exe") || name == "install" {
        return Ok(SetupMode::Installer);
    }
    if name.eq_ignore_ascii_case("climon.exe") {
        return Ok(SetupMode::RecoveryBootstrap);
    }
    Err(format!("unsupported setup executable name: {name}"))
}
```

- [ ] **Step 4: Write failing orchestration tests with injected runtime**

Define a runtime whose closures avoid network/process side effects:

```rust
pub struct BootstrapRuntime<'a> {
    pub fetch_manifest: &'a mut dyn FnMut() -> Result<Manifest, String>,
    pub stage_artifact:
        &'a mut dyn FnMut(&Manifest, &Path) -> Result<PreparedArtifact, String>,
    pub spawn_recovery:
        &'a mut dyn FnMut(&Path, &Path, &str, u32, &[String]) -> Result<(), String>,
    pub run_legacy:
        &'a mut dyn FnMut(&Path, &[String]) -> Result<i32, String>,
    pub print: &'a mut dyn FnMut(&str),
}

pub struct PreparedArtifact {
    pub staging: PathBuf,
    pub version: String,
}
```

Add these tests:

```rust
fn test_manifest() -> Manifest {
    Manifest {
        version: "9.9.0".to_string(),
        encryption: None,
        artifacts: std::collections::BTreeMap::new(),
    }
}

#[test]
fn successful_bootstrap_spawns_child_and_does_not_run_original_command() {
    let install = tempfile::tempdir().unwrap();
    let executable = install.path().join("climon.exe");
    std::fs::write(&executable, b"bootstrap").unwrap();
    std::fs::write(install.path().join("climon.exe.old"), b"legacy").unwrap();
    let stage = tempfile::tempdir_in(install.path()).unwrap();
    for name in ["install.exe", "climon.dll", "climon-server.exe"] {
        std::fs::write(stage.path().join(name), name).unwrap();
    }
    let spawned = std::cell::Cell::new(false);
    let legacy_called = std::cell::Cell::new(false);
    let mut fetch = || Ok(test_manifest());
    let stage_path = stage.keep();
    let mut stage_artifact = |_: &Manifest, _: &Path| {
        Ok(PreparedArtifact {
            staging: stage_path.clone(),
            version: "9.9.0".to_string(),
        })
    };
    let mut spawn = |_: &Path, _: &Path, version: &str, _: u32, args: &[String]| {
        assert_eq!(version, "9.9.0");
        assert_eq!(args, &["--version".to_string()]);
        spawned.set(true);
        Ok(())
    };
    let mut legacy = |_: &Path, _: &[String]| {
        legacy_called.set(true);
        Ok(7)
    };
    let mut output = String::new();
    let mut print = |message: &str| output.push_str(message);
    let outcome = run_bootstrap(
        &executable,
        &["--version".to_string()],
        &mut BootstrapRuntime {
            fetch_manifest: &mut fetch,
            stage_artifact: &mut stage_artifact,
            spawn_recovery: &mut spawn,
            run_legacy: &mut legacy,
            print: &mut print,
        },
    )
    .unwrap();
    assert_eq!(outcome, BootstrapOutcome::ChildSpawned);
    assert!(spawned.get());
    assert!(!legacy_called.get());
}

#[test]
fn download_failure_runs_old_client_with_original_args() {
    let install = tempfile::tempdir().unwrap();
    let executable = install.path().join("climon.exe");
    let old = install.path().join("climon.exe.old");
    std::fs::write(&executable, b"bootstrap").unwrap();
    std::fs::write(&old, b"legacy").unwrap();
    let observed = std::cell::RefCell::new(Vec::new());
    let mut fetch = || Err("offline".to_string());
    let mut stage = |_: &Manifest, _: &Path| unreachable!();
    let mut spawn = |_: &Path, _: &Path, _: &str, _: u32, _: &[String]| unreachable!();
    let mut legacy = |path: &Path, args: &[String]| {
        assert_eq!(path, old);
        observed.borrow_mut().extend_from_slice(args);
        Ok(23)
    };
    let mut print = |_: &str| {};
    let outcome = run_bootstrap(
        &executable,
        &["--version".to_string()],
        &mut BootstrapRuntime {
            fetch_manifest: &mut fetch,
            stage_artifact: &mut stage,
            spawn_recovery: &mut spawn,
            run_legacy: &mut legacy,
            print: &mut print,
        },
    )
    .unwrap();
    assert_eq!(outcome, BootstrapOutcome::LegacyExited(23));
    assert_eq!(&*observed.borrow(), &["--version".to_string()]);
}

#[test]
fn update_failure_does_not_recursively_run_old_updater() {
    let install = tempfile::tempdir().unwrap();
    let executable = install.path().join("climon.exe");
    std::fs::write(&executable, b"bootstrap").unwrap();
    std::fs::write(install.path().join("climon.exe.old"), b"legacy").unwrap();
    let mut fetch = || Err("offline".to_string());
    let mut stage = |_: &Manifest, _: &Path| unreachable!();
    let mut spawn = |_: &Path, _: &Path, _: &str, _: u32, _: &[String]| unreachable!();
    let mut legacy = |_: &Path, _: &[String]| panic!("must not recurse into old update");
    let mut print = |_: &str| {};
    let error = run_bootstrap(
        &executable,
        &["update".to_string()],
        &mut BootstrapRuntime {
            fetch_manifest: &mut fetch,
            stage_artifact: &mut stage,
            spawn_recovery: &mut spawn,
            run_legacy: &mut legacy,
            print: &mut print,
        },
    )
    .unwrap_err();
    assert!(error.contains("offline"));
}

#[test]
fn missing_old_client_returns_recovery_guidance() {
    let install = tempfile::tempdir().unwrap();
    let executable = install.path().join("climon.exe");
    std::fs::write(&executable, b"bootstrap").unwrap();
    let mut fetch = || Err("offline".to_string());
    let mut stage = |_: &Manifest, _: &Path| unreachable!();
    let mut spawn = |_: &Path, _: &Path, _: &str, _: u32, _: &[String]| unreachable!();
    let mut legacy = |_: &Path, _: &[String]| panic!("old client is absent");
    let mut print = |_: &str| {};
    let error = run_bootstrap(
        &executable,
        &["--version".to_string()],
        &mut BootstrapRuntime {
            fetch_manifest: &mut fetch,
            stage_artifact: &mut stage,
            spawn_recovery: &mut spawn,
            run_legacy: &mut legacy,
            print: &mut print,
        },
    )
    .unwrap_err();
    assert!(error.contains("install.ps1"));
}
```

Assert that successful bootstrap returns a dedicated `BootstrapOutcome::ChildSpawned` and never invokes `run_legacy`.

- [ ] **Step 5: Implement bootstrap orchestration**

Use these types:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapOutcome {
    ChildSpawned,
    LegacyExited(i32),
}

pub fn run_bootstrap(
    executable: &Path,
    argv: &[String],
    runtime: &mut BootstrapRuntime<'_>,
) -> Result<BootstrapOutcome, String>
```

Implementation rules:

1. Resolve `install_dir` from `executable.parent()`.
2. Resolve `old_client = install_dir.join("climon.exe.old")`.
3. Fetch the manifest from `climon_update::update_cli::resolve_manifest_url()`.
4. Stage the verified artifact inside `install_dir`.
5. Require staged `install.exe`, `climon.dll`, and `climon-server.exe`.
6. Persist the staging directory with `TempDir::keep()` before spawning the child.
7. Spawn:

```text
install.exe --recover-bootstrap
  --dir <install_dir>
  --source <staging>
  --version <manifest.version>
  --wait-pid <current pid>
  --old-client <install_dir>\climon.exe.old
  --requested-update <true|false>
  --fallback-arg <arg> (repeated for each original argument)
```

8. Return `ChildSpawned`; `main` exits zero immediately.
9. On any pre-spawn error, print the warning. If the requested command is `update`, return the error without invoking the legacy updater. Otherwise execute `climon.exe.old` with the original arguments and return its exit code.

- [ ] **Step 6: Wire the real runtime**

Update `rust/climon-setup/Cargo.toml`:

```toml
[features]
test-update-endpoint = ["climon-update/test-update-endpoint"]

[dependencies]
climon-install = { path = "../climon-install", version = "0.1.0" }
climon-update = { path = "../climon-update", version = "0.1.0" }
```

Make `resolve_manifest_url` public in `climon-update/src/update_cli.rs`:

```rust
pub fn resolve_manifest_url() -> &'static str
```

Update `main.rs`:

```rust
mod bootstrap;

fn main() {
    let executable = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("setup: resolve executable failed: {error}");
        std::process::exit(1);
    });
    let mode = bootstrap::mode_for_executable(&executable).unwrap_or_else(|error| {
        eprintln!("setup: {error}");
        std::process::exit(1);
    });
    let code = match mode {
        bootstrap::SetupMode::Installer => {
            climon_install::run_installer(VERSION, CLIENT_STUB, SERVER_STUB)
        }
        bootstrap::SetupMode::RecoveryBootstrap => {
            bootstrap::run_real_bootstrap(&executable, &std::env::args().skip(1).collect::<Vec<_>>())
        }
    };
    std::process::exit(code);
}
```

The real child spawn must use `std::process::Command` directly with `.arg(...)`; do not invoke PowerShell or `cmd.exe`.

- [ ] **Step 7: Run bootstrap tests**

Run:

```bash
cd rust
cargo test -p climon-setup
cargo test -p climon-update update_cli
```

Expected: all mode, success, fallback, recursion-prevention, and endpoint tests pass.

- [ ] **Step 8: Commit**

```bash
git add rust/climon-setup/Cargo.toml rust/climon-setup/src/bootstrap.rs rust/climon-setup/src/main.rs rust/climon-update/src/update_cli.rs rust/Cargo.lock
git commit -m "feat(setup): recover when old updater renames installer"
```

---

### Task 4: Child-Side Recovery Failure Fallback

**Files:**
- Modify: `rust/climon-install/src/installer.rs`
- Modify: `rust/climon-setup/src/bootstrap.rs`
- Test: `rust/climon-install/src/installer.rs`
- Test: `rust/climon-setup/src/bootstrap.rs`

- [ ] **Step 1: Extend recovery arguments with fallback metadata**

Add to the recovery operation:

```rust
RecoverBootstrap {
    apply: ApplyArgs,
    wait_pid: u32,
    old_client: PathBuf,
    requested_update: bool,
    fallback_args: Vec<String>,
}
```

The bootstrap child arguments become:

```text
--old-client <install_dir>\climon.exe.old
--requested-update <true|false>
--fallback-arg <arg> (repeated)
```

- [ ] **Step 2: Write failing child-fallback tests**

Inject a recovery runtime into the installer:

```rust
pub struct RecoveryRuntime<'a> {
    pub wait_for_pid: &'a mut dyn FnMut(u32) -> Result<(), String>,
    pub apply: &'a mut dyn FnMut(&ApplyArgs) -> Result<(), String>,
    pub run_old: &'a mut dyn FnMut(&Path, &[String]) -> Result<i32, String>,
    pub print: &'a mut dyn FnMut(&str),
}
```

Test:

- apply failure with `requested_update == false` runs the old client;
- apply failure with `requested_update == true` does not run the old updater;
- apply success prints the critical-update rerun message and never runs the old client;
- wait failure follows the same fallback rules.

- [ ] **Step 3: Implement child fallback**

Add:

```rust
pub fn run_recovery_operation(
    operation: &InstallerOperation,
    runtime: &mut RecoveryRuntime<'_>,
) -> Result<i32, String>
```

On success, print exactly:

```text
A critical climon update was applied successfully.
Please rerun your climon command.
```

On non-update failure, run `climon.exe.old` without shell interpolation. Do not delete the old client until a later successful cleanup.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd rust
cargo test -p climon-install recovery
cargo test -p climon-setup bootstrap
```

Expected: all parent-side and child-side fallback tests pass.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-install/src/installer.rs rust/climon-setup/src/bootstrap.rs
git commit -m "fix(setup): preserve legacy fallback across recovery child"
```

---

### Task 5: Delegate Windows Updates to the Installer

**Files:**
- Modify: `rust/climon-update/src/update_cmd.rs`
- Modify: `rust/climon-update/src/install_manifest.rs`
- Test: `rust/climon-update/src/update_cmd.rs`

- [ ] **Step 1: Write failing delegation tests**

Refactor command execution behind:

```rust
pub struct InstallerRunner<'a> {
    pub run: &'a mut dyn FnMut(&Path, &[String]) -> Result<i32, String>,
}
```

Add tests proving:

```rust
#[test]
fn windows_update_invokes_staged_installer_with_stable_contract() {
    // Signed fixture contains install.exe, climon.dll, climon-server.exe.
    // Record executable and argv.
    // Assert --update, --dir, --source, and --version are present.
}

#[test]
fn installer_failure_propagates_and_does_not_report_updated() {
    // Runner returns exit code 7.
    // Assert run_update_command returns Err containing exit code 7.
}

#[test]
fn windows_updater_does_not_write_payloads_or_pointers_directly() {
    // After injected installer success, assert only installer-owned fixture writes exist.
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd rust
cargo test -p climon-update windows_update
cargo test -p climon-update installer_failure
```

Expected: tests fail because Windows still writes versioned files and pointers directly.

- [ ] **Step 3: Replace Windows placement with installer delegation**

After `download_and_stage_artifact`, require these files:

```rust
for required in ["install.exe", "climon.dll", "climon-server.exe"] {
    if !staged.path().join(required).is_file() {
        return Err(format!("verified Windows artifact missing {required}"));
    }
}
```

Invoke:

```rust
let argv = vec![
    "--update".to_string(),
    "--dir".to_string(),
    opts.install_dir.display().to_string(),
    "--source".to_string(),
    staged.path().display().to_string(),
    "--version".to_string(),
    staged.version.clone(),
];
let exit = runner.run(&staged.path().join("install.exe"), &argv)?;
if exit != 0 {
    return Err(format!("update installer exited with code {exit}"));
}
```

Remove Windows use of `client_dll_name`, `server_exe_name`, `write_pointer`, and `write_versioned_file` from `update_cmd.rs`. Keep Unix rename-over behavior and its install manifest unchanged.

Remove the obsolete Windows mapping assertions from `install_manifest.rs`; rename its documentation to make clear it is the Unix legacy swap list.

- [ ] **Step 4: Run all updater tests**

Run:

```bash
cd rust
cargo test -p climon-update
cargo test -p climon-update --features test-update-endpoint
```

Expected: all tests pass in production and test-endpoint feature states.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-update/src/update_cmd.rs rust/climon-update/src/install_manifest.rs
git commit -m "refactor(update): delegate Windows placement to installer"
```

---

### Task 6: Update Packaging Feature Plumbing and Windows Harness

**Files:**
- Modify: `rust/climon-dll/Cargo.toml`
- Modify: `scripts/compile.ts`
- Modify: `scripts/upgrade-harness/pack.ts`
- Modify: `scripts/upgrade-test-harness.ts`
- Modify: `tests/upgrade-harness.test.ts`

- [ ] **Step 1: Forward the test endpoint to the setup binary**

Ensure the existing test feature chain includes:

```toml
# rust/climon-dll/Cargo.toml
test-update-endpoint = [
  "climon-cli/test-update-endpoint",
  "climon-setup/test-update-endpoint",
]
```

If `climon-dll` cannot depend on `climon-setup` without an unnecessary runtime dependency, keep the setup feature independent and have `scripts/compile.ts` pass `--features test-update-endpoint` to the `climon-setup` Cargo build whenever `CLIMON_TEST_UPDATE_ENDPOINT=1`.

- [ ] **Step 2: Write failing pure layout tests**

Add a bootstrap-layout assertion:

```ts
test("assertBootstrapLayout accepts the old-updater rename state", () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, "climon.exe"), "setup-bootstrap");
  writeFileSync(join(dir, "climon.exe.old"), "legacy-client");
  writeFileSync(join(dir, "climon-server.exe"), "server");
  expect(() => assertBootstrapLayout(dir)).not.toThrow();
});
```

`assertBootstrapLayout` must reject pointer files and reject a missing `.old` fallback.

- [ ] **Step 3: Run the helper test and verify it fails**

Run:

```bash
bun test tests/upgrade-harness.test.ts
```

Expected: failure because `assertBootstrapLayout` does not exist.

- [ ] **Step 4: Implement the helper**

Add to `scripts/upgrade-harness/pack.ts`:

```ts
export function assertBootstrapLayout(dir: string): void {
  for (const required of ["climon.exe", "climon.exe.old", "climon-server.exe"]) {
    if (!existsSync(join(dir, required))) {
      throw new Error(`bootstrap layout missing ${required}`);
    }
  }
  for (const forbidden of ["climon.version", "climon-server.version"]) {
    if (existsSync(join(dir, forbidden))) {
      throw new Error(`bootstrap layout unexpectedly contains ${forbidden}`);
    }
  }
}
```

- [ ] **Step 5: Replace harness scenarios**

Update `scripts/upgrade-test-harness.ts` to run:

1. **Direct legacy → bootstrap → stub**
   - Build a standalone legacy client fixture with the test key and endpoint feature.
   - Materialize a legacy install.
   - Simulate the already-released updater result exactly:

```ts
renameSync(join(install, "climon.exe"), join(install, "climon.exe.old"));
copyFileSync(join(stagedC, "install.exe"), join(install, "climon.exe"));
copyFileSync(join(stagedC, "climon-server.exe"), join(install, "climon-server.exe"));
```

   - Run `climon --version` with `CLIMON_TEST_MANIFEST_URL`.
   - Assert output contains the critical-update rerun message and does not contain the requested version output.
   - Rerun `climon --version`; assert version C and stub layout.

2. **Offline fallback**
   - Materialize the same bootstrap state.
   - Use an unreachable loopback manifest URL.
   - Run `climon --version`.
   - Assert the output comes from `climon.exe.old` and the bootstrap state remains retryable.

3. **C → C+1 installer-owned update**
   - Run the stub's `climon update`.
   - Assert C+1 pointers and payloads.
   - Run fresh `climon cleanup`; assert old payload reaping.

4. **Fresh install**
   - Extract C.
   - Run `install.exe` against isolated `LOCALAPPDATA` and `CLIMON_HOME`.
   - Assert the same stub layout.

Remove bridge-adoption and simulated-brick scenarios that no longer represent the product design.

- [ ] **Step 6: Run host-safe harness tests**

Run:

```bash
bun test tests/upgrade-harness.test.ts
bun run typecheck
```

Expected: all pure helper tests and TypeScript checks pass.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-dll/Cargo.toml rust/climon-setup/Cargo.toml scripts/compile.ts scripts/upgrade-harness/pack.ts scripts/upgrade-test-harness.ts tests/upgrade-harness.test.ts rust/Cargo.lock
git commit -m "test(windows): cover bootstrap migration and fallback"
```

---

### Task 7: Documentation and Manual Checks

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/manual-tests/windows-binary-lifecycle.md`
- Modify: `docs/features.md`
- Modify: `CHANGELOG.json`

- [ ] **Step 1: Replace bridge architecture**

In `docs/architecture.md`, replace the bridge-release section with:

```markdown
### Migrating legacy Windows installs

Already-released clients copy `install.exe` to `climon.exe`. The stub-generation
installer therefore doubles as a recovery bootstrap when executed under the
legacy destination name. It redownloads and verifies the signed release,
launches a staged installer, exits to release its own Windows file lock, and
requires the user to rerun climon after the installer places the stub layout.
No intermediate release or ordered adoption is required.

For stub-generation updates, the client verifies and stages the archive but
delegates all file placement to `install.exe --update`. The installer, rather
than the old client, owns current and future layout migrations.
```

- [ ] **Step 2: Document security boundaries**

Add to `docs/security.md`:

- bootstrap downloads use the canonical manifest and existing byte caps;
- downloaded installers execute only after Ed25519 verification;
- ZIP traversal is rejected;
- child arguments are passed without a shell;
- `.old` fallback is restricted to the install directory;
- `update` is not recursively forwarded to the old updater.

- [ ] **Step 3: Replace manual cases**

Rewrite MT-WBL-07 through MT-WBL-10:

- MT-WBL-07: legacy updater places bootstrap;
- MT-WBL-08: first bootstrap run migrates and requires rerun;
- MT-WBL-09: offline bootstrap runs `.old`;
- MT-WBL-10: stub C → C+1 delegates to installer.

Each case must retain the repository's ID, preconditions, numbered steps, expected results, platforms, and result-tracking table structure.

- [ ] **Step 4: Update catalogue and changelog**

Change the `cli-26` description so it says legacy installs self-repair directly with no bridge release. Replace the 3.2.0 changelog bridge bullet with:

```json
"Migrate any legacy Windows install directly to the stub layout through a signed recovery bootstrap, even when releases were skipped"
```

- [ ] **Step 5: Verify documentation references**

Run:

```bash
git grep -n "bridge release\|skip.*bridge\|must receive.*bridge" -- README.md docs CHANGELOG.json
git diff --check
```

Expected: no remaining user-facing claim that ordered bridge adoption is required; any historical mention must explicitly say the bridge design was replaced.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/security.md docs/manual-tests/windows-binary-lifecycle.md docs/features.md CHANGELOG.json
git commit -m "docs: describe skip-safe Windows bootstrap migration"
```

---

### Task 8: Complete Verification

**Files:**
- No source changes expected

- [ ] **Step 1: Run Rust formatting and lint**

Run:

```bash
cd rust
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: both commands exit zero.

- [ ] **Step 2: Run the full Rust suite**

Run:

```bash
cd rust
cargo test --workspace
cargo test -p climon-update --features test-update-endpoint
cargo test -p climon-setup --features test-update-endpoint
```

Expected: all tests pass.

- [ ] **Step 3: Run Bun checks**

Run:

```bash
bun run typecheck
bun test tests
```

Expected: typecheck passes and the full Bun suite has zero failures.

- [ ] **Step 4: Verify production hook inertness**

Run:

```bash
git grep -n \
  "CLIMON_TEST_UPDATE_ENDPOINT\|CLIMON_TEST_MANIFEST_URL\|test-update-endpoint" \
  -- .github/workflows/release.yml
```

Expected: no matches.

- [ ] **Step 5: Run the Windows end-to-end harness**

On a real Windows machine:

```powershell
bun scripts/upgrade-test-harness.ts
```

Expected scenario summaries:

```text
Direct legacy-to-stub bootstrap migration passed.
Offline legacy fallback passed.
Installer-owned C-to-C+1 update passed.
Fresh stub installation passed.
All upgrade-test scenarios passed.
```

- [ ] **Step 6: Inspect the release archive**

On Windows:

```powershell
tar -tf dist/climon-windows-x64.zip
```

Expected exactly:

```text
install.exe
climon.dll
climon-server.exe
```

- [ ] **Step 7: Request final code review**

Review the complete diff against `origin/dev`, focusing on:

- old-updater compatibility;
- bootstrap lock release and child lifetime;
- signature and ZIP safety;
- offline `.old` fallback;
- installer-owned update delegation;
- Windows process waiting;
- production test-hook isolation.

- [ ] **Step 8: Push and open a PR to `dev`**

```bash
git push -u origin fix/windows-bootstrap-migration
gh pr create --base dev --head fix/windows-bootstrap-migration \
  --title "Make Windows stub migration safe when releases are skipped" \
  --body "$(cat <<'EOF'
## Summary

- recover automatically when an old updater copies the new installer to `climon.exe`
- delegate Windows file placement to the signed release installer
- preserve offline use through `climon.exe.old` and require a rerun after migration
- replace bridge-release ordering with direct skip-safe migration tests and documentation

## Test plan

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `cargo test -p climon-update --features test-update-endpoint`
- [ ] `cargo test -p climon-setup --features test-update-endpoint`
- [ ] `bun run typecheck`
- [ ] `bun test tests`
- [ ] Windows upgrade harness: direct bootstrap migration, offline fallback, installer-owned update, fresh install
EOF
)"
```

Do not merge the PR or cut a release until the Windows end-to-end results are recorded.
