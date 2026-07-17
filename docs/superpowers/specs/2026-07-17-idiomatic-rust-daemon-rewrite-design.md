# Idiomatic Rust Session Daemon Rewrite Design

## Summary

Rewrite `climon-session` around a Tokio coordinator actor with explicit resource
adapters. The coordinator becomes the sole owner of authoritative session state.
PTY, socket, local-terminal, metadata, timer, and signal resources are owned by
dedicated tasks that communicate through typed, bounded channels.

The rewrite preserves all observable behavior, protocol bytes, metadata and
scrollback formats, socket references, command-line behavior, and cross-platform
PTY semantics. It is introduced beside the current daemon behind an internal
engine selector, validated through old/new parity tests, and made the default
only after deterministic, stress, integration, and platform-manual release gates
pass.

## Context

`rust/climon-session/src/host.rs` is currently a thread-based port of the former
Bun client. It has more than 2,000 lines and deliberately mirrors the Bun event
loop with a single `Arc<Mutex<HostState>>`. The mutex protects unrelated
responsibilities:

- PTY output parsing, scrollback, and terminal-grid mutation
- client registration, replay, broadcast, and disconnect handling
- controller selection and resize
- local terminal suppression, restoration, and repaint jiggles
- idle and attention state
- title and progress capture
- metadata persistence and lifecycle transitions

Multiple threads acquire this mutex and then trigger work with different
latency and failure characteristics. Some paths have historically performed
console or persistence work while holding the lock. Even where those calls are
moved outside the critical section, correctness depends on manually preserving
ordering across reader, restore, connection, idle, title, local-input, resize,
signal, and teardown threads.

Replacing the mutex with several smaller locks would reduce contention but not
solve the structural problem. Controller changes, PTY dimensions, local-output
suppression, replay state, attention, and lifecycle have cross-domain
invariants. A lock-sharded design would move those invariants into lock ordering
and snapshot reconciliation.

## Goals

- Remove the global shared-state mutex.
- Give every mutable resource and state domain one explicit owner.
- Keep cross-domain transitions serialized and deterministic.
- Ensure the coordinator never performs blocking I/O.
- Model ordering-sensitive behavior with explicit messages rather than critical
  sections.
- Bound memory use and define backpressure for every channel.
- Isolate wedged or failed peripheral adapters from the PTY session.
- Make session behavior testable without real threads, clocks, sockets,
  terminals, or PTYs.
- Preserve all externally observable behavior and data formats.
- Migrate incrementally with a production escape hatch until parity is proven.

## Non-goals

- Changing the IPC frame protocol or frame ordering.
- Changing session metadata, scrollback, socket, or configuration formats.
- Redesigning controller priority, displacement, attention, replay, title,
  progress, or repaint behavior.
- Rewriting the dashboard server or web terminal.
- Making the public CLI or `run_session_host` API async.
- Introducing a user-facing feature flag for daemon selection.
- Replacing working pure helpers solely to match the new file layout.

## Chosen Architecture

### Coordinator actor

One Tokio task owns the authoritative `SessionState` and consumes a bounded
`SessionEvent` mailbox. It applies one transition at a time and emits ordered
`Effect` values. It does not hold PTY, socket, file, console, signal, timer, or
thread handles.

`SessionState` is an aggregate of focused domain components:

- `ControlState`: connected surfaces, controller, reported dimensions, and
  applied PTY dimensions
- `TerminalModel`: scrollback, VT grid, mouse private modes, title/progress
  parsing, and replay snapshots
- `AttentionState`: idle detector state, user acknowledgements, fingerprints,
  and attention metadata
- `LocalViewState`: local attachment, suppression, displaced notice, deferred
  restore, and repaint jiggle state
- `ClientRegistry`: logical client identity, initialization, surface
  classification, connection sequence, and delivery status
- `LifecycleState`: startup, running, drain, finalization, exit code, and
  shutdown state

