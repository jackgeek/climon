//! Tokio-based devtunnel CLI gateway. Port of `src/devtunnel/gateway.ts` (and
//! the long-running process spawn from `src/devtunnel/process.ts`).
//!
//! All `devtunnel` invocations flow through this gateway so environment
//! preparation (`devtunnel_env`), the `CLIMON_DISABLE_DEVTUNNEL` guard, Windows
//! console suppression, stdio handling, and failure classification live in one
//! place. Short-lived operations return `Result<T, DevtunnelFailure>`; the
//! long-running host/connect process is exposed via [`SpawnedDevtunnelProcess`].
//! An injectable [`Runner`]/[`ProcessSpawner`] keeps the gateway unit-testable
//! without shelling out.
//!
//! The typed operations intentionally return `Result<T, DevtunnelFailure>`;
//! `DevtunnelFailure` carries rich diagnostic strings and is deliberately the
//! error surface Task 8 consumes, so the `result_large_err` lint is allowed for
//! the module rather than boxing every operation's error.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use climon_store::paths::now_iso;
use serde_json::Value;

use super::classify::classify_failure;
use super::types::{
    DevtunnelErrorCode, DevtunnelFailure, DevtunnelFailureInput, DevtunnelHealth,
    DevtunnelOperation, DevtunnelState,
};

/// Result of running an external command. Mirrors the Bun gateway `RunResult`,
/// including the optional `spawn_error` code fed into classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub spawn_error: Option<String>,
}

/// An injectable async command runner. Mirrors the Bun `Runner`.
pub type Runner = Arc<
    dyn Fn(String, Vec<String>) -> Pin<Box<dyn Future<Output = RunResult> + Send>> + Send + Sync,
>;

/// Injectable clock returning a JS-`toISOString()`-compatible timestamp.
pub type NowFn = Arc<dyn Fn() -> String + Send + Sync>;

/// Injectable spawner for the long-running `devtunnel host`/`connect` process.
pub type ProcessSpawner = Arc<
    dyn Fn(&str, Vec<String>, HashMap<String, String>) -> std::io::Result<tokio::process::Child>
        + Send
        + Sync,
>;

/// Arguments for [`DevtunnelGateway::create_tunnel`], mirroring the Bun
/// `createTunnel({ id?, labels?, description? })` shape.
#[derive(Debug, Clone, Default)]
pub struct CreateTunnelArgs {
    pub id: Option<String>,
    pub labels: Vec<String>,
    pub description: Option<String>,
}

/// A spawned long-running devtunnel process with captured stdio. Mirrors the
/// role of `DevtunnelProcess`; exits are classified from accumulated
/// stdout/stderr via [`classify_devtunnel_exit`].
#[derive(Debug)]
pub struct SpawnedDevtunnelProcess {
    pub child: tokio::process::Child,
    pub stdout: tokio::process::ChildStdout,
    pub stderr: tokio::process::ChildStderr,
    pub operation: DevtunnelOperation,
}

/// Returns an env map with `LD_LIBRARY_PATH` set to the user-local ICU library
/// path when it is missing and the path exists. Mirrors `devtunnelEnv`.
pub fn devtunnel_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    if env.contains_key("LD_LIBRARY_PATH") {
        return env.clone();
    }
    let home = env
        .get("HOME")
        .cloned()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();
    let icu_lib = Path::new(&home)
        .join(".local")
        .join("icu")
        .join("usr")
        .join("lib")
        .join("x86_64-linux-gnu");
    if icu_lib.exists() {
        let mut out = env.clone();
        out.insert(
            "LD_LIBRARY_PATH".to_string(),
            icu_lib.to_string_lossy().into_owned(),
        );
        out
    } else {
        env.clone()
    }
}

/// True when `CLIMON_DISABLE_DEVTUNNEL` disables all devtunnel interaction.
/// Mirrors `isDevtunnelDisabled`.
pub fn is_devtunnel_disabled(env: &HashMap<String, String>) -> bool {
    matches!(
        env.get("CLIMON_DISABLE_DEVTUNNEL").map(String::as_str),
        Some("1") | Some("true")
    )
}

