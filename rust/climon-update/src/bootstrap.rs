//! Legacy-updater bootstrap orchestration.
//!
//! Already-shipped updaters replace `climon[.exe]` with signed installer bytes.
//! This module redownloads and independently verifies the release, then invokes
//! its stable installer through the recovery protocol. Platform-specific
//! recovery application remains owned by `climon-install`.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use climon_install::manifest::{install_files_for_platform, Platform};

use crate::artifact::{stage_release_artifact, StagedArtifact};
use crate::check::DEFAULT_MANIFEST_URL;
use crate::manifest::{current_node_arch, current_node_platform, fetch_manifest, Manifest};
use crate::pubkey::UPDATE_PUBLIC_KEY_B64;

/// Process-launch behavior required by the host platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryPlatform {
    Windows,
    Unix,
}

/// Result of launching the recovery installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryLaunch {
    /// A detached recovery process now owns the staged release.
    Detached,
    /// The synchronous recovery installer and resumed client have exited.
    Synchronous(i32),
}

/// Failure phase for legacy bootstrap recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapError {
    /// Manifest retrieval, artifact download, verification, or extraction failed.
    Staging(String),
    /// Verified staging succeeded, but validation or recovery execution failed.
    Recovery(String),
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Staging(message) | Self::Recovery(message) => formatter.write_str(message),
        }
    }
}

const UNIX_RECOVERY_GUIDANCE: &str = "climon must complete a one-time critical update and requires a network connection.\nReconnect and rerun this command, or run the current install.sh to repair climon.";

/// Inputs needed to bootstrap a legacy updater invocation.
pub struct BootstrapRequest<'a> {
    pub current_exe: &'a Path,
    pub original_args: &'a [OsString],
    pub platform: RecoveryPlatform,
    pub node_platform: &'a str,
    pub node_arch: &'a str,
}

/// A verified, extracted release held by the bootstrap runtime.
pub trait BootstrapStaging {
    fn root(&self) -> &Path;
    fn entry(&self, name: &str) -> Result<PathBuf, String>;
    fn persist(self) -> Result<PathBuf, String>;
}

/// Injectable authenticated staging and recovery-launch operations.
pub trait BootstrapRuntime {
    type Staging: BootstrapStaging;

    fn fetch_manifest(&mut self) -> Result<Manifest, String>;
    fn stage_release(
        &mut self,
        manifest: &Manifest,
        node_platform: &str,
        node_arch: &str,
    ) -> Result<Self::Staging, String>;
    fn launch_recovery(
        &mut self,
        program: &Path,
        args: &[OsString],
        detached: bool,
    ) -> Result<RecoveryLaunch, String>;
}

impl BootstrapStaging for StagedArtifact {
    fn root(&self) -> &Path {
        StagedArtifact::root(self)
    }

    fn entry(&self, name: &str) -> Result<PathBuf, String> {
        StagedArtifact::entry(self, name).map_err(|error| error.to_string())
    }

    fn persist(self) -> Result<PathBuf, String> {
        StagedArtifact::keep(self).map_err(|error| error.to_string())
    }
}

/// Production bootstrap runtime using the canonical manifest and update key.
pub struct ProductionBootstrapRuntime;

impl BootstrapRuntime for ProductionBootstrapRuntime {
    type Staging = StagedArtifact;

    fn fetch_manifest(&mut self) -> Result<Manifest, String> {
        fetch_manifest(DEFAULT_MANIFEST_URL)
    }

    fn stage_release(
        &mut self,
        manifest: &Manifest,
        node_platform: &str,
        node_arch: &str,
    ) -> Result<Self::Staging, String> {
        stage_release_artifact(manifest, node_platform, node_arch, UPDATE_PUBLIC_KEY_B64)
            .map_err(|error| error.to_string())
    }

    fn launch_recovery(
        &mut self,
        program: &Path,
        args: &[OsString],
        detached: bool,
    ) -> Result<RecoveryLaunch, String> {
        let mut command = Command::new(program);
        command.args(args);

        if detached {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
            }

            let child = command.spawn().map_err(|error| {
                format!("launch recovery {} failed: {error}", program.display())
            })?;
            drop(child);
            return Ok(RecoveryLaunch::Detached);
        }

        let status = command
            .status()
            .map_err(|error| format!("run recovery {} failed: {error}", program.display()))?;
        Ok(RecoveryLaunch::Synchronous(exit_status_code(status)))
    }
}

fn exit_status_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

fn installer_name(node_platform: &str) -> &'static str {
    if node_platform == "win32" {
        "install.exe"
    } else {
        "install"
    }
}

