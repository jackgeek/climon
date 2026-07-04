# Phase 7 — `climon-session` crate (session host: PTY + IPC + relay)

These cases prove that the ported session host (`rust/climon-session`) behaves
like the TypeScript client's session host across the three first-class
platforms, on the live wire/metadata boundary that browsers and the unmodified
Bun `climon-server` actually exercise. They cover the attach/detach local
relay, browser-viewer resize clamp + revert, screen-idle → needs-attention →
input-clears attention, dashboard rename → title broadcast, headless
(background) sessions, the completed/failed lifecycle, the host
overgrown-warning, and a best-effort live-interop round-trip against a spawned
unmodified Bun server.

Background: Phase 7 ports `src/session-host.ts` and the richer superset
`src/daemon/daemon.ts` (plus `src/daemon/idle-detector.ts`,
`src/daemon/buffer.ts`, `src/session-socket.ts`, `src/terminal-replay.ts`) into
one cohesive `SessionHost` (`rust/climon-session/src/host.rs`) with the
mouse-private-mode replay suffix, the host overgrown-warning, and the
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

## MT-P7-11 — Attach: overgrown browser viewer pauses local output (no blank screen)

- **ID:** MT-P7-11
- **Feature / phase:** Phase 7 — Fill-mode overgrown gating for the in-process host
- **Preconditions:** A `climon` client build and a running `climon server`
  dashboard. Default config (`terminal.clampBrowserToHost = false`, i.e. Fill
  mode). Launch from a real interactive console.
- **Config-matrix cell:** SESS-win (primary), SESS-mac, SESS-linux
- **Platforms:** Windows (x64), macOS, Linux

**Steps:**
1. Start an attached session from a **small** local console window (so it is
   easy for a browser to be larger), e.g. `climon bash`.
2. Open the same session in the dashboard in a **large** browser window /
   maximized terminal pane, so the browser viewer grows the shared PTY beyond
   the local console (Fill mode). On the local console you should now see the
   `[climon] A browser viewer enlarged this session …` notice.
3. Type/scroll in the dashboard. Confirm the **local console screen is NOT
   blanked or corrupted** — local PTY rendering is paused and frozen at the
   notice, while the dashboard renders normally.
4. Restore: either click the **lock icon** on the active session in the
   dashboard (clamp mode), shrink the browser to the local size, or close the
   browser viewer. Confirm that after a brief moment (~250 ms) the local console
   **repaints the current session content** (matching the dashboard) instead of
   staying blank — including on Windows `cmd.exe`/ConPTY, where the resize
   triggers an asynchronous clear-and-repaint.

**Expected result:**
- In Fill mode, when a browser viewer enlarges the shared PTY beyond the local
  terminal, the in-process host **pauses** local stdout writes and prints the
  overgrown notice instead of writing oversized output that would blank/corrupt
  the local screen. Dashboard viewers, scrollback, and the headless grid still
  receive every byte. The pause is **level-triggered on the real corruption
  condition — the PTY currently exceeds the local console in either dimension
  (`HostState::local_terminal_exceeded`) — independent of resize mode**, NOT
  edge-triggered on the Fill-gated dashboard warning. (Edge-triggering drifted:
  the local terminal could end up resumed while the PTY was still larger than the
  console, so no notice showed and ConPTY corrupted it.) The notice therefore
  reliably appears whenever the dashboard is bigger than the local terminal and
  stays until the PTY fits again. On restore (clamp / shrink / close viewer) the
  local terminal **stays paused for a short delay (`LOCAL_RESTORE_DELAY`, ~250 ms)**
  so the PTY's resize-repaint burst drains first, then the local console is
  **repainted from the parsed grid's current screen** (`HeadlessGrid::render_screen`,
  a sequential `vt100` repaint using only `\r\n` between rows — no absolute cursor
  positioning, trailing blank rows trimmed) — NOT a raw scrollback replay, which on
  Windows ConPTY stacks lines on top of each other (absolute-cursor / missing
  carriage-return corruption). The deferral is load-bearing on Windows ConPTY: an
  immediate repaint would be clobbered by the asynchronous resize-repaint, leaving
  the terminal blank. **When the watcher fires it re-checks `local_terminal_exceeded`
  and only repaints + resumes if the PTY now fits the local console** — if a viewer
  re-grew during the delay the local terminal stays suppressed, because resuming
  while still larger than the console would expose ConPTY's tall-grid absolute-
  positioned live output (e.g. `\e[34;1H` for a 57-row PTY) to the shorter real
  console and stack the prompt over earlier lines. Regression guard for the ALT+TAB
  "screen clears to a blank cursor" bug, the "clamp leaves the local terminal blank"
  bug, the "restored output has missing carriage returns / stacked lines" corruption,
  and the "no overgrown message shown while the browser is bigger" bug.
