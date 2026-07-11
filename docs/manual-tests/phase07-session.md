# Phase 7 — `climon-session` crate (session host: PTY + IPC + relay)

These cases prove that the ported session host (`rust/climon-session`) behaves
like the TypeScript client's session host across the three first-class
platforms, on the live wire/metadata boundary that browsers and the unmodified
Bun `climon-server` actually exercise. They cover the attach/detach local
relay, the shared-PTY control-handoff model (single controller, follow/displaced
surfaces), screen-idle → needs-attention →
input-clears attention, dashboard rename → title broadcast, headless
(background) sessions, the completed/failed lifecycle, and a best-effort
live-interop round-trip against a spawned
unmodified Bun server.

Background: Phase 7 ports `src/session-host.ts` and the richer superset
`src/daemon/daemon.ts` (plus `src/daemon/idle-detector.ts`,
`src/daemon/buffer.ts`, `src/session-socket.ts`, `src/terminal-replay.ts`) into
one cohesive `SessionHost` (`rust/climon-session/src/host.rs`) with the
mouse-private-mode replay suffix, the shared-PTY control-handoff controller model
(`src/control.rs`), and the
attached-only local relay gated behind a `headless` flag. The screen-idle
fingerprint is rendered by a `vt100`-backed headless grid
(`src/fingerprint.rs`); it is **internal** daemon state never sent over the
wire, so it does not require byte-parity with xterm.js. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 7 plan](../superpowers/plans/2026-06-18-phase07-climon-session.md).

This phase spans the **PTY backend** and **transport** dimensions, so several
cases form a configuration matrix:

| Cell | OS | PTY backend | IPC transport | Local relay |
|---|---|---|---|---|
| SESS-unix-linux | Linux (x64) | `openpty` | Unix domain socket | termios raw mode + `SIGWINCH` |
| SESS-unix-macos | macOS (arm64) | `openpty` | Unix domain socket | termios raw mode + `SIGWINCH` |
| SESS-win | Windows (x64) | ConPTY | loopback TCP | console raw mode (VT input/output) + size poll |

Run the cases on each listed platform. Steps that differ per cell call it out.
On macOS, Unix-domain-socket paths under deep temp dirs can exceed `SUN_LEN`
(~104 bytes); the automated tests therefore use loopback-TCP refs, but real
sessions under `$CLIMON_HOME/sock/<id>.sock` stay well under the limit.

---

## MT-P7-01 — `climon-session` builds, tests, and lints on all 3 OSes

- **ID:** MT-P7-01
- **Feature / phase:** Phase 7 — `climon-session` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`; Bun installed for the cross-language fixture test.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-session`.
3. Test: `cargo test -p climon-session` (pure modules + `fixtures` +
   `session_integration`).
4. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.
5. License gate: `cargo deny check` and confirm `THIRD-PARTY-LICENSES.md` is
   regenerated + idempotent.
6. Cross-language fixtures (from repo root): `bun test tests/session-fixtures.test.ts`.

**Expected result:**
- The crate compiles and all `climon-session` tests are green on each platform.
- `fmt --check` reports no diffs; `clippy -D warnings` produces no warnings.
- `cargo deny check` reports `advisories ok, bans ok, licenses ok, sources ok`.
- The Bun fixture test passes (Rust and Bun encoders produce identical bytes).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-02 — Attach: local relay (stdin → PTY, output → terminal, SIGWINCH)

- **ID:** MT-P7-02
- **Feature / phase:** Phase 7 — attached local relay
- **Preconditions:** A built launcher harness (or Phase 8 `climon` client) that
  calls `run_session_host(id, meta, { headless: false })` on a real controlling
  terminal.
- **Config-matrix cell:** SESS-unix-linux, SESS-unix-macos
- **Platforms:** Linux, macOS

**Steps:**
1. Start an attached session running an interactive shell (e.g. `/bin/bash -i`)
   at the current terminal size.
2. Type commands; confirm keystrokes reach the shell and output is echoed back
   to your terminal in raw mode (no double echo, arrow keys / Ctrl-C work).
3. Resize the terminal window. Confirm the PTY (and any running TUI like
   `htop`/`vim`) reflows to the new size (`SIGWINCH` → host resize).
4. Detach/quit the harness; confirm the terminal returns to cooked mode
   (raw-mode guard restored on drop).

**Expected result:**
- Stdin is forwarded byte-for-byte to the PTY; PTY output is mirrored to the
  local terminal.
