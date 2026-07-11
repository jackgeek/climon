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
