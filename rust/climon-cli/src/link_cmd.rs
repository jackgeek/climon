//! `climon link` command wrapper. Port of `src/cli/link-cmd.ts`.

use std::path::Path;

use climon_config::config::Env as ConfigEnv;
use climon_remote::link::{link_peer, LinkDeps, LinkOptions};

/// `climon link [--peer-home <path>]` — wires same-machine WSL<->Windows
/// dashboard discovery. Mirrors `runLinkCommand`.
pub fn run_link_command(
    argv: &[String],
    env: &ConfigEnv,
    cwd: &Path,
    out: &mut dyn FnMut(&str),
) -> i32 {
    let mut peer_home: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--peer-home" {
            peer_home = argv.get(i + 1).cloned();
            i += 1;
        } else if let Some(value) = arg.strip_prefix("--peer-home=") {
            peer_home = Some(value.to_string());
        } else if arg == "--help" || arg == "-h" {
            out("Usage: climon link [--peer-home <path-to-peer-CLIMON_HOME>]\n");
            return 0;
        }
        i += 1;
    }

    match link_peer(LinkOptions { peer_home }, env, cwd, &LinkDeps::default()) {
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

    #[test]
    fn help_flag_prints_usage_and_exits_zero() {
        let env = ConfigEnv::real();
        let cwd = std::env::current_dir().unwrap();
        let mut lines: Vec<String> = Vec::new();
        let code = run_link_command(&["--help".to_string()], &env, &cwd, &mut |t| {
            lines.push(t.to_string())
        });
        assert_eq!(code, 0);
        assert!(lines.iter().any(|l| l.contains("Usage: climon link")));
    }
}
