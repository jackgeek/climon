# Installer-Owned Cross-Platform Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace updater-owned binary placement with a signed, versioned installer protocol and migrate already-installed legacy clients safely on Windows, macOS, and Linux.

**Architecture:** `climon-update` authenticates and safely stages one complete release artifact, then invokes its stable `install[.exe]` entrypoint. `climon-install` exclusively owns validation and platform layout changes. The dedicated `climon-setup` executable detects whether it was launched as `install[.exe]` or was renamed to `climon[.exe]` by a legacy updater, entering a universal recovery bootstrap in the latter case.

**Tech Stack:** Rust 2021 workspace, `ed25519-dalek`, `ureq`, `zip`, `tempfile`, `windows-sys`, Bun/TypeScript release tooling and tests.

---

## File and responsibility map

- `rust/climon-update/src/artifact.rs` — bounded download, detached Ed25519 verification, safe ZIP extraction, staged-artifact lifetime.
- `rust/climon-update/src/update_cmd.rs` — version check plus delegation to the staged installer; no layout knowledge.
- `rust/climon-update/src/bootstrap.rs` — legacy-bootstrap download/verify/stage orchestration and platform recovery launch.
- `rust/climon-update/tests/architecture.rs` — rejects updater-owned layout names and placement APIs.
- `rust/climon-install/src/update.rs` — versioned installer protocol parsing, source validation, Windows/Unix update placement, recovery operation.
- `rust/climon-install/src/files_unix.rs` — installer-owned atomic rename-over helper for Unix.
- `rust/climon-install/src/installer.rs` — dispatches normal install versus `--apply-update-v1` / `--recover-bootstrap-v1`.
- `rust/climon-setup/src/main.rs` — basename dispatch between installer and legacy bootstrap.
- `scripts/compile.ts` — preserves stable archive names and forwards test-only endpoint support to both client and installer.
- `scripts/upgrade-test-harness.ts` — host-platform direct legacy-to-current, current-to-next, tamper, fallback, and offline scenarios.
- `scripts/upgrade-harness/pack.ts` — cross-platform layout assertions and pinned legacy fixture helpers.
- `.github/workflows/rust-ci.yml` — runs the host upgrade harness on Windows, macOS, and Linux without shipping test endpoint support.
- `docs/manual-tests/installer-owned-updates.md` — release-gate checks on all three operating systems.
- `docs/manual-tests/README.md`, `docs/architecture.md`, `docs/security.md`, `docs/features.md`, `CHANGELOG.json` — user-facing and architectural truth.

### Invariants for every task

1. The first-hop legacy updater verifies the detached Ed25519 signature over the complete archive before copying `install[.exe]`.
2. The bootstrap independently verifies its redownload before extracting or executing it.
3. Production binaries cannot read `CLIMON_TEST_MANIFEST_URL`; the code exists only under `test-update-endpoint`.
4. `climon-update` never names payload files or chooses installed destinations.
5. `climon-install` is the only crate that changes the installed binary layout.
6. Windows recovery never recursively invokes the old client's `update`.
7. Unix recovery performs no install mutation until the redownload is fully verified and staged.

---

### Task 1: Extract authenticated artifact staging

**Files:**
- Create: `rust/climon-update/src/artifact.rs`
- Modify: `rust/climon-update/src/lib.rs`
- Modify: `rust/climon-update/src/update_cmd.rs`
- Test: `rust/climon-update/src/artifact.rs`

- [ ] **Step 1: Write failing tests for full-archive verification and safe extraction**

Add tests in `artifact.rs` that build in-memory ZIPs and use a throwaway Ed25519 key:

```rust
#[test]
fn stages_a_valid_signed_archive() {
    let signed = signed_zip(&[
        ("install", b"installer"),
        ("climon", b"client"),
        ("climon-server", b"server"),
    ]);
    let staged = stage_downloaded_artifact(
        &signed.zip,
        &signed.signature_b64,
        &signed.public_key_b64,
    )
    .unwrap();
    assert_eq!(std::fs::read(staged.root().join("install")).unwrap(), b"installer");
}

#[test]
fn rejects_a_tampered_archive_before_extraction() {
    let signed = signed_zip(&[("install", b"installer")]);
    let mut tampered = signed.zip;
    tampered.push(0);
    let err = stage_downloaded_artifact(
        &tampered,
        &signed.signature_b64,
        &signed.public_key_b64,
    )
    .unwrap_err();
    assert_eq!(err.kind(), ArtifactErrorKind::VerifyFailed);
}

#[test]
fn rejects_parent_absolute_and_symlink_entries() {
    for entry in ["../escape", "/absolute", "C:/windows/path"] {
        let err = extract_verified_zip(&zip_with_entry(entry, b"x"), tempdir().unwrap().path())
            .unwrap_err();
        assert!(err.contains("unsafe zip entry"));
    }
    let err = extract_verified_zip(&zip_with_unix_symlink("link", "target"), tempdir().unwrap().path())
        .unwrap_err();
    assert!(err.contains("unsupported zip entry"));
}
```

The helper must sign the complete ZIP byte vector, not individual entries.

- [ ] **Step 2: Run the focused tests and verify the new API is missing**

Run:

```bash
cd rust
cargo test -p climon-update artifact -- --nocapture
```

Expected: FAIL because `stage_downloaded_artifact`, `extract_verified_zip`, and the staged-artifact types do not exist.

- [ ] **Step 3: Implement the staged-artifact API**

