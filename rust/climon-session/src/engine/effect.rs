//! Effects: side-effect requests emitted by the actor's pure transition
//! function.
//!
//! The actor core is expressed as a pure `(state, event) -> (state, Vec<Effect>)`
//! transition. Every interaction with the outside world — the pty, connected
//! clients, the console, persisted metadata/scrollback, timers, and session
//! completion — is represented as a value here rather than performed inline,
//! so the transition function stays synchronous and unit-testable.

// The aggregate actor state (`engine::state`) constructs and matches on every
// effect variant; the coordinator that performs them against real I/O lands in
// a later task.

use std::time::Duration;

use climon_proto::meta::SessionMetaPatch;

/// Identifies a connected IPC/dashboard client for the lifetime of its
/// connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ClientId(pub u64);

/// Correlates a requested effect with the completion/failure event it later
/// produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct OperationId(pub u64);

/// Identifies a scheduled timer so a stale firing (e.g. after cancellation
/// and rescheduling) can be detected via its `generation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct TimerId(pub u64);

/// A side effect requested by the actor's transition function.
// `PatchMetadata`'s `SessionMetaPatch` payload is much larger than the other
// variants; boxing it would obscure the direct field access this crate-private
// enum is matched on everywhere, so the size difference is accepted here.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Effect {
    /// Write bytes to the pty's stdin.
    WritePty {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    /// Resize the pty's tty grid.
    ResizePty {
        operation_id: OperationId,
        cols: u16,
        rows: u16,
    },
    /// Terminate the pty's child process.
    KillPty { operation_id: OperationId },
    /// Send encoded frame bytes to a specific connected client.
    SendClient {
        client_id: ClientId,
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    /// Close a client's connection.
    CloseClient { client_id: ClientId },
    /// Stop accepting new client connections on the session socket.
    StopAcceptingClients,
    /// Write bytes to the local attached terminal/console.
    WriteConsole {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    /// Persist a metadata patch. `barrier` marks a patch that must be durably
    /// applied before any later effect that depends on it is observable.
    PatchMetadata {
        operation_id: OperationId,
        patch: SessionMetaPatch,
        barrier: bool,
    },
    /// Persist scrollback bytes.
    PersistScrollback {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    /// Schedule a timer to fire after `delay`. `generation` distinguishes this
    /// scheduling from any prior one for the same `timer_id`.
    ScheduleTimer {
        timer_id: TimerId,
        generation: u64,
        delay: Duration,
    },
    /// Cancel a previously scheduled timer, identified by its `generation`.
    CancelTimer { timer_id: TimerId, generation: u64 },
    /// Mark the session complete with the given process exit code.
    CompleteSession { exit_code: i32 },
}
