# Clean terminal history/color restore on reclaim

**Status:** Approved design (pending spec review)
**Date:** 2026-07-08
**Branch:** `terminal-control-handoff` (PR #108 targets `dev`)
**Builds on:** `docs/superpowers/specs/2026-07-06-terminal-control-handoff-design.md`

## Problem

The terminal control-handoff feature (already largely implemented on this branch)
displaces the in-process local terminal while another surface (climon dashboard or
PWA) controls the shared PTY grid. While displaced, the local terminal pauses PTY
output and shows a centered notice; pressing **Space** reclaims control, resizes
the PTY back to the local console, and restores live output.

Two defects appear at the display boundaries of that flow:

1. **Scrollback history is destroyed.** On both displace and restore the code
   clears the whole screen. The restore repaint only ever redraws the *visible*
   grid, so everything that had scrolled above the viewport before displacement is
   gone. The user cannot scroll back to see what happened before the dashboard took
   over.
2. **Terminal colors bleed.** After restore, the last cell's SGR attributes (e.g. a
   blue background from the monitored program) leak into subsequently-erased rows
   and the shell prompt, so the terminal is left painting with a stale background.

The user's requirement: on reclaim, "do what copilot does — capture the whole
history and restore it cleanly." Concretely, show the session's **current state**
(whatever it looks like now, including anything the dashboard changed) **with full
scrollback history intact and no color bleed.**

## Root causes (both confirmed from logs)

- **Color bleed.** `HeadlessGrid::render_screen`
  (`rust/climon-session/src/fingerprint.rs`, currently ~line 68) emits, per row,
  `\e[2K` (erase line) followed by vt100's `rows_formatted` output, with **no SGR
  reset between rows**. vt100 leaves the last painted cell's attributes active, and
  the ANSI erase-line then paints the cleared cells with the *current* background —
  so the color bleeds down the screen and into the prompt.
- **History loss.** `render_screen` begins with `\e[H\e[2J` (`\e[2J` clears the
  entire screen and, on several terminals including Windows Terminal, drops
  scrollback), and only ever repaints the visible grid. Scrollback above the
  viewport is never captured, so it cannot be restored. The displace notice
  (`render_local_displaced`) likewise opens with `\e[2J\e[H`, destroying history at
  the *start* of displacement — before restore even runs.

## Goals

- On restore, the local terminal shows the session's **current visible state** with
  **full scrollback history preserved** and **no residual background/foreground
  color bleed**.
- The displace notice no longer destroys scrollback; on restore the pre-displace
  screen + history are recovered losslessly.
- No regression to the confirmed-working take-control/resize/PWA flows on this
  branch.

## Non-goals

- Reconstructing scrollback that the *daemon's parsed grid* never held. We restore
  what the terminal itself had before displacement (via the alternate-screen
  buffer), not a synthesized history from the ring buffer.
- Changing the priority/controller model, the Space chord, the 250 ms restore
  delay, or any protocol frame. This is purely a local-terminal display fix.
- Reflowing output or per-surface grids (unchanged from the parent design).

## Approach C — alt-screen for the notice + current-grid repaint on exit

