//! Events: inputs to the actor's pure transition function.
//!
//! Every external occurrence the actor must react to — pty output/exit,
//! client lifecycle and frames, local input/resize, and completions/failures
//! of previously requested [`Effect`]s — is normalized into a
//! [`SessionEvent`] before it reaches the transition function.
//!
//! [`Effect`]: crate::engine::effect::Effect

// The aggregate actor state (`engine::state`) matches on every event; the
// variants are constructed by `test_support` now and by the coordinator that
// feeds real I/O later, so they have no non-test constructor yet.
#![allow(dead_code)]

use climon_proto::frame::DecodedFrame;

use crate::engine::effect::{ClientId, OperationId, TimerId};

/// An event delivered to the actor's transition function.
#[derive(Debug)]
pub(crate) enum SessionEvent {
    /// The pty produced output bytes.
    PtyOutput(Vec<u8>),
    /// The pty's child process exited with this code.
    PtyExited(i32),
    /// The pty could not be started or failed unrecoverably.
    PtyFailed(String),
    /// A new client connected.
    ClientConnected(ClientId),
    /// A client sent a decoded frame.
    ClientFrame {
        client_id: ClientId,
        frame: DecodedFrame,
    },
    /// A client's connection closed.
    ClientDisconnected(ClientId),
    /// A previously requested send to a client failed.
    ClientSendFailed {
        client_id: ClientId,
        operation_id: OperationId,
    },
    /// The local attached terminal produced input bytes.
    LocalInput(Vec<u8>),
    /// The local attached terminal was resized.
    LocalResized { cols: u16, rows: u16 },
    /// A previously requested console write completed successfully.
    ConsoleWriteCompleted(OperationId),
    /// A previously requested console write failed.
    ConsoleWriteFailed {
        operation_id: OperationId,
        error: String,
    },
    /// A previously scheduled timer fired.
    TimerFired { timer_id: TimerId, generation: u64 },
    /// A previously requested metadata patch completed successfully.
    MetadataCompleted(OperationId),
    /// A previously requested metadata patch failed.
    MetadataFailed {
        operation_id: OperationId,
        error: String,
    },
    /// The host requested a graceful shutdown.
    ShutdownRequested,
}

/// The lane a [`SessionEvent`] is delivered on. The pty lane carries only the
/// pty's own output/exit/failure; every other event travels the control lane.
/// The coordinator's typed lane senders use this to reject wrong-lane events
/// instead of silently rerouting them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventLane {
    /// Pty output/exit/failure only.
    Pty,
    /// Everything else (client, local, timer, completion, shutdown).
    Control,
}

/// A payload-free classification of a [`SessionEvent`]. Recording and logging
/// use this instead of the event itself so terminal/user bytes (pty output,
/// local input, client frames) never enter a trace or log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventKind {
    PtyOutput,
    PtyExited,
    PtyFailed,
    ClientConnected,
    ClientFrame,
    ClientDisconnected,
    ClientSendFailed,
    LocalInput,
    LocalResized,
    ConsoleWriteCompleted,
    ConsoleWriteFailed,
    TimerFired,
    MetadataCompleted,
    MetadataFailed,
    ShutdownRequested,
}

impl SessionEvent {
    /// The payload-free [`EventKind`] of this event, safe to record or log.
    pub(crate) fn kind(&self) -> EventKind {
        match self {
            SessionEvent::PtyOutput(_) => EventKind::PtyOutput,
            SessionEvent::PtyExited(_) => EventKind::PtyExited,
            SessionEvent::PtyFailed(_) => EventKind::PtyFailed,
            SessionEvent::ClientConnected(_) => EventKind::ClientConnected,
            SessionEvent::ClientFrame { .. } => EventKind::ClientFrame,
            SessionEvent::ClientDisconnected(_) => EventKind::ClientDisconnected,
            SessionEvent::ClientSendFailed { .. } => EventKind::ClientSendFailed,
            SessionEvent::LocalInput(_) => EventKind::LocalInput,
            SessionEvent::LocalResized { .. } => EventKind::LocalResized,
            SessionEvent::ConsoleWriteCompleted(_) => EventKind::ConsoleWriteCompleted,
            SessionEvent::ConsoleWriteFailed { .. } => EventKind::ConsoleWriteFailed,
            SessionEvent::TimerFired { .. } => EventKind::TimerFired,
            SessionEvent::MetadataCompleted(_) => EventKind::MetadataCompleted,
            SessionEvent::MetadataFailed { .. } => EventKind::MetadataFailed,
            SessionEvent::ShutdownRequested => EventKind::ShutdownRequested,
        }
    }

    /// The [`EventLane`] this event must be delivered on.
    pub(crate) fn lane(&self) -> EventLane {
        match self {
            SessionEvent::PtyOutput(_)
            | SessionEvent::PtyExited(_)
            | SessionEvent::PtyFailed(_) => EventLane::Pty,
            _ => EventLane::Control,
        }
    }
}
