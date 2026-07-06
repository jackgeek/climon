//! Computes the devbox uplink target set: explicit config unioned with
//! discovered live hosts, excluding this machine's own tunnel.

use crate::discovery::DiscoveredHost;
use crate::ingest_tunnel_id::derive_ingest_tunnel_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UplinkTargetSpec {
    Direct { host: String, port: u16 },
    Tunnel { tunnel_id: String },
}

pub struct ComputeTargetsInput {
    pub discover_enabled: bool,
    pub own_install_id: Option<String>,
    pub explicit_host: Option<(String, u16)>,
    pub explicit_tunnel_id: Option<String>,
    pub discovered: Vec<DiscoveredHost>,
}

/// Explicit config unioned with discovered live hosts, excluding our own tunnel,
/// deduped by tunnel id. Explicit targets come first; discovered are sorted by id.
pub fn compute_targets(input: ComputeTargetsInput) -> Vec<UplinkTargetSpec> {
    let mut out: Vec<UplinkTargetSpec> = Vec::new();
    let mut seen_tunnels: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some((host, port)) = input.explicit_host {
        out.push(UplinkTargetSpec::Direct { host, port });
    }
    if let Some(id) = input.explicit_tunnel_id {
        if seen_tunnels.insert(id.clone()) {
            out.push(UplinkTargetSpec::Tunnel { tunnel_id: id });
        }
    }

    if input.discover_enabled {
        let own_prefix = input.own_install_id.as_deref().map(derive_ingest_tunnel_id);
        let mut discovered = input.discovered;
        discovered.sort_by(|a, b| a.tunnel_id.cmp(&b.tunnel_id));
        for host in discovered {
            if let Some(prefix) = &own_prefix {
                if host.tunnel_id == *prefix || host.tunnel_id.starts_with(&format!("{prefix}.")) {
                    continue;
                }
            }
            if seen_tunnels.insert(host.tunnel_id.clone()) {
                out.push(UplinkTargetSpec::Tunnel {
                    tunnel_id: host.tunnel_id,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::DiscoveredHost;

    fn host(id: &str) -> DiscoveredHost {
        DiscoveredHost {
            tunnel_id: id.into(),
            host_connections: 1,
            hostname: None,
            client_id: None,
        }
    }

    #[test]
    fn unions_explicit_and_discovered_and_dedups() {
        let out = compute_targets(ComputeTargetsInput {
            discover_enabled: true,
            own_install_id: None,
            explicit_host: None,
            explicit_tunnel_id: Some("climon-ingest-explicit0000000000000.eun1".into()),
            discovered: vec![
                host("climon-ingest-aaaa0000000000000000.eun1"),
                host("climon-ingest-explicit0000000000000.eun1"),
            ],
        });
        let ids: Vec<String> = out
            .iter()
            .filter_map(|t| match t {
                UplinkTargetSpec::Tunnel { tunnel_id } => Some(tunnel_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                "climon-ingest-explicit0000000000000.eun1".to_string(),
                "climon-ingest-aaaa0000000000000000.eun1".to_string(),
            ]
        );
    }

    #[test]
    fn excludes_own_tunnel() {
        let install = "00000000-0000-4000-8000-000000000000";
        let own = crate::ingest_tunnel_id::derive_ingest_tunnel_id(install);
        let out = compute_targets(ComputeTargetsInput {
            discover_enabled: true,
            own_install_id: Some(install.into()),
            explicit_host: None,
            explicit_tunnel_id: None,
            discovered: vec![
                host(&format!("{own}.eun1")),
                host("climon-ingest-other0000000000000000.eun1"),
            ],
        });
        let ids: Vec<String> = out
            .iter()
            .filter_map(|t| match t {
                UplinkTargetSpec::Tunnel { tunnel_id } => Some(tunnel_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec!["climon-ingest-other0000000000000000.eun1".to_string()]
        );
    }

    #[test]
    fn discovery_disabled_keeps_only_explicit() {
        let out = compute_targets(ComputeTargetsInput {
            discover_enabled: false,
            own_install_id: None,
            explicit_host: Some(("1.2.3.4".into(), 9000)),
            explicit_tunnel_id: None,
            discovered: vec![host("climon-ingest-aaaa0000000000000000.eun1")],
        });
        assert_eq!(
            out,
            vec![UplinkTargetSpec::Direct {
                host: "1.2.3.4".into(),
                port: 9000
            }]
        );
    }
}
