# Daemon actor rewrite — cross-platform verification matrix

Manual, human-run release gate for the **actor-based session daemon** — the
idiomatic-Rust rewrite of the session host (`rust/climon-session`). These cases
exercise the actor engine on real PTYs, terminals, browsers, and OS signals
across the three first-class platforms — the behaviours the automated parity and
stress suites cannot fully characterise (controlling-terminal raw-mode
restoration, live browser handoff, `SIGWINCH`/`SIGTERM` delivery, ConPTY, and
final on-disk status).

The actor engine is **opt-in**. It runs only when the `CLIMON_SESSION_ENGINE`
environment variable is set to `actor`; unset (or `legacy`) selects the existing
legacy engine, which is **still the shipping default**. Engine selection is read
per daemon start in `rust/climon-session/src/host/mod.rs`.

**Status — do not over-claim.** The actor engine is fully implemented and its
automated parity and stress gates pass, but the default is **still the legacy
engine**. Flipping the default is a separate step (Task 18) that happens only
*after* this matrix has been executed and passes on all three platforms. The
result rows below are intentionally **blank/pending**: no case here has been run
against a release candidate yet, so none is "passed". Record real runs in
`results/<version>.md` (see [Recording results](README.md#recording-results)).

Background: the [idiomatic-Rust daemon-rewrite
plan](../superpowers/plans/2026-07-17-idiomatic-rust-daemon-rewrite.md) and its
[design](../superpowers/specs/2026-07-17-idiomatic-rust-daemon-rewrite-design.md).
The actor engine lives under `rust/climon-session/src/engine/` — the pure
`(state, event) -> Vec<Effect>` transition (`engine/state.rs`) composed from the
crate-private domain modules (`domain/`), the single bounded-actor
`engine/coordinator.rs`, and the lifecycle-owning `engine/supervisor.rs` — plus
the resource-owning I/O adapters under `rust/climon-session/src/adapters/`
(`pty`, `ipc`, `local_terminal`, `metadata`, `timers`, `signals`). The legacy
engine and the rollback path are `rust/climon-session/src/host/legacy.rs`.

## Common preconditions

Unless a case says otherwise:

- A `climon` client **built/installed from this branch**, so the daemon binary
  contains the actor engine. Each session's daemon runs the binary it was
  launched from — rebuild/reinstall before testing.
- The actor engine is selected by exporting `CLIMON_SESSION_ENGINE=actor` (or
  prefixing each command with it). The variable is inherited by the detached
  daemon (`climon __session <id>` is spawned without clearing the environment),
  so it applies to headless daemons as well as attached in-process hosts.
- Viewer cases need a dashboard: start `climon server` (loopback only) and open
  it in a browser; PWA cases need the installed app.
- Session state lives under `$CLIMON_HOME` (default `~/.climon`): metadata
  `sessions/<id>.json`, final scrollback `sessions/<id>.scrollback`, and the
  per-session daemon log `logs/daemon/<id>.log`.

## Configuration matrix

The actor engine has **per-OS PTY and IPC-transport backends**, so each case is a
matrix over these cells. Run each case on every listed platform; steps that
differ per cell call it out.

| Cell | OS | PTY backend | IPC socket transport |
|---|---|---|---|
| DAR-linux | Linux (x64) | `openpty` | Unix domain socket |
| DAR-macos | macOS (arm64) | `openpty` | Unix domain socket |
| DAR-win | Windows (x64) | ConPTY | loopback TCP |

- **PTY backend** — `rust/climon-pty` wraps `portable-pty`: `openpty` on
  Linux/macOS and ConPTY on Windows. The actor engine owns the split PTY in
  `rust/climon-session/src/adapters/pty.rs` (two owned workers, no `Arc<Mutex>`
  around any PTY resource, plus a durable emergency child terminator).
- **IPC socket transport** — the per-session listener is bound by
  `rust/climon-session/src/socket.rs` from the session's `socket_path`: a
  filesystem-path reference binds a **Unix domain socket**
  (`SessionListener::Unix`, Unix only) and a `tcp://host:port` reference binds
  **loopback TCP** (`SessionListener::Tcp`). Windows has no Unix-domain-socket
  transport. **Current default:** the launcher and headless spawn both write
  `tcp://127.0.0.1:0` (`format_session_socket_ref` in
  `rust/climon-cli/src/launcher.rs` and `rust/climon-cli/src/spawn.rs`) on every
  platform, so out of the box all three cells run over loopback TCP with an
  OS-assigned port; the Unix-domain-socket transport is exercised wherever a
  session's `socket_path` is a filesystem path. This distinction is only
  observable in DAR-07's socket-cleanup step (a Unix-domain-socket *file* is
  removed on teardown; a loopback-TCP listener is simply closed and its port
  released).

---

## DAR-01 — Attached shell: input, output, and raw-mode restoration

- **ID:** DAR-01
- **Feature / phase:** Daemon actor rewrite — attached local terminal (input
  worker + FIFO console writer + raw/console-mode guard,
  `adapters/local_terminal.rs`)
- **Preconditions:** Built client; a real interactive console.
- **Config-matrix cell:** all (attached local terminal, default config)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. In an interactive terminal that is in normal cooked mode (local echo on, line
   editing on), export `CLIMON_SESSION_ENGINE=actor`. Optionally record the tty
   modes first (Unix: `stty -a`).
2. Start an attached managed shell: `climon shell` (or `climon bash`). The
   session host runs in-process, attached to this terminal.
3. Type and run several commands (`ls`, `echo hi`), then launch a full-screen TUI
   (`vim`, `htop`, or `less` on a long file), interact with it, and confirm input
   reaches the child and output/redraw render correctly.
4. Exit the TUI and the shell (`exit` / Ctrl-D).
5. Back at your original shell, confirm the terminal is restored to cooked mode:
   local echo and line editing work and there are no raw-mode artifacts. (Unix:
   re-run `stty -a` and confirm it matches step 1.)

**Expected result:**
- The actor engine hosts the attached session with full interactive fidelity:
  keystrokes reach the child (`SessionEvent::LocalInput`, 4096-byte chunks),
  output/replay renders through the FIFO console writer, and a nested full-screen
  app is fully interactive.
- On exit the platform mode guard restores **every** mode it changed on `Drop`,
  so the launching shell is never left in raw mode. On Windows the console
  input/output modes set via `SetConsoleMode` are restored by the Windows mode
  guard, and console input read as UTF-16 via `ReadConsoleW` is converted to
  UTF-8 before it reaches the child.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-02 — Headless session and dashboard attach / replay

- **ID:** DAR-02
- **Feature / phase:** Daemon actor rewrite — detached headless daemon; IPC
  socket; scrollback replay to a late viewer
- **Preconditions:** Built client; a running `climon server` dashboard;
  `CLIMON_SESSION_ENGINE=actor` exported.
- **Config-matrix cell:** all (detached daemon + one browser viewer)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Export `CLIMON_SESSION_ENGINE=actor`.
2. Start a headless session that produces output over time, e.g.
   `climon run --headless bash -lc 'for i in $(seq 1 50); do echo "line $i"; sleep 0.2; done'`
   (Windows: `climon run --headless cmd /c "for /L %i in (1,1,50) do @(echo line %i & timeout /t 1 >NUL)"`).
   It prints the new session id and returns immediately (no attached terminal).
3. Confirm a detached daemon is running: `climon ls` shows the session `running`,
   and `logs/daemon/<id>.log` exists.
4. After the command has emitted a good amount of output, open the session in the
   dashboard — attaching mid-stream.
5. Observe the initial render, then continued live output.

**Expected result:**
- The detached actor daemon owns the PTY independently of the dashboard. A viewer
  attaching mid-stream first receives a full scrollback **replay** (the shadow
  buffer, capped ~256 KB) and then live output, so it never misses earlier bytes;
  the session status stays `running`. Closing the dashboard leaves the daemon and
  its command running.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-03 — Dashboard / PWA take-control and local Space reclaim

- **ID:** DAR-03
- **Feature / phase:** Daemon actor rewrite — one-controller handoff across
  surfaces; local **Space** take-control; PTY resize to controller
- **Preconditions:** Built client; a running dashboard; a browser and (optionally)
  the installed PWA.
- **Config-matrix cell:** all (attached local terminal + browser/PWA); local
  terminal-size behaviour is authoritative on macOS/Linux (on Windows the
  daemon's local terminal size is a fixed stub, so local-size-dependent PTY
  sizing is not exercised there — Space reclaim + repaint still are)
- **Platforms:** macOS, Linux (local-size authoritative); Windows (Space reclaim
  + repaint)

**Steps:**
1. Start an attached actor session: `CLIMON_SESSION_ENGINE=actor climon shell`.
   The local terminal is the default controller.
2. Open the session in a browser dashboard and take control (click the session /
   open its terminal). The browser becomes controller; the shared PTY resizes to
   the browser viewport.
3. Observe the local terminal: it is **displaced** — it blanks behind the *"This
   session is being viewed on a climon dashboard."* / *"Press Space to take
   control."* notice and swallows every keystroke except Space.
4. (PWA/priority) Open the same session in a second surface (installed PWA or a
   phone-sized viewer) and take control there; confirm the newest take-control
   wins and the previous controller becomes displaced.
5. In the local terminal, press **Space** to reclaim control.

**Expected result:**
- The daemon tracks exactly one controller and the shared PTY grid always equals
  the controller's size; every change broadcasts a `Control` frame. Taking
  control from a browser/PWA displaces the local terminal (identity-based, not
  size-based). Pressing **Space** locally reclaims control, resizes the PTY back
  to the local terminal, and requests a fresh replay so the screen repaints
  immediately (never left blank on an idle screen); Space is take-control input
  only while displaced, and ordinary shell input once the local terminal
  controls the grid.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-04 — Local restore and same-size repaint jiggle

- **ID:** DAR-04
- **Feature / phase:** Daemon actor rewrite — jiggle-repaint on restore /
  same-size take-control (both-dimension jiggle across two timer ticks)
- **Preconditions:** Built client; a running dashboard.
- **Config-matrix cell:** all (local terminal + one browser viewer)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start an attached actor session running a full-screen TUI:
   `CLIMON_SESSION_ENGINE=actor climon run htop` (or `vim`).
2. Open the session in a browser, take control, and resize the browser terminal
   **larger** than the local terminal so the local terminal is displaced.
3. In the local terminal, press **Space** to reclaim (or shrink the browser back
   to the local size and disconnect it) — a restore.
4. Same-size take-control: launch a frame-caching TUI
   (`CLIMON_SESSION_ENGINE=actor climon run copilot`), open it in a browser
   whose grid already matches the PTY size, and take control **without** resizing.

**Expected result:**
- When control moves to a surface at (or back to) the same PTY size — so no
  `SIGWINCH` would otherwise fire — the daemon jiggles the PTY one column
  narrower and one row shorter, then back, across two timer ticks. Changing
  **both** dimensions forces even frame-caching TUIs (Ink / `copilot`) to redraw,
  and the inter-tick gap defeats resize coalescing, so the wrapped app repaints
  its authoritative screen on top of climon's shadow-grid repaint. At most a
  brief one-column/one-row flicker is acceptable; no stale or half-painted screen.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-05 — Attention flag, acknowledgement, and resize stickiness

- **ID:** DAR-05
- **Feature / phase:** Daemon actor rewrite — static-screen attention
  detection (daemon screen-idle sampling), user acknowledgement, and
  resize-is-not-activity (`domain/attention.rs`, `attention.rs`, `idle.rs`)
- **Preconditions:** An actor session with a viewer; `attention.idleSeconds`
  known (default 10 — optionally set it small, e.g. `climon config
  attention.idleSeconds 3`, for a quicker run).
- **Config-matrix cell:** all (local terminal + one browser viewer)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start an actor session with a dashboard viewer open, e.g.
   `CLIMON_SESSION_ENGINE=actor climon shell`.
2. Leave the visible screen static (an idle shell prompt, no output) for at least
   `attention.idleSeconds`.
3. Confirm the session flips to `needs-attention` (in the dashboard and in
   `climon ls`).
4. Acknowledge from the dashboard (focus/open the session). Confirm attention
   clears and the status returns to `running`.
5. Idle again to re-flag `needs-attention`. While flagged, resize the terminal or
   the browser viewport (a dimension change only, with no new program output).
   Confirm the flag **stays**.
6. After the resize, acknowledge again from the dashboard and confirm the
   acknowledgement is still accepted.

**Expected result:**
- After the screen is static for `attention.idleSeconds`, the idle detector (on
  an internal screen fingerprint that is never sent over the wire) flips the
  session to `needs-attention`. A user acknowledgement clears attention only when
  it references the current attention token **and** the screen has not changed
  since it was flagged; a differing dimension header (a resize reflow) makes the
  content comparison meaningless, so the acknowledgement passes through. A pure
  resize is **not** program activity — the fingerprint body ignores the
  `{cols}x{rows}` header — so `needs-attention` stays sticky across a resize.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-06 — Terminal title and progress capture

- **ID:** DAR-06
- **Feature / phase:** Daemon actor rewrite — OSC 0/2 title and OSC 9;4 progress
  capture, debounced, persisted, passthrough (`title_capture.rs`)
- **Preconditions:** An actor session with a dashboard viewer open.
- **Config-matrix cell:** all (browser viewer)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start an actor session: `CLIMON_SESSION_ENGINE=actor climon shell`, open in the
   dashboard.
2. Set a window title: `printf '\033]0;dar-title\007'` (and try the `OSC 2` form
   `printf '\033]2;dar-title-2\007'`).
3. Emit determinate progress: `printf '\033]9;4;1;42\007'`, then clear it with
   `printf '\033]9;4;0;0\007'`. Optionally try the non-determinate states:
   `3` (indeterminate), `2` (error), `4` (warning).
4. Observe the dashboard subtitle and the per-session progress indicator, and
   inspect the persisted metadata `sessions/<id>.json` (`terminalTitle`,
   `progress`).

**Expected result:**
- The daemon scans PTY output for `OSC 0`/`OSC 2` titles and `OSC 9;4` progress,
  debounces them (~300 ms), and persists the latest `terminalTitle` and
  `progress` to metadata; both are **passthrough** — the bytes are still
  forwarded to the client untouched. The dashboard shows the title as the session
  subtitle and renders `progress` per session (a determinate bar, spinner, or
  error/warning icon). Clearing progress (`state 0`) removes the indicator.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-07 — Fast exit, failed exit, final scrollback, and socket cleanup

- **ID:** DAR-07
- **Feature / phase:** Daemon actor rewrite — ordered exit finalization
  (`domain/lifecycle.rs`), exit-code propagation, and socket cleanup
- **Preconditions:** Built client; `CLIMON_SESSION_ENGINE=actor` exported.
- **Config-matrix cell:** all (socket-cleanup step differs by transport — see the
  matrix note)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. **Fast exit + early output:**
   `climon run sh -c 'echo done; exit 0'`
   (Windows: `climon run cmd /c "echo done & exit 0"`). Confirm the `done`
   output was captured even though the command exited almost immediately.
2. **Failed exit:** `climon run sh -c 'echo boom; exit 7'`
   (Windows: `climon run cmd /c "echo boom & exit 7"`).
3. For each session, after exit inspect:
   - the final scrollback file `sessions/<id>.scrollback` — it holds the final
     output;
   - metadata `sessions/<id>.json` — `status` is `completed` (exit 0) or `failed`
     (exit 7), `exitCode` is `0` / `7`, and `completedAt` is set.
4. **Socket cleanup:** confirm the per-session listener is gone. With the default
   loopback-TCP `socket_path`, the listener is closed and its OS-assigned port
   released (no file to inspect). With a Unix-domain-socket `socket_path`, the
   `.sock` file is removed from disk.

**Expected result:**
- On PTY exit the actor runs the fixed, ordered finalization sequence: persist
  the final scrollback → patch terminal status (`completed`/`failed`, `exitCode`,
  `completedAt`) → send `Exit` frames to clients → restore the local screen →
  close clients. Exit codes propagate exactly (`0` and `7`), and early output /
  fast exits are captured. Teardown then cancels the adapters, terminates and
  reaps the child, joins every owned task within the bounded deadline, and cleans
  the socket: `cleanup_session_socket` removes the file for a Unix domain socket
  and is a no-op for a loopback-TCP reference (whose closed listener releases the
  port).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-08 — Slow / disconnecting viewer isolation

- **ID:** DAR-08
- **Feature / phase:** Daemon actor rewrite — per-client outbound isolation
  (`adapters/ipc.rs`) and degradable console route (`engine/coordinator.rs`)
- **Preconditions:** An actor session with a dashboard; a way to make one viewer
  slow or to disconnect it abruptly (browser network throttling / suspend the
  tab / close it).
- **Config-matrix cell:** all (local terminal + two browser viewers)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start an actor session that produces steady, high-volume output, e.g.
   `CLIMON_SESSION_ENGINE=actor climon run bash -lc 'seq 1 1000000'`
   (Windows: a comparable fast-output command), attached locally with two browser
   viewers open.
2. Make one viewer **slow** (throttle it to a very low bandwidth in dev-tools, or
   suspend/background the tab), or **abruptly disconnect** it (close the tab / cut
   the network).
3. Observe the second (healthy) viewer, the local terminal, and the PTY.

**Expected result:**
- A slow or wedged client cannot block the IPC manager, the coordinator, the PTY
  reader, or any other client: each connection has its own bounded outbound queue
  drained by its own blocking writer, and sends use non-blocking `try_send`. A
  full/closed per-client queue or a write failure yields exactly one
  `ClientSendFailed` and the adapter tears down **only that client** (first-wins
  terminal outcome); an abrupt disconnect yields exactly one `ClientDisconnected`.
  The healthy viewer and the PTY keep streaming throughout. If the **local
  console** itself wedges, its bounded route saturates and the coordinator drops
  the console write and degrades the local view rather than blocking — the PTY and
  connected clients continue unaffected.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-09 — SIGINT / SIGTERM and Windows process termination

- **ID:** DAR-09
- **Feature / phase:** Daemon actor rewrite — signals/resize adapter
  (`adapters/signals.rs`), child reap and terminal restore on teardown, Windows
  console-input cancellation
- **Preconditions:** An actor session; know the daemon PID — the `daemonPid`
  field in the session metadata `$CLIMON_HOME/sessions/<id>.json` (`climon ls`
  does not print the PID).
- **Config-matrix cell:** all (signal delivery is Unix-specific; process
  termination and console-resize polling are called out per cell)
- **Platforms:** macOS, Linux (signals); Windows (resize poller + termination)

**Steps:**
1. **Unix — SIGINT/SIGTERM:** start a headless actor session
   `CLIMON_SESSION_ENGINE=actor climon run --headless sleep 300`; read its
   `daemonPid` from `$CLIMON_HOME/sessions/<id>.json`; send `kill -INT <pid>`
   (and, in a second run, `kill -TERM <pid>`). Optionally send the same signal
   twice to confirm idempotency.
2. **Unix — SIGWINCH:** with an attached actor session
   (`CLIMON_SESSION_ENGINE=actor climon shell`) running a full-screen app, resize
   the terminal window and confirm the app reflows to the new size.
3. **Windows — termination:** start an actor session, then terminate the daemon
   with `climon kill <id>` (or `taskkill /PID <pid>`). Resize the console during a
   run and confirm redraws only happen when the size actually changes.

**Expected result:**
- On Unix the signal loop registers `SIGTERM`/`SIGINT`/`SIGWINCH`:
  `SIGTERM`/`SIGINT` emit `ShutdownRequested` (idempotent; they never kill the
  PTY directly) which drives the ordered finalization, and `SIGWINCH` reads the
  current local size and emits `LocalResized` so the grid/app reflows. On Windows
  (no `SIGWINCH`) a 200 ms poller emits `LocalResized` only when the console size
  changes, and terminating the daemon tears it down cleanly. Either way the
  child-owner loop reaps the child, the cancellable input worker interrupts a
  blocked read (on Windows via `CancelSynchronousIo` on the exact `ReadConsoleW`
  thread) so teardown stays bounded, and the session is finalized — terminal
  restored, socket cleaned, and a terminal status + final scrollback persisted.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## DAR-10 — Actor-to-legacy rollback via `CLIMON_SESSION_ENGINE`

- **ID:** DAR-10
- **Feature / phase:** Daemon actor rewrite — engine selection and rollback
  (`rust/climon-session/src/host/mod.rs`, `host/legacy.rs`)
- **Preconditions:** Built client.
- **Config-matrix cell:** all (engine selection is platform-independent)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. **Default (legacy):** with `CLIMON_SESSION_ENGINE` unset, run a session
   (`climon run sh -c 'echo hi'` / attach a `climon shell`). This uses the
   legacy engine — the shipping default.
2. **Actor:** re-run with `CLIMON_SESSION_ENGINE=actor`; the session is hosted by
   the actor engine. Confirm identical externally-visible behaviour (I/O, status,
   scrollback).
3. **Rollback:** set `CLIMON_SESSION_ENGINE=legacy` (or unset it) and re-run;
   behaviour returns to the legacy engine. This is the one-variable rollback
   lever — no rebuild.
4. **Invalid value:** run with `CLIMON_SESSION_ENGINE=future`. For an attached run
   the error surfaces to the terminal; for a headless daemon engine selection
   fails **before** the daemon logger is initialized, so the error is written to
   the detached daemon's redirected stderr in `sessions/<id>.log` (not the daemon
   log `logs/daemon/<id>.log`) and the daemon exits immediately without starting
   the session.

**Expected result:**
- `run_session_host` selects the engine from `CLIMON_SESSION_ENGINE`: unset /
  empty / `legacy` → the legacy engine (default); `actor` → the actor engine; any
  other value → a failure with the exact message
  `invalid CLIMON_SESSION_ENGINE '<value>'; expected 'legacy' or 'actor'`. Because
  the variable is read at each daemon start and inherited by the detached daemon,
  switching it (or unsetting it) is a complete rollback to the legacy engine with
  no code change. The legacy engine remains the default until this release gate
  passes and Task 18 flips it.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
