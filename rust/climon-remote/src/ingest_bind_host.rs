//! Resolves the host the ingest binds so the peer OS can reach it. 1:1 port of
//! `src/remote/ingest-bind-host.ts`.
//!
//! The interface enumerator is injectable; the default best-effort enumerator
//! returns the system IPv4 interfaces on unix (via `getifaddrs`) and an empty
//! list on Windows. The Windows-hosted `vEthernet (WSL)` bind path is therefore
//! exercised only through injected interfaces in tests (see the divergence note
//! in the Phase-9 sub-plan); the Rust client's primary role is the uplink.

use std::path::Path;

use climon_config::config::{resolve_config_setting, Env as ConfigEnv};

use crate::peer::{is_wsl, Env};

const LOOPBACK: &str = "127.0.0.1";

/// A single network-interface address (mirrors the fields of `os.NetworkInterfaceInfo`
/// used by the TS resolver).
#[derive(Debug, Clone)]
pub struct IfaceAddr {
    pub name: String,
    pub address: String,
    /// True when `family === "IPv4"`.
    pub ipv4: bool,
    pub internal: bool,
}

/// Best-effort system interface enumeration. Returns IPv4 addresses on unix and
/// an empty list on other platforms.
pub fn system_interfaces() -> Vec<IfaceAddr> {
    #[cfg(unix)]
    {
        unix_interfaces()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

#[cfg(unix)]
fn unix_interfaces() -> Vec<IfaceAddr> {
    use std::ffi::CStr;
    let mut out = Vec::new();
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return out;
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;
            if ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
                continue;
            }
            let family = (*ifa.ifa_addr).sa_family as i32;
            if family != libc::AF_INET {
                continue;
            }
            let name = CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
            let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
            let octets = u32::from_be(sin.sin_addr.s_addr).to_be_bytes();
            let address = format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]);
            let internal = (ifa.ifa_flags as i32 & libc::IFF_LOOPBACK) != 0;
            out.push(IfaceAddr {
                name,
                address,
                ipv4: true,
                internal,
            });
        }
        libc::freeifaddrs(ifap);
    }
    out
}

/// IPv4 address of the Windows-side `vEthernet (WSL)` adapter, matched
/// case-insensitively on "WSL" (excludes "vEthernet (Default Switch)"). Mirrors
/// `findWslVEthernetIPv4`.
pub fn find_wsl_vethernet_ipv4(ifaces: &[IfaceAddr]) -> Option<String> {
    for addr in ifaces {
        if !addr.name.to_lowercase().contains("wsl") {
            continue;
        }
        if addr.ipv4 && !addr.internal && !addr.address.is_empty() {
            return Some(addr.address.clone());
        }
    }
    None
}

/// Injectable dependencies for [`resolve_ingest_bind_host`].
pub struct ResolveIngestBindHostDeps<'a> {
    pub interfaces: InterfacesFn<'a>,
    pub is_wsl: IsWslFn<'a>,
    pub configured_host: ConfiguredHostFn<'a>,
}

/// Enumerates the system network interfaces.
pub type InterfacesFn<'a> = Box<dyn Fn() -> Vec<IfaceAddr> + 'a>;
/// Reports whether this process runs inside WSL.
pub type IsWslFn<'a> = Box<dyn Fn(&Env) -> bool + 'a>;
/// Resolves the optional `remote.ingestHost` override.
pub type ConfiguredHostFn<'a> = Box<dyn Fn(&Env) -> Option<String> + 'a>;

impl Default for ResolveIngestBindHostDeps<'_> {
    fn default() -> Self {
        ResolveIngestBindHostDeps {
            interfaces: Box::new(system_interfaces),
            is_wsl: Box::new(is_wsl),
            configured_host: Box::new(|_env| None),
        }
    }
}

/// Resolves the host the ingest binds so the peer OS can reach it. Mirrors
/// `resolveIngestBindHost`. Order: explicit override → WSL→loopback →
/// Windows→vEthernet(WSL) IPv4 → loopback fallback.
pub fn resolve_ingest_bind_host(env: &Env, deps: &ResolveIngestBindHostDeps) -> String {
    if let Some(override_host) = (deps.configured_host)(env) {
        if !override_host.is_empty() {
            return override_host;
        }
    }
    if (deps.is_wsl)(env) {
        return LOOPBACK.to_string();
    }
    if let Some(vethernet) = find_wsl_vethernet_ipv4(&(deps.interfaces)()) {
        return vethernet;
    }
    LOOPBACK.to_string()
}

/// The default `remote.ingestHost` resolver used by callers that wire a real
/// config env. Mirrors `defaultConfiguredHost`.
pub fn default_configured_host(config_env: &ConfigEnv, cwd: &Path) -> Option<String> {
    match resolve_config_setting("remote.ingestHost", config_env, cwd) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl_adapter() -> Vec<IfaceAddr> {
        vec![
            IfaceAddr {
                name: "vEthernet (WSL (Hyper-V firewall))".into(),
                address: "172.30.192.1".into(),
                ipv4: true,
                internal: false,
            },
            IfaceAddr {
                name: "vEthernet (Default Switch)".into(),
                address: "172.20.0.1".into(),
                ipv4: true,
                internal: false,
            },
            IfaceAddr {
                name: "Loopback Pseudo-Interface 1".into(),
                address: "127.0.0.1".into(),
                ipv4: true,
                internal: true,
            },
        ]
    }

    fn no_wsl_adapter() -> Vec<IfaceAddr> {
        vec![IfaceAddr {
            name: "Ethernet".into(),
            address: "10.0.0.5".into(),
            ipv4: true,
            internal: false,
        }]
    }

    #[test]
    fn finds_the_wsl_vethernet_ipv4_not_the_default_switch() {
        assert_eq!(
            find_wsl_vethernet_ipv4(&wsl_adapter()).as_deref(),
            Some("172.30.192.1")
        );
    }

    #[test]
    fn returns_none_when_no_wsl_adapter_exists() {
        assert_eq!(find_wsl_vethernet_ipv4(&no_wsl_adapter()), None);
    }

    fn deps(
        configured: Option<&'static str>,
        wsl: bool,
        ifaces: fn() -> Vec<IfaceAddr>,
    ) -> ResolveIngestBindHostDeps<'static> {
        ResolveIngestBindHostDeps {
            interfaces: Box::new(ifaces),
            is_wsl: Box::new(move |_| wsl),
            configured_host: Box::new(move |_| configured.map(|s| s.to_string())),
        }
    }

    #[test]
    fn an_explicit_configured_host_wins_over_everything() {
        let env = Env::new();
        assert_eq!(
            resolve_ingest_bind_host(&env, &deps(Some("10.1.2.3"), false, wsl_adapter)),
            "10.1.2.3"
        );
    }

    #[test]
    fn wsl_host_binds_loopback() {
        let env = Env::new();
        assert_eq!(
            resolve_ingest_bind_host(&env, &deps(None, true, wsl_adapter)),
            "127.0.0.1"
        );
    }

    #[test]
    fn windows_host_binds_the_vethernet_wsl_ipv4() {
        let env = Env::new();
        assert_eq!(
            resolve_ingest_bind_host(&env, &deps(None, false, wsl_adapter)),
            "172.30.192.1"
        );
    }

    #[test]
    fn falls_back_to_loopback_when_no_wsl_adapter_is_found() {
        let env = Env::new();
        assert_eq!(
            resolve_ingest_bind_host(&env, &deps(None, false, no_wsl_adapter)),
            "127.0.0.1"
        );
    }
}
