//! `climon remotes`: reads `ingest-status.json` + `uplink-status.json` and renders
//! both directions of the bridge. Default one-shot; `--watch` redraws; `--json`
//! emits the merged raw status. Pure rendering is split from I/O for testing.

use climon_config::config::Env as ConfigEnv;
use climon_remote::ingest_status::{
    is_connection_stale, is_ingest_status_stale_now, read_ingest_status, IngestStatus,
};
use climon_remote::uplink_status::{is_uplink_status_stale_now, read_uplink_status, UplinkStatus};
use serde::Serialize;

/// The merged view the CLI renders (and `--json` emits).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotesView {
    pub uplink: Option<UplinkStatus>,
    pub uplink_stale: bool,
    pub ingest: Option<IngestStatus>,
    pub ingest_stale: bool,
    pub remotes_enabled: bool,
}

/// Builds the merged view from the two parsed statuses + now + enablement.
pub fn build_view(
    uplink: Option<UplinkStatus>,
    ingest: Option<IngestStatus>,
    now_ms: u64,
    remotes_enabled: bool,
) -> RemotesView {
    let uplink_stale = uplink
        .as_ref()
        .map(|u| is_uplink_status_stale_now(u, now_ms))
        .unwrap_or(false);
    let ingest_stale = ingest
        .as_ref()
        .map(|i| is_ingest_status_stale_now(i, now_ms))
        .unwrap_or(false);
    RemotesView {
        uplink,
        uplink_stale,
        ingest,
        ingest_stale,
        remotes_enabled,
    }
}

/// Renders the human view. `color` enables `●`/`○` glyphs (TTY only — callers
/// pass `false` for non-TTY/pipes).
///
/// Security: this relies on the ingest-side `sanitize_identity`/`sanitize_os`
/// trust boundary (hostnames/os are stripped of control/ESC bytes and bounded
/// before they ever reach the status file). Never re-introduce raw connection
/// bytes here — printing unsanitized `hostname`/`os` could smuggle ANSI escapes
/// into the user's terminal.
pub fn render_human(view: &RemotesView, now_ms: u64, _color: bool) -> String {
    let mut out = String::new();
    let dot = |healthy: bool| if healthy { "●" } else { "○" };

    if !view.remotes_enabled {
        out.push_str(
            "Remotes are disabled — enable with `climon config feature.remotes enabled`.\n",
        );
        return out;
    }

    // Outbound (uplink).
    out.push_str("Dashboards I'm connected to (uplink)\n");
    match &view.uplink {
        Some(u) if !view.uplink_stale && u.state == "connected" => {
            let target = u.target.as_ref();
            let kind = target.map(|t| t.kind.as_str()).unwrap_or("direct");
            let detail = target
                .and_then(|t| {
                    t.tunnel_id.clone().or_else(|| match (&t.host, t.port) {
                        (Some(h), Some(p)) => Some(format!("{h}:{p}")),
                        (Some(h), None) => Some(h.clone()),
                        _ => None,
                    })
                })
                .unwrap_or_else(|| "-".into());
            let url = target.and_then(|t| t.url.clone());
            let up = u
                .connected_at
                .map(|c| fmt_ago(now_ms, c))
                .unwrap_or_default();
            out.push_str(&format!(
                "  {} {:<8} {:<16} {} sessions  up {}\n",
                dot(true),
                kind,
                detail,
                u.session_count,
                up
            ));
            if let Some(url) = url {
                out.push_str(&format!("    {url}\n"));
            }
        }
        Some(u) => {
            out.push_str(&format!(
                "  {} {} (stale/{})\n",
                dot(false),
                "uplink",
                u.state
            ));
        }
        None => out.push_str("  Not connected to any dashboard\n"),
    }
    out.push('\n');

    // Inbound (ingest).
    out.push_str("Remote hosts connected to my dashboard (ingest)\n");
    match &view.ingest {
        Some(i) if !i.connections.is_empty() => {
            for c in &i.connections {
                let stale = view.ingest_stale || is_connection_stale(c, now_ms);
                let addr = c.address.clone().unwrap_or_else(|| "?".into());
                let ping = c
                    .last_ping_at
                    .map(|p| format!("last ping {}", fmt_ago(now_ms, p)))
                    .unwrap_or_else(|| "no ping".into());
                let tail = if stale {
                    format!("STALE ({ping})")
                } else {
                    ping
                };
                out.push_str(&format!(
                    "  {} {} ({})  {}  {} sessions  {}\n",
                    dot(!stale),
                    c.hostname,
                    c.os,
                    addr,
                    c.session_count,
                    tail
                ));
            }
        }
        _ => out.push_str("  No remote hosts connected\n"),
    }
    out.push('\n');

    let ingest_line = match (&view.ingest, view.ingest_stale) {
        (Some(i), false) => format!("running (pid {})", i.pid),
        _ => "stopped".to_string(),
    };
    let uplink_line = match (&view.uplink, view.uplink_stale) {
        (Some(u), false) => format!("running (pid {})", u.pid),
        _ => "stopped".to_string(),
    };
    out.push_str(&format!("ingest: {ingest_line}   uplink: {uplink_line}\n"));
    out
}

