//! Dashboard discovery for `climon` to connect/uplink to. Port of
//! `src/remote/discovery.ts`.
//!
//! Discovery is synchronous here (blocking fs + a short blocking TCP probe);
//! callers in async contexts run it via `spawn_blocking`. Network/liveness
//! probes are injectable for tests.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use climon_config::config::{get_climon_home, resolve_config_setting, Env as ConfigEnv};
use climon_store::server_state::read_server_state_from_dir;
use serde_json::Value;

use crate::devtunnel::{DevtunnelFailure, DevtunnelGateway};
use crate::ingest_state::{read_ingest_state_from_dir, resolve_ingest_port};
use crate::peer::{peer_host_candidates, Env as PeerEnv};
use crate::process::is_process_alive;

const PROBE_TIMEOUT_MS: u64 = 1500;

/// A discovered dashboard target. Mirrors `DashboardTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardTarget {
    /// Whether the dashboard runs on this machine's home or the peer's.
    pub location: DashboardLocation,
    /// Reachable host for the ingest (and, locally, the dashboard HTTP server).
    pub host: String,
    /// Dashboard HTTP port.
    pub port: u16,
    /// Live ingest port for the uplink.
    pub ingest: Option<u16>,
    /// Dashboard URL to open in a browser.
    pub url: String,
}

/// Where a discovered dashboard runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardLocation {
    Local,
    Peer,
}

/// True when the CLIMON_DISABLE_DEVTUNNEL env flag disables all devtunnel interaction.
pub fn devtunnel_disabled() -> bool {
    matches!(
        std::env::var("CLIMON_DISABLE_DEVTUNNEL").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// A live climon ingest tunnel discovered on the authenticated user's account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredHost {
    pub tunnel_id: String,
    pub host_connections: u64,
    pub hostname: Option<String>,
    pub client_id: Option<String>,
}

/// Parses `devtunnel list --json` output, keeping only live hosts
/// (`hostConnections >= 1`) and best-effort-parsing the JSON description.
pub fn parse_devtunnel_list(json: &str) -> Vec<DiscoveredHost> {
    let root: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    parse_devtunnel_list_value(&root)
}

/// Parses an already-decoded `devtunnel list --json` value into live hosts.
/// The gateway returns parsed JSON, so this avoids a re-serialize round trip.
fn parse_devtunnel_list_value(root: &Value) -> Vec<DiscoveredHost> {
    let tunnels = match root.get("tunnels").and_then(|t| t.as_array()) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for t in tunnels {
        let host_connections = t
            .get("hostConnections")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if host_connections < 1 {
            continue;
        }
        let Some(tunnel_id) = t.get("tunnelId").and_then(|v| v.as_str()) else {
            continue;
        };
        let (hostname, client_id) = t
            .get("description")
            .and_then(|v| v.as_str())
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .map(|d| {
                (
                    d.get("hostname")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    d.get("clientId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                )
            })
            .unwrap_or((None, None));
        out.push(DiscoveredHost {
            tunnel_id: tunnel_id.to_string(),
            host_connections,
            hostname,
            client_id,
        });
    }
    out
}

/// Runs `devtunnel list --labels climon-ingest --json` through the shared
/// [`DevtunnelGateway`] and returns the live hosts.
///
/// A successful list — including an empty one — resolves to `Ok(hosts)`; an
/// empty vector means "authenticated, but no live hosts". When devtunnel is
/// disabled via `CLIMON_DISABLE_DEVTUNNEL` the result is `Ok(vec![])` because a
/// disabled tunnel is a deliberate opt-out, not a failure. Every other error
/// (missing CLI, not authenticated, network, …) surfaces as the gateway's typed
/// [`DevtunnelFailure`] so callers can record it instead of collapsing it into
/// "no hosts".
pub async fn list_climon_ingest_tunnels(
    gateway: &DevtunnelGateway,
) -> Result<Vec<DiscoveredHost>, DevtunnelFailure> {
    if devtunnel_disabled() {
        return Ok(Vec::new());
    }
    let value = gateway
        .list_tunnels(&[crate::ingest_tunnel_id::INGEST_TUNNEL_LABEL.to_string()])
        .await?;
    Ok(parse_devtunnel_list_value(&value))
}

/// Probe function for [`DiscoveryDeps`].
pub type ProbeTcpFn<'a> = Box<dyn Fn(&str, u16) -> bool + 'a>;
/// Liveness function for [`DiscoveryDeps`].
pub type IsAliveFn<'a> = Box<dyn Fn(u32) -> bool + 'a>;

/// Injectable dependencies for [`discover_dashboard`]. Mirrors the TS `deps`.
pub struct DiscoveryDeps<'a> {
    /// Raw TCP liveness probe of a peer ingest.
    pub probe_tcp: ProbeTcpFn<'a>,
    /// Process liveness check.
    pub is_alive: IsAliveFn<'a>,
}

impl Default for DiscoveryDeps<'_> {
    fn default() -> Self {
        Self {
            probe_tcp: Box::new(probe_tcp_default),
            is_alive: Box::new(is_process_alive),
        }
    }
}

/// Raw TCP liveness probe of the peer ingest (it speaks binary mux). Mirrors
/// `probeTcpDefault`.
fn probe_tcp_default(host: &str, port: u16) -> bool {
    let addr = match (host, port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(addr) => addr,
            None => return false,
        },
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(PROBE_TIMEOUT_MS)).is_ok()
}

