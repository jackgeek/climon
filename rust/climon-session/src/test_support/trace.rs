//! Normalized, deterministic recordings of actor [`Effect`]s for tests, plus a
//! recording logging sink for asserting the structured, payload-safe
//! observability records the coordinator and adapters emit.
//!
//! [`ObservableTrace`] strips operation/timer bookkeeping (ids that only exist
//! to correlate a completion event back to its effect) so assertions can
//! focus on the externally observable behavior of the actor: which bytes went
//! to which client, what was written to the pty/console, and so on.
//!
//! [`RecordingLogSink`] installs an in-process sink on the process-global logger
//! so a test can assert the *structured fields* of the emitted records (phase,
//! effect/failure kind, saturation, ids, payload lengths) rather than any
//! formatted NDJSON text — and prove no record ever carries payload bytes.
//!
//! [`Effect`]: crate::engine::effect::Effect

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::engine::effect::Effect;

/// A single normalized, externally observable outcome of an [`Effect`].
///
/// Operation ids, timer ids, and effects with no externally observable
/// footprint (killing the pty, closing a client, stopping the accept loop,
/// scheduling/cancelling timers) are intentionally not represented here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TraceRecord {
    /// Bytes written to the pty's stdin.
    PtyInput(Vec<u8>),
    /// A pty resize request.
    PtyResize { cols: u16, rows: u16 },
    /// Bytes sent to a specific client, keyed by its raw id.
    ClientBytes { client_id: u64, bytes: Vec<u8> },
    /// Bytes written to the local console.
    ConsoleBytes(Vec<u8>),
    /// A metadata patch, recorded via its `Debug` representation since
    /// `SessionMetaPatch` doesn't need a bespoke equality shape for tests.
    MetadataPatch { barrier: bool, debug: String },
    /// Bytes persisted to scrollback.
    Scrollback(Vec<u8>),
    /// Session completion with its exit code.
    Complete(i32),
}

/// Records a sequence of [`Effect`]s as normalized [`TraceRecord`]s.
#[derive(Debug, Default)]
pub(crate) struct ObservableTrace {
    records: Vec<TraceRecord>,
}

impl ObservableTrace {
    /// Normalizes and appends `effect`'s externally observable outcome, if
    /// any, to the trace.
    pub(crate) fn record_effect(&mut self, effect: &Effect) {
        let record = match effect {
            Effect::WritePty { bytes, .. } => TraceRecord::PtyInput(bytes.clone()),
            Effect::ResizePty { cols, rows, .. } => TraceRecord::PtyResize {
                cols: *cols,
                rows: *rows,
            },
            Effect::KillPty { .. } => return,
            Effect::SendClient {
                client_id, bytes, ..
            } => TraceRecord::ClientBytes {
                client_id: client_id.0,
                bytes: bytes.clone(),
            },
            Effect::CloseClient { .. } => return,
            Effect::StopAcceptingClients => return,
            Effect::WriteConsole { bytes, .. } => TraceRecord::ConsoleBytes(bytes.clone()),
            Effect::PatchMetadata { patch, barrier, .. } => TraceRecord::MetadataPatch {
                barrier: *barrier,
                debug: format!("{patch:?}"),
            },
            Effect::PersistScrollback { bytes, .. } => TraceRecord::Scrollback(bytes.clone()),
            Effect::ScheduleTimer { .. } => return,
            Effect::CancelTimer { .. } => return,
            Effect::CompleteSession { exit_code } => TraceRecord::Complete(*exit_code),
        };
        self.records.push(record);
    }

    /// Returns the normalized trace recorded so far.
    pub(crate) fn records(&self) -> &[TraceRecord] {
        &self.records
    }

    /// Every byte written to the local console, concatenated in record order.
    ///
    /// Lets a characterization test assert the exact local-terminal output a
    /// sequence of effects produced (e.g. the displaced-exit restore) without
    /// reaching into individual [`TraceRecord`]s.
    pub(crate) fn console_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for record in &self.records {
            if let TraceRecord::ConsoleBytes(bytes) = record {
                out.extend_from_slice(bytes);
            }
        }
        out
    }
}