fn fmt_ago(now_ms: u64, then_ms: u64) -> String {
    let secs = now_ms.saturating_sub(then_ms) / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else {
        format!("{}h", secs / 3600)
    }
}

/// Reads both status files for `config_env` and builds the view.
pub fn read_view(config_env: &ConfigEnv, now_ms: u64, remotes_enabled: bool) -> RemotesView {
    build_view(
        read_uplink_status(config_env),
        read_ingest_status(config_env),
        now_ms,
        remotes_enabled,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use climon_remote::ingest_status::IngestConnectionStatus;
    use climon_remote::uplink_status::UplinkTarget;

    fn now() -> u64 {
        2_000_000
    }

    fn connected_uplink() -> UplinkStatus {
        UplinkStatus {
            pid: std::process::id(),
            updated_at: now(),
            target: Some(UplinkTarget {
                kind: "tunnel".into(),
                host: Some("127.0.0.1".into()),
                port: Some(3132),
                tunnel_id: Some("abc".into()),
                url: Some("http://abc.devtunnels.ms".into()),
            }),
            state: "connected".into(),
            connected_at: Some(now() - 240_000),
            session_count: 3,
            last_error: None,
        }
    }

    fn ingest_with_one() -> IngestStatus {
        IngestStatus {
            pid: std::process::id(),
            updated_at: now(),
            connections: vec![IngestConnectionStatus {
                client_id: "jacks-devbox".into(),
                hostname: "jacks-devbox".into(),
                os: "linux".into(),
                address: Some("10.0.0.7".into()),
                connected_at: now() - 10_000,
                session_count: 3,
                last_ping_at: Some(now() - 1_000),
            }],
        }
    }

    #[test]
    fn disabled_hint_when_remotes_off() {
        let view = build_view(None, None, now(), false);
        let out = render_human(&view, now(), false);
        assert!(out.contains("Remotes are disabled"));
    }

    #[test]
    fn empty_sections_render_explicit_none() {
        let view = build_view(None, None, now(), true);
        let out = render_human(&view, now(), false);
        assert!(out.contains("Not connected to any dashboard"));
        assert!(out.contains("No remote hosts connected"));
    }

    #[test]
    fn renders_connected_uplink_and_one_host() {
        let view = build_view(
            Some(connected_uplink()),
            Some(ingest_with_one()),
            now(),
            true,
        );
        let out = render_human(&view, now(), false);
        assert!(out.contains("http://abc.devtunnels.ms"));
        assert!(out.contains("jacks-devbox (linux)"));
        assert!(out.contains("3 sessions"));
        assert!(out.contains("ingest: running"));
        assert!(out.contains("uplink: running"));
    }

    #[test]
    fn connected_uplink_shows_target_detail_not_duplicate_kind() {
        // Regression: render_human previously printed `kind` in both columns,
        // dropping the target detail. A direct target must show host:port once.
        let uplink = UplinkStatus {
            pid: std::process::id(),
            updated_at: now(),
            target: Some(UplinkTarget {
                kind: "direct".into(),
                host: Some("10.0.0.9".into()),
                port: Some(3131),
                tunnel_id: None,
                url: None,
            }),
            state: "connected".into(),
            connected_at: Some(now() - 5_000),
            session_count: 1,
            last_error: None,
        };
        let view = build_view(Some(uplink), None, now(), true);
        let out = render_human(&view, now(), false);
        assert!(out.contains("10.0.0.9:3131"));
        assert_eq!(out.matches("direct").count(), 1);
    }

    #[test]
    fn stale_connection_marked() {
        let mut ingest = ingest_with_one();
        ingest.connections[0].last_ping_at = Some(now() - 90_000);
        let view = build_view(Some(connected_uplink()), Some(ingest), now(), true);
        let out = render_human(&view, now(), false);
        assert!(out.contains("STALE"));
    }

    #[test]
    fn json_view_is_serializable() {
        let view = build_view(
            Some(connected_uplink()),
            Some(ingest_with_one()),
            now(),
            true,
        );
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("\"uplinkStale\""));
        assert!(json.contains("\"remotesEnabled\""));
    }
}
