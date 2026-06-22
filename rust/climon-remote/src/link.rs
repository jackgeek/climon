//! WSL <-> Windows linking. Port of `src/remote/link.ts`.

use std::path::Path;

use climon_config::config::{
    get_climon_home, resolve_config_setting, write_config_setting, Env as ConfigEnv, WriteScope,
};

use crate::peer::{
    default_run, detect_windows_climon_home, is_wsl, wsl_home_unc_path, Env as PeerEnv,
};

/// Options for [`link_peer`]. Mirrors `LinkOptions`.
#[derive(Default, Clone)]
pub struct LinkOptions {
    /// Explicit peer `CLIMON_HOME`; auto-detected from WSL when omitted.
    pub peer_home: Option<String>,
    /// Write `feature.wslBridge = enabled` into the local config (and the peer
    /// config when the reverse pointer is written).
    pub enable_wsl_bridge: bool,
}

/// Result of [`link_peer`]. Mirrors `LinkResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkResult {
    pub local_home: String,
    pub peer_home: String,
    /// True when the reverse pointer was also written into the peer's config.
    pub reverse_linked: bool,
    /// True when `feature.wslBridge` was enabled in the local config.
    pub wsl_bridge_local: bool,
    /// True when `feature.wslBridge` was enabled in the peer config.
    pub wsl_bridge_peer: bool,
}

/// Injectable dependencies. Mirrors `LinkDeps` (config writers are not injected;
/// the real config crate functions are used directly).
pub struct LinkDeps<'a> {
    pub is_wsl: Box<dyn Fn() -> bool + 'a>,
    pub detect_windows_climon_home: Box<dyn Fn() -> Option<String> + 'a>,
    pub wsl_home_unc_path: Box<dyn Fn() -> Option<String> + 'a>,
}

impl Default for LinkDeps<'_> {
    fn default() -> Self {
        Self {
            is_wsl: Box::new(|| is_wsl(&process_env())),
            detect_windows_climon_home: Box::new(|| {
                detect_windows_climon_home(default_run, |p| p.exists())
            }),
            wsl_home_unc_path: Box::new(|| wsl_home_unc_path(&process_env())),
        }
    }
}

fn process_env() -> PeerEnv {
    std::env::vars().collect()
}

