# Idiomatic Rust Session Daemon Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mutex-based `climon-session` host with a Tokio coordinator actor and owned resource adapters while preserving every observable protocol, metadata, PTY, and local-terminal behavior.

**Architecture:** A synchronous facade selects either the legacy host or a new actor engine. The actor engine owns authoritative state in one coordinator task, expresses behavior as typed events and effects, and delegates all blocking PTY, socket, metadata, console, timer, and signal work to supervised adapters with bounded channels. Shared characterization scenarios run against both engines before the actor engine becomes the default.

**Tech Stack:** Rust 2021, Tokio 1 (`rt-multi-thread`, `sync`, `time`, `macros`), `tokio-util::CancellationToken`, existing `portable-pty`, `vt100`, `climon-proto`, `climon-store`, and `climon-logging`.

**Spec:** `docs/superpowers/specs/2026-07-17-idiomatic-rust-daemon-rewrite-design.md`

**Working branch:** `design/idiomatic-daemon-rewrite` in `.worktrees/design-idiomatic-daemon-rewrite`.

---

## Non-negotiable execution rules

1. Invoke `superpowers:test-driven-development` before implementation starts.
2. For every production change, write one focused test, run it, and observe the expected failure before writing production code.
3. Never retain production code written before its failing test.
4. Use a fresh implementation subagent for each task and complete both required reviews from `superpowers:subagent-driven-development` before starting the next task.
5. Preserve exact frame bytes, frame order, metadata schema, socket references, and the public `run_session_host(id, meta, options)` signature.
6. Do not flip the default engine until Task 16's release gate passes.

## File map

### Stable facade and legacy engine

- `rust/climon-session/src/host/mod.rs` — public facade, engine selection, synchronous runtime boundary.
- `rust/climon-session/src/host/legacy.rs` — current `host.rs`, unchanged except imports needed by the move.
- `rust/climon-session/src/lib.rs` — exports the stable facade and actor modules.

### Actor engine

- `rust/climon-session/src/engine/mod.rs` — engine entry point and shared channel constants.
- `rust/climon-session/src/engine/event.rs` — typed `SessionEvent`, ids, failure classifications.
- `rust/climon-session/src/engine/effect.rs` — typed `Effect` and adapter command enums.
- `rust/climon-session/src/engine/state.rs` — aggregate `SessionState` and transition dispatch.
- `rust/climon-session/src/engine/coordinator.rs` — two-lane arbitration and effect dispatch.
- `rust/climon-session/src/engine/supervisor.rs` — runtime startup, cancellation, task ownership, joins.

### Domain components

- `rust/climon-session/src/domain/mod.rs` — domain exports.
- `rust/climon-session/src/domain/clients.rs` — logical client registry and initial-frame state.
- `rust/climon-session/src/domain/control.rs` — controller selection and PTY-size decisions.
- `rust/climon-session/src/domain/terminal.rs` — scrollback, grid, mode/title/progress parsing, replay.
- `rust/climon-session/src/domain/attention.rs` — idle and acknowledgement transitions.
- `rust/climon-session/src/domain/local_view.rs` — suppression, notices, restore, and jiggle protocol.
- `rust/climon-session/src/domain/lifecycle.rs` — start, drain, finalization, stop transitions.

### Resource adapters

- `rust/climon-session/src/adapters/mod.rs` — adapter exports and command senders.
- `rust/climon-session/src/adapters/pty.rs` — exclusive PTY ownership and blocking bridge.
- `rust/climon-session/src/adapters/ipc.rs` — listener and connection ownership.
- `rust/climon-session/src/adapters/metadata.rs` — ordered patch and scrollback writer.
- `rust/climon-session/src/adapters/local_terminal.rs` — raw mode, stdin/stdout, local resize.
- `rust/climon-session/src/adapters/timers.rs` — typed generation-safe deadlines.
- `rust/climon-session/src/adapters/signals.rs` — termination and Unix resize signals.

### Tests and documentation

- `rust/climon-session/src/test_support/mod.rs` — deterministic harness exports.
- `rust/climon-session/src/test_support/harness.rs` — event-in/effect-out coordinator harness.
- `rust/climon-session/src/test_support/trace.rs` — normalized observable trace.
- `rust/climon-session/tests/engine_parity.rs` — shared legacy/actor characterization scenarios.
- `rust/climon-session/tests/actor_stress.rs` — bounded-queue and fault-injection tests.
- `rust/climon-session/tests/session_integration.rs` — existing real PTY/socket tests parameterized by engine.
- `docs/manual-tests/daemon-actor-rewrite.md` — platform release-gate checks.
- `docs/manual-tests/README.md` — manual-test index.
- `docs/architecture.md` — actor ownership and lifecycle.
- `docs/features.md` — update `cli-07` source/implementation description without changing maturity.

---

### Task 1: Create the stable facade and internal engine selector

**Files:**
- Modify: `rust/climon-session/Cargo.toml`
- Modify: `rust/climon-session/src/lib.rs`
- Move: `rust/climon-session/src/host.rs` to `rust/climon-session/src/host/legacy.rs`
- Create: `rust/climon-session/src/host/mod.rs`
- Test: `rust/climon-session/src/host/mod.rs`

- [ ] **Step 1: Write the failing selector tests**

Create `rust/climon-session/src/host/mod.rs` with tests only:

```rust
#[cfg(test)]
mod tests {
    use super::{selected_engine, Engine};

    #[test]
    fn selector_defaults_to_legacy() {
        assert_eq!(selected_engine(None).unwrap(), Engine::Legacy);
    }

    #[test]
    fn selector_accepts_actor() {
        assert_eq!(selected_engine(Some("actor")).unwrap(), Engine::Actor);
    }

    #[test]
    fn selector_rejects_unknown_values() {
        let err = selected_engine(Some("future")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "invalid CLIMON_SESSION_ENGINE 'future'; expected 'legacy' or 'actor'"
        );
    }
}
```

- [ ] **Step 2: Run the test and verify RED**

Run from `rust/`:

```bash
cargo test -p climon-session --lib host::tests::selector
```

Expected: compilation fails because `Engine` and `selected_engine` do not exist.

- [ ] **Step 3: Move the legacy implementation**

Run:

```bash
mkdir -p climon-session/src/host
git mv climon-session/src/host.rs climon-session/src/host/legacy.rs
```

In `legacy.rs`, change only paths broken by the module move. Do not alter behavior.

- [ ] **Step 4: Implement the selector and facade**

Add above the tests in `host/mod.rs`:

