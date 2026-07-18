//! Process-global structured logger.
//!
//! Port of `src/logging/logger.ts`. Initializes a process-wide root logger for
//! a role, emits NDJSON records (with base fields, child bindings, redaction,
//! and per-sink level gating), and exposes child loggers plus the
//! terminal-suspend toggles used by the client around PTY attach.
//!
//! This is *not* pino — it reimplements the observable behaviour the TS client
//! exposes. Records are client-internal (not a wire interop surface): redaction,
//! level gating, pretty routing, and file layout are the hard guarantees; exact
//! field byte-order of non-redaction fields is best-effort.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::env::Env;
use crate::level::{resolve_level, LogLevel};
use crate::pretty::{set_terminal_suspended, write_pretty_line};
use crate::redact::redact;
use crate::sinks::{build_file_stream, LogRole};

/// Default version stamped into records when the caller supplies none. The CLI
/// crate provides the real climon version (sourced from `package.json` on the
/// TS side) in a later phase.
pub const DEFAULT_VERSION: &str = "0.0.0";

/// Roles that emit pretty output to the terminal (info/warn → out, error/fatal
/// → err). Mirrors `TERMINAL_ROLES`.
const TERMINAL_ROLES: &[LogRole] = &[LogRole::Client, LogRole::Server];

static ROOT: Mutex<Option<Logger>> = Mutex::new(None);

/// Options for [`init_logger`]. Mirrors `LoggerInitOptions`.
#[derive(Default)]
pub struct LoggerInitOptions {
    /// Effective level override; resolved from config + env when omitted.
    pub level: Option<LogLevel>,
    /// Config-supplied `logging.level` (used only if `level` is omitted).
    pub config_level: Option<String>,
    /// Daemon session id; required for role `Daemon` to name the log file.
    pub session_id: Option<String>,
    /// Anonymous installation id, added to the logger base when provided.
    pub install_id: Option<String>,
    /// Version string for the record base (defaults to [`DEFAULT_VERSION`]).
    pub version: Option<String>,
    /// Environment override (testing); defaults to the process environment.
    pub env: Option<Env>,
    /// Extra in-process sinks (e.g. capture buffers, App Insights), each with a
    /// minimum level.
    pub extra_streams: Vec<(LogLevel, Box<dyn Write + Send>)>,
}

enum SinkKind {
    File(File),
    Pretty { colorize: bool },
    Writer(Box<dyn Write + Send>),
}

struct Sink {
    level: LogLevel,
    kind: SinkKind,
}

struct LoggerCore {
    level: LogLevel,
    base: Map<String, Value>,
    sinks: Mutex<Vec<Sink>>,
}

/// A structured logger. Cheap to clone (shares the underlying sinks); child
/// loggers add a `component` binding while sharing the parent's output.
#[derive(Clone)]
pub struct Logger {
    inner: Arc<LoggerCore>,
    bindings: BTreeMap<String, Value>,
}

impl Logger {
    /// Emits `msg` at `level` with no extra structured fields.
    pub fn log(&self, level: LogLevel, msg: &str) {
        self.emit(level, Value::Null, msg);
    }

    /// Emits `msg` at `level` merging the object `fields` as top-level
    /// structured fields.
    pub fn log_with(&self, level: LogLevel, fields: Value, msg: &str) {
        self.emit(level, fields, msg);
    }

    pub fn trace(&self, msg: &str) {
        self.emit(LogLevel::Trace, Value::Null, msg);
    }
    pub fn debug(&self, msg: &str) {
        self.emit(LogLevel::Debug, Value::Null, msg);
    }
    pub fn info(&self, msg: &str) {
        self.emit(LogLevel::Info, Value::Null, msg);
    }
    pub fn warn(&self, msg: &str) {
        self.emit(LogLevel::Warn, Value::Null, msg);
    }
    pub fn error(&self, msg: &str) {
        self.emit(LogLevel::Error, Value::Null, msg);
    }
    pub fn fatal(&self, msg: &str) {
        self.emit(LogLevel::Fatal, Value::Null, msg);
    }

    /// Returns a child logger tagged with a `component` name. Mirrors `child`.
    pub fn child(&self, component: &str) -> Logger {
        let mut bindings = self.bindings.clone();
        bindings.insert(
            "component".to_string(),
            Value::String(component.to_string()),
        );
        Logger {
            inner: Arc::clone(&self.inner),
            bindings,
        }
    }