- **Diagnostics:** if the Windows corruption recurs, set `CLIMON_DEBUG_RESTORE=1`
  before launching the attached client and reproduce the grow-then-restore. The
  host appends timestamped, escaped traces to `$CLIMON_HOME/logs/restore-debug.log`
  recording host/applied/**real console** sizes and the exact bytes at
  overgrow-suppress, restore-schedule, and restore-fire, plus every PTY chunk for
  ~2 s after unsuppress (to isolate whether the corrupter is our grid repaint or
  ConPTY's late live resize-repaint).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

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

## MT-P7-04 — Browser viewer resize: clamp + revert on last-viewer-disconnect

- **ID:** MT-P7-04
- **Feature / phase:** Phase 7 — `applyResize` / `revertToHostSize` /
  terminal-mode
- **Preconditions:** A running session (attached or headless) plus a browser
  dashboard served by an unmodified Bun `climon-server`, or a scripted viewer
  client that sends Resize frames.
- **Config-matrix cell:** all (browser is the cross-environment dimension)
- **Platforms:** macOS, Linux, Windows; Chromium + Firefox + WebKit for the
  browser cell

**Steps:**
1. With `terminal.clampBrowserToHost = false` (Fill default): open a browser
   viewer and resize the browser terminal **larger** than the host. Confirm the
   PTY grows to the viewer size and the host receives an **overgrown** warning
   frame.
2. Set `terminal.clampBrowserToHost = true` (Clamped) and reconnect: confirm a
   larger viewer is **clamped** to the host dimensions (a `PtySize` echoing the
   clamped size is broadcast).
3. With the viewer still larger (Fill), close the last browser viewer. Confirm
   the PTY **reverts** to the host terminal size and the terminal mode resets to
   the configured initial mode.

**Expected result:**
- Fill mode lets viewers grow the PTY beyond the host and raises/clears the host
  overgrown warning; Clamped mode pins viewers to the host size.
- When the last viewer disconnects, the PTY reverts to the host size and a
  `PtySize` frame is broadcast.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

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

## MT-P7-10 — Acknowledged survives a switch-away resize redraw (clamp off)

- **ID:** MT-P7-10
- **Feature / phase:** Phase 7 — `ScreenIdleDetector` post-resize settle window
  (`absorb_resize` + `RESIZE_SETTLE_MS`)
- **Preconditions:** `terminal.clampBrowserToHost = false` and a small
  `attention.idleSeconds` (e.g. `2`) in `$CLIMON_HOME/config.jsonc`. The dashboard
  open with at least two sessions. Use an interactive shell (e.g. `zsh` or `bash`)
  as the session command so it **redraws its prompt on `SIGWINCH`**.
- **Config-matrix cell:** `clampBrowserToHost = false`
- **Platforms:** macOS, Linux, Windows

**Background:** This reproduces the real "Acknowledged → Running" report. With
clamp **off**, viewing a session resizes the PTY larger; switching away
disconnects the last viewer, so the host reverts the PTY to its terminal size.
That revert delivers a `SIGWINCH` whose **redraw output lands asynchronously** on
the PTY reader thread, *after* the synchronous re-baseline — previously it was
misread as activity and reverted the acknowledged session to `running`.

**Steps:**
1. Start an interactive-shell session and let it sit at a static prompt; wait
   `idleSeconds` so it flips to `status: needs-attention`.
2. In the dashboard, view that session in a browser **wider than the host
   terminal** (clamp off grows the PTY) and acknowledge it. Confirm
   `status: acknowledged`.
3. **Switch away** to another session (disconnecting the last viewer of the first
   one). This reverts its PTY back to the host size and triggers the shell's
   `SIGWINCH` prompt redraw.
4. Watch the first session's status for several seconds.

**Expected result:**
- The acknowledged session **stays `acknowledged`**. The trailing async redraw
  from the switch-away resize is absorbed by the post-resize settle window and
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
   - resizing the browser terminal resizes the PTY (subject to clamp/Fill),
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
