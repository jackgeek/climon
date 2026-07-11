use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DevtunnelOperation {
    Detect,
    ShowUser,
    ListTunnels,
    ShowTunnel,
    CreateTunnel,
    DeleteTunnel,
    ListPorts,
    CreatePort,
    DeletePort,
    HostTunnel,
    ConnectTunnel,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevtunnelErrorCode {
    CliMissing,
    NotAuthenticated,
    TunnelQuotaExhausted,
    RateLimited,
    PermissionDenied,
    TunnelNotFound,
    PortConflict,
    NetworkUnavailable,
    ServiceUnavailable,
    ProcessExited,
    InvalidOutput,
    Unknown,
}

impl DevtunnelErrorCode {
    /// The stable snake_case token for this code, matching its serde wire name.
    /// Used to render `[code]` in `climon remotes` without pulling in serde.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CliMissing => "cli_missing",
            Self::NotAuthenticated => "not_authenticated",
            Self::TunnelQuotaExhausted => "tunnel_quota_exhausted",
            Self::RateLimited => "rate_limited",
            Self::PermissionDenied => "permission_denied",
            Self::TunnelNotFound => "tunnel_not_found",
            Self::PortConflict => "port_conflict",
            Self::NetworkUnavailable => "network_unavailable",
            Self::ServiceUnavailable => "service_unavailable",
            Self::ProcessExited => "process_exited",
            Self::InvalidOutput => "invalid_output",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevtunnelRetryClass {
    Transient,
    Actionable,
    Permanent,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevtunnelFailureInput {
    pub operation: DevtunnelOperation,
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(default)]
    pub spawn_error: Option<String>,
    #[serde(default)]
    pub parse_failed: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevtunnelFailure {
    pub code: DevtunnelErrorCode,
    pub operation: DevtunnelOperation,
    pub summary: String,
    pub remediation: String,
    pub technical_detail: String,
    pub occurred_at: String,
    pub retry_class: DevtunnelRetryClass,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevtunnelRetryState {
    pub attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<String>,
    pub paused: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevtunnelState {
    Idle,
    Starting,
    Running,
    Retrying,
    Paused,
    Stopped,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevtunnelHealth {
    pub available: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub state: DevtunnelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<DevtunnelFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<DevtunnelRetryState>,
    pub probed_at: String,
}

impl DevtunnelHealth {
    /// A snapshot for a healthy/pending state with no active failure. Callers pass
    /// the transition state (e.g. `Starting`, `Running`, `Stopped`) and, on
    /// success, the ISO timestamp of the last good operation.
    pub fn healthy(
        state: DevtunnelState,
        last_success_at: Option<String>,
        probed_at: String,
    ) -> Self {
        Self {
            available: true,
            authenticated: true,
            version: None,
            state,
            last_success_at,
            last_failure: None,
            retry: None,
            probed_at,
        }
    }

    /// A snapshot carrying an already-classified failure and its retry state.
    /// The failure's `code` is not re-classified here — availability/auth are
    /// derived from it so old readers still get a coherent picture. This is the
    /// single constructor status writers use so failure strings are never rebuilt
    /// at each call site.
    pub fn from_failure(
        state: DevtunnelState,
        failure: DevtunnelFailure,
        retry: Option<DevtunnelRetryState>,
        probed_at: String,
    ) -> Self {
        let available = failure.code != DevtunnelErrorCode::CliMissing;
        let authenticated = available && failure.code != DevtunnelErrorCode::NotAuthenticated;
        Self {
            available,
            authenticated,
            version: None,
            state,
            last_success_at: None,
            last_failure: Some(failure),
            retry,
            probed_at,
        }
    }
}