    fn emit(&self, level: LogLevel, fields: Value, msg: &str) {
        if !record_passes(level, self.inner.level) {
            return;
        }

        let mut record: Map<String, Value> = Map::new();
        if let Some(n) = level.pino_number() {
            record.insert("level".to_string(), Value::from(n));
        }
        record.insert("time".to_string(), Value::from(now_millis()));
        for (k, v) in &self.inner.base {
            record.insert(k.clone(), v.clone());
        }
        for (k, v) in &self.bindings {
            record.insert(k.clone(), v.clone());
        }
        if let Value::Object(map) = fields {
            for (k, v) in map {
                record.insert(k, v);
            }
        }
        record.insert("msg".to_string(), Value::String(msg.to_string()));

        let mut value = Value::Object(record);
        redact(&mut value);

        let mut line = value.to_string();
        line.push('\n');

        let mut sinks = self.inner.sinks.lock().unwrap_or_else(|p| p.into_inner());
        for sink in sinks.iter_mut() {
            if !record_passes(level, sink.level) {
                continue;
            }
            let _ = write_to_sink(sink, &line);
        }
    }
}

fn write_to_sink(sink: &mut Sink, line: &str) -> io::Result<()> {
    match &mut sink.kind {
        SinkKind::File(f) => f.write_all(line.as_bytes()),
        SinkKind::Writer(w) => w.write_all(line.as_bytes()),
        SinkKind::Pretty { colorize } => {
            let stdout = io::stdout();
            let stderr = io::stderr();
            let mut out = stdout.lock();
            let mut err = stderr.lock();
            write_pretty_line(line.trim_end_matches('\n'), &mut out, &mut err, *colorize)
        }
    }
}