- A window resize updates the PTY dimensions via the `SIGWINCH` handler reading
  `terminal_size(STDIN)` and applying a `source: host` resize.
- Raw mode is enabled on attach and reliably restored on exit.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-09 — Attach: Windows console local relay (cmd.exe / PowerShell input)

- **ID:** MT-P7-09
- **Feature / phase:** Phase 7 — attached local relay (Windows)
- **Preconditions:** A Windows build of the `climon` client; launch from a real
  console host (`cmd.exe`, PowerShell, or Windows Terminal) — not a redirected
  pipe.
- **Config-matrix cell:** SESS-win
- **Platforms:** Windows (x64)

**Steps:**
1. From `cmd.exe`, start an attached session running an interactive shell
   (e.g. `climon powershell` or `climon cmd`).
2. Type commands in the **launching console**; confirm keystrokes reach the
   shell with no local line-buffering or double echo, and that arrow keys,
   Backspace, Tab-completion, and Ctrl-C all work.
3. Open the dashboard for the same session and type there too; confirm **both**
   the local console and the dashboard can drive the session simultaneously.
4. Resize the console window; confirm a running TUI reflows to the new size
   (console-size poller → `source: host` resize).
5. Exit the session; confirm the console returns to normal cooked mode (typed
   characters are echoed/line-buffered again — input mode restored on drop).

**Expected result:**
- Local console keystrokes are forwarded byte-for-byte to the PTY (regression
  guard for the bug where only the dashboard could type). The console input
  buffer is put in raw mode (`ENABLE_LINE_INPUT`/`ENABLE_ECHO_INPUT`/
  `ENABLE_PROCESSED_INPUT` cleared, `ENABLE_VIRTUAL_TERMINAL_INPUT` set) and VT
  output processing is enabled so escape sequences render.
- A window resize forwards a `source: host` resize via the size poller.
- The saved console input/output modes are restored when the session ends.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-10 — Attach: typing `exit` yields back to the host shell (no hang)

- **ID:** MT-P7-10
- **Feature / phase:** Phase 7 — PTY teardown / reader EOF on master drop
- **Preconditions:** A `climon` client build; launch from a real interactive
  console. Most valuable on **Windows (ConPTY)**, where the bug reproduced; also
  re-confirm on macOS/Linux for no regression.
- **Config-matrix cell:** SESS-win (primary), SESS-mac, SESS-linux
- **Platforms:** Windows (x64), macOS, Linux

**Steps:**
1. From your shell (`cmd.exe`/PowerShell on Windows, or any terminal), start an
   attached session running an interactive shell (e.g. `climon cmd`,
   `climon powershell`, or `climon bash`).
2. Type `exit` (or press Ctrl-D where applicable) in the **local console** to end
   the child shell.
3. Confirm the `climon` process returns control to the **launching shell**
   promptly — a fresh host prompt appears and you can type again. It must **not**
   hang requiring you to kill the process.
4. Repeat with the dashboard open (a browser viewer connected) and confirm
   `exit` still yields cleanly.

**Expected result:**
- The session host drops the PTY master after the child exits, closing the
  ConPTY pseudoconsole so the output-reader thread EOFs and `run_session_host`
  returns. Control returns to the host shell with no hang. Regression guard for
  the Windows `exit`-hangs bug (cloned ConPTY reader never EOFing because a
  `PtyResizer` kept a strong master reference).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-11 — (superseded) Overgrown browser viewer / Fill-mode gating

- **ID:** MT-P7-11
- **Status:** **Superseded** by the control-handoff model. Fill-mode overgrown
  gating no longer exists — the shared PTY is always sized to the single
  **controller**, and a surface too small to render the controller grid is
  *displaced* (blanked behind a Take-control screen) rather than shown an
  "overgrown" notice. See
  [terminal-control-handoff.md](terminal-control-handoff.md) (TCH-2, TCH-5).

- **ID:** MT-P7-03
- **Feature / phase:** Phase 7 — headless flag
- **Preconditions:** Harness calling `run_session_host(id, meta, { headless: true })`.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start a headless session running a long-lived command (e.g. `sleep 300`).
2. Confirm the controlling terminal is **not** put into raw mode and no stdin is
   consumed by the session (you can still use your shell normally).
3. Connect a client to the advertised socket (`socket_path` in the session
   metadata) and confirm initial frames (PtySize, TerminalMode, Replay) arrive.

**Expected result:**
- No raw-mode/`SIGWINCH`/stdin threads are installed (headless gate + `isatty`
  check).
