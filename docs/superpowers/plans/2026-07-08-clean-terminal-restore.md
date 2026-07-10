# Clean Terminal History/Color Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the in-process local terminal reclaims control after being displaced by a dashboard/PWA, restore the session with full scrollback history intact, the session's current visible state, and no terminal color bleed.

**Architecture:** The notice never touches scrollback (it draws with absolute cursor positioning inside the viewport, no scrolling), so the only cause of history loss is the `\e[2J` full-screen clear in the notice draw and the restore repaint. The fix clears and repaints **only the visible viewport** using erase sequences that never touch scrollback: `\e[J` (erase-below) for whole-viewport clears and `\e[2K` (erase-line) per row, always preceded by an SGR reset (`\e[m`) to kill color bleed — and **never `\e[2J`**. No alternate screen buffer (DEC 1049): it corrupts nested full-screen apps and legacy consoles (see spec's Rejected alternatives). Client-only change in `rust/climon-session`; no protocol, server, or config changes.

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
- `rust/climon-session/src/host.rs` — `render_local_displaced` (~1095) clears only the visible viewport (`\e[m\e[H\e[J`) instead of `\e[2J\e[H`; the restore-watcher `Repaint` arm in `spawn_restore_thread` (~1500) is unchanged apart from calling the fixed `render_screen`. Strip `CLIMON_DEBUG_RESTORE` diagnostics (Task 4).

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

## Task 2: Clear only the viewport when drawing the displaced notice

**Files:**
- Modify: `rust/climon-session/src/host.rs` (`render_local_displaced` ~1095)

The notice already centers its two lines with absolute positioning, so it never
scrolls content off. The only history-destroying step is its `\e[2J\e[H` prologue.
Replace that with a viewport-only clear so scrollback is never touched. No unit test
(this is a stdout side effect on the real console; covered by the manual test in
Task 3). Verify by build + manual.

- [ ] **Step 1: Replace the `\e[2J\e[H` prologue with a viewport-only clear**

Replace `render_local_displaced` (currently ~1093-1104) with:

```rust
fn render_local_displaced(_cols: u16, _rows: u16) -> String {
    let (w, h) = debug_console_size();
    // Clear only the *visible* viewport, never `\e[2J`: on Windows Terminal (and
    // others) `\e[2J` clears scrollback. `\e[H` homes the cursor and `\e[J`
    // (erase-below) then clears from there to the end of the visible screen --
    // the whole viewport -- without touching scrollback above it. Reset SGR
    // first so the cleared cells (behind the notice) use the default background.
    let mut out = String::from("\x1b[m\x1b[H\x1b[J");
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

The signature is unchanged (no `enter_alt` parameter — we never enter the alt
screen), so the existing caller in `update_local_displaced` (~422) needs no change.
Update the doc-comment above the function to mention the viewport-only clear if
desired.

- [ ] **Step 2: Build to verify it compiles**

```powershell
cargo build -p climon-session
```

Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add rust/climon-session/src/host.rs
git commit -m "fix(session): clear only the viewport when drawing the displaced notice"
```

---

## Task 3: Add the clean-restore manual test

**Files:**
- Modify: `docs/manual-tests/terminal-control-handoff.md`

The restore-watcher `Repaint` arm already calls `s.grid.render_screen()` and writes
it while holding the lock, then unsuppresses — that flow is correct as-is once
`render_screen` is fixed (Task 1). There is **no alt-screen exit to emit** (we never
entered one), so no code change is needed in `spawn_restore_thread`. This task just
adds the required manual test.

- [ ] **Step 1: Add the clean-restore manual test case**

Open `docs/manual-tests/terminal-control-handoff.md`, read the existing case shape
(ID/feature/preconditions/steps/expected/platforms/result row per
`docs/manual-tests/README.md`), and append a new case using the next unused ID for
that file. Use this content (adjust the ID prefix/number to match the file's existing
numbering):

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
  current state. Scrollback above the viewport is intact (scroll up to confirm the
  pre-displace lines are still there). No background/foreground color bleeds into
  the erased rows or the shell prompt. The prompt is left on the last content row.
- **Platforms:** Windows (Windows Terminal — primary; also spot-check conhost).
- **Result:** _(unverified — fill in on run: pass/fail, date, platform)_
```

Ensure the case is linked/indexed if the file has a table of contents; otherwise
appending to the case list is sufficient (the file itself is already linked from
`docs/manual-tests/README.md`).

- [ ] **Step 2: Commit**

```bash
git add docs/manual-tests/terminal-control-handoff.md
git commit -m "docs: add clean-restore manual test for terminal control handoff"
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

- **Spec coverage:** color bleed → Task 1 (SGR reset before every erase); history loss → Task 1 (no `\e[2J`, `\e[J` for below-cursor) + Task 2 (viewport-only notice clear, no `\e[2J`); current-state repaint → Task 1/Task 3 (`render_screen`); notice re-centering preserved → Task 2 (signature unchanged, caller untouched); edge cases (nested full-screen app / conhost / `\e[J` vs `\e[2J` scrollback semantics / rapid re-displace) → spec Edge cases; diagnostics/target-diag cleanup → Task 4; manual test → Task 3; Windows verify → Task 5; no `Co-authored-by`, PR #108 → Task 6. All covered.
- **No alternate screen buffer:** the fix stays on the primary buffer throughout (viewport-only `\e[H`/`\e[2K`/`\e[J`), so there is no DEC-1049 enter/exit, no nesting hazard, and no unbalanced-sequence guard needed.
- **Placeholders:** none — every code step shows the actual code; the manual-test `<NEXT-ID>` is an intentional file-local numbering slot with explicit instructions.
- **Type/name consistency:** `render_local_displaced(cols, rows)` signature unchanged (Task 2), so its caller in `update_local_displaced` is untouched; `render_screen()` fixed in Task 1 and called unchanged in Task 3's `Repaint` arm; `local_notice_size` re-centering state preserved. Consistent.
