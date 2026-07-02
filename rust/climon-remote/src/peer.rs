//! Cross-OS (WSL <-> Windows) discovery helpers. 1:1 port of `src/remote/peer.ts`.
//!
//! Each side keeps its own `CLIMON_HOME` and reads the peer's small JSON beacons
//! over the shared mount; nothing here crosses a socket or shares a home.
//! External-command and filesystem reads are injectable so the logic is unit
//! testable without a real WSL/Windows environment.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// Process environment as a map (mirrors the injected `NodeJS.ProcessEnv` in the
/// TS tests).
pub type Env = HashMap<String, String>;

/// Runs a command and returns trimmed stdout, or `None` on any failure (mirrors
/// the TS `RunCommand` which throws). Default implementation shells out.
pub fn default_run(file: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(file);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: peer discovery shells out to console tools
        // (wsl.exe, wslpath, ...) on every cycle; without this they flash a window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn env_str<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

/// True when this process runs inside a WSL distribution. Mirrors `isWsl`.
/// `read_proc_version` is injectable; it defaults to reading `/proc/version`.
pub fn is_wsl(env: &Env) -> bool {
    is_wsl_with(env, |p| std::fs::read_to_string(p).ok())
}

pub fn is_wsl_with(env: &Env, read: impl Fn(&str) -> Option<String>) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    if env_str(env, "WSL_DISTRO_NAME").is_some() {
        return true;
    }
    match read("/proc/version") {
        Some(version) => {
            let lower = version.to_lowercase();
            lower.contains("microsoft") || lower.contains("wsl")
        }
        None => false,
    }
}

/// Detects the Windows-side `CLIMON_HOME` as seen from inside WSL. Resolves
/// `%USERPROFILE%` via `cmd.exe` and translates it with `wslpath`. Returns the
/// path only when it already exists. Mirrors `detectWindowsClimonHome`.
pub fn detect_windows_climon_home(
    run: impl Fn(&str, &[&str]) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Option<String> {
    let profile = run("cmd.exe", &["/c", "echo %USERPROFILE%"])?;
    let profile = profile.trim();
    if profile.is_empty() || profile.contains("%USERPROFILE%") {
        return None;
    }
    let mnt = run("wslpath", &["-u", profile])?;
    let mnt = mnt.trim();
    if mnt.is_empty() {
        return None;
    }
    let home = Path::new(mnt).join(".climon");
    if exists(&home) {
        Some(home.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Builds the WSL-side `CLIMON_HOME` as a Windows UNC path. Mirrors `wslHomeUncPath`.
pub fn wsl_home_unc_path(env: &Env) -> Option<String> {
    let distro = env_str(env, "WSL_DISTRO_NAME")?;
    let home = env_str(env, "HOME")
        .map(|s| s.to_string())
        .or_else(|| env_str(env, "USER").map(|u| format!("/home/{u}")))?;
    let tail = format!("{home}/.climon").replace('/', "\\");
    Some(format!("\\\\wsl.localhost\\{distro}{tail}"))
}

/// Parses the WSL2 default-route gateway IP from `/proc/net/route`. Mirrors
/// `wslDefaultGatewayIp`. `read` is injectable.
pub fn wsl_default_gateway_ip(read: impl Fn(&str) -> Option<String>) -> Option<String> {
    let table = read("/proc/net/route")?;
    for line in table.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let destination = cols[1];
        let hex = cols[2];
        if destination != "00000000" {
            continue;
        }
        if hex.len() != 8 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        // Little-endian hex (e.g. "0100A8C0" -> 192.168.0.1).
        let octet = |s: &str| u8::from_str_radix(s, 16).ok();
        let (a, b, c, d) = (
            octet(&hex[6..8])?,
            octet(&hex[4..6])?,
            octet(&hex[2..4])?,
            octet(&hex[0..2])?,
        );
        return Some(format!("{a}.{b}.{c}.{d}"));
    }
    None
}

/// Ordered list of hosts to try when reaching a dashboard on the peer OS.
/// Mirrors `peerHostCandidates`.
pub fn peer_host_candidates(env: &Env) -> Vec<String> {
    let mut candidates = vec!["localhost".to_string()];
    if is_wsl(env) {
        if let Some(gateway) = wsl_default_gateway_ip(|p| std::fs::read_to_string(p).ok()) {
            if !candidates.contains(&gateway) {
                candidates.push(gateway);
            }
        }
    }
    candidates
}

/// Human label for the peer OS. Mirrors `peerOsLabel`.
pub fn peer_os_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "WSL"
    } else {
        "Windows"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_home_unc_path_builds_a_windows_unc_path() {
        let env: Env = [
            ("WSL_DISTRO_NAME".to_string(), "Ubuntu".to_string()),
            ("HOME".to_string(), "/home/ada".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            wsl_home_unc_path(&env).as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\ada\\.climon")
        );
    }

    #[test]
    fn wsl_home_unc_path_returns_none_without_a_distro_name() {
        let env: Env = [("HOME".to_string(), "/home/ada".to_string())]
            .into_iter()
            .collect();
        assert_eq!(wsl_home_unc_path(&env), None);
    }

    #[test]
    fn wsl_default_gateway_ip_parses_the_little_endian_default_route() {
        let table = [
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask",
            "eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000",
            "eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF",
        ]
        .join("\n");
        assert_eq!(
            wsl_default_gateway_ip(|_| Some(table.clone())).as_deref(),
            Some("192.168.0.1")
        );
    }

    #[test]
    fn detect_windows_climon_home_resolves_and_translates_the_windows_profile() {
        // Build a real temp dir so the existence check passes.
        let win_home = std::env::temp_dir().join(format!("climon-peer-{}", std::process::id()));
        std::fs::create_dir_all(win_home.join(".climon")).unwrap();
        let win_home_str = win_home.to_string_lossy().into_owned();
        let run = |file: &str, _args: &[&str]| -> Option<String> {
            match file {
                "cmd.exe" => Some("C:\\Users\\ada\r\n".to_string()),
                "wslpath" => Some(win_home_str.clone()),
                _ => None,
            }
        };
        let expected = win_home.join(".climon");
        let got = detect_windows_climon_home(run, |p| p == expected);
        assert_eq!(got.as_deref(), Some(expected.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&win_home).ok();
    }

    #[test]
    fn detect_windows_climon_home_returns_none_when_the_home_does_not_exist() {
        let run = |file: &str, _args: &[&str]| -> Option<String> {
            if file == "cmd.exe" {
                Some("C:\\Users\\ada".to_string())
            } else {
                Some("/mnt/c/Users/ada".to_string())
            }
        };
        assert_eq!(detect_windows_climon_home(run, |_| false), None);
    }

    #[test]
    fn peer_host_candidates_always_includes_localhost() {
        assert!(peer_host_candidates(&Env::new()).contains(&"localhost".to_string()));
    }
}