```rust
mod legacy;

use std::ffi::OsStr;

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};

pub use legacy::SessionHostOptions;

const ENGINE_ENV: &str = "CLIMON_SESSION_ENGINE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    Legacy,
    Actor,
}

fn selected_engine(value: Option<&str>) -> SessionResult<Engine> {
    match value {
        None | Some("") | Some("legacy") => Ok(Engine::Legacy),
        Some("actor") => Ok(Engine::Actor),
        Some(value) => Err(SessionError::InvalidEngine(value.to_string())),
    }
}

pub fn run_session_host(
    id: &str,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    let value = std::env::var_os(ENGINE_ENV);
    match selected_engine(value.as_deref().and_then(OsStr::to_str))? {
        Engine::Legacy => legacy::run_session_host(id, meta, options),
        Engine::Actor => crate::engine::run_session_host(id, meta, options),
    }
}
```

Add `InvalidEngine(String)` to `SessionError` and its `Display` match:

```rust
InvalidEngine(String),
```

```rust
SessionError::InvalidEngine(value) => write!(
    f,
    "invalid CLIMON_SESSION_ENGINE '{value}'; expected 'legacy' or 'actor'"
),
```

Create a temporary actor stub in `src/engine/mod.rs`:

```rust
use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};
use crate::host::SessionHostOptions;

pub fn run_session_host(
    _id: &str,
    _meta: SessionMeta,
    _options: SessionHostOptions,
) -> SessionResult<i32> {
    Err(SessionError::ActorUnavailable)
}
```

Add `ActorUnavailable` and display it as `actor session engine is not available`.

Export `pub mod engine;` from `lib.rs`.

- [ ] **Step 5: Add Tokio dependencies**

Add to `climon-session/Cargo.toml`:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "sync", "time", "macros", "test-util"] }
tokio-util = { version = "0.7", features = ["rt"] }
```

- [ ] **Step 6: Run selector and legacy integration tests**

```bash
cargo test -p climon-session --lib host::tests
cargo test -p climon-session --test session_integration
```

Expected: PASS; integration tests use the legacy default.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-session
git commit -m "refactor(session): add daemon engine facade"
```

---

### Task 2: Define typed events, effects, ids, and normalized traces

**Files:**
- Create: `rust/climon-session/src/engine/event.rs`
- Create: `rust/climon-session/src/engine/effect.rs`
- Create: `rust/climon-session/src/test_support/mod.rs`
- Create: `rust/climon-session/src/test_support/trace.rs`
- Modify: `rust/climon-session/src/engine/mod.rs`
- Modify: `rust/climon-session/src/lib.rs`

- [ ] **Step 1: Write the failing identity and trace tests**

In `test_support/trace.rs`:

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::{DecodedFrame, FrameType};

    use crate::engine::effect::{ClientId, Effect, OperationId};

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
```

- [ ] **Step 2: Run the test and verify RED**

```bash
cargo test -p climon-session --lib trace_preserves_client_frame_bytes
```

Expected: compilation fails because the event, effect, and trace types do not exist.

- [ ] **Step 3: Add the core ids and effect enum**

In `engine/effect.rs`:

```rust
use climon_proto::meta::SessionMetaPatch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OperationId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    WritePty {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    ResizePty {
        operation_id: OperationId,
        cols: u16,
        rows: u16,
    },
    KillPty {
        operation_id: OperationId,
    },
    SendClient {
        client_id: ClientId,
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    CloseClient {
        client_id: ClientId,
    },
    StopAcceptingClients,
    WriteConsole {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    PatchMetadata {
        operation_id: OperationId,
        patch: SessionMetaPatch,
        barrier: bool,
    },
    PersistScrollback {
        operation_id: OperationId,
        bytes: Vec<u8>,
    },
    ScheduleTimer {
        timer_id: TimerId,
        generation: u64,
        delay: std::time::Duration,
    },
    CancelTimer {
        timer_id: TimerId,
        generation: u64,
    },
    CompleteSession {
        exit_code: i32,
    },
}
```

Do not derive `Eq` for `Effect` if `SessionMetaPatch` prevents it; derive
`Debug, Clone, PartialEq` and keep tests on concrete variants.

- [ ] **Step 4: Add the event enum**

In `engine/event.rs`:

```rust
use climon_proto::frame::DecodedFrame;

use super::effect::{ClientId, OperationId, TimerId};

#[derive(Debug)]
pub enum SessionEvent {
    PtyOutput(Vec<u8>),
    PtyExited(i32),
    PtyFailed(String),
    ClientConnected(ClientId),
    ClientFrame {
        client_id: ClientId,
        frame: DecodedFrame,
    },
    ClientDisconnected(ClientId),
    ClientSendFailed {
        client_id: ClientId,
        operation_id: OperationId,
    },
    LocalInput(Vec<u8>),
    LocalResized {
        cols: u16,
        rows: u16,
    },
    ConsoleWriteCompleted(OperationId),
    ConsoleWriteFailed {
        operation_id: OperationId,
        error: String,
    },
    TimerFired {
        timer_id: TimerId,
        generation: u64,
    },
    MetadataCompleted(OperationId),
    MetadataFailed {
        operation_id: OperationId,
        error: String,
    },
    ShutdownRequested,
}
```

- [ ] **Step 5: Add normalized trace records**

In `test_support/trace.rs`:

```rust
use crate::engine::effect::Effect;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceRecord {
    PtyInput(Vec<u8>),
    PtyResize { cols: u16, rows: u16 },
    ClientBytes { client_id: u64, bytes: Vec<u8> },
    ConsoleBytes(Vec<u8>),
    MetadataPatch { barrier: bool, debug: String },
    Scrollback(Vec<u8>),
    Complete(i32),
}

#[derive(Default)]
pub struct ObservableTrace {
    records: Vec<TraceRecord>,
}

impl ObservableTrace {
    pub fn record_effect(&mut self, effect: &Effect) {
        let record = match effect {
            Effect::WritePty { bytes, .. } => TraceRecord::PtyInput(bytes.clone()),
            Effect::ResizePty { cols, rows, .. } => TraceRecord::PtyResize {
                cols: *cols,
                rows: *rows,
            },
            Effect::SendClient {
                client_id, bytes, ..
            } => TraceRecord::ClientBytes {
                client_id: client_id.0,
                bytes: bytes.clone(),
            },
            Effect::WriteConsole { bytes, .. } => TraceRecord::ConsoleBytes(bytes.clone()),
            Effect::PatchMetadata { patch, barrier, .. } => TraceRecord::MetadataPatch {
                barrier: *barrier,
                debug: format!("{patch:?}"),
            },
            Effect::PersistScrollback { bytes, .. } => TraceRecord::Scrollback(bytes.clone()),
            Effect::CompleteSession { exit_code } => TraceRecord::Complete(*exit_code),
            Effect::KillPty { .. }
            | Effect::CloseClient { .. }
            | Effect::StopAcceptingClients
            | Effect::ScheduleTimer { .. }
            | Effect::CancelTimer { .. } => return,
        };
        self.records.push(record);
    }

    pub fn records(&self) -> &[TraceRecord] {
        &self.records
    }
}
```

Export modules from `engine/mod.rs` and `test_support/mod.rs`. Export
`#[doc(hidden)] pub mod test_support;` from `lib.rs` so integration tests can use
the harness without a feature-dependent second build of the crate.

- [ ] **Step 6: Run tests and commit**

```bash
cargo test -p climon-session --lib trace_preserves_client_frame_bytes
cargo test -p climon-session --lib
git add rust/climon-session
git commit -m "feat(session): define actor events and effects"
```

---

### Task 3: Implement client registry and control transitions

**Files:**
- Create: `rust/climon-session/src/domain/mod.rs`
- Create: `rust/climon-session/src/domain/clients.rs`
- Create: `rust/climon-session/src/domain/control.rs`
- Modify: `rust/climon-session/src/engine/state.rs`
- Test: inline tests in `domain/clients.rs` and `domain/control.rs`

- [ ] **Step 1: Write failing tests for initial-frame membership and fallback**

In `domain/clients.rs`:

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::SurfaceKind;

    use crate::engine::effect::ClientId;

    use super::ClientRegistry;

    #[test]
    fn client_joins_broadcasts_only_after_initialization() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(1));
        assert!(clients.broadcast_recipients().is_empty());
        clients.update_surface(ClientId(1), "dash", SurfaceKind::Dashboard, 100, 30);
        clients.mark_initialized(ClientId(1));
        assert_eq!(clients.broadcast_recipients(), vec![ClientId(1)]);
    }
}
```

In `domain/control.rs`:

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::SurfaceKind;

    use super::{ControlState, SurfaceState};

    #[test]
    fn disconnected_controller_falls_back_by_priority_then_recency() {
        let mut control = ControlState::new(80, 24, true);
        control.upsert(SurfaceState::new("dash", SurfaceKind::Dashboard, 100, 30, 1));
        control.upsert(SurfaceState::new("pwa", SurfaceKind::Pwa, 90, 28, 2));
        control.take_control("dash");
        control.remove("dash");
        let change = control.recompute().unwrap();
        assert_eq!(change.controller_id, "pwa");
        assert_eq!((change.cols, change.rows), (90, 28));
    }
}
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cargo test -p climon-session --lib client_joins_broadcasts_only_after_initialization
cargo test -p climon-session --lib disconnected_controller_falls_back_by_priority_then_recency
```

