//! Dashboard server delegation. Port of `src/cli/server-exec.ts`.
//!
//! The Rust client cannot load the JS server bundle in-process, so only the
//! spawn path matters: resolve `climon-server` (override → dev entrypoint →
//! installed sibling → bare name on PATH) and exec it with inherited stdio,
//! passing `CLIMON_CLIENT_BIN` so the server can spawn child sessions through
//! this client.

use std::collections::HashMap;
use std::path::Path;

const SERVER_BIN_NAME: &str = "climon-server";
const SERVER_BUNDLE_NAME: &str = "climon-beta";

/// How to launch the dashboard server. Mirrors `ServerInvocation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInvocation {
    pub file: String,
    pub args: Vec<String>,
}

fn trimmed_nonempty(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn dir_of(exec_path: &str) -> &Path {
    Path::new(exec_path)
        .parent()
        .unwrap_or_else(|| Path::new(""))
}

/// Resolves the child env: passes the running client executable as
/// `CLIMON_CLIENT_BIN` unless already set or running a dev entrypoint. Mirrors
/// `resolveServerEnv`.
pub fn resolve_server_env(
    env: &HashMap<String, String>,
    exec_path: &str,
    dev_entrypoint: Option<&str>,
) -> HashMap<String, String> {
    let has_client_bin = trimmed_nonempty(env, "CLIMON_CLIENT_BIN").is_some();
    if has_client_bin || dev_entrypoint.is_some() {
        return env.clone();
    }
    let mut out = env.clone();
    out.insert("CLIMON_CLIENT_BIN".to_string(), exec_path.to_string());
    out
}

/// Resolves a sibling encrypted server bundle that could be loaded in-process.
/// The Rust client never loads it; ported for parity/testing. Mirrors
/// `resolveServerBundle`.
pub fn resolve_server_bundle(env: &HashMap<String, String>, exec_path: &str) -> Option<String> {
    if let Some(override_path) = trimmed_nonempty(env, "CLIMON_SERVER_BUNDLE") {
        if Path::new(&override_path).exists() {
            return Some(override_path);
        }
    }
    let sibling = dir_of(exec_path).join(SERVER_BUNDLE_NAME);
    if sibling.exists() {
        return Some(sibling.to_string_lossy().into_owned());
    }
    None
}

/// Resolves how to launch the dashboard server, without spawning it. Order:
/// `CLIMON_SERVER_BIN` override → dev source entrypoint (when present) → sibling
/// of the running executable → bare name on PATH. Mirrors
/// `resolveServerInvocation`.
pub fn resolve_server_invocation(
    forward_args: &[String],
    env: &HashMap<String, String>,
    exec_path: &str,
    dev_entrypoint: Option<&str>,
    platform: &str,
) -> ServerInvocation {
    if let Some(override_path) = trimmed_nonempty(env, "CLIMON_SERVER_BIN") {
        return ServerInvocation {
            file: override_path,
            args: forward_args.to_vec(),
        };
    }

    if let Some(dev) = dev_entrypoint {
        if Path::new(dev).exists() {
            let mut args = vec![dev.to_string()];
            args.extend(forward_args.iter().cloned());
            return ServerInvocation {
                file: exec_path.to_string(),
                args,
            };
        }
    }

    let exe = if platform == "win32" { ".exe" } else { "" };
    let sibling = dir_of(exec_path).join(format!("{SERVER_BIN_NAME}{exe}"));
    if sibling.exists() {
        return ServerInvocation {
            file: sibling.to_string_lossy().into_owned(),
            args: forward_args.to_vec(),
        };
    }

    ServerInvocation {
        file: SERVER_BIN_NAME.to_string(),
        args: forward_args.to_vec(),
    }
}

/// Node `process.platform` value for this build.
fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Resolves and spawns the dashboard server with inherited stdio. Returns its
/// exit code. Maps a missing server binary (ENOENT) to the install hint and exit
/// code 127. Mirrors the spawn path of `delegateToServer`.
pub fn delegate_to_server(
    forward_args: &[String],
    env: &HashMap<String, String>,
    exec_path: &str,
) -> i32 {
    let resolved_env = resolve_server_env(env, exec_path, None);
    let ServerInvocation { file, args } =
        resolve_server_invocation(forward_args, env, exec_path, None, current_platform());

    let mut command = std::process::Command::new(&file);
    command
        .args(&args)
        .env_clear()
        .envs(&resolved_env)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());

    match command.status() {
        Ok(status) => status.code().unwrap_or(0),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "climon: the dashboard server ({SERVER_BIN_NAME}) is not installed.\n\
                 Install the server binary alongside climon, or set CLIMON_SERVER_BIN to its path."
            );
            127
        }
        Err(err) => {
            eprintln!("climon: failed to start server: {err}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("climon-srvexec-{}", std::process::id()));
        let unique = dir.join(format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&unique).unwrap();
        unique
    }

    #[test]
    fn honors_server_bin_override() {
        let env = env_with(&[("CLIMON_SERVER_BIN", "/opt/climon-server")]);
        assert_eq!(
            resolve_server_invocation(
                &v(&["server", "--port", "9000"]),
                &env,
                "/usr/bin/climon",
                None,
                "linux"
            ),
            ServerInvocation {
                file: "/opt/climon-server".to_string(),
                args: v(&["server", "--port", "9000"])
            }
        );
    }

    #[test]
    fn prefers_sibling_climon_server() {
        let dir = tmp();
        let sibling = dir.join("climon-server");
        std::fs::write(&sibling, "").unwrap();
        let exec_path = dir.join("climon");
        assert_eq!(
            resolve_server_invocation(
                &v(&["server"]),
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                None,
                "linux"
            ),
            ServerInvocation {
                file: sibling.to_string_lossy().into_owned(),
                args: v(&["server"])
            }
        );
    }

    #[test]
    fn prefers_dev_entrypoint_over_sibling() {
        let dir = tmp();
        let sibling = dir.join("climon-server");
        let dev_entry = dir.join("server.ts");
        std::fs::write(&sibling, "").unwrap();
        std::fs::write(&dev_entry, "").unwrap();
        let exec_path = dir.join("bun");
        assert_eq!(
            resolve_server_invocation(
                &v(&["server"]),
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                Some(dev_entry.to_str().unwrap()),
                "linux"
            ),
            ServerInvocation {
                file: exec_path.to_string_lossy().into_owned(),
                args: vec![
                    dev_entry.to_string_lossy().into_owned(),
                    "server".to_string()
                ]
            }
        );
    }

    #[test]
    fn uses_sibling_when_no_dev_entrypoint() {
        let dir = tmp();
        let sibling = dir.join("climon-server");
        std::fs::write(&sibling, "").unwrap();
        let exec_path = dir.join("bun");
        assert_eq!(
            resolve_server_invocation(
                &v(&["server"]),
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                None,
                "linux"
            ),
            ServerInvocation {
                file: sibling.to_string_lossy().into_owned(),
                args: v(&["server"])
            }
        );
    }

    #[test]
    fn prefers_sibling_exe_on_win32() {
        let dir = tmp();
        let sibling = dir.join("climon-server.exe");
        std::fs::write(&sibling, "").unwrap();
        let exec_path = dir.join("climon.exe");
        assert_eq!(
            resolve_server_invocation(
                &[],
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                None,
                "win32"
            ),
            ServerInvocation {
                file: sibling.to_string_lossy().into_owned(),
                args: vec![]
            }
        );
    }

    #[test]
    fn falls_back_to_dev_entrypoint_via_exec_path() {
        let dir = tmp();
        let dev_entry = dir.join("server.ts");
        std::fs::write(&dev_entry, "").unwrap();
        let exec_path = dir.join("bun");
        assert_eq!(
            resolve_server_invocation(
                &v(&["server"]),
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                Some(dev_entry.to_str().unwrap()),
                current_platform()
            ),
            ServerInvocation {
                file: exec_path.to_string_lossy().into_owned(),
                args: vec![
                    dev_entry.to_string_lossy().into_owned(),
                    "server".to_string()
                ]
            }
        );
    }

    #[test]
    fn falls_back_to_bare_name_on_path() {
        let dir = tmp();
        let exec_path = dir.join("climon");
        assert_eq!(
            resolve_server_invocation(
                &v(&["server"]),
                &HashMap::new(),
                exec_path.to_str().unwrap(),
                None,
                "linux"
            ),
            ServerInvocation {
                file: "climon-server".to_string(),
                args: v(&["server"])
            }
        );
    }

    #[test]
    fn resolve_server_env_passes_client_bin() {
        let env = env_with(&[("PATH", "/usr/bin")]);
        let out = resolve_server_env(&env, "/opt/climon/bin/climon", None);
        assert_eq!(
            out.get("CLIMON_CLIENT_BIN").unwrap(),
            "/opt/climon/bin/climon"
        );
    }

    #[test]
    fn resolve_server_env_does_not_overwrite_override() {
        let env = env_with(&[("CLIMON_CLIENT_BIN", "/custom/climon")]);
        let out = resolve_server_env(&env, "/opt/climon/bin/climon", None);
        assert_eq!(out.get("CLIMON_CLIENT_BIN").unwrap(), "/custom/climon");
    }

    #[test]
    fn resolve_server_env_skips_bun_runtime_in_source_mode() {
        let env = env_with(&[("PATH", "/usr/bin")]);
        let out = resolve_server_env(&env, "/usr/bin/bun", Some("/repo/src/server.ts"));
        assert!(!out.contains_key("CLIMON_CLIENT_BIN"));
    }

    #[test]
    fn resolve_server_bundle_finds_sibling() {
        let dir = tmp();
        let bundle = dir.join("climon-beta");
        std::fs::write(&bundle, "bundle-content").unwrap();
        let exec_path = dir.join("climon");
        assert_eq!(
            resolve_server_bundle(&HashMap::new(), exec_path.to_str().unwrap()),
            Some(bundle.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn resolve_server_bundle_honors_override() {
        let dir = tmp();
        let bundle = dir.join("custom-server");
        std::fs::write(&bundle, "encrypted-content").unwrap();
        let env = env_with(&[("CLIMON_SERVER_BUNDLE", bundle.to_str().unwrap())]);
        assert_eq!(
            resolve_server_bundle(&env, "/some/other/path/climon"),
            Some(bundle.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn resolve_server_bundle_none_when_missing() {
        let dir = tmp();
        let exec_path = dir.join("climon");
        assert_eq!(
            resolve_server_bundle(&HashMap::new(), exec_path.to_str().unwrap()),
            None
        );
    }

    #[test]
    fn delegate_returns_127_when_server_missing() {
        let env = env_with(&[("CLIMON_SERVER_BIN", "/nonexistent/climon-server-xyz")]);
        assert_eq!(
            delegate_to_server(&v(&["server"]), &env, "/usr/bin/climon"),
            127
        );
    }
}