/// Fetches, verifies, validates, and launches recovery through an injected runtime.
pub fn run_legacy_bootstrap_with_runtime<R: BootstrapRuntime>(
    request: BootstrapRequest<'_>,
    runtime: &mut R,
) -> Result<i32, BootstrapError> {
    let manifest = runtime.fetch_manifest().map_err(BootstrapError::Staging)?;
    let staging = runtime
        .stage_release(&manifest, request.node_platform, request.node_arch)
        .map_err(BootstrapError::Staging)?;
    let installer = staging
        .entry(installer_name(request.node_platform))
        .map_err(BootstrapError::Recovery)?;

    let install_platform =
        Platform::from_node_platform(request.node_platform).ok_or_else(|| {
            BootstrapError::Recovery(format!(
                "unsupported bootstrap platform: {}",
                request.node_platform
            ))
        })?;
    for file in install_files_for_platform(install_platform) {
        staging
            .entry(&file.source)
            .map_err(BootstrapError::Recovery)?;
    }

    let install_dir = request.current_exe.parent().ok_or_else(|| {
        BootstrapError::Recovery("bootstrap executable path has no parent directory".to_string())
    })?;
    let source = staging.root().to_path_buf();
    let mut recovery_args = vec![
        OsString::from("--recover-bootstrap-v1"),
        OsString::from("--dir"),
        install_dir.as_os_str().to_owned(),
        OsString::from("--source"),
        source.as_os_str().to_owned(),
        OsString::from("--version"),
        OsString::from(&manifest.version),
    ];
    for arg in request.original_args {
        recovery_args.push(OsString::from("--original-arg"));
        recovery_args.push(arg.clone());
    }

    let detached = request.platform == RecoveryPlatform::Windows;
    let launch = runtime
        .launch_recovery(&installer, &recovery_args, detached)
        .map_err(BootstrapError::Recovery)?;
    match launch {
        RecoveryLaunch::Detached => {
            staging.persist().map_err(BootstrapError::Recovery)?;
            Ok(0)
        }
        RecoveryLaunch::Synchronous(code) => Ok(code),
    }
}

fn current_recovery_platform() -> RecoveryPlatform {
    if cfg!(windows) {
        RecoveryPlatform::Windows
    } else {
        RecoveryPlatform::Unix
    }
}

/// Production legacy-bootstrap entrypoint. Returns a process exit code.
pub fn run_legacy_bootstrap(
    current_exe: &Path,
    original_args: &[OsString],
    _bootstrap_version: &str,
) -> i32 {
    let request = BootstrapRequest {
        current_exe,
        original_args,
        platform: current_recovery_platform(),
        node_platform: current_node_platform(),
        node_arch: current_node_arch(),
    };
    let mut runtime = ProductionBootstrapRuntime;
    run_legacy_bootstrap_entry_with_runtime(request, &mut runtime, &mut |message| {
        eprintln!("{message}")
    })
}

