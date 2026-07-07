# Terminal control handoff (shared PTY, one controller)

Verifies climon's control-handoff model: one live PTY is shared between multiple
**surfaces** — the attached local terminal, the browser dashboard, and the
installed PWA. Each surface attaches with a stable `viewerId` and a `kind`
(`terminal`, `dashboard`, or `pwa`) and reports its own viewport with `Resize`
frames. The daemon tracks exactly one **controller**; the shared PTY grid always
equals the controller's size (no clamping). Fallback priority (used only when no
manual choice is in effect) is `pwa` (3) > `dashboard` (2) > `terminal` (1),
ties broken by most-recently-connected. A manual **Take control**
(`TakeControl` frame) sticks until another take-control or a disconnect. The
daemon broadcasts a `Control` frame `{controllerId, cols, rows}` on every change.

A non-controller surface that is at least as large as the controller grid in both
dimensions **follows** (renders the smaller grid, fully interactive). A surface
smaller than the controller grid in either dimension is **displaced**: it blanks
behind a centered notice with a **Take control** affordance, is fully
non-interactive, and swallows every keystroke except take-control.

- Local terminal (displaced) message: *"This session is being viewed on a climon
  dashboard."* — press **Ctrl+T** (`0x14`) to take control.
- Dashboard/PWA (displaced) overlay: *"This session is being viewed at a larger
  size elsewhere."* with a **Take control** button. Non-controller surfaces also
  show a **maximize** (`ArrowMaximize`) button on the session that takes control.

> **Platform caveat.** On Windows the daemon's `local_terminal_size()` is a fixed
> `(80, 24)` stub, so terminal-size-dependent displaced/following behaviour of the
> **local** terminal cannot be reliably exercised on Windows — verify the local
> terminal cases (TCH-1, TCH-2, TCH-4 local hop, TCH-5 local variant) on
> **macOS/Linux**. The browser/PWA cases (TCH-3, TCH-6, and the dashboard side of
> TCH-2/TCH-4/TCH-5) work on all platforms.

Source: `rust/climon-session/src/control.rs`, `rust/climon-cli/src/client.rs`,
`rust/climon-proto/src/frame.rs`, `src/web/control-state.ts`,
`src/web/components/SessionItem.tsx`, `src/web/components/TerminalView.tsx`.

## TCH-1 — Terminal-only: local terminal is controller and interactive

- **Feature:** default controller on attach; no other surface connected
- **Preconditions:** climon built; no dashboard viewing the session.
- **Config-matrix cell:** default config.
- **Steps:**
  1. Start an attached session from a normal interactive console, e.g.
     `climon bash`.
  2. Do not open the session in any dashboard/PWA.
  3. Type commands and interact normally.
- **Expected result:** The local terminal is the controller: the PTY is sized to
  the terminal, output renders normally, and all input reaches the shell. No
  displaced notice ever appears.
- **Platforms:** macOS, Linux (authoritative); Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-2 — Larger dashboard takes control; Ctrl+T reclaims and resizes down

- **Feature:** dashboard `TakeControl` → local terminal displaced → Ctrl+T
  take-control resizes PTY to the terminal
- **Preconditions:** climon built; a running `climon server` dashboard.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Start an attached session from a **small** local console (e.g. `climon bash`
     in a small window) so a browser can easily be larger.
  2. Open the session in a **large** browser window / maximized terminal pane.
  3. In the dashboard, click the session's **maximize** (Take control) button.
  4. Observe the local terminal.
  5. In the local terminal, press **Ctrl+T**.
- **Expected result:** After step 3 the browser becomes controller; the local
  terminal blanks and shows *"This session is being viewed on a climon
  dashboard."* with the *"Press Ctrl+T to take control…"* hint, and typing in the
  local terminal does nothing. After step 5 the local terminal takes control, the
  shared PTY resizes **down** to the local terminal size, the local terminal
  repaints and is interactive again, and the dashboard now follows (or is
  displaced if it is smaller than the local terminal).
- **Platforms:** macOS, Linux (local-terminal size behaviour authoritative here;
  see the Windows caveat above).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-3 — Small PWA controls; desktop dashboard follows with a maximize button

- **Feature:** following surface + maximize (Take control) button on the dashboard
- **Preconditions:** dashboard server running; the same session open in a small
  PWA/phone-sized viewer **and** a large desktop browser.
