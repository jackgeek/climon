//! Normalized, deterministic recordings of actor [`Effect`]s for tests.
//!
//! [`ObservableTrace`] strips operation/timer bookkeeping (ids that only exist
//! to correlate a completion event back to its effect) so assertions can
//! focus on the externally observable behavior of the actor: which bytes went
//! to which client, what was written to the pty/console, and so on.
//!
//! [`Effect`]: crate::engine::effect::Effect

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
