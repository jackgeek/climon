//! Legacy-updater bootstrap orchestration.
//!
//! Already-shipped updaters replace `climon[.exe]` with signed installer bytes.
//! This module redownloads and independently verifies the release, then invokes
//! its stable installer through the recovery protocol. Platform-specific
//! recovery application remains owned by `climon-install`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    ) -> Result<(), String>;
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
    ) -> Result<(), String> {
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
            return Ok(());
        }

        let status = command
            .status()
            .map_err(|error| format!("run recovery {} failed: {error}", program.display()))?;
        if status.success() {
            Ok(())
        } else {
            Err(match status.code() {
                Some(code) => format!("recovery installer exited with code {code}"),
                None => "recovery installer terminated without an exit code".to_string(),
            })
        }
    }
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
) -> Result<(), String> {
    let manifest = runtime.fetch_manifest()?;
    let staging = runtime.stage_release(&manifest, request.node_platform, request.node_arch)?;
    let installer = staging.entry(installer_name(request.node_platform))?;

    let install_platform = Platform::from_node_platform(request.node_platform)
        .ok_or_else(|| format!("unsupported bootstrap platform: {}", request.node_platform))?;
    for file in install_files_for_platform(install_platform) {
        staging.entry(&file.source)?;
    }

    let install_dir = request
        .current_exe
        .parent()
        .ok_or_else(|| "bootstrap executable path has no parent directory".to_string())?;
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
    runtime.launch_recovery(&installer, &recovery_args, detached)?;
    if detached {
        staging.persist()?;
    }
    Ok(())
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
    match run_legacy_bootstrap_with_runtime(request, &mut runtime) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("climon bootstrap failed: {error}");
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
        launches: Vec<(PathBuf, Vec<OsString>, bool)>,
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
            Ok(self.root)
        }
    }

    struct FakeRuntime {
        state: Arc<Mutex<RuntimeState>>,
        manifest: Result<Manifest, String>,
        stage_error: Option<String>,
        entries: HashSet<String>,
        launch_error: Option<String>,
    }

    impl FakeRuntime {
        fn new(entries: &[&str]) -> Self {
            Self {
                state: Arc::new(Mutex::new(RuntimeState::default())),
                manifest: Ok(manifest("2.0.0")),
                stage_error: None,
                entries: entries.iter().map(|name| (*name).to_string()).collect(),
                launch_error: None,
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
            _node_platform: &str,
            _node_arch: &str,
        ) -> Result<Self::Staging, String> {
            self.state.lock().unwrap().stages += 1;
            if let Some(error) = &self.stage_error {
                return Err(error.clone());
            }
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
        ) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state
                .launches
                .push((program.to_path_buf(), args.to_vec(), detached));
            state.events.push("launch");
            if let Some(error) = &self.launch_error {
                return Err(error.clone());
            }
            Ok(())
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

        assert_eq!(result, Err("offline".to_string()));
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

        assert_eq!(result, Err("signature verification failed".to_string()));
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

        assert!(result.unwrap_err().contains("climon-server"));
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
        }
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

        assert_eq!(result, Err("spawn failed".to_string()));
        let state = runtime.state.lock().unwrap();
        assert_eq!(state.events, vec!["launch"]);
        assert_eq!(state.persists, 0);
    }
}