fn as_string(value: &serde_json::Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// Discovers a running dashboard. Mirrors `discoverDashboard`.
pub fn discover_dashboard(
    env: &ConfigEnv,
    cwd: &Path,
    deps: &DiscoveryDeps<'_>,
) -> Option<DashboardTarget> {
    let home = get_climon_home(env);
    let local = read_server_state_from_dir(&home);
    if let Some(local) = &local {
        if (deps.is_alive)(local.pid) {
            let ingest = resolve_ingest_port(env, &deps.is_alive);
            return Some(DashboardTarget {
                location: DashboardLocation::Local,
                host: "127.0.0.1".to_string(),
                port: local.port,
                ingest: Some(ingest),
                url: format!("http://127.0.0.1:{}/", local.port),
            });
        }
    }

    let peer_home =
        resolve_config_setting("remote.peerHome", env, cwd).and_then(|v| as_string(&v))?;
    let peer_ingest = read_ingest_state_from_dir(Path::new(&peer_home))?;

    let override_host =
        resolve_config_setting("remote.peerHost", env, cwd).and_then(|v| as_string(&v));
    let mut candidates: Vec<String> = Vec::new();
    if let Some(host) = &peer_ingest.host {
        candidates.push(host.clone());
    }
    let fallbacks = match &override_host {
        Some(host) => vec![host.clone()],
        None => peer_host_candidates(&process_env()),
    };
    for host in fallbacks {
        if !candidates.contains(&host) {
            candidates.push(host);
        }
    }

    for host in candidates {
        if (deps.probe_tcp)(&host, peer_ingest.port) {
            let peer_server = read_server_state_from_dir(Path::new(&peer_home));
            let dashboard_port = peer_server.map(|s| s.port).unwrap_or(peer_ingest.port);
            return Some(DashboardTarget {
                location: DashboardLocation::Peer,
                host: host.clone(),
                port: dashboard_port,
                ingest: Some(peer_ingest.port),
                url: format!("http://{host}:{dashboard_port}/"),
            });
        }
    }
    None
}

fn process_env() -> PeerEnv {
    std::env::vars().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use climon_store::server_state::{serialize_server_state, ServerState};

    const LIST_JSON: &str = r#"{
      "tunnels": [
        {"tunnelId":"climon-ingest-aaaa000011112222aaaa.eun1","labels":["climon-ingest"],"hostConnections":1,"portCount":1,"description":"{\"app\":\"climon\",\"role\":\"ingest\",\"clientId\":\"boxA\",\"hostname\":\"boxA\",\"version\":\"1.0.0\"}"},
        {"tunnelId":"climon-ingest-bbbb000011112222bbbb.eun1","labels":["climon-ingest"],"hostConnections":0,"portCount":1,"description":""},
        {"tunnelId":"climon-ingest-cccc000011112222cccc.eun1","labels":["climon-ingest"],"hostConnections":2,"portCount":1,"description":"not-json"}
      ]
    }"#;

    #[test]
    fn keeps_only_live_hosts() {
        let hosts = parse_devtunnel_list(LIST_JSON);
        let ids: Vec<&str> = hosts.iter().map(|h| h.tunnel_id.as_str()).collect();
        assert!(ids.contains(&"climon-ingest-aaaa000011112222aaaa.eun1"));
        assert!(ids.contains(&"climon-ingest-cccc000011112222cccc.eun1"));
        assert!(!ids.contains(&"climon-ingest-bbbb000011112222bbbb.eun1"));
        assert_eq!(hosts.len(), 2);
    }

    #[test]
    fn parses_description_when_present_and_tolerates_bad_json() {
        let hosts = parse_devtunnel_list(LIST_JSON);
        let a = hosts
            .iter()
            .find(|h| h.tunnel_id.starts_with("climon-ingest-aaaa"))
            .unwrap();
        assert_eq!(a.hostname.as_deref(), Some("boxA"));
        let c = hosts
            .iter()
            .find(|h| h.tunnel_id.starts_with("climon-ingest-cccc"))
            .unwrap();
        assert_eq!(c.hostname, None);
    }

    #[test]
    fn empty_or_garbage_input_yields_no_hosts() {
        assert!(parse_devtunnel_list("").is_empty());
        assert!(parse_devtunnel_list("{}").is_empty());
        assert!(parse_devtunnel_list(r#"{"tunnels":[]}"#).is_empty());
    }

    fn gateway_with_result(result: crate::devtunnel::RunResult) -> DevtunnelGateway {
        use crate::devtunnel::gateway::{DevtunnelGatewayDeps, Runner};
        use std::sync::Arc;
        let runner: Runner = Arc::new(move |_cmd, _args| {
            let result = result.clone();
            Box::pin(async move { result })
        });
        DevtunnelGateway::with_deps(DevtunnelGatewayDeps {
            runner: Some(runner),
            env: Some(std::collections::HashMap::new()),
            now: Some(Arc::new(|| "2026-07-11T13:00:00.000Z".to_string())),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn list_ingest_tunnels_returns_ok_empty_for_authenticated_empty_list() {
        let gateway = gateway_with_result(crate::devtunnel::RunResult {
            status: 0,
            stdout: r#"{"tunnels":[]}"#.to_string(),
            stderr: String::new(),
            spawn_error: None,
        });
        let hosts = list_climon_ingest_tunnels(&gateway).await.unwrap();
        assert!(hosts.is_empty());
    }

    #[tokio::test]
    async fn list_ingest_tunnels_returns_parsed_hosts() {
        let gateway = gateway_with_result(crate::devtunnel::RunResult {
            status: 0,
            stdout: LIST_JSON.to_string(),
            stderr: String::new(),
            spawn_error: None,
        });
        let hosts = list_climon_ingest_tunnels(&gateway).await.unwrap();
        assert_eq!(hosts.len(), 2);
    }

    #[tokio::test]
    async fn list_ingest_tunnels_surfaces_not_authenticated() {
        use crate::devtunnel::DevtunnelErrorCode;
        let gateway = gateway_with_result(crate::devtunnel::RunResult {
            status: 1,
            stdout: String::new(),
            stderr: "Not logged in".to_string(),
            spawn_error: None,
        });
        let err = list_climon_ingest_tunnels(&gateway).await.unwrap_err();
        assert_eq!(err.code, DevtunnelErrorCode::NotAuthenticated);
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "climon-discovery-{tag}-{}-{}",
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

    fn write_server(home: &Path, state: ServerState) {
        std::fs::write(home.join("server.json"), serialize_server_state(&state)).unwrap();
    }

    fn write_ingest(home: &Path, raw: &str) {
        std::fs::write(home.join("ingest.json"), raw).unwrap();
    }

    #[test]
    fn returns_local_target_when_local_pid_alive() {
        let root = tmp("local-root");
        let home = root.join("local");
        std::fs::create_dir_all(&home).unwrap();
        write_server(
            &home,
            ServerState {
                pid: 999,
                port: 5000,
                ingest: Some(5001),
                started_at: None,
            },
        );
        write_ingest(&home, "{\"pid\":999,\"port\":5001}\n");
        let deps = DiscoveryDeps {
            probe_tcp: Box::new(|_, _| false),
            is_alive: Box::new(|_| true),
        };
        let target = discover_dashboard(&env_for(&home), &root, &deps).unwrap();
        assert_eq!(target.location, DashboardLocation::Local);
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 5000);
        assert_eq!(target.ingest, Some(5001));
        assert_eq!(target.url, "http://127.0.0.1:5000/");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn falls_through_to_peer_validated_by_ingest_beacon_and_probe() {
        let root = tmp("peer-root");
        let home = root.join("client");
        let peer = root.join("peer");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        write_server(
            &peer,
            ServerState {
                pid: 111,
                port: 6000,
                ingest: None,
                started_at: None,
            },
        );
        write_ingest(
            &peer,
            "{\"pid\":222,\"port\":6001,\"host\":\"localhost\"}\n",
        );
        std::fs::write(
            home.join("config.json"),
            serde_json::json!({"remote": {"peerHome": peer.to_str().unwrap(), "peerHost": "localhost"}})
                .to_string(),
        )
        .unwrap();
        let deps = DiscoveryDeps {
            probe_tcp: Box::new(|host, port| host == "localhost" && port == 6001),
            is_alive: Box::new(|_| false),
        };
        let target = discover_dashboard(&env_for(&home), &root, &deps).unwrap();
        assert_eq!(target.location, DashboardLocation::Peer);
        assert_eq!(target.host, "localhost");
        assert_eq!(target.port, 6000);
        assert_eq!(target.ingest, Some(6001));
        assert_eq!(target.url, "http://localhost:6000/");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ignores_peer_ingest_that_is_not_listening() {
        let root = tmp("peer-dead");
        let home = root.join("client2");
        let peer = root.join("peer2");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&peer).unwrap();
        write_server(
            &peer,
            ServerState {
                pid: 111,
                port: 6000,
                ingest: None,
                started_at: None,
            },
        );
        write_ingest(
            &peer,
            "{\"pid\":222,\"port\":6001,\"host\":\"localhost\"}\n",
        );
        std::fs::write(
            home.join("config.json"),
            serde_json::json!({"remote": {"peerHome": peer.to_str().unwrap(), "peerHost": "localhost"}})
                .to_string(),
        )
        .unwrap();
        let deps = DiscoveryDeps {
            probe_tcp: Box::new(|_, _| false),
            is_alive: Box::new(|_| false),
        };
        assert!(discover_dashboard(&env_for(&home), &root, &deps).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn returns_none_when_nothing_discoverable() {
        let root = tmp("empty-root");
        let home = root.join("empty");
        std::fs::create_dir_all(&home).unwrap();
        let deps = DiscoveryDeps {
            probe_tcp: Box::new(|_, _| false),
            is_alive: Box::new(|_| false),
        };
        assert!(discover_dashboard(&env_for(&home), &root, &deps).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolves_shifted_local_ingest_port() {
        let root = tmp("shift-root");
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let pid = std::process::id();
        write_server(
            &home,
            ServerState {
                pid,
                port: 3131,
                ingest: Some(3132),
                started_at: None,
            },
        );
        write_ingest(&home, &format!("{{\"pid\":{pid},\"port\":3140}}\n"));
        let deps = DiscoveryDeps {
            probe_tcp: Box::new(|_, _| false),
            is_alive: Box::new(|_| true),
        };
        let target = discover_dashboard(&env_for(&home), &root, &deps).unwrap();
        assert_eq!(target.location, DashboardLocation::Local);
        assert_eq!(target.ingest, Some(3140));
        std::fs::remove_dir_all(&root).ok();
    }
}