// ---- recording logging sink --------------------------------------------

/// Serializes every test that installs a [`RecordingLogSink`], so two of them
/// cannot race on the process-global logger.
fn log_sink_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// An in-process byte buffer wired into the process-global logger as an extra
/// sink, capturing the NDJSON records emitted while installed.
#[derive(Clone)]
struct CaptureBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("capture buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A recording logging sink installed on the process-global daemon logger. While
/// held it captures every emitted record; on drop it restores the logger. It
/// serializes against other sinks via a process lock so parallel tests cannot
/// race the global logger, and points `CLIMON_HOME` at a throwaway directory so
/// the mandatory role log file never touches the real home.
pub(crate) struct RecordingLogSink {
    buffer: Arc<Mutex<Vec<u8>>>,
    _guard: MutexGuard<'static, ()>,
}

impl RecordingLogSink {
    /// Installs the recording sink at `trace` level and returns it. Assertions
    /// read [`records`](RecordingLogSink::records) / [`raw`](RecordingLogSink::raw).
    pub(crate) fn install() -> Self {
        let guard = log_sink_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        climon_logging::logger::reset_logger_for_tests();
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let home = scratch_log_home();
        climon_logging::logger::init_logger(
            climon_logging::sinks::LogRole::Daemon,
            climon_logging::logger::LoggerInitOptions {
                level: Some(climon_logging::level::LogLevel::Trace),
                env: Some(climon_logging::env::Env::from_pairs([(
                    "CLIMON_HOME",
                    home.to_string_lossy().as_ref(),
                )])),
                session_id: Some("stress-observability".to_string()),
                extra_streams: vec![(
                    climon_logging::level::LogLevel::Trace,
                    Box::new(CaptureBuffer(buffer.clone())),
                )],
                ..Default::default()
            },
        );
        RecordingLogSink {
            buffer,
            _guard: guard,
        }
    }

    /// The captured records, parsed from NDJSON into structured values so a test
    /// can assert on *fields*, never on formatted text.
    pub(crate) fn records(&self) -> Vec<Value> {
        let bytes = self.buffer.lock().expect("capture buffer poisoned").clone();
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// The raw captured bytes, for asserting that no payload bytes ever appear.
    pub(crate) fn raw(&self) -> String {
        String::from_utf8_lossy(&self.buffer.lock().expect("capture buffer poisoned")).into_owned()
    }
}

impl Drop for RecordingLogSink {
    fn drop(&mut self) {
        climon_logging::logger::reset_logger_for_tests();
    }
}

/// A unique throwaway `CLIMON_HOME` under `target/` (never the system temp dir),
/// so the daemon role log file the logger insists on creating is isolated.
fn scratch_log_home() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/climon-session-stress-logs")
        .join(format!("{}-{nanos}-{n}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    home
}

#[cfg(test)]
mod tests {
    use crate::engine::effect::{ClientId, Effect, OperationId};
    use climon_proto::frame::{DecodedFrame, FrameType};

    use super::{ObservableTrace, TraceRecord};

    #[test]
    fn trace_preserves_client_frame_bytes() {
        let effect = Effect::SendClient {
            client_id: ClientId(7),
            operation_id: OperationId(11),
            bytes: vec![0, 0, 0, 1, FrameType::Output as u8, b'x'],
        };
        let mut trace = ObservableTrace::default();
        trace.record_effect(&effect);
        assert_eq!(
            trace.records(),
            &[TraceRecord::ClientBytes {
                client_id: 7,
                bytes: vec![0, 0, 0, 1, 1, b'x'],
            }]
        );

        let frame = DecodedFrame {
            frame_type: FrameType::Input,
            payload: vec![b'y'],
        };
        assert_eq!(frame.payload, b"y");
    }
}