These components expose deterministic transition methods. They contain domain
data, not resource handles, synchronization primitives, or blocking calls.

### Resource adapters

Dedicated adapters own resources and execute effects:

| Adapter | Exclusive ownership | Coordinator interaction |
| --- | --- | --- |
| PTY | child, reader, writer, resizer, wait handle | emits output/exit; receives input/resize/kill commands |
| IPC | listener and client socket handles | emits connect/frame/disconnect; receives per-client send/close commands |
| Local terminal | raw-mode guard, stdin/stdout handles, resize source | emits input/resize/write completion; receives output/notice/repaint commands |
| Metadata | session patch and scrollback persistence calls | receives ordered writes; emits success/failure |
| Timers | idle, initial-frame, restore, jiggle, and retry deadlines | emits typed timer events |
| Signals | platform termination and resize signals where applicable | emits shutdown or resize events |

Adapters do not choose follow-up behavior or mutate domain state. Every
completion that can affect a later decision includes an operation id and returns
as a `SessionEvent`.

### Stable facade

The public entry point remains:

```rust
run_session_host(
    env: &StoreEnv,
    id: &str,
    options: SessionHostOptions,
) -> SessionResult<i32>
```

The actor engine creates and owns its Tokio runtime internally. Existing callers
and the hidden `climon __session` command remain synchronous.

## Event and Effect Model

The coordinator accepts a closed event enum. Initial variants include:

```rust
enum SessionEvent {
    PtyOutput { bytes: Bytes },
    PtyExited { exit_code: i32 },
    PtyFailed { operation: PtyOperation, error: AdapterError },
    ClientConnected { client_id: ClientId },
    ClientFrame { client_id: ClientId, frame: Frame },
    ClientDisconnected { client_id: ClientId, reason: DisconnectReason },
    ClientSendFailed { client_id: ClientId, operation_id: OperationId },
    LocalInput { bytes: Bytes },
    LocalResized { cols: u16, rows: u16 },
    ConsoleWriteCompleted { operation_id: OperationId },
    ConsoleWriteFailed { operation_id: OperationId, error: AdapterError },
    TimerFired { timer: TimerId, generation: u64 },
    MetadataCompleted { operation_id: OperationId },
    MetadataFailed { operation_id: OperationId, error: AdapterError },
    ShutdownRequested { reason: ShutdownReason },
}
```

Payload types may be refined while writing the implementation plan, but the
listed event families and their semantics are required. Events remain typed and
domain-specific. Generic closures or untyped JSON messages are not used inside
the daemon.

Transitions emit a closed effect enum. Initial effect families include:

- PTY: `WritePty`, `ResizePty`, `KillPty`
- clients: `SendClient`, `Broadcast`, `CloseClient`, `StopAcceptingClients`
- local terminal: `WriteConsole`, `SetLocalInputEnabled`
- metadata: `PatchMetadata`, `PersistScrollback`
- timers: `ScheduleTimer`, `CancelTimer`
- lifecycle: `CancelAdapters`, `JoinAdapters`, `CompleteSession`

The coordinator dispatches effects without awaiting slow work. Effects emitted
by one transition retain their declared order. Executor-specific FIFO queues
preserve order where the external resource requires it.

## Ordering Invariants

The rewrite must encode the following invariants directly:

1. Only the coordinator chooses a controller or changes logical PTY dimensions.
2. Only the PTY adapter accesses PTY handles.
3. Only the IPC adapter accesses listener and socket handles.
4. Only the local-terminal adapter accesses raw mode, stdin, stdout, and local
   resize sources.
5. Only the metadata adapter calls session patch and scrollback persistence
   APIs.
6. PTY input, resize, and kill commands are serialized through one FIFO command
   queue.
7. Per-client frames are serialized through that client's outbound queue.
8. A client does not join broadcasts until its initial `PtySize`, `Replay`, and
   control initialization sequence has been enqueued in the existing order.