/// Classifies a long-running process exit. Returns `None` on a clean (status 0)
/// exit; otherwise classifies the accumulated stdout/stderr. Mirrors the
/// `startDevtunnelProcess` finish path.
pub fn classify_devtunnel_exit(
    operation: DevtunnelOperation,
    status: i32,
    stdout: &str,
    stderr: &str,
    spawn_error: Option<&str>,
    now: &str,
) -> Option<DevtunnelFailure> {
    if status == 0 {
        return None;
    }
    Some(classify_failure(
        &DevtunnelFailureInput {
            operation,
            status,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            spawn_error: spawn_error.map(str::to_string),
            parse_failed: None,
        },
        now,
    ))
}

fn spawn_error_code(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        other => format!("{other:?}"),
    }
}

fn default_runner(env: HashMap<String, String>) -> Runner {
    Arc::new(move |cmd, args| {
        let env = env.clone();
        Box::pin(async move { run_command(&cmd, &args, &env).await })
    })
}

async fn run_command(cmd: &str, args: &[String], env: &HashMap<String, String>) -> RunResult {
    let mut command = tokio::process::Command::new(cmd);
    command.args(args);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let effective_env = if cmd == "devtunnel" {
        devtunnel_env(env)
    } else {
        env.clone()
    };
    command.env_clear();
    command.envs(effective_env);
    apply_windows_flags(&mut command);
    match command.output().await {
        Ok(output) => RunResult {
            status: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            spawn_error: None,
        },
        Err(error) => RunResult {
            status: 127,
            stdout: String::new(),
            stderr: error.to_string(),
            spawn_error: Some(spawn_error_code(&error)),
        },
    }
}

fn default_spawner() -> ProcessSpawner {
    Arc::new(|cmd, args, env| {
        let mut command = tokio::process::Command::new(cmd);
        command.args(&args);
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.env_clear();
        command.envs(env);
        apply_windows_flags(&mut command);
        command.spawn()
    })
}