Expected: compilation fails because the domain types do not exist.

- [ ] **Step 3: Implement `ClientRegistry`**

Use a `HashMap<ClientId, ClientState>` with:

```rust
pub struct ClientState {
    pub viewer_id: String,
    pub kind: SurfaceKind,
    pub cols: u16,
    pub rows: u16,
    pub seq: u64,
    pub initialized: bool,
}
```

`connect` inserts the existing defaults (`client-<id>`, dashboard, zero size,
uninitialized). `update_surface` clamps dimensions to one. `mark_initialized`
assigns the next sequence number exactly once. `broadcast_recipients` returns
initialized ids sorted by numeric `ClientId` for deterministic tests.

- [ ] **Step 4: Implement `ControlState`**

Reuse `choose_controller` from the existing `control.rs`; move that file into
`domain/control.rs` with `git mv`, then add:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlChange {
    pub controller_id: String,
    pub cols: u16,
    pub rows: u16,
    pub size_changed: bool,
}
```

`ControlState` owns host size, applied size, optional controller id, local
attachment, and `SurfaceState` values. Implement `report_size`, `take_control`,
`remove`, and `recompute` without I/O. Preserve local id `"local"` and existing
priority `pwa > dashboard > terminal`, then recency.

- [ ] **Step 5: Run focused and existing control tests**

```bash
cargo test -p climon-session --lib domain::clients
cargo test -p climon-session --lib domain::control
```

Expected: PASS, including all tests moved from the old `control.rs`.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-session/src/domain rust/climon-session/src/lib.rs
git commit -m "feat(session): add actor client and control state"
```

---

### Task 4: Implement the terminal model as a pure component

**Files:**
- Create: `rust/climon-session/src/domain/terminal.rs`
- Modify: `rust/climon-session/src/domain/mod.rs`
- Test: `rust/climon-session/src/domain/terminal.rs`

- [ ] **Step 1: Write the failing terminal transition test**

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::{FrameDecoder, FrameType};

    use super::TerminalModel;

    #[test]
    fn output_updates_replay_grid_modes_and_passthrough_frame() {
        let mut terminal = TerminalModel::new(80, 24, 256 * 1024);
        let update = terminal.apply_output(b"\x1b]0;build\x07hello\x1b[?1000h");
        let decoded = FrameDecoder::new().push(&update.output_frame);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"\x1b]0;build\x07hello\x1b[?1000h");
        assert!(terminal.replay_snapshot().windows(5).any(|w| w == b"hello"));
        assert_eq!(terminal.captured_title(), Some("build"));
        assert!(terminal.mouse_mode_enabled("1000"));
    }
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib output_updates_replay_grid_modes_and_passthrough_frame
```

Expected: compilation fails because `TerminalModel` does not exist.

- [ ] **Step 3: Implement `TerminalModel`**

Move no behavior into adapters. `TerminalModel` owns the existing:

```rust
pub struct TerminalModel {
    scrollback: climon_pty::Scrollback,
    grid: crate::fingerprint::HeadlessGrid,
    mouse_mode_state: HashMap<String, bool>,
    mouse_mode_remainder: String,
    terminal_title_remainder: String,
    captured_terminal_title: Option<String>,
    captured_progress: Option<Option<TerminalProgress>>,
}
```

`apply_output` must execute the current `spawn_reader_thread` mutation order:
mouse modes, title/progress, scrollback, grid, encoded `Output` frame. Reuse
`track_mouse_private_modes_from_output`, `capture_terminal_output`, and
`build_mouse_private_mode_replay_suffix`. Add `resize`, `fingerprint`,
`visible_lines`, `cursor_row`, `render_host_screen`, `replay_snapshot`,
`scrollback_snapshot`, `captured_title`, and `captured_progress`.

- [ ] **Step 4: Run terminal and helper tests**

```bash
cargo test -p climon-session --lib domain::terminal
cargo test -p climon-session --lib fingerprint
cargo test -p climon-session --lib replay
cargo test -p climon-session --lib title_capture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-session/src/domain
git commit -m "feat(session): add pure terminal model"
```

---

### Task 5: Implement attention transitions without store I/O

**Files:**
- Create: `rust/climon-session/src/domain/attention.rs`
- Modify: `rust/climon-session/src/domain/mod.rs`
- Test: `rust/climon-session/src/domain/attention.rs`

- [ ] **Step 1: Write the failing acknowledgement test**

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::AttentionPayload;
    use climon_proto::meta::SessionStatus;

    use super::{AttentionSource, AttentionState};

    #[test]
    fn matching_user_acknowledgement_emits_acknowledged_patch() {
        let mut state = AttentionState::new(1, false);
        let flagged = state.sample("80x24\nprompt", 1_000).unwrap();
        state.mark_patch_applied(&flagged, "matched-at");
        let transition = state
            .apply_user(
                AttentionPayload {
                    needs_attention: false,
                    reason: None,
                    attention_matched_at: Some("matched-at".into()),
                },
                "80x24\nprompt",
                SessionStatus::NeedsAttention,
            )
            .unwrap();
        assert_eq!(transition.status, SessionStatus::Acknowledged);
        assert_eq!(transition.source, AttentionSource::User);
        assert_eq!(transition.patch.attention_matched_at, Some(None));
    }
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib matching_user_acknowledgement_emits_acknowledged_patch
```

