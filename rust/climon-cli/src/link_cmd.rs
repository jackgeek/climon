//! `climon link` command wrapper. Port of `src/cli/link-cmd.ts`.

use std::path::Path;

use climon_config::config::Env as ConfigEnv;
use climon_remote::link::{link_peer, LinkDeps, LinkOptions};

/// `climon link [--peer-home <path>] [--wsl-bridge|--no-wsl-bridge]` — wires
/// same-machine WSL<->Windows dashboard discovery and optionally enables the
/// WSL bridge feature on both sides. Mirrors `runLinkCommand`.
///
/// `is_tty` is whether stdin is a terminal (drives the default prompt path);
/// `confirm` reads a yes/no answer (injected for testability).
pub fn run_link_command(
    argv: &[String],
    env: &ConfigEnv,
    cwd: &Path,
    is_tty: bool,
    confirm: &mut dyn FnMut(&str) -> bool,
    out: &mut dyn FnMut(&str),
) -> i32 {
    let mut peer_home: Option<String> = None;
    let mut wsl_bridge_choice: Option<bool> = None;
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--peer-home" {
            peer_home = argv.get(i + 1).cloned();
            i += 1;
        } else if let Some(value) = arg.strip_prefix("--peer-home=") {
            peer_home = Some(value.to_string());
        } else if arg == "--wsl-bridge" {
            wsl_bridge_choice = Some(true);
        } else if arg == "--no-wsl-bridge" {
            wsl_bridge_choice = Some(false);
        } else if arg == "--help" || arg == "-h" {
            out("Usage: climon link [--peer-home <path-to-peer-CLIMON_HOME>] [--wsl-bridge|--no-wsl-bridge]\n");
            return 0;
        }
        i += 1;
    }

    let enable_wsl_bridge = match wsl_bridge_choice {
        Some(value) => value,
        None if is_tty => {
            confirm("Enable the WSL bridge so sessions appear on the shared dashboard? [Y/n] ")
        }
        None => {
            out("No TTY detected; the WSL bridge is left disabled (pass --wsl-bridge to enable it in automation).\n");
            false
        }
    };

    match link_peer(
        LinkOptions {
            peer_home,
            enable_wsl_bridge,
        },
        env,
        cwd,
        &LinkDeps::default(),
    ) {
        Ok(result) => {
            out(&format!(
                "Linked {} -> {}\n",
                result.local_home, result.peer_home
            ));
            if result.reverse_linked {
                out("Reverse pointer written into the peer config; both directions are configured.\n");
            } else {
                out("Run `climon link` on the peer to configure the reverse direction.\n");
            }
            if result.wsl_bridge_local {
                let scope = if result.wsl_bridge_peer {
                    "both sides"
                } else {
                    "this side"
                };
                out(&format!(
                    "WSL bridge enabled on {scope}. Restart climon (or start your next session) for it to take effect.\n"
                ));
            }
            0
        }
        Err(message) => {
            out(&format!("climon link: {message}\n"));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "climon-link-cmd-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn help_flag_prints_usage_and_exits_zero() {
        let env = ConfigEnv::real();
        let cwd = std::env::current_dir().unwrap();
        let mut lines: Vec<String> = Vec::new();
        let mut confirm = |_q: &str| true;
        let code = run_link_command(
            &["--help".to_string()],
            &env,
            &cwd,
            false,
            &mut confirm,
            &mut |t| lines.push(t.to_string()),
        );
        assert_eq!(code, 0);
        assert!(lines.iter().any(|l| l.contains("Usage: climon link")));
    }

    #[test]
    fn no_wsl_bridge_flag_skips_prompt_and_does_not_enable() {
        let root = tmp("no-wsl-bridge");
        let home = root.join("home");
        let peer = root.join("peer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let env = ConfigEnv::new(Some(home.to_str().unwrap()), home.clone());
        let mut lines: Vec<String> = Vec::new();
        let mut confirm_called = false;
        let mut confirm = |_q: &str| {
            confirm_called = true;
            true
        };
        let code = run_link_command(
            &[
                "--peer-home".to_string(),
                peer.to_string_lossy().into_owned(),
                "--no-wsl-bridge".to_string(),
            ],
            &env,
            &root,
            true,
            &mut confirm,
            &mut |t| lines.push(t.to_string()),
        );
        assert!(
            !confirm_called,
            "prompt must be skipped when --no-wsl-bridge is given"
        );
        assert_eq!(code, 0);
        let config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(config.contains("\"peerHome\""));
        assert!(!config.contains("\"wslBridge\""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn non_interactive_default_leaves_wsl_bridge_disabled() {
        let root = tmp("non-tty-default");
        let home = root.join("home");
        let peer = root.join("peer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let env = ConfigEnv::new(Some(home.to_str().unwrap()), home.clone());
        let mut lines: Vec<String> = Vec::new();
        let mut confirm_called = false;
        let mut confirm = |_q: &str| {
            confirm_called = true;
            true
        };
        // No --wsl-bridge/--no-wsl-bridge flag and is_tty=false: least-privilege
        // default must leave the bridge OFF without consulting the prompt.
        let code = run_link_command(
            &[
                "--peer-home".to_string(),
                peer.to_string_lossy().into_owned(),
            ],
            &env,
            &root,
            false,
            &mut confirm,
            &mut |t| lines.push(t.to_string()),
        );
        assert!(!confirm_called, "prompt must not run without a TTY");
        assert_eq!(code, 0);
        assert!(
            lines.iter().any(|l| l.contains("No TTY detected")),
            "should explain the bridge was left disabled"
        );
        let config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(!config.contains("\"wslBridge\""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn interactive_confirm_yes_enables_wsl_bridge() {
        let root = tmp("tty-confirm-yes");
        let home = root.join("home");
        let peer = root.join("peer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let env = ConfigEnv::new(Some(home.to_str().unwrap()), home.clone());
        let mut lines: Vec<String> = Vec::new();
        let mut confirm = |_q: &str| true;
        // is_tty=true with no explicit flag: prompt answered Yes must enable the
        // bridge in the local config.
        let code = run_link_command(
            &[
                "--peer-home".to_string(),
                peer.to_string_lossy().into_owned(),
            ],
            &env,
            &root,
            true,
            &mut confirm,
            &mut |t| lines.push(t.to_string()),
        );
        assert_eq!(code, 0);
        let config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(config.contains("\"wslBridge\""));
        std::fs::remove_dir_all(&root).ok();
    }
}