fn apply_windows_flags(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // devtunnel.exe is a console app; CREATE_NO_WINDOW suppresses the
        // console window flash on Windows.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Injectable dependencies for [`DevtunnelGateway`]. Unset fields fall back to
/// the real Tokio runner/spawner, the process environment, and [`now_iso`].
#[derive(Default)]
pub struct DevtunnelGatewayDeps {
    pub runner: Option<Runner>,
    pub spawner: Option<ProcessSpawner>,
    pub env: Option<HashMap<String, String>>,
    pub now: Option<NowFn>,
}

/// Centralized async gateway for `devtunnel` CLI operations.
pub struct DevtunnelGateway {
    runner: Runner,
    spawner: ProcessSpawner,
    env: HashMap<String, String>,
    now: NowFn,
}

impl Default for DevtunnelGateway {
    fn default() -> Self {
        Self::new()
    }
}

impl DevtunnelGateway {
    /// A gateway wired to the real Tokio runner/spawner and process environment.
    pub fn new() -> Self {
        Self::with_deps(DevtunnelGatewayDeps::default())
    }

    /// A gateway with the given injectable dependencies.
    pub fn with_deps(deps: DevtunnelGatewayDeps) -> Self {
        let env = deps
            .env
            .unwrap_or_else(|| std::env::vars().collect::<HashMap<String, String>>());
        let runner = deps.runner.unwrap_or_else(|| default_runner(env.clone()));
        let spawner = deps.spawner.unwrap_or_else(default_spawner);
        let now = deps.now.unwrap_or_else(|| Arc::new(now_iso) as NowFn);
        Self {
            runner,
            spawner,
            env,
            now,
        }
    }

    fn disabled(&self) -> bool {
        is_devtunnel_disabled(&self.env)
    }

    fn now(&self) -> String {
        (self.now)()
    }

    fn classify(
        &self,
        operation: DevtunnelOperation,
        result: &RunResult,
        parse_failed: bool,
    ) -> DevtunnelFailure {
        classify_failure(
            &DevtunnelFailureInput {
                operation,
                status: result.status,
                stdout: result.stdout.clone(),
                stderr: result.stderr.clone(),
                spawn_error: result.spawn_error.clone(),
                parse_failed: if parse_failed { Some(true) } else { None },
            },
            &self.now(),
        )
    }

    fn disabled_result() -> RunResult {
        RunResult {
            status: 127,
            stdout: String::new(),
            stderr: "devtunnel disabled".to_string(),
            spawn_error: Some("ENOENT".to_string()),
        }
    }

    fn base_health(&self) -> DevtunnelHealth {
        DevtunnelHealth {
            available: false,
            authenticated: false,
            version: None,
            state: DevtunnelState::Idle,
            last_success_at: None,
            last_failure: None,
            retry: None,
            probed_at: self.now(),
        }
    }

    async fn run(
        &self,
        operation: DevtunnelOperation,
        args: Vec<String>,
    ) -> Result<RunResult, DevtunnelFailure> {
        if self.disabled() {
            return Err(self.classify(operation, &Self::disabled_result(), false));
        }
        let result = (self.runner)("devtunnel".to_string(), args).await;
        if result.status != 0 {
            return Err(self.classify(operation, &result, false));
        }
        Ok(result)
    }

    fn parse_json(
        &self,
        operation: DevtunnelOperation,
        result: &RunResult,
    ) -> Result<Value, DevtunnelFailure> {
        let source = if result.stdout.trim().is_empty() {
            "null"
        } else {
            result.stdout.as_str()
        };
        serde_json::from_str::<Value>(source).map_err(|_| self.classify(operation, result, true))
    }

    /// Confirms the `devtunnel` CLI is present and runnable. Mirrors `detect`.
    pub async fn detect(&self) -> DevtunnelHealth {
        if self.disabled() {
            return self.base_health();
        }
        let result = (self.runner)("devtunnel".to_string(), vec!["--version".to_string()]).await;
        let mut health = self.base_health();
        if result.status != 0 {
            health.last_failure = Some(self.classify(DevtunnelOperation::Detect, &result, false));
            return health;
        }
        health.available = true;
        let version = result.stdout.trim();
        health.version = if version.is_empty() {
            None
        } else {
            Some(version.to_string())
        };
        health
    }

    /// Reports the signed-in state of the `devtunnel` CLI. Mirrors `showUser`.
    pub async fn show_user(&self) -> DevtunnelHealth {
        if self.disabled() {
            return self.base_health();
        }
        let result = (self.runner)(
            "devtunnel".to_string(),
            vec!["user".to_string(), "show".to_string(), "--json".to_string()],
        )
        .await;
        let mut health = self.base_health();
        health.available = true;
        if result.status != 0 {
            health.last_failure = Some(self.classify(DevtunnelOperation::ShowUser, &result, false));
            return health;
        }
        let source = if result.stdout.trim().is_empty() {
            "null"
        } else {
            result.stdout.as_str()
        };
        let parsed = match serde_json::from_str::<Value>(source) {
            Ok(value) => value,
            Err(_) => {
                health.last_failure =
                    Some(self.classify(DevtunnelOperation::ShowUser, &result, true));
                return health;
            }
        };
        if is_logged_in_status(&parsed) {
            health.authenticated = true;
            return health;
        }
        let stderr = if !result.stderr.is_empty() {
            result.stderr.clone()
        } else if !result.stdout.is_empty() {
            result.stdout.clone()
        } else {
            "Not logged in".to_string()
        };
        let modified = RunResult {
            status: 1,
            stdout: result.stdout.clone(),
            stderr,
            spawn_error: None,
        };
        health.authenticated = false;
        health.last_failure = Some(self.classify(DevtunnelOperation::ShowUser, &modified, false));
        health
    }

    /// Lists tunnels, optionally filtered by labels. Mirrors `listTunnels`.
    pub async fn list_tunnels(&self, labels: &[String]) -> Result<Value, DevtunnelFailure> {
        let mut args = vec!["list".to_string(), "--json".to_string()];
        if !labels.is_empty() {
            args.push("--labels".to_string());
            args.push(labels.join(","));
        }
        let result = self.run(DevtunnelOperation::ListTunnels, args).await?;
        self.parse_json(DevtunnelOperation::ListTunnels, &result)
    }

    /// Shows a single tunnel. Mirrors `showTunnel`.
    pub async fn show_tunnel(&self, id: &str, verbose: bool) -> Result<Value, DevtunnelFailure> {
        let mut args = vec!["show".to_string(), id.to_string()];
        if verbose {
            args.push("--verbose".to_string());
        }
        args.push("--json".to_string());
        let result = self.run(DevtunnelOperation::ShowTunnel, args).await?;
        self.parse_json(DevtunnelOperation::ShowTunnel, &result)
    }

    /// Creates a tunnel. Mirrors `createTunnel`.
    pub async fn create_tunnel(
        &self,
        args: &CreateTunnelArgs,
    ) -> Result<RunResult, DevtunnelFailure> {
        let mut cmd = vec!["create".to_string()];
        if let Some(id) = &args.id {
            cmd.push(id.clone());
        }
        for label in &args.labels {
            cmd.push("--labels".to_string());
            cmd.push(label.clone());
        }
        if let Some(description) = &args.description {
            cmd.push("--description".to_string());
            cmd.push(description.clone());
        }
        cmd.push("--json".to_string());
        self.run(DevtunnelOperation::CreateTunnel, cmd).await
    }

    /// Deletes a tunnel. Mirrors `deleteTunnel`.
    pub async fn delete_tunnel(&self, id: &str, force: bool) -> Result<(), DevtunnelFailure> {
        let mut args = vec!["delete".to_string(), id.to_string()];
        if force {
            args.push("--force".to_string());
        }
        self.run(DevtunnelOperation::DeleteTunnel, args).await?;
        Ok(())
    }

    /// Lists a tunnel's ports. Mirrors `listPorts`.
    pub async fn list_ports(&self, id: &str) -> Result<RunResult, DevtunnelFailure> {
        self.run(
            DevtunnelOperation::ListPorts,
            vec![
                "port".to_string(),
                "list".to_string(),
                id.to_string(),
                "--json".to_string(),
            ],
        )
        .await
    }

    /// Creates a tunnel port mapping. Swallows a `port_conflict` failure (the
    /// mapping already exists) and propagates every other classified failure.
    /// Mirrors `createPort`.
    pub async fn create_port(
        &self,
        id: &str,
        port: u16,
        protocol: Option<&str>,
    ) -> Result<(), DevtunnelFailure> {
        let mut args = vec![
            "port".to_string(),
            "create".to_string(),
            id.to_string(),
            "-p".to_string(),
            port.to_string(),
        ];
        if let Some(protocol) = protocol {
            args.push("--protocol".to_string());
            args.push(protocol.to_string());
        }
        if self.disabled() {
            return Err(self.classify(
                DevtunnelOperation::CreatePort,
                &Self::disabled_result(),
                false,
            ));
        }
        let result = (self.runner)("devtunnel".to_string(), args).await;
        if result.status == 0 {
            return Ok(());
        }
        let failure = self.classify(DevtunnelOperation::CreatePort, &result, false);
        if failure.code == DevtunnelErrorCode::PortConflict {
            return Ok(());
        }
        Err(failure)
    }

    /// Deletes a tunnel port mapping. Mirrors `deletePort`.
    pub async fn delete_port(&self, id: &str, port: u16) -> Result<(), DevtunnelFailure> {
        self.run(
            DevtunnelOperation::DeletePort,
            vec![
                "port".to_string(),
                "delete".to_string(),
                id.to_string(),
                "-p".to_string(),
                port.to_string(),
            ],
        )
        .await?;
        Ok(())
    }

    /// Spawns the long-running `devtunnel host <id>` process. Spawn failures are
    /// classified into a [`DevtunnelFailure`]; on success the captured stdio is
    /// returned so callers can stream and classify the eventual exit. Mirrors
    /// `spawnHost`.
    pub fn spawn_host(&self, id: &str) -> Result<SpawnedDevtunnelProcess, DevtunnelFailure> {
        self.spawn_long_running(
            DevtunnelOperation::HostTunnel,
            vec!["host".to_string(), id.to_string()],
        )
    }

    /// Spawns the long-running `devtunnel connect <id>` process used by the
    /// uplink to reach a remote ingest tunnel. Spawn failures are classified into
    /// a [`DevtunnelFailure`]; on success the captured stdio is returned so the
    /// caller can stream and classify the eventual exit.
    pub fn spawn_connect(&self, id: &str) -> Result<SpawnedDevtunnelProcess, DevtunnelFailure> {
        self.spawn_long_running(
            DevtunnelOperation::ConnectTunnel,
            vec!["connect".to_string(), id.to_string()],
        )
    }

    fn spawn_long_running(
        &self,
        operation: DevtunnelOperation,
        args: Vec<String>,
    ) -> Result<SpawnedDevtunnelProcess, DevtunnelFailure> {
        if self.disabled() {
            return Err(self.classify(operation, &Self::disabled_result(), false));
        }
        let env = devtunnel_env(&self.env);
        match (self.spawner)("devtunnel", args, env) {
            Ok(mut child) => match (child.stdout.take(), child.stderr.take()) {
                (Some(stdout), Some(stderr)) => Ok(SpawnedDevtunnelProcess {
                    child,
                    stdout,
                    stderr,
                    operation,
                }),
                _ => {
                    let _ = child.start_kill();
                    Err(self.classify(
                        operation,
                        &RunResult {
                            status: 127,
                            stdout: String::new(),
                            stderr: "failed to capture devtunnel process stdio".to_string(),
                            spawn_error: Some("EPIPE".to_string()),
                        },
                        false,
                    ))
                }
            },
            Err(error) => {
                let result = RunResult {
                    status: 127,
                    stdout: String::new(),
                    stderr: error.to_string(),
                    spawn_error: Some(spawn_error_code(&error)),
                };
                Err(self.classify(operation, &result, false))
            }
        }
    }
}

fn is_logged_in_status(value: &Value) -> bool {
    let status = match value {
        Value::Object(map) => match map.get("status") {
            Some(Value::String(status)) => status.clone(),
            Some(other) => other.to_string(),
            None => return false,
        },
        _ => return false,
    };
    let normalized = normalize_whitespace(&status.to_lowercase());
    normalized.contains("logged in") && !normalized.contains("not logged in")
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devtunnel::types::{DevtunnelErrorCode, DevtunnelOperation};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn fixed_now() -> NowFn {
        Arc::new(|| "2026-07-11T13:00:00.000Z".to_string())
    }

    fn ok_json(stdout: &str) -> RunResult {
        RunResult {
            status: 0,
            stdout: stdout.to_string(),
            stderr: String::new(),
            spawn_error: None,
        }
    }

    fn fixed_runner(result: RunResult) -> Runner {
        Arc::new(move |_cmd, _args| {
            let result = result.clone();
            Box::pin(async move { result })
        })
    }

    fn recording_runner(calls: Arc<Mutex<Vec<Vec<String>>>>, result: RunResult) -> Runner {
        Arc::new(move |_cmd, args| {
            calls.lock().unwrap().push(args);
            let result = result.clone();
            Box::pin(async move { result })
        })
    }

    fn gateway_with_runner(runner: Runner) -> DevtunnelGateway {
        DevtunnelGateway::with_deps(DevtunnelGatewayDeps {
            runner: Some(runner),
            env: Some(HashMap::new()),
            now: Some(fixed_now()),
            ..Default::default()
        })
    }

    #[test]
    fn disabled_env_is_detected() {
        let mut env = HashMap::new();
        env.insert("CLIMON_DISABLE_DEVTUNNEL".to_string(), "1".to_string());
        assert!(is_devtunnel_disabled(&env));
        env.insert("CLIMON_DISABLE_DEVTUNNEL".to_string(), "true".to_string());
        assert!(is_devtunnel_disabled(&env));
        env.insert("CLIMON_DISABLE_DEVTUNNEL".to_string(), "0".to_string());
        assert!(!is_devtunnel_disabled(&env));
        assert!(!is_devtunnel_disabled(&HashMap::new()));
    }

    #[test]
    fn devtunnel_env_adds_icu_when_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "climon-icu-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let icu = tmp
            .join(".local")
            .join("icu")
            .join("usr")
            .join("lib")
            .join("x86_64-linux-gnu");
        std::fs::create_dir_all(&icu).unwrap();
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), tmp.to_string_lossy().into_owned());
        let out = devtunnel_env(&env);
        assert_eq!(
            out.get("LD_LIBRARY_PATH").map(String::as_str),
            Some(icu.to_string_lossy().as_ref())
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn devtunnel_env_is_unchanged_when_already_set() {
        let mut env = HashMap::new();
        env.insert("LD_LIBRARY_PATH".to_string(), "/already".to_string());
        let out = devtunnel_env(&env);
        assert_eq!(
            out.get("LD_LIBRARY_PATH").map(String::as_str),
            Some("/already")
        );
    }

    #[tokio::test]
    async fn detect_reports_missing_cli() {
        let gw = gateway_with_runner(fixed_runner(RunResult {
            status: 127,
            stdout: String::new(),
            stderr: "not found".to_string(),
            spawn_error: Some("ENOENT".to_string()),
        }));
        let health = gw.detect().await;
        assert!(!health.available);
        assert_eq!(
            health.last_failure.unwrap().code,
            DevtunnelErrorCode::CliMissing
        );
    }

    #[tokio::test]
    async fn detect_reports_version() {
        let gw = gateway_with_runner(fixed_runner(ok_json("1.0.1234\n")));
        let health = gw.detect().await;
        assert!(health.available);
        assert_eq!(health.version, Some("1.0.1234".to_string()));
    }

    #[tokio::test]
    async fn show_user_reports_authenticated() {
        let gw = gateway_with_runner(fixed_runner(ok_json(
            r#"{"status":"Logged in as user@example.com"}"#,
        )));
        let health = gw.show_user().await;
        assert!(health.available);
        assert!(health.authenticated);
    }

    #[tokio::test]
    async fn show_user_reports_unauthenticated() {
        let gw = gateway_with_runner(fixed_runner(ok_json(r#"{"status":"Not logged in"}"#)));
        let health = gw.show_user().await;
        assert!(health.available);
        assert!(!health.authenticated);
        assert_eq!(
            health.last_failure.unwrap().code,
            DevtunnelErrorCode::NotAuthenticated
        );
    }

    #[tokio::test]
    async fn list_tunnels_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("[]")));
        gw.list_tunnels(&[]).await.unwrap();
        gw.list_tunnels(&["a".to_string(), "b".to_string()])
            .await
            .unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded[0], s(&["list", "--json"]));
        assert_eq!(recorded[1], s(&["list", "--json", "--labels", "a,b"]));
    }

    #[tokio::test]
    async fn show_tunnel_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("{}")));
        gw.show_tunnel("abc", false).await.unwrap();
        gw.show_tunnel("abc", true).await.unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded[0], s(&["show", "abc", "--json"]));
        assert_eq!(recorded[1], s(&["show", "abc", "--verbose", "--json"]));
    }

    #[tokio::test]
    async fn create_tunnel_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("{}")));
        gw.create_tunnel(&CreateTunnelArgs {
            id: Some("foo".to_string()),
            labels: vec!["a".to_string(), "b".to_string()],
            description: Some("desc".to_string()),
        })
        .await
        .unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(
            recorded[0],
            s(&[
                "create",
                "foo",
                "--labels",
                "a",
                "--labels",
                "b",
                "--description",
                "desc",
                "--json",
            ])
        );
    }

    #[tokio::test]
    async fn create_tunnel_classifies_quota_exhaustion() {
        let gw = gateway_with_runner(fixed_runner(RunResult {
            status: 1,
            stdout: String::new(),
            stderr: "maximum number of tunnels reached".to_string(),
            spawn_error: None,
        }));
        let err = gw
            .create_tunnel(&CreateTunnelArgs {
                id: None,
                labels: vec![],
                description: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err.code, DevtunnelErrorCode::TunnelQuotaExhausted);
    }

    #[tokio::test]
    async fn delete_tunnel_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("")));
        gw.delete_tunnel("abc", false).await.unwrap();
        gw.delete_tunnel("abc", true).await.unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded[0], s(&["delete", "abc"]));
        assert_eq!(recorded[1], s(&["delete", "abc", "--force"]));
    }

    #[tokio::test]
    async fn list_ports_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("[]")));
        gw.list_ports("abc").await.unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded[0], s(&["port", "list", "abc", "--json"]));
    }

    #[tokio::test]
    async fn create_port_builds_args_and_swallows_conflict() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(
            calls.clone(),
            RunResult {
                status: 1,
                stdout: String::new(),
                stderr: "port already exists".to_string(),
                spawn_error: None,
            },
        ));
        gw.create_port("abc", 3000, Some("http")).await.unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(
            recorded[0],
            s(&["port", "create", "abc", "-p", "3000", "--protocol", "http"])
        );
    }

    #[tokio::test]
    async fn create_port_propagates_non_conflict_failure() {
        let gw = gateway_with_runner(fixed_runner(RunResult {
            status: 1,
            stdout: String::new(),
            stderr: "not logged in".to_string(),
            spawn_error: None,
        }));
        let err = gw.create_port("abc", 3000, None).await.unwrap_err();
        assert_eq!(err.code, DevtunnelErrorCode::NotAuthenticated);
    }

    #[tokio::test]
    async fn delete_port_builds_args() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gw = gateway_with_runner(recording_runner(calls.clone(), ok_json("")));
        gw.delete_port("abc", 3000).await.unwrap();
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded[0], s(&["port", "delete", "abc", "-p", "3000"]));
    }

    #[tokio::test]
    async fn disabled_gateway_fails_operations() {
        let mut env = HashMap::new();
        env.insert("CLIMON_DISABLE_DEVTUNNEL".to_string(), "1".to_string());
        let gw = DevtunnelGateway::with_deps(DevtunnelGatewayDeps {
            env: Some(env),
            now: Some(fixed_now()),
            ..Default::default()
        });
        let err = gw.list_tunnels(&[]).await.unwrap_err();
        assert_eq!(err.code, DevtunnelErrorCode::CliMissing);
        assert!(!gw.detect().await.available);
    }

    #[test]
    fn spawn_host_classifies_spawn_error() {
        let spawner: ProcessSpawner = Arc::new(|_cmd, _args, _env| {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            ))
        });
        let gw = DevtunnelGateway::with_deps(DevtunnelGatewayDeps {
            spawner: Some(spawner),
            env: Some(HashMap::new()),
            now: Some(fixed_now()),
            ..Default::default()
        });
        let err = gw.spawn_host("abc").unwrap_err();
        assert_eq!(err.code, DevtunnelErrorCode::CliMissing);
    }

    #[test]
    fn host_exit_is_classified_from_stderr() {
        let now = "2026-07-11T13:00:00.000Z";
        assert!(
            classify_devtunnel_exit(DevtunnelOperation::HostTunnel, 0, "", "", None, now).is_none()
        );
        let network = classify_devtunnel_exit(
            DevtunnelOperation::HostTunnel,
            1,
            "",
            "connection refused",
            None,
            now,
        )
        .unwrap();
        assert_eq!(network.code, DevtunnelErrorCode::NetworkUnavailable);
        let generic =
            classify_devtunnel_exit(DevtunnelOperation::ConnectTunnel, 1, "", "boom", None, now)
                .unwrap();
        assert_eq!(generic.code, DevtunnelErrorCode::ProcessExited);
    }
}
