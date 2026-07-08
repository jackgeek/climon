# Clean Terminal History/Color Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the in-process local terminal reclaims control after being displaced by a dashboard/PWA, restore the session with full scrollback history intact, the session's current visible state, and no terminal color bleed.

**Architecture:** Use the terminal's alternate screen buffer (DEC private mode 1049). On displace, emit `\e[?1049h` and draw the centered notice on the alt buffer so the primary buffer (grid + scrollback + SGR state) is saved untouched. On restore, emit `\e[?1049l` to losslessly recover the primary buffer, then repaint only the current visible grid on top with a fixed `render_screen` that resets SGR before every erase and never uses `\e[2J`. Client-only change in `rust/climon-session`; no protocol, server, or config changes.

**Tech Stack:** Rust (`climon-session`), `vt100` grid parser. Tests: `cargo test -p climon-session --lib`, `cargo clippy`, `cargo fmt`.

**Spec:** `docs/superpowers/specs/2026-07-08-clean-terminal-restore-design.md`

**Working branch:** `terminal-control-handoff` (worktree `.worktrees/terminal-control-handoff`), PR #108 targets `dev`.

---

## Build/test note (Windows exe lock)

The running climon locks `rust/target/debug/climon.exe`. **Build/test to a separate target dir** and never kill running climon PIDs (one is the user's Copilot CLI session):

```powershell
$env:CARGO_TARGET_DIR="C:\git\climon\.worktrees\terminal-control-handoff\rust\target-diag"
cd C:\git\climon\.worktrees\terminal-control-handoff\rust
cargo test -p climon-session --lib
```

`cargo test --lib` builds no binary that would collide with the lock. `rust/target-diag/` is a throwaway dir (deleted in Task 4).

## File map

**Modify (Rust):**
- `rust/climon-session/src/fingerprint.rs` — rewrite `HeadlessGrid::render_screen` (SGR reset before every erase, `\e[H` + `\e[J`, never `\e[2J`); add a color-bleed/no-`\e[2J` unit test.
- `rust/climon-session/src/host.rs` — `render_local_displaced` (~1095) + its caller in `update_local_displaced` (~397) enter the alt screen; the restore-watcher `Repaint` arm in `spawn_restore_thread` (~1500) exits the alt screen before repainting. Strip `CLIMON_DEBUG_RESTORE` diagnostics (Task 4).

**Modify (docs):**
- `docs/manual-tests/terminal-control-handoff.md` — add the clean-restore manual test case.
- `docs/features.md` — refresh the terminal-control-handoff row description if needed.

**No changes** to protocol, server (`src/`), web, config, or fixtures.

## Existing state (uncommitted on the branch — preserve)

`git status` shows `M fingerprint.rs`, `M host.rs`. These are diagnostics + the notice re-centering feature layered on `4d1c8e8`. **Keep the notice re-centering** (`local_notice_size`); build on top of it. The spec is committed at `e286610`.

---

## Task 1: Fix `render_screen` (color bleed + no scrollback nuke)

**Files:**
- Modify: `rust/climon-session/src/fingerprint.rs` (`HeadlessGrid::render_screen`, ~68)
- Test: `rust/climon-session/src/fingerprint.rs` (inline `mod tests`, ~140)

- [ ] **Step 1: Write the failing test**

Add this test inside `mod tests` (after `render_screen_reproduces_current_screen_when_reparsed`, ~line 249):

```rust
    #[test]
    fn render_screen_resets_sgr_before_every_erase_and_never_clears_scrollback() {
        // Regression: render_screen must (a) never emit `\e[2J` (clears
        // scrollback on Windows Terminal), and (b) reset SGR *before* every
        // erase so a lingering background attribute cannot bleed into the
        // cleared cells / prompt.
        let mut grid = HeadlessGrid::new(20, 4);
        // Blue background then text, leaving the blue attribute active on the
        // last painted cell (the vt100 bleed source).
        grid.write(b"\x1b[44mline one\r\nline two");

        let out = String::from_utf8_lossy(&grid.render_screen()).to_string();

        // (a) No full-screen clear anywhere in the repaint.
        assert!(
            !out.contains("\x1b[2J"),
            "render_screen must never emit \\e[2J (nukes scrollback); got {out:?}"
        );

        // (b) Every erase (`\e[2K` erase-line or `\e[J` erase-below) must be
        // immediately preceded by an SGR reset (`\e[m`) so cleared cells use
        // the default background.
        for erase in ["\x1b[2K", "\x1b[J"] {
            let mut from = 0;
            while let Some(rel) = out[from..].find(erase) {
                let idx = from + rel;
                assert!(
                    out[..idx].ends_with("\x1b[m"),
                    "erase {erase:?} at byte {idx} not preceded by \\e[m reset in {out:?}"
                );
                from = idx + erase.len();
            }
        }

        // Content is still present.
        assert!(out.contains("line one") && out.contains("line two"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `rust/`, with the separate target dir set — see Build note):

```powershell
cargo test -p climon-session --lib render_screen_resets_sgr_before_every_erase_and_never_clears_scrollback
```

Expected: FAIL. Current `render_screen` emits `\x1b[H\x1b[2J\x1b[m` (contains `\e[2J`) and `\x1b[2K` with no preceding `\e[m`.

- [ ] **Step 3: Rewrite `render_screen`**

Replace the body of `render_screen` (currently ~68-84) with:

```rust
    pub fn render_screen(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut rows: Vec<Vec<u8>> = screen.rows_formatted(0, self.cols).collect();
        while rows.len() > 1 && rows.last().map(|r| r.is_empty()).unwrap_or(false) {
            rows.pop();
        }
        let mut out = Vec::new();
        // Home only. NEVER `\e[2J`: on Windows Terminal (and others) it clears
        // scrollback. This repaint lands on top of the current primary buffer
        // (e.g. just restored from the alternate screen on take-control), so it
        // must be non-destructive to history above the viewport.
        out.extend_from_slice(b"\x1b[H");
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                out.extend_from_slice(b"\r\n");
            }
            // Reset SGR *before* the erase so the erased cells are painted with
            // the default background (kills the vt100 last-cell attribute bleed);
            // the row content then re-establishes whatever attributes it needs.
            out.extend_from_slice(b"\x1b[m\x1b[2K");
            out.extend_from_slice(row);
        }
        // Clear from the cursor to the end of the visible screen so stale rows
        // below the current content are removed. `\e[J` (erase-below) does NOT
        // touch scrollback, unlike `\e[2J`.
        out.extend_from_slice(b"\x1b[m\x1b[J");
        out
    }
```

- [ ] **Step 4: Run the new test + the existing render_screen tests to verify they pass**

```powershell
cargo test -p climon-session --lib render_screen
cargo test -p climon-session --lib content_survives_shrink_then_grow_resize
```

Expected: PASS for `render_screen_resets_sgr_before_every_erase_and_never_clears_scrollback`, `render_screen_reproduces_current_screen_when_reparsed` (the new trailing `\e[J` erases only already-blank below-cursor rows, so the reparse still matches and it uses no absolute positioning), and `content_survives_shrink_then_grow_resize`.

- [ ] **Step 5: Run the full session lib suite + clippy + fmt**

```powershell
cargo test -p climon-session --lib
cargo clippy -p climon-session --all-targets
cargo fmt
```

Expected: all pass, no clippy warnings on changed code, no fmt diff.

- [ ] **Step 6: Commit**

```bash
git add rust/climon-session/src/fingerprint.rs
git commit -m "fix(session): render_screen resets SGR before erase and never clears scrollback"
```

---

## Task 2: Enter the alt screen on displace

**Files:**
- Modify: `rust/climon-session/src/host.rs` (`render_local_displaced` ~1095, `update_local_displaced` ~397)

This wires the alternate screen buffer so the primary buffer (grid + scrollback + colors) is saved when the notice is shown. No unit test (this is stdout-side effect on the real console; covered by the manual test in Task 3). Verify by build + manual.

- [ ] **Step 1: Add an `enter_alt` parameter to `render_local_displaced`**

Replace `render_local_displaced` (currently ~1095-1106) with:

```rust
fn render_local_displaced(_cols: u16, _rows: u16, enter_alt: bool) -> String {
    let (w, h) = debug_console_size();
    let mut out = String::new();
    if enter_alt {
        // Enter the alternate screen buffer: the terminal saves the primary
        // buffer -- visible grid, scrollback, and SGR/color state -- so the
        // restore path (`\e[?1049l`) can recover it losslessly. Emitted only on
        // the first displace transition; re-centering redraws on the alt buffer.
        out.push_str("\x1b[?1049h");
    }
    // Clear + home is safe here: on the first transition it targets the fresh
    // alt buffer, and on re-center it targets the existing alt buffer -- neither
    // has scrollback to lose.
    out.push_str("\x1b[2J\x1b[H");
    let msg = "This session is being viewed on a climon dashboard.";
    let hint = "Press Space to take control and resize it to this terminal.";
    let row = (h / 2).max(1);
    for (i, line) in [msg, hint].iter().enumerate() {
        let col = ((w as usize).saturating_sub(line.len()) / 2 + 1).max(1);
        out.push_str(&format!("\x1b[{};{}H{}", row as usize + i, col, line));
    }
    out
}
```

(Note: the doc-comment block above `render_local_displaced` stays; update its wording to mention the alt screen if desired. `\e[2J\e[H` order matches the original.)

- [ ] **Step 2: Pass `enter_alt` from the caller in `update_local_displaced`**

In `update_local_displaced`, find the render call (currently ~422-424):

```rust
                write_local_stdout(
                    render_local_displaced(notice_size.0, notice_size.1).as_bytes(),
                );
```

Replace it with (compute `enter_alt` = "this is the first displace transition, not a re-center", i.e. we are not yet suppressed):

```rust
                // First displace transition enters the alt screen (saving the
                // primary buffer); a re-center while already displaced just
                // redraws on the alt buffer.
                let enter_alt = !self.local_output_suppressed;
                write_local_stdout(
                    render_local_displaced(notice_size.0, notice_size.1, enter_alt)
                        .as_bytes(),
                );
```

Confirm this sits inside the `if needs_render { ... }` block and *before* `self.local_output_suppressed = true;` (so `enter_alt` reflects the pre-transition state). It does in the current code (the `write_local_stdout` call precedes `self.local_output_suppressed = true;`).

- [ ] **Step 3: Build to verify it compiles**

```powershell
cargo build -p climon-session
```

Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add rust/climon-session/src/host.rs
git commit -m "feat(session): enter alt screen for the local displaced notice"
```

---

## Task 3: Exit the alt screen on restore + add the manual test

**Files:**
- Modify: `rust/climon-session/src/host.rs` (`spawn_restore_thread` `Repaint` arm, ~1500-1541)
- Modify: `docs/manual-tests/terminal-control-handoff.md`

- [ ] **Step 1: Exit the alt screen before the current-grid repaint**

In the `LocalRestoreDecision::Repaint =>` arm of `spawn_restore_thread`, find (currently ~1510):

```rust
                let out = s.grid.render_screen();
```

Replace it with a prefix that exits the alt screen (restoring the primary buffer losslessly) before the current-grid repaint, guarded so we only emit `\e[?1049l` if the notice actually entered the alt screen:

```rust
                // Exit the alternate screen buffer first: the terminal restores
                // the saved primary buffer (full scrollback history + colors).
                // Then repaint only the current visible grid on top so it
                // reflects the session's current state. Guard on the notice
                // having been rendered (== alt screen entered) to avoid an
                // unbalanced `\e[?1049l`.
                let mut out = Vec::new();
                if s.local_notice_size.is_some() {
                    out.extend_from_slice(b"\x1b[?1049l");
                }
                out.extend_from_slice(&s.grid.render_screen());
```

Leave the rest of the arm unchanged: the existing `write_local_stdout(&out);`, then `s.local_output_suppressed = false;`, `s.local_restore_at = None;`, `s.local_notice_size = None;`. The debug block that references `out.len()` / `debug_escape(&out, ...)` still works (now includes the 1049l prefix).

- [ ] **Step 2: Build to verify it compiles**

```powershell
cargo build -p climon-session
```

Expected: compiles clean.

- [ ] **Step 3: Add the clean-restore manual test case**

Open `docs/manual-tests/terminal-control-handoff.md`, read the existing case shape (ID/feature/preconditions/steps/expected/platforms/result row per `docs/manual-tests/README.md`), and append a new case using the next unused ID for that file. Use this content (adjust the ID prefix/number to match the file's existing numbering):

```markdown
### <NEXT-ID>: Reclaim preserves scrollback history and colors

- **Feature:** Terminal control handoff — clean restore on reclaim
- **Preconditions:** climon rebuilt from this branch and a NEW session started
  (the daemon runs the binary it was launched from). Windows Terminal.
- **Config-matrix cell:** default config; `feature.*` for control-handoff enabled.
- **Steps:**
  1. `climon run -- <cmd>` where `<cmd>` emits colored output and scrolls well
     past one screen (e.g. a build with a colored progress bar, or
     `powershell -c "1..200 | % { Write-Host $_ -ForegroundColor Blue }"`).
  2. Scroll back in the local terminal and confirm earlier lines are visible.
  3. Open the printed dashboard URL in a browser sized larger than the local
     terminal so the local terminal becomes displaced (shows the centered
     "being viewed on a climon dashboard" notice; output pauses).
  4. In the local terminal, press **Space** to reclaim control.
- **Expected result:** After ~250 ms the local terminal returns to the session's
  current state. Full scrollback above the viewport is intact (scroll up to
  confirm the pre-displace lines are still there). No background/foreground color
  bleeds into the erased rows or the shell prompt. The prompt is left on the last
  content row.
- **Platforms:** Windows (Windows Terminal — primary). Note conhost may degrade
  to no history restore but must still show no color bleed.
- **Result:** _(unverified — fill in on run: pass/fail, date, platform)_
```

Ensure the case is linked/indexed if the file has a table of contents; otherwise appending to the case list is sufficient (the file itself is already linked from `docs/manual-tests/README.md`).

- [ ] **Step 4: Commit**

```bash
git add rust/climon-session/src/host.rs docs/manual-tests/terminal-control-handoff.md
git commit -m "feat(session): exit alt screen on reclaim to restore history; add manual test"
```

---

## Task 4: Strip diagnostics, delete throwaway dir, verify

**Files:**
- Modify: `rust/climon-session/src/host.rs` (remove `CLIMON_DEBUG_RESTORE`-gated diagnostics if no longer useful)
- Delete: `rust/target-diag/` (throwaway build dir)

Decide with the user whether to keep the `CLIMON_DEBUG_RESTORE` logging. The spec says strip it once verified unless still useful. If stripping:

- [ ] **Step 1: Remove the `local_stdin` per-chunk debug log**

In `local_stdin` (~526) remove the `CLIMON_DEBUG_RESTORE`-gated logging added on this branch. (Search `debug_restore` / `local_debug_capture_until` usages.)

- [ ] **Step 2: Remove the `local_debug_capture_until` field and its writes**

Remove the `local_debug_capture_until: Option<Instant>` field from `HostState` (~211), its initializer, the assignment in the restore-fire debug block (~1535), and any reader-thread check that consumes it. Keep the `debug_restore_log` calls only if the user still wants displace/restore tracing; otherwise remove the `grid_nonempty_lines` extraction blocks (~399-418, ~1511-1532) too.

- [ ] **Step 3: Rebuild + full session lib suite + clippy + fmt**

```powershell
cargo test -p climon-session --lib
cargo clippy -p climon-session --all-targets
cargo fmt
```

Expected: all pass, no warnings, no fmt diff.

- [ ] **Step 4: Delete the throwaway target dir**

```powershell
Remove-Item -Recurse -Force C:\git\climon\.worktrees\terminal-control-handoff\rust\target-diag -ErrorAction SilentlyContinue
```

(It is untracked, so nothing to commit for the deletion. Confirm `git status` no longer lists it.)

- [ ] **Step 5: Commit the cleanup**

```bash
git add rust/climon-session/src/host.rs
git commit -m "chore(session): remove CLIMON_DEBUG_RESTORE diagnostics"
```

---

## Task 5: Manual verification on Windows + docs sync

- [ ] **Step 1: Rebuild the client and reinstall so a NEW session runs the fix**

The daemon runs the binary it was launched from, so the fix only takes effect in a NEW session after rebuild/reinstall. Build the release client (to the normal target unless the exe is locked; if locked, coordinate with the user to close the running climon that is NOT their Copilot session, or install to a fresh path):

```powershell
cd C:\git\climon\.worktrees\terminal-control-handoff\rust
cargo build -p climon-cli
```

- [ ] **Step 2: Walk the manual test with the user**

Run the `terminal-control-handoff.md` clean-restore case (Task 3, Step 3) on Windows Terminal. Confirm: full scrollback preserved after Space-reclaim, current state shown, no color bleed. Note conhost degradation behavior. Record the result in the test-case Result row.

- [ ] **Step 3: Refresh `docs/features.md` if the row's description is now inaccurate**

If the terminal-control-handoff row claims behavior about reclaim/restore, update it to reflect clean history/color restore (do not claim behavior not implemented). Follow the "Maintaining this document" rules.

- [ ] **Step 4: Commit any doc updates**

```bash
git add docs/features.md docs/manual-tests/terminal-control-handoff.md
git commit -m "docs: note clean history/color restore on reclaim"
```

---

## Task 6: Push to PR #108

- [ ] **Step 1: Ensure the pushing git identity has access**

```powershell
gh auth switch --hostname github.com --user jackgeek
gh auth setup-git
```

- [ ] **Step 2: Push**

```powershell
cd C:\git\climon\.worktrees\terminal-control-handoff
git push
```

Expected: updates PR #108 (targets `dev`). **Do NOT add a `Co-authored-by` trailer** to any commit (explicit user preference this session).

- [ ] **Step 3: Request code review**

Use the superpowers:requesting-code-review skill before merging.

---

## Self-review checklist (done while writing this plan)

- **Spec coverage:** color bleed → Task 1 (SGR reset); history loss → Task 1 (no `\e[2J`, `\e[J`) + Tasks 2–3 (alt screen save/restore); current-state repaint → Task 3; notice re-centering preserved → Task 2 (`enter_alt` only on first transition); edge cases (nested alt / conhost degrade / rapid re-displace / unbalanced 1049l) → Task 3 guard + design; diagnostics/target-diag cleanup → Task 4; manual test → Task 3; Windows verify → Task 5; no `Co-authored-by`, PR #108 → Task 6. All covered.
- **Placeholders:** none — every code step shows the actual code; the manual-test `<NEXT-ID>` is an intentional file-local numbering slot with explicit instructions.
- **Type/name consistency:** `render_local_displaced(cols, rows, enter_alt: bool)` defined in Task 2 Step 1 and called in Task 2 Step 2; `render_screen()` fixed in Task 1 and called in Task 3; `local_notice_size` guard used consistently in Tasks 2–3. Consistent.
