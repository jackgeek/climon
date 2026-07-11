# Handoff — Terminal control: outstanding corruption and finalization

**Date:** 2026-07-11  
**Branch:** `terminal-control-handoff` (PR #108, targets `dev`)  
**Worktree:** `/Users/jackallan/dev/climon/.worktrees/terminal-control-handoff`  
**Current HEAD:** `fc37260`  
**Platform exercised:** macOS, Rust client daemon, Bun dashboard server

This document supersedes the troubleshooting state in
`2026-07-11-resize-spiral-handoff.md` without replacing that earlier timeline.
The resize spiral, dashboard overflow, local right-edge clipping, and dashboard
tab reclaim bugs are fixed. The remaining work is to diagnose the OSC palette
response corruption, manually verify the new local mouse-mode synchronization,
remove diagnostics, finish documentation and verification, and update PR #108.

## Current working tree

The work is uncommitted. At handoff time these files are modified:

- `docs/features.md`
- `docs/manual-tests/terminal-control-handoff.md`
- `rust/climon-session/src/fingerprint.rs`
- `rust/climon-session/src/host.rs`
- `rust/climon-session/src/replay.rs`
- `src/web/App.tsx`
- `src/web/components/TerminalView.tsx`
- `tests/app-layout.test.ts`
- `tests/terminal-view.test.ts`

Both handoff documents are untracked.

Do not discard or broadly rewrite these changes. They contain several
independently verified fixes plus temporary diagnostics.

## Verified fixes in the working tree

### Focus-driven resize spiral

Root cause: `onFocusCapture={refreshActiveTerminal}` called `refit()`. Xterm
refocused its helper textarea during terminal updates, which generated another
focus event and another double-`requestAnimationFrame` refit at roughly 40 ms
intervals.

Fix: focus and click now repaint the active terminal without fitting it. Geometry
events remain responsible for fitting and resize frames.

Regression coverage: `tests/terminal-view.test.ts`.

### Dashboard xterm overflow after a large terminal

Root cause: stale xterm canvas width contributed intrinsic flex width. The
terminal wrapper and root retained `min-width: auto`, so the flex chain could not
shrink to a narrower dashboard before FitAddon measured it.

Fix: `minWidth: 0` on the `TerminalView` wrapper and root.

The user confirmed the right-side clipping is fixed.

### Local restore lost right-hand cells

Root cause: the controller-sized `vt100::Screen` permanently discards cells when
resized narrower. Expanding it later cannot recover the clipped columns.

Fix: `render_screen_from_replay()` constructs a fresh host-sized grid from the
bounded raw PTY shadow for local repaint. The idle fingerprint grid remains
controller-sized.

Regression coverage: `rust/climon-session/src/fingerprint.rs`.

The user confirmed the right-side local restore clipping is fixed.

### Dashboard tab did not reclaim control

Root cause: hiding the page closed the WebSocket and cleared the attached session
reference. On visibility return, the native handler ran before React reattached,
so takeover was not armed before the replacement socket opened.

Fix: `App` arms takeover for the active viewed session when the page becomes
visible, before WebSocket reattachment.

Regression coverage: `tests/app-layout.test.ts`.

The user confirmed tab switching now takes control automatically.

### Replay-generated dashboard input and stale viewers

Two defensive fixes remain appropriate even though neither eliminated the OSC
corruption:

- `TerminalView` suppresses xterm `onData` forwarding while initial or
  mid-session replay writes are in progress.
- The daemon accepts socket `Input` only from the current controller.

Regression coverage exists in `tests/terminal-view.test.ts` and
`rust/climon-session/src/host.rs`.

## Outstanding issue 1 — OSC palette responses become visible shell input

### Symptom

After switching between two dashboards around a Copilot session, the terminal
occasionally prints strings such as:

```text
10;rgb:ffff/ffff/ffff11;rgb:0d0d/1111/1717
4;0;rgb:2e2e/3434/3636
...
```

These are terminal-generated responses to OSC color queries:

- OSC 10: foreground color
- OSC 11: background color
- OSC 4: indexed palette colors

The missing escape introducers make the remaining payload visible as ordinary
input/output.

### Reliable user reproduction

1. Start a fresh dashboard server.
2. Start a fresh client session using `bun run dev -- shell`.
3. Run Copilot in the terminal.
4. Switch to dashboard 1.
5. Switch to dashboard 2.
6. Exit Copilot.
7. Switch back to dashboard 1.

The corruption is intermittent but has occurred repeatedly with this sequence.

### Evidence already gathered

`~/.climon/logs/daemon/quick-spies-camp.log` contains
`osc_color_response_input` events:

- the responses came from the current controller;
- `allowed` was `true`;
- complete palette response sets arrived roughly 28–31 ms after that dashboard
  took control.

This ruled out the stale non-controller socket-input hypothesis.

The dashboard server was restarted and the served `/assets/app.js` exactly
matched `dist/web/app.js` at the time of testing:

```text
2f4fd6a0f4d5425b8242876ec346a39a94636037
```

This ruled out stale web assets for that reproduction.

Replay input suppression was present in that bundle, so replay writes alone are
not yet proven to be the source.

### Current diagnostics

Temporary diagnostics in `rust/climon-session/src/host.rs` log both sides of the
boundary:

- `osc_color_query_output`: a matching OSC query arrived from PTY output.
- `osc_color_response_input`: a dashboard sent a matching response as input.

The known `quick-spies-camp.log` predates the build containing
`osc_color_query_output`. It cannot establish whether the corresponding query
was live PTY output or historical replay. Do not draw that conclusion from this
log.

### Required next experiment

1. Rebuild the Rust client containing both diagnostics.
2. Launch a **new** client session. Existing sessions continue running the daemon
   binary from their launch time.
3. Restart the Bun dashboard server and hard-reload both dashboard tabs.
4. Reproduce the sequence above.
5. Inspect only the new session's daemon log.
6. Correlate, by timestamp and viewer/controller ID:
   - `take_control`
   - `set_pty_size`
   - `osc_color_query_output`
   - `osc_color_response_input`

Interpretation:

- Query output immediately precedes response input: the query is live PTY output
  after takeover. Trace why the application emits or re-emits it.
- Response input appears without query output: the query was processed by xterm
  during replay or generated elsewhere in the dashboard lifecycle. Instrument the
  exact `terminal.write()` call and replay/live classification next.
- Query exists much earlier than response: buffered or replayed query data is
  crossing the handoff boundary. Trace the specific replay payload.

Do not add another OSC fix until this experiment identifies the query source.

## Outstanding issue 2 — local terminal remains in mouse tracking mode

### Symptom and confirmed root cause

After returning from dashboard control, moving the mouse in the local terminal
produced visible mouse-report sequences. The behavior continued after climon
stopped.

Mouse tracking is state in the physical terminal emulator, not in the climon
process. While local output is suppressed, Copilot can emit mouse-mode disable
controls only to dashboards. The physical terminal misses those controls and
therefore remains in a stale enabled mode even after the process exits.

Immediate recovery in an affected terminal:

1. Avoid moving the mouse.
2. Press Ctrl+C.
3. Type `reset` and press Enter.

### New uncommitted fix

`build_mouse_private_mode_restore_suffix()` in
`rust/climon-session/src/replay.rs` now:

1. disables every tracked mouse private mode in deterministic order;
2. re-enables only modes that are currently active in authoritative daemon
   state.

Tracked modes: `1000`, `1002`, `1003`, `1005`, `1006`, and `1015`.

The local restore watcher prefixes the clean viewport repaint with this mode
synchronization. Session teardown also disables every tracked mode after the PTY
reader drains, so exiting while displaced cannot leave mouse tracking enabled.

The regression test was written first and failed because the helper did not
exist. It now passes. The complete `climon-session` suite passes:

```text
100 unit tests passed
2 fixture tests passed
5 integration tests passed
```

### Manual verification still required

Use a fresh rebuilt client session:

1. Run Copilot locally.
2. Give dashboard 1 control, then dashboard 2 control.
3. Exit Copilot while a dashboard controls.
4. Return control to the local terminal and move the mouse.
5. Confirm no mouse-report text appears and ordinary mouse selection works.
6. Repeat, but terminate the climon session while the dashboard controls.
7. Confirm the local terminal is still in a normal mouse mode after climon exits.

If this fails, inspect whether the cleanup bytes reached the real local stdout.
Do not broaden the fix to unrelated terminal modes without evidence.

## Architecture checkpoint

The remaining bugs share one architectural constraint: while a dashboard
controls the PTY, raw PTY output is intentionally suppressed from the physical
local terminal. The local terminal therefore misses both visible content and
terminal state transitions.

Restore must synchronize two distinct things:

1. visible screen state, rebuilt from bounded raw PTY replay at host dimensions;
2. terminal private modes, rebuilt from authoritative daemon state.

The mouse-mode suffix is the first explicit mode synchronizer. If future
reproductions reveal stale bracketed-paste, focus-reporting, cursor, keypad, or
alternate-screen state, extend a deliberate terminal-state model rather than
adding unrelated byte patches.

The OSC issue is different: a browser terminal is generating response bytes that
reach the PTY. Its source must be classified as live output versus replay before
changing the architecture.

## Temporary diagnostics that must not ship

Remove before final commit. Use this search as the cleanup checklist:

```bash
rg -n 'debug_restore|local_debug_capture_until|osc_color_|is_osc_color_response|contains_osc_color_query|debug_escape' \
  rust/climon-session/src/host.rs
```

OSC diagnostic cleanup:

- remove the PTY-reader `osc_color_query_output` JSON logging block;
- remove the socket-input `osc_color_response_input` JSON logging block;
- remove `is_osc_color_response()` and `contains_osc_color_query()`;
- remove `debug_escape()` if no restore diagnostic still uses it;
- preserve the controller-only socket-input check around the removed response
  diagnostic.

Restore diagnostic cleanup:

- remove `debug_restore_enabled()` and `debug_restore_log()`;
- remove every `CLIMON_DEBUG_RESTORE` startup/status message;
- remove diagnostic calls from displacement, resize, restore-decision, repaint,
  and PTY-reader paths;
- remove `HostState.local_debug_capture_until`, its initialization, its
  two-second capture assignment, and the reader-side capture window;
- remove diagnostic-only grid-line collection and escaped repaint rendering;
- simplify any blocks whose only remaining purpose was diagnostic logging.

`debug_console_size()` is currently also used by the production displaced-notice
renderer. Do **not** delete its console-size behavior with the diagnostics.
Rename it to a production name such as `local_console_size()` and update its call
sites, or retain it if that rename would create unrelated churn.

Retain behavioral fixes and regression tests. After removing diagnostics, rebuild
and rerun the focused suites to catch accidental removal of production logic.

## Documentation and manual-test work

Before completion:

- Update `docs/manual-tests/terminal-control-handoff.md`:
  - align TCH-10 with host-sized replay reconstruction;
  - retain TCH-11 for resize spiral and dashboard overflow;
  - add explicit mouse-mode restore and exit-cleanup checks;
  - add the two-dashboard Copilot/OSC reproduction if the final fix changes
    behavior.
- Update `docs/features.md` with the final factual behavior only.
- Keep this handoff as troubleshooting history; do not treat temporary
  diagnostics as shipped features.

## Verification and completion gates

1. User manually verifies local mouse behavior with a fresh rebuilt session.
2. Capture a fresh correlated OSC diagnostic reproduction.
3. Implement any OSC fix with a failing test first.
4. Remove all temporary diagnostics.
5. Run formatting and focused Rust/web tests and builds.
6. Run the relevant broader suites, accounting for documented baseline failures.
7. Verify control handoff on Windows, including ConPTY restore and session exit.
8. Request code review.
9. Commit, push, and update PR #108 against `dev`.

Known baseline caveats:

- Some full Bun-suite failures are pre-existing and order/environment dependent.
- Rust client changes require a rebuilt binary and a newly launched session.
- Source-mode web changes require a dashboard server restart and browser hard
  reload because the server caches its in-memory web bundle.

## Immediate next action

Superseded by the finalization update below: the mouse-mode manual verification
is complete and repeated OSC reproduction attempts did not reproduce the
corruption, so there is no further OSC diagnostic capture pending. Diagnostics
have already been removed from the working tree (see below). The remaining
action is Windows/CI verification of this branch before requesting review and
updating PR #108 — see "Finalization update — 2026-07-11".

## Finalization update — 2026-07-11

This section finalizes the state left open above.

- **Mouse-mode synchronization: manually verified on macOS.** The reclaim and
  teardown mouse-mode sync (`build_mouse_private_mode_restore_suffix`) was
  exercised end to end: mouse tracking enabled locally, control handed
  dashboard1 → dashboard2, exit while a dashboard controlled, and reclaim to the
  local terminal — no stale mouse-report garbage appeared and ordinary
  click-drag selection worked immediately. The same was repeated terminating
  the climon session entirely while displaced; the physical terminal was left
  in a normal mouse mode with no manual `reset` required.
- **OSC palette corruption: not reproduced on repeated final attempts.** Several
  further attempts at the two-dashboard Copilot reproduction sequence
  documented above (issue 1) did not reproduce the visible OSC 10/11/4 palette
  response corruption. Local physical-terminal responses to OSC color queries
  were observed during this testing and were consumed normally by the shell
  with no visible garbage. **No OSC root-cause fix is claimed** — the
  corruption was never re-triggered under the diagnostic build, so its cause
  was never isolated, and no code change specifically targets it. Treat
  "Outstanding issue 1" above as still logically open if it recurs; nothing in
  this branch should be read as having fixed it.
- **Diagnostics removed.** All temporary `CLIMON_DEBUG_RESTORE` restore
  diagnostics and the `osc_color_query_output` / `osc_color_response_input` OSC
  diagnostics described under "Temporary diagnostics that must not ship" have
  been removed from `rust/climon-session/src/host.rs`. `debug_console_size()`
  was renamed to `local_console_size()` per that section's guidance rather than
  deleted, since the displaced-notice renderer still depends on it.
- **Defensive fixes retained.** Both defensive fixes from "Replay-generated
  dashboard input and stale viewers" ship as-is even though neither was shown to
  cause the OSC corruption: `TerminalView` still suppresses xterm `onData`
  forwarding while displaced or while an initial/mid-session replay write is in
  progress (`shouldForwardTerminalData`), and the daemon still accepts socket
  `Input` frames only from the current controller (`socket_client_controls_input`).
- **Outstanding:** Windows/CI verification (ConPTY restore, session exit, and
  the control-handoff cases in `docs/manual-tests/terminal-control-handoff.md`)
  has not been performed as part of this finalization and remains open before
  requesting review and updating PR #108.