- **Config-matrix cell:** browser cell (Chromium/Firefox/WebKit); mobile viewport.
- **Steps:**
  1. Open the session in a small viewer (phone PWA, or a narrow browser window)
     and click its **maximize** button so the small viewer is the controller.
  2. Open the same session in a **large** desktop browser.
  3. Confirm the desktop browser shows the small (controller) grid and is
     interactive (it is **following**), with a **maximize** button available.
  4. Click the desktop browser's **maximize** button.
- **Expected result:** In step 3 the large desktop dashboard follows — it renders
  the smaller controller grid, stays interactive, and shows a maximize button
  because it is not the controller. In step 4 the desktop dashboard takes control,
  and the shared terminal resizes up to the desktop viewport; the small PWA, now
  too small, becomes **displaced** (blank overlay + Take control).
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-4 — Controller disconnect falls back by priority

- **Feature:** disconnect fallback = highest `kind` priority (`pwa` > `dashboard`
  > `terminal`), ties by most-recently-connected
- **Preconditions:** a session with more than one surface connected.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Attach a local terminal (`terminal`) and open the session in a dashboard
     (`dashboard`) and a PWA (`pwa`).
  2. Take control with the **PWA** (maximize).
  3. Close/disconnect the PWA.
  4. Observe which surface becomes controller and the resulting sizes.
  5. Now disconnect the dashboard too (leaving only the local terminal).
- **Expected result:** After step 3 the PWA is gone, so control falls back to the
  highest-priority remaining surface — the **dashboard** — and the shared PTY
  resizes to the dashboard's viewport (a new `Control` frame is broadcast). After
  step 5 control falls back to the local **terminal** and the PTY resizes to it.
  Any surface that ends up smaller than the new controller becomes displaced.
- **Platforms:** macOS, Linux (local-terminal hop authoritative); Windows for the
  PWA→dashboard hop.
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-5 — Displaced surface is fully non-interactive except Take control

- **Feature:** displaced input gate (all keystrokes swallowed; only take-control
  acts)
- **Preconditions:** a session with one surface displaced by a larger controller.
- **Config-matrix cell:** default config; browser cell.
- **Steps:**
  1. Make a surface displaced (e.g. a small local terminal while a larger
     dashboard is controller, per TCH-2; or a small dashboard while a larger one
     controls).
  2. On the displaced surface, type ordinary characters, Enter, arrow keys, and
     Ctrl-C.
  3. Confirm none of that reaches the shell (the running command is unaffected).
  4. Trigger take-control: **Ctrl+T** on a displaced local terminal, or the
     **Take control** button / maximize button on a displaced dashboard/PWA.
- **Expected result:** While displaced, every keystroke is swallowed and nothing
  reaches the PTY — the session is fully non-interactive on that surface. Only the
  take-control action works; after it, the surface becomes controller, the PTY
  resizes to it, and it becomes interactive.
- **Platforms:** macOS, Linux (local-terminal variant); Windows (dashboard/PWA
  variant).
- **Result:** _(version / date / tester / pass|fail / notes)_

## TCH-6 — Two dashboards: most-recent Take control wins; disconnect falls back by recency

- **Feature:** manual take-control override + tie-break by most-recently-connected
- **Preconditions:** the same session open in two separate browser tabs/windows
  ("A" and "B") of similar size, plus (optionally) an attached local terminal.
- **Config-matrix cell:** browser cell.
- **Steps:**
  1. Open dashboards A and B (A first, then B).
  2. Click **maximize** (Take control) in A. Confirm A controls.
  3. Click **maximize** in B. Confirm B controls (the newer manual choice wins and
     sticks over A).
  4. Disconnect B.
  5. Observe which dashboard becomes controller.
- **Expected result:** Manual take-control always wins over any previous choice or
  priority, so after step 3 B is controller. After B disconnects (step 4), control
  falls back among the remaining same-`kind` dashboards to the
  **most-recently-connected** one (A here, or the newer of any remaining
  dashboards). A `Control` frame is broadcast on each change and sizes update
  accordingly.
- **Platforms:** macOS, Linux, Windows.
- **Result:** _(version / date / tester / pass|fail / notes)_