The alternate screen buffer (DEC private mode 1049) is the standard, terminal-native
way to overlay UI and then restore the prior screen *and scrollback and colors* for
free — exactly what full-screen programs (vim, less, and Copilot's own TUI) do.

### On displace (enter alt screen)

Replace the notice's destructive `\e[2J\e[H` prologue with entering the alternate
screen buffer:

1. Emit `\e[?1049h`. The terminal saves the primary buffer (visible grid **and**
   scrollback **and** current SGR state) and switches to a fresh alt buffer. Nothing
   in the primary buffer is touched.
2. Draw the centered notice on the alt buffer (message + "Press Space to take
   control…" hint), using the existing centering logic.
3. Suppress PTY forwarding (unchanged).

The existing **notice re-centering on resize while displaced** (uncommitted work on
this branch) is retained: on a console resize while displaced it re-clears the *alt*
buffer and redraws the centered notice at the new size. Because this only ever
touches the alt buffer, it never affects the saved primary buffer/history.

### On restore (exit alt screen, then repaint current grid)

In the restore-watcher fire block, after the 250 ms `LOCAL_RESTORE_DELAY`:

1. Emit `\e[?1049l`. The terminal **losslessly restores** the primary buffer: the
   full pre-displace screen, all scrollback above it, and the saved SGR/color state.
2. Repaint **only the current visible grid** in place, so the restored screen
   reflects the session's *current* state (the dashboard may have changed it while
   we were displaced), using the fixed `render_screen` (below). This overwrites just
   the visible rows on top of the restored primary buffer — scrollback above is
   untouched.
3. Resume PTY forwarding (unchanged: unsuppress while still holding the lock, as
   today, so the reader thread cannot interleave a live chunk mid-repaint).

### Fixed `render_screen` (current-grid, in place, non-destructive)

`HeadlessGrid::render_screen` is rewritten so it is safe to paint on top of the
restored primary buffer:

- **Home only:** start with `\e[H`. **Never `\e[2J`** (it nukes scrollback).
- **Reset SGR before every erase:** for each row emit `\e[m` (reset attributes)
  **then** `\e[2K` (erase line) **then** the row content. Resetting before the erase
  means the cleared cells are painted with the *default* background, killing the
  bleed; the row content then re-establishes whatever attributes it needs.
- **Trailing rows:** after the last content row, emit `\e[m\e[J` to clear from the
  cursor to the end of the visible screen (`\e[J` = erase-below, which does **not**
  touch scrollback), so stale visible rows below the current content are cleared
  without destroying history. Keep the existing trailing-blank-row trimming so the
  cursor lands naturally after the last content row (the shell prompt).
- Keep the existing sequential `\r\n` row separation and the deliberate avoidance of
  absolute cursor positioning (the Windows console-height-mismatch guard documented
  in the current function).

This keeps `render_screen` self-contained and correct whether it lands on a
freshly-restored primary buffer (the alt-screen path) or, as a fallback, on a
console that never entered the alt screen (see Edge cases).

## Architecture / key files

Client-only change, all in `rust/climon-session` (per the Rust-client convention):

- `rust/climon-session/src/fingerprint.rs` — `HeadlessGrid::render_screen`: the SGR
  reset + `\e[H`/`\e[J` fix (no `\e[2J`). Add a unit test asserting an SGR reset
  precedes every erase and that the output contains no `\e[2J`.
- `rust/climon-session/src/host.rs`:
  - `render_local_displaced` (~1095) / the displace path in `update_local_displaced`
    (~397) — emit `\e[?1049h` and draw the notice on the alt buffer instead of
    `\e[2J\e[H`. Preserve notice re-centering (`local_notice_size`).
  - The restore-watcher `Repaint` arm in `spawn_restore_thread` (~1500) — emit
    `\e[?1049l` before `render_screen()`, then write the repaint, then unsuppress.
  - Strip the `CLIMON_DEBUG_RESTORE` diagnostics
    (`grid_nonempty_lines`, the `local_stdin` per-chunk log,
    `local_debug_capture_until`) once the fix is verified, unless still useful.

Nothing changes in the protocol, the daemon control state machine, the server, or
the web/PWA. No config setting or feature flag is added (this is a bug fix inside an
already-gated in-development feature).

## Edge cases

- **PTY app already in alt screen when displaced** (e.g. the monitored command is
  `vim`). Entering `\e[?1049h` from the local terminal nests a second alt screen;
  exiting with `\e[?1049l` on restore returns to the app's alt screen. The step-2
  current-grid repaint then corrects the visible content to the session's current
  state, so the screen is right regardless of nesting.
- **Legacy `conhost` without 1049 support.** `\e[?1049h/l` are ignored, so the
  notice draws on the primary buffer and restore degrades to today's behavior. The
  fixed `render_screen` (SGR reset, no `\e[2J`) still fixes the color bleed and
  avoids the scrollback-nuking clear in that degraded path. Windows Terminal
  supports 1049 fully — **verify on the user's box** before claiming done.
- **Rapid displace→restore within the delay** (surface re-grows during the 250 ms).
  Unchanged: `LocalRestoreDecision::SkipOvergrown` stays suppressed on the alt
  buffer; the next genuine restore transition exits it. We never emit `\e[?1049l`
  without a matching prior `\e[?1049h`.
- **Restore fires but we never entered the alt screen** (e.g. suppression set before
  this code path in some ordering). Emitting a stray `\e[?1049l` on the primary
  buffer is a no-op on compliant terminals; the fixed `render_screen` still paints
  correctly. Guard the `\e[?1049l` emission on the same state that gated the
  `\e[?1049h` (notice was rendered) to avoid unbalanced sequences.

## Testing

**Automated (`rust/climon-session`):**

- New `render_screen` unit test: asserts (a) an SGR reset (`\e[m`) appears before
  every `\e[2K`/`\e[J` erase, (b) the output contains **no** `\e[2J`, and (c) content
  rows survive. Add before implementing (TDD).
- Keep the existing regression test
  `content_survives_shrink_then_grow_resize` (~184) green.
- `cargo test -p climon-session --lib`, `cargo clippy --all-targets`, `cargo fmt`.

**Manual (Windows, the user's box) — required per repo convention:**

- Add a clean-restore case to `docs/manual-tests/terminal-control-handoff.md` using
  the standard test-case shape (ID, feature, preconditions, config-matrix cell,
  numbered steps, expected result, platforms, result-tracking row) and keep it
  linked from the README index. Steps: run a monitored command that emits colored
  output and scrolls past one screen; open the dashboard so the local terminal is
  displaced; press Space to reclaim; **expect** full scrollback intact, current
  state shown, and no background color bleed on the prompt.
- Verify alt-screen 1049 behavior on Windows Terminal and note conhost degradation.

## Docs

- `docs/features.md` — the terminal-control-handoff row is in-development; refresh
  its description if the clean-restore behavior changes what it claims (do not claim
  behavior that isn't implemented).
- `docs/manual-tests/terminal-control-handoff.md` — add the clean-restore case
  (above).
- `README.md` / `docs/usage.md` — already document the Space chord; add a one-line
  note that reclaiming preserves history if user-facing.

## Rollout / compatibility

Client-only, single-repo change with no protocol or config surface. Ships with the
rest of the terminal-control-handoff branch to `dev` via PR #108. No migration and
no interop concern with the Bun server (it only bridges bytes).

## Cleanup (branch hygiene, from handoff)

- Remove the throwaway `rust/target-diag/` build directory.
- Strip the `CLIMON_DEBUG_RESTORE` diagnostic logging once the fix is verified.
- No `Co-authored-by` trailer on commits (explicit user preference this session).
