//! Native self-install entrypoints. Port of the platform installer `main()`
//! flows (`src/install/index.ts`, `src/install/macos-main.ts`,
//! `src/install/linux-main.ts`) plus the runtime platform dispatch in
//! `src/installer-bundle-entry.ts`.
//!
//! In the shipped Rust client, the `climon` binary itself runs the installer
//! when a `climon-alpha` sentinel sibling is present next to the executable
//! (see `climon-cli`'s `try_run_installer`). There is no JS installer bundle
//! any more; the entire self-install is native.
//!
//! The orchestration ([`run_installer_main`]) is pure and unit-tested on any
//! host via injected IO, exactly mirroring how the rest of the crate injects
//! platform/env/IO. The `cfg`-gated platform `main` functions compose the
//! existing building blocks (manifest, file placement, chmod, PATH editing,
//! onboarding, changelog) and wire them to real stdio/syscalls.

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

use crate::changelog::{format_changelog, get_changes_since, load_changelog};
use crate::onboarding::{run_onboarding, OnboardingIo, SetupOptions};
use crate::orchestrate::{run_setup_cli, SetupCliRuntime};
use climon_config::config::Env;

/// The outcome of the PATH-setup step: whether anything changed plus the exact
/// console lines to print (which differ per platform).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PathSetup {
    pub changed: bool,
    pub messages: Vec<String>,
}

/// Injectable IO for [`run_installer_main`]. Every closure that the TS `main`
/// could throw from returns `Result<_, String>` so the error surfaces through
/// [`run_setup_cli`] exactly like the Bun installer's `runSetupCli` catch.
pub struct InstallerIo<'a> {
    /// Resolved install directory (platform-specific).
    pub install_dir: PathBuf,
    /// The version being installed.
    pub version: String,
    /// Parsed setup/onboarding options.
    pub setup_options: SetupOptions,
    /// Reads the previously-installed version from the install dir.
    pub read_installed_version: &'a mut dyn FnMut(&Path) -> Option<String>,
    /// Runs onboarding; returns whether the EULA was accepted.
    pub run_onboarding: &'a mut dyn FnMut(&SetupOptions) -> Result<bool, String>,
    /// Copies the manifest binaries into the install dir (locked-file retry inside).
    pub install_binaries: &'a mut dyn FnMut(&Path) -> Result<(), String>,
    /// Post-copy fixups (chmod on Unix; no-op on Windows).
    pub finalize_binaries: &'a mut dyn FnMut(&Path) -> Result<(), String>,
    /// Writes the `.version` marker.
    pub write_version_file: &'a mut dyn FnMut(&Path, &str) -> Result<(), String>,
    /// Adds the install dir to PATH and reports what to print.
    pub setup_path: &'a mut dyn FnMut(&Path) -> Result<PathSetup, String>,
    /// Formats the changelog tail since the previous version (empty when none).
    pub changelog_since: &'a mut dyn FnMut(Option<&str>) -> String,
    /// Writes a line to stdout.
    pub print: &'a mut dyn FnMut(&str),
    /// Writes a line to stderr.
    pub eprint: &'a mut dyn FnMut(&str),
    /// Pauses before exit (double-click readability); no-op when not a TTY.
    pub pause_for_exit: &'a mut dyn FnMut(),
    /// Terminates the process (real `std::process::exit`; recorded in tests).
    pub exit: &'a mut dyn FnMut(i32),
}

/// Drives a single native self-install. 1:1 port of the platform `main()`
/// ordering: read previous version → onboarding gate → install binaries →
/// finalize → write `.version` → PATH setup → console output → changelog tail.
///
/// On a declined licence it prints the abort message, pauses, and exits(1)
/// (matching `process.exit(1)` in the TS mains, which skips the outer
/// `runSetupCli` pause).
pub fn run_installer_main(io: InstallerIo<'_>) -> Result<(), String> {
    let InstallerIo {
        install_dir,
        version,
        setup_options,
        read_installed_version,
        run_onboarding,
        install_binaries,
        finalize_binaries,
        write_version_file,
        setup_path,
        changelog_since,
        print,
        eprint,
        pause_for_exit,
        exit,
    } = io;

    let previous_version = read_installed_version(&install_dir);

    let accepted = run_onboarding(&setup_options)?;
    if !accepted {
        eprint("Licence not accepted; aborting installation.");
        pause_for_exit();
        exit(1);
        return Ok(());
    }

    install_binaries(&install_dir)?;
    finalize_binaries(&install_dir)?;
    write_version_file(&install_dir, &version)?;

    let path = setup_path(&install_dir)?;

    print(&format!(
        "Installed climon {} to {}",
        version,
        install_dir.display()
    ));
    for message in &path.messages {
        print(message);
    }

    let changes = changelog_since(previous_version.as_deref());
    if !changes.is_empty() {
        print(&changes);
    }

    Ok(())
}