Create the following public surface in `artifact.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactErrorKind {
    Download,
    VerifyFailed,
    InvalidArchive,
    Io,
}

#[derive(Debug)]
pub struct ArtifactError {
    kind: ArtifactErrorKind,
    message: String,
}

impl ArtifactError {
    pub fn kind(&self) -> ArtifactErrorKind { self.kind }
}

pub struct StagedArtifact {
    temp: Option<tempfile::TempDir>,
    root: PathBuf,
}

impl StagedArtifact {
    pub fn root(&self) -> &Path { &self.root }

    pub fn keep(mut self) -> Result<PathBuf, ArtifactError> {
        let temp = self.temp.take().expect("staged artifact already kept");
        temp.keep().map_err(|e| ArtifactError::io("persist staging", e))
    }

    pub fn entry(&self, name: &str) -> Result<PathBuf, ArtifactError> {
        let path = self.root.join(name);
        if !path.is_file() {
            return Err(ArtifactError::invalid(format!(
                "verified artifact is missing required entry: {name}"
            )));
        }
        Ok(path)
    }
}

pub fn stage_release_artifact(
    manifest: &Manifest,
    platform: &str,
    arch: &str,
    public_key_b64: &str,
) -> Result<StagedArtifact, ArtifactError>;

pub fn stage_downloaded_artifact(
    zip_bytes: &[u8],
    signature_b64: &str,
    public_key_b64: &str,
) -> Result<StagedArtifact, ArtifactError>;
```

Implementation order inside `stage_release_artifact`:

```rust
let artifact = manifest.artifacts.get(&artifact_key(platform, arch))
    .ok_or_else(|| ArtifactError::invalid("no artifact for this platform"))?;
let zip = download_bytes(&artifact.url, MAX_ARTIFACT_BYTES)?;
let signature = download_text(&artifact.sig, MAX_TEXT_BYTES)?;
stage_downloaded_artifact(&zip, &signature, public_key_b64)
```

`extract_verified_zip` must:

- call `ZipFile::enclosed_name()` and reject `None`;
- reject entries whose raw name begins with `/`, `\`, or a Windows drive prefix;
- reject symlink and other special Unix modes;
- permit regular files and directories only;
- create parents beneath the staging root;
- preserve executable mode bits on Unix, defaulting files to `0o755` only when the archive marks an executable;
- never follow filesystem symlinks.

Move the existing `unzip` behavior out of `update_cmd.rs`. Add `pub mod artifact;` to `lib.rs`.

- [ ] **Step 4: Run artifact tests**

Run:

```bash
cd rust
cargo test -p climon-update artifact -- --nocapture
```

Expected: PASS, including valid signature, tamper rejection, traversal rejection, symlink rejection, required-entry lookup, and staging cleanup on drop.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-update/src/artifact.rs rust/climon-update/src/lib.rs rust/climon-update/src/update_cmd.rs
git commit -m "refactor(update): add verified artifact staging"
```

---

### Task 2: Add the versioned installer update protocol

**Files:**
- Create: `rust/climon-install/src/update.rs`
- Modify: `rust/climon-install/src/lib.rs`
- Modify: `rust/climon-install/src/installer.rs`
- Modify: `rust/climon-install/src/files.rs`
- Modify: `rust/climon-install/src/files_unix.rs`
- Modify: `rust/climon-install/Cargo.toml`
- Test: `rust/climon-install/src/update.rs`
- Test: `rust/climon-install/src/files_unix.rs`

- [ ] **Step 1: Write failing parser and validation tests**

Define tests for strict, versioned operations:

```rust
#[test]
fn parses_apply_update_v1_exactly() {
    let argv = strings(&[
        "--apply-update-v1", "--dir", "/installed", "--source", "/staged",
        "--version", "9.9.0",
    ]);
    assert_eq!(
        parse_update_operation(&argv).unwrap(),
        Some(UpdateOperation::Apply(ApplyUpdateArgs {
            dir: "/installed".into(),
            source: "/staged".into(),
            version: "9.9.0".into(),
        }))
    );
}

#[test]
fn rejects_missing_duplicate_and_unknown_update_arguments() {
    assert!(parse_update_operation(&strings(&["--apply-update-v1"])).is_err());
    assert!(parse_update_operation(&strings(&[
        "--apply-update-v1", "--dir", "a", "--dir", "b",
        "--source", "s", "--version", "1",
    ])).is_err());
    assert!(parse_update_operation(&strings(&[
        "--apply-update-v1", "--dir", "a", "--source", "s",
        "--version", "1", "--surprise",
    ])).is_err());
}

#[test]
fn validates_every_required_payload_before_mutation() {
    let fixture = UpdateFixture::unix();
    std::fs::remove_file(fixture.source.join("climon-server")).unwrap();
    let err = apply_update_with(&fixture.args(), &mut fixture.runtime()).unwrap_err();
    assert!(err.contains("missing required installer sibling"));
    assert!(fixture.mutations().is_empty());
}
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
cd rust
cargo test -p climon-install update -- --nocapture
```

Expected: FAIL because `UpdateOperation`, `parse_update_operation`, and `apply_update_with` do not exist.

- [ ] **Step 3: Implement strict protocol types and dispatch**

