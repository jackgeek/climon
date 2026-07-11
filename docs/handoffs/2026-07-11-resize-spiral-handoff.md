# Handoff — Terminal control-handoff: dashboard resize spiral + control war

**Date:** 2026-07-11
**Branch:** `terminal-control-handoff` (PR #108, targets `dev`)
**Worktree:** `/Users/jackallan/dev/climon/.worktrees/terminal-control-handoff`
**Last commit:** `8f8ef49 docs: rewrite clean-restore spec/plan to viewport-only approach; add TCH-10; update features`
**Platform this session:** macOS (desktop browser, single dashboard tab claimed by user)

## What is DONE (committed on this branch)

The **clean terminal restore** work (the previous handoff's goal) is finished and
committed — viewport-only repaint, no alternate screen buffer:
- `fd78e31` clear only the viewport when drawing the displaced notice
- `2f88e21` `render_screen` resets SGR before erase, never clears scrollback
- `b0de7ad` reword displaced overlay to "This session is being viewed elsewhere."
- `8f8ef49` docs (spec/plan/features)

Not pushed, not Windows-verified. `CLIMON_DEBUG_RESTORE` restore diagnostics still
present (strip before merge).

## The ACTIVE unsolved bug — dashboard resize spiral

On desktop, when the dashboard takes control of a session the terminal enters a
**runaway resize loop** ("fighting"): the controlling surface fires `resize` frames
at a **~40 ms cadence** (≈ double-`requestAnimationFrame`, matching `refit()` =
`rAF(rAF(fitNow))`), rows constant, cols drifting. Symptoms have shifted across
fix attempts: first a **monotonic shrink** (cols 130→92), later **overflow to the
right** ("xterm goes off the right-hand side"). Root cause is **NOT yet confirmed**
— do not fix without confirming (systematic-debugging Iron Law).

There is ALSO a secondary observation: some repros showed **4 concurrent viewer IDs**
fighting for control — likely a confound from repeated browser reloads leaving stale
WebSocket surfaces, but possibly a real missing-cleanup bug. Keep it separate from
the spiral until the spiral is pinned.

## Uncommitted work (this session) — decide keep vs revert

`git status` shows `M src/web/App.tsx`, `M src/web/components/TerminalView.tsx`,
`M tests/app-layout.test.ts`. Two distinct things:

1. **visualViewport gate (a fix attempt that did NOT stop the spiral).**
   - `App.tsx`: new exported predicate `shouldTrackVisualViewport(isMobile)` (~L353)
     + gated the visualViewport `resize`/`scroll` effect on it (`if
     (!shouldTrackVisualViewport(isMobile)) return;`, deps `[]`→`[isMobile]`, ~L1141).
   - `tests/app-layout.test.ts`: added import + unit test for the predicate.
   - Result: behavior **changed** (shrink→overflow) proving it took effect, but the
     40 ms loop persisted → visualViewport is NOT the (sole) re-trigger. Keep as
     hardening or revert — undecided, pending root cause.

2. **TEMPORARY diagnostic (MUST be stripped before any commit).**
   - `TerminalView.tsx` `sendResize` (~L446): `console.warn("[climon-resize] send
     …", new Error("trigger").stack)` to capture the call stack that re-triggers each
     resize. This is instrumentation, not a fix.

The instrumented web bundle was rebuilt (`bun run build:web`). **NOTE:** in source
mode the dashboard server builds `app.js` **in-memory from `src/web` on first request
and caches it in-process** — so the running server must be **restarted** to serve the
instrumented source (the `dist/web/app.js` output is NOT what source-mode serves).

## Where we were blocked (waiting on the user)

Asked the user to, in order: (1) restart the dashboard server, (2) close all
dashboard tabs/PWA except ONE (kill the stale-viewer confound), (3) open DevTools
Console + hard-reload, (4) launch a fresh session, click it in the sidebar, let it
misbehave, (5) paste **2-3 `[climon-resize] send …` lines with their stack traces**.

That trace is the ground truth that identifies the re-trigger. **Nothing should be
"fixed" until those traces are read.**

## Leading unconfirmed hypothesis

`onFocusCapture={refreshActiveTerminal}` on the terminal container
(`TerminalView.tsx` ~L1060). `refreshActiveTerminal` = `refreshTerminalRender` +
`refit()`. Theory: xterm re-focuses its helper textarea on write/resize → `focusin`
bubbles to the container → `refit()` → `sendResize` → PTY resize → xterm re-focus →
loop at 40 ms. Matches the cadence and "starts when the dashboard takes control"
(terminal gets focused on control). **Unverified** — the stack trace will confirm or
kill it.

Already RULED OUT as the sole cause: visualViewport listeners (gated, loop
persisted); stale assets/binary (server cwd = worktree, my source is active, behavior
changed); server bridge (`server.ts` relays `takeControl`/`resize`+viewerId/`Control`
correctly); daemon control machine (`host.rs` only the controller's resize →
`set_pty_size`).

## The other loose end — "width too great / off the right side"

New symptom after the visualViewport gate. Possibly the fit now settles at a
container width that includes the scrollbar (100vw fallback) now that desktop
width-clamping via visualViewport vars is gone — BUT those CSS vars only feed
`TerminalPanel.tsx`, not the main terminal, so this is unconfirmed. Diagnose main
terminal container width vs viewport and FitAddon measurement once the spiral trace
is in hand; the two may share a root cause.

## Key files

- `src/web/components/TerminalView.tsx` — central to the bug. `sendResize` (~422,
  currently instrumented ~446), `fitNow` (~547, fit()+sendResize), `refit` (~570,
  double-rAF), `refreshActiveTerminal` (~590 = refreshTerminalRender+refit),
  `focusActiveTerminal` (~595), `takeControl` (~487), `armTakeControl` (~508),
  reclaim-on-focus effect (~820), size/control frame handlers (~726), container
  render with `onClick`/`onFocusCapture` (~1047-1072), refit effect deps
  `[attachKey,accentColor,maximized,visible]` (~1010), overlay text ~1065.
- `src/web/App.tsx` — visualViewport effect / the gate fix (~353, ~1141);
  `scheduleTerminalRefit` (~341); `armTakeControl` call sites: sidebar onSelect
  (~1479), maximize (~1525).
- `src/web/control-state.ts` — pure helpers (fully read): `deriveControlState`
  (controlling iff `controllerId===ownViewerId`), `shouldRefitOnControlFrame` (refit
  only on displaced→controlling), `shouldSendResize` (dedupes IDENTICAL sizes only —
  does NOT stop the spiral since steps differ), `generateViewerId`.
- `rust/climon-session/src/host.rs` — daemon control machine: `apply_resize` (~449),
  `set_pty_size` (~482, logs the events we analyze), `take_control` (~522),
  `recompute_controller` (~575, only on disconnect).
- `~/.climon/logs/daemon/<session>.log` — ground truth. `set_pty_size` lines log
  `cols`, `rows`, `controller`, `now` (ms). Only the CONTROLLER's resizes emit
  `set_pty_size`. Parse with python for cadence/controller. Latest repro:
  `spicy-walls-complain.log` (193 `set_pty_size`, 4 viewer IDs).

## Environment / gotchas

- **Client=Rust (`rust/`), server=Bun (`src/`).** Control-handoff is client-side (the
  per-session Rust daemon). The user tests with `rust/target/debug/climon bash`
  (built 10 Jul, HAS the feature). The PATH `~/.local/bin/climon` (2 Jul) is OLD and
  lacks the feature — a daemon log containing `revert_to_host_size` = OLD binary.
  Confirm new binary: `strings <bin> | grep -c set_pty_size` → 2 (new) vs 0 (old).
- **Web change propagation:** edit `src/web` → `bun run build:web` (optional for
  source mode) → **restart the dashboard server** (rebuilds+caches app.js) →
  **hard-reload** the browser (Cmd+Shift+R). App.js is served no-store, so hard
  reload is enough on the client; the server cache needs the restart.
- **Do NOT kill running climon/server PIDs blindly** — one climon process is the
  user's Copilot CLI session; the dashboard server is the user's foreground process.
  Ask the user to restart their own server.
- **Pre-existing test failures (NOT regressions):** "compose staging Insert",
  TerminalPanel compose history x2, 2 server integration timeouts. Typecheck has
  pre-existing errors in unrelated files.
- **Commits on this branch: NO `Co-authored-by` / trailer** (explicit user pref).
- **PR push:** `gh auth switch --hostname github.com --user jackgeek` then
  `gh auth setup-git` before `git push`. Push to PR #108.
- **User pref:** use **superpowers** skills for climon, NOT `prd`.

## Suggested skills

1. **systematic-debugging** — resume mid-Phase-1. Iron Law: read the `[climon-resize]`
   stack traces (confirm the re-trigger) BEFORE any fix. Do not add fix #N without a
   confirmed cause. If a 3rd fix reveals yet another coupled loop, invoke Phase 4.5
   (question the resize/control architecture — it has multiple interacting feedback
   loops).
2. **test-driven-development** — once the trigger is confirmed, add a failing
   test/predicate (like `shouldTrackVisualViewport`) before the fix.
3. **verification-before-completion** — reproduce on desktop with the user (loop
   gone, correct width, control message shows on both surfaces) before claiming done.
4. **requesting-code-review** — before pushing to PR #108.

## Immediate next actions

1. Get the user's `[climon-resize] send …` console stack traces (server restart +
   single tab + hard reload + fresh session). Read them → confirm the re-trigger.
2. **Strip the temporary `console.warn` diagnostic** in `TerminalView.tsx`
   `sendResize` regardless of outcome.
3. Implement the single root-cause fix (likely: stop `onFocusCapture` from calling
   `refit`, or suppress/debounce focus-triggered refits) with a failing test first.
4. Decide keep-vs-revert on the visualViewport gate.
5. Diagnose "width too great / off right side" (main terminal container width vs
   viewport / FitAddon) — may share the root cause.
6. Then: strip `CLIMON_DEBUG_RESTORE` diagnostics, verify on Windows, push to PR #108.