Expected: compilation fails because `AttentionState` does not exist.

- [ ] **Step 3: Implement `AttentionState`**

Move the current attention bookkeeping and `ScreenIdleDetector` ownership from
`HostState` into this component. Return:

```rust
pub struct AttentionTransition {
    pub source: AttentionSource,
    pub status: SessionStatus,
    pub patch: SessionMetaPatch,
}
```

Do not call `climon_store` or logging here. Preserve paused-session suppression,
matching-token/fingerprint acknowledgement, `Acknowledged` stickiness, snippet
extraction, and the current reason strings.

- [ ] **Step 4: Run attention and idle tests**

```bash
cargo test -p climon-session --lib domain::attention
cargo test -p climon-session --lib attention
cargo test -p climon-session --lib idle
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-session/src/domain/attention.rs rust/climon-session/src/domain/mod.rs
git commit -m "feat(session): isolate attention state transitions"
```

---

### Task 6: Implement the two-phase local-view restore protocol

**Files:**
- Create: `rust/climon-session/src/domain/local_view.rs`
- Modify: `rust/climon-session/src/domain/mod.rs`
- Test: `rust/climon-session/src/domain/local_view.rs`

- [ ] **Step 1: Write the failing two-phase restore test**

```rust
#[cfg(test)]
mod tests {
    use crate::engine::effect::OperationId;

    use super::{LocalViewAction, LocalViewState};

    #[test]
    fn restore_stays_suppressed_until_matching_console_completion() {
        let mut state = LocalViewState::attached(80, 24);
        state.controller_changed("dash", 100, 30);
        state.controller_changed("local", 80, 24);
        let action = state.restore_due(OperationId(9), b"repaint".to_vec());
        assert_eq!(
            action,
            LocalViewAction::WriteRestore {
                operation_id: OperationId(9),
                bytes: b"repaint".to_vec(),
            }
        );
        assert!(state.output_suppressed());
        assert!(!state.console_write_completed(OperationId(8)));
        assert!(state.output_suppressed());
        assert!(state.console_write_completed(OperationId(9)));
        assert!(!state.output_suppressed());
        assert!(state.jiggle_pending());
    }
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib restore_stays_suppressed_until_matching_console_completion
```

Expected: compilation fails because `LocalViewState` does not exist.

- [ ] **Step 3: Implement local-view state**

Move pure helpers from legacy host: `local_restore_decision`,
`local_stdin_action`, `local_displaced_by_controller`, `local_exit_restore_bytes`,
`jiggle_rows`, `jiggle_size`, and `JiggleLeg`.

`LocalViewState` owns:

```rust
pub struct LocalViewState {
    attached: bool,
    host_cols: u16,
    host_rows: u16,
    output_suppressed: bool,
    notice_size: Option<(u16, u16)>,
    restore_generation: u64,
    pending_console_write: Option<OperationId>,
    pending_jiggle: Option<JiggleLeg>,
    degraded: bool,
}
```

It returns `LocalViewAction` values; it never writes stdout, resizes the PTY, or
schedules timers itself. A failed matching console operation sets `degraded`,
keeps output suppressed, and cancels restore/jiggle state.

- [ ] **Step 4: Run local-view tests**

```bash
cargo test -p climon-session --lib domain::local_view
```

Expected: PASS, including all pure helper tests moved from legacy host.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-session/src/domain/local_view.rs rust/climon-session/src/domain/mod.rs
git commit -m "feat(session): model local restore as explicit protocol"
```

---

### Task 7: Implement lifecycle state and ordered finalization

**Files:**
- Create: `rust/climon-session/src/domain/lifecycle.rs`
- Modify: `rust/climon-session/src/domain/mod.rs`
- Test: `rust/climon-session/src/domain/lifecycle.rs`

- [ ] **Step 1: Write the failing finalization-order test**

```rust
#[cfg(test)]
mod tests {
    use super::{FinalizationStep, LifecycleState};

