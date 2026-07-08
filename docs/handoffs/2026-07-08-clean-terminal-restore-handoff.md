# Handoff — Terminal control-handoff: clean history/color restore

**Date:** 2026-07-08
**Branch:** `terminal-control-handoff` (PR #108, targets `dev`)
**Worktree:** `C:\git\climon\.worktrees\terminal-control-handoff`
**Last commit:** `4d1c8e8 Fix local take-control chord and PWA resize storm`

## What this session was about

The terminal control-handoff feature (replaces the old clamping model). Dashboards
are always unclamped; only the local terminal can clamp. Priority: PWA > climon
dashboard > local terminal. The losing surface shows a centered notice ("This
session is being viewed on another dashboard / Press Ctrl+T…"; the local terminal
uses the **Space** chord to reclaim). Most of that is already committed on this
branch. See prior checkpoints 001–007 in the session state for full history.

## Current focus (approved design, NOT yet implemented)

When the local terminal reclaims control after being displaced, the restore repaint
**corrupts scrollback history** and **bleeds terminal colors**. The user wants it to
"do what copilot does — capture the whole history and restore it cleanly."

**User decision:** on reclaim, show the session's **current state** (whatever it
looks like now, including anything the dashboard changed) **with full history intact**.

**Approved approach (C): alt-screen for the notice + current-grid repaint on exit.**
- On displace: emit `\e[?1049h` (terminal saves primary buffer + scrollback + colors
  to the alt buffer for free), draw the centered notice on the alt buffer, suppress
  PTY forwarding. (Notice re-centering on resize is already built — see uncommitted
  changes below.)
- On restore (after the 250 ms `LOCAL_RESTORE_DELAY`): emit `\e[?1049l` (terminal
  losslessly restores primary buffer = full history + colors), then repaint **only
  the current visible grid** in place so it reflects current state, then resume PTY
  forwarding.
- The current-grid repaint uses a **fixed `render_screen`**: `\e[H`, per row
  `reset-SGR + \e[2K + content`, then `\e[J` for trailing rows. **Never `\e[2J`**
  (nukes scrollback). **Reset SGR before every erase** (kills the blue-bg bleed).

**Root causes (both CONFIRMED from logs):**
- *Color bleed:* `HeadlessGrid::render_screen` (`rust/climon-session/src/fingerprint.rs`
  ~line 68) emits per-row `\e[2K` + vt100 `rows_formatted` with **no SGR reset**;
  vt100 leaves the last cell's attrs active and ANSI erase-line paints with the
  current background → color bleeds.
- *History loss:* `render_screen` starts with `\e[H\e[2J` (clears whole screen +
  scrollback on some terminals) and only repaints the **visible** grid — scrollback
  above is never captured/restored.

