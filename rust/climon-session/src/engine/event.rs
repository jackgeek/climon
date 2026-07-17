//! Events: inputs to the actor's pure transition function.
//!
//! Every external occurrence the actor must react to — pty output/exit,
//! client lifecycle and frames, local input/resize, and completions/failures
//! of previously requested [`Effect`]s — is normalized into a
//! [`SessionEvent`] before it reaches the transition function.
//!
//! [`Effect`]: crate::engine::effect::Effect

// The actor implementation that constructs and matches on `SessionEvent`
// lands in a later task; until then it has no non-test consumer.
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