/// The directory the installer copies binaries *from*: the directory holding the
/// running executable (the extracted release zip).
fn installer_source_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Reads a single line after printing `question`. EOF / read error yields "".
fn stdin_prompt(question: &str) -> String {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return String::new();
    }
    line.trim_end_matches(['\n', '\r']).to_string()
}

/// Real pause-before-exit: only prompts when both stdin and stdout are TTYs so
/// piped/non-interactive runs (CI, self-install smoke tests) never block.
fn real_pause_for_exit() {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return;
    }
    print!("Press Enter to exit...");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
}

/// Runs onboarding against the real config env with stdio-backed prompts.
fn real_run_onboarding(env: &Env, options: &SetupOptions) -> Result<bool, String> {
    let mut print = |s: &str| {
        print!("{s}");
        let _ = std::io::stdout().flush();
    };
    let mut prompt = |q: &str| stdin_prompt(q);
    let result = run_onboarding(OnboardingIo {
        env,
        options: options.clone(),
        print: &mut print,
        prompt: &mut prompt,
    })?;
    Ok(result.accepted)
}

/// Formats the changelog tail since `previous` (empty when nothing is new).
fn changelog_since(previous: Option<&str>) -> String {
    let log = load_changelog();
    let entries = get_changes_since(&log, previous);
    format_changelog(&entries)
}

