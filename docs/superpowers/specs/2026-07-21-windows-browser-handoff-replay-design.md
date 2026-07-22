# Windows Browser Handoff Replay Design

## Problem

On Windows actor sessions, transferring control between the dashboard and PWA
can leave the newly controlling terminal blank until the child emits fresh
output. Control ownership and input routing are correct; only rendering fails.

The observed handoff order is:

1. The displaced browser reports its natural size and sends `takeControl`.
2. The actor resizes ConPTY and broadcasts the new controller.
3. Windows PowerShell emits a resize repaint containing only cursor visibility,
   row erasure, and cursor-position controls.
4. The browser requests a replay after refitting.
5. The actor replays its raw bounded PTY byte stream. Because that stream ends
   with the erase-only resize repaint, replay reconstructs a blank screen.

This is the same raw-ConPTY-replay hazard already documented for local-terminal
restore in `rust/climon-session/src/fingerprint.rs`: ConPTY output is a stream of
screen diffs, not an authoritative terminal snapshot.

## Goals

- Restore the newly controlling dashboard or PWA immediately after a handoff.
- Preserve full browser scrollback, styling, cursor state, and terminal modes.
- Keep normal nonblank daemon replay authoritative.
- Scope recovery to the exact attachment and handoff that created it.
- Leave actor control, resize, input routing, local reclaim, and wire protocol
  semantics unchanged.

## Non-goals

- Replacing the daemon's bounded raw scrollback format.
- Changing local-terminal restore.
- Suppressing or classifying PTY output as meaningful or erase-only.
- Repairing legacy-engine behavior.
- Adding timing delays or retries to wait for a child repaint.

## Design

### Browser checkpoint

Each `TerminalView` loads `@xterm/addon-serialize`. When an authoritative
`Control` frame transitions that surface from `displaced` to `controlling`,
the component serializes the active xterm buffer before refitting it. The
checkpoint includes normal scrollback and the current terminal state.

The checkpoint records:

- the current attachment generation;
- the serialized terminal bytes;
- the source terminal columns and rows;
- whether the captured visible screen contains non-whitespace content.

Only this transition creates a checkpoint. Initial attachment, stable-controller
resize, and displaced updates continue through their existing paths.

### Existing resize/replay round trip

The current handoff flow remains intact:

1. `refit()` resizes xterm to the winning surface's natural dimensions.
2. `sendResize()` sends the controller resize.
3. The browser sends the existing replay request.
4. The daemon responds with `PtySize`, the replay marker, and replay bytes.

The protocol needs no new frame type. The replay response remains the boundary
at which the browser decides whether normal replay or checkpoint recovery is
appropriate.

### Recovery decision

When the handoff replay payload arrives, the browser uses the checkpoint only
when all of these conditions hold:

- the checkpoint belongs to the current attachment generation;
- the checkpoint was created for a displaced-to-controlling transition;
- the checkpoint had visible non-whitespace content;
- the post-resize **visible viewport** is blank.

Visible-viewport blankness is intentionally independent from scrollback. A
ConPTY erase-only resize can blank every visible row while xterm still retains
thousands of characters above `buffer.active.baseY`; retained history must not
block recovery. The existing full-buffer capture remains responsible for
checkpoint content, while a dedicated viewport capture reads exactly
`term.rows` lines starting at `buffer.active.baseY` for this decision.

If every condition holds, the component discards the raw handoff replay,
resizes xterm back to the checkpoint's source grid, resets the buffer, writes
the serialized checkpoint, then resizes xterm to the newly fitted controller
dimensions. Restoring at the source grid follows the serialize addon's contract
for cursor-positioned content; the final xterm resize performs the supported
reflow. This restores the browser-owned terminal state without replaying the
ConPTY erase-only suffix.

Otherwise the existing replay path remains authoritative: clear the live
terminal without resetting private modes and write the server-sanitized daemon
replay normally.

The checkpoint is single-use. It is cleared after either recovery path
completes.

### Lifecycle isolation

Pending checkpoints are cleared when:

- the selected attachment changes;
- the WebSocket closes or reconnects;
- the session exits;
- the attachment generation changes;
- a handoff replay completes.

Generation matching prevents a delayed replay from restoring content from a
previous session or socket.

## Failure handling

Checkpoint recovery is optional state, not a success-shaped fallback for
connection or protocol errors. If no valid checkpoint exists, the component
uses the current replay behavior.

The serialize addon is initialized with the terminal. Serialization is
synchronous; no broad exception handling is added. Existing malformed control
message handling and WebSocket lifecycle behavior remain unchanged.

## Testing

Focused tests will cover:

1. A nonblank serialized terminal with full scrollback survives the captured
   Windows PowerShell erase-only resize sequence and blank raw replay.
2. Styles, cursor state, and terminal modes represented by the serialized
   checkpoint are restored.
3. A nonblank post-resize terminal uses normal daemon replay.
4. A blank visible viewport with nonblank retained scrollback still restores
   the checkpoint.
5. A blank checkpoint never resurrects old content.
6. A checkpoint from an old attachment generation is ignored.
7. Disconnect, reconnect, session change, and exit clear pending recovery state.
8. Existing replay, control-state, resize deduplication, and alternate-screen
   tests remain green.

Physical DAR-03 validation will repeat:

- dashboard to PWA control transfer;
- PWA to dashboard control transfer;
- input on the newest controller;
- displaced-surface input swallowing;
- local Space reclaim and local-size authority.

The newly controlling browser must show its prior terminal and full scrollback
without waiting for fresh child output.

## Documentation

Update the terminal-control-handoff manual coverage with the Windows
erase-only resize regression, then record the exact actor candidate evidence in
`docs/manual-tests/results/windows.md` when the full release-gate sweep is
complete. This bug fix does not add or re-scope a catalogue feature.
