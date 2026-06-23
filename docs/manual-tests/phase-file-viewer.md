# Read-only file viewer (terminal link → cwd-confined viewer, local + remote)

Manual checks for the optional dashboard file viewer. Clicking a file path printed
in the terminal opens it in a **read-only**, cwd-confined viewer. File bytes come
from `POST /api/file` (same-origin guarded); the cwd-subtree confinement
(canonicalize + containment + regular-file + size cap + binary screen) is applied
on the local read and re-applied on the remote host by the uplink. Content renders
in a sandboxed iframe (no scripts) under a strict CSP, so opening a file never
executes its contents. The feature is **off by default** (`feature.fileViewer`).

## FV-1 — Local: click a path opens the file at the referenced line

- **Feature:** File viewer — local read + link parsing
- **Preconditions:** `climon config feature.fileViewer enabled`. Dashboard open with a
  live local session whose cwd is the climon repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session; desktop browser.
- **Steps:**
  1. In the attached terminal, run `echo src/index.ts:1`.
  2. In the dashboard terminal, click the `src/index.ts:1` link.
- **Expected result:** A full-screen viewer opens showing the contents of
  `src/index.ts` scrolled to the referenced line. The header reflects the resolved
  path. No page reload; the terminal stays live.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-2 — Confinement: a path outside the cwd is refused

- **Feature:** File viewer — cwd-subtree confinement (SEC)
- **Preconditions:** `feature.fileViewer enabled`; live local session with a normal
  project cwd (not `/`).
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Run `echo /etc/hosts` (or `echo ../../../../etc/passwd`) in the terminal.
  2. Click the resulting link.
- **Expected result:** The viewer refuses the read with an "outside the session
  working directory" message; no file outside the cwd subtree is shown. A symlink
  inside the cwd that points outside is likewise refused.
- **Platforms:** Desktop Chrome, Firefox, Safari; macOS/Linux (and Windows with an
  out-of-tree absolute path).
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-3 — Markdown renders without executing scripts

- **Feature:** File viewer — sandboxed markdown render
- **Preconditions:** `feature.fileViewer enabled`; live local session in the repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Run `echo README.md` and click the link.
  2. (Optional) Open a markdown file containing a raw `<script>` or
     `<img onerror=…>` and inspect the dev-tools console.
- **Expected result:** Markdown renders (headings, lists, code blocks). No script
  executes (the iframe is `sandbox=""` with `script-src 'none'`); the console shows
  CSP blocking any inline/script attempt.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-4 — Binary file shows a "binary" notice

- **Feature:** File viewer — binary screen
- **Preconditions:** `feature.fileViewer enabled`; live local session; a binary file in
  the cwd subtree (e.g. a compiled binary or an image).
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. `echo` the path to a binary file in the cwd and click the link.
- **Expected result:** The viewer shows a "binary file" notice instead of garbled
  bytes; no content is rendered.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-5 — File over the size cap shows a "too large" notice

- **Feature:** File viewer — size cap (`fileViewer.maxFileSizeBytes`)
- **Preconditions:** `feature.fileViewer enabled`. Set a small cap, e.g.
  `climon config fileViewer.maxFileSizeBytes 1024`. Have a file > 1 KiB in the cwd.
- **Config-matrix cell:** `fileViewer.maxFileSizeBytes = 1024`; local session.
- **Steps:**
  1. `echo` the path to a file larger than the cap and click the link.
- **Expected result:** The viewer shows a "too large" notice (with the file size);
  no content body is read.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-6 — Disabled by default / when turned off

- **Feature:** File viewer — feature gate
- **Preconditions:** `climon config feature.fileViewer disabled` (or unset).
- **Config-matrix cell:** `feature.fileViewer = disabled`; local session.
- **Steps:**
  1. Run `echo src/index.ts:1` and attempt to click the link.
  2. (Optional) `POST /api/file` directly and observe the status.
- **Expected result:** No viewer opens (or a disabled message is shown). The direct
  `POST /api/file` returns `404` ("file viewer disabled").
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-7 — Remote: file loads over the mux; escape refused on the remote host

- **Feature:** File viewer — remote read routing (ingest ↔ uplink mux)
- **Preconditions:** `feature.fileViewer enabled` on the dashboard host. A remote
  (dev-tunnel) session is connected and visible in the dashboard, with a known cwd
  containing a text file.
- **Config-matrix cell:** `feature.fileViewer = enabled`; remote (dev tunnel) session.
- **Steps:**
  1. In the remote session's terminal, `echo` a path to a text file inside its cwd
     and click the link.
  2. `echo` an out-of-tree path (e.g. `/etc/hosts`) on the remote and click it.
- **Expected result:** Step 1 loads the remote file contents in the viewer (the
  read travels server → ingest control socket → uplink → confined read → back).
  Step 2 is refused ("outside the session working directory") — confinement holds
  on the remote host. A 2 MiB-range file still loads (length-prefixed reply framing,
  not capped by the 64 KiB control line).
- **Platforms:** Desktop/mobile; remote devbox over a dev tunnel.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-8 — Tunnel/mobile render; cross-origin rejected