Create:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyUpdateArgs {
    pub dir: PathBuf,
    pub source: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverBootstrapArgs {
    pub apply: ApplyUpdateArgs,
    pub bootstrap_pid: Option<u32>,
    pub fallback: Option<PathBuf>,
    pub original_args: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOperation {
    Apply(ApplyUpdateArgs),
    Recover(RecoverBootstrapArgs),
}

pub fn parse_update_operation(
    argv: &[OsString],
) -> Result<Option<UpdateOperation>, String>;
```

Use repeated `--original-arg <value>` pairs so arguments are passed directly
without shell quoting. Reject:

- both operation flags together;
- missing values;
- duplicate scalar flags;
- empty version;
- unknown flags within an update operation.

In `installer.rs`, parse update operations before onboarding:

```rust
let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
match parse_update_operation(&argv) {
    Ok(Some(operation)) => return run_update_operation(
        operation,
        version,
        client_stub,
        server_stub,
    ),
    Ok(None) => {}
    Err(error) => {
        eprintln!("installer update arguments: {error}");
        return 2;
    }
}
```

Keep normal install parsing on UTF-8 `Vec<String>` only after update-operation
dispatch, so non-UTF-8 original Unix arguments can round-trip through recovery.

- [ ] **Step 4: Move all platform placement into the installer**

Implement `run_apply_update` in `update.rs`:

```rust
pub fn run_apply_update(
    args: &ApplyUpdateArgs,
    version: &str,
    client_stub: &[u8],
    server_stub: &[u8],
) -> Result<(), String> {
    if args.version != version {
        return Err(format!(
            "staged installer version {} does not match requested version {}",
            version, args.version
        ));
    }
    validate_update_source(args)?;
    platform_apply_update(args, client_stub, server_stub)?;
    remove_retired_files(&args.dir);
    Ok(())
}
```

Windows `platform_apply_update` reads `climon.dll` and
`climon-server.exe`, calls `place_windows_layout_with_options`, writes pointer
files last, and invokes the existing superseded-payload reaper after placement.
Move any write helpers required for this from `climon-update` into
`climon-install`.

Unix adds an installer-owned atomic helper:

```rust
pub fn replace_file_atomic(
    source: &Path,
    destination: &Path,
) -> Result<(), InstallError>;
```

It copies the source to a unique sibling temp file, applies the source executable
mode (or `0o755`), fsyncs it, and renames it over the destination. Running
processes keep their old inode. Apply `climon-server` first and `climon` last so
the client entrypoint is the commit point. Write `.version` only after both
renames succeed and strip macOS quarantine from both destinations.

Validate every required source file before the first write. Remove `climon-beta`
and stale `.old` siblings only after a successful apply.

- [ ] **Step 5: Add crash-order and Unix running-inode tests**

Add tests:

```rust
#[cfg(unix)]
#[test]
fn unix_apply_replaces_an_open_client_and_keeps_it_executable() {
    let fixture = RealUnixFixture::new();
    let old_handle = std::fs::File::open(fixture.install.join("climon")).unwrap();
    run_apply_update(&fixture.args(), "9.9.0", &[], &[]).unwrap();
    assert_eq!(read_all(old_handle), b"old-client");
    assert_eq!(std::fs::read(fixture.install.join("climon")).unwrap(), b"new-client");
    assert_ne!(mode(fixture.install.join("climon")) & 0o111, 0);
}

#[test]
fn failure_before_client_commit_leaves_the_old_entrypoint() {
    let fixture = UpdateFixture::with_injected_failure("climon-server");
    assert!(apply_update_with(&fixture.args(), &mut fixture.runtime()).is_err());
    assert_eq!(fixture.read_installed_client(), b"old-client");
}
```

- [ ] **Step 6: Run installer tests**

Run:

```bash
cd rust
cargo test -p climon-install -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-install
git commit -m "feat(install): own versioned update placement"
```

---

### Task 3: Make normal updates delegate and enforce the boundary

**Files:**
- Modify: `rust/climon-update/src/update_cmd.rs`
- Modify: `rust/climon-update/src/update_cli.rs`
- Modify: `rust/climon-update/src/lib.rs`
- Modify: `rust/climon-update/src/pointer.rs`
- Delete: `rust/climon-update/src/install_manifest.rs`
- Delete: `rust/climon-update/src/swap.rs`
- Create: `rust/climon-update/tests/architecture.rs`
- Test: `rust/climon-update/src/update_cmd.rs`

- [ ] **Step 1: Replace placement tests with delegation tests**

Introduce an injectable command runner:

```rust
pub trait InstallerRunner {
    fn run(&mut self, program: &Path, args: &[OsString]) -> Result<ExitStatus, String>;
}
```

Add tests:

```rust
#[test]
fn update_invokes_the_verified_installer_protocol() {
    let fixture = signed_release_fixture("9.9.0");
    let mut runner = RecordingRunner::success();
    let result = run_update_command_with_runner(
        &fixture.options(),
        &mut runner,
        &mut |_| {},
    ).unwrap();

    assert_eq!(result.status, UpdateStatus::Updated);
    assert_eq!(runner.calls.len(), 1);
    assert_eq!(runner.calls[0].program.file_name().unwrap(), installer_name());
    assert_eq!(runner.calls[0].args, os_strings(&[
        "--apply-update-v1", "--dir", fixture.install_dir(),
        "--source", runner.staged_root(), "--version", "9.9.0",
    ]));
}

#[test]
fn signature_failure_never_launches_the_installer() {
    let fixture = tampered_release_fixture();
    let mut runner = RecordingRunner::success();
    let result = run_update_command_with_runner(
        &fixture.options(),
        &mut runner,
        &mut |_| {},
    ).unwrap();
    assert_eq!(result.status, UpdateStatus::VerifyFailed);
    assert!(runner.calls.is_empty());
}

#[test]
fn installer_failure_is_an_update_failure() {
    let fixture = signed_release_fixture("9.9.0");
    let mut runner = RecordingRunner::exit_code(17);
    let err = run_update_command_with_runner(
        &fixture.options(),
        &mut runner,
        &mut |_| {},
    ).unwrap_err();
    assert!(err.contains("installer exited with code 17"));
}
```

- [ ] **Step 2: Run the tests and verify old placement behavior fails expectations**

Run:

```bash
cd rust
cargo test -p climon-update update_cmd -- --nocapture
```

Expected: FAIL because the updater still writes payloads and pointers directly.

- [ ] **Step 3: Reduce `run_update_command` to staging plus invocation**

The successful path must be structurally equivalent to:

```rust
let staged = stage_release_artifact(
    opts.manifest,
    opts.platform,
    opts.arch,
    opts.public_key_b64,
)?;
let installer = staged.entry(installer_name(opts.platform))?;
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
```

Keep `UpToDate`, `NoArtifact`, and `VerifyFailed` status semantics. Remove:

- `should_migrate_legacy`;
- `migrate_via_bundled_installer`;
- Windows versioned payload writes;
- pointer flips;
- Unix swap loops;
- updater-owned orphan cleanup.

Delete `install_manifest.rs` and `swap.rs`. Keep pointer *reading* needed by the
Windows reaper, but remove `write_pointer`, `client_dll_name`, and
`server_exe_name` from `climon-update`.

- [ ] **Step 4: Add a source-level architecture regression test**

Create:

```rust
const UPDATE_APPLICATION: &str = concat!(
    include_str!("../src/update_cmd.rs"),
    include_str!("../src/update_cli.rs"),
);

#[test]
fn updater_application_has_no_install_layout_policy() {
    for forbidden in [
        "climon.dll",
        "climon-server.exe",
        "climon.version",
        "climon-server.version",
        "write_pointer",
        "replace_file_atomic",
        "place_windows_layout",
        "install_files_for_platform",
        "std::fs::rename",
        "std::fs::write",
    ] {
        assert!(
            !UPDATE_APPLICATION.contains(forbidden),
            "updater application regained layout policy: {forbidden}"
        );
    }
}

#[test]
fn updater_invokes_only_the_stable_installer_entrypoint() {
    assert!(UPDATE_APPLICATION.contains("--apply-update-v1"));
    assert!(UPDATE_APPLICATION.contains("installer_name"));
}
```

Do not scan `artifact.rs`: staging is allowed to write into a temporary
directory. Do not scan reaper/pointer readers: cleanup of already-installed old
Windows payloads remains a separate client command, not update application.

- [ ] **Step 5: Run updater and architecture tests**

Run:

```bash
cd rust
cargo test -p climon-update -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-update
git commit -m "refactor(update): delegate installation to new artifact"
```

---

### Task 4: Dispatch installer versus legacy bootstrap by basename

**Files:**
- Create: `rust/climon-update/src/bootstrap.rs`
- Modify: `rust/climon-update/src/lib.rs`
- Modify: `rust/climon-setup/src/main.rs`
- Modify: `rust/climon-setup/Cargo.toml`
- Test: `rust/climon-update/src/bootstrap.rs`
- Test: `rust/climon-setup/src/main.rs`

- [ ] **Step 1: Write failing mode-selection tests**

Extract pure basename classification:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntrypointMode {
    Installer,
    LegacyBootstrap,
}

#[test]
fn install_names_select_installer_mode() {
    assert_eq!(classify_entrypoint(OsStr::new("install")).unwrap(), EntrypointMode::Installer);
    assert_eq!(classify_entrypoint(OsStr::new("install.exe")).unwrap(), EntrypointMode::Installer);
}

#[test]
fn climon_names_select_bootstrap_mode() {
    assert_eq!(classify_entrypoint(OsStr::new("climon")).unwrap(), EntrypointMode::LegacyBootstrap);
    assert_eq!(classify_entrypoint(OsStr::new("climon.exe")).unwrap(), EntrypointMode::LegacyBootstrap);
}

#[test]
fn unexpected_names_fail_closed() {
    assert!(classify_entrypoint(OsStr::new("renamed-installer")).is_err());
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd rust
cargo test -p climon-setup
```

Expected: FAIL because basename dispatch does not exist.

- [ ] **Step 3: Implement setup entrypoint dispatch**

Add `climon-update` to `climon-setup` dependencies. Refactor `main.rs`:

```rust
fn run(current_exe: &Path, original_args: Vec<OsString>) -> i32 {
    let basename = current_exe.file_name().unwrap_or_default();
    match classify_entrypoint(basename) {
        Ok(EntrypointMode::Installer) => {
            climon_install::run_installer(VERSION, CLIENT_STUB, SERVER_STUB)
        }
        Ok(EntrypointMode::LegacyBootstrap) => {
            climon_update::bootstrap::run_legacy_bootstrap(
                current_exe,
                &original_args,
                VERSION,
            )
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}
```

Do not accept a command-line flag that forces bootstrap mode; the executable
basename is the compatibility signal created by old updaters.

- [ ] **Step 4: Add bootstrap orchestration with injected runtime**

Create:

```rust
pub enum RecoveryPlatform {
    Windows,
    Unix,
}

pub struct BootstrapRequest<'a> {
    pub current_exe: &'a Path,
    pub original_args: &'a [OsString],
    pub platform: RecoveryPlatform,
    pub node_platform: &'a str,
    pub node_arch: &'a str,
}

pub trait BootstrapRuntime {
    fn fetch_manifest(&mut self) -> Result<Manifest, String>;
    fn stage(&mut self, manifest: &Manifest) -> Result<StagedArtifact, ArtifactError>;
    fn launch_recovery(
        &mut self,
        installer: &Path,
        args: &[OsString],
        detached: bool,
    ) -> Result<RecoveryLaunch, String>;
}
```

`run_legacy_bootstrap_with_runtime` must:

1. fetch the manifest;
2. stage through `stage_release_artifact`;
3. require the platform `install[.exe]` entry;
4. require every installer-declared platform payload before launching recovery;
5. build `--recover-bootstrap-v1` arguments;
6. use detached launch on Windows and synchronous launch on Unix;
7. persist staging only after a successful detached Windows child spawn.

Add a test proving stage/launch is never called when manifest fetch fails and a
test proving launch is never called when signature verification or required
payload validation fails.

- [ ] **Step 5: Run setup and bootstrap tests**

Run:

```bash
cd rust
cargo test -p climon-setup
cargo test -p climon-update bootstrap -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-setup rust/climon-update/src/bootstrap.rs rust/climon-update/src/lib.rs
git commit -m "feat(setup): detect legacy bootstrap invocation"
```

---

### Task 5: Implement Unix bootstrap recovery and command resume

**Files:**
- Modify: `rust/climon-update/src/bootstrap.rs`
- Modify: `rust/climon-install/src/update.rs`
- Modify: `rust/climon-install/src/installer.rs`
- Test: `rust/climon-update/src/bootstrap.rs`
- Test: `rust/climon-install/src/update.rs`

- [ ] **Step 1: Write failing Unix recovery tests**

Add:

```rust
#[cfg(unix)]
#[test]
fn unix_recovery_applies_then_runs_the_new_client_with_original_args() {
    let fixture = UnixRecoveryFixture::new(&["run", "printf", "hello world"]);
    let exit = run_recover_bootstrap_with(&fixture.args(), &mut fixture.runtime()).unwrap();
    assert_eq!(exit, 23);
    assert_eq!(fixture.events(), [
        "validate-source",
        "replace-server",
        "replace-client",
        "write-version",
        "spawn-installed-client:run|printf|hello world",
    ]);
}

#[cfg(unix)]
#[test]
fn unix_recovery_does_not_mutate_when_staging_or_validation_fails() {
    let fixture = UnixRecoveryFixture::missing_server();
    assert!(run_recover_bootstrap_with(&fixture.args(), &mut fixture.runtime()).is_err());
    assert_eq!(fixture.read_installed_client(), b"bootstrap");
    assert!(fixture.events().iter().all(|event| !event.starts_with("replace-")));
}

#[cfg(unix)]
#[test]
fn unix_recovery_reports_the_one_time_network_requirement() {
    let mut runtime = FailingBootstrapRuntime::download();
    let request = BootstrapRequest::unix(
        Path::new("/scratch/climon"),
        &os_strings(&["--version"]),
    );
    let code = run_legacy_bootstrap_with_runtime(&request, &mut runtime);
    assert_eq!(code, 1);
    assert!(runtime.stderr.contains("requires a network connection"));
    assert!(runtime.stderr.contains("install.sh"));
}
```

- [ ] **Step 2: Run Unix recovery tests and verify failure**

Run:

```bash
cd rust
cargo test -p climon-install unix_recovery -- --nocapture
cargo test -p climon-update unix_recovery -- --nocapture
```

Expected: FAIL because recovery does not apply and resume.

- [ ] **Step 3: Implement synchronous Unix recovery**

For `--recover-bootstrap-v1` on Unix:

```rust
run_apply_update(&args.apply, version, client_stub, server_stub)?;
let installed_client = args.apply.dir.join("climon");
let status = Command::new(&installed_client)
    .args(&args.original_args)
    .status()
    .map_err(|e| format!("launch newly installed climon: {e}"))?;
Ok(exit_code(status))
```

The bootstrap waits for this installer process and returns the same exit code.
Keep the staged `TempDir` alive until the installer exits, then clean it
automatically.

On fetch/download/signature/staging failure, print:

```text
climon must complete a one-time critical update and requires a network connection.
Reconnect and rerun this command, or run the current install.sh to repair climon.
```

Do not try to execute the overwritten bootstrap as a fallback.

- [ ] **Step 4: Run Unix tests**

Run:

```bash
cd rust
cargo test -p climon-install
cargo test -p climon-update
```

Expected: PASS on macOS/Linux.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-install/src/update.rs rust/climon-install/src/installer.rs rust/climon-update/src/bootstrap.rs
git commit -m "feat(update): recover legacy Unix installs"
```

---

### Task 6: Implement Windows detached recovery and `.old` fallback

**Files:**
- Modify: `rust/climon-update/src/bootstrap.rs`
- Modify: `rust/climon-install/src/update.rs`
- Modify: `rust/climon-install/Cargo.toml`
- Test: `rust/climon-update/src/bootstrap.rs`
- Test: `rust/climon-install/src/update.rs`

- [ ] **Step 1: Write failing Windows behavior tests with injected process IO**

Add platform-independent pure tests:

```rust
#[test]
fn windows_bootstrap_spawns_detached_recovery_and_returns_immediately() {
    let fixture = WindowsBootstrapFixture::new(&["--version"]);
    let code = run_legacy_bootstrap_with_runtime(&fixture.request(), &mut fixture.runtime());
    assert_eq!(code, 0);
    assert_eq!(fixture.launch.detached, true);
    assert!(fixture.launch.args.contains_pair("--bootstrap-pid", &fixture.pid.to_string()));
    assert!(fixture.launch.args.contains_pair("--fallback", fixture.old_client()));
    assert!(fixture.staging_was_kept());
}

#[test]
fn windows_recovery_waits_for_bootstrap_before_layout_mutation() {
    let fixture = WindowsRecoveryFixture::new();
    run_recover_bootstrap_with(&fixture.args(), &mut fixture.runtime()).unwrap();
    assert_eq!(fixture.events()[0], "wait-pid");
    assert_eq!(fixture.events()[1], "validate-source");
}

#[test]
fn windows_failed_recovery_falls_back_for_non_update_commands() {
    let fixture = WindowsRecoveryFixture::placement_failure(&["--version"]);
    let code = run_recover_bootstrap_with(&fixture.args(), &mut fixture.runtime()).unwrap();
    assert_eq!(code, 42);
    assert_eq!(fixture.fallback_args(), ["--version"]);
}

#[test]
fn windows_failed_update_never_recurses_to_the_old_updater() {
    let fixture = WindowsRecoveryFixture::placement_failure(&["update"]);
    assert!(run_recover_bootstrap_with(&fixture.args(), &mut fixture.runtime()).is_err());
    assert!(fixture.fallback_calls().is_empty());
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd rust
cargo test -p climon-update windows_bootstrap -- --nocapture
cargo test -p climon-install windows_recovery -- --nocapture
```

Expected: FAIL because detached recovery/wait/fallback is not implemented.

- [ ] **Step 3: Implement detached spawn and staging handoff**

On Windows the bootstrap:

1. resolves fallback strictly as `current_exe.with_file_name("climon.exe.old")`;
2. launches staged `install.exe --recover-bootstrap-v1`;
3. passes `--bootstrap-pid`, `--fallback`, and each original argument as a
   separate `--original-arg`;
4. uses `CREATE_NO_WINDOW | DETACHED_PROCESS`;
5. persists staging only after successful spawn;
6. exits without waiting.

If fetch, verification, staging, or child spawn fails before handoff:

- original command `update`: print a retryable error and return non-zero;
- any other command: launch `climon.exe.old` directly with original arguments;
- no `.old`: print `install.ps1` repair guidance and return non-zero.

Never accept a fallback path from the network or manifest.

- [ ] **Step 4: Implement child PID wait, install, fallback, and success output**

Add `windows-sys` features needed to open and wait for a specific process:

```toml
windows-sys = { workspace = true, features = [
  "Win32_Foundation",
  "Win32_System_Threading",
] }
```

The installer child:

```rust
wait_for_process(args.bootstrap_pid.ok_or("missing --bootstrap-pid")?)?;
match run_apply_update(&args.apply, version, client_stub, server_stub) {
    Ok(()) => {
        println!("A critical climon update was applied successfully.");
        println!("Please rerun your climon command.");
        Ok(0)
    }
    Err(error) if first_original_arg(&args) != Some("update") => {
        eprintln!("critical update failed: {error}");
        run_fallback(&args)
    }
    Err(error) => Err(format!(
        "critical update failed; reconnect and rerun `climon update`: {error}"
    )),
}
```

After finishing, remove the persisted staging directory best-effort. Do not
delete `climon.exe.old` during recovery; retain it until a later successful
cleanup can remove it.

- [ ] **Step 5: Run Windows-focused and crate tests**

Run:

```bash
cd rust
cargo test -p climon-install
cargo test -p climon-update
```

Expected: PASS on every host; real process-wait integration remains gated to
Windows and is exercised by the upgrade harness.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-install rust/climon-update/src/bootstrap.rs
git commit -m "feat(update): recover legacy Windows installs"
```

---

### Task 7: Preserve packaging and test-only endpoint isolation

**Files:**
- Modify: `rust/climon-setup/Cargo.toml`
- Modify: `rust/climon-update/src/update_cli.rs`
- Modify: `rust/climon-update/src/bootstrap.rs`
- Modify: `scripts/compile.ts`
- Modify: `tests/windows-installer-package.test.ts`
- Modify: `tests/upgrade-harness.test.ts`
- Test: `rust/climon-update/src/update_cli.rs`

- [ ] **Step 1: Write failing tests for bootstrap endpoint isolation and archive stability**

Add Rust tests under mutually exclusive feature gates:

```rust
#[cfg(not(feature = "test-update-endpoint"))]
#[test]
fn bootstrap_manifest_is_canonical_in_production_builds() {
    assert_eq!(resolve_bootstrap_manifest_url(), DEFAULT_MANIFEST_URL);
}

#[cfg(feature = "test-update-endpoint")]
#[test]
fn bootstrap_honors_the_test_manifest_only_when_compiled_for_tests() {
    let _guard = EnvGuard::set("CLIMON_TEST_MANIFEST_URL", "http://127.0.0.1:9/manifest.json");
    assert_eq!(
        resolve_bootstrap_manifest_url(),
        "http://127.0.0.1:9/manifest.json"
    );
}
```

Keep package expectations exactly:

```ts
expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
  "install.exe", "climon.dll", "climon-server.exe"
]);
expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
  "install", "climon", "climon-server"
]);
expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
  "install", "climon", "climon-server"
]);
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test tests/windows-installer-package.test.ts tests/upgrade-harness.test.ts
cd rust
cargo test -p climon-update
cargo test -p climon-update --features test-update-endpoint
```

Expected: endpoint test FAILS because the installer build does not yet receive
the feature; archive-name tests remain PASS.

- [ ] **Step 3: Forward the test feature to the installer only in harness builds**

Add:

```toml
[features]
test-update-endpoint = ["climon-update/test-update-endpoint"]

[dependencies]
climon-update = { path = "../climon-update", version = "0.1.0" }
```

In `compile.ts`, separate client and installer feature args:

```ts
const testUpdateEndpoint = process.env.CLIMON_TEST_UPDATE_ENDPOINT === "1";
const testEndpointArgs = testUpdateEndpoint
  ? ["--features", "test-update-endpoint"]
  : [];
```

Pass `testEndpointArgs` to both `climon-cli`/`climon-dll` and `climon-setup`
builds. Keep release/assemble builds free of
`CLIMON_TEST_UPDATE_ENDPOINT`.

Remove bridge-specific production comments. Retain `CLIMON_LEGACY_LAYOUT` only
if the cross-platform harness still needs it inside the pinned legacy checkout;
the current release path must never branch on it.

- [ ] **Step 4: Prove production compile paths omit the feature**

Add a Bun source test that reads `scripts/compile.ts` and
`.github/workflows/release.yml`:

```ts
expect(releaseWorkflow).not.toContain("CLIMON_TEST_UPDATE_ENDPOINT");
expect(releaseWorkflow).not.toContain("test-update-endpoint");
expect(compileSource).toContain('process.env.CLIMON_TEST_UPDATE_ENDPOINT === "1"');
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/windows-installer-package.test.ts tests/upgrade-harness.test.ts
cd rust
cargo test -p climon-update
cargo test -p climon-update --features test-update-endpoint
cargo test -p climon-setup --features test-update-endpoint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-setup/Cargo.toml rust/climon-update/src scripts/compile.ts tests/windows-installer-package.test.ts tests/upgrade-harness.test.ts
git commit -m "test(update): isolate bootstrap endpoint override"
```

---

### Task 8: Replace the bridge harness with cross-platform direct migration

**Files:**
- Modify: `scripts/upgrade-test-harness.ts`
- Modify: `scripts/upgrade-harness/pack.ts`
- Modify: `tests/upgrade-harness.test.ts`
- Modify: `.github/workflows/rust-ci.yml`

- [ ] **Step 1: Write failing tests for host layout helpers and pinned legacy source**

Use the exact merged legacy updater commit:

```ts
export const LEGACY_UPDATER_COMMIT =
  "5e3caf570841a43aa1257d716af2a380f0319c93";
```

Add tests:

```ts
test("legacy fixture is pinned to the last updater-owned-layout commit", () => {
  expect(LEGACY_UPDATER_COMMIT).toMatch(/^[0-9a-f]{40}$/);
});

test.each(["darwin-x64", "linux-x64"])(
  "legacy Unix layout is climon plus climon-server for %s",
  (platform) => {
    expect(legacyZipEntries(platform)).toEqual(["climon", "climon-server"]);
  }
);

test("host current layout assertion selects Windows stubs or Unix binaries", () => {
  expect(currentLayoutKind("windows-x64")).toBe("windows-stub");
  expect(currentLayoutKind("darwin-arm64")).toBe("unix");
  expect(currentLayoutKind("linux-x64")).toBe("unix");
});
```

- [ ] **Step 2: Run harness unit tests**

Run:

```bash
bun test tests/upgrade-harness.test.ts
```

Expected: FAIL because cross-platform fixture helpers do not exist.

- [ ] **Step 3: Build the old updater from the pinned commit**

The harness must create a temporary detached worktree:

```ts
await $`git worktree add --detach ${legacySource} ${LEGACY_UPDATER_COMMIT}`;
try {
  await $`bun install --frozen-lockfile`.cwd(legacySource);
  await $`bun scripts/compile.ts`
    .cwd(legacySource)
    .env({
      ...process.env,
      CLIMON_LEGACY_LAYOUT: "1",
      CLIMON_TEST_UPDATE_ENDPOINT: "1",
      CLIMON_VERSION: LEGACY_VERSION,
      CLIMON_UPDATE_PUBKEY_B64: keypair.publicKeyRawB64,
    });
} finally {
  await $`git worktree remove --force ${legacySource}`;
}
```

This fixture preserves the actual old updater-owned mapping without retaining
that code in the new updater. Confirm the pinned source's first-hop tamper test:
serve a modified ZIP with the original signature, run its `climon update`, and
assert the installed `climon[.exe]` bytes are unchanged.

- [ ] **Step 4: Implement common host scenarios**

The harness runs on its current OS and packages host artifacts C and C+1 with a
throwaway key:

1. **Legacy → C direct:** old client verifies C, copies `install[.exe]` over
   `climon[.exe]`; next invocation enters bootstrap.
2. **Bootstrap tamper:** serve a tampered C archive/signature pair; assert no
   installer execution or layout mutation.
3. **Bootstrap success:** serve valid C; invoke `climon --version`.
4. **C → C+1:** run current `climon update`; assert installer-owned layout.
5. **Offline bootstrap:** stop the server before bootstrap fetch.

Unix assertions:

```ts
expect(await run([installedClimon, "--version"])).toContain(C_VERSION);
assertUnixLayout(installDir, C_VERSION);
expect(offline.stderr).toContain("requires a network connection");
expect(offline.stderr).toContain("install.sh");
```

Windows assertions:

```ts
expect(firstLaunch.stdout + firstLaunch.stderr).toContain(
  "Please rerun your climon command."
);
assertStubLayout(installDir, C_VERSION);
expect(existsSync(join(installDir, "climon.exe.old"))).toBe(true);
```

For Windows offline/failure:

- `climon --version` falls back to `.old`;
- `climon update` fails without a fallback invocation;
- a missing `.old` prints `install.ps1`.

Leave scratch directories only when `CLIMON_KEEP_UPGRADE_SCRATCH=1`; otherwise
remove them in `finally`.

- [ ] **Step 5: Add the harness to the existing three-OS Rust CI matrix**

After `cargo test --workspace`, add:

```yaml
- name: Cross-platform legacy update migration
  run: bun scripts/upgrade-test-harness.ts
```

Use the existing Bun setup/version in the workflow. Do not set
`CLIMON_TEST_UPDATE_ENDPOINT` in workflow YAML; the harness passes it only to
its local compilation subprocesses.

- [ ] **Step 6: Run unit tests and the host harness**

Run:

```bash
bun test tests/upgrade-harness.test.ts tests/windows-installer-package.test.ts
bun scripts/upgrade-test-harness.ts
```

Expected on the current host: all legacy signature, direct migration, bootstrap
signature, offline, and current-update scenarios PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/upgrade-test-harness.ts scripts/upgrade-harness/pack.ts tests/upgrade-harness.test.ts .github/workflows/rust-ci.yml
git commit -m "test(update): cover direct legacy migration on every OS"
```

---

### Task 9: Replace bridge documentation with installer-owned updates

**Files:**
- Create: `docs/manual-tests/installer-owned-updates.md`
- Delete: `docs/manual-tests/windows-binary-lifecycle.md`
- Modify: `docs/manual-tests/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/features.md`
- Modify: `CHANGELOG.json`

- [ ] **Step 1: Replace manual checks**

Create cases using the repository's required shape:

- `MT-IOU-01` — fresh install archive and platform layout;
- `MT-IOU-02` — real pre-change Windows release directly to C, rerun required;
- `MT-IOU-03` — Windows `.old` fallback and no recursive `update`;
- `MT-IOU-04` — real pre-change macOS release directly to C, automatic resume;
- `MT-IOU-05` — real pre-change Linux release directly to C, automatic resume;
- `MT-IOU-06` — first-hop tampered archive rejected by legacy client;
- `MT-IOU-07` — bootstrap tampered redownload rejected;
- `MT-IOU-08` — Unix offline one-time network guidance;
- `MT-IOU-09` — C-to-C+1 installer delegation while sessions remain alive;
- `MT-IOU-10` — production binary ignores test manifest environment variable.

Each case must include ID, feature, preconditions, config-matrix cell, numbered
steps, exact expected result, platforms, and result-tracking row. Link the new
file from `docs/manual-tests/README.md`.

- [ ] **Step 2: Update architecture and security docs**

In `docs/architecture.md`, document:

```text
client updater: check -> download -> verify -> safe stage -> invoke installer
installer: validate -> migrate/place -> cleanup
legacy bootstrap: signed first hop -> signed redownload -> recovery installer
```

Remove statements that the updater swaps Unix binaries or flips Windows
pointers.

In `docs/security.md`, explicitly state:

- Ed25519 covers the complete release ZIP including `install[.exe]`;
- legacy updater and bootstrap verify separate downloads;
- no extracted file executes before verification;
- safe extraction rejects traversal and symlink entries;
- Windows fallback path is locally derived, never manifest-controlled;
- production binaries lack the test endpoint override.

- [ ] **Step 3: Update feature catalogue and changelog**

Keep stable feature ID `cli-26`, but replace bridge wording:

```text
Updates are staged and signature-verified by the client, then applied by the
new release's versioned installer protocol. Already-installed legacy clients
enter a signed universal bootstrap: Windows repairs to the stub layout with
.old fallback and a rerun prompt; macOS/Linux repair in place and resume the
original command.
```

Update `cli-15` so it no longer claims the updater itself performs the swap.
Update `cli-16` so `install[.exe]` is described as a dedicated stable installer,
not the Rust client itself.

Replace the 3.2.0 bridge changelog entry with:

```json
"Migrate existing Windows, macOS, and Linux installs directly to installer-owned updates without requiring an intermediate release",
"Make every future update use the new release's signed installer, preventing old clients from dictating new binary layouts"
```

- [ ] **Step 4: Check stale wording is gone**

Run:

```bash
rg -n "bridge release|bridge-to|skip(s|ped)? the bridge|updater.*pointer|updater.*swap" \
  docs CHANGELOG.json rust scripts tests
```

Expected: no active design, user, or test documentation relies on bridge
adoption. Historical git commit references inside the upgrade harness are
allowed.

- [ ] **Step 5: Commit**

```bash
git add docs CHANGELOG.json
git commit -m "docs: describe installer-owned cross-platform updates"
```

---

### Task 10: Verify the complete update architecture

**Files:**
- Modify only if verification exposes defects directly caused by this work.

- [ ] **Step 1: Format**

Run:

```bash
cd rust
cargo fmt --check
```

Expected: PASS. If it fails, run `cargo fmt`, inspect the diff, and rerun
`cargo fmt --check`.

- [ ] **Step 2: Run focused Rust update/install suites with and without test hooks**

Run:

```bash
cd rust
cargo test -p climon-update
cargo test -p climon-update --features test-update-endpoint
cargo test -p climon-install
cargo test -p climon-setup
cargo test -p climon-setup --features test-update-endpoint
```

Expected: PASS.

- [ ] **Step 3: Run workspace Rust verification**

Run:

```bash
cd rust
cargo test --workspace
cargo clippy --all-targets -- -D warnings
```

Expected: PASS, apart from a confirmed pre-existing macOS
`climon-remote::shutdown_watch` timing flake; rerun only that failed test once to
distinguish the known flake from a regression.

- [ ] **Step 4: Run Bun tests and type checking**

Run:

```bash
bun test tests
bun run typecheck
```

Expected: no new failures. Compare any full-suite-only failures with the known
base failures before changing unrelated code.

- [ ] **Step 5: Run host packaging and migration**

Run:

```bash
bun scripts/compile.ts
bun scripts/upgrade-test-harness.ts
```

Expected: host archive contains the stable installer and required payloads; all
direct legacy migration, tamper, offline/fallback, and current update scenarios
PASS.

- [ ] **Step 6: Run release attribution gates**

Run:

```bash
cd rust
cargo deny check
cargo about generate about.hbs > target/climon-about.html
```

Expected: PASS.

- [ ] **Step 7: Review final architecture diff**

Run:

```bash
git --no-pager diff origin/dev...HEAD --stat
git --no-pager diff origin/dev...HEAD -- rust/climon-update rust/climon-install rust/climon-setup
rg -n "climon\\.dll|climon-server\\.exe|climon\\.version|write_pointer|replace_file_atomic" \
  rust/climon-update/src/update_cmd.rs rust/climon-update/src/update_cli.rs
```

Expected: updater application search returns no matches; installer owns all
layout names and placement.

- [ ] **Step 8: Commit verification fixes, if any**

If verification required code changes:

```bash
git add <changed-files>
git commit -m "fix(update): address cross-platform verification findings"
```

If no changes were required, do not create an empty commit.

- [ ] **Step 9: Request final review**

Dispatch:

1. spec-compliance review against
   `docs/superpowers/specs/2026-07-11-installer-owned-updates-design.md`;
2. code-quality review of `origin/dev...HEAD`;
3. security review focused on signed staging, ZIP extraction, command execution,
   Windows fallback, and test-hook isolation.

Resolve every blocking finding and rerun the smallest affected verification
command before requesting re-review.

---

## Release gate

Before merging the release PR, record real-machine results for:

- Windows x64: direct pre-change release → release candidate, rerun behavior,
  `.old` fallback, and non-recursive update failure;
- macOS arm64 and x64 where available: direct pre-change release → release
  candidate with automatic resume and offline guidance;
- Linux x64 and arm64 where available: direct pre-change release → release
  candidate with automatic resume and offline guidance;
- tampered first-hop and bootstrap artifacts rejected before mutation/execution;
- current release candidate → next signed candidate through
  `--apply-update-v1`.

Do not publish until Windows, macOS, and Linux direct migration cases pass. No
bridge release or ordered adoption requirement is permitted.