fn as_string(value: &serde_json::Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// Links this machine's climon to the peer OS's climon. Mirrors `linkPeer`.
pub fn link_peer(
    options: LinkOptions,
    env: &ConfigEnv,
    cwd: &Path,
    deps: &LinkDeps<'_>,
) -> Result<LinkResult, String> {
    let on_wsl = (deps.is_wsl)();

    let peer_home = options.peer_home.or_else(|| {
        if on_wsl {
            (deps.detect_windows_climon_home)()
        } else {
            None
        }
    });
    let peer_home = match peer_home {
        Some(home) => home,
        None => {
            return Err(if on_wsl {
                "Could not detect the Windows CLIMON_HOME. Pass it explicitly: climon link --peer-home /mnt/c/Users/<you>/.climon".to_string()
            } else {
                "Provide the peer CLIMON_HOME: climon link --peer-home <path>".to_string()
            });
        }
    };

    let local_home = get_climon_home(env).to_string_lossy().into_owned();
    write_config_setting("remote.peerHome", &peer_home, WriteScope::Global, env, cwd)?;

    let mut wsl_bridge_local = false;
    if options.enable_wsl_bridge {
        write_config_setting("feature.wslBridge", "enabled", WriteScope::Global, env, cwd)?;
        wsl_bridge_local = true;
    }

    let mut reverse_linked = false;
    let mut wsl_bridge_peer = false;
    if on_wsl {
        if let Some(reverse_pointer) = (deps.wsl_home_unc_path)() {
            // Write into the peer (Windows) config by pointing CLIMON_HOME at it.
            let peer_env = ConfigEnv::new(Some(&peer_home), &peer_home);
            write_config_setting(
                "remote.peerHome",
                &reverse_pointer,
                WriteScope::Global,
                &peer_env,
                cwd,
            )?;
            reverse_linked = true;
            if options.enable_wsl_bridge {
                write_config_setting(
                    "feature.wslBridge",
                    "enabled",
                    WriteScope::Global,
                    &peer_env,
                    cwd,
                )?;
                wsl_bridge_peer = true;
            }
        }
    }

    Ok(LinkResult {
        local_home,
        peer_home,
        reverse_linked,
        wsl_bridge_local,
        wsl_bridge_peer,
    })
}

/// Lazily auto-links on the first `climon` run inside WSL. Mirrors `maybeAutoLink`.
pub fn maybe_auto_link(
    env: &ConfigEnv,
    cwd: &Path,
    out: &mut dyn FnMut(&str),
    deps: &LinkDeps<'_>,
) {
    if resolve_config_setting("remote.autoLink", env, cwd) == Some(serde_json::Value::Bool(false)) {
        return;
    }
    if resolve_config_setting("remote.peerHome", env, cwd)
        .as_ref()
        .and_then(as_string)
        .is_some()
    {
        return;
    }
    if !(deps.is_wsl)() {
        return;
    }
    let win_home = match (deps.detect_windows_climon_home)() {
        Some(home) => home,
        None => return,
    };

    out(&format!(
        "climon: detected a Windows climon at {win_home}; attempting to auto-link so sessions appear on the Windows dashboard.\n"
    ));
    out("climon: to prevent this, run: climon config remote.autoLink false\n");
    match link_peer(
        LinkOptions {
            peer_home: Some(win_home),
            enable_wsl_bridge: false,
        },
        env,
        cwd,
        deps,
    ) {
        Ok(result) => {
            let suffix = if result.reverse_linked {
                " on both sides"
            } else {
                " (WSL side only)"
            };
            out(&format!(
                "climon: auto-link successful — WSL<->Windows discovery configured{suffix}. The WSL bridge is NOT enabled; turn it on with: climon config feature.wslBridge enabled (or run: climon link --wsl-bridge).\n"
            ));
        }
        Err(error) => {
            out(&format!(
                "climon: auto-link failed: {error}. Continuing without it. Set it manually with: climon config remote.peerHome <path>, or disable with: climon config remote.autoLink false\n"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-link-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_for(home: &Path) -> ConfigEnv {
        ConfigEnv::new(Some(home.to_str().unwrap()), home.to_path_buf())
    }

    #[test]
    fn writes_local_pointer_and_skips_reverse_when_not_on_wsl() {
        let root = tmp("nowsl");
        let home = root.join("local");
        let peer = root.join("peer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let deps = LinkDeps {
            is_wsl: Box::new(|| false),
            detect_windows_climon_home: Box::new(|| None),
            wsl_home_unc_path: Box::new(|| None),
        };
        let result = link_peer(
            LinkOptions {
                peer_home: Some(peer.to_string_lossy().into_owned()),
                enable_wsl_bridge: false,
            },
            &env_for(&home),
            &root,
            &deps,
        )
        .unwrap();
        assert!(!result.reverse_linked);
        assert_eq!(result.peer_home, peer.to_string_lossy());
        let config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(config.contains("\"peerHome\""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn writes_both_directions_when_run_from_wsl() {
        let root = tmp("wsl");
        let home = root.join("wsl");
        let peer = root.join("win");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let deps = LinkDeps {
            is_wsl: Box::new(|| true),
            detect_windows_climon_home: Box::new(|| None),
            wsl_home_unc_path: Box::new(|| {
                Some("\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon".to_string())
            }),
        };
        let result = link_peer(
            LinkOptions {
                peer_home: Some(peer.to_string_lossy().into_owned()),
                enable_wsl_bridge: false,
            },
            &env_for(&home),
            &root,
            &deps,
        )
        .unwrap();
        assert!(result.reverse_linked);
        let home_config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(home_config.contains("\"peerHome\""));
        let peer_config = std::fs::read_to_string(peer.join("config.jsonc")).unwrap();
        assert!(peer_config.contains("wsl.localhost"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn enables_wsl_bridge_on_both_sides_when_requested_from_wsl() {
        let root = tmp("wslbridge");
        let home = root.join("wsl");
        let peer = root.join("win");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let deps = LinkDeps {
            is_wsl: Box::new(|| true),
            detect_windows_climon_home: Box::new(|| None),
            wsl_home_unc_path: Box::new(|| {
                Some("\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon".to_string())
            }),
        };
        let result = link_peer(
            LinkOptions {
                peer_home: Some(peer.to_string_lossy().into_owned()),
                enable_wsl_bridge: true,
            },
            &env_for(&home),
            &root,
            &deps,
        )
        .unwrap();
        assert!(result.wsl_bridge_local);
        assert!(result.wsl_bridge_peer);
        let home_config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(home_config.contains("\"wslBridge\": \"enabled\""));
        let peer_config = std::fs::read_to_string(peer.join("config.jsonc")).unwrap();
        assert!(peer_config.contains("\"wslBridge\": \"enabled\""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn throws_when_peer_home_cannot_be_determined() {
        let root = tmp("nopeer");
        let home = root.join("nope");
        std::fs::create_dir_all(&home).unwrap();
        let deps = LinkDeps {
            is_wsl: Box::new(|| true),
            detect_windows_climon_home: Box::new(|| None),
            wsl_home_unc_path: Box::new(|| None),
        };
        let err = link_peer(LinkOptions::default(), &env_for(&home), &root, &deps).unwrap_err();
        assert!(err.contains("Windows CLIMON_HOME"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn auto_link_announces_advises_links_and_confirms() {
        let root = tmp("auto");
        let home = root.join("auto");
        let peer = root.join("autopeer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        let peer_str = peer.to_string_lossy().into_owned();
        let mut lines: Vec<String> = Vec::new();
        {
            let deps = LinkDeps {
                is_wsl: Box::new(|| true),
                detect_windows_climon_home: Box::new(move || Some(peer_str.clone())),
                wsl_home_unc_path: Box::new(|| {
                    Some("\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon".to_string())
                }),
            };
            let mut out = |t: &str| lines.push(t.to_string());
            maybe_auto_link(&env_for(&home), &home, &mut out, &deps);
        }
        let text = lines.join("");
        assert!(text.contains("attempting to auto-link"));
        assert!(text.contains("remote.autoLink false"));
        assert!(text.contains("auto-link successful"));
        assert!(text.contains("discovery configured"));
        assert!(text.contains("WSL bridge is NOT enabled"));
        assert!(text.contains("climon config feature.wslBridge enabled"));
        let config = std::fs::read_to_string(home.join("config.jsonc")).unwrap();
        assert!(config.contains("\"peerHome\""));
        assert!(!config.contains("\"wslBridge\""));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn auto_link_silent_when_not_on_wsl() {
        let root = tmp("notwsl");
        let home = root.join("notwsl");
        std::fs::create_dir_all(&home).unwrap();
        let mut lines: Vec<String> = Vec::new();
        {
            let deps = LinkDeps {
                is_wsl: Box::new(|| false),
                detect_windows_climon_home: Box::new(|| Some("/p".to_string())),
                wsl_home_unc_path: Box::new(|| None),
            };
            let mut out = |t: &str| lines.push(t.to_string());
            maybe_auto_link(&env_for(&home), &home, &mut out, &deps);
        }
        assert!(lines.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn auto_link_silent_when_already_linked() {
        let root = tmp("linked");
        let home = root.join("linked");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.json"),
            serde_json::json!({"remote": {"peerHome": "/mnt/c/x"}}).to_string(),
        )
        .unwrap();
        let mut lines: Vec<String> = Vec::new();
        {
            let deps = LinkDeps {
                is_wsl: Box::new(|| true),
                detect_windows_climon_home: Box::new(|| Some("/p".to_string())),
                wsl_home_unc_path: Box::new(|| None),
            };
            let mut out = |t: &str| lines.push(t.to_string());
            maybe_auto_link(&env_for(&home), &home, &mut out, &deps);
        }
        assert!(lines.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn auto_link_silent_when_disabled() {
        let root = tmp("disabled");
        let home = root.join("disabled");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("config.json"),
            serde_json::json!({"remote": {"autoLink": false}}).to_string(),
        )
        .unwrap();
        let mut lines: Vec<String> = Vec::new();
        {
            let deps = LinkDeps {
                is_wsl: Box::new(|| true),
                detect_windows_climon_home: Box::new(|| Some("/p".to_string())),
                wsl_home_unc_path: Box::new(|| None),
            };
            let mut out = |t: &str| lines.push(t.to_string());
            maybe_auto_link(&env_for(&home), &root, &mut out, &deps);
        }
        assert!(lines.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