**Edge cases to handle:** (a) PTY app already in alt-screen (e.g. `vim`) when
displaced → nested alt-screen; the step-2 grid repaint still corrects visible
content. (b) Legacy `conhost` without 1049 support → degrades to today's behavior;
Windows Terminal supports 1049 fully (verify on the user's box).

## Uncommitted work on the branch (do NOT lose)

`git status` shows `M rust/climon-session/src/fingerprint.rs`, `M .../host.rs`,
and an untracked `rust/target-diag/` build dir. These are **diagnostics + a
partial feature (notice re-centering)** layered on top of `4d1c8e8`:

- `host.rs` `local_stdin` (~526): `CLIMON_DEBUG_RESTORE`-gated logging.
- `host.rs` `HostState`: new field `local_notice_size: Option<(u16,u16)>` (~203),
  initialized `None` (~843).
- `host.rs` `update_local_displaced` (~370): renders notice on displaced→suppressed
  transition AND when console resized while displaced (re-centering); grid-content
  debug log.
- `host.rs` restore-fire block (~1487): grid-content debug log; `s.local_notice_size
  = None` on un-suppress.
- `fingerprint.rs`: passing regression test `content_survives_shrink_then_grow_resize`
  (~184) proving vt100 `set_size` preserves content across shrink→grow.

**Decisions for the next agent:** keep the notice re-centering; either wire the
alt-screen enter into that displace transition and the alt-screen exit + fixed
repaint into the restore-fire block. Remove or quiet the `CLIMON_DEBUG_RESTORE`
diagnostic logging (`grid_nonempty_lines`, `local_stdin` log) before the final
commit unless still useful. Delete the throwaway `rust/target-diag/` dir.

## Key files

- `rust/climon-session/src/host.rs` — `update_local_displaced` (~370, displace/notice),
  `take_control` (~502), `local_stdin` (~526), `render_local_displaced` (centered
  notice), restore watcher `spawn_restore_thread`/`local_restore_decision` (~1434+)
  where `render_screen()` is written at restore-fire (~1487). `HostState` (~192).
  `LOCAL_TAKE_CONTROL_KEY = 0x20` (Space). `LOCAL_RESTORE_DELAY` = 250 ms.
- `rust/climon-session/src/fingerprint.rs` — `HeadlessGrid::render_screen` (~68,
  THE fix target), `visible_lines` (~111), new test (~184).
- Docs to update: `docs/manual-tests/terminal-control-handoff.md`, `docs/features.md`,
  `README.md`, `docs/usage.md` (already updated for Space chord; add a
  clean-restore manual-test case + note).

## Confirmed working — do NOT re-investigate

- Space take-control chord reaches the daemon end-to-end; `take_control("local")`
  resizes PTY + broadcasts; vt100 `set_size` preserves grid content across resize.
- PWA resize-storm fix works.
- Doubled sessions in the list = an environmental **remote self-ingest loop**
  (`Laptop~<id>.json`, `origin:"remote"`), NOT this branch. User purged config → gone.

## Environment gotchas

- **Exe lock:** the running climon locks `rust\target\debug\climon.exe`. Build to a
  separate dir: `$env:CARGO_TARGET_DIR="C:\git\climon\.worktrees\terminal-control-handoff\rust\target-diag"; cargo build -p climon-cli`. **Do NOT kill running climon PIDs** — one is the user's Copilot CLI session.
- **Debug log:** `C:\Users\jackallan\.climon\logs\restore-debug.log` (only when
  `CLIMON_DEBUG_RESTORE=1`). grep for `displace-suppress|restore-fire|action=TakeControl`.
- **Windows/ConPTY:** ConPTY does NOT re-emit on resize-back within 250 ms; grid
  content comes from earlier output. Test alt-screen 1049 on the user's terminal.
- **Build/test:** from `rust/`: `cargo test -p climon-session --lib`,
  `cargo clippy --all-targets`, `cargo fmt`. Client work is Rust-only (`rust/`).
- **NEVER add a `Co-authored-by` trailer to commits** (explicit user preference this session).
- **PR push:** `gh auth switch --hostname github.com --user jackgeek` then
  `gh auth setup-git` before `git push` (the `jackallan_microsoft` identity lacks
  push access). Push to PR #108.

## Suggested skills

1. **brainstorming** — already completed; the design above is approved. The next
   step in that flow is to write the spec to
   `docs/superpowers/specs/2026-07-08-clean-terminal-restore-design.md`, commit it,
   get the user's review, then invoke **writing-plans**. (User preference: use the
   **superpowers** skills for climon, NOT the `prd` plugin.)
2. **writing-plans** — turn the approved design into an implementation plan.
3. **test-driven-development** — add a `render_screen` unit test asserting SGR reset
   before each erase and no `\e[2J`, before implementing.
4. **verification-before-completion** — run cargo test/clippy/fmt and verify on
   Windows with the user before claiming done.
5. **requesting-code-review** — before merging to PR #108.

## Immediate next actions

1. Confirm with the user whether to proceed now or keep parked (they said "do this
   later").
2. When resuming: write + commit the design spec, get user review, then writing-plans.
3. Implement approach C; keep notice re-centering; strip diagnostics; delete
   `rust/target-diag/`.
4. `cargo test -p climon-session --lib` + clippy + fmt; user verifies on Windows;
   commit (no Co-authored-by); push to PR #108.