9. PTY output updates scrollback, grid, terminal modes, title/progress capture,
   client broadcast state, and local-routing decisions in one coordinator
   transition.
10. PTY exit starts one explicit finalization sequence; later duplicate exit or
    shutdown events are idempotent.
11. Operation ids or timer generations reject stale completions and cancelled
    deadlines.

### Two-phase local restore

The current daemon has ordering-sensitive local restore behavior: the restored
screen must land before live local output resumes, while the coordinator must not
block on a console write.

The actor engine models this as a protocol:

1. The restore timer fires.
2. The coordinator computes the current repaint bytes and emits
   `WriteConsole(operation_id, repaint)`.
3. `LocalViewState` remains suppressed and records the pending operation.
4. The local-terminal adapter performs the write and emits
   `ConsoleWriteCompleted(operation_id)`.
5. The coordinator verifies the operation id, clears suppression, resumes live
   local routing, and schedules the first repaint-jiggle leg.

A failure marks the local adapter degraded and keeps local output disabled. It
does not stop the PTY, dashboard clients, replay capture, or lifecycle
persistence.

The same two-phase pattern is used for any action whose successful completion is
a prerequisite for a later state transition.

## Backpressure

Every channel is bounded and documents saturation behavior.

### Coordinator mailbox

PTY output is never dropped. The coordinator consumes two bounded lanes:

- an ordered PTY lane for output, exit, and PTY failures
- a control lane for clients, local-terminal events, timers, metadata
  completions, and shutdown

The coordinator processes at most 16 consecutive PTY-output events before
checking the control lane. A pending PTY exit remains ordered behind all earlier
PTY output because both use the same lane. When a lane reaches capacity, its
producer awaits capacity, allowing bounded backpressure instead of unbounded
memory growth. This fixed arbitration rule prevents control starvation and is
directly testable with a paused runtime.

### Client output

Each client has a bounded outbound queue. A client that cannot keep up is closed
and removed through the normal disconnect transition. No socket write blocks
the coordinator, PTY reader, local terminal, or another client.

Queue limits are internal constants initially. They are not exposed as config
unless real usage demonstrates a tuning requirement.

### PTY commands

Input, resize, and kill commands use one bounded FIFO queue. Resize coalescing is
allowed only for consecutive resize commands that have no intervening input,
kill, or ordering barrier and only if parity tests prove no observable change.
The initial implementation should not coalesce.

### Local console

The local-terminal adapter has a bounded output queue. A write failure or
permanent stall degrades and detaches local output while the session continues.
No console call executes inside the coordinator.

### Metadata

One metadata adapter processes ordered patches and scrollback writes.
Compatible adjacent non-lifecycle patches may be coalesced. Running, attention,
paused/acknowledged, and terminal completion boundaries are ordering barriers.
The initial implementation should prefer correctness over aggressive
coalescing.

## Failure Handling

### Core failures

The following terminate the daemon and attempt to persist a failed session:

- PTY spawn failure
- unrecoverable PTY read or wait failure
- loss of the PTY command executor
- coordinator panic or violated state invariant
- inability to initialize the session's required IPC listener

### Isolated peripheral failures

The following affect only their adapter or operation:

- a client disconnect, decode failure, timeout, or full outbound queue
- local stdin/stdout or console-mode failure
- transient metadata patch failure
- title or progress persistence failure
- timer cancellation or stale completion
- a non-controlling optional surface failure

Metadata failures are logged and retried with bounded backoff. Retry exhaustion
is surfaced in structured logs and retained in coordinator diagnostics, but does
not kill a live PTY. Final status and scrollback persistence receive a bounded
final retry window during shutdown.

The rewrite removes broad silent `let _ = ...` handling from orchestration
paths. Expected best-effort failures have explicit variants and structured log
events.

## Lifecycle and Shutdown

Lifecycle is an explicit state machine:

### Starting