/// Prints a "Failed to copy climon binaries: …" line then a kill+retry prompt.
fn confirm_kill_and_retry(message: &str, prompt: &str) -> bool {
    eprintln!("Failed to copy climon binaries: {message}");
    let answer = stdin_prompt(prompt).trim().to_lowercase();
    answer == "y" || answer == "yes"
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::files::InstallError;
    use crate::files_unix::install_binaries as install_binaries_unix;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    /// Which Unix flavour's profile/install-dir conventions to use. Only one
    /// variant is constructed per target, so the other is "dead" on that build.
    #[allow(dead_code)]
    #[derive(Debug, Clone, Copy)]
    pub enum UnixOs {
        Macos,
        Linux,
    }

    const KILL_RETRY_PROMPT: &str =
        "climon appears to be running. Kill climon processes and try again? [y/N] ";

    fn default_install_dir(os: UnixOs) -> PathBuf {
        match os {
            UnixOs::Macos => crate::macos::get_default_install_dir(),
            UnixOs::Linux => crate::linux::get_default_install_dir(),
        }
    }

    fn make_installed_executable(install_dir: &Path) -> Result<(), String> {
        let path = install_dir.join("climon");
        if path.exists() {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set permissions on climon: {e}"))?;
        }
        Ok(())
    }

    fn setup_path(os: UnixOs, install_dir: &Path) -> Result<PathSetup, String> {
        let install_dir_str = install_dir.to_string_lossy().into_owned();
        let profile = match os {
            UnixOs::Macos => crate::macos::detect_shell_profile(),
            UnixOs::Linux => crate::linux::detect_shell_profile(),
        };
        let changed = match os {
            UnixOs::Macos => crate::macos::ensure_profile_path(&install_dir_str, &profile),
            UnixOs::Linux => crate::linux::ensure_profile_path(&install_dir_str, &profile),
        }
        .map_err(|e| format!("Failed to update {}: {e}", profile.profile_path.display()))?;

        let messages = if changed {
            vec![
                format!(
                    "Updated {} to add climon to your PATH.",
                    profile.profile_path.display()
                ),
                "Open a new terminal or run the following to use climon now:".to_string(),
                format!("  source {}", profile.profile_path.display()),
            ]
        } else {
            vec!["climon is already on your PATH.".to_string()]
        };
        Ok(PathSetup { changed, messages })
    }

    fn install_binaries_step(
        os: UnixOs,
        source_dir: &Path,
        install_dir: &Path,
    ) -> Result<(), String> {
        use crate::files::InstallBinariesOptions;
        let mut confirm =
            |error: &InstallError| confirm_kill_and_retry(&error.message, KILL_RETRY_PROMPT);
        let mut kill = || match os {
            UnixOs::Macos => crate::macos::kill_running_climon_processes(),
            UnixOs::Linux => crate::linux::kill_running_climon_processes(),
        };
        install_binaries_unix(
            source_dir,
            install_dir,
            InstallBinariesOptions {
                copy_file: None,
                confirm_kill_and_retry: Some(&mut confirm),
                kill_running_climon_processes: Some(&mut kill),
            },
        )
        .map_err(|e| e.message)
    }

    /// Runs the native installer for a Unix flavour, wiring real stdio/syscalls.
    pub fn unix_installer_main(argv: &[String], os: UnixOs, version: &str) -> Result<(), String> {
        use crate::onboarding::parse_setup_options;

        let install_dir = default_install_dir(os);
        let source_dir = installer_source_dir();
        let env = Env::real();
        let setup_options = parse_setup_options(argv)?;

        let mut read_installed_version = crate::changelog::read_installed_version;
        let mut run_onboarding_io = |options: &SetupOptions| real_run_onboarding(&env, options);
        let mut install_binaries =
            |install_dir: &Path| install_binaries_step(os, &source_dir, install_dir);
        let mut finalize_binaries = |install_dir: &Path| make_installed_executable(install_dir);
        let mut write_version = |install_dir: &Path, version: &str| {
            crate::files_unix::write_version_file(install_dir, version)
                .map_err(|e| format!("Failed to write .version: {e}"))
        };
        let mut setup_path_io = |install_dir: &Path| setup_path(os, install_dir);
        let mut changelog = changelog_since;
        let mut print = |s: &str| println!("{s}");
        let mut eprint = |s: &str| eprintln!("{s}");
        let mut pause = real_pause_for_exit;
        let mut exit = |code: i32| std::process::exit(code);

        run_installer_main(InstallerIo {
            install_dir,
            version: version.to_string(),
            setup_options,
            read_installed_version: &mut read_installed_version,
            run_onboarding: &mut run_onboarding_io,
            install_binaries: &mut install_binaries,
            finalize_binaries: &mut finalize_binaries,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path_io,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
    }
}

#[cfg(target_os = "windows")]
mod windows_main {
    use super::*;
    use crate::files::install_binaries as install_binaries_win;
    use crate::files::{InstallBinariesOptions, InstallError};
    use crate::orchestrate::{update_user_path_with_io, UserPathIo};

    const KILL_RETRY_PROMPT: &str =
        "The file may be locked by climon or another program (antivirus, Explorer). Kill climon processes and retry? [y/N] ";

    fn install_dir() -> Result<PathBuf, String> {
        let local_app_data = crate::windows::get_local_app_data()?;
        Ok(PathBuf::from(local_app_data)
            .join("Programs")
            .join("climon"))
    }

    fn setup_path(install_dir: &Path) -> Result<PathSetup, String> {
        let install_dir_str = install_dir.to_string_lossy().into_owned();
        let mut read = || crate::windows::read_user_path().unwrap_or_default();
        let mut write = |value: &str| {
            let _ = crate::windows::write_user_path(value);
        };
        let mut broadcast = crate::windows::broadcast_environment_change;
        let changed = update_user_path_with_io(
            &install_dir_str,
            UserPathIo {
                read_user_path: &mut read,
                write_user_path: &mut write,
                broadcast_environment_change: &mut broadcast,
                expand_environment_string: &crate::windows::expand_environment_string,
            },
        );
        let messages = if changed {
            vec!["Updated your user PATH so climon resolves to this install first. Open a new terminal to use it.".to_string()]
        } else {
            vec!["climon is already first on your user PATH.".to_string()]
        };
        Ok(PathSetup { changed, messages })
    }

    fn install_binaries_step(source_dir: &Path, install_dir: &Path) -> Result<(), String> {
        let mut confirm =
            |error: &InstallError| confirm_kill_and_retry(&error.message, KILL_RETRY_PROMPT);
        let mut kill = || {
            let _ = crate::processes::kill_running_climon_processes();
        };
        install_binaries_win(
            source_dir,
            install_dir,
            InstallBinariesOptions {
                copy_file: None,
                confirm_kill_and_retry: Some(&mut confirm),
                kill_running_climon_processes: Some(&mut kill),
            },
        )
        .map_err(|e| e.message)
    }

    pub fn windows_installer_main(argv: &[String], version: &str) -> Result<(), String> {
        use crate::onboarding::parse_setup_options;

        let install_dir = install_dir()?;
        let source_dir = installer_source_dir();
        let env = Env::real();
        let setup_options = parse_setup_options(argv)?;

        let mut read_installed_version = crate::changelog::read_installed_version;
        let mut run_onboarding_io = |options: &SetupOptions| real_run_onboarding(&env, options);
        let mut install_binaries =
            |install_dir: &Path| install_binaries_step(&source_dir, install_dir);
        let mut finalize_binaries = |_install_dir: &Path| Ok(());
        let mut write_version = |install_dir: &Path, version: &str| {
            crate::files::write_version_file(install_dir, version)
                .map_err(|e| format!("Failed to write .version: {e}"))
        };
        let mut setup_path_io = |install_dir: &Path| setup_path(install_dir);
        let mut changelog = changelog_since;
        let mut print = |s: &str| println!("{s}");
        let mut eprint = |s: &str| eprintln!("{s}");
        let mut pause = real_pause_for_exit;
        let mut exit = |code: i32| std::process::exit(code);

        run_installer_main(InstallerIo {
            install_dir,
            version: version.to_string(),
            setup_options,
            read_installed_version: &mut read_installed_version,
            run_onboarding: &mut run_onboarding_io,
            install_binaries: &mut install_binaries,
            finalize_binaries: &mut finalize_binaries,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path_io,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
    }
}

/// Runs the platform-appropriate installer main. Mirrors the runtime platform
/// switch in `src/installer-bundle-entry.ts`.
#[cfg(target_os = "macos")]
fn platform_installer_main(argv: &[String], version: &str) -> Result<(), String> {
    unix::unix_installer_main(argv, unix::UnixOs::Macos, version)
}

#[cfg(target_os = "linux")]
fn platform_installer_main(argv: &[String], version: &str) -> Result<(), String> {
    unix::unix_installer_main(argv, unix::UnixOs::Linux, version)
}

#[cfg(target_os = "windows")]
fn platform_installer_main(argv: &[String], version: &str) -> Result<(), String> {
    windows_main::windows_installer_main(argv, version)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn platform_installer_main(_argv: &[String], _version: &str) -> Result<(), String> {
    Err("Unsupported platform for the climon installer.".to_string())
}

/// Cross-platform self-install entrypoint invoked by the client when the
/// `climon-alpha` sentinel is present. `version` is the client's build version
/// (the value written to `.version`). Runs the platform main under the
/// pause-before-exit wrapper and returns the process exit code (0 on success;
/// failures/declines exit the process from within the wrapper). Mirrors
/// `installer-bundle-entry.ts` + `index.ts`'s `tryRunInstaller`.
pub fn run_installer(version: &str) -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut main = || platform_installer_main(&argv, version);
    let mut write_error = |message: &str| eprintln!("{message}");
    let mut pause = real_pause_for_exit;
    let mut exit = |code: i32| std::process::exit(code);
    run_setup_cli(SetupCliRuntime {
        main: &mut main,
        write_error: &mut write_error,
        pause_for_exit: &mut pause,
        exit: &mut exit,
    });
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Recorder {
        events: RefCell<Vec<String>>,
    }

    impl Recorder {
        fn new() -> Recorder {
            Recorder {
                events: RefCell::new(Vec::new()),
            }
        }
        fn push(&self, s: impl Into<String>) {
            self.events.borrow_mut().push(s.into());
        }
        fn events(&self) -> Vec<String> {
            self.events.borrow().clone()
        }
    }

    fn base_options() -> SetupOptions {
        SetupOptions {
            apply: true,
            accept_eula: true,
            telemetry: None,
            auto_update: None,
        }
    }

    #[test]
    fn success_path_runs_full_sequence_in_order() {
        let rec = Recorder::new();
        let mut read = |_d: &Path| {
            rec.push("read");
            Some("1.0.0".to_string())
        };
        let mut onboard = |_o: &SetupOptions| {
            rec.push("onboard");
            Ok(true)
        };
        let mut install = |_d: &Path| {
            rec.push("install");
            Ok(())
        };
        let mut finalize = |_d: &Path| {
            rec.push("finalize");
            Ok(())
        };
        let mut write_version = |_d: &Path, v: &str| {
            rec.push(format!("version:{v}"));
            Ok(())
        };
        let mut setup_path = |_d: &Path| {
            rec.push("path");
            Ok(PathSetup {
                changed: true,
                messages: vec!["msg".to_string()],
            })
        };
        let mut changelog = |prev: Option<&str>| {
            rec.push(format!("changelog:{}", prev.unwrap_or("none")));
            "CHANGES".to_string()
        };
        let mut print = |s: &str| rec.push(format!("print:{s}"));
        let mut eprint = |s: &str| rec.push(format!("eprint:{s}"));
        let mut pause = || rec.push("pause");
        let mut exit = |c: i32| rec.push(format!("exit:{c}"));

        run_installer_main(InstallerIo {
            install_dir: PathBuf::from("/opt/climon"),
            version: "1.2.0".to_string(),
            setup_options: base_options(),
            read_installed_version: &mut read,
            run_onboarding: &mut onboard,
            install_binaries: &mut install,
            finalize_binaries: &mut finalize,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
        .unwrap();

        assert_eq!(
            rec.events(),
            vec![
                "read".to_string(),
                "onboard".to_string(),
                "install".to_string(),
                "finalize".to_string(),
                "version:1.2.0".to_string(),
                "path".to_string(),
                "print:Installed climon 1.2.0 to /opt/climon".to_string(),
                "print:msg".to_string(),
                "changelog:1.0.0".to_string(),
                "print:CHANGES".to_string(),
            ]
        );
    }

    #[test]
    fn licence_declined_aborts_before_install() {
        let rec = Recorder::new();
        let mut read = |_d: &Path| None;
        let mut onboard = |_o: &SetupOptions| Ok(false);
        let mut install = |_d: &Path| {
            rec.push("install");
            Ok(())
        };
        let mut finalize = |_d: &Path| Ok(());
        let mut write_version = |_d: &Path, _v: &str| Ok(());
        let mut setup_path = |_d: &Path| Ok(PathSetup::default());
        let mut changelog = |_p: Option<&str>| String::new();
        let mut print = |s: &str| rec.push(format!("print:{s}"));
        let mut eprint = |s: &str| rec.push(format!("eprint:{s}"));
        let mut pause = || rec.push("pause");
        let mut exit = |c: i32| rec.push(format!("exit:{c}"));

        run_installer_main(InstallerIo {
            install_dir: PathBuf::from("/opt/climon"),
            version: "1.2.0".to_string(),
            setup_options: SetupOptions::default(),
            read_installed_version: &mut read,
            run_onboarding: &mut onboard,
            install_binaries: &mut install,
            finalize_binaries: &mut finalize,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
        .unwrap();

        assert_eq!(
            rec.events(),
            vec![
                "eprint:Licence not accepted; aborting installation.".to_string(),
                "pause".to_string(),
                "exit:1".to_string(),
            ]
        );
    }

    #[test]
    fn install_binaries_error_surfaces() {
        let mut read = |_d: &Path| None;
        let mut onboard = |_o: &SetupOptions| Ok(true);
        let mut install = |_d: &Path| Err("EBUSY: locked".to_string());
        let mut finalize = |_d: &Path| Ok(());
        let mut write_version = |_d: &Path, _v: &str| Ok(());
        let mut setup_path = |_d: &Path| Ok(PathSetup::default());
        let mut changelog = |_p: Option<&str>| String::new();
        let mut print = |_s: &str| {};
        let mut eprint = |_s: &str| {};
        let mut pause = || {};
        let mut exit = |_c: i32| {};

        let err = run_installer_main(InstallerIo {
            install_dir: PathBuf::from("/opt/climon"),
            version: "1.2.0".to_string(),
            setup_options: base_options(),
            read_installed_version: &mut read,
            run_onboarding: &mut onboard,
            install_binaries: &mut install,
            finalize_binaries: &mut finalize,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
        .unwrap_err();
        assert_eq!(err, "EBUSY: locked");
    }

    #[test]
    fn path_changed_vs_unchanged_messaging_differs() {
        fn run(path: PathSetup) -> Vec<String> {
            let rec = Recorder::new();
            let mut read = |_d: &Path| None;
            let mut onboard = |_o: &SetupOptions| Ok(true);
            let mut install = |_d: &Path| Ok(());
            let mut finalize = |_d: &Path| Ok(());
            let mut write_version = |_d: &Path, _v: &str| Ok(());
            let mut setup_path = |_d: &Path| Ok(path.clone());
            let mut changelog = |_p: Option<&str>| String::new();
            let mut print = |s: &str| rec.push(format!("print:{s}"));
            let mut eprint = |_s: &str| {};
            let mut pause = || {};
            let mut exit = |_c: i32| {};
            run_installer_main(InstallerIo {
                install_dir: PathBuf::from("/opt/climon"),
                version: "1.2.0".to_string(),
                setup_options: super::tests::base_options(),
                read_installed_version: &mut read,
                run_onboarding: &mut onboard,
                install_binaries: &mut install,
                finalize_binaries: &mut finalize,
                write_version_file: &mut write_version,
                setup_path: &mut setup_path,
                changelog_since: &mut changelog,
                print: &mut print,
                eprint: &mut eprint,
                pause_for_exit: &mut pause,
                exit: &mut exit,
            })
            .unwrap();
            rec.events()
        }

        let changed = run(PathSetup {
            changed: true,
            messages: vec![
                "Updated /home/ada/.zshrc to add climon to your PATH.".to_string(),
                "Open a new terminal or run the following to use climon now:".to_string(),
                "  source /home/ada/.zshrc".to_string(),
            ],
        });
        let unchanged = run(PathSetup {
            changed: false,
            messages: vec!["climon is already on your PATH.".to_string()],
        });

        assert!(changed
            .iter()
            .any(|m| m.contains("to add climon to your PATH")));
        assert!(changed
            .iter()
            .any(|m| m.contains("source /home/ada/.zshrc")));
        assert!(unchanged
            .iter()
            .any(|m| m.contains("climon is already on your PATH.")));
        assert!(!unchanged
            .iter()
            .any(|m| m.contains("to add climon to your PATH")));
    }

    #[cfg(unix)]
    #[test]
    fn locked_binary_retry_path_recovers_and_continues() {
        use crate::files::{InstallBinariesOptions, InstallError};
        use crate::files_unix::install_binaries as install_binaries_unix;
        use std::cell::Cell;
        use std::fs;

        let root = std::env::temp_dir().join(format!(
            "climon-installer-retry-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let source_dir = root.join("src");
        let install_dir = root.join("bin");
        fs::create_dir_all(&source_dir).unwrap();
        for name in ["install", "climon-server"] {
            fs::write(source_dir.join(name), name).unwrap();
        }

        let attempts = Cell::new(0);
        let prompted = Cell::new(0);
        let killed = Cell::new(0);

        let rec = Recorder::new();
        let mut read = |_d: &Path| None;
        let mut onboard = |_o: &SetupOptions| Ok(true);
        let mut install = |dest: &Path| {
            let mut copy = |src: &Path, dst: &Path| -> Result<(), InstallError> {
                let is_climon = dst.file_name().and_then(|n| n.to_str()) == Some("climon");
                if is_climon && attempts.replace(attempts.get() + 1) == 0 {
                    return Err(InstallError::with_code("ETXTBSY", "text busy"));
                }
                fs::copy(src, dst).unwrap();
                Ok(())
            };
            let mut confirm = |_e: &InstallError| {
                prompted.set(prompted.get() + 1);
                true
            };
            let mut kill = || killed.set(killed.get() + 1);
            install_binaries_unix(
                &source_dir,
                dest,
                InstallBinariesOptions {
                    copy_file: Some(&mut copy),
                    confirm_kill_and_retry: Some(&mut confirm),
                    kill_running_climon_processes: Some(&mut kill),
                },
            )
            .map_err(|e| e.message)
        };
        let mut finalize = |_d: &Path| Ok(());
        let mut write_version = |_d: &Path, _v: &str| Ok(());
        let mut setup_path = |_d: &Path| {
            Ok(PathSetup {
                changed: true,
                messages: vec!["ok".to_string()],
            })
        };
        let mut changelog = |_p: Option<&str>| String::new();
        let mut print = |s: &str| rec.push(format!("print:{s}"));
        let mut eprint = |_s: &str| {};
        let mut pause = || {};
        let mut exit = |_c: i32| {};

        run_installer_main(InstallerIo {
            install_dir: install_dir.clone(),
            version: "1.2.0".to_string(),
            setup_options: base_options(),
            read_installed_version: &mut read,
            run_onboarding: &mut onboard,
            install_binaries: &mut install,
            finalize_binaries: &mut finalize,
            write_version_file: &mut write_version,
            setup_path: &mut setup_path,
            changelog_since: &mut changelog,
            print: &mut print,
            eprint: &mut eprint,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        })
        .unwrap();

        assert_eq!(prompted.get(), 1);
        assert_eq!(killed.get(), 1);
        assert_eq!(
            fs::read_to_string(install_dir.join("climon")).unwrap(),
            "install"
        );
        assert!(rec
            .events()
            .iter()
            .any(|m| m.contains("Installed climon 1.2.0")));
        fs::remove_dir_all(&root).ok();
    }
}