/// True when a record at `record_level` passes a `threshold`. A silent
/// threshold (or silent record) never passes.
fn record_passes(record_level: LogLevel, threshold: LogLevel) -> bool {
    match (record_level.pino_number(), threshold.pino_number()) {
        (Some(r), Some(t)) => r >= t,
        _ => false,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Initializes the process-wide root logger for a role. At level `Silent` no
/// streams or files are created. Mirrors `initLogger`.
pub fn init_logger(role: LogRole, opts: LoggerInitOptions) -> Logger {
    let env = opts.env.unwrap_or_else(Env::from_process);
    let level = opts
        .level
        .unwrap_or_else(|| resolve_level(opts.config_level.as_deref(), &env));

    let mut base: Map<String, Value> = Map::new();
    base.insert("role".to_string(), Value::String(role.as_str().to_string()));
    base.insert("pid".to_string(), Value::from(std::process::id()));
    let version = opts.version.unwrap_or_else(|| DEFAULT_VERSION.to_string());
    base.insert("version".to_string(), Value::String(version));
    if let Some(iid) = opts.install_id {
        base.insert("installId".to_string(), Value::String(iid));
    }

    let sinks: Vec<Sink> = if level == LogLevel::Silent {
        Vec::new()
    } else {
        let mut sinks = Vec::new();
        let file = build_file_stream(role, &env, opts.session_id.as_deref())
            .expect("create role log file");
        sinks.push(Sink {
            level,
            kind: SinkKind::File(file),
        });
        if TERMINAL_ROLES.contains(&role) {
            sinks.push(Sink {
                level: LogLevel::Info,
                kind: SinkKind::Pretty { colorize: true },
            });
        }
        for (lvl, w) in opts.extra_streams {
            sinks.push(Sink {
                level: lvl,
                kind: SinkKind::Writer(w),
            });
        }
        sinks
    };

    let logger = Logger {
        inner: Arc::new(LoggerCore {
            level,
            base,
            sinks: Mutex::new(sinks),
        }),
        bindings: BTreeMap::new(),
    };

    *ROOT.lock().unwrap_or_else(|p| p.into_inner()) = Some(logger.clone());
    logger
}

/// Returns the root logger, lazily initializing a default `client` logger if
/// init was never called. Mirrors `getLogger`.
pub fn get_logger() -> Logger {
    {
        let guard = ROOT.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(logger) = guard.as_ref() {
            return logger.clone();
        }
    }
    init_logger(LogRole::Client, LoggerInitOptions::default())
}

/// Whether the process-wide root logger has been initialized. Lets a caller in a
/// hot path avoid the lazy [`get_logger`] init (which would create a log file):
/// it logs only when a logger is already installed, so uninstrumented runs (and
/// tests that never init a logger) incur no logging side effects.
pub fn is_initialized() -> bool {
    ROOT.lock().unwrap_or_else(|p| p.into_inner()).is_some()
}

/// Returns a child logger tagged with a `component` name. Mirrors `child`.
pub fn child(component: &str) -> Logger {
    get_logger().child(component)
}

/// Mutes pretty terminal output (used by the client around PTY attach).
pub fn suspend_terminal() {
    set_terminal_suspended(true);
}

/// Restores pretty terminal output.
pub fn resume_terminal() {
    set_terminal_suspended(false);
}

/// Test helper: drops the cached root logger so the next `get_logger` re-inits.
pub fn reset_logger_for_tests() {
    *ROOT.lock().unwrap_or_else(|p| p.into_inner()) = None;
    set_terminal_suspended(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A `Write` sink that appends into a shared buffer (for capture tests).
    #[derive(Clone)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);
    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn temp_home() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/lt-test-homes")
            .join(format!("{}-{}-{}", std::process::id(), n, nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_role_logs(home: &Path, role: &str) -> String {
        let dir = home.join("logs").join(role);
        fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| fs::read_to_string(e.path()).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    }

    fn env_for(home: &Path) -> Env {
        Env::from_pairs([("CLIMON_HOME", home.to_str().unwrap())])
    }

    #[test]
    fn silent_level_creates_no_logs_dir_or_files() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Silent),
                env: Some(env_for(&home)),
                ..Default::default()
            },
        );
        get_logger().info("should not be written");
        assert!(!home.join("logs").exists());
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn non_silent_level_creates_the_role_dir() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                ..Default::default()
            },
        );
        get_logger().info("hello");
        assert!(home.join("logs").join("server").exists());
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn debug_records_reach_the_file_for_terminal_roles() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        // "server" is a terminal role; the file sink must capture the logger's
        // full level (not the pretty sink's info gate) or debug is dropped.
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Trace),
                env: Some(env_for(&home)),
                ..Default::default()
            },
        );
        get_logger().debug("debug-marker-xyz");
        let written = read_role_logs(&home, "server");
        assert!(written.contains("debug-marker-xyz"), "got: {written}");
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn every_record_includes_the_version() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                version: Some("1.2.3".to_string()),
                ..Default::default()
            },
        );
        get_logger().info("version-marker");
        let written = read_role_logs(&home, "server");
        let record: Value = written
            .lines()
            .find(|l| l.contains("version-marker"))
            .map(|l| serde_json::from_str(l).unwrap())
            .unwrap();
        assert_eq!(record["version"], Value::from("1.2.3"));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn install_id_attached_when_provided() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        let buf = Arc::new(Mutex::new(Vec::new()));
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                install_id: Some("11111111-2222-4333-8444-555555555555".to_string()),
                extra_streams: vec![(LogLevel::Info, Box::new(SharedBuf(buf.clone())))],
                ..Default::default()
            },
        );
        get_logger().info("hello");
        let captured = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let record: Value = serde_json::from_str(captured.trim().lines().last().unwrap()).unwrap();
        assert_eq!(
            record["installId"],
            Value::from("11111111-2222-4333-8444-555555555555")
        );
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn install_id_omitted_when_not_provided() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        let buf = Arc::new(Mutex::new(Vec::new()));
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                extra_streams: vec![(LogLevel::Info, Box::new(SharedBuf(buf.clone())))],
                ..Default::default()
            },
        );
        get_logger().info("hello");
        let captured = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        let record: Value = serde_json::from_str(captured.trim().lines().last().unwrap()).unwrap();
        assert!(record.get("installId").is_none());
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn child_logger_carries_a_component_binding() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                ..Default::default()
            },
        );
        get_logger().child("push").info("component-marker");
        let written = read_role_logs(&home, "server");
        let record: Value = written
            .lines()
            .find(|l| l.contains("component-marker"))
            .map(|l| serde_json::from_str(l).unwrap())
            .unwrap();
        assert_eq!(record["component"], Value::from("push"));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn suspend_and_resume_terminal_do_not_panic() {
        let _guard = crate::test_lock();
        reset_logger_for_tests();
        init_logger(
            LogRole::Client,
            LoggerInitOptions {
                level: Some(LogLevel::Silent),
                ..Default::default()
            },
        );
        suspend_terminal();
        resume_terminal();
        reset_logger_for_tests();
    }

    #[test]
    fn redaction_applies_to_emitted_records() {
        let _guard = crate::test_lock();
        let home = temp_home();
        reset_logger_for_tests();
        init_logger(
            LogRole::Server,
            LoggerInitOptions {
                level: Some(LogLevel::Info),
                env: Some(env_for(&home)),
                ..Default::default()
            },
        );
        get_logger().log_with(
            LogLevel::Info,
            serde_json::json!({ "token": "supersecret", "redact-marker": true }),
            "auth attempt",
        );
        let written = read_role_logs(&home, "server");
        assert!(written.contains("redact-marker"));
        assert!(!written.contains("supersecret"), "secret leaked: {written}");
        assert!(written.contains("[REDACTED]"));
        reset_logger_for_tests();
        let _ = fs::remove_dir_all(&home);
    }
}