    #[test]
    fn pty_exit_finalizes_scrollback_metadata_clients_then_local_restore() {
        let mut state = LifecycleState::running();
        assert!(state.begin_exit(3));
        assert_eq!(
            state.pending_steps(),
            &[
                FinalizationStep::PersistScrollback,
                FinalizationStep::PatchTerminalStatus,
                FinalizationStep::SendExitFrames,
                FinalizationStep::RestoreLocalScreen,
                FinalizationStep::CloseClients,
            ]
        );
        assert!(!state.begin_exit(9), "duplicate exit is idempotent");
        assert_eq!(state.exit_code(), Some(3));
    }
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib pty_exit_finalizes_scrollback_metadata_clients_then_local_restore
```

Expected: compilation fails because lifecycle types do not exist.

- [ ] **Step 3: Implement lifecycle phases**

Define:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Starting,
    Running,
    Draining,
    Finalizing,
    Stopped,
}
```

Track one exit code, the ordered finalization steps, in-flight operation ids,
and completion. `begin_exit` is idempotent. `complete_step` rejects stale or
out-of-order completions. Core failure maps to exit code `1` and failed metadata.

- [ ] **Step 4: Run lifecycle tests and commit**

```bash
cargo test -p climon-session --lib domain::lifecycle
git add rust/climon-session/src/domain/lifecycle.rs rust/climon-session/src/domain/mod.rs
git commit -m "feat(session): add explicit daemon lifecycle"
```

---

### Task 8: Build aggregate state transitions and deterministic harness

**Files:**
- Create: `rust/climon-session/src/engine/state.rs`
- Create: `rust/climon-session/src/test_support/harness.rs`
- Modify: `rust/climon-session/src/test_support/mod.rs`
- Test: `rust/climon-session/src/engine/state.rs`

- [ ] **Step 1: Write the failing output transition test**

```rust
#[cfg(test)]
mod tests {
    use climon_proto::frame::{FrameDecoder, FrameType};

    use crate::test_support::harness::ActorHarness;

    #[test]
    fn pty_output_updates_state_before_broadcast_and_local_write() {
        let mut harness = ActorHarness::headless();
        harness.connect_initialized_dashboard(1, "dash", 80, 24);
        let effects = harness.pty_output(b"hello");
        let client = effects
            .iter()
            .find_map(|effect| effect.client_bytes())
            .expect("client output");
        let decoded = FrameDecoder::new().push(client);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"hello");
        assert!(harness.state().terminal.replay_snapshot().ends_with(b"hello"));
    }
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib pty_output_updates_state_before_broadcast_and_local_write
```

Expected: compilation fails because `SessionState` and `ActorHarness` do not exist.

- [ ] **Step 3: Implement `SessionState`**

`SessionState` contains the six domain components plus session id, store env,
started instant abstraction, next operation id, and latest metadata status.
Implement:

```rust
pub fn apply(&mut self, event: SessionEvent) -> Vec<Effect>
```

Route each event to one private transition method. The PTY-output method must:

1. update `TerminalModel`
2. enqueue one shared encoded output frame to initialized clients
3. enqueue local console bytes only when attached, not suppressed, and not degraded

The resize method must produce `ResizePty`, metadata patch, `PtySize`, `Control`,
and local-view effects in the same observable order as legacy.

- [ ] **Step 4: Implement `ActorHarness`**

Construct deterministic state with no runtime:

```rust
pub struct ActorHarness {
    state: SessionState,
}

impl ActorHarness {
    pub fn apply(&mut self, event: SessionEvent) -> Vec<Effect> {
        self.state.apply(event)
    }
}
```

Add helpers used by tests, but keep them in `test_support`; do not add test-only
methods to production domain types.

- [ ] **Step 5: Add focused transition tests**

Add one failing-then-green test each for:

- resize by controller
- ignored input from non-controller
- take-control at same size schedules jiggle
- initial frames are `PtySize`, `Replay`, then `Control`
- disconnect fallback
- attention flag and acknowledgement
- title/progress capture emits one debounced metadata patch on the 300 ms timer
- a client that sends no resize receives initial frames after the 10 ms timer
- PTY exit ordered effects

Run each test individually for RED before implementing its transition.

- [ ] **Step 6: Run aggregate tests and commit**

```bash
cargo test -p climon-session --lib engine::state
cargo test -p climon-session --lib test_support
git add rust/climon-session/src/engine rust/climon-session/src/test_support
git commit -m "feat(session): implement actor state transitions"
```

---

### Task 9: Implement two-lane coordinator arbitration and effect dispatch

**Files:**
- Create: `rust/climon-session/src/engine/coordinator.rs`
- Modify: `rust/climon-session/src/engine/mod.rs`
- Test: `rust/climon-session/src/engine/coordinator.rs`

- [ ] **Step 1: Write the failing starvation test**

```rust
#[tokio::test(start_paused = true)]
async fn control_event_runs_after_sixteen_pty_output_events() {
    let (mut fixture, handle) = CoordinatorFixture::start();
    for index in 0..32 {
        fixture.send_pty(SessionEvent::PtyOutput(vec![index])).await;
    }
    fixture
        .send_control(SessionEvent::ShutdownRequested)
        .await;
    handle.run_until_effects(17).await;
    assert_eq!(handle.applied_event_kinds()[16], "ShutdownRequested");
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib control_event_runs_after_sixteen_pty_output_events
```

Expected: compilation fails because the coordinator fixture and loop do not exist.

- [ ] **Step 3: Implement coordinator loop**

Use two bounded `tokio::sync::mpsc` receivers. The loop checks control before PTY,
then processes at most 16 consecutive `PtyOutput` events before requiring another
control check. `PtyExited` remains in the PTY lane behind prior output.

Dispatch effects through an `EffectSenders` struct containing bounded adapter
senders. Sending an effect must not await an adapter completion; awaiting bounded
queue capacity is allowed and is the defined backpressure.

Define these initial capacities in `engine/mod.rs`:

```rust
pub const PTY_EVENT_CAPACITY: usize = 64;
pub const CONTROL_EVENT_CAPACITY: usize = 64;
pub const PTY_COMMAND_CAPACITY: usize = 128;
pub const CLIENT_OUTPUT_CAPACITY: usize = 128;
pub const CONSOLE_OUTPUT_CAPACITY: usize = 64;
pub const METADATA_COMMAND_CAPACITY: usize = 64;
```

Do not expose them as configuration settings.

- [ ] **Step 4: Add queue-closure and stale-completion tests**

Write and observe RED before implementation for:

- closed required PTY effect queue produces core shutdown
- closed client queue closes only that client
- stale timer generation produces no effects
- stale console operation completion does not unsuppress local output

- [ ] **Step 5: Run coordinator tests and commit**

```bash
cargo test -p climon-session --lib engine::coordinator
git add rust/climon-session/src/engine
git commit -m "feat(session): add bounded actor coordinator"
```

---

### Task 10: Implement the ordered metadata adapter

**Files:**
- Create: `rust/climon-session/src/adapters/mod.rs`
- Create: `rust/climon-session/src/adapters/metadata.rs`
- Test: `rust/climon-session/src/adapters/metadata.rs`

- [ ] **Step 1: Write the failing barrier test**

```rust
#[tokio::test]
async fn lifecycle_barrier_prevents_patch_coalescing() {
    let store = RecordingStore::default();
    let (tx, task) = spawn_metadata_adapter(store.clone(), test_event_sender());
    tx.send(MetadataCommand::Patch {
        operation_id: OperationId(1),
        patch: patch_cols(100, 30),
        barrier: false,
    })
    .await
    .unwrap();
    tx.send(MetadataCommand::Patch {
        operation_id: OperationId(2),
        patch: completed_patch(0),
        barrier: true,
    })
    .await
    .unwrap();
    drop(tx);
    task.await.unwrap();
    assert_eq!(store.operation_ids(), vec![OperationId(1), OperationId(2)]);
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib lifecycle_barrier_prevents_patch_coalescing
```

Expected: compilation fails because metadata adapter types do not exist.

- [ ] **Step 3: Implement injectable metadata operations**

Define an internal trait:

```rust
pub trait MetadataStore: Send + Sync + 'static {
    fn patch(&self, patch: SessionMetaPatch) -> Result<(), String>;
    fn persist_scrollback(&self, bytes: Vec<u8>) -> Result<(), String>;
}
```

`RealMetadataStore` captures `StoreEnv` and session id and calls existing
`climon_store` functions. `RecordingStore` exists only under `cfg(test)`.

Run blocking store calls with `tokio::task::spawn_blocking`. Process commands in
FIFO order. Do not coalesce in the first implementation. Emit
`MetadataCompleted` or `MetadataFailed` with the original operation id.

- [ ] **Step 4: Add retry test with paused time**

Test that a transient failure retries at 100 ms, 250 ms, then 500 ms and reports
failure after the third retry. Observe RED before adding retry logic.

- [ ] **Step 5: Run and commit**

```bash
cargo test -p climon-session --lib adapters::metadata
git add rust/climon-session/src/adapters
git commit -m "feat(session): add ordered metadata adapter"
```

---

### Task 11: Give the PTY one owned command adapter

**Files:**
- Modify: `rust/climon-pty/src/pty.rs`
- Create: `rust/climon-session/src/adapters/pty.rs`
- Modify: `rust/climon-session/src/adapters/mod.rs`
- Test: `rust/climon-session/src/adapters/pty.rs`
- Test: `rust/climon-pty/src/pty.rs`

- [ ] **Step 1: Write the failing owned-parts test**

In `climon-pty/src/pty.rs`:

```rust
#[test]
fn into_parts_exposes_single_owner_handles() {
    fn assert_send<T: Send>() {}
    assert_send::<PtyParts>();
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-pty --lib into_parts_exposes_single_owner_handles
```

Expected: compilation fails because the owned part types do not exist.

- [ ] **Step 3: Add owned PTY parts**

Add:

```rust
pub struct PtyParts {
    pub pid: Option<u32>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub resizer: PtyResizer,
    pub child: Pty,
}
```

If moving `Pty` into `child` while deriving reader/writer is clearer than three
new wrappers, use `PtyParts` directly; the invariant is one adapter task owns all
returned parts. Add `Pty::into_parts(self) -> PtyResult<PtyParts>`.

- [ ] **Step 4: Write the failing FIFO adapter test**

```rust
#[tokio::test]
async fn pty_commands_execute_in_fifo_order() {
    let fake = FakePty::default();
    let (tx, task) = spawn_fake_pty_adapter(fake.clone(), test_pty_sender());
    tx.send(PtyCommand::Input(OperationId(1), b"a".to_vec())).await.unwrap();
    tx.send(PtyCommand::Resize(OperationId(2), 100, 30)).await.unwrap();
    tx.send(PtyCommand::Input(OperationId(3), b"b".to_vec())).await.unwrap();
    drop(tx);
    task.await.unwrap();
    assert_eq!(
        fake.commands(),
        vec!["input:a", "resize:100x30", "input:b"]
    );
}
```

- [ ] **Step 5: Implement PTY adapter**

The adapter owns `PtyParts`. Use one blocking reader bridge to send
`PtyOutput` into the PTY event lane, one child wait bridge to send `PtyExited`,
and one FIFO command task for input, resize, and kill. The supervisor owns all
join handles. Dropping the PTY owner after child exit must preserve the current
Windows ConPTY reader-EOF behavior.

- [ ] **Step 6: Run PTY tests and commit**

```bash
cargo test -p climon-pty
cargo test -p climon-session --lib adapters::pty
cargo build --workspace
git add rust/climon-pty rust/climon-session
git commit -m "feat(session): add exclusively owned PTY adapter"
```

---

### Task 12: Implement IPC with bounded per-client writers

**Files:**
- Create: `rust/climon-session/src/adapters/ipc.rs`
- Modify: `rust/climon-session/src/adapters/mod.rs`
- Test: `rust/climon-session/src/adapters/ipc.rs`

- [ ] **Step 1: Write the failing slow-client isolation test**

```rust
#[tokio::test]
async fn full_client_queue_disconnects_only_that_client() {
    let mut fixture = IpcFixture::with_client_capacity(1);
    let slow = fixture.connect_client();
    let healthy = fixture.connect_client();
    fixture.pause_writer(slow);
    fixture.send(slow, b"one").await.unwrap();
    let err = fixture.send(slow, b"two").await.unwrap_err();
    assert_eq!(err.client_id, slow);
    fixture.send(healthy, b"ok").await.unwrap();
    assert_eq!(fixture.read(healthy).await, b"ok");
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib full_client_queue_disconnects_only_that_client
```

Expected: compilation fails because `IpcFixture` and adapter do not exist.

- [ ] **Step 3: Implement listener and connection ownership**

Wrap existing `SessionListener` and `SessionStream` with blocking bridge tasks.
Each connection owns:

- one reader/decoder task
- one bounded outbound receiver
- one writer task
- one cancellation token

The adapter sends `ClientConnected`, typed `ClientFrame`, and one
`ClientDisconnected`. `SendClient` uses `try_send`; `Full` cancels and closes
only that client, then emits disconnect. Preserve the five-second socket write
timeout and shutdown-both behavior.

- [ ] **Step 4: Add exact decode/order tests**

Write RED tests for split frames, multiple frames per read, initial outbound FIFO,
writer failure, and stop-accepting behavior, then implement each.

- [ ] **Step 5: Run and commit**

```bash
cargo test -p climon-session --lib adapters::ipc
git add rust/climon-session/src/adapters/ipc.rs rust/climon-session/src/adapters/mod.rs
git commit -m "feat(session): add isolated IPC adapter"
```

---

### Task 13: Implement local terminal, timers, and signals adapters

**Files:**
- Create: `rust/climon-session/src/adapters/local_terminal.rs`
- Create: `rust/climon-session/src/adapters/timers.rs`
- Create: `rust/climon-session/src/adapters/signals.rs`
- Modify: `rust/climon-session/src/adapters/mod.rs`
- Test: inline adapter tests

- [ ] **Step 1: Write the failing console completion test**

```rust
#[tokio::test]
async fn console_adapter_reports_completion_after_flush() {
    let writer = RecordingWriter::default();
    let (tx, mut events, task) = spawn_console_writer(writer.clone());
    tx.send(ConsoleCommand::Write {
        operation_id: OperationId(4),
        bytes: b"screen".to_vec(),
    })
    .await
    .unwrap();
    assert!(matches!(
        events.recv().await,
        Some(SessionEvent::ConsoleWriteCompleted(OperationId(4)))
    ));
    assert_eq!(writer.bytes(), b"screen");
    task.abort();
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib console_adapter_reports_completion_after_flush
```

Expected: compilation fails because local-terminal adapter types do not exist.

- [ ] **Step 3: Implement local-terminal ownership**

Move Unix and Windows raw-mode setup from legacy host into platform modules under
`local_terminal.rs`. The adapter owns the guard and all stdin/stdout handles.
Stdin and resize sources emit events. Console writes run on one blocking worker
and emit completion/failure only after flush. No coordinator lock or state is
accessible.

- [ ] **Step 4: Write and implement generation-safe timer tests**

Test first:

```rust
#[tokio::test(start_paused = true)]
async fn cancelled_generation_never_fires() {
    let (tx, mut events, _task) = spawn_timer_adapter();
    tx.send(TimerCommand::Schedule(TimerId(2), 1, Duration::from_secs(1)))
        .await
        .unwrap();
    tx.send(TimerCommand::Cancel(TimerId(2), 1)).await.unwrap();
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(events.try_recv().is_err());
}
```

Use `tokio::time::sleep_until` and cancellation tokens; emit timer id and generation.

- [ ] **Step 5: Move signal handling**

Unix `SIGTERM`/`SIGINT` emits `ShutdownRequested`; Unix `SIGWINCH` and Windows
console-size polling emit `LocalResized`. Signal adapters own their iterator or
poll task and terminate on supervisor cancellation.

- [ ] **Step 6: Run and commit**

```bash
cargo test -p climon-session --lib adapters::local_terminal
cargo test -p climon-session --lib adapters::timers
cargo test -p climon-session --lib adapters::signals
git add rust/climon-session/src/adapters
git commit -m "feat(session): add terminal timer and signal adapters"
```

---

### Task 14: Supervise the actor engine end to end

**Files:**
- Create: `rust/climon-session/src/engine/supervisor.rs`
- Modify: `rust/climon-session/src/engine/mod.rs`
- Modify: `rust/climon-session/src/host/mod.rs`
- Test: `rust/climon-session/src/engine/supervisor.rs`

- [ ] **Step 1: Write the failing runtime-boundary test**

```rust
#[test]
fn actor_engine_owns_runtime_and_returns_exit_code() {
    let fixture = SupervisorFixture::successful_exit(7);
    let code = fixture.run_sync().unwrap();
    assert_eq!(code, 7);
    assert!(fixture.all_tasks_joined());
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --lib actor_engine_owns_runtime_and_returns_exit_code
```

Expected: compilation fails because supervisor fixture and implementation do not exist.

- [ ] **Step 3: Implement supervisor startup**

`engine::run_session_host` builds a multi-thread Tokio runtime and calls:

```rust
runtime.block_on(supervisor::run(id.to_string(), meta, options))
```

Startup order:

1. load config and initialize daemon logger
2. resolve and spawn PTY
3. establish local raw mode before enabling PTY-to-console routing
4. bind IPC listener and patch resolved socket
5. construct state and bounded lanes
6. spawn all adapters and coordinator into a `JoinSet`
7. patch running/paused metadata

Use `CancellationToken` for shutdown. Register every task in `JoinSet`; no
detached tasks.

- [ ] **Step 4: Implement finalization and joins**

Wait for `CompleteSession`, cancel adapters, close command senders, join all
tasks with a five-second deadline, restore terminal modes by dropping the local
adapter guard, clean the socket, and return the exit code. A task panic becomes
`SessionError::ActorTask`.

- [ ] **Step 5: Add partial-startup unwind tests**

Test PTY spawn failure, IPC bind failure after PTY spawn, metadata startup
failure, and local-terminal setup failure. Verify owned resources are cancelled,
joined, or dropped exactly once.

- [ ] **Step 6: Run and commit**

```bash
cargo test -p climon-session --lib engine::supervisor
cargo test -p climon-session --lib
git add rust/climon-session/src/engine rust/climon-session/src/host
git commit -m "feat(session): supervise actor daemon lifecycle"
```

---

### Task 15: Add shared legacy/actor characterization and parity tests

**Files:**
- Create: `rust/climon-session/tests/engine_parity.rs`
- Modify: `rust/climon-session/tests/session_integration.rs`
- Modify: `rust/climon-session/src/test_support/trace.rs`

- [ ] **Step 1: Parameterize existing real integration tests by engine**

Add:

```rust
#[derive(Clone, Copy)]
enum TestEngine {
    Legacy,
    Actor,
}

impl TestEngine {
    fn env_value(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Actor => "actor",
        }
    }
}
```

Extract each current test body into a function taking `TestEngine`, and retain
the legacy test names first.

- [ ] **Step 2: Run existing legacy tests**

```bash
cargo test -p climon-session --test session_integration legacy
```

Expected: PASS before any actor assertions are enabled.

- [ ] **Step 3: Write the first failing actor parity test**

```rust
#[test]
fn actor_matches_legacy_initial_frames_and_completion() {
    let legacy = run_initial_frames_scenario(TestEngine::Legacy);
    let actor = run_initial_frames_scenario(TestEngine::Actor);
    assert_eq!(actor.normalized(), legacy.normalized());
}
```

- [ ] **Step 4: Run and verify RED**

```bash
cargo test -p climon-session --test engine_parity actor_matches_legacy_initial_frames_and_completion
```

Expected: FAIL with the first concrete frame, metadata, or ordering mismatch.

- [ ] **Step 5: Fix only the observed mismatch**

Use the normalized trace to identify one discrepancy. Add or refine the smallest
actor unit test that reproduces it, observe RED, implement the minimum fix, then
rerun the parity scenario. Repeat until green.

- [ ] **Step 6: Add parity scenarios one at a time**

For each scenario, write the actor-vs-legacy assertion, observe RED, and fix:

- failed exit status
- viewer resize and `PtySize`
- replay request
- take-control and controller fallback
- attention flag and matching acknowledgement
- acknowledged state surviving resize/idle
- slow client disconnect
- exit while local terminal is displaced
- title/progress metadata
- fast exit and early output

- [ ] **Step 7: Run parity and integration suites**

```bash
cargo test -p climon-session --test engine_parity
cargo test -p climon-session --test session_integration
```

Expected: PASS for both engines on Unix.

- [ ] **Step 8: Commit**

```bash
git add rust/climon-session/tests rust/climon-session/src/test_support
git commit -m "test(session): prove legacy actor parity"
```

---

### Task 16: Add bounded-queue stress and fault-injection release gates

**Files:**
- Create: `rust/climon-session/tests/actor_stress.rs`
- Modify: `rust/climon-session/src/test_support/harness.rs`
- Modify: `rust/climon-session/src/test_support/trace.rs`

- [ ] **Step 1: Write the failing PTY flood test**

```rust
#[tokio::test]
async fn output_flood_is_bounded_and_control_is_not_starved() {
    let fixture = StressFixture::new()
        .pty_capacity(32)
        .control_capacity(8)
        .client_capacity(4)
        .start()
        .await;
    fixture.flood_pty_output(10_000, 1024).await;
    fixture.request_shutdown().await;
    fixture.wait_stopped(Duration::from_secs(5)).await.unwrap();
    assert!(fixture.max_pty_depth() <= 32);
    assert!(fixture.shutdown_applied_within_pty_events(16));
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p climon-session --test actor_stress output_flood_is_bounded_and_control_is_not_starved
```

Expected: compilation fails because `StressFixture` does not exist.

- [ ] **Step 3: Implement the stress fixture and make the test green**

Expose queue-depth instrumentation only through test-support wrappers around
senders. Do not add queue inspection APIs to production domain types.

- [ ] **Step 4: Add fault tests one at a time**

Write, observe RED, implement, and rerun for:

- slow client does not delay healthy client
- blocked console degrades local output without stopping PTY/client output
- metadata retry exhaustion does not stop live PTY
- PTY command queue preserves input/resize/input order
- concurrent PTY exit and shutdown finalize once
- stale console/timer/metadata completions are ignored
- adapter panic cancels and joins all sibling tasks
- all queues stay within configured capacities
- structured event/effect logs contain ids, phase, saturation, and failure class
  but never PTY bytes, replay bytes, or user input

For the observability case, install a recording logging sink and assert fields,
not formatted NDJSON text. The coordinator logs event/effect kind and lifecycle
phase; adapters log queue saturation and classified failures. Payload bytes are
represented only by their length.

- [ ] **Step 5: Run the release-gate automated suite**

```bash
cargo test -p climon-session
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: all pass with no warnings or formatting diff.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-session
git commit -m "test(session): stress actor daemon isolation"
```

---

### Task 17: Document architecture and add the cross-platform manual gate

**Files:**
- Create: `docs/manual-tests/daemon-actor-rewrite.md`
- Modify: `docs/manual-tests/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features.md`

- [ ] **Step 1: Add manual cases**

Create `daemon-actor-rewrite.md` with these cases, each using the repository's
ID/preconditions/config-matrix/steps/expected/platforms/result-row shape:

- `DAR-01`: attached shell input/output/raw-mode restoration
- `DAR-02`: headless session and dashboard attach/replay
- `DAR-03`: dashboard/PWA take-control and local Space reclaim
- `DAR-04`: local restore and same-size repaint jiggle
- `DAR-05`: attention flag, acknowledgement, and resize stickiness
- `DAR-06`: title and progress capture
- `DAR-07`: fast exit, failed exit, final scrollback, and socket cleanup
- `DAR-08`: slow/disconnecting viewer isolation
- `DAR-09`: SIGINT/SIGTERM and Windows process termination
- `DAR-10`: actor-to-legacy rollback using `CLIMON_SESSION_ENGINE`

The matrix rows are Linux/openpty/Unix socket, macOS/openpty/Unix socket, and
Windows/ConPTY/loopback TCP.

- [ ] **Step 2: Update docs**

In `docs/architecture.md`, replace the thread/shared-mutex description with the
coordinator, domain, adapter, bounded-channel, and explicit lifecycle model.

In `docs/features.md`, update `cli-07` to cite the actor engine source paths and
new manual test. Keep it in the same production/development section; this is an
internal rewrite, not a new user feature.

Add the manual file to `docs/manual-tests/README.md`.

- [ ] **Step 3: Verify docs contain no legacy mutex claim**

```bash
rg -n 'Arc<Mutex<HostState>>|threads guarded by a single|mirroring the single-threaded TS' \
  docs rust/climon-session/src/lib.rs rust/climon-session/src/host
```

Expected: matches only in migration history/spec text or `host/legacy.rs`, not
current architecture documentation or the actor facade.

- [ ] **Step 4: Commit**

```bash
git add docs rust/climon-session/src/lib.rs
git commit -m "docs: add actor daemon verification matrix"
```

---

### Task 18: Flip the default only after the full release gate

**Files:**
- Modify: `rust/climon-session/src/host/mod.rs`
- Modify: selector tests in `rust/climon-session/src/host/mod.rs`
- Modify: `docs/manual-tests/daemon-actor-rewrite.md` result rows when executed

- [ ] **Step 1: Record manual results**

Run every `DAR-*` case on Windows, macOS, and Linux. Record date, tester,
platform, version/commit, pass/fail, and notes. Do not continue if any required
cell fails.

- [ ] **Step 2: Write the failing default-selection test**

Change the test expectation first:

```rust
#[test]
fn selector_defaults_to_actor() {
    assert_eq!(selected_engine(None).unwrap(), Engine::Actor);
}
```

- [ ] **Step 3: Run and verify RED**

```bash
cargo test -p climon-session --lib selector_defaults_to_actor
```

Expected: FAIL because the default remains `Legacy`.

- [ ] **Step 4: Flip the default**

Change:

```rust
None | Some("") => Ok(Engine::Actor),
Some("legacy") => Ok(Engine::Legacy),
Some("actor") => Ok(Engine::Actor),
```

Keep explicit legacy rollback for one stabilization release.

- [ ] **Step 5: Run final verification**

```bash
cargo test -p climon-session
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-session/src/host/mod.rs docs/manual-tests/daemon-actor-rewrite.md
git commit -m "feat(session): make actor daemon the default"
```

---

## Stabilization follow-up

After one release with the actor engine as default and no unresolved actor-only
regressions, create a separate cleanup plan to remove:

- `rust/climon-session/src/host/legacy.rs`
- `CLIMON_SESSION_ENGINE`
- legacy branches in parity tests
- migration-only normalized trace plumbing
- `ActorUnavailable` and legacy selector errors

That cleanup is intentionally not part of this plan because the design requires
one release of rollback coverage.