fn run_legacy_bootstrap_entry_with_runtime<R: BootstrapRuntime>(
    request: BootstrapRequest<'_>,
    runtime: &mut R,
    eprint: &mut dyn FnMut(&str),
) -> i32 {
    let unix = request.platform == RecoveryPlatform::Unix;
    match run_legacy_bootstrap_with_runtime(request, runtime) {
        Ok(code) => code,
        Err(BootstrapError::Staging(_)) if unix => {
            eprint(UNIX_RECOVERY_GUIDANCE);
            1
        }
        Err(error) => {
            eprint(&format!("climon bootstrap failed: {error}"));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Manifest, ManifestArtifact};
    use std::collections::{BTreeMap, HashSet};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RuntimeState {
        fetches: usize,
        stages: usize,
        stage_requests: Vec<(String, String)>,
        launches: Vec<(PathBuf, Vec<OsString>, bool)>,
        staging_alive: bool,
        staging_alive_during_launch: Vec<bool>,
        persists: usize,
        events: Vec<&'static str>,
    }

    struct FakeStaging {
        root: PathBuf,
        entries: HashSet<String>,
        state: Arc<Mutex<RuntimeState>>,
    }

    impl BootstrapStaging for FakeStaging {
        fn root(&self) -> &Path {
            &self.root
        }

        fn entry(&self, name: &str) -> Result<PathBuf, String> {
            if self.entries.contains(name) {
                Ok(self.root.join(name))
            } else {
                Err(format!("missing staged entry: {name}"))
            }
        }

        fn persist(self) -> Result<PathBuf, String> {
            let mut state = self.state.lock().unwrap();
            state.persists += 1;
            state.events.push("persist");
            Ok(self.root.clone())
        }
    }

    impl Drop for FakeStaging {
        fn drop(&mut self) {
            self.state.lock().unwrap().staging_alive = false;
        }
    }

    struct FakeRuntime {
        state: Arc<Mutex<RuntimeState>>,
        manifest: Result<Manifest, String>,
        stage_error: Option<String>,
        entries: HashSet<String>,
        launch_error: Option<String>,
        launch_result: Option<RecoveryLaunch>,
    }

    impl FakeRuntime {
        fn new(entries: &[&str]) -> Self {
            Self {
                state: Arc::new(Mutex::new(RuntimeState::default())),
                manifest: Ok(manifest("2.0.0")),
                stage_error: None,
                entries: entries.iter().map(|name| (*name).to_string()).collect(),
                launch_error: None,
                launch_result: None,
            }
        }
    }

    impl BootstrapRuntime for FakeRuntime {
        type Staging = FakeStaging;

        fn fetch_manifest(&mut self) -> Result<Manifest, String> {
            self.state.lock().unwrap().fetches += 1;
            self.manifest.clone()
        }

        fn stage_release(
            &mut self,
            _manifest: &Manifest,
            node_platform: &str,
            node_arch: &str,
        ) -> Result<Self::Staging, String> {
            let mut state = self.state.lock().unwrap();
            state.stages += 1;
            state
                .stage_requests
                .push((node_platform.to_string(), node_arch.to_string()));
            drop(state);
            if let Some(error) = &self.stage_error {
                return Err(error.clone());
            }
            self.state.lock().unwrap().staging_alive = true;
            Ok(FakeStaging {
                root: PathBuf::from("/verified-stage"),
                entries: self.entries.clone(),
                state: Arc::clone(&self.state),
            })
        }

        fn launch_recovery(
            &mut self,
            program: &Path,
            args: &[OsString],
            detached: bool,
        ) -> Result<RecoveryLaunch, String> {
            let mut state = self.state.lock().unwrap();
            let staging_alive = state.staging_alive;
            state.staging_alive_during_launch.push(staging_alive);
            state
                .launches
                .push((program.to_path_buf(), args.to_vec(), detached));
            state.events.push("launch");
            if let Some(error) = &self.launch_error {
                return Err(error.clone());
            }
            Ok(self.launch_result.unwrap_or(if detached {
                RecoveryLaunch::Detached
            } else {
                RecoveryLaunch::Synchronous(0)
            }))
        }
    }

    fn manifest(version: &str) -> Manifest {
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            "linux-x64".to_string(),
            ManifestArtifact {
                url: "artifact".to_string(),
                sig: "signature".to_string(),
            },
        );
        Manifest {
            version: version.to_string(),
            encryption: None,
            artifacts,
        }
    }

    fn request<'a>(
        current_exe: &'a Path,
        original_args: &'a [OsString],
        platform: RecoveryPlatform,
        node_platform: &'a str,
    ) -> BootstrapRequest<'a> {
        BootstrapRequest {
            current_exe,
            original_args,
            platform,
            node_platform,
            node_arch: "x64",
        }
    }

    #[cfg(unix)]
    fn non_utf8_original_arg() -> OsString {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(vec![b'-', 0xff])
    }

    #[cfg(windows)]
    fn non_utf8_original_arg() -> OsString {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0xd800])
    }

    #[test]
    fn manifest_fetch_failure_never_stages_or_launches() {
        let mut runtime = FakeRuntime::new(&[]);
        runtime.manifest = Err("offline".to_string());

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
        );

        assert_eq!(result, Err(BootstrapError::Staging("offline".to_string())));
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.fetches, 1);
        assert_eq!(state.stages, 0);
        assert!(state.launches.is_empty());
    }

    #[test]
    fn signature_verification_failure_never_launches() {
        let mut runtime = FakeRuntime::new(&[]);
        runtime.stage_error = Some("signature verification failed".to_string());

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
        );

        assert_eq!(
            result,
            Err(BootstrapError::Staging(
                "signature verification failed".to_string()
            ))
        );
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.stages, 1);
        assert!(state.launches.is_empty());
    }

    #[test]
    fn missing_installer_declared_payload_never_launches() {
        let mut runtime = FakeRuntime::new(&["install", "climon"]);

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
        );

        assert!(result.unwrap_err().to_string().contains("climon-server"));
        assert!(runtime.state.lock().unwrap().launches.is_empty());
    }

    #[test]
    fn missing_installer_entry_never_launches() {
        let mut runtime = FakeRuntime::new(&["climon", "climon-server"]);

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
        );

        assert!(result.unwrap_err().to_string().contains("install"));
        assert!(runtime.state.lock().unwrap().launches.is_empty());
    }

    #[test]
    fn valid_flow_builds_strict_recovery_args_and_detaches_only_on_windows() {
        let original_args = vec![OsString::from("session"), non_utf8_original_arg()];
        let cases = [
            (
                RecoveryPlatform::Windows,
                "win32",
                &["install.exe", "climon.dll", "climon-server.exe"][..],
                true,
            ),
            (
                RecoveryPlatform::Unix,
                "linux",
                &["install", "climon", "climon-server"][..],
                false,
            ),
        ];

        for (platform, node_platform, entries, expected_detached) in cases {
            let mut runtime = FakeRuntime::new(entries);
            run_legacy_bootstrap_with_runtime(
                request(
                    Path::new("/installed/climon"),
                    &original_args,
                    platform,
                    node_platform,
                ),
                &mut runtime,
            )
            .unwrap();

            let state = runtime.state.lock().unwrap();
            assert_eq!(state.launches.len(), 1);
            let (program, args, detached) = &state.launches[0];
            assert_eq!(
                program,
                &PathBuf::from("/verified-stage").join(if expected_detached {
                    "install.exe"
                } else {
                    "install"
                })
            );
            assert_eq!(
                args,
                &vec![
                    OsString::from("--recover-bootstrap-v1"),
                    OsString::from("--dir"),
                    OsString::from("/installed"),
                    OsString::from("--source"),
                    OsString::from("/verified-stage"),
                    OsString::from("--version"),
                    OsString::from("2.0.0"),
                    OsString::from("--original-arg"),
                    OsString::from("session"),
                    OsString::from("--original-arg"),
                    original_args[1].clone(),
                ]
            );
            assert_eq!(*detached, expected_detached);
            assert_eq!(state.persists, usize::from(expected_detached));
            assert_eq!(
                state.stage_requests,
                vec![(node_platform.to_string(), "x64".to_string())]
            );
        }
    }

    #[test]
    fn unix_recovery_returns_exact_exit_code_and_keeps_staging_alive_until_completion() {
        let mut runtime = FakeRuntime::new(&["install", "climon", "climon-server"]);
        runtime.launch_result = Some(RecoveryLaunch::Synchronous(23));

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[OsString::from("session")],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
        );

        assert_eq!(result, Ok(23));
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.staging_alive_during_launch, vec![true]);
        assert!(!state.staging_alive);
        assert_eq!(state.persists, 0);
    }

    #[test]
    fn unix_recovery_staging_failures_emit_exact_network_repair_guidance() {
        let expected = "climon must complete a one-time critical update and requires a network connection.\nReconnect and rerun this command, or run the current install.sh to repair climon.";

        for stage_error in [None, Some("signature verification failed".to_string())] {
            let mut runtime = FakeRuntime::new(&["install", "climon", "climon-server"]);
            if let Some(error) = stage_error {
                runtime.stage_error = Some(error);
            } else {
                runtime.manifest = Err("offline".to_string());
            }
            let mut output = Vec::new();

            let code = run_legacy_bootstrap_entry_with_runtime(
                request(
                    Path::new("/installed/climon"),
                    &[],
                    RecoveryPlatform::Unix,
                    "linux",
                ),
                &mut runtime,
                &mut |message| output.push(message.to_string()),
            );

            assert_eq!(code, 1);
            assert_eq!(output, vec![expected]);
        }
    }

    #[test]
    fn unix_recovery_execution_failures_are_not_reported_as_network_failures() {
        let mut runtime = FakeRuntime::new(&["install", "climon", "climon-server"]);
        runtime.launch_error = Some("permission denied".to_string());
        let mut output = Vec::new();

        let code = run_legacy_bootstrap_entry_with_runtime(
            request(
                Path::new("/installed/climon"),
                &[],
                RecoveryPlatform::Unix,
                "linux",
            ),
            &mut runtime,
            &mut |message| output.push(message.to_string()),
        );

        assert_eq!(code, 1);
        assert_eq!(output, vec!["climon bootstrap failed: permission denied"]);
    }

    #[test]
    fn windows_staging_is_persisted_only_after_successful_detached_spawn() {
        let mut runtime = FakeRuntime::new(&["install.exe", "climon.dll", "climon-server.exe"]);

        run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon.exe"),
                &[],
                RecoveryPlatform::Windows,
                "win32",
            ),
            &mut runtime,
        )
        .unwrap();

        let state = runtime.state.lock().unwrap();
        assert_eq!(state.events, vec!["launch", "persist"]);
        assert_eq!(state.persists, 1);
    }

    #[test]
    fn failed_windows_spawn_does_not_transfer_staging_ownership() {
        let mut runtime = FakeRuntime::new(&["install.exe", "climon.dll", "climon-server.exe"]);
        runtime.launch_error = Some("spawn failed".to_string());

        let result = run_legacy_bootstrap_with_runtime(
            request(
                Path::new("/installed/climon.exe"),
                &[],
                RecoveryPlatform::Windows,
                "win32",
            ),
            &mut runtime,
        );

        assert_eq!(
            result,
            Err(BootstrapError::Recovery("spawn failed".to_string()))
        );
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.events, vec!["launch"]);
        assert_eq!(state.persists, 0);
    }
}