- Load metadata and configuration.
- Spawn the PTY.
- Initialize adapters and coordinator state.
- Establish local raw mode before PTY output may be routed to the real terminal.
- Bind the session socket and persist its resolved reference.
- Patch the session to `running`, preserving existing paused semantics.
- Begin accepting normal events.

Startup uses a supervisor so partial initialization unwinds already-created
resources in reverse ownership order.

### Running

Normal PTY, client, local-terminal, timer, metadata, and signal events are
accepted. Adapter failures are classified according to the failure policy.

### Draining

PTY exit or fatal shutdown moves the session to `Draining` exactly once:

- stop accepting new clients
- reject new input and resize commands
- finish processing already-observed PTY output
- capture the final scrollback and terminal model

### Finalizing

The coordinator emits the ordered final effects:

1. persist final scrollback
2. patch completed/failed metadata and exit code
3. enqueue `Exit` to initialized clients
4. perform the final local-screen restore when required
5. close client queues after their final frame

Completion events and deadlines determine when finalization may advance.

### Stopped

The supervisor cancels adapters, closes command queues, joins owned tasks with
defined deadlines, restores terminal modes, cleans up the socket, and returns
the exit code.

Every spawned task is registered with the supervisor and has one owner
responsible for cancellation and joining. Detached helper threads are not
allowed.

## Proposed Source Layout

```text
rust/climon-session/src/
  host/
    mod.rs                 # stable facade and temporary engine selector
    legacy.rs              # current implementation during migration
  engine/
    mod.rs
    coordinator.rs         # mailbox loop and effect dispatch
    event.rs               # SessionEvent
    effect.rs              # Effect and operation ids
    state.rs               # aggregate domain state
    supervisor.rs          # startup, cancellation, task joins
  domain/
    control.rs
    terminal.rs
    attention.rs
    local_view.rs
    clients.rs
    lifecycle.rs
  adapters/
    pty.rs
    ipc.rs
    local_terminal.rs
    metadata.rs
    timers.rs
    signals.rs
  test_support/
    harness.rs
    trace.rs
    fake_adapters.rs
```

Existing pure modules such as `control`, `idle`, `fingerprint`, `replay`,
`snippet`, and `title_capture` should be reused or moved into these boundaries.
The implementation plan should prefer small moves and wrappers before semantic
rewrites.

Supporting crates may receive narrow API changes:

- `climon-pty`: expose owned reader, command, resize, wait, and termination
  capabilities that make exclusive ownership clear
- `climon-store`: expose an injectable metadata writer interface suitable for
  ordered adapter execution and deterministic tests
- `climon-proto`: add an owned decoded-frame type for adapter-to-coordinator
  delivery without changing serialized bytes

## Migration Strategy

### Internal engine selector

The legacy and actor engines coexist behind an internal selector such as:

```text
CLIMON_SESSION_ENGINE=legacy
CLIMON_SESSION_ENGINE=actor
```

This is an implementation escape hatch, not a documented user feature or config
setting. Invalid values fail explicitly. The selector defaults to `legacy`
until the release gate passes.

### Phase 1: Characterization

Build a black-box harness around the current daemon behavior. Scenarios record:

- input events and timing
- exact outbound frame bytes and order
- PTY input, resize, and kill commands
- metadata patches and persisted scrollback
- local-console writes
- adapter close and shutdown order

Characterization covers ordinary sessions and known fragile paths such as early
output, fast exit, slow clients, controller disconnect, local displacement,
deferred restore, repaint jiggle, attention acknowledgement, and exit while
displaced.

### Phase 2: Pure engine

Implement domain components and the coordinator against fake adapters and a
controllable clock. No real PTY, socket, filesystem, console, or signal handling
is required for this phase.

### Phase 3: Resource adapters

Wrap existing blocking APIs in owned Tokio tasks or dedicated bridging threads.
Blocking handles never enter coordinator state. Introduce supporting-crate API
changes only where they improve ownership or testability.

### Phase 4: Old/new parity