- The IPC socket server still accepts connections and serves frames.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-04 — (superseded) Browser viewer resize: clamp + revert

- **ID:** MT-P7-04
- **Status:** **Superseded** by the control-handoff model. There is no
  clamp/Fill toggle and no last-viewer revert-to-host-size: the shared PTY tracks
  the current **controller's** size, and on controller disconnect the daemon falls
  back to the highest-priority remaining surface (`pwa` > `dashboard` >
  `terminal`, ties by most-recently-connected). See
  [terminal-control-handoff.md](terminal-control-handoff.md) (TCH-2, TCH-4).

---

## MT-P7-05 — Idle → needs-attention → input clears it (three-state patch)

- **ID:** MT-P7-05
- **Feature / phase:** Phase 7 — `ScreenIdleDetector` + `applyAttention`
- **Preconditions:** `attention.idleSeconds` set to a small value (e.g. `2`) in
  `$CLIMON_HOME/config.jsonc`. A running session and a viewer client.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start a session running a command that leaves the screen static (e.g. a shell
   sitting at a prompt, or `sleep 60`).
2. Wait `idleSeconds`. Confirm the session metadata flips to
   `status: needs-attention`, `priorityReason: attention`, with
   `attentionMatchedAt` + `attentionReason` set.
3. From the browser viewer (or by sending an `Attention { needsAttention:false,
   attentionMatchedAt:<the token> }` frame), acknowledge the attention while the
   screen is unchanged. Confirm the metadata flips to `status: acknowledged` and
   that `attentionMatchedAt` / `attentionReason` are **removed** from the JSON
   (the Phase 5 `Some(None)` three-state clear, not left as `null`).
4. Produce new output (type a command). Confirm the detector re-baselines and
   does not immediately re-flag.

**Expected result:**
- The idle detector flags attention after `idleSeconds` of an unchanged screen
  fingerprint.
- A matching-token acknowledgement clears attention and **deletes** the
  `attentionMatchedAt` / `attentionReason` keys via `Some(None)`.
- A stale token or a changed screen does **not** clear attention
  (`shouldApplyUserAttentionAcknowledgement`).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-09 — Acknowledged stays acknowledged across session switch / resize

- **ID:** MT-P7-09
- **Feature / phase:** Phase 7 — `ScreenIdleDetector` dimension-aware change
  detection + `acknowledge`
- **Preconditions:** `attention.idleSeconds` set to a small value (e.g. `2`) in
  `$CLIMON_HOME/config.jsonc`. The dashboard open with at least two sessions.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start a session that leaves the screen static (e.g. `sleep 120`) and wait
   `idleSeconds` so it flips to `status: needs-attention`.
2. In the dashboard, view that session and acknowledge it (any input / focus that
   sends the matching-token acknowledgement). Confirm `status: acknowledged`.
3. Switch the dashboard to another session and back, and/or resize the browser
   window (changing the viewer dimensions). The acknowledged session's screen
   content does not change — only its dimensions do.
4. Leave it idle for more than another `idleSeconds`.

**Expected result:**
- The acknowledged session **stays `acknowledged`**. Switching sessions or
  resizing (a dimension-only fingerprint difference, or a reflow absorbed on
  resize) never flips it to `running`.
- While its screen stays unchanged, the acknowledged session does **not** re-flag
  `needs-attention`.
- Only a genuine screen-content change (real program output) resumes normal
  detection (`running`, then re-flag after a fresh idle window).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-10 — Acknowledged survives a control-handoff resize redraw

- **ID:** MT-P7-10
- **Feature / phase:** Phase 7 — `ScreenIdleDetector` post-resize settle window
  (`absorb_resize` + `RESIZE_SETTLE_MS`)
- **Preconditions:** A small `attention.idleSeconds` (e.g. `2`) in
  `$CLIMON_HOME/config.jsonc`. The dashboard open with at least two sessions. Use
  an interactive shell (e.g. `zsh` or `bash`) as the session command so it
  **redraws its prompt on `SIGWINCH`**.
- **Config-matrix cell:** default config
- **Platforms:** macOS, Linux, Windows

**Background:** This reproduces the real "Acknowledged → Running" report. When a
larger browser surface takes control it grows the shared PTY; switching away
disconnects it, so control falls back to the attached local terminal and the
daemon resizes the PTY back down to it. That resize delivers a `SIGWINCH` whose
**redraw output lands asynchronously** on the PTY reader thread, *after* the
synchronous re-baseline — previously it was misread as activity and reverted the
acknowledged session to `running`.

