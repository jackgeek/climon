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
  **scrollback history above the viewport preserved** and **no residual
  background/foreground color bleed**.
- Neither the displace notice nor the restore repaint destroys scrollback; the
  history the terminal already held remains scrollable after reclaim.
- No regression to the confirmed-working take-control/resize/PWA flows on this
  branch.

## Non-goals

- Restoring the *pre-displace visible content* to the viewport. On reclaim we show
  the session's **current** grid (which may differ from the pre-displace screen if
  the dashboard changed it), not a snapshot of what the viewport held before.
- Using the alternate screen buffer (DEC private mode 1049). It saves/restores
  scrollback for free but corrupts nested full-screen apps (e.g. `vim`) and legacy
  consoles; we deliberately avoid it (see Rejected alternatives).
- Changing the priority/controller model, the Space chord, the 250 ms restore
  delay, or any protocol frame. This is purely a local-terminal display fix.
- Reflowing output or per-surface grids (unchanged from the parent design).

## Approach — viewport-only clears (no alternate screen buffer)

The key realisation: **the notice never touches scrollback in the first place.**
`render_local_displaced` draws its two lines with *absolute* cursor positioning
(`\e[{row};{col}H`) inside the visible viewport — it emits no newlines that scroll
content off the top. So the only thing that ever destroyed history was the
`\e[2J` clear at the *start* of the notice and again in the restore repaint. Remove
those two `\e[2J`s and history is safe on every terminal — no save/restore machinery
is needed, because nothing above the viewport is ever disturbed.

So the fix is: clear and repaint **only the visible viewport**, using erase
sequences that never touch scrollback, and reset SGR before every erase.

### On displace (draw the notice — viewport-only clear)

`render_local_displaced` clears just the visible screen and draws the centered
notice:

1. Emit `\e[m\e[H\e[J` — reset SGR, home the cursor, then `\e[J` (erase-below).
   With the cursor at home, erase-below clears the entire *visible* viewport but
   does **not** touch scrollback (unlike `\e[2J`). The SGR reset first means the
   cleared cells use the default background (no bleed behind the notice).
2. Draw the centered notice (message + "Press Space to take control…" hint) with the
   existing absolute-positioning centering logic. No scrolling occurs.
3. Suppress PTY forwarding (unchanged).

The existing **notice re-centering on resize while displaced** is retained
unchanged: it simply re-invokes `render_local_displaced`, which re-clears the
viewport (again, no scrollback touched) and redraws the notice at the new size.

### On restore (repaint the current grid — viewport-only)

In the restore-watcher fire block, after the 250 ms `LOCAL_RESTORE_DELAY`:

1. Repaint **only the current visible grid** in place with the fixed `render_screen`
   (below). This overwrites exactly the viewport rows where the notice sat with the
   session's *current* state (the dashboard may have changed it while we were
   displaced). Scrollback above the viewport is never written, so the history the
   terminal already held stays intact.
2. Resume PTY forwarding (unchanged: unsuppress while still holding the lock, as
   today, so the reader thread cannot interleave a live chunk mid-repaint).

No `\e[?1049l`, no alt-screen exit, no history snapshot — the terminal's own
scrollback was never disturbed, so there is nothing to restore.

### Fixed `render_screen` (current-grid, in place, non-destructive)

`HeadlessGrid::render_screen` is rewritten so it repaints the viewport without ever
clearing scrollback:

- **Home only:** start with `\e[H`. **Never `\e[2J`** (it clears scrollback on
  Windows Terminal and others).
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

## Rejected alternatives

**Alternate screen buffer (DEC 1049).** Emitting `\e[?1049h` on displace / `\e[?1049l`
on restore would let the terminal save and restore scrollback for free. Rejected
because it corrupts more than it fixes: if the monitored program is itself a
full-screen app (`vim`, `less`), the local `1049h` nests a second alt screen and the
`1049l` returns to the app's alt screen, not the primary buffer; legacy `conhost`
ignores 1049 entirely; and an unbalanced `1049l` (restore firing without a matching
enter) can blank the primary buffer. The viewport-only approach avoids all of these
by never leaving the primary buffer.

## Architecture / key files

Client-only change, all in `rust/climon-session` (per the Rust-client convention):

- `rust/climon-session/src/fingerprint.rs` — `HeadlessGrid::render_screen`: the SGR
  reset + `\e[H`/`\e[J` fix (no `\e[2J`). Add a unit test asserting an SGR reset
  precedes every erase and that the output contains no `\e[2J`.
- `rust/climon-session/src/host.rs`:
  - `render_local_displaced` (~1095) — clear only the visible viewport with
    `\e[m\e[H\e[J` (reset + home + erase-below) instead of `\e[2J\e[H`, then draw the
    centered notice with the existing absolute positioning. Preserve notice
    re-centering (`local_notice_size`).
  - The restore-watcher `Repaint` arm in `spawn_restore_thread` (~1500) — unchanged
    apart from the fixed `render_screen()`: no alt-screen exit is emitted (we never
    entered one).
  - Strip the `CLIMON_DEBUG_RESTORE` diagnostics
    (`grid_nonempty_lines`, the `local_stdin` per-chunk log,
    `local_debug_capture_until`) once the fix is verified, unless still useful.

Nothing changes in the protocol, the daemon control state machine, the server, or
the web/PWA. No config setting or feature flag is added (this is a bug fix inside an
already-gated in-development feature).

## Edge cases

- **PTY app already in alt screen when displaced** (e.g. the monitored command is
  `vim`). We never touch the alt screen ourselves, so there is no nesting: the
  notice's viewport-only clear and the restore repaint both land on whatever buffer
  is current, and the step-1 current-grid repaint corrects the visible content to the
  session's current state.
- **Legacy `conhost`.** The fix relies only on `\e[H`, `\e[2K`, and `\e[J`, which are
  universally supported — no DEC-1049 dependency — so the color-bleed and
  scrollback-preservation fixes apply identically on conhost and Windows Terminal.
  **Verify on the user's box** before claiming done.
- **`\e[2J`/`\e[J` scrollback semantics.** The whole fix rests on `\e[J`
  (erase-below) never clearing scrollback while `\e[2J` may. This holds on Windows
  Terminal, xterm, and modern conhost; confirm empirically on the user's terminal
  that scrollback survives after Space-reclaim.
- **Rapid displace→restore within the delay** (surface re-grows during the 250 ms).
  Unchanged: `LocalRestoreDecision::SkipOvergrown` stays suppressed; the next genuine
  restore transition repaints. No alt-screen state to balance, so there is no
  unbalanced-sequence hazard.

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
  displaced; press Space to reclaim; **expect** scrollback above the viewport intact,
  current state shown, and no background color bleed on the prompt.
- Verify on both Windows Terminal and conhost that scrollback survives the reclaim.

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