Run each characterization scenario against both engines and compare normalized
observable traces. Normalization may remove nondeterministic values such as
process ids, generated socket names, and wall-clock timestamps, but it must not
hide event order, frame bytes, status changes, dimensions, controller ids, or
failure classification.

### Phase 5: Platform validation

Complete automated integration and stress coverage, then execute the documented
manual test matrix on Windows, macOS, and Linux.

### Phase 6: Default flip and removal

After the release gate passes:

1. make `actor` the default
2. retain `legacy` as an internal escape hatch for one stabilization release
3. collect and compare structured traces for reported failures
4. remove `legacy`, the selector, and migration-only parity plumbing in a
   separate cleanup change

## Testing Strategy

### Deterministic domain tests

Drive `SessionState` with events and assert the new state plus ordered effects.
Coverage includes every event variant, lifecycle state, controller transition,
attention transition, restore state, and stale completion path.

Implementation follows strict test-driven development. Every production change
starts with one focused test, that test is run and observed failing for the
intended missing behavior, the minimum implementation is added to make it pass,
and cleanup occurs only while the tests remain green. Production code written
before its failing test is discarded and rewritten test-first.

### Virtual-time tests

Use Tokio paused time or an injected clock for:

- initial-frame delay
- idle sampling and settle windows
- local restore deferral
- two-leg repaint jiggle
- metadata retry backoff
- adapter shutdown deadlines

No timing test should depend on fixed wall-clock sleeps.

### Parity tests

Run shared scenarios through legacy and actor harnesses. Compare:

- exact encoded frame bytes and order
- metadata patches after timestamp normalization
- PTY command order
- console write order
- final scrollback
- final exit status

### Stress and fault tests

Exercise:

- sustained PTY output larger than all queue capacities
- one or more slow clients while healthy clients continue
- rapid connect/disconnect and replay requests
- resize and take-control races
- local resize during displacement and restore
- console writes that block, fail, or complete late
- metadata failures and retry exhaustion
- PTY exit during queued output
- shutdown arriving concurrently with PTY exit
- stale timer and operation completions

Tests must assert bounded queues, no deadlock, no unbounded memory growth, and
deterministic terminal state.

### Real integration tests

Use real sockets and PTYs for:

- output emitted immediately after spawn
- a child that exits immediately
- input/output round trips
- replay after substantial output
- multiple clients and controller fallback
- signal-driven termination
- final socket cleanup and persisted status

### Manual platform checks

Add a daemon-rewrite manual-test phase and index it from
`docs/manual-tests/README.md`. The matrix covers Windows ConPTY, macOS, and
Linux, with attached and headless sessions, dashboard/PWA handoff, local
restore, same-size repaint jiggle, attention, title/progress, replay, signals,
fast exit, and final status persistence.

## Observability

Both engines use common structured event and effect names during migration.
Trace records include engine, session id, event/effect kind, operation id,
client id where applicable, lifecycle phase, queue saturation, and failure
classification. PTY content and user input are not logged.

This allows old/new failures to be diffed from logs without reproducing the
interactive session and makes adapter degradation visible rather than silent.

## Release Gate

The actor engine may become the default only when:

- all deterministic state-machine tests pass
- all legacy/actor parity scenarios match
- stress and fault-injection tests pass without deadlock or unbounded queues
- the Rust workspace builds and tests on supported targets
- the Windows, macOS, and Linux manual matrix passes
- no known core session behavior is available only in the legacy engine
- rollback to `legacy` has been exercised before the default flip

## Success Criteria

The rewrite is successful when:

- no `Arc<Mutex<HostState>>` or equivalent shared aggregate exists
- no blocking I/O occurs in the coordinator
- every resource has one explicit owner
- every spawned task is supervised and joined
- ordering-sensitive behavior is represented by typed events and effects
- slow or failed peripherals cannot freeze the session
- externally observable legacy and actor traces match
- the legacy engine can be removed after the stabilization release without
  changing behavior