- **Feature:** File viewer — same-origin guard over tunnel
- **Preconditions:** `feature.fileViewer enabled`. A dev-tunnel (Tunnel Link) session is
  active; open the dashboard via the tunnel URL (optionally on a phone).
- **Config-matrix cell:** Remote = dev tunnel; Browser = mobile or desktop.
- **Steps:**
  1. Over the tunnel URL, click a file link and view the file.
  2. (Optional) From a different Origin host, issue a `POST /api/file` and observe
     the status.
- **Expected result:** The viewer renders over the tunnel. A cross-origin
  `POST /api/file` is rejected with `403` (same-origin guard).
- **Platforms:** iOS Safari, Android Chrome, desktop over a dev tunnel.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-1 — Full-screen viewer with no dialog chrome

- **Feature:** File viewer — full-screen overlay
- **Preconditions:** `feature.fileViewer enabled`. Dashboard open with a live local
  session whose cwd is the climon repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session; desktop browser.
- **Steps:**
  1. In the terminal, run `echo src/index.ts:1` and click the link.
- **Expected result:** The viewer covers the entire window (full screen) with no
  Fluent dialog title bar, border, or surrounding backdrop. The editor surface fills
  the viewport beneath a single header row.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-2 — Header shows session cwd and relative path

- **Feature:** File viewer — cwd + relative-path header
- **Preconditions:** `feature.fileViewer enabled`; live local session whose cwd is the
  repo root.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Click a link to `src/index.ts:1`.
  2. (If a file outside the cwd is reachable and displayable) observe its header.
- **Expected result:** The header shows the session's working directory, then `/`,
  then the path relative to that cwd (e.g. `src/index.ts`). For a file not under the
  cwd, the absolute path is shown instead. Long paths ellipsize the cwd first.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-3 — Exit button closes the viewer

- **Feature:** File viewer — Exit control (mobile-style)
- **Preconditions:** `feature.fileViewer enabled`; viewer open on any file.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session; desktop + mobile.
- **Steps:**
  1. Open a file in the viewer.
  2. Click the outline **Exit** button (Dismiss icon) at the top-right.
- **Expected result:** The viewer closes and returns to the live terminal. The Exit
  button matches the mobile terminal session view's exit control (outline, small,
  Dismiss icon, top-right, respecting the visual-viewport offset).
- **Platforms:** Desktop Chrome, Firefox, Safari; iOS Safari, Android Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-4 — Escape key closes the viewer

- **Feature:** File viewer — Escape-to-close
- **Preconditions:** `feature.fileViewer enabled`; viewer open on any file.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session; desktop browser.
- **Steps:**
  1. Open a file in the viewer.
  2. Press `Escape` (with focus in the dashboard, not inside the iframe content).
- **Expected result:** The viewer closes immediately.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-5 — Syntax highlighting across popular languages

- **Feature:** File viewer — static syntax highlighting
- **Preconditions:** `feature.fileViewer enabled`; repo-root session with source files.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Open files of several types: a `.ts`, a `.py`, a `.rs`, a `.json`, and a `.sh`.
  2. Open one with `:line` (e.g. `src/index.ts:10`) to jump to a line.
- **Expected result:** Keywords, strings, comments, and numbers are color-highlighted
  appropriately for each language. Line-number gutter remains; the referenced line is
  highlighted (active row). Files with an unknown/unmapped extension render as plain
  (escaped) text with line numbers — no broken markup.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-6 — Markdown still renders as formatted markdown

- **Feature:** File viewer — markdown rendering unchanged
- **Preconditions:** `feature.fileViewer enabled`; a `.md` file in the cwd.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Open a `.md` file (e.g. `README.md`).
- **Expected result:** The markdown renders as a formatted document (headings, lists,
  code blocks), not as highlighted source. No scripts execute.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-7 — XSS guard: source/markup never executes

- **Feature:** File viewer — sandbox/CSP XSS guard
- **Preconditions:** `feature.fileViewer enabled`; a markdown file with embedded HTML
  (e.g. `.fv-scratch/xss.md`) and a source file containing the literal text
  `<script>`.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. Open the malicious markdown file.
  2. Open a `.ts`/`.js` file whose contents include `"<script>alert(1)</script>"`.
- **Expected result:** No script runs; no alert. In source files the angle brackets
  render as visible text (`&lt;script&gt;`), highlighted but inert.
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## FV-UI-8 — Not-found link click is a silent no-op

- **Feature:** File viewer — silent not-found
- **Preconditions:** `feature.fileViewer enabled`; live local session.
- **Config-matrix cell:** `feature.fileViewer = enabled`; local session.
- **Steps:**
  1. In the terminal, run `echo nonexistent/missing.ts:99` and click the link.
- **Expected result:** Nothing happens — no viewer opens and no "file not found"
  dialog/message is shown. (Other non-displayable states, e.g. a real binary or an
  out-of-tree file, still open the viewer and show their explanatory message.)
- **Platforms:** Desktop Chrome, Firefox, Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