**Steps:**
1. Start an interactive-shell session and let it sit at a static prompt; wait
   `idleSeconds` so it flips to `status: needs-attention`.
2. In the dashboard, view that session in a browser **wider than the local
   terminal** and **take control** (maximize) so it grows the PTY; acknowledge it.
   Confirm `status: acknowledged`.
3. **Switch away** to another session (disconnecting the controller of the first
   one). Control falls back to the local terminal, resizing its PTY back down and
   triggering the shell's `SIGWINCH` prompt redraw.
4. Watch the first session's status for several seconds.

**Expected result:**
- The acknowledged session **stays `acknowledged`**. The trailing async redraw
  from the control-handoff resize is absorbed by the post-resize settle window and
  never flips it to `running`.
- Only a genuine screen-content change (real program output, well after the
  resize settles) resumes normal detection (`running`, then re-flag after a fresh
  idle window).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---


- **ID:** MT-P7-06
- **Feature / phase:** Phase 7 — terminal-title capture thread
- **Preconditions:** A running session and a connected viewer (dashboard).
- **Config-matrix cell:** default config
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. In the session's PTY, run `printf '\033]0;captured-title\007'`.
2. Confirm the captured title is written to session metadata as `terminalTitle`
   within ~1s (the capture thread flushes on change).
3. Confirm the dashboard shows `captured-title` as a subtitle under the session
   name (see also [terminal-title-subtitle.md](terminal-title-subtitle.md)).

**Expected result:**
- The daemon parses the OSC 0/2 title from PTY output and stores it in
  `terminalTitle` metadata; renaming the session does NOT push the name to the
  attached terminal's title (that behavior was removed).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-07 — Lifecycle: completed vs failed + final scrollback + Exit frame

- **ID:** MT-P7-07
- **Feature / phase:** Phase 7 — lifecycle teardown
- **Preconditions:** A built harness/launcher.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run a session whose command exits `0` (e.g. `sh -c 'printf done'`). Confirm
   the metadata becomes `status: completed`, `exitCode: 0`, with `completedAt`
   set, the final scrollback is persisted, and connected viewers receive an
   `Exit { exitCode:0 }` frame before the socket closes.
2. Run a session whose command exits non-zero (e.g. `sh -c 'exit 3'`). Confirm
   `status: failed`, `exitCode: 3`.
3. Connect a **new** viewer *after* the session has exited. Confirm it receives
   the replay then an immediate `Exit` frame and the connection closes.

**Expected result:**
- Exit code `0` → `completed`; non-zero → `failed`, with `completedAt`,
  `exitCode`, and `lastActivityAt` recorded and the final scrollback written.
- Late viewers get replay + `Exit` and are disconnected.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P7-08 — Live interop: viewer round-trip through an unmodified Bun server

- **ID:** MT-P7-08
- **Feature / phase:** Phase 7 — wire/metadata interop boundary
- **Preconditions:** Bun installed; the unmodified Bun `climon-server`
  (`bun src/server.ts server`) available; a Rust-hosted session writing metadata
  + binding a socket under the same `$CLIMON_HOME`.
- **Config-matrix cell:** all; browser cell for the final hop
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Point `CLIMON_HOME` at a scratch dir. Start the unmodified Bun server:
   `bun src/server.ts server` (note the dashboard URL).
2. Launch a Rust-hosted session (headless is fine) under the same `CLIMON_HOME`
   running an interactive program that prints recognizable output.
3. Open the dashboard URL in a browser and select the session. Confirm:
   - the replay renders the scrollback (including mouse-mode re-assertion),
   - live output streams to the browser,
   - typing in the browser reaches the PTY,
   - resizing the browser terminal resizes the PTY when it is the controller
     (control-handoff),
   - renaming updates the title.
4. Cross-check the bytes are identical to the Bun client by repeating with a
   Bun-hosted session and diffing the captured frames if any discrepancy is
   suspected.

**Expected result:**
- A browser viewer connected **through the unmodified Bun server** to a
  Rust-hosted session round-trips replay/output/input/resize/title with no
  protocol errors — proving byte-for-byte wire interop.

**Why this is manual:** it requires a real browser, a running Bun server, and a
multi-process setup that the Rust integration tests (which connect a raw socket
client directly to the host) cannot fully stand in for. The Rust
`session_integration` tests cover the socket-level round-trip; this case covers
the full browser↔server↔host path.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
